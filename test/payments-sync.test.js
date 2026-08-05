import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseInvoiceNumber, syncPaidInvoices } from "../payments-sync.js";

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
  const run = async (sql, params = []) => {
    const norm = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: norm, params });
    for (const r of routes) {
      if (r.match.test(norm)) return { rows: r.rows(params) };
    }
    return { rows: [] };
  };
  return {
    calls,
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
    const ins = pool.calls.filter((c) => c.sql.startsWith("INSERT"));
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
