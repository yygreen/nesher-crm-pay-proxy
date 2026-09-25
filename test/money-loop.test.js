// The collection loop after the Mr Money audit of 25 Sep (loop findings #26 #28 #73 #74 #75 #140 #141
// #142 #144, the loop-review list for #27, and the security scrub #44; #76 and #145 were taken back out
// on the Gabbai's 25 Sep verdict (B1, D4) and stay open). Written RED FIRST
// against live 0e14f81 (build 2026-09-25-paddle-reader), from the auditor's own reproductions
// (audit-mr-money/loop/pp/audit/loop-audit.test.js). FAKE data only: an in-memory PGlite CRM and a fake
// NMI query.php. No network, no real CRM, no gateway call.
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  recordNmiPaidInvoice,
  recordNmiReversal,
  recordNmiException,
  recordSweepReversal,
  shadowNmiPayment,
  syncPaidInvoices,
  NOTE_REASON_WORDS,
  reviewNoteText,
} from "../payments-sync.js";
import { retryPaymentPosts, listPaymentPostExceptions, loopReview, MAX_POST_ATTEMPTS, REVIEW_WORDS, reasonCode } from "../payment-posts.js";
import { runNmiRecovery, sweepDays, parseNmiQueryXml } from "../nmi-recovery.js";
import { applyNmiSaleSuccess, parseNmiWebhook } from "../nmi-webhook.js";
import { scrubDigits } from "../mercury-gateway.js";
import { officeCrmState, OFFICE_DONE_WORDS, renderOpenPayHtml, renderOfficePayHtml } from "../open-pay.js";

class PGlitePool {
  constructor(db) { this.db = db; this.waiters = []; this.busy = false; }
  query(sql, params) { return this.db.query(sql, params); }
  async connect() {
    if (this.busy) await new Promise((r) => this.waiters.push(r));
    this.busy = true;
    let released = false;
    return {
      query: (sql, params) => this.db.query(sql, params),
      release: () => { if (released) return; released = true; const n = this.waiters.shift(); if (n) n(); else this.busy = false; },
    };
  }
}

let db; let pool;
async function setup() {
  if (db) await db.close();
  db = new PGlite();
  pool = new PGlitePool(db);
  await db.exec(`
    CREATE TABLE core_reservation (id INTEGER PRIMARY KEY, reservation_code TEXT NOT NULL,
      amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0, notes TEXT, updated_at TIMESTAMPTZ);
    CREATE TABLE core_jrmhotelrequest (id INTEGER PRIMARY KEY);
    CREATE TABLE core_jrmhoteloffer (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL);
    CREATE TABLE core_payment (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, amount NUMERIC(12,2) NOT NULL,
      method TEXT NOT NULL, paid_at TIMESTAMPTZ NOT NULL, notes TEXT, created_at TIMESTAMPTZ NOT NULL, created_by_id INTEGER,
      reservation_id INTEGER NOT NULL, cash_location TEXT, cash_location_other TEXT, points_account_id INTEGER,
      points_qty INTEGER, transfer_details TEXT, zelle_address TEXT, points_cost_per_point NUMERIC(12,2));
    CREATE TABLE core_jrmhotelpayment (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payment_date TIMESTAMPTZ NOT NULL,
      amount NUMERIC(12,2) NOT NULL, currency TEXT NOT NULL, method TEXT NOT NULL, reference TEXT, note TEXT,
      created_at TIMESTAMPTZ NOT NULL, created_by_id INTEGER, offer_id INTEGER, request_id INTEGER NOT NULL, card_last4 TEXT);
    CREATE TABLE core_jrmhotelnote (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL, created_by_id INTEGER, request_id INTEGER NOT NULL);
    INSERT INTO core_reservation (id, reservation_code, amount_paid, notes) VALUES (7, 'ABC123', 0, ''), (8, '8SU7MW', 0, ''), (9, 'HANDRW', 0, '');
    INSERT INTO core_jrmhotelrequest (id) VALUES (42);
    INSERT INTO core_jrmhoteloffer (id, request_id) VALUES (99, 42);
  `);
}
beforeEach(setup);
after(async () => { if (db) await db.close(); });

const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
const paid = async (id) => Number((await one("SELECT amount_paid FROM core_reservation WHERE id = $1", [id])).amount_paid);
const handRow = (amount, resId, notes = "cc visa") => pool.query(`INSERT INTO core_payment (amount, method, paid_at, notes, created_at, reservation_id, cash_location, cash_location_other, points_qty, transfer_details, zelle_address, points_cost_per_point)
  VALUES ($1, 'card', NOW(), $2, NOW(), $3, '', '', 0, '', '', 0)`, [amount, notes, resId]);

function stamp(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`; }
function tx({ id, order = "", orig = "", proc = "mav7067", cond = "complete", mdf1 = "nesher", mdf5 = "", actions }) {
  return `<transaction><transaction_id>${id}</transaction_id><order_id>${order}</order_id><original_transaction_id>${orig}</original_transaction_id><condition>${cond}</condition>` +
    `<processor_id>${proc}</processor_id><cc_number>4xxxxxxxxxxx1111</cc_number>` +
    `<merchant_defined_field id="1">${mdf1}</merchant_defined_field><merchant_defined_field id="5">${mdf5}</merchant_defined_field>` +
    actions.map((a) => `<action><action_type>${a.type}</action_type><amount>${a.amount}</amount><success>${a.success ?? 1}</success><date>${stamp(a.at)}</date></action>`).join("") +
    `</transaction>`;
}
const xml = (list) => `<?xml version="1.0"?><nm_response>${list.map(tx).join("")}</nm_response>`;
const fakeNmi = (list) => async () => ({ ok: true, status: 200, text: async () => xml(list) });
const NOW = Date.parse("2026-09-25T09:00:00Z");

// the live doors exactly as server.js builds them for the sweep (moneyDoors("recovery"))
const sweep = (list, extra = {}) => runNmiRecovery({
  host: "https://fake", securityKey: "k", days: 3, now: new Date(NOW), fetchImpl: fakeNmi(list), mode: "live",
  post: (args) => recordNmiPaidInvoice({ pool, path: "recovery", ...args }),
  except: (ev) => recordNmiException({ pool, path: "recovery", ...ev }),
  reverse: (ev) => recordSweepReversal({ pool, path: "recovery", ...ev }),
  ...extra,
});

describe("#26 a void or refund done outside the desk chat", () => {
  it("L1: a posted sale voided in the portal is taken off the booking, once", async () => {
    const p = await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 500, transactionId: "t-void-1", paidAt: new Date(NOW - 3600e3).toISOString(), path: "guest" });
    assert.equal(p.ok, true);
    assert.equal(await paid(7), 500);
    const list = [{ id: "t-void-1", order: "RES-ABC123", cond: "canceled", actions: [{ type: "sale", amount: "500.00", at: NOW - 3600e3 }, { type: "void", amount: "500.00", at: NOW - 600e3 }] }];
    const out = await sweep(list);
    assert.equal(out.reversed, 1);
    assert.equal(out.fresh.reversed, 1);
    assert.equal(await paid(7), 0, "the booking no longer shows money that never came in");
    const minus = await all("SELECT amount, notes FROM core_payment WHERE reservation_id = 7 AND amount < 0");
    assert.equal(minus.length, 1);
    assert.match(minus[0].notes, /nmi-void:t-void-1/);
    assert.match(minus[0].notes, /processor's portal/);
    // the next sweep sees the same void and adds nothing
    const again = await sweep(list);
    assert.equal(again.fresh.reversed, 0);
    assert.equal(await paid(7), 0);
    assert.equal((await all("SELECT id FROM core_payment WHERE reservation_id = 7 AND amount < 0")).length, 1);
  });

  it("L2: a sale voided from the chat while its CRM write is pending is never posted by the retry", async () => {
    await pool.query(`CREATE FUNCTION f_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'crm down'; END; $$`);
    await pool.query(`CREATE TRIGGER t_fail BEFORE INSERT ON core_payment FOR EACH ROW EXECUTE FUNCTION f_fail()`);
    await assert.rejects(recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 80, transactionId: "t-void-2", paidAt: new Date(NOW).toISOString(), path: "guest" }));
    await pool.query(`DROP TRIGGER t_fail ON core_payment`);
    const v = await recordNmiReversal({ pool, kind: "void", saleTxn: "t-void-2", amountUsd: 80, brand: "nesher", orderId: "RES-ABC123", rep: "joseph" });
    assert.equal(v.state, "review");
    const r = await retryPaymentPosts({ pool, post: recordNmiPaidInvoice });
    assert.equal(r.posted, 0);
    assert.equal(await paid(7), 0, "a voided sale is not booked as paid");
    const row = await one("SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = 't-void-2'");
    assert.deepEqual(row, { state: "review", reason: "sale_voided_before_posting" });
  });

  it("L2b: a portal void the sweep sees while the sale is still pending sends the sale to review", async () => {
    await pool.query(`CREATE FUNCTION f_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'crm down'; END; $$`);
    await pool.query(`CREATE TRIGGER t_fail BEFORE INSERT ON core_payment FOR EACH ROW EXECUTE FUNCTION f_fail()`);
    await assert.rejects(recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 80, transactionId: "t-void-3", paidAt: new Date(NOW).toISOString(), path: "guest" }));
    await pool.query(`DROP TRIGGER t_fail ON core_payment`);
    await sweep([{ id: "t-void-3", order: "RES-ABC123", cond: "canceled", actions: [{ type: "sale", amount: "80.00", at: NOW }, { type: "void", amount: "80.00", at: NOW + 30e3 }] }]);
    await retryPaymentPosts({ pool, post: recordNmiPaidInvoice });
    assert.equal(await paid(7), 0);
    assert.equal((await one("SELECT state FROM nesher_money_payment_posts WHERE transaction_id = 't-void-3'")).state, "review");
  });

  it("L3: a portal refund of a loop-posted sale writes its own minus row, named after the sale", async () => {
    await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 500, transactionId: "t-s3", paidAt: new Date(NOW - 5 * 3600e3).toISOString(), path: "guest" });
    const list = [
      { id: "t-s3", order: "RES-ABC123", actions: [{ type: "sale", amount: "500.00", at: NOW - 5 * 3600e3 }, { type: "settle", amount: "500.00", at: NOW - 4 * 3600e3 }] },
      { id: "t-rf3", order: "", orig: "t-s3", actions: [{ type: "refund", amount: "-200.00", at: NOW - 3600e3 }] },
    ];
    const out = await sweep(list);
    assert.equal(await paid(7), 300);
    assert.equal(out.fresh.reversed, 1);
    const r = await one("SELECT state, invoice_number, kind FROM nesher_money_payment_posts WHERE transaction_id = 't-rf3'");
    assert.deepEqual(r, { state: "posted", invoice_number: "RES-ABC123", kind: "refund" });
    await sweep(list);
    assert.equal(await paid(7), 300, "seen twice, written once");
  });

  it("a portal refund of a sale the loop never posted is kept for a person, named after the sale", async () => {
    await sweep([{ id: "t-rf9", order: "", orig: "t-hand-9", actions: [{ type: "refund", amount: "-50.00", at: NOW - 3600e3 }] }]);
    const r = await one("SELECT state, reason, invoice_number FROM nesher_money_payment_posts WHERE transaction_id = 't-rf9'");
    assert.deepEqual(r, { state: "review", reason: "refund_outside_chat", invoice_number: "NMI-T-HAND-9" });
    assert.equal((await all("SELECT id FROM core_payment WHERE amount < 0")).length, 0);
  });

  it("a void of a hand-entered (never loop-posted) sale is not reversed by the sweep", async () => {
    await handRow(300, 9, "Linked to NMI sale txn t-hand-1 (hand-entered row). nmi:t-hand-1");
    await pool.query("UPDATE core_reservation SET amount_paid = 300 WHERE id = 9");
    await sweep([{ id: "t-hand-1", order: "", cond: "canceled", actions: [{ type: "sale", amount: "300.00", at: NOW - 3600e3 }, { type: "void", amount: "300.00", at: NOW - 60e3 }] }]);
    assert.equal(await paid(9), 300, "only what the loop itself posted is reversed");
    assert.equal((await one("SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = 't-hand-1'")).reason, "sale_voided");
  });

  it("L4 unchanged: a chat refund then the sweep's sight of it adds nothing; a chat void then a sweep adds nothing", async () => {
    await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 500, transactionId: "t-s4", paidAt: new Date(NOW - 5 * 3600e3).toISOString(), path: "guest" });
    const r = await recordNmiReversal({ pool, kind: "refund", saleTxn: "t-s4", reversalTxn: "t-rf4", amountUsd: 120, brand: "nesher", orderId: "RES-ABC123", rep: "sruly", cardLast4: "1111" });
    assert.equal(r.state, "posted");
    await sweep([
      { id: "t-s4", order: "RES-ABC123", actions: [{ type: "sale", amount: "500.00", at: NOW - 5 * 3600e3 }] },
      { id: "t-rf4", order: "RES-ABC123", orig: "t-s4", actions: [{ type: "refund", amount: "-120.00", at: NOW - 60e3 }] },
    ]);
    assert.equal(await paid(7), 380);
    assert.equal(Number((await one("SELECT seen_count FROM nesher_money_payment_posts WHERE transaction_id = 't-rf4'")).seen_count), 2);
    await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 60, transactionId: "t-s5", paidAt: new Date(NOW - 600e3).toISOString(), path: "guest" });
    const v = await recordNmiReversal({ pool, kind: "void", saleTxn: "t-s5", amountUsd: 60, brand: "nesher", orderId: "RES-ABC123", rep: "joseph" });
    assert.equal(v.state, "posted");
    await sweep([{ id: "t-s5", order: "RES-ABC123", cond: "canceled", actions: [{ type: "sale", amount: "60.00", at: NOW - 600e3 }, { type: "void", amount: "60.00", at: NOW - 60e3 }] }]);
    assert.equal(await paid(7), 380);
  });

  it("parses the refund's original transaction and the void time from query.php", () => {
    const ev = parseNmiQueryXml(xml([{ id: "t-rf", orig: "t-sale", actions: [{ type: "refund", amount: "-5.00", at: NOW }] },
      { id: "t-v", cond: "canceled", actions: [{ type: "sale", amount: "5.00", at: NOW - 1000 }, { type: "void", amount: "5.00", at: NOW }] }]));
    assert.equal(ev[0].originalTransactionId, "t-sale");
    assert.equal(ev[1].voidedAt, new Date(NOW).toISOString());
  });
});

describe("#28 a payment typed by hand after the loop posted it", () => {
  it("the loop's note says it is already recorded", async () => {
    await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 1200, transactionId: "t-s7b", paidAt: new Date(NOW).toISOString(), path: "guest" });
    const n = (await one("SELECT notes FROM core_reservation WHERE id = 7")).notes;
    assert.match(n, /recorded in the CRM automatically/);
    assert.match(n, /do not enter it again/);
    await recordNmiPaidInvoice({ pool, invoiceNumber: "JRM-142-O99", amountUsd: 80, transactionId: "t-h7", paidAt: new Date(NOW).toISOString(), path: "guest" });
    const hn = (await one("SELECT note FROM core_jrmhotelnote WHERE request_id = 42")).note;
    assert.match(hn, /do not enter it again/);
  });
  it("a later same-amount hand row is listed for a person, and clears when the hand copy is deleted", async () => {
    await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 1200, transactionId: "t-s7", paidAt: new Date(NOW).toISOString(), path: "guest" });
    await handRow(1200, 7);
    const r = await loopReview({ pool, now: new Date() });
    const dup = r.items.find((i) => i.reason === "hand_row_after_auto_post");
    assert.ok(dup, JSON.stringify(r));
    assert.equal(dup.booking, "RES-ABC123");
    assert.equal(dup.amount_cents, 120000);
    await pool.query("DELETE FROM core_payment WHERE notes = 'cc visa'");
    assert.equal((await loopReview({ pool, now: new Date() })).items.filter((i) => i.reason === "hand_row_after_auto_post").length, 0);
  });
});

describe("#73 shadow-era review rows", () => {
  it("are counted and listed until their sale is in the CRM", async () => {
    await shadowNmiPayment({ pool, invoiceNumber: "OPEN-20260924-X1", amountUsd: 4750, transactionId: "t-open-1", paidAt: new Date(NOW - 86400e3).toISOString(), brand: "nesher", path: "open", decision: { action: "exception", reason: "no_crm_reference" } });
    const r = await retryPaymentPosts({ pool, post: recordNmiPaidInvoice });
    assert.equal(r.reviewTotal, 1);
    assert.equal((await listPaymentPostExceptions({ pool })).length, 1);
    const lr = await loopReview({ pool, now: new Date() });
    assert.equal(lr.count, 1);
    assert.match(lr.items[0].words, /before the automatic recording/);
    await handRow(4750, 9, "typed by Goldie nmi:t-open-1");
    assert.equal((await retryPaymentPosts({ pool, post: recordNmiPaidInvoice })).reviewTotal, 0);
    assert.equal((await loopReview({ pool, now: new Date() })).count, 0);
  });
});

describe("#74 the Mercury invoice clause", () => {
  it("is on the note when the booking's pay link also made a Mercury invoice, and not otherwise", async () => {
    await pool.query(`CREATE TABLE nesher_pay_invoices (id TEXT PRIMARY KEY, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL)`);
    await pool.query(`INSERT INTO nesher_pay_invoices (id, payload, expires_at) VALUES ('abcd2345', $1::jsonb, NOW() + INTERVAL '30 days')`, [JSON.stringify({ invoiceNumber: "RES-ABC123", mercuryUrl: "https://app.mercury.com/pay/x", amountUsd: 250 })]);
    await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 250, transactionId: "t-m1", paidAt: new Date(NOW).toISOString(), path: "guest" });
    assert.match((await one("SELECT notes FROM core_reservation WHERE id = 7")).notes, /Mark the Mercury invoice PAID, never cancel/);
    await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-HANDRW", amountUsd: 30, transactionId: "t-m2", paidAt: new Date(NOW).toISOString(), path: "office" });
    assert.doesNotMatch((await one("SELECT notes FROM core_reservation WHERE id = 9")).notes, /Mercury/);
  });
});

describe("#75 a live sale that goes to review", () => {
  it("leaves one staff note on the booking", async () => {
    await handRow(250, 7, "deposit");
    const r = await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 250, transactionId: "t-s9", paidAt: new Date(NOW).toISOString(), path: "guest" });
    assert.equal(r.needsReview, true);
    const n = (await one("SELECT notes FROM core_reservation WHERE id = 7")).notes;
    assert.match(n, /Card payment \$250\.00 USD \(NMI txn t-s9\) received and NOT recorded/);
    await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 250, transactionId: "t-s9", paidAt: new Date(NOW).toISOString(), path: "webhook" });
    const again = (await one("SELECT notes FROM core_reservation WHERE id = 7")).notes;
    assert.equal(again.split("received and NOT recorded").length - 1, 1, "once per sale");
    assert.equal((await all("SELECT id FROM core_payment WHERE reservation_id = 7")).length, 1, "no payment row");
  });
});

describe("B1 (Gabbai 25 Sep): the office follows the note and marks the Mercury invoice PAID after a card payment", () => {
  // The Gabbai's probe (scratchpad/gabbai-probe/double.mjs) as a test: red on d2cb975 (audit #76 had loosened
  // the Mercury path's same-amount check), green once #76 is reverted. #76 stays open (s.8).
  it("the same money is written ONCE, for a reservation and for a hotel request", async () => {
    await pool.query(`CREATE TABLE nesher_pay_invoices (id TEXT PRIMARY KEY, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL)`);
    await pool.query(`INSERT INTO nesher_pay_invoices (id, payload, expires_at) VALUES ('abcd2345', $1::jsonb, NOW() + INTERVAL '30 days')`,
      [JSON.stringify({ invoiceNumber: "RES-ABC123", mercuryUrl: "https://app.mercury.com/pay/x", amountUsd: 750, transactionId: "t-card", paidAt: new Date().toISOString() })]);
    await pool.query(`INSERT INTO nesher_pay_invoices (id, payload, expires_at) VALUES ('efgh6789', $1::jsonb, NOW() + INTERVAL '30 days')`,
      [JSON.stringify({ invoiceNumber: "JRM-142-O99", mercuryUrl: "https://app.mercury.com/pay/y", amountUsd: 400, transactionId: "t-card-h", paidAt: new Date().toISOString() })]);
    assert.equal((await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 750, transactionId: "t-card", paidAt: new Date().toISOString(), path: "guest" })).ok, true);
    assert.equal((await recordNmiPaidInvoice({ pool, invoiceNumber: "JRM-142-O99", amountUsd: 400, transactionId: "t-card-h", paidAt: new Date().toISOString(), path: "guest" })).ok, true);
    assert.match((await one("SELECT notes FROM core_reservation WHERE id = 7")).notes, /Mark the Mercury invoice PAID/);
    const out = await syncPaidInvoices({ pool, listInvoices: async () => [
      { id: "merc-inv-1", invoiceNumber: "RES-ABC123", status: "Paid", amount: 750, paidAt: new Date().toISOString() },
      { id: "merc-inv-2", invoiceNumber: "JRM-142-O99", status: "Paid", amount: 400, paidAt: new Date().toISOString() },
    ] });
    assert.equal(out.recorded.length, 0, JSON.stringify(out));
    assert.equal(await paid(7), 750, "one real payment of $750");
    assert.equal((await all("SELECT id FROM core_payment WHERE reservation_id = 7")).length, 1);
    assert.equal((await all("SELECT id FROM core_jrmhotelpayment WHERE request_id = 42")).length, 1);
  });
  it("#144 a paid FLY- flight link is kept for review", async () => {
    await syncPaidInvoices({ pool, listInvoices: async () => [{ id: "merc-fly-1", invoiceNumber: "FLY-1055-R7", status: "Paid", amount: 300, paidAt: new Date().toISOString() }] });
    assert.equal((await one("SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = 'mercury_merc-fly-1'")).reason, "flight_link_not_wired");
  });
});

describe("#140 a signed webhook for a portal sale with no brand field and no CRM reference", () => {
  it("takes the brand from the merchant account and is kept", async () => {
    const parsed = parseNmiWebhook({ event_type: "transaction.sale.success", event_body: { transaction_id: "t-s11", order_id: "OPEN-X", processor_id: "mav2083", action: { amount: "10.00", action_type: "sale" } } });
    assert.equal(parsed.brand, "jrm");
    const r = await applyNmiSaleSuccess({ ...parsed, amountUsd: 10 }, { findInvoicesByOrderId: async () => [], recordPaymentException: (ev) => recordNmiException({ pool, path: "webhook", ...ev }) });
    assert.equal(r.ok, true);
    assert.equal((await one("SELECT state FROM nesher_money_payment_posts WHERE transaction_id = 't-s11'")).state, "review");
  });
  it("with no merchant account either, it answers 200 and leaves it to the sweep", async () => {
    const r = await applyNmiSaleSuccess(
      { eventType: "transaction.sale.success", transactionId: "t-s12", orderId: "OPEN-X", amountUsd: 10, brand: null },
      { findInvoicesByOrderId: async () => [], recordPaymentException: (ev) => recordNmiException({ pool, path: "webhook", ...ev }) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.httpStatus ?? 200, 200);
  });
});

describe("#141 a payment the CRM keeps refusing", () => {
  it("goes to review after MAX_POST_ATTEMPTS, and is in the loop-review list", async () => {
    await pool.query(`CREATE FUNCTION f_fail2() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'bad row'; END; $$`);
    await pool.query(`CREATE TRIGGER t_fail2 BEFORE INSERT ON core_payment FOR EACH ROW EXECUTE FUNCTION f_fail2()`);
    await assert.rejects(recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 5, transactionId: "t-stuck", paidAt: new Date(NOW).toISOString() }));
    for (let i = 0; i < MAX_POST_ATTEMPTS + 2; i++) await retryPaymentPosts({ pool, post: recordNmiPaidInvoice });
    const row = await one("SELECT state, reason FROM nesher_money_payment_posts WHERE transaction_id = 't-stuck'");
    assert.deepEqual(row, { state: "review", reason: "crm_write_keeps_failing" });
    const lr = await loopReview({ pool, now: new Date() });
    assert.equal(lr.items[0].reason, "crm_write_keeps_failing");
  });
});

describe("#142 the sweep's counters and look-back", () => {
  it("fresh counts only what this pass did first; the look-back reaches back to the last good sweep", async () => {
    const list = [{ id: "t-ok", order: "RES-ABC123", actions: [{ type: "sale", amount: "10.00", at: NOW }] }, { id: "t-open", order: "OPEN-1", actions: [{ type: "sale", amount: "20.00", at: NOW }] }];
    const a = await sweep(list);
    assert.deepEqual(a.fresh, { posted: 1, reversed: 0, exceptions: 1 });
    const b = await sweep(list);
    assert.deepEqual(b.fresh, { posted: 0, reversed: 0, exceptions: 0 });
    assert.equal(b.posted, 1);
    assert.equal(sweepDays(null, NOW), 3);
    assert.equal(sweepDays(new Date(NOW - 3600e3).toISOString(), NOW), 3);
    assert.equal(sweepDays(new Date(NOW - 5 * 86400e3).toISOString(), NOW), 6);
    assert.equal(sweepDays(new Date(NOW - 400 * 86400e3).toISOString(), NOW), 60);
  });
});

describe("Gabbai 25 Sep D1/D2: codes and words", () => {
  it("every loop-review reason is a code from a closed set, including the ledger's free-text reasons", async () => {
    for (const [txn, reason] of [["t-r1", "RES-ZZZ999: 0 reservations match code ZZZ999 — not recorded"], ["t-r2", "JRM-1999: hotel request #999 not found"], ["t-r3", "something new and odd"], ["t-r4", "legacy_transaction_conflict"]]) {
      await recordNmiException({ pool, invoiceNumber: "RES-ABC123", amountUsd: 12, transactionId: txn, paidAt: new Date(NOW).toISOString(), brand: "nesher", reason, path: "recovery" });
    }
    await shadowNmiPayment({ pool, invoiceNumber: "OPEN-1", amountUsd: 5, transactionId: "t-r5", paidAt: new Date(NOW).toISOString(), brand: "nesher", path: "open", decision: { action: "exception", reason: "no_crm_reference" } });
    const r = await loopReview({ pool, now: new Date() });
    assert.equal(r.count, 5);
    for (const i of r.items) assert.match(i.reason, /^[a-z_]{1,60}$/, i.reason);
    assert.deepEqual(r.items.map((i) => i.reason).sort(), ["before_live_no_crm_reference", "booking_not_found", "legacy_transaction_conflict", "request_not_found", "review"]);
    assert.equal(reasonCode("RES-X: 2 reservations match code X — not recorded"), "booking_not_found");
  });
  it("every line that tells a person to enter, take off, delete or adjust says to check first", () => {
    const acts = /\b(enter|take (it|the refund|that money)? ?off|delete|adjust)\b/i;
    const checks = /\bif\b|Do not enter/i;
    const lines = [...Object.entries(REVIEW_WORDS), ...Object.entries(NOTE_REASON_WORDS).map(([k, v]) => ["note:" + k, reviewNoteText(10, "t", k)])];
    for (const [k, v] of lines) if (acts.test(v)) assert.match(v, checks, k);
    assert.match(REVIEW_WORDS.refund_voided, /no money moved/);
    assert.match(REVIEW_WORDS.legacy_transaction_conflict, /already recorded on another booking\. Do not enter it twice/);
    assert.match(reviewNoteText(10, "t", "legacy_transaction_conflict"), /already recorded on another booking.*Do not enter it twice/);
  });
  it("a refund voided at the processor is its own reason: no money moved", async () => {
    await sweep([{ id: "t-rv", order: "", orig: "t-sale-x", cond: "canceled", actions: [{ type: "refund", amount: "-20.00", at: NOW - 3600e3 }, { type: "void", amount: "-20.00", at: NOW - 60e3 }] }]);
    assert.equal((await one("SELECT reason FROM nesher_money_payment_posts WHERE transaction_id = 't-rv'")).reason, "refund_voided");
  });
});

describe("Gabbai 25 Sep C2: the public pay page carries no office words", () => {
  it("the /pay/open source never says NOT recorded or in the CRM; the office page does", () => {
    for (const brandId of ["nesher", "jrm"]) {
      const html = renderOpenPayHtml({ collectPublicKey: "k", brandId });
      assert.doesNotMatch(html, /NOT recorded/);
      assert.doesNotMatch(html, /in the CRM/);
      assert.match(html, /Card payment received\. Thank you\./);
    }
    assert.match(renderOfficePayHtml({ collectPublicKey: "k" }), /NOT recorded in the CRM automatically/);
  });
});

describe("#27 the loop-review list", () => {
  it("has the contract shape, newest first, no card digits, no transaction id", async () => {
    await shadowNmiPayment({ pool, invoiceNumber: "OPEN-20260924-X1", amountUsd: 4750, transactionId: "12573566896", paidAt: new Date(NOW - 86400e3).toISOString(), brand: "nesher", path: "open", decision: { action: "exception", reason: "no_crm_reference" } });
    await recordNmiException({ pool, invoiceNumber: "RES-ABC123", amountUsd: 30, transactionId: "12599999999", paidAt: new Date(NOW).toISOString(), brand: "nesher", reason: "invoice_amount_mismatch", path: "webhook" });
    const r = await loopReview({ pool, now: new Date() });
    assert.equal(r.ok, true);
    assert.equal(typeof r.as_of, "string");
    assert.equal(r.count, 2);
    for (const i of r.items) {
      assert.deepEqual(Object.keys(i).sort(), ["amount_cents", "at", "booking", "brand", "currency", "reason", "words"]);
      assert.equal(i.currency, "USD");
      assert.doesNotMatch(JSON.stringify(i), /12573566896|12599999999/);
      assert.ok(i.words.length > 20);
    }
    assert.ok(r.items[0].at >= r.items[1].at);
    assert.equal(r.items.find((i) => i.amount_cents === 3000).booking, "RES-ABC123");
    assert.equal(r.items.find((i) => i.amount_cents === 475000).booking, null);
  });
});

describe("#44 scrubDigits in Mercury notes", () => {
  const PAN = ["4111", "1111", "1111", "1111"];
  const seps = { "en dash": "–", "em dash": "—", minus: "−", "nb hyphen": "‑", slash: "/", underscore: "_",
    "thin space": " ", "narrow nbsp": " ", "figure space": " ", "ideographic space": "　",
    rlm: " ‏", lrm: "‎", zwsp: "​", "word joiner": "⁠", dots: ".", "dot space": ". ", tab: "\t" };
  for (const [name, sep] of Object.entries(seps)) {
    it(`cuts a card with ${name} between the groups`, () => {
      const out = scrubDigits(`Cohen card ${PAN.join(sep)} please`);
      assert.doesNotMatch(out.replace(/\D/g, ""), /41111111/);
      assert.match(out, /••1111/);
    });
  }
  it("cuts full-width digits", () => {
    const wide = "4111111111111111".split("").map((c) => String.fromCharCode(c.charCodeAt(0) - 48 + 0xFF10)).join("");
    assert.match(scrubDigits(`card ${wide}`), /••1111/);
  });
  it("keeps an amount and a short date readable", () => {
    assert.equal(scrubDigits("paid 1,240.00 on 12/27/2026 for 3 nights"), "paid 1,240.00 on 12/27/2026 for 3 nights");
    assert.equal(scrubDigits("acct 000123456789"), "acct ••6789");
  });
});

describe("#77 the office page's words", () => {
  it("say what happened in the CRM", () => {
    assert.equal(officeCrmState({ crmRecorded: true }), "recorded");
    assert.equal(officeCrmState({ crmRecorded: false, crmPending: true, needsReview: true }), "review");
    assert.equal(officeCrmState({ crmRecorded: false, crmPending: true }), "pending");
    assert.equal(officeCrmState({}), "none");
    assert.match(OFFICE_DONE_WORDS.recorded, /nothing to enter/);
    assert.match(OFFICE_DONE_WORDS.pending, /before entering anything/);
    assert.equal(OFFICE_DONE_WORDS.none, "Card payment received. Thank you.");
  });
});
