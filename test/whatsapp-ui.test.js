import test from "node:test";
import assert from "node:assert/strict";
import { injectWhatsAppUi, WA_UI_MARKER } from "../whatsapp-ui.js";

const sample = `<!DOCTYPE html><html><head><title>WhatsApp Inbox</title></head>
<body><div class="container"><div class="card">
<div class="page-header"><h1>WhatsApp Inbox</h1><p class="muted">Shared</p></div>
<table><tbody><tr>
<td>Design Test Guest</td><td>Not linked</td><td>15551234567</td><td>1</td>
<td>Aug 04, 2026 22:27</td><td class="actions"><a href="/whatsapp/2/">Open Chat</a></td>
</tr></tbody></table>
</div></div></body></html>`;

test("injectWhatsAppUi adds assets on /whatsapp/", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/");
  assert.match(out, new RegExp(WA_UI_MARKER + "-css"));
  assert.match(out, new RegExp(WA_UI_MARKER + "-js"));
  assert.match(out, /wa-chat-list|nesher-wa-page|25d366/);
});

test("injectWhatsAppUi skips non-whatsapp paths", () => {
  const out = injectWhatsAppUi(sample, "/dashboard/");
  assert.equal(out.includes(WA_UI_MARKER + "-js"), false);
});

test("injectWhatsAppUi is idempotent", () => {
  const once = injectWhatsAppUi(sample, "/whatsapp/");
  const twice = injectWhatsAppUi(once, "/whatsapp/");
  assert.equal(twice, once);
});

test("injectWhatsAppUi adds assets on chat detail pages", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/4/");
  assert.match(out, new RegExp(WA_UI_MARKER + "-js"));
  assert.match(out, /wa-composer|wa-msgs|wa-details/);
});

test("injected browser script is syntactically valid JS", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/");
  const m = out.match(/<script id="nesher-wa-ui-js">([\s\S]*?)<\/script>/);
  assert.ok(m, "script block present");
  assert.doesNotThrow(() => new Function(m[1]));
});

test("template-literal escaping kept regexes intact in the emitted script", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/");
  const m = out.match(/<script id="nesher-wa-ui-js">([\s\S]*?)<\/script>/);
  const body = m[1];
  for (const probe of [
    "/^\\/whatsapp\\/(\\d+)\\/?$/",
    "replace(/\\D/g",
    "split(/\\s+/)",
  ]) {
    assert.ok(body.includes(probe), "missing regex: " + probe);
  }
});

test("injected script can render image / media bubbles", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/4/");
  const m = out.match(/<script id="nesher-wa-ui-js">([\s\S]*?)<\/script>/);
  assert.ok(m, "script block present");
  const body = m[1];
  for (const probe of [
    "isImageMsg",
    "mediaBubbleBody",
    "wa-has-media",
    "openLightbox",
    "__nesher_wa/media/",
    "image message received",
  ]) {
    assert.ok(body.includes(probe), "missing image UI piece: " + probe);
  }
  assert.match(out, /wa-media|wa-lightbox/);
});
