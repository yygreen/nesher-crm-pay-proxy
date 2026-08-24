import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { build, runScript, scriptBody } from "./dom-stub.js";
import {
  injectStatusOption,
  isHotelRequestPath,
  pickStatusValue,
  loadStatusMeta,
  loadHotelRequestStatus,
  setHotelRequestStatus,
  STATUS_LABEL,
} from "../status-option.js";

// The CRM's real status vocabulary, read off the live dropdown on
// /jrm/hotels/<id>/. Kept verbatim so a change in how values are picked is
// judged against what the column actually holds, not an invented list.
const LIVE_STATUSES = [
  "New",
  "Needs Customer Clarification",
  "Ready to Contact Hotels",
  "Sent to Hotels",
  "Hotel Responded",
  "Sent to Customer",
  "Customer Interested",
  "Booking in Progress",
  "Booked",
  "Lost",
  "Cancelled",
];

/** Django's own slug form of the same list, for CRMs that store the key. */
const LIVE_SLUGS = LIVE_STATUSES.map((s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
);

const optionHtml = (v) => `<option value="${v}">${v}</option>`;

// Shape of the Change Status card from the CRM, plus the per-offer select that
// also lives on that page — the injector must not bind to the wrong one.
const PAGE =
  "<html><body><h1>Hotel request 87</h1>" +
  '<div class="card"><h3>Change Status</h3>' +
  '<form method="post" action="/jrm/hotels/87/status/">' +
  '<select name="status">' + LIVE_STATUSES.map(optionHtml).join("") + "</select>" +
  '<button type="submit">Update Status</button></form></div>' +
  '<select name="customer_answer_status"><option value="">--</option></select>' +
  "</body></html>";

/** Pool that answers by SQL shape. */
function pool({ len = 20, existing = ["New", "Quoted"], status = "New", rowCount = 1 } = {}) {
  const seen = [];
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (/information_schema/.test(sql)) return { rows: [{ len }] };
      if (/SELECT DISTINCT status/.test(sql)) return { rows: existing.map((s) => ({ status: s })) };
      if (/^SELECT status/.test(sql.trim())) return { rows: status === null ? [] : [{ status }] };
      if (/^UPDATE/.test(sql.trim())) return { rowCount };
      throw new Error("unexpected sql: " + sql);
    },
  };
}

describe("isHotelRequestPath", () => {
  it("matches the request detail page only", () => {
    assert.equal(isHotelRequestPath("/jrm/hotels/87/"), "87");
    assert.equal(isHotelRequestPath("/jrm/hotels/87"), "87");
    assert.equal(isHotelRequestPath("/jrm/hotels/87/?tab=x"), "87");
    assert.equal(isHotelRequestPath("/jrm/hotels/"), null);
    assert.equal(isHotelRequestPath("/jrm/hotels/offer/48/"), null);
    assert.equal(isHotelRequestPath("/reservations/12/"), null);
  });
});

describe("pickStatusValue", () => {
  it("uses the readable label when the CRM stores readable statuses", () => {
    assert.equal(pickStatusValue(["New", "Quoted", "Booked"], 40), STATUS_LABEL);
  });

  it("matches slug style when the CRM stores slugs", () => {
    assert.equal(pickStatusValue(["new", "quoted", "booked"], 40), "not_interested");
  });

  it("follows the separator already in use", () => {
    assert.equal(pickStatusValue(["new", "waiting-on-hotel"], 40), "not-interested");
  });

  it("never overflows the column", () => {
    for (const len of [30, 26, 20, 14, 8, 4]) {
      const v = pickStatusValue(["New", "Quoted"], len);
      assert.ok(v.length <= len, `${v} (${v.length}) fits ${len}`);
      assert.ok(v.length > 0);
    }
  });

  it("prefers the full label at exactly its own length", () => {
    assert.equal(pickStatusValue(["New"], STATUS_LABEL.length), STATUS_LABEL);
    assert.equal(pickStatusValue(["New"], STATUS_LABEL.length - 1), "Not Interested");
  });

  it("falls back to the label style when the vocabulary is unreadable", () => {
    assert.equal(pickStatusValue([], null), STATUS_LABEL);
  });
});

describe("loadStatusMeta", () => {
  it("reads the column limit and the vocabulary", async () => {
    const meta = await loadStatusMeta(pool({ len: 32, existing: ["New", "Booked"] }));
    assert.equal(meta.maxLen, 32);
    assert.deepEqual(meta.existing, ["New", "Booked"]);
  });

  it("degrades instead of throwing when the catalog is unreadable", async () => {
    const meta = await loadStatusMeta({ query: async () => { throw new Error("denied"); } });
    assert.equal(meta.maxLen, null);
    assert.deepEqual(meta.existing, []);
  });

  it("treats an unbounded column as no limit", async () => {
    const meta = await loadStatusMeta(pool({ len: null }));
    assert.equal(meta.maxLen, null);
  });
});

describe("status read/write", () => {
  it("reads the current status", async () => {
    assert.equal(await loadHotelRequestStatus(pool({ status: "Quoted" }), 87), "Quoted");
  });

  it("returns null for a missing request", async () => {
    assert.equal(await loadHotelRequestStatus(pool({ status: null }), 999), null);
  });

  it("writes ONLY the status column", async () => {
    const p = pool();
    const n = await setHotelRequestStatus(p, 87, STATUS_LABEL);
    assert.equal(n, 1);
    const write = p.seen.find((q) => /^UPDATE/.test(q.sql.trim()));
    assert.match(write.sql, /UPDATE core_jrmhotelrequest SET status = \$1 WHERE id = \$2/);
    assert.doesNotMatch(write.sql, /updated_at|,/);
    assert.deepEqual(write.params, [STATUS_LABEL, 87]);
  });

  it("reports 0 when the request does not exist", async () => {
    assert.equal(await setHotelRequestStatus(pool({ rowCount: 0 }), 999, "x"), 0);
  });
});

describe("injectStatusOption", () => {
  it("injects on the request detail page", () => {
    const out = injectStatusOption(PAGE, "/jrm/hotels/87/");
    assert.match(out, /nesher-status-option-js/);
    assert.match(out, /nesher-status-option-css/);
    assert.match(out, /__nesher_status\/hotel\/" \+ REQ/);
    assert.match(out, /"87"/);
  });

  it("leaves the CRM's own markup untouched", () => {
    const out = injectStatusOption(PAGE, "/jrm/hotels/87/");
    const original = PAGE.slice(0, PAGE.indexOf("</body>"));
    assert.ok(out.startsWith(original), "CRM markup is preserved verbatim");
    // everything we add sits between the CRM's last node and </body>
    assert.equal(out.slice(original.length).trimStart().startsWith("<style"), true);
    assert.match(out, /<\/body><\/html>$/);
  });

  it("is idempotent", () => {
    const once = injectStatusOption(PAGE, "/jrm/hotels/87/");
    assert.equal(injectStatusOption(once, "/jrm/hotels/87/"), once);
  });

  it("only touches the request detail page", () => {
    for (const p of ["/jrm/hotels/", "/reservations/12/", "/whatsapp/", "/"]) {
      assert.equal(injectStatusOption(PAGE, p), PAGE, p);
    }
  });

  it("no-ops when the page has no select at all", () => {
    const plain = "<html><body><h1>Hotel request 87</h1></body></html>";
    assert.equal(injectStatusOption(plain, "/jrm/hotels/87/"), plain);
  });

  it("handles non-string input", () => {
    assert.equal(injectStatusOption(null, "/jrm/hotels/87/"), null);
    assert.equal(injectStatusOption("", "/jrm/hotels/87/"), "");
  });

  it("emits a browser script that actually parses", () => {
    const out = injectStatusOption(PAGE, "/jrm/hotels/87/");
    const m = out.match(/<script id="nesher-status-option-js">([\s\S]*?)<\/script>/);
    assert.ok(m, "script block present");
    new vm.Script(m[1]); // throws on a syntax error
  });

  it("carries the label through to the browser script", () => {
    const out = injectStatusOption(PAGE, "/jrm/hotels/87/");
    assert.match(out, /Not Interested \\?\/ Can't Help/);
  });
});

describe("the CRM's real status vocabulary", () => {
  it("stores the readable label when the column holds labels", () => {
    // Longest live label is "Needs Customer Clarification" (28), so any column
    // that fits the CRM's own list also fits ours (27).
    assert.equal(pickStatusValue(LIVE_STATUSES, 30), STATUS_LABEL);
    assert.equal(pickStatusValue(LIVE_STATUSES, null), STATUS_LABEL);
  });

  it("stores an underscore slug when the column holds Django keys", () => {
    assert.equal(pickStatusValue(LIVE_SLUGS, 30), "not_interested");
  });

  it("never overflows a column sized to the CRM's own longest value", () => {
    const longest = Math.max(...LIVE_STATUSES.map((s) => s.length));
    for (const len of [longest, 20, 14, 10]) {
      assert.ok(
        pickStatusValue(LIVE_STATUSES, len).length <= len,
        `overflowed at max_length=${len}`
      );
    }
  });

  it("offers the option alongside Lost and Cancelled, not in place of them", () => {
    const out = injectStatusOption(PAGE, "/jrm/hotels/87/");
    for (const s of LIVE_STATUSES) {
      assert.ok(out.includes(optionHtml(s)), `dropped existing status ${s}`);
    }
    assert.ok(out.includes(STATUS_LABEL));
  });
});

/* ── the injected script, driven for real ───────────────────────────── */

const VALUE = STATUS_LABEL;

/** The Change Status card, plus the per-offer select that must not be bound. */
function statusPage() {
  return build([
    { tag: "h1", text: "Hotel request 87" },
    {
      tag: "div",
      attrs: { class: "card" },
      children: [
        { tag: "h3", text: "Change Status" },
        {
          tag: "form",
          attrs: { method: "post", action: "/jrm/hotels/87/status/" },
          children: [
            {
              tag: "select",
              attrs: { name: "status" },
              children: LIVE_STATUSES.map((v) => ({
                tag: "option", attrs: { value: v }, value: v, text: v,
              })),
            },
            { tag: "button", attrs: { type: "submit" }, text: "Update Status" },
          ],
        },
      ],
    },
    {
      tag: "select",
      attrs: { name: "customer_answer_status" },
      children: [{ tag: "option", attrs: { value: "" }, value: "", text: "--" }],
    },
  ]);
}

function driveStatus({ current = "New", doc = null, saveOk = true } = {}) {
  const page = doc || statusPage();
  const src = scriptBody(injectStatusOption(PAGE, "/jrm/hotels/87/"), "nesher-status-option-js");
  const sandbox = runScript(src, {
    doc: page,
    fetchImpl: (url, opts) =>
      opts && opts.method === "POST"
        ? { ok: saveOk, json: () => Promise.resolve(saveOk ? { ok: true, status: VALUE } : { ok: false, error: "column too small" }) }
        : { ok: true, json: () => Promise.resolve({ ok: true, value: VALUE, label: STATUS_LABEL, current }) },
  });
  vm.createContext(sandbox);
  new vm.Script(src).runInContext(sandbox);
  return sandbox;
}

const settle = () => new Promise((r) => setImmediate(r));
const statusSelect = (doc) => doc.querySelectorAll("select").find((x) => x.getAttribute("name") === "status");
const decoySelect = (doc) => doc.querySelectorAll("select").find((x) => x.getAttribute("name") === "customer_answer_status");

describe("the injected browser script", () => {
  it("binds the Change Status select, not the per-offer decoy", async () => {
    const s = driveStatus();
    await settle();
    assert.equal(statusSelect(s.document).getAttribute("data-nesher-status-option"), "1");
    assert.equal(decoySelect(s.document).getAttribute("data-nesher-status-option"), null);
  });

  it("appends the option without disturbing the CRM's own", async () => {
    const s = driveStatus();
    await settle();
    const opts = statusSelect(s.document).options;
    assert.deepEqual(opts.slice(0, LIVE_STATUSES.length).map((o) => o.value), LIVE_STATUSES);
    assert.equal(opts[opts.length - 1].value, VALUE);
    assert.equal(opts[opts.length - 1].textContent, STATUS_LABEL);
  });

  it("re-selects our value when it is what the request is stored as", async () => {
    const s = driveStatus({ current: VALUE });
    await settle();
    assert.equal(statusSelect(s.document).value, VALUE);
  });

  it("leaves the selection alone for a normal CRM status", async () => {
    const s = driveStatus({ current: "Hotel Responded" });
    await settle();
    assert.notEqual(statusSelect(s.document).value, VALUE);
  });

  it("intercepts submit and saves when our option is chosen", async () => {
    const s = driveStatus();
    await settle();
    const sel = statusSelect(s.document);
    sel.value = VALUE;
    const ev = sel.form.dispatch("submit");
    await settle();
    assert.equal(ev.defaultPrevented, true, "the CRM form must not post an unknown status");
    const post = s.calls.fetch.find((c) => c.opts && c.opts.method === "POST");
    assert.ok(post, "saved through our endpoint");
    assert.equal(post.url, "/__nesher_status/hotel/87/");
    assert.deepEqual(JSON.parse(post.opts.body), { status: VALUE });
  });

  it("lets a normal status post to the CRM untouched", async () => {
    const s = driveStatus();
    await settle();
    const sel = statusSelect(s.document);
    sel.value = "Booked";
    const ev = sel.form.dispatch("submit");
    await settle();
    assert.equal(ev.defaultPrevented, false, "the CRM must handle its own statuses");
    assert.equal(s.calls.fetch.filter((c) => c.opts && c.opts.method === "POST").length, 0);
  });

  it("reloads only after the save succeeds", async () => {
    const s = driveStatus();
    await settle();
    const sel = statusSelect(s.document);
    sel.value = VALUE;
    sel.form.dispatch("submit");
    await settle();
    assert.equal(s.calls.reload, 1);
  });

  it("shows the failure instead of silently losing the change", async () => {
    const s = driveStatus({ saveOk: false });
    await settle();
    const sel = statusSelect(s.document);
    sel.value = VALUE;
    sel.form.dispatch("submit");
    await settle();
    assert.match(s.document.body.textContent, /column too small/);
    assert.equal(s.calls.reload, 0, "must not reload away an unsaved change");
  });

  it("binds nothing when the page has only the decoy select", async () => {
    const doc = build([
      { tag: "h1", text: "Hotel request 87" },
      { tag: "select", attrs: { name: "customer_answer_status" }, children: [] },
    ]);
    const s = driveStatus({ doc });
    await settle();
    assert.equal(decoySelect(s.document).getAttribute("data-nesher-status-option"), null);
    assert.equal(s.calls.fetch.length, 0, "no request when there is nothing to extend");
  });
});
