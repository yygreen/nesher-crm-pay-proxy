import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceNumber, syncPaidInvoices, recordNmiPaidInvoice } from "../payments-sync.js";

describe("parseInvoiceNumber", () => {
  it("maps JRM numbers to request/offer", () => {
    assert.deepEqual(parseInvoiceNumber("JRM-190-O48"), {
      kind: "hotel",
      requestId: 90,
      offerId: 48,
    });
    assert.deepEqual(parseInvoiceNumber("JRM-1089"), {
      kind: "hotel",
      requestId: 89,
      offerId: null,
    });
  });
  it("maps RES numbers to reservation codes", () => {
    assert.deepEqual(parseInvoiceNumber("RES-AFV2WG"), {
      kind: "reservation",
      code: "AFV2WG",
    });
    assert.deepEqual(parseInvoiceNumber("RES-SVC-194-20260804145928"), {
      kind: "reservation",
      code: "SVC-194-20260804145928",
    });
  });
  it("rejects unknown patterns", () => {
    assert.equal(parseInvoiceNumber("INV-1"), null);
    assert.equal(parseInvoiceNumber(""), null);
  });
});

function fakeFetch(invoices) {
  return async () => ({
    ok: true,
    json: async () => ({ invoices }),
  });
}

/** Records every query; routes SELECTs via matchers. */
function fakePool(routes) {
  const calls = [];
  const paymentPosts = new Map();
  const committedWrites = [];
  let transaction = null;
  const clonePosts = (source) => new Map([...source].map(([k, v]) => [k, { ...v }]));
  const run = async (sql, params = []) => {
    const norm = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: norm, params });
    if (norm === "BEGIN") {
      transaction = { posts: clonePosts(paymentPosts), writes: [], savepoint: null };
      return { rows: [] };
    }
    if (norm === "SAVEPOINT crm_payment_write") {
      if (transaction) transaction.savepoint = { posts: clonePosts(transaction.posts), writes: [...transaction.writes] };
      return { rows: [] };
    }
    if (norm === "ROLLBACK TO SAVEPOINT crm_payment_write") {
      if (transaction?.savepoint) {
        transaction.posts = clonePosts(transaction.savepoint.posts);
        transaction.writes = [...transaction.savepoint.writes];
      }
      return { rows: [] };
    }
    if (norm === "COMMIT") {
      if (transaction) {
        paymentPosts.clear();
        for (const [key, value] of transaction.posts) paymentPosts.set(key, value);
        committedWrites.push(...transaction.writes);
      }
      transaction = null;
      return { rows: [] };
    }
    if (norm === "ROLLBACK") {
      transaction = null;
      return { rows: [] };
    }
    if (/^CREATE TABLE IF NOT EXISTS nesher_money_payment_posts/.test(norm)) {
      return { rows: [] };
    }
    if (/^INSERT INTO nesher_money_payment_posts/.test(norm)) {
      const [transactionId, invoiceNumber, amountCents, brand, paidAt] = params;
      const posts = transaction?.posts || paymentPosts;
      if (!posts.has(transactionId)) {
        posts.set(transactionId, {
          transaction_id: transactionId,
          invoice_number: invoiceNumber,
          amount_cents: amountCents,
          brand,
          paid_at: paidAt,
          state: "pending",
          reason: null,
          attempts: 0,
        });
      }
      return { rows: [] };
    }
    if (/^SELECT \* FROM nesher_money_payment_posts WHERE transaction_id/.test(norm)) {
      const posts = transaction?.posts || paymentPosts;
      const row = posts.get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/^SELECT transaction_id, invoice_number, amount_cents, paid_at FROM nesher_money_payment_posts/.test(norm)) {
      const posts = transaction?.posts || paymentPosts;
      const limit = Number(params[0]);
      return {
        rows: [...posts.values()]
          .filter((row) => row.state === "pending")
          .sort((a, b) => String(a.transaction_id).localeCompare(String(b.transaction_id)))
          .slice(0, limit)
          .map(({ transaction_id, invoice_number, amount_cents, paid_at }) => ({
            transaction_id, invoice_number, amount_cents, paid_at,
          })),
      };
    }
    if (/^UPDATE nesher_money_payment_posts SET state = 'posted'/.test(norm)) {
      const posts = transaction?.posts || paymentPosts;
      const row = posts.get(params[0]);
      if (row) Object.assign(row, { state: "posted", reason: null, attempts: row.attempts + 1, posted_at: "now" });
      return { rows: [] };
    }
    if (/^UPDATE nesher_money_payment_posts SET state = 'review'/.test(norm)) {
      const posts = transaction?.posts || paymentPosts;
      const row = posts.get(params[0]);
      if (row && row.state === "pending") Object.assign(row, { state: "review", reason: params[1], attempts: row.attempts + 1 });
      return { rows: [] };
    }
    if (/^UPDATE nesher_money_payment_posts SET reason = 'posting_failed'/.test(norm)) {
      const posts = transaction?.posts || paymentPosts;
      const row = posts.get(params[0]);
      if (row && row.state === "pending") Object.assign(row, { reason: "posting_failed", attempts: row.attempts + 1 });
      return { rows: [] };
    }
    if (/^INSERT INTO (core_|fake_)/.test(norm) || /^UPDATE core_/.test(norm)) {
      const write = { sql: norm, params: [...params] };
      if (transaction) transaction.writes.push(write);
      else committedWrites.push(write);
    }
    for (const r of routes) {
      if (r.match.test(norm)) {
        if (r.throw) throw new Error(typeof r.throw === "string" ? r.throw : "fake query failure");
        return { rows: r.rows(params) };
      }
    }
    return { rows: [] };
  };
  return {
    calls,
    paymentPosts,
    committedWrites,
    query: run,
    connect: async () => ({ query: run, release() {} }),
  };
}

const PAID_HOTEL = {
  id: "minv-1",
  invoiceNumber: "JRM-190-O48",
  status: "Paid",
  amount: 965.72,
  paidAt: "2026-08-05T13:00:00Z",
};
const PAID_RES = {
  id: "minv-2",
  invoiceNumber: "RES-AFV2WG",
  status: "Paid",
  amount: 2436.32,
};

describe("syncPaidInvoices", () => {
  it("records a hotel payment + note", async () => {
    const pool = fakePool([
      { match: /FROM core_jrmhoteloffer/, rows: () => [{ request_id: 90 }] },
      { match: /FROM core_jrmhotelrequest WHERE id/, rows: () => [{ id: 90 }] },
    ]);
    const out = await syncPaidInvoices({
      token: "mercury_x",
      pool,
      fetchImpl: fakeFetch([PAID_HOTEL, { id: "u", invoiceNumber: "JRM-1050", status: "Unpaid", amount: 5 }]),
    });
    assert.equal(out.recorded.length, 1);
    assert.match(out.recorded[0], /hotel request #90/);
    const ins = pool.calls.filter((c) => c.sql.startsWith("INSERT INTO core_"));
    assert.equal(ins.length, 2); // payment + note
    assert.match(ins[0].sql, /core_jrmhotelpayment/);
    assert.ok(ins[0].params.some((p) => String(p).includes("mercury:minv-1")));
  });

  it("records a reservation payment and bumps amount_paid in one transaction", async () => {
    const pool = fakePool([
      { match: /FROM core_reservation WHERE UPPER/, rows: () => [{ id: 347, amount_paid: "0.00" }] },
    ]);
    const out = await syncPaidInvoices({
      token: "mercury_x",
      pool,
      fetchImpl: fakeFetch([PAID_RES]),
    });
    assert.equal(out.recorded.length, 1);
    assert.match(out.recorded[0], /reservation #347/);
    const sqls = pool.calls.map((c) => c.sql);
    assert.ok(sqls.includes("BEGIN"));
    assert.ok(sqls.includes("COMMIT"));
    assert.ok(sqls.some((s) => s.includes("INSERT INTO core_payment")));
    assert.ok(sqls.some((s) => s.includes("amount_paid = COALESCE(amount_paid, 0) + $1")));
  });

  it("is idempotent — marker in DB blocks a re-record", async () => {
    const pool = fakePool([
      { match: /WHERE reference LIKE/, rows: () => [{ id: 1 }] },
    ]);
    const out = await syncPaidInvoices({
      token: "mercury_x",
      pool,
      fetchImpl: fakeFetch([PAID_HOTEL]),
    });
    assert.equal(out.recorded.length, 0);
    assert.match(out.skipped[0], /already synced/);
    assert.equal(pool.calls.filter((c) => c.sql.startsWith("INSERT")).length, 0);
  });

  it("does not duplicate a manually entered same-amount payment", async () => {
    const pool = fakePool([
      { match: /ABS\(amount - \$2\)/, rows: () => [{ id: 9 }] },
      { match: /FROM core_jrmhoteloffer/, rows: () => [{ request_id: 90 }] },
    ]);
    const out = await syncPaidInvoices({
      token: "mercury_x",
      pool,
      fetchImpl: fakeFetch([PAID_HOTEL]),
    });
    assert.equal(out.recorded.length, 0);
    assert.match(out.skipped[0], /not duplicated/);
  });

  it("skips unknown invoice patterns and keeps going", async () => {
    const pool = fakePool([
      { match: /FROM core_jrmhoteloffer/, rows: () => [{ request_id: 90 }] },
      { match: /FROM core_jrmhotelrequest WHERE id/, rows: () => [{ id: 90 }] },
    ]);
    const out = await syncPaidInvoices({
      token: "mercury_x",
      pool,
      fetchImpl: fakeFetch([
        { id: "x", invoiceNumber: "INV-1", status: "Paid", amount: 1 },
        PAID_HOTEL,
      ]),
    });
    assert.equal(out.recorded.length, 1);
    assert.match(out.skipped[0], /unrecognized/);
  });
});

describe("recordNmiPaidInvoice", () => {
  it("records a hotel NMI payment with nmi: marker and no Mercury prefix", async () => {
    const pool = fakePool([
      { match: /FROM core_jrmhoteloffer/, rows: () => [{ request_id: 90 }] },
      { match: /FROM core_jrmhotelrequest WHERE id/, rows: () => [{ id: 90 }] },
    ]);
    const out = await recordNmiPaidInvoice({
      pool,
      invoiceNumber: "JRM-190-O48",
      amountUsd: 40,
      transactionId: "txn_crm",
    });
    assert.equal(out.ok, true);
    assert.equal(out.recorded.length, 1);
    const ins = pool.calls.filter((c) => c.sql.startsWith("INSERT INTO core_"));
    assert.equal(ins.length, 2);
    assert.match(ins[0].sql, /core_jrmhotelpayment/);
    assert.ok(ins[0].params.some((p) => String(p).includes("nmi:txn_crm")));
    assert.ok(ins[0].params.includes("card"));
    assert.equal(ins[0].params.includes("nmi"), false);
    assert.equal(
      ins[0].params.some((p) => String(p).includes("[Mercury")),
      false
    );
    assert.equal(
      ins[1].params.some((p) => String(p).includes("[Mercury Pay]")),
      false
    );
    assert.match(String(ins[1].params[0]), /Card payment \$40\.00 USD recorded in the CRM automatically \(NMI txn txn_crm\) - do not enter it again\./);
  });

  it("records a reservation NMI payment without [Mercury Pay]", async () => {
    const pool = fakePool([
      { match: /FROM core_reservation WHERE UPPER/, rows: () => [{ id: 347, amount_paid: "0.00" }] },
    ]);
    const out = await recordNmiPaidInvoice({
      pool,
      invoiceNumber: "RES-AFV2WG",
      amountUsd: 40,
      transactionId: "txn_res",
    });
    assert.equal(out.ok, true);
    const notes = pool.calls.flatMap((c) => c.params.map(String));
    assert.equal(notes.some((p) => p.includes("[Mercury Pay]")), false);
    assert.equal(notes.some((p) => p.includes("[Mercury sync]")), false);
    assert.ok(notes.some((p) => p.includes("nmi:txn_res")));
    assert.ok(notes.some((p) => p.includes("Card payment $40.00 USD recorded in the CRM automatically (NMI txn txn_res) - do not enter it again.")));
    assert.ok(pool.calls.some((c) => c.sql.includes("INSERT INTO core_payment")));
    assert.ok(
      pool.calls.some((c) => c.sql.includes("amount_paid = COALESCE(amount_paid, 0) + $1"))
    );
  });

  it("is idempotent on the nmi: marker", async () => {
    const pool = fakePool([
      { match: /WHERE notes ~/, rows: () => [{ id: 1, reservation_id: 347, amount: 40, currency: "USD" }] },
      { match: /FROM core_reservation WHERE UPPER/, rows: () => [{ id: 347, amount_paid: "0.00" }] },
    ]);
    const out = await recordNmiPaidInvoice({
      pool,
      invoiceNumber: "RES-AFV2WG",
      amountUsd: 40,
      transactionId: "txn_res",
    });
    assert.equal(out.ok, true);
    assert.equal(out.recorded.length, 0);
    assert.match(out.skipped[0], /already synced/);
    assert.equal(pool.calls.filter((c) => c.sql.startsWith("INSERT INTO core_")).length, 0);
  });

  it("rejects a legacy nmi marker attached to another reservation or amount", async () => {
    const pool = fakePool([
      { match: /WHERE notes ~/, rows: () => [{ id: 1, reservation_id: 999, amount: 40, currency: "USD" }] },
      { match: /FROM core_reservation WHERE UPPER/, rows: () => [{ id: 347, amount_paid: "0.00" }] },
    ]);
    const out = await recordNmiPaidInvoice({
      pool,
      invoiceNumber: "RES-AFV2WG",
      amountUsd: 40,
      transactionId: "txn_res_conflict",
    });
    assert.equal(out.ok, false);
    assert.equal(out.needsReview, true);
    assert.match(out.errors[0], /legacy_transaction_conflict/);
    assert.equal(pool.calls.filter((c) => c.sql.startsWith("INSERT INTO core_")).length, 0);
  });
});
