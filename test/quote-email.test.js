import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  buildQuoteEmail,
  buildQuoteDraft,
  describeGuests,
  discoverHotelEmail,
  discoverRequestColumns,
  formatDate,
  injectQuoteEmail,
  isHotelRequestPath,
  loadQuoteContext,
  nightsBetween,
  SIGN_OFF,
} from "../quote-email.js";
import { build, runScript, scriptBody } from "./dom-stub.js";

/* The stay in the screenshot: Aug 31 2026 → Sep 6 2026, 6 nights. */
const REQUEST = {
  id: 87,
  customer_name: "Chaim Rosenberg",
  city: "Jerusalem",
  check_in: "2026-08-31",
  check_out: "2026-09-06",
  adults: 2,
  children: 3,
  rooms: 2,
};
const OFFER = { id: 48, hotel_name: "Dan Jerusalem", room_type: "Deluxe" };
const CTX = { request: REQUEST, offer: OFFER, offers: [OFFER] };

const PAGE =
  "<html><body><h1>Hotel request 87</h1>" +
  '<span class="nesher-mercury-wrap">' +
  '<button data-nesher-mercury-pay data-kind="hotel" data-id="87">Mercury Pay Link</button>' +
  "</span></body></html>";

/** Pool answering by SQL shape; `tables` drives the catalog lookups. */
function pool({
  request = REQUEST,
  offers = [OFFER],
  extraCols = ["adults", "children", "rooms"],
  emailCols = [],
  nameCols = [],
  emails = [],
  fail = null,
} = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (fail) throw new Error(fail);
      if (/column_name = ANY/.test(sql)) return { rows: extraCols.map((c) => ({ column_name: c })) };
      if (/table_name LIKE '%hotel%'/.test(sql)) return { rows: emailCols };
      if (/column_name LIKE '%name%'/.test(sql)) return { rows: nameCols };
      if (/FROM core_jrmhotelrequest/.test(sql)) return { rows: request ? [request] : [] };
      if (/FROM core_jrmhoteloffer/.test(sql)) return { rows: offers };
      if (/AS email FROM/.test(sql)) return { rows: emails.map((e) => ({ email: e })) };
      throw new Error("unexpected sql: " + sql);
    },
  };
}

describe("dates and guests", () => {
  it("counts nights across a month boundary", () => {
    assert.equal(nightsBetween("2026-08-31", "2026-09-06"), 6);
  });

  it("rejects a non-positive or unparseable stay", () => {
    assert.equal(nightsBetween("2026-09-06", "2026-08-31"), null);
    assert.equal(nightsBetween("2026-08-31", "2026-08-31"), null);
    assert.equal(nightsBetween(null, "2026-09-06"), null);
    assert.equal(nightsBetween("not a date", "2026-09-06"), null);
  });

  it("formats a date the same from a string or a Date", () => {
    assert.equal(formatDate("2026-08-31"), "Monday, 31 August 2026");
    assert.equal(formatDate(new Date("2026-08-31T00:00:00Z")), "Monday, 31 August 2026");
  });

  it("pluralises guests and omits what the CRM lacks", () => {
    assert.equal(describeGuests({ adults: 2, children: 3 }).guests, "2 adults, 3 children");
    assert.equal(describeGuests({ adults: 1, children: 1 }).guests, "1 adult, 1 child");
    assert.equal(describeGuests({ adults: 2 }).guests, "2 adults");
    assert.equal(describeGuests({}).guests, null);
    assert.equal(describeGuests({ adults: 0, children: 0 }).guests, null);
  });
});

describe("buildQuoteEmail", () => {
  it("puts the stay in the subject, not our request id", () => {
    const { subject } = buildQuoteEmail(CTX);
    assert.equal(subject, "Price request — 31 Aug–6 Sep 2026 — 6 nights");
    assert.doesNotMatch(subject, /87/);
  });

  it("states the stay and asks for what a quote needs", () => {
    const { body } = buildQuoteEmail(CTX);
    assert.match(body, /Dan Jerusalem/);
    assert.match(body, /Jerusalem/);
    assert.match(body, /Monday, 31 August 2026/);
    assert.match(body, /Sunday, 6 September 2026/);
    assert.match(body, /Nights:\s+6/);
    assert.match(body, /Rooms:\s+2/);
    assert.match(body, /2 adults, 3 children/);
    assert.match(body, /Deluxe/);
    for (const ask of [/Rate per night/, /breakfast/, /Cancellation policy/, /available/]) {
      assert.match(body, ask);
    }
    assert.match(body, new RegExp(SIGN_OFF));
  });

  it("never discloses the customer to the hotel", () => {
    const ctx = {
      request: { ...REQUEST, email: "chaim@example.com", phone: "+1 555 0100", internal_notes: "haggle hard" },
      offer: OFFER,
    };
    const { body, subject } = buildQuoteEmail(ctx);
    for (const leak of ["Chaim", "Rosenberg", "chaim@example.com", "555", "haggle"]) {
      assert.ok(!body.includes(leak), "leaked " + leak + " to the hotel");
      assert.ok(!subject.includes(leak), "leaked " + leak + " in the subject");
    }
  });

  it("omits rows the CRM has no answer for rather than printing blanks", () => {
    const { body } = buildQuoteEmail({ request: { city: "Tel Aviv" }, offer: null });
    assert.doesNotMatch(body, /Hotel:/);
    assert.doesNotMatch(body, /Nights:/);
    assert.doesNotMatch(body, /Guests:/);
    assert.match(body, /City:\s+Tel Aviv/);
  });

  it("names what staff must supply before sending", () => {
    assert.deepEqual(buildQuoteEmail(CTX).missing, []);
    assert.deepEqual(
      buildQuoteEmail({ request: {}, offer: null }).missing,
      ["hotel name", "city", "stay dates"]
    );
  });

  it("appends a reply-to line only when one is configured", () => {
    assert.match(buildQuoteEmail(CTX, { replyTo: "desk@example.com" }).body, /desk@example\.com/);
    assert.doesNotMatch(buildQuoteEmail(CTX).body, /@/);
  });

  it("survives an empty context", () => {
    const out = buildQuoteEmail(null);
    assert.equal(out.subject, "Price request");
    assert.match(out.body, /Hello,/);
  });
});

describe("context discovery", () => {
  it("selects the guest columns the CRM actually has", async () => {
    assert.deepEqual(await discoverRequestColumns(pool({ extraCols: ["adults"] })), ["adults"]);
  });

  it("drops catalog names that are not plain identifiers", async () => {
    const cols = await discoverRequestColumns(pool({ extraCols: ["adults", 'drop"; --'] }));
    assert.deepEqual(cols, ["adults"]);
  });

  it("degrades to the core columns when the catalog is unreadable", async () => {
    const p = pool({ extraCols: [] });
    const ctx = await loadQuoteContext(p, 87);
    const read = p.seen.find((q) => /FROM core_jrmhotelrequest/.test(q.sql));
    assert.doesNotMatch(read.sql, /adults/);
    assert.equal(ctx.request.id, 87);
  });

  it("picks the requested offer, else the newest", async () => {
    const offers = [{ id: 48, hotel_name: "Dan" }, { id: 12, hotel_name: "Inbal" }];
    assert.equal((await loadQuoteContext(pool({ offers }), 87, 12)).offer.hotel_name, "Inbal");
    assert.equal((await loadQuoteContext(pool({ offers }), 87)).offer.hotel_name, "Dan");
    assert.equal((await loadQuoteContext(pool({ offers }), 87, 999)).offer.hotel_name, "Dan");
  });

  it("throws only when the request itself is missing", async () => {
    await assert.rejects(() => loadQuoteContext(pool({ request: null }), 87), /not found/);
    await assert.rejects(() => loadQuoteContext(pool(), "abc"), /Invalid hotel request id/);
  });

  it("still builds a draft when the CRM holds no offers", async () => {
    const ctx = await loadQuoteContext(pool({ offers: [] }), 87);
    assert.equal(ctx.offer, null);
    assert.match(buildQuoteEmail(ctx).missing.join(), /hotel name/);
  });
});

describe("hotel address lookup", () => {
  const withBook = {
    emailCols: [{ table_name: "core_hotel", column_name: "email" }],
    nameCols: [{ column_name: "name" }],
    emails: ["res@danjerusalem.com", "res@danjerusalem.com"],
  };

  it("finds an address and de-duplicates it", async () => {
    assert.deepEqual(await discoverHotelEmail(pool(withBook), "Dan Jerusalem"), [
      "res@danjerusalem.com",
    ]);
  });

  it("returns nothing when the CRM has no hotel address book", async () => {
    assert.deepEqual(await discoverHotelEmail(pool(), "Dan Jerusalem"), []);
  });

  it("returns nothing rather than throwing when the catalog is denied", async () => {
    assert.deepEqual(await discoverHotelEmail(pool({ fail: "permission denied" }), "Dan"), []);
  });

  it("skips rows that are not real addresses", async () => {
    const p = pool({ ...withBook, emails: ["", "not-an-address"] });
    assert.deepEqual(await discoverHotelEmail(p, "Dan Jerusalem"), []);
  });

  it("refuses a catalog identifier that is not a plain identifier", async () => {
    const p = pool({
      emailCols: [{ table_name: 'hotel"; DROP TABLE x; --', column_name: "email" }],
      nameCols: [{ column_name: "name" }],
      emails: ["x@y.com"],
    });
    assert.deepEqual(await discoverHotelEmail(p, "Dan"), []);
    assert.ok(!p.seen.some((q) => /DROP TABLE/.test(q.sql)), "unsafe identifier reached SQL");
  });

  it("parameterises the hotel name instead of interpolating it", async () => {
    const p = pool(withBook);
    await discoverHotelEmail(p, "O'Hara Suites");
    const lookup = p.seen.find((q) => /AS email FROM/.test(q.sql));
    assert.deepEqual(lookup.params, ["O'Hara Suites"]);
    assert.doesNotMatch(lookup.sql, /O'Hara/);
  });

  it("skips the lookup entirely without a hotel name", async () => {
    const p = pool(withBook);
    assert.deepEqual(await discoverHotelEmail(p, ""), []);
    assert.equal(p.seen.length, 0);
  });
});

describe("buildQuoteDraft", () => {
  it("assembles the draft the modal renders", async () => {
    const d = await buildQuoteDraft(
      pool({
        emailCols: [{ table_name: "core_hotel", column_name: "email" }],
        nameCols: [{ column_name: "name" }],
        emails: ["res@danjerusalem.com"],
      }),
      87
    );
    assert.deepEqual(d.to, ["res@danjerusalem.com"]);
    assert.equal(d.selectedOfferId, 48);
    assert.deepEqual(d.offers, [{ id: 48, hotel_name: "Dan Jerusalem" }]);
    assert.match(d.subject, /Price request/);
  });

  it("leaves the address empty rather than guessing", async () => {
    assert.deepEqual((await buildQuoteDraft(pool(), 87)).to, []);
  });
});

describe("injectQuoteEmail", () => {
  it("injects on the request detail page only", () => {
    assert.match(injectQuoteEmail(PAGE, "/jrm/hotels/87/"), /nesher-quote-email-js/);
    for (const p of ["/jrm/hotels/", "/reservations/12/", "/whatsapp/", "/"]) {
      assert.equal(injectQuoteEmail(PAGE, p), PAGE, p);
    }
  });

  it("leaves the CRM's own markup untouched", () => {
    const out = injectQuoteEmail(PAGE, "/jrm/hotels/87/");
    const original = PAGE.slice(0, PAGE.indexOf("</body>"));
    assert.ok(out.startsWith(original), "CRM markup preserved verbatim");
    assert.match(out, /<\/body><\/html>$/);
  });

  it("is idempotent", () => {
    const once = injectQuoteEmail(PAGE, "/jrm/hotels/87/");
    assert.equal(injectQuoteEmail(once, "/jrm/hotels/87/"), once);
  });

  it("handles non-string input", () => {
    assert.equal(injectQuoteEmail(null, "/jrm/hotels/87/"), null);
    assert.equal(injectQuoteEmail("", "/jrm/hotels/87/"), "");
  });

  it("emits a browser script that parses", () => {
    const src = scriptBody(injectQuoteEmail(PAGE, "/jrm/hotels/87/"), "nesher-quote-email-js");
    new vm.Script(src);
  });

  it("only matches a numeric request id", () => {
    assert.equal(isHotelRequestPath("/jrm/hotels/87/"), "87");
    assert.equal(isHotelRequestPath("/jrm/hotels/87"), "87");
    assert.equal(isHotelRequestPath("/jrm/hotels/87/?x=1"), "87");
    assert.equal(isHotelRequestPath("/jrm/hotels/offer/48/"), null);
    assert.equal(isHotelRequestPath("/jrm/hotels/"), null);
  });
});

/* ── the injected script, driven for real ───────────────────────────── */

const DRAFT = {
  subject: "Price request — 31 Aug–6 Sep 2026 — 6 nights",
  body: "Hello,\n\nCould you please send us your best available rate",
  to: ["res@danjerusalem.com"],
  missing: [],
  offers: [{ id: 48, hotel_name: "Dan Jerusalem" }],
  selectedOfferId: 48,
};

function drive({ draft = DRAFT, page = null, ok = true } = {}) {
  const doc = page || build([
    { tag: "h1", text: "Hotel request 87" },
    {
      tag: "span",
      attrs: { class: "nesher-mercury-wrap" },
      children: [{ tag: "button", attrs: { "data-nesher-mercury-pay": "" }, text: "Mercury Pay Link" }],
    },
    // Trailing node so "beside the pay button" and "at the end of the page"
    // are distinguishable positions.
    { tag: "div", attrs: { id: "offers" }, text: "Offers" },
  ]);
  const src = scriptBody(injectQuoteEmail(PAGE, "/jrm/hotels/87/"), "nesher-quote-email-js");
  const sandbox = runScript(src, {
    doc,
    fetchImpl: () => ({
      ok,
      json: () => Promise.resolve(ok ? { ok: true, draft } : { ok: false, error: "boom" }),
    }),
  });
  vm.createContext(sandbox);
  new vm.Script(src).runInContext(sandbox);
  return sandbox;
}

const modalOf = (doc) => doc.querySelector("[class]") && doc.body.children.find((c) => /-ov$/.test(c.className));
const fieldsOf = (doc) => ({
  inputs: doc.querySelectorAll("input"),
  textarea: doc.querySelector("textarea"),
});

describe("the injected browser script", () => {
  it("puts the button beside the Mercury button, not at the page end", () => {
    const s = drive();
    const btn = s.document.getElementById("nesher-quote-email-btn");
    assert.ok(btn, "button was added");
    assert.equal(btn.textContent, "Email hotel for price");
    const wrap = s.document.querySelector("span");
    const kids = s.document.body.children;
    assert.equal(btn.parentNode, wrap.parentNode, "shares the pay button's parent");
    assert.equal(
      kids.indexOf(btn),
      kids.indexOf(wrap) + 1,
      "sits immediately after the pay button, not appended to the page"
    );
  });

  it("falls back to the heading when there is no Mercury button", () => {
    const doc = build([{ tag: "h1", text: "Hotel request 87" }]);
    const s = drive({ page: doc });
    assert.ok(s.document.getElementById("nesher-quote-email-btn"));
  });

  it("adds nothing until staff ask for it", () => {
    const s = drive();
    assert.equal(s.calls.fetch.length, 0, "no request on page load");
    assert.equal(modalOf(s.document), undefined);
  });

  it("asks the server for the draft when clicked", async () => {
    const s = drive();
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    assert.equal(s.calls.fetch.length, 1);
    assert.equal(s.calls.fetch[0].url, "/__nesher_quote/hotel/87/");
    assert.equal(s.calls.fetch[0].opts.credentials, "same-origin");
  });

  it("renders the draft into an editable modal", async () => {
    const s = drive();
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    const { inputs, textarea } = fieldsOf(s.document);
    assert.equal(inputs[0].value, "res@danjerusalem.com");
    assert.equal(inputs[1].value, DRAFT.subject);
    assert.equal(textarea.value, DRAFT.body);
  });

  it("warns when the CRM had no address for the hotel", async () => {
    const s = drive({ draft: { ...DRAFT, to: [] } });
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    assert.match(s.document.body.textContent, /No email on file/);
  });

  it("names missing CRM fields in the modal", async () => {
    const s = drive({ draft: { ...DRAFT, missing: ["stay dates"] } });
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    assert.match(s.document.body.textContent, /Missing from the CRM: stay dates/);
  });

  it("opens Gmail with the edited text, not the original draft", async () => {
    const s = drive();
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    const { inputs, textarea } = fieldsOf(s.document);
    inputs[0].value = "front.desk@inbal.co.il";
    textarea.value = "Edited body";
    s.document.querySelectorAll("button").find((b) => b.textContent === "Open in Gmail").dispatch("click");

    assert.equal(s.calls.open.length, 1);
    const url = s.calls.open[0].url;
    assert.match(url, /^https:\/\/mail\.google\.com\/mail\/\?view=cm/);
    assert.match(url, /to=front\.desk%40inbal\.co\.il/);
    assert.match(url, /body=Edited%20body/);
  });

  it("refuses to compose without an address", async () => {
    const s = drive({ draft: { ...DRAFT, to: [] } });
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    s.document.querySelectorAll("button").find((b) => b.textContent === "Open in Gmail").dispatch("click");
    assert.equal(s.calls.open.length, 0, "did not open a blank-recipient compose");
    assert.match(s.document.body.textContent, /Add the hotel's email address first/);
  });

  it("copies the message body", async () => {
    const s = drive();
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    s.document.querySelectorAll("button").find((b) => b.textContent === "Copy message").dispatch("click");
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(s.calls.clipboard, [DRAFT.body]);
  });

  it("sends nothing by itself — no POST anywhere", async () => {
    const s = drive();
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    s.document.querySelectorAll("button").find((b) => b.textContent === "Open in Gmail").dispatch("click");
    assert.ok(
      s.calls.fetch.every((c) => !c.opts || !c.opts.method || c.opts.method === "GET"),
      "the injected script must never post an email"
    );
  });

  it("surfaces a server failure instead of showing an empty modal", async () => {
    const s = drive({ ok: false });
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    assert.equal(modalOf(s.document), undefined, "no half-built modal left open");
    assert.match(s.calls.alert.join(" "), /Could not build the email/);
  });

  it("re-fetches when staff switch hotels", async () => {
    const s = drive({
      draft: { ...DRAFT, offers: [{ id: 48, hotel_name: "Dan" }, { id: 12, hotel_name: "Inbal" }] },
    });
    s.document.getElementById("nesher-quote-email-btn").dispatch("click");
    await new Promise((r) => setImmediate(r));
    const sel = s.document.querySelector("select");
    sel.value = "12";
    sel.dispatch("change");
    await new Promise((r) => setImmediate(r));
    assert.equal(s.calls.fetch[1].url, "/__nesher_quote/hotel/87/?offer=12");
  });
});
