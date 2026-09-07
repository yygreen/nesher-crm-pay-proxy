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

/** Short pay codes can stamp paidAt. Long JWT tokens (they contain `.`) cannot. */
export function isShortPayCode(code) {
  const key = String(code || "").trim();
  return Boolean(key) && !key.includes(".") && key.length <= 16;
}

/**
 * Staff mint JSON. Mercury's creditCardEnabled stays false — NMI is
 * cardProcessor / cardCapture, never Mercury card-on.
 */
export function staffCardFields(cardMint = {}) {
  const hostedCard = Boolean(cardMint.ok && cardMint.cardUrl);
  const collectCard = Boolean(cardMint.ok && cardMint.capture === "collectjs");
  const hasCard = hostedCard || collectCard;
  return {
    hasCard,
    hostedCard,
    collectCard,
    creditCardEnabled: false,
    cardProcessor: hasCard ? "nmi" : "none",
    cardCapture: cardMint.capture || (hostedCard ? "invoice" : null),
    cardUrl: hostedCard ? cardMint.cardUrl : null,
    cardBlockedReason: hasCard
      ? null
      : cardMint.blockedReason || cardMint.error || null,
  };
}

export function nmiPaidStaffNote({ amountUsd, transactionId } = {}) {
  const amt = money2(amountUsd) || "0.00";
  const txn = String(transactionId || "").trim() || "unknown";
  return `NMI card $${amt} txn ${txn}. mark the Mercury invoice PAID, never cancel.`;
}

function noteKind(invoice = {}) {
  const k = String(invoice.kind || "").toLowerCase();
  if (k === "reservation") return "reservation";
  if (k === "hotel" || k === "hotel-offer") return "hotel";
  const n = String(invoice.invoiceNumber || "").toUpperCase();
  if (n.startsWith("JRM-")) return "hotel";
  if (n.startsWith("RES-") || n.startsWith("FLY-")) return "reservation";
  return "";
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
    // Portal MDFs must match mint: 1 Brand, 2 CRM Ref, 3 Invoice.
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

/**
 * Guest POST /pay/:code/charge. Dotted long-tokens are refused (cannot
 * stamp paidAt). Short codes CAS-claim paidAt BEFORE the NMI sale so a
 * second submit is 409 and does not fire a second sale.
 */
export async function chargePayCode(opts = {}) {
  const code = String(opts.code || "").trim();
  if (!isShortPayCode(code)) {
    return { ok: false, error: "short_code_required", httpStatus: 400 };
  }
  const token = String(opts.paymentToken || "").trim();
  if (looksLikePan(token)) {
    return { ok: false, error: "raw_card_rejected", httpStatus: 400 };
  }
  if (!token) {
    return { ok: false, error: "payment_token required", httpStatus: 400 };
  }
  if (typeof opts.loadInvoice !== "function" || typeof opts.claimInvoicePaid !== "function") {
    return { ok: false, error: "store_missing", httpStatus: 503 };
  }

  const verified = await opts.loadInvoice(code);
  if (!verified || !verified.ok || !verified.data) {
    return {
      ok: false,
      error: verified?.error || "invalid",
      httpStatus: 410,
    };
  }
  const invoice = verified.data;
  if (invoice.paidAt) {
    return { ok: false, error: "already_paid", httpStatus: 409 };
  }

  const claimedAt = opts.now || new Date().toISOString();
  const claimed = await opts.claimInvoicePaid(code, { paidAt: claimedAt });
  if (!claimed || !claimed.ok) {
    const err = claimed?.error || "claim_failed";
    return {
      ok: false,
      error: err === "already_paid" ? "already_paid" : err,
      httpStatus: err === "already_paid" ? 409 : 503,
    };
  }

  const sale = await chargeWithToken({
    amountUsd: invoice.amountUsd,
    invoiceNumber: invoice.invoiceNumber,
    kind: invoice.kind,
    customerName: invoice.customerName,
    summary: invoice.summary,
    paymentToken: token,
    fetchImpl: opts.fetchImpl,
    privateKey: opts.privateKey,
  });
  if (!sale.ok) {
    if (typeof opts.releaseInvoicePaidClaim === "function") {
      try {
        await opts.releaseInvoicePaidClaim(code, claimed.paidAt || claimedAt);
      } catch (e) {
        console.warn("releaseInvoicePaidClaim failed", e.message);
      }
    }
    const err = sale.error;
    return {
      ok: false,
      error: err,
      blockedReason: sale.blockedReason,
      httpStatus:
        err === "second_dba_pending"
          ? 403
          : err === "keys_missing"
            ? 503
            : err === "payment_token required"
              ? 400
              : 200,
    };
  }

  if (typeof opts.markInvoicePaid === "function") {
    try {
      await opts.markInvoicePaid(code, {
        paidAt: claimed.paidAt || claimedAt,
        transactionId: sale.transactionId,
      });
    } catch (e) {
      console.warn("markInvoicePaid failed", e.message);
    }
  }

  const note = nmiPaidStaffNote({
    amountUsd: invoice.amountUsd,
    transactionId: sale.transactionId,
  });
  const recordId = Number(invoice.recordId);
  const kind = noteKind(invoice);
  try {
    if (Number.isFinite(recordId) && recordId > 0) {
      if (kind === "reservation" && typeof opts.appendReservationNote === "function") {
        await opts.appendReservationNote(recordId, note);
      } else if (kind === "hotel" && typeof opts.appendHotelNote === "function") {
        await opts.appendHotelNote(recordId, note);
      }
    }
  } catch (e) {
    console.warn("nmi paid CRM note failed", e.message);
  }

  return {
    ok: true,
    transactionId: sale.transactionId || null,
    httpStatus: 200,
    note,
  };
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
