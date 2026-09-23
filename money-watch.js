// money-watch.js - the three Nesher-Payment-Watch jobs, moved onto the server, in SHADOW.
//
// Joseph, 23 Sep 2026: "nothing needs to work through this machine. Things need to work through
// APIs." Until today three jobs ran every 10 minutes as the Windows task Nesher-Payment-Watch on his
// PC (C:\Users\User\nesher-payment-watch): watch-payments.js (Mercury AR status changes -> an alert
// to joseph@), quote-link-autopilot.js (priced CRM quotes -> a Mercury link + booking@ draft + CRM
// note) and enrich-methods.js (a settled payout -> "[Settled ...: paid by ...]" on the CRM payment).
//
// This module runs the SAME logic here, every 10 minutes, IN PARALLEL with the PC task and in
// SHADOW ONLY: it reads Mercury (through mercury-gateway.js: direct first, the seat as fallback) and
// the CRM (SELECT only), and it records what each job WOULD do. It sends no email, creates no
// Mercury invoice or customer, stages no draft and writes no CRM row. The PC task keeps doing the
// real work until the cutover, which is its own reviewed step. The report is key-gated
// (GET /__nesher_pay/money-watch, x-report-key).
//
// Idempotency, same meaning as the PC, sourced from the CRM instead of a local file:
//   watch     - a status map per invoice id; the first pass is a baseline, never an alert
//   autopilot - a quote is "done" when its CRM note carries the PC's own marker "(offer#<id>)" /
//               "(flightresult#<id>)"; the PC's ledger file is on the PC and is not read
//   enrich    - a paid invoice is "done" when every CRM payment carrying mercury:<id> already
//               ends with "[Settled "
// The report never carries a customer name, email, or account number: invoice numbers, amounts,
// counts and reasons only.

const TEN_MIN = 10 * 60 * 1000;
const HISTORY = 36;

function iso(ms) { return new Date(ms).toISOString(); }
function short(e) { return String((e && e.message) || e || "").slice(0, 160); }
function isPaid(status) { return /paid/i.test(String(status || "")) && !/unpaid/i.test(String(status || "")); }

/** enrich-methods.js instrumentOf, ported verbatim in meaning: structured fields first, text second, else null. */
export function instrumentOf(txn) {
  const d = (txn && txn.details) || {};
  if (txn.cardId || d.creditCardInfo || d.debitCardInfo) return "credit/debit card";
  if (d.electronicRoutingInfo) return "ACH bank debit";
  const hay = [txn.kind, txn.bankDescription, txn.counterpartyName, txn.externalMemo].filter(Boolean).join(" ");
  if (/credit\s*card|debit\s*card|card\b|stripe/i.test(hay)) return "credit/debit card";
  if (/\bach\b|bank debit|direct debit/i.test(hay)) return "ACH bank debit";
  return null;
}

/** watch-payments.js change detection over a previous status map. */
export function statusChanges(prev, invoices) {
  const changes = [];
  const next = new Map();
  for (const inv of invoices) {
    const before = prev ? prev.get(inv.id) : undefined;
    if (prev && before !== undefined && before !== inv.status) {
      changes.push({
        invoiceNumber: inv.invoiceNumber || inv.id,
        amount: Number(inv.amount),
        from: before,
        to: inv.status,
        would: isPaid(inv.status) ? "alert Joseph: PAYMENT RECEIVED" : "alert Joseph: invoice status change",
      });
    }
    next.set(inv.id, inv.status);
  }
  return { changes, next };
}

/** enrich-methods.js settlement match: exact or up to 4.5% under, not before the invoice. */
export function settlementCandidates(inv, incoming) {
  const amt = Number(inv.amount);
  return incoming.filter((t) => {
    const a = Number(t.amount);
    return a <= amt + 0.005 && a >= amt * 0.955 && new Date(t.createdAt) >= new Date(inv.createdAt);
  });
}

const AUTOPILOT_HOTELS_SQL = `
  SELECT o.id oid, o.customer_price, o.currency, r.id req
  FROM core_jrmhoteloffer o JOIN core_jrmhotelrequest r ON r.id = o.request_id
  WHERE o.customer_price IS NOT NULL AND o.customer_price > 0
    AND r.status NOT IN ('lost') AND COALESCE(r.check_in, r.service_date) >= CURRENT_DATE
    AND COALESCE(r.email,'') <> ''`;
const AUTOPILOT_FLIGHTS_SQL = `
  SELECT f.id fid, f.sell_price, r.id req
  FROM core_flightsearchresult f JOIN core_flightsearchrequest r ON r.id = f.request_id
  WHERE f.sell_price IS NOT NULL AND f.sell_price > 0
    AND r.status NOT IN ('closed_lost') AND r.depart_date >= CURRENT_DATE
    AND COALESCE(r.customer_email,'') <> ''`;

export function createMoneyWatch(opts = {}) {
  const gateway = opts.gateway;
  const getPool = opts.getPool || (() => null);
  const now = opts.now || (() => Date.now());
  const log = opts.log || ((m) => console.log(m));
  const enabled = String(opts.mode ?? process.env.MONEY_WATCH ?? "shadow").trim().toLowerCase() !== "off";

  let statusMap = null;
  let busy = false;
  let last = null;
  let lastOkAt = null;
  const history = [];
  const changesSeen = [];

  async function watchJob(invoices, served) {
    const hadBaseline = Boolean(statusMap);
    const { changes, next } = statusChanges(statusMap, invoices);
    statusMap = next;
    for (const c of changes) {
      changesSeen.push({ at: iso(now()), ...c });
      if (changesSeen.length > 100) changesSeen.shift();
    }
    const byStatus = {};
    for (const i of invoices) byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    return {
      checked: invoices.length,
      by_status: byStatus,
      baseline: !hadBaseline,
      changes,
      served_by: served,
      pc_line: `checked ${invoices.length} invoices, ${changes.length} change(s)`,
    };
  }

  async function autopilotJob(pool) {
    const hotels = (await pool.query(AUTOPILOT_HOTELS_SQL)).rows;
    const flights = (await pool.query(AUTOPILOT_FLIGHTS_SQL)).rows;
    const hotelReqs = [...new Set(hotels.map((h) => Number(h.req)))];
    const flightReqs = [...new Set(flights.map((f) => Number(f.req)))];
    const markers = new Set();
    const re = /\((offer#\d+|flightresult#\d+)\)/g;
    if (hotelReqs.length) {
      const r = await pool.query(
        "SELECT note FROM core_jrmhotelnote WHERE request_id = ANY($1::int[]) AND note LIKE '%(offer#%'",
        [hotelReqs]
      );
      for (const row of r.rows) for (const m of String(row.note || "").matchAll(re)) markers.add(m[1]);
    }
    if (flightReqs.length) {
      const r = await pool.query(
        "SELECT internal_notes FROM core_flightsearchrequest WHERE id = ANY($1::int[]) AND internal_notes LIKE '%(flightresult#%'",
        [flightReqs]
      );
      for (const row of r.rows) for (const m of String(row.internal_notes || "").matchAll(re)) markers.add(m[1]);
    }
    const wouldHotels = hotels.filter((h) => !markers.has("offer#" + h.oid)).map((h) => ({
      num: "JRM-" + (1000 + Number(h.req)) + "-O" + h.oid,
      price: Number(h.customer_price),
      currency: /usd|\$/i.test(h.currency || "") ? "USD" : "ILS (spot + 3%)",
    }));
    const wouldFlights = flights.filter((f) => !markers.has("flightresult#" + f.fid)).map((f) => ({
      num: "FLY-" + (1000 + Number(f.req)) + "-R" + f.fid,
      price: Number(f.sell_price),
      currency: "USD (assumed)",
    }));
    return {
      priced_hotel_offers: hotels.length,
      priced_flight_results: flights.length,
      already_linked: hotels.length + flights.length - wouldHotels.length - wouldFlights.length,
      would_link: [...wouldHotels, ...wouldFlights],
      would: wouldHotels.length + wouldFlights.length
        ? "create Mercury link + booking mailbox draft + CRM note (SHADOW: none made)"
        : "nothing",
      pc_line: wouldHotels.length + wouldFlights.length
        ? `candidates: hotels ${wouldHotels.length}, flights ${wouldFlights.length}`
        : "no new priced quotes (hotels 0, flights 0)",
    };
  }

  async function enrichJob(pool, invoices) {
    const paid = invoices.filter((i) => /^paid$/i.test(String(i.status || "")));
    const rows = [];
    let pending = [];
    for (const inv of paid) {
      const mark = `%mercury:${inv.id}%`;
      const a = await pool.query("SELECT id, notes FROM core_payment WHERE notes LIKE $1", [mark]);
      const b = await pool.query("SELECT id, note FROM core_jrmhotelpayment WHERE reference LIKE $1", [mark]);
      const crm = [...a.rows.map((r) => String(r.notes || "")), ...b.rows.map((r) => String(r.note || ""))];
      const settled = crm.length > 0 && crm.every((t) => t.includes("[Settled "));
      if (!settled) pending.push({ inv, crmRows: crm.length });
    }
    let served = null;
    let incoming = [];
    let txError = null;
    if (pending.length) {
      const today = new Date(now());
      const end = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
      const start = new Date(today.getTime() - 91 * 86400000).toISOString().slice(0, 10);
      const r = await gateway.read("watch.transactions", `/transactions?start=${start}&end=${end}&account=checking`);
      served = r.servedBy;
      if (r.status === 200) {
        let body = null;
        try { body = JSON.parse(r.body); } catch { body = null; }
        const txns = body && Array.isArray(body.transactions) ? body.transactions : [];
        incoming = txns.filter((t) => Number(t.amount) > 0 && t.status !== "failed" && t.kind !== "billingEngineSubscriptionFee");
      } else {
        txError = `transactions ${r.status}`;
      }
    }
    for (const p of pending) {
      const cands = txError ? [] : settlementCandidates(p.inv, incoming);
      const inst = cands.length === 1 ? instrumentOf(cands[0]) : null;
      let would;
      if (txError) would = "unknown: " + txError;
      else if (cands.length !== 1) would = `wait: ${cands.length} candidate settlement(s)`;
      else if (!inst) would = "wait: settlement found, instrument unclear";
      else if (!p.crmRows) would = `wait: instrument known (${inst}), no CRM row carries the marker yet`;
      else would = `label "${inst}"`;
      rows.push({ invoiceNumber: p.inv.invoiceNumber, amount: Number(p.inv.amount), crm_rows: p.crmRows, candidates: cands.length, instrument: inst, would });
    }
    pending = pending.length;
    return {
      paid: paid.length,
      pending,
      would_label: rows.filter((r) => r.would.startsWith("label")).length,
      rows,
      transactions_served_by: served,
      note: served === "seat" ? "the seat returns an allowlisted field set (no cardId/details): instrument by text only" : null,
      pc_line: `pass done: ${pending} paid invoice(s) pending, 0 enriched (shadow)`,
    };
  }

  async function runOnce(trigger = "manual") {
    if (busy) return last || { skippedRun: "busy" };
    busy = true;
    const t0 = now();
    const out = { at: iso(t0), trigger, mode: "shadow", watch: null, autopilot: null, enrich: null, errors: [] };
    try {
      let invoices = null;
      try {
        invoices = await gateway.listArInvoices("watch.invoices");
      } catch (e) {
        out.errors.push("invoices: " + short(e));
      }
      const served = gateway.lastServed("watch.invoices");
      if (invoices) out.watch = await watchJob(invoices, served);
      const pool = getPool();
      if (!pool) out.errors.push("database not configured");
      else {
        try { out.autopilot = await autopilotJob(pool); } catch (e) { out.errors.push("autopilot: " + short(e)); }
        if (invoices) {
          try { out.enrich = await enrichJob(pool, invoices); } catch (e) { out.errors.push("enrich: " + short(e)); }
        }
      }
      out.ms = now() - t0;
      if (!out.errors.length) lastOkAt = out.at;
      last = out;
      history.push({
        at: out.at,
        invoices_served_by: served,
        watch: out.watch ? out.watch.pc_line : null,
        autopilot: out.autopilot ? out.autopilot.pc_line : null,
        enrich: out.enrich ? out.enrich.pc_line : null,
        errors: out.errors.length,
      });
      if (history.length > HISTORY) history.shift();
      if (out.errors.length || (out.watch && out.watch.changes.length) || (out.autopilot && out.autopilot.would_link.length)) {
        log(`money-watch (${trigger}, shadow): errors=${JSON.stringify(out.errors)} changes=${out.watch ? out.watch.changes.length : "?"} would_link=${out.autopilot ? out.autopilot.would_link.length : "?"}`);
      }
      return out;
    } finally {
      busy = false;
    }
  }

  function summary() {
    return {
      mode: enabled ? "shadow" : "off",
      at: last ? last.at : null,
      last_ok_at: lastOkAt,
      errors: last ? last.errors.length : null,
      invoices_served_by: last && last.watch ? last.watch.served_by : null,
      watch: last && last.watch ? last.watch.pc_line : null,
      autopilot: last && last.autopilot ? last.autopilot.pc_line : null,
      enrich: last && last.enrich ? last.enrich.pc_line : null,
    };
  }

  function report() {
    return { ok: true, mode: enabled ? "shadow" : "off", last, last_ok_at: lastOkAt, history: [...history], changes_seen: [...changesSeen] };
  }

  function start({ firstDelayMs = 90 * 1000, everyMs = TEN_MIN } = {}) {
    if (!enabled) return false;
    setTimeout(() => runOnce("boot").catch((e) => log("money-watch boot failed: " + short(e))), firstDelayMs).unref?.();
    setInterval(() => runOnce("interval").catch((e) => log("money-watch failed: " + short(e))), everyMs).unref?.();
    return true;
  }

  return { runOnce, summary, report, start, enabled };
}
