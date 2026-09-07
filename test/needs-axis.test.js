import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { injectNeedsAxis, needsAxisBadges } from "../needs-axis.js";

function pool(rows) {
  return { query: async () => ({ rows }) };
}

describe("needsAxisBadges", () => {
  it("prints nothing when every field is empty", () => {
    assert.equal(needsAxisBadges({}), "");
    assert.equal(needsAxisBadges({ travelParty: { adults: 0, children: 0, babies: 0, rooms: 0 } }), "");
  });

  it("builds a party line only from the non-zero counts", () => {
    const out = needsAxisBadges({ travelParty: { adults: 2, children: 1, babies: 0, rooms: 1 } });
    assert.match(out, /Party: 2 adults, 1 child, 1 room</);
  });

  it("HTML-escapes free-text kashrus and Shabbos notes", () => {
    const out = needsAxisBadges({ kashrus: "<script>x</script>", shabbosNotes: "no travel Fri>Sun" });
    assert.doesNotMatch(out, /<script>/);
    assert.match(out, /&lt;script&gt;/);
    assert.match(out, /Shabbos\/Yom Tov: no travel Fri&gt;Sun/);
  });
});

describe("injectNeedsAxis", () => {
  it("adds a kashrus badge on the customer detail page", async () => {
    const html = "<html><body><h1 class=\"customer-page-title\">Test Customer</h1></body></html>";
    const out = await injectNeedsAxis(html, "/customers/9/", pool([{ kashrus_standard: "Cholov Yisroel" }]));
    assert.match(out, /nesher-needs-badge/);
    assert.match(out, /Kashrus: Cholov Yisroel/);
  });

  it("adds kashrus + party + Shabbos badges on the reservation detail page", async () => {
    const out = await injectNeedsAxis(
      "<h1>Reservation AFV2WG</h1>",
      "/reservations/347/",
      pool([{ kashrus_standard: "Glatt", shabbos_yomtov_notes: "no Friday arrival", travel_party: { adults: 2, children: 3, babies: 0, rooms: 2 } }])
    );
    assert.match(out, /Kashrus: Glatt/);
    assert.match(out, /Party: 2 adults, 3 children, 2 rooms/);
    assert.match(out, /Shabbos\/Yom Tov: no Friday arrival/);
  });

  it("adds badges on the JRM hotel request detail page", async () => {
    const out = await injectNeedsAxis(
      "<h1 class=\"jrm-title\">JRM Request #1090 - Test</h1>",
      "/jrm/hotels/90/",
      pool([{ kashrus_standard: "Badatz", shabbos_yomtov_notes: null, travel_party: { adults: 1, children: 0, babies: 0, rooms: 1 } }])
    );
    assert.match(out, /Kashrus: Badatz/);
    assert.match(out, /Party: 1 adult, 1 room/);
    assert.doesNotMatch(out, /Shabbos\/Yom Tov:/);
  });

  it("returns HTML unchanged with no pool, an all-empty row, no matching row, or a DB error", async () => {
    const html = "<h1>R</h1>";
    assert.equal(await injectNeedsAxis(html, "/reservations/1/", null), html);
    assert.equal(await injectNeedsAxis(html, "/reservations/1/", pool([{ kashrus_standard: null, shabbos_yomtov_notes: null, travel_party: null }])), html);
    assert.equal(await injectNeedsAxis(html, "/reservations/1/", pool([])), html);
    assert.equal(await injectNeedsAxis(html, "/some/other/page/", pool([{ kashrus_standard: "Glatt" }])), html);
    const boom = { query: async () => { throw new Error("db down"); } };
    assert.equal(await injectNeedsAxis(html, "/customers/9/", boom), html);
  });

  it("never runs a query for a path it does not own", async () => {
    let called = false;
    const spy = { query: async () => { called = true; return { rows: [] }; } };
    await injectNeedsAxis("<h1>x</h1>", "/whatsapp/", spy);
    assert.equal(called, false);
  });
});
