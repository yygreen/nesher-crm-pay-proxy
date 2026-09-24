// Plan 17.3: the three completion paths (guest charge, webhook, office) and the
// processor recovery sweep, each wired to the SHADOW observer or the LIVE doors.
// No network: the gateway is a fake fetch; nothing here can reach NMI.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { chargeWithToken, chargePayCode, cardLastFour } from "../nmi-card.js";
import { applyNmiSaleSuccess, parseNmiWebhook } from "../nmi-webhook.js";
import { chargeOfficePay } from "../open-pay.js";
import { parseNmiQueryXml, recoveryDecision, runNmiRecovery, queryNmiRange } from "../nmi-recovery.js";

const INVOICE = { amountUsd: 55.55, invoiceNumber: "RES-555TRAIN", customerName: "Ada", kind: "reservation", recordId: 337 };
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, async text() { return typeof body === "string" ? body : JSON.stringify(body); } });

describe("gateway outcome classes (the red nmi-card test's cause)", () => {
  const base = { amountUsd: 10, invoiceNumber: "RES-X", kind: "reservation", paymentToken: "tok", privateKey: "k" };
  it("a 4xx is a refused request: definitive, the claim may be released", async () => {
    for (const s of [400, 401, 402, 403, 404, 409, 422, 429]) {
      const r = await chargeWithToken({ ...base, fetchImpl: reply(s, { message: "no" }) });
      assert.equal(r.ok, false);
      assert.notEqual(r.error, "outcome_unknown", `HTTP ${s}`);
      assert.equal(r.outcomeUnknown, undefined);
    }
  });
  it("a throw, 408, 5xx, unreadable body or unknown response code = outcome unknown", async () => {
    const cases = [
      async () => { throw new Error("socket hang up"); },
      reply(408, { message: "timeout" }),
      reply(500, { response: "1" }),
      reply(502, "<html>bad gateway</html>"),
      reply(200, "not json"),
      reply(200, { hello: "world" }),
    ];
    for (const f of cases) {
      const r = await chargeWithToken({ ...base, fetchImpl: f });
      assert.equal(r.error, "outcome_unknown");
      assert.equal(r.outcomeUnknown, true);
    }
  });
  it("approved answers carry the last four when the gateway gives a masked card", async () => {
    const r = await chargeWithToken({ ...base, fetchImpl: reply(200, { response: "1", id: "t1", card: { cc_number: "4xxxxxxxxxxx4242" } }) });
    assert.equal(r.ok, true);
    assert.equal(r.cardLast4, "4242");
  });
  it("cardLastFour reads masks and last-four fields, never a full number", () => {
    assert.equal(cardLastFour({ card: { cc_number: "4xxxxxxxxxxx1111" } }), "1111");
    assert.equal(cardLastFour({ cc_number: "411111******1111" }), "1111");
    assert.equal(cardLastFour({ payment_details: { card: { last_four: "0007" } } }), "0007");
    assert.equal(cardLastFour({ cc_number: "4111111111111111" }), null);
    assert.equal(cardLastFour({}), null);
  });
});

describe("guest charge path", () => {
  it("shadow: observes the approved sale BEFORE the legacy note, legacy unchanged", async () => {
    const order = [];
    const out = await chargePayCode({
      code: "abc12xyz", paymentToken: "tok", privateKey: "k",
      loadInvoice: async () => ({ ok: true, data: { ...INVOICE, staffName: "Hershy" } }),
      claimInvoicePaid: async () => ({ ok: true, paidAt: "2026-09-23T10:00:00.000Z" }),
      markInvoicePaid: async () => { order.push("mark"); return { ok: true }; },
      claimNmiNote: async () => ({ ok: true }),
      appendReservationNote: async () => { order.push("note"); },
      shadowPayment: async (ev) => { order.push(`shadow:${ev.path}:${ev.decision.action}:${ev.rep}`); return { ok: true }; },
      fetchImpl: reply(200, { response: "1", id: "txn_g" }),
    });
    assert.equal(out.ok, true);
    assert.deepEqual(order, ["shadow:guest:post:Hershy", "mark", "note"]);
  });
  it("a broken observer never breaks the sale", async () => {
    const out = await chargePayCode({
      code: "abc12xyz", paymentToken: "tok", privateKey: "k",
      loadInvoice: async () => ({ ok: true, data: INVOICE }),
      claimInvoicePaid: async () => ({ ok: true, paidAt: "2026-09-23T10:00:00.000Z" }),
      shadowPayment: async () => { throw new Error("db down"); },
      fetchImpl: reply(200, { response: "1", id: "txn_g2" }),
    });
    assert.equal(out.ok, true);
    assert.equal(out.transactionId, "txn_g2");
  });
});

describe("webhook path", () => {
  const sale = (over = {}) => parseNmiWebhook({
    event_type: "transaction.sale.success",
    event_body: {
      transaction_id: "txn_w", order_id: "RES-555TRAIN",
      action: { amount: "55.55", action_type: "sale", success: "1" },
      card: { cc_number: "4xxxxxxxxxxx1111" },
      merchant_defined_fields: { field_1: "nesher", field_5: "Sruly" },
      ...over,
    },
  });
  it("parses brand, rep and last four from the signed event", () => {
    const p = sale();
    assert.equal(p.brand, "nesher");
    assert.equal(p.rep, "Sruly");
    assert.equal(p.cardLast4, "1111");
  });
  it("shadow + amount mismatch: observed as an exception, legacy answer unchanged, no CRM callback", async () => {
    const seen = [];
    const out = await applyNmiSaleSuccess({ ...sale(), amountUsd: 999 }, {
      findInvoicesByOrderId: async () => [{ id: "abc12xyz", payload: INVOICE }],
      shadowPayment: async (ev) => { seen.push(ev.decision); return { ok: true }; },
    });
    assert.deepEqual(out, { ok: true, ignored: "amount_mismatch" });
    assert.deepEqual(seen, [{ action: "exception", reason: "invoice_amount_mismatch" }]);
  });
  it("live + second transaction on a paid request: exception door, durable, 200", async () => {
    let posts = 0;
    const kept = [];
    const out = await applyNmiSaleSuccess({ ...sale(), transactionId: "txn_other" }, {
      findInvoicesByOrderId: async () => [{ id: "abc12xyz", payload: { ...INVOICE, paidAt: "x", transactionId: "txn_w" } }],
      recordNmiPaidInvoice: async () => { posts++; return { ok: true }; },
      recordPaymentException: async (ev) => { kept.push(ev.reason); return { durable: true }; },
    });
    assert.equal(out.ok, true);
    assert.equal(out.needsReview, true);
    assert.equal(out.already, true);
    assert.equal(posts, 0);
    assert.deepEqual(kept, ["invoice_transaction_conflict"]);
  });
  it("live + an exception that cannot be persisted = 503 so NMI redelivers", async () => {
    const out = await applyNmiSaleSuccess({ ...sale(), orderId: "OPEN-1" }, {
      findInvoicesByOrderId: async () => [],
      recordPaymentException: async () => ({ durable: false }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.httpStatus, 503);
  });
  it("live + office CRM-ref sale whose office answer was lost: the webhook posts it", async () => {
    const calls = [];
    const out = await applyNmiSaleSuccess({ ...sale(), orderId: "JRM-1325" }, {
      findInvoicesByOrderId: async () => [],
      recordNmiPaidInvoice: async (a) => { calls.push(a); return { ok: true }; },
    });
    assert.equal(out.crmRecorded, true);
    assert.equal(calls[0].invoiceNumber, "JRM-1325");
    assert.equal(calls[0].cardLast4, "1111");
    assert.equal(calls[0].rep, "Sruly");
  });
  it("shadow + office CRM-ref sale: observed as post, legacy still ignores it", async () => {
    const seen = [];
    const out = await applyNmiSaleSuccess({ ...sale(), orderId: "RES-79RHW4" }, {
      findInvoicesByOrderId: async () => [],
      shadowPayment: async (ev) => { seen.push(`${ev.invoiceNumber}:${ev.decision.action}`); return { ok: true }; },
    });
    assert.deepEqual(out, { ok: true, ignored: "not_found" });
    assert.deepEqual(seen, ["RES-79RHW4:post"]);
  });
});

describe("office path", () => {
  it("shadow: CRM-ref charge is observed, then written by the legacy writer (with rep + last four)", async () => {
    const order = [];
    const out = await chargeOfficePay({
      crmRef: "RES-ABC123", amountUsd: 40, paymentToken: "tok", staffName: "Hershy", privateKey: "k",
      loadReservationPayContextByCode: async () => ({ ok: true, data: { reservation: { id: 7, reservation_code: "ABC123" } } }),
      loadReservationPayContext: async () => ({ ok: true }),
      shadowPayment: async (ev) => { order.push(`shadow:${ev.path}:${ev.rep}:${ev.cardLast4}`); return { ok: true }; },
      recordOfficeCrmPayment: async (a) => { order.push(`legacy:${a.rep}:${a.cardLast4}`); return { ok: true }; },
      fetchImpl: reply(200, { response: "1", id: "txn_o", card: { cc_number: "4xxxxxxxxxxx9999" } }),
    });
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.deepEqual(order, ["shadow:office:Hershy:9999", "legacy:Hershy:9999"]);
    assert.equal(out.crmRecorded, true);
  });
});

const XML = `<?xml version="1.0"?><nm_response>
<transaction><transaction_id>12569487556</transaction_id><condition>complete</condition><order_id>JRM-1325</order_id>
<first_name>Secret</first_name><email>guest@example.com</email><cc_number>4xxxxxxxxxxx5692</cc_number><processor_id>mav7067</processor_id>
<merchant_defined_field id="1">jrm</merchant_defined_field><merchant_defined_field id="5">Sruly</merchant_defined_field>
<action><amount>3408.17</amount><action_type>sale</action_type><date>20260917184700</date><success>1</success></action>
<action><amount>3408.17</amount><action_type>settle</action_type><date>20260918022100</date><success>1</success></action></transaction>
<transaction><transaction_id>12589139842</transaction_id><condition>complete</condition><order_id>OPEN-20260922-71fde3</order_id>
<cc_number>4xxxxxxxxxxx1995</cc_number><processor_id>mav7067</processor_id><merchant_defined_field id="1">nesher</merchant_defined_field>
<action><amount>3140.00</amount><action_type>sale</action_type><date>20260922210000</date><success>1</success></action></transaction>
<transaction><transaction_id>12562434983</transaction_id><condition>complete</condition><order_id></order_id>
<cc_number>4xxxxxxxxxxx7127</cc_number><processor_id>mav2083</processor_id>
<action><amount>1.01</amount><action_type>sale</action_type><date>20260915234300</date><success>1</success></action></transaction>
<transaction><transaction_id>12532467411</transaction_id><condition>failed</condition><order_id>OPEN-20260908-c09c18</order_id>
<processor_id>mav7067</processor_id><action><amount>4100.00</amount><action_type>sale</action_type><date>20260908223300</date><success>0</success></action></transaction>
<transaction><transaction_id>12532195003</transaction_id><condition>canceled</condition><order_id></order_id><processor_id>mav7067</processor_id>
<action><amount>0.01</amount><action_type>sale</action_type><date>20260908211400</date><success>1</success></action>
<action><amount>0.01</amount><action_type>void</action_type><date>20260908212700</date><success>1</success></action></transaction>
<transaction><transaction_id>12588835274</transaction_id><condition>complete</condition><order_id></order_id><processor_id>mav2083</processor_id>
<action><amount>-1.01</amount><action_type>refund</action_type><date>20260922193500</date><success>1</success></action></transaction>
</nm_response>`;

describe("NMI recovery sweep (read-only processor state)", () => {
  it("parses only what it needs; names, emails and card masks are dropped", () => {
    const ev = parseNmiQueryXml(XML);
    assert.equal(ev.length, 6);
    const text = JSON.stringify(ev);
    for (const bad of ["Secret", "guest@example.com", "4xxxxxxxxxxx"]) assert.ok(!text.includes(bad), bad);
    const jrm = ev[0];
    assert.equal(jrm.orderId, "JRM-1325");
    assert.equal(jrm.brand, "nesher", "brand from the processor that actually took it");
    assert.equal(jrm.brandHint, "jrm");
    assert.equal(jrm.cardLast4, "5692");
    assert.equal(jrm.rep, "Sruly");
    assert.equal(jrm.paidAt, "2026-09-17T18:47:00.000Z");
    assert.equal(ev[2].brand, "jrm");
    assert.equal(ev[5].kind, "refund");
    assert.equal(ev[5].amountUsd, 1.01);
    assert.equal(ev[4].voided, true);
  });
  it("decides post / no-ref / voided / reversal", () => {
    const ev = parseNmiQueryXml(XML);
    assert.deepEqual(recoveryDecision(ev[0]), { action: "post" });
    assert.deepEqual(recoveryDecision(ev[1]), { action: "exception", reason: "no_crm_reference" });
    assert.deepEqual(recoveryDecision(ev[4]), { action: "exception", reason: "sale_voided" });
    assert.deepEqual(recoveryDecision(ev[5]), { action: "exception", reason: "reversal_requires_review" });
    assert.deepEqual(recoveryDecision({ orderId: "RES-X", brandHint: "jrm" }), { action: "exception", reason: "brand_mismatch" });
  });
  it("shadow sweep: failed sales are not money; the key rides in the body only and never in the result", async () => {
    const seen = [];
    let sentBody = "";
    let sentUrl = "";
    const out = await runNmiRecovery({
      host: "https://fake-gateway.invalid", securityKey: "SECRET_KEY_VALUE_123", days: 45,
      now: new Date("2026-09-23T12:00:00Z"),
      fetchImpl: async (url, init) => { sentUrl = url; sentBody = init.body; return { ok: true, status: 200, async text() { return XML; } }; },
      observe: async (ev) => { seen.push(`${ev.transactionId}:${ev.brand}:${ev.decision.action}:${ev.decision.reason || ""}`); return { ok: true }; },
    });
    assert.equal(sentUrl, "https://fake-gateway.invalid/api/query.php");
    assert.match(sentBody, /security_key=SECRET_KEY_VALUE_123/);
    assert.match(sentBody, /start_date=20260809120000/);
    assert.ok(!JSON.stringify(out).includes("SECRET_KEY_VALUE_123"));
    assert.equal(out.notMoney, 1);
    assert.equal(out.confirmed, 5);
    assert.deepEqual(seen, [
      "12569487556:nesher:post:",
      "12589139842:nesher:exception:no_crm_reference",
      "12562434983:jrm:exception:no_crm_reference",
      "12532195003:nesher:exception:sale_voided",
      "12588835274:jrm:exception:reversal_requires_review",
    ]);
  });
  it("live sweep: posts through the poster, keeps exceptions, counts both", async () => {
    const out = await runNmiRecovery({
      host: "https://fake-gateway.invalid", securityKey: "k", mode: "live",
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return XML; } }),
      post: async () => ({ ok: true }),
      except: async () => ({ durable: true }),
    });
    assert.equal(out.posted, 1);
    assert.equal(out.exceptions, 4);
  });
  it("a refused query is an error, never an empty book", async () => {
    await assert.rejects(queryNmiRange({ host: "https://x.invalid", securityKey: "k", since: new Date(0), until: new Date(),
      fetchImpl: async () => ({ ok: true, status: 200, async text() { return "<error_response>bad key</error_response>"; } }) }), /nmi_query_refused/);
    await assert.rejects(queryNmiRange({ host: "", securityKey: "k", since: new Date(0), until: new Date() }), /nmi_query_not_configured/);
  });
});

describe("server wiring (boot without credentials)", () => {
  it("health says shadow; the report route is key-gated and GET only", { timeout: 20000 }, async () => {
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /\.\.\.moneyDoors\("guest"\)/);
    assert.match(src, /\.\.\.moneyDoors\("webhook"\)/);
    assert.match(src, /\.\.\.moneyDoors\("office"\)/);
    assert.match(src, /\.\.\.moneyDoors\("open"\)/);
    const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    for (const f of ["payment-posts.js", "nmi-recovery.js"]) assert.ok(docker.includes(f), f);
    for (const mode of [undefined, "live"]) {
      const socket = net.createServer();
      socket.listen(0, "127.0.0.1");
      await once(socket, "listening");
      const port = socket.address().port;
      await new Promise((r) => socket.close(r));
      const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP"].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
      Object.assign(env, { PORT: String(port), CRM_UPSTREAM: "http://127.0.0.1:9", NODE_ENV: "test", MONEY_POSTING_REPORT_KEY: "r".repeat(40) });
      if (mode) env.MONEY_POSTING_MODE = mode;
      const child = spawn(process.execPath, ["server.js"], { cwd: new URL("../", import.meta.url), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let log = "";
      child.stdout.on("data", (c) => { log += c; });
      child.stderr.on("data", (c) => { log += c; });
      const get = (p, o = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...o, signal: AbortSignal.timeout(1500) });
      try {
        let h;
        for (let i = 0; i < 100 && !h; i++) { try { h = await get("/__nesher_pay/health"); } catch { await delay(50); } }
        assert.ok(h?.ok, log);
        const j = await h.json();
        assert.equal(j.build, "2026-09-25-card-reader");
        assert.equal(j.postingMode, mode === "live" ? "live" : "shadow");
        assert.deepEqual(j.payLinks, { confirming: null, at: null }, "no DB: the confirming count is unknown, never a fake 0");
        if (mode) assert.equal(j.postingShadow, null);
        else assert.deepEqual(j.postingShadow, { observed: 0, planned: 0, errors: 0, lastAt: null, lastError: null });
        assert.equal((await get("/__nesher_pay/posting-shadow")).status, 401);
        assert.equal((await get("/__nesher_pay/posting-shadow", { headers: { "x-report-key": "x".repeat(40) } })).status, 401);
        assert.equal((await get("/__nesher_pay/posting-shadow", { method: "POST" })).status, 405);
        // the right key with no database is an honest 503, never a fake empty report
        assert.equal((await get("/__nesher_pay/posting-shadow", { headers: { "x-report-key": "r".repeat(40) } })).status, 503);
      } finally {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    }
  });
});
