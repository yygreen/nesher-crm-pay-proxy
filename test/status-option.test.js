import { describe, it } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  injectStatusOption,
  isHotelRequestPath,
  pickStatusValue,
  loadStatusMeta,
  loadHotelRequestStatus,
  setHotelRequestStatus,
  STATUS_LABEL,
} from "../status-option.js";

// Shape of the Change Status card from the CRM, plus the per-offer select that
// also lives on that page — the injector must not bind to the wrong one.
const PAGE =
  "<html><body><h1>Hotel request 87</h1>" +
  '<div class="card"><h3>Change Status</h3>' +
  '<form method="post" action="/jrm/hotels/87/status/">' +
  '<select name="status"><option value="New">New</option>' +
  '<option value="Quoted">Quoted</option></select>' +
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
