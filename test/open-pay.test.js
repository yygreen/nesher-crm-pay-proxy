import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  OPEN_PAY_MAX_USD,
  OPEN_PAY_MIN_USD,
  OPEN_PAY_STAFF,
  NESHER_LOGO_URL,
  isOpenPayPath,
  isOpenPayChargePath,
  isOfficePayPath,
  isOfficePayChargePath,
  openPayHostAllowed,
  openPayRequestAllowed,
  decideOpenPayPage,
  decideOfficePayPage,
  parseOpenAmountUsd,
  mintOpenInvoiceNumber,
  rosterStaffName,
  chargeOpenPay,
  chargeOfficePay,
  renderOpenPayHtml,
  renderOfficePayHtml,
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
    assert.equal(isOpenPayPath("/pay/office"), false);
    assert.equal(isOpenPayPath("/pay/office/charge"), false);
    assert.equal(isOfficePayPath("/pay/office"), true);
    assert.equal(isOfficePayPath("/pay/office/"), true);
    assert.equal(isOfficePayPath("/pay/office/charge"), true);
    assert.equal(isOfficePayPath("/__nesher_pay/office"), true);
    assert.equal(isOfficePayPath("/__nesher_pay/office/charge/"), true);
    assert.equal(isOfficePayChargePath("/pay/office/charge"), true);
    assert.equal(isOfficePayChargePath("/pay/office"), false);
    assert.equal(isOfficePayChargePath("/pay/open/charge"), false);
    assert.equal(isOfficePayPath("/pay/open"), false);
    assert.equal(isOfficePayPath("/pay/officer"), false);
    assert.equal(isOfficePayPath("/pay/7wm3td6g"), false);
  });

  it("roster is the named desk people, exact strings only", () => {
    assert.deepEqual(OPEN_PAY_STAFF, [
      "Hershy",
      "Sruly",
      "Richter",
      "Goldie",
      "Joseph",
      "John",
      "Aby",
      "Anne",
      "Purity",
      "Lennart",
      "Kimberly",
    ]);
    assert.equal(rosterStaffName("Hershy"), "Hershy");
    assert.equal(rosterStaffName(" Goldie "), "Goldie");
    assert.equal(rosterStaffName("hershy"), "");
    assert.equal(rosterStaffName("Hershey"), "");
    assert.equal(rosterStaffName("goldy"), "");
    assert.equal(rosterStaffName("Processor"), "");
    assert.equal(rosterStaffName("Guest"), "");
    assert.equal(rosterStaffName(""), "");
  });

  it("allowlists only flynesher.com and www.flynesher.com", () => {
    assert.equal(openPayHostAllowed("www.flynesher.com"), true);
    assert.equal(openPayHostAllowed("flynesher.com"), true);
    assert.equal(openPayHostAllowed("www.flynesher.com:443"), true);
    assert.equal(openPayHostAllowed("crm.flynesher.com"), false);
    assert.equal(openPayHostAllowed("www.jrmhotels.com"), false);
    assert.equal(openPayHostAllowed("jrmhotels.com"), false);
    assert.equal(openPayHostAllowed(""), false);
    assert.equal(openPayHostAllowed(undefined), false);
    assert.equal(openPayHostAllowed("nesher-crm-pay-proxy.up.railway.app"), false);
  });

  it("refuses crm, JRM, empty Host, and forwarded JRM hosts", () => {
    assert.equal(openPayRequestAllowed({ host: "www.flynesher.com" }), true);
    assert.equal(openPayRequestAllowed({ host: "flynesher.com" }), true);
    assert.equal(openPayRequestAllowed({ host: "crm.flynesher.com" }), false);
    assert.equal(openPayRequestAllowed({ host: "www.jrmhotels.com" }), false);
    assert.equal(openPayRequestAllowed({ host: "jrmhotels.com" }), false);
    assert.equal(openPayRequestAllowed({}), false);
    assert.equal(openPayRequestAllowed({ host: "" }), false);
    assert.equal(
      openPayRequestAllowed({
        host: "crm.flynesher.com",
        "x-forwarded-host": "www.jrmhotels.com",
      }),
      false
    );
    assert.equal(
      openPayRequestAllowed({
        host: "www.flynesher.com",
        "x-forwarded-host": "www.jrmhotels.com",
      }),
      false
    );
    assert.equal(
      openPayRequestAllowed({
        host: "www.flynesher.com",
        forwarded: "host=jrmhotels.com;proto=https",
      }),
      false
    );
    assert.equal(
      openPayRequestAllowed({
        host: "www.flynesher.com",
        "x-forwarded-host": "www.flynesher.com",
      }),
      true
    );
  });

  it("jrmhotels.com, crm.flynesher.com, and empty Host never paint Collect.js", () => {
    const collect = { collectPublicKey: "pk_test_collect" };
    function assertClosed(headers) {
      const page = decideOpenPayPage(headers, collect);
      assert.equal(page.status, 404);
      assert.doesNotMatch(page.html, /Collect\.js/);
      assert.doesNotMatch(page.html, /id="amount-usd"/);
      assert.doesNotMatch(page.html, /Pay with card/);
      assert.doesNotMatch(page.html, /data-tokenization-key/);
    }
    assertClosed({ host: "www.jrmhotels.com" });
    assertClosed({ host: "jrmhotels.com" });
    assertClosed({ host: "crm.flynesher.com" });
    assertClosed({
      host: "crm.flynesher.com",
      "x-forwarded-host": "www.jrmhotels.com",
    });
    assertClosed({});
    assertClosed({ host: "" });
    function assertOfficeClosed(headers) {
      const page = decideOfficePayPage(headers, collect);
      assert.equal(page.status, 404);
      assert.doesNotMatch(page.html, /Collect\.js/);
      assert.doesNotMatch(page.html, /Taken by/);
      assert.doesNotMatch(page.html, /Hershy/);
    }
    assertOfficeClosed({ host: "www.jrmhotels.com" });
    assertOfficeClosed({ host: "jrmhotels.com" });
    assertOfficeClosed({ host: "crm.flynesher.com" });
    assertOfficeClosed({});
    assertOfficeClosed({ host: "" });
    const ok = decideOpenPayPage({ host: "www.flynesher.com" }, collect);
    assert.equal(ok.status, 200);
    assert.match(ok.html, /Collect\.js/);
    assert.match(ok.html, /id="amount-usd"/);
    assert.match(ok.html, /Pay with card/);
    assert.doesNotMatch(ok.html, /Taken by/);
    assert.doesNotMatch(ok.html, /Processor/);
    const officeOk = decideOfficePayPage({ host: "www.flynesher.com" }, collect);
    assert.equal(officeOk.status, 200);
    assert.match(officeOk.html, /Collect\.js/);
    assert.match(officeOk.html, /Taken by/);
    assert.match(officeOk.html, /Hershy/);
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
    assert.match(html, /id="customer-name"/);
    assert.match(html, /id="guest-name"/);
    assert.match(html, />Customer name</);
    assert.doesNotMatch(html, />Name</);
    assert.doesNotMatch(html, /id="staff-name"/);
    assert.doesNotMatch(html, /id="more-info"/);
    assert.doesNotMatch(html, /id="office-group"/);
    assert.doesNotMatch(html, /<h2 class="group-title">Office<\/h2>/);
    assert.doesNotMatch(html, />Processor</);
    assert.doesNotMatch(html, /Taken by/);
    assert.doesNotMatch(html, /Hershy/);
    assert.doesNotMatch(html, /Sruly/);
    assert.doesNotMatch(html, /Richter/);
    assert.doesNotMatch(html, /Goldie/);
    assert.doesNotMatch(html, /<select/);
    assert.doesNotMatch(html, />More info</);
    assert.match(html, /id="card-group"/);
    assert.match(html, /<h2 class="group-title">Card<\/h2>/);
    assert.match(html, /id="billing-address"/);
    assert.match(html, /id="billing-city"/);
    assert.match(html, /id="billing-state"/);
    assert.match(html, /id="billing-zip"/);
    assert.match(html, /id="billing-country"/);
    assert.match(html, /id="billing-email"/);
    assert.match(html, />Address</);
    assert.match(html, />City</);
    assert.match(html, />State</);
    assert.match(html, />ZIP</);
    assert.match(html, />Country</);
    assert.match(html, />Email</);
    assert.match(html, /Used to match the card\./);
    assert.doesNotMatch(html, /id="customer-name"[^>]*required/);
    assert.doesNotMatch(html, /id="billing-address"[^>]*required/);
    assert.doesNotMatch(html, /id="billing-city"[^>]*required/);
    assert.doesNotMatch(html, /id="billing-state"[^>]*required/);
    assert.doesNotMatch(html, /id="billing-zip"[^>]*required/);
    assert.doesNotMatch(html, /id="billing-country"[^>]*required/);
    assert.doesNotMatch(html, /id="billing-email"[^>]*required/);
    const nameAt = html.indexOf(">Customer name<");
    const cardAt = html.indexOf(">Card<");
    const amountAt = html.indexOf('id="amount-usd"');
    assert.ok(nameAt > 0 && nameAt < cardAt);
    assert.ok(cardAt > 0 && cardAt < amountAt);
    const cardHtml = html.slice(html.indexOf('id="card-group"'));
    assert.match(cardHtml, /id="amount-usd"/);
    assert.match(cardHtml, /id="billing-address"/);
    assert.match(cardHtml, /Used to match the card\./);
    assert.doesNotMatch(cardHtml, /id="staff-name"/);
    assert.doesNotMatch(cardHtml, /id="customer-name"/);
    assert.doesNotMatch(cardHtml, /id="more-info"/);
    const billingAt = cardHtml.indexOf('id="billing-address"');
    const collectAt = cardHtml.indexOf("token/Collect.js");
    const amountInCard = cardHtml.indexOf('id="amount-usd"');
    assert.ok(amountInCard >= 0 && amountInCard < billingAt);
    assert.ok(billingAt > 0 && collectAt > billingAt);
    assert.match(html, /class="avs-block"/);
    assert.match(html, /var avs=document\.querySelector\("\.avs-block"\)/);
    assert.match(html, /if\(avs\) avs\.hidden=true/);
    assert.match(html, /if\(office\) office\.hidden=true/);
    assert.match(html, /if\(wrap\) wrap\.hidden=true/);
    const avsAt = html.indexOf('class="avs-block"');
    const payAt = html.indexOf("Pay with card");
    const hideAt = html.indexOf("if(avs) avs.hidden=true");
    assert.ok(avsAt > 0 && payAt > avsAt);
    assert.ok(hideAt > html.indexOf('if(x.j&&x.j.ok)'));
    assert.match(html, /var payload=\{payment_token:token,amountUsd:amt\}/);
    assert.match(html, /if\(customerName\) payload\.customerName=customerName/);
    assert.doesNotMatch(html, /payload\.staffName/);
    assert.doesNotMatch(html, /payload\.notes/);
    assert.match(html, /if\(address1\) payload\.address1=address1/);
    assert.match(html, /if\(city\) payload\.city=city/);
    assert.match(html, /if\(state\) payload\.state=state/);
    assert.match(html, /if\(zip\) payload\.zip=zip/);
    assert.match(html, /if\(country\) payload\.country=country/);
    assert.match(html, /if\(email\) payload\.email=email/);
    assert.match(html, /JSON\.stringify\(payload\)/);
    assert.match(html, /charAt\(0\)==="\{"/);
    assert.match(html, /Nothing is wrong on our side/);
    assert.match(html, /We're missing something: amount/);
    assert.match(html, /We're missing something: card details/);
    assert.match(html, /problem on our side/);
    assert.doesNotMatch(html, /x\.j\.error/);
    assert.match(html, /fetch\("\/pay\/open\/charge"/);
    assert.doesNotMatch(html, /fetch\("\/pay\/office\/charge"/);
    assert.doesNotMatch(html, /Card processed by/);
    assert.doesNotMatch(html, /Air Today Travel/);
    assert.doesNotMatch(html, /Your card statement shows/);
    assert.doesNotMatch(html, /FLYNESHER\.COM/);
    assert.doesNotMatch(html, /Stripe/i);
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

describe("renderOfficePayHtml", () => {
  const html = renderOfficePayHtml({ collectPublicKey: "pk_test_collect" });

  it("Office then Card: Taken by select, Customer name, More info, none required", () => {
    assert.match(html, /id="office-group"/);
    assert.match(html, /<h2 class="group-title">Office<\/h2>/);
    assert.match(html, /<h2 class="group-title">Card<\/h2>/);
    assert.match(html, />Taken by</);
    assert.match(html, /<select id="staff-name"/);
    assert.match(html, /<option value=""><\/option>/);
    assert.match(html, /<option value="Hershy">Hershy<\/option>/);
    assert.match(html, /<option value="Sruly">Sruly<\/option>/);
    assert.match(html, /<option value="Richter">Richter<\/option>/);
    assert.match(html, /<option value="Goldie">Goldie<\/option>/);
    assert.match(html, /<option value="Joseph">Joseph<\/option>/);
    assert.match(html, /<option value="John">John<\/option>/);
    assert.match(html, /<option value="Aby">Aby<\/option>/);
    assert.match(html, /<option value="Anne">Anne<\/option>/);
    assert.match(html, /<option value="Purity">Purity<\/option>/);
    assert.match(html, /<option value="Lennart">Lennart<\/option>/);
    assert.match(html, /<option value="Kimberly">Kimberly<\/option>/);
    assert.doesNotMatch(html, /Hershey/);
    assert.doesNotMatch(html, />Processor</);
    assert.match(html, />Customer name</);
    assert.doesNotMatch(html, />Name</);
    assert.match(html, /id="customer-name"/);
    assert.match(html, />More info</);
    assert.match(html, /id="more-info"/);
    assert.doesNotMatch(html, /id="staff-name"[^>]*required/);
    assert.doesNotMatch(html, /id="customer-name"[^>]*required/);
    assert.doesNotMatch(html, /id="more-info"[^>]*required/);
    assert.doesNotMatch(html, /<select id="staff-name"[^>]*required/);
    const officeAt = html.indexOf(">Office<");
    const takenAt = html.indexOf(">Taken by<");
    const cardAt = html.indexOf(">Card<");
    const amountAt = html.indexOf('id="amount-usd"');
    assert.ok(officeAt > 0 && officeAt < takenAt);
    assert.ok(takenAt < cardAt);
    assert.ok(cardAt > 0 && cardAt < amountAt);
    const officeHtml = html.slice(
      html.indexOf('id="office-group"'),
      html.indexOf('id="card-group"')
    );
    const cardHtml = html.slice(html.indexOf('id="card-group"'));
    assert.match(officeHtml, /id="staff-name"/);
    assert.match(officeHtml, /id="customer-name"/);
    assert.match(officeHtml, /id="more-info"/);
    assert.match(officeHtml, />Taken by</);
    assert.match(officeHtml, />Customer name</);
    assert.doesNotMatch(officeHtml, />Name</);
    assert.match(officeHtml, />More info</);
    assert.doesNotMatch(officeHtml, /id="billing-address"/);
    assert.doesNotMatch(officeHtml, /id="amount-usd"/);
    assert.match(cardHtml, /id="amount-usd"/);
    assert.match(cardHtml, /Used to match the card\./);
    assert.match(cardHtml, /Pay with card/);
    assert.doesNotMatch(cardHtml, /id="staff-name"/);
    assert.match(html, /if\(staffName\) payload\.staffName=staffName/);
    assert.match(html, /if\(notes\) payload\.notes=notes/);
    assert.match(html, /fetch\("\/pay\/office\/charge"/);
    assert.doesNotMatch(html, /fetch\("\/pay\/open\/charge"/);
    assert.match(html, /if\(avs\) avs\.hidden=true/);
    assert.match(html, /if\(office\) office\.hidden=true/);
    assert.match(html, /if\(wrap\) wrap\.hidden=true/);
    assert.doesNotMatch(html, /FLYNESHER\.COM/);
    assert.doesNotMatch(html, /Stripe/i);
    assert.doesNotMatch(html, /required/);
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
    assert.equal(sale.lastBody().merchant_defined_fields.field_4, undefined);
    assert.equal(sale.lastBody().merchant_defined_fields.field_5, undefined);
    assert.equal(sale.lastBody().merchant_defined_fields.field_6, undefined);
    assert.equal(sale.lastBody().payment_descriptor, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(sale.lastBody(), "payment_descriptor"),
      false
    );
    assert.doesNotMatch(JSON.stringify(sale.lastBody()), /payment_descriptor/);
    assert.doesNotMatch(JSON.stringify(sale.lastBody()), /NESHER-PAY|JRM-PAY/);
    assert.doesNotMatch(JSON.stringify(sale.lastBody()), /Guest/);
    assert.equal(sale.lastBody().billing_address, undefined);
    assert.match(NMI_HOST, /pinpointpayments/);
  });

  it("empty names still charge and do not invent Guest", async () => {
    const sale = saleFetch();
    const out = await chargeOpenPay({
      amountUsd: 10,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-blank1",
      customerName: "",
      staffName: "   ",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(out.ok, true);
    assert.equal(out.httpStatus, 200);
    assert.equal(sale.calls(), 1);
    const body = sale.lastBody();
    assert.equal(body.merchant_defined_fields.field_4, undefined);
    assert.equal(body.merchant_defined_fields.field_5, undefined);
    assert.equal(body.merchant_defined_fields.field_6, undefined);
    assert.equal(body.billing_address, undefined);
    assert.doesNotMatch(JSON.stringify(body), /Guest/);
    assert.doesNotMatch(JSON.stringify(body), /payment_descriptor/);
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "payment_descriptor"),
      false
    );
  });

  it("empty address still charges; zip+address1 go on billing_address", async () => {
    const sale = saleFetch();
    const blank = await chargeOpenPay({
      amountUsd: 10,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-avs0",
      address1: "",
      city: "   ",
      zip: "",
      country: "",
      email: "",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(blank.ok, true);
    assert.equal(blank.httpStatus, 200);
    const emptyBody = sale.lastBody();
    assert.equal(emptyBody.billing_address, undefined);
    assert.doesNotMatch(JSON.stringify(emptyBody), /Guest/);
    assert.equal(
      Object.prototype.hasOwnProperty.call(emptyBody, "payment_descriptor"),
      false
    );
    const filled = await chargeOpenPay({
      amountUsd: 10,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-avs1",
      address1: "12 Main St",
      zip: "10977",
      state: "NY",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(filled.ok, true);
    const body = sale.lastBody();
    assert.equal(body.billing_address.address1, "12 Main St");
    assert.equal(body.billing_address.zip, "10977");
    assert.equal(body.billing_address.state, "NY");
    assert.equal(body.billing_address.country, "US");
    assert.equal(body.billing_address.city, undefined);
    assert.equal(body.billing_address.email, undefined);
    assert.equal(body.billing_address.first_name, undefined);
    const usa = await chargeOpenPay({
      amountUsd: 10,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-avs2",
      address1: "12 Main St",
      zip: "10977",
      country: "United States",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(usa.ok, true);
    assert.equal(sale.lastBody().billing_address.country, "US");
    assert.doesNotMatch(JSON.stringify(body), /Guest/);
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "payment_descriptor"),
      false
    );
    assert.doesNotMatch(JSON.stringify(body), /payment_descriptor/);
  });

  it("guest name is field_4; staffName Hershy on /pay/open/charge never sets field_5", async () => {
    const sale = saleFetch();
    const out = await chargeOpenPay({
      amountUsd: 12.5,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-named1",
      customerName: "Chaim Cohen",
      staffName: "Hershy",
      notes: "Window seat",
      processor: "Hershy",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(out.ok, true);
    const body = sale.lastBody();
    assert.equal(body.merchant_defined_fields.field_1, "nesher");
    assert.equal(body.merchant_defined_fields.field_4, "Chaim Cohen");
    assert.equal(body.merchant_defined_fields.field_5, undefined);
    assert.equal(body.merchant_defined_fields.field_6, undefined);
    assert.equal(body.billing_address.first_name, "Chaim");
    assert.equal(body.billing_address.last_name, "Cohen");
    assert.doesNotMatch(body.order_details.order_description, /Hershy/);
    assert.doesNotMatch(JSON.stringify(body), /Hershy/);
    assert.doesNotMatch(JSON.stringify(body), /Window seat/);
    assert.equal(body.payment_descriptor, undefined);
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "payment_descriptor"),
      false
    );
    assert.doesNotMatch(JSON.stringify(body), /payment_descriptor/);
    assert.doesNotMatch(JSON.stringify(body), /Guest/);
  });

  it("office Taken by Hershy sets field_5; junk staffName omitted; empty still charges", async () => {
    const sale = saleFetch();
    const hershy = await chargeOfficePay({
      amountUsd: 12.5,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-off1",
      customerName: "Chaim Cohen",
      staffName: "Hershy",
      notes: "Window seat",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(hershy.ok, true);
    const body = sale.lastBody();
    assert.equal(body.merchant_defined_fields.field_4, "Chaim Cohen");
    assert.equal(body.merchant_defined_fields.field_5, "Hershy");
    assert.equal(body.merchant_defined_fields.field_6, "Window seat");
    assert.match(body.order_details.order_description, /Hershy/);
    assert.equal(
      Object.prototype.hasOwnProperty.call(body, "payment_descriptor"),
      false
    );
    assert.doesNotMatch(JSON.stringify(body), /payment_descriptor/);
    assert.doesNotMatch(JSON.stringify(body), /Guest/);
    const junk = await chargeOfficePay({
      amountUsd: 10,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-off2",
      staffName: "Hershey",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(junk.ok, true);
    assert.equal(junk.httpStatus, 200);
    const junkBody = sale.lastBody();
    assert.equal(junkBody.merchant_defined_fields.field_5, undefined);
    assert.doesNotMatch(JSON.stringify(junkBody), /Hershey/);
    assert.doesNotMatch(JSON.stringify(junkBody), /Guest/);
    const empty = await chargeOfficePay({
      amountUsd: 10,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-off3",
      staffName: "",
      notes: "",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(empty.ok, true);
    const emptyBody = sale.lastBody();
    assert.equal(emptyBody.merchant_defined_fields.field_5, undefined);
    assert.equal(emptyBody.merchant_defined_fields.field_6, undefined);
    assert.doesNotMatch(JSON.stringify(emptyBody), /Guest/);
    assert.equal(
      Object.prototype.hasOwnProperty.call(emptyBody, "payment_descriptor"),
      false
    );
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
    assert.match(out.message, /missing something: amount/);
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
    assert.match(out.message, /We're missing something: card details/);
    assert.doesNotMatch(out.message, /Nothing is wrong on our side/);
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
    assert.match(out.message, /missing something: card details/);
  });

  it("guest notes are ignored; office notes go to field_6", async () => {
    const sale = saleFetch();
    const guest = await chargeOpenPay({
      amountUsd: 12.5,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-note0",
      notes: "Window seat",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(guest.ok, true);
    assert.equal(sale.lastBody().merchant_defined_fields.field_6, undefined);
    const office = await chargeOfficePay({
      amountUsd: 12.5,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-note1",
      notes: "Window seat",
      fetchImpl: sale.fetchImpl,
    });
    assert.equal(office.ok, true);
    assert.equal(sale.lastBody().merchant_defined_fields.field_6, "Window seat");
    assert.equal(
      Object.prototype.hasOwnProperty.call(sale.lastBody(), "payment_descriptor"),
      false
    );
  });

  it("Do Not Honor decline is a clear sentence, not JSON", async () => {
    const hershy = {
      object: "transaction",
      id: "12532467411",
      response: "2",
      response_code: "201",
      response_text: "Do Not Honor",
      processor_response_code: "05",
      processor_response_text: "DECLINE",
    };
    const out = await chargeOpenPay({
      amountUsd: 4100,
      paymentToken: "tok_collect",
      invoiceNumber: "OPEN-20260908-c09c18",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify(hershy);
        },
      }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "declined");
    assert.equal(out.httpStatus, 200);
    assert.match(out.message, /Nothing is wrong on our side/);
    assert.match(out.message, /Do Not Honor/);
    assert.match(out.message, /Call the customer/);
    assert.doesNotMatch(out.message, /"object"/);
    assert.doesNotMatch(out.message, /12532467411/);
    assert.doesNotMatch(out.message, /\{/);
    assert.equal(out.blockedReason, out.message);
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
    assert.match(open, /customerName:/);
    assert.match(open, /isOfficePayPath/);
    assert.match(open, /isOfficePayChargePath/);
    assert.match(open, /officeCharge/);
    assert.match(open, /office: true/);
    assert.match(open, /staffName:/);
    assert.match(open, /notes:/);
    assert.match(open, /renderOfficePayHtml/);
    assert.match(open, /renderOpenPayHtml/);
    assert.match(open, /address1:/);
    assert.match(open, /city:/);
    assert.match(open, /state:/);
    assert.match(open, /zip:/);
    assert.match(open, /country:/);
    assert.match(open, /email:/);
    assert.match(open, /guestFailBody/);
    assert.match(open, /guestFailBody\(\{ error: "raw_card_rejected" \}\)/);
    assert.doesNotMatch(
      open,
      /sendJson\(res, 400, \{ ok: false, error: "raw_card_rejected" \}\)/
    );
    assert.match(open, /openPayRequestAllowed\(req\.headers\)/);
    assert.doesNotMatch(open, /openPayHostForbidden/);
    assert.doesNotMatch(open, /payment_descriptor/);
    assert.doesNotMatch(src, /NMI_JRM_DESCRIPTOR/);
  });
});

describe("wiring", () => {
  it("Dockerfile COPY includes open-pay.js and health tag is bumped", () => {
    const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(docker, /\bopen-pay\.js\b/);
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /from "\.\/open-pay\.js"/);
    assert.match(src, /build: "2026-09-10-customer-name"/);
    assert.match(src, /isOpenPayPath\(url\.pathname\)/);
    assert.match(src, /isOfficePayPath\(url\.pathname\)/);
    assert.match(src, /openPayRequestAllowed\(req\.headers\)/);
    assert.match(src, /\/pay\/open/);
    assert.match(src, /\/pay\/office/);
  });
});
