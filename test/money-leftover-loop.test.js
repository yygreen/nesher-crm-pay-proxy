// Mr Money audit leftovers of 25 Sep (lane money-leftover-loop): #76 and #145 in the collection loop (#150, the
// money map, is in test/money-map-paid-day.test.js on its own branch). Written RED FIRST against live 855d016 (build 2026-09-25-mr-av-train). FAKE data only: an
// in-memory PGlite CRM + pay-link store and a fake NMI query.php. No network, no real CRM, no gateway call.
//
// #76  A customer pays half by card and the equal other half through the Mercury bank pay link: the Mercury
//      half was dropped SILENTLY. Gabbai r1 B1 ruled it can never be a post (the office marks the Mercury
//      invoice PAID after a card payment, and paySync must not count that twice). So the only silent skip left
//      is the provable #74 case; every other same-amount clash is kept for a person: one ledger review row,
//      one check-first note on the booking. Never a CRM payment row.
// #145 A guest pay link stuck on "confirming" is settled once the sweep records its sale - with the Gabbai's D4
//      guards (the sale's txn on no link yet; the sale inside the link's own attempt window; exactly one link).
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  recordNmiPaidInvoice,
  recordNmiException,
  recordSweepReversal,
  syncPaidInvoices,
  NOTE_REASON_WORDS,
} from "../payments-sync.js";
import { loopReview, REVIEW_WORDS } from "../payment-posts.js";
import { runNmiRecovery } from "../nmi-recovery.js";
import * as store from "../invoice-store.js";
import { renderInvoiceHtml } from "../invoice-page.js";

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
    CREATE TABLE nesher_pay_invoices (id TEXT PRIMARY KEY, payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL);
    INSERT INTO core_reservation (id, reservation_code, amount_paid, notes) VALUES (7, 'ABC123', 0, ''), (8, 'TWOHLF', 0, '');
    INSERT INTO core_jrmhotelrequest (id) VALUES (42);
    INSERT INTO core_jrmhoteloffer (id, request_id) VALUES (99, 42);
  `);
}
beforeEach(setup);
after(async () => { if (db) await db.close(); });

const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0];
const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
const paid = async (id) => Number((await one("SELECT amount_paid FROM core_reservation WHERE id = $1", [id])).amount_paid);
const link = (code, payload, createdAt) => pool.query(
  `INSERT INTO nesher_pay_invoices (id, payload, created_at, expires_at) VALUES ($1, $2::jsonb, $3, NOW() + INTERVAL '30 days')`,
  [code, JSON.stringify(payload), createdAt || new Date().toISOString()]);
const handRow = (amount, resId, notes = "zelle") => pool.query(`INSERT INTO core_payment (amount, method, paid_at, notes, created_at, reservation_id, cash_location, cash_location_other, points_qty, transfer_details, zelle_address, points_cost_per_point)
  VALUES ($1, 'zelle', NOW(), $2, NOW(), $3, '', '', 0, '', '', 0)`, [amount, notes, resId]);
const merc = (id, invoiceNumber, amount) => ({ id, invoiceNumber, status: "Paid", amount, createdAt: "2026-09-20T10:00:00Z", updatedAt: "2026-09-20T10:00:00Z" });
const sync = (invoices) => syncPaidInvoices({ pool, listInvoices: async () => invoices });
const ledger = async (txn) => ((await one("SELECT to_regclass('public.nesher_money_payment_posts') IS NOT NULL AS ok")).ok
  ? one("SELECT state, reason, invoice_number, amount_cents, seen_count FROM nesher_money_payment_posts WHERE transaction_id = $1", [txn])
  : undefined);
const resNotes = async (id) => String((await one("SELECT notes FROM core_reservation WHERE id = $1", [id])).notes || "");
const count = (s, part) => s.split(part).length - 1;

const T0 = Date.parse("2026-09-24T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("#76 a same-amount Mercury payment after a card payment is never dropped silently (and never posted twice)", () => {
  it("half by card on link A, the equal other half on link B through the bank: kept for a person, not silent", async () => {
    await link("aaaa2345", { invoiceNumber: "RES-TWOHLF", amountUsd: 500, mercuryUrl: "https://app.mercury.com/pay/m1", transactionId: "t-half-1", paidAt: iso(T0) }, iso(T0 - 3600e3));
    assert.equal((await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-TWOHLF", amountUsd: 500, transactionId: "t-half-1", paidAt: iso(T0), path: "guest" })).ok, true);
    // the second half: a new link for the same booking and amount, made AFTER the card payment (it reuses the
    // still-open Mercury invoice, so both links carry the same Mercury pay URL - that is how mercury.js mints)
    await link("bbbb2345", { invoiceNumber: "RES-TWOHLF", amountUsd: 500, mercuryUrl: "https://app.mercury.com/pay/m1" }, iso(T0 + 3600e3));
    const out = await sync([merc("m-inv-1", "RES-TWOHLF", 500)]);
    assert.equal(out.recorded.length, 0, "never a post: the office may also have marked it PAID after the card");
    assert.equal(await paid(8), 500);
    const row = await ledger("mercury_m-inv-1");
    assert.ok(row, "the Mercury half is kept, not dropped");
    assert.equal(row.state, "review");
    assert.equal(row.reason, "mercury_same_amount_on_booking");
    assert.equal(row.invoice_number, "RES-TWOHLF");
    assert.equal(Number(row.amount_cents), 50000);
    const notes = await resNotes(8);
    assert.equal(count(notes, "NOT recorded automatically"), 1, "one note on the booking");
    assert.match(notes, /Mercury pay-link payment \$500\.00 USD \(invoice RES-TWOHLF\)/);
    const lr = await loopReview({ pool, now: new Date() });
    const item = lr.items.find((i) => i.reason === "mercury_same_amount_on_booking");
    assert.ok(item, "on the loop-review list");
    assert.equal(item.booking, "RES-TWOHLF");
    assert.equal(item.words, REVIEW_WORDS.mercury_same_amount_on_booking);
    // the next minute's pass adds nothing: no second note, no second row, no post
    const again = await sync([merc("m-inv-1", "RES-TWOHLF", 500)]);
    assert.equal(again.recorded.length, 0);
    assert.equal(count(await resNotes(8), "NOT recorded automatically"), 1);
    assert.equal(Number((await ledger("mercury_m-inv-1")).seen_count), 2);
    assert.equal((await all("SELECT id FROM core_payment WHERE reservation_id = 8")).length, 1);
  });

  it("card half charged from the desk (no pay link) + Mercury half: kept for a person", async () => {
    assert.equal((await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-TWOHLF", amountUsd: 300, transactionId: "t-desk-1", paidAt: iso(T0), path: "chat" })).ok, true);
    const out = await sync([merc("m-inv-2", "RES-TWOHLF", 300)]);
    assert.equal(out.recorded.length, 0);
    assert.equal((await ledger("mercury_m-inv-2")).reason, "mercury_same_amount_on_booking");
    assert.equal(await paid(8), 300);
  });

  it("two equal Mercury halves: the second is kept for a person", async () => {
    const a = await sync([merc("m-inv-3", "RES-TWOHLF", 250)]);
    assert.equal(a.recorded.length, 1, "the first half posts as before");
    const b = await sync([merc("m-inv-3", "RES-TWOHLF", 250), merc("m-inv-4", "RES-TWOHLF", 250)]);
    assert.equal(b.recorded.length, 0);
    assert.equal((await ledger("mercury_m-inv-4")).reason, "mercury_same_amount_on_booking");
    assert.equal(await ledger("mercury_m-inv-3"), undefined, "the posted one has no review row");
    assert.equal(await paid(8), 250);
  });

  it("a same-amount hand-typed payment + a Mercury payment: kept for a person (the office may have typed either)", async () => {
    await handRow(120, 8);
    const out = await sync([merc("m-inv-5", "RES-TWOHLF", 120)]);
    assert.equal(out.recorded.length, 0);
    assert.match(out.skipped[0], /not duplicated/, "the skip line the health and the old tests read is unchanged");
    assert.equal((await ledger("mercury_m-inv-5")).reason, "mercury_same_amount_on_booking");
  });

  it("the hotel side: card half on request 42 + the Mercury half: one hotel note, one review row, no post", async () => {
    await link("hhhh2345", { invoiceNumber: "JRM-142-O99", amountUsd: 400, mercuryUrl: "https://app.mercury.com/pay/h1", transactionId: "t-hot-1", paidAt: iso(T0) }, iso(T0 - 3600e3));
    await link("iiii2345", { invoiceNumber: "JRM-142-O99", amountUsd: 400, mercuryUrl: "https://app.mercury.com/pay/h1" }, iso(T0 + 3600e3));
    assert.equal((await recordNmiPaidInvoice({ pool, invoiceNumber: "JRM-142-O99", amountUsd: 400, transactionId: "t-hot-1", paidAt: iso(T0), path: "guest" })).ok, true);
    const out = await sync([merc("m-inv-6", "JRM-142-O99", 400)]);
    assert.equal(out.recorded.length, 0);
    assert.equal((await all("SELECT id FROM core_jrmhotelpayment WHERE request_id = 42")).length, 1);
    assert.equal((await ledger("mercury_m-inv-6")).reason, "mercury_same_amount_on_booking");
    const hn = await all("SELECT note FROM core_jrmhotelnote WHERE request_id = 42 AND note LIKE '%NOT recorded automatically%'");
    assert.equal(hn.length, 1);
    await sync([merc("m-inv-6", "JRM-142-O99", 400)]);
    assert.equal((await all("SELECT note FROM core_jrmhotelnote WHERE request_id = 42 AND note LIKE '%NOT recorded automatically%'")).length, 1);
  });

  it("B1 stays closed: ONE link paid by card, the office marks its Mercury invoice PAID -> silent skip, nothing kept, written once", async () => {
    await link("abcd2345", { invoiceNumber: "RES-ABC123", mercuryUrl: "https://app.mercury.com/pay/x", amountUsd: 750, transactionId: "t-card", paidAt: iso(T0) }, iso(T0 - 3600e3));
    await link("efgh6789", { invoiceNumber: "JRM-142-O99", mercuryUrl: "https://app.mercury.com/pay/y", amountUsd: 400, transactionId: "t-card-h", paidAt: iso(T0) }, iso(T0 - 3600e3));
    // a never-paid link for the same money made BEFORE the card payment (superseded) does not change that
    await link("olde2345", { invoiceNumber: "RES-ABC123", mercuryUrl: "https://app.mercury.com/pay/x", amountUsd: 750 }, iso(T0 - 7200e3));
    assert.equal((await recordNmiPaidInvoice({ pool, invoiceNumber: "RES-ABC123", amountUsd: 750, transactionId: "t-card", paidAt: iso(T0), path: "guest" })).ok, true);
    assert.equal((await recordNmiPaidInvoice({ pool, invoiceNumber: "JRM-142-O99", amountUsd: 400, transactionId: "t-card-h", paidAt: iso(T0), path: "guest" })).ok, true);
    const out = await sync([merc("merc-inv-1", "RES-ABC123", 750), merc("merc-inv-2", "JRM-142-O99", 400)]);
    assert.equal(out.recorded.length, 0, JSON.stringify(out));
    assert.equal(await paid(7), 750, "one real payment of $750");
    assert.equal((await all("SELECT id FROM core_payment WHERE reservation_id = 7")).length, 1);
    assert.equal((await all("SELECT id FROM core_jrmhotelpayment WHERE request_id = 42")).length, 1);
    assert.equal(await ledger("merc-inv-1"), undefined);
    assert.equal(await ledger("mercury_merc-inv-1"), undefined, "the provable same money is not a review row");
    assert.equal(await ledger("mercury_merc-inv-2"), undefined);
    assert.equal(count(await resNotes(7), "NOT recorded automatically"), 0);
  });

  it("a Mercury payment with no same-amount row posts exactly as before", async () => {
    const out = await sync([merc("m-inv-7", "RES-ABC123", 99)]);
    assert.equal(out.recorded.length, 1);
    assert.equal(await paid(7), 99);
    assert.equal(await ledger("mercury_m-inv-7"), undefined);
  });

  it("the words check first (Gabbai D2) and name no card digits", () => {
    const w = REVIEW_WORDS.mercury_same_amount_on_booking;
    assert.match(w, /If it is the same money, nothing to enter/);
    assert.match(w, /if it is a second payment, enter it/);
    assert.match(NOTE_REASON_WORDS.mercury_same_amount_on_booking, /If that is the same money, nothing to enter; if it is a second payment, enter it\./);
    assert.doesNotMatch(w + NOTE_REASON_WORDS.mercury_same_amount_on_booking, /\d/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function stamp(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`; }
function tx({ id, order = "", proc = "mav7067", cond = "complete", actions }) {
  return `<transaction><transaction_id>${id}</transaction_id><order_id>${order}</order_id><original_transaction_id></original_transaction_id><condition>${cond}</condition>` +
    `<processor_id>${proc}</processor_id><cc_number>4xxxxxxxxxxx1111</cc_number>` +
    `<merchant_defined_field id="1">nesher</merchant_defined_field><merchant_defined_field id="5"></merchant_defined_field>` +
    actions.map((a) => `<action><action_type>${a.type}</action_type><amount>${a.amount}</amount><success>1</success><date>${stamp(a.at)}</date></action>`).join("") +
    `</transaction>`;
}
const xml = (list) => `<?xml version="1.0"?><nm_response>${list.map(tx).join("")}</nm_response>`;
const fakeNmi = (list) => async () => ({ ok: true, status: 200, text: async () => xml(list) });
const settle = (ev) => store.settleConfirmingLink(ev, pool);
// the live doors exactly as server.js builds them for the sweep, plus the #145 door (live mode only)
const sweep = (list, extra = {}) => runNmiRecovery({
  host: "https://fake", securityKey: "k", days: 3, now: new Date(T0 + 3600e3), fetchImpl: fakeNmi(list), mode: "live",
  post: (args) => recordNmiPaidInvoice({ pool, path: "recovery", ...args }),
  except: (ev) => recordNmiException({ pool, path: "recovery", ...ev }),
  reverse: (ev) => recordSweepReversal({ pool, path: "recovery", ...ev }),
  settled: typeof store.settleConfirmingLink === "function" ? settle : undefined,
  ...extra,
});
// a guest link whose sale answer was lost: claim at T0, marked confirming 40 s later (nmi-card.js order)
async function stuck(code, { ref = "RES-ABC123", amount = 55.55, claim = T0, since = T0 + 40e3, created = T0 - 600e3 } = {}) {
  await link(code, { invoiceNumber: ref, amountUsd: amount, mercuryUrl: "https://app.mercury.com/pay/z", paidAt: iso(claim), confirming: true, confirmingSince: iso(since) }, iso(created));
}
const payload = async (code) => (await one("SELECT payload FROM nesher_pay_invoices WHERE id = $1", [code])).payload;
const pageOf = async (code) => { const p = await payload(code); return renderInvoiceHtml({ ...p, confirming: p.confirming === true && !p.transactionId }); };
const CONFIRMING_WORDS = "We are confirming this payment. Please contact us before paying again.";

describe("#145 a pay link stuck on 'confirming' is settled once the sweep records its sale", () => {
  it("the sale inside the link's own attempt window is posted -> the guest page says received; the next pass adds nothing", async () => {
    await stuck("conf2345");
    assert.ok((await pageOf("conf2345")).includes(CONFIRMING_WORDS));
    const list = [{ id: "t-lost-1", order: "RES-ABC123", actions: [{ type: "sale", amount: "55.55", at: T0 + 12e3 }] }];
    const out = await sweep(list);
    assert.equal(out.posted, 1);
    assert.equal(out.linksSettled, 1);
    const p = await payload("conf2345");
    assert.equal(p.transactionId, "t-lost-1");
    assert.equal(p.confirming, undefined);
    assert.equal(p.confirmingSince, undefined);
    assert.equal(p.paidAt, iso(T0), "the claim stays the paid time");
    assert.equal(p.confirmedBy, "sweep");
    const html = await pageOf("conf2345");
    assert.ok(html.includes("Payment received. Thank you."));
    assert.ok(!html.includes(CONFIRMING_WORDS));
    assert.equal((await store.listConfirmingLinks(pool)).length, 0);
    const again = await sweep(list);
    assert.equal(again.linksSettled, 0);
    assert.equal(await paid(7), 55.55, "the CRM got the money once");
  });

  it("two stuck links for the same booking and amount: ambiguous, both left alone", async () => {
    await stuck("conf2345");
    await stuck("conf6789");
    const out = await sweep([{ id: "t-lost-2", order: "RES-ABC123", actions: [{ type: "sale", amount: "55.55", at: T0 + 12e3 }] }]);
    assert.equal(out.posted, 1);
    assert.equal(out.linksSettled, 0);
    assert.equal((await payload("conf2345")).confirming, true);
    assert.equal((await payload("conf6789")).confirming, true);
  });

  it("the office minted a new link and the guest paid it (the sale's txn is on that link): the old stuck link is NOT stamped", async () => {
    await stuck("conf2345");
    await link("newl2345", { invoiceNumber: "RES-ABC123", amountUsd: 55.55, mercuryUrl: "https://app.mercury.com/pay/z", paidAt: iso(T0 + 20e3), transactionId: "t-new-1" }, iso(T0 + 10e3));
    const out = await sweep([{ id: "t-new-1", order: "RES-ABC123", actions: [{ type: "sale", amount: "55.55", at: T0 + 25e3 }] }]);
    assert.equal(out.posted, 1);
    assert.equal(out.linksSettled, 0);
    assert.equal((await payload("conf2345")).confirming, true, "a stuck link is never stamped with another link's sale");
    assert.equal((await payload("conf2345")).transactionId, undefined);
  });

  it("a sale outside the link's attempt window (before the claim, or well after it went confirming) is not its sale", async () => {
    await stuck("conf2345");
    const early = await sweep([{ id: "t-early", order: "RES-ABC123", actions: [{ type: "sale", amount: "55.55", at: T0 - 600e3 }] }]);
    assert.equal(early.linksSettled, 0);
    const late = await sweep([{ id: "t-late", order: "RES-ABC123", actions: [{ type: "sale", amount: "55.55", at: T0 + 40e3 + 30 * 60e3 }] }]);
    assert.equal(late.linksSettled, 0);
    assert.equal((await payload("conf2345")).confirming, true);
  });

  it("a different amount, or a sale that went to review instead of the CRM, leaves the link alone", async () => {
    await stuck("conf2345");
    const other = await sweep([{ id: "t-amt", order: "RES-ABC123", actions: [{ type: "sale", amount: "55.56", at: T0 + 12e3 }] }]);
    assert.equal(other.linksSettled, 0);
    await setup();
    await stuck("conf2345", { ref: "RES-NOSUCH" });
    const rev = await sweep([{ id: "t-rev", order: "RES-NOSUCH", actions: [{ type: "sale", amount: "55.55", at: T0 + 12e3 }] }]);
    assert.equal(rev.posted, 0);
    assert.equal(rev.linksSettled, 0);
    assert.equal((await payload("conf2345")).confirming, true);
  });

  it("the store door alone: a link that is no longer confirming, or already has a txn, is never touched", async () => {
    await link("paid2345", { invoiceNumber: "RES-ABC123", amountUsd: 55.55, paidAt: iso(T0), transactionId: "t-x" });
    const r = await store.settleConfirmingLink({ invoiceNumber: "RES-ABC123", amountUsd: 55.55, transactionId: "t-y", paidAt: iso(T0 + 5e3) }, pool);
    assert.equal(r.ok, false);
    assert.equal((await payload("paid2345")).transactionId, "t-x");
    const none = await store.settleConfirmingLink({ invoiceNumber: "", amountUsd: 55.55, transactionId: "t-y", paidAt: iso(T0) }, pool);
    assert.equal(none.ok, false);
  });
});

