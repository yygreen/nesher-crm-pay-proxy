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
import { mintTicket, mintOcrTicket, registerCardHold, redeemCardHold, CARD_HOLD_TTL_MS, _resetCardRefsForTests } from "../ocr-card.js";

const SECRET = "test-ocr-secret-0123456789abcdef";
const PAN = "4539578763621486"; // synthetic, Luhn-valid, Visa range
const CVV = "731";

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
  const h = registerCardHold({ pan: PAN, expiry: "10/29", brand: "visa", rep: "sruly", ...over });
  assert.equal(h.ok, true, "the hold must mint for the test to mean anything");
  return h.ref;
}

/** Everything the doors said, in one string, so "never logged" can be asserted. */
function everythingSaid(door, ...responses) {
  return [...door.logs, ...responses.map((r) => (r && r.text) || "")].join("\n");
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
      assert.equal(redeemCardHold(ref, { rep: "sruly" }).ok, true, "the hold was not spent by refused calls");
    } finally {
      await s.close();
    }
  });

  it("JRM charge: held card sold on mav2083 with the typed cvv, AVS along, never payment_descriptor, response shape", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k-live-never" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, {
        token_ref: ref, amount_cents: 123456, currency: "usd", brand: "jrm", rep: "sruly", customer_name: "Avrohom Cohen",
        cvv: CVV,
        invoice_ref: "JRM-189-O50", note: "2 nights", address1: "12 Main St", city: "Monsey", state: "NY", zip: "10952", country: "US",
      });
      assert.equal(p.status, 200, p.text);
      assert.deepEqual(p.body, {
        ok: true, txn_id: "txn-100", brand: "jrm", last4: "1486", card_brand: "visa", amount_cents: 123456, currency: "USD",
        processor_id: "mav2083", auth_code: "OK123", avs: "Y", cvv: "M", cvv_sent: true, order_id: "JRM-189-O50",
      });
      assert.equal(calls.length, 1, "one gateway call: the sale, and nothing else");
      const sale = calls[0];
      assert.match(sale.url, /\/api\/v5\/payments\/sale$/);
      assert.equal(sale.auth, "k-live-never");
      assert.equal(sale.body.amount, "1234.56");
      assert.equal(sale.body.processor_id, "mav2083");
      // The held number and expiry, and the code the rep typed, all on this
      // one call and nowhere else.
      assert.deepEqual(sale.body.payment_details, { card_number: PAN, card_exp: "1029", card_cvv: CVV });
      assert.equal(sale.body.customer_vault, undefined, "no paid add-on on the path");
      assert.equal(sale.body.payment_descriptor, undefined);
      assert.equal(sale.body.billing_address.address1, "12 Main St");
      assert.equal(sale.body.billing_address.zip, "10952");
      assert.equal(sale.body.billing_address.first_name, "Avrohom");
      assert.equal(sale.body.merchant_defined_fields.field_1, "jrm");
      assert.equal(sale.body.merchant_defined_fields.field_5, "sruly");
      assert.equal(sale.body.merchant_defined_fields.field_6, "2 nights");
      assert.equal(redeemCardHold(ref, { rep: "sruly" }).error, "unknown", "hold spent");
      assert.equal(s.logs.length, 1);
      const line = JSON.parse(s.logs[0].replace(/^charge /, ""));
      assert.deepEqual(line, { method: "POST", ticket: t.ticketId, outcome: "approved", ms: line.ms, brand: "jrm", amount_cents: 123456, txn: "txn-100", cvv_sent: true });
      // Neither the number, nor the code, nor the reference, nor the guest.
      const said = everythingSaid(s, p);
      for (const secretish of [PAN, CVV, ref, "Cohen", "4539 5787"]) {
        assert.equal(said.includes(secretish), false, `never said: ${secretish.slice(0, 4)}...`);
      }
      assert.doesNotMatch(said, /\d{13,19}/, "no card-length digit run anywhere");
    } finally {
      await s.close();
    }
  });

  it("cvv is optional: without one the sale still goes, and the answer says so", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 200, p.text);
      assert.equal(p.body.ok, true);
      assert.equal(p.body.cvv_sent, false, "the tile and the ledger must be able to show this");
      assert.deepEqual(calls[0].body.payment_details, { card_number: PAN, card_exp: "1029" });
      assert.equal("card_cvv" in calls[0].body.payment_details, false);
      assert.match(s.logs[0], /"cvv_sent":false/);
    } finally {
      await s.close();
    }
  });

  it("a cvv that is not 3 or 4 digits is refused before the gateway, and the hold survives", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef();
      // "12345" is the one that matters: a mistyped code must be refused, not
      // quietly cut down to four digits and sent to the bank.
      for (const junk of ["12", "12345", "123456789", "abc", "1 3", "12a"]) {
        const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
        const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest", cvv: junk });
        assert.equal(p.status, 400, p.text);
        assert.equal(p.body.error, "cvv_invalid");
      }
      assert.equal(calls.length, 0);
      assert.equal(redeemCardHold(ref, { rep: "sruly" }).ok, true, "a bad cvv does not burn the card");
    } finally {
      await s.close();
    }
  });

  it("the cvv never reaches a decline answer or a decline log either", async () => {
    const { fetchImpl } = gatewayMock({ sale: { response: "2", response_code: "225", response_text: "CVV MISMATCH" } });
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest", cvv: CVV });
      assert.equal(p.status, 402);
      assert.equal(p.body.decline_reason_human, "The security code is wrong.");
      assert.equal(p.body.cvv_sent, true);
      const said = everythingSaid(s, p);
      assert.equal(said.includes(CVV), false);
      assert.equal(said.includes(PAN), false);
    } finally {
      await s.close();
    }
  });

  it("the number is zeroed after the charge on every path: approved, declined, and the gateway throwing", async () => {
    const seen = [];
    for (const script of [
      { name: "approved", sale: { response: "1", id: "txn-z", auth_code: "A" } },
      { name: "declined", sale: { response: "2", response_code: "200" } },
      { name: "threw", throws: true },
    ]) {
      const fetchImpl = async (url, init = {}) => {
        if (script.throws) throw new Error("gateway on fire");
        return { ok: true, status: 200, text: async () => JSON.stringify(script.sale) };
      };
      const trace = { buffers: [] };
      const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k", trace });
      try {
        const ref = newRef();
        const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
        const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest", cvv: CVV });
        // Gabbai 23 Sep F5: a gateway that throws is an UNKNOWN outcome (503), never "declined".
        assert.equal(p.status, { approved: 200, declined: 402, threw: 503 }[script.name], `${script.name}: ${p.status} ${p.text}`);
        assert.equal(trace.buffers.length, 1, `${script.name}: the door held exactly one number`);
        assert.equal(
          trace.buffers[0].every((b) => b === 0),
          true,
          `${script.name}: the number is zeroed once the answer is out`
        );
        assert.equal(redeemCardHold(ref, { rep: "sruly" }).error, "unknown", `${script.name}: gone from the store`);
        const said = everythingSaid(s, p);
        assert.equal(said.includes(PAN), false, `${script.name}: no number said`);
        assert.equal(said.includes(CVV), false, `${script.name}: no code said`);
        seen.push(script.name);
      } finally {
        await s.close();
      }
    }
    assert.deepEqual(seen, ["approved", "declined", "threw"]);
  });

  it("a hold past its five minutes is refused, and a hold read by another rep is refused, without a gateway call", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      // Expired: minted in the past so its whole life is already over.
      const old = registerCardHold({ pan: PAN, expiry: "10/29", brand: "visa", rep: "sruly" }, { now: Date.now() - CARD_HOLD_TTL_MS - 1000 }).ref;
      let t = mintTicket({ kind: "charge", repId: "sruly", bind: old, secret: SECRET });
      let p = await post(s.url, CHARGE_PATH, t.token, { token_ref: old, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 410);
      assert.equal(p.body.error, "token_ref_spent_or_expired");
      assert.match(s.logs.at(-1), /"outcome":"token_ref_gone:expired"/);

      // Wrong rep: hershy has a perfectly good ticket of his own, bound to a
      // reference that is not his to spend.
      const mine = registerCardHold({ pan: PAN, expiry: "10/29", brand: "visa", rep: "sruly" }).ref;
      t = mintTicket({ kind: "charge", repId: "hershy", bind: mine, secret: SECRET });
      p = await post(s.url, CHARGE_PATH, t.token, { token_ref: mine, amount_cents: 2500, brand: "jrm", rep: "hershy", customer_name: "Guest" });
      assert.equal(p.status, 403, p.text);
      assert.equal(p.body.error, "token_ref_wrong_rep");
      assert.match(s.logs.at(-1), /"outcome":"token_ref_wrong_rep"/);
      // Burned: even the rep who took the photo cannot use it now.
      t = mintTicket({ kind: "charge", repId: "sruly", bind: mine, secret: SECRET });
      p = await post(s.url, CHARGE_PATH, t.token, { token_ref: mine, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 410);

      assert.equal(calls.length, 0, "no card ever reached the gateway on a refused hold");
    } finally {
      await s.close();
    }
  });

  it("a charge ticket bound to a different token_ref cannot spend this one", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const mine = newRef();
      const other = newRef();
      // A real, signed, unexpired, unused charge ticket - for the OTHER card.
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: other, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: mine, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 401);
      assert.equal(p.body.error, "ticket_bind_mismatch");
      assert.equal(calls.length, 0);
      assert.equal(redeemCardHold(mine, { rep: "sruly" }).ok, true, "and neither card was spent");
      assert.equal(redeemCardHold(other, { rep: "sruly" }).ok, true);
    } finally {
      await s.close();
    }
  });

  it("Nesher charge goes to mav7067 with a generated RES-CARD order id", async () => {
    const { fetchImpl, calls } = gatewayMock();
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef({ rep: "goldie" });
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

  it("declines map to plain words with the raw code beside; 503 when keys are missing", async () => {
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
      assert.equal(calls.length, 1, "one sale attempt, no clean-up call to a vault that does not exist");
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
      assert.equal(redeemCardHold(ref, { rep: "sruly" }).ok, true, "validation failures do not spend the hold");
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

describe("unknown gateway outcome at the desk charge door (Gabbai 23 Sep F5)", () => {
  beforeEach(() => _resetCardRefsForTests());
  it("503 outcome_unknown with do-not-charge-again words, not a 402 decline, on throw / 5xx / unreadable", async () => {
    for (const make of [
      () => async () => { throw new Error("socket hang up"); },
      () => async () => ({ ok: false, status: 502, text: async () => "<html>bad gateway</html>" }),
      () => async () => ({ ok: true, status: 200, text: async () => "not json" }),
    ]) {
      const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl: make(), privateKey: "k" });
      try {
        const ref = newRef();
        const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
        const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "nesher", rep: "sruly", customer_name: "Guest", cvv: CVV });
        assert.equal(p.status, 503, p.text);
        assert.equal(p.body.error, "outcome_unknown");
        assert.match(p.body.message, /Do not charge again/);
        assert.match(s.logs.join("\n"), /"outcome":"outcome_unknown"/);
        assert.equal(everythingSaid(s, p).includes(PAN), false);
      } finally {
        await s.close();
      }
    }
  });
});
