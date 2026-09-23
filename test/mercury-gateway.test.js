// mercury-gateway.js: direct first, fallback on 401 ipNotWhitelisted, sticky direct, per-token
// health, and the money seat's read-only protection ported as code (seat tests ported from
// nesher-money-seat/test/routes.test.js + invoices.test.js).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createMercuryGateway,
  checkOperation,
  pickSeatAccounts,
  TOKEN_AR,
  TOKEN_FULL,
  MERCURY_DIRECT_ROOT,
  NOT_IN_THIS_SHIP,
} from "../mercury-gateway.js";

const FAKE_AR = "secret-token:mercury_production_FAKE_AR_TOKEN_0123456789abcdef";
const FAKE_FULL = "secret-token:mercury_production_FAKE_FULL_TOKEN_0123456789abcdef";
const CHECKING_ID = "841f6d7c-53b8-11f1-a581-8f1a5e965da2";
const SAVINGS_ID = "aaaaaaaa-0000-0000-0000-000000005926";
const TUNNEL = "https://dead-tunnel.trycloudflare.com";

function fakeAccounts() {
  return [
    { id: CHECKING_ID, accountNumber: "000000005649", name: "Nesher Checking", kind: "checking", status: "active", type: "mercury", availableBalance: 123456.78, currentBalance: 124000.0, legalBusinessName: "Air Today Travel Inc" },
    { id: SAVINGS_ID, accountNumber: "000000005926", name: "Nesher Savings", kind: "savings", status: "active", type: "mercury", availableBalance: 50000, currentBalance: 50000, legalBusinessName: "Air Today Travel Inc" },
    { id: "bbbbbbbb-0000-0000-0000-000000008521", accountNumber: "000000008521", name: "Richter escrow", kind: "checking", status: "active", type: "mercury", availableBalance: 999999, currentBalance: 999999, legalBusinessName: "Air Today Travel Inc" },
    { id: "cccccccc-0000-0000-0000-000000001588", accountNumber: "000000001588", name: "Richter two", kind: "checking", status: "active", type: "mercury", availableBalance: 888888, currentBalance: 888888, legalBusinessName: "Air Today Travel Inc" },
    { id: "dddddddd-0000-0000-0000-000000000001", accountNumber: "000000000001", name: "Other", kind: "checking", status: "active", type: "mercury", availableBalance: 1, currentBalance: 1, legalBusinessName: "Air Today Travel Inc" },
  ];
}
function fakeTransactions() {
  return [
    { id: "t1", amount: 1500.25, status: "pending", kind: "incomingDomesticWire", createdAt: "2026-09-20T10:00:00Z", counterpartyName: "Guest One", bankDescription: "WIRE IN", details: { electronicRoutingInfo: { accountNumber: "123456789012345" } } },
    { id: "t2", amount: -420.5, status: "pending", kind: "outgoingPayment", createdAt: "2026-09-21T10:00:00Z", counterpartyName: "Supplier", bankDescription: "ACH OUT" },
    { id: "t3", amount: -99, status: "sent", kind: "debitCardTransaction", createdAt: "2026-09-01T10:00:00Z", postedAt: "2026-09-02T10:00:00Z", counterpartyName: "Vendor", bankDescription: "CARD" },
  ];
}
function fakeInvoices() {
  return [
    { id: "inv-paid-1", invoiceNumber: "RES-AAA111", status: "Paid", amount: 1200.5, currencyCode: "USD", creditCardEnabled: false, achDebitEnabled: true, payerMemo: "secret memo", ccEmails: ["guest@example.com"], customerId: "cust-1", slug: "abc", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-02T00:00:00Z", canceledAt: null },
    { id: "inv-open-2", invoiceNumber: "JRM-190-O48", status: "Unpaid", amount: 99, currencyCode: "USD", creditCardEnabled: true, achDebitEnabled: true, payerMemo: "x", ccEmails: [], customerId: "cust-2", slug: "def", createdAt: "2026-09-03T00:00:00Z", updatedAt: "2026-09-03T00:00:00Z", canceledAt: null },
  ];
}

/** Mercury fake. mode.direct: "ok" | "blocked" | "down"; the tunnel answers from the same book. */
function mercury(mode = {}) {
  const s = { calls: [], direct: mode.direct || "ok", tunnel: mode.tunnel || "ok", invoicePage: mode.invoicePage || {}, accounts: mode.accounts || fakeAccounts() };
  const f = async (url, init = {}) => {
    const u = new URL(String(url));
    const isDirect = u.origin === "https://api.mercury.com";
    const auth = init.headers && init.headers.Authorization;
    s.calls.push({ url: String(url), method: init.method || "GET", direct: isDirect, token: auth === `Bearer ${FAKE_FULL}` ? "full" : auth === `Bearer ${FAKE_AR}` ? "ar" : "other" });
    const mode2 = isDirect ? s.direct : s.tunnel;
    if (mode2 === "blocked") return new Response(JSON.stringify({ errors: { errorCode: "ipNotWhitelisted", message: "ipNotWhitelisted: 152.55.180.243" } }), { status: 401 });
    if (mode2 === "down") throw new TypeError("fetch failed");
    if (mode2 === "530") return new Response("tunnel gone", { status: 530 });
    const p = u.pathname.replace(/^\/api\/v1/, "");
    if (p === "/ar/invoices" && (init.method || "GET") === "GET") return new Response(JSON.stringify({ invoices: fakeInvoices(), page: s.invoicePage }), { status: 200 });
    if (p === "/ar/invoices" && init.method === "POST") return new Response(JSON.stringify({ id: "new-1", slug: "zz", status: "Unpaid" }), { status: 200 });
    if (p === "/ar/customers") return new Response(JSON.stringify({ customers: [] }), { status: 200 });
    if (p === "/accounts") return new Response(JSON.stringify({ accounts: s.accounts, page: {} }), { status: 200 });
    const m = p.match(/^\/account\/([^/]+)\/transactions$/);
    if (m) {
      const st = u.searchParams.get("status");
      const rows = fakeTransactions().filter((t) => !st || t.status === st);
      return new Response(JSON.stringify({ transactions: rows, total: rows.length }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected " + p }), { status: 404 });
  };
  f.state = s;
  return f;
}

function gw(mode = {}, extra = {}) {
  const fetchImpl = mercury(mode);
  const clock = { now: Date.parse("2026-09-23T12:00:00Z") };
  const env = { MERCURY_TOKEN_NESHER: FAKE_AR, MERCURY_TOKEN_NESHER_FULL: FAKE_FULL, MERCURY_API_BASE: TUNNEL, ...(extra.env || {}) };
  const hopCalls = [];
  const hop = extra.hop === null ? null : {
    read: async (p) => {
      hopCalls.push(p);
      if (extra.seatDown) return { status: 503, body: JSON.stringify({ error: "seat_offline" }) };
      if (p === "/invoices") return { status: 200, body: JSON.stringify({ complete: true, count: 1, invoices: [{ id: "seat-inv", invoiceNumber: "RES-SEAT", status: "Paid", amount: 5 }] }) };
      return { status: 200, body: JSON.stringify({ from: "seat", path: p }) };
    },
  };
  const g = createMercuryGateway({ env, fetchImpl, now: () => clock.now, hop });
  return { g, fetchImpl, clock, hopCalls };
}

describe("mercury-gateway: the seat's protection as code", () => {
  it("send / transfer / request-send-money / recipients are 405 not_in_this_ship for BOTH tokens", () => {
    for (const tk of [TOKEN_AR, TOKEN_FULL]) {
      for (const p of ["/send", "/transfer", "/account/x/request-send-money", "/recipients", "/recipient/abc", "/account/" + CHECKING_ID + "/transactions/t1/attachments", "/internal-transfer"]) {
        for (const m of ["GET", "POST"]) {
          const r = checkOperation(tk, m, p);
          assert.equal(r.ok, false, `${tk} ${m} ${p}`);
          assert.equal(r.status, 405);
          assert.equal(r.error, "not_in_this_ship");
        }
      }
      const post = checkOperation(tk, "POST", "/account/" + CHECKING_ID + "/transactions");
      assert.deepEqual([post.status, post.error], [405, "not_in_this_ship"], "POST to transactions = send money");
    }
    assert.ok(NOT_IN_THIS_SHIP.includes("request-send-money"));
  });

  it("the full token is read only: GET accounts / ar / nesher transactions with start+end, nothing else", () => {
    assert.equal(checkOperation(TOKEN_FULL, "GET", "/accounts").ok, true);
    assert.equal(checkOperation(TOKEN_FULL, "GET", "/ar/invoices").ok, true);
    assert.equal(checkOperation(TOKEN_FULL, "POST", "/ar/invoices").error, "not_in_this_ship");
    assert.equal(checkOperation(TOKEN_FULL, "GET", `/account/${CHECKING_ID}/transactions`).error, "start_and_end_required");
    assert.equal(checkOperation(TOKEN_FULL, "GET", `/account/${CHECKING_ID}/transactions?start=2026-09-01`).error, "start_and_end_required");
    assert.equal(checkOperation(TOKEN_FULL, "GET", `/account/${CHECKING_ID}/transactions?start=2026-09-01&end=2026-09-02`).ok, true);
    assert.equal(checkOperation(TOKEN_FULL, "GET", "/account/bbbbbbbb-0000-0000-0000-000000008521/transactions?start=2026-09-01&end=2026-09-02").error, "account_not_nesher");
    assert.equal(checkOperation(TOKEN_FULL, "GET", "/organization").error, "not_allowlisted");
    assert.equal(checkOperation(TOKEN_FULL, "DELETE", "/ar/invoices").error, "not_in_this_ship");
  });

  it("the AR token touches ar/invoices and ar/customers only (the relay's list)", () => {
    assert.equal(checkOperation(TOKEN_AR, "POST", "/ar/invoices").ok, true);
    assert.equal(checkOperation(TOKEN_AR, "POST", "/ar/invoices/abc-1/cancel").ok, true);
    assert.equal(checkOperation(TOKEN_AR, "GET", "/ar/customers").ok, true);
    assert.equal(checkOperation(TOKEN_AR, "GET", "/accounts").error, "not_allowlisted");
    assert.equal(checkOperation(TOKEN_AR, "PUT", "/ar/invoices/x").error, "method_not_allowed");
  });

  it("pickSeatAccounts: only checking 5649 and savings 5926; Richter and others never appear; mismatch refused", () => {
    const rows = pickSeatAccounts(fakeAccounts());
    assert.deepEqual(rows.map((a) => a.label + ":" + a.last4), ["checking:5649", "savings:5926"]);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes("8521") && !text.includes("1588") && !text.includes("999999") && !text.includes("Other"));
    const bad = fakeAccounts();
    bad[0].accountNumber = "000000009999";
    assert.throws(() => pickSeatAccounts(bad), /mismatch/);
    const other = fakeAccounts();
    other[1].legalBusinessName = "Rank Friendly Inc";
    assert.deepEqual(pickSeatAccounts(other).map((a) => a.label), ["checking"]);
  });
});

describe("mercury-gateway: direct first", () => {
  it("allowlist in: balances, transactions, invoices are served DIRECT with the seat's shapes, seat never asked", async () => {
    const { g, fetchImpl, hopCalls } = gw({ direct: "ok" });
    const b = await g.read("t.balances", "/balances");
    assert.equal(b.servedBy, "direct");
    const bj = JSON.parse(b.body);
    assert.deepEqual(bj.accounts.map((a) => a.label + ":" + a.last4), ["checking:5649", "savings:5926"]);
    assert.equal(bj.accounts[0].pending_in, 1500.25);
    assert.equal(bj.accounts[0].pending_out, 420.5);
    assert.equal(bj.accounts[0].pending_count, 2);
    assert.ok(!b.body.includes("8521") && !b.body.includes("1588"));
    const txCalls = fetchImpl.state.calls.filter((c) => c.url.includes("/transactions"));
    for (const c of txCalls) {
      const u = new URL(c.url);
      assert.ok(u.searchParams.get("start") && u.searchParams.get("end"), "start and end always");
      assert.equal(c.token, "full");
    }
    assert.ok(!fetchImpl.state.calls.some((c) => c.url.includes("8521") || c.url.includes("1588")), "never read a Richter account");

    const t = await g.read("t.tx", "/transactions?start=2026-09-01&end=2026-09-22");
    const tj = JSON.parse(t.body);
    assert.equal(t.status, 200);
    assert.equal(tj.count, 3);
    assert.equal(tj.total_in, 1500.25);
    assert.equal(tj.total_out, 519.5);
    assert.ok(!("details" in tj.transactions[0]), "allowlisted fields only");

    const i = await g.read("t.inv", "/invoices");
    const ij = JSON.parse(i.body);
    assert.equal(ij.complete, true);
    assert.deepEqual(Object.keys(ij.invoices[0]).sort(), ["achDebitEnabled", "amount", "canceledAt", "createdAt", "creditCardEnabled", "currencyCode", "id", "invoiceNumber", "status", "updatedAt"]);
    for (const bad of ["secret memo", "guest@example.com", "cust-1"]) assert.ok(!i.body.includes(bad));
    const invCall = fetchImpl.state.calls.find((c) => c.url.endsWith("/ar/invoices"));
    assert.equal(invCall.token, "ar", "AR listing uses the AR token (least privilege)");
    assert.equal(hopCalls.length, 0);
    assert.ok(fetchImpl.state.calls.every((c) => c.direct), "nothing went to the tunnel");
    const h = g.health();
    assert.equal(h.tokens[TOKEN_FULL].direct, "ok");
    assert.equal(h.tokens[TOKEN_AR].direct, "ok");
    assert.equal(h.tokens[TOKEN_FULL].verdict, "direct ok");
    assert.equal(h.uses["t.balances"].served_by, "direct");
    assert.equal(h.blocker, null);
  });

  it("transactions validation mirrors the seat and never reaches Mercury", async () => {
    const { g, fetchImpl } = gw({ direct: "ok" });
    const err = async (q) => JSON.parse((await g.read("v", "/transactions" + q)).body).error;
    assert.equal(await err(""), "start_and_end_required");
    assert.equal(await err("?start=2026-9-1&end=2026-09-10"), "bad_date");
    assert.equal(await err("?start=2026-09-10&end=2026-09-01"), "start_after_end");
    assert.equal(await err("?start=2026-06-01&end=2026-09-02"), "range_too_wide");
    assert.equal(await err("?start=2026-09-01&end=2026-09-10&account=treasury"), "unknown_account");
    assert.equal(fetchImpl.state.calls.length, 0);
  });

  it("an invoice listing with a next page is reported incomplete and listArInvoices refuses it", async () => {
    const { g } = gw({ direct: "ok", invoicePage: { nextPage: "x" } });
    const r = await g.read("x", "/invoices");
    assert.equal(JSON.parse(r.body).complete, false);
    await assert.rejects(() => g.listArInvoices("paySync"), /invoices_incomplete/);
  });
});

describe("mercury-gateway: fallback while the allowlist is missing", () => {
  it("401 ipNotWhitelisted -> the seat serves reads; health says blocked by allowlist, fallback in use", async () => {
    const { g, hopCalls } = gw({ direct: "blocked" });
    const b = await g.read("hop.b", "/balances");
    assert.equal(b.servedBy, "seat");
    assert.deepEqual(JSON.parse(b.body), { from: "seat", path: "/balances" });
    const inv = await g.listArInvoices("paySync");
    assert.equal(inv[0].id, "seat-inv");
    assert.deepEqual(hopCalls, ["/balances", "/invoices"]);
    const h = g.health();
    assert.equal(h.tokens[TOKEN_FULL].direct, "blocked");
    assert.equal(h.tokens[TOKEN_FULL].blocked_ip, "152.55.180.243");
    assert.equal(h.tokens[TOKEN_FULL].fallback_in_use, true);
    assert.match(h.tokens[TOKEN_FULL].verdict, /blocked by allowlist/);
    assert.equal(h.uses.paySync.served_by, "seat");
    assert.match(h.blocker, /ipNotWhitelisted/);
    assert.ok(!JSON.stringify(h).includes(FAKE_FULL) && !JSON.stringify(h).includes(FAKE_AR), "no token value in health");
    assert.equal(h.tokens[TOKEN_FULL].length, FAKE_FULL.length);
  });

  it("while blocked, direct is re-tried at most once a minute; the moment it succeeds it stays direct", async () => {
    const { g, fetchImpl, clock } = gw({ direct: "blocked" });
    await g.read("a", "/invoices");
    const directCalls = () => fetchImpl.state.calls.filter((c) => c.direct).length;
    assert.equal(directCalls(), 1);
    clock.now += 30 * 1000;
    await g.read("a", "/invoices");
    assert.equal(directCalls(), 1, "no second direct try inside the minute");
    fetchImpl.state.direct = "ok"; // Joseph adds the IPs
    clock.now += 31 * 1000;
    const r = await g.read("a", "/invoices");
    assert.equal(r.servedBy, "direct");
    assert.equal(g.health().tokens[TOKEN_AR].direct, "ok");
    const r2 = await g.read("a", "/invoices");
    assert.equal(r2.servedBy, "direct");
  });

  it("probeStale switches a token on without any traffic", async () => {
    const { g, fetchImpl, clock } = gw({ direct: "blocked" });
    await g.probeStale();
    assert.equal(g.health().tokens[TOKEN_FULL].direct, "blocked");
    fetchImpl.state.direct = "ok";
    clock.now += 5 * 60 * 1000;
    await g.probeStale();
    assert.equal(g.health().tokens[TOKEN_FULL].direct, "ok");
    assert.equal(g.health().tokens[TOKEN_AR].direct, "ok");
  });

  it("no full token on this service -> no direct request, the seat serves, health says so", async () => {
    const { g, fetchImpl } = gw({ direct: "ok" }, { env: { MERCURY_TOKEN_NESHER_FULL: "" } });
    const r = await g.read("hop.b", "/balances");
    assert.equal(r.servedBy, "seat");
    assert.equal(fetchImpl.state.calls.length, 0);
    assert.equal(g.health().tokens[TOKEN_FULL].direct, "no_token");
    assert.equal(g.health().tokens[TOKEN_FULL].present, false);
  });

  it("seat offline too: invoices fall to the tunnel exactly as before; a dead tunnel is an error, never 'nothing paid'", async () => {
    const a = gw({ direct: "blocked", tunnel: "ok" }, { seatDown: true });
    const inv = await a.g.listArInvoices("paySync");
    assert.equal(inv.length, 2);
    assert.equal(a.g.lastServed("paySync"), "tunnel");
    const b = gw({ direct: "blocked", tunnel: "530" }, { seatDown: true });
    await assert.rejects(() => b.g.listArInvoices("paySync"), /mercury_/);
  });
});

describe("mercury-gateway: AR writes (pay links, relay)", () => {
  it("direct ok: the pay-link POST goes to api.mercury.com, never the tunnel", async () => {
    const { g, fetchImpl } = gw({ direct: "ok" });
    const f = g.arFetch("payLink");
    const res = await f(TUNNEL + "/api/v1/ar/invoices", { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-mercury-path"), "direct");
    assert.equal(fetchImpl.state.calls[0].url, MERCURY_DIRECT_ROOT + "/ar/invoices");
    assert.equal(fetchImpl.state.calls[0].token, "ar");
  });

  it("blocked: the POST goes down the tunnel (nothing reached Mercury directly)", async () => {
    const { g, fetchImpl } = gw({ direct: "blocked" });
    const r = await g.arRequest("payLink", "POST", "/ar/invoices", { body: "{}" });
    assert.equal(r.servedBy, "tunnel");
    assert.equal(fetchImpl.state.calls.length, 2);
    assert.equal(g.health().uses.payLink.served_by, "tunnel");
  });

  it("a POST whose direct attempt may have reached Mercury (network drop / 5xx) is NEVER replayed", async () => {
    const { g, fetchImpl } = gw({ direct: "down" });
    const r = await g.arRequest("payLink", "POST", "/ar/invoices", { body: "{}" });
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.text).fallback, "not_replayed");
    assert.equal(fetchImpl.state.calls.length, 1);
    const get = await g.arRequest("relay", "GET", "/ar/invoices");
    assert.equal(get.servedBy, "tunnel", "a read may retry down the old path");
  });

  it("MERCURY_API_BASE pointing at api.mercury.com is not a fallback; blocked with no fallback is a clear 502", async () => {
    const { g } = gw({ direct: "blocked" }, { env: { MERCURY_API_BASE: "https://api.mercury.com" }, hop: null });
    const r = await g.arRequest("relay", "GET", "/ar/invoices");
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.text).direct, "blocked_by_allowlist");
    assert.equal(g.health().tunnel_configured, false);
  });

  it("the relay's refusals hold in the gateway too", async () => {
    const { g, fetchImpl } = gw({ direct: "ok" });
    const r = await g.arRequest("relay", "POST", "/account/" + CHECKING_ID + "/transactions", { body: "{}" });
    assert.equal(r.status, 405);
    assert.equal(fetchImpl.state.calls.length, 0);
  });
});

describe("mercury-gateway: the hop door hook", () => {
  it("hopDirect answers data paths direct, leaves /health /caps /state to the seat", async () => {
    const { g } = gw({ direct: "ok" });
    assert.equal(await g.hopDirect("/health"), null);
    assert.equal(await g.hopDirect("/caps"), null);
    const d = await g.hopDirect("/balances");
    assert.equal(d.status, 200);
    assert.equal(d.servedBy, "direct");
  });

  it("hopDirect returns null while blocked, so the hop forwards to the seat as before", async () => {
    const { g } = gw({ direct: "blocked" });
    assert.equal(await g.hopDirect("/balances"), null);
    assert.equal(g.health().uses["hop/balances"].served_by, "seat");
  });
});
