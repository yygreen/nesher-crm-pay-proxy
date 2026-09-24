// crm-search.js - Mr Money's CRM search (Mr. AQ Money, 24 Sep 2026). READ ONLY.
//
// Joseph, 24 Sep night: "the agent needs to have all the tools and abilities needed to ... whatever can
// help it like search". The desk chat's model asks here for a customer, a traveller, a booking, the
// payments on it and a JRM hotel request - by name, phone, email or booking code, optionally inside a
// date window - so it answers from the CRM instead of telling the rep to go and look.
//
// THE DOOR: GET /__money_hop/crm-search?q=<text>&from=YYYY-MM-DD&to=YYYY-MM-DD, answered HERE through the
// hop's direct hook (the same signature the desk already uses for the bank line and the money map),
// never forwarded to a seat. Unsigned = 401 at the hop, any other method = 405.
//
// WHAT IT CAN NEVER DO: write. Every statement passes isReadOnlySql, runs inside BEGIN READ ONLY and is
// rolled back. Parameterised only - the rep's text is a bind value, never SQL.
// WHAT IT NEVER RETURNS: a note body, a transfer detail, a zelle address, a card or bank number. Text
// fields that do come back (names, emails, phones, codes, hotel names) pass maskDigits, which keeps only
// the last four of any 13+ digit run, so a number typed into a CRM name field still cannot leave.
// Nesher (flights) and JRM (hotels) come back in two separate blocks and are never summed together.

export const CRM_SEARCH_PATH = "/crm-search";
export const CRM_SEARCH_BUILD = "2026-09-24-crm-search";
const LIMIT = 8;
const PAY_LIMIT = 25;

export function isReadOnlySql(sql) {
  return /^\s*(SELECT|WITH|BEGIN READ ONLY|ROLLBACK)\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY)\b/i.test(sql.replace(/'[^']*'/g, ""));
}

/** Any run of 13+ digits (a card is 13-19; a phone is at most 12 here) (spaces or dashes between them allowed) keeps only its last four. */
export function maskDigits(v) {
  if (v == null) return v;
  return String(v).replace(/\d(?:[ -]?\d){12,}/g, (run) => "..." + run.replace(/\D/g, "").slice(-4));
}

function ymd(s) {
  const v = String(s || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + "T00:00:00Z")) ? v : "";
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}
function iso(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v).slice(0, 25) : d.toISOString();
}
function day(v) {
  const s = iso(v);
  return s ? s.slice(0, 10) : null;
}

/** The rep's text -> what to look for. Never throws. */
export function parseQuery(params) {
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(String(params || ""));
  const q = String(p.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const digits = q.replace(/\D/g, "");
  // A phone written the Israeli way (0527...) is stored as +972527...: search without the leading 0.
  const phone = digits.length >= 4 && digits.length <= 15 && !/[A-Za-z֐-׿]/.test(q) ? digits.replace(/^0+/, "") : "";
  const code = /^[A-Za-z0-9-]{5,12}$/.test(q) && /\d/.test(q) && /[A-Za-z]/.test(q) ? q.toUpperCase() : "";
  const words = /[A-Za-z֐-׿]/.test(q) && q.length >= 2 ? q : "";
  return { q, phone, code, words, email: /@/.test(q) ? q.toLowerCase() : "", from: ymd(p.get("from")), to: ymd(p.get("to")) };
}

/** Run the search in ONE read-only transaction that is always rolled back. */
export async function searchCrm(pool, query) {
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  const q = async (sql, params) => {
    if (!isReadOnlySql(sql)) throw new Error("crm_search_refused_write");
    return (await client.query(sql, params)).rows;
  };
  const like = "%" + (query.words || query.email || query.q).replace(/[%_\\]/g, "") + "%";
  const phoneLike = query.phone ? "%" + query.phone + "%" : null;
  const from = query.from || "1900-01-01";
  const to = query.to || "2999-12-31";
  try {
    await q("BEGIN READ ONLY");
    const customers = await q(
      `SELECT c.id, c.full_name, c.email, c.phone, c.created_at
         FROM core_customer c
        WHERE ($1::text <> '' AND (c.full_name ILIKE $2 OR c.email ILIKE $2))
           OR ($3::text IS NOT NULL AND regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') LIKE $3)
        ORDER BY c.created_at DESC NULLS LAST LIMIT ${LIMIT}`,
      [query.words || query.email, like, phoneLike]);
    const travelers = query.words
      ? await q(
          `SELECT t.full_name, t.reservation_id FROM core_traveler t WHERE t.full_name ILIKE $1 ORDER BY t.id DESC LIMIT ${LIMIT}`,
          [like])
      : [];
    const custIds = customers.map((c) => String(c.id));
    const travResIds = travelers.map((t) => String(t.reservation_id)).filter(Boolean);
    const reservations = await q(
      `SELECT r.id, r.reservation_code, r.created_at, r.customer_price::float8 AS customer_price, r.amount_paid::float8 AS amount_paid,
              r.is_closed, r.review_status, r.booked_with_points, r.agent_name, c.full_name AS customer
         FROM core_reservation r LEFT JOIN core_customer c ON c.id = r.customer_id
        WHERE (($1::text <> '' AND upper(r.reservation_code) = $1)
            OR r.customer_id = ANY($2::bigint[]) OR r.id = ANY($3::bigint[]))
        ORDER BY r.created_at DESC NULLS LAST LIMIT ${LIMIT}`,
      [query.code, custIds, travResIds]);
    const resIds = reservations.map((r) => String(r.id));
    const payments = resIds.length
      ? await q(
          `SELECT p.amount::float8 AS amount, p.method, p.paid_at, r.reservation_code,
                  substring(p.notes from 'nmi:([A-Za-z0-9_-]+)') AS nmi_txn
             FROM core_payment p JOIN core_reservation r ON r.id = p.reservation_id
            WHERE p.reservation_id = ANY($1::bigint[]) AND p.paid_at >= $2::date AND p.paid_at < ($3::date + 1)
            ORDER BY p.paid_at DESC LIMIT ${PAY_LIMIT}`,
          [resIds, from, to])
      : [];
    const customerPayments = custIds.length
      ? await q(
          `SELECT cp.amount::float8 AS amount, cp.method, cp.paid_at, cp.imported_from_legacy_payments AS imported, c.full_name AS customer
             FROM core_customerpayment cp JOIN core_customer c ON c.id = cp.customer_id
            WHERE cp.customer_id = ANY($1::bigint[]) AND cp.paid_at >= $2::date AND cp.paid_at < ($3::date + 1)
            ORDER BY cp.paid_at DESC LIMIT ${PAY_LIMIT}`,
          [custIds, from, to])
      : [];
    const refunds = resIds.length
      ? await q(
          `SELECT f.amount_to_customer::float8 AS amount_to_customer, f.amount_received::float8 AS amount_received, f.status, f.refund_type, f.created_at, r.reservation_code
             FROM core_refund f JOIN core_reservation r ON r.id = f.reservation_id
            WHERE f.reservation_id = ANY($1::bigint[]) ORDER BY f.created_at DESC LIMIT ${LIMIT}`,
          [resIds])
      : [];
    const hotelRequests = await q(
      `SELECT h.id, h.customer_name, h.phone, h.email, h.city, h.check_in, h.check_out, h.status, h.requested_hotel, h.created_at
         FROM core_jrmhotelrequest h
        WHERE ($1::text <> '' AND (h.customer_name ILIKE $2 OR h.email ILIKE $2))
           OR ($3::text IS NOT NULL AND regexp_replace(coalesce(h.phone, ''), '[^0-9]', '', 'g') LIKE $3)
           OR h.customer_id = ANY($4::bigint[])
           OR ($5::text <> '' AND ('JRM-' || h.id::text) = $5)
        ORDER BY h.created_at DESC NULLS LAST LIMIT ${LIMIT}`,
      [query.words || query.email, like, phoneLike, custIds, query.code]);
    const reqIds = hotelRequests.map((h) => String(h.id));
    const hotelPayments = reqIds.length
      ? await q(
          `SELECT p.request_id, p.payment_date::text AS payment_date, p.amount::float8 AS amount, p.currency, p.method, p.card_last4
             FROM core_jrmhotelpayment p
            WHERE p.request_id = ANY($1::bigint[]) AND p.payment_date >= $2::date AND p.payment_date <= $3::date
            ORDER BY p.payment_date DESC LIMIT ${PAY_LIMIT}`,
          [reqIds, from, to])
      : [];
    return { customers, travelers, reservations, payments, customerPayments, refunds, hotelRequests, hotelPayments };
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* nothing was written */ }
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

/** Rows -> the one answer shape. An allowlist: nothing leaves that is not named here. */
export function shape(query, rows) {
  const m = maskDigits;
  const resCode = new Map(rows.reservations.map((r) => [String(r.id), r.reservation_code]));
  const payments = rows.payments.map((p) => ({ booking: m(p.reservation_code), amount_usd: num(p.amount), method: p.method || null, paid_on: day(p.paid_at), processor_txn: p.nmi_txn || null }));
  const sum = (list, k) => Math.round(list.reduce((a, x) => a + (Number(x[k]) || 0), 0) * 100) / 100;
  const byCur = {};
  for (const p of rows.hotelPayments) {
    const c = String(p.currency || "").toUpperCase() || "UNKNOWN";
    byCur[c] = Math.round(((byCur[c] || 0) + (Number(p.amount) || 0)) * 100) / 100;
  }
  return {
    ok: true,
    build: CRM_SEARCH_BUILD,
    query: { text: m(query.q), from: query.from || null, to: query.to || null },
    nesher: {
      customers: rows.customers.map((c) => ({ name: m(c.full_name), email: m(c.email), phone: m(c.phone), since: day(c.created_at) })),
      travelers: rows.travelers.map((t) => ({ name: m(t.full_name), booking: m(resCode.get(String(t.reservation_id)) || null) })),
      bookings: rows.reservations.map((r) => ({
        booking: m(r.reservation_code), customer: m(r.customer), created_on: day(r.created_at),
        price_usd: num(r.customer_price), paid_usd: num(r.amount_paid),
        balance_usd: r.customer_price != null && r.amount_paid != null ? num(Number(r.customer_price) - Number(r.amount_paid)) : null,
        closed: r.is_closed === true, review: r.review_status || null, points: r.booked_with_points === true, agent: m(r.agent_name) || null,
      })),
      payments,
      payments_total_usd: sum(payments, "amount_usd"),
      customer_level_payments: rows.customerPayments.map((p) => ({ customer: m(p.customer), amount_usd: num(p.amount), method: p.method || null, paid_on: day(p.paid_at), imported_from_booking_payments: p.imported === true })),
      refunds: rows.refunds.map((f) => ({ booking: m(f.reservation_code), to_customer_usd: num(f.amount_to_customer), received_usd: num(f.amount_received), status: f.status || null, type: f.refund_type || null, on: day(f.created_at) })),
    },
    jrm: {
      hotel_requests: rows.hotelRequests.map((h) => ({ request: "JRM-" + h.id, name: m(h.customer_name), phone: m(h.phone), email: m(h.email), city: h.city || null, check_in: day(h.check_in), check_out: day(h.check_out), status: h.status || null, hotel: m(h.requested_hotel) || null })),
      payments: rows.hotelPayments.map((p) => ({ request: "JRM-" + p.request_id, on: p.payment_date || null, amount: num(p.amount), currency: String(p.currency || "").toUpperCase() || null, method: p.method || null, card_last4: /^\d{4}$/.test(String(p.card_last4 || "")) ? String(p.card_last4) : null })),
      payments_total_by_currency: byCur,
    },
    notes: [
      "Nesher (flights) and JRM (hotels) are separate books - never add them together.",
      "payments_total_usd sums the booking payments listed (capped at " + PAY_LIMIT + " rows); customer_level_payments may repeat money already in payments.",
    ],
  };
}

export function createCrmSearch(opts = {}) {
  const getPool = opts.getPool || (() => null);
  const stats = { calls: 0, errors: 0, last_ms: null, last_at: null };
  async function answer(params) {
    const t0 = Date.now();
    stats.calls++;
    const query = parseQuery(params);
    if (!query.q || query.q.length < 2) return { status: 400, body: { ok: false, error: "query_required" } };
    const pool = getPool();
    if (!pool) return { status: 503, body: { ok: false, error: "not_configured" } };
    try {
      const rows = await searchCrm(pool, query);
      stats.last_ms = Date.now() - t0;
      stats.last_at = new Date().toISOString();
      return { status: 200, body: shape(query, rows) };
    } catch (e) {
      stats.errors++;
      return { status: 500, body: { ok: false, error: /refused_write/.test(String(e && e.message)) ? "refused_write" : "crm_search_failed" } };
    }
  }
  /** The hop's direct hook: sub = "/crm-search?q=...". Never throws, never null. */
  async function hopAnswer(sub) {
    const s = String(sub || "");
    const r = await answer(new URLSearchParams(s.includes("?") ? s.slice(s.indexOf("?") + 1) : ""));
    return { status: r.status, body: JSON.stringify(r.body) };
  }
  function health() {
    return { build: CRM_SEARCH_BUILD, path: "/__money_hop" + CRM_SEARCH_PATH, ...stats };
  }
  return { answer, hopAnswer, health };
}
