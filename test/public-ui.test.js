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

test("is idempotent", () => {
  const once = injectPublicHomeUi(HOME, "/");
  assert.equal(injectPublicHomeUi(once, "/"), once);
});

test("injects inside the document", () => {
  assert.match(injectPublicHomeUi(HOME, "/"), /<\/script>\s*<\/body>/);
});
