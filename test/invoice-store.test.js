import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  claimInvoicePaid,
  releaseInvoicePaidClaim,
  markInvoicePaid,
  findInvoicesByOrderId,
  claimNmiNote,
} from "../invoice-store.js";

function memoryPool(seed = {}) {
  const rows = new Map();
  for (const [id, payload] of Object.entries(seed)) {
    rows.set(id, { payload: { ...payload } });
  }
  return {
    rows,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (/^CREATE TABLE|^CREATE INDEX/i.test(s)) return { rows: [] };
      if (s.includes("COALESCE(payload, '{}'::jsonb)") && s.includes("RETURNING payload")) {
        const id = params[0];
        const patch = JSON.parse(params[1]);
        const row = rows.get(id);
        if (!row) return { rows: [] };
        const gate = s.includes("nmiNoteAt") ? "nmiNoteAt" : "paidAt";
        const cur = row.payload && row.payload[gate];
        if (cur) return { rows: [] };
        row.payload = { ...row.payload, ...patch };
        return { rows: [{ payload: row.payload }] };
      }
      if (s.includes("lower(payload->>'invoiceNumber')")) {
        const ref = String(params[0] || "").toLowerCase();
        const out = [];
        for (const [id, row] of rows) {
          if (String(row.payload?.invoiceNumber || "").toLowerCase() === ref) {
            out.push({
              id,
              payload: row.payload,
              created_at: row.created_at || "2026-09-08T00:00:00Z",
            });
          }
        }
        return { rows: out };
      }
      if (s.includes("payload - 'paidAt'")) {
        const id = params[0];
        const at = params[1];
        const row = rows.get(id);
        if (!row || row.payload?.paidAt !== at) return { rows: [] };
        if (row.payload?.transactionId) return { rows: [] };
        const next = { ...row.payload };
        delete next.paidAt;
        row.payload = next;
        return { rows: [{ id }] };
      }
      if (/SELECT payload FROM nesher_pay_invoices WHERE id = \$1/.test(s)) {
        const row = rows.get(params[0]);
        return { rows: row ? [{ payload: row.payload }] : [] };
      }
      if (/UPDATE nesher_pay_invoices SET payload = \$2::jsonb WHERE id = \$1/.test(s)) {
        const id = params[0];
        const row = rows.get(id);
        if (!row) return { rows: [] };
        row.payload = JSON.parse(params[1]);
        return { rows: [] };
      }
      throw new Error(`unhandled sql: ${s}`);
    },
  };
}

describe("invoice-store paidAt CAS", () => {
  it("refuses a dotted long token so paidAt cannot be stamped", async () => {
    const pool = memoryPool();
    const out = await claimInvoicePaid("aaa.bbb", { paidAt: "t" }, pool);
    assert.equal(out.ok, false);
    assert.equal(out.error, "short_code_required");
    const mark = await markInvoicePaid("aaa.bbb", { transactionId: "x" }, pool);
    assert.equal(mark.ok, false);
  });

  it("second claim is already_paid and does not overwrite paidAt", async () => {
    const pool = memoryPool({
      abc12xyz: { amountUsd: 10, invoiceNumber: "RES-X" },
    });
    const first = await claimInvoicePaid(
      "abc12xyz",
      { paidAt: "2026-09-08T00:00:00Z" },
      pool
    );
    const second = await claimInvoicePaid(
      "abc12xyz",
      { paidAt: "2026-09-08T00:00:01Z" },
      pool
    );
    assert.equal(first.ok, true);
    assert.equal(first.paidAt, "2026-09-08T00:00:00Z");
    assert.equal(second.ok, false);
    assert.equal(second.error, "already_paid");
    assert.equal(
      pool.rows.get("abc12xyz").payload.paidAt,
      "2026-09-08T00:00:00Z"
    );
  });

  it("releases a failed-sale claim so a retry can charge", async () => {
    const pool = memoryPool({
      abc12xyz: { amountUsd: 10, invoiceNumber: "RES-X" },
    });
    const claimed = await claimInvoicePaid(
      "abc12xyz",
      { paidAt: "claim-1" },
      pool
    );
    assert.equal(claimed.ok, true);
    const released = await releaseInvoicePaidClaim("abc12xyz", "claim-1", pool);
    assert.equal(released.ok, true);
    const again = await claimInvoicePaid(
      "abc12xyz",
      { paidAt: "claim-2" },
      pool
    );
    assert.equal(again.ok, true);
    assert.equal(pool.rows.get("abc12xyz").payload.paidAt, "claim-2");
  });

  it("finds short codes by CRM invoice number, newest first", async () => {
    const pool = memoryPool({
      oldcode1: { amountUsd: 10, invoiceNumber: "RES-555TRAIN" },
      newcode2: { amountUsd: 10, invoiceNumber: "RES-555TRAIN" },
      otherxxx: { amountUsd: 1, invoiceNumber: "RES-OTHER" },
    });
    pool.rows.get("oldcode1").created_at = "2026-09-01T00:00:00Z";
    pool.rows.get("newcode2").created_at = "2026-09-08T00:00:00Z";
    const rows = await findInvoicesByOrderId("res-555train", pool);
    assert.equal(rows.length, 2);
    assert.equal(rows.some((r) => r.id === "newcode2"), true);
    assert.equal(rows.some((r) => r.id === "otherxxx"), false);
  });

  it("second nmi note claim is already_noted", async () => {
    const pool = memoryPool({
      abc12xyz: { amountUsd: 55.55, invoiceNumber: "RES-555TRAIN" },
    });
    const first = await claimNmiNote("abc12xyz", { nmiNoteAt: "n1" }, pool);
    const second = await claimNmiNote("abc12xyz", { nmiNoteAt: "n2" }, pool);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.error, "already_noted");
    assert.equal(pool.rows.get("abc12xyz").payload.nmiNoteAt, "n1");
  });
});
