// Mr Money audit #150 (25 Sep leftover lane, reworked on the Gabbai leftover verdict C8). Mercury's AR answer has no
// paid date and its updatedAt equals createdAt (live, every paid invoice), so the map dated a paid invoice by the day
// it was SENT. The one owner of "when was this Mercury payment paid" is the CRM row paySync writes for it (paidAtOf =
// first sight, see test/money-leftover-loop.test.js) or its ledger review row; the map READS that row, so its Mercury
// section and its booking list name the same day. Rows written before the fix keep their day (RES-A3L4RS stays 9 Aug
// unless a separately reviewed CRM correction moves it). paySync's own Mercury rows are not "recorded by a rep".
// Written RED FIRST against live 855d016. Fixtures only: an in-memory PGlite CRM. READ ONLY.
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { buildMoneyMap, loadCrm, periodFor, parseNmiTransactions } from "../money-map.js";

class PGlitePool {
  constructor(db) { this.db = db; }
  query(sql, params) { return this.db.query(sql, params); }
  async connect() { return { query: (s, p) => this.db.query(s, p), release() {} }; }
}
let db; let pool;
beforeEach(async () => {
  if (db) await db.close();
  db = new PGlite();
  pool = new PGlitePool(db);
  await db.exec(`
    CREATE TABLE core_reservation (id INTEGER PRIMARY KEY, reservation_code TEXT NOT NULL, customer_price NUMERIC(12,2), supplier_cost NUMERIC(12,2), booked_with_points BOOLEAN);
    CREATE TABLE core_payment (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, amount NUMERIC(12,2) NOT NULL,
      method TEXT NOT NULL, paid_at TIMESTAMPTZ NOT NULL, notes TEXT, created_at TIMESTAMPTZ NOT NULL, reservation_id INTEGER NOT NULL);
    CREATE TABLE core_jrmhotelpayment (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payment_date DATE NOT NULL,
      amount NUMERIC(12,2) NOT NULL, currency TEXT NOT NULL, method TEXT NOT NULL, reference TEXT,
      created_at TIMESTAMPTZ NOT NULL, offer_id INTEGER, request_id INTEGER NOT NULL);
    CREATE TABLE core_jrmhoteloffer (id INTEGER PRIMARY KEY, request_id INTEGER, currency TEXT, hotel_price NUMERIC, markup NUMERIC, customer_price NUMERIC, customer_answer_status TEXT);
    CREATE TABLE core_jrmhotelrequest (id INTEGER PRIMARY KEY, status TEXT);
    CREATE TABLE core_refund (id INTEGER PRIMARY KEY, reservation_id INTEGER);
    INSERT INTO core_reservation (id, reservation_code, customer_price, supplier_cost, booked_with_points) VALUES (7, 'A3L4RS', 8037, 7000, false), (9, 'NEWRUL', 500, 400, false);
  `);
});
after(async () => { if (db) await db.close(); });

const NOW = Date.parse("2026-08-12T12:00:00Z");
const day = (d) => periodFor({ period: "day", date: d }, NOW);
const OLD = { id: "inv-a3l4", invoiceNumber: "RES-A3L4RS", status: "Paid", amount: 4018.5, createdAt: "2026-08-09T20:00:32.065Z", updatedAt: "2026-08-09T20:00:32.065Z" };
const NEW = { id: "inv-newr", invoiceNumber: "RES-NEWRUL", status: "Paid", amount: 500, createdAt: "2026-08-09T09:00:00.000Z", updatedAt: "2026-08-09T09:00:00.000Z" };
async function rows() {
  // RES-A3L4RS: written before the fix (paid_at = the day sent, 9 Aug 20:00Z = 23:00 IL); RES-NEWRUL: the new rule
  // (paid_at = first sight, 10 Aug). One rep-typed bank row without a marker, on RES-NEWRUL, 10 Aug.
  await pool.query(`INSERT INTO core_payment (amount, method, paid_at, notes, created_at, reservation_id) VALUES
    (4018.5, 'other', '2026-08-09T20:00:32Z', '[Mercury sync] Invoice RES-A3L4RS paid via Mercury pay link mercury:inv-a3l4', '2026-08-10T16:15:28Z', 7),
    (500, 'bank', '2026-08-10T16:15:28Z', '[Mercury sync] Invoice RES-NEWRUL paid via Mercury pay link mercury:inv-newr', '2026-08-10T16:15:28Z', 9),
    (120, 'bank', '2026-08-10T09:00:00Z', 'wire from the customer', '2026-08-10T09:00:00Z', 9)`);
}
async function mapFor(d, invoices = [OLD, NEW]) {
  const period = day(d);
  const crm = await loadCrm(pool, period, { res: [], jrm: [] });
  return buildMoneyMap({ period, nowMs: NOW, nmi: parseNmiTransactions("<nm_response></nm_response>"), bank: [], invoices, crm,
    sources: { nmi: { ok: true }, mercury: { ok: true }, invoices: { ok: true }, crm: { ok: true } } });
}
const inBookings = (m, code) => JSON.stringify((m.bookings && m.bookings.items) || []).includes(code);

describe("#150 a Mercury invoice is dated by the payment the CRM recorded for it", () => {
  it("a row written by the new rule (first sight 10 Aug) counts on 10 Aug, not on the day it was sent", async () => {
    await rows();
    const m10 = await mapFor("2026-08-10");
    const m09 = await mapFor("2026-08-09");
    assert.equal(m10.brands.nesher.mercury_invoices.paid, 500);
    assert.equal(m09.brands.nesher.mercury_invoices.paid, 4018.5, "RES-NEWRUL is not on 9 Aug any more");
    assert.ok(inBookings(m10, "NEWRUL"));
    assert.ok(m10.notes.some((n) => /dated by the day on the payment the CRM recorded for it, or on its review row/.test(n)));
    assert.ok(!m10.notes.some((n) => /wait for a person/.test(n)), "no ledger-dated invoice here");
  });

  it("RES-A3L4RS (written before the fix, paid_at 9 Aug) lands on the SAME day in the Mercury section and the booking list", async () => {
    await rows();
    const m09 = await mapFor("2026-08-09", [OLD]);
    const m10 = await mapFor("2026-08-10", [OLD]);
    assert.equal(m09.brands.nesher.mercury_invoices.paid, 4018.5);
    assert.ok(inBookings(m09, "A3L4RS"));
    assert.equal(m10.brands.nesher.mercury_invoices.paid, 0);
    assert.ok(!inBookings(m10, "A3L4RS"));
  });

  it("paySync's own Mercury rows (bank|other + mercury: marker) are not 'recorded by a rep'; a rep's bank row still is", async () => {
    await rows();
    const m10 = await mapFor("2026-08-10");
    assert.deepEqual(m10.brands.nesher.recorded_other_rails, { bank: 120 });
    const m09 = await mapFor("2026-08-09");
    assert.equal(m09.brands.nesher.recorded_other_rails.other, undefined, "the 4018.50 Mercury row is not counted twice");
  });

  it("R2: an invoice dated by its ledger review row is counted apart - it waits for a person and is NOT in the CRM", () => {
    const period = day("2026-08-11");
    const crm = { nesherInPeriod: [], reservations: [], nesherAll: [], jrmInPeriod: [], jrmAll: [], offers: [], requests: [], refundRows: [],
      mercuryPaid: [{ invoice_id: "inv-held", paid_at: "2026-08-11T08:00:00Z", source: "ledger" }] };
    const m = buildMoneyMap({ period, nowMs: NOW, nmi: parseNmiTransactions("<nm_response></nm_response>"), bank: [],
      invoices: [{ id: "inv-held", invoiceNumber: "RES-A3L4RS", status: "Paid", amount: 300, updatedAt: "2026-08-01T10:00:00Z" }], crm,
      sources: { nmi: { ok: true }, mercury: { ok: true }, invoices: { ok: true }, crm: { ok: true } } });
    // F4 (25 Sep evening, a deliberate requirement change): an invoice waiting for a person is not confirmed money -
    // shown apart as held_for_person, not counted in paid or the confirmed total
    assert.equal(m.brands.nesher.mercury_invoices.paid, 0);
    assert.deepEqual(m.brands.nesher.mercury_invoices.held_for_person, { count: 1, amount: 300 });
    assert.ok(m.notes.some((n) => /1 paid invoice\(s\) \(\$300\) wait for a person and are not counted until the CRM records them \(held_for_person\); dated by when our sync first saw them paid/.test(n)), m.notes.join(" | "));
  });

  it("an invoice with no CRM record keeps the day it was sent, and the notes say so; an unreadable CRM says so too", () => {
    const period = day("2026-08-09");
    const base = { nesherInPeriod: [], reservations: [], nesherAll: [], jrmInPeriod: [], jrmAll: [], offers: [], requests: [], refundRows: [], mercuryPaid: [] };
    const run = (crm) => buildMoneyMap({ period, nowMs: NOW, nmi: parseNmiTransactions("<nm_response></nm_response>"), bank: [], invoices: [OLD], crm,
      sources: { nmi: { ok: true }, mercury: { ok: true }, invoices: { ok: true }, crm: { ok: Boolean(crm) } } });
    const seenNone = run(base);
    assert.equal(seenNone.brands.nesher.mercury_invoices.paid, 4018.5);
    assert.ok(seenNone.notes.some((n) => /1 paid invoice\(s\) with no CRM record are dated by when they were sent/.test(n)));
    const blind = run(null);
    assert.equal(blind.brands.nesher.mercury_invoices.paid, 4018.5);
    assert.ok(blind.notes.some((n) => /dated by when it was sent: the CRM could not be read/.test(n)));
  });

  it("the read: reservation paid_at, hotel payment_date (an Israel day) and a ledger review row, in the READ ONLY transaction", async () => {
    await db.exec(`CREATE TABLE nesher_money_payment_posts (transaction_id TEXT PRIMARY KEY, paid_at TIMESTAMPTZ NOT NULL)`);
    await rows();
    await pool.query(`INSERT INTO core_jrmhotelpayment (payment_date, amount, currency, method, reference, created_at, request_id) VALUES ('2026-08-11', 90, 'USD', 'bank', 'Mercury JRM-142 mercury:inv-h1', '2026-08-11T09:00:00Z', 42)`);
    await pool.query(`INSERT INTO nesher_money_payment_posts (transaction_id, paid_at) VALUES ('mercury_inv-fly1', '2026-08-11T08:00:00Z'), ('t-card-9', '2026-08-11T08:00:00Z')`);
    const data = await loadCrm(pool, day("2026-08-10"), { res: [], jrm: [] });
    const by = Object.fromEntries(data.mercuryPaid.map((r) => [r.invoice_id, r.payment_date ? String(r.payment_date).slice(0, 10) : new Date(r.paid_at).toISOString()]));
    assert.deepEqual(by, { "inv-a3l4": "2026-08-09T20:00:32.000Z", "inv-newr": "2026-08-10T16:15:28.000Z", "inv-h1": "2026-08-11", "inv-fly1": "2026-08-11T08:00:00.000Z" });
    const jrm = buildMoneyMap({ period: day("2026-08-11"), nowMs: NOW, nmi: parseNmiTransactions("<nm_response></nm_response>"), bank: [],
      invoices: [{ id: "inv-h1", invoiceNumber: "JRM-142", status: "Paid", amount: 90, updatedAt: "2026-08-01T10:00:00Z" }], crm: data,
      sources: { nmi: { ok: true }, mercury: { ok: true }, invoices: { ok: true }, crm: { ok: true } } });
    assert.equal(jrm.brands.jrm.mercury_invoices.paid, 90);
  });
});
