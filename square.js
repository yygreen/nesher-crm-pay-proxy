/**
 * Square Checkout payment links — THE card path (Mercury invoices are bank/ACH-only).
 *
 * Env (Railway / local):
 *   SQUARE_ACCESS_TOKEN_NESHER  (or SQUARE_ACCESS_TOKEN)
 *   SQUARE_LOCATION_ID_NESHER   (or SQUARE_LOCATION_ID) — optional; auto-picked if omitted
 *   SQUARE_APP_ID_NESHER        (optional; diagnostics only)
 *   SQUARE_API_BASE             default https://connect.squareup.com
 *   SQUARE_VERSION              default 2024-12-18
 */

import { fetchWithTimeout } from "./http.js";
import crypto from "node:crypto";

const DEFAULT_API = "https://connect.squareup.com";
const DEFAULT_VERSION = "2024-12-18";

export function squareConfig() {
  const token = String(
    process.env.SQUARE_ACCESS_TOKEN_NESHER ||
      process.env.SQUARE_ACCESS_TOKEN ||
      ""
  ).trim();
  const locationId = String(
    process.env.SQUARE_LOCATION_ID_NESHER ||
      process.env.SQUARE_LOCATION_ID ||
      ""
  ).trim();
  const appId = String(
    process.env.SQUARE_APP_ID_NESHER || process.env.SQUARE_APPLICATION_ID || ""
  ).trim();
  const base = String(process.env.SQUARE_API_BASE || DEFAULT_API).replace(
    /\/$/,
    ""
  );
  const version = String(process.env.SQUARE_VERSION || DEFAULT_VERSION).trim();
  return {
    token,
    locationId,
    appId,
    base,
    version,
    configured: Boolean(token),
  };
}

export function isSquareConfigured() {
  return squareConfig().configured;
}

function headers(token, version) {
  return {
    Authorization: `Bearer ${token}`,
    "Square-Version": version,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * @param {object} opts
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 */
export async function resolveSquareLocationId(opts = {}) {
  const cfg = squareConfig();
  if (cfg.locationId) return { ok: true, locationId: cfg.locationId, cached: true };
  if (!cfg.token) {
    return { ok: false, error: "Square access token not configured" };
  }
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchWithTimeout(
    `${cfg.base}/v2/locations`,
    {
      method: "GET",
      headers: headers(cfg.token, cfg.version),
      timeoutMs: opts.timeoutMs || 12000,
    },
    fetchImpl
  );
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!res.ok) {
    return {
      ok: false,
      error: `Square locations failed: ${res.status} ${text.slice(0, 200)}`,
    };
  }
  const locs = Array.isArray(data.locations) ? data.locations : [];
  const active =
    locs.find((l) => String(l.status || "").toUpperCase() === "ACTIVE") ||
    locs[0];
  if (!active?.id) {
    return { ok: false, error: "No Square locations on this merchant" };
  }
  return {
    ok: true,
    locationId: active.id,
    name: active.name || active.business_name || null,
  };
}

/**
 * Create (or fail soft) a Square-hosted card checkout link.
 *
 * @param {object} opts
 * @param {number} opts.amountUsd
 * @param {string} opts.invoiceNumber
 * @param {string} [opts.lineName]
 * @param {string} [opts.customerEmail]
 * @param {string} [opts.customerName]
 * @param {string} [opts.idempotencyKey]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: boolean, payUrl?: string, paymentLinkId?: string, orderId?: string, locationId?: string, error?: string, amountCents?: number }>}
 */
export async function createSquarePaymentLink(opts) {
  const cfg = squareConfig();
  if (!cfg.token) {
    return {
      ok: false,
      error: "Square not configured — set SQUARE_ACCESS_TOKEN_NESHER on Railway",
      missing: "access_token",
    };
  }

  const amountUsd = Number(opts.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    return { ok: false, error: "amountUsd must be positive" };
  }
  // Square money is integer minor units (cents)
  const amountCents = Math.round(amountUsd * 100);
  if (amountCents < 1) {
    return { ok: false, error: "amount too small for Square" };
  }

  const invoiceNumber = String(opts.invoiceNumber || "")
    .trim()
    .slice(0, 40);
  const lineName = String(
    opts.lineName || invoiceNumber || "Payment"
  ).slice(0, 100);

  const loc = await resolveSquareLocationId(opts);
  if (!loc.ok) return { ok: false, error: loc.error };

  const idempotencyKey = String(
    opts.idempotencyKey ||
      `nesher-${invoiceNumber || "pay"}-${amountCents}-${crypto
        .randomBytes(6)
        .toString("hex")}`
  ).slice(0, 192);

  const body = {
    idempotency_key: idempotencyKey,
    description: invoiceNumber
      ? `Nesher CRM ${invoiceNumber}`
      : "Nesher CRM payment",
    quick_pay: {
      name: lineName,
      price_money: {
        amount: amountCents,
        currency: "USD",
      },
      location_id: loc.locationId,
    },
    checkout_options: {
      ask_for_shipping_address: false,
      enable_coupon: false,
      // Guests land on a calm thank-you; staff still reconcile via CRM notes / webhook later
      redirect_url: "https://www.jrmhotels.com/?paid=1",
    },
    payment_note: [invoiceNumber, opts.customerName, opts.customerEmail]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 500),
  };

  const email = String(opts.customerEmail || "")
    .trim()
    .toLowerCase();
  // Square rejects placeholder/own emails sometimes; only prefill plausible guest mail
  if (
    email &&
    email.includes("@") &&
    !email.endsWith("@jrmhotels.com") &&
    !email.endsWith("@rankfriendly.com")
  ) {
    body.pre_populated_data = { buyer_email: email };
  }

  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchWithTimeout(
    `${cfg.base}/v2/online-checkout/payment-links`,
    {
      method: "POST",
      headers: headers(cfg.token, cfg.version),
      body: JSON.stringify(body),
      timeoutMs: opts.timeoutMs || 15000,
    },
    fetchImpl
  );
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = {};
  }
  if (!res.ok) {
    const detail =
      data?.errors?.map((e) => e.detail || e.code).join("; ") ||
      text.slice(0, 240);
    return {
      ok: false,
      error: `Square payment link failed: ${res.status} ${detail}`,
      status: res.status,
    };
  }

  const link = data.payment_link || {};
  const payUrl = link.url || link.long_url || null;
  if (!payUrl) {
    return { ok: false, error: "Square response missing payment link URL" };
  }
  return {
    ok: true,
    payUrl,
    paymentLinkId: link.id || null,
    orderId: link.order_id || null,
    locationId: loc.locationId,
    amountCents,
    invoiceNumber,
  };
}
