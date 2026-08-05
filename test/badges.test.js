import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectPaidBadges } from "../inject.js";

function pool(rows) {
  return { query: async () => ({ rows }) };
}

describe("injectPaidBadges", () => {
  it("adds a PAID badge on a fully paid reservation detail", async () => {
    const html = "<html><body><h1>Reservation AFV2WG</h1></body></html>";
    const out = await injectPaidBadges(
      html,
      "/reservations/347/",
      pool([{ customer_price: "2436.32", amount_paid: "2436.32" }])
    );
    assert.match(out, /nesher-paid-badge/);
    assert.match(out, /PAID \$2,436\.32/);
    assert.doesNotMatch(out, /of \$/);
  });

  it("shows a partial badge when paid < price", async () => {
    const out = await injectPaidBadges(
      "<h1>R</h1>",
      "/reservations/1/",
      pool([{ customer_price: "2000", amount_paid: "500" }])
    );
    assert.match(out, /nesher-paid-badge part/);
    assert.match(out, /PAID \$500\.00 of \$2,000\.00/);
  });

  it("badges reservation list rows and skips edit links", async () => {
    const html =
      '<a href="/reservations/347/">AFV2WG</a> <a href="/reservations/347/edit/">edit</a>' +
      ' <a href="/reservations/300/">other</a>';
    const out = await injectPaidBadges(
      html,
      "/reservations/",
      pool([{ id: 347, customer_price: "2436.32", amount_paid: "2436.32" }])
    );
    assert.equal((out.match(/nesher-paid-badge/g) || []).length, 1);
    assert.ok(out.indexOf("nesher-paid-badge") > out.indexOf("AFV2WG</a>"));
  });

  it("badges hotel list rows from payment sums", async () => {
    const html = '<a href="/jrm/hotels/90/">Smilow</a>';
    const out = await injectPaidBadges(
      html,
      "/jrm/hotels/",
      pool([{ request_id: 90, paid: "965.72" }])
    );
    assert.match(out, /PAID \$965\.72/);
  });

  it("returns HTML unchanged with no pool, unpaid rows, or DB errors", async () => {
    const html = "<h1>R</h1>";
    assert.equal(await injectPaidBadges(html, "/reservations/1/", null), html);
    assert.equal(
      await injectPaidBadges(html, "/reservations/1/", pool([{ customer_price: "5", amount_paid: "0" }])),
      html
    );
    const boom = { query: async () => { throw new Error("db down"); } };
    assert.equal(await injectPaidBadges(html, "/reservations/1/", boom), html);
  });
});
