/**
 * Server-to-server money doors for the desk chat's card tile (Mr Money plan
 * Phase 1.3; scope added mid-run by the coordinator on 23 Sep 2026):
 *
 *   POST /__nesher_pay/charge {token_ref, amount_cents, currency, brand, rep, customer_name, cvv?, invoice_ref?, note?, address1?, city?, state?, zip?, country?}
 *   POST /__nesher_pay/void   {txn_id}
 *   POST /__nesher_pay/refund {txn_id, amount_cents}
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
  chargeWithToken,
  refundPayment,
  voidPayment,
} from "./nmi-card.js";
import {
  bindHashOf,
  consumeTicket,
  ocrSecret,
  purge,
  readLimitedBody,
  redeemCardHold,
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
  return null;
}

/** Absent, empty, non-numeric or negative -> 0 -> every refund is refused. */
export function refundCapCents(env = process.env) {
  const raw = String(env[REFUND_CAP_NAME] ?? "").trim();
  if (!/^\d{1,9}$/.test(raw)) return 0;
  return Number(raw);
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

export function declineHuman(code, fallbackText) {
  const c = String(code || "").trim();
  for (const [re, words] of DECLINE_WORDS) if (re.test(c)) return words;
  const t = String(fallbackText || "").trim();
  if (/declin/i.test(t)) return "The card was declined.";
  if (/expired/i.test(t)) return "The card has expired.";
  if (/insufficient/i.test(t)) return "Insufficient funds.";
  if (/duplicate/i.test(t)) return "The processor saw this as a duplicate.";
  return "The card was not charged. Try again or use another card.";
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
  const invoiceRef = str(body.invoice_ref, 50);
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

  // One presentation is the whole life of a reference. The rep on the ticket
  // must be the rep who took the photo.
  const held = redeemCardHold(tokenRef, { now: clock(), rep: ticket.repId });
  if (!held.ok) {
    if (held.error === "rep_mismatch") {
      return finish(403, { ok: false, error: "token_ref_wrong_rep", decline_reason_human: "That card was read by somebody else. Take the photo again." }, { outcome: "token_ref_wrong_rep", brand: brandId, amount_cents: amountCents });
    }
    return finish(410, { ok: false, error: "token_ref_spent_or_expired", decline_reason_human: "That card reference has expired. Take the photo again." }, { outcome: `token_ref_gone:${held.error}`, brand: brandId, amount_cents: amountCents });
  }
  const entry = held.entry;
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
      rawCard: { number: entry.pan.toString("latin1"), expMMYY: entry.expMMYY, cvv },
      paymentToken: "",
      fetchImpl: deps.fetchImpl,
      privateKey: deps.privateKey,
    });
  } catch {
    sale = { ok: false, error: "processor_error", responseCode: null, responseText: "" };
  } finally {
    // Approved, declined or thrown: the number is gone from this process here.
    zeroHold(entry);
  }

  const brand = brandId === "jrm" ? BRANDS.jrm : BRANDS.nesher;
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
        cvv_sent: Boolean(cvv),
      },
      { outcome: "outcome_unknown", brand: brandId === "jrm" ? "jrm" : "nesher", amount_cents: amountCents, cvv_sent: Boolean(cvv) }
    );
  }
  if (!sale || !sale.ok) {
    const code = sale && sale.responseCode ? String(sale.responseCode) : null;
    const status = sale && sale.error === "keys_missing" ? 503 : 402;
    return finish(
      status,
      {
        ok: false,
        error: (sale && sale.error) || "declined",
        decline_reason_human: sale && sale.error === "keys_missing" ? "Card processing is not configured. Tell the office." : declineHuman(code, sale && sale.responseText),
        decline_code: code,
        decline_text: sale && sale.responseText ? String(sale.responseText).slice(0, 120) : null,
        brand: brand.id,
        last4: entry.last4,
        amount_cents: amountCents,
        cvv_sent: Boolean(cvv),
      },
      { outcome: `declined:${code || (sale && sale.error) || "unknown"}`, brand: brand.id, amount_cents: amountCents, cvv_sent: Boolean(cvv) }
    );
  }
  return finish(
    200,
    {
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
      cvv_sent: Boolean(cvv),
      order_id: sale.orderId,
    },
    { outcome: "approved", brand: brand.id, amount_cents: amountCents, txn: sale.transactionId, cvv_sent: Boolean(cvv) }
  );
}

/**
 * POST /__nesher_pay/void {txn_id}. Ticket kind "void", bound to txn_id.
 * The chat's 60-second undo: voids an unsettled sale.
 */
export async function handleVoidRequest(req, res, deps = {}) {
  const door = await openDoor(req, res, deps, "void", "txn_id");
  if (!door) return;
  const { body, finish } = door;
  const txnId = str(body.txn_id, 64);
  if (!TXN_ID_RE.test(txnId)) return finish(400, { ok: false, error: "txn_id_invalid" }, { outcome: "bad_request:txn_id_invalid" });
  let out;
  try {
    out = await voidPayment({ transactionId: txnId, fetchImpl: deps.fetchImpl, privateKey: deps.privateKey });
  } catch {
    out = { ok: false, error: "processor_error" };
  }
  if (!out.ok) {
    return finish(
      out.error === "keys_missing" ? 503 : 402,
      {
        ok: false,
        error: out.error || "void_failed",
        decline_reason_human: out.error === "keys_missing" ? "Card processing is not configured. Tell the office." : "The void did not go through. If the sale already settled, refund it instead.",
        decline_code: out.responseCode || null,
        decline_text: out.responseText ? String(out.responseText).slice(0, 120) : null,
        txn_id: txnId,
      },
      { outcome: `void_failed:${out.responseCode || out.error || "unknown"}`, txn: txnId }
    );
  }
  return finish(200, { ok: true, txn_id: txnId, void_txn_id: out.transactionId || null }, { outcome: "voided", txn: txnId });
}

/**
 * POST /__nesher_pay/refund {txn_id, amount_cents}. Ticket kind "refund",
 * bound to txn_id. Capped by REFUND_CAP_CENTS (absent = 0 = refused).
 */
export async function handleRefundRequest(req, res, deps = {}) {
  const door = await openDoor(req, res, deps, "refund", "txn_id");
  if (!door) return;
  const { body, finish } = door;
  const txnId = str(body.txn_id, 64);
  const amountCents = body.amount_cents;
  if (!TXN_ID_RE.test(txnId)) return finish(400, { ok: false, error: "txn_id_invalid" }, { outcome: "bad_request:txn_id_invalid" });
  if (!isInt(amountCents) || amountCents < 1) return finish(400, { ok: false, error: "amount_cents_invalid" }, { outcome: "bad_request:amount_cents_invalid" });
  const cap = refundCapCents(deps.env || process.env);
  if (cap <= 0) {
    return finish(403, { ok: false, error: "refund_cap_not_set", cap_cents: 0, decline_reason_human: "Refunds from the chat are switched off. Refund it in the gateway portal." }, { outcome: "refund_refused:cap_not_set", amount_cents: amountCents, txn: txnId });
  }
  if (amountCents > cap) {
    return finish(403, { ok: false, error: "refund_over_cap", cap_cents: cap, decline_reason_human: "That refund is above the chat's cap. Refund it in the gateway portal." }, { outcome: "refund_refused:over_cap", amount_cents: amountCents, txn: txnId });
  }
  let out;
  try {
    out = await refundPayment({ transactionId: txnId, amountUsd: Number(moneyCents(amountCents)), fetchImpl: deps.fetchImpl, privateKey: deps.privateKey });
  } catch {
    out = { ok: false, error: "processor_error" };
  }
  if (!out.ok) {
    return finish(
      out.error === "keys_missing" ? 503 : 402,
      {
        ok: false,
        error: out.error || "refund_failed",
        decline_reason_human: out.error === "keys_missing" ? "Card processing is not configured. Tell the office." : "The refund did not go through. Check the sale in the gateway portal.",
        decline_code: out.responseCode || null,
        decline_text: out.responseText ? String(out.responseText).slice(0, 120) : null,
        txn_id: txnId,
        amount_cents: amountCents,
      },
      { outcome: `refund_failed:${out.responseCode || out.error || "unknown"}`, amount_cents: amountCents, txn: txnId }
    );
  }
  return finish(200, { ok: true, txn_id: txnId, refund_txn_id: out.transactionId || null, amount_cents: amountCents }, { outcome: "refunded", amount_cents: amountCents, txn: txnId });
}
