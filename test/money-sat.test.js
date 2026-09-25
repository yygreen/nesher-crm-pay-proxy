// Mr Money leftovers, 25 Sep evening (Joseph ~16:20 IL: "reguler work i never said dont waork" / "make it perfect").
// Written RED FIRST against live 37b7864 (build 2026-09-25-leftover-loop). Fixtures only: fake query.php XML, an
// in-memory PGlite CRM, a fake Mercury read. No network, no real CRM, no gateway call, no card number.
//  1. /__nesher_pay/sale: every match carries the sale's NMI authorization code (auth_code) and the id of the latest
//     refund transaction on it (last_back_txn) - names agreed with the phone's docs reader (money-docs-livefix lane).
//  2. crm-search: every booking carries remaining_balance_usd = the CRM's OWN Reservation.remaining_balance (price +
//     services - refunds to the customer - payments - ledger applications - active sponsorships), so the phone's
//     "Use $X" comes back from a complete source. balance_usd (price minus paid) stays for ranking only.
//  3. money map (F4, Gabbai s.8 (b)): a Mercury invoice marked PAID after a card payment is not counted a second time,
//     and one held for a person is shown apart - under the MONEY_LEFTOVER_LOOP switch.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import * as cc from "../card-charge.js";
import { mintTicket } from "../ocr-card.js";
import * as cs from "../crm-search.js";
import * as mm from "../money-map.js";

// ── 1. /sale ─────────────────────────────────────────────────────────────────────────────────────────────
const SECRET = "test-ocr-secret-0123456789abcdef";
const NOW_MS = Date.now();
const DAYS = (n) => NOW_MS - n * 86400000;
function stampOf(ms) { const d = new Date(ms); const p = (n) => String(n).padStart(2, "0"); return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`; }
function txXml(t) {
  const acts = (t.actions || []).map((a) => `<action><amount>${a.amount}</amount><action_type>${a.type}</action_type><date>${stampOf(a.at)}</date><success>${a.success === false ? 0 : 1}</success><batch_id>0</batch_id></action>`).join("");
  return `<transaction><transaction_id>${t.id}</transaction_id><order_id>${t.order || ""}</order_id><original_transaction_id>${t.orig || ""}</original_transaction_id><processor_id>${t.proc || "mav7067"}</processor_id><condition>${t.cond || "complete"}</condition><cc_type>visa</cc_type><cc_number>4xxxxxxxxxxx1111</cc_number>` +
    (t.auth != null ? `<authorization_code>${t.auth}</authorization_code>` : "") + `<first_name></first_name><last_name></last_name>${acts}</transaction>`;
}
const nmiXml = (list) => `<?xml version="1.0" encoding="UTF-8"?><nm_response>${list.map(txXml).join("")}</nm_response>`;
function ledger() {
  return [
    // settled $500 sale, two refunds by their own transactions: the LATER one is last_back_txn
    { id: "txn-100", order: "RES-79RHW4", auth: "OK123A", actions: [{ type: "sale", amount: "500.00", at: DAYS(3) }] },
    { id: "txn-101", orig: "txn-100", actions: [{ type: "refund", amount: "-100.00", at: DAYS(2) }] },
    { id: "txn-102", orig: "txn-100", actions: [{ type: "refund", amount: "-50.00", at: DAYS(1) }] },
    // fully refunded; a 6-digit approval code is a real code
    { id: "txn-500", order: "RES-FULLRF", auth: "123456", actions: [{ type: "sale", amount: "25.00", at: DAYS(9) }] },
    { id: "txn-501", orig: "txn-500", actions: [{ type: "refund", amount: "-25.00", at: DAYS(8) }] },
    // 7+ digits is never shown as a code (card-number shaped); money back as an action on the sale itself has no own id
    { id: "txn-600", order: "RES-SELFRF", auth: "1234567", actions: [{ type: "sale", amount: "90.00", at: DAYS(6) }, { type: "refund", amount: "-10.00", at: DAYS(5) }] },
    // a code with a separator, and no code at all
    { id: "txn-700", order: "RES-SEPARA", auth: "AB-12", actions: [{ type: "sale", amount: "30.00", at: DAYS(4) }] },
    { id: "txn-800", order: "RES-NOCODE", actions: [{ type: "sale", amount: "40.00", at: DAYS(4) }] },
    // a refund that was itself voided moved nothing: it is not last_back_txn
    { id: "txn-900", order: "RES-VOIDRF", auth: "Z9", actions: [{ type: "sale", amount: "60.00", at: DAYS(7) }] },
    { id: "txn-901", orig: "txn-900", cond: "canceled", actions: [{ type: "refund", amount: "-60.00", at: DAYS(6) }, { type: "void", amount: "-60.00", at: DAYS(6) + 60000 }] },
  ];
}
async function startDoor(handler, deps) {
  const server = http.createServer((req, res) => handler(req, res, { log: () => {}, ...deps }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

describe("1. /__nesher_pay/sale carries the approval code and the refund reference (names agreed with the phone)", () => {
  beforeEach(() => cc._resetSaleCache());
  it("salesFromXml: auth_code and last_back_txn per sale, guarded", () => {
    const { sales } = cc.salesFromXml(nmiXml(ledger()), { nowMs: NOW_MS });
    const by = Object.fromEntries(sales.map((s) => [s.txn_id, s]));
    assert.equal(by["txn-100"].auth_code, "OK123A");
    assert.equal(by["txn-100"].last_back_txn, "txn-102", "the latest refund, the one last_back_at names");
    assert.equal(by["txn-100"].last_back_cents, 5000);
    assert.equal(by["txn-500"].auth_code, "123456");
    assert.equal(by["txn-500"].last_back_txn, "txn-501");
    assert.equal(by["txn-600"].auth_code, null, "7+ digits is never shown");
    assert.equal(by["txn-600"].last_back_txn, null, "a refund action on the sale itself has no own id");
    assert.equal(by["txn-600"].last_back_cents, 1000);
    assert.equal(by["txn-700"].auth_code, null);
    assert.equal(by["txn-800"].auth_code, null);
    assert.equal(by["txn-800"].last_back_txn, null);
    assert.equal(by["txn-900"].last_back_txn, null, "a voided refund moved nothing");
  });
  it("POST /sale: each match carries auth_code + last_back_txn; the key set is pinned (a rename on either side goes red)", async () => {
    const fetchImpl = async (url) => ({ ok: true, status: 200, text: async () => nmiXml(ledger()) });
    const s = await startDoor(cc.handleSaleLookup, { secret: SECRET, fetchImpl, privateKey: "k", env: { REFUND_CAP_CENTS: "100000" } });
    try {
      const t = mintTicket({ kind: "sale", repId: "joseph", bind: "joseph", secret: SECRET });
      const r = await fetch(s.url + cc.SALE_PATH, { method: "POST", headers: { "content-type": "application/json", "x-ocr-ticket": t.token }, body: JSON.stringify({ rep: "joseph", q: { txn: "txn-100" } }) });
      const body = await r.json();
      assert.equal(r.status, 200);
      const m = body.matches[0];
      assert.equal(m.auth_code, "OK123A");
      assert.equal(m.last_back_txn, "txn-102");
      assert.deepEqual(Object.keys(m).sort(), ["action", "amount_cents", "at", "auth_code", "booking", "card_type", "condition", "last4", "last_back_at",
        "last_back_cents", "last_back_txn", "merchant", "order_id", "processor_id", "refundable_cents", "refunded_cents", "settled", "txn_id", "voidable_cents", "voided", "why"]);
    } finally { await s.close(); }
  });
});

// ── 2. crm-search remaining_balance_usd ─────────────────────────────────────────────────────────────────────
async function crmDb({ noSponsorTable = false } = {}) {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE core_customer (id bigint primary key, full_name varchar, email varchar, phone varchar, created_at timestamptz, is_business_customer boolean);
    CREATE TABLE core_traveler (id bigint primary key, full_name varchar, reservation_id bigint, customer_price numeric);
    CREATE TABLE core_reservation (id bigint primary key, reservation_code varchar, customer_price numeric, amount_paid numeric, notes text, created_at timestamptz,
      customer_id bigint, is_closed boolean, review_status varchar, booked_with_points boolean, agent_name varchar, pricing_mode varchar);
    CREATE TABLE core_journey (id bigint primary key, reservation_id bigint, line_type varchar, customer_price numeric);
    CREATE TABLE core_payment (id bigint primary key, amount numeric, method varchar, paid_at timestamptz, notes text, reservation_id bigint, transfer_details varchar, zelle_address varchar);
    CREATE TABLE core_customerpaymentapplication (id bigint primary key, amount numeric, reservation_id bigint, legacy_payment_id bigint, customer_payment_id bigint);
    ${noSponsorTable ? "" : "CREATE TABLE core_organizationsponsorship (id bigint primary key, amount numeric, applied_amount numeric, is_active boolean, reservation_id bigint);"}
    CREATE TABLE core_customerpayment (id bigint primary key, amount numeric, method varchar, paid_at timestamptz, notes text, customer_id bigint, imported_from_legacy_payments boolean, transfer_details varchar);
    CREATE TABLE core_refund (id bigint primary key, refund_type varchar, amount_expected numeric, amount_received numeric, amount_to_customer numeric, status varchar, notes text, created_at timestamptz, reservation_id bigint);
    CREATE TABLE core_jrmhotelrequest (id bigint primary key, customer_name varchar, phone varchar, email varchar, city varchar, check_in date, check_out date, status varchar,
      requested_hotel varchar, internal_notes text, created_at timestamptz, customer_id bigint);
    CREATE TABLE core_jrmhotelpayment (id bigint primary key, payment_date date, amount numeric, currency varchar, method varchar, reference varchar, note text, request_id bigint, card_last4 varchar);
    INSERT INTO core_customer VALUES (1, 'Moshe Cohen', 'moshe@example.com', '+1 (845) 555-0101', '2026-01-02', false);
    INSERT INTO core_reservation VALUES
      (100, 'TOTAL1', 2000, 1000, null, '2026-03-01', 1, false, 'complete', false, null, 'total'),
      (101, 'PERTRP', 999, 0, null, '2026-02-01', 1, false, 'complete', false, null, 'per_traveler'),
      (102, 'PERTRV', 0, 0, null, '2026-01-15', 1, false, 'complete', false, null, 'per_traveler');
    -- 100 (total mode): the reservation price rules; a trip row is detail only; services add once
    INSERT INTO core_journey VALUES (1, 100, 'service', 300), (2, 100, 'trip', 5000),
    -- 101 (per traveler): real trip totals rule over travellers; a service adds once
                                    (3, 101, 'trip', 700), (4, 101, 'trip', 600), (5, 101, 'service', 50);
    INSERT INTO core_traveler VALUES (10, 'Rivka Cohen', 101, 999), (11, 'Dov Cohen', 102, 400), (12, 'Leah Cohen', 102, 300);
    INSERT INTO core_refund VALUES (1, 'partial', 0, 0, 100, 'completed', null, '2026-03-05', 100);
    -- payments: 500 legacy; 400 migrated into the ledger (counted ONCE, as its application); 1350 on 101
    INSERT INTO core_payment VALUES (1000, 500, 'zelle', '2026-03-02', null, 100, null, null), (1001, 400, 'card', '2026-03-03', null, 100, null, null),
                                    (1002, 1350, 'bank', '2026-02-02', null, 101, null, null);
    INSERT INTO core_customerpaymentapplication VALUES (1, 400, 100, 1001, null), (2, 200, 100, null, 7);
    ${noSponsorTable ? "" : "INSERT INTO core_organizationsponsorship VALUES (1, 250, 150, true, 100), (2, 80, null, true, 100), (3, 999, null, false, 100);"}
  `);
  return { query: (sql, params) => pg.query(sql, params), exec: (s) => pg.exec(s), pg };
}

describe("2. crm-search returns the CRM's own full balance as remaining_balance_usd", () => {
  it("price + services - refunds to the customer - payments - ledger applications - active sponsorships (applied amount first)", async () => {
    const d = await crmDb();
    const s = cs.createCrmSearch({ getPool: () => d });
    const r = await s.answer(new URLSearchParams("q=Cohen"));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = Object.fromEntries(r.body.nesher.people[0].bookings.map((x) => [x.booking, x]));
    // 2000 + 300 - 100 - 500 - (400 + 200) - (150 + 80) = 870
    assert.equal(b.TOTAL1.remaining_balance_usd, 870);
    assert.equal(b.TOTAL1.balance_usd, 1000, "balance_usd stays price minus paid (ranking only)");
    // (700 + 600) + 50 - 1350 = 0
    assert.equal(b.PERTRP.remaining_balance_usd, 0);
    // no trip rows: travellers 400 + 300 = 700
    assert.equal(b.PERTRV.remaining_balance_usd, 700);
    assert.ok(r.body.notes.some((n) => /remaining_balance_usd is the CRM's own balance/.test(n)));
    assert.equal(typeof cs.REMAINING_BALANCE_SQL, "string", "one text, used by the search and by the live drift proof");
  });
  it("a balance that cannot be read is null (never a guess), everything else still answers, and it is counted", async () => {
    const d = await crmDb({ noSponsorTable: true });
    const s = cs.createCrmSearch({ getPool: () => d });
    const r = await s.answer(new URLSearchParams("q=Cohen"));
    assert.equal(r.status, 200);
    const bk = r.body.nesher.people[0].bookings;
    assert.equal(bk.length, 3);
    assert.ok(bk.every((x) => x.remaining_balance_usd === null));
    assert.ok(bk.every((x) => typeof x.balance_usd === "number"));
    assert.ok(r.body.notes.some((n) => /remaining_balance_usd could not be read/.test(n)));
    assert.equal(s.health().balance_errors, 1);
  });
});

// ── 3. money map F4 ────────────────────────────────────────────────────────────────────────────────────────
const NOWM = Date.parse("2026-09-20T12:00:00Z");
const DAY = mm.periodFor({ period: "day", date: "2026-09-18" }, NOWM);
const inv = (id, ref, amount) => ({ id, invoiceNumber: ref, status: "Paid", amount, createdAt: "2026-09-18T08:00:00Z", updatedAt: "2026-09-18T08:00:00Z" });
function mapOf(crmExtra, invoices) {
  const crm = { nesherInPeriod: [], reservations: [], nesherAll: [], jrmInPeriod: [], jrmAll: [], offers: [], requests: [], refundRows: [], mercuryPaid: [], mercuryCardRows: [], ...crmExtra };
  return mm.buildMoneyMap({ period: DAY, nowMs: NOWM, nmi: mm.parseNmiTransactions("<nm_response></nm_response>"), bank: [], invoices, crm,
    sources: { nmi: { ok: true }, mercury: { ok: true }, invoices: { ok: true }, crm: { ok: true } } });
}
describe("3. money map F4: a Mercury invoice marked PAID after a card payment is not counted twice; one held for a person is apart", () => {
  const crm = {
    mercuryPaid: [{ invoice_id: "m-rec", paid_at: "2026-09-18T09:00:00Z", source: "crm" }, { invoice_id: "m-held", paid_at: "2026-09-18T10:00:00Z", source: "ledger" }],
    mercuryCardRows: [{ ref: "RES-CARDED", amount: 750 }],
  };
  const invoices = [inv("m-rec", "RES-RECORD", 100), inv("m-held", "RES-HELD01", 1000), inv("m-marked", "RES-CARDED", 750), inv("m-plain", "RES-PLAIN1", 40)];
  it("on: recorded + plain are Mercury paid; the held one and the marked-after-card one are shown apart and not in the confirmed total", () => {
    const m = mapOf(crm, invoices);
    const I = m.brands.nesher.mercury_invoices;
    assert.equal(I.paid, 140);
    assert.equal(I.count, 2);
    assert.deepEqual(I.held_for_person, { count: 1, amount: 1000 });
    assert.deepEqual(I.marked_paid_after_card, { count: 1, amount: 750 });
    assert.ok(m.notes.some((n) => /1 paid invoice\(s\) \(\$1000\) wait for a person and are not counted/.test(n)), m.notes.join(" | "));
    assert.ok(m.notes.some((n) => /1 invoice\(s\) \(\$750\) were marked paid on a booking whose card payment of the same amount is already counted/.test(n)), m.notes.join(" | "));
  });
  it("off (MONEY_LEFTOVER_LOOP=off): everything paid is counted, as on 07c394c", () => {
    process.env.MONEY_LEFTOVER_LOOP = "off";
    try {
      const I = mapOf(crm, invoices).brands.nesher.mercury_invoices;
      assert.equal(I.paid, 1890);
      assert.equal(I.held_for_person, undefined);
      assert.equal(I.marked_paid_after_card, undefined);
    } finally { delete process.env.MONEY_LEFTOVER_LOOP; }
  });
  it("loadCrm reads the card rows of the paid invoices' bookings (anchored nmi: marker), read only", async () => {
    const pg = new PGlite();
    await pg.exec(`
      CREATE TABLE core_reservation (id bigint primary key, reservation_code varchar, customer_price numeric, supplier_cost numeric, booked_with_points boolean);
      CREATE TABLE core_payment (id bigint primary key, amount numeric, method varchar, paid_at timestamptz, notes text, created_at timestamptz, reservation_id bigint);
      CREATE TABLE core_jrmhotelpayment (id bigint primary key, payment_date date, amount numeric, currency varchar, method varchar, reference varchar, created_at timestamptz, offer_id bigint, request_id bigint);
      CREATE TABLE core_jrmhoteloffer (id bigint primary key, request_id bigint, currency varchar, hotel_price numeric, markup numeric, customer_price numeric, customer_answer_status varchar);
      CREATE TABLE core_jrmhotelrequest (id bigint primary key, status varchar);
      CREATE TABLE core_refund (id bigint primary key, reservation_id bigint);
      INSERT INTO core_reservation VALUES (7, 'CARDED', 0, 0, false), (8, 'NOCARD', 0, 0, false);
      INSERT INTO core_payment VALUES (1, 750, 'card', '2026-09-10', 'Card payment ... nmi:t-750', '2026-09-10', 7), (2, 750, 'card', '2026-09-10', 'typed by hand', '2026-09-10', 8),
                                      (3, 20, 'card', '2026-09-10', 'VOID nmi-void:t-9', '2026-09-10', 8);
      INSERT INTO core_jrmhotelpayment VALUES (1, '2026-09-10', 400, 'USD', 'card', 'JRM-142 nmi:t-400', '2026-09-10', null, 42);
    `);
    const pool = { query: (s, p) => pg.query(s, p), connect: async () => ({ query: (s, p) => pg.query(s, p), release() {} }) };
    const data = await mm.loadCrm(pool, DAY, { res: [], jrm: [], mercury: { res: ["CARDED", "NOCARD"], jrm: [42] } });
    assert.deepEqual((data.mercuryCardRows || []).map((r) => r.ref + ":" + r.amount).sort(), ["JRM-142:400", "RES-CARDED:750"]);
    await pg.close();
  });
});
