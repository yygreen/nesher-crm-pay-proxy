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
