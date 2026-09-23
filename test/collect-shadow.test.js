// Plan 17.3 / 17.4 - the collection loop in SHADOW mode, on a real Postgres
// engine (PGlite). Proves: the shadow path writes ONLY its ledger, plans with
// the live write code, sees every path once per transaction, compares against
// what the legacy writer did, and cannot write a CRM table even if asked to.
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  recordNmiPaidInvoice,
  recordNmiPaidInvoiceLegacy,
  shadowNmiPayment,
  recordNmiException,
  mercuryMethod,
  repUserId,
  syncPaidInvoices,
  listInvoicesViaSeat,
} from "../payments-sync.js";
import {
  postingMode,
  observeShadowPayment,
  shadowReport,
  captureClient,
  observeSafely,
} from "../payment-posts.js";

class PGlitePool {
  constructor(db) { this.db = db; this.waiters = []; this.busy = false; }
  query(sql, params) { return this.db.query(sql, params); }
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
        if (next) next(); else this.busy = false;
      },
    };
  }
}

let db;
let pool;
const n = async (sql, p = []) => Number((await pool.query(sql, p)).rows[0].n);
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];

beforeEach(async () => {
  if (db) await db.close();
  db = new PGlite();
  pool = new PGlitePool(db);
  await db.exec(`
    CREATE TABLE core_reservation (id INTEGER PRIMARY KEY, reservation_code TEXT NOT NULL,
      amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0, notes TEXT, updated_at TIMESTAMPTZ);
    CREATE TABLE core_jrmhotelrequest (id INTEGER PRIMARY KEY);
    CREATE TABLE core_jrmhoteloffer (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL);
    CREATE TABLE core_payment (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      amount NUMERIC(12,2) NOT NULL, method TEXT NOT NULL, paid_at TIMESTAMPTZ NOT NULL, notes TEXT,
      created_at TIMESTAMPTZ NOT NULL, created_by_id INTEGER, reservation_id INTEGER NOT NULL,
      cash_location TEXT, cash_location_other TEXT, points_account_id INTEGER, points_qty INTEGER,
      transfer_details TEXT, zelle_address TEXT, points_cost_per_point NUMERIC(12,2));
    CREATE TABLE core_jrmhotelpayment (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      payment_date TIMESTAMPTZ NOT NULL, amount NUMERIC(12,2) NOT NULL, currency TEXT NOT NULL,
      method TEXT NOT NULL, reference TEXT, note TEXT, created_at TIMESTAMPTZ NOT NULL,
      created_by_id INTEGER, offer_id INTEGER, request_id INTEGER NOT NULL, card_last4 TEXT);
    CREATE TABLE core_jrmhotelnote (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      note TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, created_by_id INTEGER, request_id INTEGER NOT NULL);
    INSERT INTO core_reservation (id, reservation_code, amount_paid, notes) VALUES (7, 'ABC123', 0, ''), (8, 'OTHER', 20, '');
    INSERT INTO core_jrmhotelrequest (id) VALUES (42);
    INSERT INTO core_jrmhoteloffer (id, request_id) VALUES (99, 42);
  `);
});
after(async () => { if (db) await db.close(); });

const crmCounts = async () => ({
  payments: await n("SELECT COUNT(*) AS n FROM core_payment"),
  hotelPayments: await n("SELECT COUNT(*) AS n FROM core_jrmhotelpayment"),
  hotelNotes: await n("SELECT COUNT(*) AS n FROM core_jrmhotelnote"),
  paid7: Number((await one("SELECT amount_paid FROM core_reservation WHERE id = 7")).amount_paid),
  notes7: (await one("SELECT notes FROM core_reservation WHERE id = 7")).notes,
});
const ZERO = { payments: 0, hotelPayments: 0, hotelNotes: 0, paid7: 0, notes7: "" };
const EV = { invoiceNumber: "RES-ABC123", amountUsd: 40, transactionId: "12600000001", paidAt: "2026-09-23T10:00:00.000Z" };

describe("posting mode", () => {
  it("is shadow unless MONEY_POSTING_MODE is exactly live", () => {
    assert.equal(postingMode({}), "shadow");
    assert.equal(postingMode({ MONEY_POSTING_MODE: "" }), "shadow");
    assert.equal(postingMode({ MONEY_POSTING_MODE: "on" }), "shadow");
    assert.equal(postingMode({ MONEY_POSTING_MODE: "livee" }), "shadow");
    assert.equal(postingMode({ MONEY_POSTING_MODE: "live" }), "live");
  });
});

describe("shadow observation writes only the ledger", () => {
  it("plans a reservation post with the live code and leaves every CRM table untouched", async () => {
    const r = await shadowNmiPayment({ pool, ...EV, path: "guest", cardLast4: "4242", rep: "Hershy", decision: { action: "post" } });
    assert.equal(r.ok, true);
    assert.equal(r.would_action, "post");
    assert.deepEqual(await crmCounts(), ZERO);
    const row = await one("SELECT * FROM nesher_money_payment_posts WHERE transaction_id = $1", [EV.transactionId]);
    assert.equal(row.state, "shadow");
    assert.equal(row.mode, "shadow");
    assert.equal(row.brand, "nesher");
    assert.equal(row.card_last4, "4242");
    assert.equal(row.rep, "Hershy");
    const writes = row.would.writes.map((w) => `${w.op} ${w.table}`);
    assert.deepEqual(writes, ["INSERT core_payment", "UPDATE core_reservation"]);
    const ins = row.would.writes[0];
    assert.equal(ins.params[1], "card");
    assert.equal(ins.params[4], "7");
    assert.equal(ins.params[5], String(repUserId("Hershy")));
    assert.match(ins.params[3], /card ending 4242, taken by Hershy nmi:12600000001$/);
  });

  it("sees the same transaction from every path exactly once (replay + concurrency)", async () => {
    const paths = ["guest", "webhook", "recovery", "webhook", "webhook"];
    await Promise.all(paths.map((path) => shadowNmiPayment({ pool, ...EV, path, decision: { action: "post" } })));
    assert.equal(await n("SELECT COUNT(*) AS n FROM nesher_money_payment_posts"), 1);
    const row = await one("SELECT seen_count, paths, would_action FROM nesher_money_payment_posts");
    assert.equal(row.seen_count, 5);
    assert.deepEqual([...row.paths].sort(), ["guest", "recovery", "webhook"]);
    assert.equal(row.would_action, "post");
    assert.deepEqual(await crmCounts(), ZERO);
  });

  it("flags a transaction id that comes back with different facts, never merges it", async () => {
    await shadowNmiPayment({ pool, ...EV, path: "guest" });
    const r = await shadowNmiPayment({ pool, ...EV, amountUsd: 41, path: "webhook" });
    assert.equal(r.conflict, true);
    assert.equal((await one("SELECT reason FROM nesher_money_payment_posts")).reason, "transaction_conflict");
    assert.equal(Number((await one("SELECT amount_cents FROM nesher_money_payment_posts")).amount_cents), 4000);
  });

  it("keeps a sale with no CRM reference visible as review, with its brand, and refuses a brandless one", async () => {
    const r = await shadowNmiPayment({ pool, invoiceNumber: "OPEN-20260922-71fde3", amountUsd: 3140, transactionId: "12589139842", brand: "nesher", path: "open", decision: { action: "exception", reason: "no_crm_reference" } });
    assert.equal(r.would_action, "review");
    const row = await one("SELECT brand, would_action, reason FROM nesher_money_payment_posts");
    assert.deepEqual(row, { brand: "nesher", would_action: "review", reason: "no_crm_reference" });
    const bad = await shadowNmiPayment({ pool, invoiceNumber: "NMI-1", amountUsd: 1, transactionId: "1" });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "brand_unknown");
    assert.equal(await n("SELECT COUNT(*) AS n FROM nesher_money_payment_posts"), 1);
  });

  it("the READ ONLY belt: a write that slips past the capture is refused by Postgres itself", async () => {
    const sneaky = async (client, out) => {
      await client.query(`WITH x AS (INSERT INTO core_payment (amount, method, paid_at, created_at, reservation_id)
        VALUES (1, 'card', NOW(), NOW(), 7) RETURNING id) SELECT id FROM x`);
      out.recorded.push("should never get here");
    };
    const r = await observeShadowPayment({ pool, ev: { ...EV, brand: "nesher", path: "guest" }, write: sneaky });
    assert.equal(r.would_action, "review");
    assert.equal(r.reason, "plan_failed");
    assert.equal(await n("SELECT COUNT(*) AS n FROM core_payment"), 0);
  });

  it("the capture client returns a fake row count and records the statement", async () => {
    const writes = [];
    const c = captureClient({ query: async () => ({ rows: [{ ok: 1 }] }) }, writes);
    const w = await c.query("UPDATE core_reservation SET amount_paid = 1 WHERE id = $1", [7]);
    const s = await c.query("SELECT 1");
    assert.equal(w.rowCount, 1);
    assert.deepEqual(s.rows, [{ ok: 1 }]);
    assert.deepEqual(writes, [{ op: "UPDATE", table: "core_reservation", params: ["7"] }]);
  });

  it("observeSafely never lets the observer fail or stall a money path", async () => {
    assert.equal(await observeSafely(undefined, {}), null);
    assert.deepEqual(await observeSafely(async () => { throw new Error("x"); }, {}), { ok: false, error: "observe_failed" });
    const slow = await observeSafely(() => new Promise(() => {}), {}, 20);
    assert.deepEqual(slow, { ok: false, error: "observe_timeout" });
  });
});

describe("shadow report compares would-post with what legacy did", () => {
  it("office CRM-ref sale: shadow then the legacy writer = match", async () => {
    const ev = { invoiceNumber: "JRM-142-O99", amountUsd: 75, transactionId: "12600000002", paidAt: "2026-09-23T10:00:00.000Z", cardLast4: "5692", rep: "Sruly" };
    await shadowNmiPayment({ pool, ...ev, path: "office" });
    const legacy = await recordNmiPaidInvoiceLegacy({ pool, ...ev });
    assert.equal(legacy.ok, true);
    const p = await one("SELECT method, card_last4, created_by_id, request_id FROM core_jrmhotelpayment");
    assert.deepEqual(p, { method: "card", card_last4: "5692", created_by_id: 7, request_id: 42 });
    const { tally, items } = await shadowReport({ pool });
    assert.equal(tally.matches, 1);
    assert.equal(tally.mismatches, 0);
    assert.equal(items[0].brand, "jrm");
    assert.deepEqual(items[0].would_row, { table: "core_jrmhotelpayment", target: 42, cents: 7500 });
  });

  it("guest pay-code sale: legacy wrote a note only = a named mismatch (the gap live closes)", async () => {
    await shadowNmiPayment({ pool, ...EV, path: "guest" });
    await pool.query("UPDATE core_reservation SET notes = notes || $1 WHERE id = 7", [`\n[Mercury Pay] NMI card $40.00 txn ${EV.transactionId}. mark the Mercury invoice PAID, never cancel.`]);
    const { tally, items } = await shadowReport({ pool });
    assert.equal(tally.mismatches, 1);
    assert.equal(items[0].mismatch_reason, "legacy_note_only_no_payment_row");
    assert.equal(items[0].legacy_note, true);
  });

  it("an exception that legacy never posted = match; one legacy DID post = mismatch", async () => {
    await shadowNmiPayment({ pool, invoiceNumber: "OPEN-1", amountUsd: 10, transactionId: "12600000003", brand: "nesher", decision: { action: "exception", reason: "no_crm_reference" } });
    await shadowNmiPayment({ pool, ...EV, transactionId: "12600000004", decision: { action: "exception", reason: "invoice_amount_mismatch" } });
    await recordNmiPaidInvoiceLegacy({ pool, ...EV, transactionId: "12600000004" });
    const { tally, items } = await shadowReport({ pool });
    assert.equal(tally.matches, 1);
    assert.equal(tally.mismatches, 1);
    assert.equal(items.find((i) => i.transaction_id === "12600000004").mismatch_reason, "legacy_posted_but_new_path_reviews:invoice_amount_mismatch");
  });
});

describe("live mode: exactly once, partial, over, reversal, and the flip never reposts shadow", () => {
  it("replay + concurrency on one transaction = one payment row, one balance increment", async () => {
    const runs = await Promise.all(Array.from({ length: 6 }, () => recordNmiPaidInvoice({ pool, ...EV, path: "webhook" })));
    assert.ok(runs.every((r) => r.ok));
    const c = await crmCounts();
    assert.equal(c.payments, 1);
    assert.equal(c.paid7, 40);
  });

  it("partial payments on one booking are separate transactions and both count", async () => {
    await recordNmiPaidInvoice({ pool, ...EV, transactionId: "12600000011", amountUsd: 25 });
    await recordNmiPaidInvoice({ pool, ...EV, transactionId: "12600000012", amountUsd: 15 });
    const c = await crmCounts();
    assert.equal(c.payments, 2);
    assert.equal(c.paid7, 40);
  });

  it("an overpayment / second charge / refund goes to the exception door, never a CRM table", async () => {
    const over = await recordNmiException({ pool, ...EV, transactionId: "12600000021", amountUsd: 400, reason: "invoice_amount_mismatch", path: "webhook" });
    const refund = await recordNmiException({ pool, invoiceNumber: "NMI-12588835274", amountUsd: 1.01, transactionId: "12588835274", brand: "jrm", kind: "refund", reason: "reversal_requires_review", path: "recovery" });
    assert.equal(over.durable, true);
    assert.equal(refund.durable, true);
    assert.deepEqual(await crmCounts(), ZERO);
    const rows = (await pool.query("SELECT transaction_id, state, reason, kind, brand FROM nesher_money_payment_posts ORDER BY transaction_id")).rows;
    assert.deepEqual(rows, [
      { transaction_id: "12588835274", state: "review", reason: "reversal_requires_review", kind: "refund", brand: "jrm" },
      { transaction_id: "12600000021", state: "review", reason: "invoice_amount_mismatch", kind: "sale", brand: "nesher" },
    ]);
  });

  it("a transaction first seen in shadow is never re-posted by the live path after the flip", async () => {
    await shadowNmiPayment({ pool, ...EV, path: "guest" });
    const r = await recordNmiPaidInvoice({ pool, ...EV, path: "webhook" });
    assert.equal(r.ok, false);
    assert.equal(r.state, "shadow");
    assert.deepEqual(r.errors, ["observed_in_shadow"]);
    assert.deepEqual(await crmCounts(), ZERO);
  });
});

describe("17.4 going forward: method, rep, last four", () => {
  it("a Mercury pay-link payment is never written as the non-choice 'mercury'", () => {
    assert.equal(mercuryMethod({ creditCardEnabled: false, achDebitEnabled: true }), "bank");
    assert.equal(mercuryMethod({ creditCardEnabled: true, achDebitEnabled: true }), "other");
    assert.equal(mercuryMethod({}), "other");
  });

  it("the sync writes bank for an ACH-only invoice, through the seat source", async () => {
    const hop = { read: async () => ({ status: 200, body: JSON.stringify({ complete: true, invoices: [
      { id: "minv-9", invoiceNumber: "RES-ABC123", status: "Paid", amount: 40, creditCardEnabled: false, achDebitEnabled: true, updatedAt: "2026-09-23T09:00:00Z" },
      { id: "minv-10", invoiceNumber: "RES-OTHER", status: "Unpaid", amount: 5 },
    ] }) }) };
    const out = await syncPaidInvoices({ pool, listInvoices: () => listInvoicesViaSeat(hop) });
    assert.equal(out.source, "money-seat");
    assert.deepEqual(out.errors, []);
    assert.equal(out.checked, 1);
    assert.equal((await one("SELECT method FROM core_payment")).method, "bank");
    const again = await syncPaidInvoices({ pool, listInvoices: () => listInvoicesViaSeat(hop) });
    assert.equal(again.recorded.length, 0);
    assert.equal(await n("SELECT COUNT(*) AS n FROM core_payment"), 1);
  });

  it("a seat answer that is partial, malformed or refused is an error, never 'nothing paid'", async () => {
    for (const r of [
      { status: 503, body: "{}" },
      { status: 200, body: "not json" },
      { status: 200, body: JSON.stringify({ complete: false, invoices: [] }) },
      { status: 200, body: JSON.stringify({ complete: true, invoices: [{ id: "a" }, { id: "a" }] }) },
    ]) {
      const out = await syncPaidInvoices({ pool, listInvoices: () => listInvoicesViaSeat({ read: async () => r }) });
      assert.equal(out.errors.length, 1);
      assert.equal(out.checked, 0);
    }
  });

  it("rep ids are the verified roster only; anyone else is null", () => {
    assert.equal(repUserId("Hershy"), 3);
    assert.equal(repUserId("sruly"), 7);
    assert.equal(repUserId("Goldie"), 2);
    assert.equal(repUserId("Joseph"), 10);
    assert.equal(repUserId("Richter"), null);
    assert.equal(repUserId(""), null);
  });
});
