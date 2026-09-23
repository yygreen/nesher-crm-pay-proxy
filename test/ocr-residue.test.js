// Audit 23 Sep: tesseract.js writes each image to the worker's in-memory FS at
// /input and never deletes it. Real tesseract.js, real workers: prove the leak
// exists without the scrub, and that every card read now ends with no card
// bytes at /input in any worker - on success, failure and throw alike.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEnginePool, BLANK_PNG } from "../ocr-engine.js";
import { recognizeCard } from "../ocr-card.js";
import { buildSyntheticSet } from "./ocr-fixtures.js";

const NOW = new Date("2026-09-23T12:00:00Z");

describe("worker /input residue (real tesseract.js)", () => {
  let pool;
  let card;
  before(async () => {
    pool = createEnginePool({ size: 2 });
    await pool.warm();
    const set = await buildSyntheticSet({ now: NOW });
    card = set.find((s) => s.clean && s.rotation === 0);
  });
  after(async () => { if (pool) await pool.close(); });

  it("the leak is real: a bare recognize leaves the image at /input", async () => {
    await pool.recognize(Buffer.from(card.buffer), { mode: "block", charset: "digits" });
    const residue = await pool.inputResidue();
    assert.ok(residue.some((n) => n > BLANK_PNG.length), `expected card bytes at /input, got ${residue}`);
    assert.equal(await pool.scrub() >= 1, true);
    assert.deepEqual(await pool.inputResidue(), residue.map(() => 0));
  });

  it("a successful read leaves nothing at /input, and the answer is unchanged", async () => {
    const r = await recognizeCard(Buffer.from(card.buffer), { engine: pool, now: NOW });
    assert.equal(r.ok, true);
    assert.equal(r.pan, card.pan);
    assert.deepEqual(await pool.inputResidue(), [0, 0]);
  });

  it("a failed read (no card in the picture) leaves nothing at /input", async () => {
    const sharp = (await import("sharp")).default;
    const noise = await sharp({ create: { width: 900, height: 560, channels: 3, background: { r: 90, g: 120, b: 160 } } }).png().toBuffer();
    const r = await recognizeCard(noise, { engine: pool, now: NOW });
    assert.equal(r.ok, false);
    assert.deepEqual(await pool.inputResidue(), [0, 0]);
  });

  it("a read that throws midway still scrubs every worker that touched the card", async () => {
    let calls = 0;
    const flaky = {
      recognize: async (buf, o) => {
        calls += 1;
        if (calls === 3) throw new Error("worker died");
        return pool.recognize(buf, o);
      },
      scrub: () => pool.scrub(),
    };
    await assert.rejects(recognizeCard(Buffer.from(card.buffer), { engine: flaky, now: NOW }), /worker died/);
    assert.deepEqual(await pool.inputResidue(), [0, 0]);
  });
});
