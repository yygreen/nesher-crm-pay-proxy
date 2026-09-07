import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  brandFromInvoiceNumber,
  brandFromKind,
  descriptorFor,
  isAllowedCardUrl,
  hostedInvoiceUrl,
  mintCardCheckout,
  chargeWithToken,
  chargeGuestInvoice,
  looksLikePan,
  agentPaste,
  stripDeadCardFields,
  NMI_HOST,
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
  });

  it("blocks JRM card mint until a second descriptor is configured", () => {
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
    try {
      assert.equal(descriptorFor(brandFromInvoiceNumber("JRM-1")), null);
      assert.equal(
        descriptorFor(brandFromInvoiceNumber("RES-1")),
        "FLYNESHER.COM"
      );
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

  it("does not mint a JRM card URL under the Nesher descriptor", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    let called = 0;
    const out = await mintCardCheckout({
      amountUsd: 100,
      invoiceNumber: "JRM-189-O50",
      kind: "hotel",
      fetchImpl: async () => {
        called += 1;
        throw new Error("should not hit NMI");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "second_dba_pending");
    assert.equal(out.cardUrl, null);
    assert.equal(out.brand.id, "jrm");
    assert.equal(called, 0);
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
  });

  it("does not charge JRM until a second descriptor is configured", async () => {
    process.env.NMI_PRIVATE_KEY = "test-private-key";
    let called = 0;
    const out = await chargeWithToken({
      amountUsd: 189,
      invoiceNumber: "JRM-189-O50",
      kind: "hotel",
      paymentToken: "tok_collect",
      fetchImpl: async () => {
        called += 1;
        throw new Error("should not hit NMI");
      },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error, "second_dba_pending");
    assert.equal(called, 0);
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
    assert.doesNotMatch(text, /square|stripe/i);
    assert.equal(text.split("\n").filter(Boolean).length, 2);
    assert.equal(hostedInvoiceUrl("1").includes("invoice_id=1"), true);
  });

  it("pastes JRM brand + JRM- ref on a guest URL", () => {
    const text = agentPaste({
      brand: brandFromInvoiceNumber("JRM-189-O50"),
      invoiceNumber: "JRM-189-O50",
      amountUsd: 189,
      cardUrl: "https://www.flynesher.com/pay/abc12xyz",
    });
    assert.match(text, /JRM Hotels/);
    assert.match(text, /JRM-189-O50/);
    assert.match(text, /https:\/\/www\.flynesher\.com\/pay\/abc12xyz/);
    assert.doesNotMatch(text, /square|stripe/i);
  });
});
