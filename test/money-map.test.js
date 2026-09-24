// money-map.js (F6): processed per brand, fees measured from the bank, contribution per booking.
// Fixtures only: no test touches NMI, Mercury or the CRM. Each reconciliation trap from plan 16.5
// has its own test, named after the trap.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import {
  MONEY_MAP_BUILD,
  MONEY_MAP_PATH,
  periodFor,
  ilDate,
  ilMidnightMs,
  parseNmiTransactions,
  classifyTransaction,
  buildBatches,
  classifyBankRow,
  matchBatches,
  buildMoneyMap,
  jrmCost,
  loadCrm,
  createMoneyMap,
} from "../money-map.js";
import { createMoneyHop, hopSignedHeaders, MONEY_HOP_PREFIX } from "../money-hop.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");
const SEPT = periodFor({ period: "month", date: "2026-09-10" }, NOW);
const SECRET_KEY = "nmi-secret-key-must-never-appear-0123456789";

// ── fixture builders ─────────────────────────────────────────────────────────
function tx({ id, order = "", proc = "mav7067", cond = "complete", cc = "Visa", hint = "", rep = "", orig = "", actions }) {
  const acts = actions.map((a) => `<action><amount>${a.amount}</amount><action_type>${a.type}</action_type><date>${a.date}</date><success>${a.success === 0 ? 0 : 1}</success><batch_id>${a.batch || 0}</batch_id><processor_batch_id>001</processor_batch_id></action>`).join("");
  // PII the parser must never carry: names, email, masked card.
  return `<transaction><transaction_id>${id}</transaction_id><original_transaction_id>${orig}</original_transaction_id><condition>${cond}</condition><order_id>${order}</order_id>`
    + `<first_name>Moshe</first_name><last_name>Cohenfixture</last_name><email>moshe@example.com</email><cc_number>4xxxxxxxxxxx1111</cc_number>`
    + `<processor_id>${proc}</processor_id><cc_type>${cc}</cc_type>`
    + (hint ? `<merchant_defined_field id="1">${hint}</merchant_defined_field>` : "")
    + (rep ? `<merchant_defined_field id="5">${rep}</merchant_defined_field>` : "")
    + acts + `</transaction>`;
}
const xml = (...t) => `<?xml version="1.0"?><nm_response>${t.join("")}</nm_response>`;
const sale = (id, amount, date, batch, extra = {}) => tx({ id, actions: [{ type: "sale", amount, date }, ...(batch ? [{ type: "settle", amount, date: batch.date, batch: batch.id }] : [])], ...extra });
function bank(id, amount, createdAt, desc, name = "M MERCHANT", kind = "other") {
  return { id, amount, createdAt, postedAt: createdAt, status: "sent", kind, counterpartyName: name, bankDescription: desc };
}
const DEP = "M MERCHANT; CR CD DEP; FLYNESHER.COM";
const DIS = "M MERCHANT; DLY DIS S; FLYNESHER.COM";
const JDEP = "M MERCHANT; CR CD DEP; JRM HOTELS";
const JDIS = "M MERCHANT; DLY DIS S; JRM HOTELS";
function bankRowsOf(list) {
  // the same shaping buildMoneyMap receives from createMoneyMap (via the exported classifier)
  return list.map((t) => ({ id: t.id, at: Date.parse(t.createdAt), createdMs: Date.parse(t.createdAt), amount: t.amount, pending: false, ...classifyBankRow(t) }));
}
function map({ nmi, bankList = [], invoices = [], crm = null, period = SEPT, nowMs = NOW, nmiFrom = null }) {
  return buildMoneyMap({
    period,
    nowMs,
    nmi: nmi == null ? null : parseNmiTransactions(nmi),
    bank: bankList == null ? null : bankRowsOf(bankList),
    invoices,
    crm,
    sources: { nmi: { ok: nmi != null, ...(nmiFrom ? { window: { from: nmiFrom } } : {}) }, mercury: { ok: bankList != null }, invoices: { ok: true }, crm: { ok: Boolean(crm) } },
  });
}
const emptyCrm = () => ({ nesherInPeriod: [], reservations: [], nesherAll: [], jrmInPeriod: [], jrmAll: [], offers: [], requests: [] });

// ── periods ─────────────────────────────────────────────────────────────────
describe("periods are Israel days, weeks, months", () => {
  it("September 2026 runs from Israel midnight 1 Sep to Israel midnight 1 Oct", () => {
    assert.equal(SEPT.start_at, "2026-08-31T21:00:00.000Z");
    assert.equal(SEPT.end_at, "2026-09-30T21:00:00.000Z");
    assert.equal(SEPT.end, "2026-09-30");
    assert.equal(SEPT.open, true);
  });
  it("October crosses the end of summer time (25 Oct) and still ends at Israel midnight", () => {
    const oct = periodFor({ period: "month", date: "2026-10-05" }, NOW);
    assert.equal(oct.start_at, "2026-09-30T21:00:00.000Z");
    assert.equal(oct.end_at, "2026-10-31T22:00:00.000Z");
  });
  it("a week is Sunday to Saturday; a day is one Israel calendar day", () => {
    const w = periodFor({ period: "week", date: "2026-09-24" }, NOW); // a Thursday
    assert.equal(w.start, "2026-09-20");
    assert.equal(w.end, "2026-09-26");
    const d = periodFor({ period: "day", date: "2026-09-24" }, NOW);
    assert.equal(d.start_at, "2026-09-23T21:00:00.000Z");
    assert.equal(ilDate(Date.parse("2026-09-23T21:30:00Z")), "2026-09-24");
    assert.equal(ilMidnightMs("2026-09-24"), Date.parse("2026-09-23T21:00:00Z"));
  });
  it("a custom range is inclusive, capped, and bad input is refused in words", () => {
    const r = periodFor({ period: "range", start: "2026-09-01", end: "2026-09-15" }, NOW);
    assert.equal(r.kind, "range");
    assert.equal(r.end, "2026-09-15");
    assert.equal(periodFor({ period: "range", start: "2026-06-01", end: "2026-09-15" }, NOW).error, "range_too_wide");
    assert.equal(periodFor({ period: "range", start: "2026-09-15", end: "2026-09-01" }, NOW).error, "start_after_end");
    assert.equal(periodFor({ period: "day", date: "2026-02-30" }, NOW).error, "bad_date");
    assert.equal(periodFor({ period: "year" }, NOW).error, "bad_period");
  });
});

// ── parsing: never PII ───────────────────────────────────────────────────────
describe("the processor's record", () => {
  it("reads only ids, order, processor, card brand, stamps and actions - no name, email or card digits", () => {
    const t = parseNmiTransactions(xml(sale("T1", 100, "20260910100000", { id: "B1", date: "20260911020000" }, { rep: "Sruly", hint: "jrm" })));
    const s = JSON.stringify(t);
    for (const bad of ["Moshe", "Cohenfixture", "example.com", "1111", "4xxx"]) assert.ok(!s.includes(bad), bad);
    assert.equal(t[0].rep, "Sruly");
    assert.equal(t[0].brandHint, "jrm");
    assert.equal(t[0].cardType, "Visa");
  });
});

// ── trap 16.5.1 / 16.5.2 ─────────────────────────────────────────────────────
describe("trap 16.5.1: a card sale, its settlement and its deposit are ONE payment", () => {
  it("one sale settled and deposited counts once in processed, once in cash, and its fee is measured", () => {
    const m = map({
      nmi: xml(sale("T1", 1000, "20260910100000", { id: "B1", date: "20260911020000" })),
      bankList: [bank("d1", 1000, "2026-09-12T12:45:00Z", DEP), bank("f1", -19.9, "2026-09-12T12:45:00Z", DIS, "Merchant Services")],
    });
    const c = m.brands.nesher.card;
    assert.equal(c.gross_sales, 1000);
    assert.equal(c.sale_count, 1);
    assert.equal(m.bank.processor_deposits.mav7067.amount, 1000);
    assert.equal(m.brands.nesher.fees.measured, 19.9);
    assert.equal(m.brands.nesher.fees.effective_rate, 0.0199);
    assert.equal(m.batches[0].match, "one_to_one");
    assert.equal(m.batches[0].fee.source, "daily discount debit beside the deposit");
  });
});

describe("trap 16.5.2: authorisations, captures and deposits stay distinct", () => {
  it("an authorisation alone is not money; a capture counts at the captured amount; the settle is not a second sale", () => {
    const m = map({
      nmi: xml(
        tx({ id: "A1", cond: "pending", actions: [{ type: "auth", amount: 500, date: "20260910100000" }] }),
        tx({ id: "A2", actions: [
          { type: "auth", amount: 800, date: "20260910100000" },
          { type: "capture", amount: 600, date: "20260910110000" },
          { type: "settle", amount: 600, date: "20260911020000", batch: "B9" },
        ] }),
      ),
      bankList: [],
    });
    const c = m.brands.nesher.card;
    assert.equal(c.gross_sales, 600);
    assert.equal(c.sale_count, 1);
    assert.deepEqual(c.authorised_not_captured, { count: 1, amount: 500 });
    assert.equal(classifyTransaction(parseNmiTransactions(xml(tx({ id: "F1", cond: "failed", actions: [{ type: "sale", amount: 9, date: "20260910100000", success: 0 }] })))[0]).kind, "failed");
  });
  it("a voided sale is left out of processed and counted apart", () => {
    const m = map({ nmi: xml(tx({ id: "V1", cond: "canceled", actions: [{ type: "sale", amount: 0.01, date: "20260908211442" }, { type: "void", amount: 0.01, date: "20260908212753" }] })), bankList: [] });
    assert.equal(m.brands.nesher.card.gross_sales, 0);
    assert.deepEqual(m.brands.nesher.card.voids_excluded, { count: 1, amount: 0.01 });
  });
});

// ── trap 16.5.3 ──────────────────────────────────────────────────────────────
describe("trap 16.5.3: partial payments and many payments to one settlement are normal", () => {
  it("two batches paid in ONE deposit match many-to-one and the fee is shared by sales", () => {
    const m = map({
      nmi: xml(
        sale("S1", 300, "20260918100000", { id: "B1", date: "20260919020000" }),
        sale("S2", 700, "20260919100000", { id: "B2", date: "20260920020000" }),
      ),
      bankList: [bank("d1", 1000, "2026-09-21T12:45:00Z", DEP), bank("f1", -20, "2026-09-21T12:45:00Z", DIS, "Merchant Services")],
    });
    assert.equal(m.match_summary.many_to_one, 2);
    const fees = m.batches.map((b) => b.fee.amount).sort((a, b) => a - b);
    assert.deepEqual(fees, [6, 14]);
    assert.equal(m.brands.nesher.fees.measured, 20);
  });
  it("two partial card payments for one booking both count, and the booking sums them", () => {
    const crm = { ...emptyCrm(),
      reservations: [{ id: 5, reservation_code: "ABC123", customer_price: 1000, supplier_cost: 800, booked_with_points: false }],
    };
    const m = map({
      nmi: xml(
        sale("P1", 400, "20260910100000", { id: "B1", date: "20260911020000" }, { order: "RES-ABC123" }),
        sale("P2", 600, "20260912100000", { id: "B2", date: "20260913020000" }, { order: "RES-ABC123" }),
      ),
      bankList: [
        bank("d1", 400, "2026-09-11T12:45:00Z", DEP), bank("f1", -8, "2026-09-11T12:45:00Z", DIS, "Merchant Services"),
        bank("d2", 600, "2026-09-14T12:45:00Z", DEP), bank("f2", -12, "2026-09-14T12:45:00Z", DIS, "Merchant Services"),
      ],
      crm,
    });
    assert.equal(m.brands.nesher.card.gross_sales, 1000);
    const b = m.bookings.items.find((i) => i.ref === "ABC123");
    assert.equal(b.received_to_date, 1000);
    assert.equal(b.card_fees.measured, 20);
    assert.equal(b.contribution.amount, 180); // 1000 - 800 - 20
    assert.equal(b.contribution.final, true);
    assert.equal(b.contribution.estimate, false);
  });
  it("a deposit short of its batch (net-of-fee shape) measures the fee as the shortfall", () => {
    const m = map({ nmi: xml(sale("N1", 1000, "20260910100000", { id: "B1", date: "20260911020000" })), bankList: [bank("d1", 980.1, "2026-09-12T12:45:00Z", DEP)] });
    assert.equal(m.batches[0].match, "net_of_fee");
    assert.equal(m.batches[0].fee.amount, 19.9);
    assert.equal(m.batches[0].fee.source, "deposit short of the batch total");
  });
});

// ── trap 16.5.5: zero unexplained money, not a forced match ────────────────────
describe("trap 16.5.5: an honest unresolved item beats a tidy wrong one", () => {
  it("a deposit that equals no batch is NOT forced onto one; an old batch stays unmatched, a young one awaits", () => {
    const m = map({
      nmi: xml(
        sale("U1", 1000, "20260905100000", { id: "B1", date: "20260906020000" }),
        sale("U2", 250, "20260923100000", { id: "B2", date: "20260924020000" }),
      ),
      bankList: [bank("d1", 900, "2026-09-07T12:45:00Z", DEP)], // 10% short: outside the net-of-fee band
    });
    const byId = Object.fromEntries(m.batches.map((b) => [b.batch_id, b]));
    assert.equal(byId.B1.match, "unmatched");
    assert.equal(byId.B1.fee, null);
    assert.equal(byId.B2.match, "awaiting_deposit");
    assert.equal(m.match_summary.deposits_not_matched.length, 1);
    assert.equal(m.brands.nesher.fees.measured, 0);
    assert.equal(m.brands.nesher.fees.unmatched_on, 1000);
    assert.equal(m.brands.nesher.fees.effective_rate, null);
  });
  it("a fee debit beside two same-moment deposits is not guessed", () => {
    const m = map({
      nmi: xml(
        sale("X1", 100, "20260910100000", { id: "B1", date: "20260911020000" }),
        sale("X2", 200, "20260910110000", { id: "B2", date: "20260911021000" }),
      ),
      bankList: [bank("d1", 100, "2026-09-12T12:45:00Z", DEP), bank("d2", 200, "2026-09-12T12:45:00Z", DEP), bank("f1", -5.97, "2026-09-12T12:45:00Z", DIS, "Merchant Services")],
    });
    assert.equal(m.match_summary.one_to_one, 2);
    assert.equal(m.match_summary.with_measured_fee, 0);
    assert.equal(m.match_summary.fee_debits_not_matched.length, 1);
    assert.match(m.match_summary.fee_debits_not_matched[0].reason, /not guessed/);
  });
});

// ── trap 16.5.4 ──────────────────────────────────────────────────────────────
describe("trap 16.5.4: late and reversed events never silently rewrite a closed period", () => {
  const AUG = periodFor({ period: "month", date: "2026-08-15" }, NOW);
  it("a refund in September of an August sale is counted in September, and August does not move", () => {
    const nmi = xml(
      sale("L1", 500, "20260820100000", { id: "B1", date: "20260821020000" }),
      tx({ id: "L2", orig: "L1", actions: [{ type: "refund", amount: -500, date: "20260905100000" }, { type: "settle", amount: -500, date: "20260906020000", batch: "B2" }] }),
    );
    const aug = map({ nmi, bankList: [], period: AUG });
    assert.equal(aug.brands.nesher.card.gross_sales, 500);
    assert.equal(aug.brands.nesher.card.refunds, 0);
    assert.equal(aug.late_events.length, 1);
    assert.equal(aug.late_events[0].type, "refund_after_close");
    const sep = map({ nmi, bankList: [] });
    assert.equal(sep.brands.nesher.card.refunds, 500);
    assert.equal(sep.brands.nesher.card.refunds_of_earlier_sales, 500);
    assert.equal(sep.brands.nesher.card.gross_sales, 0);
  });
  it("a void recorded after the close is listed with its effect, not applied quietly", () => {
    const nmi = xml(tx({ id: "L3", cond: "canceled", actions: [{ type: "sale", amount: 80, date: "20260831205000" }, { type: "void", amount: 80, date: "20260831213000" }] }));
    const aug = map({ nmi, bankList: [], period: AUG }); // 20:50Z on 31 Aug = 23:50 Israel, 31 Aug
    assert.equal(aug.brands.nesher.card.voids_excluded.count, 1);
    assert.equal(aug.late_events[0].type, "void_after_close");
  });
});

// ── JRM under JRM ────────────────────────────────────────────────────────────
describe("JRM money is in JRM's column, whatever account it settles into", () => {
  it("a JRM booking charged on the Nesher merchant account is JRM, with its share of the Nesher batch fee", () => {
    const m = map({
      nmi: xml(
        sale("J1", 3000, "20260917100000", { id: "B1", date: "20260918020000" }, { order: "JRM-1325", hint: "jrm" }),
        sale("J2", 1000, "20260917110000", { id: "B1", date: "20260918020000" }),
      ),
      bankList: [bank("d1", 4000, "2026-09-18T12:45:00Z", DEP), bank("f1", -80, "2026-09-18T12:45:00Z", DIS, "Merchant Services")],
    });
    assert.equal(m.brands.jrm.card.gross_sales, 3000);
    assert.equal(m.brands.jrm.card.by_merchant_account.mav7067, 3000);
    assert.equal(m.brands.jrm.fees.measured, 60);
    assert.equal(m.brands.nesher.card.gross_sales, 1000);
    assert.equal(m.brands.nesher.fees.measured, 20);
    assert.equal(m.merchant_accounts.mav7067.gross_sales, 4000);
    assert.ok(m.notes.some((n) => /ran on the NESHER merchant account/.test(n)));
  });
  it("the JRM merchant account's own deposits are matched by its own descriptor, and a refund-only batch keeps its fee", () => {
    const m = map({
      nmi: xml(
        sale("K1", 1.01, "20260915234304", { id: "B1", date: "20260916022358" }, { proc: "mav2083" }),
        tx({ id: "K2", proc: "mav2083", orig: "K1", actions: [{ type: "refund", amount: -1.01, date: "20260922193511" }, { type: "settle", amount: -1.01, date: "20260923020955", batch: "B2" }] }),
      ),
      bankList: [
        bank("d1", 1.01, "2026-09-17T12:47:00Z", JDEP), bank("f1", -0.02, "2026-09-17T12:47:00Z", JDIS, "Merchant Services"),
        bank("d2", -1.01, "2026-09-24T12:42:00Z", JDEP), bank("f2", -0.02, "2026-09-24T12:42:00Z", JDIS, "Merchant Services"),
      ],
    });
    assert.equal(m.brands.jrm.card.gross_sales, 1.01);
    assert.equal(m.brands.jrm.card.refunds, 1.01);
    assert.equal(m.match_summary.one_to_one, 2);
    assert.equal(m.brands.jrm.fees.measured, 0.04);
    assert.equal(m.brands.jrm.fees.on_refund_batches, 0.02);
  });
});

// ── contribution: missing cost is never zero ──────────────────────────────────
describe("contribution per booking (plan 16.4.1: missing costs never become zero costs)", () => {
  it("no supplier cost in the CRM = cost unknown, contribution null, counted apart", () => {
    const crm = { ...emptyCrm(),
      nesherInPeriod: [{ id: 1, amount: 500, method: "cash", paid_at: "2026-09-10T21:00:00Z", reservation_id: 9, nmi_txn: null }],
      nesherAll: [{ id: 1, amount: 500, method: "cash", paid_at: "2026-09-10T21:00:00Z", reservation_id: 9, nmi_txn: null }],
      reservations: [{ id: 9, reservation_code: "ZZZ999", customer_price: 500, supplier_cost: 0, booked_with_points: false }],
    };
    const m = map({ nmi: xml(), bankList: [], crm });
    const b = m.bookings.items[0];
    assert.equal(b.cost.status, "unknown");
    assert.equal(b.cost.amount, null);
    assert.equal(b.contribution.amount, null);
    assert.match(b.contribution.label, /cost unknown/);
    assert.equal(m.bookings.cost_unknown, 1);
    assert.equal(m.bookings.by_brand.nesher.contribution_paid_in_full, null);
    assert.deepEqual(m.brands.nesher.recorded_other_rails, { cash: 500 });
  });
  it("a card row typed into the CRM is the SAME payment as the processor sale (mutual nearest, same amount) - not two", () => {
    const crm = { ...emptyCrm(),
      nesherInPeriod: [{ id: 2, amount: 2475, method: "card", paid_at: "2026-09-21T21:00:00Z", reservation_id: 7, nmi_txn: null }],
      nesherAll: [{ id: 2, amount: 2475, method: "card", paid_at: "2026-09-21T21:00:00Z", reservation_id: 7, nmi_txn: null }],
      reservations: [{ id: 7, reservation_code: "ICQ001", customer_price: 2475, supplier_cost: 2176, booked_with_points: false }],
    };
    const m = map({
      nmi: xml(sale("C1", 2475, "20260918161322", { id: "B1", date: "20260919023846" }, { order: "OPEN-20260918-EFA26F" })),
      bankList: [bank("d1", 2475, "2026-09-21T12:45:00Z", DEP), bank("f1", -49.25, "2026-09-21T12:45:00Z", DIS, "Merchant Services")],
      crm,
    });
    const b = m.bookings.items[0];
    assert.equal(b.received_to_date, 2475);
    assert.equal(b.processor_sales_not_in_crm, 0);
    assert.equal(b.card_fees.measured, 49.25);
    assert.equal(b.contribution.amount, 249.75);
  });
  it("two same-amount candidates the same distance away are not linked; the fee is left out and SAID, not estimated", () => {
    const crm = { ...emptyCrm(),
      nesherInPeriod: [{ id: 3, amount: 100, method: "card", paid_at: "2026-09-10T21:00:00Z", reservation_id: 8, nmi_txn: null }],
      nesherAll: [{ id: 3, amount: 100, method: "card", paid_at: "2026-09-10T21:00:00Z", reservation_id: 8, nmi_txn: null }],
      reservations: [{ id: 8, reservation_code: "TIE001", customer_price: 100, supplier_cost: 50, booked_with_points: false }],
    };
    const m = map({
      nmi: xml(sale("E1", 100, "20260909100000"), sale("E2", 100, "20260913100000")),
      bankList: [],
      crm,
    });
    const b = m.bookings.items[0];
    assert.equal(b.card_fees.not_in_processor_record, 100);
    assert.equal(b.card_fees.estimated_on, 0);
    assert.equal(b.processor_sales_not_in_crm, 0);
    assert.equal(b.contribution.amount, 50); // 100 - 50, no invented fee
    assert.match(b.contribution.label, /not in our processor's record/);
  });
  it("a partly paid booking says BOTH what fee it left out and that it is not final; card rows older than the processor read are 'not checked'", () => {
    const rows = [
      { id: 1, amount: 300, method: "card", paid_at: "2026-09-10T21:00:00Z", reservation_id: 6, nmi_txn: null },
      { id: 2, amount: 200, method: "card", paid_at: "2026-07-01T21:00:00Z", reservation_id: 6, nmi_txn: null },
    ];
    const crm = { ...emptyCrm(), nesherInPeriod: [rows[0]], nesherAll: rows,
      reservations: [{ id: 6, reservation_code: "PART01", customer_price: 1000, supplier_cost: 700, booked_with_points: false }] };
    const m = map({ nmi: xml(), bankList: [], crm, nmiFrom: "2026-08-27T00:00:00Z" });
    const b = m.bookings.items[0];
    assert.equal(b.card_fees.not_in_processor_record, 300);
    assert.equal(b.card_fees.older_than_processor_read, 200);
    assert.equal(b.contribution.final, false);
    assert.match(b.contribution.label, /not in our processor's record/);
    assert.match(b.contribution.label, /older than the processor record/);
    assert.match(b.contribution.label, /not final - the booking is not paid in full/);
    assert.equal(m.bookings.by_brand.nesher.card_payments_older_than_processor_read, 200);
  });
  it("more received than the price is flagged and kept out of the totals", () => {
    const crm = { ...emptyCrm(),
      nesherInPeriod: [1, 2].map((id) => ({ id, amount: 1560, method: "bank", paid_at: "2026-09-01T21:00:00Z", reservation_id: 4, nmi_txn: null })),
      nesherAll: [1, 2].map((id) => ({ id, amount: 1560, method: "bank", paid_at: "2026-09-01T21:00:00Z", reservation_id: 4, nmi_txn: null })),
      reservations: [{ id: 4, reservation_code: "DUP001", customer_price: 1560, supplier_cost: 1400, booked_with_points: false }],
    };
    const m = map({ nmi: xml(), bankList: [], crm });
    const b = m.bookings.items[0];
    assert.ok(b.flags.includes("received more than the booking price"));
    assert.equal(b.contribution.final, false);
    assert.equal(m.bookings.by_brand.nesher.contribution_paid_in_full, null);
  });
  it("a JRM hotel cost in shekels is unknown in dollars, never converted by guess", () => {
    const pays = [{ offer_id: 86, request_id: 189 }];
    const c = jrmCost(189, [{ id: 86, request_id: 189, currency: "Shekels", hotel_price: 3385.98, customer_price: 1241, customer_answer_status: "not_sent" }], pays);
    assert.equal(c.status, "unknown");
    assert.equal(c.amount, null);
    assert.equal(c.ils, 3385.98);
    assert.equal(jrmCost(325, [], []).basis, "the request has no hotel offer in the CRM");
    const usdBad = jrmCost(1, [{ id: 1, request_id: 1, currency: "USD", hotel_price: 14161, customer_price: 5198.36, customer_answer_status: "wants_to_book" }], []);
    assert.equal(usdBad.status, "unknown");
    const ok = jrmCost(2, [{ id: 2, request_id: 2, currency: "usd", hotel_price: 900, customer_price: 1000, customer_answer_status: "wants_to_book" }], []);
    assert.deepEqual([ok.status, ok.amount], ["known", 900]);
  });
});

// ── the CRM is read inside a read-only transaction ────────────────────────────
describe("CRM access is read-only and names no one", () => {
  it("opens BEGIN READ ONLY, only SELECTs, always rolls back, and never selects a name", async () => {
    const seen = [];
    const client = {
      async query(text) {
        seen.push(String(text).trim());
        return { rows: [] };
      },
      release() { seen.push("released"); },
    };
    await loadCrm({ connect: async () => client }, SEPT, { res: ["ABC123"], jrm: ["325"] });
    assert.equal(seen[0], "BEGIN READ ONLY");
    assert.equal(seen[seen.length - 2], "ROLLBACK");
    assert.equal(seen[seen.length - 1], "released");
    for (const q of seen.slice(1, -2)) {
      assert.match(q, /^SELECT/);
      assert.doesNotMatch(q, /customer_name|first_name|last_name|email|phone|\bnotes\s*,|\bnote\b\s*,/i);
    }
  });
});

// ── the door: signed like the bank line, answered here, never by the seat ─────
describe("GET /__money_hop/money-map", () => {
  const KEY = "9".repeat(64);
  function rig() {
    const clock = { now: NOW };
    const fetchImpl = async (url, init) => {
      assert.match(String(url), /\/api\/query\.php$/);
      assert.ok(!String(url).includes(SECRET_KEY));
      assert.ok(String(init.body).includes("security_key="));
      return new Response(xml(sale("H1", 1000, "20260910100000", { id: "B1", date: "20260911020000" }, { rep: "Goldie" })), { status: 200 });
    };
    const mm = createMoneyMap({
      now: () => clock.now,
      fetchImpl,
      nmiConfig: () => ({ host: "https://fake-gateway.invalid", securityKey: SECRET_KEY }),
      mercuryRead: async (use, p) => {
        assert.equal(use, "money-map");
        if (p.startsWith("/transactions")) return { status: 200, servedBy: "direct", body: JSON.stringify({ transactions: [bank("d1", 1000, "2026-09-11T12:45:00Z", DEP), bank("f1", -19.9, "2026-09-11T12:45:00Z", DIS, "Merchant Services")] }) };
        return { status: 200, servedBy: "direct", body: JSON.stringify({ complete: true, invoices: [] }) };
      },
      getPool: () => null,
    });
    const hop = createMoneyHop({ key: KEY, now: () => clock.now, direct: (sub) => (String(sub).split("?")[0] === MONEY_MAP_PATH ? mm.hopAnswer(sub) : null) });
    const server = http.createServer(async (req, res) => { if (!(await hop.handle(req, res))) { res.writeHead(404); res.end(); } });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ port: server.address().port, hop, mm, clock, close: () => new Promise((r) => server.close(r)) })));
  }
  function get(t, sub, { sign = true, method = "GET" } = {}) {
    const h = sign ? hopSignedHeaders(KEY, method, sub, Buffer.alloc(0), t.clock.now) : {};
    return new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: t.port, method, path: MONEY_HOP_PREFIX + sub, headers: h, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  }
  it("answers a signed GET directly with the month's figures, an as-of time and the definitions", async () => {
    const t = await rig();
    try {
      const r = await get(t, "/money-map?period=month&date=2026-09-10");
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-money-hop"], "direct");
      const j = JSON.parse(r.text);
      assert.equal(j.build, MONEY_MAP_BUILD);
      assert.equal(j.as_of, new Date(NOW).toISOString());
      assert.equal(j.brands.nesher.card.gross_sales, 1000);
      assert.equal(j.brands.nesher.card.by_rep.Goldie, 1000);
      assert.equal(j.brands.nesher.fees.measured, 19.9);
      assert.ok(j.definitions.contribution && j.definitions.processed);
      assert.equal(j.bookings, null);
      assert.ok(j.notes.some((n) => /CRM could not be read/.test(n)));
      assert.ok(!r.text.includes(SECRET_KEY));
      for (const bad of ["Moshe", "example.com", "4xxx"]) assert.ok(!r.text.includes(bad), bad);
      const again = await get(t, "/money-map?period=month&date=2026-09-10");
      assert.equal(JSON.parse(again.text).cached, true);
      assert.equal(t.mm.health().cache_hits, 1);
    } finally { await t.close(); }
  });
  it("refuses unsigned (401) and non-GET (405), and a bad period is a 400 in words", async () => {
    const t = await rig();
    try {
      assert.equal((await get(t, "/money-map", { sign: false })).status, 401);
      assert.equal((await get(t, "/money-map", { method: "POST" })).status, 405);
      const bad = await get(t, "/money-map?period=range&start=2026-01-01&end=2026-09-01");
      assert.equal(bad.status, 400);
      assert.equal(JSON.parse(bad.text).error, "range_too_wide");
    } finally { await t.close(); }
  });
  it("when every source is down it says so (503), and one source down leaves its numbers null, never zero", async () => {
    const down = createMoneyMap({ now: () => NOW, nmiConfig: () => ({ host: "", securityKey: "" }), mercuryRead: async () => ({ status: 503, body: "{}" }), getPool: () => null });
    const r = await down.answer(new URLSearchParams("period=month"));
    assert.equal(r.status, 503);
    const half = map({ nmi: null, bankList: [] });
    assert.equal(half.brands.nesher.card, null);
    assert.equal(half.brands.nesher.confirmed_total, null);
    assert.ok(half.notes.some((n) => /Card figures are not available/.test(n)));
  });
});

describe("wiring", () => {
  it("Dockerfile COPY carries money-map.js; server.js builds it read-only and reports it in health", () => {
    const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(docker, /\bmoney-map\.js\b/);
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /import \{ createMoneyMap, MONEY_MAP_PATH \} from "\.\/money-map\.js"/);
    assert.match(src, /moneyMap: moneyMap\.health\(\)/);
    const mod = fs.readFileSync(new URL("../money-map.js", import.meta.url), "utf8");
    // no money-moving door, no write SQL outside the refusal list, no token by name
    assert.doesNotMatch(mod, /MERCURY_TOKEN|chargeWithToken|\/send\b|INSERT INTO|UPDATE core_|DELETE FROM/);
  });
});
