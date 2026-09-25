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
          confirming: p.confirming === true && !p.transactionId,
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

/**
 * Gabbai 23 Sep F1: the gateway answer was lost or unreadable, so the claim is
 * KEPT (never a second sale) and the link is marked CONFIRMING - neither paid
 * nor payable - until a transaction id arrives (webhook / recovery). CAS on
 * the same claim and on no transaction id yet.
 */
export async function markInvoiceConfirming(idOrToken, claimedAt, poolImpl) {
  const key = String(idOrToken || "").trim();
  if (!isShortPayCode(key) || !claimedAt) return { ok: false, error: "bad claim" };
  try {
    const pool = storePool(poolImpl);
    await ensureTable(pool);
    const r = await pool.query(
      `UPDATE nesher_pay_invoices
          SET payload = COALESCE(payload, '{}'::jsonb) || $3::jsonb
        WHERE id = $1
          AND payload->>'paidAt' = $2
          AND COALESCE(payload->>'transactionId', '') = ''
        RETURNING id`,
      [key.toLowerCase(), String(claimedAt), JSON.stringify({ confirming: true, confirmingSince: new Date().toISOString() })]
    );
    return { ok: Boolean(r.rows.length) };
  } catch (e) {
    console.warn("markInvoiceConfirming failed");
    return { ok: false, error: "store_error" };
  }
}

/** Gabbai 23 Sep F4: links held as confirming, for health (count) and the report (list). */
export async function listConfirmingLinks(poolImpl, limit = 50) {
  const pool = storePool(poolImpl);
  await ensureTable(pool);
  const r = await pool.query(
    `SELECT id, payload->>'invoiceNumber' AS invoice_number, payload->>'amountUsd' AS amount_usd,
            payload->>'confirmingSince' AS since
       FROM nesher_pay_invoices
      WHERE payload->>'confirming' = 'true' AND COALESCE(payload->>'transactionId', '') = ''
      ORDER BY payload->>'confirmingSince' LIMIT $1`,
    [Math.min(200, Math.max(1, Number(limit) || 50))]
  );
  return r.rows.map((x) => ({
    link: "..." + String(x.id).slice(-3),
    invoice: x.invoice_number || null,
    amount_usd: x.amount_usd != null ? Number(x.amount_usd) : null,
    since: x.since || null,
  }));
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
      `UPDATE nesher_pay_invoices
         SET payload = (COALESCE(payload, '{}'::jsonb) - 'confirming' - 'confirmingSince') || $2::jsonb
       WHERE id = $1
         AND (COALESCE(payload->>'transactionId', '') = '' OR payload->>'transactionId' = $3)
       RETURNING payload`,
      [key.toLowerCase(), JSON.stringify({
        paidAt: extra.paidAt || new Date().toISOString(),
        ...(extra.transactionId ? { transactionId: String(extra.transactionId) } : {}),
      }), String(extra.transactionId || "")]
    );
    const row = r.rows[0];
    if (!row) {
      const exists = await pool.query(`SELECT payload FROM nesher_pay_invoices WHERE id = $1`, [key.toLowerCase()]);
      return { ok: false, error: exists.rows.length ? "transaction_conflict" : "not found" };
    }
    return { ok: true };
  } catch (e) {
    console.warn("markInvoicePaid failed", e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * AUDIT #145 (25 Sep, leftover lane): a guest link held as "confirming" (the gateway answer was lost, the
 * claim kept) is settled once the recovery sweep has POSTED its sale to the CRM - so the guest stops seeing
 * "We are confirming this payment. Please contact us" for money that came in. Gabbai r1 D4 guards:
 *   - the sale's transaction id is on NO link for this order id yet (after the canon R1 step the office mints a
 *     new link; the old stuck link must never be stamped with the new link's sale);
 *   - the sale falls inside the link's OWN attempt: at or after its claim (paidAt, stamped BEFORE the sale was
 *     sent, nmi-card.js) less 60 s of clock skew, and no later than 2 minutes after it went confirming
 *     (confirmingSince is stamped AFTER the answer was lost, so the real sale is before it; NMI dates are UTC,
 *     measured 24 Sep);
 *   - the same amount, and EXACTLY ONE such link (two = ambiguous, both left alone).
 * The write is a compare-and-swap on the same claim, still confirming, still without a transaction id, and the
 * transaction id on no other link. Only transactionId is stamped (plus confirmedBy/confirmedAt); the claim time
 * stays the paid time. Never a gateway call, never a CRM write.
 */
export async function settleConfirmingLink({ invoiceNumber, amountUsd, transactionId, paidAt } = {}, poolImpl) {
  const ref = String(invoiceNumber || "").trim();
  const txn = String(transactionId || "").trim();
  const amount = Number(amountUsd);
  const saleMs = Date.parse(String(paidAt || ""));
  if (!ref || !/^[A-Za-z0-9_-]{1,64}$/.test(txn) || !(amount > 0) || !Number.isFinite(saleMs)) return { ok: false, skipped: "bad_input" };
  const rows = await findInvoicesByOrderId(ref, poolImpl);
  if (rows.some((r) => String(r.payload?.transactionId || "") === txn)) return { ok: false, skipped: "txn_on_link" };
  let wide = 0;
  const hits = rows.filter((r) => {
    const p = r.payload || {};
    if (p.confirming !== true || String(p.transactionId || "") !== "" || !isShortPayCode(r.id)) return false;
    if (Math.abs(Number(p.amountUsd) - amount) >= 0.005) return false;
    const claimMs = Date.parse(String(p.paidAt || ""));
    const sinceMs = Date.parse(String(p.confirmingSince || ""));
    if (!Number.isFinite(claimMs) || !Number.isFinite(sinceMs)) return false;
    // Gabbai leftover C5: one guest attempt spans seconds; a claim-to-confirming span over 5 minutes is not a
    // window this guard can vouch for (it would no longer depend only on nmi-card.js's call order) - left alone.
    if (sinceMs - claimMs > 5 * 60 * 1000) { wide++; return false; }
    return saleMs >= claimMs - 60 * 1000 && saleMs <= sinceMs + 2 * 60 * 1000;
  });
  if (hits.length !== 1) return { ok: false, skipped: hits.length ? "ambiguous" : wide ? "window_too_wide" : "none" };
  try {
    const pool = storePool(poolImpl);
    const r = await pool.query(
      `UPDATE nesher_pay_invoices
          SET payload = (payload - 'confirming' - 'confirmingSince') || $3::jsonb
        WHERE id = $1
          AND payload->>'confirming' = 'true'
          AND COALESCE(payload->>'transactionId', '') = ''
          AND payload->>'paidAt' = $2
          AND NOT EXISTS (SELECT 1 FROM nesher_pay_invoices o WHERE o.payload->>'transactionId' = $4)
        RETURNING id`,
      [String(hits[0].id).toLowerCase(), String(hits[0].payload.paidAt),
        JSON.stringify({ transactionId: txn, confirmedBy: "sweep", confirmedAt: new Date().toISOString() }), txn]
    );
    return r.rows.length ? { ok: true, link: "..." + String(hits[0].id).slice(-3) } : { ok: false, skipped: "changed" };
  } catch {
    console.warn("settleConfirmingLink failed");
    return { ok: false, skipped: "store_error" };
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
