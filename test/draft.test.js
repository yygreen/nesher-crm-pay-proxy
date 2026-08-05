import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReservationDraft,
  buildHotelDraft,
  mercuryOptsFromDraft,
} from "../draft.js";
import { buildLineItems } from "../mercury.js";
import { injectPayButtons, BUTTON_MARKER } from "../inject.js";

describe("buildReservationDraft — rich + flexible", () => {
  const baseCtx = {
    reservation: {
      id: 345,
      reservation_code: "9FSGMN",
      customer_name: "Ada Lovelace",
      customer_email: "ada@example.com",
      phone: "+15551212",
      booking_method: "phone",
    },
    quote: {
      customer_price: 2604,
      amount_paid: 0,
      balance: 2604,
      priceSource: "sum(journey.customer_price)",
      journeyLines: [
        { id: 1, label: "TLV-JFK ticket", customer_price: 1800, confirmation_number: "ABC" },
        { id: 2, label: "Hotel night", customer_price: 804 },
      ],
      travelers: [{ full_name: "Ada Lovelace" }, { full_name: "Charles Babbage" }],
      flights: [
        {
          airline: "LY",
          flight_number: "001",
          from_location: "TLV",
          to_location: "JFK",
          departure_date: "2026-09-01",
          departure_time: "23:00",
        },
      ],
    },
    warnings: [],
  };

  it("packs booking number, travelers, flights into memo", () => {
    const d = buildReservationDraft(baseCtx);
    assert.equal(d.canCreate, true);
    assert.equal(d.needsInput, false);
    assert.match(d.draft.payerMemo, /9FSGMN/);
    assert.match(d.draft.payerMemo, /Ada Lovelace/);
    assert.match(d.draft.payerMemo, /Charles Babbage/);
    assert.match(d.draft.payerMemo, /LY 001/);
    assert.match(d.draft.payerMemo, /TLV.*JFK/);
    assert.match(d.draft.payerMemo, /conf ABC/);
    assert.equal(d.draft.invoiceNumber, "RES-9FSGMN");
    assert.ok(d.draft.lineItems.length >= 1);
    assert.equal(d.draft.amountUsd, 2604);
  });

  it("does not hard-fail when price is missing — lists required amount", () => {
    const ctx = {
      reservation: {
        id: 99,
        reservation_code: "NOPRICE",
        customer_name: "",
        customer_email: null,
        phone: null,
      },
      quote: {
        customer_price: 0,
        amount_paid: 0,
        balance: 0,
        journeyLines: [],
        travelers: [],
        flights: [],
      },
      warnings: ["No customer price"],
    };
    const d = buildReservationDraft(ctx);
    assert.equal(d.canCreate, false);
    assert.equal(d.needsInput, true);
    assert.ok(d.missing.some((m) => m.field === "amountUsd" && m.required));
    assert.ok(d.missing.some((m) => m.field === "customerEmail"));
    assert.match(d.draft.customerEmail, /booking\+.*@jrmhotels\.com/);
    assert.equal(d.draft.emailPlaceholder, true);
  });

  it("accepts staff overrides for amount and email", () => {
    const ctx = {
      reservation: {
        id: 1,
        reservation_code: "X",
        customer_name: null,
        customer_email: null,
      },
      quote: {
        customer_price: 0,
        amount_paid: 0,
        balance: 0,
        journeyLines: [],
        travelers: [],
        flights: [],
      },
    };
    const d = buildReservationDraft(ctx, {
      amountUsd: 500,
      customerEmail: "real@customer.com",
      customerName: "Real Name",
      payerMemo: "Rush payment",
    });
    assert.equal(d.canCreate, true);
    assert.equal(d.needsInput, false);
    assert.equal(d.draft.amountUsd, 500);
    assert.equal(d.draft.customerEmail, "real@customer.com");
    assert.equal(d.draft.emailPlaceholder, false);
    assert.match(d.draft.payerMemo, /Rush payment/);
    assert.match(d.draft.payerMemo, /Real Name/);
  });
});

describe("buildHotelDraft — soft unpriced", () => {
  it("allows create with manual amount when offer has no price", async () => {
    const ctx = {
      request: {
        id: 89,
        customer_name: "Guest",
        email: "g@ex.com",
        phone: "1",
        city: "Jerusalem",
        check_in: "2026-09-10",
        check_out: "2026-09-15",
      },
      offer: {
        id: 50,
        hotel_name: "Inbal",
        customer_price: 0,
        currency: "USD",
        room_type: "Deluxe",
      },
      resolution: "explicit_offer",
    };
    const empty = await buildHotelDraft(ctx);
    assert.equal(empty.canCreate, false);
    assert.ok(empty.missing.some((m) => m.field === "amountUsd"));

    const filled = await buildHotelDraft(ctx, { amountUsd: 1200 });
    assert.equal(filled.canCreate, true);
    assert.match(filled.draft.payerMemo, /Inbal/);
    assert.match(filled.draft.payerMemo, /2026-09-10/);
    assert.match(filled.draft.payerMemo, /Jerusalem/);
    assert.equal(filled.draft.invoiceNumber, "JRM-189-O50");
  });

  it("pre-fills amount from hotel_price when customer_price missing", async () => {
    const d = await buildHotelDraft({
      request: { id: 87, customer_name: "Guest", email: "g@ex.com" },
      offer: {
        id: 46,
        hotel_name: "Inbal",
        customer_price: null,
        hotel_price: 1000,
        currency: "USD",
      },
      resolution: "hotel_price_only",
      payments: { paidUsd: 0, otherCurrencyCount: 0 },
    });
    assert.equal(d.draft.amountUsd, 1000);
    assert.equal(d.canCreate, true);
    assert.equal(d.draft.amountSource, "offer.hotel_price");
    assert.ok(d.advice.some((a) => /hotel's own price/.test(a)));
  });

  it("deducts recorded USD payments from the auto amount", async () => {
    const base = {
      request: { id: 87, customer_name: "Guest", email: "g@ex.com" },
      offer: { id: 46, hotel_name: "Inbal", customer_price: 1200, currency: "USD" },
      resolution: "explicit_offer",
      payments: { paidUsd: 400, otherCurrencyCount: 0 },
    };
    const d = await buildHotelDraft(base);
    assert.equal(d.draft.amountUsd, 800);
    assert.equal(d.draft.details.amountPaid, 400);
    assert.match(d.draft.payerMemo, /Paid to date: \$400\.00/);
    assert.match(d.draft.payerMemo, /Balance due: \$800\.00/);

    // Fully paid — soft-asks for a new amount instead of charging $0
    const paidUp = await buildHotelDraft({
      ...base,
      payments: { paidUsd: 1200, otherCurrencyCount: 0 },
    });
    assert.equal(paidUp.canCreate, false);
    assert.ok(paidUp.missing.some((m) => m.field === "amountUsd" && /already cover/.test(m.reason)));

    // Staff override wins untouched — no deduction applied
    const over = await buildHotelDraft(base, { amountUsd: 500 });
    assert.equal(over.draft.amountUsd, 500);
    assert.equal(over.draft.details.amountPaid, 0);
  });
});

describe("buildLineItems multi", () => {
  it("uses multiple line items when provided", () => {
    const items = buildLineItems({
      amountUsd: 100,
      lineItems: [
        { name: "A", unitPrice: 40 },
        { name: "B", unitPrice: 60 },
      ],
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].unitPrice, 40);
  });
});

describe("mercuryOptsFromDraft", () => {
  it("maps draft to mercury create opts", () => {
    const opts = mercuryOptsFromDraft("tok", {
      draft: {
        customerName: "A",
        customerEmail: "a@b.com",
        invoiceNumber: "RES-X",
        amountUsd: 10,
        lineItemName: "Line",
        lineItems: [{ name: "Line", unitPrice: 10, quantity: 1 }],
        payerMemo: "memo",
      },
    });
    assert.equal(opts.token, "tok");
    assert.equal(opts.invoiceNumber, "RES-X");
    assert.equal(opts.amountUsd, 10);
  });
});

describe("inject modal assets", () => {
  it("injects modal CSS/JS and buttons", () => {
    const html =
      "<html><head></head><body><h1>Res</h1><a href=\"/reservations/12/payments/add/\">Add</a></body></html>";
    const out = injectPayButtons(html, "/reservations/12/");
    assert.ok(out.includes(BUTTON_MARKER));
    assert.ok(out.includes("nesher-pay-modal"));
    assert.ok(out.includes("Complete invoice details") || out.includes("nesher-f-amount") || out.includes("What still needs attention") || out.includes("nesher-pay-create"));
  });
});
