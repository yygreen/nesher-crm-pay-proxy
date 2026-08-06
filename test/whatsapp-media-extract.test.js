import test from "node:test";
import assert from "node:assert/strict";
import { extractWaMedia } from "../whatsapp-media.js";

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
