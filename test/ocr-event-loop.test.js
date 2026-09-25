/**
 * The card reader must never freeze the proxy (Gabbai B1, 25 Sep 2026).
 *
 * This process fronts crm.flynesher.com for every rep, the /pay guest pages,
 * the NMI webhook and the money hop. A read that blocks the event loop stops
 * all of them. Written BEFORE the fix: on 2626457 the glyph matcher ran on the
 * main thread and blocked the loop for ~1 s on a tilted card.
 *
 * Measures the longest single event-loop stall while reading the hardest
 * images of the hard set with the real engine. Ceiling: 100 ms.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { recognizeCard } from "../ocr-card.js";
import { createEnginePool } from "../ocr-engine.js";
import { buildHardSet } from "./ocr-hard-fixtures.js";

export const LOOP_CEILING_MS = 100;
const NOW = new Date(Date.UTC(2026, 8, 24, 12));
const HEAVY = ["tilt", "glare", "pattern", "screen-moire", "dark-metal", "white-on-white"];

describe("the card reader never freezes the proxy", () => {
  const quiet = { warn: console.warn, error: console.error };
  let pool;
  let set;
  before(async () => {
    console.warn = () => {};
    console.error = () => {};
    pool = createEnginePool({ size: 3 });
    await pool.warm();
    set = (await buildHardSet({ now: NOW, only: HEAVY })).filter((_, i) => i % 2 === 0);
  });
  after(async () => {
    console.warn = quiet.warn;
    console.error = quiet.error;
    if (pool) await pool.close();
  });

  it(`no read stalls the event loop for more than ${LOOP_CEILING_MS} ms`, async () => {
    let worst = 0;
    let worstId = "";
    for (const s of set) {
      const h = monitorEventLoopDelay({ resolution: 10 });
      h.enable();
      const r = await recognizeCard(Buffer.from(s.buffer), { engine: pool, now: NOW });
      h.disable();
      const ms = h.max / 1e6;
      if (ms > worst) { worst = ms; worstId = s.id; }
      if (r.pan) r.pan = null;
    }
    process.stdout.write(`ocr-event-loop images=${set.length} worstStallMs=${worst.toFixed(0)} at ${worstId}\n`);
    assert.ok(worst <= LOOP_CEILING_MS, `worst stall ${worst.toFixed(0)} ms at ${worstId}`);
  });
});

describe("a glyph worker that never answers cannot hold a read (Gabbai D1)", () => {
  it("the read returns within its budget + 500 ms, and the next read works on a fresh worker", async () => {
    const { fileURLToPath } = await import("node:url");
    const { _setGlyphWorkerFileForTests, glyphWorkerStats } = await import("../ocr-glyph-worker.js");
    const PAN = "4539578763621486";
    const fake = (script) => ({ async recognize(buf, o) { return { text: script(o), confidence: 80 }; } });
    const { tinyImage } = await import("./ocr-fixtures.js");
    _setGlyphWorkerFileForTests(fileURLToPath(new URL("./glyph-worker-stub.mjs", import.meta.url)));
    try {
      const before = glyphWorkerStats.timeouts;
      const t0 = Date.now();
      const r = await recognizeCard(await tinyImage(), { engine: fake(() => ""), now: NOW, deadlineMs: 1000, totalMs: 2000 });
      const took = Date.now() - t0;
      assert.equal(r.ok, false);
      assert.ok(took <= 2000 + 500, `returned in ${took} ms`);
      assert.ok(glyphWorkerStats.timeouts > before, "the silent worker was cut off");
    } finally {
      _setGlyphWorkerFileForTests(null);
    }
    let n = 0;
    const r2 = await recognizeCard(await tinyImage(), { engine: fake((o) => (o.charset === "text" ? "" : n++ < 2 ? PAN : "")), now: NOW });
    assert.equal(r2.ok, true, "the next read works");
    assert.equal(r2.pan, PAN);
    r2.pan = null;
  });
});
