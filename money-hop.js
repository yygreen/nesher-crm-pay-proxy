// money-hop.js — Mr Money's hop: signed read-only GETs from a caller (the Money agent on Vercel,
// later) relayed to the money seat on Joseph's PC WITHOUT the seat ever being reachable.
//
// The seat is never exposed. Its hop client (nesher-money-seat/hop.js) dials OUT to this service,
// holds a long-poll open on GET /__money_hop/poll, receives jobs, runs each one against its
// loopback seat, and posts the seat's answer back on POST /__money_hop/result. A caller's
// GET /__money_hop/<seat path> becomes one job; the caller waits for the result or gets
// 503 seat_offline when no poll has been seen lately. No tunnel, no hostname, no inbound port,
// no new dependency: plain HTTPS both ways.
//
// Auth: every request on the prefix — the caller's GETs AND the seat's poll/result — is HMAC-signed
// with MONEY_HOP_KEY (Railway env; the seat holds the same key), key id "hop", the seat's own
// header shape:
//   x-seat-key: hop      x-seat-ts: unix ms      x-seat-nonce: 32-64 hex
//   x-seat-sig: hex HMAC-SHA256(MONEY_HOP_KEY, METHOD \n <path after /__money_hop> \n ts \n nonce \n sha256hex(body))
// Refused 401: unsigned, unknown_key, stale (5 min either way), bad_nonce, bad_signature, replay
// (10 min). The seat verifies the caller's headers AGAIN on its side, so this edge is a first
// filter, never the only one. Only GET /health /balances /transactions /caps /state /invoices are
// forwardable; anything else is 405 not_forwardable here, before any job exists. This module
// never logs a header value, never holds a Mercury token, and cannot move money by construction.
import crypto from "node:crypto";

export const MONEY_HOP_PREFIX = "/__money_hop";
export const MONEY_HOP_KEY_ID = "hop";
// /money-map (F6, 24 Sep) is answered by the pay-proxy itself through the direct hook, never by the seat.
// /crm-search (Mr. AQ, 24 Sep) is answered by the pay-proxy itself too, read-only (crm-search.js).
export const MONEY_HOP_FORWARDABLE = ["/health", "/balances", "/transactions", "/caps", "/state", "/invoices", "/money-map", "/crm-search"];
export const MONEY_HOP_BUILD = "2026-09-24-money-map";
export const MONEY_HOP_MAX_SKEW_MS = 5 * 60 * 1000;
export const MONEY_HOP_NONCE_TTL_MS = 10 * 60 * 1000;
const HEADER_NAMES = ["x-seat-key", "x-seat-ts", "x-seat-nonce", "x-seat-sig"];
const MAX_JOBS_PER_POLL = 5;
const RESULT_BODY_LIMIT = 4 * 1024 * 1024;
const OTHER_BODY_LIMIT = 64 * 1024;

export function sha256hex(buf) {
  return crypto.createHash("sha256").update(buf || "").digest("hex");
}

export function hopStringToSign(method, pathWithQuery, ts, nonce, body) {
  return [String(method).toUpperCase(), pathWithQuery, String(ts), String(nonce), sha256hex(body)].join("\n");
}

export function hopSign(secret, method, pathWithQuery, ts, nonce, body) {
  return crypto.createHmac("sha256", secret).update(hopStringToSign(method, pathWithQuery, ts, nonce, body)).digest("hex");
}

/** Headers a caller sends (the future Money agent, the tests): key id "hop", fresh nonce. */
export function hopSignedHeaders(secret, method, pathWithQuery, body, now) {
  const ts = String(now || Date.now());
  const nonce = crypto.randomBytes(16).toString("hex");
  return {
    "x-seat-key": MONEY_HOP_KEY_ID,
    "x-seat-ts": ts,
    "x-seat-nonce": nonce,
    "x-seat-sig": hopSign(secret, method, pathWithQuery, ts, nonce, body),
  };
}

export function createHopVerifier(secret, opts = {}) {
  const now = opts.now || (() => Date.now());
  const seen = new Map();
  function purge(t) {
    for (const [n, at] of seen) if (t - at > MONEY_HOP_NONCE_TTL_MS) seen.delete(n);
  }
  return {
    verify(method, pathWithQuery, headers, body) {
      const keyId = headers["x-seat-key"];
      const ts = headers["x-seat-ts"];
      const nonce = headers["x-seat-nonce"];
      const sig = headers["x-seat-sig"];
      if (!keyId || !ts || !nonce || !sig) return { ok: false, error: "unsigned" };
      if (keyId !== MONEY_HOP_KEY_ID) return { ok: false, error: "unknown_key" };
      const t = now();
      const tsNum = Number(ts);
      if (!Number.isFinite(tsNum) || Math.abs(t - tsNum) > MONEY_HOP_MAX_SKEW_MS) return { ok: false, error: "stale" };
      if (!/^[0-9a-f]{32,64}$/.test(String(nonce))) return { ok: false, error: "bad_nonce" };
      const expect = hopSign(secret, method, pathWithQuery, ts, nonce, body);
      const a = Buffer.from(String(sig), "utf8");
      const b = Buffer.from(expect, "utf8");
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: "bad_signature" };
      purge(t);
      if (seen.has(nonce)) return { ok: false, error: "replay" };
      seen.set(nonce, t);
      return { ok: true, keyId };
    },
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function pickHeaders(headers) {
  const out = {};
  for (const n of HEADER_NAMES) if (typeof headers[n] === "string") out[n] = headers[n];
  return out;
}

export function createMoneyHop(opts = {}) {
  const key = String(opts.key || "");
  const now = opts.now || (() => Date.now());
  const pollWaitMs = Number(opts.pollWaitMs ?? 20000);       // how long one poll is held open
  const jobWaitMs = Number(opts.jobWaitMs ?? 15000);         // how long a caller waits for the seat
  const onlineWindowMs = Number(opts.onlineWindowMs ?? 45000); // a poll this recent = the seat is connected
  const maxQueue = Number(opts.maxQueue ?? 20);
  const setTimer = opts.setTimeout || setTimeout;
  const clearTimer = opts.clearTimeout || clearTimeout;
  const verifier = createHopVerifier(key, { now });
  // Off the PC (Joseph 23 Sep): a verified data GET is answered by the pay-proxy itself, direct to
  // Mercury, when opts.direct returns an answer; null = the seat, exactly as before.
  const direct = typeof opts.direct === "function" ? opts.direct : null;

  const queue = [];      // jobs no poller has taken yet
  const waiters = [];    // open polls: { deliver, timer, req }
  const pending = new Map(); // job id -> { resolve, timer }
  let lastPollAt = 0;
  const counters = { polls: 0, results: 0, forwarded: 0, direct: 0, refused: 0, offline: 0, timeouts: 0, unknown_results: 0 };

  function configured() {
    return key.length >= 32;
  }
  function online() {
    return waiters.length > 0 || (lastPollAt > 0 && now() - lastPollAt < onlineWindowMs);
  }
  function send(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(body);
  }
  function takeJobs() {
    return queue.splice(0, MAX_JOBS_PER_POLL);
  }
  function dropWaiter(w) {
    const i = waiters.indexOf(w);
    if (i >= 0) waiters.splice(i, 1);
    clearTimer(w.timer);
  }

  function dispatch(job) {
    return new Promise((resolve) => {
      const entry = {
        resolve,
        timer: setTimer(() => {
          pending.delete(job.id);
          const i = queue.findIndex((j) => j.id === job.id);
          if (i >= 0) queue.splice(i, 1);
          resolve(null);
        }, jobWaitMs),
      };
      pending.set(job.id, entry);
      if (waiters.length) {
        const w = waiters.shift();
        clearTimer(w.timer);
        w.deliver([job]);
      } else {
        queue.push(job);
      }
    });
  }

  function poll(req, res) {
    counters.polls++;
    lastPollAt = now();
    if (queue.length) {
      send(res, 200, { jobs: takeJobs() });
      return;
    }
    const w = {
      req,
      deliver(jobs) {
        lastPollAt = now();
        send(res, 200, { jobs });
      },
      timer: null,
    };
    w.timer = setTimer(() => {
      dropWaiter(w);
      lastPollAt = now();
      res.writeHead(204, { "Cache-Control": "no-store" });
      res.end();
    }, pollWaitMs);
    waiters.push(w);
    req.on("close", () => dropWaiter(w));
  }

  function result(body, res) {
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8") || "{}");
    } catch {
      send(res, 400, { error: "bad_result" });
      return;
    }
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const entry = pending.get(id);
    if (!entry) {
      counters.unknown_results++;
      send(res, 404, { error: "unknown_job" });
      return;
    }
    clearTimer(entry.timer);
    pending.delete(id);
    counters.results++;
    const status = Number.isInteger(parsed.status) && parsed.status >= 100 && parsed.status <= 599 ? parsed.status : 502;
    const text = typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body ?? null);
    entry.resolve({ status, body: text });
    send(res, 200, { ok: true });
  }

  /** Returns true when the request was on the hop prefix and has been answered. */
  async function handle(req, res) {
    const raw = String(req.url || "");
    if (!raw.startsWith(MONEY_HOP_PREFIX + "/")) return false;
    const sub = raw.slice(MONEY_HOP_PREFIX.length); // "/balances?start=..", "/poll", "/result"
    if (!configured()) {
      send(res, 503, { error: "money_hop_not_configured" });
      return true;
    }
    const method = String(req.method || "GET").toUpperCase();
    const isResult = sub === "/result";
    let body = Buffer.alloc(0);
    if (method !== "GET" && method !== "HEAD") {
      try {
        body = await readBody(req, isResult ? RESULT_BODY_LIMIT : OTHER_BODY_LIMIT);
      } catch {
        send(res, 413, { error: "body_too_large" });
        return true;
      }
    }
    const v = verifier.verify(method, sub, req.headers, body);
    if (!v.ok) {
      counters.refused++;
      send(res, 401, { error: v.error });
      return true;
    }
    if (sub === "/poll") {
      if (method !== "GET") { send(res, 405, { error: "method_not_allowed" }); return true; }
      poll(req, res);
      return true;
    }
    if (isResult) {
      if (method !== "POST") { send(res, 405, { error: "method_not_allowed" }); return true; }
      result(body, res);
      return true;
    }
    const pathname = sub.split("?")[0];
    if (method !== "GET" || !MONEY_HOP_FORWARDABLE.includes(pathname)) {
      counters.refused++;
      send(res, 405, { error: "not_forwardable", forwardable: MONEY_HOP_FORWARDABLE });
      return true;
    }
    if (direct) {
      let d = null;
      try {
        d = await direct(sub);
      } catch {
        d = null;
      }
      if (d && Number.isInteger(d.status)) {
        counters.direct++;
        res.writeHead(d.status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Money-Hop": "direct",
        });
        res.end(typeof d.body === "string" ? d.body : JSON.stringify(d.body ?? null));
        return true;
      }
    }
    if (!online()) {
      counters.offline++;
      send(res, 503, {
        error: "seat_offline",
        reason: lastPollAt ? "no_poll_recently" : "never_polled",
        last_poll_s_ago: lastPollAt ? Math.round((now() - lastPollAt) / 1000) : null,
      });
      return true;
    }
    if (queue.length >= maxQueue) {
      send(res, 503, { error: "seat_busy" });
      return true;
    }
    const job = { id: crypto.randomBytes(8).toString("hex"), method: "GET", path: sub, headers: pickHeaders(req.headers) };
    const outcome = await dispatch(job);
    if (!outcome) {
      counters.timeouts++;
      send(res, 504, { error: "seat_timeout" });
      return true;
    }
    counters.forwarded++;
    res.writeHead(outcome.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Money-Hop": "seat",
    });
    res.end(outcome.body);
    return true;
  }

  function health() {
    return {
      build: MONEY_HOP_BUILD,
      configured: configured(),
      online: online(),
      last_poll_s_ago: lastPollAt ? Math.round((now() - lastPollAt) / 1000) : null,
      open_polls: waiters.length,
      queued: queue.length,
      in_flight: pending.size,
      forwardable: MONEY_HOP_FORWARDABLE,
      counters: { ...counters },
    };
  }

  // In-process read for this service's own jobs (the Mercury paid-invoice sync,
  // plan 17.4): the SAME queue, the same signed job shape the seat verifies
  // again, allowlisted GET paths only, never an arbitrary URL or method.
  // (Shape first drafted by the Codex money-collection lane; rewritten here.)
  async function read(pathWithQuery) {
    const pq = String(pathWithQuery || "");
    if (!pq.startsWith("/") || pq.includes("://") || pq.includes("#") || !MONEY_HOP_FORWARDABLE.includes(pq.split("?")[0])) {
      return { status: 405, body: JSON.stringify({ error: "not_forwardable" }) };
    }
    if (!configured()) return { status: 503, body: JSON.stringify({ error: "money_hop_not_configured" }) };
    if (!online()) { counters.offline++; return { status: 503, body: JSON.stringify({ error: "seat_offline" }) }; }
    if (queue.length >= maxQueue) return { status: 503, body: JSON.stringify({ error: "seat_busy" }) };
    const job = { id: crypto.randomBytes(8).toString("hex"), method: "GET", path: pq, headers: hopSignedHeaders(key, "GET", pq, Buffer.alloc(0), now()) };
    const outcome = await dispatch(job);
    if (!outcome) { counters.timeouts++; return { status: 504, body: JSON.stringify({ error: "seat_timeout" }) }; }
    counters.forwarded++;
    return outcome;
  }

  return { handle, health, verifier, read };
}
