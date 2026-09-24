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
import { postConfirmedPayment, observeShadowPayment, recordPaymentException } from "./payment-posts.js";

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
    return {
      marker: mark,
      method: "card",
      cardLast4: last4,
      createdById: repUserId(rep),
      paymentReference: `${inv.invoiceNumber} ${mark}`,
      paymentNote: `NMI card $${amt} USD txn ${txn}.${extra}`,
      staffNote: `NMI card $${amt} USD txn ${txn}.${extra}`,
      reservationPaymentNotes: `NMI card $${amt} USD txn ${txn}.${extra} ${mark}`,
      reservationAppend: `\nNMI card $${amt} USD txn ${txn}.`,
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
    if (target.kind === "hotel") await recordHotelPayment(client, inv, target, result, "nmi");
    else await recordReservationPayment(client, inv, target, result, "nmi", true);
  };
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
  return postConfirmedPayment({
    pool, invoiceNumber: inv.invoiceNumber, amountUsd: inv.amount, transactionId: inv.id,
    paidAt: inv.paidAt, brand, path, cardLast4: inv.cardLast4, rep: inv.rep,
    write: nmiWrite(input, reviewReason),
  });
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
export async function recordNmiReversal({ pool, kind = "refund", saleTxn, reversalTxn, amountUsd, brand, orderId, rep, cardLast4, at } = {}) {
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
  const words = `${isVoid ? "VOID" : "REFUND"} of NMI card sale txn ${sale}: -$${amt} USD${isVoid ? "" : ` (refund txn ${key})`}${last4 ? `, card ending ${last4}` : ""}${who ? `, sent by ${who} from the desk chat` : ""}.`;
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
        [amount, `\n${words}`, Number(r.reservation_id)]
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
      [words, Number(h.request_id), by]
    );
    out.recorded.push(`${mark}: -$${amt} -> hotel request #${h.request_id}`);
  };
  return postConfirmedPayment({
    pool, invoiceNumber: String(orderId || "").trim() || `NMI-${sale}`, amountUsd: amount, transactionId: key,
    paidAt: at || new Date().toISOString(), brand: b, path: "chat", cardLast4: last4, rep: who, kind: "refund", write,
  });
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
