/**
 * Server-to-server money doors for the desk chat's card tile (Mr Money plan
 * Phase 1.3; scope added mid-run by the coordinator on 23 Sep 2026):
 *
 *   POST /__nesher_pay/charge {token_ref, amount_cents, currency, brand, rep, customer_name, cvv?, invoice_ref?, note?, address1?, city?, state?, zip?, country?}
 *   POST /__nesher_pay/void   {txn_id}
 *   POST /__nesher_pay/refund {txn_id, amount_cents, rep}
 *   POST /__nesher_pay/sale   {rep, q}   READ ONLY: a past sale, looked up at the processor (24 Sep)
 *
 * Refund and void (24 Sep, Joseph: "connect with my processor and make refunds"): ANY sale on our
 * processor in the last 180 days, not only a sale the chat charged. Before the gateway is asked the
 * door reads the sale from the processor itself (settled or not, how much already went back), holds
 * the amount to what is left, to REFUND_CAP_CENTS and to REFUND_DAY_CAP_CENTS, and afterwards
 * records the reversal in the CRM as its own negative row through the collection loop's ledger.
 *
 * Every door takes the same one-time ticket as the OCR upload (ocr-card.js
 * mintTicket / verifyTicket) with its own kind, five-minute TTL, single use,
 * bound to the rep id AND to the reference it may touch: a "charge" ticket is
 * bound to the token_ref it may spend, a "void" / "refund" ticket to the
 * txn_id. A ticket for one card can never charge another card.
 *
 * Charges go through the existing chargeWithToken seam with processorIdFor
 * (JRM -> mav2083, Nesher -> mav7067), never payment_descriptor. AVS fields
 * ride along when present. Refunds are capped server side by REFUND_CAP_CENTS,
 * which defaults to 0 (refuses) when absent.
 *
 * Spending a hold (23 Sep 2026): the token_ref is redeemed ONCE - removed
 * from the store before anything else is checked - and the rep on the hold
 * must be the rep on the ticket. The number lives just long enough to go into
 * the gateway body and is zeroed in a finally on every path, including the
 * decline path and the throw path.
 *
 * CVV (13.4, and Joseph's design item 2). The security code is NEVER read
 * from the photo and is NEVER held. The rep types it at charge time; it
 * arrives in this one request, goes straight into this one gateway call, and
 * is gone. Optional, because some cards reach a rep without one - but then
 * the sale is card-not-present with no CVV protection and worse interchange,
 * so the answer carries `cvv_sent` either way and the tile and the ledger
 * show it. The code itself is never stored, never logged, never echoed.
 *
 * Disabled (404) together with the OCR route when OCR_TICKET_SECRET is unset.
 * Nothing here is reachable from a browser (no CORS); the desk chat's server
 * calls it. No PAN and no card reference in any log line.
 */

import {
  BRANDS,
  NMI_HOST,
  chargeWithToken,
  refundPayment,
  voidPayment,
} from "./nmi-card.js";
import { queryNmiRange, NMI_PROCESSOR_BRAND } from "./nmi-recovery.js";
import { parseNmiTransactions, classifyTransaction } from "./money-map.js";
import { parseInvoiceNumber } from "./payments-sync.js";
import {
  bindHashOf,
  consumeTicket,
  ocrSecret,
  purge,
  readLimitedBody,
  redeemCardHold,
  reholdAfterDecline,
  sendTicketJson,
  ticketFromHeaders,
  verifyTicket,
  zeroHold,
} from "./ocr-card.js";

export const CHARGE_PATH = "/__nesher_pay/charge";
export const VOID_PATH = "/__nesher_pay/void";
export const REFUND_PATH = "/__nesher_pay/refund";
export const CHARGE_BODY_MAX = 64 * 1024;
/** Mirrors OPEN_PAY_MAX_USD: no single card charge above $25,000 from this door. */
export const CHARGE_MAX_CENTS = 25000 * 100;
/** Mr. AU (audit C2): the chat charge's own gateway limit. The desk waits 45 s; this door answers well inside it. */
export const CHARGE_SALE_TIMEOUT_MS = 15000;
/** Mr. AU (audit H3): the booking as the order id, per brand, in the collection loop's own shapes. */
const INVOICE_REF_RE = { nesher: /^RES-[A-Z0-9][A-Z0-9_-]{2,20}$/, jrm: /^JRM-1\d{1,9}(?:-O\d{1,9})?$/ };
export const REFUND_CAP_NAME = "REFUND_CAP_CENTS";

const CARD_REF_RE = /^cr_[A-Za-z0-9_-]{16,64}$/;
const TXN_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
/** 3 digits, or 4 for Amex. Never stored, never logged, never echoed. */
const CVV_RE = /^\d{3,4}$/;

export function chargeFamilyPath(pathname) {
  const p = String(pathname || "").split("?")[0].replace(/\/+$/, "");
  if (p === CHARGE_PATH) return "charge";
  if (p === VOID_PATH) return "void";
  if (p === REFUND_PATH) return "refund";
  if (p === SALE_PATH) return "sale";
  return null;
}

/** Absent, empty, non-numeric or negative -> 0 -> every refund is refused. */
export function refundCapCents(env = process.env) {
  const raw = String(env[REFUND_CAP_NAME] ?? "").trim();
  if (!/^\d{1,9}$/.test(raw)) return 0;
  return Number(raw);
}

/**
 * A DAY CAP beside the per-refund cap (24 Sep): the most that may go back to cards through these
 * doors in any 24 hours, refunds and voids together, counted from the PROCESSOR's own record (so a
 * restart cannot reset it, and a refund done in the gateway portal counts too). Absent, empty or
 * bad = the per-refund cap, i.e. one refund's worth a day - never "unlimited".
 */
export const REFUND_DAY_CAP_NAME = "REFUND_DAY_CAP_CENTS";
export function refundDayCapCents(env = process.env) {
  const raw = String(env[REFUND_DAY_CAP_NAME] ?? "").trim();
  if (!/^\d{1,9}$/.test(raw)) return refundCapCents(env);
  return Number(raw);
}

// ── A PAST SALE, READ FROM THE PROCESSOR (24 Sep, Joseph: "refund any past sale") ──────────────
// READ ONLY: the Classic query.php, the same read the money map and the recovery sweep make, with
// the key in the POST body only. The window is the last 180 days (the processor's own refund
// window); a sale older than that is refunded in the gateway portal.
export const SALE_PATH = "/__nesher_pay/sale";
export const SALE_WINDOW_DAYS = 180;
const DAY_MS = 86400000;
const SALE_CACHE_MS = 20000;
let saleCache = { at: 0, xml: null, key: "" };

function mdfText(block, tagName) {
  const m = block.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`));
  return m ? m[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim() : "";
}
/**
 * The two facts the money map's parser does not read: the masked card's last four, and whether the
 * name on the sale contains the words the rep typed. The name is read here, compared, and dropped -
 * it is never returned, stored or logged; the answer carries only a yes/no per transaction.
 */
export function saleExtras(xml, nameNeedle = "") {
  const out = new Map();
  const needle = String(nameNeedle || "").toLowerCase().replace(/[^\p{L}\s'-]/gu, " ").replace(/\s+/g, " ").trim();
  const blocks = String(xml || "").split("<transaction>").slice(1).map((b) => b.split("</transaction>")[0]);
  for (const b of blocks) {
    const head = b.split("<action>")[0];
    const id = mdfText(head, "transaction_id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
    const cc = mdfText(head, "cc_number").replace(/[\s-]/g, "");
    const m = cc.match(/^\d{0,6}[Xx*•]{4,}(\d{4})$/);
    let nameHit = false;
    if (needle) {
      const hay = ` ${[mdfText(head, "first_name"), mdfText(head, "last_name"), mdfText(head, "company")].join(" ").toLowerCase()} `;
      nameHit = needle.split(" ").every((w) => w.length >= 2 && hay.includes(w));
    }
    out.set(id, { last4: m ? m[1] : null, nameHit });
  }
  return out;
}

function saleBooking(orderId) {
  const p = parseInvoiceNumber(orderId);
  if (!p) return null;
  return p.kind === "hotel" ? `JRM-1${p.requestId}${p.offerId ? `-O${p.offerId}` : ""}` : `RES-${p.code}`;
}
function cleanRefText(v) {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

/**
 * Every sale in the query answer, with what has already gone back on it. A refund in this gateway
 * is its OWN transaction pointing at the sale (original_transaction_id); a refund action on the sale
 * itself is counted too. `action` is what the chat may offer: "refund" (settled, money left),
 * "void" (not settled yet - the processor refuses a refund until the batch settles, so the whole
 * sale is voided instead), or "none" with a reason.
 */
export function salesFromXml(xml, { nameNeedle = "", nowMs = Date.now() } = {}) {
  const txns = parseNmiTransactions(xml);
  const extras = saleExtras(xml, nameNeedle);
  const back = new Map();
  const lastBack = new Map();
  const noteBack = (id, at, cents) => { const p = lastBack.get(id); if (at != null && (!p || at > p.at)) lastBack.set(id, { at, cents }); };
  let dayBackCents = 0;
  for (const t of txns) {
    const c = classifyTransaction(t);
    for (const a of t.actions) {
      if (!a.success) continue;
      if ((a.type === "refund" || a.type === "credit") && a.at != null && nowMs - a.at < DAY_MS) dayBackCents += Math.round(Math.abs(a.amount) * 100);
    }
    if (c.voided && c.kind === "sale" && c.voidAt != null && nowMs - c.voidAt < DAY_MS) dayBackCents += Math.round(c.amount * 100);
    if (c.kind === "refund" && t.originalId) { back.set(t.originalId, (back.get(t.originalId) || 0) + Math.round(c.amount * 100)); noteBack(t.originalId, c.at, Math.round(c.amount * 100)); }
    if (c.kind === "sale") {
      const ownActs = t.actions.filter((a) => a.success && (a.type === "refund" || a.type === "credit"));
      const own = ownActs.reduce((s, a) => s + Math.round(Math.abs(a.amount) * 100), 0);
      if (own) back.set(t.id, (back.get(t.id) || 0) + own);
      for (const a of ownActs) noteBack(t.id, a.at, Math.round(Math.abs(a.amount) * 100));
    }
  }
  const sales = [];
  for (const t of txns) {
    const c = classifyTransaction(t);
    if (c.kind !== "sale") continue;
    const amountCents = Math.round(c.amount * 100);
    const refundedCents = Math.min(amountCents, back.get(t.id) || 0);
    const settled = t.condition === "complete";
    const pending = t.condition === "pendingsettlement" || t.condition === "pending";
    let action = "none";
    let why = null;
    if (c.voided || t.condition === "canceled") why = "voided";
    else if (settled && amountCents - refundedCents > 0) action = "refund";
    else if (settled) why = "fully_refunded";
    else if (pending && refundedCents === 0) action = "void";
    else why = `condition_${t.condition || "unknown"}`;
    const ex = extras.get(t.id) || { last4: null, nameHit: false };
    sales.push({
      txn_id: t.id,
      merchant: NMI_PROCESSOR_BRAND[t.processorId] || null,
      processor_id: t.processorId || null,
      at: c.at != null ? new Date(c.at).toISOString() : null,
      at_ms: c.at,
      amount_cents: amountCents,
      refunded_cents: refundedCents,
      last_back_at: lastBack.get(t.id) ? new Date(lastBack.get(t.id).at).toISOString() : null,
      last_back_cents: lastBack.get(t.id) ? lastBack.get(t.id).cents : 0,
      refundable_cents: action === "refund" ? amountCents - refundedCents : 0,
      voidable_cents: action === "void" ? amountCents : 0,
      settled,
      voided: Boolean(c.voided),
      condition: t.condition || null,
      last4: ex.last4,
      card_type: t.cardType || null,
      order_id: t.orderId || null,
      booking: saleBooking(t.orderId),
      name_hit: ex.nameHit,
      action,
      why,
    });
  }
  sales.sort((a, b) => (b.at_ms || 0) - (a.at_ms || 0));
  return { sales, dayBackCents };
}

/** Filter the sales by what the rep typed. Needs ONE identifier: txn, booking, last four or a name. */
export function matchSales(sales, q = {}) {
  const txn = String(q.txn || "").trim();
  const ref = cleanRefText(q.ref);
  const last4 = /^\d{4}$/.test(String(q.last4 || "")) ? String(q.last4) : "";
  const name = String(q.name || "").trim();
  const from = Number.isFinite(Date.parse(q.from || "")) ? Date.parse(q.from) : null;
  const to = Number.isFinite(Date.parse(q.to || "")) ? Date.parse(q.to) : null;
  const saleCents = Number.isInteger(q.sale_cents) && q.sale_cents > 0 ? q.sale_cents : null;
  if (!txn && !ref && !last4 && !name) return { error: "identifier_required", matches: [] };
  const out = sales.filter((s) => {
    if (txn && s.txn_id !== txn) return false;
    if (ref) {
      const oid = cleanRefText(s.order_id);
      const bare = oid.replace(/^RES-/, "");
      if (!(oid === ref || bare === ref || (ref.length >= 5 && oid.includes(ref)))) return false;
    }
    if (last4 && s.last4 !== last4) return false;
    if (name && !s.name_hit) return false;
    if (from != null && (s.at_ms == null || s.at_ms < from)) return false;
    if (to != null && (s.at_ms == null || s.at_ms >= to)) return false;
    if (saleCents != null && s.amount_cents !== saleCents) return false;
    return true;
  });
  return { error: null, matches: out };
}

/** The read right before money moves (Gabbai C5): at most 10 s, so the door's worst case - 10 s read +
 *  15 s gateway (nmi-card REVERSAL_TIMEOUT_MS) + 8 s CRM write - is 33 s, inside the desk chat's 45 s
 *  wait, inside its 60 s function limit. A lookup may take 20 s. */
export const PRE_REVERSAL_READ_MS = 10000;
export const LOOKUP_READ_MS = 20000;
export const CRM_WRITE_MS = 8000;
async function readSales({ deps = {}, nameNeedle = "", fresh = false } = {}) {
  const clock = typeof deps.clock === "function" ? deps.clock : Date.now;
  const key = String(deps.privateKey || (deps.env || process.env).NMI_PRIVATE_KEY || "").trim();
  if (!key) return { ok: false, error: "keys_missing" };
  const now = clock();
  let xml = null;
  if (!fresh && saleCache.xml && now - saleCache.at < SALE_CACHE_MS && saleCache.key === key.slice(-6)) xml = saleCache.xml;
  if (!xml) {
    try {
      xml = await queryNmiRange({
        host: (deps.env || process.env).NMI_HOST || NMI_HOST,
        securityKey: key,
        since: new Date(now - SALE_WINDOW_DAYS * DAY_MS),
        until: new Date(now + 60000),
        fetchImpl: deps.fetchImpl || fetch,
        timeoutMs: fresh ? PRE_REVERSAL_READ_MS : LOOKUP_READ_MS,
      });
    } catch (e) {
      const msg = String(e?.message || "");
      return { ok: false, error: /^nmi_query_[a-z_0-9]+$/.test(msg) ? msg : "nmi_query_failed" };
    }
    saleCache = { at: now, xml, key: key.slice(-6) };
  }
  const { sales, dayBackCents } = salesFromXml(xml, { nameNeedle, nowMs: now });
  return { ok: true, sales, dayBackCents };
}
export function _resetSaleCache() {
  saleCache = { at: 0, xml: null, key: "" };
}
function publicSale(s) {
  const { at_ms, name_hit, ...rest } = s;
  return rest;
}

/**
 * POST /__nesher_pay/sale {rep, q:{txn?, ref?, last4?, name?, from?, to?, sale_cents?}}.
 * Ticket kind "sale", bound to the rep. READ ONLY - it moves nothing. Up to five sales, newest
 * first, each with what has already gone back and what the chat may offer.
 */
export async function handleSaleLookup(req, res, deps = {}) {
  const door = await openDoor(req, res, deps, "sale", "rep");
  if (!door) return;
  const { body, finish } = door;
  const q = body.q && typeof body.q === "object" && !Array.isArray(body.q) ? body.q : {};
  const clean = {
    txn: /^[A-Za-z0-9_-]{4,64}$/.test(str(q.txn, 64)) ? str(q.txn, 64) : "",
    ref: str(q.ref, 32),
    last4: /^\d{4}$/.test(str(q.last4, 4)) ? str(q.last4, 4) : "",
    name: str(q.name, 60),
    from: str(q.from, 40),
    to: str(q.to, 40),
    sale_cents: Number.isInteger(q.sale_cents) ? q.sale_cents : null,
  };
  if (!clean.txn && !clean.ref && !clean.last4 && !clean.name) {
    return finish(400, { ok: false, error: "identifier_required" }, { outcome: "bad_request:identifier_required" });
  }
  const read = await readSales({ deps, nameNeedle: clean.name });
  if (!read.ok) {
    return finish(read.error === "keys_missing" ? 503 : 502, { ok: false, error: read.error }, { outcome: `lookup_failed:${read.error}` });
  }
  const m = matchSales(read.sales, clean);
  return finish(
    200,
    {
      ok: true,
      window_days: SALE_WINDOW_DAYS,
      total: m.matches.length,
      matches: m.matches.slice(0, 5).map(publicSale),
      caps: { refund_cap_set: refundCapCents(deps.env || process.env) > 0 },
    },
    { outcome: `found:${m.matches.length}` }
  );
}

/**
 * What the processor itself says about ONE sale right before money moves back on it, plus how
 * much went back in the last 24 hours. Fails closed: no read, no refund.
 */
async function saleBeforeReversal(txnId, deps) {
  const read = await readSales({ deps, fresh: true });
  if (!read.ok) return { ok: false, error: read.error };
  const sale = read.sales.find((s) => s.txn_id === txnId) || null;
  const clock = typeof deps.clock === "function" ? deps.clock : Date.now;
  return { ok: true, sale, dayBackCents: read.dayBackCents, nowMs: clock() };
}

/** Plain words for a gateway response_code. The raw code stays in its own field. */
const DECLINE_WORDS = [
  [/^100$/, "Approved."],
  [/^200$/, "The card was declined by the bank."],
  [/^201$/, "The bank said do not honor this card."],
  [/^202$/, "Insufficient funds."],
  [/^203$/, "The card is over its limit."],
  [/^204$/, "This kind of transaction is not allowed on the card."],
  [/^220$/, "The card details were not accepted."],
  [/^221$/, "No such card issuer."],
  [/^222$/, "The issuer does not know this card number."],
  [/^223$/, "The card has expired."],
  [/^224$/, "The expiration date is wrong."],
  [/^225$/, "The security code is wrong."],
  [/^226$/, "The PIN is wrong."],
  [/^240$/, "The bank asks the cardholder to call them."],
  [/^25[0-3]$/, "The issuer flagged this card. Do not retry."],
  [/^26[0-4]$/, "Declined. The cardholder should call the bank."],
  [/^300$/, "The gateway rejected the transaction."],
  [/^400$/, "Processor error. Try again in a minute."],
  [/^410$/, "Merchant configuration error. Tell the office."],
  [/^411$/, "The merchant account is inactive. Tell the office."],
  [/^420$/, "Could not reach the processor. Try again."],
  [/^421$/, "Could not reach the card issuer. Try again."],
  [/^430$/, "The processor saw this as a duplicate."],
  [/^44[01]$/, "The transaction details were rejected by the processor."],
  [/^460$/, "This card type is not supported here."],
  [/^461$/, "This card type is not supported here."],
];

export function declineHuman(code, fallbackText, o = {}) {
  const c = String(code || "").trim();
  for (const [re, words] of DECLINE_WORDS) if (re.test(c)) return words;
  const t = String(fallbackText || "").trim();
  if (/declin/i.test(t)) return "The card was declined.";
  if (/expired/i.test(t)) return "The card has expired.";
  if (/insufficient/i.test(t)) return "Insufficient funds.";
  if (/duplicate/i.test(t)) return "The processor saw this as a duplicate.";
  // Mr. AT (25 Sep, the Kaufman charge): a v5 request the gateway refused carries no code and made no
  // transaction - the bank never saw it. Say that, with the gateway's own words when it gave any.
  if (o.refused) return "The card processor refused the charge itself - it never reached the bank." + (o.said ? ` It said: "${String(o.said).slice(0, 140)}".` : "");
  // Mr. AU: the next step is declineNext's alone - two different next steps in one tile contradicted each other.
  return "The card was not charged.";
}

/**
 * THE ONE THING TO DO NEXT after a decline (Mr. AT, Joseph 25 Sep: "Show the processor's reason in
 * plain words ... and the one thing to do next"). `kept` = the card is still held for a retry.
 */
/** The gateway answers after which the SAME card may be tried again (Gabbai AT B2). Everything else is zeroed. */
export const KEEP_CODES = /^(200|201|202|203|220|224|225|240|260|300|400|420|421|440|441)$/;

export function declineNext(code, o = {}) {
  const c = String(code || "").trim();
  const again = o.kept ? " and tap Charge again - the card is held 5 more minutes, no need to send it again" : "";
  if (/^225$/.test(c)) return o.kept ? `Type the right security code in the box on the tile${again}.` : "Send the card again with the right security code.";
  if (/^22[04]$/.test(c)) return o.kept ? `Type the right expiry here (like 08/29)${again}.` : "Check the expiry and send the card again.";
  if (/^20[23]$/.test(c)) return o.kept ? `Try a smaller amount${again}, or use another card.` : "Try a smaller amount, or use another card.";
  if (/^(20[01]|24\d|26\d)$/.test(c)) return o.kept ? `Ask the customer to call the bank and approve the charge, then tap Charge again within 5 minutes - or use another card.` : "Ask the customer to call the bank and approve the charge, then send the card again - or use another card.";
  if (/^(204|223|25\d|46[01])$/.test(c)) return "Use another card.";
  if (/^22[12]$/.test(c)) return "Check the card number and send the card again.";
  if (/^41[01]$/.test(c)) return "Nothing was charged - tell Joseph, the merchant account needs a fix.";
  if (/^430$/.test(c)) return "Check in the processor whether the first charge went through before trying again.";
  if (/^(300|4[0-4]\d)$/.test(c)) return o.kept ? "Nothing was charged. Try once more in a minute; if it says the same, tell Joseph." : "Nothing was charged. Send the card again in a minute; if it says the same, tell Joseph.";
  // Gabbai AT B3 (canon s.7): never advise splitting a sale to get under a limit.
  if (o.refused) return "Nothing was charged. If it is about the amount, ask Joseph to call Pinpoint about the account's limit, or send the customer a bank-transfer link." + (o.kept ? " The card is held 5 more minutes." : "");
  return o.kept ? "Tap Charge again within 5 minutes, or use another card." : "Send the card again, or use another card.";
}

function isInt(n) {
  return Number.isInteger(n);
}

function str(v, max) {
  const s = v == null ? "" : String(v).trim();
  return max ? s.slice(0, max) : s;
}

function moneyCents(cents) {
  return (Number(cents) / 100).toFixed(2);
}

function accessLine(name, fields) {
  const o = {
    method: fields.method || null,
    ticket: fields.ticket || null,
    outcome: fields.outcome || null,
    ms: fields.ms == null ? null : fields.ms,
  };
  if (fields.brand) o.brand = fields.brand;
  if (fields.amount_cents != null) o.amount_cents = fields.amount_cents;
  if (fields.txn) o.txn = fields.txn;
  // A yes/no, never the code. Nothing else about the card is ever logged.
  if (fields.cvv_sent != null) o.cvv_sent = Boolean(fields.cvv_sent);
  // Mr. AT: the gateway's HTTP class on a decline (http_400 = the request itself was refused) and
  // whether the card went back into its hold for a retry. Words from a closed alphabet, never a card.
  if (fields.gw && /^http_\d{3}$/.test(fields.gw)) o.gw = fields.gw;
  if (fields.kept != null) o.kept = Boolean(fields.kept);
  // Gabbai AT C3: how long the gateway's own sentence was - the words go to the rep, never the log.
  if (fields.said_len != null && Number.isInteger(fields.said_len)) o.said_len = fields.said_len;
  return `${name} ${JSON.stringify(o)}`;
}

/**
 * Shared preamble: enabled -> POST -> ticket (signature, kind, TTL, single
 * use) -> body JSON -> binding + rep match. Returns {ticket, body} or null
 * after answering the request itself.
 */
async function openDoor(req, res, deps, kind, bindField) {
  const clock = typeof deps.clock === "function" ? deps.clock : Date.now;
  const t0 = clock();
  const log = typeof deps.log === "function" ? deps.log : console.log;
  const method = String(req.method || "GET").toUpperCase();
  const secret = deps.secret == null ? ocrSecret() : String(deps.secret || "");
  const done = (status, body, fields) => {
    sendTicketJson(res, status, body, { close: true });
    log(accessLine(kind, { method, ...fields, ms: clock() - t0 }));
  };
  if (!secret) {
    done(404, { ok: false, error: "not_found" }, { ticket: null, outcome: "disabled" });
    return null;
  }
  if (method !== "POST") {
    done(405, { ok: false, error: "post_only" }, { ticket: null, outcome: "method" });
    return null;
  }
  const token = ticketFromHeaders(req.headers || {});
  if (!token) {
    done(401, { ok: false, error: "ticket_required" }, { ticket: null, outcome: "no_ticket" });
    return null;
  }
  const ticket = verifyTicket(token, { secret, now: clock(), kind });
  if (!ticket.ok) {
    done(401, { ok: false, error: `ticket_${ticket.error}` }, { ticket: ticket.ticketId || null, outcome: `bad_ticket:${ticket.error}` });
    return null;
  }
  // Burn it now: a ticket presented with the wrong body is spent, not retried.
  consumeTicket(ticket.ticketId, ticket.expiresAt, { now: clock() });
  const read = await readLimitedBody(req, CHARGE_BODY_MAX);
  if (read.error) {
    done(read.error === "body_too_large" ? 413 : 400, { ok: false, error: read.error }, { ticket: ticket.ticketId, outcome: read.error });
    return null;
  }
  let body;
  try {
    body = JSON.parse(read.buffer.toString("utf8") || "{}");
  } catch {
    body = null;
  }
  purge([read.buffer]);
  if (!body || typeof body !== "object") {
    done(400, { ok: false, error: "invalid_json" }, { ticket: ticket.ticketId, outcome: "invalid_json" });
    return null;
  }
  const bound = str(body[bindField], 128);
  if (!bound || bindHashOf(kind, bound) !== ticket.bindHash) {
    done(401, { ok: false, error: "ticket_bind_mismatch" }, { ticket: ticket.ticketId, outcome: "bad_ticket:bind_mismatch" });
    return null;
  }
  if (body.rep != null && str(body.rep, 64) !== ticket.repId) {
    done(401, { ok: false, error: "ticket_rep_mismatch" }, { ticket: ticket.ticketId, outcome: "bad_ticket:rep_mismatch" });
    return null;
  }
  return {
    ticket,
    body,
    finish: (status, out, fields) => done(status, out, { ticket: ticket.ticketId, ...fields }),
  };
}

function orderRef(brandId, now) {
  const d = new Date(now);
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${brandId === "jrm" ? "JRM" : "RES"}-CARD-${stamp}-${rand}`;
}

/**
 * POST /__nesher_pay/charge. Ticket kind "charge", bound to token_ref.
 */
export async function handleChargeRequest(req, res, deps = {}) {
  const door = await openDoor(req, res, deps, "charge", "token_ref");
  if (!door) return;
  const { ticket, body, finish } = door;
  const clock = typeof deps.clock === "function" ? deps.clock : Date.now;

  const tokenRef = str(body.token_ref, 128);
  const amountCents = body.amount_cents;
  const currency = str(body.currency || "USD", 3).toUpperCase();
  const brandId = str(body.brand, 10).toLowerCase();
  const customerName = str(body.customer_name, 80);
  const invoiceRefRaw = str(body.invoice_ref, 50);
  const note = str(body.note, 255);
  // The security code, typed by the rep, optional. It is NOT in the hold and
  // never will be (13.4: it is never read from a photo). It is taken off the
  // body here, put in the one gateway call, and dropped. The raw request bytes
  // that carried it are already zeroed by openDoor.
  // NOT sliced to 4: slicing would turn a mistyped "12345" into a valid-looking
  // "1234" and send the wrong code to the bank. Take it whole, then judge it.
  const cvv = str(body.cvv, 16);
  body.cvv = null;
  delete body.cvv;

  const bad = (error) => finish(400, { ok: false, error }, { outcome: `bad_request:${error}` });
  if (!CARD_REF_RE.test(tokenRef)) return bad("token_ref_invalid");
  if (cvv && !CVV_RE.test(cvv)) return bad("cvv_invalid");
  if (!isInt(amountCents) || amountCents < 100 || amountCents > CHARGE_MAX_CENTS) return bad("amount_cents_invalid");
  if (currency !== "USD") return bad("currency_usd_only");
  if (brandId !== "jrm" && brandId !== "nesher") return bad("brand_invalid");
  if (!customerName) return bad("customer_name_required");
  // Mr. AU (25 Sep, audit H3): the booking goes to the processor as the order id, in the one shape the
  // collection loop reads back (payments-sync parseInvoiceNumber): RES-<code> on Nesher, JRM-1<id>[-O<id>]
  // on JRM. Anything else - a typo, the wrong brand's shape - is not sent; the random CARD ref stands.
  const invoiceRef = INVOICE_REF_RE[brandId] && INVOICE_REF_RE[brandId].test(invoiceRefRaw.toUpperCase()) ? invoiceRefRaw.toUpperCase() : "";

  // ONE TILE, AT MOST ONE SALE AT A TIME (Mr. AU, audit C2). The desk sends `arming` = its tile id. The
  // first charge for a tile claims it BEFORE the hold is spent or the gateway is asked; while that sale
  // is on the wire, and forever after an approval or an unknown answer, a repeat is answered from the
  // claim and never reaches the gateway - not even with a new card read. Only a CLEAR no (a decline,
  // a refused request, a spent hold) releases it, so "Charge again" after a real decline still works.
  const chargeKey = ARMING_RE.test(str(body.arming, 80)) ? `charge:${str(body.arming, 80).split(":")[0]}` : null;
  if (chargeKey) {
    const prior = claimArming(chargeKey, clock());
    if (prior) {
      if (prior.state === "done") return finish(prior.status, { ...prior.body, repeated: true }, { outcome: "charge_repeat", brand: brandId, amount_cents: amountCents });
      if (prior.state === "unknown") return finish(503, { ok: false, error: "outcome_unknown", repeated: true, message: "We could not confirm the first charge on this tile. Do not charge again - check the sale." }, { outcome: "charge_repeat:unknown", brand: brandId, amount_cents: amountCents });
      return finish(409, { ok: false, error: "charge_in_flight", message: "That charge is being sent right now - its answer lands on the tile. Do not charge again." }, { outcome: "charge_repeat:in_flight", brand: brandId, amount_cents: amountCents });
    }
  }
  const releaseCharge = () => { if (chargeKey) armings.delete(chargeKey); };

  // One presentation is the whole life of a reference. The rep on the ticket
  // must be the rep who took the photo.
  const held = redeemCardHold(tokenRef, { now: clock(), rep: ticket.repId });
  if (!held.ok) {
    releaseCharge();
    if (held.error === "rep_mismatch") {
      return finish(403, { ok: false, error: "token_ref_wrong_rep", decline_reason_human: "That card was read by somebody else. Take the photo again." }, { outcome: "token_ref_wrong_rep", brand: brandId, amount_cents: amountCents });
    }
    if (held.error === "needs_expiry") {
      return finish(409, { ok: false, error: "token_ref_needs_expiry", decline_reason_human: "That card had no expiry yet, so nothing was charged. Send the card again with its expiry." }, { outcome: "token_ref_gone:needs_expiry", brand: brandId, amount_cents: amountCents });
    }
    return finish(410, { ok: false, error: "token_ref_spent_or_expired", decline_reason_human: "That card reference has expired. Take the photo again." }, { outcome: `token_ref_gone:${held.error}`, brand: brandId, amount_cents: amountCents });
  }
  const entry = held.entry;
  // A code that came WITH a typed / pasted / spoken card (card-hold, 23 Sep) sits in the hold as a
  // Buffer beside the number. The rep's typed code on this body wins; otherwise the held one goes.
  // zeroHold() below wipes both, whatever the gateway says.
  const cvvUse = cvv || (entry.cvv && typeof entry.cvv.toString === "function" ? entry.cvv.toString("latin1") : "");
  if (deps.trace && Array.isArray(deps.trace.buffers) && entry.cvv) deps.trace.buffers.push(entry.cvv);
  // The same trace seam handleOcrRequest uses: the suite collects every Buffer
  // this path touches and asserts each one is all-zero when the answer is out.
  if (deps.trace && Array.isArray(deps.trace.buffers)) deps.trace.buffers.push(entry.pan);

  let sale;
  try {
    sale = await chargeWithToken({
      brandId,
      amountUsd: Number(moneyCents(amountCents)),
      invoiceNumber: invoiceRef || orderRef(brandId, clock()),
      customerName,
      staffName: ticket.repId,
      notes: note,
      address1: str(body.address1, 100),
      city: str(body.city, 50),
      state: str(body.state, 50),
      zip: str(body.zip, 20),
      country: str(body.country, 2),
      email: str(body.email, 120),
      rawCard: { number: entry.pan.toString("latin1"), expMMYY: entry.expMMYY, cvv: cvvUse },
      paymentToken: "",
      fetchImpl: deps.fetchImpl,
      privateKey: deps.privateKey,
      // Mr. AU (audit C2): the sale's own limit, well inside the desk's 45 s wait, so the desk always gets
      // THIS door's answer (approved / declined / outcome_unknown) and never has to guess from a timeout.
      timeoutMs: Number(deps.saleTimeoutMs) > 0 ? Number(deps.saleTimeoutMs) : CHARGE_SALE_TIMEOUT_MS,
    });
  } catch {
    sale = { ok: false, error: "processor_error", responseCode: null, responseText: "", thrown: true };
  }
  // Approved, unknown or thrown: the number is gone from this process here. A CLEAR decline (Mr. AT,
  // Joseph 25 Sep: "After a decline, keep the card hold for 5 minutes, so a corrected CVV or amount can
  // retry WITHOUT re-sending the card") goes back behind the same reference, same rep, five minutes,
  // at most MAX_HOLD_DECLINES times - and is zeroed by the next spend, the sweeper, or the cap.
  // Gabbai AT B2: kept ONLY on an allow-list of retryable answers. A hard decline (pick up / lost / stolen /
  // fraud 250-253, not allowed 204, bad card 221-223, recurring stops 261-264, merchant 410/411, duplicate
  // 430, unsupported 460/461) is zeroed: keeping it would be decline recycling. Never kept when the gateway
  // said approved ("1") anywhere, even inside a 4xx.
  const saleCode = sale && sale.responseCode ? String(sale.responseCode).trim() : "";
  const clearNo = Boolean(sale && !sale.ok && !sale.outcomeUnknown && !sale.thrown && String(sale.gatewayResponse || "") !== "1" &&
    (sale.error === "keys_missing" || (sale.refusedRequest && !saleCode) || KEEP_CODES.test(saleCode)));
  let kept = null;
  if (clearNo) {
    const back = reholdAfterDecline(tokenRef, entry, { now: clock() });
    kept = back.ok ? back : null;
  } else {
    zeroHold(entry);
  }

  const brand = brandId === "jrm" ? BRANDS.jrm : BRANDS.nesher;
  // A thrown sale is an unknown too (the request may have left): never a decline, never a release.
  if (sale && sale.thrown) sale.outcomeUnknown = true;
  if (chargeKey) {
    if (sale && sale.outcomeUnknown) armings.set(chargeKey, { at: clock(), state: "unknown" });
    else if (!sale || !sale.ok) releaseCharge();
  }
  if (sale && sale.outcomeUnknown) {
    // Gabbai 23 Sep F5: the gateway may have taken the money. A rep told
    // "declined" would retake the photo and charge twice.
    return finish(
      503,
      {
        ok: false,
        error: "outcome_unknown",
        message: "We could not confirm this charge. Do not charge again - check with the office.",
        brand: brandId === "jrm" ? BRANDS.jrm.id : BRANDS.nesher.id,
        last4: entry.last4,
        amount_cents: amountCents,
        cvv_sent: Boolean(cvvUse),
      },
      { outcome: "outcome_unknown", brand: brandId === "jrm" ? "jrm" : "nesher", amount_cents: amountCents, cvv_sent: Boolean(cvvUse) }
    );
  }
  if (!sale || !sale.ok) {
    const code = sale && sale.responseCode ? String(sale.responseCode) : null;
    const status = sale && sale.error === "keys_missing" ? 503 : 402;
    const refused = Boolean(sale && sale.refusedRequest);
    const said = sale && sale.gatewayText ? String(sale.gatewayText) : null;
    const gw = sale && Number(sale.httpStatus) ? `http_${Number(sale.httpStatus)}` : null;
    return finish(
      status,
      {
        ok: false,
        error: (sale && sale.error) || "declined",
        decline_reason_human: sale && sale.error === "keys_missing" ? "Card processing is not configured. Tell the office." : declineHuman(code, sale && sale.responseText, { refused, said }),
        decline_next: sale && sale.error === "keys_missing" ? "Nothing was charged - tell Joseph." : declineNext(code, { kept: Boolean(kept), refused }),
        decline_code: code,
        decline_text: sale && sale.responseText ? String(sale.responseText).slice(0, 120) : (said ? said.slice(0, 120) : null),
        // A refusal of the REQUEST (no transaction exists at the gateway) vs the bank's answer.
        refused_by_processor: refused,
        brand: brand.id,
        last4: entry.last4,
        amount_cents: amountCents,
        cvv_sent: Boolean(cvvUse),
        // Still held for a retry (same reference, same rep), and until when.
        hold_kept: Boolean(kept),
        token_ref_expires_at: kept ? new Date(kept.expiresAt).toISOString() : null,
      },
      { outcome: `declined:${code || (sale && sale.error) || "unknown"}`, brand: brand.id, amount_cents: amountCents, cvv_sent: Boolean(cvvUse), gw, kept: Boolean(kept), said_len: said ? said.length : 0 }
    );
  }
  const approved = {
    ok: true,
    txn_id: sale.transactionId,
    brand: brand.id,
    last4: entry.last4,
    card_brand: entry.brand,
    amount_cents: amountCents,
    currency: "USD",
    processor_id: sale.processorId,
    auth_code: sale.authCode || null,
    avs: sale.avsResponse || null,
    // The gateway's CVV match letter (M / N / P), never the code itself.
    cvv: sale.cvvResponse || null,
    // Did a security code go with this sale? The tile and the ledger show
    // this: a sale without one is worse interchange and no CVV protection.
    cvv_sent: Boolean(cvvUse),
    order_id: sale.orderId,
  };
  // Mr. AU: an approved tile answers any repeat with this same approval - never a second sale.
  if (chargeKey) armings.set(chargeKey, { at: clock(), state: "done", status: 200, body: approved });
  return finish(
    200,
    approved,
    { outcome: "approved", brand: brand.id, amount_cents: amountCents, txn: sale.transactionId, cvv_sent: Boolean(cvvUse) }
  );
}

/**
 * The checks every reversal passes BEFORE the gateway is asked (24 Sep). Read from the processor
 * itself, fresh: the sale exists in the last 180 days, is a sale, is not voided; a refund needs it
 * SETTLED and the amount at most what is left on it; a void needs it NOT settled and takes the whole
 * sale. Both are held to the per-refund cap and the 24-hour cap. Returns null when all pass, or the
 * refusal to send.
 */
export const RECENT_REFUND_MS = 15 * 60 * 1000;
function reversalRefusal(kind, txnId, amountCents, facts, env) {
  const cap = refundCapCents(env);
  const dayCap = refundDayCapCents(env);
  const say = (status, error, words, extra = {}) => ({ status, body: { ok: false, error, decline_reason_human: words, txn_id: txnId, ...extra }, outcome: `${kind}_refused:${error}` });
  if (cap <= 0) return say(403, "refund_cap_not_set", "Refunds from the chat are switched off. Refund it in the gateway portal.", { cap_cents: 0 });
  if (amountCents > cap) return say(403, "refund_over_cap", "That is above the chat's cap for one refund. Refund it in the gateway portal.", { cap_cents: cap });
  if (!facts.ok) return say(502, "sale_unreadable", "Could not read the sale at the processor, so nothing was sent back. Try again in a minute.");
  const s = facts.sale;
  if (!s) return say(404, "sale_not_found", `No card sale with that transaction in the last ${SALE_WINDOW_DAYS} days. Refund it in the gateway portal.`);
  if (s.voided) return say(409, "sale_voided", "That sale was already voided - nothing is left to send back.");
  if (kind === "refund") {
    // ONE ARMING, AT MOST ONE REFUND (Gabbai 24 Sep C4): a refund already went back on this sale in the
    // last 15 minutes - from this chat, another screen or the portal - so a second one waits for a person.
    const lastMs = Date.parse(s.last_back_at || "");
    const nowMs = typeof facts.nowMs === "number" ? facts.nowMs : Date.now();
    if (Number.isFinite(lastMs) && nowMs - lastMs < RECENT_REFUND_MS) {
      const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" }).format(new Date(lastMs));
      return say(409, "recent_refund", `A refund of $${moneyCents(s.last_back_cents)} went back on this sale at ${hhmm} (Israel time). Check it before sending another - or wait 15 minutes.`, { last_back_at: s.last_back_at, last_back_cents: s.last_back_cents });
    }
    if (!s.settled) return say(409, "not_settled", "That sale has not settled yet, so the processor will not refund it. Void it instead (the whole sale), or refund after tonight's batch.", { settled: false });
    const left = s.amount_cents - s.refunded_cents;
    if (left <= 0) return say(409, "fully_refunded", "That sale is already fully refunded.", { refunded_cents: s.refunded_cents });
    if (amountCents > left) return say(409, "over_refundable", `Only $${moneyCents(left)} is left to refund on that sale.`, { refundable_cents: left });
  } else {
    if (s.settled) return say(409, "already_settled", "That sale has already settled - it cannot be voided. Refund it instead.", { settled: true });
    if (s.action !== "void") return say(409, "not_voidable", "That sale cannot be voided from the chat. Check it in the gateway portal.");
    if (amountCents !== s.amount_cents) return say(409, "void_is_whole", `A void cancels the whole sale: $${moneyCents(s.amount_cents)}.`, { amount_cents: s.amount_cents });
  }
  if (facts.dayBackCents + amountCents > dayCap) {
    return say(403, "refund_over_day_cap", "That would pass the chat's refund limit for 24 hours. Refund it in the gateway portal, or wait.", { day_cap_cents: dayCap });
  }
  return null;
}

/**
 * The CRM half of a reversal (24 Sep): through the collection loop's own ledger door, as a new
 * negative row against the CRM payment the sale is on (payments-sync.js recordNmiReversal). Never
 * fails the answer: the money already went back, so a CRM problem is REPORTED, never hidden and
 * never allowed to look like the refund failed.
 */
async function recordReversal(deps, fields) {
  const rec = typeof deps.recordReversal === "function" ? deps.recordReversal : null;
  if (!rec) return { state: "not_recorded", reason: "no_crm_door" };
  try {
    let slow;
    const r = await Promise.race([
      rec(fields),
      new Promise((resolve) => { slow = setTimeout(() => resolve({ ok: false, state: "slow", errors: ["crm_slow"] }), deps.crmWriteMs || CRM_WRITE_MS); }),
    ]).finally(() => clearTimeout(slow));
    if (r && r.state === "posted") {
      // "nmi-refund:<id>: -$15.00 -> reservation #7" -> "reservation #7" (the marker itself holds a colon).
      const where = Array.isArray(r.recorded) && r.recorded[0] ? (String(r.recorded[0]).split("->")[1] || "").trim() : "";
      return { state: "posted", where: where.slice(0, 80), repeated: Array.isArray(r.skipped) && r.skipped.length > 0 };
    }
    const reason = (r && Array.isArray(r.errors) && r.errors[0]) || (r && r.state) || "not_recorded";
    return { state: r && r.state === "review" ? "review" : "not_recorded", reason: String(reason).slice(0, 60) };
  } catch {
    return { state: "not_recorded", reason: "crm_write_failed" };
  }
}

// ONE ARMING, AT MOST ONE GATEWAY CALL (Gabbai 24 Sep C4). The desk chat sends `arming` = its tile id
// + the moment it was armed. The first request with that key claims it BEFORE the gateway is asked;
// any repeat is answered from the claim (the same answer, or "still being sent", or "unknown") and
// never reaches the gateway. One container answers (health `instance`), so memory is the right
// place; behind it stands the processor-based 15-minute guard, which survives a restart.
const ARMING_RE = /^[A-Za-z0-9:_-]{6,80}$/;
const ARMING_TTL_MS = 24 * 60 * 60 * 1000;
const armings = new Map();
export function _resetArmingsForTests() {
  armings.clear();
}
function claimArming(key, now) {
  for (const [k, v] of armings) if (now - v.at > ARMING_TTL_MS) armings.delete(k);
  const prior = armings.get(key);
  if (prior) return prior;
  armings.set(key, { at: now, state: "in_flight" });
  return null;
}

const UNKNOWN_WORDS = {
  refund: "We could not confirm this refund. Do not send it again - check the sale.",
  void: "We could not confirm this void. Do not send it again - check the sale.",
};

/**
 * The refund and void doors, one body (24 Sep). kind "refund": any SETTLED sale in the last 180 days,
 * up to what is left. kind "void": a sale that has NOT settled, the whole amount. Both: the ticket
 * bound to the txn, the caps, the processor's own fresh record (reversalRefusal), the arming claim,
 * the gateway with the sale's outcome classes (an unknown is 503 outcome_unknown, never "did not go
 * through"), then the CRM record through the collection loop's ledger (recordReversal).
 */
async function reversalDoor(kind, req, res, deps) {
  const door = await openDoor(req, res, deps, kind, "txn_id");
  if (!door) return;
  const { body, finish, ticket } = door;
  const env = deps.env || process.env;
  const clock = typeof deps.clock === "function" ? deps.clock : Date.now;
  const txnId = str(body.txn_id, 64);
  const amountCents = body.amount_cents;
  if (!TXN_ID_RE.test(txnId)) return finish(400, { ok: false, error: "txn_id_invalid" }, { outcome: "bad_request:txn_id_invalid" });
  if (!isInt(amountCents) || amountCents < 1) return finish(400, { ok: false, error: "amount_cents_invalid" }, { outcome: "bad_request:amount_cents_invalid" });
  // The cap first, before the processor is even read: a door that is off stays cheap and says so.
  const cap = refundCapCents(env);
  if (cap <= 0) {
    return finish(403, { ok: false, error: "refund_cap_not_set", cap_cents: 0, decline_reason_human: "Refunds from the chat are switched off. Refund it in the gateway portal." }, { outcome: `${kind}_refused:cap_not_set`, amount_cents: amountCents, txn: txnId });
  }
  if (amountCents > cap) {
    return finish(403, { ok: false, error: "refund_over_cap", cap_cents: cap, decline_reason_human: "That is above the chat's cap for one refund. Refund it in the gateway portal." }, { outcome: `${kind}_refused:over_cap`, amount_cents: amountCents, txn: txnId });
  }
  const arming = ARMING_RE.test(str(body.arming, 80)) ? `${kind}:${txnId}:${str(body.arming, 80)}` : null;
  if (arming) {
    const prior = claimArming(arming, clock());
    if (prior) {
      if (prior.state === "done") return finish(prior.status, { ...prior.body, repeated: true }, { outcome: `${kind}_repeat`, txn: txnId });
      if (prior.state === "unknown") return finish(503, { ok: false, error: "outcome_unknown", repeated: true, decline_reason_human: UNKNOWN_WORDS[kind], txn_id: txnId }, { outcome: `${kind}_repeat:unknown`, txn: txnId });
      return finish(409, { ok: false, error: "in_flight", decline_reason_human: `That ${kind} is being sent right now - its answer lands on the tile.`, txn_id: txnId }, { outcome: `${kind}_repeat:in_flight`, txn: txnId });
    }
  }
  const release = () => { if (arming) armings.delete(arming); };
  const facts = await saleBeforeReversal(txnId, deps);
  const refused = reversalRefusal(kind, txnId, amountCents, facts, env);
  if (refused) {
    release();
    return finish(refused.status, refused.body, { outcome: refused.outcome, amount_cents: amountCents, txn: txnId });
  }
  const sale = facts.sale;
  let out;
  try {
    out = kind === "refund"
      ? await refundPayment({ transactionId: txnId, amountUsd: Number(moneyCents(amountCents)), fetchImpl: deps.fetchImpl, privateKey: deps.privateKey, timeoutMs: deps.gatewayTimeoutMs })
      : await voidPayment({ transactionId: txnId, fetchImpl: deps.fetchImpl, privateKey: deps.privateKey, timeoutMs: deps.gatewayTimeoutMs });
  } catch {
    out = { ok: false, error: "outcome_unknown", outcomeUnknown: true };
  }
  if (out.outcomeUnknown) {
    if (arming) armings.set(arming, { at: clock(), state: "unknown" });
    _resetSaleCache();
    // What had already gone back BEFORE this call (Gabbai 24 Sep round 2, condition 1): the desk's
    // read-back counts a refund as landed only above this figure and only after the arming.
    return finish(503, { ok: false, error: "outcome_unknown", decline_reason_human: UNKNOWN_WORDS[kind], txn_id: txnId, amount_cents: amountCents, refunded_cents_before: sale.refunded_cents }, { outcome: `${kind}_outcome_unknown`, amount_cents: amountCents, txn: txnId });
  }
  if (!out.ok) {
    release();
    return finish(
      out.error === "keys_missing" ? 503 : 402,
      {
        ok: false,
        error: out.error || `${kind}_failed`,
        decline_reason_human: out.error === "keys_missing" ? "Card processing is not configured. Tell the office." : kind === "refund" ? "The processor refused the refund. Check the sale in the gateway portal." : "The processor refused the void. If the sale already settled, refund it instead.",
        decline_code: out.responseCode || null,
        decline_text: out.responseText ? String(out.responseText).slice(0, 120) : null,
        txn_id: txnId,
        amount_cents: amountCents,
      },
      { outcome: `${kind}_failed:${out.responseCode || out.error || "unknown"}`, amount_cents: amountCents, txn: txnId }
    );
  }
  _resetSaleCache();
  const moved = kind === "refund" ? amountCents : sale.amount_cents;
  const crm = kind === "void" || out.transactionId
    ? await recordReversal(deps, { kind, saleTxn: txnId, reversalTxn: out.transactionId || null, amountUsd: Number(moneyCents(moved)), brand: sale.merchant, orderId: sale.order_id, rep: ticket.repId, cardLast4: sale.last4, at: new Date(clock()).toISOString() })
    : { state: "not_recorded", reason: "no_refund_txn_id" };
  const answer = kind === "refund"
    ? { ok: true, txn_id: txnId, refund_txn_id: out.transactionId || null, amount_cents: amountCents, refunded_cents: sale.refunded_cents + amountCents, sale_cents: sale.amount_cents, merchant: sale.merchant, crm }
    : { ok: true, txn_id: txnId, void_txn_id: out.transactionId || null, amount_cents: sale.amount_cents, merchant: sale.merchant, crm };
  if (arming) armings.set(arming, { at: clock(), state: "done", status: 200, body: answer });
  return finish(200, answer, { outcome: kind === "refund" ? "refunded" : "voided", amount_cents: moved, txn: txnId });
}

/** POST /__nesher_pay/void {txn_id, amount_cents, rep, arming}. Ticket kind "void", bound to txn_id. */
export async function handleVoidRequest(req, res, deps = {}) {
  return reversalDoor("void", req, res, deps);
}

/**
 * POST /__nesher_pay/refund {txn_id, amount_cents, rep, arming}. Ticket kind "refund", bound to txn_id.
 * Any settled sale on our processor in the last 180 days - a chat tile's own sale or any past one -
 * capped per refund (REFUND_CAP_CENTS, absent = 0 = refused) and per 24 hours (REFUND_DAY_CAP_CENTS).
 */
export async function handleRefundRequest(req, res, deps = {}) {
  return reversalDoor("refund", req, res, deps);
}
