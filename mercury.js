/**
 * Mercury AR create-or-reuse payment request helpers.
 * HTTP boundary is injectable for unit tests.
 */

import { fetchWithTimeout } from "./http.js";

/** Override with MERCURY_API_BASE when Railway egress IPs are not on the token whitelist. */
export function mercuryApiBase() {
  const base = (process.env.MERCURY_API_BASE || "https://api.mercury.com").replace(
    /\/$/,
    ""
  );
  return `${base}/api/v1`;
}
const DEFAULT_DEST = "841f6d7c-53b8-11f1-a581-8f1a5e965da2";

export function payUrlFromSlug(slug) {
  if (!slug) return null;
  return `https://app.mercury.com/pay/${slug}`;
}

export function normalizeToken(token) {
  if (!token) return "";
  const t = String(token).trim();
  if (t.startsWith("secret-token:")) return t;
  if (t.startsWith("mercury_")) return `secret-token:${t}`;
  return t;
}

/** Stable invoice numbers matching Nesher autopilot conventions. */
export function hotelInvoiceNumber(requestId, offerId) {
  const base = `JRM-1${requestId}`;
  return offerId ? `${base}-O${offerId}` : base;
}

export function reservationInvoiceNumber(code) {
  const clean = String(code || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, "")
    .toUpperCase();
  return clean ? `RES-${clean}` : null;
}

/**
 * Convert amount to USD if needed (ILS → USD at spot * 1.03).
 * @param {number} amount
 * @param {string} currency
 * @param {() => Promise<number>} getIlsSpot  returns ILS per 1 USD
 */
export async function toUsdAmount(amount, currency, getIlsSpot) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error("Amount must be a positive number");
  }
  const cur = String(currency || "USD").trim().toUpperCase();
  if (cur === "USD" || cur === "US$" || cur === "$") {
    return Math.round(n * 100) / 100;
  }
  if (cur === "ILS" || cur === "NIS" || cur === "₪") {
    const spot = await getIlsSpot();
    if (!spot || spot <= 0) throw new Error("Could not fetch ILS/USD spot rate");
    // usd = ils / spot * 1.03  (locked Nesher pricing rule)
    return Math.round((n / spot) * 1.03 * 100) / 100;
  }
  // assume already USD-ish
  return Math.round(n * 100) / 100;
}

/** Fallback if FX APIs hang or fail — update occasionally; +3% still applied in toUsdAmount. */
const FALLBACK_ILS_PER_USD = Number(process.env.FALLBACK_ILS_PER_USD || 3.3);

export async function defaultIlsSpot() {
  try {
    const r = await fetchWithTimeout("https://open.er-api.com/v6/latest/USD", {
      timeoutMs: 4000,
    });
    if (r.ok) {
      const j = await r.json();
      if (j?.rates?.ILS) return Number(j.rates.ILS);
    }
  } catch {
    /* fall through */
  }
  try {
    const r2 = await fetchWithTimeout(
      "https://api.frankfurter.app/latest?from=USD&to=ILS",
      { timeoutMs: 4000 }
    );
    if (r2.ok) {
      const j2 = await r2.json();
      if (j2?.rates?.ILS) return Number(j2.rates.ILS);
    }
  } catch {
    /* fall through */
  }
  return FALLBACK_ILS_PER_USD;
}

/**
 * Normalize line items for Mercury AR.
 * Accepts opts.lineItems[] or falls back to single lineItemName + amountUsd.
 */
export function buildLineItems(opts) {
  const amountUsd = Number(opts.amountUsd);
  if (Array.isArray(opts.lineItems) && opts.lineItems.length) {
    const items = opts.lineItems
      .map((li) => ({
        name: String(li.name || opts.lineItemName || opts.invoiceNumber || "Payment")
          .slice(0, 180),
        unitPrice: Number(li.unitPrice ?? li.unit_price ?? li.amount),
        quantity: Number(li.quantity) > 0 ? Number(li.quantity) : 1,
      }))
      .filter((li) => Number.isFinite(li.unitPrice) && li.unitPrice > 0);
    if (items.length) return items;
  }
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("amountUsd must be positive (or provide priced lineItems)");
  }
  return [
    {
      name: String(opts.lineItemName || opts.invoiceNumber || "Payment").slice(0, 180),
      unitPrice: amountUsd,
      quantity: 1,
    },
  ];
}

/**
 * Create or reuse an unpaid Mercury AR invoice.
 * @param {object} opts
 * @param {string} opts.token
 * @param {string} opts.customerName
 * @param {string} opts.customerEmail
 * @param {string} opts.invoiceNumber
 * @param {number} [opts.amountUsd]
 * @param {string} [opts.lineItemName]
 * @param {Array<{name:string,unitPrice:number,quantity?:number}>} [opts.lineItems]
 * @param {string} [opts.payerMemo]
 * @param {string} [opts.destinationAccountId]
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ reused: boolean, invoice: object, payUrl: string }>}
 */
export async function createOrReusePaymentRequest(opts) {
  const rawFetch = opts.fetchImpl || fetch;
  const fetchImpl = (url, init = {}) =>
    fetchWithTimeout(url, { timeoutMs: opts.timeoutMs || 12000, ...init }, rawFetch);
  const token = normalizeToken(opts.token);
  if (!token) throw new Error("MERCURY_TOKEN missing");
  const email = String(opts.customerEmail || "").trim().toLowerCase();
  const name = String(opts.customerName || "").trim() || email || "Customer";
  if (!email) throw new Error("Customer email is required for Mercury AR invoices");
  const invoiceNumber = String(opts.invoiceNumber || "").trim();
  if (!invoiceNumber) throw new Error("invoiceNumber required");
  const lineItems = buildLineItems(opts);
  const amountUsd =
    Number(opts.amountUsd) > 0
      ? Number(opts.amountUsd)
      : Math.round(
          lineItems.reduce((s, li) => s + li.unitPrice * li.quantity, 0) * 100
        ) / 100;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("amountUsd must be positive");
  }
  const dest =
    opts.destinationAccountId ||
    process.env.MERCURY_DESTINATION_ACCOUNT_ID ||
    DEFAULT_DEST;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const MERCURY_API = mercuryApiBase();

  const amountOf = (items) =>
    Math.round(items.reduce((s, li) => s + li.unitPrice * li.quantity, 0) * 100) / 100;
  const memoOf = (m) =>
    String(
      m || `Nesher CRM pay link for ${invoiceNumber}. Do not reply to this memo.`
    ).slice(0, 2000);

  // 1) Existing unpaid invoice with the same number: reuse when identical,
  //    UPDATE in place when the draft changed (same link, new details).
  const listRes = await fetchImpl(`${MERCURY_API}/ar/invoices`, { headers });
  if (!listRes.ok) {
    const t = await listRes.text();
    throw new Error(`Mercury list invoices failed: ${listRes.status} ${t}`);
  }
  const listJson = await listRes.json();
  const invoices = listJson.invoices || listJson || [];
  const existing = invoices.find(
    (inv) =>
      inv.invoiceNumber === invoiceNumber &&
      String(inv.status || "").toLowerCase() === "unpaid"
  );
  if (existing?.slug) {
    const sameAmount =
      Math.abs(Number(existing.amount) - amountOf(lineItems)) < 0.005;
    const sameMemo =
      String(existing.payerMemo || "") === memoOf(opts.payerMemo) ||
      existing.payerMemo === undefined; // list payloads may omit the memo
    const sameLines =
      !Array.isArray(existing.lineItems) ||
      existing.lineItems.map((li) => li.name).join("|") ===
        lineItems.map((li) => li.name).join("|");
    if (sameAmount && sameMemo && sameLines) {
      return {
        reused: true,
        invoice: existing,
        payUrl: payUrlFromSlug(existing.slug),
      };
    }
  }

  // 2) Find or create customer by email
  const custRes = await fetchImpl(`${MERCURY_API}/ar/customers`, { headers });
  if (!custRes.ok) {
    const t = await custRes.text();
    throw new Error(`Mercury list customers failed: ${custRes.status} ${t}`);
  }
  const custJson = await custRes.json();
  const customers = custJson.customers || [];
  let customer = customers.find(
    (c) => String(c.email || "").trim().toLowerCase() === email
  );
  if (!customer) {
    const createCust = await fetchImpl(`${MERCURY_API}/ar/customers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, email }),
    });
    if (!createCust.ok) {
      const t = await createCust.text();
      throw new Error(`Mercury create customer failed: ${createCust.status} ${t}`);
    }
    customer = await createCust.json();
  }

  // 3) Create or update invoice — pack every detail into payerMemo + line items
  const today = new Date();
  const due = new Date(today.getTime() + 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const memo = memoOf(opts.payerMemo);
  const body = {
    customerId: customer.id,
    destinationAccountId: dest,
    invoiceDate: iso(today),
    dueDate: iso(due),
    invoiceNumber,
    ccEmails: [],
    creditCardEnabled: true,
    achDebitEnabled: true,
    useRealAccountNumber: false,
    sendEmailOption: "DontSend",
    payerMemo: memo,
    lineItems,
  };
  // Optional invoice metadata — poNumber shows to the payer; internalNote is
  // org-only; service period renders as the covered date range.
  const isoOnly = (s) =>
    /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : null;
  if (opts.poNumber) body.poNumber = String(opts.poNumber).slice(0, 100);
  if (opts.internalNote) {
    body.internalNote = String(opts.internalNote).slice(0, 1000);
  }
  const spStart = isoOnly(opts.servicePeriodStartDate);
  const spEnd = isoOnly(opts.servicePeriodEndDate);
  if (spStart && spEnd && spStart <= spEnd) {
    body.servicePeriodStartDate = spStart;
    body.servicePeriodEndDate = spEnd;
  }

  if (existing?.slug) {
    // Same invoice number, details changed → update in place (same pay URL).
    // Mercury update is POST /ar/invoices/{id} with the FULL body (PUT/PATCH → 405).
    if (existing.invoiceDate) body.invoiceDate = existing.invoiceDate;
    if (existing.dueDate && existing.dueDate >= iso(today)) {
      body.dueDate = existing.dueDate;
    }
    const updRes = await fetchImpl(`${MERCURY_API}/ar/invoices/${existing.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!updRes.ok) {
      const t = await updRes.text();
      throw new Error(`Mercury update invoice failed: ${updRes.status} ${t}`);
    }
    let updated = {};
    try {
      updated = await updRes.json();
    } catch {
      updated = {};
    }
    const invoice = { ...existing, ...updated };
    return {
      reused: false,
      updated: true,
      invoice,
      payUrl: payUrlFromSlug(invoice.slug || existing.slug),
    };
  }

  const invRes = await fetchImpl(`${MERCURY_API}/ar/invoices`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!invRes.ok) {
    const t = await invRes.text();
    throw new Error(`Mercury create invoice failed: ${invRes.status} ${t}`);
  }
  const invoice = await invRes.json();
  if (!invoice.slug) throw new Error("Mercury invoice missing slug");
  return {
    reused: false,
    invoice,
    payUrl: payUrlFromSlug(invoice.slug),
  };
}

export { DEFAULT_DEST };
