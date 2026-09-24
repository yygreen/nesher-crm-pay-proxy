// F7 (24 Sep 2026): pay a supplier from the desk chat. Mercury request-send-money ONLY (approval in
// the Mercury app), Nesher checking only, existing allowed recipients only. No real Mercury call
// happens in this file: every answer comes from the fake below, and the fake counts every POST.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createMercuryGateway,
  checkOperation,
  checkPayOperation,
  payeeVerdict,
  payeeView,
  TOKEN_FULL,
  PAY_CHECKING,
  externalMemoOf,
  memoMatches,
  NOTE_MARK,
} from "../mercury-gateway.js";
import { createMoneyPay, memoRefs, pickPayee, payeeScore, payDoorOf } from "../money-pay.js";
import { mintTicket, TICKET_KINDS } from "../ocr-card.js";

const FAKE_FULL = "secret-token:mercury_production_FAKE_FULL_TOKEN_0123456789abcdef";
const CHECKING_ID = "841f6d7c-53b8-11f1-a581-8f1a5e965da2";
const SECRET = "test-secret-0123456789abcdef";
const NOW = Date.parse("2026-09-24T12:00:00Z");

const R = {
  prima: { id: "11111111-1111-4111-8111-111111111111", status: "active", isBusiness: true, name: "prima Hotels", nickname: "Prima Rome", defaultPaymentMethod: "internationalWire", internationalWireRoutingInfo: { iban: "IT60X0542811101000000123456", swiftCode: "BPMOIT22", bankDetails: { bankName: "Banca Test" } }, emails: [], attachments: [] },
  shloimy: { id: "22222222-2222-4222-8222-222222222222", status: "active", isBusiness: true, name: "Shloimys Kosher World", defaultPaymentMethod: "domesticWire", domesticWireRoutingInfo: { accountNumber: "0000003483", routingNumber: "021000021", bankName: "Chase" }, emails: [], attachments: [] },
  airtodaySupplier: { id: "33333333-3333-4333-8333-333333333333", status: "active", isBusiness: true, name: "Sky Consolidators LLC", nickname: "Sky", defaultPaymentMethod: "ach", electronicRoutingInfo: { accountNumber: "000000007777", routingNumber: "021000021", electronicAccountType: "businessChecking", bankName: "Chase" }, emails: [], attachments: [] },
  person: { id: "44444444-4444-4444-8444-444444444444", status: "active", isBusiness: false, name: "yakov weissmandl", defaultPaymentMethod: "ach", electronicRoutingInfo: { accountNumber: "000000001659", routingNumber: "021000021", electronicAccountType: "personalChecking" }, emails: [], attachments: [] },
  joseph: { id: "55555555-5555-4555-8555-555555555555", status: "active", name: "Yoseph Green", nickname: "Guardian Life Insurance (Joseph+Chava)", defaultPaymentMethod: "ach", electronicRoutingInfo: { accountNumber: "000000002735", routingNumber: "021000021", electronicAccountType: "personalSavings" }, emails: [], attachments: [] },
  self: { id: "66666666-6666-4666-8666-666666666666", status: "active", isBusiness: true, name: "Air Today Travel Inc", nickname: "Nesher", defaultPaymentMethod: "domesticWire", domesticWireRoutingInfo: { accountNumber: "000000005649", routingNumber: "091311229" }, emails: [], attachments: [] },
  rf: { id: "77777777-7777-4777-8777-777777777777", status: "active", isBusiness: true, name: "Rank Friendly Inc.", defaultPaymentMethod: "ach", electronicRoutingInfo: { accountNumber: "000000004281", routingNumber: "091311229", electronicAccountType: "businessChecking" }, emails: [], attachments: [] },
  richter: { id: "88888888-8888-4888-8888-888888888888", status: "active", isBusiness: true, name: "Trust account", defaultPaymentMethod: "ach", electronicRoutingInfo: { accountNumber: "000000008521", routingNumber: "091311229", electronicAccountType: "businessChecking" }, emails: [], attachments: [] },
  gone: { id: "99999999-9999-4999-8999-999999999999", status: "deleted", isBusiness: true, name: "Old Hotel", defaultPaymentMethod: "ach", electronicRoutingInfo: { accountNumber: "000000001234", routingNumber: "1", electronicAccountType: "businessChecking" }, emails: [], attachments: [] },
};

function accounts(last4 = "5649") {
  return [
    { id: CHECKING_ID, accountNumber: "00000000" + last4, name: "Nesher Checking", kind: "checking", status: "active", type: "mercury", availableBalance: 7000, currentBalance: 7000, legalBusinessName: "Air Today Travel Inc" },
  ];
}

/** Mercury fake for the pay path. Records every call; `requests` is the approval list. */
function mercury(opt = {}) {
  const s = { calls: [], posts: [], requests: opt.requests || [], txns: opt.txns || [], last4: opt.last4 || "5649", postMode: opt.postMode || "ok", echo: opt.echo || "external" };
  s.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const m = init.method || "GET";
    s.calls.push({ m, p: u.pathname + u.search });
    const p = u.pathname.replace(/^\/api\/v1/, "");
    if (p === "/accounts") return new Response(JSON.stringify({ accounts: accounts(s.last4) }), { status: 200 });
    if (p === "/recipients") return new Response(JSON.stringify({ total: Object.keys(R).length, recipients: Object.values(R), page: {} }), { status: 200 });
    const rm = p.match(/^\/recipient\/(.+)$/);
    if (rm) {
      const hit = Object.values(R).find((x) => x.id === rm[1]);
      return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response("{}", { status: 404 });
    }
    if (p === "/request-send-money" && m === "GET") return new Response(JSON.stringify({ requests: s.requests, page: {} }), { status: 200 });
    const one = p.match(/^\/request-send-money\/(.+)$/);
    if (one) {
      const hit = s.requests.find((x) => x.requestId === one[1]);
      return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response("{}", { status: 404 });
    }
    if (p.match(/^\/account\/[^/]+\/transactions$/)) return new Response(JSON.stringify({ transactions: s.txns }), { status: 200 });
    if (p === `/account/${CHECKING_ID}/request-send-money` && m === "POST") {
      const body = JSON.parse(init.body);
      s.posts.push(body);
      if (s.postMode === "down") throw new TypeError("fetch failed");
      if (s.postMode === "dup") return new Response(JSON.stringify({ errors: { message: "Duplicate transaction" } }), { status: 400 });
      const q = { accountId: CHECKING_ID, requestId: "abcdef01-2345-4678-9abc-def012345678", recipientId: body.recipientId, memo: s.echo === "note" ? body.note : body.externalMemo, paymentMethod: body.paymentMethod, amount: body.amount, status: "pendingApproval", requestedByUserId: "u-1", numberOfApproversRequired: 1, requesterMayApprove: false, reviews: [], createdAt: new Date(NOW).toISOString() };
      s.requests.push(q);
      return new Response(JSON.stringify(q), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "unexpected " + m + " " + p }), { status: 599 });
  };
  return s;
}

function gw(s, env = {}) {
  return createMercuryGateway({ env: { MERCURY_TOKEN_NESHER_FULL: FAKE_FULL, MONEY_PAY: "on", ...env }, fetchImpl: s.fetch, now: () => NOW });
}

describe("checkPayOperation: five exact shapes, everything else 405", () => {
  it("allows only the pay shapes", () => {
    assert.equal(checkPayOperation("GET", "/recipients?limit=1000").ok, true);
    assert.equal(checkPayOperation("GET", `/recipient/${R.prima.id}`).ok, true);
    assert.equal(checkPayOperation("GET", `/request-send-money?accountId=${CHECKING_ID}&limit=10`).ok, true);
    assert.equal(checkPayOperation("GET", `/request-send-money/${R.prima.id}`).ok, true);
    assert.equal(checkPayOperation("POST", `/account/${CHECKING_ID}/request-send-money`).ok, true);
  });
  it("refuses direct send, transfers, recipient writes, other accounts", () => {
    for (const [m, p] of [
      // Mr. AK (Joseph 24 Sep): POST /recipients and POST /account/<checking>/transactions are now exact
      // allowed shapes (test/money-ak.test.js); any OTHER account's transactions stay refused.
      ["POST", `/account/aaaaaaaa-0000-0000-0000-000000005926/transactions`],
      ["POST", "/transfer"],
      ["POST", `/account/${CHECKING_ID}/request-transfer`],
      ["POST", `/recipient/${R.prima.id}`],
      ["DELETE", `/recipient/${R.prima.id}`],
      ["POST", `/account/aaaaaaaa-0000-0000-0000-000000005926/request-send-money`],
      ["POST", `/account/bbbbbbbb-0000-0000-0000-000000008521/request-send-money`],
      ["POST", `/request-send-money/${R.prima.id}`],
      ["GET", "/request-send-money"],
      ["GET", "/request-send-money?accountId=bbbbbbbb-0000-0000-0000-000000008521"],
      ["GET", "/recipient/../accounts"],
    ]) {
      assert.equal(checkPayOperation(m, p).ok, false, `${m} ${p}`);
    }
  });
  it("the generic door still refuses every send path for both tokens", () => {
    assert.equal(checkOperation(TOKEN_FULL, "POST", `/account/${CHECKING_ID}/request-send-money`).status, 405);
    assert.equal(checkOperation(TOKEN_FULL, "GET", "/recipients").status, 405);
    assert.equal(checkOperation("MERCURY_TOKEN_NESHER", "POST", `/account/${CHECKING_ID}/request-send-money`).status, 405);
  });
  it("the pay path's account is Nesher checking 5649", () => {
    assert.equal(PAY_CHECKING.id, CHECKING_ID);
    assert.equal(PAY_CHECKING.last4, "5649");
  });
});

describe("payeeVerdict: the plan's hard lines (1.5)", () => {
  it("business suppliers pass, with the method they are paid by", () => {
    assert.deepEqual(payeeVerdict(R.prima), { ok: true, method: "internationalWire" });
    assert.deepEqual(payeeVerdict(R.shloimy), { ok: true, method: "domesticWire" });
    assert.deepEqual(payeeVerdict(R.airtodaySupplier), { ok: true, method: "ach" });
  });
  it("persons, our own accounts, other orgs, Richter and deleted recipients never pass", () => {
    assert.equal(payeeVerdict(R.person).why, "personal");
    assert.equal(payeeVerdict(R.joseph).why, "own_or_other_org");
    assert.equal(payeeVerdict(R.self).why, "own_or_other_org");
    assert.equal(payeeVerdict(R.rf).why, "own_or_other_org");
    assert.equal(payeeVerdict(R.richter).why, "richter");
    assert.equal(payeeVerdict(R.gone).why, "inactive");
    assert.equal(payeeVerdict({ ...R.airtodaySupplier, isBusiness: undefined }).why, "personal");
  });
  it("the view carries name, method, bank and last four only", () => {
    const v = payeeView(R.shloimy);
    assert.deepEqual(Object.keys(v).sort(), ["bank", "fp", "id", "last4", "lastPaid", "method", "name", "nickname", "payable", "person", "why"]);
    assert.equal(v.last4, "3483");
    assert.ok(!JSON.stringify(v).includes("021000021"));
  });
});

describe("requestPay: one approval request, every rule checked again server side", () => {
  const base = { recipientId: R.shloimy.id, amountCents: 320000, memo: "PNR ABC123", idempotencyKey: "nesher-desk-mp0000001" };
  it("is off without MONEY_PAY=on, and nothing is asked of Mercury", async () => {
    const s = mercury();
    const r = await gw(s, { MONEY_PAY: "" }).requestPay(base);
    assert.equal(r.status, 404);
    assert.equal(s.calls.length, 0);
  });
  it("queues ONE request-send-money from checking, wire purpose = vendor + payee name", async () => {
    const s = mercury();
    const r = await gw(s).requestPay(base);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.request.status, "pendingApproval");
    assert.equal(s.posts.length, 1);
    assert.deepEqual(s.posts[0].purpose, { simple: { category: "vendor", additionalInfo: "Shloimys Kosher World" } });
    assert.equal(s.posts[0].amount, 3200);
    assert.equal(s.posts[0].paymentMethod, "domesticWire");
    assert.equal(s.posts[0].externalMemo, "PNR ABC123");
    assert.equal(s.posts[0].idempotencyKey, "nesher-desk-mp0000001");
    const postCalls = s.calls.filter((c) => c.m !== "GET");
    assert.equal(postCalls.length, 1);
    assert.equal(postCalls[0].p, `/api/v1/account/${CHECKING_ID}/request-send-money`);
  });
  it("ACH payees carry no purpose", async () => {
    const s = mercury();
    await gw(s).requestPay({ ...base, recipientId: R.airtodaySupplier.id });
    assert.equal(s.posts[0].paymentMethod, "ach");
    assert.equal(s.posts[0].purpose, undefined);
  });
  it("refuses a second request with the same payee, amount and memo within 24 h (no POST)", async () => {
    const s = mercury({ requests: [{ accountId: CHECKING_ID, requestId: "abcdef01-2345-4678-9abc-def012345670", recipientId: R.shloimy.id, memo: " pnr  abc123", amount: 3200, status: "pendingApproval", createdAt: new Date(NOW - 3600e3).toISOString(), reviews: [] }] });
    const r = await gw(s).requestPay(base);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "duplicate_24h");
    assert.equal(r.body.existing.id, "abcdef01-2345-4678-9abc-def012345670");
    assert.equal(s.posts.length, 0);
  });
  it("a rejected one, or one older than 24 h, does not block", async () => {
    const s = mercury({ requests: [
      { accountId: CHECKING_ID, requestId: "a1", recipientId: R.shloimy.id, memo: "PNR ABC123", amount: 3200, status: "rejected", createdAt: new Date(NOW - 3600e3).toISOString(), reviews: [] },
      { accountId: CHECKING_ID, requestId: "a2", recipientId: R.shloimy.id, memo: "PNR ABC123", amount: 3200, status: "approved", createdAt: new Date(NOW - 25 * 3600e3).toISOString(), reviews: [] },
    ] });
    const r = await gw(s).requestPay(base);
    assert.equal(r.status, 200);
    assert.equal(s.posts.length, 1);
  });
  it("caps: per payment and per day", async () => {
    let s = mercury();
    let r = await gw(s).requestPay({ ...base, amountCents: 10000 * 100 + 1 });
    assert.equal(r.body.error, "over_cap");
    s = mercury({ requests: [{ accountId: CHECKING_ID, requestId: "a3", recipientId: R.prima.id, memo: "x", amount: 23000, status: "pendingApproval", createdAt: new Date(NOW - 60e3).toISOString(), reviews: [] }] });
    r = await gw(s).requestPay(base);
    assert.equal(r.body.error, "over_day_cap");
    assert.equal(s.posts.length, 0);
    r = await gw(mercury()).requestPay({ ...base, amountCents: 99 });
    assert.equal(r.body.error, "amount_invalid");
    r = await gw(mercury()).requestPay({ ...base, memo: "  " });
    assert.equal(r.body.error, "memo_required");
  });
  it("never pays a person, our own account, another org or Richter - no POST", async () => {
    for (const k of ["person", "joseph", "self", "rf", "richter", "gone"]) {
      const s = mercury();
      const r = await gw(s).requestPay({ ...base, recipientId: R[k].id });
      assert.equal(r.status, 403, k);
      assert.equal(s.posts.length, 0, k);
    }
  });
  it("refuses when checking is not 5649 any more (id / last four mismatch)", async () => {
    const s = mercury({ last4: "0001" });
    const r = await gw(s).requestPay(base);
    assert.equal(r.status, 503);
    assert.equal(s.posts.length, 0);
  });
  it("a POST that may have reached Mercury is 'outcome_unknown', never 'failed'", async () => {
    const s = mercury({ postMode: "down" });
    const r = await gw(s).requestPay(base);
    assert.equal(r.body.error, "outcome_unknown");
  });
  it("Mercury's own duplicate guard comes back in words", async () => {
    const s = mercury({ postMode: "dup" });
    const r = await gw(s).requestPay(base);
    assert.equal(r.body.error, "mercury_refused");
    assert.match(r.body.mercury, /Duplicate/);
  });
});

describe("payStatus: read from Mercury, Nesher checking only", () => {
  it("waiting -> approved -> paid when the payment has gone out", async () => {
    const id = "abcdef01-2345-4678-9abc-def012345678";
    const q = { accountId: CHECKING_ID, requestId: id, recipientId: R.shloimy.id, memo: "PNR ABC123", paymentMethod: "domesticWire", amount: 3200, status: "pendingApproval", reviews: [], createdAt: new Date(NOW - 3600e3).toISOString() };
    const s = mercury({ requests: [q] });
    let r = await gw(s).payStatus(id);
    assert.equal(r.body.state, "waiting");
    q.status = "approved";
    q.reviews = [{ reviewerUserId: "x", status: "approved", reviewedAt: new Date(NOW).toISOString() }];
    s.txns = [{ id: "t9", amount: -3200, status: "pending", externalMemo: "PNR ABC123" }];
    r = await gw(s).payStatus(id);
    assert.equal(r.body.state, "sending");
    s.txns[0].status = "sent";
    r = await gw(s).payStatus(id);
    assert.equal(r.body.state, "paid");
    assert.ok(!JSON.stringify(r.body).includes("reviewerUserId"));
  });
  it("another account's request is refused", async () => {
    const id = "abcdef01-2345-4678-9abc-def012345679";
    const s = mercury({ requests: [{ accountId: "bbbbbbbb-0000-0000-0000-000000008521", requestId: id, recipientId: R.shloimy.id, amount: 1, status: "pendingApproval", reviews: [], createdAt: new Date(NOW).toISOString() }] });
    const r = await gw(s).payStatus(id);
    assert.equal(r.status, 403);
  });
});

describe("Gabbai 24 Sep C3/C4/C5: gone desk, either memo echo, no JRM mark at the bank", () => {
  const base = { recipientId: R.shloimy.id, amountCents: 320000, memo: "PNR ABC123", idempotencyKey: "nesher-desk-mp0000001", note: "mp0000001 by joseph" };
  it("the external memo carries no JRM mark; the note begins with the full memo", async () => {
    assert.equal(externalMemoOf("JRM-11038-O2 prima deposit"), "prima deposit");
    assert.equal(externalMemoOf("JRM Hotels deposit for Cohen"), "deposit for Cohen");
    assert.equal(externalMemoOf("JRM-11038-O2"), "Supplier payment");
    assert.equal(externalMemoOf("jrm"), "Supplier payment");
    assert.equal(externalMemoOf("PNR ABC123"), "PNR ABC123");
    const s = mercury();
    await gw(s).requestPay({ ...base, memo: "JRM-11038-O2 prima deposit" });
    assert.equal(s.posts[0].externalMemo, "prima deposit");
    assert.ok(!/jrm/i.test(s.posts[0].externalMemo));
    assert.ok(s.posts[0].note.startsWith("JRM-11038-O2 prima deposit" + NOTE_MARK));
  });
  it("a Mercury 2xx without a request id is outcome_unknown, never refused", async () => {
    const s = mercury();
    const inner = s.fetch;
    s.fetch = async (url, init = {}) => {
      if ((init.method || "GET") === "POST") { s.posts.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
      return inner(url, init);
    };
    const r = await gw(s).requestPay(base);
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "outcome_unknown");
  });
  it("a desk that stopped waiting gets nothing POSTed", async () => {
    const s = mercury();
    const r = await gw(s).requestPay({ ...base, isGone: () => true });
    assert.equal(r.body.error, "client_gone_nothing_sent");
    assert.equal(s.posts.length, 0);
  });
  for (const echo of ["external", "note"]) {
    it(`Mercury echoes the ${echo === "note" ? "note" : "externalMemo"} as memo: duplicate, day cap and paid still hold`, async () => {
      const s = mercury({ echo });
      const g = gw(s, { MONEY_PAY_DAY_CENTS: "400000" });
      let r = await g.requestPay(base);
      assert.equal(r.status, 200);
      r = await g.requestPay({ ...base, idempotencyKey: "nesher-desk-mp0000002" });
      assert.equal(r.status, 409, "duplicate within 24 h");
      assert.equal(s.posts.length, 1);
      r = await g.requestPay({ ...base, memo: "PNR XYZ999", amountCents: 100000, idempotencyKey: "nesher-desk-mp0000003" });
      assert.equal(r.body.error, "over_day_cap");
      const id = s.requests[0].requestId;
      s.requests[0].status = "approved";
      s.txns = [{ id: "t1", amount: -3200, status: "sent", externalMemo: "PNR ABC123" }];
      const st = await g.payStatus(id);
      assert.equal(st.body.state, "paid");
    });
  }
  it("memoMatches reads both shapes and nothing looser", () => {
    assert.equal(memoMatches("PNR ABC123", "pnr  abc123"), true);
    assert.equal(memoMatches("PNR ABC123" + NOTE_MARK + "mp1 by joseph", "PNR ABC123"), true);
    assert.equal(memoMatches("prima deposit", "JRM-11038-O2 prima deposit"), true);
    assert.equal(memoMatches("PNR ABC1234", "PNR ABC123"), false);
    assert.equal(memoMatches("", "PNR ABC123"), false);
  });
});

describe("memo, payee words", () => {
  it("finds PNRs, JRM numbers and reservations in a memo", () => {
    const m = memoRefs("pay for PNR ABC123 and JRM-11084-O43, RES-Q6TWM7, hotels");
    assert.ok(m.codes.includes("ABC123"));
    assert.equal(m.codes[0].match(/\d/) != null, true);
    assert.deepEqual(m.jrmRequests, [1084]);
    assert.deepEqual(m.res, ["Q6TWM7"]);
    assert.deepEqual(memoRefs("בקשה 1038").jrmRequests, [1038]);
  });
  it("names one payee or none", () => {
    const views = Object.values(R).filter((x) => payeeVerdict(x).ok).map(payeeView);
    assert.equal(pickPayee("Shloimys Kosher World", views).name, "Shloimys Kosher World");
    assert.equal(pickPayee("shloimys", views).name, "Shloimys Kosher World");
    assert.equal(pickPayee("prima", views).name, "prima Hotels");
    assert.equal(pickPayee("Sky", views).name, "Sky Consolidators LLC");
    assert.equal(pickPayee("nobody here", views), null);
    assert.ok(payeeScore("kosher world", payeeView(R.shloimy)) >= 70);
  });
  it("door paths", () => {
    assert.equal(payDoorOf("/__nesher_pay/pay/prepare"), "prepare");
    assert.equal(payDoorOf("/__nesher_pay/pay/request/"), "request");
    assert.equal(payDoorOf("/__nesher_pay/pay/status"), "status");
    assert.equal(payDoorOf("/__nesher_pay/pay/send"), "send");
    assert.equal(payDoorOf("/__nesher_pay/pay/transfer"), null);
    assert.ok(TICKET_KINDS.includes("pay") && TICKET_KINDS.includes("payprep") && TICKET_KINDS.includes("paystat"));
  });
});

async function startDoor(door) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (!(await door.handle(req, res, u.pathname))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function post(url, path, token, body) {
  const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-ocr-ticket": token } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

describe("the doors: ticket kind, binding and rep", () => {
  it("prepare names the payee, says why a blocked one is blocked, and never lists persons", async () => {
    const s = mercury();
    const logs = [];
    const d = await startDoor(createMoneyPay({ gateway: gw(s), secret: SECRET, clock: () => NOW, log: (l) => logs.push(l) }));
    try {
      let t = mintTicket({ kind: "payprep", repId: "joseph", bind: "mpabc12345", secret: SECRET, now: NOW });
      let r = await post(d.url, "/__nesher_pay/pay/prepare", t.token, { tile_id: "mpabc12345", payee_query: "Shloimys", amount_cents: 320000, memo: "PNR ABC123", rep: "joseph" });
      assert.equal(r.status, 200);
      assert.equal(r.json.payee.name, "Shloimys Kosher World");
      const names = r.json.payees.map((p) => p.name);
      assert.ok(!names.includes("yakov weissmandl") && !names.includes("Yoseph Green") && !names.includes("Rank Friendly Inc."));
      t = mintTicket({ kind: "payprep", repId: "joseph", bind: "mpabc12345", secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/prepare", t.token, { tile_id: "mpabc12345", payee_query: "Rank Friendly", amount_cents: 100, memo: "x", rep: "joseph" });
      assert.equal(r.json.payee, null);
      assert.equal(r.json.blocked.why, "own_or_other_org");
      assert.ok(logs.some((l) => l.startsWith("money-pay ") && l.includes('"rep":"joseph"')));
      assert.ok(!logs.join("\n").includes(FAKE_FULL));
    } finally { await d.close(); }
  });
  it("a pay ticket for one amount cannot pay another amount, and the rep must match", async () => {
    const s = mercury();
    const d = await startDoor(createMoneyPay({ gateway: gw(s), secret: SECRET, clock: () => NOW, log: () => {} }));
    try {
      const body = { tile_id: "mpabc12345", recipient_id: R.shloimy.id, amount_cents: 320000, memo: "PNR ABC123", matched: "", rep: "joseph", idempotency_key: "nesher-desk-mpabc12345" };
      let t = mintTicket({ kind: "pay", repId: "joseph", bind: `${R.shloimy.id}|100|nesher-desk-mpabc12345`, secret: SECRET, now: NOW });
      let r = await post(d.url, "/__nesher_pay/pay/request", t.token, body);
      assert.equal(r.status, 401);
      assert.equal(r.json.error, "ticket_bind_mismatch");
      t = mintTicket({ kind: "pay", repId: "sruly", bind: `${R.shloimy.id}|320000|nesher-desk-mpabc12345`, secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/request", t.token, body);
      assert.equal(r.json.error, "ticket_rep_mismatch");
      t = mintTicket({ kind: "charge", repId: "joseph", bind: `${R.shloimy.id}|320000|nesher-desk-mpabc12345`, secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/request", t.token, body);
      assert.equal(r.json.error, "ticket_kind_mismatch");
      assert.equal(s.posts.length, 0);
      t = mintTicket({ kind: "pay", repId: "joseph", bind: `${R.shloimy.id}|320000|nesher-desk-mpabc12345`, secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/request", t.token, body);
      assert.equal(r.status, 200);
      assert.equal(r.json.request.status, "pendingApproval");
      assert.equal(s.posts.length, 1);
      assert.match(s.posts[0].note, /by joseph/);
      // the same ticket again: spent
      r = await post(d.url, "/__nesher_pay/pay/request", t.token, body);
      assert.equal(r.json.error, "ticket_used");
      assert.equal(s.posts.length, 1);
    } finally { await d.close(); }
  });
  it("switched off = 404 whatever the ticket", async () => {
    const s = mercury();
    const d = await startDoor(createMoneyPay({ gateway: gw(s, { MONEY_PAY: "off" }), secret: SECRET, clock: () => NOW, log: () => {} }));
    try {
      const t = mintTicket({ kind: "paystat", repId: "joseph", bind: "abcdef01-2345-4678-9abc-def012345678", secret: SECRET, now: NOW });
      const r = await post(d.url, "/__nesher_pay/pay/status", t.token, { request_id: "abcdef01-2345-4678-9abc-def012345678", rep: "joseph" });
      assert.equal(r.status, 404);
      assert.equal(s.calls.length, 0);
    } finally { await d.close(); }
  });
});
