import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  createSquarePaymentLink,
  isSquareConfigured,
  squareConfig,
} from "../square.js";

describe("square config", () => {
  const prev = {};
  before(() => {
    for (const k of [
      "SQUARE_ACCESS_TOKEN_NESHER",
      "SQUARE_ACCESS_TOKEN",
      "SQUARE_LOCATION_ID_NESHER",
      "SQUARE_LOCATION_ID",
    ]) {
      prev[k] = process.env[k];
    }
  });
  after(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("reports not configured without token", () => {
    delete process.env.SQUARE_ACCESS_TOKEN_NESHER;
    delete process.env.SQUARE_ACCESS_TOKEN;
    assert.equal(isSquareConfigured(), false);
    assert.equal(squareConfig().configured, false);
  });

  it("reports configured when token present", () => {
    process.env.SQUARE_ACCESS_TOKEN_NESHER = "test-token";
    assert.equal(isSquareConfigured(), true);
  });
});

describe("createSquarePaymentLink", () => {
  it("fails soft without token", async () => {
    const saved = process.env.SQUARE_ACCESS_TOKEN_NESHER;
    const saved2 = process.env.SQUARE_ACCESS_TOKEN;
    delete process.env.SQUARE_ACCESS_TOKEN_NESHER;
    delete process.env.SQUARE_ACCESS_TOKEN;
    const r = await createSquarePaymentLink({
      amountUsd: 10,
      invoiceNumber: "JRM-1",
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /not configured/i);
    if (saved !== undefined) process.env.SQUARE_ACCESS_TOKEN_NESHER = saved;
    if (saved2 !== undefined) process.env.SQUARE_ACCESS_TOKEN = saved2;
  });

  it("creates a quick_pay payment link via API", async () => {
    process.env.SQUARE_ACCESS_TOKEN_NESHER = "tok-test";
    process.env.SQUARE_LOCATION_ID_NESHER = "LOC1";
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", body: init.body });
      if (String(url).includes("/v2/online-checkout/payment-links")) {
        const body = JSON.parse(init.body);
        assert.equal(body.quick_pay.location_id, "LOC1");
        assert.equal(body.quick_pay.price_money.amount, 260400);
        assert.equal(body.quick_pay.price_money.currency, "USD");
        assert.ok(body.idempotency_key);
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              payment_link: {
                id: "PL1",
                url: "https://square.link/u/TEST",
                order_id: "ord1",
              },
            });
          },
        };
      }
      throw new Error("unexpected " + url);
    };
    const r = await createSquarePaymentLink({
      amountUsd: 2604,
      invoiceNumber: "JRM-189-O50",
      lineName: "Hotel stay",
      customerEmail: "guest@example.com",
      fetchImpl,
    });
    assert.equal(r.ok, true);
    assert.equal(r.payUrl, "https://square.link/u/TEST");
    assert.equal(r.paymentLinkId, "PL1");
    assert.equal(calls.length, 1);
  });
});
