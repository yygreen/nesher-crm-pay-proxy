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

test("injected script covers reactions, contacts, location, and media send", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/4/");
  const m = out.match(/<script id="nesher-wa-ui-js">([\s\S]*?)<\/script>/);
  assert.ok(m);
  const body = m[1];
  for (const probe of [
    "isReactionMsg",
    "isContactsMsg",
    "isLocationMsg",
    "contactsBubbleBody",
    "locationBubbleBody",
    "appendReactions",
    "send-media",
    "sendMediaFile",
    "guessKind",
  ]) {
    assert.ok(body.includes(probe), "missing complete-media piece: " + probe);
  }
  assert.match(out, /wa-contact-card|wa-loc|wa-reactions/);
});

test("injected script hardens: 24h window, paste, drop, compress, session", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/4/");
  const m = out.match(/<script id="nesher-wa-ui-js">([\s\S]*?)<\/script>/);
  assert.ok(m);
  const body = m[1];
  for (const probe of [
    "updateWindowBanner",
    "freeFormOpen",
    "compressImageIfNeeded",
    "SESSION_EXPIRED",
    "wa-drop-active",
    "paste",
    "View-once media",
    "auto-stopped at 3 minutes",
  ]) {
    assert.ok(body.includes(probe), "missing harden piece: " + probe);
  }
  assert.match(out, /wa-window-banner|wa-quote/);
});

test("round-2 hardens: IL time, linkify phones, live status patch, copy", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/4/");
  const m = out.match(/<script id="nesher-wa-ui-js">([\s\S]*?)<\/script>/);
  assert.ok(m);
  const body = m[1];
  for (const probe of [
    "Asia/Jerusalem",
    "ilParts",
    "mailto:",
    "tel:",
    "reactionKey",
    "wa-copy-btn",
    "copyText",
    "document.title",
  ]) {
    assert.ok(body.includes(probe), "missing round-2 piece: " + probe);
  }
});
