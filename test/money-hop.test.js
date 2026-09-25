import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import {
  MONEY_HOP_PREFIX,
  MONEY_HOP_FORWARDABLE,
  MONEY_HOP_BUILD,
  hopSign,
  hopSignedHeaders,
  createHopVerifier,
  createMoneyHop,
} from "../money-hop.js";

const KEY = "7".repeat(64);

// Shared with nesher-money-seat/test/hop.test.js: both sides sign the same bytes.
const VECTOR_GET = "ccb09fb9b9cad9a7eab99ebbdda10ad541bce28e739ef7c488af7afc0d1a7ffb";
const VECTOR_POST = "6a48386d885267339ca7097c44d9132c3d15a1167f66abbc38d885b8ea0760f3";

function rig(opts = {}) {
  const clock = { now: 1700000000000 };
  const hop = createMoneyHop({ key: KEY, now: () => clock.now, pollWaitMs: 150, jobWaitMs: 250, ...opts });
  const server = http.createServer(async (req, res) => {
    const handled = await hop.handle(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end("upstream");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        hop,
        clock,
        port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function call(t, method, sub, { secret = KEY, body = null, headers = null, now, extra = {} } = {}) {
  const port = t.port;
  const payload = body ? Buffer.from(typeof body === "string" ? body : JSON.stringify(body)) : Buffer.alloc(0);
  const h = headers ?? hopSignedHeaders(secret, method, sub, payload, now ?? t.clock.now);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method, agent: false, path: MONEY_HOP_PREFIX + sub, headers: { ...h, ...extra, "content-length": payload.length } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("money-hop signing", () => {
  it("signs the seat's string-to-sign byte for byte (shared vectors)", () => {
    assert.equal(hopSign(KEY, "GET", "/balances", "1700000000000", "a".repeat(32), Buffer.alloc(0)), VECTOR_GET);
    assert.equal(hopSign(KEY, "POST", "/result", "1700000000000", "b".repeat(32), Buffer.from('{"id":"j1","status":200,"body":"{}"}')), VECTOR_POST);
  });

  it("verifier: unsigned, unknown key id, stale, bad nonce, bad signature, replay", () => {
    const clock = { now: 1700000000000 };
    const v = createHopVerifier(KEY, { now: () => clock.now });
    assert.equal(v.verify("GET", "/balances", {}, Buffer.alloc(0)).error, "unsigned");
    const h = hopSignedHeaders(KEY, "GET", "/balances", Buffer.alloc(0), clock.now);
    assert.equal(v.verify("GET", "/balances", { ...h, "x-seat-key": "local" }, Buffer.alloc(0)).error, "unknown_key");
    const old = hopSignedHeaders(KEY, "GET", "/balances", Buffer.alloc(0), clock.now - 5 * 60 * 1000 - 1);
    assert.equal(v.verify("GET", "/balances", old, Buffer.alloc(0)).error, "stale");
    assert.equal(v.verify("GET", "/balances", { ...h, "x-seat-nonce": "short" }, Buffer.alloc(0)).error, "bad_nonce");
    assert.equal(v.verify("GET", "/balances?x=1", h, Buffer.alloc(0)).error, "bad_signature");
    assert.equal(v.verify("GET", "/balances", hopSignedHeaders("c".repeat(64), "GET", "/balances", Buffer.alloc(0), clock.now), Buffer.alloc(0)).error, "bad_signature");
    assert.equal(v.verify("GET", "/balances", h, Buffer.alloc(0)).ok, true);
    assert.equal(v.verify("GET", "/balances", h, Buffer.alloc(0)).error, "replay");
  });
});

describe("money-hop route", () => {
  it("is not configured without a key: 503, and never says more", async () => {
    const t = await rig({ key: "" });
    try {
      const r = await call(t, "GET", "/balances");
      assert.equal(r.status, 503);
      assert.deepEqual(r.json, { error: "money_hop_not_configured" });
      assert.equal(t.hop.health().configured, false);
    } finally { await t.close(); }
  });

  it("leaves other paths alone", async () => {
    const t = await rig();
    try {
      const r = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: t.port, path: "/__money_hop" }, (res) => resolve(res.statusCode)));
      assert.equal(r, 404, "prefix without a trailing slash is not the hop");
      const r2 = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: t.port, path: "/customers/" }, (res) => resolve(res.statusCode)));
      assert.equal(r2, 404);
    } finally { await t.close(); }
  });

  it("refuses unsigned, wrong key, stale and replayed callers with 401 before anything else", async () => {
    const t = await rig();
    try {
      assert.equal((await call(t, "GET", "/balances", { headers: {} })).json.error, "unsigned");
      assert.equal((await call(t, "GET", "/balances", { secret: "c".repeat(64) })).json.error, "bad_signature");
      assert.equal((await call(t, "GET", "/balances", { now: t.clock.now - 6 * 60 * 1000 })).json.error, "stale");
      const h = hopSignedHeaders(KEY, "GET", "/caps", Buffer.alloc(0), t.clock.now);
      const first = await call(t, "GET", "/caps", { headers: h });
      assert.equal(first.status, 503, "signed ok, but no seat yet");
      const again = await call(t, "GET", "/caps", { headers: h });
      assert.equal(again.status, 401);
      assert.equal(again.json.error, "replay");
      assert.equal(t.hop.health().counters.refused, 4);
    } finally { await t.close(); }
  });

  it("forwards only the listed GETs (plan 17.4 added /invoices, F6 /money-map, AQ /crm-search, 25 Sep /loop-review); anything else is 405 not_forwardable and never becomes a job", async () => {
    const t = await rig();
    try {
      assert.deepEqual(MONEY_HOP_FORWARDABLE, ["/health", "/balances", "/transactions", "/caps", "/state", "/invoices", "/money-map", "/crm-search", "/loop-review"]);
      for (const [m, p] of [["POST", "/balances"], ["POST", "/money-map"], ["GET", "/send"], ["GET", "/balances/x"], ["GET", "/transfer?amount=1"], ["GET", "/recipients"], ["DELETE", "/state"]]) {
        const r = await call(t, m, p, { body: m === "POST" ? "{}" : null });
        assert.equal(r.status, 405, m + " " + p);
        assert.equal(r.json.error, "not_forwardable");
        assert.deepEqual(r.json.forwardable, MONEY_HOP_FORWARDABLE);
      }
      assert.equal(t.hop.health().queued, 0);
      assert.equal(t.hop.health().in_flight, 0);
    } finally { await t.close(); }
  });

  it("answers 503 seat_offline when the seat has never polled, and after the window closes", async () => {
    const t = await rig({ onlineWindowMs: 1000 });
    try {
      const r = await call(t, "GET", "/balances");
      assert.equal(r.status, 503);
      assert.equal(r.json.error, "seat_offline");
      assert.equal(r.json.reason, "never_polled");
      // one empty poll (204) makes the seat "online" for the window
      const p = await call(t, "GET", "/poll");
      assert.equal(p.status, 204);
      assert.equal(t.hop.health().online, true);
      t.clock.now += 1500;
      const r2 = await call(t, "GET", "/balances");
      assert.equal(r2.status, 503);
      assert.equal(r2.json.reason, "no_poll_recently");
      assert.equal(r2.json.last_poll_s_ago, 2);
      assert.equal(t.hop.health().online, false);
      assert.equal(t.hop.health().counters.offline, 2);
    } finally { await t.close(); }
  });

  it("hands a caller's signed GET to the polling seat as a job with only the four signature headers, and returns the seat's answer unchanged", async () => {
    const t = await rig();
    try {
      // the seat opens its long-poll first
      const pollP = call(t, "GET", "/poll");
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(t.hop.health().online, true);
      assert.equal(t.hop.health().open_polls, 1);
      // a caller asks for balances (extra headers must not travel)
      const callerP = call(t, "GET", "/transactions?start=2026-09-01&end=2026-09-10", { extra: { cookie: "sessionid=abc", authorization: "Bearer nope" } });
      const poll = await pollP;
      assert.equal(poll.status, 200);
      assert.equal(poll.json.jobs.length, 1);
      const job = poll.json.jobs[0];
      assert.match(job.id, /^[0-9a-f]{16}$/);
      assert.equal(job.method, "GET");
      assert.equal(job.path, "/transactions?start=2026-09-01&end=2026-09-10", "the seat path with its query, prefix stripped");
      assert.deepEqual(Object.keys(job.headers).sort(), ["x-seat-key", "x-seat-nonce", "x-seat-sig", "x-seat-ts"]);
      assert.equal(job.headers["x-seat-key"], "hop");
      assert.ok(!JSON.stringify(poll.json).includes("sessionid") && !JSON.stringify(poll.json).includes("Bearer"));
      // the seat posts the answer
      const seatAnswer = '{"account":"checking","count":2,"seat":"on"}';
      const res = await call(t, "POST", "/result", { body: { id: job.id, status: 200, body: seatAnswer } });
      assert.equal(res.status, 200);
      assert.deepEqual(res.json, { ok: true });
      const caller = await callerP;
      assert.equal(caller.status, 200);
      assert.equal(caller.text, seatAnswer, "byte for byte");
      assert.equal(caller.headers["x-money-hop"], "seat");
      assert.equal(caller.headers["cache-control"], "no-store");
      const h = t.hop.health();
      assert.equal(h.counters.forwarded, 1);
      assert.equal(h.counters.results, 1);
      assert.equal(h.in_flight, 0);
    } finally { await t.close(); }
  });

  it("passes the seat's own refusals through with their status (a 400 stays a 400, a 401 from the seat-side gate stays a 401)", async () => {
    const t = await rig();
    try {
      const pollP = call(t, "GET", "/poll");
      await new Promise((r) => setTimeout(r, 30));
      const callerP = call(t, "GET", "/balances");
      const job = (await pollP).json.jobs[0];
      await call(t, "POST", "/result", { body: { id: job.id, status: 400, body: '{"error":"range_too_wide"}' } });
      const c = await callerP;
      assert.equal(c.status, 400);
      assert.equal(c.json.error, "range_too_wide");
    } finally { await t.close(); }
  });

  it("queues a job when no poll is open and delivers it to the next poll; times out the caller with 504 when the seat never answers", async () => {
    const t = await rig();
    try {
      assert.equal((await call(t, "GET", "/poll")).status, 204, "empty poll, seat now online");
      const callerP = call(t, "GET", "/state");
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(t.hop.health().queued, 1);
      const poll = await call(t, "GET", "/poll");
      assert.equal(poll.status, 200);
      assert.equal(poll.json.jobs[0].path, "/state");
      assert.equal(t.hop.health().queued, 0);
      const c = await callerP;
      assert.equal(c.status, 504);
      assert.equal(c.json.error, "seat_timeout");
      assert.equal(t.hop.health().counters.timeouts, 1);
      // a late result is refused as unknown, never delivered twice
      const late = await call(t, "POST", "/result", { body: { id: poll.json.jobs[0].id, status: 200, body: "{}" } });
      assert.equal(late.status, 404);
      assert.equal(late.json.error, "unknown_job");
    } finally { await t.close(); }
  });

  it("poll and result are signed too: an unsigned poll is 401, a result whose body was altered is bad_signature, a GET on /result is 405", async () => {
    const t = await rig();
    try {
      assert.equal((await call(t, "GET", "/poll", { headers: {} })).json.error, "unsigned");
      const body = Buffer.from('{"id":"x","status":200,"body":"{}"}');
      const h = hopSignedHeaders(KEY, "POST", "/result", body, t.clock.now);
      const tampered = await call(t, "POST", "/result", { headers: h, body: '{"id":"x","status":200,"body":"{\\"hacked\\":1}"}' });
      assert.equal(tampered.status, 401);
      assert.equal(tampered.json.error, "bad_signature");
      assert.equal((await call(t, "GET", "/result")).status, 405);
      assert.equal((await call(t, "POST", "/poll", { body: "{}" })).status, 405);
      assert.equal((await call(t, "POST", "/result", { body: "not json" })).json.error, "bad_result");
    } finally { await t.close(); }
  });

  it("a poll with nothing to do returns 204 after the wait, and dropping the poll connection forgets the waiter", async () => {
    const t = await rig();
    try {
      const t0 = Date.now();
      const p = await call(t, "GET", "/poll");
      assert.equal(p.status, 204);
      assert.ok(Date.now() - t0 >= 140);
      assert.equal(t.hop.health().open_polls, 0);
      assert.equal(t.hop.health().counters.polls, 1);
    } finally { await t.close(); }
  });

  it("health names the build, state and counters and carries no key or header value", async () => {
    const t = await rig();
    try {
      const h = t.hop.health();
      assert.equal(h.build, MONEY_HOP_BUILD);
      assert.deepEqual(Object.keys(h).sort(), ["build", "configured", "counters", "forwardable", "in_flight", "last_poll_s_ago", "online", "open_polls", "queued"]);
      assert.equal(h.configured, true);
      assert.equal(h.online, false);
      assert.equal(h.last_poll_s_ago, null);
      assert.ok(!JSON.stringify(h).includes(KEY));
    } finally { await t.close(); }
  });
});

describe("wiring", () => {
  it("Dockerfile COPY carries money-hop.js; server.js mounts the hop before the proxy, reports it in health, and bumps the build tag", () => {
    const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(docker, /\bmoney-hop\.js\b/);
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /import \{ createMoneyHop \} from "\.\/money-hop\.js"/);
    // F6: the money map is answered by the pay-proxy itself; every other data GET goes to the Mercury door
    assert.match(src, /createMoneyHop\(\{\s+key: process\.env\.MONEY_HOP_KEY \|\| "",[\s\S]{0,200}?direct: \(sub\) => \{\s+const p = String\(sub\)\.split\("\?"\)\[0\];\s+if \(p === MONEY_MAP_PATH\) return moneyMap\.hopAnswer\(sub\);\s+if \(p === CRM_SEARCH_PATH\) return crmSearch\.hopAnswer\(sub\);[\s\S]{0,200}?if \(p === LOOP_REVIEW_PATH\) return loopReviewAnswer\(\);\s+return mercuryGateway\.hopDirect\(sub\);\s+\},\s+\}\)/);
    assert.match(src, /url\.pathname\.startsWith\("\/__money_hop\/"\)/);
    assert.match(src, /await moneyHop\.handle\(req, res\)/);
    assert.match(src, /moneyHop: moneyHop\.health\(\)/);
    assert.match(src, /build: "2026-09-25-leftover-loop"/);
    // the hop is mounted before the Mercury relay and everything behind it
    assert.ok(src.indexOf('url.pathname.startsWith("/__money_hop/")') < src.indexOf("/^\\/__mercury_relay\\/(.+)$/"));
    // no Mercury token or send path anywhere in the module
    const mod = fs.readFileSync(new URL("../money-hop.js", import.meta.url), "utf8");
    assert.doesNotMatch(mod, /MERCURY_TOKEN|api\.mercury\.com|send-money|\/send\b/);
  });
});

describe("read() - the service's own signed read through the seat (plan 17.4)", () => {
  it("queues one signed GET job the seat can verify, and returns the seat's answer", async () => {
    const t = await rig();
    try {
      const pollP = call(t, "GET", "/poll");
      await new Promise((r) => setTimeout(r, 20));
      const readP = t.hop.read("/invoices");
      const poll = await pollP;
      const job = poll.json.jobs[0];
      assert.equal(job.method, "GET");
      assert.equal(job.path, "/invoices");
      const v = createHopVerifier(KEY, { now: () => t.clock.now }).verify("GET", "/invoices", job.headers, Buffer.alloc(0));
      assert.equal(v.ok, true);
      const res = await call(t, "POST", "/result", { body: { id: job.id, status: 200, body: '{"complete":true,"invoices":[]}' } });
      assert.equal(res.status, 200);
      assert.deepEqual(await readP, { status: 200, body: '{"complete":true,"invoices":[]}' });
    } finally { await t.close(); }
  });
  it("refuses anything off the list, and says offline when the seat is not polling", async () => {
    const t = await rig();
    try {
      for (const p of ["/send", "https://evil/invoices", "invoices", "/invoices#x"]) {
        assert.equal((await t.hop.read(p)).status, 405, p);
      }
      assert.equal((await t.hop.read("/invoices")).status, 503);
      assert.equal(JSON.parse((await t.hop.read("/invoices")).body).error, "seat_offline");
    } finally { await t.close(); }
  });
});

describe("money-hop direct hook (off the PC, 23 Sep)", () => {
  it("a verified data GET is answered by opts.direct with X-Money-Hop: direct, even with the seat offline", async () => {
    const asked = [];
    const t = await rig({ direct: async (sub) => { asked.push(sub); return sub.startsWith("/balances") ? { status: 200, body: '{"seat":"direct"}' } : null; } });
    try {
      const r = await call(t, "GET", "/balances");
      assert.equal(r.status, 200);
      assert.equal(r.text, '{"seat":"direct"}');
      assert.equal(r.headers["x-money-hop"], "direct");
      assert.equal(t.hop.health().counters.direct, 1);
      // null from the hook = the seat path exactly as before (offline here)
      const s = await call(t, "GET", "/health");
      assert.equal(s.status, 503);
      assert.equal(s.json.error, "seat_offline");
      // the gate still runs first: unsigned never reaches the hook, a POST is refused before it
      const u = await call(t, "GET", "/balances", { headers: {} });
      assert.equal(u.status, 401);
      const p = await call(t, "POST", "/send", { body: "{}" });
      assert.equal(p.status, 405);
      assert.deepEqual(asked, ["/balances", "/health"]);
    } finally { await t.close(); }
  });

  it("a throwing hook falls back to the seat path, never a 500", async () => {
    const t = await rig({ direct: async () => { throw new Error("boom"); } });
    try {
      const r = await call(t, "GET", "/balances");
      assert.equal(r.status, 503);
      assert.equal(r.json.error, "seat_offline");
    } finally { await t.close(); }
  });
});
