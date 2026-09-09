/**
 * Pinpoint/NMI card mint for the CRM pay seam.
 * One function: CRM record + amount + brand → { cardUrl, orderId, descriptor, brand }.
 * Mercury bank stays on the same guest page. Square/Stripe hosts are never returned.
 *
 * Dual-brand rule: this MID's boarded DBA is flynesher.com. Pinpoint
 * 2026-09-09: "Custom descriptors are not allowed for this processor" —
 * never send v5 payment_descriptor or Classic descriptor on sale.
 * Joseph 2026-09-08: JRM hotel quotes take cards on this Nesher MID until
 * a new MID exists. Staff tell the guest the statement shows FLYNESHER.COM
 * (boarded DBA, not an API field). Do not set NMI_JRM_DESCRIPTOR. Never
 * fall back to "JRM HOTELS". Guest HTML stays sermon-free.
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
  if (kind === "reservation" || kind === "customer") return BRANDS.nesher;
  return brandFromInvoiceNumber(invoiceNumber);
}

export function brandFromRecord(opts = {}) {
  const id = String(opts.brandId || "").toLowerCase();
  if (id === "jrm") return BRANDS.jrm;
  if (id === "nesher") return BRANDS.nesher;
  return brandFromKind(opts.kind, opts.invoiceNumber);
}

/** Guest /pay URL origin for this brand. Card statement is a different field. */
export function guestPayOrigin(brand) {
  const b = brand && brand.id ? brand : BRANDS.nesher;
  return String(b.successOrigin || BRANDS.nesher.successOrigin).replace(
    /\/$/,
    ""
  );
}

/**
 * Boarded DBA on MID 30120057067. Pinpoint prints this on the statement.
 * Not a v5 override — this processor rejects custom descriptors.
 */
export const BOARDED_DBA = "FLYNESHER.COM";

const DESCRIPTOR_RE = /^[A-Za-z0-9._\- &]{1,60}$/;

export function sanitizeDescriptor(value) {
  const s = String(value || "").trim().slice(0, 60);
  return DESCRIPTOR_RE.test(s) ? s : null;
}

function boardedDba() {
  return sanitizeDescriptor(
    String(process.env.NMI_NESHER_DESCRIPTOR || "").trim() || BOARDED_DBA
  );
}

/**
 * Staff/display copy of what the statement prints. Not a charge gate and
 * not a v5 field. JRM without env uses the boarded DBA, never "JRM HOTELS".
 */
export function descriptorFor(brand) {
  const b = brand && brand.id ? brand : BRANDS.nesher;
  if (b.id === "jrm") {
    const explicit = String(process.env.NMI_JRM_DESCRIPTOR || "").trim();
    if (explicit) return sanitizeDescriptor(explicit);
    return boardedDba();
  }
  return boardedDba();
}

/** Always null on this MID. Charge must omit payment_descriptor. */
export function paymentDescriptorPayload(_brand) {
  return null;
}

/** Legal merchant / bank copy. Card statement is the boarded DBA. */
export const MERCHANT = {
  legal: "Air Today Travel Inc",
  dba: "Nesher Travel",
  bankBeneficiary: "Air Today Travel",
  bankRail: "Mercury / Bank Hapoalim",
};

/**
 * One truth for staff-paste processed-by copy. Guest HTML does not print
 * this (Joseph banned the sermon). Staff paste names the boarded DBA
 * FLYNESHER.COM — that is what Pinpoint prints, not an API field.
 */
export function processedByFacts({ brand, hasCard } = {}) {
  const b = brand && brand.id ? brand : BRANDS.nesher;
  const descriptor = boardedDba();
  const showCard = Boolean(hasCard) && Boolean(descriptor);
  return {
    brandId: b.id,
    showCard,
    descriptor: showCard ? descriptor : null,
    merchant: MERCHANT.legal,
    dba: MERCHANT.dba,
    bankBeneficiary: MERCHANT.bankBeneficiary,
    bankRail: MERCHANT.bankRail,
  };
}

export function processedByPasteLine(opts = {}) {
  const f = processedByFacts(opts);
  if (f.showCard) {
    return `Card processed by ${f.merchant} (${f.dba}). Statement shows ${f.descriptor}. Bank: ${f.bankBeneficiary} (${f.bankRail}).`;
  }
  return `Bank: ${f.bankBeneficiary} (${f.bankRail}).`;
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

export function agentPaste({
  brand,
  invoiceNumber,
  amountUsd,
  cardUrl,
  mercuryUrl,
  hasCard,
} = {}) {
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
  const cardOn =
    hasCard == null ? Boolean(descriptorFor(b)) : Boolean(hasCard);
  lines.push(processedByPasteLine({ brand: b, hasCard: cardOn }));
  return lines.join("\n");
}

export function money2(n) {
  const x = Math.round(Number(n) * 100) / 100;
  if (!Number.isFinite(x) || x <= 0) return null;
  return x.toFixed(2);
}

export function amountsMatch(a, b) {
  const x = money2(a);
  const y = money2(b);
  return Boolean(x && y && x === y);
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

/** Portal MDF / billing name. Empty omitted — never invent "Guest". */
export function recordName(value, max = 80) {
  const n = Number(max);
  const cap = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 255) : 80;
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, cap);
}

const US_CA_STATE_NAMES = {
  ALABAMA: "AL",
  ALASKA: "AK",
  ARIZONA: "AZ",
  ARKANSAS: "AR",
  CALIFORNIA: "CA",
  COLORADO: "CO",
  CONNECTICUT: "CT",
  DELAWARE: "DE",
  FLORIDA: "FL",
  GEORGIA: "GA",
  HAWAII: "HI",
  IDAHO: "ID",
  ILLINOIS: "IL",
  INDIANA: "IN",
  IOWA: "IA",
  KANSAS: "KS",
  KENTUCKY: "KY",
  LOUISIANA: "LA",
  MAINE: "ME",
  MARYLAND: "MD",
  MASSACHUSETTS: "MA",
  MICHIGAN: "MI",
  MINNESOTA: "MN",
  MISSISSIPPI: "MS",
  MISSOURI: "MO",
  MONTANA: "MT",
  NEBRASKA: "NE",
  NEVADA: "NV",
  "NEW HAMPSHIRE": "NH",
  "NEW JERSEY": "NJ",
  "NEW MEXICO": "NM",
  "NEW YORK": "NY",
  "NORTH CAROLINA": "NC",
  "NORTH DAKOTA": "ND",
  OHIO: "OH",
  OKLAHOMA: "OK",
  OREGON: "OR",
  PENNSYLVANIA: "PA",
  "RHODE ISLAND": "RI",
  "SOUTH CAROLINA": "SC",
  "SOUTH DAKOTA": "SD",
  TENNESSEE: "TN",
  TEXAS: "TX",
  UTAH: "UT",
  VERMONT: "VT",
  VIRGINIA: "VA",
  WASHINGTON: "WA",
  "WEST VIRGINIA": "WV",
  WISCONSIN: "WI",
  WYOMING: "WY",
  "DISTRICT OF COLUMBIA": "DC",
  "WASHINGTON DC": "DC",
  ALBERTA: "AB",
  "BRITISH COLUMBIA": "BC",
  MANITOBA: "MB",
  "NEW BRUNSWICK": "NB",
  NEWFOUNDLAND: "NL",
  "NEWFOUNDLAND AND LABRADOR": "NL",
  "NOVA SCOTIA": "NS",
  "NORTHWEST TERRITORIES": "NT",
  NUNAVUT: "NU",
  ONTARIO: "ON",
  "PRINCE EDWARD ISLAND": "PE",
  QUEBEC: "QC",
  SASKATCHEWAN: "SK",
  YUKON: "YT",
};

/** v5 billing_address.country is ISO 3166-1 alpha-2. Never a 40-char string. */
export function isoCountry(value, hasPlace) {
  const raw = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  if (!raw) return hasPlace ? "US" : "";
  const upper = raw.toUpperCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (
    upper === "US" ||
    upper === "USA" ||
    upper === "UNITED STATES" ||
    upper === "UNITED STATES OF AMERICA" ||
    upper === "AMERICA"
  ) {
    return "US";
  }
  const letters = raw.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length === 2) return letters;
  return "";
}

/** US/CA 2-letter when it looks like a state; otherwise a trimmed short code. */
export function isoState(value) {
  const raw = recordName(value, 40);
  if (!raw) return "";
  const upper = raw.toUpperCase().replace(/\./g, "").replace(/\s+/g, " ");
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  if (US_CA_STATE_NAMES[upper]) return US_CA_STATE_NAMES[upper];
  const compact = upper.replace(/[^A-Z0-9]/g, "");
  if (compact.length >= 1 && compact.length <= 5) return compact;
  if (compact.length > 5) return compact.slice(0, 5);
  return "";
}

/**
 * Optional v5 billing_address for AVS. Names from customerName when
 * present; address1 / city / state / zip / country / email when present.
 * Country is ISO-2. Blank + any street/city/zip/state → US. Empty keys
 * omitted. Never invents Guest. Not a descriptor.
 */
export function saleBillingAddress(opts = {}) {
  const customerName = recordName(opts.customerName);
  const names = customerName ? splitName(customerName) : null;
  const address1 = recordName(opts.address1 || opts.address, 255);
  const city = recordName(opts.city, 80);
  const state = isoState(opts.state);
  const zip = recordName(
    opts.zip || opts.postalCode || opts.postal_code,
    20
  );
  const email = recordName(opts.email, 120);
  const hasPlace = Boolean(address1 || city || zip || state);
  const country = isoCountry(opts.country, hasPlace);
  const addr = {};
  if (names) {
    addr.first_name = names.first_name;
    addr.last_name = names.last_name;
  }
  if (address1) addr.address1 = address1;
  if (city) addr.city = city;
  if (state) addr.state = state;
  if (zip) addr.zip = zip;
  if (country) addr.country = country;
  if (email) addr.email = email;
  return Object.keys(addr).length ? addr : null;
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

const GUEST_NOT_US_TAIL =
  "That often means the bank blocked a large charge, the card needs a call to activate it, or they should try another card. Call the customer, try again, or have them call the number on the back of the card.";

function notUs(reason) {
  const named = reason
    ? ` The customer's bank declined the card (${reason}).`
    : " The customer's bank declined the card.";
  return `Nothing is wrong on our side.${named} ${GUEST_NOT_US_TAIL}`;
}

/** Bank declined, not us. */
export const GUEST_DECLINE_DEFAULT = notUs("");

export const GUEST_DECLINE_DO_NOT_HONOR = notUs("Do Not Honor");

export const GUEST_OURS =
  "This looks like a problem on our side (card processor / our setup), not the customer's card. Do not keep retrying the same card. Tell the office.";

export const GUEST_MISSING_AMOUNT =
  "We're missing something: amount. Fill that in, then Pay with card again.";

export const GUEST_MISSING_CARD =
  "We're missing something: card details. Fill that in, then Pay with card again.";

export const GUEST_MISSING_CVV =
  "We're missing something: security code. Fill that in, then Pay with card again.";

export const GUEST_MISSING_DEFAULT =
  "We're missing something: amount / card details / security code. Fill that in, then Pay with card again.";

export const GUEST_ALREADY_PAID =
  "This payment is already recorded. No need to pay again.";

export const GUEST_INVALID_LINK =
  "This pay link is not valid. Ask us for a new one.";

export const GUEST_LINK_EXPIRED =
  "This pay link has expired. Ask us for a new one.";

export const GUEST_INACCURATE =
  "The payment details look inaccurate. Check the card number, expiration date, and security code, then try again.";

export const GUEST_AVS_MISMATCH =
  "The address does not match the card. Check the address, then Pay with card again.";

const AVS_NO_MATCH = new Set(["N", "C", "4", "8"]);

export const GUEST_INACCURATE_EXP =
  "The expiration date looks inaccurate. Check the month and year on the card, then try again.";

export const GUEST_INACCURATE_CVV =
  "The security code looks inaccurate. Check the three or four digits on the card, then try again.";

export const GUEST_INACCURATE_PIN =
  "The PIN looks inaccurate. Check it and try again, or use a card that does not need a PIN.";

export const GUEST_NOT_A_CARD =
  "That is not a valid card. Check the card number, or try another card.";

export const GUEST_UNSUPPORTED_CARD =
  "That card type is not a valid card for us. Try a different card.";

export const GUEST_NO_CARD_ON_FILE =
  "We're missing something: no card number on file. Fill in the card details, then Pay with card again.";

export const GUEST_CALL_ISSUER =
  "Nothing is wrong on our side. The customer's bank wants them to call the number on the back of the card before this charge can go through. Call the customer.";

export const GUEST_TRY_ANOTHER =
  "Nothing is wrong on our side. The bank will not take this card. Try another card, then call the customer.";

export const GUEST_DUPLICATE =
  "This looks like a duplicate charge. Check whether the payment already went through before trying again.";

export const GUEST_RECURRING =
  "Nothing is wrong on our side. The bank declined this recurring charge. Call the customer, or try another card.";

export const GUEST_RECURRING_STOP_ALL =
  "Nothing is wrong on our side. The bank declined this recurring charge and asked that all recurring payments on this card be stopped. Call the customer. Do not retry the same card.";

export const GUEST_RECURRING_STOP_THIS =
  "Nothing is wrong on our side. The bank declined this recurring charge and asked that this recurring program be stopped. Call the customer. Do not retry the same card.";

export const GUEST_RECURRING_UPDATE =
  "Nothing is wrong on our side. The bank declined this recurring charge. The card details need an update. Call the customer for a new card.";

export const GUEST_RECURRING_RETRY_LATER =
  "Nothing is wrong on our side. The bank declined this recurring charge and asked to retry in a few days. Call the customer. Do not keep retrying today.";

/** docs.nmi.com response_code → one plain-English sentence. Never JSON. */
export const NMI_CODE_MESSAGES = {
  200: notUs("declined by processor"),
  201: GUEST_DECLINE_DO_NOT_HONOR,
  202: notUs("insufficient funds"),
  203: notUs("over limit"),
  204: notUs("not allowed"),
  220: GUEST_INACCURATE,
  221: GUEST_NOT_A_CARD,
  222: GUEST_NO_CARD_ON_FILE,
  223: notUs("expired"),
  224: GUEST_INACCURATE_EXP,
  225: GUEST_INACCURATE_CVV,
  226: GUEST_INACCURATE_PIN,
  240: GUEST_CALL_ISSUER,
  250: GUEST_TRY_ANOTHER,
  251: GUEST_TRY_ANOTHER,
  252: GUEST_TRY_ANOTHER,
  253: GUEST_TRY_ANOTHER,
  260: GUEST_RECURRING,
  261: GUEST_RECURRING_STOP_ALL,
  262: GUEST_RECURRING_STOP_THIS,
  263: GUEST_RECURRING_UPDATE,
  264: GUEST_RECURRING_RETRY_LATER,
  300: GUEST_OURS,
  400: GUEST_OURS,
  410: GUEST_OURS,
  411: GUEST_OURS,
  420: GUEST_OURS,
  421: GUEST_OURS,
  430: GUEST_DUPLICATE,
  440: GUEST_INACCURATE,
  441: GUEST_INACCURATE,
  460: GUEST_OURS,
  461: GUEST_UNSUPPORTED_CARD,
};

const MISSING_ERRORS = new Set([
  "amount_required",
  "amount_invalid",
  "amount_too_small",
  "amount_too_large",
  "amountusd required",
]);
const MISSING_CARD_ERRORS = new Set([
  "payment_token required",
  "raw_card_rejected",
  "short_code_required",
  "invoicenumber required",
  "open_ref_required",
]);
const INVALID_LINK_ERRORS = new Set([
  "invalid",
  "not found",
  "not_found",
  "missing",
  "gone",
]);

function isUglyDump(value) {
  const s = String(value || "").trim();
  if (!s) return true;
  if (s.startsWith("{") || s.startsWith("[") || s.startsWith("<")) return true;
  if (/"object"\s*:\s*"transaction"/i.test(s)) return true;
  if (/"cc_number"|"ccnumber"|["']cvv["']/i.test(s)) return true;
  if (looksLikePan(s)) return true;
  return false;
}

function nmiDeclineSignals(src) {
  const out = {
    phrase: "",
    codes: [],
    error: "",
    httpStatus: 0,
    response: "",
    avs: "",
  };
  if (src == null) return out;
  if (typeof src === "string") {
    const t = src.trim();
    if (isUglyDump(t)) return out;
    out.phrase = t;
    out.error = t.toLowerCase();
    return out;
  }
  if (typeof src !== "object") return out;
  out.error = String(src.error || "").trim().toLowerCase();
  const hs = Number(src.httpStatus);
  if (Number.isFinite(hs) && hs > 0) out.httpStatus = hs;
  const json =
    src.json && typeof src.json === "object" && !Array.isArray(src.json)
      ? src.json
      : src;
  const phraseKeys = [
    "response_text",
    "processor_response_text",
    "responsetext",
    "processor_response_description",
  ];
  for (const k of phraseKeys) {
    const v = json[k];
    if (typeof v === "string" && v.trim() && !isUglyDump(v)) {
      out.phrase = v.trim();
      break;
    }
  }
  if (
    !out.phrase &&
    typeof json.message === "string" &&
    json.message.trim() &&
    !isUglyDump(json.message)
  ) {
    out.phrase = json.message.trim();
  }
  if (
    !out.phrase &&
    typeof src.blockedReason === "string" &&
    src.blockedReason.trim() &&
    !isUglyDump(src.blockedReason)
  ) {
    out.phrase = src.blockedReason.trim();
  }
  if (
    !out.phrase &&
    typeof json.raw === "string" &&
    json.raw.trim() &&
    !isUglyDump(json.raw)
  ) {
    out.phrase = json.raw.trim();
  }
  for (const k of ["response_code", "processor_response_code"]) {
    const v = json[k];
    if (v != null && String(v).trim() !== "") out.codes.push(String(v).trim());
  }
  out.response = String(json.response ?? "").trim();
  for (const k of ["avs_response", "avsresponse", "avs"]) {
    const v = json[k];
    if (v != null && String(v).trim() !== "") {
      out.avs = String(v).trim().toUpperCase();
      break;
    }
  }
  return out;
}

function messageForNmiCode(code) {
  const n = Number(String(code || "").trim());
  if (!Number.isFinite(n)) return null;
  if (Object.prototype.hasOwnProperty.call(NMI_CODE_MESSAGES, n)) {
    return NMI_CODE_MESSAGES[n];
  }
  return null;
}

/**
 * Guest-facing card line. Buckets: bank / our side / missing / inaccurate /
 * not a valid card / already paid / invalid link. Never JSON, never PAN.
 */
export function guestCardMessage(saleOrNmiJson) {
  const { phrase, codes, error, httpStatus, response, avs } =
    nmiDeclineSignals(saleOrNmiJson);
  if (error === "already_paid") return GUEST_ALREADY_PAID;
  if (INVALID_LINK_ERRORS.has(error)) return GUEST_INVALID_LINK;
  if (MISSING_ERRORS.has(error)) return GUEST_MISSING_AMOUNT;
  if (MISSING_CARD_ERRORS.has(error)) return GUEST_MISSING_CARD;
  if (error === "cvv" || error === "security code") return GUEST_MISSING_CVV;

  if (
    error === "keys_missing" ||
    error === "store_missing" ||
    error === "processor_error" ||
    error === "lookup failed" ||
    error === "claim_failed" ||
    httpStatus >= 500
  ) {
    return GUEST_OURS;
  }

  if (AVS_NO_MATCH.has(avs) && response !== "1") {
    return GUEST_AVS_MISMATCH;
  }

  for (const c of codes) {
    const mapped = messageForNmiCode(c);
    if (mapped) return mapped;
  }

  if (error === "expired") return GUEST_LINK_EXPIRED;

  if (
    /communication|timeout|network|econnreset|fetch failed/i.test(
      `${phrase} ${error}`
    )
  ) {
    return GUEST_OURS;
  }

  const blob = `${phrase} ${error}`.toLowerCase();
  if (/do not honor/.test(blob) || codes.some((c) => String(c) === "05")) {
    return GUEST_DECLINE_DO_NOT_HONOR;
  }
  if (/insufficient|not sufficient|\bnsf\b/.test(blob)) {
    return notUs("insufficient funds");
  }
  if (/over.?limit/.test(blob)) {
    return notUs("over limit");
  }
  if (/expired/.test(blob)) {
    return notUs("expired");
  }
  if (/not allowed|not permitted/.test(blob)) {
    return notUs("not allowed");
  }
  if (
    /incorrect payment|inaccurate|invalid expiration|invalid card security|invalid cvv|invalid pin|format error|invalid transaction info/.test(
      blob
    )
  ) {
    return GUEST_INACCURATE;
  }
  if (/no such card issuer|unsupported card/.test(blob)) {
    return GUEST_NOT_A_CARD;
  }
  if (/pick\s*up|stolen|lost card|lost\/stolen|fraudulent/.test(blob)) {
    return GUEST_TRY_ANOTHER;
  }
  if (/duplicate/.test(blob)) {
    return GUEST_DUPLICATE;
  }

  const ints = codes
    .map((c) => Number(String(c).trim()))
    .filter((n) => Number.isFinite(n));
  if (ints.some((n) => n >= 300 && n <= 499)) return GUEST_OURS;
  if (response === "2" || ints.some((n) => n >= 200 && n <= 299)) {
    return GUEST_DECLINE_DEFAULT;
  }
  return GUEST_DECLINE_DEFAULT;
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
      : cardMint.error === "second_dba_pending"
        ? "second_dba_pending"
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
      ...(recordName(opts.customerName)
        ? { field_4: recordName(opts.customerName) }
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
    const message = guestCardMessage({ error: "amountUsd required" });
    return { ok: false, error: "amountUsd required", message, ...base };
  }
  if (!orderId) {
    const message = guestCardMessage({ error: "invoiceNumber required" });
    return { ok: false, error: "invoiceNumber required", message, ...base };
  }
  if (!token) {
    const message = guestCardMessage({ error: "payment_token required" });
    return { ok: false, error: "payment_token required", message, ...base };
  }
  const key = String(opts.privateKey || nmiPrivateKey()).trim();
  if (!key) {
    const message = guestCardMessage({ error: "keys_missing" });
    return { ok: false, error: "keys_missing", message, ...base };
  }
  const customerName = recordName(opts.customerName);
  const staffName = recordName(opts.staffName);
  const notes = recordName(opts.notes || opts.moreInfo, 255);
  const billing = saleBillingAddress({
    customerName,
    address1: opts.address1 || opts.address,
    city: opts.city,
    state: opts.state,
    zip: opts.zip || opts.postalCode || opts.postal_code,
    country: opts.country,
    email: opts.email,
  });
  const descBase = String(opts.summary || `${brand.name} ${orderId}`);
  const orderDescription = staffName
    ? `${descBase} · ${staffName}`.slice(0, 100)
    : descBase.slice(0, 100);
  // No payment_descriptor / Classic descriptor: this MID refuses custom DBA.
  // field_4 Guest / field_5 Processor / field_6 More info — records only.
  // billing_address AVS (address1/city/state/zip/country) is not a descriptor.
  const body = {
    amount,
    currency: "USD",
    payment_details: { payment_token: token },
    ...(billing ? { billing_address: billing } : {}),
    order_details: {
      id: orderId,
      order_description: orderDescription,
    },
    // Portal MDFs: 1 Brand, 2 CRM/open ref, 3 Invoice, 4 Guest, 5 Processor, 6 Notes.
    merchant_defined_fields: {
      field_1: brand.id,
      field_2: orderId,
      field_3: orderId,
      ...(customerName ? { field_4: customerName } : {}),
      ...(staffName ? { field_5: staffName } : {}),
      ...(notes ? { field_6: notes } : {}),
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
    const message = guestCardMessage({
      ...json,
      json,
      error: "declined",
      httpStatus: res.status,
    });
    return {
      ok: false,
      error: message === GUEST_OURS ? "processor_error" : "declined",
      message,
      blockedReason: message,
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
    const message = guestCardMessage({ error: "already_paid" });
    return { ok: false, error: "already_paid", message, httpStatus: 409 };
  }
  const token = String(opts.paymentToken || "").trim();
  if (looksLikePan(token)) {
    const message = guestCardMessage({ error: "raw_card_rejected" });
    return { ok: false, error: "raw_card_rejected", message, httpStatus: 400 };
  }
  return chargeWithToken({
    amountUsd: invoice.amountUsd,
    invoiceNumber: invoice.invoiceNumber,
    kind: invoice.kind,
    customerName: invoice.customerName,
    summary: invoice.summary,
    paymentToken: token,
    address1: opts.address1 || opts.address,
    city: opts.city,
    state: opts.state,
    zip: opts.zip || opts.postalCode || opts.postal_code,
    country: opts.country,
    email: opts.email,
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
    const message = guestCardMessage({ error: "short_code_required" });
    return { ok: false, error: "short_code_required", message, httpStatus: 400 };
  }
  const token = String(opts.paymentToken || "").trim();
  if (looksLikePan(token)) {
    const message = guestCardMessage({ error: "raw_card_rejected" });
    return { ok: false, error: "raw_card_rejected", message, httpStatus: 400 };
  }
  if (!token) {
    const message = guestCardMessage({ error: "payment_token required" });
    return {
      ok: false,
      error: "payment_token required",
      message,
      httpStatus: 400,
    };
  }
  if (typeof opts.loadInvoice !== "function" || typeof opts.claimInvoicePaid !== "function") {
    const message = guestCardMessage({ error: "store_missing" });
    return { ok: false, error: "store_missing", message, httpStatus: 503 };
  }

  const verified = await opts.loadInvoice(code);
  if (!verified || !verified.ok || !verified.data) {
    const err = verified?.error || "invalid";
    const message = guestCardMessage({ error: err });
    return {
      ok: false,
      error: err,
      message,
      httpStatus: 410,
    };
  }
  const invoice = verified.data;
  if (invoice.paidAt) {
    const message = guestCardMessage({ error: "already_paid" });
    return { ok: false, error: "already_paid", message, httpStatus: 409 };
  }

  const claimedAt = opts.now || new Date().toISOString();
  const claimed = await opts.claimInvoicePaid(code, { paidAt: claimedAt });
  if (!claimed || !claimed.ok) {
    const err = claimed?.error || "claim_failed";
    const message = guestCardMessage({ error: err });
    return {
      ok: false,
      error: err === "already_paid" ? "already_paid" : err,
      message,
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
    address1: opts.address1 || opts.address,
    city: opts.city,
    state: opts.state,
    zip: opts.zip || opts.postalCode || opts.postal_code,
    country: opts.country,
    email: opts.email,
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
    const err = sale.error || "declined";
    const message = sale.message || guestCardMessage(sale);
    return {
      ok: false,
      error: err,
      message,
      blockedReason: message || sale.blockedReason,
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

  const recorded = await recordNmiPaid({
    code,
    invoice,
    transactionId: sale.transactionId,
    paidAt: claimed.paidAt || claimedAt,
    markInvoicePaid: opts.markInvoicePaid,
    claimNmiNote: opts.claimNmiNote,
    appendReservationNote: opts.appendReservationNote,
    appendHotelNote: opts.appendHotelNote,
  });
  return {
    ok: true,
    transactionId: sale.transactionId || recorded.transactionId || null,
    httpStatus: 200,
    note: recorded.note,
    noteWritten: Boolean(recorded.noteWritten),
  };
}

/**
 * Stamp paidAt + transactionId and write the CRM staff note once.
 * Shared by guest /pay/:code/charge and the signed NMI webhook.
 * claimNmiNote CAS-skips a second note if the browser POST already wrote it.
 */
export async function recordNmiPaid(opts = {}) {
  const code = String(opts.code || "").trim();
  const invoice = opts.invoice || {};
  const transactionId = String(opts.transactionId || "").trim() || null;
  const paidAt = opts.paidAt || new Date().toISOString();
  if (typeof opts.markInvoicePaid === "function") {
    try {
      await opts.markInvoicePaid(code, { paidAt, transactionId });
    } catch (e) {
      console.warn("markInvoicePaid failed", e.message);
    }
  }
  const note = nmiPaidStaffNote({
    amountUsd: invoice.amountUsd,
    transactionId,
  });
  if (typeof opts.claimNmiNote === "function") {
    let claimed;
    try {
      claimed = await opts.claimNmiNote(code, { nmiNoteAt: paidAt });
    } catch (e) {
      console.warn("claimNmiNote failed", e.message);
      claimed = { ok: false, error: e.message };
    }
    if (!claimed || !claimed.ok) {
      return {
        ok: true,
        transactionId,
        note,
        noteWritten: false,
        alreadyNoted: true,
        httpStatus: 200,
      };
    }
  }
  const recordId = Number(invoice.recordId);
  const kind = noteKind(invoice);
  let noteWritten = false;
  try {
    if (Number.isFinite(recordId) && recordId > 0) {
      if (kind === "reservation" && typeof opts.appendReservationNote === "function") {
        await opts.appendReservationNote(recordId, note);
        noteWritten = true;
      } else if (kind === "hotel" && typeof opts.appendHotelNote === "function") {
        await opts.appendHotelNote(recordId, note);
        noteWritten = true;
      }
    }
  } catch (e) {
    console.warn("nmi paid CRM note failed", e.message);
  }
  return {
    ok: true,
    transactionId,
    note,
    noteWritten,
    httpStatus: 200,
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
