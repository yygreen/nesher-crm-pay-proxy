/**
 * D3 (25 Sep): the synthetic clean cards turned 90 / 180 / 270. The number was read, the expiry and the
 * name were not (0/24 each at 90+180 on 0e14f81), so the photo was refused with expiry_unknown.
 * node test/ocr-rotation-bench.mjs [--rot 90,180] [--workers 3]. Prints counts only, never a number.
 */
import { recognizeCard } from "../ocr-card.js";
import { createEnginePool } from "../ocr-engine.js";
import { syntheticSpecs, renderCard } from "./ocr-fixtures.js";

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const rots = arg("--rot", "90,180").split(",").map(Number);
const workers = Number(arg("--workers", 3));
const NOW = new Date(Date.UTC(2026, 8, 24, 12, 0, 0));
console.warn = () => {};
console.error = () => {};
const pool = createEnginePool({ size: workers });
await pool.warm();
const specs = syntheticSpecs({ now: NOW }).filter((s) => s.clean && rots.includes(s.rotation));
const by = {};
let wrong = 0;
for (const s of specs) {
  const buf = await renderCard(s);
  const r = await recognizeCard(buf, { engine: pool, now: NOW });
  const k = String(s.rotation);
  const b = by[k] || (by[k] = { n: 0, pan: 0, expiry: 0, name: 0 });
  b.n++;
  if (r.ok && r.pan === s.pan) b.pan++;
  else if (r.ok) wrong++;
  if (r.ok && r.expiry === s.expiry) b.expiry++;
  if (r.ok && r.name === s.name) b.name++;
  if (r.pan) r.pan = null;
}
await pool.close();
for (const [k, b] of Object.entries(by)) process.stdout.write(`rot ${k}: n=${b.n} number=${b.pan} expiry=${b.expiry} name=${b.name}\n`);
process.stdout.write(`wrong=${wrong}\n`);
