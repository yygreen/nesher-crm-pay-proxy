/**
 * Signed NMI webhook for Collect.js sales.
 * Guest POST /pay/:code/charge already CAS-claims paidAt + writes the CRM
 * note. A missed browser POST leaves CRM unpaid while NMI captured. This
 * receiver is the second writer of that same claim/note path.
 *
 * Portal: Settings → Webhooks → Create (HTTPS only, no Sign-Up VAS).
 *   URL: https://crm.flynesher.com/__nesher_pay/nmi-webhook
 *   Event: transaction.sale.success
 * Signing key → Railway env NMI_WEBHOOK_SECRET (never printed, never logged).
 */

import crypto from "node:crypto";
import {
  amountsMatch,
  isShortPayCode,
  recordNmiPaid,
} from "./nmi-card.js";

export const NMI_WEBHOOK_PATH = "/__nesher_pay/nmi-webhook";

export function nmiWebhookSecret() {
  return String(process.env.NMI_WEBHOOK_SECRET || "").trim();
}

function header(headers, name) {
  if (!headers) return "";
  const want = String(name).toLowerCase();
  if (headers[want] != null) return String(headers[want]);
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return String(v ?? "");
  }
  return "";
}

function hmacHex(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function hmacB64(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64");
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (aa.length !== bb.length || aa.length === 0) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function stripSigPrefix(s) {
  return String(s || "")
    .trim()
    .replace(/^sha256=/i, "");
}

/**
 * Official NMI (docs How-to-Validate):
 *   Webhook-Signature: t=<nonce>,s=<hex>
 *   HMAC-SHA256(signingKey, nonce + "." + rawBody) as hex.
 * Extra header shapes are accepted only after that primary check.
 * Never logs the raw body (event_body.card.cc_number is a masked PAN).
 */
function parseOfficialSignature(header) {
  const h = String(header || "").trim();
  const t = /(?:^|[,\s])t=([^,\s]+)/.exec(h);
  const s = /(?:^|[,\s])s=([A-Fa-f0-9]+)/.exec(h);
  if (t && s) return { nonce: t[1], sig: s[1] };
  return null;
}

function sigMatches(offered, computed) {
  if (!offered || !computed) return false;
  return (
    safeEqual(offered, computed) ||
    safeEqual(String(offered).toLowerCase(), String(computed).toLowerCase())
  );
}

export function verifyNmiWebhookSignature(rawBody, headers, secret) {
  const key = String(secret || nmiWebhookSecret()).trim();
  if (!key) return { ok: false, error: "secret_missing" };
  const raw = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(String(rawBody || ""), "utf8");
  const sigHeader =
    header(headers, "webhook-signature") ||
    header(headers, "x-nmi-signature") ||
    header(headers, "x-webhook-signature");
  if (!sigHeader) return { ok: false, error: "signature_missing" };

  const official = parseOfficialSignature(sigHeader);
  if (official) {
    const expected = hmacHex(
      key,
      Buffer.concat([Buffer.from(`${official.nonce}.`, "utf8"), raw])
    );
    if (sigMatches(official.sig, expected)) return { ok: true };
    return { ok: false, error: "bad_signature" };
  }

  const offered = [];
  const v1 = /(?:^|[,\s])v1=([A-Za-z0-9+/=]+)/.exec(sigHeader);
  const t = /(?:^|[,\s])t=([^,\s]+)/.exec(sigHeader);
  if (v1) offered.push(v1[1]);
  offered.push(stripSigPrefix(sigHeader.split(",")[0]));
  offered.push(stripSigPrefix(sigHeader));

  const computed = [hmacHex(key, raw), hmacB64(key, raw)];
  if (t) {
    computed.push(
      hmacHex(key, Buffer.concat([Buffer.from(`${t[1]}.`, "utf8"), raw]))
    );
  }

  for (const o of offered) {
    if (!o) continue;
    for (const c of computed) {
      if (sigMatches(o, c)) return { ok: true };
    }
  }
  return { ok: false, error: "bad_signature" };
}

function firstAction(body) {
  const a = body?.action;
  if (Array.isArray(a) && a.length) return a[0];
  if (a && typeof a === "object") return a;
  return null;
}

function mdf(body, n) {
  const key = String(n);
  const fields = body?.merchant_defined_fields || body?.merchant_defined_field || {};
  if (Array.isArray(fields)) {
    const hit = fields.find((f) => String(f?.id || f?.field || "") === key);
    if (hit) return String(hit.value || hit.val || "").trim();
  }
  if (fields && typeof fields === "object") {
    const v =
      fields[`field_${key}`] ||
      fields[key] ||
      fields[`merchant_defined_field_${key}`];
    if (v != null) return String(v).trim();
  }
  const flat = body?.[`merchant_defined_field_${key}`];
  if (flat != null) return String(flat).trim();
  return "";
}

function looksLikeCrmRef(s) {
  return /^(RES-|JRM-|FLY-)/i.test(String(s || "").trim());
}

/** Pull sale facts. Never copies PAN/CVV onto the result. */
export function parseNmiWebhook(body) {
  const root = body && typeof body === "object" ? body : {};
  const eventType = String(root.event_type || root.eventType || root.type || "").trim();
  const inner =
    root.event_body || root.eventBody || root.data || root.transaction || root;
  const action = firstAction(inner);
  const transactionId = String(
    inner.transaction_id ||
      inner.transactionid ||
      inner.transactionId ||
      inner.id ||
      root.transaction_id ||
      ""
  ).trim();
  const orderIdRaw = String(
    inner.order_id ||
      inner.orderid ||
      inner.orderId ||
      inner.order_details?.id ||
      inner.order_details?.order_id ||
      ""
  ).trim();
  const mdf2 = mdf(inner, 2) || mdf(root, 2);
  const orderId = looksLikeCrmRef(orderIdRaw)
    ? orderIdRaw
    : looksLikeCrmRef(mdf2)
      ? mdf2
      : orderIdRaw || mdf2;
  const amountRaw =
    action?.amount || inner.amount || inner.requested_amount || action?.requested_amount;
  const amountFixed = (() => {
    const x = Math.round(Number(amountRaw) * 100) / 100;
    return Number.isFinite(x) && x > 0 ? x : null;
  })();
  return {
    eventType,
    transactionId: transactionId || null,
    orderId: orderId || null,
    amountUsd: amountFixed,
    actionType: String(action?.action_type || inner.action_type || "").toLowerCase(),
  };
}

export function isSaleSuccess(parsed) {
  const t = String(parsed?.eventType || "").toLowerCase();
  return t === "transaction.sale.success" || t.endsWith(".sale.success");
}

export function pickInvoiceRow(rows, transactionId) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return null;
  const txn = String(transactionId || "").trim();
  if (txn) {
    const same = list.find((r) => String(r.payload?.transactionId || "") === txn);
    if (same) return same;
  }
  const unpaid = list.find((r) => !r.payload?.paidAt);
  if (unpaid) return unpaid;
  return list[0];
}

/**
 * Idempotent with guest charge: CAS-claim if unpaid, stamp transactionId,
 * write the CRM note once. Never charges NMI. Amount must match the store.
 */
export async function applyNmiSaleSuccess(parsed, opts = {}) {
  if (!isSaleSuccess(parsed)) {
    return { ok: true, ignored: parsed?.eventType || "not_sale_success" };
  }
  const orderId = String(parsed.orderId || "").trim();
  const transactionId = String(parsed.transactionId || "").trim();
  if (!orderId) return { ok: true, ignored: "no_order_id" };
  if (!transactionId) return { ok: true, ignored: "no_transaction_id" };
  if (parsed.amountUsd == null) return { ok: true, ignored: "amount_missing" };
  if (typeof opts.findInvoicesByOrderId !== "function") {
    return { ok: false, error: "store_missing", httpStatus: 503 };
  }

  const rows = await opts.findInvoicesByOrderId(orderId);
  if (!rows || !rows.length) return { ok: true, ignored: "not_found" };
  const row = pickInvoiceRow(rows, transactionId);
  if (!row || !isShortPayCode(row.id)) return { ok: true, ignored: "not_found" };
  const invoice = row.payload || {};
  if (!amountsMatch(parsed.amountUsd, invoice.amountUsd)) {
    return { ok: true, ignored: "amount_mismatch" };
  }
  const existingTxn = String(invoice.transactionId || "").trim();
  if (invoice.paidAt && existingTxn && existingTxn !== transactionId) {
    return { ok: true, already: true, ignored: "other_txn" };
  }

  const paidAt = opts.now || new Date().toISOString();
  if (!invoice.paidAt) {
    if (typeof opts.claimInvoicePaid !== "function") {
      return { ok: false, error: "store_missing", httpStatus: 503 };
    }
    const claimed = await opts.claimInvoicePaid(row.id, { paidAt, transactionId });
    if (!claimed || !claimed.ok) {
      if (claimed?.error !== "already_paid") {
        return {
          ok: false,
          error: claimed?.error || "claim_failed",
          httpStatus: 503,
        };
      }
    }
  }

  const recorded = await recordNmiPaid({
    code: row.id,
    invoice,
    transactionId,
    paidAt,
    markInvoicePaid: opts.markInvoicePaid,
    claimNmiNote: opts.claimNmiNote,
    appendReservationNote: opts.appendReservationNote,
    appendHotelNote: opts.appendHotelNote,
  });
  return {
    ok: true,
    transactionId,
    noteWritten: Boolean(recorded.noteWritten),
    alreadyNoted: Boolean(recorded.alreadyNoted),
    httpStatus: 200,
  };
}
