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
//   before a request exists. Nesher accounts only: checking ••5649 matched by id AND last four,
//   savings ••5926; the Richter accounts (last four 8521 and 1588) are dropped before anything is
//   named, and a transactions read is refused for any account id that did not pass that filter.
// No token value is ever logged, returned or put in health: name, presence and length only.
import { fetchWithTimeout } from "./http.js";
import { normalizeToken } from "./mercury.js";

export const MERCURY_GATEWAY_BUILD = "2026-09-23-off-the-pc";
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
      return { failed: `http_${res.status}` };
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
    return {
      build: MERCURY_GATEWAY_BUILD,
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

  return { arRequest, arFetch, hopDirect, read, listArInvoices, probe, probeStale, health, lastServed, allowedAccountIds };
}
