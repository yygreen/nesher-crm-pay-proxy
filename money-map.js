// money-map.js - Mr Money's money map, server side, READ ONLY (plan s.10, finish line F6).
//
// Joseph, 22 Sep 2026, verbatim: "it should know how much money was proccessed where and what fee
// we pay for it what profit we make on it and so on" and "of course jrm should be under jrm".
//
// Four different numbers, never blurred into "profit" (plan 16.4.4):
//   processed    - customer card sales the processor APPROVED (Pinpoint / NMI query API), by sale
//                  date, voids excluded, refunds shown beside; plus Mercury invoices marked Paid.
//   cash         - what actually landed in Nesher checking (Mercury): processor deposits, payouts.
//   fees         - MEASURED from the bank wherever possible: Pinpoint pays each settled batch into
//                  checking and takes its discount as a separate debit the same minute (or, in the
//                  other shape, deposits the batch short of its total). Batch -> deposit -> fee.
//                  A batch that cannot be matched is shown unmatched, never guessed (16.5.5).
//   contribution - per booking, only where the supplier cost is actually known: money received
//                  minus the cost the CRM holds minus card fees minus refunds. Missing cost is
//                  "cost unknown", NEVER zero (16.4.1). Every estimate carries its formula (16.4.2).
//   revenue      - not computed here.
//
// Traps it is built around (16.5): a card sale and its settlement and its deposit are ONE payment;
// authorisations, captures and deposits stay distinct; partial payments and many batches in one
// deposit are normal; late and reversed events never silently rewrite a closed period.
//
// It cannot move money: NMI is read through query.php (the key rides in the POST body only), Mercury
// through mercury-gateway.js read() (GET only, Nesher accounts only), the CRM inside BEGIN READ ONLY
// that is always rolled back. It never reads or returns a card number, a customer name or an email.
import { queryNmiRange } from "./nmi-recovery.js";

export const MONEY_MAP_BUILD = "2026-09-24-money-map";
export const MONEY_MAP_PATH = "/money-map";
export const MONEY_MAP_TZ = "Asia/Jerusalem";
export const MERCHANT_ACCOUNTS = Object.freeze({
  mav7067: Object.freeze({ label: "Nesher merchant account", descriptor: /FLYNESHER/i }),
  mav2083: Object.freeze({ label: "JRM merchant account", descriptor: /JRM HOTELS/i }),
});
const PROCESSOR_BRAND = Object.freeze({ mav7067: "nesher", mav2083: "jrm" });
const MAX_RANGE_DAYS = 70;           // + the matching margins stays inside Mercury's 92-day read
const DEPOSIT_WINDOW_MS = 8 * 86400000;
const AWAITING_MS = 5 * 86400000;    // a batch younger than this with no deposit is "awaiting", not unmatched
const FEE_PAIR_MS = 10 * 60 * 1000;
const CARD_LINK_DAYS = 7;          // a rep may type a card payment into the CRM days after the sale
const CENT = 0.005;

// ── small helpers ────────────────────────────────────────────────────────────
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const same = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < CENT;
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const pct = (fee, base) => (base > 0 ? r4(fee / base) : null);
function validYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + "T00:00:00Z"))
    && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
}
function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function tzOffsetMs(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: MONEY_MAP_TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(ms / 1000) * 1000;
}
/** Israel calendar date of an instant, YYYY-MM-DD. */
export function ilDate(ms) {
  return new Date(ms + tzOffsetMs(ms)).toISOString().slice(0, 10);
}
/** The instant Israel midnight begins on this calendar date. */
export function ilMidnightMs(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess);
  t = guess - tzOffsetMs(t);
  return t;
}

/**
 * The period asked for, in Israel time. day | week (Sunday to Saturday, the Israeli working week)
 * | month (calendar) | range (start..end inclusive, at most 70 days).
 */
export function periodFor({ period = "month", date, start, end } = {}, nowMs = Date.now()) {
  const kind = String(period || "month").toLowerCase();
  const today = ilDate(nowMs);
  let s;
  let e;
  if (kind === "range" || kind === "custom") {
    if (!validYmd(start) || !validYmd(end)) return { error: "bad_range", hint: "start and end as YYYY-MM-DD" };
    if (end < start) return { error: "start_after_end" };
    s = start;
    e = addDaysYmd(end, 1);
    const days = Math.round((Date.parse(e) - Date.parse(s)) / 86400000);
    if (days > MAX_RANGE_DAYS) return { error: "range_too_wide", max_days: MAX_RANGE_DAYS, requested_days: days };
  } else {
    const d = date == null || date === "" ? today : date;
    if (!validYmd(d)) return { error: "bad_date", hint: "YYYY-MM-DD" };
    if (kind === "day") { s = d; e = addDaysYmd(d, 1); }
    else if (kind === "week") { s = addDaysYmd(d, -new Date(d + "T00:00:00Z").getUTCDay()); e = addDaysYmd(s, 7); }
    else if (kind === "month") {
      s = d.slice(0, 8) + "01";
      const [y, m] = s.split("-").map(Number);
      e = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    } else return { error: "bad_period", allowed: ["day", "week", "month", "range"] };
  }
  const startMs = ilMidnightMs(s);
  const endMs = ilMidnightMs(e);
  return {
    kind: kind === "custom" ? "range" : kind,
    start: s,
    end: addDaysYmd(e, -1),
    start_at: iso(startMs),
    end_at: iso(endMs),
    tz: MONEY_MAP_TZ,
    open: endMs > nowMs,
    startMs,
    endMs,
  };
}

// ── NMI: the processor's record ─────────────────────────────────────────────
function decode(s) {
  return String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? decode(m[1]).trim() : "";
}
function mdf(block, id) {
  const m = block.match(new RegExp(`<merchant_defined_field id="${id}">([^<]*)</merchant_defined_field>`));
  return m ? decode(m[1]).trim() : "";
}
function nmiMs(s) {
  const m = String(s || "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/**
 * query.php XML -> one record per transaction with its actions. Only these fields are read:
 * transaction id, order id, original transaction id, processor, condition, card brand (cc_type),
 * MDF 1 (brand stamp) and MDF 5 (rep), and per action its type, amount, success, date, batch id.
 * Names, emails, addresses and the masked card number are never read.
 */
export function parseNmiTransactions(xml) {
  const out = [];
  const blocks = String(xml || "").split("<transaction>").slice(1).map((b) => b.split("</transaction>")[0]);
  for (const b of blocks) {
    const id = tag(b, "transaction_id");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
    const head = b.split("<action>")[0];
    const actions = b.split("<action>").slice(1).map((a) => a.split("</action>")[0]).map((a) => ({
      type: tag(a, "action_type").toLowerCase(),
      amount: Number(tag(a, "amount")) || 0,
      success: tag(a, "success") === "1",
      at: nmiMs(tag(a, "date")),
      batchId: tag(a, "batch_id") && tag(a, "batch_id") !== "0" ? tag(a, "batch_id") : null,
    }));
    const hint = mdf(b, 1).toLowerCase();
    const rep = mdf(b, 5);
    const orig = tag(head, "original_transaction_id");
    out.push({
      id,
      orderId: tag(head, "order_id") || null,
      originalId: /^[A-Za-z0-9_-]{1,64}$/.test(orig) ? orig : null,
      processorId: tag(head, "processor_id").toLowerCase() || null,
      condition: tag(head, "condition").toLowerCase(),
      cardType: tag(head, "cc_type") || null,
      brandHint: hint === "jrm" || hint === "nesher" ? hint : null,
      rep: /^[A-Za-z][A-Za-z .'-]{0,39}$/.test(rep) ? rep : null,
      actions,
    });
  }
  return out;
}

/**
 * What one transaction IS, money-wise. An authorisation alone is not money. A capture is the sale
 * (at the captured amount, so a partial capture counts what was captured). A settle action is the
 * batch the sale rode in, never a second sale. A successful void removes the sale.
 */
export function classifyTransaction(t) {
  const ok = (types) => t.actions.filter((a) => a.success && types.includes(a.type));
  const sales = ok(["sale"]);
  const captures = ok(["capture"]);
  const refunds = ok(["refund", "credit"]);
  const auths = ok(["auth"]);
  const voids = ok(["void"]);
  const settles = ok(["settle"]);
  let kind = "none";
  let amount = 0;
  let at = null;
  let basis = null;
  if (sales.length) { kind = "sale"; amount = Math.abs(sales[0].amount); at = sales[0].at; basis = "sale"; }
  else if (captures.length) { kind = "sale"; amount = captures.reduce((s, a) => s + Math.abs(a.amount), 0); at = captures[0].at; basis = "capture"; }
  else if (refunds.length) { kind = "refund"; amount = refunds.reduce((s, a) => s + Math.abs(a.amount), 0); at = refunds[0].at; basis = "refund"; }
  else if (auths.length) { kind = "auth_only"; amount = Math.abs(auths[0].amount); at = auths[0].at; basis = "auth"; }
  else if (t.actions.some((a) => ["sale", "auth", "capture", "refund", "credit"].includes(a.type))) {
    kind = "failed";
    const first = t.actions.find((a) => ["sale", "auth", "capture", "refund", "credit"].includes(a.type));
    amount = Math.abs(first.amount);
    at = first.at;
  }
  return {
    kind,
    amount: r2(amount),
    at,
    basis,
    voided: voids.length > 0,
    voidAt: voids.length ? voids[0].at : null,
    settles: settles.map((a) => ({ batchId: a.batchId, amount: a.amount, at: a.at })),
  };
}

export function brandOf(t, crmBrand = null) {
  const ref = String(t.orderId || "");
  if (/^JRM-/i.test(ref)) return { brand: "jrm", basis: "booking reference" };
  if (/^RES-/i.test(ref)) return { brand: "nesher", basis: "booking reference" };
  if (t.brandHint) return { brand: t.brandHint, basis: "brand stamped at charge time" };
  if (crmBrand) return { brand: crmBrand, basis: "matched to a CRM payment row" };
  if (PROCESSOR_BRAND[t.processorId]) return { brand: PROCESSOR_BRAND[t.processorId], basis: MERCHANT_ACCOUNTS[t.processorId].label };
  return { brand: null, basis: "unknown" };
}

/** Settled batches, per merchant account, from the settle actions. Net = sales minus refunds. */
export function buildBatches(txns) {
  const map = new Map();
  for (const t of txns) {
    for (const s of t.money.settles) {
      if (!s.batchId || !t.processorId) continue;
      const key = t.processorId + "|" + s.batchId;
      let b = map.get(key);
      if (!b) {
        b = { key, processor_id: t.processorId, batch_id: s.batchId, settledMs: s.at, gross_sales: 0, refunds: 0, net: 0, count: 0, items: [] };
        map.set(key, b);
      }
      if (s.at != null && (b.settledMs == null || s.at < b.settledMs)) b.settledMs = s.at;
      b.count++;
      b.net += s.amount;
      if (s.amount >= 0) b.gross_sales += s.amount;
      else b.refunds += -s.amount;
      b.items.push({ id: t.id, amount: s.amount });
    }
  }
  return [...map.values()].sort((a, b) => (a.settledMs || 0) - (b.settledMs || 0));
}

// ── Mercury: what reached the bank ──────────────────────────────────────────
/** Put a Nesher checking row in one bucket. Pure. */
export function classifyBankRow(t) {
  const text = `${t.counterpartyName || ""} ${t.bankDescription || ""}`;
  const amount = Number(t.amount) || 0;
  if (/M MERCHANT|MERCHANT SERVICES|MERCHANT BANKCD|MERCH SVC/i.test(text)) {
    const mid = MERCHANT_ACCOUNTS.mav2083.descriptor.test(text) ? "mav2083" : MERCHANT_ACCOUNTS.mav7067.descriptor.test(text) ? "mav7067" : null;
    let type;
    if (/CR CD DEP/i.test(text)) type = "deposit";
    else if (/DLY DIS/i.test(text)) type = "discount";
    else if (/CHG ?BK|CHARGE ?BACK|\bCB\b|RETRIEVAL/i.test(text)) type = "chargeback";
    else if (/MTHLY|MONTHLY|STMT|ANNUAL|PCI|FEE|DISC/i.test(text)) type = "processor_fee";
    else type = amount >= 0 ? "deposit" : "processor_debit";
    return { group: "merchant", mid, type };
  }
  if (/cashback/i.test(text)) return { group: "cashback" };
  if (t.kind === "billingEngineSubscriptionFee" || /Mercury Technologies/i.test(text)) return { group: "mercury_subscription" };
  if (t.kind === "wireFee" || /exchange fee|wire fee/i.test(text)) return { group: "mercury_wire_fee" };
  if (/SQUARE INC|^\s*Square\b/i.test(text)) return { group: "square" };
  if (/STRIPE/i.test(text)) return { group: "stripe" };
  if (t.kind === "internalTransfer" || /Mercury Credit IO|Mercury IO/i.test(text)) return { group: "internal" };
  return { group: amount >= 0 ? "other_credit" : "other_debit" };
}

function bankRows(list) {
  const out = [];
  for (const t of list || []) {
    const st = String(t.status || "").toLowerCase();
    if (st === "failed" || st === "cancelled" || st === "canceled" || st === "reversed") continue;
    const at = Date.parse(t.postedAt || t.createdAt || "");
    if (!Number.isFinite(at)) continue;
    out.push({ id: t.id, at, createdMs: Date.parse(t.createdAt || "") || at, amount: Number(t.amount) || 0, pending: st === "pending", ...classifyBankRow(t) });
  }
  return out.sort((a, b) => a.createdMs - b.createdMs);
}

/**
 * Batch -> deposit -> fee. Pure; never guesses.
 *  1. one-to-one: a deposit on the same merchant account for exactly the batch net, within 8 days.
 *  2. many-to-one: one deposit equal to 2-4 consecutive unmatched batches of that account.
 *  3. net-of-fee: a deposit short of ONE unmatched batch by at most 6%, only when that is the sole
 *     candidate either way - the shortfall is the fee.
 *  Fee debits ("DLY DIS") are paired with the matched deposit of the same account posted in the same
 *  10 minutes, closest first; a tie between two deposits is left unassigned, not guessed.
 */
export function matchBatches(batches, rows, nowMs = Date.now()) {
  const used = new Set();
  const deposits = rows.filter((r) => r.group === "merchant" && (r.type === "deposit" || r.type === "processor_debit"));
  const groups = [];
  const inWindow = (b, d) => b.settledMs != null && d.createdMs >= b.settledMs - 3600000 && d.createdMs <= b.settledMs + DEPOSIT_WINDOW_MS;
  for (const b of batches) { b.match = null; b.deposit = null; b.fee = null; b.group = null; }

  // 1. one-to-one
  for (const b of batches) {
    if (same(b.net, 0)) { b.match = "zero_net"; continue; }
    const d = deposits.find((x) => !used.has(x.id) && x.mid === b.processor_id && same(x.amount, b.net) && inWindow(b, x));
    if (d) {
      used.add(d.id);
      const g = { id: "g" + groups.length, batches: [b], deposit: d, shape: "one_to_one" };
      groups.push(g);
      b.group = g;
      b.match = "one_to_one";
    }
  }
  // 2. many-to-one
  for (const d of deposits) {
    if (used.has(d.id)) continue;
    const pool = batches.filter((b) => !b.match && b.processor_id === d.mid && inWindow(b, d));
    let hit = null;
    for (let size = 2; size <= Math.min(4, pool.length) && !hit; size++) {
      for (let i = 0; i + size <= pool.length && !hit; i++) {
        const run = pool.slice(i, i + size);
        if (same(run.reduce((s, b) => s + b.net, 0), d.amount)) hit = run;
      }
    }
    if (hit) {
      used.add(d.id);
      const g = { id: "g" + groups.length, batches: hit, deposit: d, shape: "many_to_one" };
      groups.push(g);
      for (const b of hit) { b.group = g; b.match = "many_to_one"; }
    }
  }
  // 3. net of fee (the shape the plan expected; unique candidates only)
  for (const d of deposits) {
    if (used.has(d.id) || d.amount <= 0) continue;
    const cands = batches.filter((b) => !b.match && b.processor_id === d.mid && inWindow(b, d) && b.net > d.amount && b.net - d.amount <= 0.06 * b.net);
    if (cands.length !== 1) continue;
    const b = cands[0];
    const rivals = deposits.filter((x) => !used.has(x.id) && x !== d && x.mid === d.mid && x.amount > 0 && inWindow(b, x) && b.net > x.amount && b.net - x.amount <= 0.06 * b.net);
    if (rivals.length) continue;
    used.add(d.id);
    const g = { id: "g" + groups.length, batches: [b], deposit: d, shape: "net_of_fee", fee: r2(b.net - d.amount), feeSource: "deposit short of the batch total" };
    groups.push(g);
    b.group = g;
    b.match = "net_of_fee";
  }
  // Fee debits -> the matched deposit of the same account in the same 10 minutes.
  const discounts = rows.filter((r) => r.group === "merchant" && r.type === "discount");
  const unassignedFees = [];
  for (const f of discounts) {
    const near = groups
      .filter((g) => g.shape !== "net_of_fee" && g.fee == null && g.deposit.mid === f.mid && Math.abs(g.deposit.createdMs - f.createdMs) <= FEE_PAIR_MS)
      .map((g) => ({ g, dist: Math.abs(g.deposit.createdMs - f.createdMs) }))
      .sort((a, b) => a.dist - b.dist);
    if (!near.length) { unassignedFees.push({ ...f, reason: "no matched deposit beside it" }); continue; }
    if (near.length > 1 && near[0].dist === near[1].dist) { unassignedFees.push({ ...f, reason: "two deposits at the same moment - not guessed" }); continue; }
    near[0].g.fee = r2(-f.amount);
    near[0].g.feeSource = "daily discount debit beside the deposit";
    near[0].g.feeRow = f;
  }
  // Spread each group's fee over its batches by sales, then report.
  for (const g of groups) {
    const gross = g.batches.reduce((s, b) => s + b.gross_sales, 0);
    const refunds = g.batches.reduce((s, b) => s + b.refunds, 0);
    for (const b of g.batches) {
      b.deposit = { at: iso(g.deposit.createdMs), amount: r2(g.deposit.amount), pending: g.deposit.pending, shape: g.shape, batches_in_deposit: g.batches.length };
      const share = gross > 0 ? b.gross_sales / gross : refunds > 0 ? b.refunds / refunds : 1 / g.batches.length;
      if (g.fee != null) b.fee = { amount: r2(g.fee * share), feeExact: g.fee * share, measured: true, source: g.feeSource, shared_in_deposit: g.batches.length > 1 };
    }
  }
  for (const b of batches) {
    if (b.match) continue;
    b.match = b.settledMs != null && nowMs - b.settledMs < AWAITING_MS ? "awaiting_deposit" : "unmatched";
  }
  const unmatchedDeposits = deposits.filter((d) => !used.has(d.id));
  return { groups, unassignedFees, unmatchedDeposits };
}

// ── CRM: read only, no names ────────────────────────────────────────────────
function isReadOnlySql(sql) {
  return /^\s*(SELECT|WITH|BEGIN READ ONLY|ROLLBACK)\b/i.test(sql) && !/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT)\b/i.test(sql.replace(/'[^']*'/g, ""));
}

/**
 * Every row the contribution needs, in ONE read-only transaction that is always rolled back.
 * Never selects a name, an email, a phone or a note body (only the nmi:<txn> marker is extracted).
 */
export async function loadCrm(pool, period, refs) {
  const client = typeof pool.connect === "function" ? await pool.connect() : pool;
  const q = async (sql, params) => {
    if (!isReadOnlySql(sql)) throw new Error("money_map_refused_write");
    return (await client.query(sql, params)).rows;
  };
  try {
    await q("BEGIN READ ONLY");
    const startIso = new Date(period.startMs).toISOString();
    const endIso = new Date(period.endMs).toISOString();
    const nesherInPeriod = await q(
      `SELECT p.id, p.amount::float8 AS amount, p.method, p.paid_at, p.reservation_id,
              substring(p.notes from 'nmi:([A-Za-z0-9_-]+)') AS nmi_txn
         FROM core_payment p WHERE p.paid_at >= $1 AND p.paid_at < $2`, [startIso, endIso]);
    const codes = [...new Set(refs.res)];
    const byCode = codes.length
      ? await q(`SELECT id FROM core_reservation WHERE reservation_code = ANY($1::text[])`, [codes])
      : [];
    const resIds = [...new Set([...nesherInPeriod.map((p) => String(p.reservation_id)), ...byCode.map((r) => String(r.id))])];
    const reservations = resIds.length
      ? await q(`SELECT id, reservation_code, customer_price::float8 AS customer_price, supplier_cost::float8 AS supplier_cost,
                        booked_with_points FROM core_reservation WHERE id = ANY($1::bigint[])`, [resIds])
      : [];
    const nesherAll = resIds.length
      ? await q(`SELECT p.id, p.amount::float8 AS amount, p.method, p.paid_at, p.reservation_id,
                        substring(p.notes from 'nmi:([A-Za-z0-9_-]+)') AS nmi_txn
                   FROM core_payment p WHERE p.reservation_id = ANY($1::bigint[])`, [resIds])
      : [];
    const jrmInPeriod = await q(
      `SELECT id, amount::float8 AS amount, currency, method, payment_date::text AS payment_date, offer_id, request_id,
              substring(reference from 'nmi:([A-Za-z0-9_-]+)') AS nmi_txn
         FROM core_jrmhotelpayment WHERE payment_date >= $1::date AND payment_date < $2::date`,
      [period.start, addDaysYmd(period.end, 1)]);
    const reqIds = [...new Set([...jrmInPeriod.map((p) => String(p.request_id)), ...refs.jrm.map(String)])];
    const jrmAll = reqIds.length
      ? await q(`SELECT id, amount::float8 AS amount, currency, method, payment_date::text AS payment_date, offer_id, request_id,
                        substring(reference from 'nmi:([A-Za-z0-9_-]+)') AS nmi_txn
                   FROM core_jrmhotelpayment WHERE request_id = ANY($1::bigint[])`, [reqIds])
      : [];
    const offers = reqIds.length
      ? await q(`SELECT id, request_id, currency, hotel_price::float8 AS hotel_price, markup::float8 AS markup,
                        customer_price::float8 AS customer_price, customer_answer_status
                   FROM core_jrmhoteloffer WHERE request_id = ANY($1::bigint[])`, [reqIds])
      : [];
    const requests = reqIds.length
      ? await q(`SELECT id, status FROM core_jrmhotelrequest WHERE id = ANY($1::bigint[])`, [reqIds])
      : [];
    return { nesherInPeriod, reservations, nesherAll, jrmInPeriod, jrmAll, offers, requests };
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* nothing was written */ }
    if (client !== pool && typeof client.release === "function") client.release();
  }
}

function currencyOf(s) {
  const c = String(s || "").trim().toLowerCase();
  if (/^(usd|us\$|\$|dollars?)$/.test(c)) return "USD";
  if (/^(ils|nis|shek|shekels?|₪)$/.test(c)) return "ILS";
  return null;
}

/** The supplier cost the CRM knows for a hotel request, in USD, or why it is unknown. */
export function jrmCost(requestId, offers, payments) {
  const own = offers.filter((o) => String(o.request_id) === String(requestId));
  const paidOffer = [...new Set(payments.filter((p) => p.offer_id != null).map((p) => String(p.offer_id)))];
  let offer = null;
  if (paidOffer.length === 1) offer = own.find((o) => String(o.id) === paidOffer[0]) || null;
  else if (paidOffer.length > 1) return { amount: null, status: "unknown", basis: "payments point at more than one offer" };
  if (!offer) {
    const chosen = own.filter((o) => ["wants_to_book", "booked"].includes(String(o.customer_answer_status)));
    if (chosen.length === 1) offer = chosen[0];
    else if (!own.length) return { amount: null, status: "unknown", basis: "the request has no hotel offer in the CRM" };
    else return { amount: null, status: "unknown", basis: `${own.length} offers, none marked as the one booked` };
  }
  if (!(offer.hotel_price > 0)) return { amount: null, status: "unknown", basis: "the booked offer has no hotel price" };
  const cur = currencyOf(offer.currency);
  if (cur === "ILS") return { amount: null, status: "unknown", basis: `hotel cost is in shekels (${r2(offer.hotel_price)}); no dollar rate is on file for it`, ils: r2(offer.hotel_price) };
  if (cur !== "USD") return { amount: null, status: "unknown", basis: "the offer's currency is not stated" };
  if (offer.customer_price > 0 && offer.hotel_price > offer.customer_price) return { amount: null, status: "unknown", basis: "hotel price above the customer price - the currency looks wrong on the offer" };
  return { amount: r2(offer.hotel_price), status: "known", basis: "hotel price on the booked offer (USD)" };
}

/** Each transaction's share of its batch's measured fee. Sales share by amount; a batch with no
 *  sales (refunds only) still cost a fee, and that fee is carried on its refunds. */
export function feeShares(batches) {
  const feeOf = new Map();
  const statusOf = new Map();
  for (const b of batches || []) {
    for (const it of b.items) {
      statusOf.set(it.id, b.match);
      if (!b.fee) continue;
      if (b.gross_sales > 0) { if (it.amount > 0) feeOf.set(it.id, b.fee.feeExact * (it.amount / b.gross_sales)); }
      else if (b.refunds > 0 && it.amount < 0) feeOf.set(it.id, b.fee.feeExact * (-it.amount / b.refunds));
    }
  }
  return { feeOf, statusOf };
}

// ── the map ─────────────────────────────────────────────────────────────────
function blankBrand() {
  return {
    card: {
      gross_sales: 0, sale_count: 0, refunds: 0, refund_count: 0, net: 0, average_ticket: null,
      voids_excluded: { count: 0, amount: 0 },
      authorised_not_captured: { count: 0, amount: 0 },
      by_merchant_account: {}, by_card_brand: {}, by_rep: {},
    },
    mercury_invoices: { paid: 0, count: 0, fee_measured: 0, fee_unmeasured_on: 0 },
    confirmed_total: 0,
    fees: { measured: 0, measured_on: 0, effective_rate: null, awaiting_deposit_on: 0, unsettled_on: 0, unmatched_on: 0 },
    recorded_other_rails: {},
  };
}
const add = (o, k, v) => { o[k] = (o[k] || 0) + v; };

/**
 * Build the whole answer from the three sources. Pure (sources are passed in), so the tests drive it
 * with fixtures. A missing source makes its numbers null with the reason, never zero.
 */
export function buildMoneyMap({ period, nowMs, nmi, bank, invoices, crm, sources }) {
  const notes = [];
  const out = {
    ok: true,
    build: MONEY_MAP_BUILD,
    as_of: iso(nowMs),
    period: { kind: period.kind, start: period.start, end: period.end, start_at: period.start_at, end_at: period.end_at, tz: period.tz, open: period.open },
    definitions: {
      processed: "Card sales the processor approved (Pinpoint / NMI), by sale date in Israel time, voids left out, refunds shown beside them; plus Mercury invoices marked Paid. A sale, its settlement and its bank deposit are ONE payment, counted once.",
      cash: "What landed in Nesher checking in the period: processor deposits, Square and Stripe payouts, other credits.",
      fees: "Measured = what the processor actually took, read from the bank: the daily discount debit beside each batch deposit, or a deposit short of its batch. Anything estimated says so and gives its formula.",
      contribution: "Per booking, only where the supplier cost is known: money received minus the cost in the CRM minus card fees minus refunds. Not profit: overheads, salaries and tax are not in it.",
      revenue: "Not computed by the money map.",
    },
    brands: { nesher: blankBrand(), jrm: blankBrand() },
    unbranded: { count: 0, amount: 0 },
    merchant_accounts: {},
    batches: [],
    match_summary: null,
    bank: null,
    bookings: null,
    late_events: [],
    notes,
    sources,
  };
  const inPeriod = (ms) => ms != null && ms >= period.startMs && ms < period.endMs;

  // ---- NMI transactions ----
  const txns = nmi ? nmi.map((t) => ({ ...t, money: classifyTransaction(t) })) : null;
  const byId = new Map((txns || []).map((t) => [t.id, t]));
  const crmBrandOfTxn = new Map(); // filled from the CRM link below
  let rateAll = null;
  let batches = [];
  let match = null;

  // CRM card rows <-> processor sales (the same payment, trap 16.5.1). By marker, else by exact
  // amount within 7 days when that pairing is unique BOTH ways; anything else stays unlinked.
  const links = new Map(); // crm row key -> txn id
  const txnToRow = new Map();
  if (crm && txns) {
    const cardRows = [
      ...crm.nesherAll.map((p) => ({ key: "n" + p.id, brand: "nesher", booking: "res:" + p.reservation_id, amount: p.amount, method: p.method, ms: Date.parse(p.paid_at), nmi: p.nmi_txn })),
      ...crm.jrmAll.map((p) => ({ key: "j" + p.id, brand: "jrm", booking: "req:" + p.request_id, amount: p.amount, method: p.method, ms: ilMidnightMs(String(p.payment_date).slice(0, 10)), nmi: p.nmi_txn })),
    ].filter((r) => r.method === "card" || r.nmi);
    for (const r of cardRows) if (r.nmi && byId.has(r.nmi)) { links.set(r.key, r.nmi); txnToRow.set(r.nmi, r); }
    const openSales = txns.filter((t) => t.money.kind === "sale" && !t.money.voided && !txnToRow.has(t.id) && !/^(RES|JRM)-/i.test(String(t.orderId || "")));
    // Mutual nearest: the row's closest same-amount sale must have that row as ITS closest, and
    // neither closest may be a tie. Repeated until nothing more links.
    const dist = (r, t) => (same(r.amount, t.money.amount) ? Math.abs(r.ms - ilMidnightMs(ilDate(t.money.at))) : Infinity);
    const nearest = (items, score) => {
      const ranked = items.map((x) => ({ x, d: score(x) })).filter((o) => o.d <= CARD_LINK_DAYS * 86400000).sort((p, q) => p.d - q.d);
      if (!ranked.length || (ranked.length > 1 && ranked[0].d === ranked[1].d)) return null;
      return ranked[0].x;
    };
    for (let changed = true; changed;) {
      changed = false;
      for (const r of cardRows) {
        if (links.has(r.key)) continue;
        const t = nearest(openSales.filter((x) => !txnToRow.has(x.id)), (x) => dist(r, x));
        if (!t) continue;
        const back = nearest(cardRows.filter((x) => !links.has(x.key)), (x) => dist(x, t));
        if (back !== r) continue;
        links.set(r.key, t.id);
        txnToRow.set(t.id, r);
        changed = true;
      }
    }
    for (const [id, r] of txnToRow) crmBrandOfTxn.set(id, r.brand);
  }

  if (txns) {
    batches = buildBatches(txns);
    match = bank ? matchBatches(batches, bank, nowMs) : null;
    if (!bank) for (const b of batches) b.match = "bank_unavailable";
    // Fee per transaction: its share of its batch's measured fee, by sale amount.
    const { feeOf, statusOf } = feeShares(batches);
    let feeSum = 0;
    let feeBase = 0;
    for (const b of batches) if (b.fee) { feeSum += b.fee.feeExact; feeBase += b.gross_sales; }
    rateAll = feeBase > 0 ? feeSum / feeBase : null;

    const midOf = (pid) => (out.merchant_accounts[pid || "unknown"] ||= { label: MERCHANT_ACCOUNTS[pid]?.label || "unknown", gross_sales: 0, sale_count: 0, fee_measured: 0, fee_measured_on: 0, effective_rate: null });
    const saleBrand = new Map();
    for (const t of txns) {
      const m = t.money;
      const bo = brandOf(t, crmBrandOfTxn.get(t.id));
      t.brand = bo.brand;
      t.brandBasis = bo.basis;
      saleBrand.set(t.id, bo.brand);
    }
    for (const t of txns) {
      const m = t.money;
      if (m.kind === "refund" && t.originalId && saleBrand.get(t.originalId)) t.brand = saleBrand.get(t.originalId);
      const B = t.brand ? out.brands[t.brand] : null;
      if (m.kind === "sale" && inPeriod(m.at)) {
        if (m.voided) {
          if (B) { B.card.voids_excluded.count++; B.card.voids_excluded.amount += m.amount; }
          if (m.voidAt != null && m.voidAt >= period.endMs) out.late_events.push({ type: "void_after_close", transaction_id: t.id, amount: m.amount, sale_at: iso(m.at), void_at: iso(m.voidAt), effect: "the period's card sales are lower by this amount than they read before the void" });
          continue;
        }
        if (!B) { out.unbranded.count++; out.unbranded.amount += m.amount; continue; }
        B.card.gross_sales += m.amount;
        B.card.sale_count++;
        add(B.card.by_merchant_account, t.processorId || "unknown", m.amount);
        add(B.card.by_card_brand, t.cardType || "unknown", m.amount);
        add(B.card.by_rep, t.rep || "not stamped", m.amount);
        const mid = midOf(t.processorId);
        mid.gross_sales += m.amount;
        mid.sale_count++;
        const st = statusOf.get(t.id);
        if (feeOf.has(t.id)) {
          B.fees.measured += feeOf.get(t.id);
          B.fees.measured_on += m.amount;
          mid.fee_measured += feeOf.get(t.id);
          mid.fee_measured_on += m.amount;
        } else if (!st) B.fees.unsettled_on += m.amount;
        else if (st === "awaiting_deposit") B.fees.awaiting_deposit_on += m.amount;
        else B.fees.unmatched_on += m.amount;
        // a refund after the close of a sale made in this period does not rewrite this period
        for (const r of txns) {
          if (r.money.kind === "refund" && r.originalId === t.id && r.money.at >= period.endMs) {
            out.late_events.push({ type: "refund_after_close", transaction_id: r.id, of_sale: t.id, amount: r.money.amount, at: iso(r.money.at), effect: "counted in the period the refund was made, not here" });
          }
        }
      } else if (m.kind === "refund" && inPeriod(m.at)) {
        if (!B) { out.unbranded.count++; out.unbranded.amount -= m.amount; continue; }
        B.card.refunds += m.amount;
        B.card.refund_count++;
        if (feeOf.has(t.id)) {
          B.fees.measured += feeOf.get(t.id);
          B.fees.on_refund_batches = (B.fees.on_refund_batches || 0) + feeOf.get(t.id);
          const md = midOf(t.processorId);
          md.fee_measured += feeOf.get(t.id);
          md.fee_on_refund_batches = (md.fee_on_refund_batches || 0) + feeOf.get(t.id);
        }
        const orig = t.originalId ? byId.get(t.originalId) : null;
        if (orig && orig.money.at != null && orig.money.at < period.startMs) B.card.refunds_of_earlier_sales = r2((B.card.refunds_of_earlier_sales || 0) + m.amount);
      } else if (m.kind === "auth_only" && inPeriod(m.at) && B) {
        B.card.authorised_not_captured.count++;
        B.card.authorised_not_captured.amount += m.amount;
      }
    }
    // batches out
    out.batches = batches.map((b) => ({
      merchant_account: b.processor_id,
      batch_id: b.batch_id,
      settled_at: iso(b.settledMs),
      settled_date: b.settledMs != null ? ilDate(b.settledMs) : null,
      gross_sales: r2(b.gross_sales),
      refunds: r2(b.refunds),
      net: r2(b.net),
      count: b.count,
      match: b.match,
      deposit: b.deposit,
      fee: b.fee ? { amount: b.fee.amount, measured: true, source: b.fee.source, shared_in_deposit: b.fee.shared_in_deposit } : null,
      effective_rate: b.fee ? pct(b.fee.feeExact, b.gross_sales) : null,
    })).filter((b) => b.settled_date && b.settled_date >= addDaysYmd(period.start, -3) && b.settled_date <= addDaysYmd(period.end, 9));
    const mcount = (s) => out.batches.filter((b) => b.match === s).length;
    out.match_summary = {
      batches: out.batches.length,
      matched: mcount("one_to_one") + mcount("many_to_one") + mcount("net_of_fee"),
      one_to_one: mcount("one_to_one"),
      many_to_one: mcount("many_to_one"),
      net_of_fee: mcount("net_of_fee"),
      with_measured_fee: out.batches.filter((b) => b.fee).length,
      awaiting_deposit: mcount("awaiting_deposit"),
      unmatched: mcount("unmatched"),
      zero_net: mcount("zero_net"),
      deposits_not_matched: match ? match.unmatchedDeposits.filter((d) => inPeriod(d.createdMs)).map((d) => ({ at: iso(d.createdMs), amount: r2(d.amount), merchant_account: d.mid })) : null,
      fee_debits_not_matched: match ? match.unassignedFees.filter((f) => inPeriod(f.createdMs)).map((f) => ({ at: iso(f.createdMs), amount: r2(-f.amount), merchant_account: f.mid, reason: f.reason })) : null,
      rule: "A batch is matched only to a deposit on the same merchant account for exactly its total (or several batches for exactly their sum); anything else stays unmatched, never guessed.",
    };
  } else {
    notes.push("Card figures are not available: the processor's record could not be read (" + (sources.nmi?.error || "unknown") + ").");
    out.brands.nesher.card = null;
    out.brands.jrm.card = null;
  }

  // ---- Mercury invoices (the invoice rail) ----
  const credits = bank ? bank.filter((r) => r.group === "other_credit") : [];
  if (invoices) {
    const usedCredit = new Set();
    for (const inv of invoices) {
      if (String(inv.status) !== "Paid") continue;
      const ms = Date.parse(inv.updatedAt || "");
      if (!inPeriod(ms)) continue;
      const brand = /^JRM-/i.test(String(inv.invoiceNumber || "")) ? "jrm" : "nesher";
      const I = out.brands[brand].mercury_invoices;
      const amt = Number(inv.amount) || 0;
      I.paid += amt;
      I.count++;
      const c = credits
        .filter((x) => !usedCredit.has(x.id) && x.createdMs >= ms - 86400000 && x.createdMs <= ms + 10 * 86400000 && x.amount <= amt + CENT && x.amount >= 0.9 * amt)
        .sort((a, b) => Math.abs(amt - a.amount) - Math.abs(amt - b.amount))[0];
      if (c) { usedCredit.add(c.id); I.fee_measured += amt - c.amount; }
      else I.fee_unmeasured_on += amt;
    }
    notes.push("A Mercury invoice's paid date is the time Mercury last updated it (the API gives no separate paid-at).");
  } else notes.push("Mercury invoices could not be read (" + (sources.invoices?.error || "unknown") + ").");

  // ---- per brand finish ----
  for (const [name, B] of Object.entries(out.brands)) {
    if (B.card) {
      B.card.net = r2(B.card.gross_sales - B.card.refunds);
      B.card.average_ticket = B.card.sale_count ? r2(B.card.gross_sales / B.card.sale_count) : null;
      for (const k of ["gross_sales", "refunds"]) B.card[k] = r2(B.card[k]);
      B.card.voids_excluded.amount = r2(B.card.voids_excluded.amount);
      B.card.authorised_not_captured.amount = r2(B.card.authorised_not_captured.amount);
      for (const o of [B.card.by_merchant_account, B.card.by_card_brand, B.card.by_rep]) for (const k of Object.keys(o)) o[k] = r2(o[k]);
      if (name === "jrm" && B.card.by_merchant_account.mav7067) {
        notes.push(`JRM card sales of ${r2(B.card.by_merchant_account.mav7067)} ran on the NESHER merchant account; they are counted under JRM, and their fee share is under JRM too.`);
      }
    }
    B.mercury_invoices.paid = r2(B.mercury_invoices.paid);
    B.mercury_invoices.fee_measured = r2(B.mercury_invoices.fee_measured);
    B.mercury_invoices.fee_unmeasured_on = r2(B.mercury_invoices.fee_unmeasured_on);
    B.confirmed_total = B.card ? r2(B.card.net + B.mercury_invoices.paid) : null;
    const F = B.fees;
    F.effective_rate = pct(F.measured - (F.on_refund_batches || 0), F.measured_on);
    F.measured = r2(F.measured);
    if (F.on_refund_batches) F.on_refund_batches = r2(F.on_refund_batches);
    F.measured_on = r2(F.measured_on);
    for (const k of ["awaiting_deposit_on", "unsettled_on", "unmatched_on"]) F[k] = r2(F[k]);
    F.label = "Measured from the bank: each sale's share (by amount) of its batch's fee debit. Sales whose batch has no deposit yet carry no fee here.";
    if (F.awaiting_deposit_on + F.unsettled_on > 0 && F.effective_rate != null) {
      F.estimated_on_rest = { amount: r2((F.awaiting_deposit_on + F.unsettled_on) * F.effective_rate), estimate: true, label: `estimate: ${r2(F.awaiting_deposit_on + F.unsettled_on)} not yet deposited x the measured rate ${r2(F.effective_rate * 100)}%` };
    }
  }
  for (const m of Object.values(out.merchant_accounts)) {
    m.effective_rate = pct(m.fee_measured - (m.fee_on_refund_batches || 0), m.fee_measured_on);
    if (m.fee_on_refund_batches) m.fee_on_refund_batches = r2(m.fee_on_refund_batches);
    m.gross_sales = r2(m.gross_sales);
    m.fee_measured = r2(m.fee_measured);
    m.fee_measured_on = r2(m.fee_measured_on);
  }
  out.unbranded.amount = r2(out.unbranded.amount);
  if (out.unbranded.count) notes.push(`${out.unbranded.count} card sale(s) could not be put under a brand; they are shown apart, not guessed.`);

  // ---- the bank in the period ----
  if (bank) {
    const inP = bank.filter((r) => inPeriod(r.createdMs));
    const sum = (f) => r2(inP.filter(f).reduce((s, r) => s + r.amount, 0));
    const cnt = (f) => inP.filter(f).length;
    const midF = (mid, type) => (r) => r.group === "merchant" && r.mid === mid && r.type === type;
    out.bank = {
      account: "Nesher checking",
      processor_deposits: Object.fromEntries(Object.keys(MERCHANT_ACCOUNTS).map((mid) => [mid, { count: cnt(midF(mid, "deposit")), amount: sum(midF(mid, "deposit")), fee_debits: -sum(midF(mid, "discount")) }])),
      chargebacks: { count: cnt((r) => r.group === "merchant" && r.type === "chargeback"), amount: -sum((r) => r.group === "merchant" && r.type === "chargeback"), label: "Chargebacks and their fees show here only when the processor debits them separately." },
      other_processor_fees: { count: cnt((r) => r.group === "merchant" && (r.type === "processor_fee" || r.type === "processor_debit")), amount: -sum((r) => r.group === "merchant" && (r.type === "processor_fee" || r.type === "processor_debit")) },
      mercury_fees: {
        subscription: -sum((r) => r.group === "mercury_subscription"),
        wire_and_fx: -sum((r) => r.group === "mercury_wire_fee"),
        total: -sum((r) => r.group === "mercury_subscription" || r.group === "mercury_wire_fee"),
        measured: true,
      },
      square_payouts: { count: cnt((r) => r.group === "square" && r.amount > 0), amount: sum((r) => r.group === "square" && r.amount > 0), label: "Square pays out net of its fee; the gross and the fee are not visible without Square access." },
      stripe_payouts: { count: cnt((r) => r.group === "stripe" && r.amount > 0), amount: sum((r) => r.group === "stripe" && r.amount > 0) },
      other_credits: { count: cnt((r) => r.group === "other_credit"), amount: sum((r) => r.group === "other_credit"), label: "Wires, ACH, Zelle and transfers into checking; not stamped with a brand by the bank." },
      cashback: sum((r) => r.group === "cashback"),
      pending_rows: cnt((r) => r.pending),
    };
    out.bank.cash_in = r2(Object.values(out.bank.processor_deposits).reduce((s, d) => s + d.amount, 0) + out.bank.square_payouts.amount + out.bank.stripe_payouts.amount + out.bank.other_credits.amount);
    if (!out.bank.chargebacks.count) notes.push("No chargeback or chargeback fee was debited in the period.");
    if (!out.bank.other_processor_fees.count) notes.push("No monthly or other processor fee was debited in the period; any such fee is measured only once it appears in the bank.");
  } else {
    notes.push("Bank figures and every measured fee are not available: Nesher checking could not be read (" + (sources.mercury?.error || "unknown") + ").");
  }

  // ---- CRM-recorded rails (a rep's record, not a bank confirmation - 16.3) ----
  if (crm) {
    for (const p of crm.nesherInPeriod) {
      if (p.method === "card" || p.method === "mercury") continue;
      add(out.brands.nesher.recorded_other_rails, p.method || "other", p.amount);
    }
    for (const p of crm.jrmInPeriod) {
      if (p.method === "card" || p.method === "mercury") continue;
      add(out.brands.jrm.recorded_other_rails, p.method || "other", p.amount);
    }
    for (const B of Object.values(out.brands)) {
      for (const k of Object.keys(B.recorded_other_rails)) B.recorded_other_rails[k] = r2(B.recorded_other_rails[k]);
      B.recorded_other_rails_label = "Recorded by a rep in the CRM (cash, Zelle, bank, check...). Not confirmed by a bank or processor, so not in confirmed_total.";
    }
  }

  // ---- contribution per booking ----
  const nmiFromMs = sources?.nmi?.window?.from ? Date.parse(sources.nmi.window.from) : null;
  if (crm) out.bookings = buildBookings({ crm, txns, txnToRow, rateAll, inPeriod, batches, nmiFromMs });
  else notes.push("Contribution per booking is not available: the CRM could not be read (" + (sources.crm?.error || "unknown") + ").");
  return out;
}

function buildBookings({ crm, txns, txnToRow, rateAll, inPeriod, batches, nmiFromMs }) {
  const { feeOf } = feeShares(batches);
  const resById = new Map(crm.reservations.map((r) => [String(r.id), r]));
  const resByCode = new Map(crm.reservations.map((r) => [String(r.reservation_code).toUpperCase(), r]));
  const bookings = new Map();
  const get = (key, brand, ref) => {
    if (!bookings.has(key)) bookings.set(key, { key, brand, ref, rows: [], sales: [], refunds: 0, inPeriod: false });
    return bookings.get(key);
  };
  for (const p of crm.nesherAll) {
    const r = resById.get(String(p.reservation_id));
    const bk = get("res:" + p.reservation_id, "nesher", r ? r.reservation_code : String(p.reservation_id));
    bk.rows.push({ key: "n" + p.id, amount: p.amount, method: p.method, ms: Date.parse(p.paid_at) });
  }
  for (const p of crm.jrmAll) {
    const bk = get("req:" + p.request_id, "jrm", "JRM-1" + p.request_id);
    bk.rows.push({ key: "j" + p.id, amount: p.amount, method: p.method, ms: ilMidnightMs(String(p.payment_date).slice(0, 10)), offer_id: p.offer_id, currency: p.currency });
  }
  for (const bk of bookings.values()) if (bk.rows.some((r) => inPeriod(r.ms))) bk.inPeriod = true;
  // processor sales that carry a booking reference but have no CRM row yet are still money in
  for (const t of txns || []) {
    const m = t.money;
    if (m.kind !== "sale" || m.voided) continue;
    const ref = String(t.orderId || "").toUpperCase();
    let key = null;
    let brand = null;
    let label = null;
    const res = ref.match(/^RES-([A-Z0-9_-]+)$/);
    const jrm = ref.match(/^JRM-1([0-9]+)(?:-O[0-9]+)?$/);
    if (res && resByCode.has(res[1])) { const r = resByCode.get(res[1]); key = "res:" + r.id; brand = "nesher"; label = r.reservation_code; }
    else if (jrm) { key = "req:" + jrm[1]; brand = "jrm"; label = "JRM-1" + jrm[1]; }
    const row = txnToRow.get(t.id);
    if (row) key = row.booking;
    if (!key) continue;
    const bk = get(key, brand || (key.startsWith("req:") ? "jrm" : "nesher"), label || key);
    bk.sales.push({ id: t.id, amount: m.amount, inCrm: Boolean(row), ms: m.at });
    if (inPeriod(m.at)) bk.inPeriod = true;
    for (const r of txns) if (r.money.kind === "refund" && r.originalId === t.id) bk.refunds += r.money.amount;
  }
  const linkedRows = new Set([...txnToRow.values()].map((r) => r.key));
  const items = [];
  for (const bk of bookings.values()) {
    if (!bk.inPeriod) continue;
    const crmIn = bk.rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    const crmOut = -bk.rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0);
    const notInCrm = bk.sales.filter((s) => !s.inCrm).reduce((s, x) => s + x.amount, 0);
    const received = crmIn + notInCrm;
    const receivedInPeriod = bk.rows.filter((r) => r.amount > 0 && inPeriod(r.ms)).reduce((s, r) => s + r.amount, 0)
      + bk.sales.filter((s) => !s.inCrm && inPeriod(s.ms)).reduce((s, x) => s + x.amount, 0);
    const refunds = crmOut + bk.refunds;
    // card fees: measured where the processor sale is linked to a matched batch; else estimated
    let measured = 0;
    let estimatedOn = 0;
    for (const s of bk.sales) {
      if (feeOf.has(s.id)) measured += feeOf.get(s.id);
      else estimatedOn += s.amount;
    }
    // A CRM card row with no sale in our processor's record may have been charged by the airline or
    // another processor: its fee is NOT known and is not estimated at our rate (it may be zero).
    let notInProcessor = 0;
    let notChecked = 0;
    for (const r of bk.rows) {
      if (r.method !== "card" || linkedRows.has(r.key) || !(r.amount > 0)) continue;
      if (nmiFromMs != null && r.ms < nmiFromMs) notChecked += r.amount;
      else notInProcessor += r.amount;
    }
    const estimated = rateAll != null ? estimatedOn * rateAll : null;
    // cost
    let cost;
    let price = null;
    if (bk.brand === "nesher") {
      const r = resById.get(bk.key.slice(4));
      price = r && r.customer_price > 0 ? r2(r.customer_price) : null;
      if (!r) cost = { amount: null, status: "unknown", basis: "reservation not found" };
      else if (r.supplier_cost > 0) cost = { amount: r2(r.supplier_cost), status: "known", basis: r.booked_with_points ? "supplier cost in the CRM (points valued by the CRM)" : "supplier cost in the CRM" };
      else cost = { amount: null, status: "unknown", basis: "no supplier cost in the CRM" };
    } else {
      const reqRows = crm.jrmAll.filter((p) => "req:" + p.request_id === bk.key);
      cost = jrmCost(bk.key.slice(4), crm.offers, reqRows);
      const off = cost.status === "known" ? crm.offers.find((o) => String(o.request_id) === bk.key.slice(4) && o.customer_price > 0 && currencyOf(o.currency) === "USD") : null;
      price = off ? r2(off.customer_price) : null;
    }
    const flags = [];
    if (price != null && received > price + 1) flags.push("received more than the booking price");
    if (cost.status === "known" && price != null && same(cost.amount, price)) flags.push("cost equals price in the CRM");
    let contribution;
    if (cost.status !== "known") contribution = { amount: null, label: "cost unknown - " + cost.basis };
    else if (estimatedOn > 0 && estimated == null) contribution = { amount: null, label: "card fee unknown: no batch fee measured yet to estimate from" };
    else {
      const amount = received - cost.amount - measured - (estimated || 0) - refunds;
      const paidInFull = price != null && received >= price - 0.01;
      const overpaid = price != null && received > price + 1;
      const final = paidInFull && !overpaid;
      contribution = {
        amount: r2(amount),
        estimate: estimatedOn > 0,
        final,
        label: ([
          estimatedOn > 0 ? `includes an estimated card fee: ${r2(estimatedOn)} not yet deposited x measured rate ${r2(rateAll * 100)}%` : null,
          notInProcessor > 0 ? `no card fee taken off for ${r2(notInProcessor)} of card payments that are not in our processor's record (charged elsewhere - their fee is not known)` : null,
          notChecked > 0 ? `no card fee taken off for ${r2(notChecked)} of card payments older than the processor record read for this answer` : null,
        ].filter(Boolean).join("; ") || "every part measured or recorded")
          + (overpaid ? "; not final - more was received than the booking price (a duplicate row or an old price) - check before trusting"
            : paidInFull ? "" : "; not final - the booking is not paid in full, so the cost is ahead of the money"),
      };
      if (final && amount < 0) flags.push("negative contribution");
    }
    items.push({
      ref: bk.ref,
      brand: bk.brand,
      price,
      received_to_date: r2(received),
      received_in_period: r2(receivedInPeriod),
      processor_sales_not_in_crm: r2(notInCrm),
      refunds: r2(refunds),
      cost,
      card_fees: { measured: r2(measured), estimated: estimated == null ? null : r2(estimated), estimated_on: r2(estimatedOn), not_in_processor_record: r2(notInProcessor), older_than_processor_read: r2(notChecked) },
      contribution,
      flags,
    });
  }
  items.sort((a, b) => a.brand.localeCompare(b.brand) || String(a.ref).localeCompare(String(b.ref)));
  const known = items.filter((i) => i.cost.status === "known");
  const finals = known.filter((i) => i.contribution.amount != null && i.contribution.final);
  const summary = {};
  for (const brand of ["nesher", "jrm"]) {
    const mine = items.filter((i) => i.brand === brand);
    const f = finals.filter((i) => i.brand === brand);
    summary[brand] = {
      bookings: mine.length,
      cost_known: mine.filter((i) => i.cost.status === "known").length,
      cost_unknown: mine.filter((i) => i.cost.status !== "known").length,
      paid_in_full_with_known_cost: f.length,
      contribution_paid_in_full: f.length ? r2(f.reduce((s, i) => s + i.contribution.amount, 0)) : null,
      contribution_includes_estimate: f.some((i) => i.contribution.estimate),
      card_payments_not_in_processor_record: r2(mine.reduce((s, i) => s + i.card_fees.not_in_processor_record, 0)),
      card_payments_older_than_processor_read: r2(mine.reduce((s, i) => s + i.card_fees.older_than_processor_read, 0)),
    };
  }
  return {
    count: items.length,
    cost_known: known.length,
    cost_unknown: items.length - known.length,
    by_brand: summary,
    label: "Bookings that took customer money in this period. Contribution totals add only bookings paid in full whose cost is known; bookings with unknown cost are counted, never priced at zero.",
    items: items.slice(0, 300),
  };
}

// ── the service door ────────────────────────────────────────────────────────
export function createMoneyMap(opts = {}) {
  const now = opts.now || (() => Date.now());
  const nmiConfig = opts.nmiConfig || (() => ({ host: "", securityKey: "" }));
  const mercuryRead = opts.mercuryRead || null;
  const getPool = opts.getPool || (() => null);
  const fetchImpl = opts.fetchImpl;
  const cacheMs = Number(opts.cacheMs ?? 60000);
  const cache = new Map();
  const stats = { calls: 0, cache_hits: 0, errors: 0, last_at: null, last_ms: null, last_error: null };

  async function sourceNmi(period, nowMs) {
    const cfg = nmiConfig();
    if (!cfg.host || !cfg.securityKey) return { data: null, meta: { ok: false, error: "not_configured" } };
    try {
      const since = new Date(period.startMs - 5 * 86400000);
      const until = new Date(Math.min(nowMs, period.endMs + 9 * 86400000));
      const xml = await queryNmiRange({ host: cfg.host, securityKey: cfg.securityKey, since, until, fetchImpl });
      const txns = parseNmiTransactions(xml);
      return { data: txns, meta: { ok: true, transactions: txns.length, window: { from: since.toISOString(), to: until.toISOString() } } };
    } catch (e) {
      const msg = String(e?.message || "failed");
      return { data: null, meta: { ok: false, error: /^nmi_query_[a-z_0-9]+$/.test(msg) ? msg : "nmi_read_failed" } };
    }
  }
  async function sourceBank(period, nowMs) {
    if (!mercuryRead) return { data: null, meta: { ok: false, error: "not_configured" } };
    const start = ilDate(period.startMs - 2 * 86400000);
    const end = addDaysYmd(ilDate(Math.min(nowMs, period.endMs + 10 * 86400000)), 1);
    try {
      const r = await mercuryRead("money-map", `/transactions?start=${start}&end=${end}&account=checking`);
      if (!r || r.status !== 200) return { data: null, meta: { ok: false, error: `mercury_${r ? r.status : "no_answer"}` } };
      const body = JSON.parse(r.body);
      return { data: bankRows(body.transactions), meta: { ok: true, rows: (body.transactions || []).length, served_by: r.servedBy || null, window: { start, end } } };
    } catch {
      return { data: null, meta: { ok: false, error: "mercury_read_failed" } };
    }
  }
  async function sourceInvoices() {
    if (!mercuryRead) return { data: null, meta: { ok: false, error: "not_configured" } };
    try {
      const r = await mercuryRead("money-map", "/invoices");
      if (!r || r.status !== 200) return { data: null, meta: { ok: false, error: `mercury_${r ? r.status : "no_answer"}` } };
      const body = JSON.parse(r.body);
      if (body.complete !== true) return { data: null, meta: { ok: false, error: "invoices_incomplete" } };
      return { data: body.invoices || [], meta: { ok: true, invoices: (body.invoices || []).length, served_by: r.servedBy || null } };
    } catch {
      return { data: null, meta: { ok: false, error: "invoices_read_failed" } };
    }
  }
  async function sourceCrm(period, nmi) {
    const pool = getPool();
    if (!pool) return { data: null, meta: { ok: false, error: "not_configured" } };
    const refs = { res: [], jrm: [] };
    for (const t of nmi || []) {
      const ref = String(t.orderId || "").toUpperCase();
      const a = ref.match(/^RES-([A-Z0-9_-]+)$/);
      const b = ref.match(/^JRM-1([0-9]+)(?:-O[0-9]+)?$/);
      if (a) refs.res.push(a[1]);
      if (b) refs.jrm.push(b[1]);
    }
    try {
      const data = await loadCrm(pool, period, refs);
      return { data, meta: { ok: true, read_only: true } };
    } catch (e) {
      return { data: null, meta: { ok: false, error: /money_map_refused_write/.test(String(e?.message)) ? "refused_write" : "crm_read_failed" } };
    }
  }

  async function compute(params) {
    const nowMs = now();
    const period = periodFor(params, nowMs);
    if (period.error) return { status: 400, body: { ok: false, ...period } };
    const key = JSON.stringify([period.kind, period.start, period.end]);
    const hit = cache.get(key);
    if (hit && nowMs - hit.at < cacheMs) { stats.cache_hits++; return { status: 200, body: { ...hit.body, cached: true } }; }
    const [nmi, bank, inv] = await Promise.all([sourceNmi(period, nowMs), sourceBank(period, nowMs), sourceInvoices()]);
    const crm = await sourceCrm(period, nmi.data);
    const sources = { nmi: nmi.meta, mercury: bank.meta, invoices: inv.meta, crm: crm.meta };
    if (!nmi.data && !bank.data && !inv.data && !crm.data) return { status: 503, body: { ok: false, error: "no_source_available", sources } };
    const body = buildMoneyMap({ period, nowMs, nmi: nmi.data, bank: bank.data, invoices: inv.data, crm: crm.data, sources });
    cache.set(key, { at: nowMs, body });
    if (cache.size > 50) cache.delete(cache.keys().next().value);
    return { status: 200, body };
  }

  /** Answer a query string: period, date, start, end, bookings=0 to leave the booking list out. */
  async function answer(searchParams) {
    const t0 = Date.now();
    stats.calls++;
    try {
      const q = searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(String(searchParams || ""));
      const r = await compute({ period: q.get("period") || "month", date: q.get("date") || undefined, start: q.get("start") || undefined, end: q.get("end") || undefined });
      let body = r.body;
      if (r.status === 200 && q.get("bookings") === "0" && body.bookings) body = { ...body, bookings: { ...body.bookings, items: undefined } };
      stats.last_at = new Date().toISOString();
      stats.last_ms = Date.now() - t0;
      return { status: r.status, body };
    } catch {
      stats.errors++;
      stats.last_error = "money_map_failed";
      return { status: 500, body: { ok: false, error: "money_map_failed" } };
    }
  }

  /** For the hop door's direct hook: sub = "/money-map?period=month". Never throws, never null. */
  async function hopAnswer(sub) {
    const s = String(sub || "");
    const qs = s.includes("?") ? s.slice(s.indexOf("?") + 1) : "";
    const r = await answer(new URLSearchParams(qs));
    return { status: r.status, body: JSON.stringify(r.body) };
  }

  function health() {
    return { build: MONEY_MAP_BUILD, path: "/__money_hop" + MONEY_MAP_PATH, ...stats, cached_periods: cache.size };
  }

  return { answer, hopAnswer, health, compute };
}
