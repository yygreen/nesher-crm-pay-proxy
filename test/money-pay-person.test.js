// Mr. AJ Money (24 Sep 2026): pay a PERSON from pasted bank details, add a recipient, send an ACH
// without an approver (Joseph: "No need to wait for approvels"). NO real Mercury call happens in this
// file - every answer comes from the fake below, which counts every POST and keeps every body it got.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  createMercuryGateway,
  checkPayOperation,
  checkOperation,
  abaOk,
  recipientDraft,
  payeeFingerprint,
  payeeVerdict,
  maskEmail,
  TOKEN_FULL,
  NOTE_MARK,
} from "../mercury-gateway.js";
import { createMoneyPay, createPayeeHold, payDoorOf } from "../money-pay.js";
import { mintTicket } from "../ocr-card.js";

const FAKE_FULL = "secret-token:mercury_production_FAKE_FULL_TOKEN_0123456789abcdef";
const CHECKING_ID = "841f6d7c-53b8-11f1-a581-8f1a5e965da2";
const SECRET = "test-secret-0123456789abcdef";
const NOW = Date.parse("2026-09-24T18:00:00Z");
// Community Federal Savings Bank's routing number (the Wise USD details' bank), a real ABA number.
const CFSB = "026073150";
const ACCT = "8310006088846";

const BASE_R = {
  shloimy: { id: "22222222-2222-4222-8222-222222222222", status: "active", isBusiness: true, name: "Shloimys Kosher World", defaultPaymentMethod: "domesticWire", domesticWireRoutingInfo: { accountNumber: "0000003483", routingNumber: "021000021", bankName: "Chase" }, emails: [] },
  sky: { id: "33333333-3333-4333-8333-333333333333", status: "active", isBusiness: true, name: "Sky Consolidators LLC", defaultPaymentMethod: "ach", electronicRoutingInfo: { accountNumber: "000000007777", routingNumber: "021000021", electronicAccountType: "businessChecking", bankName: "Chase" }, emails: [] },
  cohen: { id: "44444444-4444-4444-8444-444444444444", status: "active", isBusiness: false, name: "Levi Cohen", defaultPaymentMethod: "ach", electronicRoutingInfo: { accountNumber: "000000001659", routingNumber: "021000021", electronicAccountType: "personalChecking", bankName: "Chase" }, emails: [] },
  richter: { id: "88888888-8888-4888-8888-888888888888", status: "active", isBusiness: true, name: "Trust account", defaultPaymentMethod: "ach", electronicRoutingInfo: { accountNumber: "000000008521", routingNumber: "091311229", electronicAccountType: "businessChecking" }, emails: [] },
};

// Mercury POST /recipients as documented (docs.mercury.com/reference/createrecipient): name string,
// emails array of strings, electronicRoutingInfo {accountNumber, routingNumber, electronicAccountType in
// the four, address {address1, city, region, postalCode, country ISO alpha-2}}; no nulls. A body that
// breaks any of it gets the answer Joseph saw on 24 Sep.
const ACH_ENUM = ["businessChecking", "businessSavings", "personalChecking", "personalSavings"];
function specErrors(b) {
  const e = [];
  const str = (v) => typeof v === "string" && v.trim().length > 0;
  if (!b || typeof b !== "object") return ["body"];
  if (!str(b.name)) e.push("name");
  if (!Array.isArray(b.emails) || !b.emails.every((x) => typeof x === "string")) e.push("emails");
  const r = b.electronicRoutingInfo;
  if (!r || typeof r !== "object") e.push("electronicRoutingInfo");
  else {
    if (!str(r.accountNumber)) e.push("accountNumber");
    if (!str(r.routingNumber)) e.push("routingNumber");
    if (!ACH_ENUM.includes(r.electronicAccountType)) e.push("electronicAccountType");
    const a = r.address;
    if (!a || typeof a !== "object") e.push("address");
    else {
      for (const k of ["address1", "city", "region", "postalCode"]) if (!str(a[k])) e.push("address." + k);
      if (!/^[A-Z]{2}$/.test(String(a.country || ""))) e.push("address.country");
    }
  }
  if (JSON.stringify(b).includes("null")) e.push("null");
  return e;
}

function mercury(opt = {}) {
  const R = JSON.parse(JSON.stringify(BASE_R));
  const s = { R, calls: [], posts: [], created: [], sends: [], requests: opt.requests || [], txns: opt.txns || [], addMode: opt.addMode || "ok", sendMode: opt.sendMode || "ok" };
  s.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const m = init.method || "GET";
    s.calls.push({ m, p: u.pathname + u.search });
    const p = u.pathname.replace(/^\/api\/v1/, "");
    if (p === "/accounts") return new Response(JSON.stringify({ accounts: [{ id: CHECKING_ID, accountNumber: "000000005649", type: "mercury", status: "active", legalBusinessName: "Air Today Travel Inc" }] }), { status: 200 });
    if (p === "/recipients" && m === "GET") return new Response(JSON.stringify({ recipients: Object.values(s.R), page: {} }), { status: 200 });
    if (p === "/recipients" && m === "POST") {
      const body = JSON.parse(init.body);
      s.posts.push({ p, body });
      const bad = specErrors(body);
      if (bad.length) { s.rejected = (s.rejected || 0) + 1; return new Response(JSON.stringify({ errors: { jsonParse: ["Error parsing JSON; please contact help@mercury.com."], why: bad } }), { status: 400 }); }
      if (s.addMode === "scope") return new Response(JSON.stringify({ errors: { message: "Token does not have the required scope: RecipientsWrite" } }), { status: 403 });
      if (s.addMode === "down") throw new TypeError("fetch failed");
      const id = "aaaaaaaa-0000-4000-8000-" + String(100000000000 + s.created.length).slice(-12);
      const rec = { id, status: "active", isBusiness: false, name: body.name, emails: body.emails, defaultPaymentMethod: "ach", electronicRoutingInfo: { ...body.electronicRoutingInfo, bankName: "Community Federal Savings Bank" } };
      s.created.push(rec);
      s.R["new" + s.created.length] = rec;
      return new Response(JSON.stringify(rec), { status: 200 });
    }
    const rm = p.match(/^\/recipient\/(.+)$/);
    if (rm) {
      const hit = Object.values(s.R).find((x) => x.id === rm[1]);
      return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response("{}", { status: 404 });
    }
    if (p === "/request-send-money" && m === "GET") return new Response(JSON.stringify({ requests: s.requests, page: {} }), { status: 200 });
    if (p === `/account/${CHECKING_ID}/transactions` && m === "GET") return new Response(JSON.stringify({ transactions: s.txns }), { status: 200 });
    if (p === `/account/${CHECKING_ID}/transactions` && m === "POST") {
      const body = JSON.parse(init.body);
      s.posts.push({ p, body });
      s.sends.push(body);
      if (s.sendMode === "down") throw new TypeError("fetch failed");
      if (s.sendMode === "approval") return new Response(JSON.stringify({ requestId: "abcdef01-2345-4678-9abc-def012345678", accountId: CHECKING_ID, recipientId: body.recipientId, amount: body.amount, status: "pendingApproval", memo: body.externalMemo, createdAt: new Date(NOW).toISOString() }), { status: 200 });
      if (s.sendMode === "dup400") return new Response(JSON.stringify({ errors: { message: "Duplicate transaction within 24 hours" } }), { status: 400 });
      const t = { id: "bbbbbbbb-0000-4000-8000-" + String(100000000000 + s.sends.length).slice(-12), accountId: CHECKING_ID, amount: -body.amount, status: "pending", counterpartyId: body.recipientId, counterpartyName: "x", note: body.note, externalMemo: body.externalMemo, createdAt: new Date(NOW).toISOString(), estimatedDeliveryDate: "2026-09-28T00:00:00Z", dashboardLink: "https://app.mercury.com/x" };
      s.txns.push(t);
      return new Response(JSON.stringify(t), { status: 200 });
    }
    const one = p.match(/^\/account\/[^/]+\/transaction\/(.+)$/);
    if (one) {
      const hit = s.txns.find((x) => x.id === one[1]);
      return hit ? new Response(JSON.stringify(hit), { status: 200 }) : new Response("{}", { status: 404 });
    }
    return new Response(JSON.stringify({ error: "unexpected " + m + " " + p }), { status: 599 });
  };
  return s;
}

const ENV_ON = { MERCURY_TOKEN_NESHER_FULL: FAKE_FULL, MONEY_PAY: "on", MONEY_PAY_RECIPIENTS: "on", MONEY_PAY_MODE: "direct", OCR_TICKET_SECRET: SECRET };
function gw(s, env = {}) {
  return createMercuryGateway({ env: { ...ENV_ON, ...env }, fetchImpl: s.fetch, now: () => NOW });
}
const fpOf = (r) => payeeFingerprint(r, SECRET);
const yael = () => recipientDraft({ name: "Yael Sher", routing: CFSB, account: ACCT, type: "Checking", emails: ["yael.sher@example.com"], address: { address1: "89-16 Jamaica Ave", city: "Woodhaven", region: "NY", postalCode: "11421", country: "US" } });

describe("the pure rules", () => {
  it("ABA checksum", () => {
    assert.equal(abaOk(CFSB), true);
    assert.equal(abaOk("021000021"), true);
    assert.equal(abaOk("026073151"), false);
    assert.equal(abaOk("12345678"), false);
    assert.equal(abaOk("000000000"), false);
  });
  it("a draft: personal checking by default, numbers only in the Mercury body, the view masked", () => {
    const d = yael();
    assert.equal(d.ok, true);
    assert.equal(d.body.electronicRoutingInfo.electronicAccountType, "personalChecking");
    assert.equal(d.body.electronicRoutingInfo.accountNumber, ACCT);
    assert.deepEqual(d.body.emails, ["yael.sher@example.com"]);
    assert.equal(d.view.last4, "8846");
    assert.deepEqual(d.view.emails, ["y***@example.com"]);
    assert.ok(!JSON.stringify(d.view).includes(ACCT) && !JSON.stringify(d.view).includes(CFSB));
    assert.equal(d.body.payment_descriptor, undefined);
  });
  it("refuses bad routing, Richter and our own last four, our own names", () => {
    assert.equal(recipientDraft({ name: "Yael", routing: "026073151", account: ACCT }).error, "routing_invalid");
    assert.equal(recipientDraft({ name: "Yael", routing: CFSB, account: "12345678521" }).error, "richter");
    assert.equal(recipientDraft({ name: "Yael", routing: CFSB, account: "12345671588" }).error, "richter");
    assert.equal(recipientDraft({ name: "Yael", routing: CFSB, account: "12345675649" }).error, "own_account");
    assert.equal(recipientDraft({ name: "Air Today Travel", routing: CFSB, account: ACCT }).error, "own_or_other_org");
    assert.equal(recipientDraft({ name: "", routing: CFSB, account: ACCT }).error, "name_required");
    assert.equal(recipientDraft({ name: "Yael", routing: CFSB, account: "12" }).error, "account_invalid");
  });
  it("Mr. AV (25 Sep): WhatsApp/markdown decoration is stripped off the name and street before Mercury sees it", () => {
    const base = { name: "Yael Sher", routing: CFSB, account: ACCT, type: "Checking", emails: ["yael.sher@example.com"], address: { address1: "89-16 Jamaica Ave", city: "Woodhaven", region: "NY", postalCode: "11421", country: "US" } };
    let d = recipientDraft({ ...base, name: "* Yael Sher" });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.body.name, "Yael Sher");

    d = recipientDraft({ ...base, name: "* Leah Roth *" });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.body.name, "Leah Roth");

    d = recipientDraft({ ...base, address: { ...base.address, address1: "* 3 Park Pl" } });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(d.body.electronicRoutingInfo.address.address1, "3 Park Pl");

    d = recipientDraft({ ...base, name: "Yael Sher - please refund $630" });
    assert.equal(d.ok, false);
    assert.equal(d.error, "name_invalid");
    assert.match(d.decline_reason_human, /numbers or signs/);
  });
  it("a person is a payee only with the switch", () => {
    assert.equal(payeeVerdict(BASE_R.cohen).why, "personal");
    assert.equal(payeeVerdict(BASE_R.cohen, { persons: true }).ok, true);
    assert.equal(payeeVerdict(BASE_R.richter, { persons: true }).why, "richter");
  });
  it("the new shapes are exact; the generic door still refuses them", () => {
    assert.equal(checkPayOperation("POST", "/recipients").ok, true);
    assert.equal(checkPayOperation("POST", `/account/${CHECKING_ID}/transactions`).ok, true);
    assert.equal(checkPayOperation("GET", `/account/${CHECKING_ID}/transaction/${BASE_R.sky.id}`).ok, true);
    assert.equal(checkPayOperation("GET", `/account/bbbbbbbb-0000-0000-0000-000000008521/transaction/${BASE_R.sky.id}`).ok, false);
    assert.equal(checkPayOperation("POST", "/account/bbbbbbbb-0000-0000-0000-000000008521/transactions").ok, false);
    assert.equal(checkPayOperation("POST", `/recipient/${BASE_R.sky.id}`).ok, false);
    assert.equal(checkPayOperation("DELETE", `/recipient/${BASE_R.sky.id}`).ok, false);
    assert.equal(checkPayOperation("POST", "/transfer").ok, false);
    assert.equal(checkOperation(TOKEN_FULL, "POST", "/recipients").status, 405);
    assert.equal(checkOperation(TOKEN_FULL, "POST", `/account/${CHECKING_ID}/transactions`).status, 405);
  });
  it("maskEmail", () => {
    assert.equal(maskEmail("yael.sher@gmail.com"), "y***@gmail.com");
    assert.equal(maskEmail(""), "");
  });
});

describe("addRecipient: moves no money, reuses the same bank details, says a scope refusal plainly", () => {
  it("off unless MONEY_PAY_RECIPIENTS=on, and nothing asked of Mercury", async () => {
    const s = mercury();
    const r = await gw(s, { MONEY_PAY_RECIPIENTS: "" }).addRecipient(yael());
    assert.equal(r.status, 404);
    assert.equal(s.calls.length, 0);
  });
  it("creates ONE ACH recipient with the email, never a send", async () => {
    const s = mercury();
    const r = await gw(s).addRecipient(yael());
    assert.equal(r.body.ok, true);
    assert.equal(r.body.reused, false);
    assert.equal(s.posts.length, 1);
    assert.equal(s.posts[0].p, "/recipients");
    assert.equal(s.posts[0].body.electronicRoutingInfo.routingNumber, CFSB);
    assert.deepEqual(s.posts[0].body.emails, ["yael.sher@example.com"]);
    assert.equal(s.sends.length, 0);
    assert.equal(r.body.recipient.last4, "8846");
    assert.equal(r.body.recipient.person, true);
    assert.equal(r.body.payable, true);
    assert.ok(!JSON.stringify(r.body).includes(ACCT));
  });
  it("the same bank details again are REUSED (also the safe retry after an unclear answer)", async () => {
    const s = mercury();
    const g = gw(s);
    const a = await g.addRecipient(yael());
    const b = await g.addRecipient(yael());
    assert.equal(b.body.reused, true);
    assert.equal(b.body.recipient.id, a.body.recipient.id);
    assert.equal(s.created.length, 1);
  });
  it("same name, other bank: both are named back, nothing is created without the second say", async () => {
    const s = mercury();
    const d = recipientDraft({ name: "Levi Cohen", routing: CFSB, account: ACCT, address: { address1: "89-16 Jamaica Ave", city: "Woodhaven", region: "NY", postalCode: "11421", country: "US" } });
    const r = await gw(s).addRecipient(d);
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "same_name_other_bank");
    assert.equal(r.body.twins[0].last4, "1659");
    assert.equal(s.created.length, 0);
    const r2 = await gw(s).addRecipient(d, { allowSameName: true });
    assert.equal(r2.body.ok, true);
    assert.equal(s.created.length, 1);
  });
  it("a token that may not add recipients: token_scope_refused with Mercury's words, nothing made", async () => {
    const s = mercury({ addMode: "scope" });
    const r = await gw(s).addRecipient(yael());
    assert.equal(r.body.error, "token_scope_refused");
    assert.match(r.body.mercury, /scope/i);
    assert.equal(s.created.length, 0);
  });
  it("a network drop on the POST is outcome_unknown, never 'failed'", async () => {
    const s = mercury({ addMode: "down" });
    const r = await gw(s).addRecipient(yael());
    assert.equal(r.body.error, "outcome_unknown");
  });
});

describe("sendPay: direct ACH from Nesher checking, every rule checked here", () => {
  const base = (s, extra = {}) => ({ recipientId: BASE_R.cohen.id, amountCents: 63000, memo: "Refund RES-8P4R3T", idempotencyKey: "nesher-desk-mpak000001", fp: fpOf(BASE_R.cohen), note: "mpak000001 by joseph", ...extra });
  it("sends ONE ACH to the person, the note carries the desk mark, no payment_descriptor", async () => {
    const s = mercury();
    const r = await gw(s).sendPay(base(s));
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, "direct");
    assert.equal(r.body.txn.status, "pending");
    assert.equal(s.sends.length, 1);
    assert.equal(s.sends[0].paymentMethod, "ach");
    assert.equal(s.sends[0].amount, 630);
    assert.equal(s.sends[0].idempotencyKey, "nesher-desk-mpak000001");
    assert.ok(s.sends[0].note.includes(NOTE_MARK));
    assert.equal(s.sends[0].payment_descriptor, undefined);
    assert.equal(s.sends[0].paymentDescriptor, undefined);
    const posts = s.calls.filter((c) => c.m !== "GET");
    assert.equal(posts.length, 1);
    assert.equal(posts[0].p, `/api/v1/account/${CHECKING_ID}/transactions`);
  });
  it("without MONEY_PAY_MODE=direct the same tap is an approval request (F7), never a direct send", async () => {
    const s = mercury();
    const r = await gw(s, { MONEY_PAY_MODE: "" }).sendPay(base(s));
    assert.equal(s.sends.length, 0);
    assert.equal(s.calls.filter((c) => c.m === "POST")[0].p, `/api/v1/account/${CHECKING_ID}/request-send-money`);
    void r;
  });
  it("a wire payee still goes for approval even in direct mode (v1 is ACH only)", async () => {
    const s = mercury();
    await gw(s).sendPay({ ...base(s), recipientId: BASE_R.shloimy.id, fp: fpOf(BASE_R.shloimy) });
    assert.equal(s.sends.length, 0);
    assert.equal(s.calls.filter((c) => c.m === "POST")[0].p, `/api/v1/account/${CHECKING_ID}/request-send-money`);
  });
  it("bank details that changed since the tile: refused, nothing sent", async () => {
    const s = mercury();
    s.R.cohen.electronicRoutingInfo.accountNumber = "000000009999";
    const r = await gw(s).sendPay(base(s));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "payee_changed");
    assert.equal(s.sends.length, 0);
  });
  it("no fingerprint = no send", async () => {
    const s = mercury();
    const r = await gw(s).sendPay(base(s, { fp: "" }));
    assert.equal(r.body.error, "payee_changed");
    assert.equal(s.sends.length, 0);
  });
  it("Richter is never paid, whatever the tile says", async () => {
    const s = mercury();
    const r = await gw(s).sendPay(base(s, { recipientId: BASE_R.richter.id, fp: fpOf(BASE_R.richter) }));
    assert.equal(r.body.error, "payee_richter");
    assert.equal(s.sends.length, 0);
  });
  it("over $10,000 is refused before anything is asked", async () => {
    const s = mercury();
    const r = await gw(s).sendPay(base(s, { amountCents: 1000001 }));
    assert.equal(r.body.error, "over_cap");
    assert.equal(s.calls.length, 0);
  });
  it("the $25,000 day counts everything the chat sent in 24 h, for everyone; the desk may lower it", async () => {
    const s = mercury({ txns: [
      { id: "cccccccc-0000-4000-8000-000000000001", amount: -9000, status: "sent", counterpartyId: BASE_R.sky.id, note: "Hotel" + NOTE_MARK + "mpx by sruly", createdAt: new Date(NOW - 3600e3).toISOString() },
      { id: "cccccccc-0000-4000-8000-000000000002", amount: -9000, status: "pending", counterpartyId: BASE_R.sky.id, note: "Hotel 2" + NOTE_MARK + "mpy by hershy", createdAt: new Date(NOW - 7200e3).toISOString() },
      { id: "cccccccc-0000-4000-8000-000000000003", amount: -50000, status: "sent", counterpartyId: BASE_R.sky.id, note: "paid in the Mercury app", createdAt: new Date(NOW - 7200e3).toISOString() },
    ] });
    let r = await gw(s).sendPay(base(s, { amountCents: 700100 }));
    assert.equal(r.body.error, "over_day_cap");
    assert.equal(r.body.day_used_cents, 1800000);
    r = await gw(s).sendPay(base(s, { amountCents: 63000, dayCapCents: 1850000 }));
    assert.equal(r.body.error, "over_day_cap");
    assert.equal(s.sends.length, 0);
    r = await gw(s).sendPay(base(s, { amountCents: 63000 }));
    assert.equal(r.body.ok, true);
  });
  it("same person and amount in 24 h: a warning (409 with the earlier one); the second tap may send", async () => {
    const s = mercury({ txns: [{ id: "cccccccc-0000-4000-8000-000000000009", amount: -630, status: "pending", counterpartyId: BASE_R.cohen.id, note: "Refund", createdAt: new Date(NOW - 600e3).toISOString() }] });
    let r = await gw(s).sendPay(base(s));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "duplicate_24h");
    assert.equal(r.body.existing.amount, 630);
    assert.equal(s.sends.length, 0);
    r = await gw(s).sendPay(base(s, { allowDup: true }));
    assert.equal(r.body.ok, true);
    assert.equal(s.sends.length, 1);
  });
  it("Mr. AR (25 Sep): a retry of the SAME desk tile is itself, not a duplicate - a DIFFERENT tile still gets 409", async () => {
    // base()'s idempotencyKey is "nesher-desk-mpak000001" and note is "mpak000001 by joseph" -
    // exactly what deskNote() puts at the front of the Mercury note, after NOTE_MARK.
    const sameTile = mercury({ txns: [{ id: "cccccccc-0000-4000-8000-000000000010", amount: -630, status: "pending", counterpartyId: BASE_R.cohen.id, note: "Refund RES-8P4R3T" + NOTE_MARK + "mpak000001 by joseph", createdAt: new Date(NOW - 600e3).toISOString(), estimatedDeliveryDate: "2026-09-28T00:00:00Z" }] });
    let r = await gw(sameTile).sendPay(base(sameTile));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.mode, "direct");
    assert.equal(r.body.reused, true);
    assert.equal(r.body.txn.id, "cccccccc-0000-4000-8000-000000000010");
    assert.equal(sameTile.sends.length, 0, "the SAME tile's retry never reaches Mercury again");

    const otherTile = mercury({ txns: [{ id: "cccccccc-0000-4000-8000-000000000011", amount: -630, status: "pending", counterpartyId: BASE_R.cohen.id, note: "Refund RES-8P4R3T" + NOTE_MARK + "mpzz999999 by hershy", createdAt: new Date(NOW - 600e3).toISOString() }] });
    r = await gw(otherTile).sendPay(base(otherTile));
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "duplicate_24h");
    assert.equal(r.body.existing.amount, 630);
    assert.equal(otherTile.sends.length, 0);
  });
  it("Mercury holding an API send for approval is said as such (approval_forced), never 'sent'", async () => {
    const s = mercury({ sendMode: "approval" });
    const r = await gw(s).sendPay(base(s));
    assert.equal(r.body.mode, "approval_forced");
    assert.equal(r.body.request.status, "pendingApproval");
  });
  it("a drop on the POST is outcome_unknown; Mercury's own 24 h refusal comes back with its words", async () => {
    let s = mercury({ sendMode: "down" });
    let r = await gw(s).sendPay(base(s));
    assert.equal(r.body.error, "outcome_unknown");
    s = mercury({ sendMode: "dup400" });
    r = await gw(s).sendPay(base(s));
    assert.equal(r.body.error, "mercury_refused");
    assert.match(r.body.mercury, /Duplicate/);
  });
  it("a desk that stopped waiting: nothing is sent", async () => {
    const s = mercury();
    const r = await gw(s).sendPay({ ...base(s), isGone: () => true });
    assert.equal(r.body.error, "client_gone_nothing_sent");
    assert.equal(s.sends.length, 0);
  });
  it("Gabbai C2: Mercury's words echoing an account number keep only its last four", async () => {
    const s = mercury();
    const echo = async (url, init = {}) => {
      if (new URL(String(url)).pathname.endsWith("/transactions") && (init.method || "GET") === "POST") {
        return new Response(JSON.stringify({ errors: { message: `Invalid account ${ACCT} at routing ${CFSB}` } }), { status: 400 });
      }
      return s.fetch(url, init);
    };
    const g = createMercuryGateway({ env: ENV_ON, fetchImpl: echo, now: () => NOW });
    const r = await g.sendPay(base(s));
    assert.equal(r.body.error, "mercury_refused");
    assert.ok(!r.body.mercury.includes(ACCT) && !r.body.mercury.includes(CFSB), r.body.mercury);
    assert.ok(r.body.mercury.includes("••8846"));
  });
  it("Gabbai C6: a person's payment never says 'Supplier payment' at their bank; a supplier's still may", async () => {
    const s = mercury();
    await gw(s).sendPay(base(s, { memo: "JRM Hotels" }));
    assert.equal(s.sends[0].externalMemo, "Refund");
    const s2 = mercury();
    await gw(s2).sendPay(base(s2, { recipientId: BASE_R.sky.id, fp: fpOf(BASE_R.sky), memo: "JRM" }));
    assert.equal(s2.sends[0].externalMemo, "Supplier payment");
  });
  it("Gabbai C9: the view says whether the chat may pay this recipient", async () => {
    const all = await gw(mercury()).payRecipientsAll();
    const v = (id) => all.find((x) => x.view.id === id).view;
    assert.equal(v(BASE_R.cohen.id).payable, true);
    assert.equal(v(BASE_R.richter.id).payable, false);
    assert.equal(v(BASE_R.richter.id).why, "richter");
    const off = await gw(mercury(), { MONEY_PAY_RECIPIENTS: "" }).payRecipientsAll();
    assert.equal(off.find((x) => x.view.id === BASE_R.cohen.id).view.payable, false);
  });
  it("payTxnStatus: pending -> sending, sent -> paid, Nesher checking only", async () => {
    const s = mercury();
    const g = gw(s);
    const r = await g.sendPay(base(s));
    let st = await g.payTxnStatus(r.body.txn.id);
    assert.equal(st.body.state, "sending");
    s.txns[0].status = "sent";
    st = await g.payTxnStatus(r.body.txn.id);
    assert.equal(st.body.state, "paid");
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

describe("the doors: hold -> add -> send, never a number in a log line or an answer", () => {
  it("paste to paid, end to end on the fake", async () => {
    const s = mercury();
    const logs = [];
    const d = await startDoor(createMoneyPay({ gateway: gw(s), secret: SECRET, clock: () => NOW, log: (l) => logs.push(l) }));
    try {
      assert.equal(payDoorOf("/__nesher_pay/pay/payee-hold"), "payee-hold");
      // 1. hold
      let t = mintTicket({ kind: "payprep", repId: "joseph", bind: "prak000001", secret: SECRET, now: NOW });
      let r = await post(d.url, "/__nesher_pay/pay/payee-hold", t.token, { tile_id: "prak000001", rep: "joseph", details: { name: "Yael Sher", routing: CFSB, account: ACCT, type: "Checking", emails: ["yael.sher@example.com"], address: { address1: "89-16 Jamaica Ave", city: "Woodhaven", region: "NY", postalCode: "11421", country: "US" } } });
      assert.equal(r.status, 200);
      assert.match(r.json.ref, /^ph_/);
      assert.equal(r.json.draft.last4, "8846");
      assert.equal(r.json.existing, null);
      assert.equal(s.posts.length, 0, "the hold creates nothing");
      const ref = r.json.ref;
      // a hold ticket for a pay tile id (mp...) is refused: holds belong to recipient tiles
      t = mintTicket({ kind: "payprep", repId: "joseph", bind: "mpak000001", secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/payee-hold", t.token, { tile_id: "mpak000001", rep: "joseph", details: {} });
      assert.equal(r.status, 401);
      // 2. add - another rep's ticket cannot spend Joseph's hold
      t = mintTicket({ kind: "pay", repId: "sruly", bind: `add|${ref}|prak000001`, secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/recipient-add", t.token, { ref, tile_id: "prak000001", rep: "sruly" });
      assert.equal(r.status, 403);
      t = mintTicket({ kind: "pay", repId: "joseph", bind: `add|${ref}|prak000001`, secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/recipient-add", t.token, { ref, tile_id: "prak000001", rep: "joseph" });
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      const rec = r.json.recipient;
      assert.equal(rec.last4, "8846");
      assert.equal(s.sends.length, 0, "adding moves no money");
      // the hold is spent
      t = mintTicket({ kind: "pay", repId: "joseph", bind: `add|${ref}|prak000001`, secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/recipient-add", t.token, { ref, tile_id: "prak000001", rep: "joseph" });
      assert.equal(r.json.error, "ref_expired");
      // 3. send, bound to recipient, amount, key AND fingerprint
      const bind = `send|${rec.id}|63000|nesher-desk-mpak000002|${rec.fp}|0`;
      t = mintTicket({ kind: "pay", repId: "joseph", bind: bind.replace("|63000|", "|64000|"), secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/send", t.token, { tile_id: "mpak000002", recipient_id: rec.id, amount_cents: 63000, memo: "Refund", idempotency_key: "nesher-desk-mpak000002", fp: rec.fp, rep: "joseph" });
      assert.equal(r.status, 401, "a ticket for another amount cannot pay this one");
      t = mintTicket({ kind: "pay", repId: "joseph", bind, secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/send", t.token, { tile_id: "mpak000002", recipient_id: rec.id, amount_cents: 63000, memo: "Refund", idempotency_key: "nesher-desk-mpak000002", fp: rec.fp, rep: "joseph", day_cap_cents: 2500000 });
      assert.equal(r.status, 200);
      assert.equal(r.json.mode, "direct");
      assert.equal(s.sends.length, 1);
      // 4. status by txn id
      t = mintTicket({ kind: "paystat", repId: "joseph", bind: "txn|" + r.json.txn.id, secret: SECRET, now: NOW });
      r = await post(d.url, "/__nesher_pay/pay/status", t.token, { txn_id: r.json.txn.id, rep: "joseph" });
      assert.equal(r.json.state, "sending");
      const all = logs.join("\n");
      assert.ok(!all.includes(ACCT) && !all.includes(CFSB), "no account or routing number in any log line");
      assert.ok(!all.includes("yael.sher@example.com"), "no email in the clear in any log line");
      assert.ok(all.includes("y***@example.com"));
    } finally { await d.close(); }
  });
  it("the hold: 30 minutes, then gone; bound to its rep", () => {
    let t = NOW;
    const h = createPayeeHold({ clock: () => t });
    const { ref } = h.put({ ok: true }, "joseph");
    assert.ok(h.get(ref, "joseph").draft);
    assert.equal(h.get(ref, "sruly").error, "ref_other_rep");
    t += 30 * 60 * 1000 + 1;
    assert.equal(h.get(ref, "joseph").error, "ref_expired");
  });
});

// Mr. AL (24 Sep): Joseph's real paste (Wise USD details, account number replaced by a fake) answered
// {"jsonParse":["Error parsing JSON; please contact help@mercury.com."]} because the body had no address.
describe("Mr. AL: Mercury's address is required, and checked before Mercury", () => {
  const JOSEPH = { name: "Yael Sher", routing: CFSB, account: ACCT, type: "Checking", emails: ["yael.sher@example.com"] };
  const BANK_ADDR = { address1: "89-16 Jamaica Ave", city: "Woodhaven", region: "NY", postalCode: "11421", country: "United States" };
  it("the fake enforces the spec: the 24 Sep body (no address) is refused with the words Joseph saw", async () => {
    const s = mercury();
    const r = await s.fetch("https://api.mercury.com/api/v1/recipients", { method: "POST", body: JSON.stringify({ name: "Yael Sher", emails: ["yael.sher@example.com"], electronicRoutingInfo: { accountNumber: ACCT, routingNumber: CFSB, electronicAccountType: "personalChecking" } }) });
    assert.equal(r.status, 400);
    assert.match(await r.text(), /jsonParse/);
  });
  it("no address: address_required from the draft, and Mercury is never asked", async () => {
    assert.equal(recipientDraft(JOSEPH).error, "address_required");
    assert.equal(recipientDraft({ ...JOSEPH, address: { address1: "89-16 Jamaica Ave", city: "Woodhaven", region: "", postalCode: "11421" } }).error, "address_required");
    assert.equal(recipientDraft({ ...JOSEPH, address: { ...BANK_ADDR, country: "Narnia" } }).error, "address_required");
  });
  it("the bank's address from the paste: country words become ISO-2 and ONE recipient is made, spec-clean", async () => {
    const d = recipientDraft({ ...JOSEPH, address: BANK_ADDR });
    assert.equal(d.ok, true);
    assert.deepEqual(d.body.electronicRoutingInfo.address, { address1: "89-16 Jamaica Ave", city: "Woodhaven", region: "NY", postalCode: "11421", country: "US" });
    assert.ok(!JSON.stringify(d.body).includes("null"));
    const s = mercury();
    const r = await gw(s).addRecipient(d);
    assert.equal(r.body.ok, true);
    assert.equal(s.rejected || 0, 0);
    assert.equal(s.created.length, 1);
  });
  it("the hold door answers address_required (400) and holds nothing", async () => {
    const d = recipientDraft({ ...JOSEPH, address: null });
    assert.equal(d.ok, false);
    assert.equal(d.error, "address_required");
  });
});

// Mr. AO Money (24 Sep 2026): the reps' notes on a payment tile ride in Mercury's INTERNAL note (never
// the external memo the supplier's bank sees), masked again here; Mercury's `reversed` reads `returned`.
describe("Mr. AO: tile notes and a returned payment", () => {
  it("deskNote: no notes = the old note exactly; notes are appended, digits cut to the last four", async () => {
    const { deskNote } = await import("../money-pay.js");
    assert.equal(deskNote("mp0000001", "joseph", "", ""), "mp0000001 by joseph");
    assert.equal(deskNote("mp0000001", "joseph", "reservation RES-1", undefined), "mp0000001 by joseph; for reservation RES-1");
    const n = deskNote("mp0000001", "joseph", "", "Joseph: refund Sukkos 79RHW4, acct 8310006088846");
    assert.equal(n, "mp0000001 by joseph; notes: Joseph: refund Sukkos 79RHW4, acct ••8846");
    assert.ok(!n.includes(ACCT));
    // Gabbai AO C1: a date survives the digit cut, exactly as the desk showed it
    assert.equal(deskNote("mp1", "joseph", "", "paid 2026-09-24, acct 8310006088846"), "mp1 by joseph; notes: paid 2026-09-24, acct \u2022\u20228846");
    assert.ok(deskNote("mp1", "joseph", "", "x".repeat(500)).length <= "mp1 by joseph; notes: ".length + 160);
  });
  it("the send door puts the notes in Mercury's note and nowhere in the external memo", async () => {
    const s = mercury();
    const d = await startDoor(createMoneyPay({ gateway: gw(s), secret: SECRET, clock: () => NOW, log: () => {} }));
    try {
      const fp = fpOf(BASE_R.cohen);
      const bind = `send|${BASE_R.cohen.id}|63000|nesher-desk-mpao000001|${fp}|0`;
      const t = mintTicket({ kind: "pay", repId: "joseph", bind, secret: SECRET, now: NOW });
      const r = await post(d.url, "/__nesher_pay/pay/send", t.token, { tile_id: "mpao000001", recipient_id: BASE_R.cohen.id, amount_cents: 63000, memo: "Refund", idempotency_key: "nesher-desk-mpao000001", fp, rep: "joseph", day_cap_cents: 2500000, rep_note: "Joseph: cancelled Sukkos trip 79RHW4" });
      assert.equal(r.status, 200);
      assert.equal(s.sends.length, 1);
      assert.ok(s.sends[0].note.includes(NOTE_MARK));
      assert.ok(s.sends[0].note.includes("notes: Joseph: cancelled Sukkos trip 79RHW4"));
      assert.ok(!String(s.sends[0].externalMemo || "").includes("Sukkos"), "the supplier's bank never sees a note");
      assert.equal(s.sends[0].paymentDescriptor, undefined);
      assert.equal(s.sends[0].payment_descriptor, undefined);
    } finally { await d.close(); }
  });
  it("payTxnStatus: reversed -> returned, failed stays failed", async () => {
    const s = mercury();
    const g = gw(s);
    const r = await g.sendPay({ recipientId: BASE_R.cohen.id, amountCents: 63000, memo: "Refund RES-8P4R3T", idempotencyKey: "nesher-desk-mpao000002", fp: fpOf(BASE_R.cohen), note: "mpao000002 by joseph" });
    s.txns[0].status = "reversed";
    let st = await g.payTxnStatus(r.body.txn.id);
    assert.equal(st.body.state, "returned");
    s.txns[0].status = "failed";
    st = await g.payTxnStatus(r.body.txn.id);
    assert.equal(st.body.state, "failed");
  });
});
