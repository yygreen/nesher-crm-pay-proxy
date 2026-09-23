// Gabbai 23 Sep F1-F4: after an UNKNOWN gateway outcome the pay link keeps its
// claim (never a second sale) but is shown as "confirming" - neither paid nor
// payable - until a transaction id confirms it. Real Postgres engine (PGlite).
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { renderInvoiceHtml } from "../invoice-page.js";
import { chargePayCode } from "../nmi-card.js";
import { claimInvoicePaid, markInvoiceConfirming, markInvoicePaid, listConfirmingLinks } from "../invoice-store.js";

class PGlitePool {
  constructor(db) { this.db = db; }
  query(sql, params) { return this.db.query(sql, params); }
  async connect() { return { query: (s, p) => this.db.query(s, p), release() {} }; }
}
let db;
let pool;
beforeEach(async () => { if (db) await db.close(); db = new PGlite(); pool = new PGlitePool(db); });
after(async () => { if (db) await db.close(); });

const PAGE = { amountUsd: 55.55, invoiceNumber: "RES-555TRAIN", mercuryUrl: "https://app.mercury.com/pay/x", capture: "collectjs", collectPublicKey: "pk", paidAt: "2026-09-23T10:00:00Z" };
const CONFIRMING_WORDS = "We are confirming this payment. Please contact us before paying again.";

describe("the guest page", () => {
  it("confirming = no pay buttons, no 'received', plain words (Nesher and JRM)", () => {
    for (const extra of [{}, { brandId: "jrm", invoiceNumber: "JRM-1325" }]) {
      const html = renderInvoiceHtml({ ...PAGE, ...extra, confirming: true });
      assert.ok(html.includes(CONFIRMING_WORDS));
      assert.ok(!html.includes("Payment received"));
      assert.ok(!html.includes("Pay with card") && !html.includes("Pay with bank"));
      if (extra.brandId === "jrm") assert.ok(!html.includes("FLYNESHER"));
    }
  });
  it("a transaction id wins over confirming: received", () => {
    const html = renderInvoiceHtml({ ...PAGE, confirming: true, transactionId: "t1" });
    assert.ok(html.includes("Payment received. Thank you."));
    assert.ok(!html.includes(CONFIRMING_WORDS));
  });
  it("unpaid pages are unchanged", () => {
    const html = renderInvoiceHtml({ ...PAGE, paidAt: null });
    assert.ok(html.includes("Pay with bank"));
    assert.ok(!html.includes(CONFIRMING_WORDS));
    assert.ok(!html.includes("Payment received"));
  });
});

describe("the store (real Postgres)", () => {
  it("claim -> confirming -> the webhook's transaction id clears it; counted and listed meanwhile", async () => {
    await pool.query(`CREATE TABLE nesher_pay_invoices (id TEXT PRIMARY KEY, payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ NOT NULL)`);
    const code = "abc12xyz";
    await pool.query(
      "INSERT INTO nesher_pay_invoices (id, payload, expires_at) VALUES ($1, $2::jsonb, NOW() + interval '1 day')",
      [code, JSON.stringify({ amountUsd: 40, invoiceNumber: "RES-ABC123", paidAt: null, transactionId: null })]
    );
    const payload = async () => (await pool.query("SELECT payload FROM nesher_pay_invoices WHERE id = $1", [code])).rows[0].payload;
    assert.equal((await claimInvoicePaid(code, { paidAt: "claim-1" }, pool)).ok, true);
    assert.equal((await markInvoiceConfirming(code, "claim-1", pool)).ok, true);
    assert.equal((await payload()).confirming, true);
    const listed = await listConfirmingLinks(pool);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].invoice, "RES-ABC123");
    assert.equal(listed[0].link, "...xyz", "the code is never listed whole");
    assert.equal((await markInvoicePaid(code, { transactionId: "txn_late", paidAt: "claim-1" }, pool)).ok, true);
    const done = await payload();
    assert.equal(done.confirming, undefined);
    assert.equal(done.confirmingSince, undefined);
    assert.equal(done.transactionId, "txn_late");
    assert.equal((await listConfirmingLinks(pool)).length, 0);
    assert.equal((await markInvoiceConfirming(code, "claim-1", pool)).ok, false, "a confirmed link never goes back to confirming");
  });
});

describe("the guest charge", () => {
  const base = () => ({
    code: "abc12xyz", paymentToken: "tok", privateKey: "k",
    loadInvoice: async () => ({ ok: true, data: { amountUsd: 55.55, invoiceNumber: "RES-555TRAIN", kind: "reservation" } }),
    claimInvoicePaid: async () => ({ ok: true, paidAt: "claim-9" }),
  });
  it("unknown outcome: claim kept, marked confirming, never released, one gateway call", async () => {
    const marks = [];
    let released = 0;
    let calls = 0;
    const out = await chargePayCode({
      ...base(),
      releaseInvoicePaidClaim: async () => { released++; return { ok: true }; },
      markInvoiceConfirming: async (code, at) => { marks.push([code, at]); return { ok: true }; },
      fetchImpl: async () => { calls++; throw new Error("timeout after submit"); },
    });
    assert.equal(out.error, "outcome_unknown");
    assert.deepEqual(marks, [["abc12xyz", "claim-9"]]);
    assert.equal(released, 0);
    assert.equal(calls, 1);
  });
  it("a 4xx refusal releases the claim and never marks confirming", async () => {
    const marks = [];
    let released = 0;
    await chargePayCode({
      ...base(),
      releaseInvoicePaidClaim: async () => { released++; return { ok: true }; },
      markInvoiceConfirming: async (code, at) => { marks.push([code, at]); return { ok: true }; },
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error_code: "invalid" }) }),
    });
    assert.equal(released, 1);
    assert.deepEqual(marks, []);
  });
});
