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
const HEAVY = ["tilt", "glare", "pattern", "screen-moire", "dark-metal"];

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
