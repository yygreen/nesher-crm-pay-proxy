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

function paidAtOf(inv) {
  const t = inv.paidAt || inv.paidDate || inv.updatedAt || null;
  const d = t ? new Date(t) : new Date();
  return isNaN(d.getTime()) ? new Date() : d;
}

async function recordHotelPayment(pool, inv, target, out) {
  const amount = Number(inv.amount);
  // Already recorded by a previous sync run?
  const dup = await pool.query(
    `SELECT id FROM core_jrmhotelpayment WHERE reference LIKE $1 LIMIT 1`,
    [`%${marker(inv)}%`]
  );
  if (dup.rows.length) {
    out.skipped.push(`${inv.invoiceNumber}: already synced`);
    return;
  }
  // Same amount already entered by staff? Don't double-count.
  const manual = await pool.query(
    `SELECT id FROM core_jrmhotelpayment
     WHERE request_id = $1 AND ABS(amount - $2) < 0.01 LIMIT 1`,
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
     VALUES ($1, $2, 'USD', 'card', $3, $4, NOW(), NULL, $5, $6, '')`,
    [
      paidAtOf(inv),
      amount,
      `Mercury ${inv.invoiceNumber} ${marker(inv)}`,
      `[Mercury sync] Invoice ${inv.invoiceNumber} paid $${amount.toFixed(2)} USD via Mercury pay link.`,
      offerId,
      target.requestId,
    ]
  );
  await pool.query(
    `INSERT INTO core_jrmhotelnote (note, created_at, created_by_id, request_id)
     VALUES ($1, NOW(), NULL, $2)`,
    [
      `[Mercury sync] PAID $${amount.toFixed(2)} USD — invoice ${inv.invoiceNumber}. Payment recorded; reserve with the hotel and confirm to the guest.`,
      target.requestId,
    ]
  );
  out.recorded.push(`${inv.invoiceNumber}: $${amount.toFixed(2)} → hotel request #${target.requestId}`);
}

async function recordReservationPayment(pool, inv, target, out) {
  const amount = Number(inv.amount);
  const dup = await pool.query(
    `SELECT id FROM core_payment WHERE notes LIKE $1 LIMIT 1`,
    [`%${marker(inv)}%`]
  );
  if (dup.rows.length) {
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
  const manual = await pool.query(
    `SELECT id FROM core_payment
     WHERE reservation_id = $1 AND ABS(amount - $2) < 0.01 LIMIT 1`,
    [reservationId, amount]
  );
  if (manual.rows.length) {
    out.skipped.push(
      `${inv.invoiceNumber}: same-amount payment already on reservation #${reservationId} (manual?) — not duplicated`
    );
    return;
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO core_payment
         (amount, method, paid_at, notes, created_at, created_by_id,
          reservation_id, cash_location, cash_location_other,
          points_account_id, points_qty, transfer_details, zelle_address,
          points_cost_per_point)
       VALUES ($1, 'card', $2, $3, NOW(), NULL, $4, '', '', NULL, 0, '', '', 0)`,
      [
        amount,
        paidAtOf(inv),
        `[Mercury sync] Invoice ${inv.invoiceNumber} paid via Mercury pay link. ${marker(inv)}`,
        reservationId,
      ]
    );
    await client.query(
      `UPDATE core_reservation
       SET amount_paid = COALESCE(amount_paid, 0) + $1,
           notes = COALESCE(notes,'') || $2,
           updated_at = NOW()
       WHERE id = $3`,
      [
        amount,
        `\n[Mercury sync] PAID $${amount.toFixed(2)} USD — invoice ${inv.invoiceNumber}.`,
        reservationId,
      ]
    );
    await client.query("COMMIT");
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
  out.recorded.push(`${inv.invoiceNumber}: $${amount.toFixed(2)} → reservation #${reservationId}`);
}

/**
 * One sync pass. Never throws for a single bad invoice — collects per-invoice
 * results so one failure cannot stall the rest.
 */
export async function syncPaidInvoices({ token, pool, fetchImpl }) {
  const rawFetch = fetchImpl || fetch;
  const doFetch = (url, init = {}) =>
    fetchWithTimeout(url, { timeoutMs: 15000, ...init }, rawFetch);
  const out = { checked: 0, recorded: [], skipped: [], errors: [], at: new Date().toISOString() };

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
  const invoices = (await listRes.json()).invoices || [];
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
