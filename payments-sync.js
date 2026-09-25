/**
 * Mercury → CRM payment sync.
 * Polls Mercury AR invoices; when one is Paid, records the payment on the CRM
 * record it came from (reservation or hotel request) and appends a CRM note.
 * Idempotent: every write carries a "mercury:<invoiceId>" marker and the sync
 * skips invoices whose marker is already in the DB, so re-runs never
 * double-record. A same-amount payment recorded manually by staff also blocks
 * the auto-insert (skipped and reported instead).
 */

import { fetchWithTimeout } from "./http.js";
import { mercuryApiBase, normalizeToken } from "./mercury.js";
import { postConfirmedPayment, observeShadowPayment, recordPaymentException, ensureLedger } from "./payment-posts.js";

/** JRM-1{req}[-O{offer}] | RES-{code} → CRM target. */
export function parseInvoiceNumber(num) {
  const s = String(num || "").trim();
  let m = s.match(/^JRM-1(\d+)(?:-O(\d+))?$/i);
  if (m) {
    return {
      kind: "hotel",
      requestId: Number(m[1]),
      offerId: m[2] ? Number(m[2]) : null,
    };
  }
  m = s.match(/^RES-([A-Za-z0-9_-]+)$/i);
  if (m) return { kind: "reservation", code: m[1].toUpperCase() };
  return null;
}

function marker(inv) {
  return `mercury:${inv.id}`;
}

function nmiMarker(transactionId) {
  const txn = String(transactionId || "").trim() || "unknown";
  return `nmi:${txn}`;
}

/**
 * CRM user id for the rep the office DECLARED in the "Taken by" dropdown (not a
 * signed-in identity: /pay/office has no staff session), or null. Two sources,
 * both read 23 Sep 2026 (Gabbai A3): auth_user id + username + first name, AND
 * rows that person already created in the CRM - goldy=2 (30 payments, 333
 * hotel notes), Hershy=3 (57 payments), sgrunfeld=7 (866 hotel notes).
 * joseph=10 has created no CRM row, so the second source fails and he maps to
 * null; Richter has no CRM user. The note text still names whoever was declared.
 */
export const REP_USER_IDS = Object.freeze({ goldie: 2, goldy: 2, hershy: 3, sruly: 7 });
export function repUserId(name) {
  const k = String(name || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(REP_USER_IDS, k) ? REP_USER_IDS[k] : null;
}

/**
 * CRM method for a paid Mercury invoice. "mercury" is not a choice in the CRM
 * (Payment / JRMHotelPayment method choices: cash card bank zelle check other
 * points seller_credit), and the AR invoice never says HOW it was paid. When
 * the invoice offered ACH only, the only way it could be paid is a bank debit;
 * otherwise it is honestly "other" and the note says Mercury pay link.
 * Going forward only: rows already written are previewed, never rewritten.
 */
export function mercuryMethod(inv = {}) {
  return inv.creditCardEnabled === false && inv.achDebitEnabled !== false ? "bank" : "other";
}

function describeChannel(inv, channel = "mercury") {
  const amount = Number(inv.amount);
  const amt = Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
  if (channel === "nmi") {
    const txn = String(inv.id || "").trim() || "unknown";
    const mark = nmiMarker(txn);
    const last4 = /^\d{4}$/.test(String(inv.cardLast4 || "")) ? String(inv.cardLast4) : "";
    const rep = String(inv.rep || "").trim().slice(0, 40);
    const extra = `${last4 ? ` card ending ${last4}` : ""}${rep ? `, taken by ${rep}` : ""}`;
    // THE NOTE SAYS IT IS ALREADY RECORDED (audit #28, 25 Sep): the office learned to type a card payment
    // in by hand when it saw an "NMI card" note; this note is written WITH the payment row, so it says so.
    // A booking whose pay link also made a Mercury invoice gets the old instruction back (audit #74):
    // the Mercury invoice stays open until someone marks it PAID - never cancelled.
    const said = `Card payment $${amt} USD recorded in the CRM automatically (NMI txn ${txn}) - do not enter it again.`;
    const merc = inv.mercuryLink ? " Mark the Mercury invoice PAID, never cancel." : "";
    return {
      marker: mark,
      method: "card",
      cardLast4: last4,
      createdById: repUserId(rep),
      paymentReference: `${inv.invoiceNumber} ${mark}`,
      paymentNote: `${said}${extra}`,
      staffNote: `${said}${extra}${merc}`,
      reservationPaymentNotes: `${said}${extra} ${mark}`,
      reservationAppend: `\n${said}${merc}`,
    };
  }
  const mark = marker(inv);
  return {
    marker: mark,
    method: mercuryMethod(inv),
    cardLast4: "",
    createdById: null,
    paymentReference: `Mercury ${inv.invoiceNumber} ${mark}`,
    paymentNote: `[Mercury sync] Invoice ${inv.invoiceNumber} paid $${amt} USD via Mercury pay link (card or ACH bank debit — Mercury does not disclose which).`,
    staffNote: `[Mercury sync] PAID $${amt} USD — invoice ${inv.invoiceNumber}. Payment recorded; reserve with the hotel and confirm to the guest.`,
    reservationPaymentNotes: `[Mercury sync] Invoice ${inv.invoiceNumber} paid via Mercury pay link (card or ACH bank debit — Mercury does not disclose which). ${mark}`,
    reservationAppend: `\n[Mercury sync] PAID $${amt} USD — invoice ${inv.invoiceNumber}.`,
  };
}

function paidAtOf(inv) {
  const t = inv.paidAt || inv.paidDate || inv.updatedAt || null;
  const d = t ? new Date(t) : new Date();
  return isNaN(d.getTime()) ? new Date() : d;
}

async function recordHotelPayment(pool, inv, target, out, channel = "mercury", { strict = channel === "nmi" } = {}) {
  // strict = the new posting path (anchored marker, conflicts go to review).
  // strict false on channel "nmi" = the legacy office writer, byte-for-byte
  // the 6133cd2 rules, which keeps the real CRM writes while shadow runs.
  const amount = Number(inv.amount);
  const ch = describeChannel(inv, channel);
  // Already recorded by a previous sync run?
  const dup = await pool.query(
    strict
      ? `SELECT id, request_id, amount, currency FROM core_jrmhotelpayment WHERE reference ~ $1 LIMIT 1`
      : `SELECT id FROM core_jrmhotelpayment WHERE reference LIKE $1 LIMIT 1`,
    [strict ? `(^|[[:space:]])${ch.marker}($|[[:space:]])` : `%${ch.marker}%`]
  );
  if (dup.rows.length) {
    if (strict && (Number(dup.rows[0].request_id) !== target.requestId || Math.round(Number(dup.rows[0].amount) * 100) !== Math.round(amount * 100) || !['USD', 'US$', '$'].includes(String(dup.rows[0].currency || '').trim().toUpperCase()))) {
      out.errors.push("legacy_transaction_conflict");
      return;
    }
    out.skipped.push(`${inv.invoiceNumber}: already synced`);
    return;
  }
  // Same amount already entered by staff? Don't double-count.
  const manual = await pool.query(
    `SELECT id FROM core_jrmhotelpayment
     WHERE request_id = $1 AND ABS(amount - $2) < 0.01
       ${strict ? "AND COALESCE(reference, '') !~ '(mercury|nmi):[A-Za-z0-9_-]+'" : ""} LIMIT 1`,
    [target.requestId, amount]
  );
  if (manual.rows.length) {
    out.skipped.push(
      `${inv.invoiceNumber}: same-amount payment already on request #${target.requestId} (manual?) — not duplicated`
    );
    return;
  }
  // Offer sanity: only attach offer_id when it belongs to this request
  let offerId = null;
  if (target.offerId) {
    const off = await pool.query(
      `SELECT request_id FROM core_jrmhoteloffer WHERE id = $1`,
      [target.offerId]
    );
    if (off.rows.length && Number(off.rows[0].request_id) === target.requestId) {
      offerId = target.offerId;
    } else if (strict) {
      out.errors.push("hotel_offer_mismatch");
      return;
    }
  }
  const req = await pool.query(
    `SELECT id FROM core_jrmhotelrequest WHERE id = $1`,
    [target.requestId]
  );
  if (!req.rows.length) {
    out.errors.push(`${inv.invoiceNumber}: hotel request #${target.requestId} not found`);
    return;
  }
  await pool.query(
    `INSERT INTO core_jrmhotelpayment
       (payment_date, amount, currency, method, reference, note, created_at,
        created_by_id, offer_id, request_id, card_last4)
     VALUES ($1, $2, 'USD', $3, $4, $5, NOW(), $8, $6, $7, $9)`,
    [
      paidAtOf(inv),
      amount,
      ch.method,
      ch.paymentReference,
      ch.paymentNote,
      offerId,
      target.requestId,
      ch.createdById,
      ch.cardLast4,
    ]
  );
  await pool.query(
    `INSERT INTO core_jrmhotelnote (note, created_at, created_by_id, request_id)
     VALUES ($1, NOW(), $3, $2)`,
    [ch.staffNote, target.requestId, ch.createdById]
  );
  out.recorded.push(`${inv.invoiceNumber}: $${amount.toFixed(2)} → hotel request #${target.requestId}`);
}

async function recordReservationPayment(pool, inv, target, out, channel = "mercury", inTransaction = false, { strict = channel === "nmi" } = {}) {
  const amount = Number(inv.amount);
  const ch = describeChannel(inv, channel);
  const dup = await pool.query(
    strict
      ? `SELECT id, reservation_id, amount FROM core_payment WHERE notes ~ $1 LIMIT 1`
      : `SELECT id FROM core_payment WHERE notes LIKE $1 LIMIT 1`,
    [strict ? `(^|[[:space:]])${ch.marker}($|[[:space:]])` : `%${ch.marker}%`]
  );
  if (dup.rows.length && !strict) {
    out.skipped.push(`${inv.invoiceNumber}: already synced`);
    return;
  }
  const res = await pool.query(
    `SELECT id, amount_paid FROM core_reservation
     WHERE UPPER(regexp_replace(reservation_code, '[^A-Za-z0-9_-]', '', 'g')) = $1`,
    [target.code]
  );
  if (res.rows.length !== 1) {
    out.errors.push(
      `${inv.invoiceNumber}: ${res.rows.length} reservations match code ${target.code} — not recorded`
    );
    return;
  }
  const reservationId = Number(res.rows[0].id);
  if (dup.rows.length) {
    if (Number(dup.rows[0].reservation_id) !== reservationId || Math.round(Number(dup.rows[0].amount) * 100) !== Math.round(amount * 100)) {
      out.errors.push("legacy_transaction_conflict");
    } else out.skipped.push(`${inv.invoiceNumber}: already synced`);
    return;
  }
  // The Mercury path's same-amount check COUNTS machine-marker rows (nmi:, mercury:) as already there:
  // that is what makes "mark the Mercury invoice PAID, never cancel" safe - the invoice the office marks
  // PAID after a card payment is not posted a second time (Gabbai 25 Sep B1; audit #76 stays open).
  const manual = await pool.query(
    `SELECT id FROM core_payment
     WHERE reservation_id = $1 AND ABS(amount - $2) < 0.01
       ${strict ? "AND COALESCE(notes, '') !~ '(mercury|nmi):[A-Za-z0-9_-]+'" : ""} LIMIT 1`,
    [reservationId, amount]
  );
  if (manual.rows.length) {
    out.skipped.push(
      `${inv.invoiceNumber}: same-amount payment already on reservation #${reservationId} (manual?) — not duplicated`
    );
    return;
  }
  const client = inTransaction ? pool : await pool.connect();
  try {
    if (!inTransaction) await client.query("BEGIN");
    await client.query(
      `INSERT INTO core_payment
         (amount, method, paid_at, notes, created_at, created_by_id,
          reservation_id, cash_location, cash_location_other,
          points_account_id, points_qty, transfer_details, zelle_address,
          points_cost_per_point)
       VALUES ($1, $2, $3, $4, NOW(), $6, $5, '', '', NULL, 0, '', '', 0)`,
      [
        amount,
        ch.method,
        paidAtOf(inv),
        ch.reservationPaymentNotes,
        reservationId,
        ch.createdById,
      ]
    );
    await client.query(
      `UPDATE core_reservation
       SET amount_paid = COALESCE(amount_paid, 0) + $1,
           notes = COALESCE(notes,'') || $2,
           updated_at = NOW()
       WHERE id = $3`,
      [amount, ch.reservationAppend, reservationId]
    );
    if (!inTransaction) await client.query("COMMIT");
  } catch (e) {
    if (!inTransaction) { try { await client.query("ROLLBACK"); } catch { /* ignore */ } }
    throw e;
  } finally {
    if (!inTransaction) client.release();
  }
  out.recorded.push(`${inv.invoiceNumber}: $${amount.toFixed(2)} → reservation #${reservationId}`);
}

/**
 * Card sale -> CRM payment row. Same inserts as Mercury sync, marker nmi:<txn>.
 * Notes never carry [Mercury Pay] / [Mercury sync]. Idempotent on the marker.
 */
function nmiInput({ invoiceNumber, amountUsd, transactionId, paidAt, cardLast4, rep }) {
  const target = parseInvoiceNumber(invoiceNumber);
  if (!target || (target.kind !== "hotel" && target.kind !== "reservation")) {
    return { error: "unrecognized invoice number pattern" };
  }
  const amount = Number(amountUsd);
  if (!Number.isFinite(amount) || !(amount > 0)) return { error: "amount" };
  return {
    target,
    brand: target.kind === "hotel" ? "jrm" : "nesher",
    inv: {
      id: String(transactionId || "").trim(),
      invoiceNumber: String(invoiceNumber || "").trim(),
      amount,
      paidAt: paidAt || new Date().toISOString(),
      cardLast4: /^\d{4}$/.test(String(cardLast4 || "")) ? String(cardLast4) : "",
      rep: String(rep || "").trim().slice(0, 40),
    },
  };
}

/** The new path's CRM write, shared by live posting and the shadow plan. */
function nmiWrite({ target, inv }, reviewReason) {
  return async (client, result) => {
    if (reviewReason) {
      result.errors.push(["invoice_transaction_conflict", "invoice_amount_mismatch", "invoice_reference_missing"].includes(reviewReason) ? reviewReason : "review_required");
      return;
    }
    // A transaction imported before the event table existed may already be
    // recorded under the other brand. Preserve it for review, never copy it.
    const other = await client.query(target.kind === "hotel"
      ? `SELECT id FROM core_payment WHERE notes ~ $1 LIMIT 1`
      : `SELECT id FROM core_jrmhotelpayment WHERE reference ~ $1 LIMIT 1`,
    [`(^|[[:space:]])nmi:${inv.id}($|[[:space:]])`]);
    if (other.rows.length) {
      result.errors.push("legacy_transaction_conflict");
      return;
    }
    const withLink = { ...inv, mercuryLink: await hasMercuryPayLink(client, inv.invoiceNumber) };
    if (target.kind === "hotel") await recordHotelPayment(client, withLink, target, result, "nmi");
    else await recordReservationPayment(client, withLink, target, result, "nmi", true);
  };
}

/** Audit #74: did a pay link for this CRM reference also make a Mercury invoice? A read inside the
 *  posting transaction; a CRM without the pay-link table (tests) answers no without aborting it. */
async function hasMercuryPayLink(client, invoiceNumber) {
  const ref = String(invoiceNumber || "").trim();
  if (!ref) return false;
  const t = await client.query(`SELECT to_regclass('public.nesher_pay_invoices') IS NOT NULL AS ok`);
  if (!t.rows?.[0]?.ok) return false;
  const r = await client.query(`SELECT 1 AS hit FROM nesher_pay_invoices
    WHERE lower(payload->>'invoiceNumber') = lower($1) AND COALESCE(payload->>'mercuryUrl', '') <> '' LIMIT 1`, [ref]);
  return Boolean(r.rows?.length);
}

/** LIVE mode: post a confirmed card payment exactly once (ledger first). */
export async function recordNmiPaidInvoice({
  pool,
  invoiceNumber,
  amountUsd,
  transactionId,
  paidAt,
  reviewReason,
  path,
  cardLast4,
  rep,
} = {}) {
  const input = nmiInput({ invoiceNumber, amountUsd, transactionId, paidAt, cardLast4, rep });
  if (input.error) return { ok: false, recorded: [], skipped: [], errors: [input.error] };
  const { inv, brand } = input;
  const out = await postConfirmedPayment({
    pool, invoiceNumber: inv.invoiceNumber, amountUsd: inv.amount, transactionId: inv.id,
    paidAt: inv.paidAt, brand, path, cardLast4: inv.cardLast4, rep: inv.rep,
    write: nmiWrite(input, reviewReason),
  });
  // A LIVE SALE THAT WENT TO REVIEW LEAVES A TRACE ON THE BOOKING (audit #75, 25 Sep): the review
  // rolled the payment's own note back with it, so the booking showed neither the money nor a word.
  // One staff note, in its own write, only on the pending -> review transition (so once per sale).
  if (out && out.newlyReviewed) {
    try { out.reviewNote = await writeReviewNote(pool, input, out.errors && out.errors[0]); } catch { out.reviewNote = false; }
  }
  return out;
}

// Gabbai 25 Sep D2: the note's instruction CHECKS first, and money already on another booking is never
// "entered" again. Pinned by the table scan in test/money-loop.test.js.
export const NOTE_REASON_WORDS = Object.freeze({
  manual_payment_requires_review: "received and NOT recorded automatically: a payment of the same amount is already typed on this booking. If that is this card payment, nothing to enter; if it is not, enter it.",
  invoice_transaction_conflict: "received and NOT recorded automatically: the pay link was already paid by another card transaction. Check the booking; if this is a duplicate charge, it needs a refund.",
  invoice_amount_mismatch: "received and NOT recorded automatically: the amount differs from what the pay link asked for. If the booking does not show what came in, enter it.",
  legacy_transaction_conflict: "is already recorded on another booking in the CRM, so it was NOT added here. Do not enter it twice; check which booking is right.",
  hotel_offer_mismatch: "received and NOT recorded automatically: the hotel offer belongs to another request. Check which request it belongs to, and enter it there if it is not already there.",
  other: "received and NOT recorded automatically: the CRM could not match it by itself. If the booking does not show it, enter it.",
});
export function reviewNoteText(amountUsd, txn, reason) {
  const said = NOTE_REASON_WORDS[String(reason || "")] || NOTE_REASON_WORDS.other;
  return `Card payment $${Number(amountUsd).toFixed(2)} USD (NMI txn ${txn}) ${said}`;
}
/** The staff note for a live sale the loop could not record. Only when the booking is found. */
async function writeReviewNote(pool, { target, inv }, reason) {
  const note = reviewNoteText(inv.amount, inv.id, reason);
  if (target.kind === "hotel") {
    const req = await pool.query(`SELECT id FROM core_jrmhotelrequest WHERE id = $1`, [target.requestId]);
    if (!req.rows.length) return false;
    await pool.query(`INSERT INTO core_jrmhotelnote (note, created_at, created_by_id, request_id) VALUES ($1, NOW(), NULL, $2)`, [note, target.requestId]);
    return true;
  }
  const res = await pool.query(`SELECT id FROM core_reservation WHERE UPPER(regexp_replace(reservation_code, '[^A-Za-z0-9_-]', '', 'g')) = $1`, [target.code]);
  if (res.rows.length !== 1) return false;
  await pool.query(`UPDATE core_reservation SET notes = COALESCE(notes,'') || $1, updated_at = NOW() WHERE id = $2`, [`\n${note}`, Number(res.rows[0].id)]);
  return true;
}

/**
 * SHADOW mode's real writer for the office CRM-ref charge: the 6133cd2 rules
 * unchanged (LIKE marker, same-amount skip, offer dropped when it does not
 * belong), plus the rep and last four going forward. No ledger here.
 */
export async function recordNmiPaidInvoiceLegacy({
  pool,
  invoiceNumber,
  amountUsd,
  transactionId,
  paidAt,
  cardLast4,
  rep,
} = {}) {
  const out = { ok: false, recorded: [], skipped: [], errors: [] };
  const input = nmiInput({ invoiceNumber, amountUsd, transactionId, paidAt, cardLast4, rep });
  if (input.error) {
    out.errors.push(input.error);
    return out;
  }
  const inv = { ...input.inv, id: input.inv.id || "unknown" };
  if (input.target.kind === "hotel") {
    await recordHotelPayment(pool, inv, input.target, out, "nmi", { strict: false });
  } else {
    await recordReservationPayment(pool, inv, input.target, out, "nmi", false, { strict: false });
  }
  out.ok = out.errors.length === 0;
  return out;
}

/**
 * SHADOW mode observer: ledger row + what the new path WOULD post, planned by
 * the same nmiWrite against a capture client in a READ ONLY transaction.
 * ev = {invoiceNumber, amountUsd, transactionId, paidAt, path, brand?,
 * cardLast4?, rep?, decision:{action:'post'|'exception', reason?}}.
 */
export async function shadowNmiPayment({ pool, ...ev } = {}) {
  const input = nmiInput(ev);
  const brand = input.brand || (["nesher", "jrm"].includes(ev.brand) ? ev.brand : null);
  if (!brand) return { ok: false, error: "brand_unknown" };
  const decision = input.error
    ? { action: "exception", reason: ev.decision?.reason || "no_crm_reference" }
    : ev.decision || { action: "post" };
  return observeShadowPayment({
    pool,
    ev: { ...ev, brand, decision, amountUsd: Number(ev.amountUsd) },
    write: input.error ? null : nmiWrite(input, null),
  });
}

/**
 * A REFUND OR VOID SENT FROM THE DESK CHAT (24 Sep, Joseph: "connect with my processor and make
 * refunds"). The money went back at the processor; this records it against the CRM payment the
 * SALE is on, through the same ledger door as every sale (postConfirmedPayment: ledger row first,
 * exactly once per key, one transaction), as its OWN negative row. The sale's row is never edited.
 *
 * The sale's CRM row is found by its marker - `nmi:<saleTxn>` in core_payment.notes (the collection
 * loop's rows and the hand-entered rows linked on 24 Sep) or in core_jrmhotelpayment.reference. No
 * such row = the sale was never recorded in the CRM, so there is nothing to reverse there and a
 * negative row would make the booking's paid total wrong: it is kept for review instead.
 *
 * key: the refund's own transaction id, or "void_<saleTxn>" for a void (a void has no new id).
 */
export async function recordNmiReversal({ pool, kind = "refund", saleTxn, reversalTxn, amountUsd, brand, orderId, rep, cardLast4, at, origin } = {}) {
  const sale = String(saleTxn || "").trim();
  const isVoid = kind === "void";
  const key = isVoid ? `void_${sale}` : String(reversalTxn || "").trim();
  const amount = Number(amountUsd);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(sale) || !/^[A-Za-z0-9_-]{1,80}$/.test(key)) return { ok: false, state: "not_recorded", errors: ["transaction_id_required"] };
  if (!(amount > 0)) return { ok: false, state: "not_recorded", errors: ["invalid_amount"] };
  const target = parseInvoiceNumber(orderId);
  const b = ["nesher", "jrm"].includes(brand) ? brand : target ? (target.kind === "hotel" ? "jrm" : "nesher") : null;
  if (!b) return { ok: false, state: "not_recorded", errors: ["brand_unknown"] };
  const last4 = /^\d{4}$/.test(String(cardLast4 || "")) ? String(cardLast4) : "";
  const who = String(rep || "").trim().slice(0, 40);
  const amt = amount.toFixed(2);
  const mark = `${isVoid ? "nmi-void" : "nmi-refund"}:${isVoid ? sale : key}`;
  // origin "processor" (audit #26): found by the recovery sweep - done in the processor's portal, not the desk chat.
  const fromWhere = origin === "processor" ? ", done in the processor's portal (found by the payment sweep)" : who ? `, sent by ${who} from the desk chat` : "";
  const words = `${isVoid ? "VOID" : "REFUND"} of NMI card sale txn ${sale}: -$${amt} USD${isVoid ? "" : ` (refund txn ${key})`}${last4 ? `, card ending ${last4}` : ""}${fromWhere}.`;
  // Gabbai 24 Sep C7: the cash went back; whether the PRICE came down too (a cancellation) is a person's
  // call, in the CRM's own Refund entry. Said on the note, or the booking shows the amount as due again.
  const cancelWords = (where) => `If this was a cancellation, add the refund on ${where} in the CRM, or it will show $${amt} due.`;
  const markRe = `(^|[[:space:]])${mark}($|[[:space:]])`;
  const saleRe = `(^|[[:space:]])nmi:${sale}($|[[:space:]])`;
  const write = async (client, out) => {
    const done = await client.query(`SELECT id FROM core_payment WHERE notes ~ $1 UNION ALL SELECT id FROM core_jrmhotelpayment WHERE reference ~ $1 LIMIT 1`, [markRe]);
    if (done.rows.length) { out.skipped.push(`${mark}: already synced`); return; }
    const res = await client.query(`SELECT id, reservation_id, method FROM core_payment WHERE notes ~ $1 ORDER BY id LIMIT 2`, [saleRe]);
    const hot = await client.query(`SELECT id, request_id, offer_id, method FROM core_jrmhotelpayment WHERE reference ~ $1 ORDER BY id LIMIT 2`, [saleRe]);
    if (res.rows.length + hot.rows.length === 0) { out.errors.push("sale_not_in_crm"); return; }
    if (res.rows.length + hot.rows.length > 1) { out.errors.push("sale_on_two_crm_rows"); return; }
    const by = repUserId(who);
    if (res.rows.length) {
      const r = res.rows[0];
      await client.query(
        `INSERT INTO core_payment
           (amount, method, paid_at, notes, created_at, created_by_id,
            reservation_id, cash_location, cash_location_other,
            points_account_id, points_qty, transfer_details, zelle_address,
            points_cost_per_point)
         VALUES ($1, $2, $3, $4, NOW(), $6, $5, '', '', NULL, 0, '', '', 0)`,
        [-amount, r.method || "card", at ? new Date(at) : new Date(), `${words} ${mark}`, Number(r.reservation_id), by]
      );
      await client.query(
        `UPDATE core_reservation SET amount_paid = COALESCE(amount_paid, 0) - $1, notes = COALESCE(notes,'') || $2, updated_at = NOW() WHERE id = $3`,
        [amount, `\n${words} ${cancelWords("the booking")}`, Number(r.reservation_id)]
      );
      out.recorded.push(`${mark}: -$${amt} -> reservation #${r.reservation_id}`);
      return;
    }
    const h = hot.rows[0];
    await client.query(
      `INSERT INTO core_jrmhotelpayment
         (payment_date, amount, currency, method, reference, note, created_at,
          created_by_id, offer_id, request_id, card_last4)
       VALUES ($1, $2, 'USD', $3, $4, $5, NOW(), $6, $7, $8, $9)`,
      [at ? new Date(at) : new Date(), -amount, h.method || "card", `${String(orderId || "").trim() || "NMI"} ${mark}`.trim(), words, by, h.offer_id == null ? null : Number(h.offer_id), Number(h.request_id), last4]
    );
    await client.query(
      `INSERT INTO core_jrmhotelnote (note, created_at, created_by_id, request_id) VALUES ($1, NOW(), $3, $2)`,
      [`${words} ${cancelWords(`hotel request #${h.request_id}`)}`, Number(h.request_id), by]
    );
    out.recorded.push(`${mark}: -$${amt} -> hotel request #${h.request_id}`);
  };
  return postConfirmedPayment({
    pool, invoiceNumber: String(orderId || "").trim() || `NMI-${sale}`, amountUsd: amount, transactionId: key,
    paidAt: at || new Date().toISOString(), brand: b, path: origin === "processor" ? "recovery" : "chat", cardLast4: last4, rep: who, kind: "refund", write,
  });
}

async function ledgerRow(pool, txn) {
  const r = await pool.query(`SELECT transaction_id, invoice_number, amount_cents, brand, state, kind
    FROM nesher_money_payment_posts WHERE transaction_id = $1`, [String(txn)]);
  return r.rows?.[0] || null;
}

/**
 * A VOID OR REFUND DONE OUTSIDE THE DESK CHAT (audit #26, 25 Sep). The recovery sweep sees the
 * processor's record; until now a portal void or refund only bumped a hidden counter, so a booking
 * kept showing money that went back.
 *
 * It reverses ONLY what the loop itself wrote: the SALE's ledger row must be state 'posted' (the loop's
 * own CRM row, since the flip to live). Then the minus row goes through recordNmiReversal - the same
 * idempotent door the desk chat's refunds use (key void_<sale> / the refund's own id), which also
 * checks the sale's nmi:<txn> row is in the CRM. Anything else is kept for a person:
 *   - a void of a sale still PENDING (CRM write not done yet) -> the sale goes to review, never posted;
 *   - a void or refund of a sale the loop never posted (hand rows, shadow era) -> review, named after
 *     the sale (NMI-<sale txn> or its booking) so a person can find it.
 * ev = the sweep's event + {reversal:'void'|'refund', originalTransactionId, reversedAt}.
 */
export async function recordSweepReversal({ pool, ...ev } = {}) {
  await ensureLedger(pool);
  if (ev.reversal === "void") {
    const sale = await ledgerRow(pool, ev.transactionId);
    const already = await ledgerRow(pool, `void_${ev.transactionId}`);
    if (already) return { ok: already.state === "posted", reversal: already.state === "posted", durable: true, state: already.state, recorded: [], skipped: [`void_${ev.transactionId}: already synced`], errors: [], needsReview: already.state !== "posted" };
    if (sale && sale.state === "posted" && (sale.kind || "sale") === "sale") {
      const r = await recordNmiReversal({ pool, kind: "void", saleTxn: ev.transactionId, amountUsd: Number(sale.amount_cents) / 100,
        brand: sale.brand, orderId: sale.invoice_number, cardLast4: ev.cardLast4, at: ev.reversedAt || undefined, origin: "processor" });
      return { ...r, reversal: true };
    }
    if (sale && sale.state === "pending") {
      await pool.query(`UPDATE nesher_money_payment_posts SET state = 'review', reason = 'sale_voided_before_posting', updated_at = NOW()
        WHERE transaction_id = $1 AND state = 'pending'`, [String(ev.transactionId)]);
      return { ok: false, durable: true, state: "review", needsReview: true, recorded: [], skipped: [], errors: ["sale_voided_before_posting"] };
    }
    return recordNmiException({ pool, ...ev, reason: "sale_voided" });
  }
  // a refund transaction
  const own = await ledgerRow(pool, ev.transactionId);
  if (own) return recordNmiException({ pool, ...ev, invoiceNumber: own.invoice_number, brand: own.brand, reason: "reversal_requires_review" });
  const orig = String(ev.originalTransactionId || "").trim();
  const sale = /^[A-Za-z0-9_-]{1,64}$/.test(orig) ? await ledgerRow(pool, orig) : null;
  if (sale && sale.state === "posted" && (sale.kind || "sale") === "sale" && !ev.refundVoided) {
    const r = await recordNmiReversal({ pool, kind: "refund", saleTxn: orig, reversalTxn: ev.transactionId, amountUsd: ev.amountUsd,
      brand: sale.brand, orderId: sale.invoice_number, cardLast4: ev.cardLast4, at: ev.paidAt, origin: "processor" });
    return { ...r, reversal: true };
  }
  return recordNmiException({ pool, ...ev,
    invoiceNumber: sale?.invoice_number || (orig ? `NMI-${orig}` : ev.invoiceNumber),
    brand: sale?.brand || ev.brand,
    // Gabbai 25 Sep D2: a refund voided at the processor moved no money - its own reason, "nothing to change".
    reason: ev.refundVoided ? "refund_voided" : orig ? "refund_outside_chat" : "reversal_requires_review" });
}

/** LIVE mode exception door (never a CRM write). */
export async function recordNmiException({ pool, reason, brand, ...ev } = {}) {
  const input = nmiInput(ev);
  const b = input.brand || (["nesher", "jrm"].includes(brand) ? brand : null);
  if (!b) return { ok: false, durable: false, errors: ["brand_unknown"] };
  return recordPaymentException({ pool, ...ev, brand: b, reason });
}

/**
 * One sync pass. Never throws for a single bad invoice — collects per-invoice
 * results so one failure cannot stall the rest.
 */
export async function syncPaidInvoices({ token, pool, fetchImpl, listInvoices }) {
  const rawFetch = fetchImpl || fetch;
  const doFetch = (url, init = {}) =>
    fetchWithTimeout(url, { timeoutMs: 15000, ...init }, rawFetch);
  const out = { checked: 0, recorded: [], skipped: [], errors: [], at: new Date().toISOString(), source: listInvoices ? "money-seat" : "mercury-api" };

  let invoices;
  if (typeof listInvoices === "function") {
    // Plan 17.4: the AR listing read through the money seat's outbound hop
    // (no tunnel, no inbound port). A failed or partial read is an error for
    // this cycle, never an empty "nothing paid".
    try {
      invoices = await listInvoices();
    } catch (e) {
      out.errors.push(`Invoice source failed: ${String(e?.message || e).slice(0, 80)}`);
      return out;
    }
    if (!Array.isArray(invoices)) {
      out.errors.push("Invoice source failed: invalid");
      return out;
    }
  } else {
    const t = normalizeToken(token);
    if (!t) {
      out.errors.push("MERCURY_TOKEN missing");
      return out;
    }
    const listRes = await doFetch(`${mercuryApiBase()}/ar/invoices`, {
      headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
    });
    if (!listRes.ok) {
      out.errors.push(`Mercury list failed: ${listRes.status}`);
      return out;
    }
    invoices = (await listRes.json()).invoices || [];
  }
  const paid = invoices.filter(
    (i) => String(i.status || "").toLowerCase() === "paid"
  );
  out.checked = paid.length;

  for (const inv of paid) {
    try {
      if (!(Number(inv.amount) > 0)) {
        out.skipped.push(`${inv.invoiceNumber}: zero amount`);
        continue;
      }
      const target = parseInvoiceNumber(inv.invoiceNumber);
      if (!target) {
        out.skipped.push(`${inv.invoiceNumber}: unrecognized invoice number pattern`);
        // Audit #144: a paid FLY- flight pay link has no CRM writer yet - kept for a person, never dropped.
        if (/^FLY-/i.test(String(inv.invoiceNumber || "").trim())) {
          try { await keepMercuryForReview(pool, inv, "nesher", "flight_link_not_wired"); } catch { /* the skip line reports it */ }
        }
        continue;
      }
      if (target.kind === "hotel") {
        await recordHotelPayment(pool, inv, target, out);
      } else {
        await recordReservationPayment(pool, inv, target, out);
      }
    } catch (e) {
      out.errors.push(`${inv.invoiceNumber}: ${e.message}`);
    }
  }
  return out;
}

/** A paid Mercury invoice the sync will not write, kept once as a ledger review row (never a CRM write). */
async function keepMercuryForReview(pool, inv, brand, reason) {
  const id = String(inv.id || "").trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return null;
  return recordPaymentException({ pool, invoiceNumber: String(inv.invoiceNumber || "").trim(), amountUsd: Number(inv.amount),
    transactionId: `mercury_${id}`, paidAt: paidAtOf(inv).toISOString(), brand, reason, kind: "sale" });
}

/**
 * The paid-invoice listing through the money seat's hop (plan 17.4). The seat
 * reads Mercury AR from Joseph's PC with its own token and answers only the
 * minimal fields; this throws on anything but a clean, complete answer.
 */
export async function listInvoicesViaSeat(hop) {
  if (!hop || typeof hop.read !== "function") throw new Error("seat_unavailable");
  const r = await hop.read("/invoices");
  if (!r || r.status !== 200) throw new Error(`seat_${r?.status || "no_answer"}`);
  let body;
  try {
    body = JSON.parse(r.body);
  } catch {
    throw new Error("seat_invalid");
  }
  if (!body || !Array.isArray(body.invoices) || body.complete !== true) throw new Error("seat_incomplete");
  const seen = new Set();
  for (const inv of body.invoices) {
    if (!inv || typeof inv.id !== "string" || !inv.id || seen.has(inv.id)) throw new Error("seat_bad_invoice");
    seen.add(inv.id);
  }
  return body.invoices;
}
