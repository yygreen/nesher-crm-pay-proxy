import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mintInvoiceToken,
  verifyInvoiceToken,
  buildCombinedPayUrl,
  renderInvoiceHtml,
} from "../invoice-page.js";

describe("unified invoice token", () => {
  it("round-trips bank + square payload", () => {
    process.env.PAY_PAGE_SECRET = "test-secret-for-invoice-page";
    const token = mintInvoiceToken({
      amountUsd: 2604.5,
      invoiceNumber: "JRM-189-O50",
      customerName: "Sarah Cohen",
      summary: "King David · Aug 12–15",
      mercuryUrl: "https://app.mercury.com/pay/abc",
      squareUrl: "https://square.link/u/xyz",
      cardProcessor: "square",
    });
    const v = verifyInvoiceToken(token);
    assert.equal(v.ok, true);
    assert.equal(v.data.amountUsd, 2604.5);
    assert.equal(v.data.invoiceNumber, "JRM-189-O50");
    assert.equal(v.data.squareUrl, "https://square.link/u/xyz");
    assert.equal(v.data.mercuryUrl, "https://app.mercury.com/pay/abc");
    const url = buildCombinedPayUrl("https://www.flynesher.com", token);
    assert.match(url, /^https:\/\/www\.flynesher\.com\/pay\//);
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

  it("renders both payment methods on the guest page", () => {
    const html = renderInvoiceHtml({
      amountUsd: 100,
      invoiceNumber: "RES-1",
      customerName: "Test",
      summary: "Flights",
      mercuryUrl: "https://app.mercury.com/pay/a",
      squareUrl: "https://square.link/u/b",
      cardProcessor: "square",
    });
    assert.match(html, /Pay with card/);
    assert.match(html, /Pay with bank/);
    assert.match(html, /square\.link\/u\/b/);
    assert.match(html, /mercury\.com\/pay\/a/);
    assert.match(html, /\$100\.00/);
  });
});
