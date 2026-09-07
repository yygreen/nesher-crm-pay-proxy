/**
 * Short pay codes → invoice payload (so guests get /pay/abc12x not a 400-char JWT).
 * Table is created automatically on first use. Falls back to signed long tokens if DB fails.
 */

import crypto from "node:crypto";
import { getPool } from "./db.js";
import { mintInvoiceToken, verifyInvoiceToken } from "./invoice-page.js";
import { isAllowedCardUrl } from "./nmi-card.js";

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
  if (!key.includes(".") && key.length <= 16) {
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

/** Best-effort: stamp paidAt so a second Collect.js submit cannot re-charge. */
export async function markInvoicePaid(idOrToken, extra = {}) {
  const key = String(idOrToken || "").trim();
  if (!key || key.includes(".") || key.length > 16) {
    return { ok: false, error: "not a short code" };
  }
  try {
    const pool = getPool();
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
      paidAt: extra.paidAt || new Date().toISOString(),
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
