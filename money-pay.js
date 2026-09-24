/**
 * money-pay.js - the desk chat's door to pay a supplier (Mr Money finish line F7, 24 Sep 2026).
 *
 * Joseph, 22 Sep: "it should be able to show the amount in the bank account, make payment to
 * someonbe etc etc"; "also it should only have access to the nesher account". 23 Sep: "nothing
 * needs to work through this machine. Things need to work through APIs."
 *
 *   POST /__nesher_pay/pay/prepare {tile_id, payee_query, amount_cents, memo, rep}
 *        -> the Mercury recipient the words name (only one that passes the hard lines), the
 *           other allowed payees, what the memo matches in the CRM (a reservation, a PNR, a JRM
 *           hotel request) or null, and the caps. Reads only.
 *   POST /__nesher_pay/pay/request {tile_id, recipient_id, amount_cents, memo, matched, rep, idempotency_key}
 *        -> ONE Mercury request-send-money from Nesher checking, which WAITS FOR AN APPROVER IN
 *           THE MERCURY APP. Nothing leaves on the chat's word.
 *   POST /__nesher_pay/pay/status {request_id, rep}
 *        -> waiting / approved / sending / paid / rejected / cancelled / failed, read from Mercury.
 *
 * Auth: the desk chat's one-time ticket (ocr-card.js, OCR_TICKET_SECRET, five minutes, single use,
 * bound to the rep). Kinds and bindings:
 *   payprep -> the tile id;  pay -> "<recipient_id>|<amount_cents>|<idempotency_key>";
 *   paystat -> the request id.
 * A pay ticket minted for one payee and amount can never pay another payee or another amount.
 *
 * All Mercury work is mercury-gateway.js (checkPayOperation: five exact shapes, nothing else;
 * direct send, transfers and recipient writes stay 405). Off unless MONEY_PAY=on. The CRM is read
 * with SELECT only, inside a READ ONLY transaction. One log line per door call: who, what, amount,
 * payee, memo, matched record, Mercury's request id. Never a token, never an account number.
 */

import {
  bindHashOf,
  consumeTicket,
  ocrSecret,
  readLimitedBody,
  sendTicketJson,
  ticketFromHeaders,
  verifyTicket,
} from "./ocr-card.js";

export const PAY_PREFIX = "/__nesher_pay/pay/";
export const PAY_BODY_MAX = 16 * 1024;
const TILE_RE = /^mp[a-z0-9]{6,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function payDoorOf(pathname) {
  const p = String(pathname || "").split("?")[0].replace(/\/+$/, "");
  if (p === "/__nesher_pay/pay/prepare") return "prepare";
  if (p === "/__nesher_pay/pay/request") return "request";
  if (p === "/__nesher_pay/pay/status") return "status";
  return null;
}

function str(v, max) {
  const s = v == null ? "" : String(v).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return max ? s.slice(0, max) : s;
}

function norm(s) {
  return String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

/**
 * How well do the rep's words name this payee? 0..100. Pure.
 * Exact name or nickname 100; one starts with the other 85; every word of the query inside the
 * name/nickname 70; any shared word of 3+ letters 40.
 */
export function payeeScore(query, view) {
  const q = norm(query);
  if (!q) return 0;
  const names = [norm(view && view.name), norm(view && view.nickname)].filter(Boolean);
  let best = 0;
  for (const n of names) {
    if (n === q) best = Math.max(best, 100);
    else if (n.startsWith(q) || q.startsWith(n)) best = Math.max(best, 85);
    else {
      const qw = q.split(" ");
      const nw = new Set(n.split(" "));
      if (qw.every((w) => nw.has(w) || n.includes(w))) best = Math.max(best, 70);
      else if (qw.some((w) => w.length >= 3 && nw.has(w))) best = Math.max(best, 40);
    }
  }
  return best;
}

/** The one payee the words name, or null when none / more than one is equally close. Pure. */
export function pickPayee(query, views) {
  const scored = (views || []).map((v) => ({ v, s: payeeScore(query, v) })).filter((x) => x.s >= 70);
  scored.sort((a, b) => b.s - a.s);
  if (!scored.length) return null;
  if (scored.length > 1 && scored[1].s === scored[0].s) return null;
  return scored[0].v;
}

/** References a memo carries: PNR-like codes, JRM / FLY / RES numbers, "request 1084". Pure. */
export function memoRefs(memo) {
  const s = String(memo || "");
  const out = { codes: [], jrmRequests: [], res: [] };
  let m;
  const jrm = /\bJRM-1(\d{2,6})(?:-O\d+)?\b/gi;
  while ((m = jrm.exec(s))) out.jrmRequests.push(Number(m[1]));
  const req = /\b(?:request|req|בקשה)\s*#?\s*(\d{3,6})\b/gi;
  while ((m = req.exec(s))) out.jrmRequests.push(Number(m[1]));
  const res = /\bRES-([A-Z0-9]{4,12})\b/gi;
  while ((m = res.exec(s))) out.res.push(m[1].toUpperCase());
  const code = /\b([A-Z0-9]{6})\b/g;
  const up = s.toUpperCase().replace(/\b(?:JRM|FLY|RES)-[A-Z0-9-]+\b/g, " ");
  while ((m = code.exec(up))) {
    const c = m[1];
    if (/[A-Z]/.test(c) && /^[A-Z0-9]+$/.test(c) && !/^\d+$/.test(c)) out.codes.push(c);
  }
  // A code with a digit in it (ABC123) before a plain six-letter word (HOTELS).
  out.codes = [...new Set(out.codes)].sort((a, b) => Number(/\d/.test(b)) - Number(/\d/.test(a))).slice(0, 4);
  out.jrmRequests = [...new Set(out.jrmRequests)].slice(0, 3);
  out.res = [...new Set(out.res)].slice(0, 3);
  return out;
}

function firstName(full) {
  const w = String(full || "").trim().split(/\s+/);
  return w.length > 1 ? `${w[0]} ${w[w.length - 1]}` : w[0] || "";
}

/**
 * What the memo matches in the CRM, SELECT only, in a READ ONLY transaction. null when nothing or
 * when the CRM is not reachable (never guessed). One record: the first exact hit.
 */
export async function matchMemo(pool, memo) {
  if (!pool) return null;
  const refs = memoRefs(memo);
  if (!refs.codes.length && !refs.jrmRequests.length && !refs.res.length) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    for (const code of [...refs.res, ...refs.codes]) {
      const r = await client.query(
        `SELECT r.id, r.reservation_code, c.full_name, NULL::text AS label
           FROM core_reservation r JOIN core_customer c ON c.id = r.customer_id
          WHERE upper(r.reservation_code) = $1
         UNION ALL
         SELECT r.id, r.reservation_code, c.full_name, j.label
           FROM core_journey j JOIN core_reservation r ON r.id = j.reservation_id JOIN core_customer c ON c.id = r.customer_id
          WHERE upper(j.confirmation_number) = $1
         UNION ALL
         SELECT r.id, r.reservation_code, c.full_name, j.label
           FROM core_journeybookinggroup g JOIN core_journey j ON j.id = g.journey_id
           JOIN core_reservation r ON r.id = j.reservation_id JOIN core_customer c ON c.id = r.customer_id
          WHERE upper(g.confirmation_number) = $1
         LIMIT 3`,
        [code]
      );
      const ids = new Set(r.rows.map((x) => String(x.id)));
      if (ids.size === 1) {
        const x = r.rows[0];
        return { kind: "reservation", ref: code, id: Number(x.id), code: x.reservation_code, customer: firstName(x.full_name), label: str(x.label, 80) };
      }
    }
    for (const id of refs.jrmRequests) {
      const r = await client.query("SELECT id, customer_name FROM core_jrmhotelrequest WHERE id = $1", [id]);
      if (r.rows.length === 1) return { kind: "hotel_request", ref: `JRM-1${id}`, id, customer: firstName(r.rows[0].customer_name), label: "" };
    }
    return null;
  } catch {
    return null;
  } finally {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    client.release();
  }
}

function accessLine(door, f) {
  const o = { door, rep: f.rep || null, ticket: f.ticket || null, outcome: f.outcome || null, ms: f.ms == null ? null : f.ms };
  for (const k of ["tile", "recipient", "payee", "amount_cents", "memo", "matched", "request_id", "state"]) if (f[k] != null) o[k] = f[k];
  return `money-pay ${JSON.stringify(o)}`;
}

/**
 * The three doors. deps: {gateway, getPool, secret?, clock?, log?}. Returns true when the request
 * was on the pay prefix and has been answered.
 */
export function createMoneyPay(deps = {}) {
  const clock = typeof deps.clock === "function" ? deps.clock : Date.now;
  const log = typeof deps.log === "function" ? deps.log : console.log;
  const gateway = deps.gateway;
  const getPool = typeof deps.getPool === "function" ? deps.getPool : () => null;

  async function open(req, res, kind, bindOf) {
    const t0 = clock();
    const secret = deps.secret == null ? ocrSecret() : String(deps.secret || "");
    const done = (status, body, fields) => {
      sendTicketJson(res, status, body, { close: true });
      log(accessLine(kind, { ...fields, ms: clock() - t0 }));
    };
    if (!secret || !gateway || !gateway.payCaps().on) {
      done(404, { ok: false, error: "not_found" }, { outcome: "disabled" });
      return null;
    }
    if (String(req.method || "GET").toUpperCase() !== "POST") {
      done(405, { ok: false, error: "post_only" }, { outcome: "method" });
      return null;
    }
    const token = ticketFromHeaders(req.headers || {});
    if (!token) {
      done(401, { ok: false, error: "ticket_required" }, { outcome: "no_ticket" });
      return null;
    }
    const ticket = verifyTicket(token, { secret, now: clock(), kind });
    if (!ticket.ok) {
      done(401, { ok: false, error: `ticket_${ticket.error}` }, { ticket: ticket.ticketId || null, outcome: `bad_ticket:${ticket.error}` });
      return null;
    }
    consumeTicket(ticket.ticketId, ticket.expiresAt, { now: clock() });
    const read = await readLimitedBody(req, PAY_BODY_MAX);
    if (read.error) {
      done(read.error === "body_too_large" ? 413 : 400, { ok: false, error: read.error }, { ticket: ticket.ticketId, outcome: read.error });
      return null;
    }
    let body = null;
    try { body = JSON.parse(read.buffer.toString("utf8") || "{}"); } catch { body = null; }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      done(400, { ok: false, error: "invalid_json" }, { ticket: ticket.ticketId, outcome: "invalid_json" });
      return null;
    }
    const bound = bindOf(body);
    if (!bound || bindHashOf(kind, bound) !== ticket.bindHash) {
      done(401, { ok: false, error: "ticket_bind_mismatch" }, { ticket: ticket.ticketId, outcome: "bad_ticket:bind_mismatch" });
      return null;
    }
    if (str(body.rep, 64) !== ticket.repId) {
      done(401, { ok: false, error: "ticket_rep_mismatch" }, { ticket: ticket.ticketId, outcome: "bad_ticket:rep_mismatch" });
      return null;
    }
    return { ticket, body, finish: (status, out, fields) => done(status, out, { ticket: ticket.ticketId, rep: ticket.repId, ...fields }) };
  }

  async function prepare(req, res) {
    const door = await open(req, res, "payprep", (b) => (TILE_RE.test(str(b.tile_id, 24)) ? str(b.tile_id, 24) : ""));
    if (!door) return;
    const { body, finish } = door;
    const query = str(body.payee_query, 80);
    const memo = str(body.memo, 140);
    const tile = str(body.tile_id, 24);
    let all;
    try { all = await gateway.payRecipientsAll(); } catch (e) {
      return finish(503, { ok: false, error: "recipients_unavailable" }, { tile, outcome: `recipients:${e.detail || "error"}` });
    }
    const allowed = all.filter((x) => x.verdict.ok).map((x) => x.view);
    const best = query ? pickPayee(query, allowed) : null;
    // The words name a recipient that exists but is off-limits: say WHY, never who else is there.
    let blocked = null;
    if (query && !best) {
      const hit = all.filter((x) => !x.verdict.ok).map((x) => ({ x, s: payeeScore(query, x.view) })).filter((y) => y.s >= 70).sort((a, b) => b.s - a.s)[0];
      if (hit) blocked = { name: hit.x.view.name, why: hit.x.verdict.why };
    }
    const candidates = allowed
      .map((v) => ({ v, s: query ? payeeScore(query, v) : 0 }))
      .sort((a, b) => b.s - a.s || String(a.v.name).localeCompare(String(b.v.name)))
      .slice(0, 8)
      .map((x) => x.v);
    let match = null;
    try { match = await matchMemo(getPool(), memo); } catch { match = null; }
    const caps = gateway.payCaps();
    finish(200, { ok: true, payee: best, blocked, payees: candidates, match, caps: { max_cents: caps.maxCents, day_cents: caps.dayCents } }, {
      tile, payee: best ? best.name : null, amount_cents: Number.isInteger(body.amount_cents) ? body.amount_cents : null, memo, matched: match ? `${match.kind}:${match.ref}` : null, outcome: best ? "named" : blocked ? `blocked:${blocked.why}` : "ask",
    });
  }

  async function request(req, res) {
    const door = await open(req, res, "pay", (b) => {
      const rid = str(b.recipient_id, 40);
      const key = str(b.idempotency_key, 80);
      if (!UUID_RE.test(rid) || !Number.isInteger(b.amount_cents) || !key) return "";
      return `${rid}|${b.amount_cents}|${key}`;
    });
    if (!door) return;
    const { body, finish, ticket } = door;
    const tile = str(body.tile_id, 24);
    const memo = str(body.memo, 140);
    const matched = str(body.matched, 120);
    const out = await gateway.requestPay({
      recipientId: str(body.recipient_id, 40),
      amountCents: body.amount_cents,
      memo,
      idempotencyKey: str(body.idempotency_key, 80),
      note: `Desk chat ${tile || "-"} by ${ticket.repId}${matched ? `; for ${matched}` : ""}`,
    });
    const b = out.body || {};
    finish(out.status, b, {
      tile,
      recipient: str(body.recipient_id, 40),
      payee: b.payee ? b.payee.name : null,
      amount_cents: body.amount_cents,
      memo,
      matched: matched || null,
      request_id: b.request ? b.request.id : b.existing ? b.existing.id : null,
      state: b.request ? b.request.status : null,
      outcome: b.ok ? "requested" : String(b.error || "error"),
    });
  }

  async function status(req, res) {
    const door = await open(req, res, "paystat", (b) => (UUID_RE.test(str(b.request_id, 40)) ? str(b.request_id, 40) : ""));
    if (!door) return;
    const { body, finish } = door;
    const out = await gateway.payStatus(str(body.request_id, 40));
    const b = out.body || {};
    finish(out.status, b, { request_id: str(body.request_id, 40), state: b.state || null, outcome: b.ok ? "read" : String(b.error || "error") });
  }

  async function handle(req, res, pathname) {
    const door = payDoorOf(pathname);
    if (!door) {
      // Anything else under the prefix is answered here, never forwarded to the CRM.
      if (!String(pathname || "").startsWith(PAY_PREFIX)) return false;
      sendTicketJson(res, 404, { ok: false, error: "not_found" }, { close: true });
      return true;
    }
    if (door === "prepare") await prepare(req, res);
    else if (door === "request") await request(req, res);
    else await status(req, res);
    return true;
  }

  return { handle };
}
