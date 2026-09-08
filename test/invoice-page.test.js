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
    assert.match(html, /alt="Nesher Travel"/);
    assert.match(html, /assets\.flynesher\.com\/nesher-logo\.jpg/);
    assert.doesNotMatch(html, /Pay with card/);
    assert.doesNotMatch(html, /Card processed by/);
    assert.doesNotMatch(html, /Your card statement shows/);
  });

  it("brands a JRM invoice as JRM Hotels even without a card URL", () => {
    const html = renderInvoiceHtml({
      amountUsd: 189,
      invoiceNumber: "JRM-189-O50",
      mercuryUrl: "https://app.mercury.com/pay/a",
      brandId: "jrm",
    });
    assert.match(html, /alt="JRM Hotels"/);
    assert.match(html, /jrmhotels\.com\/images\/logos\/jrm-logo\.png/);
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
    assert.match(html, /class="card-row"/);
    assert.match(html, /customCss:/);
    assert.doesNotMatch(html, /square\.link|squareup|checkout\.stripe/i);
    assert.doesNotMatch(html, /NESHER-PAY|JRM-PAY/);
    assert.doesNotMatch(html, /customPayment/);
    assert.doesNotMatch(html, /<input[^>]*(amount|ccnumber|ccexp|cvv|pan)/i);
    assert.doesNotMatch(html, /NMI_PRIVATE/);
  });

  it("Collect.js fields sit in a two-column card-row with iframe CSS, not a stacked PAN input", () => {
    const html = renderInvoiceHtml({
      amountUsd: 55.55,
      invoiceNumber: "RES-555TRAIN",
      customerName: "Ada",
      mercuryUrl: "https://app.mercury.com/pay/a",
      capture: "collectjs",
      collectPublicKey: "pk_test_collect",
      brandId: "nesher",
    });
    assert.match(html, /class="card-row"/);
    assert.match(html, /class="card-col"/);
    assert.match(html, /id="ccnumber" class="card-field"/);
    assert.match(html, /id="ccexp" class="card-field"/);
    assert.match(html, /id="cvv" class="card-field"/);
    assert.match(html, /styleSniffer:\s*true/);
    assert.match(html, /customCss:/);
    assert.match(html, /placeholderCss:/);
    assert.match(html, /focusCss:/);
    assert.match(html, /invalidCss:/);
    assert.match(html, /"font-size":"16px"/);
    assert.match(html, /placeholder:"ACCT-000003"/);
    assert.match(html, /placeholder:"MM \/ YY"/);
    assert.match(html, /placeholder:"123"/);
    assert.match(html, /grid-template-columns:\s*1fr 1fr/);
    assert.match(html, /\.card-field:focus-within/);
    assert.match(html, /body\.pay-brand-jrm \.card-field:focus-within/);
    assert.match(html, /JSON\.stringify\(\{payment_token:token\}\)/);
    assert.match(html, /charAt\(0\)==="\{"/);
    assert.match(html, /Nothing is wrong on our side/);
    assert.match(html, /We're missing something: card details/);
    assert.match(html, /problem on our side/);
    assert.doesNotMatch(html, /x\.j\.error/);
    assert.doesNotMatch(html, /placeholder:"Card number"/);
    assert.doesNotMatch(html, /placeholder:"CVV"/);
    assert.doesNotMatch(html, /<input\b/i);
    assert.doesNotMatch(html, /name=["']ccnumber["']/i);
    assert.doesNotMatch(html, /creditCardEnabled/);
    assert.doesNotMatch(html, /googlePay|applePay|vault/i);
  });

  it("renders Collect.js for JRM-189 on Nesher FLYNESHER.COM without a guest sermon (Joseph 2026-09-08)", () => {
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
        kind: "hotel",
      });
      assert.match(html, /Collect\.js/);
      assert.match(html, /Pay with bank/);
      assert.match(html, /alt="JRM Hotels"/);
      assert.match(html, /src="https:\/\/jrmhotels\.com\/images\/logos\/jrm-logo\.png"/);
      assert.doesNotMatch(html, /Card processed by/);
      assert.doesNotMatch(html, /Your card statement shows/);
      assert.doesNotMatch(html, /FLYNESHER\.COM/);
      assert.doesNotMatch(html, /Nesher Travel/);
      assert.doesNotMatch(html, /JRM HOTELS/);
      assert.doesNotMatch(html, /<input\b/i);
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
    assert.match(html, /Payment received\. Thank you\./);
    assert.doesNotMatch(html, /Paid\. Thank you\./);
    assert.doesNotMatch(html, /Card processed by/);
    assert.doesNotMatch(html, /Your card statement shows/);
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

  it("guest Nesher page shows the real logo img and no processed-by sermon", () => {
    const html = renderInvoiceHtml({
      amountUsd: 55.55,
      invoiceNumber: "RES-555TRAIN",
      customerName: "Ada",
      mercuryUrl: "https://app.mercury.com/pay/a",
      capture: "collectjs",
      collectPublicKey: "pk_test_collect",
      brandId: "nesher",
    });
    assert.match(html, /<p class="logo"><img /);
    assert.match(html, /src="https:\/\/assets\.flynesher\.com\/nesher-logo\.jpg"/);
    assert.match(html, /alt="Nesher Travel"/);
    assert.match(html, /height="40"/);
    assert.match(
      html,
      /data-fallback="https:\/\/www\.flynesher\.com\/static\/core\/images\/nesher_logo\.png"/
    );
    assert.match(html, /Questions\? Reply to your booking message\./);
    assert.doesNotMatch(html, /<p class="logo">Nesher/);
    assert.doesNotMatch(html, /Nesher · FlyNesher/);
    assert.doesNotMatch(html, /processed-by/);
    assert.doesNotMatch(html, /Card processed by/);
    assert.doesNotMatch(html, /Your card statement shows/);
    assert.doesNotMatch(html, /FLYNESHER\.COM/);
    assert.doesNotMatch(html, /Bank transfer is Mercury/);
    assert.doesNotMatch(html, /beneficiary <strong>Air Today Travel/);
    assert.doesNotMatch(html, /Pinpoint\/NMI/);
    assert.doesNotMatch(html, /JRM HOTELS/);
  });

  it("guest JRM page shows the JRM logo img and no sermon", () => {
    const html = renderInvoiceHtml({
      amountUsd: 189,
      invoiceNumber: "JRM-189-O50",
      mercuryUrl: "https://app.mercury.com/pay/a",
      brandId: "jrm",
      kind: "hotel",
    });
    assert.match(html, /<p class="logo"><img /);
    assert.match(html, /src="https:\/\/jrmhotels\.com\/images\/logos\/jrm-logo\.png"/);
    assert.match(html, /alt="JRM Hotels"/);
    assert.match(html, /height="40"/);
    assert.match(html, /body\.pay-brand-jrm \.logo img/);
    assert.match(html, /filter: brightness\(0\) sepia\(1\)/);
    assert.match(html, /Questions\? Reply to your booking message\./);
    assert.doesNotMatch(html, /processed-by/);
    assert.doesNotMatch(html, /Card processed/);
    assert.doesNotMatch(html, /FLYNESHER/);
    assert.doesNotMatch(html, /Your card statement shows/);
    assert.doesNotMatch(html, /Bank transfer is Mercury/);
    assert.doesNotMatch(html, /Pinpoint|NMI/);
    assert.doesNotMatch(html, /Nesher Travel/);
    assert.doesNotMatch(html, /statement shows/i);
    assert.doesNotMatch(html, /assets\.flynesher\.com\/nesher-logo/);
  });

  it("Nesher bank-only still has the logo and still has no sermon", () => {
    const html = renderInvoiceHtml({
      amountUsd: 100,
      invoiceNumber: "RES-1",
      mercuryUrl: "https://app.mercury.com/pay/a",
      brandId: "nesher",
    });
    assert.match(html, /src="https:\/\/assets\.flynesher\.com\/nesher-logo\.jpg"/);
    assert.match(html, /alt="Nesher Travel"/);
    assert.doesNotMatch(html, /Card processed/);
    assert.doesNotMatch(html, /statement shows/i);
    assert.doesNotMatch(html, /processed-by/);
    assert.doesNotMatch(html, /Pinpoint\/NMI/);
    assert.doesNotMatch(html, /Bank transfer is Mercury/);
  });

  it("paints JRM guest chrome without Collect.js when capture is off", () => {
    const html = renderInvoiceHtml({
      amountUsd: 189,
      invoiceNumber: "JRM-189-O50",
      mercuryUrl: "https://app.mercury.com/pay/a",
      brandId: "jrm",
      kind: "hotel",
    });
    assert.match(html, /pay-brand-jrm/);
    assert.match(html, /alt="JRM Hotels"/);
    assert.match(html, /#5C4528/);
    assert.match(html, /body\.pay-brand-jrm \.card-field:focus-within/);
    assert.doesNotMatch(html, /Collect\.js/);
    assert.doesNotMatch(html, /Nesher · FlyNesher/);
    assert.doesNotMatch(html, /FLYNESHER\.COM/);
    assert.doesNotMatch(html, /<p class="logo">JRM Hotels<\/p>/);
  });
});
