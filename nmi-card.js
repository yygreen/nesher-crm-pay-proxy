/**
 * Pinpoint/NMI card mint for the CRM pay seam.
 * One function: CRM record + amount + brand → { cardUrl, orderId, descriptor, brand }.
 * Mercury bank stays on the same guest page. Square/Stripe hosts are never returned.
 *
 * Dual-brand rule: this MID's boarded DBA is flynesher.com. A JRM statement
 * descriptor is a Pinpoint second-DBA ask. Until NMI_JRM_DESCRIPTOR is set,
 * JRM-sold records do not get a live card URL (wrong-brand charges are worse
 * than no card rail).
 */

export const NMI_HOST = (
  process.env.NMI_HOST || "https://pinpointpayments.transactiongateway.com"
).replace(/\/$/, "");

export const CARD_HOST_RE =
  /^https:\/\/((?:[a-z0-9-]+\.)*pinpointpayments\.transactiongateway\.com|collectcheckout\.com)(\/|$)/i;

const DEAD_CARD_HOST_RE =
  /square\.link|squareup\.com|stripe\.com|checkout\.stripe/i;

export const BRANDS = {
  nesher: {
    id: "nesher",
    name: "Nesher",
    // Catalog labels only. Product Manager SKUs cost $1.00 — never send them
    // as invoice line items. CRM-priced charges use Invoices API `amount`.
    sku: "NESHER-PAY",
    defaultDescriptor: "FLYNESHER.COM",
    successOrigin: "https://www.flynesher.com",
  },
  jrm: {
    id: "jrm",
    name: "JRM Hotels",
    sku: "JRM-PAY",
    defaultDescriptor: "JRM HOTELS",
    successOrigin: "https://www.jrmhotels.com",
  },
};

export function brandFromInvoiceNumber(invoiceNumber) {
  const n = String(invoiceNumber || "").trim().toUpperCase();
  if (n.startsWith("JRM-")) return BRANDS.jrm;
  return BRANDS.nesher;
}

export function brandFromKind(kind, invoiceNumber) {
  if (kind === "hotel" || kind === "hotel-offer") return BRANDS.jrm;
  if (kind === "reservation") return BRANDS.nesher;
  return brandFromInvoiceNumber(invoiceNumber);
}

/** Statement descriptor actually configured for this brand, or null if blocked. */
export function descriptorFor(brand) {
  const b = brand && brand.id ? brand : BRANDS.nesher;
  if (b.id === "jrm") {
    const explicit = String(process.env.NMI_JRM_DESCRIPTOR || "").trim();
    return explicit || null;
  }
  return (
    String(process.env.NMI_NESHER_DESCRIPTOR || "").trim() ||
    b.defaultDescriptor
  );
}

export function isAllowedCardUrl(url) {
  const u = String(url || "").trim();
  if (!/^https:\/\//i.test(u)) return false;
  if (DEAD_CARD_HOST_RE.test(u)) return false;
  return CARD_HOST_RE.test(u);
}

export function hostedInvoiceUrl(invoiceId) {
  const id = String(invoiceId || "").trim();
  if (!id) return "";
  return `${NMI_HOST}/cart/invoicing.php?invoice_id=${encodeURIComponent(id)}`;
}

export function agentPaste({ brand, invoiceNumber, amountUsd, cardUrl, mercuryUrl }) {
  const b = brand && brand.name ? brand : BRANDS.nesher;
  const amt = Number(amountUsd);
  const money = Number.isFinite(amt)
    ? amt.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      })
    : "";
  const ref = String(invoiceNumber || "").trim();
  const lines = [
    `${b.name} payment${ref ? ` ${ref}` : ""}${money ? ` · ${money}` : ""}`,
  ];
  if (cardUrl) lines.push(String(cardUrl).trim());
  else if (mercuryUrl) lines.push(String(mercuryUrl).trim());
  return lines.join("\n");
}

function money2(n) {
  const x = Math.round(Number(n) * 100) / 100;
  if (!Number.isFinite(x) || x <= 0) return null;
  return x.toFixed(2);
}

function splitName(full) {
  const parts = String(full || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return { first_name: "Guest", last_name: "Customer" };
  if (parts.length === 1) return { first_name: parts[0], last_name: "Customer" };
  return {
    first_name: parts[0],
    last_name: parts.slice(1).join(" ").slice(0, 80),
  };
}

function nmiPrivateKey() {
  return String(process.env.NMI_PRIVATE_KEY || "").trim();
}

export function nmiPublicKey() {
  return String(process.env.NMI_PUBLIC_KEY || "").trim();
}

export function collectScriptUrl() {
  return `${NMI_HOST}/token/Collect.js`;
}

/** True when a guest posted a PAN instead of a Collect.js token. */
export function looksLikePan(value) {
  const compact = String(value || "")
    .trim()
    .replace(/[\s-]/g, "");
  return /^\d{12,19}$/.test(compact);
}

function invoicesNotProvisioned(message) {
  return /not set up to use invoicing/i.test(String(message || ""));
}

/**
 * CRM-priced card mint. Never charges a card. Creates (or reuses) an NMI
 * invoice whose amount equals the CRM price and whose order_id is the CRM ref.
 *
 * @param {object} opts
 * @param {number} opts.amountUsd
 * @param {string} opts.invoiceNumber
 * @param {string} [opts.kind]
 * @param {string} [opts.customerName]
 * @param {string} [opts.customerEmail]
 * @param {string} [opts.summary]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {string} [opts.privateKey]
 */
export async function mintCardCheckout(opts = {}) {
  const invoiceNumber = String(opts.invoiceNumber || "").trim();
  const amount = money2(opts.amountUsd);
  const brand = brandFromKind(opts.kind, invoiceNumber);
  const descriptor = descriptorFor(brand);
  const orderId = invoiceNumber.slice(0, 50);
  const base = {
    brand,
    orderId,
    descriptor,
    sku: brand.sku,
    amountUsd: amount ? Number(amount) : 0,
  };

  if (!amount) {
    return { ok: false, error: "amountUsd required", ...base, cardUrl: null };
  }
  if (!orderId) {
    return { ok: false, error: "invoiceNumber required", ...base, cardUrl: null };
  }
  if (!descriptor) {
    return {
      ok: false,
      error: "second_dba_pending",
      blockedReason:
        "JRM card links wait on a Pinpoint second DBA / statement descriptor. Nesher (FLYNESHER.COM) can mint.",
      ...base,
      cardUrl: null,
    };
  }

  const key = String(opts.privateKey || nmiPrivateKey()).trim();
  if (!key) {
    return {
      ok: false,
      error: "keys_missing",
      blockedReason:
        "NMI_PRIVATE_KEY not set. Create Settings → Security Keys, then mint.",
      ...base,
      cardUrl: null,
    };
  }

  const names = splitName(opts.customerName);
  // Do not send billing email: POST /invoices emails the customer when an
  // address is present, and nothing here auto-emails (canon rule 16). Staff
  // paste the guest /pay/ URL. Never attach Product Manager SKUs.
  const body = {
    amount: Number(amount),
    currency: "USD",
    payment_terms: "upon_receipt",
    payment_methods_allowed: ["cc"],
    billing_address: {
      first_name: names.first_name,
      last_name: names.last_name,
    },
    order_details: {
      order_id: orderId,
      order_description: String(opts.summary || `${brand.name} ${orderId}`).slice(
        0,
        100
      ),
      po_number: orderId,
    },
    // Portal MDFs: 1 Brand, 2 CRM Ref, 3 Invoice, 4 Guest (optional).
    merchant_defined_fields: {
      field_1: brand.id,
      field_2: orderId,
      field_3: orderId,
      ...(String(opts.customerName || "").trim()
        ? { field_4: String(opts.customerName).trim().slice(0, 80) }
        : {}),
    },
  };

  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(`${NMI_HOST}/api/v5/invoices`, {
    method: "POST",
    headers: {
      Authorization: key,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const blockedReason = json.message || json.error || text.slice(0, 180);
    if (invoicesNotProvisioned(blockedReason)) {
      // MID can list invoices but cannot create them. CRM-locked card
      // then runs on our guest /pay page via Collect.js + v5 sale.
      return {
        ok: true,
        ...base,
        cardUrl: null,
        capture: "collectjs",
        invoicesProvisioned: false,
      };
    }
    return {
      ok: false,
      error: `nmi_http_${res.status}`,
      blockedReason,
      ...base,
      cardUrl: null,
    };
  }

  const invoiceId = json.id || json.invoice_id;
  const fromApi =
    json.payment_url || json.url || json.invoice_url || json.payment_link;
  const cardUrl = isAllowedCardUrl(fromApi)
    ? String(fromApi).trim()
    : hostedInvoiceUrl(invoiceId);
  if (!isAllowedCardUrl(cardUrl)) {
    return {
      ok: false,
      error: "bad_card_host",
      blockedReason: "NMI invoice response was not a Collect Checkout / gateway URL",
      ...base,
      cardUrl: null,
      invoiceId: invoiceId || null,
    };
  }

  return {
    ok: true,
    ...base,
    cardUrl,
    invoiceId: invoiceId || null,
    capture: "invoice",
    invoicesProvisioned: true,
  };
}

/**
 * CRM-priced card capture. Amount is the CRM figure — never a $1 SKU and
 * never a guest-typed amount. Token comes from Collect.js on our guest page.
 * Does not run unless the caller passes a payment token (tests mock fetch).
 */
export async function chargeWithToken(opts = {}) {
  const invoiceNumber = String(opts.invoiceNumber || "").trim();
  const amount = money2(opts.amountUsd);
  const brand = brandFromKind(opts.kind, invoiceNumber);
  const descriptor = descriptorFor(brand);
  const token = String(opts.paymentToken || "").trim();
  const orderId = invoiceNumber.slice(0, 50);
  const base = {
    brand,
    orderId,
    descriptor,
    amountUsd: amount ? Number(amount) : 0,
  };
  if (!amount) {
    return { ok: false, error: "amountUsd required", ...base };
  }
  if (!orderId) {
    return { ok: false, error: "invoiceNumber required", ...base };
  }
  if (!descriptor) {
    return { ok: false, error: "second_dba_pending", ...base };
  }
  if (!token) {
    return { ok: false, error: "payment_token required", ...base };
  }
  const key = String(opts.privateKey || nmiPrivateKey()).trim();
  if (!key) {
    return { ok: false, error: "keys_missing", ...base };
  }
  const names = splitName(opts.customerName);
  const body = {
    amount,
    currency: "USD",
    payment_details: { payment_token: token },
    billing_address: {
      first_name: names.first_name,
      last_name: names.last_name,
    },
    order_details: {
      id: orderId,
      order_description: String(opts.summary || `${brand.name} ${orderId}`).slice(
        0,
        100
      ),
    },
    merchant_defined_fields: {
      field_1: orderId,
      field_2: brand.id,
      field_3: descriptor,
    },
  };
  const fetchImpl = opts.fetchImpl || fetch;
  const res = await fetchImpl(`${NMI_HOST}/api/v5/payments/sale`, {
    method: "POST",
    headers: {
      Authorization: key,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  const approved = String(json.response ?? json.action?.success ?? "") === "1";
  if (!res.ok || !approved) {
    return {
      ok: false,
      error: `nmi_sale_${res.status}`,
      blockedReason: json.message || json.responsetext || text.slice(0, 180),
      ...base,
    };
  }
  return {
    ok: true,
    ...base,
    transactionId: json.id || json.transactionid || json.transaction_id || null,
  };
}

/**
 * Guest /pay/:code/charge. Amount and ref come from the stored invoice —
 * never from the POST body. Token only; no PAN, no SKU, no auto-email.
 */
export async function chargeGuestInvoice(opts = {}) {
  const invoice = opts.invoice || {};
  if (invoice.paidAt) {
    return { ok: false, error: "already_paid" };
  }
  const token = String(opts.paymentToken || "").trim();
  if (looksLikePan(token)) {
    return { ok: false, error: "raw_card_rejected" };
  }
  return chargeWithToken({
    amountUsd: invoice.amountUsd,
    invoiceNumber: invoice.invoiceNumber,
    kind: invoice.kind,
    customerName: invoice.customerName,
    summary: invoice.summary,
    paymentToken: token,
    fetchImpl: opts.fetchImpl,
    privateKey: opts.privateKey,
  });
}

export function stripDeadCardFields(data = {}) {
  const out = { ...data };
  delete out.squareUrl;
  delete out.stripeUrl;
  if (out.cardProcessor === "square" || out.cardProcessor === "stripe") {
    delete out.cardProcessor;
  }
  if (out.cardUrl && !isAllowedCardUrl(out.cardUrl)) delete out.cardUrl;
  return out;
}
