import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { recordNmiPaidInvoice } from "../payments-sync.js";
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
    assert.equal((await pool.query("SELECT id FROM core_jrmhotelnote WHERE request_id = 42")).rows.length, 0);
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
    assert.equal((await pool.query("SELECT id FROM core_jrmhotelnote WHERE request_id = 42")).rows.length, 0);
    assert.deepEqual(
      await row("SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = $1", ["nmi_bad_offer"]),
      { state: "review", reason: "hotel_offer_mismatch" },
    );
  });
});
