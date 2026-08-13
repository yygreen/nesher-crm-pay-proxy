import test from "node:test";
import assert from "node:assert/strict";
import { injectPublicHomeUi, isHomePath } from "../public-ui.js";

// Trimmed from the live homepage.
const HOME =
  '<html><body><div class="floating-contact-buttons" aria-label="Contact options">' +
  '<button class="floating-contact-button floating-chat-button" data-coming-soon-name="Website chat"></button>' +
  '<button class="floating-contact-button floating-whatsapp-button" data-coming-soon-name="WhatsApp"></button>' +
  '</div><div class="coming-soon-toast" id="coming-soon-toast">Coming soon</div></body></html>';

test("home path matching", () => {
  assert.equal(isHomePath("/"), true);
  assert.equal(isHomePath("/?utm=x"), true);
  assert.equal(isHomePath("/flights/"), false);
  assert.equal(isHomePath("/reservations/"), false);
});

test("hides the placeholder chat button on the homepage", () => {
  const out = injectPublicHomeUi(HOME, "/");
  assert.match(out, /\.floating-contact-buttons \.floating-chat-button \{ display: none !important; \}/);
  assert.match(out, /nesher-public-ui-js/);
});

test("does NOT hide the WhatsApp button outright — it is repositioned", () => {
  const out = injectPublicHomeUi(HOME, "/");
  assert.doesNotMatch(out, /\.floating-whatsapp-button\s*\{[^}]*display:\s*none/);
  assert.match(out, /data-se-state="panel"/);
});

test("only touches the homepage", () => {
  for (const p of ["/flights/", "/points-request/", "/reservations/"]) {
    assert.equal(injectPublicHomeUi(HOME, p), HOME, p);
  }
});

test("skips non-public hosts", () => {
  assert.equal(injectPublicHomeUi(HOME, "/", { isPublicHost: false }), HOME);
});

test("no-ops if upstream drops the buttons (their fix lands)", () => {
  const plain = "<html><body><h1>Nesher</h1></body></html>";
  assert.equal(injectPublicHomeUi(plain, "/"), plain);
});

test("classifies SnapEngage's launcher by size, not height alone", () => {
  const out = injectPublicHomeUi(HOME, "/");
  // regression: the 300x85 proactive invite bar used to pass as the 60x60
  // launcher, anchoring the button to the wrong element and pushing it up
  // into the hero card.
  assert.match(out, /LAUNCHER_MAX = 90/);
  assert.match(out, /r\.width <= LAUNCHER_MAX && r\.height <= LAUNCHER_MAX/);
});

test("centre-aligns with the launcher rather than matching right edges", () => {
  const out = injectPublicHomeUi(HOME, "/");
  assert.match(out, /launcher\.left \+ launcher\.width \/ 2/);
  assert.match(out, /box\.offsetWidth \/ 2/);
});

test("refuses to sit on top of the hero card", () => {
  const out = injectPublicHomeUi(HOME, "/");
  assert.match(out, /KEEP_CLEAR = "\.premium-service-panel"/);
  assert.match(out, /data-se-state="blocked"/);
  assert.match(out, /shouldStandDown/);
  assert.match(out, /addEventListener\("scroll", apply/);
});

test("is idempotent", () => {
  const once = injectPublicHomeUi(HOME, "/");
  assert.equal(injectPublicHomeUi(once, "/"), once);
});

test("injects inside the document", () => {
  assert.match(injectPublicHomeUi(HOME, "/"), /<\/script>\s*<\/body>/);
});
