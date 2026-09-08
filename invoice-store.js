/**
 * Short pay codes → invoice payload (so guests get /pay/abc12x not a 400-char JWT).
 * Table is created automatically on first use. Falls back to signed long tokens if DB fails.
 */

import crypto from "node:crypto";
import { getPool } from "./db.js";
import { mintInvoiceToken, verifyInvoiceToken } from "./invoice-page.js";
import { isAllowedCardUrl, isShortPayCode } from "./nmi-card.js";

let tableReady = false;

function shortCode() {
  // 8 chars, URL-safe, no ambiguous 0/O/1/l
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function ensureTable(pool) {
  if (tableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nesher_pay_invoices (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS nesher_pay_invoices_exp_idx
    ON nesher_pay_invoices (expires_at)
  `);
  tableReady = true;
}

/**
 * Persist invoice and return a short public code.
 * @returns {Promise<{ ok: true, code: string } | { ok: false, error: string, longToken?: string }>}
 */
export async function storeInvoice(data) {
  const cardUrl = isAllowedCardUrl(data.cardUrl)
    ? String(data.cardUrl).trim()
    : "";
  const payload = {
    amountUsd: Number(data.amountUsd),
    invoiceNumber: String(data.invoiceNumber || ""),
    customerName: String(data.customerName || ""),
    summary: String(data.summary || data.lineName || ""),
    mercuryUrl: String(data.mercuryUrl || ""),
    cardUrl,
    brandId: String(data.brandId || ""),
    capture: String(data.capture || ""),
    paidAt: data.paidAt || null,
    transactionId: data.transactionId || null,
    kind: String(data.kind || ""),
    recordId: Number.isFinite(Number(data.recordId)) && Number(data.recordId) > 0
      ? Number(data.recordId)
      : null,
  };
  const expiresAt = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);

  try {
    const pool = getPool();
    await ensureTable(pool);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = shortCode();
      try {
        await pool.query(
          `INSERT INTO nesher_pay_invoices (id, payload, expires_at)
           VALUES ($1, $2::jsonb, $3)`,
          [code, JSON.stringify(payload), expiresAt.toISOString()]
        );
        return { ok: true, code };
      } catch (e) {
        if (String(e.message || "").includes("duplicate") || e.code === "23505") {
          continue;
        }
        throw e;
      }
    }
    return { ok: false, error: "could not allocate short code" };
  } catch (e) {
    // Fallback: long signed token still works without DB
    try {
      const longToken = mintInvoiceToken({
        amountUsd: payload.amountUsd,
        invoiceNumber: payload.invoiceNumber,
        customerName: payload.customerName,
        summary: payload.summary,
        mercuryUrl: payload.mercuryUrl,
        cardUrl: payload.cardUrl,
        brandId: payload.brandId,
        capture: payload.capture,
        ttlSec: 45 * 24 * 60 * 60,
      });
      return { ok: false, error: e.message, longToken };
    } catch (e2) {
      return { ok: false, error: e.message || e2.message };
    }
  }
}

/**
 * Resolve short code OR long signed token → invoice data.
 */
export async function loadInvoice(idOrToken) {
  const key = String(idOrToken || "").trim();
  if (!key) return { ok: false, error: "missing" };

  // Short codes are 6–12 alnum; long tokens have a dot
  if (isShortPayCode(key)) {
    try {
      const pool = getPool();
      await ensureTable(pool);
      const r = await pool.query(
        `SELECT payload, expires_at FROM nesher_pay_invoices WHERE id = $1`,
        [key.toLowerCase()]
      );
      const row = r.rows[0];
      if (!row) return { ok: false, error: "not found" };
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return { ok: false, error: "expired" };
      }
      const p = row.payload || {};
      return {
        ok: true,
        data: {
          amountUsd: Number(p.amountUsd),
          invoiceNumber: p.invoiceNumber || "",
          customerName: p.customerName || "",
          summary: p.summary || "",
          mercuryUrl: p.mercuryUrl || "",
          cardUrl: isAllowedCardUrl(p.cardUrl) ? p.cardUrl : undefined,
          brandId: p.brandId || "",
          capture: p.capture || "",
          paidAt: p.paidAt || null,
          transactionId: p.transactionId || null,
          kind: p.kind || "",
          recordId: Number.isFinite(Number(p.recordId)) && Number(p.recordId) > 0
            ? Number(p.recordId)
            : null,
        },
      };
    } catch (e) {
      console.warn("loadInvoice short code failed", e.message);
      return { ok: false, error: "lookup failed" };
    }
  }

  // Long signed token path (fallback / older links)
  return verifyInvoiceToken(key);
}

function storePool(poolImpl) {
  return poolImpl || getPool();
}

/**
 * Compare-and-swap paidAt on a short code. Second claim is already_paid.
 * Long tokens are refused — they cannot stamp paidAt.
 */
export async function claimInvoicePaid(idOrToken, extra = {}, poolImpl) {
  const key = String(idOrToken || "").trim();
  if (!isShortPayCode(key)) {
    return { ok: false, error: "short_code_required" };
  }
  const paidAt = extra.paidAt || new Date().toISOString();
  const patch = { paidAt };
  if (extra.transactionId) patch.transactionId = extra.transactionId;
  try {
    const pool = storePool(poolImpl);
    await ensureTable(pool);
    const r = await pool.query(
      `UPDATE nesher_pay_invoices
          SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
          AND (payload->>'paidAt' IS NULL OR payload->>'paidAt' = '')
        RETURNING payload`,
      [key.toLowerCase(), JSON.stringify(patch)]
    );
    if (!r.rows.length) {
      const existing = await pool.query(
        `SELECT payload FROM nesher_pay_invoices WHERE id = $1`,
        [key.toLowerCase()]
      );
      if (!existing.rows.length) return { ok: false, error: "not found" };
      return {
        ok: false,
        error: "already_paid",
        paidAt: existing.rows[0].payload?.paidAt || true,
      };
    }
    return { ok: true, paidAt, payload: r.rows[0].payload };
  } catch (e) {
    console.warn("claimInvoicePaid failed", e.message);
    return { ok: false, error: e.message };
  }
}

/** Undo a paidAt claim when the NMI sale failed and no transactionId was stored. */
export async function releaseInvoicePaidClaim(idOrToken, claimedAt, poolImpl) {
  const key = String(idOrToken || "").trim();
  if (!isShortPayCode(key) || !claimedAt) {
    return { ok: false, error: "bad claim" };
  }
  try {
    const pool = storePool(poolImpl);
    await ensureTable(pool);
    const r = await pool.query(
      `UPDATE nesher_pay_invoices
          SET payload = payload - 'paidAt'
        WHERE id = $1
          AND payload->>'paidAt' = $2
          AND (payload->>'transactionId' IS NULL OR payload->>'transactionId' = '')
        RETURNING id`,
      [key.toLowerCase(), String(claimedAt)]
    );
    return { ok: Boolean(r.rows.length) };
  } catch (e) {
    console.warn("releaseInvoicePaidClaim failed", e.message);
    return { ok: false, error: e.message };
  }
}

/** Stamp transactionId (and paidAt) on a short code after a successful sale. */
export async function markInvoicePaid(idOrToken, extra = {}, poolImpl) {
  const key = String(idOrToken || "").trim();
  if (!isShortPayCode(key)) {
    return { ok: false, error: "not a short code" };
  }
  try {
    const pool = storePool(poolImpl);
    await ensureTable(pool);
    const r = await pool.query(
      `SELECT payload FROM nesher_pay_invoices WHERE id = $1`,
      [key.toLowerCase()]
    );
    const row = r.rows[0];
    if (!row) return { ok: false, error: "not found" };
    const prev =
      row.payload && typeof row.payload === "object" ? row.payload : {};
    const payload = {
      ...prev,
      paidAt: extra.paidAt || prev.paidAt || new Date().toISOString(),
      transactionId: extra.transactionId || prev.transactionId || null,
    };
    await pool.query(
      `UPDATE nesher_pay_invoices SET payload = $2::jsonb WHERE id = $1`,
      [key.toLowerCase(), JSON.stringify(payload)]
    );
    return { ok: true };
  } catch (e) {
    console.warn("markInvoicePaid failed", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Short codes for one CRM invoice number, newest first.
 * Used by the NMI webhook to find the guest /pay row without the URL code.
 */
export async function findInvoicesByOrderId(orderId, poolImpl) {
  const ref = String(orderId || "").trim();
  if (!ref) return [];
  try {
    const pool = storePool(poolImpl);
    await ensureTable(pool);
    const r = await pool.query(
      `SELECT id, payload, created_at
         FROM nesher_pay_invoices
        WHERE lower(payload->>'invoiceNumber') = lower($1)
        ORDER BY created_at DESC
        LIMIT 25`,
      [ref]
    );
    return (r.rows || []).map((row) => ({
      id: row.id,
      payload:
        row.payload && typeof row.payload === "object" ? row.payload : {},
      createdAt: row.created_at || null,
    }));
  } catch (e) {
    console.warn("findInvoicesByOrderId failed", e.message);
    return [];
  }
}

/** Compare-and-swap nmiNoteAt so guest charge and webhook write the CRM note once. */
export async function claimNmiNote(idOrToken, extra = {}, poolImpl) {
  const key = String(idOrToken || "").trim();
  if (!isShortPayCode(key)) {
    return { ok: false, error: "short_code_required" };
  }
  const nmiNoteAt = extra.nmiNoteAt || new Date().toISOString();
  try {
    const pool = storePool(poolImpl);
    await ensureTable(pool);
    const r = await pool.query(
      `UPDATE nesher_pay_invoices
          SET payload = COALESCE(payload, '{}'::jsonb) || $2::jsonb
        WHERE id = $1
          AND (payload->>'nmiNoteAt' IS NULL OR payload->>'nmiNoteAt' = '')
        RETURNING payload`,
      [key.toLowerCase(), JSON.stringify({ nmiNoteAt })]
    );
    if (!r.rows.length) {
      const existing = await pool.query(
        `SELECT payload FROM nesher_pay_invoices WHERE id = $1`,
        [key.toLowerCase()]
      );
      if (!existing.rows.length) return { ok: false, error: "not found" };
      return {
        ok: false,
        error: "already_noted",
        nmiNoteAt: existing.rows[0].payload?.nmiNoteAt || true,
      };
    }
    return { ok: true, nmiNoteAt, payload: r.rows[0].payload };
  } catch (e) {
    console.warn("claimNmiNote failed", e.message);
    return { ok: false, error: e.message };
  }
}
