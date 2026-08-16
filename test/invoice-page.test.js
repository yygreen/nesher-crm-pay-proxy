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
    assert.doesNotMatch(html, /Pay with card/);
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
});
