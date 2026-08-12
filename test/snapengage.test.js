import test from "node:test";
import assert from "node:assert/strict";
import {
  injectSnapEngage,
  isPublicMarketingPath,
  isPublicMarketingHost,
  looksLikeStaffPage,
  isValidWidgetId,
  DEFAULT_WIDGET_ID,
} from "../snapengage.js";

const WWW = "www.flynesher.com";
const MARKETING = "<html><head></head><body><h1>Nesher Travel</h1></body></html>";
// Real markers taken from the live staff templates.
const STAFF =
  '<html><body><form action="/attendance/clock-in/"></form>' +
  '<h1 class="page-title">Reservations</h1>' +
  '<h2 id="nesher-pay-title">Create payment link</h2>' +
  "<a>Logout</a></body></html>";

test("public marketing paths are exactly the three live pages", () => {
  for (const p of ["/", "/flights/", "/points-request/", "/flights", "/points-request"]) {
    assert.equal(isPublicMarketingPath(p), true, p);
  }
  for (const p of ["/reservations/", "/whatsapp/", "/customers/12/", "/login/", "/jrm/hotels/"]) {
    assert.equal(isPublicMarketingPath(p), false, p);
  }
});

test("query strings and fragments do not defeat the path gate", () => {
  assert.equal(isPublicMarketingPath("/flights/?utm_source=x"), true);
  assert.equal(isPublicMarketingPath("/reservations/?utm_source=x"), false);
});

test("host gate accepts the public site and rejects the CRM host", () => {
  assert.equal(isPublicMarketingHost(WWW), true);
  assert.equal(isPublicMarketingHost("flynesher.com"), true);
  assert.equal(isPublicMarketingHost("WWW.FlyNesher.com:443"), true);
  assert.equal(isPublicMarketingHost("crm.flynesher.com"), false);
  assert.equal(isPublicMarketingHost("nesher-pay-proxy-production.up.railway.app"), false);
  assert.equal(isPublicMarketingHost(""), false);
});

test("staff CRM pages are detected", () => {
  assert.equal(looksLikeStaffPage(STAFF), true);
  assert.equal(looksLikeStaffPage(MARKETING), false);
});

test("injects the widget on a public marketing page", () => {
  const out = injectSnapEngage(MARKETING, "/", { host: WWW });
  assert.match(out, /code\.snapengage\.com\/js\/c4b14451-5977-400d-b64e-89f1252d5d85\.js/);
  assert.match(out, /begin nesher-snapengage/);
  // must sit inside the document, immediately before </body>
  assert.match(out, /end nesher-snapengage -->\s*<\/body>/);
});

test("injects on /flights/ and /points-request/", () => {
  for (const p of ["/flights/", "/points-request/"]) {
    assert.match(injectSnapEngage(MARKETING, p, { host: WWW }), /snapengage/i, p);
  }
});

test("NEVER injects into the staff CRM", () => {
  // wrong path
  assert.equal(injectSnapEngage(MARKETING, "/reservations/", { host: WWW }), MARKETING);
  // wrong host
  assert.equal(injectSnapEngage(MARKETING, "/", { host: "crm.flynesher.com" }), MARKETING);
  // right host + right path, but staff content served there (logged-in agent on "/")
  assert.equal(injectSnapEngage(STAFF, "/", { host: WWW }), STAFF);
});

test("is idempotent — a second pass adds nothing", () => {
  const once = injectSnapEngage(MARKETING, "/", { host: WWW });
  const twice = injectSnapEngage(once, "/", { host: WWW });
  assert.equal(twice, once);
});

test("stands down if upstream ever ships its own SnapEngage tag", () => {
  const withOwn =
    '<html><body><script src="https://storage.googleapis.com/code.snapengage.com/js/x.js"></script></body></html>';
  assert.equal(injectSnapEngage(withOwn, "/", { host: WWW }), withOwn);
});

test("kill switch and widget-id validation", () => {
  assert.equal(injectSnapEngage(MARKETING, "/", { host: WWW, enabled: false }), MARKETING);
  assert.equal(
    injectSnapEngage(MARKETING, "/", { host: WWW, widgetId: "not-a-uuid" }),
    MARKETING
  );
  assert.equal(isValidWidgetId(DEFAULT_WIDGET_ID), true);
  assert.equal(isValidWidgetId("'); alert(1); //"), false);
});

test("falls back to </html> and to append when </body> is missing", () => {
  const noBody = "<html><head></head><p>hi</p></html>";
  assert.match(injectSnapEngage(noBody, "/", { host: WWW }), /snapengage[\s\S]*<\/html>/);
  const bare = "<p>hi</p>";
  assert.match(injectSnapEngage(bare, "/", { host: WWW }), /snapengage/);
});

test("non-string bodies pass through untouched", () => {
  assert.equal(injectSnapEngage(null, "/", { host: WWW }), null);
  assert.equal(injectSnapEngage("", "/", { host: WWW }), "");
});
