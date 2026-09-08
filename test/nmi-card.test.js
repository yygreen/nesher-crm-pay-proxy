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

  it("v5 payment_descriptor is Nesher until JRM DBA is set", () => {
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
    try {
      assert.deepEqual(paymentDescriptorPayload(BRANDS.nesher), {
        descriptor: "FLYNESHER.COM",
        url: "https://www.flynesher.com",
      });
      assert.equal(paymentDescriptorPayload(BRANDS.jrm), null);
      process.env.NMI_JRM_DESCRIPTOR = "JRM HOTELS";
      assert.deepEqual(paymentDescriptorPayload(BRANDS.jrm), {
        descriptor: "JRM HOTELS",
        url: "https://www.jrmhotels.com",
      });
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
    assert.equal(body.merchant_defined_fields.field_1, "nesher");
    assert.equal(body.merchant_defined_fields.field_2, "RES-9FSGMN");
    assert.equal(body.merchant_defined_fields.field_3, "RES-9FSGMN");
    assert.equal(body.merchant_defined_fields.field_4, "Ada Lovelace");
    assert.notEqual(body.merchant_defined_fields.field_1, "RES-9FSGMN");
    assert.notEqual(body.merchant_defined_fields.field_3, "FLYNESHER.COM");
    assert.deepEqual(body.payment_descriptor, {
      descriptor: "FLYNESHER.COM",
      url: "https://www.flynesher.com",
    });
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
    const jrmBlocked = staffCardFields({
      ok: false,
      error: "second_dba_pending",
      blockedReason:
        "JRM card links wait on a Pinpoint second DBA / statement descriptor. Nesher (FLYNESHER.COM) can mint.",
    });
    assert.equal(jrmBlocked.cardBlockedReason, "second_dba_pending");
    assert.doesNotMatch(jrmBlocked.cardBlockedReason || "", /flynesher/i);
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
    assert.equal(sale.calls(), 1);
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
      assert.deepEqual(sale.lastBody().payment_descriptor, {
        descriptor: "JRM HOTELS",
        url: "https://www.jrmhotels.com",
      });
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
    assert.match(src, /build: "2026-09-08-open-pay"/);
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
    assert.match(text, /Bank: Air Today Travel \(Mercury \/ Bank Hapoalim\)/);
    assert.doesNotMatch(text, /Card processed/);
    assert.doesNotMatch(text, /flynesher\.com/i);
    assert.doesNotMatch(text, /FLYNESHER/);
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

  it("JRM never prints a card processor or flynesher.com descriptor", () => {
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    process.env.NMI_JRM_DESCRIPTOR = "JRM HOTELS";
    try {
      const f = processedByFacts({
        brand: brandFromInvoiceNumber("JRM-1"),
        hasCard: true,
      });
      assert.equal(f.showCard, false);
      assert.equal(f.descriptor, null);
      const line = processedByPasteLine({
        brand: brandFromInvoiceNumber("JRM-1"),
        hasCard: true,
      });
      assert.match(line, /Bank: Air Today Travel/);
      assert.doesNotMatch(line, /Card processed/);
      assert.doesNotMatch(line, /flynesher/i);
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
