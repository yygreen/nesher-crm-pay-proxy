import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mintInvoiceToken,
  verifyInvoiceToken,
  buildCombinedPayUrl,
  renderInvoiceHtml,
} from "../invoice-page.js";

describe("unified invoice token", () => {
  it("round-trips a bank-only payload", () => {
    process.env.PAY_PAGE_SECRET = "test-secret-for-invoice-page";
    const token = mintInvoiceToken({
      amountUsd: 2604.5,
      invoiceNumber: "JRM-189-O50",
      customerName: "Sarah Cohen",
      summary: "King David · Aug 12–15",
      mercuryUrl: "https://app.mercury.com/pay/abc",
    });
    const v = verifyInvoiceToken(token);
    assert.equal(v.ok, true);
    assert.equal(v.data.amountUsd, 2604.5);
    assert.equal(v.data.invoiceNumber, "JRM-189-O50");
    assert.equal(v.data.mercuryUrl, "https://app.mercury.com/pay/abc");
    const url = buildCombinedPayUrl("https://www.flynesher.com", token);
    assert.match(url, /^https:\/\/www\.flynesher\.com\/pay\//);
  });

  it("ignores dead Square card fields even if a caller still passes them", () => {
    process.env.PAY_PAGE_SECRET = "test-secret-for-invoice-page";
    const token = mintInvoiceToken({
      amountUsd: 100,
      invoiceNumber: "RES-1",
      mercuryUrl: "https://app.mercury.com/pay/a",
      squareUrl: "https://square.link/u/dead",
      cardProcessor: "square",
    });
    const v = verifyInvoiceToken(token);
    assert.equal(v.ok, true);
    assert.equal(v.data.squareUrl, undefined);
    assert.equal(v.data.cardProcessor, undefined);
    assert.ok(!token.includes("square"));
  });

  it("rejects tampered tokens", () => {
    process.env.PAY_PAGE_SECRET = "test-secret-for-invoice-page";
    const token = mintInvoiceToken({
      amountUsd: 10,
      invoiceNumber: "X",
      mercuryUrl: "https://app.mercury.com/pay/a",
    });
    const bad = token.slice(0, -4) + "xxxx";
    assert.equal(verifyInvoiceToken(bad).ok, false);
  });

  it("renders bank-only on the guest page", () => {
    const html = renderInvoiceHtml({
      amountUsd: 100,
      invoiceNumber: "RES-1",
      customerName: "Test",
      summary: "Flights",
      mercuryUrl: "https://app.mercury.com/pay/a",
    });
    assert.match(html, /Pay with bank/);
    assert.match(html, /mercury\.com\/pay\/a/);
    assert.match(html, /\$100\.00/);
    assert.match(html, /Nesher/);
    assert.doesNotMatch(html, /Pay with card/);
  });

  it("brands a JRM invoice as JRM Hotels even without a card URL", () => {
    const html = renderInvoiceHtml({
      amountUsd: 189,
      invoiceNumber: "JRM-189-O50",
      mercuryUrl: "https://app.mercury.com/pay/a",
      brandId: "jrm",
    });
    assert.match(html, /JRM Hotels/);
    assert.doesNotMatch(html, /Nesher · JRM Hotels/);
    assert.doesNotMatch(html, /Pay with card/);
    assert.match(html, /Pay with bank/);
  });

  it("never renders a card button even from a legacy Square-era record", () => {
    // Old DB rows / signed tokens may still carry squareUrl — the account is
    // closed, so the renderer must drop it on the floor.
    const html = renderInvoiceHtml({
      amountUsd: 250,
      invoiceNumber: "JRM-OLD-1",
      mercuryUrl: "https://app.mercury.com/pay/b",
      squareUrl: "https://square.link/u/dead",
      cardProcessor: "square",
    });
    assert.doesNotMatch(html, /Pay with card/);
    assert.doesNotMatch(html, /square\.link/);
    assert.match(html, /Pay with bank/);
  });

  it("renders Pay with card for an NMI hosted URL and keeps Mercury bank", () => {
    const html = renderInvoiceHtml({
      amountUsd: 2604.5,
      invoiceNumber: "RES-9FSGMN",
      customerName: "Ada",
      summary: "Flights",
      mercuryUrl: "https://app.mercury.com/pay/a",
      cardUrl:
        "https://pinpointpayments.transactiongateway.com/cart/invoicing.php?invoice_id=5550199",
      brandId: "nesher",
    });
    assert.match(html, /Pay with card/);
    assert.match(html, /pinpointpayments\.transactiongateway\.com/);
    assert.match(html, /Pay with bank/);
    assert.match(html, /mercury\.com\/pay\/a/);
    assert.match(html, /Nesher/);
    assert.doesNotMatch(html, /square\.link/);
  });

  it("round-trips an NMI card URL on the signed token and drops Square", () => {
    process.env.PAY_PAGE_SECRET = "test-secret-for-invoice-page";
    const token = mintInvoiceToken({
      amountUsd: 50,
      invoiceNumber: "RES-CARD",
      mercuryUrl: "https://app.mercury.com/pay/a",
      cardUrl:
        "https://pinpointpayments.transactiongateway.com/cart/invoicing.php?invoice_id=9",
      squareUrl: "https://square.link/u/dead",
    });
    const v = verifyInvoiceToken(token);
    assert.equal(v.ok, true);
    assert.match(v.data.cardUrl, /pinpointpayments\.transactiongateway\.com/);
    assert.equal(v.data.squareUrl, undefined);
    assert.ok(!token.includes("square"));
  });

  it("renders Collect.js on the branded guest page when invoices are not hosted", () => {
    const html = renderInvoiceHtml({
      amountUsd: 12.34,
      invoiceNumber: "RES-555QA",
      customerName: "Ada",
      mercuryUrl: "https://app.mercury.com/pay/a",
      capture: "collectjs",
      collectPublicKey: "pk_test_collect",
      brandId: "nesher",
    });
    assert.match(html, /Pay with card/);
    assert.match(html, /token\/Collect\.js/);
    assert.match(html, /data-tokenization-key="pk_test_collect"/);
    assert.match(html, /Pay with bank/);
    assert.match(html, /mercury\.com\/pay\/a/);
    assert.match(html, /Nesher/);
    assert.match(html, /\/charge/);
    assert.match(html, /payment_token/);
    assert.doesNotMatch(html, /square\.link|squareup|checkout\.stripe/i);
    assert.doesNotMatch(html, /NESHER-PAY|JRM-PAY/);
    assert.doesNotMatch(html, /customPayment/);
    assert.doesNotMatch(html, /<input[^>]*(amount|ccnumber)/i);
    assert.doesNotMatch(html, /NMI_PRIVATE/);
  });

  it("does not render Collect.js for JRM while second DBA is pending", () => {
    const prev = process.env.NMI_JRM_DESCRIPTOR;
    delete process.env.NMI_JRM_DESCRIPTOR;
    try {
      const html = renderInvoiceHtml({
        amountUsd: 189,
        invoiceNumber: "JRM-189-O50",
        mercuryUrl: "https://app.mercury.com/pay/a",
        capture: "collectjs",
        collectPublicKey: "pk_test_collect",
        brandId: "jrm",
      });
      assert.doesNotMatch(html, /Collect\.js/);
      assert.doesNotMatch(html, /Pay with card/);
      assert.match(html, /Pay with bank/);
      assert.match(html, /JRM Hotels/);
    } finally {
      if (prev !== undefined) process.env.NMI_JRM_DESCRIPTOR = prev;
      else delete process.env.NMI_JRM_DESCRIPTOR;
    }
  });

  it("prefers a hosted NMI invoice URL over Collect.js", () => {
    const html = renderInvoiceHtml({
      amountUsd: 50,
      invoiceNumber: "RES-9FSGMN",
      mercuryUrl: "https://app.mercury.com/pay/a",
      cardUrl:
        "https://pinpointpayments.transactiongateway.com/cart/invoicing.php?invoice_id=1",
      capture: "collectjs",
      collectPublicKey: "pk_test_collect",
    });
    assert.match(html, /invoicing\.php/);
    assert.match(html, /Pay with card/);
    assert.match(html, /Pay with bank/);
    assert.doesNotMatch(html, /Collect\.js/);
  });

  it("does not paint Collect.js without a public key (long-token / keys unset)", () => {
    const html = renderInvoiceHtml({
      amountUsd: 12.34,
      invoiceNumber: "RES-555QA",
      mercuryUrl: "https://app.mercury.com/pay/a",
      capture: "collectjs",
      collectPublicKey: "",
      brandId: "nesher",
    });
    assert.doesNotMatch(html, /Collect\.js/);
    assert.doesNotMatch(html, /Pay with card/);
    assert.match(html, /Pay with bank/);
  });

  it("hides card capture after paidAt", () => {
    const html = renderInvoiceHtml({
      amountUsd: 10,
      invoiceNumber: "RES-1",
      mercuryUrl: "https://app.mercury.com/pay/a",
      capture: "collectjs",
      collectPublicKey: "pk_test_collect",
      paidAt: "2026-09-08T00:00:00Z",
    });
    assert.doesNotMatch(html, /Collect\.js/);
    assert.doesNotMatch(html, /Pay with card/);
    assert.doesNotMatch(html, /Pay with bank/);
    assert.match(html, /Paid/);
  });

  it("round-trips collectjs capture on the signed token", () => {
    process.env.PAY_PAGE_SECRET = "test-secret-for-invoice-page";
    const token = mintInvoiceToken({
      amountUsd: 50,
      invoiceNumber: "RES-CARD",
      mercuryUrl: "https://app.mercury.com/pay/a",
      capture: "collectjs",
    });
    const v = verifyInvoiceToken(token);
    assert.equal(v.ok, true);
    assert.equal(v.data.capture, "collectjs");
    assert.doesNotMatch(token, /pk_test|NMI_PUBLIC|collectPublicKey/);
  });

  it("builds Nesher guest URLs on flynesher.com and JRM on jrmhotels.com", () => {
    assert.equal(
      buildCombinedPayUrl("https://www.flynesher.com", "abc12xyz"),
      "https://www.flynesher.com/pay/abc12xyz"
    );
    assert.equal(
      buildCombinedPayUrl("https://www.jrmhotels.com", "jrm12xyz"),
      "https://www.jrmhotels.com/pay/jrm12xyz"
    );
    assert.equal(
      buildCombinedPayUrl("https://evil.example", "x"),
      "https://www.flynesher.com/pay/x"
    );
  });

  it("paints JRM guest chrome without Collect.js while DBA is pending", () => {
    const html = renderInvoiceHtml({
      amountUsd: 189,
      invoiceNumber: "JRM-189-O50",
      mercuryUrl: "https://app.mercury.com/pay/a",
      brandId: "jrm",
      kind: "hotel",
    });
    assert.match(html, /pay-brand-jrm/);
    assert.match(html, /JRM Hotels/);
    assert.match(html, /#5C4528/);
    assert.doesNotMatch(html, /Collect\.js/);
    assert.doesNotMatch(html, /Nesher · FlyNesher/);
  });
});
