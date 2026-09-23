// POST /__nesher_pay/card-hold - a typed, pasted or spoken card (Joseph 23 Sep: "make it also
// work by pasting in numbers or by writing in numbers or by speaking in numbers"). The same
// in-memory hold as the photo reader, the same /ocr answer shape, the same zeroing. Test
// number 4111 1111 1111 1111 only.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  CARD_HOLD_PATH,
  isCardHoldPath,
  normalizeExpiry,
  handleCardHoldRequest,
  mintTicket,
  redeemCardHold,
  zeroHold,
  _resetCardRefsForTests,
} from "../ocr-card.js";
import { handleChargeRequest } from "../card-charge.js";

const SECRET = "card-hold-test-secret-0123456789abcdef";
const PAN = "4111111111111111";

function req(body, headers = {}, method = "POST") {
  const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const r = Readable.from([raw]);
  r.method = method;
  r.headers = { "content-type": "application/json", "content-length": String(raw.length), ...headers };
  return r;
}
function res() {
  const out = { status: 0, headers: {}, body: "" };
  return {
    out,
    writeHead(s, h) { out.status = s; out.headers = h || {}; },
    end(b) { out.body = b ? String(b) : ""; },
  };
}
function ticket(kind = "hold", repId = "joseph", bind = "") {
  return mintTicket({ kind, repId, bind, secret: SECRET }).token;
}
async function hold(body, tk = ticket(), logs = []) {
  const r = res();
  await handleCardHoldRequest(req(body, { "x-ocr-ticket": tk }), r, { secret: SECRET, log: (l) => logs.push(l) });
  return { status: r.out.status, json: JSON.parse(r.out.body || "{}"), logs };
}

describe("card-hold door", () => {
  beforeEach(() => _resetCardRefsForTests());

  it("the path is its own", () => {
    assert.equal(CARD_HOLD_PATH, "/__nesher_pay/card-hold");
    assert.equal(isCardHoldPath("/__nesher_pay/card-hold"), true);
    assert.equal(isCardHoldPath("/__nesher_pay/ocr"), false);
  });

  it("expiry forms: 12/30, 1230, 12/2030, 12-30; never a past or impossible month", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    for (const f of ["12/30", "1230", "12/2030", "12-30", "12 30"]) assert.equal(normalizeExpiry(f, now), "12/30", f);
    assert.equal(normalizeExpiry("13/30", now), null);
    assert.equal(normalizeExpiry("01/20", now), null);
    assert.equal(normalizeExpiry("", now), null);
  });

  it("a typed card is held and answered in the /ocr shape - last four, never the number", async () => {
    const logs = [];
    const r = await hold({ pan: "4111 1111 1111 1111", exp: "12/30", cvv: "123" }, ticket(), logs);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.brand, "visa");
    assert.equal(r.json.brandLabel, "Visa");
    assert.equal(r.json.last4, "1111");
    assert.equal(r.json.expiry, "12/30");
    assert.equal(r.json.confirmLast4, false);
    assert.equal(r.json.source, "typed");
    assert.equal(r.json.cvv_held, true);
    assert.match(r.json.token_ref, /^cr_[A-Za-z0-9_-]{16,64}$/);
    const wire = JSON.stringify(r.json) + logs.join("\n");
    assert.equal(wire.includes(PAN), false, "no number on the wire or in the log");
    assert.equal(/123(?!\d)/.test(JSON.stringify(r.json).replace(/"token_ref":"[^"]+"/, "")), false, "no code on the wire");
    assert.match(logs[0], /^hold \{"method":"POST","ticket":"[0-9a-f]{24}","outcome":"ok:typed:cvv"/);
  });

  it("a spoken card must be confirmed by its last four", async () => {
    const r = await hold({ pan: PAN, exp: "1230", source: "spoken" });
    assert.equal(r.json.source, "spoken");
    assert.equal(r.json.confirmLast4, true);
    assert.equal(r.json.cvv_held, false);
  });

  it("refusals in words the chat maps: bad number, bad expiry, a five-digit code (never sliced)", async () => {
    assert.equal((await hold({ pan: "4111111111111112", exp: "12/30" })).json.error, "pan_invalid");
    assert.equal((await hold({ pan: PAN, exp: "01/20" })).json.error, "expiry_invalid");
    assert.equal((await hold({ pan: PAN, exp: "12/30", cvv: "12345" })).json.error, "cvv_invalid");
  });

  it("the ticket: required, kind hold only, single use, signed", async () => {
    const r0 = res();
    await handleCardHoldRequest(req({ pan: PAN, exp: "12/30" }), r0, { secret: SECRET, log: () => {} });
    assert.equal(r0.out.status, 401);
    assert.equal((await hold({ pan: PAN, exp: "12/30" }, ticket("ocr"))).json.error, "ticket_kind_mismatch");
    const tk = ticket();
    assert.equal((await hold({ pan: PAN, exp: "12/30" }, tk)).status, 200);
    assert.equal((await hold({ pan: PAN, exp: "12/30" }, tk)).json.error, "ticket_used");
    const forged = mintTicket({ kind: "hold", repId: "joseph", secret: "another-secret-0123456789abcdef" }).token;
    assert.equal((await hold({ pan: PAN, exp: "12/30" }, forged)).json.error, "ticket_bad_signature");
  });

  it("disabled without the secret; POST only", async () => {
    const r = res();
    await handleCardHoldRequest(req({}), r, { secret: "", log: () => {} });
    assert.equal(r.out.status, 404);
    const r2 = res();
    await handleCardHoldRequest(req({}, { "x-ocr-ticket": ticket() }, "GET"), r2, { secret: SECRET, log: () => {} });
    assert.equal(r2.out.status, 405);
  });

  it("the hold is bound to the rep, spent once, and the held code is zeroed with the number", async () => {
    const r = await hold({ pan: PAN, exp: "12/30", cvv: "123" });
    const other = redeemCardHold(r.json.token_ref, { rep: "sruly" });
    assert.equal(other.ok, false);
    assert.equal(other.error, "rep_mismatch");
    const r2 = await hold({ pan: PAN, exp: "12/30", cvv: "123" });
    const got = redeemCardHold(r2.json.token_ref, { rep: "joseph" });
    assert.equal(got.ok, true);
    assert.equal(got.entry.cvv.toString("latin1"), "123");
    zeroHold(got.entry);
    assert.equal(got.entry.pan.every((b) => b === 0), true);
    assert.equal(got.entry.cvv.every((b) => b === 0), true);
    assert.equal(redeemCardHold(r2.json.token_ref, { rep: "joseph" }).error, "unknown");
  });

  it("the charge door uses the held code when the body has none, and zeroes both", async () => {
    const r = await hold({ pan: PAN, exp: "12/30", cvv: "123" });
    const ref = r.json.token_ref;
    const gateway = [];
    const trace = { buffers: [] };
    const fetchImpl = async (u, init) => {
      gateway.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ response: "2", response_code: "200", responsetext: "DECLINE", id: "t1" }) };
    };
    const tk = mintTicket({ kind: "charge", repId: "joseph", bind: ref, secret: SECRET }).token;
    const rr = res();
    await handleChargeRequest(
      req({ token_ref: ref, amount_cents: 2500, currency: "USD", brand: "jrm", rep: "joseph", customer_name: "Cohen" }, { "x-ocr-ticket": tk }),
      rr,
      { secret: SECRET, fetchImpl, privateKey: "k", log: () => {}, trace }
    );
    const j = JSON.parse(rr.out.body);
    assert.equal(j.ok, false);
    assert.equal(j.cvv_sent, true);
    assert.equal(gateway.length, 1);
    assert.equal(gateway[0].payment_details.card_number, PAN);
    assert.equal(gateway[0].payment_details.card_cvv, "123");
    assert.ok(trace.buffers.length >= 2, "the number and the code were both traced");
    for (const b of trace.buffers) assert.equal(b.every((x) => x === 0), true, "every held buffer is zero after the charge");
  });
});
