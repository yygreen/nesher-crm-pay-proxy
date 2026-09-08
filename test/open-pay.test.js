import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  OPEN_PAY_MAX_USD,
  OPEN_PAY_MIN_USD,
  NESHER_LOGO_URL,
  isOpenPayPath,
  isOpenPayChargePath,
  openPayHostForbidden,
  parseOpenAmountUsd,
  mintOpenInvoiceNumber,
  chargeOpenPay,
  renderOpenPayHtml,
  renderOpenPayErrorHtml,
} from "../open-pay.js";
import { chargePayCode, NMI_HOST } from "../nmi-card.js";

describe("open-pay paths", () => {
  it("reserves /pay/open and does not steal 8-char CRM codes", () => {
    assert.equal(isOpenPayPath("/pay/open"), true);
    assert.equal(isOpenPayPath("/pay/open/"), true);
    assert.equal(isOpenPayPath("/pay/open/charge"), true);
    assert.equal(isOpenPayPath("/__nesher_pay/open/charge/"), true);
    assert.equal(isOpenPayChargePath("/pay/open/charge"), true);
    assert.equal(isOpenPayChargePath("/pay/open"), false);
    assert.equal(isOpenPayPath("/pay/7wm3td6g"), false);
    assert.equal(isOpenPayPath("/pay/openx"), false);
    assert.equal(isOpenPayPath("/pay/open-amount"), false);
    assert.equal(isOpenPayPath("/pay/abc12xyz/charge"), false);
  });

  it("forbids JRM hosts and allows Nesher", () => {
    assert.equal(openPayHostForbidden("www.jrmhotels.com"), true);
    assert.equal(openPayHostForbidden("jrmhotels.com"), true);
    assert.equal(openPayHostForbidden("www.flynesher.com"), false);
    assert.equal(openPayHostForbidden("crm.flynesher.com"), false);
    assert.equal(openPayHostForbidden("flynesher.com"), false);
  });
});

describe("parseOpenAmountUsd", () => {
  it("accepts 1 .. 25000 at 2 decimal places", () => {
    assert.deepEqual(parseOpenAmountUsd(1), { ok: true, amountUsd: 1 });
    assert.deepEqual(parseOpenAmountUsd("1.00"), { ok: true, amountUsd: 1 });
    assert.deepEqual(parseOpenAmountUsd("55.55"), { ok: true, amountUsd: 55.55 });
    assert.deepEqual(parseOpenAmountUsd("25000"), {
      ok: true,
      amountUsd: OPEN_PAY_MAX_USD,
    });
    assert.equal(OPEN_PAY_MIN_USD, 1);
  });

  it("rejects too small, too large, and non-2dp values", () => {
    assert.equal(parseOpenAmountUsd(0.99).error, "amount_too_small");
    assert.equal(parseOpenAmountUsd("0").error, "amount_too_small");
    assert.equal(parseOpenAmountUsd("25000.01").error, "amount_too_large");
    assert.equal(parseOpenAmountUsd("1.001").error, "amount_invalid");
    assert.equal(parseOpenAmountUsd("1e2").error, "amount_invalid");
    assert.equal(parseOpenAmountUsd("$5").error, "amount_invalid");
    assert.equal(parseOpenAmountUsd("").error, "amount_required");
    assert.equal(parseOpenAmountUsd(undefined).error, "amount_required");
    assert.equal(parseOpenAmountUsd("abc").error, "amount_invalid");
  });
});

describe("mintOpenInvoiceNumber", () => {
  it("stamps OPEN-YYYYMMDD-hex, not a CRM hotel id", () => {
    const n = mintOpenInvoiceNumber(new Date("2026-09-08T12:00:00Z"));
    assert.match(n, /^OPEN-20260908-[a-f0-9]{6}$/);
    assert.doesNotMatch(n, /^RES-|^JRM-|^FLY-/);
  });
});

describe("renderOpenPayHtml", () => {
  const html = renderOpenPayHtml({ collectPublicKey: "pk_test_collect" });

  it("is a Nesher amount + Collect.js card page with logo and no sermon", () => {
    assert.match(html, /<title>Pay Nesher<\/title>/);
    assert.match(html, /id="amount-usd"/);
    assert.match(html, /inputmode="decimal"/);
    assert.match(html, /min="1"/);
    assert.match(html, /max="25000"/);
    assert.match(html, /step="0.01"/);
    assert.match(html, /token\/Collect\.js/);
    assert.match(html, /data-tokenization-key="pk_test_collect"/);
    assert.match(html, /class="card-row"/);
    assert.match(html, /customCss:/);
    assert.match(html, /"font-size":"16px"/);
    assert.match(html, /placeholder:"ACCT-000003"/);
    assert.equal(html.includes(NESHER_LOGO_URL), true);
    assert.match(html, /src="https:\/\/assets\.flynesher\.com\/nesher-logo\.jpg"/);
    assert.match(html, /alt="Nesher Travel"/);
    assert.match(html, /height="40"/);
    assert.match(html, /Pay with card/);
    assert.match(html, /JSON\.stringify\(\{payment_token:token,amountUsd:amt\}\)/);
    assert.match(html, /fetch\("\/pay\/open\/charge"/);
    assert.doesNotMatch(html, /Card processed by/);
    assert.doesNotMatch(html, /Air Today Travel/);
    assert.doesNotMatch(html, /Your card statement shows/);
    assert.doesNotMatch(html, /Pay with bank/);
    assert.doesNotMatch(html, /mercury\.com/);
    assert.doesNotMatch(html, /JRM/);
    assert.doesNotMatch(html, /NMI_JRM_DESCRIPTOR/);
    assert.doesNotMatch(html, /NESHER-PAY|JRM-PAY/);
    assert.doesNotMatch(html, /customPayment/);
    assert.doesNotMatch(html, /placeholder:"Card number"/);
  });

  it("amount is a number input; PAN never is", () => {
    assert.match(html, /<input id="amount-usd"/);
    assert.doesNotMatch(html, /<input[^>]*(ccnumber|ccexp|cvv|pan)/i);
    assert.doesNotMatch(html, /name=["']ccnumber["']/i);
    assert.doesNotMatch(html, /creditCardEnabled/);
    assert.doesNotMatch(html, /googlePay|applePay|vault/i);
  });

  it("hides Collect.js without a public key", () => {
    const bare = renderOpenPayHtml({ collectPublicKey: "" });
    assert.doesNotMatch(bare, /Collect\.js/);
    assert.match(bare, /id="amount-usd"/);
    assert.match(bare, /Card pay is not available/);
  });

  it("error page has no sermon", () => {
    const err = renderOpenPayErrorHtml("nope");
    assert.match(err, /nope/);
    assert.doesNotMatch(err, /Card processed by/);
  });
});

describe("chargeOpenPay", () => {
  let prevKey;
  let prevJrm;
  beforeEach(() => {
    prevKey = process.env.NMI_PRIVATE_KEY;
    prevJrm = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
    process.env.NMI_PRIVATE_KEY = "test-private-key";
  });
  afterEach(() => {
    if (prevKey !== undefined) process.env.NMI_PRIVATE_KEY = prevKey;
    else delete process.env.NMI_PRIVATE_KEY;
    if (prevJrm !== undefined) process.env.NMI_JRM_DESCRIPTOR = prevJrm;
    else delete process.env.NMI_JRM_DESCRIPTOR;
  });

  function saleFetch() {
    let lastBody;
    let calls = 0;
    const fetchImpl = async (url, init) => {
      calls += 1;
      lastBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ response: "1", id: "txn_open" });
        },
      };
    };
    return {
      fetchImpl,
      calls: () => calls,
      lastBody: () => lastBody,
    };
  }

  it("happy path: guest amount, OPEN- ref, FLYNESHER.COM, no SKU", async () => {
    const sale = saleFetch();
    const out = await chargeOpenPay({
      amountUsd: 55.55,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-test01",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(out.ok, true);
    assert.equal(out.transactionId, "txn_open");
    assert.equal(out.amountUsd, 55.55);
    assert.equal(sale.calls(), 1);
    assert.equal(sale.lastBody().amount, "55.55");
    assert.equal(sale.lastBody().payment_details.payment_token, "tok_collect");
    assert.equal(sale.lastBody().order_details.id, "OPEN-20260908-test01");
    assert.equal(sale.lastBody().merchant_defined_fields.field_1, "nesher");
    assert.deepEqual(sale.lastBody().payment_descriptor, {
      descriptor: "FLYNESHER.COM",
      url: "https://www.flynesher.com",
    });
    assert.doesNotMatch(JSON.stringify(sale.lastBody()), /NESHER-PAY|JRM-PAY/);
    assert.equal(sale.lastBody().billing_address.email, undefined);
    assert.match(NMI_HOST, /pinpointpayments/);
  });

  it("rejects amount too small without hitting NMI", async () => {
    let called = 0;
    const out = await chargeOpenPay({
      amountUsd: 0.5,
      paymentToken: "tok_collect",
      fetchImpl: async () => {
        called += 1;
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "amount_too_small");
    assert.equal(out.httpStatus, 400);
    assert.equal(called, 0);
  });

  it("rejects amount too large without hitting NMI", async () => {
    let called = 0;
    const out = await chargeOpenPay({
      amountUsd: 25000.01,
      paymentToken: "tok_collect",
      fetchImpl: async () => {
        called += 1;
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "amount_too_large");
    assert.equal(called, 0);
  });

  it("rejects a PAN posted as the token", async () => {
    let called = 0;
    const out = await chargeOpenPay({
      amountUsd: 10,
      paymentToken: "4111111111111111",
      fetchImpl: async () => {
        called += 1;
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "raw_card_rejected");
    assert.equal(out.httpStatus, 400);
    assert.equal(called, 0);
  });

  it("rejects JRM brand and never charges", async () => {
    let called = 0;
    const out = await chargeOpenPay({
      amountUsd: 10,
      paymentToken: "tok_collect",
      brandId: "jrm",
      fetchImpl: async () => {
        called += 1;
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "jrm_not_supported");
    assert.equal(out.httpStatus, 403);
    assert.equal(called, 0);
  });

  it("requires a payment token", async () => {
    const out = await chargeOpenPay({
      amountUsd: 10,
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "payment_token required");
  });
});

describe("CRM amount lock is unchanged", () => {
  it("chargePayCode still charges the stored amount, not a client amount", async () => {
    let lastBody;
    const out = await chargePayCode({
      code: "7wm3td6g",
      paymentToken: "tok_collect",
      amountUsd: 1,
      loadInvoice: async () => ({
        ok: true,
        data: {
          amountUsd: 55.55,
          invoiceNumber: "RES-555TRAIN",
          customerName: "Ada",
          kind: "reservation",
        },
      }),
      claimInvoicePaid: async () => ({ ok: true, paidAt: "t" }),
      markInvoicePaid: async () => ({ ok: true }),
      fetchImpl: async (_url, init) => {
        lastBody = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({ response: "1", id: "txn_locked" });
          },
        };
      },
      privateKey: "test-private-key",
    });
    assert.equal(out.ok, true);
    assert.equal(lastBody.amount, "55.55");
    assert.notEqual(Number(lastBody.amount), 1);
    assert.equal(lastBody.order_details.id, "RES-555TRAIN");
  });

  it("CRM HTTP charge slice still ignores body.amount; open-pay is a separate block", () => {
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    const openAt = src.indexOf("isOpenPayPath");
    const captureAt = src.indexOf("Public guest card capture");
    const invoiceAt = src.indexOf("Public guest invoice");
    assert.ok(openAt > 0 && openAt < captureAt);
    const charge = src.slice(captureAt, invoiceAt);
    assert.match(charge, /chargePayCode\(\{/);
    assert.doesNotMatch(charge, /body\.amount/);
    assert.doesNotMatch(charge, /amountUsd:/);
    const open = src.slice(openAt, captureAt);
    assert.match(open, /chargeOpenPay\(\{/);
    assert.match(open, /amountUsd:/);
    assert.doesNotMatch(src, /NMI_JRM_DESCRIPTOR/);
  });
});

describe("wiring", () => {
  it("Dockerfile COPY includes open-pay.js and health tag is bumped", () => {
    const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(docker, /\bopen-pay\.js\b/);
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /from "\.\/open-pay\.js"/);
    assert.match(src, /build: "2026-09-08-open-pay"/);
    assert.match(src, /isOpenPayPath\(url\.pathname\)/);
    assert.match(src, /\/pay\/open/);
  });
});
