import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { injectPayButtons, BUTTON_MARKER } from "../inject.js";
import { pickUnpaidCustomerPayTarget } from "../db.js";
import { buildCustomerDraft } from "../draft.js";
import { customerInvoiceNumber } from "../mercury.js";
import { brandFromKind, guestPayOrigin, descriptorFor } from "../nmi-card.js";

const LIST_HTML = `<!doctype html><html><head></head><body>
<table class="cust-table">
<tr>
  <td><a href="/customers/212/" class="cust-link">Nisan Bayer</a></td>
  <td>
    <div class="actions-cell">
      <a href="/customers/212/" class="act-btn view">View</a>
      <a href="/customers/212/edit/" class="act-btn edit">Edit</a>
      <a href="/customers/212/delete/" class="act-btn del">Delete</a>
    </div>
  </td>
</tr>
<tr>
  <td><a href="/customers/348/" class="cust-link">Ada Lovelace</a></td>
  <td><a href="/customers/348/" class="act-btn view">View</a></td>
</tr>
</table>
</body></html>`;

const DETAIL_HTML = `<!doctype html><html><head></head><body>
<div class="page-header customer-page-hero">
  <div class="customer-page-label">Customer Page</div>
  <h1 class="customer-page-title">Nisan Bayer</h1>
  <div class="customer-action-bar">
    <a href="/customers/212/edit/" class="btn">Edit</a>
    <a href="/customers/212/payment/add/" class="btn customer-action-pay">Payment</a>
    <a href="/customers/212/delete/" class="btn btn-danger">Delete</a>
  </div>
</div>
</body></html>`;

describe("customerInvoiceNumber", () => {
  it("builds CUST-<id> and rejects junk", () => {
    assert.equal(customerInvoiceNumber(212), "CUST-212");
    assert.equal(customerInvoiceNumber("348"), "CUST-348");
    assert.equal(customerInvoiceNumber(0), null);
    assert.equal(customerInvoiceNumber(-1), null);
    assert.equal(customerInvoiceNumber("x"), null);
  });
});

describe("pickUnpaidCustomerPayTarget", () => {
  it("prefers an unpaid reservation over a hotel quote", () => {
    const picked = pickUnpaidCustomerPayTarget({
      customerId: 9,
      reservations: [
        { id: 10, customer_price: 100, amount_paid: 100, journey_sum: 0 },
        { id: 11, customer_price: 80, amount_paid: 20, journey_sum: 0 },
      ],
      hotelOffers: [
        { offer_id: 50, request_id: 3, customer_price: 400, paid: 0 },
      ],
    });
    assert.equal(picked.kind, "reservation");
    assert.equal(picked.id, 11);
    assert.equal(picked.amountUsd, 60);
    assert.equal(picked.customerId, 9);
  });

  it("uses journey sum when the reservation header has no price", () => {
    const picked = pickUnpaidCustomerPayTarget({
      customerId: 9,
      reservations: [
        { id: 22, customer_price: 0, amount_paid: 10, journey_sum: 55 },
      ],
    });
    assert.equal(picked.kind, "reservation");
    assert.equal(picked.id, 22);
    assert.equal(picked.amountUsd, 45);
  });

  it("falls through to an unpaid hotel offer", () => {
    const picked = pickUnpaidCustomerPayTarget({
      customerId: 9,
      reservations: [
        { id: 10, customer_price: 100, amount_paid: 100, journey_sum: 0 },
      ],
      hotelOffers: [
        { offer_id: 50, request_id: 3, customer_price: 400, paid: 400 },
        { id: 51, request_id: 4, customer_price: 250, paid: 40 },
      ],
    });
    assert.equal(picked.kind, "hotel-offer");
    assert.equal(picked.id, 51);
    assert.equal(picked.requestId, 4);
    assert.equal(picked.amountUsd, 210);
  });

  it("returns the person when nothing is unpaid", () => {
    const picked = pickUnpaidCustomerPayTarget({
      customerId: 212,
      reservations: [
        { id: 1, customer_price: 10, amount_paid: 10, journey_sum: 0 },
      ],
      hotelOffers: [{ offer_id: 2, customer_price: 30, paid: 30 }],
    });
    assert.equal(picked.kind, "customer");
    assert.equal(picked.id, 212);
    assert.equal(picked.amountUsd, 0);
  });
});

describe("buildCustomerDraft", () => {
  const customer = {
    id: 212,
    full_name: "Nisan Bayer",
    email: "nisan@example.com",
    phone: "+15551212",
  };

  it("needs a typed amount and does not mint JRM", () => {
    const d = buildCustomerDraft({ customer });
    assert.equal(d.kind, "customer");
    assert.equal(d.canCreate, false);
    assert.equal(d.needsInput, true);
    assert.equal(d.draft.invoiceNumber, "CUST-212");
    assert.equal(d.draft.customerName, "Nisan Bayer");
    assert.equal(d.draft.amountUsd, 0);
    assert.ok(d.missing.some((m) => m.field === "amountUsd" && m.required));
    assert.match(d.advice[0], /No unpaid booking/);
    assert.doesNotMatch(d.draft.invoiceNumber, /^JRM-/);
    assert.equal(brandFromKind("customer", d.draft.invoiceNumber).id, "nesher");
  });

  it("can create a Nesher-locked amount with email", () => {
    const d = buildCustomerDraft(
      { customer },
      { amountUsd: 55.55, customerEmail: "nisan@example.com" }
    );
    assert.equal(d.canCreate, true);
    assert.equal(d.needsInput, false);
    assert.equal(d.draft.amountUsd, 55.55);
    assert.equal(d.draft.lineItems[0].unitPrice, 55.55);
    assert.match(d.draft.payerMemo, /Nisan Bayer/);
    assert.match(d.draft.payerMemo, /CUST-212/);
    assert.doesNotMatch(JSON.stringify(d), /\/pay\/open/);
  });
});

describe("injectPayButtons — customer list and detail", () => {
  it("injects one Send pay link button per name on the list, not on View/Edit", () => {
    const out = injectPayButtons(LIST_HTML, "/customers/");
    assert.match(out, new RegExp(BUTTON_MARKER));
    assert.match(out, /data-kind="customer"/);
    assert.match(out, /data-id="212"/);
    assert.match(out, /data-id="348"/);
    assert.match(out, /Send pay link/);
    assert.doesNotMatch(out, /Mercury Pay/);
    assert.match(out, /nesher-mercury-pay-js/);
    assert.match(out, /Create payment link/);
    assert.match(out, /\/__nesher_pay\/customer\//);
    const buttons = out.match(/data-kind="customer"/g) || [];
    assert.equal(buttons.length, 2);
    assert.doesNotMatch(
      out.slice(out.indexOf('class="act-btn view"'), out.indexOf('class="act-btn edit"')),
      /data-kind="customer"/
    );
  });

  it("injects Send pay link on customer detail next to Payment", () => {
    const out = injectPayButtons(DETAIL_HTML, "/customers/212/");
    assert.match(out, new RegExp(BUTTON_MARKER));
    assert.match(out, /data-kind="customer"/);
    assert.match(out, /data-id="212"/);
    assert.match(out, /Send pay link/);
    assert.doesNotMatch(out, /Mercury Pay/);
    assert.match(out, /customer-action-pay[\s\S]*data-kind="customer"/);
    assert.equal((out.match(/data-kind="customer"/g) || []).length, 1);
  });

  it("is idempotent on the customer list", () => {
    const once = injectPayButtons(LIST_HTML, "/customers/");
    const twice = injectPayButtons(once, "/customers/");
    assert.equal((twice.match(/nesher-mercury-pay-js/g) || []).length, 1);
    assert.equal((twice.match(/data-kind="customer"/g) || []).length, 2);
  });

  it("does not treat add/edit as a name row", () => {
    const html = `<html><body>
      <h1>Add Customer</h1>
      <a href="/customers/212/" class="cust-link">Nisan Bayer</a>
      </body></html>`;
    const out = injectPayButtons(html, "/customers/add/");
    assert.doesNotMatch(out, /data-kind="customer"/);
  });

  it("does not treat reservation payments/add as a customer page", () => {
    const html = `<html><body>
      <h1>Add Payment</h1>
      <a href="#payment-form">Add First Payment</a>
      <a href="/customers/212/" class="cust-link">Nisan</a>
      </body></html>`;
    const out = injectPayButtons(html, "/reservations/99/payments/add/");
    assert.match(out, /data-kind="reservation"/);
    assert.match(out, /data-id="99"/);
    assert.doesNotMatch(out, /data-kind="customer"/);
  });
});

describe("customer pay mint path wiring", () => {
  it("staff teal buttons say Send pay link / Card or bank link, never Mercury Pay", () => {
    const src = fs.readFileSync(new URL("../inject.js", import.meta.url), "utf8");
    assert.match(src, /Send pay link/);
    assert.match(src, /Card or bank link/);
    assert.match(src, /Create payment link/);
    assert.doesNotMatch(src, /Mercury Pay/);
    assert.doesNotMatch(src, /Send card\/bank pay link/);
    assert.doesNotMatch(src, /"Pay due"/);
    assert.doesNotMatch(src, /"Pay quote"/);
  });

  it("staffCore includes the customer list and the customer API kind", () => {
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.ok(src.includes("/^\\/customers\\/?$/.test(pathOnly)"));
    assert.ok(src.includes("hotel-offer|hotel|reservation|customer"));
    assert.ok(src.includes("loadCustomerPayTarget"));
    assert.ok(src.includes("buildCustomerDraft"));
    assert.ok(src.includes('build: "2026-09-10-address-group"'));
    assert.ok(!/NMI_JRM_DESCRIPTOR\s*=/.test(src));
  });

  it("customer mint is Nesher card+bank; hotel-offer also FLYNESHER.COM until a JRM MID", () => {
    assert.equal(brandFromKind("customer", "CUST-1").id, "nesher");
    assert.equal(
      guestPayOrigin(brandFromKind("customer", "CUST-1")),
      "https://www.flynesher.com"
    );
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
    try {
      assert.equal(descriptorFor(brandFromKind("customer", "CUST-1")), "FLYNESHER.COM");
      assert.equal(descriptorFor(brandFromKind("hotel-offer", "JRM-1")), "FLYNESHER.COM");
    } finally {
      if (prev !== undefined) process.env.NMI_JRM_DESCRIPTOR = prev;
      else delete process.env.NMI_JRM_DESCRIPTOR;
    }
  });
});
