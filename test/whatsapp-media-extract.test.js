import test from "node:test";
import assert from "node:assert/strict";
import {
  extractWaMedia,
  extractWaStructured,
  inferMediaKind,
  humanizeStoredError,
  humanizeMetaSendError,
} from "../whatsapp-media.js";

test("extractWaMedia finds top-level image id + caption", () => {
  const m = extractWaMedia(
    {
      from: "15551234567",
      type: "image",
      image: {
        id: "123456789012345",
        mime_type: "image/jpeg",
        caption: "passport scan",
      },
    },
    "image"
  );
  assert.equal(m.mediaId, "123456789012345");
  assert.equal(m.mediaKind, "image");
  assert.equal(m.caption, "passport scan");
  assert.equal(m.mimeType, "image/jpeg");
});

test("extractWaMedia finds audio (existing voice-note shape)", () => {
  const m = extractWaMedia(
    { audio: { id: "999", voice: true, mime_type: "audio/ogg; codecs=opus" } },
    "audio"
  );
  assert.equal(m.mediaId, "999");
  assert.equal(m.mediaKind, "audio");
  assert.equal(m.voice, true);
});

test("extractWaMedia finds nested webhook message image", () => {
  const m = extractWaMedia(
    {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    type: "image",
                    image: { id: "555666777", mime_type: "image/png" },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    "image"
  );
  assert.equal(m.mediaId, "555666777");
  assert.equal(m.mediaKind, "image");
});

test("extractWaMedia finds document filename", () => {
  const m = extractWaMedia(
    {
      document: {
        id: "doc1",
        filename: "quote.pdf",
        mime_type: "application/pdf",
      },
    },
    "document"
  );
  assert.equal(m.mediaKind, "document");
  assert.equal(m.filename, "quote.pdf");
});

test("extractWaMedia returns null when no media", () => {
  assert.equal(extractWaMedia({ type: "text", text: { body: "hi" } }, "text"), null);
  assert.equal(extractWaMedia(null, "image"), null);
});

test("extractWaStructured reads reaction emoji + target", () => {
  const s = extractWaStructured(
    {
      type: "reaction",
      reaction: {
        emoji: "👍",
        message_id: "wamid.ABC",
      },
    },
    "reaction"
  );
  assert.equal(s.reaction.emoji, "👍");
  assert.equal(s.reaction.messageId, "wamid.ABC");
});

test("extractWaStructured reads contacts name + phone from vcard", () => {
  const vcard = Buffer.from(
    "BEGIN:VCARD\nVERSION:3.0\nFN:El Al Agent Line\nTEL;type=Mobile:+972 3-977-1010\nEND:VCARD\n",
    "utf8"
  ).toString("base64");
  const s = extractWaStructured(
    {
      type: "contacts",
      contacts: [{ name: { formatted_name: "El Al Agent Line" }, vcard }],
    },
    "contacts"
  );
  assert.equal(s.contacts.length, 1);
  assert.equal(s.contacts[0].name, "El Al Agent Line");
  assert.ok(s.contacts[0].phones.some((p) => /972/.test(p)));
});

test("extractWaStructured reads location + forwarded", () => {
  const s = extractWaStructured(
    {
      type: "location",
      location: {
        latitude: 31.78,
        longitude: 35.22,
        name: "Kotel",
        address: "Jerusalem",
      },
      context: { forwarded: true },
    },
    "location"
  );
  assert.equal(s.location.lat, 31.78);
  assert.equal(s.location.name, "Kotel");
  assert.equal(s.forwarded, true);
});

test("extractWaStructured reads button reply", () => {
  const s = extractWaStructured(
    {
      type: "interactive",
      interactive: {
        type: "button_reply",
        button_reply: { id: "yes", title: "Yes, book it" },
      },
    },
    "interactive"
  );
  assert.equal(s.interactive.title, "Yes, book it");
});

test("inferMediaKind classifies common files", () => {
  assert.equal(inferMediaKind("image/jpeg", "x.jpg"), "image");
  assert.equal(inferMediaKind("video/mp4", "clip.mp4"), "video");
  assert.equal(inferMediaKind("application/pdf", "quote.pdf"), "document");
  assert.equal(inferMediaKind("audio/ogg", "note.ogg"), "audio");
});

test("humanizeStoredError parses Meta JSON auth failures", () => {
  const raw = JSON.stringify({
    error: { message: "Authentication Error", code: 190, type: "OAuthException" },
  });
  const h = humanizeStoredError(raw);
  assert.match(h, /token expired|invalid/i);
});

test("humanizeMetaSendError maps 24h window code", () => {
  const h = humanizeMetaSendError({
    error: { code: 131047, message: "Re-engagement message" },
  });
  assert.match(h, /24h|template/i);
});
