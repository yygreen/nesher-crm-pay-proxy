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

import crypto from "node:crypto";
import { recipientDraft, scrubDigits } from "./mercury-gateway.js";
import {
  bindHashOf,
  consumeTicket,
  ocrSecret,
  readLimitedBody,
  sendTicketJson,
  ticketFromHeaders,
  verifyTicket,
} from "./ocr-card.js";

/**
 * Mercury's INTERNAL note for a desk payment: the tile, who, the CRM match, and (Mr. AO, 24 Sep) the
 * notes the reps wrote on the tile before it went. Never the external memo, never a descriptor - the
 * supplier's bank sees none of it. The desk masks the notes; any 5+ digit run is cut to its last four
 * here again, and the gateway cuts the whole note at 240.
 */
const CTRL_RE = new RegExp("[" + String.fromCharCode(0) + "-" + String.fromCharCode(31) + String.fromCharCode(127) + "]", "g");
const ISO_DATE_RE = new RegExp("\\b\\d{4}-\\d{2}-\\d{2}\\b", "g");
const DATE_SLOT_RE = new RegExp(String.fromCharCode(1) + "(\\d+)" + String.fromCharCode(1), "g");
export function deskNote(tile, repId, matched, repNote) {
  // An ISO date is set aside before the digit cut (Gabbai AO C1): "2026-09-24" must reach Mercury as the rep
  // wrote it, the way the desk's own mask keeps it. A bare 5-6 digit amount still shows as its last four.
  const dates = [];
  const held = String(repNote == null ? "" : repNote).replace(CTRL_RE, " ").split(" ").filter(Boolean).join(" ")
    .replace(ISO_DATE_RE, (m) => { dates.push(m); return "\u0001" + (dates.length - 1) + "\u0001"; });
  const extra = scrubDigits(held).replace(DATE_SLOT_RE, (_, i) => dates[Number(i)] || "").slice(0, 160);
  return `${tile || "-"} by ${repId}${matched ? `; for ${matched}` : ""}${extra ? `; notes: ${extra}` : ""}`;
}

export const PAY_PREFIX = "/__nesher_pay/pay/";
export const PAY_BODY_MAX = 16 * 1024;
const TILE_RE = /^(?:mp|pr)[a-z0-9]{6,20}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FP_RE = /^[0-9a-f]{24}$/;

export function payDoorOf(pathname) {
  const p = String(pathname || "").split("?")[0].replace(/\/+$/, "");
  if (p === "/__nesher_pay/pay/prepare") return "prepare";
  if (p === "/__nesher_pay/pay/request") return "request";
  if (p === "/__nesher_pay/pay/status") return "status";
  if (p === "/__nesher_pay/pay/payee-hold") return "payee-hold";
  if (p === "/__nesher_pay/pay/recipient-add") return "recipient-add";
  if (p === "/__nesher_pay/pay/send") return "send";
  return null;
}

// ── Mr. AJ Money: pasted bank details are HELD here, never on the desk ─────────────────────────
// The desk parses what the rep pasted and sends the details here ONCE; it keeps only the reference
// this returns, the last four, the name and the bank's name. The hold is in this process's memory
// only (like the card hold), 30 minutes, bound to the rep who pasted it, spent by one successful add.
export const PAYEE_HOLD_MS = 30 * 60 * 1000;
const PAYEE_REF_RE = /^ph_[A-Za-z0-9_-]{24,40}$/;
export function createPayeeHold({ clock = Date.now, ttlMs = PAYEE_HOLD_MS, max = 200 } = {}) {
  const held = new Map();
  function prune() {
    const t = clock();
    for (const [k, v] of held) if (v.exp <= t) { v.draft = null; held.delete(k); }
    while (held.size > max) { const k = held.keys().next().value; held.get(k).draft = null; held.delete(k); }
  }
  return {
    put(draft, rep) {
      prune();
      const ref = "ph_" + crypto.randomBytes(24).toString("base64url");
      held.set(ref, { draft, rep: String(rep || ""), exp: clock() + ttlMs });
      return { ref, expiresAt: clock() + ttlMs };
    },
    get(ref, rep) {
      prune();
      if (!PAYEE_REF_RE.test(String(ref || ""))) return { error: "ref_invalid" };
      const h = held.get(ref);
      if (!h) return { error: "ref_expired" };
      if (h.rep !== String(rep || "")) return { error: "ref_other_rep" };
      return { draft: h.draft };
    },
    spend(ref) { const h = held.get(ref); if (h) { h.draft = null; held.delete(ref); } },
    size() { prune(); return held.size; },
  };
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
  // \b does not see Hebrew letters as word characters, so the start is a space or the start.
  const req = /(?:^|[\s(])(?:request|req|בקשה)\s*#?\s*(\d{3,6})\b/gi;
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
  for (const k of ["tile", "recipient", "payee", "amount_cents", "memo", "matched", "request_id", "state", "last4", "email", "mode", "txn", "reused", "dup_ok"]) if (f[k] != null) o[k] = f[k];
  // Audit #109: a memo in the log keeps only the last four of any 5+ digit run.
  // Gabbai D2: an ISO date is set aside first (the deskNote rule) - "2026-09-24" stays as written in the log.
  if (typeof o.memo === "string") {
    const dates = [];
    const held = o.memo.replace(ISO_DATE_RE, (m) => { dates.push(m); return "\u0001" + (dates.length - 1) + "\u0001"; });
    o.memo = scrubDigits(held).replace(DATE_SLOT_RE, (_, i) => dates[Number(i)] || "");
  }
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
  const holds = deps.holds || createPayeeHold({ clock });

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
    // The desk's own request closing before we answer = it stopped waiting: never POST after that.
    let gone = false;
    res.on("close", () => { if (!res.writableFinished) gone = true; });
    const out = await gateway.requestPay({
      recipientId: str(body.recipient_id, 40),
      amountCents: body.amount_cents,
      memo,
      idempotencyKey: str(body.idempotency_key, 80),
      // The gateway puts the memo FIRST, then NOTE_MARK, then this.
      note: deskNote(tile, ticket.repId, matched, body.rep_note),
      isGone: () => gone,
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
    // An approval request (request_id) or, since Mr. AJ, a sent payment (txn_id). One of the two.
    const door = await open(req, res, "paystat", (b) => {
      const rq = str(b.request_id, 40), tx = str(b.txn_id, 40);
      if (UUID_RE.test(rq) && !tx) return rq;
      if (UUID_RE.test(tx) && !rq) return "txn|" + tx;
      return "";
    });
    if (!door) return;
    const { body, finish } = door;
    const tx = str(body.txn_id, 40);
    const out = tx ? await gateway.payTxnStatus(tx) : await gateway.payStatus(str(body.request_id, 40));
    const b = out.body || {};
    finish(out.status, b, { request_id: tx ? null : str(body.request_id, 40), txn: tx || null, state: b.state || null, outcome: b.ok ? "read" : String(b.error || "error") });
  }

  // ── Mr. AJ: the pasted details go to the hold; the desk keeps a reference and the last four ──
  async function payeeHold(req, res) {
    const door = await open(req, res, "payprep", (b) => (TILE_RE.test(str(b.tile_id, 24)) && str(b.tile_id, 24).startsWith("pr") ? str(b.tile_id, 24) : ""));
    if (!door) return;
    const { body, finish } = door;
    const tile = str(body.tile_id, 24);
    if (!gateway.payCaps().recipients) return finish(404, { ok: false, error: "recipients_off" }, { tile, outcome: "recipients_off" });
    const d = body.details && typeof body.details === "object" ? body.details : {};
    const draft = recipientDraft({ name: d.name, routing: d.routing, account: d.account, type: d.type, business: d.business === true, emails: d.emails, address: d.address });
    // The numbers are off the request body the moment the draft holds them.
    if (body.details) { body.details.account = ""; body.details.routing = ""; }
    if (!draft.ok) return finish(400, { ok: false, error: draft.error }, { tile, outcome: `draft:${draft.error}` });
    const h = holds.put(draft, door.ticket.repId);
    // What Mercury already has: the same bank details (reuse), or the same name with other details.
    let same = null, twins = [];
    try {
      const all = await gateway.payRecipientsAll();
      const key = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const want = gateway.payeeFingerprintOf(draft.body);
      for (const x of all) {
        if (x.raw.status && x.raw.status !== "active") continue;
        if (want && x.view.fp === want) same = x.view;
        else if (key(x.view.name) === key(draft.body.name)) twins.push(x.view);
      }
    } catch { /* the tile says it could not check; the add checks again */ }
    finish(200, { ok: true, ref: h.ref, expires_at: new Date(h.expiresAt).toISOString(), draft: draft.view, existing: same, twins: twins.slice(0, 3) }, {
      tile, payee: draft.view.name, last4: draft.view.last4, email: draft.view.emails.join(",") || null, outcome: same ? "held:exists" : twins.length ? "held:same_name" : "held",
    });
  }

  async function recipientAdd(req, res) {
    const door = await open(req, res, "pay", (b) => (/^ph_/.test(str(b.ref, 48)) && TILE_RE.test(str(b.tile_id, 24)) ? `add|${str(b.ref, 48)}|${str(b.tile_id, 24)}` : ""));
    if (!door) return;
    const { body, finish, ticket } = door;
    const tile = str(body.tile_id, 24);
    const got = holds.get(str(body.ref, 48), ticket.repId);
    if (got.error) return finish(got.error === "ref_other_rep" ? 403 : 410, { ok: false, error: got.error }, { tile, outcome: got.error });
    let gone = false;
    res.on("close", () => { if (!res.writableFinished) gone = true; });
    const out = await gateway.addRecipient(got.draft, { allowSameName: body.allow_same_name === true, isGone: () => gone });
    const b = out.body || {};
    // Spent on a clear answer either way (made, reused, or refused for a reason a retry will not
    // change); kept on an unclear one, where the retry finds and reuses what may have been made.
    if (b.ok || (out.status >= 400 && out.status < 500 && b.error !== "same_name_other_bank")) holds.spend(str(body.ref, 48));
    finish(out.status, b, { tile, payee: b.recipient ? b.recipient.name : got.draft.view.name, last4: got.draft.view.last4, recipient: b.recipient ? b.recipient.id : null, reused: b.ok ? b.reused === true : null, outcome: b.ok ? (b.reused ? "reused" : "added") : String(b.error || "error") });
  }

  async function sendDoor(req, res) {
    const door = await open(req, res, "pay", (b) => {
      const rid = str(b.recipient_id, 40);
      const key = str(b.idempotency_key, 80);
      const fp = str(b.fp, 24);
      if (!UUID_RE.test(rid) || !Number.isInteger(b.amount_cents) || !key || !FP_RE.test(fp)) return "";
      return `send|${rid}|${b.amount_cents}|${key}|${fp}|${b.allow_dup === true ? 1 : 0}`;
    });
    if (!door) return;
    const { body, finish, ticket } = door;
    const tile = str(body.tile_id, 24);
    const memo = str(body.memo, 140);
    const matched = str(body.matched, 120);
    let gone = false;
    res.on("close", () => { if (!res.writableFinished) gone = true; });
    const out = await gateway.sendPay({
      recipientId: str(body.recipient_id, 40),
      amountCents: body.amount_cents,
      memo,
      idempotencyKey: str(body.idempotency_key, 80),
      fp: str(body.fp, 24),
      allowDup: body.allow_dup === true,
      dayCapCents: Number.isInteger(body.day_cap_cents) ? body.day_cap_cents : null,
      note: deskNote(tile, ticket.repId, matched, body.rep_note),
      isGone: () => gone,
    });
    const b = out.body || {};
    finish(out.status, b, {
      tile, recipient: str(body.recipient_id, 40), payee: b.payee ? b.payee.name : null, amount_cents: body.amount_cents, memo, matched: matched || null,
      mode: b.mode || null, txn: b.txn ? b.txn.id : null, request_id: b.request ? b.request.id : b.existing ? b.existing.id : null,
      state: b.txn ? b.txn.status : b.request ? b.request.status : null, dup_ok: body.allow_dup === true ? true : null,
      outcome: b.ok ? (b.mode === "direct" ? "sent" : "requested") : String(b.error || "error"),
    });
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
    else if (door === "payee-hold") await payeeHold(req, res);
    else if (door === "recipient-add") await recipientAdd(req, res);
    else if (door === "send") await sendDoor(req, res);
    else await status(req, res);
    return true;
  }

  return { handle };
}
