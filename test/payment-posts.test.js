import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { postConfirmedPayment, retryPaymentPosts, listPaymentPostExceptions } from "../payment-posts.js";

function fakePool() {
  const calls = [];
  const posts = new Map();
  const committedWrites = [];
  let tx = null;
  const clone = (map) => new Map([...map].map(([key, value]) => [key, { ...value }]));
  const run = async (sql, params = []) => {
    const norm = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: norm, params });
    if (norm === "BEGIN") {
      tx = { posts: clone(posts), writes: [], savepoint: null };
      return { rows: [] };
    }
    if (norm === "SAVEPOINT crm_payment_write") {
      if (tx) tx.savepoint = { posts: clone(tx.posts), writes: [...tx.writes] };
      return { rows: [] };
    }
    if (norm === "ROLLBACK TO SAVEPOINT crm_payment_write") {
      if (tx?.savepoint) {
        tx.posts = clone(tx.savepoint.posts);
        tx.writes = [...tx.savepoint.writes];
      }
      return { rows: [] };
    }
    if (norm === "COMMIT") {
      if (tx) {
        posts.clear();
        for (const [key, value] of tx.posts) posts.set(key, value);
        committedWrites.push(...tx.writes);
      }
      tx = null;
      return { rows: [] };
    }
    if (norm === "ROLLBACK") {
      tx = null;
      return { rows: [] };
    }
    if (/^CREATE TABLE IF NOT EXISTS nesher_money_payment_posts/.test(norm)) return { rows: [] };
    if (/^INSERT INTO nesher_money_payment_posts/.test(norm)) {
      const [transactionId, invoiceNumber, amountCents, brand, paidAt] = params;
      const target = tx?.posts || posts;
      if (!target.has(transactionId)) target.set(transactionId, {
        transaction_id: transactionId,
        invoice_number: invoiceNumber,
        amount_cents: amountCents,
        brand,
        paid_at: paidAt,
        state: "pending",
        reason: null,
        attempts: 0,
      });
      return { rows: [] };
    }
    if (/^SELECT \* FROM nesher_money_payment_posts WHERE transaction_id/.test(norm)) {
      const row = (tx?.posts || posts).get(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    // 24 Sep: the retry also reads `kind` (a reversal is never handed to the sale writer).
    if (/^SELECT transaction_id, invoice_number, amount_cents, paid_at(, kind)? FROM nesher_money_payment_posts/.test(norm)) {
      const limit = Number(params[0]);
      return {
        rows: [...(tx?.posts || posts).values()]
          .filter((row) => row.state === "pending")
          .slice(0, limit)
          .map(({ transaction_id, invoice_number, amount_cents, paid_at }) => ({
            transaction_id, invoice_number, amount_cents, paid_at,
          })),
      };
    }
    if (/^SELECT state, COUNT\(\*\)::integer AS count FROM nesher_money_payment_posts/.test(norm)) {
      const counts = new Map();
      for (const row of (tx?.posts || posts).values()) {
        if (row.state !== "posted") counts.set(row.state, (counts.get(row.state) || 0) + 1);
      }
      return { rows: [...counts].map(([state, count]) => ({ state, count })) };
    }
    if (/^SELECT transaction_id, invoice_number, amount_cents, currency, brand, paid_at, state, reason, attempts, created_at, updated_at FROM nesher_money_payment_posts/.test(norm)) {
      const limit = Number(params[0]);
      return {
        rows: [...(tx?.posts || posts).values()]
          .filter((row) => row.state !== "posted")
          .slice(0, limit)
          .map((row) => ({ ...row, currency: "USD", created_at: "now", updated_at: "now" })),
      };
    }
    if (/^UPDATE nesher_money_payment_posts SET state = 'posted'/.test(norm)) {
      const row = (tx?.posts || posts).get(params[0]);
      if (row) Object.assign(row, { state: "posted", reason: null, attempts: row.attempts + 1 });
      return { rows: [] };
    }
    if (/^UPDATE nesher_money_payment_posts SET state = 'review'/.test(norm)) {
      const row = (tx?.posts || posts).get(params[0]);
      if (row) Object.assign(row, { state: "review", reason: params[1], attempts: row.attempts + 1 });
      return { rows: [] };
    }
    if (/^UPDATE nesher_money_payment_posts SET reason = 'posting_failed'/.test(norm)) {
      const row = (tx?.posts || posts).get(params[0]);
      if (row) Object.assign(row, { reason: "posting_failed", attempts: row.attempts + 1 });
      return { rows: [] };
    }
    if (norm.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
    if (/^INSERT INTO crm_payment/.test(norm)) {
      const write = { sql: norm, params: [...params] };
      if (tx) tx.writes.push(write);
      else committedWrites.push(write);
    }
    return { rows: [] };
  };
  return {
    calls,
    posts,
    committedWrites,
    query: run,
    connect: async () => ({ query: run, release() {} }),
  };
}

const payment = {
  invoiceNumber: "RES-ABC123",
  amountUsd: 40,
  transactionId: "txn_posts_1",
  paidAt: "2026-09-23T10:00:00.000Z",
  brand: "nesher",
};

function writePayment(client, result) {
  return client.query("INSERT INTO crm_payment (amount) VALUES ($1)", [40])
    .then(() => result.recorded.push("RES-ABC123: $40.00"));
}

describe("durable confirmed payment posts", () => {
  it("replay of a posted event skips the CRM write", async () => {
    const pool = fakePool();
    let writes = 0;
    const write = async (client, result) => {
      writes += 1;
      await writePayment(client, result);
    };
    const first = await postConfirmedPayment({ pool, ...payment, write });
    const second = await postConfirmedPayment({ pool, ...payment, write });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.match(second.skipped[0], /already synced/);
    assert.equal(writes, 1);
    assert.equal(pool.committedWrites.length, 1);
    assert.equal(pool.posts.get(payment.transactionId).state, "posted");
  });

  it("keeps an exception pending, then retry succeeds without a gateway", async () => {
    const pool = fakePool();
    let shouldFail = true;
    let writes = 0;
    const write = async (client, result) => {
      writes += 1;
      await writePayment(client, result);
      if (shouldFail) throw new Error("CRM unavailable");
    };
    await assert.rejects(postConfirmedPayment({ pool, ...payment, write }), /CRM unavailable/);
    assert.equal(pool.posts.get(payment.transactionId).state, "pending");
    assert.equal(pool.committedWrites.length, 0, "rollback must discard partial CRM writes");

    shouldFail = false;
    let gatewayCalls = 0;
    const retry = await retryPaymentPosts({
      pool,
      post: (args) => postConfirmedPayment({
        ...args,
        pool,
        brand: "nesher",
        write: async (client, result) => {
          assert.equal(gatewayCalls, 0);
          await writePayment(client, result);
        },
      }),
    });
    assert.equal(retry.posted, 1);
    assert.equal(retry.errors, 0);
    assert.equal(retry.pendingTotal, 0);
    assert.equal(retry.reviewTotal, 0);
    assert.equal(gatewayCalls, 0);
    assert.equal(writes, 1);
    assert.equal(pool.committedWrites.length, 1);
    assert.equal(pool.posts.get(payment.transactionId).state, "posted");
  });

  it("moves a failed CRM write to review without claiming posted", async () => {
    const pool = fakePool();
    let writes = 0;
    const out = await postConfirmedPayment({
      pool,
      ...payment,
      write: async (client, result) => {
        writes += 1;
        await writePayment(client, result);
        result.errors.push("manual_payment_requires_review");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.needsReview, true);
    assert.equal(writes, 1);
    assert.equal(pool.committedWrites.length, 0, "review rollback must discard partial CRM writes");
    assert.equal(pool.posts.get(payment.transactionId).state, "review");
    assert.notEqual(pool.posts.get(payment.transactionId).state, "posted");

    const later = await retryPaymentPosts({
      pool,
      post: async () => { throw new Error("review rows must not be retried"); },
    });
    assert.deepEqual(later, {
      checked: 0,
      posted: 0,
      review: 0,
      errors: 0,
      pendingTotal: 0,
      reviewTotal: 1,
    });
    const exceptions = await listPaymentPostExceptions({ pool });
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0].state, "review");
    assert.equal(exceptions[0].reason, "manual_payment_requires_review");
  });

  it("refuses reuse of an event for another amount or booking", async () => {
    const pool = fakePool();
    let writes = 0;
    const write = async (client, result) => {
      writes += 1;
      await writePayment(client, result);
    };
    await postConfirmedPayment({ pool, ...payment, write });
    const amount = await postConfirmedPayment({
      pool,
      ...payment,
      amountUsd: 41,
      write,
    });
    const booking = await postConfirmedPayment({
      pool,
      ...payment,
      invoiceNumber: "RES-OTHER",
      write,
    });
    assert.equal(amount.ok, false);
    assert.equal(amount.needsReview, true);
    assert.equal(booking.ok, false);
    assert.equal(booking.needsReview, true);
    assert.equal(writes, 1);
  });

  it("rejects empty transactions, nonfinite amounts, and sub-cent amounts", async () => {
    for (const overrides of [
      { transactionId: "" },
      { amountUsd: Number.NaN },
      { amountUsd: 0.001 },
    ]) {
      const pool = fakePool();
      const out = await postConfirmedPayment({
        pool,
        ...payment,
        ...overrides,
        write: async () => { throw new Error("must not write"); },
      });
      assert.equal(out.ok, false);
      assert.equal(out.needsReview, false);
      assert.equal(pool.calls.some((call) => call.sql.includes("nesher_money_payment_posts")), false);
    }
  });

  it("recovery processes only durable pending posts and performs no financial gateway call", async () => {
    const pool = fakePool();
    await assert.rejects(postConfirmedPayment({
      pool,
      ...payment,
      write: async () => { throw new Error("temporary CRM outage"); },
    }));
    let gatewayCalls = 0;
    const out = await retryPaymentPosts({
      pool,
      post: async (args) => postConfirmedPayment({
        ...args,
        pool,
        brand: "nesher",
        write: async (client, result) => {
          assert.equal(gatewayCalls, 0);
          await writePayment(client, result);
        },
      }),
    });
    assert.equal(out.posted, 1);
    assert.equal(out.pendingTotal, 0);
    assert.equal(out.reviewTotal, 0);
    assert.equal(gatewayCalls, 0);
    assert.equal(pool.committedWrites.length, 1);
  });
});
