import test from "node:test";
import assert from "node:assert/strict";
import { injectWhatsAppUi } from "../whatsapp-ui.js";

const sample = `<!DOCTYPE html><html><head><title>WhatsApp Inbox</title></head>
<body><div class="container"><div class="card">
<div class="page-header"><h1>WhatsApp Inbox</h1></div>
<table><tbody></tbody></table>
</div></div></body></html>`;

test("new-chat UI explains Meta approval + open-if-exists", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/");
  assert.match(out, /Open if exists/);
  assert.match(out, /Pending Meta approval|no approved template yet|Waiting for Meta/);
  assert.match(out, /openExistingOnly/);
  assert.match(out, /972501234567|0501234567/);
  // sample hello_world must be called out as unusable on real numbers
  assert.match(out, /hello_world|Sample hello_world/);
});

test("new-chat UI normalizes IL local numbers", () => {
  const out = injectWhatsAppUi(sample, "/whatsapp/");
  const m = out.match(/<script id="nesher-wa-ui-js">([\s\S]*?)<\/script>/);
  assert.ok(m);
  assert.match(m[1], /function normalizeDigits/);
  assert.match(m[1], /972/);
});
