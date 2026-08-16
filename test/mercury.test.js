import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createOrReusePaymentRequest,
  hotelInvoiceNumber,
  reservationInvoiceNumber,
  payUrlFromSlug,
  normalizeToken,
  toUsdAmount,
  humanizePayError,
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

  it("updates the existing unpaid invoice in place when the amount changed", async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      const method = init.method || "GET";
      calls.push({ url, method });
      if (url.endsWith("/ar/invoices") && method === "GET") {
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
                  invoiceDate: "2026-08-02",
                  dueDate: "2026-08-03",
                },
              ],
            };
          },
        };
      }
      if (url.endsWith("/ar/customers") && method === "GET") {
        return {
          ok: true,
          async json() {
            return { customers: [{ id: "cust-1", email: "t@example.com" }] };
          },
        };
      }
      if (url.endsWith("/ar/invoices/inv-1") && method === "POST") {
        const body = JSON.parse(init.body);
        assert.equal(body.invoiceNumber, "JRM-189-O50");
        assert.equal(body.lineItems[0].unitPrice, 150);
        assert.equal(body.customerId, "cust-1");
        assert.equal(body.sendEmailOption, "DontSend");
        return {
          ok: true,
          async json() {
            return { id: "inv-1", slug: "existingslug", amount: 150, status: "Unpaid" };
          },
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const result = await createOrReusePaymentRequest({
      token: "secret-token:test",
      customerName: "Test",
      customerEmail: "t@example.com",
      invoiceNumber: "JRM-189-O50",
      amountUsd: 150,
      fetchImpl,
    });
    assert.equal(result.updated, true);
    assert.equal(result.reused, false);
    assert.equal(result.payUrl, "https://app.mercury.com/pay/existingslug");
    assert.equal(calls.filter((c) => c.url.endsWith("/ar/invoices") && c.method === "POST").length, 0);
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
        assert.equal(body.creditCardEnabled, false);
        assert.equal(body.achDebitEnabled, true);
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
              creditCardEnabled: false,
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
    assert.equal(result.creditCardEnabled, false);
    assert.equal(result.cardProcessor, "none");
    assert.equal(result.cardFallback, false);
    assert.match(result.paymentMethodsLabel, /bank/i);
  });

  it("reposts a reused invoice bank-only when card is still enabled on it", async () => {
    const posts = [];
    const fetchImpl = async (url, init = {}) => {
      const method = init.method || "GET";
      if (url.endsWith("/ar/invoices") && method === "GET") {
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
                  creditCardEnabled: true,
                  invoiceDate: "2026-08-02",
                  dueDate: "2026-08-03",
                },
              ],
            };
          },
        };
      }
      if (url.endsWith("/ar/customers") && method === "GET") {
        return {
          ok: true,
          async json() {
            return { customers: [{ id: "cust-1", email: "t@example.com" }] };
          },
        };
      }
      if (url.endsWith("/ar/invoices/inv-1") && method === "POST") {
        const body = JSON.parse(init.body);
        posts.push(body);
        assert.equal(body.creditCardEnabled, false);
        return {
          ok: true,
          async json() {
            return {
              id: "inv-1",
              slug: "existingslug",
              amount: 100,
              status: "Unpaid",
              creditCardEnabled: false,
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
      invoiceNumber: "JRM-189-O50",
      amountUsd: 100,
      fetchImpl,
    });
    assert.equal(posts.length, 1);
    assert.equal(result.updated, true);
    assert.equal(result.creditCardEnabled, false);
    assert.equal(result.cardProcessor, "none");
    assert.equal(result.payUrl, "https://app.mercury.com/pay/existingslug");
  });

  it("surfaces create 400 errors", async () => {
    const fetchImpl = async (url, init = {}) => {
      const method = init.method || "GET";
      if (url.endsWith("/ar/invoices") && method === "GET") {
        return { ok: true, async json() { return { invoices: [] }; } };
      }
      if (url.endsWith("/ar/customers") && method === "GET") {
        return {
          ok: true,
          async json() {
            return { customers: [{ id: "cust-1", email: "t@example.com" }] };
          },
        };
      }
      if (url.endsWith("/ar/invoices") && method === "POST") {
        return {
          ok: false,
          status: 400,
          async text() {
            return "invoiceNumber already exists for a paid invoice";
          },
        };
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    await assert.rejects(
      () =>
        createOrReusePaymentRequest({
          token: "secret-token:test",
          customerName: "Test",
          customerEmail: "t@example.com",
          invoiceNumber: "JRM-dup",
          amountUsd: 10,
          fetchImpl,
        }),
      /Mercury create invoice failed: 400/
    );
  });
});

describe("humanizePayError", () => {
  it("humanizes create-400 without dumping raw Mercury text", () => {
    const msg = humanizePayError(
      new Error(
        "Mercury create invoice failed: 400 some raw processor error body"
      )
    );
    assert.match(msg, /could not create the payment link/i);
    assert.doesNotMatch(msg, /raw processor error/i);
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
