import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { recordNmiPaidInvoice, recordNmiReversal } from "../payments-sync.js";
import { retryPaymentPosts } from "../payment-posts.js";

// PGlite exposes one PostgreSQL session. The pool adapter serializes checked-out
// clients; these tests deliberately make no multi-connection concurrency claim.
class PGlitePool {
  constructor(db) {
    this.db = db;
    this.waiters = [];
    this.busy = false;
  }

  query(sql, params) {
    return this.db.query(sql, params);
  }

  async connect() {
    if (this.busy) await new Promise((resolve) => this.waiters.push(resolve));
    this.busy = true;
    let released = false;
    return {
      query: (sql, params) => this.db.query(sql, params),
      release: () => {
        if (released) return;
        released = true;
        const next = this.waiters.shift();
        if (next) next();
        else this.busy = false;
      },
    };
  }
}

let db;
let pool;

async function scalar(sql, params = []) {
  const result = await pool.query(sql, params);
  const value = result.rows[0]?.value;
  return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

async function setupSchema() {
  if (db) await db.close();
  db = new PGlite();
  pool = new PGlitePool(db);
  await db.exec(`
    CREATE TABLE core_reservation (
      id INTEGER PRIMARY KEY,
      reservation_code TEXT NOT NULL,
      amount_paid NUMERIC(12, 2) NOT NULL DEFAULT 0,
      notes TEXT,
      updated_at TIMESTAMPTZ
    );
    CREATE TABLE core_jrmhotelrequest (id INTEGER PRIMARY KEY);
    CREATE TABLE core_jrmhoteloffer (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL);
    CREATE TABLE core_payment (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      amount NUMERIC(12, 2) NOT NULL,
      method TEXT NOT NULL,
      paid_at TIMESTAMPTZ NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      created_by_id INTEGER,
      reservation_id INTEGER NOT NULL,
      cash_location TEXT,
      cash_location_other TEXT,
      points_account_id INTEGER,
      points_qty INTEGER,
      transfer_details TEXT,
      zelle_address TEXT,
      points_cost_per_point NUMERIC(12, 2)
    );
    CREATE TABLE core_jrmhotelpayment (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      payment_date TIMESTAMPTZ NOT NULL,
      amount NUMERIC(12, 2) NOT NULL,
      currency TEXT NOT NULL,
      method TEXT NOT NULL,
      reference TEXT,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      created_by_id INTEGER,
      offer_id INTEGER,
      request_id INTEGER NOT NULL,
      card_last4 TEXT
    );
    CREATE TABLE core_jrmhotelnote (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      created_by_id INTEGER,
      request_id INTEGER NOT NULL
    );
    INSERT INTO core_reservation (id, reservation_code, amount_paid, notes)
      VALUES (7, 'ABC123', 0, ''), (8, 'OTHER', 20, '');
    INSERT INTO core_jrmhotelrequest (id) VALUES (42);
    INSERT INTO core_jrmhoteloffer (id, request_id) VALUES (99, 42);
  `);
}

async function row(sql, params = []) {
  const result = await pool.query(sql, params);
  return result.rows[0];
}

async function addAlwaysFailTrigger(table, triggerName, message) {
  await pool.query(`CREATE FUNCTION ${triggerName}_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION '${message}'; END; $$`);
  await pool.query(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON ${table}
    FOR EACH ROW EXECUTE FUNCTION ${triggerName}_fn()`);
}

async function removeAlwaysFailTrigger(table, triggerName) {
  await pool.query(`DROP TRIGGER ${triggerName} ON ${table}`);
  await pool.query(`DROP FUNCTION ${triggerName}_fn()`);
}

beforeEach(setupSchema);
after(async () => { if (db) await db.close(); });

describe("confirmed NMI payment SQL integration", () => {
  it("records reservation amount_paid exactly once and replays without a duplicate", async () => {
    const payment = {
      pool, invoiceNumber: "RES-ABC123", amountUsd: 40,
      transactionId: "nmi_res_1", paidAt: "2026-09-23T10:00:00.000Z",
    };
    const first = await recordNmiPaidInvoice(payment);
    const second = await recordNmiPaidInvoice(payment);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.match(second.skipped[0], /already synced/);
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 40);
    assert.equal((await pool.query("SELECT id FROM core_payment WHERE reservation_id = 7")).rows.length, 1);
    assert.equal((await pool.query("SELECT transaction_id FROM nesher_money_payment_posts WHERE state = 'posted'")).rows.length, 1);
  });

  it("posts a second known transaction as an installment and reviews a manual same-amount payment", async () => {
    const base = { pool, invoiceNumber: "RES-ABC123", amountUsd: 40, paidAt: "2026-09-23T10:00:00.000Z" };
    const first = await recordNmiPaidInvoice({ ...base, transactionId: "nmi_installment_1" });
    const second = await recordNmiPaidInvoice({ ...base, transactionId: "nmi_installment_2" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 80);
    assert.equal((await pool.query("SELECT id FROM core_payment WHERE reservation_id = 7")).rows.length, 2);

    await pool.query(`INSERT INTO core_payment
      (amount, method, paid_at, notes, created_at, reservation_id,
       cash_location, cash_location_other, points_qty, transfer_details,
       zelle_address, points_cost_per_point)
      VALUES (40, 'card', NOW(), 'staff entered', NOW(), 8, '', '', 0, '', '', 0)`);
    const manual = await recordNmiPaidInvoice({ ...base, invoiceNumber: "RES-OTHER", transactionId: "nmi_manual_same" });
    assert.equal(manual.ok, false);
    assert.equal(manual.needsReview, true);
    assert.equal(manual.errors[0], "manual_payment_requires_review");
    assert.equal((await row("SELECT state FROM nesher_money_payment_posts WHERE transaction_id = $1", ["nmi_manual_same"])).state, "review");
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 8"), 20);
  });

  it("keeps hotel payment and note atomic, then retries a pending event once", async () => {
    await addAlwaysFailTrigger("core_jrmhotelnote", "fail_hotel_note", "note unavailable");
    await assert.rejects(
      recordNmiPaidInvoice({ pool, invoiceNumber: "JRM-142-O99", amountUsd: 75, transactionId: "nmi_hotel_atomic", paidAt: "2026-09-23T10:00:00.000Z" }),
      /note unavailable/
    );
    assert.equal((await pool.query("SELECT id FROM core_jrmhotelpayment")).rows.length, 0);
    assert.equal((await pool.query("SELECT id FROM core_jrmhotelnote")).rows.length, 0);
    assert.equal((await row("SELECT state FROM nesher_money_payment_posts WHERE transaction_id = $1", ["nmi_hotel_atomic"])).state, "pending");

    await removeAlwaysFailTrigger("core_jrmhotelnote", "fail_hotel_note");
    const retry = await retryPaymentPosts({
      pool,
      post: (args) => recordNmiPaidInvoice({ ...args, pool }),
    });
    assert.equal(retry.posted, 1);
    assert.equal((await pool.query("SELECT id FROM core_jrmhotelpayment WHERE request_id = 42")).rows.length, 1);
    assert.equal((await pool.query("SELECT id FROM core_jrmhotelnote WHERE request_id = 42")).rows.length, 1);
    assert.equal((await row("SELECT state FROM nesher_money_payment_posts WHERE transaction_id = $1", ["nmi_hotel_atomic"])).state, "posted");
  });

  it("rolls back a failed CRM insert, leaves pending, and recovery posts exactly once", async () => {
    await addAlwaysFailTrigger("core_payment", "fail_crm_payment", "CRM insert unavailable");
    const payment = { pool, invoiceNumber: "RES-ABC123", amountUsd: 40, transactionId: "nmi_retry_insert", paidAt: "2026-09-23T10:00:00.000Z" };
    await assert.rejects(recordNmiPaidInvoice(payment), /CRM insert unavailable/);
    assert.equal((await pool.query("SELECT id FROM core_payment WHERE reservation_id = 7")).rows.length, 0);
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 0);
    assert.equal((await row("SELECT state FROM nesher_money_payment_posts WHERE transaction_id = $1", [payment.transactionId])).state, "pending");

    await removeAlwaysFailTrigger("core_payment", "fail_crm_payment");
    const retry = await retryPaymentPosts({ pool, post: (args) => recordNmiPaidInvoice({ ...args, pool }) });
    assert.equal(retry.posted, 1);
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 40);
    assert.equal((await pool.query("SELECT id FROM core_payment WHERE reservation_id = 7")).rows.length, 1);
    assert.equal((await row("SELECT state FROM nesher_money_payment_posts WHERE transaction_id = $1", [payment.transactionId])).state, "posted");
  });

  it("persists a forced review without touching the reservation balance", async () => {
    const out = await recordNmiPaidInvoice({
      pool, invoiceNumber: "RES-ABC123", amountUsd: 40,
      transactionId: "nmi_forced_review", paidAt: "2026-09-23T10:00:00.000Z",
      reviewReason: "invoice_transaction_conflict",
    });
    assert.equal(out.ok, false);
    assert.equal(out.needsReview, true);
    assert.deepEqual(out.errors, ["invoice_transaction_conflict"]);
    const event = await row("SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = $1", ["nmi_forced_review"]);
    assert.deepEqual(event, { state: "review", reason: "invoice_transaction_conflict" });
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 0);
    assert.equal((await pool.query("SELECT id FROM core_payment WHERE reservation_id = 7")).rows.length, 0);
    const replay = await recordNmiPaidInvoice({
      pool, invoiceNumber: "RES-ABC123", amountUsd: 40,
      transactionId: "nmi_forced_review", paidAt: "2026-09-23T10:00:00.000Z",
    });
    assert.equal(replay.needsReview, true);
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 0);
  });

  it("reviews a legacy NMI marker found in the other CRM payment table", async () => {
    await pool.query(`INSERT INTO core_jrmhotelpayment
      (payment_date, amount, currency, method, reference, note, created_at,
       request_id, card_last4)
      VALUES (NOW(), 40, 'USD', 'card', 'JRM-142 nmi:legacy_reservation', 'old', NOW(), 42, '')`);
    const reservationConflict = await recordNmiPaidInvoice({
      pool, invoiceNumber: "RES-ABC123", amountUsd: 40,
      transactionId: "legacy_reservation", paidAt: "2026-09-23T10:00:00.000Z",
    });
    assert.equal(reservationConflict.needsReview, true);
    assert.deepEqual(reservationConflict.errors, ["legacy_transaction_conflict"]);
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 0);
    assert.equal((await pool.query("SELECT id FROM core_payment WHERE reservation_id = 7")).rows.length, 0);
    assert.equal((await row("SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = $1", ["legacy_reservation"])).state, "review");

    await pool.query(`INSERT INTO core_payment
      (amount, method, paid_at, notes, created_at, reservation_id,
       cash_location, cash_location_other, points_qty, transfer_details,
       zelle_address, points_cost_per_point)
      VALUES (75, 'card', NOW(), 'old nmi:legacy_hotel', NOW(), 7, '', '', 0, '', '', 0)`);
    const hotelConflict = await recordNmiPaidInvoice({
      pool, invoiceNumber: "JRM-142", amountUsd: 75,
      transactionId: "legacy_hotel", paidAt: "2026-09-23T10:00:00.000Z",
    });
    assert.equal(hotelConflict.needsReview, true);
    assert.deepEqual(hotelConflict.errors, ["legacy_transaction_conflict"]);
    assert.equal((await pool.query("SELECT id FROM core_jrmhotelpayment WHERE request_id = 42")).rows.length, 1);
    // Audit #75 (25 Sep): the review leaves exactly ONE staff note saying it was NOT recorded (it used to leave none).
    const hotelNotes = (await pool.query("SELECT note FROM core_jrmhotelnote WHERE request_id = 42")).rows;
    assert.equal(hotelNotes.length, 1);
    assert.match(hotelNotes[0].note, /is already recorded on another booking in the CRM, so it was NOT added here\. Do not enter it twice/);
    assert.equal((await row("SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = $1", ["legacy_hotel"])).state, "review");
  });

  it("reviews a hotel payment whose offer belongs to no matching request", async () => {
    const out = await recordNmiPaidInvoice({
      pool, invoiceNumber: "JRM-142-O123", amountUsd: 75,
      transactionId: "nmi_bad_offer", paidAt: "2026-09-23T10:00:00.000Z",
    });
    assert.equal(out.ok, false);
    assert.equal(out.needsReview, true);
    assert.deepEqual(out.errors, ["hotel_offer_mismatch"]);
    assert.equal((await pool.query("SELECT id FROM core_jrmhotelpayment WHERE request_id = 42")).rows.length, 0);
    // Audit #75: one staff note, no payment row.
    const offerNotes = (await pool.query("SELECT note FROM core_jrmhotelnote WHERE request_id = 42")).rows;
    assert.equal(offerNotes.length, 1);
    assert.match(offerNotes[0].note, /received and NOT recorded automatically: the hotel offer belongs to another request/);
    assert.deepEqual(
      await row("SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = $1", ["nmi_bad_offer"]),
      { state: "review", reason: "hotel_offer_mismatch" },
    );
  });
});

describe("a refund or void from the desk chat, recorded against the sale's CRM row (24 Sep)", () => {
  const SALE = { invoiceNumber: "RES-ABC123", amountUsd: 40, transactionId: "nmi_res_1", paidAt: "2026-09-20T10:00:00.000Z", cardLast4: "4421", rep: "Hershy" };
  it("a partial refund is its OWN negative row; the sale row is untouched; replay writes nothing twice", async () => {
    assert.equal((await recordNmiPaidInvoice({ pool, ...SALE })).ok, true);
    const before = await row("SELECT id, amount, notes, method FROM core_payment WHERE reservation_id = 7");
    const r = await recordNmiReversal({ pool, kind: "refund", saleTxn: "nmi_res_1", reversalTxn: "nmi_rf_9", amountUsd: 15, brand: "nesher", orderId: "RES-ABC123", rep: "joseph", cardLast4: "4421" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.state, "posted");
    const again = await recordNmiReversal({ pool, kind: "refund", saleTxn: "nmi_res_1", reversalTxn: "nmi_rf_9", amountUsd: 15, brand: "nesher", orderId: "RES-ABC123", rep: "joseph", cardLast4: "4421" });
    assert.equal(again.ok, true);
    const rows = (await pool.query("SELECT id, amount, notes, method FROM core_payment WHERE reservation_id = 7 ORDER BY id")).rows;
    assert.equal(rows.length, 2, "one sale row + one refund row, no duplicate on replay");
    assert.deepEqual(rows[0], before, "the sale's own row is never edited");
    assert.equal(Number(rows[1].amount), -15);
    assert.equal(rows[1].method, "card");
    assert.match(rows[1].notes, /REFUND of NMI card sale txn nmi_res_1: -\$15\.00 USD \(refund txn nmi_rf_9\), card ending 4421, sent by joseph from the desk chat\. nmi-refund:nmi_rf_9$/);
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 25);
    assert.deepEqual(await row("SELECT state, kind, amount_cents::int AS cents, rep, first_path FROM nesher_money_payment_posts WHERE transaction_id = 'nmi_rf_9'"),
      { state: "posted", kind: "refund", cents: 1500, rep: "joseph", first_path: "chat" });
    // The sale's marker still finds exactly ONE row (the refund note says "nmi-refund:" and "sale txn", never " nmi:<sale>").
    assert.equal((await pool.query("SELECT id FROM core_payment WHERE notes ~ $1", ["(^|[[:space:]])nmi:nmi_res_1($|[[:space:]])"])).rows.length, 1);
  });

  it("a sale that was never recorded in the CRM is kept for review, never a negative row on its own", async () => {
    const r = await recordNmiReversal({ pool, kind: "refund", saleTxn: "nmi_never", reversalTxn: "nmi_rf_x", amountUsd: 1, brand: "nesher", orderId: "RES-ABC123", rep: "joseph" });
    assert.equal(r.ok, false);
    assert.equal(r.state, "review");
    assert.deepEqual(await row("SELECT state, reason, kind FROM nesher_money_payment_posts WHERE transaction_id = 'nmi_rf_x'"), { state: "review", reason: "sale_not_in_crm", kind: "refund" });
    assert.equal((await pool.query("SELECT id FROM core_payment")).rows.length, 0);
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 0);
  });

  it("a void of a JRM hotel sale: a negative hotel payment + a hotel note, keyed void_<sale>", async () => {
    assert.equal((await recordNmiPaidInvoice({ pool, invoiceNumber: "JRM-142-O99", amountUsd: 80, transactionId: "nmi_hot_1", paidAt: "2026-09-24T08:00:00.000Z" })).ok, true);
    const r = await recordNmiReversal({ pool, kind: "void", saleTxn: "nmi_hot_1", reversalTxn: null, amountUsd: 80, brand: "jrm", orderId: "JRM-142-O99", rep: "joseph", cardLast4: "0008" });
    assert.equal(r.ok, true, JSON.stringify(r));
    const pays = (await pool.query("SELECT amount, reference, request_id, offer_id, card_last4 FROM core_jrmhotelpayment ORDER BY id")).rows;
    assert.equal(pays.length, 2);
    assert.equal(Number(pays[1].amount), -80);
    assert.match(pays[1].reference, /nmi-void:nmi_hot_1$/);
    assert.equal(pays[1].request_id, 42);
    assert.equal(pays[1].offer_id, 99);
    assert.equal(pays[1].card_last4, "0008");
    const notes = (await pool.query("SELECT note FROM core_jrmhotelnote ORDER BY id")).rows.map((x) => x.note);
    assert.match(notes[notes.length - 1], /^VOID of NMI card sale txn nmi_hot_1: -\$80\.00 USD, card ending 0008, sent by joseph from the desk chat\. If this was a cancellation, add the refund on hotel request #42 in the CRM, or it will show \$80\.00 due\.$/);
    assert.equal((await row("SELECT kind, state FROM nesher_money_payment_posts WHERE transaction_id = 'void_nmi_hot_1'")).kind, "refund");
  });
});

describe("the retry worker never hands a reversal to the sale writer (Gabbai 24 Sep C1)", () => {
  it("a refund whose CRM write failed stays pending, then the retry moves it to review: no plus row, amount_paid unchanged", async () => {
    assert.equal((await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 40, transactionId: "nmi_res_1", paidAt: "2026-09-20T10:00:00.000Z" })).ok, true);
    await addAlwaysFailTrigger("core_payment", "fail_pay", "payment table unavailable");
    await assert.rejects(recordNmiReversal({ pool, kind: "refund", saleTxn: "nmi_res_1", reversalTxn: "nmi_rf_fail", amountUsd: 15, brand: "nesher", orderId: "RES-ABC123", rep: "joseph" }));
    assert.equal((await row("SELECT state FROM nesher_money_payment_posts WHERE transaction_id = 'nmi_rf_fail'")).state, "pending");
    await removeAlwaysFailTrigger("core_payment", "fail_pay");
    // the REAL worker with the REAL sale writer, as server.js runs it
    const out = await retryPaymentPosts({ pool, post: recordNmiPaidInvoice });
    assert.equal(out.review, 1);
    assert.equal(out.posted, 0);
    assert.deepEqual(await row("SELECT state, reason, kind FROM nesher_money_payment_posts WHERE transaction_id = 'nmi_rf_fail'"), { state: "review", reason: "reversal_retry_requires_review", kind: "refund" });
    const rows = (await pool.query("SELECT amount FROM core_payment WHERE reservation_id = 7 ORDER BY id")).rows.map((x) => Number(x.amount));
    assert.deepEqual(rows, [40], "only the sale row - no plus row for the refund, no minus row either");
    assert.equal(await scalar("SELECT amount_paid AS value FROM core_reservation WHERE id = 7"), 40);
  });
});
