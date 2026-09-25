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
export const CRM_SEARCH_BUILD = "2026-09-25-crm-balance";
const LIMIT = 8;             // travellers, refunds, JRM requests
const CUSTOMER_LIMIT = 8;
const BOOKING_LIMIT = 40;
const PAY_LIMIT = 150;

export function isReadOnlySql(sql) {
  // The one SET allowed is the 6-second timeout itself, exactly (Gabbai AQ B3).
  if (String(sql).trim() === "SET LOCAL statement_timeout = '6s'") return true;
  return /^\s*(SELECT|WITH|BEGIN READ ONLY|ROLLBACK)\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|COPY|SET)\b/i.test(sql.replace(/'[^']*'/g, ""));
}

/**
 * THE CRM'S OWN BALANCE (25 Sep evening; the phone's "Use $X" may offer an amount only from a complete source).
 * Reservation.remaining_balance in the CRM (core/models.py, live 25 Sep) = net_customer_total - total_paid:
 *   total_customer_price = (per_traveler: the trip rows' customer prices when they sum above 0, else the travellers')
 *                          or (total mode: Reservation.customer_price) + the service rows' customer prices;
 *   - refunds to the customer (core_refund.amount_to_customer);
 *   - total_paid = legacy payments not copied into the ledger + ledger applications + active sponsorships
 *                  (applied_amount, else amount).
 * Proved equal to the CRM's own property on all 335 live reservations (25 Sep, read only); the naive
 * price-minus-paid was wrong on 41 of them. One text, used here and by the drift proof.
 */
export const REMAINING_BALANCE_SQL = `SELECT r.id,
  ( CASE WHEN r.pricing_mode = 'per_traveler' THEN
      CASE WHEN COALESCE((SELECT SUM(j.customer_price) FROM core_journey j WHERE j.reservation_id = r.id AND j.line_type = 'trip'), 0) > 0
           THEN (SELECT SUM(j.customer_price) FROM core_journey j WHERE j.reservation_id = r.id AND j.line_type = 'trip')
           ELSE COALESCE((SELECT SUM(t.customer_price) FROM core_traveler t WHERE t.reservation_id = r.id), 0) END
    ELSE COALESCE(r.customer_price, 0) END
    + COALESCE((SELECT SUM(j.customer_price) FROM core_journey j WHERE j.reservation_id = r.id AND j.line_type = 'service'), 0)
    - COALESCE((SELECT SUM(f.amount_to_customer) FROM core_refund f WHERE f.reservation_id = r.id), 0)
    - COALESCE((SELECT SUM(p.amount) FROM core_payment p WHERE p.reservation_id = r.id
        AND NOT EXISTS (SELECT 1 FROM core_customerpaymentapplication a WHERE a.legacy_payment_id = p.id)), 0)
    - COALESCE((SELECT SUM(a.amount) FROM core_customerpaymentapplication a WHERE a.reservation_id = r.id), 0)
    - COALESCE((SELECT SUM(COALESCE(s.applied_amount, s.amount)) FROM core_organizationsponsorship s WHERE s.reservation_id = r.id AND s.is_active), 0)
  )::text AS remaining_balance
  FROM core_reservation r WHERE r.id = ANY($1::bigint[])`;

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

/** Run the search in ONE read-only transaction that is always rolled back, under a 6-second statement
 *  timeout (Gabbai AQ B3: the phone gives up at 12 s, and this pool is the ledger poster's pool too). */
export const STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '6s'";
export async function searchCrm(pool, query) {
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  const q = async (sql, params) => {
    if (!isReadOnlySql(sql)) throw new Error("crm_search_refused_write");
    return (await client.query(sql, params)).rows;
  };
  const like = "%" + (query.words || query.email || query.q).replace(/[%_\\]/g, "") + "%";
  const phoneLike = query.phone ? "%" + query.phone + "%" : null;
  const windowed = !!(query.from || query.to);
  const from = query.from || "1900-01-01";
  const to = query.to || "2999-12-31";
  try {
    await q("BEGIN READ ONLY");
    await q(STATEMENT_TIMEOUT_SQL);
    // one row past each cap, so a capped list can SAY it is capped (Gabbai AQ B2b)
    const customers = await q(
      `SELECT c.id, c.full_name, c.email, c.phone, c.created_at
         FROM core_customer c
        WHERE ($1::text <> '' AND (c.full_name ILIKE $2 OR c.email ILIKE $2))
           OR ($3::text IS NOT NULL AND regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') LIKE $3)
        ORDER BY c.created_at DESC NULLS LAST LIMIT ${CUSTOMER_LIMIT + 1}`,
      [query.words || query.email, like, phoneLike]);
    const travelers = query.words
      ? await q(`SELECT t.full_name, t.reservation_id FROM core_traveler t WHERE t.full_name ILIKE $1 ORDER BY t.id DESC LIMIT ${LIMIT + 1}`, [like])
      : [];
    const custIds = customers.slice(0, CUSTOMER_LIMIT).map((c) => String(c.id));
    const travResIds = travelers.slice(0, LIMIT).map((t) => String(t.reservation_id)).filter(Boolean);
    // With a window, a booking is chosen because money moved on it (or it was made) inside the window -
    // never by being among the newest few (Gabbai AQ B2c).
    // The caps are PER PERSON (a regular customer's long history never starves another match of theirs):
    // rn counts inside each customer, and one row past the cap marks that person's list as truncated.
    const reservations = await q(
      `WITH hits AS (
         SELECT r.id, r.reservation_code, r.created_at, r.customer_id, r.customer_price::float8 AS customer_price, r.amount_paid::float8 AS amount_paid,
                r.is_closed, r.review_status, r.booked_with_points, r.agent_name, c.full_name AS customer,
                ROW_NUMBER() OVER (PARTITION BY r.customer_id ORDER BY r.created_at DESC NULLS LAST, r.id DESC) AS rn
           FROM core_reservation r LEFT JOIN core_customer c ON c.id = r.customer_id
          WHERE (($1::text <> '' AND upper(r.reservation_code) = $1)
              OR r.customer_id = ANY($2::bigint[]) OR r.id = ANY($3::bigint[]))
            AND (NOT $4::boolean
              OR (r.created_at >= $5::date AND r.created_at < ($6::date + 1))
              OR EXISTS (SELECT 1 FROM core_payment p WHERE p.reservation_id = r.id AND p.paid_at >= $5::date AND p.paid_at < ($6::date + 1))))
       SELECT * FROM hits WHERE rn <= ${BOOKING_LIMIT + 1} ORDER BY created_at DESC NULLS LAST`,
      [query.code, custIds, travResIds, windowed, from, to]);
    const resIds = reservations.filter((r) => Number(r.rn) <= BOOKING_LIMIT).map((r) => String(r.id));
    const payments = resIds.length
      ? await q(
          `WITH hits AS (
             SELECT p.amount::float8 AS amount, p.method, p.paid_at, p.reservation_id, r.reservation_code, r.customer_id,
                    substring(p.notes from 'nmi:([A-Za-z0-9_-]+)') AS nmi_txn,
                    ROW_NUMBER() OVER (PARTITION BY r.customer_id ORDER BY p.paid_at DESC, p.id DESC) AS rn
               FROM core_payment p JOIN core_reservation r ON r.id = p.reservation_id
              WHERE p.reservation_id = ANY($1::bigint[]) AND p.paid_at >= $2::date AND p.paid_at < ($3::date + 1))
           SELECT * FROM hits WHERE rn <= ${PAY_LIMIT + 1} ORDER BY paid_at DESC`,
          [resIds, from, to])
      : [];
    const customerPayments = custIds.length
      ? await q(
          `SELECT cp.amount::float8 AS amount, cp.method, cp.paid_at, cp.imported_from_legacy_payments AS imported, cp.customer_id
             FROM core_customerpayment cp
            WHERE cp.customer_id = ANY($1::bigint[]) AND cp.paid_at >= $2::date AND cp.paid_at < ($3::date + 1)
            ORDER BY cp.paid_at DESC LIMIT ${PAY_LIMIT + 1}`,
          [custIds, from, to])
      : [];
    const refunds = resIds.length
      ? await q(
          `SELECT f.amount_to_customer::float8 AS amount_to_customer, f.amount_received::float8 AS amount_received, f.status, f.refund_type, f.created_at, r.reservation_code, r.customer_id
             FROM core_refund f JOIN core_reservation r ON r.id = f.reservation_id
            WHERE f.reservation_id = ANY($1::bigint[]) ORDER BY f.created_at DESC LIMIT ${LIMIT + 1}`,
          [resIds])
      : [];
    const hotelRequests = await q(
      `SELECT h.id, h.customer_name, h.phone, h.email, h.city, h.check_in, h.check_out, h.status, h.requested_hotel, h.created_at
         FROM core_jrmhotelrequest h
        WHERE (($1::text <> '' AND (h.customer_name ILIKE $2 OR h.email ILIKE $2))
           OR ($3::text IS NOT NULL AND regexp_replace(coalesce(h.phone, ''), '[^0-9]', '', 'g') LIKE $3)
           OR h.customer_id = ANY($4::bigint[])
           OR ($5::text <> '' AND ('JRM-' || h.id::text) = $5))
          AND (NOT $6::boolean
            OR (h.created_at >= $7::date AND h.created_at < ($8::date + 1))
            OR EXISTS (SELECT 1 FROM core_jrmhotelpayment p WHERE p.request_id = h.id AND p.payment_date >= $7::date AND p.payment_date <= $8::date))
        ORDER BY h.created_at DESC NULLS LAST LIMIT ${LIMIT + 1}`,
      [query.words || query.email, like, phoneLike, custIds, query.code, windowed, from, to]);
    const reqIds = hotelRequests.slice(0, LIMIT).map((h) => String(h.id));
    const hotelPayments = reqIds.length
      ? await q(
          `SELECT p.request_id, p.payment_date::text AS payment_date, p.amount::float8 AS amount, p.currency, p.method, p.card_last4
             FROM core_jrmhotelpayment p
            WHERE p.request_id = ANY($1::bigint[]) AND p.payment_date >= $2::date AND p.payment_date <= $3::date
            ORDER BY p.payment_date DESC LIMIT ${PAY_LIMIT + 1}`,
          [reqIds, from, to])
      : [];
    // The CRM's own balance per booking. Read LAST: if it fails (a renamed table), every other list is already
    // read; the balance is then null (the phone asks, it never guesses) and the failure is counted.
    let balances = new Map();
    let balancesOk = true;
    if (resIds.length) {
      try {
        for (const b of await q(REMAINING_BALANCE_SQL, [resIds])) balances.set(String(b.id), b.remaining_balance);
      } catch {
        balances = new Map();
        balancesOk = false;
      }
    }
    return { customers, travelers, reservations, payments, customerPayments, refunds, hotelRequests, hotelPayments, balances, balancesOk };
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* nothing was written */ }
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
function cut(list, cap) { return { items: list.slice(0, cap), truncated: list.length > cap }; }

/** Rows -> the one answer shape, PER PERSON (Gabbai AQ B2a): a total is one customer's, never a sum over
 *  everyone a name matched. An allowlist: nothing leaves that is not named here. */
export function shape(query, rows) {
  const m = maskDigits;
  const cust = cut(rows.customers, CUSTOMER_LIMIT);
  const trav = cut(rows.travelers, LIMIT);
  const perPerson = (list, capN) => ({ items: list.filter((x) => Number(x.rn || 1) <= capN), truncated: list.some((x) => Number(x.rn || 1) > capN), cutFor: new Set(list.filter((x) => Number(x.rn || 1) > capN).map((x) => String(x.customer_id))) });
  const res = perPerson(rows.reservations, BOOKING_LIMIT);
  const pay = perPerson(rows.payments, PAY_LIMIT);
  const cpay = cut(rows.customerPayments, PAY_LIMIT);
  const refs = cut(rows.refunds, LIMIT);
  const hreq = cut(rows.hotelRequests, LIMIT);
  const hpay = cut(rows.hotelPayments, PAY_LIMIT);
  const resCode = new Map(res.items.map((r) => [String(r.id), r.reservation_code]));

  // One group per customer the search reached: matched customers first, then the owners of bookings
  // reached through a traveller name or a booking code.
  const groups = new Map();
  const group = (id, name, extra) => {
    const k = id == null ? "none" : String(id);
    if (!groups.has(k)) groups.set(k, { customer: m(name) || null, ...extra, bookings: [], payments: [], customer_level_payments: [], refunds: [] });
    return groups.get(k);
  };
  for (const c of cust.items) group(c.id, c.full_name, { email: m(c.email), phone: m(c.phone), since: day(c.created_at), matched: "customer" });
  for (const r of res.items) {
    const g = group(r.customer_id, r.customer, { matched: "booking" });
    const own = rows.balances && rows.balances.has(String(r.id)) ? num(rows.balances.get(String(r.id))) : null;
    g.bookings.push({ booking: m(r.reservation_code), created_on: day(r.created_at), price_usd: num(r.customer_price), paid_usd: num(r.amount_paid),
      balance_usd: r.customer_price != null && r.amount_paid != null ? num(Number(r.customer_price) - Number(r.amount_paid)) : null,
      remaining_balance_usd: own,
      closed: r.is_closed === true, review: r.review_status || null, points: r.booked_with_points === true, agent: m(r.agent_name) || null });
  }
  for (const p of pay.items) group(p.customer_id, null, {}).payments.push({ booking: m(p.reservation_code), amount_usd: num(p.amount), method: p.method || null, paid_on: day(p.paid_at), processor_txn: p.nmi_txn || null });
  for (const p of cpay.items) group(p.customer_id, null, {}).customer_level_payments.push({ amount_usd: num(p.amount), method: p.method || null, paid_on: day(p.paid_at), imported_from_booking_payments: p.imported === true });
  for (const f of refs.items) group(f.customer_id, null, {}).refunds.push({ booking: m(f.reservation_code), to_customer_usd: num(f.amount_to_customer), received_usd: num(f.amount_received), status: f.status || null, type: f.refund_type || null, on: day(f.created_at) });
  const people = [...groups.entries()].map(([k, g]) => ({ ...g, truncated: res.cutFor.has(k) || pay.cutFor.has(k) || undefined,
    payments_total_usd: round2(g.payments.reduce((a, x) => a + (Number(x.amount_usd) || 0), 0)) }));

  const byReq = new Map();
  for (const h of hreq.items) byReq.set(String(h.id), { request: "JRM-" + h.id, name: m(h.customer_name), phone: m(h.phone), email: m(h.email), city: h.city || null, check_in: day(h.check_in), check_out: day(h.check_out), status: h.status || null, hotel: m(h.requested_hotel) || null, payments: [], payments_total_by_currency: {} });
  for (const p of hpay.items) {
    const r = byReq.get(String(p.request_id));
    if (!r) continue;
    const cur = String(p.currency || "").toUpperCase() || "UNKNOWN";
    r.payments.push({ on: p.payment_date || null, amount: num(p.amount), currency: cur, method: p.method || null, card_last4: /^\d{4}$/.test(String(p.card_last4 || "")) ? String(p.card_last4) : null });
    r.payments_total_by_currency[cur] = round2((r.payments_total_by_currency[cur] || 0) + (Number(p.amount) || 0));
  }
  const requests = [...byReq.values()];
  const jrmNames = new Set(requests.map((r) => String(r.name || "").trim().toLowerCase()).filter(Boolean));

  const truncated = { customers: cust.truncated, travelers: trav.truncated, bookings: res.truncated, payments: pay.truncated, customer_level_payments: cpay.truncated, refunds: refs.truncated, hotel_requests: hreq.truncated, hotel_payments: hpay.truncated };
  const anyCut = Object.values(truncated).some(Boolean);
  const nesherPeople = people.filter((g) => g.customer || g.bookings.length || g.payments.length);
  const ambiguous = nesherPeople.length > 1 || jrmNames.size > 1;
  const notes = ["Nesher (flights) and JRM (hotels) are separate books - never add them together."];
  if (ambiguous) notes.push("AMBIGUOUS: more than one person matched - name them and ask which one; never add their money together.");
  if (anyCut) notes.push("TRUNCATED: a list hit its cap (see truncated) - a total over it is 'at least', never exact.");
  notes.push("payments_total_usd is one person's booking payments listed here; customer_level_payments may repeat money already in payments.");
  notes.push(rows.balancesOk === false
    ? "remaining_balance_usd could not be read - never offer an amount from balance_usd; ask for it."
    : "remaining_balance_usd is the CRM's own balance (price + services - refunds to the customer - payments - ledger applications - active sponsorships), the same rule as the booking page. balance_usd is price minus amount paid only - never offer it as an amount.");
  return {
    ok: true,
    build: CRM_SEARCH_BUILD,
    query: { text: m(query.q), from: query.from || null, to: query.to || null },
    ambiguous,
    truncated,
    nesher: { people: nesherPeople, travelers: trav.items.map((t) => ({ name: m(t.full_name), booking: m(resCode.get(String(t.reservation_id)) || null) })) },
    jrm: { hotel_requests: requests },
    notes,
  };
}

/** At most two searches at once; a third is told busy (Gabbai AQ B3). */
export const MAX_INFLIGHT = 2;
export function createCrmSearch(opts = {}) {
  const getPool = opts.getPool || (() => null);
  const stats = { calls: 0, errors: 0, busy: 0, balance_errors: 0, last_ms: null, last_at: null };
  let inflight = 0;
  async function answer(params) {
    const t0 = Date.now();
    stats.calls++;
    const query = parseQuery(params);
    if (!query.q || query.q.length < 2) return { status: 400, body: { ok: false, error: "query_required" } };
    const pool = getPool();
    if (!pool) return { status: 503, body: { ok: false, error: "not_configured" } };
    if (inflight >= MAX_INFLIGHT) { stats.busy++; return { status: 503, body: { ok: false, error: "busy" } }; }
    inflight++;
    try {
      const rows = await searchCrm(pool, query);
      if (rows.balancesOk === false) stats.balance_errors++;
      stats.last_ms = Date.now() - t0;
      stats.last_at = new Date().toISOString();
      return { status: 200, body: shape(query, rows) };
    } catch (e) {
      stats.errors++;
      const msg = String(e && e.message);
      return { status: 500, body: { ok: false, error: /refused_write/.test(msg) ? "refused_write" : /statement timeout|canceling statement/i.test(msg) ? "timeout" : "crm_search_failed" } };
    } finally {
      inflight--;
    }
  }
  /** The hop's direct hook: sub = "/crm-search?q=...". Never throws, never null. */
  async function hopAnswer(sub) {
    const s = String(sub || "");
    const r = await answer(new URLSearchParams(s.includes("?") ? s.slice(s.indexOf("?") + 1) : ""));
    return { status: r.status, body: JSON.stringify(r.body) };
  }
  function health() {
    return { build: CRM_SEARCH_BUILD, path: "/__money_hop" + CRM_SEARCH_PATH, inflight, ...stats };
  }
  return { answer, hopAnswer, health };
}
