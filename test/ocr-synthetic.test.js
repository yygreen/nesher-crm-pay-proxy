/**
 * Plan 13.7: the 60-image synthetic set through the REAL engine.
 *   - 95% exact on clean images (48 clean: 6 families x embossed/flat x 4 rotations)
 *   - 100% never wrong with high confidence (all 60)
 *   - p50 / p95 photo-to-read time printed (13.6 target: under 3 s on the container)
 *   - every buffer zeroed after each read; no PAN in anything logged during the suite
 * Images are rendered in memory at test time and never written anywhere.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { recognizeCard } from "../ocr-card.js";
import { sharedEnginePool } from "../ocr-engine.js";
import { buildSyntheticSet, groupDigits } from "./ocr-fixtures.js";

const NOW = new Date(Date.UTC(2026, 8, 23, 12, 0, 0));

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

describe("synthetic card set (real tesseract.js)", () => {
  const captured = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  let pool;
  let set;
  let results;

  before(async () => {
    for (const k of Object.keys(orig)) {
      console[k] = (...a) => captured.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    }
    pool = sharedEnginePool();
    await pool.warm();
    set = await buildSyntheticSet({ now: NOW });
  });

  after(async () => {
    for (const k of Object.keys(orig)) console[k] = orig[k];
    if (pool) await pool.close();
  });

  it("renders 60 images: 48 clean across four rotations, 6 glare, 6 blur", () => {
    assert.equal(set.length, 60);
    assert.equal(set.filter((s) => s.clean).length, 48);
    assert.equal(set.filter((s) => s.effect === "glare").length, 6);
    assert.equal(set.filter((s) => s.effect === "blur").length, 6);
    assert.equal(new Set(set.map((s) => s.pan)).size, 12);
    for (const s of set) assert.ok(s.buffer.length > 10_000, `${s.id} rendered`);
  });

  it("reads them", async () => {
    results = [];
    for (const s of set) {
      const trace = { buffers: [] };
      const input = Buffer.from(s.buffer);
      const r = await recognizeCard(input, { engine: pool, now: NOW, trace });
      for (const b of trace.buffers) assert.ok(b.every((x) => x === 0), `${s.id}: buffer zeroed`);
      assert.ok(input.every((x) => x === 0), `${s.id}: input zeroed`);
      results.push({
        id: s.id,
        clean: s.clean,
        effect: s.effect,
        rotation: s.rotation,
        family: s.family.label,
        embossed: s.embossed,
        ok: r.ok,
        exact: r.ok && r.pan === s.pan,
        confidence: r.ok ? r.confidence : "none",
        expiryOk: r.ok && r.expiry === s.expiry,
        nameOk: r.ok && r.name === s.name,
        ms: r.ms,
        passes: r.passes,
        foundRotation: r.ok ? r.rotation : null,
      });
    }
    assert.equal(results.length, 60);
  });

  it("95% exact on clean images; 100% never wrong with high confidence; timings", () => {
    const clean = results.filter((r) => r.clean);
    const cleanExact = clean.filter((r) => r.exact).length;
    const wrongHigh = results.filter((r) => r.ok && !r.exact && r.confidence === "high");
    const allExact = results.filter((r) => r.exact).length;
    const highExact = results.filter((r) => r.exact && r.confidence === "high").length;
    const lowExact = results.filter((r) => r.exact && r.confidence === "low").length;
    const expiryOk = results.filter((r) => r.expiryOk).length;
    const nameOk = results.filter((r) => r.nameOk).length;
    const ms = results.map((r) => r.ms).sort((a, b) => a - b);
    const p50 = pct(ms, 50);
    const p95 = pct(ms, 95);
    const maxPasses = Math.max(...results.map((r) => r.passes));
    const byRot = {};
    for (const r of clean) {
      byRot[r.rotation] = byRot[r.rotation] || { n: 0, exact: 0 };
      byRot[r.rotation].n += 1;
      if (r.exact) byRot[r.rotation].exact += 1;
    }
    const misses = results.filter((r) => !r.exact).map((r) => `${r.id}:${r.family}:${r.embossed ? "emb" : "flat"}:${r.rotation}:${r.effect || "clean"}:${r.ok ? r.confidence : "none"}`);
    const summary = `ocr-synthetic clean=${cleanExact}/${clean.length} all=${allExact}/60 high=${highExact} low=${lowExact} wrongHigh=${wrongHigh.length} expiry=${expiryOk}/60 name=${nameOk}/60 p50=${p50}ms p95=${p95}ms max=${ms[ms.length - 1]}ms maxPasses=${maxPasses} byRotation=${JSON.stringify(byRot)} misses=${misses.join(",") || "none"} workers=${pool.size}`;
    orig.log(summary);
    assert.equal(wrongHigh.length, 0, `never wrong with high confidence: ${JSON.stringify(wrongHigh)}`);
    assert.ok(cleanExact / clean.length >= 0.95, `clean exact ${cleanExact}/${clean.length}`);
    // Joseph, 24 Sep: a read may take "under about 8 s" (the 13.6 target of 3 s predates the line rescue
    // and PaddleOCR). npm test runs files in parallel on one CPU, so this is a ceiling, not a benchmark:
    // the real figures come from node test/ocr-bench.mjs on an idle machine.
    assert.ok(p95 < 8000, `p95 ${p95}ms under the 8 s target (measured on this machine)`);
  });

  it("nothing logged during the suite carries a card number", () => {
    const pans = new Set(set.map((s) => s.pan));
    const joined = captured.join("\n");
    for (const pan of pans) {
      assert.equal(joined.includes(pan), false, "raw PAN in a log line");
      assert.equal(joined.includes(groupDigits(pan)), false, "grouped PAN in a log line");
    }
    assert.doesNotMatch(joined, /\b\d{13,19}\b/, "no long digit run logged at all");
  });
});
