// mercury-gateway.js - the pay-proxy's ONE door to Mercury.
//
// Joseph, 23 Sep 2026, verbatim: "Excuse me, but nothing needs to work through this machine.
// Things need to work through APIs."
//
// Every Mercury call this service makes goes through here. Each call tries the DIRECT path first:
// https://api.mercury.com from this service's own static egress IPs (canon s.3 holds the one
// authoritative copy of the three addresses). Only when Mercury answers 401 ipNotWhitelisted (or,
// for a read, the network or Mercury itself fails) does the call fall back to the path that served
// it before this ship:
//   reads  -> the money seat on Joseph's PC, through the outbound hop (money-hop.js read / door)
//   AR     -> MERCURY_API_BASE (the old home quick tunnel), exactly as before
// Which path served every use is recorded and reported in health, per token. The moment a direct
// call succeeds the token is "direct ok" and every later call goes direct first and stays there.
// While a token is blocked, direct is re-tried at most once a minute (plus a probe every 5 minutes),
// so the server switches itself on within minutes of the allowlist edit, with nobody touching it.
//
// A WRITE never falls back after a direct attempt that may have reached Mercury (timeout, 5xx):
// only the definitive 401 ipNotWhitelisted, where nothing happened, lets a POST try the old path.
//
// THE SEAT'S PROTECTION IS CODE HERE, NOT A LOCATION.
//   MERCURY_TOKEN_NESHER_FULL (the wide token) is READ ONLY: GET /accounts, GET
//   /account/{nesher id}/transactions WITH start and end, GET /ar/invoices, GET /ar/customers.
//   MERCURY_TOKEN_NESHER (AR) may touch ar/invoices and ar/customers only (the relay's own list).
//   Any send / transfer / request-send-money / recipient(s) / attachments / internal-transfer path,
//   and any non-GET on an account's transactions, is refused 405 not_in_this_ship for EITHER token
//   before a request exists - EXCEPT the one F7 pay path below (checkPayOperation): request-send-money
//   for approval from Nesher checking to an existing, allowed recipient, behind MONEY_PAY=on.
//   Nesher accounts only: checking ••5649 matched by id AND last four,
//   savings ••5926; the Richter accounts (last four 8521 and 1588) are dropped before anything is
//   named, and a transactions read is refused for any account id that did not pass that filter.
// No token value is ever logged, returned or put in health: name, presence and length only.
import crypto from "node:crypto";
import { fetchWithTimeout } from "./http.js";
import { normalizeToken } from "./mercury.js";

export const MERCURY_GATEWAY_BUILD = "2026-09-24-pay-person";
export const MERCURY_DIRECT_ROOT = "https://api.mercury.com/api/v1";
export const TOKEN_AR = "MERCURY_TOKEN_NESHER";
export const TOKEN_FULL = "MERCURY_TOKEN_NESHER_FULL";
export const SEAT_ACCOUNTS = Object.freeze([
  Object.freeze({ label: "checking", last4: "5649", id: "841f6d7c-53b8-11f1-a581-8f1a5e965da2" }),
  Object.freeze({ label: "savings", last4: "5926", id: null }),
]);
export const NEVER_LAST4 = Object.freeze(["8521", "1588"]);
export const NOT_IN_THIS_SHIP = Object.freeze([
  "send", "transfer", "transfers", "request-send-money", "recipient", "recipients",
  "attachments", "internal-transfer",
]);
export const MAX_SPAN_DAYS = 92;
export const PENDING_WINDOW_DAYS = 45;
export const TX_FIELDS = Object.freeze(["id", "amount", "status", "kind", "createdAt", "postedAt",
  "estimatedDeliveryDate", "counterpartyName", "counterpartyNickname", "bankDescription",
  "externalMemo", "note", "mercuryCategory", "dashboardLink", "hasGeneratedReceipt", "reasonForFailure"]);
export const INVOICE_FIELDS = Object.freeze(["id", "invoiceNumber", "status", "amount", "currencyCode",
  "creditCardEnabled", "achDebitEnabled", "createdAt", "updatedAt", "canceledAt"]);
const ORG_PATTERN = /air today/i;
const SEAT_DATA_PATHS = ["/balances", "/transactions", "/invoices"];
const AR_PATH = /^\/ar\/(invoices|customers)(\/[A-Za-z0-9-]+)?(\/cancel)?$/;

function iso(ms) { return new Date(ms).toISOString(); }
function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
function validDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z")); }
function spanDays(a, b) { return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000); }
function round2(n) { return Math.round(n * 100) / 100; }
function short(e) { return String((e && e.message) || e || "").slice(0, 120); }
function last4(acc) { return String((acc && acc.accountNumber) || "").slice(-4); }
function pick(obj, fields) { const o = {}; for (const k of fields) if (obj && obj[k] !== undefined) o[k] = obj[k]; return o; }

/**
 * Is this operation allowed for this token? Pure; used before any request exists.
 * @returns {{ok:true}|{ok:false,status:number,error:string}}
 */
export function checkOperation(tokenKey, method, pathWithQuery, allowedAccountIds = new Set([SEAT_ACCOUNTS[0].id])) {
  const m = String(method || "GET").toUpperCase();
  const [pathname, qs = ""] = String(pathWithQuery || "").split("?");
  if (!pathname.startsWith("/") || pathname.includes("..") || pathname.includes("://")) {
    return { ok: false, status: 400, error: "bad_path" };
  }
  const segs = pathname.split("/").filter(Boolean).map((s) => s.toLowerCase());
  if (segs.some((s) => NOT_IN_THIS_SHIP.includes(s))) return { ok: false, status: 405, error: "not_in_this_ship" };
  const acctTx = pathname.match(/^\/account\/([^/]+)\/transactions$/);
  if (acctTx && m !== "GET") return { ok: false, status: 405, error: "not_in_this_ship" };
  if (tokenKey === TOKEN_FULL) {
    if (m !== "GET") return { ok: false, status: 405, error: "not_in_this_ship" };
    if (pathname === "/accounts" || pathname === "/ar/invoices" || pathname === "/ar/customers") return { ok: true };
    if (acctTx) {
      const q = new URLSearchParams(qs);
      if (!q.get("start") || !q.get("end")) return { ok: false, status: 400, error: "start_and_end_required" };
      if (!allowedAccountIds.has(acctTx[1])) return { ok: false, status: 403, error: "account_not_nesher" };
      return { ok: true };
    }
    return { ok: false, status: 405, error: "not_allowlisted" };
  }
  if (tokenKey === TOKEN_AR) {
    if (m !== "GET" && m !== "POST") return { ok: false, status: 405, error: "method_not_allowed" };
    if (AR_PATH.test(pathname)) return { ok: true };
    return { ok: false, status: 405, error: "not_allowlisted" };
  }
  return { ok: false, status: 500, error: "unknown_token" };
}

/**
 * The seat's account filter, ported (nesher-money-seat/lib/mercury.js pickSeatAccounts).
 * Returns rows in SEAT_ACCOUNTS order. Drops any NEVER_LAST4 account, any account whose legal
 * name is present and not Air Today, any non-mercury type. Throws on an id/last4 mismatch.
 */
export function pickSeatAccounts(all) {
  const out = [];
  for (const want of SEAT_ACCOUNTS) {
    const hit = (all || []).find((a) => {
      if (!a || NEVER_LAST4.includes(last4(a))) return false;
      if (a.type && a.type !== "mercury") return false;
      if (a.legalBusinessName && !ORG_PATTERN.test(a.legalBusinessName)) return false;
      if (want.id) return a.id === want.id;
      return last4(a) === want.last4;
    });
    if (!hit) continue;
    if (want.id && last4(hit) !== want.last4) {
      throw new Error("account id/last4 mismatch for " + want.label + " - refusing to name it");
    }
    out.push({
      label: want.label,
      last4: want.last4,
      id: hit.id,
      name: hit.name || hit.nickname || "",
      kind: hit.kind,
      status: hit.status,
      available: hit.availableBalance,
      current: hit.currentBalance,
      org: hit.legalBusinessName || null,
    });
  }
  return out;
}

// ── F7 (24 Sep 2026): ONE narrow path to pay a supplier ──────────────────────
// Joseph, 22 Sep: "it should be able to show the amount in the bank account, make payment to
// someonbe etc etc"; "also it should only have access to the nesher account".
// What opens, and nothing else: request-send-money (Mercury's APPROVAL flow - the payment waits for
// an approver in the Mercury app; nothing leaves on the chat's word), from Nesher checking ••5649
// only, to an EXISTING Mercury recipient that passes payeeVerdict. The four reads it needs (the
// recipients list, one recipient, the Nesher approval requests, one approval request) are exact
// shapes. Direct send (POST /account/{id}/transactions), transfers, recipient create / edit /
// delete, attachments, and every other path stay 405 not_in_this_ship - checkOperation above is
// untouched, so the relay, the pay modal and the hop can still never reach any of them. Direct
// only: a write is never replayed down a fallback.
export const PAY_CHECKING = SEAT_ACCOUNTS[0];
export const PAY_METHODS = Object.freeze(["ach", "domesticWire", "internationalWire"]);
/** Our own accounts: paying one of them is a transfer, not a supplier payment. */
export const OWN_LAST4 = Object.freeze(["5649", "5926"]);
/** Another organisation of Joseph's, the Richter family, or a person of the Green family: never a payee. */
export const PAY_BLOCK_NAME = /air\s*today|nesher|rank\s*friendly|orchim|richter|\b(?:yoseph|yosef|joseph|chava)\s+green\b/i;
export const PAY_MIN_CENTS = 100;
export const PAY_MAX_CENTS_DEFAULT = 10000 * 100;
export const PAY_DAY_CENTS_DEFAULT = 25000 * 100;
export const PAY_LIVE_STATES = Object.freeze(["pendingApproval", "approved"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is this one of the five pay shapes? Pure; used before any request exists. */
export function checkPayOperation(method, pathWithQuery) {
  const m = String(method || "GET").toUpperCase();
  const [p, qs = ""] = String(pathWithQuery || "").split("?");
  if (!p.startsWith("/") || p.includes("..") || p.includes("://")) return { ok: false, status: 400, error: "bad_path" };
  if (m === "GET" && p === "/recipients") return { ok: true };
  if (m === "GET" && /^\/recipient\/[^/]+$/.test(p)) return UUID_RE.test(p.slice(11)) ? { ok: true } : { ok: false, status: 400, error: "bad_id" };
  if (m === "GET" && p === "/request-send-money") {
    return new URLSearchParams(qs).get("accountId") === PAY_CHECKING.id ? { ok: true } : { ok: false, status: 403, error: "account_not_nesher" };
  }
  if (m === "GET" && /^\/request-send-money\/[^/]+$/.test(p)) return UUID_RE.test(p.slice(20)) ? { ok: true } : { ok: false, status: 400, error: "bad_id" };
  if (m === "POST" && p === `/account/${PAY_CHECKING.id}/request-send-money`) return { ok: true };
  // Mr. AJ Money (Joseph, 24 Sep): add a recipient; send an ACH from Nesher checking; read one
  // payment of Nesher checking. Each is one exact shape; the switches (MONEY_PAY_RECIPIENTS,
  // MONEY_PAY_MODE) are checked by the functions that use them, never here.
  if (m === "POST" && p === "/recipients") return { ok: true };
  if (m === "POST" && p === `/account/${PAY_CHECKING.id}/transactions`) return { ok: true };
  const tx = p.match(/^\/account\/([^/]+)\/transaction\/([^/]+)$/);
  if (m === "GET" && tx) {
    if (tx[1] !== PAY_CHECKING.id) return { ok: false, status: 403, error: "account_not_nesher" };
    return UUID_RE.test(tx[2]) ? { ok: true } : { ok: false, status: 400, error: "bad_id" };
  }
  return { ok: false, status: 405, error: "not_in_this_ship" };
}

// ── Mr. AJ Money (24 Sep 2026): pay a PERSON, add a recipient, send without an approver ─────────
// Joseph, 24 Sep, on the open item "paying individuals": he pastes a customer's bank details and
// says "we want to refund them $630" - "would Mr money be able to do it?". Then: "it needs to be
// able to add recipients", and "No need to wait for approvels". So, behind two switches:
//   MONEY_PAY_RECIPIENTS=on  - a person may be a payee (the hard lines below still hold), and the
//                              desk may ADD a recipient (ACH, US routing only). Adding moves no money.
//   MONEY_PAY_MODE=direct    - an ACH payee is paid with POST /account/{checking}/transactions (no
//                              approver); the desk holds it 60 s with Undo first. A wire still goes
//                              through request-send-money (approval), as in F7. Anything else = F7.
// A recipient's bank details are never logged, returned or kept: the desk sees a FINGERPRINT
// (HMAC of method|routing|account under the ticket secret) so a change of bank details between the
// tile and the tap is refused, and a change since the desk last saw it is caught.

/** ABA routing-number checksum (3-7-1). Pure. */
export function abaOk(routing) {
  const s = String(routing || "");
  if (!/^\d{9}$/.test(s) || /^0{9}$/.test(s)) return false;
  const d = s.split("").map(Number);
  return (3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8])) % 10 === 0;
}
export const ACH_TYPES = Object.freeze(["personalChecking", "personalSavings", "businessChecking", "businessSavings"]);
const EMAIL_RE = /^[^\s@<>(),;:"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/** Gabbai AJ C2: any run of 5+ digits (spaces / dashes allowed inside) keeps only its last four. Pure. */
export function scrubDigits(t) {
  return String(t == null ? "" : t).replace(/\d[\d \-]{3,}\d/g, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 5 ? "\u2022\u2022" + d.slice(-4) : m;
  });
}

/** "yael.sher@gmail.com" -> "y***@gmail.com". For logs and the tile. Pure. */
export function maskEmail(e) {
  const s = String(e || "").trim();
  const i = s.lastIndexOf("@");
  if (i < 1) return s ? "***" : "";
  return s[0] + "***" + s.slice(i);
}

/** The fingerprint of a recipient's bank details. "" when there are none or no key. Pure. */
export function payeeFingerprint(r, key) {
  if (!r || !key) return "";
  const e = r.electronicRoutingInfo || {};
  const w = r.domesticWireRoutingInfo || {};
  const i = r.internationalWireRoutingInfo || {};
  const parts = [
    e.accountNumber ? `ach:${e.routingNumber || ""}:${String(e.accountNumber).replace(/\s+/g, "")}` : "",
    w.accountNumber ? `wire:${w.routingNumber || ""}:${String(w.accountNumber).replace(/\s+/g, "")}` : "",
    (i.iban || i.swiftCode) ? `intl:${i.swiftCode || ""}:${String(i.iban || "").replace(/\s+/g, "")}` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  return crypto.createHmac("sha256", String(key)).update("payee-fp.v1|" + parts.join("|")).digest("hex").slice(0, 24);
}

// Country words -> ISO 3166 alpha-2 (Mercury's address.country). A two-letter code passes as itself. Pure.
const COUNTRY_ISO2 = {
  "united states": "US", "united states of america": "US", usa: "US", "u.s.": "US", "u.s.a.": "US", america: "US",
  israel: "IL", canada: "CA", "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB",
  belgium: "BE", france: "FR", germany: "DE", netherlands: "NL", switzerland: "CH", austria: "AT",
  australia: "AU", mexico: "MX", argentina: "AR", brazil: "BR", italy: "IT", spain: "ES", hungary: "HU",
};
export function countryCode(c) {
  const t = String(c == null ? "" : c).trim().toLowerCase().replace(/\s+/g, " ");
  if (/^[a-z]{2}$/.test(t)) return t === "uk" ? "GB" : t.toUpperCase();
  return COUNTRY_ISO2[t] || "";
}

/**
 * WhatsApp/markdown decoration off a pasted name or street line: a leading "- " or "> " (a reply
 * quote or bullet marker, possibly repeated), and any "*", "_", "~" or bullet character (used for
 * bold/italic/strike, or as a list mark) wherever it sits - so "*Name:* Leah Roth"-style wrapping and
 * inner bold pairs come off too, not only the ends. Pure.
 */
export function stripDecoration(v) {
  let s = String(v == null ? "" : v);
  s = s.replace(/^(?:[-•▪‣·>]\s+)+/, "");
  s = s.replace(/[*_~•▪‣·]/g, "");
  return s.replace(/\s+/g, " ").trim();
}

/**
 * What a pasted set of bank details may become, checked before anything reaches Mercury. Pure.
 * in: {name, routing, account, type, business, emails[], address{address1,city,region,postalCode,country}}
 * -> {ok:true, body, view} | {ok:false, error}
 * body is the Mercury POST /recipients body (ACH only); view is what the desk may see (never the numbers).
 */
export function recipientDraft(input) {
  const x = input && typeof input === "object" ? input : {};
  const clean = (v, n) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
  const name = clean(stripDecoration(x.name), 80);
  if (name.length < 2 || !/\p{L}/u.test(name) || !/^[\p{L}\p{Nd}]/u.test(name)) return { ok: false, error: "name_required" };
  if (/[\d$₪]/.test(name)) return { ok: false, error: "name_invalid", decline_reason_human: "The recipient name has numbers or signs in it - nothing was added. Type just the account holder's name." };
  if (PAY_BLOCK_NAME.test(name)) return { ok: false, error: "own_or_other_org" };
  const routing = String(x.routing || "").replace(/\D/g, "");
  if (!abaOk(routing)) return { ok: false, error: "routing_invalid" };
  const account = String(x.account || "").replace(/[\s-]/g, "");
  if (!/^\d{4,17}$/.test(account)) return { ok: false, error: "account_invalid" };
  const l4 = account.slice(-4);
  if (NEVER_LAST4.includes(l4)) return { ok: false, error: "richter" };
  if (OWN_LAST4.includes(l4)) return { ok: false, error: "own_account" };
  const business = x.business === true;
  let type = String(x.type || "");
  if (!ACH_TYPES.includes(type)) {
    const savings = /saving/i.test(type);
    type = (business ? "business" : "personal") + (savings ? "Savings" : "Checking");
  }
  const emails = (Array.isArray(x.emails) ? x.emails : []).map((e) => clean(e, 254).toLowerCase()).filter((e) => EMAIL_RE.test(e)).slice(0, 3);
  // Mr. AL (24 Sep): Mercury's electronicRoutingInfo REQUIRES address {address1, city, region,
  // postalCode, country ISO alpha-2}; without it Mercury answered {"jsonParse":[...]} to Joseph's paste.
  // No complete address = refused HERE, before Mercury, and the tile asks the rep for one line.
  const a = x.address && typeof x.address === "object" ? x.address : null;
  if (!a) return { ok: false, error: "address_required" };
  const address = { address1: clean(stripDecoration(a.address1), 120), city: clean(a.city, 60), region: clean(a.region, 40), postalCode: clean(a.postalCode, 12), country: countryCode(a.country == null || a.country === "" ? "US" : a.country) };
  if (!address.address1 || !address.city || !address.region || !address.postalCode || !address.country) return { ok: false, error: "address_required" };
  if (!/^[\p{L}\p{Nd}]/u.test(address.address1)) return { ok: false, error: "address_required" };
  if (clean(a.address2, 60)) address.address2 = clean(a.address2, 60);
  const eri = { accountNumber: account, routingNumber: routing, electronicAccountType: type, address };
  const body = { name, emails, electronicRoutingInfo: eri };
  return {
    ok: true,
    body,
    view: { name, method: "ach", type, last4: l4, emails: emails.map(maskEmail), address: address ? `${address.city}, ${address.region}` : "" },
  };
}

function recipientLast4(r) {
  const e = (r && r.electronicRoutingInfo) || {};
  const w = (r && r.domesticWireRoutingInfo) || {};
  const i = (r && r.internationalWireRoutingInfo) || {};
  return String(e.accountNumber || w.accountNumber || i.iban || "").replace(/\s+/g, "").slice(-4);
}

/** The method this payee is paid by, when we can pay it from here; else "". */
export function payMethodOf(r) {
  if (!r) return "";
  const want = r.defaultPaymentMethod;
  const has = {
    ach: Boolean(r.electronicRoutingInfo && r.electronicRoutingInfo.accountNumber),
    domesticWire: Boolean(r.domesticWireRoutingInfo && r.domesticWireRoutingInfo.accountNumber),
    internationalWire: Boolean(r.internationalWireRoutingInfo && (r.internationalWireRoutingInfo.iban || r.internationalWireRoutingInfo.swiftCode)),
  };
  if (PAY_METHODS.includes(want) && has[want]) return want;
  return PAY_METHODS.find((m) => has[m]) || "";
}

/**
 * May Nesher pay this Mercury recipient from the chat? Pure. Plan 1.5 hard lines: no personal
 * account, no other organisation, never the Richter accounts, never our own accounts.
 * @returns {{ok:true, method:string}|{ok:false, why:string}}
 */
export function payeeVerdict(r, o = {}) {
  if (!r || typeof r !== "object" || !r.id) return { ok: false, why: "unknown" };
  if (r.status && r.status !== "active") return { ok: false, why: "inactive" };
  const words = `${r.name || ""} ${r.nickname || ""}`;
  if (PAY_BLOCK_NAME.test(words)) return { ok: false, why: "own_or_other_org" };
  const l4 = recipientLast4(r);
  if (l4 && NEVER_LAST4.includes(l4)) return { ok: false, why: "richter" };
  if (l4 && OWN_LAST4.includes(l4)) return { ok: false, why: "own_account" };
  const acctType = String((r.electronicRoutingInfo && r.electronicRoutingInfo.electronicAccountType) || "");
  // A person is a payee only when MONEY_PAY_RECIPIENTS=on (Joseph 24 Sep: refunds to customers).
  if (o.persons !== true && /^personal/i.test(acctType)) return { ok: false, why: "personal" };
  if (o.persons !== true && r.isBusiness !== true) return { ok: false, why: "personal" };
  const method = payMethodOf(r);
  if (!method) return { ok: false, why: "no_method" };
  return { ok: true, method };
}

/** What the desk may see of a payee: name, nickname, how it is paid, bank, last four. */
export function payeeView(r, o = {}) {
  const v = payeeVerdict(r, o);
  const method = v.ok ? v.method : payMethodOf(r);
  const info = method === "ach" ? r.electronicRoutingInfo : method === "domesticWire" ? r.domesticWireRoutingInfo : method === "internationalWire" ? r.internationalWireRoutingInfo : null;
  const bank = info ? (info.bankName || (info.bankDetails && info.bankDetails.bankName) || "") : "";
  return {
    id: r.id,
    name: String(r.name || "").slice(0, 80),
    nickname: String(r.nickname || "").slice(0, 120),
    method,
    bank: String(bank || "").slice(0, 60),
    last4: recipientLast4(r),
    lastPaid: r.dateLastPaid || null,
    person: r.isBusiness !== true,
    fp: payeeFingerprint(r, o.fpKey),
    payable: v.ok === true,
    why: v.ok ? null : v.why,
  };
}

/** Mercury's approval request, the fields the desk needs (never a user id). */
export function payRequestView(q) {
  if (!q || typeof q !== "object") return null;
  const reviews = Array.isArray(q.reviews) ? q.reviews.map((x) => ({ status: x && x.status, at: x && x.reviewedAt })) : [];
  return {
    id: q.requestId,
    status: q.status,
    amount: Number(q.amount),
    recipientId: q.recipientId,
    method: q.paymentMethod,
    memo: q.memo == null ? "" : String(q.memo),
    createdAt: q.createdAt || null,
    approversRequired: q.numberOfApproversRequired == null ? null : Number(q.numberOfApproversRequired),
    requesterMayApprove: q.requesterMayApprove === true,
    reviews,
  };
}

function memoKey(s) {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** The internal note BEGINS with the rep's memo, then this marker (Gabbai 24 Sep C4). */
export const NOTE_MARK = " · desk chat ";

/**
 * What goes to the supplier's bank (Mercury externalMemo). Rule 23: an Air Today payment never
 * carries a JRM mark - "JRM Hotels", JRM-... references and the word JRM are taken out; nothing
 * left = "Supplier payment". The full memo stays in the note, the tile and the log.
 */
export function externalMemoOf(memo, fallback) {
  const out = String(memo || "")
    .replace(/\bJRM[-\s]?Hotels?\b/gi, " ")
    .replace(/\bJRM-[A-Z0-9-]+/gi, " ")
    .replace(/\bJRM\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s,;:.\-–]+|[\s,;:\-–]+$/g, "")
    .trim();
  return out || String(fallback || "Supplier payment");
}

/** The rep's memo out of an echoed memo (the part before the desk-chat marker). */
export function memoBase(echo) {
  const s = String(echo || "");
  const i = s.indexOf(NOTE_MARK);
  return i >= 0 ? s.slice(0, i) : s;
}

/**
 * The desk tile id at the front of a note - deskNote's own words are "<tileId> by <rep>...", and the
 * gateway puts that straight after NOTE_MARK when it sends (money-pay.js deskNote/sendDoor). Works on
 * either shape: the raw desk-note text (o.note, before NOTE_MARK is added) or the full Mercury note
 * Mercury hands back on a read (memo + NOTE_MARK + desk-note). "" when there is no tile id to read -
 * an older or hand-made note, never our own retry. Pure.
 */
export function noteTileId(s) {
  const raw = String(s || "");
  const i = raw.indexOf(NOTE_MARK);
  const desk = i >= 0 ? raw.slice(i + NOTE_MARK.length) : raw;
  const m = desk.match(/^(\S+)\s+by\s+/);
  return m ? m[1] : "";
}

/**
 * Does the memo Mercury echoes on a request belong to the rep's memo? Mercury's docs do not say
 * whether `memo` echoes externalMemo or the note, so both are accepted: equal to the memo, equal to
 * its external form, or the note that begins with the memo and the desk-chat marker.
 */
export function memoMatches(echo, memo) {
  const m = memoKey(memo);
  if (!m || !String(echo || "").trim()) return false;
  const e = memoKey(echo);
  return e === m || e === memoKey(externalMemoOf(memo)) || memoKey(memoBase(echo)) === m;
}

class Fallback extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

export function createMercuryGateway(opts = {}) {
  const env = opts.env || process.env;
  const rawFetch = opts.fetchImpl || ((u, i) => fetch(u, i));
  const now = opts.now || (() => Date.now());
  const getHop = typeof opts.getHop === "function" ? opts.getHop : () => opts.hop || null;
  const retryMs = Number(opts.blockRetryMs ?? 60 * 1000);
  const timeoutMs = Number(opts.timeoutMs ?? 15000);
  const allowedAccountIds = new Set([SEAT_ACCOUNTS[0].id]);

  function freshToken() {
    return {
      direct: "untried", last_try_at: null, last_ok_at: null, last_blocked_at: null,
      blocked_ip: null, last_error: null,
      calls: { direct: 0, seat: 0, tunnel: 0, failed: 0, refused: 0 },
    };
  }
  const tokens = { [TOKEN_AR]: freshToken(), [TOKEN_FULL]: freshToken() };
  const uses = {};

  function tokenValue(key) {
    if (key === TOKEN_AR) return normalizeToken(env.MERCURY_TOKEN_NESHER || env.MERCURY_TOKEN || "");
    if (key === TOKEN_FULL) return normalizeToken(env.MERCURY_TOKEN_NESHER_FULL || "");
    return "";
  }
  function tokenLength(key) {
    const raw = key === TOKEN_AR ? (env.MERCURY_TOKEN_NESHER || env.MERCURY_TOKEN || "") : (env[key] || "");
    return String(raw).trim().length;
  }
  function tunnelRoot() {
    const b = String(env.MERCURY_API_BASE || "").trim().replace(/\/$/, "");
    if (!b || /^https:\/\/api\.mercury\.com$/i.test(b)) return null;
    return b + "/api/v1";
  }
  function headersFor(tok, hasBody) {
    const h = { Authorization: `Bearer ${tok}`, Accept: "application/json" };
    if (hasBody) h["Content-Type"] = "application/json";
    return h;
  }
  function mark(use, tokenKey, servedBy, status) {
    uses[use] = { token: tokenKey, served_by: servedBy, status: status || null, at: iso(now()) };
    const c = tokens[tokenKey].calls;
    if (servedBy in c) c[servedBy]++;
    else c.failed++;
  }

  /**
   * One direct attempt. Never throws.
   * {status,text,contentType} = Mercury answered with authority (2xx, or 4xx other than 401/403).
   * {skipped} = no request was made. {blocked} = 401 ipNotWhitelisted. {failed} = network / 5xx /
   * 401-403 of another kind (a request MAY have reached Mercury).
   */
  async function tryDirect(tokenKey, method, path, init = {}) {
    const st = tokens[tokenKey];
    const tok = tokenValue(tokenKey);
    if (!tok) {
      st.direct = "no_token";
      return { skipped: "no_token" };
    }
    if (st.direct === "blocked" && !init.force && st.last_try_at && now() - Date.parse(st.last_try_at) < retryMs) {
      return { skipped: "blocked_recently" };
    }
    st.last_try_at = iso(now());
    let res;
    let text;
    try {
      res = await fetchWithTimeout(MERCURY_DIRECT_ROOT + path, {
        timeoutMs,
        method,
        headers: headersFor(tok, init.body != null),
        body: init.body == null ? undefined : init.body,
        signal: init.signal,
      }, rawFetch);
      text = await res.text();
    } catch (e) {
      st.last_error = "network: " + short(e);
      if (st.direct !== "ok" && st.direct !== "blocked") st.direct = "error";
      return { failed: "network" };
    }
    if (res.status === 401 && /ipNotWhitelisted/i.test(text)) {
      st.direct = "blocked";
      st.last_blocked_at = iso(now());
      const ip = String(text).match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      st.blocked_ip = ip ? ip[1] : null;
      st.last_error = null;
      return { blocked: true };
    }
    if (res.status === 401 || res.status === 403 || res.status >= 500) {
      st.last_error = `http_${res.status}`;
      if (st.direct !== "ok") st.direct = "error";
      // Mercury's own words ride along (a scope refusal names the scope); never a token, never a body we sent.
      return { failed: `http_${res.status}`, words: String(text || "").replace(/\s+/g, " ").slice(0, 300) };
    }
    st.direct = "ok";
    st.last_ok_at = iso(now());
    st.blocked_ip = null;
    st.last_error = null;
    return { status: res.status, text, contentType: res.headers.get("content-type") || "application/json" };
  }

  // ── AR (pay links, the concierge relay): direct, then the old tunnel ──────────
  async function arRequest(use, method, path, init = {}) {
    const m = String(method || "GET").toUpperCase();
    const chk = checkOperation(TOKEN_AR, m, path, allowedAccountIds);
    if (!chk.ok) {
      tokens[TOKEN_AR].calls.refused++;
      uses[use] = { token: TOKEN_AR, served_by: "refused", status: chk.status, at: iso(now()) };
      return { status: chk.status, text: JSON.stringify({ error: chk.error }), contentType: "application/json", servedBy: "refused" };
    }
    const d = await tryDirect(TOKEN_AR, m, path, init);
    if (d.status) {
      mark(use, TOKEN_AR, "direct", d.status);
      return { ...d, servedBy: "direct" };
    }
    // A POST that may have reached Mercury is never replayed down another path.
    const nothingSent = Boolean(d.blocked || d.skipped);
    const root = tunnelRoot();
    if (!root || (m !== "GET" && !nothingSent)) {
      mark(use, TOKEN_AR, "failed", 502);
      return {
        status: 502,
        text: JSON.stringify({ error: "mercury_unreachable", direct: d.blocked ? "blocked_by_allowlist" : (d.skipped || d.failed), fallback: root ? "not_replayed" : "none" }),
        contentType: "application/json",
        servedBy: "none",
      };
    }
    const tok = tokenValue(TOKEN_AR);
    try {
      const res = await fetchWithTimeout(root + path, {
        timeoutMs,
        method: m,
        headers: headersFor(tok, init.body != null),
        body: init.body == null ? undefined : init.body,
        signal: init.signal,
      }, rawFetch);
      const text = await res.text();
      mark(use, TOKEN_AR, "tunnel", res.status);
      return { status: res.status, text, contentType: res.headers.get("content-type") || "application/json", servedBy: "tunnel" };
    } catch (e) {
      mark(use, TOKEN_AR, "failed", 502);
      return { status: 502, text: JSON.stringify({ error: "mercury_unreachable", direct: d.blocked ? "blocked_by_allowlist" : (d.skipped || d.failed), fallback: "tunnel_failed", detail: short(e) }), contentType: "application/json", servedBy: "none" };
    }
  }

  /** fetch-compatible function for mercury.js createOrReusePaymentRequest (any base URL; the path after /api/v1 is used). */
  function arFetch(use) {
    return async (url, init = {}) => {
      const u = new URL(String(url));
      const i = u.pathname.indexOf("/api/v1");
      const path = (i >= 0 ? u.pathname.slice(i + 7) : u.pathname) + u.search;
      const r = await arRequest(use, init.method || "GET", path, { body: init.body, signal: init.signal });
      return new Response(r.text, { status: r.status, headers: { "content-type": r.contentType || "application/json", "x-mercury-path": r.servedBy } });
    };
  }

  // ── Seat-shaped reads, served direct (ported from nesher-money-seat/lib/app.js) ──
  async function directJson(tokenKey, path) {
    const chk = checkOperation(tokenKey, "GET", path, allowedAccountIds);
    if (!chk.ok) {
      tokens[tokenKey].calls.refused++;
      const e = new Error(chk.error);
      e.refusal = chk;
      throw e;
    }
    const d = await tryDirect(tokenKey, "GET", path);
    if (!d.status) throw new Fallback(d.blocked ? "blocked" : (d.skipped || d.failed));
    let body;
    try { body = d.text ? JSON.parse(d.text) : {}; } catch { body = { raw: String(d.text).slice(0, 300) }; }
    if (d.status >= 300) {
      const e = new Error("mercury " + d.status);
      e.mercury = { status: d.status, body };
      throw e;
    }
    return body;
  }

  async function accountsDirect() {
    const body = await directJson(TOKEN_FULL, "/accounts");
    const accounts = pickSeatAccounts(Array.isArray(body) ? body : (body.accounts || []));
    for (const a of accounts) allowedAccountIds.add(a.id);
    return accounts;
  }

  async function accountTransactionsDirect(accountId, o) {
    if (!o.start || !o.end) throw new Error("accountTransactions: start and end are required");
    const q = new URLSearchParams({ start: o.start, end: o.end, limit: String(o.limit || 1000), order: o.order || "desc" });
    if (o.status) q.set("status", o.status);
    if (o.offset) q.set("offset", String(o.offset));
    const body = await directJson(TOKEN_FULL, "/account/" + encodeURIComponent(accountId) + "/transactions?" + q.toString());
    return Array.isArray(body) ? body : (body.transactions || []);
  }

  async function balancesDirect() {
    const accounts = await accountsDirect();
    const today = new Date(now());
    const start = isoDate(addDays(today, -PENDING_WINDOW_DAYS));
    const end = isoDate(addDays(today, 1));
    for (const a of accounts) {
      const pend = await accountTransactionsDirect(a.id, { start, end, status: "pending" });
      let pin = 0;
      let pout = 0;
      let n = 0;
      for (const t of pend) {
        if (t.status && t.status !== "pending") continue;
        const amt = Number(t.amount) || 0;
        n++;
        if (amt >= 0) pin += amt;
        else pout += -amt;
      }
      a.pending_in = round2(pin);
      a.pending_out = round2(pout);
      a.pending_count = n;
      a.pending_window = { start, end };
    }
    return { status: 200, body: { as_of: iso(now()), org: "Air Today Travel Inc (Nesher)", accounts, seat: "direct" } };
  }

  async function transactionsDirect(q) {
    const start = q.get("start");
    const end = q.get("end");
    const label = q.get("account") || "checking";
    if (!start || !end) return { status: 400, body: { error: "start_and_end_required", hint: "YYYY-MM-DD both; Mercury truncates without them" } };
    if (!validDate(start) || !validDate(end)) return { status: 400, body: { error: "bad_date", hint: "YYYY-MM-DD" } };
    const span = spanDays(start, end);
    if (span < 0) return { status: 400, body: { error: "start_after_end" } };
    if (span > MAX_SPAN_DAYS) return { status: 400, body: { error: "range_too_wide", max_days: MAX_SPAN_DAYS, requested_days: span } };
    if (label !== "checking" && label !== "savings") return { status: 400, body: { error: "unknown_account", allowed: ["checking", "savings"] } };
    const accounts = await accountsDirect();
    const acc = accounts.find((a) => a.label === label);
    if (!acc) return { status: 404, body: { error: "account_not_visible", account: label } };
    const rows = [];
    const limit = 1000;
    for (let page = 0; page < 5; page++) {
      const batch = await accountTransactionsDirect(acc.id, { start, end, limit, offset: page * limit });
      for (const t of batch) rows.push(pick(t, TX_FIELDS));
      if (batch.length < limit) break;
    }
    let tin = 0;
    let tout = 0;
    for (const t of rows) { const a = Number(t.amount) || 0; if (a >= 0) tin += a; else tout += -a; }
    return {
      status: 200,
      body: { account: label, last4: acc.last4, start, end, count: rows.length, total_in: round2(tin), total_out: round2(tout), transactions: rows, seat: "direct" },
    };
  }

  function minimalInvoices(body) {
    const page = body && body.page && typeof body.page === "object" ? body.page : {};
    const more = Boolean(page.nextPage || page.next || page.startAfter || page.nextCursor);
    const list = Array.isArray(body && body.invoices) ? body.invoices : [];
    const invoices = list.map((i) => {
      const o = {};
      for (const k of INVOICE_FIELDS) o[k] = k === "canceledAt" ? (i[k] || null) : i[k];
      return o;
    });
    return { as_of: iso(now()), complete: !more, count: invoices.length, invoices };
  }

  async function invoicesDirect() {
    // AR is the AR token's own scope (least privilege); the wide token is not needed for it.
    const body = await directJson(TOKEN_AR, "/ar/invoices");
    return { status: 200, body: minimalInvoices(body) };
  }

  function tokenForSeatPath(p) {
    return p === "/invoices" ? TOKEN_AR : TOKEN_FULL;
  }

  /**
   * A seat-shaped read answered DIRECT, or null when the direct path is not available (the caller
   * then uses the seat). Local validation answers (400) count as direct: no PC was asked.
   */
  async function directSeatShape(use, pathWithQuery) {
    const u = new URL(String(pathWithQuery || "/"), "http://seat.local");
    const p = u.pathname;
    if (!SEAT_DATA_PATHS.includes(p)) return null;
    const tk = tokenForSeatPath(p);
    try {
      let r;
      if (p === "/balances") r = await balancesDirect();
      else if (p === "/transactions") r = await transactionsDirect(u.searchParams);
      else r = await invoicesDirect();
      mark(use, tk, "direct", r.status);
      return { status: r.status, body: JSON.stringify(r.body), servedBy: "direct" };
    } catch (e) {
      if (e instanceof Fallback) return null;
      if (e.refusal) {
        mark(use, tk, "refused", e.refusal.status);
        return { status: e.refusal.status, body: JSON.stringify({ error: e.refusal.error }), servedBy: "refused" };
      }
      if (e.mercury) {
        const b = e.mercury.body || {};
        const msg = b.message || b.error || b.errors || null;
        mark(use, tk, "direct", 502);
        return { status: 502, body: JSON.stringify({ error: "mercury_refused", mercury_status: e.mercury.status, mercury: typeof msg === "string" ? msg.slice(0, 300) : msg }), servedBy: "direct" };
      }
      mark(use, tk, "direct", 500);
      return { status: 500, body: JSON.stringify({ error: "seat_error", message: short(e) }), servedBy: "direct" };
    }
  }

  /**
   * The hop door's hook (money-hop.js opts.direct): answer a caller's signed data GET direct, or
   * null so the hop forwards it to the seat exactly as before. /health /caps /state stay the seat's.
   */
  async function hopDirect(sub) {
    const p = String(sub || "").split("?")[0];
    if (!SEAT_DATA_PATHS.includes(p)) return null;
    const use = "hop" + p;
    const d = await directSeatShape(use, sub);
    if (d) return d;
    mark(use, tokenForSeatPath(p), "seat", null);
    return null;
  }

  /** Seat-shaped read for this service's own jobs: direct, then the seat through the hop. */
  async function read(use, pathWithQuery) {
    const d = await directSeatShape(use, pathWithQuery);
    if (d) return d;
    const p = String(pathWithQuery).split("?")[0];
    const tk = tokenForSeatPath(p);
    const hop = getHop();
    if (hop && typeof hop.read === "function") {
      const r = await hop.read(pathWithQuery);
      mark(use, tk, r && r.status === 200 ? "seat" : "failed", r ? r.status : null);
      if (r && r.status === 200) return { status: 200, body: r.body, servedBy: "seat" };
      if (p !== "/invoices") return { status: r ? r.status : 503, body: r ? r.body : JSON.stringify({ error: "seat_offline" }), servedBy: "none" };
    }
    if (p === "/invoices") {
      // Last resort, as before this ship: the AR listing down MERCURY_API_BASE.
      const t = await arRequest(use, "GET", "/ar/invoices");
      if (t.status === 200) {
        let body;
        try { body = JSON.parse(t.text); } catch { body = null; }
        if (body) return { status: 200, body: JSON.stringify(minimalInvoices(body)), servedBy: t.servedBy };
      }
      return { status: t.status === 200 ? 502 : t.status, body: t.text, servedBy: "none" };
    }
    mark(use, tk, "failed", 503);
    return { status: 503, body: JSON.stringify({ error: "seat_offline" }), servedBy: "none" };
  }

  /**
   * The AR invoice listing for the paid-invoice sync and the watch: throws on anything but a
   * clean, complete answer (a refused or partial read is an error, never "nothing paid").
   */
  async function listArInvoices(use) {
    const r = await read(use, "/invoices");
    if (!r || r.status !== 200) throw new Error(`mercury_${r ? r.servedBy : "none"}_${r ? r.status : "no_answer"}`);
    let body;
    try { body = JSON.parse(r.body); } catch { throw new Error("invoices_invalid"); }
    if (!body || !Array.isArray(body.invoices) || body.complete !== true) throw new Error("invoices_incomplete");
    const seen = new Set();
    for (const inv of body.invoices) {
      if (!inv || typeof inv.id !== "string" || !inv.id || seen.has(inv.id)) throw new Error("invoices_bad_invoice");
      seen.add(inv.id);
    }
    return body.invoices;
  }

  /** Keep each token's direct verdict current: a cheap GET whose body is dropped unread. */
  async function probe(tokenKey, { force = false } = {}) {
    const path = tokenKey === TOKEN_FULL ? "/accounts" : "/ar/invoices";
    const d = await tryDirect(tokenKey, "GET", path, { force });
    return d.status ? { direct: "ok", status: d.status } : { direct: tokens[tokenKey].direct, reason: d.blocked ? "blocked" : (d.skipped || d.failed) };
  }

  async function probeStale(maxAgeMs = 5 * 60 * 1000) {
    const out = {};
    for (const k of [TOKEN_AR, TOKEN_FULL]) {
      const st = tokens[k];
      if (!st.last_try_at || now() - Date.parse(st.last_try_at) >= maxAgeMs) out[k] = await probe(k, { force: true });
    }
    return out;
  }

  function verdict(st) {
    if (st.direct === "ok") return "direct ok";
    if (st.direct === "blocked") return "blocked by allowlist - fallback in use";
    if (st.direct === "no_token") return "no token on this service - fallback in use";
    if (st.direct === "error") return "direct failing - fallback in use";
    return "not tried yet";
  }

  function health() {
    const t = {};
    for (const k of [TOKEN_AR, TOKEN_FULL]) {
      const st = tokens[k];
      t[k] = {
        present: tokenLength(k) > 0,
        length: tokenLength(k),
        direct: st.direct,
        verdict: verdict(st),
        fallback: k === TOKEN_AR ? (tunnelRoot() ? "money seat (reads) / MERCURY_API_BASE (AR)" : "money seat (reads)") : "money seat via hop",
        fallback_in_use: st.direct !== "ok",
        blocked_ip: st.blocked_ip,
        last_try_at: st.last_try_at,
        last_ok_at: st.last_ok_at,
        last_blocked_at: st.last_blocked_at,
        last_error: st.last_error,
        calls: { ...st.calls },
      };
    }
    const blocked = Object.keys(t).filter((k) => t[k].direct === "blocked");
    const pc = payCaps();
    return {
      build: MERCURY_GATEWAY_BUILD,
      pay: { on: pc.on, max_cents: pc.maxCents, day_cents: pc.dayCents, account_last4: PAY_CHECKING.last4,
        recipients: pc.recipients, mode: pc.mode,
        path: pc.mode === "direct" ? "ACH payees: direct send after the desk's 60 s undo; wires: request-send-money (approval in Mercury)" : "request-send-money only (approval in Mercury)" },
      direct_root: MERCURY_DIRECT_ROOT,
      tunnel_configured: Boolean(tunnelRoot()),
      tokens: t,
      uses: JSON.parse(JSON.stringify(uses)),
      blocker: blocked.length
        ? `Mercury answers 401 ipNotWhitelisted for ${blocked.join(" and ")}: the three static egress IPs (canon s.3) must be on each token's allowlist`
        : null,
    };
  }

  function lastServed(use) {
    return uses[use] ? uses[use].served_by : null;
  }

  // ── F7: the pay path (see the header above checkPayOperation) ──────────────
  function payCaps() {
    const n = (v, d) => (/^\d{1,10}$/.test(String(v ?? "").trim()) ? Number(String(v).trim()) : d);
    return {
      on: String(env.MONEY_PAY || "").trim().toLowerCase() === "on",
      maxCents: n(env.MONEY_PAY_MAX_CENTS, PAY_MAX_CENTS_DEFAULT),
      dayCents: n(env.MONEY_PAY_DAY_CENTS, PAY_DAY_CENTS_DEFAULT),
      // Mr. AJ: both default OFF; either can be taken back by one Railway variable.
      recipients: String(env.MONEY_PAY_RECIPIENTS || "").trim().toLowerCase() === "on",
      mode: String(env.MONEY_PAY_MODE || "").trim().toLowerCase() === "direct" ? "direct" : "approval",
    };
  }
  function fpKey() { return String(env.OCR_TICKET_SECRET || "").trim(); }
  function payeeOpts() { return { persons: payCaps().recipients, fpKey: fpKey() }; }

  /** One pay-shaped call, direct only. {status, body} or {refused} / {unknown} / {unreachable}. */
  async function payCall(use, method, path, bodyObj) {
    const chk = checkPayOperation(method, path);
    if (!chk.ok) {
      tokens[TOKEN_FULL].calls.refused++;
      uses[use] = { token: TOKEN_FULL, served_by: "refused", status: chk.status, at: iso(now()) };
      return { refused: chk };
    }
    const d = await tryDirect(TOKEN_FULL, method, path, { body: bodyObj == null ? undefined : JSON.stringify(bodyObj), force: method !== "GET" });
    if (!d.status && /^http_40[13]$/.test(String(d.failed || ""))) {
      // Mercury said no with authority (scope, auth): nothing was created.
      mark(use, TOKEN_FULL, "direct", Number(d.failed.slice(5)));
      let said = null;
      try { said = d.words ? JSON.parse(d.words) : null; } catch { said = d.words ? { message: d.words } : null; }
      return { status: Number(d.failed.slice(5)), body: { error: tokens[TOKEN_FULL].last_error, mercury: said } };
    }
    if (!d.status) {
      mark(use, TOKEN_FULL, "failed", null);
      // A POST that may have reached Mercury: the caller must say "check Mercury", never "failed".
      if (method !== "GET" && !(d.blocked || d.skipped)) return { unknown: d.failed || "unknown" };
      return { unreachable: d.blocked ? "blocked" : (d.skipped || d.failed) };
    }
    mark(use, TOKEN_FULL, "direct", d.status);
    let body;
    try { body = d.text ? JSON.parse(d.text) : {}; } catch { body = { raw: String(d.text).slice(0, 300) }; }
    return { status: d.status, body };
  }

  function mercuryWords(body) {
    const b = body || {};
    const m = b.message || b.error || b.errors || "";
    return scrubDigits((typeof m === "string" ? m : JSON.stringify(m)).slice(0, 300));
  }

  /** Every recipient, each with its verdict. Throws on anything but a clean list. */
  async function payRecipientsAll() {
    const r = await payCall("pay/recipients", "GET", "/recipients?limit=1000");
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.recipients)) {
      const e = new Error("recipients_unavailable");
      e.detail = r.status ? `mercury_${r.status}` : (r.unreachable || "refused");
      throw e;
    }
    const po = payeeOpts();
    return r.body.recipients.map((x) => ({ raw: x, verdict: payeeVerdict(x, po), view: payeeView(x, po) }));
  }

  async function payRecipient(id) {
    if (!UUID_RE.test(String(id || ""))) return { ok: false, why: "bad_id" };
    const r = await payCall("pay/recipient", "GET", `/recipient/${id}`);
    if (r.status === 404) return { ok: false, why: "not_found" };
    if (r.status !== 200 || !r.body || !r.body.id) return { ok: false, why: "unavailable" };
    const po = payeeOpts();
    const v = payeeVerdict(r.body, po);
    return v.ok ? { ok: true, raw: r.body, method: v.method, view: payeeView(r.body, po) } : { ok: false, why: v.why, view: payeeView(r.body, po) };
  }

  /** Nesher checking's approval requests from the last 24 hours (all states). */
  async function payRequestsSince(sinceMs) {
    const out = [];
    let after = "";
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ accountId: PAY_CHECKING.id, limit: "1000" });
      if (after) q.set("start_after", after);
      const r = await payCall("pay/requests", "GET", `/request-send-money?${q.toString()}`);
      if (r.status !== 200 || !r.body || !Array.isArray(r.body.requests)) {
        const e = new Error("requests_unavailable");
        e.detail = r.status ? `mercury_${r.status}` : (r.unreachable || "refused");
        throw e;
      }
      for (const x of r.body.requests) {
        if (x && x.accountId === PAY_CHECKING.id && Date.parse(x.createdAt || "") >= sinceMs) out.push(x);
      }
      const next = r.body.page && (r.body.page.nextPage || r.body.page.startAfter || r.body.page.nextCursor);
      if (!next || !r.body.requests.length) break;
      after = typeof next === "string" ? next : r.body.requests[r.body.requests.length - 1].requestId;
    }
    return out;
  }

  /**
   * Queue ONE payment for approval in Mercury. Everything is checked here again, whatever the desk
   * already checked: the switch, Nesher checking by id AND last four, the payee's hard lines, the
   * amount, the day, and the 24-hour duplicate rule (same payee, amount and memo).
   */
  async function requestPay(o = {}) {
    const caps = payCaps();
    if (!caps.on) return { status: 404, body: { ok: false, error: "money_pay_off" } };
    const cents = o.amountCents;
    if (!Number.isInteger(cents) || cents < PAY_MIN_CENTS) return { status: 400, body: { ok: false, error: "amount_invalid" } };
    if (cents > caps.maxCents) return { status: 400, body: { ok: false, error: "over_cap", cap_cents: caps.maxCents } };
    const memo = String(o.memo || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 140);
    if (!memo) return { status: 400, body: { ok: false, error: "memo_required" } };
    const key = String(o.idempotencyKey || "").trim();
    if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key)) return { status: 400, body: { ok: false, error: "idempotency_key_invalid" } };
    // Nesher checking must still be what we think it is (id AND last four), or nothing is named.
    let accounts;
    try { accounts = await accountsDirect(); } catch (e) {
      return { status: 503, body: { ok: false, error: e instanceof Fallback ? "mercury_unreachable" : "checking_not_verified" } };
    }
    if (!accounts.some((a) => a.id === PAY_CHECKING.id && a.last4 === PAY_CHECKING.last4)) {
      return { status: 503, body: { ok: false, error: "checking_not_verified" } };
    }
    const payee = await payRecipient(o.recipientId);
    if (!payee.ok) {
      const code = payee.why === "unavailable" ? 503 : payee.why === "not_found" || payee.why === "bad_id" ? 404 : 403;
      return { status: code, body: { ok: false, error: `payee_${payee.why}` } };
    }
    let recent;
    try { recent = await payRequestsSince(now() - 24 * 3600 * 1000); } catch {
      return { status: 503, body: { ok: false, error: "requests_unavailable" } };
    }
    const live = recent.filter((x) => PAY_LIVE_STATES.includes(x.status));
    const dup = live.find((x) => x.recipientId === payee.raw.id && Math.round(Number(x.amount) * 100) === cents && memoMatches(x.memo, memo));
    if (dup) return { status: 409, body: { ok: false, error: "duplicate_24h", existing: payRequestView(dup) } };
    const dayUsed = live.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0);
    if (dayUsed + cents > caps.dayCents) return { status: 400, body: { ok: false, error: "over_day_cap", day_cap_cents: caps.dayCents, day_used_cents: dayUsed } };
    const body = {
      recipientId: payee.raw.id,
      amount: Number((cents / 100).toFixed(2)),
      paymentMethod: payee.method,
      idempotencyKey: key,
      externalMemo: externalMemoOf(memo, payee.view && payee.view.person ? "Refund" : ""),
      // The note BEGINS with the memo, so whichever of the two Mercury echoes as `memo`, the 24 h rule
      // and the paid-read still find it; the rest names the tile and the rep.
      note: (memo + NOTE_MARK + String(o.note || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, 240),
    };
    if (payee.method === "domesticWire" || payee.method === "internationalWire") {
      body.purpose = { simple: { category: "vendor", additionalInfo: String(payee.raw.name || "supplier").slice(0, 100) } };
    }
    // The desk gave up waiting (its request closed): stop here, before anything reaches Mercury (C3).
    if (typeof o.isGone === "function" && o.isGone()) return { status: 499, body: { ok: false, error: "client_gone_nothing_sent" } };
    const r = await payCall("pay/request", "POST", `/account/${PAY_CHECKING.id}/request-send-money`, body);
    if (r.refused) return { status: r.refused.status, body: { ok: false, error: r.refused.error } };
    if (r.unknown) return { status: 503, body: { ok: false, error: "outcome_unknown", payee: payee.view } };
    if (r.unreachable) return { status: 503, body: { ok: false, error: "mercury_unreachable", payee: payee.view } };
    if (r.status >= 200 && r.status < 300 && r.body && r.body.requestId) {
      return { status: 200, body: { ok: true, request: payRequestView(r.body), payee: payee.view } };
    }
    // A 2xx without a request id most likely DID create the request: never "refused" (Gabbai r2 C1).
    if (r.status >= 200 && r.status < 300) return { status: 503, body: { ok: false, error: "outcome_unknown", payee: payee.view } };
    return { status: 502, body: { ok: false, error: "mercury_refused", mercury_status: r.status, mercury: mercuryWords(r.body), payee: payee.view } };
  }

  // ── Mr. AJ Money ─────────────────────────────────────────────────────────────
  /**
   * ADD A RECIPIENT (moves no money). The draft is recipientDraft()'s; the numbers in it are never
   * logged or returned. A recipient with the same bank details already in Mercury is REUSED, never
   * duplicated - which is also what makes a retry after an unclear answer safe (Mercury's create has
   * no idempotency key). A recipient with the same NAME and other bank details is named back so the
   * desk can show both; it is created only when the desk says so (o.allowSameName).
   */
  async function addRecipient(draft, o = {}) {
    const caps = payCaps();
    if (!caps.on || !caps.recipients) return { status: 404, body: { ok: false, error: "recipients_off" } };
    if (!draft || !draft.ok || !draft.body) return { status: 400, body: { ok: false, error: "draft_invalid" } };
    const po = payeeOpts();
    if (!po.fpKey) return { status: 503, body: { ok: false, error: "not_configured" } };
    const fp = payeeFingerprint(draft.body, po.fpKey);
    let all;
    try { all = await payRecipientsAll(); } catch (e) {
      return { status: 503, body: { ok: false, error: "recipients_unavailable" } };
    }
    const live = all.filter((x) => !x.raw.status || x.raw.status === "active");
    const same = live.find((x) => x.view.fp === fp);
    if (same) {
      if (!same.verdict.ok) return { status: 403, body: { ok: false, error: `payee_${same.verdict.why}`, recipient: same.view } };
      return { status: 200, body: { ok: true, reused: true, recipient: same.view } };
    }
    const key = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const twins = live.filter((x) => key(x.view.name) === key(draft.body.name)).map((x) => x.view).slice(0, 3);
    if (twins.length && o.allowSameName !== true) return { status: 409, body: { ok: false, error: "same_name_other_bank", twins } };
    if (typeof o.isGone === "function" && o.isGone()) return { status: 499, body: { ok: false, error: "client_gone_nothing_sent" } };
    const r = await payCall("pay/recipient-add", "POST", "/recipients", draft.body);
    if (r.refused) return { status: r.refused.status, body: { ok: false, error: r.refused.error } };
    if (r.unknown) return { status: 503, body: { ok: false, error: "outcome_unknown" } };
    if (r.unreachable) return { status: 503, body: { ok: false, error: "mercury_unreachable" } };
    if (r.status === 401 || r.status === 403) {
      // The token may not add recipients (scope). Nothing was created. This is a NEED, said as such.
      return { status: 502, body: { ok: false, error: "token_scope_refused", mercury_status: r.status, mercury: mercuryWords(r.body && r.body.mercury) } };
    }
    if (r.status >= 200 && r.status < 300 && r.body && UUID_RE.test(String(r.body.id || ""))) {
      const v = payeeVerdict(r.body, po);
      return { status: 200, body: { ok: true, reused: false, recipient: payeeView(r.body, po), payable: v.ok, why: v.ok ? null : v.why } };
    }
    if (r.status >= 200 && r.status < 300) return { status: 503, body: { ok: false, error: "outcome_unknown" } };
    return { status: 502, body: { ok: false, error: "mercury_refused", mercury_status: r.status, mercury: mercuryWords(r.body) } };
  }

  /** Outgoing money from Nesher checking in the last 24 h: every row, and the ones the desk chat sent. */
  async function outgoingSince(sinceMs) {
    const start = isoDate(addDays(new Date(sinceMs), -1));
    const end = isoDate(addDays(new Date(now()), 1));
    const rows = await accountTransactionsDirect(PAY_CHECKING.id, { start, end, limit: 500 });
    return rows.filter((t) => t && Number(t.amount) < 0 && Date.parse(t.createdAt || "") >= sinceMs
      && !["failed", "cancelled", "reversed"].includes(String(t.status || "")));
  }

  /** A sent payment, as the desk may see it (never an account number). */
  function payTxnView(t) {
    if (!t || typeof t !== "object") return null;
    return { id: t.id, status: t.status, amount: Math.abs(Number(t.amount)), recipientId: t.counterpartyId || null, createdAt: t.createdAt || null, postedAt: t.postedAt || null, estimatedDeliveryDate: t.estimatedDeliveryDate || null, dashboardLink: t.dashboardLink || null, reasonForFailure: t.reasonForFailure || null };
  }

  /**
   * PAY. MONEY_PAY_MODE=direct and an ACH payee -> POST /account/{checking}/transactions (no approver;
   * Joseph 24 Sep "No need to wait for approvels"). Anything else -> requestPay (approval, F7).
   * Checked here whatever the desk checked: the switch, Nesher checking by id AND last four, the
   * payee's hard lines, the bank-details fingerprint the desk approved, the amount, the 24 h total of
   * everything the chat sent, and the 24 h same-payee-same-amount rule (a warning the desk turns into
   * a second tap: o.allowDup).
   */
  async function sendPay(o = {}) {
    const caps = payCaps();
    if (!caps.on) return { status: 404, body: { ok: false, error: "money_pay_off" } };
    const cents = o.amountCents;
    if (!Number.isInteger(cents) || cents < PAY_MIN_CENTS) return { status: 400, body: { ok: false, error: "amount_invalid" } };
    if (cents > caps.maxCents) return { status: 400, body: { ok: false, error: "over_cap", cap_cents: caps.maxCents } };
    const memo = String(o.memo || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 140);
    if (!memo) return { status: 400, body: { ok: false, error: "memo_required" } };
    const key = String(o.idempotencyKey || "").trim();
    if (!/^[A-Za-z0-9._:-]{8,80}$/.test(key)) return { status: 400, body: { ok: false, error: "idempotency_key_invalid" } };
    let accounts;
    try { accounts = await accountsDirect(); } catch (e) {
      return { status: 503, body: { ok: false, error: e instanceof Fallback ? "mercury_unreachable" : "checking_not_verified" } };
    }
    if (!accounts.some((a) => a.id === PAY_CHECKING.id && a.last4 === PAY_CHECKING.last4)) {
      return { status: 503, body: { ok: false, error: "checking_not_verified" } };
    }
    const payee = await payRecipient(o.recipientId);
    if (!payee.ok) {
      const code = payee.why === "unavailable" ? 503 : payee.why === "not_found" || payee.why === "bad_id" ? 404 : 403;
      return { status: code, body: { ok: false, error: `payee_${payee.why}` } };
    }
    // The bank details the desk showed are the bank details that get paid - or nothing moves.
    if (!payee.view.fp || String(o.fp || "") !== payee.view.fp) return { status: 409, body: { ok: false, error: "payee_changed", payee: payee.view } };
    if (!(caps.mode === "direct" && payee.method === "ach")) return requestPay(o);
    const dayCap = Number.isInteger(o.dayCapCents) && o.dayCapCents > 0 ? Math.min(o.dayCapCents, caps.dayCents) : caps.dayCents;
    const since = now() - 24 * 3600 * 1000;
    let out, recent;
    try { out = await outgoingSince(since); recent = await payRequestsSince(since); } catch {
      return { status: 503, body: { ok: false, error: "requests_unavailable" } };
    }
    const live = recent.filter((x) => PAY_LIVE_STATES.includes(x.status));
    if (o.allowDup !== true) {
      const dupT = out.find((t) => t.counterpartyId === payee.raw.id && Math.round(Number(t.amount) * 100) === -cents);
      const dupR = live.find((x) => x.recipientId === payee.raw.id && Math.round(Number(x.amount) * 100) === cents);
      if (dupT || dupR) {
        // A retry of the SAME desk tile (it lost the first answer and tried again) is ITSELF, not a
        // duplicate: our own note carries the tile id right after NOTE_MARK, and Mercury hands it
        // straight back on the read. A different tile at the same payee and amount is still refused.
        const myTile = noteTileId(o.note);
        if (dupT && myTile && noteTileId(dupT.note) === myTile) {
          return { status: 200, body: { ok: true, mode: "direct", txn: payTxnView(dupT), payee: payee.view, reused: true } };
        }
        return { status: 409, body: { ok: false, error: "duplicate_24h", existing: dupT ? payTxnView(dupT) : payRequestView(dupR) } };
      }
    }
    const chatSent = out.filter((t) => String(t.note || "").includes(NOTE_MARK)).reduce((s, t) => s + Math.round(-Number(t.amount) * 100), 0);
    const dayUsed = chatSent + live.reduce((s, x) => s + Math.round(Number(x.amount) * 100), 0);
    if (dayUsed + cents > dayCap) return { status: 400, body: { ok: false, error: "over_day_cap", day_cap_cents: dayCap, day_used_cents: dayUsed } };
    const body = {
      recipientId: payee.raw.id,
      amount: Number((cents / 100).toFixed(2)),
      paymentMethod: "ach",
      idempotencyKey: key,
      externalMemo: externalMemoOf(memo, payee.view && payee.view.person ? "Refund" : ""),
      note: (memo + NOTE_MARK + String(o.note || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, 240),
    };
    if (typeof o.isGone === "function" && o.isGone()) return { status: 499, body: { ok: false, error: "client_gone_nothing_sent" } };
    const r = await payCall("pay/send", "POST", `/account/${PAY_CHECKING.id}/transactions`, body);
    if (r.refused) return { status: r.refused.status, body: { ok: false, error: r.refused.error } };
    if (r.unknown) return { status: 503, body: { ok: false, error: "outcome_unknown", payee: payee.view } };
    if (r.unreachable) return { status: 503, body: { ok: false, error: "mercury_unreachable", payee: payee.view } };
    if (r.status === 401 || r.status === 403) return { status: 502, body: { ok: false, error: "token_scope_refused", mercury_status: r.status, mercury: mercuryWords(r.body && r.body.mercury), payee: payee.view } };
    const b = r.body || {};
    if (r.status >= 200 && r.status < 300) {
      // Mercury's own approval rules may still hold an API send: that is an approval request, said so.
      if (b.requestId || b.status === "pendingApproval") return { status: 200, body: { ok: true, mode: "approval_forced", request: payRequestView(b), payee: payee.view } };
      if (UUID_RE.test(String(b.id || "")) && (b.status === "pending" || b.status === "sent")) return { status: 200, body: { ok: true, mode: "direct", txn: payTxnView(b), payee: payee.view } };
      if (UUID_RE.test(String(b.id || "")) && b.status === "blocked") return { status: 200, body: { ok: true, mode: "direct", txn: payTxnView(b), payee: payee.view, blocked: true } };
      return { status: 503, body: { ok: false, error: "outcome_unknown", payee: payee.view } };
    }
    return { status: 502, body: { ok: false, error: "mercury_refused", mercury_status: r.status, mercury: mercuryWords(b), payee: payee.view } };
  }

  /** One payment of Nesher checking, by id: pending / sent / failed / cancelled / reversed / blocked. */
  async function payTxnStatus(txnId) {
    if (!UUID_RE.test(String(txnId || ""))) return { status: 400, body: { ok: false, error: "bad_id" } };
    const r = await payCall("pay/txn", "GET", `/account/${PAY_CHECKING.id}/transaction/${txnId}`);
    if (r.status === 404) return { status: 404, body: { ok: false, error: "not_found" } };
    if (r.status !== 200 || !r.body || !r.body.id) return { status: 503, body: { ok: false, error: "mercury_unreachable" } };
    const t = payTxnView(r.body);
    // Mr. AO: `reversed` = the receiving bank sent it back - said as returned, never lumped with failed.
    const state = t.status === "sent" ? "paid" : t.status === "pending" ? "sending" : t.status === "reversed" ? "returned" : (t.status === "failed" || t.status === "blocked") ? "failed" : t.status === "cancelled" ? "cancelled" : "sending";
    return { status: 200, body: { ok: true, state, txn: t } };
  }

  /** One approval request, Nesher checking only; once approved, the payment's own state. */
  async function payStatus(requestId) {
    if (!UUID_RE.test(String(requestId || ""))) return { status: 400, body: { ok: false, error: "bad_id" } };
    const r = await payCall("pay/status", "GET", `/request-send-money/${requestId}`);
    if (r.status === 404) return { status: 404, body: { ok: false, error: "not_found" } };
    if (r.status !== 200 || !r.body || !r.body.requestId) return { status: 503, body: { ok: false, error: "mercury_unreachable" } };
    if (r.body.accountId !== PAY_CHECKING.id) return { status: 403, body: { ok: false, error: "account_not_nesher" } };
    const q = payRequestView(r.body);
    let state = q.status === "pendingApproval" ? "waiting" : q.status;
    let txn = null;
    if (q.status === "approved") {
      state = "approved";
      try {
        const start = isoDate(addDays(new Date(Date.parse(q.createdAt || iso(now()))), -1));
        const end = isoDate(addDays(new Date(now()), 1));
        const rows = await accountTransactionsDirect(PAY_CHECKING.id, { start, end, limit: 500 });
        const cents = Math.round(q.amount * 100);
        const hit = rows.find((t) => Math.round(Number(t.amount) * 100) === -cents && (!q.memo || memoMatches(t.externalMemo, memoBase(q.memo)) || memoKey(t.externalMemo) === memoKey(q.memo)));
        if (hit) {
          txn = { id: hit.id, status: hit.status, postedAt: hit.postedAt || null, dashboardLink: hit.dashboardLink || null };
          if (hit.status === "sent") state = "paid";
          else if (hit.status === "reversed") state = "returned";
          else if (hit.status === "failed" || hit.status === "cancelled") state = "failed";
          else state = "sending";
        }
      } catch { /* the approval stands; the payment's own state is read next time */ }
    }
    return { status: 200, body: { ok: true, state, request: q, txn } };
  }

  return { arRequest, arFetch, hopDirect, read, listArInvoices, probe, probeStale, health, lastServed, allowedAccountIds,
    payCaps, payRecipientsAll, payRecipient, payRequestsSince, requestPay, payStatus,
    addRecipient, sendPay, payTxnStatus, payeeFingerprintOf: (r) => payeeFingerprint(r, fpKey()) };
}
