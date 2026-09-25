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
  declineNext,
  KEYS_MISSING_WORDS,
  KEEP_CODES,
  handleChargeRequest,
  handleVoidRequest,
  handleRefundRequest,
  handleSaleLookup,
  SALE_PATH,
  salesFromXml,
  matchSales,
  _resetSaleCache,
  _resetArmingsForTests,
  _resetSaleClaimsForTests,
  PRE_REVERSAL_READ_MS,
  CRM_WRITE_MS,
} from "../card-charge.js";
import { REVERSAL_TIMEOUT_MS } from "../nmi-card.js";
import { mintTicket, mintOcrTicket, registerCardHold, redeemCardHold, zeroHold, sweepCardHolds, MAX_HOLD_DECLINES, CARD_HOLD_TTL_MS, _resetCardRefsForTests } from "../ocr-card.js";

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
    assert.equal(declineHuman(null, ""), "The card was not charged.");
    for (const code of ["200", "201", "202", "203", "204", "220", "221", "222", "223", "224", "225", "226", "240", "250", "260", "300", "400", "410", "411", "420", "421", "430", "440", "460", "461"]) {
      assert.doesNotMatch(declineHuman(code), /\d/, `no digits for ${code}`);
    }
  });

  // money-leftover-words, 25 Sep: audit E11 (#62) Hebrew beside English, E16 (#127) no dead-end "tell Joseph".
  it("E11 #62: every code has its Hebrew words, in Hebrew letters, with no digits and no English", () => {
    const codes = ["100", "200", "201", "202", "203", "204", "220", "221", "222", "223", "224", "225", "226", "240", "250", "251", "260", "264", "300", "400", "410", "411", "420", "421", "430", "440", "441", "460", "461"];
    for (const code of codes) {
      const he = declineHuman(code, null, { lang: "he" });
      assert.match(he, /[א-ת]/, `Hebrew for ${code}`);
      assert.doesNotMatch(he, /\d|[A-Za-z]/, `no digits or English for ${code}: ${he}`);
      assert.notEqual(he, declineHuman(code), `not the English for ${code}`);
    }
    assert.equal(declineHuman("999", "DECLINED BY ISSUER", { lang: "he" }), "הכרטיס נדחה.");
    assert.equal(declineHuman(null, "", { lang: "he" }), "הכרטיס לא חויב.");
    assert.match(declineHuman(null, "", { refused: true, said: "Amount exceeds limit", lang: "he" }), /^מערכת הסליקה דחתה את החיוב עצמו - הוא לא הגיע לבנק\. היא כתבה: "Amount exceeds limit"\.$/);
    // English is word for word what it was, for the codes this lane did not touch
    assert.equal(declineHuman("202"), "Insufficient funds.");
    assert.equal(declineNext("225", { kept: true }), "Type the right security code in the box on the tile and tap Charge again - the card is held 5 more minutes, no need to send it again.");
  });
  it("E11 #62 / E16 #127: every next step exists in Hebrew, and no next step in either language says tell Joseph / ask Joseph / tell the office", () => {
    const codes = ["200", "201", "202", "203", "204", "220", "221", "222", "223", "224", "225", "240", "250", "260", "300", "400", "410", "411", "420", "430", "440", "460", "999", ""];
    const dead = /tell joseph|ask joseph|tell the office|תגיד ליוסף|ספר ליוסף|למשרד/i;
    for (const code of codes) {
      for (const kept of [true, false]) {
        for (const refused of [true, false]) {
          const en = declineNext(code, { kept, refused });
          const he = declineNext(code, { kept, refused, lang: "he" });
          assert.doesNotMatch(en, dead, `${code} kept=${kept} refused=${refused}: ${en}`);
          assert.doesNotMatch(he, dead, `${code} kept=${kept} refused=${refused}: ${he}`);
          assert.match(he, /[א-ת]/, `Hebrew next for ${code}`);
        }
      }
      assert.doesNotMatch(declineHuman(code), dead, `reason ${code}`);
    }
    for (const w of Object.values(KEYS_MISSING_WORDS)) assert.doesNotMatch(w, dead, w);
    assert.match(KEYS_MISSING_WORDS.next, /gateway portal/);
    assert.match(declineNext("410"), /Pinpoint/);
    // Gabbai AT B3 (canon s.7) still holds in both languages: never advise splitting a sale under a limit
    assert.doesNotMatch(declineNext(null, { refused: true }) + declineNext(null, { refused: true, lang: "he" }), /split|two charges|לפצל|שני חיובים/i);
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
        if (script.name === "declined") {
          // Mr. AT (Joseph 25 Sep): a CLEAR decline puts the card back behind the same reference for a
          // retry. It is zeroed by the next spend; here the test spends and zeroes it by hand.
          assert.equal(p.body.hold_kept, true, "a clear decline keeps the card for a retry");
          const again = redeemCardHold(ref, { rep: "sruly" });
          assert.equal(again.ok, true, "declined: still held, same reference");
          zeroHold(again.entry);
        }
        assert.equal(
          trace.buffers[0].every((b) => b === 0),
          true,
          `${script.name}: the number is zeroed once the answer is out (or once the kept hold is spent)`
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
      // Audit E11 (#62): the same pair in Hebrew rides beside the English.
      assert.equal(p.body.decline_reason_he, "אין מספיק יתרה בכרטיס.");
      assert.match(p.body.decline_next_he, /סכום קטן יותר/);
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

// ── A fake processor record (query.php XML). Synthetic ids, names and masks only. ──
const NOW_MS = Date.now();
function stampOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
function txXml(t) {
  const acts = (t.actions || []).map((a) => `<action><amount>${a.amount}</amount><action_type>${a.type}</action_type><date>${stampOf(a.at)}</date><success>${a.success === false ? 0 : 1}</success><batch_id>${a.batch || 0}</batch_id></action>`).join("");
  return `<transaction><transaction_id>${t.id}</transaction_id><order_id>${t.order || ""}</order_id><original_transaction_id>${t.orig || ""}</original_transaction_id><processor_id>${t.proc || "mav7067"}</processor_id><condition>${t.cond || "complete"}</condition><cc_type>${t.ccType || "visa"}</cc_type><cc_number>${t.cc || "4xxxxxxxxxxx1111"}</cc_number><first_name>${t.first || ""}</first_name><last_name>${t.last || ""}</last_name>${acts}</transaction>`;
}
function nmiXml(list) {
  return `<?xml version="1.0" encoding="UTF-8"?><nm_response>${list.map(txXml).join("")}</nm_response>`;
}
const DAYS = (n) => NOW_MS - n * 86400000;
// A settled $500 Nesher sale with $100 already refunded (its own refund transaction), an unsettled
// $80 JRM sale from this morning, a voided sale, and one fully refunded sale.
function ledger() {
  return [
    { id: "txn-100", order: "RES-79RHW4", proc: "mav7067", cond: "complete", cc: "4xxxxxxxxxxx4421", first: "Moshe", last: "Cohen", actions: [{ type: "sale", amount: "500.00", at: DAYS(3) }, { type: "settle", amount: "500.00", at: DAYS(3) + 3600000, batch: 7 }] },
    { id: "txn-101", orig: "txn-100", proc: "mav7067", cond: "complete", actions: [{ type: "refund", amount: "-100.00", at: DAYS(2) }] },
    { id: "txn-300", order: "JRM-1422-O99", proc: "mav2083", cond: "pendingsettlement", cc: "5xxxxxxxxxxx0008", first: "Dina", last: "Levi", actions: [{ type: "sale", amount: "80.00", at: NOW_MS - 3600000 }] },
    { id: "txn-400", order: "RES-VOIDED", proc: "mav7067", cond: "canceled", actions: [{ type: "sale", amount: "40.00", at: DAYS(5) }, { type: "void", amount: "40.00", at: DAYS(5) + 60000 }] },
    { id: "txn-500", order: "RES-FULLRF", proc: "mav7067", cond: "complete", actions: [{ type: "sale", amount: "25.00", at: DAYS(9) }] },
    { id: "txn-501", orig: "txn-500", proc: "mav7067", cond: "complete", actions: [{ type: "refund", amount: "-25.00", at: DAYS(8) }] },
  ];
}

function processorMock(list = ledger(), script = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (/\/api\/query\.php$/.test(url)) {
      calls.push({ url, method: init.method || "GET", query: true, keyInBody: /security_key=/.test(String(init.body || "")) });
      if (script.queryDown) return { ok: false, status: 500, text: async () => "down" };
      return { ok: true, status: 200, text: async () => nmiXml(list) };
    }
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || "GET", body });
    if (/\/void$/.test(url)) {
      const r = script.void || { response: "1", id: "txn-300" };
      return { ok: true, status: 200, text: async () => JSON.stringify(r) };
    }
    if (/\/refund$/.test(url)) {
      const r = script.refund || { response: "1", id: "txn-900" };
      return { ok: true, status: 200, text: async () => JSON.stringify(r) };
    }
    return { ok: false, status: 404, text: async () => "{}" };
  };
  const moved = () => calls.filter((c) => !c.query);
  return { calls, moved, fetchImpl };
}
const CAPS_ON = { REFUND_CAP_CENTS: "100000", REFUND_DAY_CAP_CENTS: "300000" };

describe("a past sale read from the processor (24 Sep)", () => {
  beforeEach(() => _resetSaleCache());

  it("salesFromXml: amounts, already refunded, settled or not, what the chat may offer", () => {
    const { sales, dayBackCents } = salesFromXml(nmiXml(ledger()), { nowMs: NOW_MS });
    const by = Object.fromEntries(sales.map((s) => [s.txn_id, s]));
    assert.deepEqual(Object.keys(by).sort(), ["txn-100", "txn-300", "txn-400", "txn-500"]);
    assert.equal(by["txn-100"].amount_cents, 50000);
    assert.equal(by["txn-100"].refunded_cents, 10000);
    assert.equal(by["txn-100"].refundable_cents, 40000);
    assert.equal(by["txn-100"].action, "refund");
    assert.equal(by["txn-100"].merchant, "nesher");
    assert.equal(by["txn-100"].last4, "4421");
    assert.equal(by["txn-100"].booking, "RES-79RHW4");
    assert.equal(by["txn-300"].action, "void");
    assert.equal(by["txn-300"].settled, false);
    assert.equal(by["txn-300"].merchant, "jrm");
    assert.equal(by["txn-300"].voidable_cents, 8000);
    assert.equal(by["txn-400"].action, "none");
    assert.equal(by["txn-400"].why, "voided");
    assert.equal(by["txn-500"].action, "none");
    assert.equal(by["txn-500"].why, "fully_refunded");
    assert.equal(dayBackCents, 0, "nothing went back in the last 24 hours");
    assert.equal(sales[0].txn_id, "txn-300", "newest first");
  });

  it("a REFUND that was itself voided sent nothing back: not refunded_cents, not lastBack, not the day cap", () => {
    const list = ledger();
    // A $300 Nesher sale, and a refund of the whole amount that was itself voided minutes later
    // (its own condition is canceled AND it carries a successful void action).
    list.push({ id: "txn-700", order: "RES-VOIDRF", proc: "mav7067", cond: "complete", actions: [{ type: "sale", amount: "300.00", at: DAYS(1) }] });
    list.push({ id: "txn-701", orig: "txn-700", proc: "mav7067", cond: "canceled", actions: [{ type: "refund", amount: "-300.00", at: NOW_MS - 3600000 }, { type: "void", amount: "-300.00", at: NOW_MS - 1800000 }] });
    const { sales, dayBackCents } = salesFromXml(nmiXml(list), { nowMs: NOW_MS });
    const by = Object.fromEntries(sales.map((s) => [s.txn_id, s]));
    assert.equal(by["txn-700"].refunded_cents, 0, "the voided refund must not count as money already back");
    assert.equal(by["txn-700"].refundable_cents, 30000);
    assert.equal(by["txn-700"].action, "refund");
    assert.equal(by["txn-700"].last_back_cents, 0);
    assert.equal(by["txn-700"].last_back_at, null);
    assert.equal(dayBackCents, 0, "a voided refund never eats the day cap or the 15-minute guard");
    // Positive control: a normal, non-voided complete refund still counts (txn-100/txn-101 in ledger()).
    assert.equal(by["txn-100"].refunded_cents, 10000);
  });

  it("matchSales: txn, booking with or without RES-, last four, name + day; an identifier is required", () => {
    const { sales } = salesFromXml(nmiXml(ledger()), { nowMs: NOW_MS, nameNeedle: "cohen" });
    assert.deepEqual(matchSales(sales, { txn: "txn-100" }).matches.map((s) => s.txn_id), ["txn-100"]);
    assert.deepEqual(matchSales(sales, { ref: "79RHW4" }).matches.map((s) => s.txn_id), ["txn-100"]);
    assert.deepEqual(matchSales(sales, { ref: "res-79rhw4" }).matches.map((s) => s.txn_id), ["txn-100"]);
    assert.deepEqual(matchSales(sales, { last4: "0008" }).matches.map((s) => s.txn_id), ["txn-300"]);
    assert.deepEqual(matchSales(sales, { name: "Cohen" }).matches.map((s) => s.txn_id), ["txn-100"]);
    const day = new Date(DAYS(3));
    const from = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) - 86400000).toISOString();
    const to = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) + 2 * 86400000).toISOString();
    assert.deepEqual(matchSales(sales, { name: "Cohen", from, to }).matches.map((s) => s.txn_id), ["txn-100"]);
    assert.equal(matchSales(sales, { name: "Cohen", from: new Date(DAYS(1)).toISOString() }).matches.length, 0);
    assert.equal(matchSales(sales, { from, to }).error, "identifier_required");
  });

  it("the name is compared and dropped: never in the answer", () => {
    const { sales } = salesFromXml(nmiXml(ledger()), { nowMs: NOW_MS, nameNeedle: "cohen" });
    assert.equal(JSON.stringify(sales).includes("Cohen"), false);
    assert.equal(JSON.stringify(sales).includes("Moshe"), false);
  });

  it("POST /sale: ticket kind sale bound to the rep, read only, the name never echoed, 400 with no identifier", async () => {
    const { fetchImpl, calls, moved } = processorMock();
    const s = await startDoor(handleSaleLookup, { secret: SECRET, fetchImpl, privateKey: "k", env: CAPS_ON });
    try {
      let t = mintTicket({ kind: "sale", repId: "joseph", bind: "joseph", secret: SECRET });
      let p = await post(s.url, SALE_PATH, t.token, { rep: "joseph", q: { name: "Cohen" } });
      assert.equal(p.status, 200, p.text);
      assert.equal(p.body.total, 1);
      assert.equal(p.body.matches[0].txn_id, "txn-100");
      assert.equal(p.body.matches[0].refundable_cents, 40000);
      assert.equal(p.body.caps.refund_cap_set, true);
      assert.equal(p.text.includes("Cohen"), false);
      assert.equal(calls[0].keyInBody, true);
      assert.equal(moved().length, 0, "a lookup moves nothing");
      t = mintTicket({ kind: "sale", repId: "joseph", bind: "joseph", secret: SECRET });
      p = await post(s.url, SALE_PATH, t.token, { rep: "sruly", q: { txn: "txn-100" } });
      assert.equal(p.status, 401, "another rep's body is refused");
      t = mintTicket({ kind: "sale", repId: "joseph", bind: "joseph", secret: SECRET });
      p = await post(s.url, SALE_PATH, t.token, { rep: "joseph", q: { from: "2026-09-01" } });
      assert.equal(p.status, 400);
      assert.equal(p.body.error, "identifier_required");
      const refundTicket = mintTicket({ kind: "refund", repId: "joseph", bind: "joseph", secret: SECRET });
      p = await post(s.url, SALE_PATH, refundTicket.token, { rep: "joseph", q: { txn: "txn-100" } });
      assert.equal(p.body.error, "ticket_kind_mismatch");
    } finally {
      await s.close();
    }
  });
});

describe("POST /__nesher_pay/void and /refund", () => {
  beforeEach(() => { _resetCardRefsForTests(); _resetSaleCache(); _resetSaleClaimsForTests(); });

  it("void: an UNSETTLED sale, whole amount, bound to txn_id, documented empty body; settled or partial refused", async () => {
    const pm = processorMock();
    const crm = [];
    const s = await startDoor(handleVoidRequest, { secret: SECRET, fetchImpl: pm.fetchImpl, privateKey: "k", env: CAPS_ON, recordReversal: async (f) => { crm.push(f); return { ok: true, state: "posted", recorded: ["nmi-void:txn-300: -$80.00 -> hotel request #1422"] }; } });
    try {
      let t = mintTicket({ kind: "void", repId: "joseph", bind: "txn-300", secret: SECRET });
      let p = await post(s.url, VOID_PATH, t.token, { txn_id: "txn-999", amount_cents: 8000 });
      assert.equal(p.status, 401);
      assert.equal(p.body.error, "ticket_bind_mismatch");
      t = mintTicket({ kind: "void", repId: "joseph", bind: "txn-300", secret: SECRET });
      p = await post(s.url, VOID_PATH, t.token, { txn_id: "txn-300", amount_cents: 5000 });
      assert.equal(p.status, 409);
      assert.equal(p.body.error, "void_is_whole");
      t = mintTicket({ kind: "void", repId: "joseph", bind: "txn-100", secret: SECRET });
      p = await post(s.url, VOID_PATH, t.token, { txn_id: "txn-100", amount_cents: 50000 });
      assert.equal(p.status, 409);
      assert.equal(p.body.error, "already_settled");
      assert.equal(pm.moved().length, 0, "nothing moved on a refusal");
      t = mintTicket({ kind: "void", repId: "joseph", bind: "txn-300", secret: SECRET });
      p = await post(s.url, VOID_PATH, t.token, { txn_id: "txn-300", amount_cents: 8000, rep: "joseph" });
      assert.equal(p.status, 200, p.text);
      assert.equal(p.body.ok, true);
      assert.equal(p.body.amount_cents, 8000);
      assert.equal(p.body.merchant, "jrm");
      assert.equal(p.body.crm.state, "posted");
      assert.match(pm.moved()[0].url, /\/api\/v5\/payments\/txn-300\/void$/);
      assert.deepEqual(pm.moved()[0].body, {});
      assert.equal(crm[0].kind, "void");
      assert.equal(crm[0].saleTxn, "txn-300");
      assert.equal(crm[0].rep, "joseph", "who tapped it travels to the CRM row");
      assert.equal(crm[0].orderId, "JRM-1422-O99");
    } finally {
      await s.close();
    }
    const bad = processorMock(ledger(), { void: { response: "3", response_code: "300", response_text: "Transaction already settled" } });
    const s2 = await startDoor(handleVoidRequest, { secret: SECRET, fetchImpl: bad.fetchImpl, privateKey: "k", env: CAPS_ON });
    try {
      const t = mintTicket({ kind: "void", repId: "joseph", bind: "txn-300", secret: SECRET });
      const p = await post(s2.url, VOID_PATH, t.token, { txn_id: "txn-300", amount_cents: 8000 });
      assert.equal(p.status, 402);
      assert.equal(p.body.error, "void_failed");
      assert.equal(p.body.decline_code, "300");
      assert.doesNotMatch(p.body.decline_reason_human, /\d/);
    } finally {
      await s2.close();
    }
  });

  it("refund: cap absent refuses before any read; above the cap refused; then the processor's own facts rule", async () => {
    const pm = processorMock();
    const s = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl: pm.fetchImpl, privateKey: "k", env: {} });
    try {
      const t = mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET });
      const p = await post(s.url, REFUND_PATH, t.token, { txn_id: "txn-100", amount_cents: 500 });
      assert.equal(p.status, 403);
      assert.equal(p.body.error, "refund_cap_not_set");
      assert.equal(p.body.cap_cents, 0);
      assert.equal(pm.calls.length, 0, "no processor call at all without a cap");
      assert.match(s.logs[0], /"outcome":"refund_refused:cap_not_set"/);
    } finally {
      await s.close();
    }
    const crm = [];
    const s2 = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl: pm.fetchImpl, privateKey: "k", env: CAPS_ON, recordReversal: async (f) => { crm.push(f); return { ok: true, state: "posted", recorded: ["nmi-refund:txn-900: -$12.34 -> reservation #7"] }; } });
    const go = async (txn, cents) => post(s2.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: txn, secret: SECRET }).token, { txn_id: txn, amount_cents: cents, rep: "joseph" });
    try {
      let p = await go("txn-100", 100001);
      assert.equal(p.status, 403);
      assert.equal(p.body.error, "refund_over_cap");
      p = await go("txn-100", 40001);
      assert.equal(p.status, 409);
      assert.equal(p.body.error, "over_refundable", "$500 sale, $100 already back: $400.01 is refused");
      assert.equal(p.body.refundable_cents, 40000);
      p = await go("txn-300", 1000);
      assert.equal(p.status, 409);
      assert.equal(p.body.error, "not_settled");
      assert.match(p.body.decline_reason_human, /Void it instead/);
      p = await go("txn-400", 1000);
      assert.equal(p.body.error, "sale_voided");
      p = await go("txn-500", 100);
      assert.equal(p.body.error, "fully_refunded");
      p = await go("txn-777", 100);
      assert.equal(p.status, 404);
      assert.equal(p.body.error, "sale_not_found");
      assert.equal(pm.moved().length, 0, "every refusal above moved nothing");
      p = await go("txn-100", 1234);
      assert.equal(p.status, 200, p.text);
      assert.equal(p.body.ok, true);
      assert.equal(p.body.refund_txn_id, "txn-900");
      assert.equal(p.body.amount_cents, 1234);
      assert.equal(p.body.refunded_cents, 11234);
      assert.equal(p.body.merchant, "nesher");
      assert.equal(p.body.crm.state, "posted");
      assert.match(pm.moved()[0].url, /\/api\/v5\/payments\/txn-100\/refund$/);
      assert.deepEqual(pm.moved()[0].body, { amount: 12.34 });
      assert.deepEqual({ kind: crm[0].kind, saleTxn: crm[0].saleTxn, reversalTxn: crm[0].reversalTxn, amountUsd: crm[0].amountUsd, rep: crm[0].rep, orderId: crm[0].orderId, cardLast4: crm[0].cardLast4 },
        { kind: "refund", saleTxn: "txn-100", reversalTxn: "txn-900", amountUsd: 12.34, rep: "joseph", orderId: "RES-79RHW4", cardLast4: "4421" });
      p = await go("txn-100", 0);
      assert.equal(p.status, 400);
      assert.equal(p.body.error, "amount_cents_invalid");
    } finally {
      await s2.close();
    }
  });

  it("refund: the 24-hour cap counts what the processor says went back today, portal refunds included", async () => {
    const list = ledger();
    list.push({ id: "txn-600", order: "RES-OTHER1", proc: "mav7067", cond: "complete", actions: [{ type: "sale", amount: "2950.00", at: DAYS(20) }] });
    list.push({ id: "txn-601", orig: "txn-600", proc: "mav7067", cond: "complete", actions: [{ type: "refund", amount: "-2950.00", at: NOW_MS - 7200000 }] });
    const pm = processorMock(list);
    const s = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl: pm.fetchImpl, privateKey: "k", env: CAPS_ON });
    try {
      let p = await post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, { txn_id: "txn-100", amount_cents: 5001 });
      assert.equal(p.status, 403);
      assert.equal(p.body.error, "refund_over_day_cap", "$2,950 back today + $50.01 passes $3,000");
      p = await post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, { txn_id: "txn-100", amount_cents: 5000 });
      assert.equal(p.status, 200, p.text);
      assert.equal(p.body.crm.state, "not_recorded", "no CRM door wired in this test: said, never hidden");
    } finally {
      await s.close();
    }
  });

  it("refund: a processor that cannot be read means nothing is sent back (fail closed)", async () => {
    const pm = processorMock(ledger(), { queryDown: true });
    const s = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl: pm.fetchImpl, privateKey: "k", env: CAPS_ON });
    try {
      const p = await post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, { txn_id: "txn-100", amount_cents: 100 });
      assert.equal(p.status, 502);
      assert.equal(p.body.error, "sale_unreadable");
      assert.equal(pm.moved().length, 0);
    } finally {
      await s.close();
    }
  });

  it("refund: a CRM failure after the money went back is reported, never shown as a failed refund", async () => {
    const pm = processorMock();
    const s = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl: pm.fetchImpl, privateKey: "k", env: CAPS_ON, recordReversal: async () => { throw new Error("db down"); } });
    try {
      const p = await post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, { txn_id: "txn-100", amount_cents: 100 });
      assert.equal(p.status, 200);
      assert.equal(p.body.ok, true);
      assert.deepEqual(p.body.crm, { state: "not_recorded", reason: "crm_write_failed" });
    } finally {
      await s.close();
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

describe("a refund or void whose outcome is not known is never told as 'did not go through' (Gabbai 24 Sep C2-C5)", () => {
  beforeEach(() => { _resetSaleCache(); _resetArmingsForTests(); _resetSaleClaimsForTests(); });
  const unknowns = [
    ["a throw", async () => { throw new Error("socket hang up"); }],
    ["a 5xx", async () => ({ ok: false, status: 502, text: async () => "<html>bad gateway</html>" })],
    ["a 408", async () => ({ ok: false, status: 408, text: async () => "{}" })],
    ["an unreadable 200", async () => ({ ok: true, status: 200, text: async () => "not json" })],
    ["a 200 with no known response", async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ hello: "world" }) })],
  ];
  for (const [label, answer] of unknowns) {
    for (const [kind, path, txn, cents] of [["refund", REFUND_PATH, "txn-100", 500], ["void", VOID_PATH, "txn-300", 8000]]) {
      it(`${kind}: ${label} -> 503 outcome_unknown, do-not-send-again words, CRM untouched`, async () => {
        const pm = processorMock();
        const fetchImpl = async (u, init) => (/query\.php$/.test(String(u)) ? pm.fetchImpl(u, init) : answer());
        const crm = [];
        const s = await startDoor(kind === "refund" ? handleRefundRequest : handleVoidRequest, { secret: SECRET, fetchImpl, privateKey: "k", env: CAPS_ON, recordReversal: async (f) => { crm.push(f); return { state: "posted" }; } });
        try {
          const p = await post(s.url, path, mintTicket({ kind, repId: "joseph", bind: txn, secret: SECRET }).token, { txn_id: txn, amount_cents: cents, arming: "mcabc123:1700000000000" });
          assert.equal(p.status, 503, p.text);
          assert.equal(p.body.error, "outcome_unknown");
          assert.match(p.body.decline_reason_human, /Do not send it again - check the sale\./);
          assert.equal(crm.length, 0);
          const again = await post(s.url, path, mintTicket({ kind, repId: "joseph", bind: txn, secret: SECRET }).token, { txn_id: txn, amount_cents: cents, arming: "mcabc123:1700000000000" });
          assert.equal(again.status, 503, "the same arming is answered from its claim");
          assert.equal(again.body.repeated, true);
        } finally {
          await s.close();
        }
      });
    }
  }

  it("one arming, one gateway call: a second fire while the first is still at the gateway gets in_flight, then the saved answer", async () => {
    const pm = processorMock();
    let release;
    let refunds = 0;
    const slow = async (u, init) => {
      if (/query\.php$/.test(String(u))) return pm.fetchImpl(u, init);
      refunds++;
      await new Promise((r) => { release = r; });
      return { ok: true, status: 200, text: async () => JSON.stringify({ response: "1", id: "rf-slow" }) };
    };
    const s = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl: slow, privateKey: "k", env: CAPS_ON });
    try {
      const body = { txn_id: "txn-100", amount_cents: 20000, arming: "mcslow0001:1700000000000" };
      const first = post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, body);
      await new Promise((r) => setTimeout(r, 150));
      const second = await post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, body);
      assert.equal(second.status, 409);
      assert.equal(second.body.error, "in_flight");
      release();
      const a = await first;
      assert.equal(a.status, 200, a.text);
      const third = await post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, body);
      assert.equal(third.status, 200);
      assert.equal(third.body.repeated, true);
      assert.equal(third.body.refund_txn_id, "rf-slow");
      assert.equal(refunds, 1, "the gateway saw exactly ONE refund");
    } finally {
      await s.close();
    }
  });

  it("a refund already went back on this sale in the last 15 minutes (any screen, the portal) -> refused with its time and amount", async () => {
    const list = ledger();
    list.push({ id: "txn-102", orig: "txn-100", proc: "mav7067", cond: "complete", actions: [{ type: "refund", amount: "-20.00", at: NOW_MS - 5 * 60000 }] });
    const pm = processorMock(list);
    const s = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl: pm.fetchImpl, privateKey: "k", env: CAPS_ON });
    try {
      const p = await post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, { txn_id: "txn-100", amount_cents: 1000, arming: "mcother001:1700000000001" });
      assert.equal(p.status, 409);
      assert.equal(p.body.error, "recent_refund");
      assert.match(p.body.decline_reason_human, /^A refund of \$20\.00 went back on this sale at \d\d:\d\d \(Israel time\)\./);
      assert.equal(pm.moved().length, 0);
    } finally {
      await s.close();
    }
  });

  it("the time budget: the read before money moves is 10 s, the gateway 15 s, the CRM write 8 s - 33 s in all", () => {
    assert.equal(PRE_REVERSAL_READ_MS, 10000);
    assert.equal(REVERSAL_TIMEOUT_MS, 15000);
    assert.equal(CRM_WRITE_MS, 8000);
    assert.ok(PRE_REVERSAL_READ_MS + REVERSAL_TIMEOUT_MS + CRM_WRITE_MS < 45000, "inside the desk chat's 45 s wait");
  });

  it("a slow CRM write is reported as slow, never waited on past its limit", async () => {
    const pm = processorMock();
    const s = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl: pm.fetchImpl, privateKey: "k", env: CAPS_ON, crmWriteMs: 50, recordReversal: () => new Promise(() => {}) });
    try {
      const p = await post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, { txn_id: "txn-100", amount_cents: 100 });
      assert.equal(p.status, 200);
      assert.deepEqual(p.body.crm, { state: "not_recorded", reason: "crm_slow" });
    } finally {
      await s.close();
    }
  });

  it("two DIFFERENT tiles refunding the SAME sale at once: exactly one reaches the gateway, the other gets 409 sale_busy", async () => {
    const pm = processorMock();
    let gatewayCalls = 0;
    const fetchImpl = async (u, init) => {
      if (/query\.php$/.test(String(u))) return pm.fetchImpl(u, init);
      gatewayCalls++;
      await new Promise((r) => setTimeout(r, 300));
      return { ok: true, status: 200, text: async () => JSON.stringify({ response: "1", id: `rf-${gatewayCalls}` }) };
    };
    const s = await startDoor(handleRefundRequest, { secret: SECRET, fetchImpl, privateKey: "k", env: CAPS_ON });
    try {
      const mk = (arming) => post(s.url, REFUND_PATH, mintTicket({ kind: "refund", repId: "joseph", bind: "txn-100", secret: SECRET }).token, { txn_id: "txn-100", amount_cents: 200, arming });
      const [a, b] = await Promise.all([mk("mcfirst00001:1700000000000"), mk("mcsecond0002:1700000000000")]);
      const results = [a, b];
      const busy = results.filter((r) => r.status === 409 && r.body.error === "sale_busy");
      const ok = results.filter((r) => r.status === 200);
      assert.equal(busy.length, 1, "exactly one screen is told the other is already sending money back on this sale");
      assert.equal(ok.length, 1);
      assert.equal(gatewayCalls, 1, "the gateway saw exactly ONE refund");
      assert.match(busy[0].body.decline_reason_human, /Another screen is sending money back on this sale right now/);
      assert.equal(busy[0].body.txn_id, "txn-100");
    } finally {
      await s.close();
    }
  });
});

// ---- Mr. AT (25 Sep, the Kaufman charge): the gateway's own reason and the one next step; a clear
// decline keeps the card for a retry (same reference, same rep, 5 minutes, at most 3 declines).
describe("declines say why and what next, and keep the card for a retry", () => {
  beforeEach(() => _resetCardRefsForTests());

  it("a request the gateway refused (HTTP 400, no code, no transaction) is said as that, with its words", async () => {
    const { fetchImpl } = gatewayMock({ saleStatus: 400, sale: { error_code: "validation", message: "Amount exceeds the maximum allowed for this merchant" } });
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 1566700, brand: "nesher", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 402, p.text);
      assert.equal(p.body.refused_by_processor, true);
      assert.match(p.body.decline_reason_human, /never reached the bank/);
      assert.match(p.body.decline_reason_human, /Amount exceeds the maximum/);
      // Audit E16 (#127): the limit is named as Pinpoint's, and the next step is one the reader can take now.
      assert.match(p.body.decline_next, /send the customer a bank-transfer link; the account's card limit is raised only by Pinpoint/);
      assert.doesNotMatch(p.body.decline_next, /ask Joseph|tell Joseph/i);
      assert.match(p.body.decline_next_he, /קישור להעברה בנקאית/);
      assert.doesNotMatch(p.body.decline_next, /split/i, "never advise splitting a sale (Gabbai AT B3)");
      assert.match(s.logs.at(-1), /"said_len":\d+/);
      assert.doesNotMatch(s.logs.at(-1), /maximum allowed/, 'the sentence itself is never logged');
      assert.equal(p.body.hold_kept, true);
      assert.ok(Date.parse(p.body.token_ref_expires_at) > Date.now());
      assert.match(s.logs.at(-1), /"gw":"http_400"/);
      assert.match(s.logs.at(-1), /"kept":true/);
      assert.equal(everythingSaid(s, p).includes(PAN), false);
    } finally {
      await s.close();
    }
  });

  it("a wrong security code: the next step says type the right one, and the retry with the typed code charges the SAME card", async () => {
    let n = 0;
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push(JSON.parse(init.body));
      n++;
      const r = n === 1 ? { response: "2", response_code: "225", response_text: "CVV2 MISMATCH" } : { response: "1", id: "txn-ok", auth_code: "A1", cvv_response: "M" };
      return { ok: true, status: 200, text: async () => JSON.stringify(r) };
    };
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef();
      let t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      let p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest", cvv: "111" });
      assert.equal(p.status, 402);
      assert.equal(p.body.decline_reason_human, "The security code is wrong.");
      assert.match(p.body.decline_next, /right security code/);
      assert.match(p.body.decline_next, /held 5 more minutes/);
      assert.equal(p.body.hold_kept, true);
      t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest", cvv: "999" });
      assert.equal(p.status, 200, p.text);
      assert.equal(calls[1].payment_details.card_number, PAN);
      assert.equal(calls[1].payment_details.card_cvv, "999");
      // one use per SUCCESSFUL charge: gone now
      assert.equal(redeemCardHold(ref, { rep: "sruly" }).error, "unknown");
      const said = everythingSaid(s, p);
      assert.equal(said.includes("999"), false);
    } finally {
      await s.close();
    }
  });

  it("the kept card is bound to the rep, and dropped (zeroed) after the third decline", async () => {
    const trace = { buffers: [] };
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ response: "2", response_code: "201" }) });
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k", trace });
    try {
      const ref = newRef();
      const kept = [];
      for (let i = 0; i < MAX_HOLD_DECLINES; i++) {
        const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
        const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
        assert.equal(p.status, 402);
        kept.push(p.body.hold_kept);
        if (i === 0) assert.match(p.body.decline_next, /call the bank/);
      }
      assert.deepEqual(kept, [true, true, false]);
      assert.equal(redeemCardHold(ref, { rep: "sruly" }).error, "unknown");
      for (const b of trace.buffers) assert.equal(b.every((x) => x === 0), true, "zeroed once dropped");
      // another rep's ticket for a kept card is refused and burns it
      const ref2 = newRef();
      let t = mintTicket({ kind: "charge", repId: "sruly", bind: ref2, secret: SECRET });
      let p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref2, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.body.hold_kept, true);
      t = mintTicket({ kind: "charge", repId: "hershy", bind: ref2, secret: SECRET });
      p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref2, amount_cents: 2500, brand: "jrm", rep: "hershy", customer_name: "Guest" });
      assert.equal(p.status, 403);
    } finally {
      await s.close();
    }
  });

  it("Gabbai AT B2: a HARD decline keeps nothing - pick up, stolen, duplicate, not allowed; and never when the gateway said approved", async () => {
    for (const code of ["250", "251", "252", "253", "430", "204", "223", "410", "461"]) {
      const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ response: "2", response_code: code }) });
      const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
      try {
        const ref = newRef();
        const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
        const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
        assert.equal(p.status, 402, `${code}: ${p.text}`);
        assert.equal(p.body.hold_kept, false, `${code} must not keep the card`);
        assert.equal(redeemCardHold(ref, { rep: "sruly" }).error, "unknown", `${code}: zeroed and gone`);
        assert.doesNotMatch(p.body.decline_next, /Charge again|held 5 more minutes/, code);
      } finally {
        await s.close();
      }
    }
    // a 4xx that nonetheless says response "1" is never treated as a retryable no
    const odd = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ response: "1", message: "odd" }) });
    const s2 = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl: odd, privateKey: "k" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      const p = await post(s2.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.notEqual(p.body.hold_kept, true);
      assert.equal(redeemCardHold(ref, { rep: "sruly" }).error, "unknown");
    } finally {
      await s2.close();
    }
    // the allow-list itself
    for (const c of ["200", "201", "202", "203", "220", "224", "225", "240", "260", "300", "400", "420", "421", "440", "441"]) assert.ok(KEEP_CODES.test(c), c);
    for (const c of ["204", "221", "222", "223", "250", "253", "261", "264", "410", "411", "430", "460", "461", ""]) assert.equal(KEEP_CODES.test(c), false, c);
  });

  it("an unknown outcome (gateway 5xx) is never kept - it may have charged", async () => {
    const fetchImpl = async () => ({ ok: false, status: 502, text: async () => "bad gateway" });
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.status, 503);
      assert.equal(redeemCardHold(ref, { rep: "sruly" }).error, "unknown");
    } finally {
      await s.close();
    }
  });

  it("a kept card expires with the sweeper like any other hold", async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ response: "2", response_code: "202" }) });
    const s = await startDoor(handleChargeRequest, { secret: SECRET, fetchImpl, privateKey: "k" });
    try {
      const ref = newRef();
      const t = mintTicket({ kind: "charge", repId: "sruly", bind: ref, secret: SECRET });
      const p = await post(s.url, CHARGE_PATH, t.token, { token_ref: ref, amount_cents: 2500, brand: "jrm", rep: "sruly", customer_name: "Guest" });
      assert.equal(p.body.hold_kept, true);
      assert.match(p.body.decline_next, /smaller amount/);
      assert.equal(sweepCardHolds({ now: Date.now() + CARD_HOLD_TTL_MS + 1000 }), 1);
      assert.equal(redeemCardHold(ref, { rep: "sruly" }).error, "unknown");
    } finally {
      await s.close();
    }
  });
});
