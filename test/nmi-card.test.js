import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  BRANDS,
  brandFromInvoiceNumber,
  brandFromKind,
  brandFromRecord,
  descriptorFor,
  guestPayOrigin,
  paymentDescriptorPayload,
  isAllowedCardUrl,
  hostedInvoiceUrl,
  mintCardCheckout,
  chargeWithToken,
  chargeGuestInvoice,
  chargePayCode,
  looksLikePan,
  agentPaste,
  processedByFacts,
  processedByPasteLine,
  stripDeadCardFields,
  staffCardFields,
  isShortPayCode,
  nmiPaidStaffNote,
  NMI_HOST,
  guestCardMessage,
  GUEST_DECLINE_DEFAULT,
  GUEST_DECLINE_DO_NOT_HONOR,
  GUEST_OURS,
  GUEST_MISSING_AMOUNT,
  GUEST_MISSING_CARD,
  GUEST_ALREADY_PAID,
  GUEST_INVALID_LINK,
  GUEST_TRY_ANOTHER,
  GUEST_INACCURATE,
  GUEST_INACCURATE_EXP,
  GUEST_INACCURATE_CVV,
  GUEST_INACCURATE_PIN,
  GUEST_NOT_A_CARD,
  GUEST_UNSUPPORTED_CARD,
  GUEST_NO_CARD_ON_FILE,
  GUEST_CALL_ISSUER,
  GUEST_DUPLICATE,
  GUEST_RECURRING,
  GUEST_RECURRING_STOP_ALL,
  GUEST_RECURRING_STOP_THIS,
  GUEST_RECURRING_UPDATE,
  GUEST_RECURRING_RETRY_LATER,
  NMI_CODE_MESSAGES,
} from "../nmi-card.js";

const CARD_HOST = /pinpointpayments\.transactiongateway\.com/;

describe("brand + descriptor mapping", () => {
  it("maps JRM hotel invoice numbers to JRM", () => {
    assert.equal(brandFromInvoiceNumber("JRM-189-O50").id, "jrm");
    assert.equal(brandFromKind("hotel", "JRM-189-O50").id, "jrm");
    assert.equal(brandFromKind("hotel-offer", "x").sku, "JRM-PAY");
  });

  it("maps reservation / FLY refs to Nesher", () => {
    assert.equal(brandFromInvoiceNumber("RES-9FSGMN").id, "nesher");
    assert.equal(brandFromInvoiceNumber("FLY-12").id, "nesher");
    assert.equal(brandFromKind("reservation", "RES-9FSGMN").sku, "NESHER-PAY");
    assert.equal(brandFromKind("reservation", "FLY-12").id, "nesher");
    assert.equal(brandFromKind("customer", "CUST-12").id, "nesher");
    assert.equal(guestPayOrigin(brandFromKind("customer", "CUST-12")), "https://www.flynesher.com");
  });

  it("JRM falls back to Nesher FLYNESHER.COM until a JRM MID env is set (Joseph 2026-09-08)", () => {
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
    try {
      assert.equal(
        descriptorFor(brandFromInvoiceNumber("JRM-1")),
        "FLYNESHER.COM"
      );
      assert.equal(
        descriptorFor(brandFromInvoiceNumber("RES-1")),
        "FLYNESHER.COM"
      );
      assert.notEqual(
        descriptorFor(brandFromInvoiceNumber("JRM-1")),
        BRANDS.jrm.defaultDescriptor
      );
    } finally {
      if (prev !== undefined) process.env.NMI_JRM_DESCRIPTOR = prev;
      else delete process.env.NMI_JRM_DESCRIPTOR;
    }
  });

  it("maps record kind then brandId then invoice prefix", () => {
    assert.equal(brandFromRecord({ kind: "hotel" }).id, "jrm");
    assert.equal(brandFromRecord({ brandId: "jrm", kind: "reservation" }).id, "jrm");
    assert.equal(brandFromRecord({ invoiceNumber: "RES-1" }).id, "nesher");
  });

  it("guest origins are the matching website, never mixed", () => {
    assert.equal(guestPayOrigin(BRANDS.nesher), "https://www.flynesher.com");
    assert.equal(guestPayOrigin(BRANDS.jrm), "https://www.jrmhotels.com");
    assert.equal(
      guestPayOrigin(brandFromKind("hotel", "x")),
      "https://www.jrmhotels.com"
    );
    assert.equal(
      guestPayOrigin(brandFromKind("reservation", "x")),
      "https://www.flynesher.com"
    );
  });

  it("v5 sale never sends payment_descriptor; processor uses boarded DBA", () => {
    const src = fs.readFileSync(new URL("../nmi-card.js", import.meta.url), "utf8");
    assert.doesNotMatch(src, /body\.payment_descriptor/);
    assert.doesNotMatch(src, /payment_descriptor\s*=/);
    assert.equal(paymentDescriptorPayload(BRANDS.nesher), null);
    assert.equal(paymentDescriptorPayload(BRANDS.jrm), null);
    assert.equal(descriptorFor(BRANDS.nesher), "FLYNESHER.COM");
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
    try {
      assert.equal(descriptorFor(BRANDS.jrm), "FLYNESHER.COM");
      assert.notEqual(descriptorFor(BRANDS.jrm), BRANDS.jrm.defaultDescriptor);
      process.env.NMI_JRM_DESCRIPTOR = "JRM HOTELS";
      assert.equal(paymentDescriptorPayload(BRANDS.jrm), null);
    } finally {
      if (prev !== undefined) process.env.NMI_JRM_DESCRIPTOR = prev;
      else delete process.env.NMI_JRM_DESCRIPTOR;
    }
  });
});

describe("card URL allowlist", () => {
  it("accepts the Pinpoint Collect Checkout host and rejects Square/Stripe", () => {
    assert.equal(
      isAllowedCardUrl(
        "https://pinpointpayments.transactiongateway.com/cart/invoicing.php?invoice_id=1"
      ),
      true
    );
    assert.equal(
      isAllowedCardUrl("https://collectcheckout.com/r/wdy33zjf7bja16vvqlnk2tsdrgupbs"),
      true
    );
    assert.equal(isAllowedCardUrl("https://square.link/u/dead"), false);
    assert.equal(isAllowedCardUrl("https://checkout.stripe.com/c/pay/cs_x"), false);
    assert.equal(isAllowedCardUrl("http://pinpointpayments.transactiongateway.com/x"), false);
  });
});

describe("mintCardCheckout", () => {
  let prevKey;
  let prevJrm;
  beforeEach(() => {
    prevKey = process.env.NMI_PRIVATE_KEY;
    prevJrm = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
  });
  afterEach(() => {
    if (prevKey !== undefined) process.env.NMI_PRIVATE_KEY = prevKey;
    else delete process.env.NMI_PRIVATE_KEY;
    if (prevJrm !== undefined) process.env.NMI_JRM_DESCRIPTOR = prevJrm;
    else delete process.env.NMI_JRM_DESCRIPTOR;
  });

  it("mints a CRM-priced Nesher card URL on the NMI host with order_id = CRM ref", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ object: "invoice", id: 5550199, amount: "2604.00" });
        },
      };
    };
    const out = await mintCardCheckout({
      amountUsd: 2604.5,
      invoiceNumber: "RES-9FSGMN",
      kind: "reservation",
      customerName: "Ada Lovelace",
      customerEmail: "ada@example.com",
      summary: "TLV-JFK",
      fetchImpl,
    });
    assert.equal(out.ok, true);
    assert.equal(out.brand.id, "nesher");
    assert.equal(out.orderId, "RES-9FSGMN");
    assert.equal(out.descriptor, "FLYNESHER.COM");
    assert.match(out.cardUrl, CARD_HOST);
    assert.match(out.cardUrl, /invoice_id=5550199/);
    assert.doesNotMatch(out.cardUrl, /square|stripe/i);
    const body = JSON.parse(captured.init.body);
    assert.equal(captured.url, `${NMI_HOST}/api/v5/invoices`);
    assert.equal(captured.init.headers.Authorization, "test-private-key");
    assert.equal(body.amount, 2604.5);
    assert.notEqual(body.amount, 1);
    assert.equal(body.order_details.order_id, "RES-9FSGMN");
    assert.equal(body.order_details.order_description, "TLV-JFK");
    assert.equal(body.order_details.description, undefined);
    assert.deepEqual(body.payment_methods_allowed, ["cc"]);
    assert.equal(body.merchant_defined_fields.field_1, "nesher");
    assert.equal(body.merchant_defined_fields.field_2, "RES-9FSGMN");
    assert.equal(body.merchant_defined_fields.field_3, "RES-9FSGMN");
    assert.equal(body.merchant_defined_fields.field_4, "Ada Lovelace");
    assert.equal(body.billing_address.email, undefined);
    assert.equal(body.products, undefined);
    assert.equal(body.item_sku, undefined);
    assert.doesNotMatch(captured.init.body, /NESHER-PAY|JRM-PAY/);
    assert.equal(out.sku, "NESHER-PAY");
  });

  it("mints JRM-189 Collect.js on Nesher FLYNESHER.COM (Joseph 2026-09-08)", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    let called = 0;
    const fetchImpl = async () => {
      called += 1;
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({
            message: "Your account is not set up to use Invoicing",
          });
        },
      };
    };
    const out = await mintCardCheckout({
      amountUsd: 189,
      invoiceNumber: "JRM-189-O50",
      kind: "hotel",
      fetchImpl,
    });
    assert.equal(out.ok, true);
    assert.equal(out.capture, "collectjs");
    assert.equal(out.descriptor, "FLYNESHER.COM");
    assert.equal(out.cardUrl, null);
    assert.equal(out.brand.id, "jrm");
    assert.equal(out.invoicesProvisioned, false);
    assert.equal(called, 1);
    const fields = staffCardFields(out);
    assert.equal(fields.hasCard, true);
    assert.equal(fields.cardBlockedReason, null);
    assert.equal(fields.cardCapture, "collectjs");
    assert.equal(fields.cardProcessor, "nmi");
    assert.equal(fields.creditCardEnabled, false);
    const offer = await mintCardCheckout({
      amountUsd: 189,
      invoiceNumber: "JRM-189-O50",
      kind: "hotel-offer",
      fetchImpl,
    });
    assert.equal(offer.ok, true);
    assert.equal(offer.brand.id, "jrm");
    assert.equal(offer.capture, "collectjs");
    assert.equal(offer.descriptor, "FLYNESHER.COM");
    assert.equal(staffCardFields(offer).cardBlockedReason, null);
  });

  it("mints JRM once a second descriptor is configured", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    process.env.NMI_JRM_DESCRIPTOR = "JRM HOTELS";
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            id: 77,
            payment_url:
              "https://pinpointpayments.transactiongateway.com/cart/invoicing.php?invoice_id=77",
          });
        },
      };
    };
    const out = await mintCardCheckout({
      amountUsd: 189.0,
      invoiceNumber: "JRM-189-O50",
      kind: "hotel",
      fetchImpl,
    });
    assert.equal(out.ok, true);
    assert.equal(out.descriptor, "JRM HOTELS");
    assert.equal(out.brand.id, "jrm");
    assert.equal(
      out.cardUrl,
      "https://pinpointpayments.transactiongateway.com/cart/invoicing.php?invoice_id=77"
    );
    const body = JSON.parse(captured.init.body);
    assert.equal(body.amount, 189);
    assert.equal(body.order_details.order_id, "JRM-189-O50");
    assert.equal(body.order_details.order_description, "JRM Hotels JRM-189-O50");
    assert.equal(body.merchant_defined_fields.field_1, "jrm");
    assert.equal(body.merchant_defined_fields.field_2, "JRM-189-O50");
    assert.equal(body.merchant_defined_fields.field_3, "JRM-189-O50");
    assert.equal(body.merchant_defined_fields.field_4, undefined);
    assert.doesNotMatch(captured.init.body, /NESHER-PAY|JRM-PAY/);
  });

  it("ignores leftover Square URLs", () => {
    const cleaned = stripDeadCardFields({
      squareUrl: "https://square.link/u/dead",
      cardProcessor: "square",
      cardUrl: "https://square.link/u/dead",
      mercuryUrl: "https://app.mercury.com/pay/a",
    });
    assert.equal(cleaned.squareUrl, undefined);
    assert.equal(cleaned.cardProcessor, undefined);
    assert.equal(cleaned.cardUrl, undefined);
  });

  it("records keys_missing without calling the gateway", async () => {
    delete process.env.NMI_PRIVATE_KEY;
    const out = await mintCardCheckout({
      amountUsd: 10,
      invoiceNumber: "RES-X",
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "keys_missing");
  });

  it("falls back to Collect.js when Invoicing is not provisioned", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({
            message: "Your account is not set up to use Invoicing",
          });
        },
      };
    };
    const out = await mintCardCheckout({
      amountUsd: 12.34,
      invoiceNumber: "RES-555QA",
      kind: "reservation",
      customerEmail: "ada@example.com",
      fetchImpl,
    });
    assert.equal(out.ok, true);
    assert.equal(out.capture, "collectjs");
    assert.equal(out.invoicesProvisioned, false);
    assert.equal(out.cardUrl, null);
    assert.equal(out.amountUsd, 12.34);
    assert.equal(out.orderId, "RES-555QA");
    const body = JSON.parse(captured.init.body);
    assert.equal(body.amount, 12.34);
    assert.notEqual(body.amount, 1);
    assert.equal(body.order_details.order_id, "RES-555QA");
    assert.equal(body.billing_address.email, undefined);
    assert.doesNotMatch(captured.init.body, /NESHER-PAY|JRM-PAY/);
  });
});

describe("chargeWithToken", () => {
  let prevKey;
  let prevJrm;
  beforeEach(() => {
    prevKey = process.env.NMI_PRIVATE_KEY;
    prevJrm = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
  });
  afterEach(() => {
    if (prevKey !== undefined) process.env.NMI_PRIVATE_KEY = prevKey;
    else delete process.env.NMI_PRIVATE_KEY;
    if (prevJrm !== undefined) process.env.NMI_JRM_DESCRIPTOR = prevJrm;
    else delete process.env.NMI_JRM_DESCRIPTOR;
  });

  it("posts the CRM amount and order id, never a SKU or email", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ response: "1", id: "txn_1" });
        },
      };
    };
    const out = await chargeWithToken({
      amountUsd: 2604.5,
      invoiceNumber: "RES-9FSGMN",
      kind: "reservation",
      customerName: "Ada Lovelace",
      customerEmail: "ada@example.com",
      paymentToken: "tok_collect",
      fetchImpl,
    });
    assert.equal(out.ok, true);
    assert.equal(out.transactionId, "txn_1");
    assert.equal(captured.url, `${NMI_HOST}/api/v5/payments/sale`);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.amount, "2604.50");
    assert.notEqual(Number(body.amount), 1);
    assert.equal(body.order_details.id, "RES-9FSGMN");
    assert.equal(body.payment_details.payment_token, "tok_collect");
    assert.equal(body.billing_address.email, undefined);
    assert.equal(body.products, undefined);
    assert.doesNotMatch(captured.init.body, /NESHER-PAY|JRM-PAY/);
    assert.equal(body.merchant_defined_fields.field_1, "nesher");
    assert.equal(body.merchant_defined_fields.field_2, "RES-9FSGMN");
    assert.equal(body.merchant_defined_fields.field_3, "RES-9FSGMN");
    assert.equal(body.merchant_defined_fields.field_4, "Ada Lovelace");
    assert.notEqual(body.merchant_defined_fields.field_1, "RES-9FSGMN");
    assert.notEqual(body.merchant_defined_fields.field_3, "FLYNESHER.COM");
    assert.equal(body.payment_descriptor, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "payment_descriptor"), false);
    assert.doesNotMatch(captured.init.body, /payment_descriptor/);
    assert.doesNotMatch(captured.init.body, /"descriptor"/);
  });

  it("charges JRM-189 Collect.js under FLYNESHER.COM (Joseph 2026-09-08)", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ response: "1", id: "txn_jrm189" });
        },
      };
    };
    const out = await chargeWithToken({
      amountUsd: 189,
      invoiceNumber: "JRM-189-O50",
      kind: "hotel",
      paymentToken: "tok_collect",
      fetchImpl,
    });
    assert.equal(out.ok, true);
    assert.equal(out.descriptor, "FLYNESHER.COM");
    assert.equal(out.brand.id, "jrm");
    assert.equal(out.transactionId, "txn_jrm189");
    const body = JSON.parse(captured.init.body);
    assert.equal(body.amount, "189.00");
    assert.equal(body.order_details.id, "JRM-189-O50");
    assert.equal(body.merchant_defined_fields.field_1, "jrm");
    assert.equal(body.merchant_defined_fields.field_4, undefined);
    assert.equal(body.merchant_defined_fields.field_5, undefined);
    assert.equal(body.billing_address, undefined);
    assert.equal(body.payment_details.payment_token, "tok_collect");
    assert.equal(body.payment_descriptor, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "payment_descriptor"), false);
    assert.doesNotMatch(captured.init.body, /payment_descriptor/);
    assert.doesNotMatch(captured.init.body, /JRM HOTELS/);
    assert.doesNotMatch(captured.init.body, /Guest/);
  });

  it("maps customer and processor names to field_4 and field_5, never descriptor", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ response: "1", id: "txn_names" });
        },
      };
    };
    const out = await chargeWithToken({
      amountUsd: 10,
      invoiceNumber: "OPEN-20260908-mdf",
      kind: "open",
      customerName: "Ada Lovelace",
      staffName: "Sruly",
      paymentToken: "tok_collect",
      fetchImpl,
    });
    assert.equal(out.ok, true);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.merchant_defined_fields.field_4, "Ada Lovelace");
    assert.equal(body.merchant_defined_fields.field_5, "Sruly");
    assert.equal(body.billing_address.first_name, "Ada");
    assert.equal(body.billing_address.last_name, "Lovelace");
    assert.match(body.order_details.order_description, /Sruly/);
    assert.equal(body.merchant_defined_fields.field_6, undefined);
    assert.equal(body.payment_descriptor, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "payment_descriptor"), false);
    assert.doesNotMatch(captured.init.body, /payment_descriptor/);
  });

  it("maps More info to field_6 when provided, omitted when blank", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    let captured;
    const fetchImpl = async (_url, init) => {
      captured = init;
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ response: "1", id: "txn_notes" });
        },
      };
    };
    const out = await chargeWithToken({
      amountUsd: 10,
      invoiceNumber: "OPEN-20260908-note",
      kind: "open",
      notes: "Room 12, arriving Thursday",
      paymentToken: "tok_collect",
      fetchImpl,
    });
    assert.equal(out.ok, true);
    const body = JSON.parse(captured.body);
    assert.equal(body.merchant_defined_fields.field_6, "Room 12, arriving Thursday");
    assert.equal(body.payment_descriptor, undefined);
    const blank = await chargeWithToken({
      amountUsd: 10,
      invoiceNumber: "OPEN-20260908-note2",
      kind: "open",
      notes: "  ",
      paymentToken: "tok_collect",
      fetchImpl,
    });
    assert.equal(blank.ok, true);
    assert.equal(JSON.parse(captured.body).merchant_defined_fields.field_6, undefined);
  });

  it("requires a payment token", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    const out = await chargeWithToken({
      amountUsd: 10,
      invoiceNumber: "RES-X",
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "payment_token required");
    assert.equal(out.message, GUEST_MISSING_CARD);
  });

  it("Hershy Do Not Honor decline is a clear sentence, not JSON", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    const hershy = {
      object: "transaction",
      id: "12532467411",
      response: "2",
      response_code: "201",
      response_text: "Do Not Honor",
      processor_response_code: "05",
      processor_response_text: "DECLINE",
      cvv_response: "M",
    };
    const out = await chargeWithToken({
      amountUsd: 4100,
      invoiceNumber: "OPEN-20260908-c09c18",
      kind: "open",
      paymentToken: "tok_collect",
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
    assert.equal(out.message, GUEST_DECLINE_DO_NOT_HONOR);
    assert.match(out.message, /Nothing is wrong on our side/);
    assert.match(out.message, /Do Not Honor/);
    assert.match(out.message, /Call the customer/);
    assert.doesNotMatch(out.message, /"object"/);
    assert.doesNotMatch(out.message, /12532467411/);
    assert.doesNotMatch(out.message, /\{/);
    assert.equal(out.blockedReason, out.message);
  });
});

describe("guestCardMessage", () => {
  const hershy = {
    object: "transaction",
    id: "12532467411",
    response: "2",
    response_code: "201",
    response_text: "Do Not Honor",
    processor_response_code: "05",
    processor_response_text: "DECLINE",
    cvv_response: "M",
  };

  it("Hershy JSON → Do Not Honor sentence, no dump", () => {
    const msg = guestCardMessage(hershy);
    assert.equal(msg, GUEST_DECLINE_DO_NOT_HONOR);
    assert.match(msg, /Nothing is wrong on our side/);
    assert.match(msg, /Do Not Honor/);
    assert.match(msg, /Call the customer/);
    assert.doesNotMatch(msg, /"object"/);
    assert.doesNotMatch(msg, /12532467411/);
    assert.doesNotMatch(msg, /\{/);
  });

  it("insufficient funds fixture names that", () => {
    const msg = guestCardMessage({
      response: "2",
      response_text: "Insufficient funds",
    });
    assert.match(msg, /Nothing is wrong on our side/);
    assert.match(msg, /insufficient funds/i);
    assert.match(msg, /Call the customer/);
    assert.doesNotMatch(msg, /\{/);
  });

  it("expired card fixture names that", () => {
    const msg = guestCardMessage({ response_text: "Expired card" });
    assert.match(msg, /Nothing is wrong on our side/);
    assert.match(msg, /expired/i);
    assert.doesNotMatch(msg, /\{/);
  });

  it("pickup / stolen stays try-another, no stolen word", () => {
    const msg = guestCardMessage({ response_text: "Pick up card" });
    assert.equal(msg, GUEST_TRY_ANOTHER);
    assert.match(msg, /Nothing is wrong on our side/);
    assert.match(msg, /Try another card/);
    assert.match(msg, /call the customer/i);
    assert.doesNotMatch(msg, /stolen|pick up|lost|fraud/i);
  });

  it("already_paid / invalid / raw PAN never say Nothing is wrong on our side", () => {
    const paid = guestCardMessage({ error: "already_paid" });
    assert.equal(paid, GUEST_ALREADY_PAID);
    assert.doesNotMatch(paid, /Nothing is wrong on our side/);
    assert.doesNotMatch(paid, /\{/);
    const invalid = guestCardMessage({ error: "invalid" });
    assert.equal(invalid, GUEST_INVALID_LINK);
    assert.doesNotMatch(invalid, /Nothing is wrong on our side/);
    assert.doesNotMatch(invalid, /\{/);
    const pan = guestCardMessage({ error: "raw_card_rejected" });
    assert.equal(pan, GUEST_MISSING_CARD);
    assert.doesNotMatch(pan, /Nothing is wrong on our side/);
    assert.match(pan, /We're missing something/);
    assert.doesNotMatch(pan, /\{/);
  });

  it("204 is not allowed, not expired", () => {
    const msg = guestCardMessage({ response_code: "204" });
    assert.match(msg, /Nothing is wrong on our side/);
    assert.match(msg, /not allowed/);
    assert.doesNotMatch(msg, /expired/i);
    assert.doesNotMatch(msg, /\{/);
  });

  it("maps every NMI response_code 200-461 to plain English, never JSON", () => {
    const expect = {
      200: [/Nothing is wrong on our side/, /declined by processor/i],
      201: [GUEST_DECLINE_DO_NOT_HONOR],
      202: [/Nothing is wrong on our side/, /insufficient funds/i],
      203: [/Nothing is wrong on our side/, /over limit/i],
      204: [/Nothing is wrong on our side/, /not allowed/],
      220: [GUEST_INACCURATE],
      221: [GUEST_NOT_A_CARD],
      222: [GUEST_NO_CARD_ON_FILE],
      223: [/Nothing is wrong on our side/, /expired/i],
      224: [GUEST_INACCURATE_EXP],
      225: [GUEST_INACCURATE_CVV],
      226: [GUEST_INACCURATE_PIN],
      240: [GUEST_CALL_ISSUER],
      250: [GUEST_TRY_ANOTHER],
      251: [GUEST_TRY_ANOTHER],
      252: [GUEST_TRY_ANOTHER],
      253: [GUEST_TRY_ANOTHER],
      260: [GUEST_RECURRING],
      261: [GUEST_RECURRING_STOP_ALL],
      262: [GUEST_RECURRING_STOP_THIS],
      263: [GUEST_RECURRING_UPDATE],
      264: [GUEST_RECURRING_RETRY_LATER],
      300: [GUEST_OURS],
      400: [GUEST_OURS],
      410: [GUEST_OURS],
      411: [GUEST_OURS],
      420: [GUEST_OURS],
      421: [GUEST_OURS],
      430: [GUEST_DUPLICATE],
      440: [GUEST_INACCURATE],
      441: [GUEST_INACCURATE],
      460: [GUEST_OURS],
      461: [GUEST_UNSUPPORTED_CARD],
    };
    const codes = Object.keys(expect).map(Number);
    assert.deepEqual(
      Object.keys(NMI_CODE_MESSAGES).map(Number).sort((a, b) => a - b),
      codes.sort((a, b) => a - b)
    );
    for (const code of codes) {
      const msg = guestCardMessage({ response_code: String(code) });
      assert.equal(msg, NMI_CODE_MESSAGES[code]);
      assert.doesNotMatch(msg, /\{/);
      assert.doesNotMatch(msg, /"object"/);
      assert.doesNotMatch(msg, /response_code/);
      for (const part of expect[code]) {
        if (typeof part === "string") assert.equal(msg, part);
        else assert.match(msg, part);
      }
      if (code >= 250 && code <= 253) {
        assert.doesNotMatch(msg, /stolen|lost|fraud|pick up/i);
        assert.match(msg, /Try another card/);
      }
      if (code === 204) assert.doesNotMatch(msg, /expired/i);
      if ([220, 224, 225, 226, 440, 441].includes(code)) {
        assert.match(msg, /inaccurate/);
        assert.doesNotMatch(msg, /Nothing is wrong on our side/);
      }
      if (code === 221 || code === 461) {
        assert.match(msg, /not a valid card/);
        assert.doesNotMatch(msg, /Nothing is wrong on our side/);
      }
      if (code === 222) {
        assert.match(msg, /We're missing something/);
        assert.doesNotMatch(msg, /Nothing is wrong on our side/);
      }
      if ([300, 400, 410, 411, 420, 421, 460].includes(code)) {
        assert.equal(msg, GUEST_OURS);
      }
      if (code === 430) {
        assert.equal(msg, GUEST_DUPLICATE);
        assert.doesNotMatch(msg, /Nothing is wrong on our side/);
      }
    }
  });

  it("JSON-only body → not-us default, no brace", () => {
    const raw = JSON.stringify(hershy);
    const msg = guestCardMessage(raw);
    assert.equal(msg, GUEST_DECLINE_DEFAULT);
    assert.match(msg, /Nothing is wrong on our side/);
    assert.doesNotMatch(msg, /\{/);
    assert.doesNotMatch(msg, /12532467411/);
    assert.doesNotMatch(msg, /"object"/);
  });

  it("keys_missing and 410 are our side", () => {
    assert.equal(guestCardMessage({ error: "keys_missing" }), GUEST_OURS);
    assert.equal(guestCardMessage({ response_code: "410" }), GUEST_OURS);
    assert.equal(guestCardMessage({ httpStatus: 500 }), GUEST_OURS);
    assert.match(GUEST_OURS, /problem on our side/);
    assert.doesNotMatch(GUEST_OURS, /\{/);
  });

  it("amount_required and payment_token required are missing", () => {
    assert.equal(
      guestCardMessage({ error: "amount_required" }),
      GUEST_MISSING_AMOUNT
    );
    assert.equal(
      guestCardMessage({ error: "payment_token required" }),
      GUEST_MISSING_CARD
    );
    assert.match(GUEST_MISSING_AMOUNT, /amount/);
    assert.match(GUEST_MISSING_CARD, /card details/);
    assert.doesNotMatch(GUEST_MISSING_AMOUNT, /\{/);
  });
});

describe("chargeGuestInvoice", () => {
  it("charges the stored CRM amount and ignores a client amount", async () => {
    let captured;
    const fetchImpl = async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ response: "1", id: "txn_locked" });
        },
      };
    };
    const out = await chargeGuestInvoice({
      invoice: {
        amountUsd: 2604.5,
        invoiceNumber: "RES-9FSGMN",
        customerName: "Ada",
      },
      paymentToken: "tok_collect",
      amountUsd: 1,
      fetchImpl,
      privateKey: "test-private-key",
    });
    assert.equal(out.ok, true);
    const body = JSON.parse(captured.init.body);
    assert.equal(body.amount, "2604.50");
    assert.notEqual(Number(body.amount), 1);
    assert.equal(body.order_details.id, "RES-9FSGMN");
  });

  it("rejects a PAN posted as the token", async () => {
    const out = await chargeGuestInvoice({
      invoice: { amountUsd: 10, invoiceNumber: "RES-X" },
      paymentToken: "4111111111111111",
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "raw_card_rejected");
    assert.equal(out.message, GUEST_MISSING_CARD);
    assert.doesNotMatch(out.message, /Nothing is wrong on our side/);
    assert.equal(looksLikePan("4111 1111 1111 1111"), true);
    assert.equal(looksLikePan("tok_collect"), false);
  });

  it("refuses a second charge once paidAt is set", async () => {
    const out = await chargeGuestInvoice({
      invoice: {
        amountUsd: 10,
        invoiceNumber: "RES-X",
        paidAt: "2026-09-08T00:00:00Z",
      },
      paymentToken: "tok_collect",
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "already_paid");
    assert.equal(out.message, GUEST_ALREADY_PAID);
    assert.doesNotMatch(out.message, /Nothing is wrong on our side/);
  });
});

describe("agent paste", () => {
  it("is one URL plus CRM ref plus brand", () => {
    const text = agentPaste({
      brand: brandFromInvoiceNumber("RES-9FSGMN"),
      invoiceNumber: "RES-9FSGMN",
      amountUsd: 2604,
      cardUrl:
        "https://pinpointpayments.transactiongateway.com/cart/invoicing.php?invoice_id=1",
    });
    assert.match(text, /Nesher/);
    assert.match(text, /RES-9FSGMN/);
    assert.match(text, CARD_HOST);
    assert.match(text, /Card processed by Air Today Travel Inc/);
    assert.match(text, /Statement shows FLYNESHER\.COM/);
    assert.match(text, /Bank: Air Today Travel \(Mercury \/ Bank Hapoalim\)/);
    assert.doesNotMatch(text, /square|stripe/i);
    assert.doesNotMatch(text, /Pinpoint\/NMI/);
    assert.equal(text.split("\n").filter(Boolean).length, 3);
    assert.equal(hostedInvoiceUrl("1").includes("invoice_id=1"), true);
  });

  it("staff mint keeps Mercury creditCardEnabled false; NMI is cardProcessor", () => {
    const collect = staffCardFields({
      ok: true,
      capture: "collectjs",
      cardUrl: null,
      error: null,
    });
    assert.equal(collect.creditCardEnabled, false);
    assert.equal(collect.cardProcessor, "nmi");
    assert.equal(collect.cardCapture, "collectjs");
    assert.equal(collect.hasCard, true);
    const none = staffCardFields({ ok: false, error: "keys_missing" });
    assert.equal(none.creditCardEnabled, false);
    assert.equal(none.cardProcessor, "none");
    const jrmLive = staffCardFields({
      ok: true,
      capture: "collectjs",
      cardUrl: null,
      descriptor: "FLYNESHER.COM",
    });
    assert.equal(jrmLive.hasCard, true);
    assert.equal(jrmLive.cardBlockedReason, null);
    assert.equal(jrmLive.cardCapture, "collectjs");
    const jrmBlocked = staffCardFields({
      ok: false,
      error: "second_dba_pending",
      blockedReason: "Card descriptor is missing or invalid.",
    });
    assert.equal(jrmBlocked.cardBlockedReason, "second_dba_pending");
    assert.equal(jrmBlocked.hasCard, false);
    const hosted = staffCardFields({
      ok: true,
      cardUrl:
        "https://pinpointpayments.transactiongateway.com/cart/invoicing.php?invoice_id=1",
      capture: "invoice",
    });
    assert.equal(hosted.creditCardEnabled, false);
    assert.equal(hosted.cardProcessor, "nmi");
    assert.equal(hosted.cardCapture, "invoice");
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.doesNotMatch(src, /creditCardEnabled:\s*hasCard/);
    assert.match(src, /staffCardFields/);
    assert.match(src, /creditCardEnabled:\s*cardFields\.creditCardEnabled/);
  });
});

describe("chargePayCode", () => {
  const invoice = {
    amountUsd: 55.55,
    invoiceNumber: "RES-555TRAIN",
    customerName: "Ada",
    kind: "reservation",
    recordId: 337,
  };

  function saleFetch() {
    let calls = 0;
    let lastBody;
    const fetchImpl = async (url, init) => {
      calls += 1;
      lastBody = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ response: "1", id: "txn_cas" });
        },
      };
    };
    return {
      fetchImpl,
      calls: () => calls,
      lastBody: () => lastBody,
    };
  }

  it("refuses a dotted long-token path without loading or charging", async () => {
    let loaded = 0;
    let claimed = 0;
    let fetched = 0;
    const out = await chargePayCode({
      code: "aaa.bbb.ccc",
      paymentToken: "tok_collect",
      loadInvoice: async () => {
        loaded += 1;
        return { ok: true, data: invoice };
      },
      claimInvoicePaid: async () => {
        claimed += 1;
        return { ok: true, paidAt: "t" };
      },
      fetchImpl: async () => {
        fetched += 1;
        throw new Error("no fetch");
      },
      privateKey: "test-private-key",
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "short_code_required");
    assert.equal(out.httpStatus, 400);
    assert.equal(loaded, 0);
    assert.equal(claimed, 0);
    assert.equal(fetched, 0);
    assert.equal(isShortPayCode("aaa.bbb.ccc"), false);
    assert.equal(isShortPayCode("abc12xyz"), true);
  });

  it("CAS-claims paidAt so a second submit is 409 and does not fire NMI", async () => {
    const sale = saleFetch();
    let paidAt = null;
    const claims = [];
    const notes = [];
    const load = async () => ({
      ok: true,
      data: { ...invoice, paidAt },
    });
    const claim = async (code, extra) => {
      claims.push(code);
      if (paidAt) return { ok: false, error: "already_paid" };
      paidAt = extra.paidAt || "t1";
      return { ok: true, paidAt };
    };
    const first = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice: load,
      claimInvoicePaid: claim,
      markInvoicePaid: async () => ({ ok: true }),
      appendReservationNote: async (id, note) => {
        notes.push({ id, note });
      },
      appendHotelNote: async () => {
        throw new Error("hotel writer must not run");
      },
      fetchImpl: sale.fetchImpl,
      privateKey: "test-private-key",
    });
    assert.equal(first.ok, true);
    assert.equal(first.transactionId, "txn_cas");
    assert.equal(sale.calls(), 1);
    assert.equal(sale.lastBody().merchant_defined_fields.field_1, "nesher");
    assert.equal(sale.lastBody().merchant_defined_fields.field_2, "RES-555TRAIN");
    assert.equal(sale.lastBody().merchant_defined_fields.field_3, "RES-555TRAIN");
    assert.equal(notes.length, 1);
    assert.equal(notes[0].id, 337);
    assert.match(notes[0].note, /\$55\.55/);
    assert.match(notes[0].note, /txn_cas/);
    assert.match(notes[0].note, /mark the Mercury invoice PAID, never cancel\./);
    assert.doesNotMatch(notes[0].note, /core_payment/);

    const second = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice: load,
      claimInvoicePaid: claim,
      fetchImpl: sale.fetchImpl,
      privateKey: "test-private-key",
    });
    assert.equal(second.ok, false);
    assert.equal(second.error, "already_paid");
    assert.equal(second.httpStatus, 409);
    assert.equal(second.message, GUEST_ALREADY_PAID);
    assert.doesNotMatch(second.message, /Nothing is wrong on our side/);
    assert.equal(sale.calls(), 1);
    assert.equal(claims.length, 1);
  });

  it("a second concurrent claim is 409 without a second NMI sale", async () => {
    const sale = saleFetch();
    let held = false;
    const loadUnpaid = async () => ({ ok: true, data: { ...invoice } });
    const claim = async () => {
      if (held) return { ok: false, error: "already_paid" };
      held = true;
      return { ok: true, paidAt: "t-cas" };
    };
    const first = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice: loadUnpaid,
      claimInvoicePaid: claim,
      markInvoicePaid: async () => ({ ok: true }),
      fetchImpl: sale.fetchImpl,
      privateKey: "test-private-key",
    });
    const second = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice: loadUnpaid,
      claimInvoicePaid: claim,
      fetchImpl: sale.fetchImpl,
      privateKey: "test-private-key",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(second.error, "already_paid");
    assert.equal(second.httpStatus, 409);
    assert.equal(second.message, GUEST_ALREADY_PAID);
    assert.doesNotMatch(second.message, /Nothing is wrong on our side/);
    assert.equal(sale.calls(), 1);
  });

  it("invalid pay code is not the bank-decline sentence", async () => {
    const out = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice: async () => ({ ok: false, error: "invalid" }),
      claimInvoicePaid: async () => {
        throw new Error("no claim");
      },
      fetchImpl: async () => {
        throw new Error("no fetch");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "invalid");
    assert.equal(out.httpStatus, 410);
    assert.equal(out.message, GUEST_INVALID_LINK);
    assert.doesNotMatch(out.message, /Nothing is wrong on our side/);
    assert.doesNotMatch(out.message, /\{/);
  });

  it("guest JRM-189 chargePayCode uses FLYNESHER.COM without NMI_JRM_DESCRIPTOR (Joseph 2026-09-08)", async () => {
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
    try {
      const sale = saleFetch();
      const hotels = [];
      const out = await chargePayCode({
        code: "jrm12xyz",
        paymentToken: "tok_collect",
        loadInvoice: async () => ({
          ok: true,
          data: {
            amountUsd: 189,
            invoiceNumber: "JRM-189-O50",
            kind: "hotel",
            recordId: 189,
            customerName: "Guest",
          },
        }),
        claimInvoicePaid: async () => ({ ok: true, paidAt: "t" }),
        markInvoicePaid: async () => ({ ok: true }),
        appendHotelNote: async (id, note) => hotels.push({ id, note }),
        fetchImpl: sale.fetchImpl,
        privateKey: "test-private-key",
      });
      assert.equal(out.ok, true);
      assert.equal(hotels.length, 1);
      assert.equal(sale.lastBody().payment_descriptor, undefined);
      assert.equal(
        Object.prototype.hasOwnProperty.call(sale.lastBody(), "payment_descriptor"),
        false
      );
      assert.doesNotMatch(JSON.stringify(sale.lastBody()), /payment_descriptor/);
      assert.doesNotMatch(JSON.stringify(sale.lastBody()), /JRM HOTELS/);
    } finally {
      if (prev !== undefined) process.env.NMI_JRM_DESCRIPTOR = prev;
      else delete process.env.NMI_JRM_DESCRIPTOR;
    }
  });

  it("does not INSERT core_payment and writes a hotel note for JRM", async () => {
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    process.env.NMI_JRM_DESCRIPTOR = "JRM HOTELS";
    try {
      const sale = saleFetch();
      const hotels = [];
      const resNotes = [];
      const out = await chargePayCode({
        code: "jrm12xyz",
        paymentToken: "tok_collect",
        loadInvoice: async () => ({
          ok: true,
          data: {
            amountUsd: 189,
            invoiceNumber: "JRM-189-O50",
            kind: "hotel",
            recordId: 189,
            customerName: "Guest",
          },
        }),
        claimInvoicePaid: async () => ({ ok: true, paidAt: "t" }),
        markInvoicePaid: async () => ({ ok: true }),
        appendHotelNote: async (id, note) => hotels.push({ id, note }),
        appendReservationNote: async (id, note) => resNotes.push({ id, note }),
        fetchImpl: sale.fetchImpl,
        privateKey: "test-private-key",
      });
      assert.equal(out.ok, true);
      assert.equal(hotels.length, 1);
      assert.equal(hotels[0].id, 189);
      assert.match(hotels[0].note, /mark the Mercury invoice PAID, never cancel\./);
      assert.equal(resNotes.length, 0);
      assert.equal(sale.lastBody().payment_descriptor, undefined);
      assert.equal(
        Object.prototype.hasOwnProperty.call(sale.lastBody(), "payment_descriptor"),
        false
      );
      assert.doesNotMatch(JSON.stringify(sale.lastBody()), /payment_descriptor/);
      const nmiSrc = fs.readFileSync(new URL("../nmi-card.js", import.meta.url), "utf8");
      assert.doesNotMatch(nmiSrc, /core_payment/);
      assert.equal(
        nmiPaidStaffNote({ amountUsd: 10, transactionId: "x" }).includes(
          "mark the Mercury invoice PAID, never cancel."
        ),
        true
      );
    } finally {
      if (prev !== undefined) process.env.NMI_JRM_DESCRIPTOR = prev;
      else delete process.env.NMI_JRM_DESCRIPTOR;
    }
  });

  it("charges the stored CRM amount even if the caller passes amountUsd: 1", async () => {
    const sale = saleFetch();
    const out = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      amountUsd: 1,
      loadInvoice: async () => ({ ok: true, data: invoice }),
      claimInvoicePaid: async () => ({ ok: true, paidAt: "t" }),
      markInvoicePaid: async () => ({ ok: true }),
      fetchImpl: sale.fetchImpl,
      privateKey: "test-private-key",
    });
    assert.equal(out.ok, true);
    assert.equal(sale.lastBody().amount, "55.55");
    assert.notEqual(Number(sale.lastBody().amount), 1);
    assert.equal(sale.lastBody().order_details.id, "RES-555TRAIN");
    assert.doesNotMatch(JSON.stringify(sale.lastBody()), /NESHER-PAY|JRM-PAY/);
  });

  it("mint JSON and guest charge live on the brand website origin", () => {
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /guestPayOrigin\(/);
    assert.match(src, /build: "2026-09-09-nmi-code-map"/);
    assert.doesNotMatch(
      src.slice(src.indexOf("const stored = await storeInvoice"), src.indexOf("const shareUrl")),
      /publicHostFor\(req\)/
    );
  });

  it("HTTP charge handler never reads amount from the POST body", () => {
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    const start = src.indexOf("Public guest card capture");
    const end = src.indexOf("Public guest invoice");
    assert.ok(start > 0 && end > start);
    const charge = src.slice(start, end);
    assert.match(charge, /paymentToken: body\.payment_token/);
    assert.doesNotMatch(charge, /body\.amount/);
    assert.doesNotMatch(charge, /amountUsd:/);
    assert.match(charge, /chargePayCode\(\{/);
    assert.match(charge, /guestFailBody/);
    assert.match(charge, /guestFailBody\(\{ error: "raw_card_rejected" \}\)/);
    assert.doesNotMatch(charge, /blockedReason \|\| result\.error/);
    assert.doesNotMatch(
      charge,
      /sendJson\(res, 400, \{ ok: false, error: "raw_card_rejected" \}\)/
    );
  });

  it("releases the paidAt claim when the NMI sale fails", async () => {
    const released = [];
    const out = await chargePayCode({
      code: "abc12xyz",
      paymentToken: "tok_collect",
      loadInvoice: async () => ({ ok: true, data: invoice }),
      claimInvoicePaid: async () => ({ ok: true, paidAt: "claim-1" }),
      releaseInvoicePaidClaim: async (code, at) => {
        released.push({ code, at });
        return { ok: true };
      },
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ message: "declined" });
        },
      }),
      privateKey: "test-private-key",
    });
    assert.equal(out.ok, false);
    assert.equal(released.length, 1);
    assert.equal(released[0].at, "claim-1");
  });
});

describe("agent paste leftover", () => {
  it("pastes JRM brand + JRM- ref on a guest URL", () => {
    const text = agentPaste({
      brand: brandFromInvoiceNumber("JRM-189-O50"),
      invoiceNumber: "JRM-189-O50",
      amountUsd: 189,
      cardUrl: "https://www.jrmhotels.com/pay/abc12xyz",
    });
    assert.match(text, /JRM Hotels/);
    assert.match(text, /JRM-189-O50/);
    assert.match(text, /https:\/\/www\.jrmhotels\.com\/pay\/abc12xyz/);
    assert.match(text, /Card processed by Air Today Travel Inc/);
    assert.match(text, /Statement shows FLYNESHER\.COM/);
    assert.match(text, /Bank: Air Today Travel \(Mercury \/ Bank Hapoalim\)/);
    assert.doesNotMatch(text, /JRM HOTELS/);
    assert.doesNotMatch(text, /Pinpoint|NMI/);
    assert.doesNotMatch(text, /square|stripe/i);
  });
});

describe("processed-by copy", () => {
  it("Nesher card-on names Air Today and the live descriptor", () => {
    const f = processedByFacts({
      brand: brandFromInvoiceNumber("RES-1"),
      hasCard: true,
    });
    assert.equal(f.showCard, true);
    assert.equal(f.merchant, "Air Today Travel Inc");
    assert.equal(f.dba, "Nesher Travel");
    assert.equal(f.descriptor, "FLYNESHER.COM");
    assert.equal(f.bankBeneficiary, "Air Today Travel");
    assert.match(
      processedByPasteLine({
        brand: brandFromInvoiceNumber("RES-1"),
        hasCard: true,
      }),
      /FLYNESHER\.COM/
    );
  });

  it("JRM staff paste names FLYNESHER.COM until a JRM MID exists (Joseph 2026-09-08)", () => {
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
    try {
      const f = processedByFacts({
        brand: brandFromInvoiceNumber("JRM-1"),
        hasCard: true,
      });
      assert.equal(f.showCard, true);
      assert.equal(f.descriptor, "FLYNESHER.COM");
      const line = processedByPasteLine({
        brand: brandFromInvoiceNumber("JRM-1"),
        hasCard: true,
      });
      assert.match(line, /Card processed by Air Today Travel Inc/);
      assert.match(line, /Statement shows FLYNESHER\.COM/);
      assert.doesNotMatch(line, /JRM HOTELS/);
    } finally {
      if (prev !== undefined) process.env.NMI_JRM_DESCRIPTOR = prev;
      else delete process.env.NMI_JRM_DESCRIPTOR;
    }
  });

  it("Nesher bank-only drops the card statement line", () => {
    const f = processedByFacts({
      brand: brandFromInvoiceNumber("RES-1"),
      hasCard: false,
    });
    assert.equal(f.showCard, false);
    assert.equal(processedByPasteLine({ brand: brandFromInvoiceNumber("RES-1"), hasCard: false }),
      "Bank: Air Today Travel (Mercury / Bank Hapoalim).");
  });
});
