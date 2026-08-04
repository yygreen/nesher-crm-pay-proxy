import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildHotelQuoteSnapshot,
  buildReservationQuoteSnapshot,
  formatStay,
  resolveCustomerEmail,
} from "../quote.js";
import { injectPayButtons, BUTTON_MARKER } from "../inject.js";

describe("resolveCustomerEmail", () => {
  it("keeps a real email", () => {
    const r = resolveCustomerEmail("  Person@Example.com ", "9FSGMN");
    assert.equal(r.email, "person@example.com");
    assert.equal(r.placeholder, false);
  });
  it("builds booking+ placeholder for missing email", () => {
    const r = resolveCustomerEmail("", "RES-9FSGMN");
    assert.equal(r.email, "booking+res9fsgmn@jrmhotels.com");
    assert.equal(r.placeholder, true);
  });
  it("builds placeholder when email blank", () => {
    const r = resolveCustomerEmail(null, "abc-12");
    assert.equal(r.placeholder, true);
    assert.match(r.email, /^booking\+abc12@jrmhotels\.com$/);
  });
});

describe("quote snapshots", () => {
  it("formats stay range", () => {
    assert.equal(formatStay("2026-08-06", "2026-08-12"), "2026-08-06 → 2026-08-12");
  });

  it("builds hotel snapshot from exact offer", () => {
    const snap = buildHotelQuoteSnapshot(
      {
        request: {
          id: 89,
          customer_name: "Devorah Pruzansky",
          email: "cdpruz@gmail.com",
          city: "Jerusalem",
          check_in: "2026-08-06",
          check_out: "2026-08-12",
          phone: "1",
        },
        offer: {
          id: 50,
          hotel_name: "haneviim",
          customer_price: 7100,
          currency: "Ils",
          vat_status: "Vat included",
          room_type: "suite",
          sent_to_customer: true,
        },
        resolution: "explicit_offer",
      },
      2391.9
    );
    assert.equal(snap.offerId, 50);
    assert.equal(snap.requestId, 89);
    assert.equal(snap.customerPrice, 7100);
    assert.equal(snap.amountUsd, 2391.9);
    assert.equal(snap.customerEmail, "cdpruz@gmail.com");
    assert.match(snap.summary, /Offer #50/);
    assert.match(snap.summary, /haneviim/);
    assert.match(snap.summary, /7100/);
    assert.match(snap.lineItem, /haneviim/);
  });

  it("builds reservation balance snapshot", () => {
    const snap = buildReservationQuoteSnapshot(
      {
        reservation: {
          id: 304,
          reservation_code: "8882XQ",
          customer_name: "Yosey Eagle",
          customer_email: "info@flynesher.com",
        },
        balance: 1507.03,
        quote: { customer_price: 2210, amount_paid: 702.97, balance: 1507.03 },
      },
      1507.03
    );
    assert.equal(snap.reservationCode, "8882XQ");
    assert.equal(snap.balance, 1507.03);
    assert.equal(snap.customerEmail, "info@flynesher.com");
    assert.match(snap.summary, /due \$1507\.03/);
  });

  it("includes journey line prices in summary when priceSource is journeys", () => {
    const snap = buildReservationQuoteSnapshot(
      {
        reservation: {
          id: 346,
          reservation_code: "SVC-194-x",
          customer_name: "Test",
          customer_email: "booking+x@jrmhotels.com",
        },
        balance: 1500,
        quote: {
          customer_price: 1500,
          amount_paid: 0,
          balance: 1500,
          priceSource: "sum(journey.customer_price)",
          journeyLines: [{ id: 1, label: "Ticket feb 5", customer_price: 1500 }],
        },
      },
      1500
    );
    assert.match(snap.summary, /Ticket feb 5/);
    assert.match(snap.summary, /sum\(journey/);
  });
});

describe("inject per-offer buttons", () => {
  it("binds hotel detail buttons to offer ids not only request id", () => {
    const html = `<!doctype html><html><head><title>x</title></head><body>
      <div class="jrm-offer-actions">
        <a href="/jrm/hotels/offer/50/quote/pdf/">Quote PDF</a>
        <a href="/jrm/hotels/offer/50/edit/">Edit</a>
      </div>
      <div class="jrm-offer-actions">
        <a href="/jrm/hotels/offer/51/quote/pdf/">Quote PDF</a>
      </div>
      </body></html>`;
    const out = injectPayButtons(html, "/jrm/hotels/89/");
    assert.match(out, /data-kind="hotel-offer"/);
    assert.match(out, /data-id="50"/);
    assert.match(out, /data-id="51"/);
    assert.equal((out.match(/data-kind="hotel-offer"/g) || []).length, 2);
    assert.match(out, /Mercury Pay \(this quote\)/);
  });
});
