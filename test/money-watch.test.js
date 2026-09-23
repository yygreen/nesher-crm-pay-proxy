// money-watch.js: the three PC payment-watch jobs on the server, SHADOW only.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMoneyWatch, instrumentOf, statusChanges, settlementCandidates } from "../money-watch.js";

function fakeGateway(state) {
  return {
    served: {},
    async listArInvoices(use) {
      this.served[use] = state.served || "direct";
      if (state.invoicesFail) throw new Error("mercury_none_503");
      return state.invoices;
    },
    lastServed(use) { return this.served[use] || null; },
    async read(use, path) {
      state.reads = (state.reads || []).concat(path);
      this.served[use] = state.served || "direct";
      return { status: 200, body: JSON.stringify({ transactions: state.transactions || [] }), servedBy: state.served || "direct" };
    },
  };
}

/** A pool that answers the SELECTs this module makes and REFUSES anything else. */
function fakePool(db) {
  const seen = [];
  return {
    seen,
    async query(text, params = []) {
      const t = String(text).trim();
      seen.push(t.slice(0, 40));
      if (!/^SELECT/i.test(t)) throw new Error("write attempted: " + t.slice(0, 40));
      if (t.includes("FROM core_jrmhoteloffer")) return { rows: db.hotels || [] };
      if (t.includes("FROM core_flightsearchresult")) return { rows: db.flights || [] };
      if (t.includes("FROM core_jrmhotelnote")) return { rows: (db.hotelNotes || []).map((note) => ({ note })) };
      if (t.includes("FROM core_flightsearchrequest")) return { rows: (db.flightNotes || []).map((n) => ({ internal_notes: n })) };
      if (t.includes("FROM core_payment")) return { rows: (db.payments || []).filter((p) => p.notes.includes(params[0].replace(/%/g, ""))) };
      if (t.includes("FROM core_jrmhotelpayment")) return { rows: (db.hotelPayments || []).filter((p) => p.reference.includes(params[0].replace(/%/g, ""))) };
      throw new Error("unexpected query " + t.slice(0, 60));
    },
  };
}

const INV = (id, number, status, amount, createdAt = "2026-08-01T00:00:00Z") => ({ id, invoiceNumber: number, status, amount, createdAt });

describe("money-watch pure parts (ported from the PC scripts)", () => {
  it("instrumentOf: structured fields first, text second, else null", () => {
    assert.equal(instrumentOf({ cardId: "c" }), "credit/debit card");
    assert.equal(instrumentOf({ details: { electronicRoutingInfo: {} } }), "ACH bank debit");
    assert.equal(instrumentOf({ bankDescription: "STRIPE PAYOUT" }), "credit/debit card");
    assert.equal(instrumentOf({ kind: "externalTransfer", bankDescription: "ACH CREDIT" }), "ACH bank debit");
    assert.equal(instrumentOf({ bankDescription: "MERCURY" }), null);
  });
  it("statusChanges: first pass is a baseline, later a real change is reported", () => {
    const a = statusChanges(null, [INV("1", "RES-A", "Unpaid", 10)]);
    assert.equal(a.changes.length, 0);
    const b = statusChanges(a.next, [INV("1", "RES-A", "Paid", 10), INV("2", "RES-B", "Unpaid", 5)]);
    assert.equal(b.changes.length, 1);
    assert.match(b.changes[0].would, /PAYMENT RECEIVED/);
  });
  it("settlementCandidates: exact or up to 4.5% under, not before the invoice", () => {
    const inv = INV("1", "RES-A", "Paid", 100, "2026-08-10T00:00:00Z");
    const c = settlementCandidates(inv, [
      { amount: 100, createdAt: "2026-08-11T00:00:00Z" },
      { amount: 96, createdAt: "2026-08-12T00:00:00Z" },
      { amount: 95, createdAt: "2026-08-12T00:00:00Z" },
      { amount: 100, createdAt: "2026-08-01T00:00:00Z" },
    ]);
    assert.equal(c.length, 2);
  });
});

describe("money-watch shadow run", () => {
  it("runs the three jobs read-only, idempotent on the CRM markers, and never writes", async () => {
    const state = {
      invoices: [INV("i1", "RES-AAA", "Paid", 100, "2026-08-10T00:00:00Z"), INV("i2", "JRM-1123-O9", "Unpaid", 50)],
      transactions: [{ amount: 100, status: "sent", kind: "externalTransfer", createdAt: "2026-08-12T00:00:00Z", bankDescription: "ACH CREDIT" }],
    };
    const db = {
      hotels: [{ oid: 9, customer_price: 50, currency: "USD", req: 123 }, { oid: 10, customer_price: 300, currency: "ILS", req: 124 }],
      flights: [{ fid: 7, sell_price: 900, req: 55 }],
      hotelNotes: ["[Automated - Claude autopilot] Payment link ready ... (offer#9)"],
      flightNotes: [],
      payments: [{ id: 1, notes: "[Mercury sync] ... mercury:i1" }],
      hotelPayments: [],
    };
    const pool = fakePool(db);
    const w = createMoneyWatch({ gateway: fakeGateway(state), getPool: () => pool, mode: "shadow", log: () => {} });
    const r1 = await w.runOnce("test");
    assert.deepEqual(r1.errors, []);
    assert.equal(r1.watch.baseline, true);
    assert.equal(r1.watch.checked, 2);
    assert.equal(r1.watch.pc_line, "checked 2 invoices, 0 change(s)");
    assert.deepEqual(r1.autopilot.would_link.map((x) => x.num), ["JRM-1124-O10", "FLY-1055-R7"], "offer#9 already carries the PC's marker");
    assert.match(r1.autopilot.would, /SHADOW: none made/);
    assert.equal(r1.enrich.paid, 1);
    assert.equal(r1.enrich.pending, 1);
    assert.equal(r1.enrich.rows[0].would, 'label "ACH bank debit"');
    assert.match(state.reads[0], /^\/transactions\?start=\d{4}-\d{2}-\d{2}&end=\d{4}-\d{2}-\d{2}&account=checking$/);
    // second pass: a status flip is seen as a would-alert, still no write
    state.invoices = [INV("i1", "RES-AAA", "Paid", 100, "2026-08-10T00:00:00Z"), INV("i2", "JRM-1123-O9", "Paid", 50)];
    const r2 = await w.runOnce("test");
    assert.equal(r2.watch.changes.length, 1);
    assert.equal(r2.watch.changes[0].invoiceNumber, "JRM-1123-O9");
    assert.ok(pool.seen.every((q) => /^SELECT/i.test(q)), "SELECT only");
    const rep = w.report();
    assert.equal(rep.mode, "shadow");
    assert.equal(rep.history.length, 2);
    assert.equal(rep.changes_seen.length, 1);
    const text = JSON.stringify(rep);
    assert.ok(!/@/.test(text), "no email in the report");
  });

  it("an already-settled CRM payment is not pending; a failed invoice read is an error, not a clean pass", async () => {
    const state = { invoices: [INV("i1", "RES-AAA", "Paid", 100)] };
    const db = { payments: [{ id: 1, notes: "mercury:i1 [Settled 2026-08-12: paid by ACH bank debit.]" }], hotels: [], flights: [] };
    const w = createMoneyWatch({ gateway: fakeGateway(state), getPool: () => fakePool(db), mode: "shadow", log: () => {} });
    const r = await w.runOnce("test");
    assert.equal(r.enrich.pending, 0);
    assert.equal(state.reads, undefined, "no transactions read when nothing is pending");
    const w2 = createMoneyWatch({ gateway: fakeGateway({ invoicesFail: true }), getPool: () => fakePool(db), mode: "shadow", log: () => {} });
    const r2 = await w2.runOnce("test");
    assert.equal(r2.errors.length, 1);
    assert.equal(r2.watch, null);
    assert.equal(w2.summary().last_ok_at, null);
  });

  it("MONEY_WATCH=off never starts", () => {
    const w = createMoneyWatch({ gateway: fakeGateway({ invoices: [] }), mode: "off" });
    assert.equal(w.start(), false);
    assert.equal(w.summary().mode, "off");
  });
});
