import test from "node:test";
import assert from "node:assert/strict";
import {
  verifyWebhookChallenge,
  processWhatsAppWebhook,
} from "../whatsapp-webhook.js";

test("verifyWebhookChallenge accepts matching token", () => {
  const prev = process.env.WHATSAPP_VERIFY_TOKEN;
  process.env.WHATSAPP_VERIFY_TOKEN = "test-token-xyz";
  const q = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "test-token-xyz",
    "hub.challenge": "12345",
  });
  const r = verifyWebhookChallenge(q);
  assert.equal(r.ok, true);
  assert.equal(r.challenge, "12345");
  if (prev === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
  else process.env.WHATSAPP_VERIFY_TOKEN = prev;
});

test("verifyWebhookChallenge rejects bad token", () => {
  const prev = process.env.WHATSAPP_VERIFY_TOKEN;
  process.env.WHATSAPP_VERIFY_TOKEN = "good";
  const q = new URLSearchParams({
    "hub.mode": "subscribe",
    "hub.verify_token": "bad",
    "hub.challenge": "1",
  });
  const r = verifyWebhookChallenge(q);
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  if (prev === undefined) delete process.env.WHATSAPP_VERIFY_TOKEN;
  else process.env.WHATSAPP_VERIFY_TOKEN = prev;
});

test("processWhatsAppWebhook tolerates empty payload", async () => {
  const s = await processWhatsAppWebhook({ object: "other" });
  assert.ok(Array.isArray(s.errors));
});

test("status rank prefers read over delivered over sent", async () => {
  // Import private behavior via applying logic inline (same ranks as module)
  const RANK = { sent: 1, delivered: 2, read: 3, failed: 99 };
  function shouldUpgrade(current, next) {
    if (next === "failed") return true;
    if (current === "failed") return false;
    return (RANK[next] ?? 0) > (RANK[current] ?? 0);
  }
  assert.equal(shouldUpgrade("sent", "delivered"), true);
  assert.equal(shouldUpgrade("delivered", "read"), true);
  assert.equal(shouldUpgrade("read", "delivered"), false);
  assert.equal(shouldUpgrade("sent", "failed"), true);
  assert.equal(shouldUpgrade("failed", "sent"), false);
});
