// Mr. AU (25 Sep 2026): the card door's half of the audit's charge defects.
//   C2 - the chat sale has its own gateway limit, well inside the desk's wait, and a timeout is an UNKNOWN;
//   C2 - one tile, at most one sale: a repeat for the same tile never reaches the gateway while the first
//        is on the wire, after an unknown, or after an approval - not even with a fresh card read;
//        a CLEAR decline releases it, so "Charge again" still works;
//   H3 - the booking goes to the processor as the order id in the collection loop's own shapes.
// Written first and run against the live sha (0e14f81, build 2026-09-25-paddle-reader): every case below
// failed there.
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { CHARGE_PATH, handleChargeRequest, _resetArmingsForTests } from "../card-charge.js";
import { mintTicket, registerCardHold, _resetCardRefsForTests } from "../ocr-card.js";
import { parseInvoiceNumber } from "../payments-sync.js";

const SECRET = "test-ocr-secret-0123456789abcdef";
const PAN = "4539578763621486"; // synthetic, Luhn-valid, Visa range

async function startDoor(deps) {
  const logs = [];
  const server = http.createServer((req, res) => handleChargeRequest(req, res, { log: (l) => logs.push(l), secret: SECRET, privateKey: "k", ...deps }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { logs, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
function newRef(rep = "joseph") {
  const h = registerCardHold({ pan: PAN, expiry: "10/29", brand: "visa", rep });
  assert.equal(h.ok, true);
  return h.ref;
}
async function charge(door, body, rep = "joseph") {
  const t = mintTicket({ kind: "charge", repId: rep, bind: body.token_ref, secret: SECRET });
  const r = await fetch(door.url + CHARGE_PATH, { method: "POST", headers: { "content-type": "application/json", "x-ocr-ticket": t.token }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
function gateway(script) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(init.body ? JSON.parse(init.body) : null);
    return script(calls.length, init);
  };
  return { calls, fetchImpl };
}
const approve = (id) => ({ ok: true, status: 200, text: async () => JSON.stringify({ response: "1", id, auth_code: "A1" }) });
const decline = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ response: "2", response_code: "202" }) });

describe("Mr. AU - the chat sale's own time limit (audit C2)", () => {
  beforeEach(() => { _resetCardRefsForTests(); _resetArmingsForTests(); });

  it("a gateway slower than the limit is answered 503 outcome_unknown inside the limit, never an approval or a decline", async () => {
    const gw = gateway((n, init) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(approve("txn-late")), 600);
      if (init.signal) init.signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
    }));
    const door = await startDoor({ fetchImpl: gw.fetchImpl, saleTimeoutMs: 60 });
    try {
      const t0 = Date.now();
      const p = await charge(door, { token_ref: newRef(), amount_cents: 1566700, currency: "USD", brand: "nesher", rep: "joseph", customer_name: "Shloma Kaufman", arming: "mcaaaa1111" });
      const ms = Date.now() - t0;
      assert.equal(p.status, 503, JSON.stringify(p.body));
      assert.equal(p.body.error, "outcome_unknown");
      assert.ok(ms < 450, `answered inside the limit, not after the gateway (${ms} ms)`);
    } finally { await door.close(); }
  });
});

describe("Mr. AU - one tile, at most one sale (audit C2)", () => {
  beforeEach(() => { _resetCardRefsForTests(); _resetArmingsForTests(); });

  it("after an UNKNOWN, a second charge for the same tile - even with a fresh card read - never reaches the gateway", async () => {
    const gw = gateway(() => { throw new Error("socket hang up"); });
    const door = await startDoor({ fetchImpl: gw.fetchImpl });
    try {
      const a = await charge(door, { token_ref: newRef(), amount_cents: 50000, currency: "USD", brand: "jrm", rep: "joseph", customer_name: "Cohen", arming: "mcbbbb2222" });
      assert.equal(a.status, 503);
      assert.equal(a.body.error, "outcome_unknown");
      const b = await charge(door, { token_ref: newRef(), amount_cents: 50000, currency: "USD", brand: "jrm", rep: "joseph", customer_name: "Cohen", arming: "mcbbbb2222" });
      assert.equal(b.status, 503, JSON.stringify(b.body));
      assert.equal(b.body.error, "outcome_unknown");
      assert.equal(b.body.repeated, true);
      assert.equal(gw.calls.length, 1, "the gateway heard ONE sale for this tile");
    } finally { await door.close(); }
  });

  it("after an APPROVAL, a repeat for the same tile gets the same approval back, not a second sale", async () => {
    const gw = gateway((n) => approve("txn-" + n));
    const door = await startDoor({ fetchImpl: gw.fetchImpl });
    try {
      const a = await charge(door, { token_ref: newRef(), amount_cents: 30000, currency: "USD", brand: "nesher", rep: "joseph", customer_name: "Levi", arming: "mccccc3333" });
      assert.equal(a.status, 200);
      const b = await charge(door, { token_ref: newRef(), amount_cents: 30000, currency: "USD", brand: "nesher", rep: "joseph", customer_name: "Levi", arming: "mccccc3333" });
      assert.equal(b.status, 200);
      assert.equal(b.body.repeated, true);
      assert.equal(b.body.txn_id, a.body.txn_id);
      assert.equal(gw.calls.length, 1);
    } finally { await door.close(); }
  });

  it("a CLEAR decline releases the tile: Charge again goes to the gateway", async () => {
    const gw = gateway((n) => (n === 1 ? decline() : approve("txn-2")));
    const door = await startDoor({ fetchImpl: gw.fetchImpl });
    try {
      const ref = newRef();
      const a = await charge(door, { token_ref: ref, amount_cents: 30000, currency: "USD", brand: "nesher", rep: "joseph", customer_name: "Levi", arming: "mcdddd4444" });
      assert.equal(a.status, 402);
      assert.equal(a.body.hold_kept, true);
      const b = await charge(door, { token_ref: ref, amount_cents: 20000, currency: "USD", brand: "nesher", rep: "joseph", customer_name: "Levi", arming: "mcdddd4444" });
      assert.equal(b.status, 200, JSON.stringify(b.body));
      assert.equal(gw.calls.length, 2);
    } finally { await door.close(); }
  });
});

describe("Mr. AU - the booking reaches the processor (audit H3)", () => {
  beforeEach(() => { _resetCardRefsForTests(); _resetArmingsForTests(); });

  for (const [brand, ref, want] of [
    ["nesher", "RES-8SU7MW", "RES-8SU7MW"],
    ["jrm", "JRM-11325", "JRM-11325"],
    ["jrm", "JRM-189-O50", "JRM-189-O50"],
    ["nesher", "JRM-11325", null],
    ["jrm", "RES-8SU7MW", null],
    ["nesher", "8SU7MW; DROP", null],
  ]) {
    it(`${brand} + invoice_ref ${JSON.stringify(ref)} -> order id ${want || "the random CARD ref"}`, async () => {
      const gw = gateway(() => approve("txn-9"));
      const door = await startDoor({ fetchImpl: gw.fetchImpl });
      try {
        const p = await charge(door, { token_ref: newRef(), amount_cents: 10000, currency: "USD", brand, rep: "joseph", customer_name: "Kaufman", invoice_ref: ref });
        assert.equal(p.status, 200);
        const id = gw.calls[0].order_details.id;
        if (want) {
          assert.equal(id, want);
          assert.ok(parseInvoiceNumber(id), "the collection loop can read it back");
        } else {
          assert.match(id, brand === "jrm" ? /^JRM-CARD-\d{8}-[A-Z0-9]+$/ : /^RES-CARD-\d{8}-[A-Z0-9]+$/);
        }
      } finally { await door.close(); }
    });
  }
});
