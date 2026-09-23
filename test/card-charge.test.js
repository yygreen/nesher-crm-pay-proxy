import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  CHARGE_PATH,
  VOID_PATH,
  REFUND_PATH,
  CHARGE_MAX_CENTS,
  chargeFamilyPath,
  refundCapCents,
  declineHuman,
  handleChargeRequest,
  handleVoidRequest,
  handleRefundRequest,
} from "../card-charge.js";
import { mintTicket, mintOcrTicket, registerCardRef, redeemCardRef, _resetCardRefsForTests } from "../ocr-card.js";

const SECRET = "test-ocr-secret-0123456789abcdef";

function gatewayMock(script = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || "GET", body, auth: init.headers && init.headers.Authorization });
    if (/\/payments\/sale$/.test(url)) {
      const r = script.sale || { response: "1", id: "txn-100", auth_code: "OK123", avs_response: "Y", cvv_response: "M" };
      return { ok: script.saleStatus ? script.saleStatus < 400 : true, status: script.saleStatus || 200, text: async () => JSON.stringify(r) };
    }
    if (/\/void$/.test(url)) {
      const r = script.void || { response: "1", id: "txn-100" };
      return { ok: true, status: 200, text: async () => JSON.stringify(r) };
    }
    if (/\/refund$/.test(url)) {
      const r = script.refund || { response: "1", id: "txn-200" };
      return { ok: true, status: 200, text: async () => JSON.stringify(r) };
    }
    if ((init.method || "GET") === "DELETE") return { ok: true, status: 200, text: async () => "{}" };
    return { ok: false, status: 404, text: async () => "{}" };
  };
  return { calls, fetchImpl };
}

async function startDoor(handler, deps) {
  const logs = [];
  const server = http.createServer((req, res) => handler(req, res, { log: (l) => logs.push(l), ...deps }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { logs, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function post(url, path, token, body) {
  const headers = { "content-type": "application/json" };
  if (token) headers["x-ocr-ticket"] = token;
  const r = await fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: text ? JSON.parse(text) : null, headers: r.headers };
}

function newRef(over = {}) {
  return registerCardRef({ customerVaultId: "ocr-vault-1", brand: "visa", last4: "1486", expiry: "10/29", ...over }).ref;
}

describe("card-charge basics", () => {
  it("paths", () => {
    assert.equal(chargeFamilyPath(CHARGE_PATH), "charge");
    assert.equal(chargeFamilyPath(VOID_PATH + "/"), "void");
    assert.equal(chargeFamilyPath(REFUND_PATH + "?x"), "refund");
    assert.equal(chargeFamilyPath("/__nesher_pay/ocr"), null);
    assert.equal(chargeFamilyPath("/pay/open/charge"), null);
  });

  it("refund cap: absent, empty, junk, negative -> 0; digits -> the number", () => {
    assert.equal(refundCapCents({}), 0);
    assert.equal(refundCapCents({ REFUND_CAP_CENTS: "" }), 0);
    assert.equal(refundCapCents({ REFUND_CAP_CENTS: "abc" }), 0);
    assert.equal(refundCapCents({ REFUND_CAP_CENTS: "-100" }), 0);
    assert.equal(refundCapCents({ REFUND_CAP_CENTS: "12.5" }), 0);
    assert.equal(refundCapCents({ REFUND_CAP_CENTS: "500000" }), 500000);
  });

  it("declineHuman: plain words, never a raw code in the sentence", () => {
    assert.equal(declineHuman("202"), "Insufficient funds.");
    assert.equal(declineHuman("223"), "The card has expired.");
    assert.equal(declineHuman("251"), "The issuer flagged this card. Do not retry.");
    assert.equal(declineHuman("430"), "The processor saw this as a duplicate.");
    assert.equal(declineHuman("999", "DECLINED BY ISSUER"), "The card was declined.");
    assert.equal(declineHuman(null, ""), "The card was not charged. Try again or use another card.");
    for (const code of ["200", "201", "202", "203", "204", "220", "221", "222", "223", "224", "225", "226", "240", "250", "260", "300", "400", "410", "411", "420", "421", "430", "440", "460", "461"]) {
      assert.doesNotMatch(declineHuman(code), /\d/, `no digits for ${code}`);
    }
  });
});

describe("POST /__nesher_pay/charge", () => {
  beforeEach(() => _resetCardRefsForTests());

  it("404 disabled (no secret), 405 GET, 401 no ticket / ocr ticket / wrong card ref / wrong rep", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const off = await startDoor(handleChargeRequest, { secret: "", fetchImpl, privateKey: "k" });
    try {
      const r = await post(off.url, CHARGE_PATH, "x", { token_ref: "cr_a" });
      assert.equal(r.status, 404);
      assert.equal(r.headers.get("connection"), "close");
    } finally {
      await off.close();
    }
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      let r = await fetch(s.url + CHARGE_PATH, { method: "GET", headers: { "x-ocr-ticket": "x" } });
      assert.equal(r.status, 405);
      let p = await post(s.url, CHARGE_PATH, "", { token_ref: "cr_a" });
      assert.equal(p.status, 401);
      assert.equal(p.body.error, "ticket_required");
      const ref = newRef();
      const ocr = mintOcrTicket({ repId: "sruly", secret: SECRET });
      p = await post(s.url, CHARGE_PATH, ocr.token, { token_ref: ref, amount_cents: 1000, currency: "USD", brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 401);
      assert.equal(p.body.error, "ticket_kind_mismatch");
      const bound = mintTicket({ kind: "charge", repId: "sruly", bind: "cr_someOtherCardReference0001", secret: SECRET });
      p = await post(s.url, CHARGE_PATH, bound.token, { token_ref: ref, amount_cents: 1000, currency: "USD", brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 401);
      assert.equal(p.body.error, "ticket_bind_mismatch");
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 1000, currency: "USD", brand: "jrm", rep: "hershy", customer_name: "Guest" });
      assert.equal(p.status, 401);
      assert.equal(p.body.error, "ticket_rep_mismatch");
      // the ticket is spent by that presentation
      p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 1000, currency: "USD", brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 401);
      assert.equal(p.body.error, "ticket_used");
      assert.equal(calls.length, 0, "the gateway never heard from us");
      assert.ok(redeemCardRef(ref), "the card ref was not spent by refused calls");
    } finally {
      await s.close();
    }
  });

  it("JRM charge: vault sale on mav2083, AVS along, never payment_descriptor, vault record deleted after, response shape", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k-live-never" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, {
        token_ref: ref, amount_cents: 123456, currency: "usd", brand: "jrm", rep: "sruly", customer_name: "Avrohom Cohen",
        invoice_ref: "JRM-189-O50", note: "2 nights", address1: "12 Main St", city: "Monsey", state: "NY", zip: "10952", country: "US",
      });
      assert.equal(p.status, 200, p.text);
      assert.deepEqual(p.body, {
        ok: true, txn_id: "txn-100", brand: "jrm", last4: "1486", card_brand: "visa", amount_cents: 123456, currency: "USD",
        processor_id: "mav2083", auth_code: "OK123", avs: "Y", cvv: "M", order_id: "JRM-189-O50",
      });
      assert.equal(calls.length, 2);
      const sale = calls[0];
      assert.match(sale.url, /\/api\/v5\/payments\/sale$/);
      assert.equal(sale.auth, "k-live-never");
      assert.equal(sale.body.amount, "1234.56");
      assert.equal(sale.body.processor_id, "mav2083");
      assert.deepEqual(sale.body.customer_vault, { id: "ocr-vault-1" });
      assert.equal(sale.body.payment_details, undefined);
      assert.equal(sale.body.payment_descriptor, undefined);
      assert.equal(sale.body.billing_address.address1, "12 Main St");
      assert.equal(sale.body.billing_address.zip, "10952");
      assert.equal(sale.body.billing_address.first_name, "Avrohom");
      assert.equal(sale.body.merchant_defined_fields.field_1, "jrm");
      assert.equal(sale.body.merchant_defined_fields.field_5, "sruly");
      assert.equal(sale.body.merchant_defined_fields.field_6, "2 nights");
      assert.equal(calls[1].method, "DELETE");
      assert.match(calls[1].url, /\/api\/v5\/customers\/ocr-vault-1$/);
      assert.equal(redeemCardRef(ref), null, "ref spent");
      assert.equal(s.logs.length, 1);
      const line = JSON.parse(s.logs[0].replace(/^charge /, ""));
      assert.deepEqual(line, { method: "POST", ticket: t.ticketId, outcome: "approved", ms: line.ms, brand: "jrm", amount_cents: 123456, txn: "txn-100" });
      assert.equal(s.logs[0].includes("ocr-vault-1"), false);
      assert.equal(s.logs[0].includes(ref), false);
      assert.equal(s.logs[0].includes("Cohen"), false);
    } finally {
      await s.close();
    }
  });

  it("Nesher charge goes to mav7067 with a generated RES-CARD order id", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "goldie", bind: ref, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 100, brand: "nesher", rep: "goldie", customer_name: "Miriam Schwartz" });
      assert.equal(p.status, 200, p.text);
      assert.equal(p.body.processor_id, "mav7067");
      assert.equal(p.body.brand, "nesher");
      assert.equal(calls[0].body.processor_id, "mav7067");
      assert.match(calls[0].body.order_details.id, /^RES-CARD-\d{8}-[A-Z0-9]{6}$/);
      assert.equal(calls[0].body.amount, "1.00");
    } finally {
      await s.close();
    }
  });

  it("declines map to plain words with the raw code beside; the vault record is still deleted; 503 when keys are missing", async () => {
    const { fetchImpl, calls } = gatewayMock({ sale: { response: "2", response_code: "202", response_text: "DECLINED: INSUFFICIENT FUNDS" } });
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 5000, brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 402);
      assert.equal(p.body.ok, false);
      assert.equal(p.body.decline_reason_human, "Insufficient funds.");
      assert.equal(p.body.decline_code, "202");
      assert.equal(p.body.decline_text, "DECLINED: INSUFFICIENT FUNDS");
      assert.equal(p.body.last4, "1486");
      assert.doesNotMatch(p.body.decline_reason_human, /\d/);
      assert.equal(calls[1].method, "DELETE");
      assert.match(s.logs[0], /"outcome":"declined:202"/);
    } finally {
      await s.close();
    }
    const s2 = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "" });
    try {
      const prev = process.env.NMI_PRIVATE_KEY;
      delete process.env.NMI_PRIVATE_KEY;
      try {
        const ref = newRef();
        const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
        const p = await post(s2.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 5000, brand: "jrm", rep: "sruly", customer_name: "Guest" });
        assert.equal(p.status, 503);
        assert.equal(p.body.error, "keys_missing");
      } finally {
        if (prev !== undefined) process.env.NMI_PRIVATE_KEY = prev;
      }
    } finally {
      await s2.close();
    }
  });

  it("validation: bad amount / brand / currency / name -> 400; spent ref -> 410; nothing reaches the gateway", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const mk = (ref) => mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET }).token;
      const base = { brand: "jrm", rep: "sruly", customer_name: "Guest", currency: "USD" };
      let ref = newRef();
      let p = await post(s.url, CHARGE_PATH, mk(ref), { ...base, token_ref: ref, amount_cents: 99 });
      assert.equal(p.status, 400);
      assert.equal(p.body.error, "amount_cents_invalid");
      p = await post(s.url, CHARGE_PATH, mk(ref), { ...base, token_ref: ref, amount_cents: CHARGE_MAX_CENTS + 1 });
      assert.equal(p.body.error, "amount_cents_invalid");
      p = await post(s.url, CHARGE_PATH, mk(ref), { ...base, token_ref: ref, amount_cents: 10.5 });
      assert.equal(p.body.error, "amount_cents_invalid");
      p = await post(s.url, CHARGE_PATH, mk(ref), { ...base, token_ref: ref, amount_cents: 1000, brand: "airtoday" });
      assert.equal(p.body.error, "brand_invalid");
      p = await post(s.url, CHARGE_PATH, mk(ref), { ...base, token_ref: ref, amount_cents: 1000, currency: "ILS" });
      assert.equal(p.body.error, "currency_usd_only");
      p = await post(s.url, CHARGE_PATH, mk(ref), { ...base, token_ref: ref, amount_cents: 1000, customer_name: "" });
      assert.equal(p.body.error, "customer_name_required");
      assert.ok(redeemCardRef(ref), "validation failures do not spend the ref");
      p = await post(s.url, CHARGE_PATH, mk(ref), { ...base, token_ref: ref, amount_cents: 1000 });
      assert.equal(p.status, 410);
      assert.equal(p.body.error, "token_ref_spent_or_expired");
      assert.equal(calls.length, 0);
    } finally {
      await s.close();
    }
  });
});

describe("POST /__nesher_pay/void and /refund", () => {
  beforeEach(() => _resetCardRefsForTests());

  it("void: bound to txn_id, posts the documented empty body, 402 on failure", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleVoidRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      let t = mintTicket({ kind: "void", repId: "sruly", bind: "txn-100", secret: SECRET });
      let p = await post(s.url, VOID_PATH, t.token, { txn_id: "txn-999" });
      assert.equal(p.status, 401);
      assert.equal(p.body.error, "ticket_bind_mismatch");
      t = mintTicket({ kind: "void", repId: "sruly", bind: "txn-100", secret: SECRET });
      p = await post(s.url, VOID_PATH, t.token, { txn_id: "txn-100" });
      assert.equal(p.status, 200, p.text);
      assert.deepEqual(p.body, { ok: true, txn_id: "txn-100", void_txn_id: "txn-100" });
      assert.match(calls[0].url, /\/api\/v5\/payments\/txn-100\/void$/);
      assert.deepEqual(calls[0].body, {});
      const charge = mintTicket({ kind: "charge", repId: "sruly", bind: "txn-100", secret: SECRET });
      p = await post(s.url, VOID_PATH, charge.token, { txn_id: "txn-100" });
      assert.equal(p.body.error, "ticket_kind_mismatch");
    } finally {
      await s.close();
    }
    const bad = gatewayMock({ void: { response: "3", response_code: "300", response_text: "Transaction already settled" } });
    const s2 = await startDoor(handleVoidRequest, { secret: SECRET, fetchImpl: bad.fetchImpl, privateKey: "k" });
    try {
      const t = mintTicket({ kind: "void", repId: "sruly", bind: "txn-100", secret: SECRET });
      const p = await post(s2.url, VOID_PATH, t.token, { txn_id: "txn-100" });
      assert.equal(p.status, 402);
      assert.equal(p.body.error, "void_failed");
      assert.equal(p.body.decline_code, "300");
      assert.doesNotMatch(p.body.decline_reason_human, /\d/);
    } finally {
      await s2.close();
    }
  });

  it("refund: refused when REFUND_CAP_CENTS is absent, refused above the cap, otherwise posts the amount", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl, privateKey: "k", env: {} });
    try {
      let t = mintTicket({ kind: "refund", repId: "sruly", bind: "txn-100", secret: SECRET });
      let p = await post(s.url, REFUND_PATH, t.token, { txn_id: "txn-100", amount_cents: 500 });
      assert.equal(p.status, 403);
      assert.equal(p.body.error, "refund_cap_not_set");
      assert.equal(p.body.cap_cents, 0);
      assert.equal(calls.length, 0, "no gateway call without a cap");
      assert.match(s.logs[0], /"outcome":"refund_refused:cap_not_set"/);
    } finally {
      await s.close();
    }
    const s2 = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl, privateKey: "k", env: { REFUND_CAP_CENTS: "100000" } });
    try {
      let t = mintTicket({ kind: "refund", repId: "sruly", bind: "txn-100", secret: SECRET });
      let p = await post(s2.url, REFUND_PATH, t.token, { txn_id: "txn-100", amount_cents: 100001 });
      assert.equal(p.status, 403);
      assert.equal(p.body.error, "refund_over_cap");
      assert.equal(p.body.cap_cents, 100000);
      assert.equal(calls.length, 0);
      t = mintTicket({ kind: "refund", repId: "sruly", bind: "txn-100", secret: SECRET });
      p = await post(s2.url, REFUND_PATH, t.token, { txn_id: "txn-100", amount_cents: 1234 });
      assert.equal(p.status, 200, p.text);
      assert.deepEqual(p.body, { ok: true, txn_id: "txn-100", refund_txn_id: "txn-200", amount_cents: 1234 });
      assert.match(calls[0].url, /\/api\/v5\/payments\/txn-100\/refund$/);
      assert.deepEqual(calls[0].body, { amount: 12.34 });
      t = mintTicket({ kind: "refund", repId: "sruly", bind: "txn-100", secret: SECRET });
      p = await post(s2.url, REFUND_PATH, t.token, { txn_id: "txn-100", amount_cents: 0 });
      assert.equal(p.status, 400);
      assert.equal(p.body.error, "amount_cents_invalid");
    } finally {
      await s2.close();
    }
  });
});
