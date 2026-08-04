import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOrReusePaymentRequest,
  hotelInvoiceNumber,
  reservationInvoiceNumber,
  payUrlFromSlug,
  normalizeToken,
  toUsdAmount,
} from "../mercury.js";
import { injectPayButtons, BUTTON_MARKER } from "../inject.js";

describe("invoice numbering", () => {
  it("builds JRM hotel numbers", () => {
    assert.equal(hotelInvoiceNumber(89, 50), "JRM-189-O50");
    assert.equal(hotelInvoiceNumber(1), "JRM-11");
  });
  it("builds RES numbers", () => {
    assert.equal(reservationInvoiceNumber("9FSGMN"), "RES-9FSGMN");
    assert.equal(reservationInvoiceNumber("ab-12"), "RES-AB-12");
  });
  it("builds pay urls", () => {
    assert.equal(
      payUrlFromSlug("abc123"),
      "https://app.mercury.com/pay/abc123"
    );
  });
  it("normalizes secret-token prefix", () => {
    assert.equal(
      normalizeToken("mercury_production_x"),
      "secret-token:mercury_production_x"
    );
    assert.equal(
      normalizeToken("secret-token:mercury_production_x"),
      "secret-token:mercury_production_x"
    );
  });
});

describe("toUsdAmount", () => {
  it("passes through USD", async () => {
    assert.equal(await toUsdAmount(100, "USD", async () => 3), 100);
  });
  it("converts ILS at spot*1.03 rule", async () => {
    // ils 3090 / 3 * 1.03 = 1060.9
    const usd = await toUsdAmount(3090, "ILS", async () => 3);
    assert.equal(usd, 1060.9);
  });
});

describe("createOrReusePaymentRequest", () => {
  it("reuses existing unpaid invoice with same number", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", body: init.body });
      if (url.endsWith("/ar/invoices") && !init.method) {
        return {
          ok: true,
          async json() {
            return {
              invoices: [
                {
                  id: "inv-1",
                  invoiceNumber: "JRM-189-O50",
                  status: "Unpaid",
                  slug: "existingslug",
                  amount: 100,
                },
              ],
            };
          },
        };
      }
      throw new Error("unexpected " + url);
    };
    const result = await createOrReusePaymentRequest({
      token: "secret-token:test",
      customerName: "Test",
      customerEmail: "t@example.com",
      invoiceNumber: "JRM-189-O50",
      amountUsd: 100,
      fetchImpl,
    });
    assert.equal(result.reused, true);
    assert.equal(result.payUrl, "https://app.mercury.com/pay/existingslug");
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  it("creates customer + invoice when none exists", async () => {
    const fetchImpl = async (url, init = {}) => {
      const method = init.method || "GET";
      if (url.endsWith("/ar/invoices") && method === "GET") {
        return { ok: true, async json() { return { invoices: [] }; } };
      }
      if (url.endsWith("/ar/customers") && method === "GET") {
        return { ok: true, async json() { return { customers: [] }; } };
      }
      if (url.endsWith("/ar/customers") && method === "POST") {
        return {
          ok: true,
          async json() {
            return { id: "cust-1", email: "t@example.com", name: "Test" };
          },
        };
      }
      if (url.endsWith("/ar/invoices") && method === "POST") {
        const body = JSON.parse(init.body);
        assert.equal(body.sendEmailOption, "DontSend");
        assert.equal(body.invoiceNumber, "JRM-195-O52");
        assert.equal(body.creditCardEnabled, true);
        assert.equal(body.lineItems[0].unitPrice, 50.5);
        return {
          ok: true,
          async json() {
            return {
              id: "inv-new",
              invoiceNumber: body.invoiceNumber,
              status: "Unpaid",
              slug: "newslug99",
              amount: 50.5,
            };
          },
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const result = await createOrReusePaymentRequest({
      token: "secret-token:test",
      customerName: "Test",
      customerEmail: "t@example.com",
      invoiceNumber: "JRM-195-O52",
      amountUsd: 50.5,
      lineItemName: "Hotel",
      fetchImpl,
    });
    assert.equal(result.reused, false);
    assert.equal(result.payUrl, "https://app.mercury.com/pay/newslug99");
  });
});

describe("injectPayButtons", () => {
  it("injects hotel detail button and assets", () => {
    const html = `<!doctype html><html><head><title>x</title></head><body>
      <div class="jrm-offer-actions">
        <a href="/jrm/hotels/offer/50/quote/pdf/">Quote PDF</a>
      </div>
      <a class="jrm-btn primary" href="/jrm/hotels/89/payment/add/">Add payment</a>
      </body></html>`;
    const out = injectPayButtons(html, "/jrm/hotels/89/");
    assert.match(out, new RegExp(BUTTON_MARKER));
    assert.match(out, /data-kind="hotel-offer"/);
    assert.match(out, /data-id="50"/);
    assert.match(out, /nesher-mercury-pay-js/);
    assert.match(out, /Mercury Pay \(this quote\)/);
  });

  it("injects reservation list pay buttons", () => {
    const html = `<html><body>
      <a href="/reservations/280/">RES-1</a>
      <a href="/reservations/281/edit/">edit</a>
      </body></html>`;
    const out = injectPayButtons(html, "/reservations/");
    assert.match(out, /data-kind="reservation"/);
    assert.match(out, /data-id="280"/);
  });

  it("is idempotent", () => {
    const html = `<html><body><a href="/jrm/hotels/1/">x</a></body></html>`;
    const once = injectPayButtons(html, "/jrm/hotels/");
    const twice = injectPayButtons(once, "/jrm/hotels/");
    const count = (twice.match(/nesher-mercury-pay-js/g) || []).length;
    assert.equal(count, 1);
  });
});
