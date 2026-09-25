/**
 * The hard-card scoreboard. node test/ocr-bench.mjs [--workers N] [--only cat,cat] [--deadline ms]
 *
 * Renders the hard set (test/ocr-hard-fixtures.js) in memory, runs the REAL
 * reader on each image and prints, per category: full number exact, Luhn-ok
 * returns, WRONG numbers accepted, expiry exact, name exact, p50 / p95 time.
 * Never prints a number: the corpus is test numbers only, and the board prints
 * counts. Exit 1 when a target is missed (0 wrong, 95% overall, p95 < 8 s).
 */

import { recognizeCard, luhnOk } from "../ocr-card.js";
import { createEnginePool } from "../ocr-engine.js";
import { buildHardSet } from "./ocr-hard-fixtures.js";

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const workers = Number(arg("--workers", 3));
const only = arg("--only", "") ? arg("--only").split(",") : null;
const deadlineMs = arg("--deadline") ? Number(arg("--deadline")) : undefined;
const verbose = args.includes("--verbose");
const heldOut = args.includes("--heldout");
const totalMs = arg("--total") ? Number(arg("--total")) : undefined;
const NOW = new Date(Date.UTC(2026, 8, 24, 12, 0, 0));

const quiet = { warn: console.warn, error: console.error };
console.warn = () => {};
console.error = () => {};
const out = (...a) => process.stdout.write(a.join(" ") + "\n");

const pool = createEnginePool({ size: workers });
await pool.warm();
const set = await buildHardSet({ now: NOW, only, heldOut });
const rows = [];
for (const s of set) {
  const r = await recognizeCard(Buffer.from(s.buffer), { engine: pool, now: NOW, deadlineMs, totalMs, contentType: s.contentType });
  const got = r.ok ? r.pan : null;
  let verdict;
  if (s.expect === "refuse") verdict = got ? "WRONG" : "ok";
  else if (s.expect === "either") verdict = !got ? (r.error === "two_cards" ? "ok" : "miss") : got === s.pan ? "ok" : got === s.pan2 ? "ok-other" : "WRONG";
  else verdict = !got ? "miss" : got === s.pan ? "ok" : "WRONG";
  rows.push({
    id: s.id, cat: s.cat, verdict, ms: r.ms, passes: r.passes,
    luhn: got ? luhnOk(got) : false,
    expiry: r.ok ? r.expiry === s.expiry : (r.partial && r.partial.expiry === s.expiry),
    name: r.ok ? r.name === s.name : (r.partial && r.partial.name === s.name),
    conf: r.ok ? r.confidence : "none",
    problem: r.ok ? "" : `${r.error}${r.problem ? ":" + r.problem : ""}${r.partial && r.partial.last4 ? ":p4" + (r.partial.last4 === s.pan.slice(-4) ? "=" : "!") : ""}`,
  });
  if (r.pan) r.pan = null;
  if (verbose) out(`${s.id} ${s.cat} ${rows.at(-1).verdict} ${r.ms}ms passes=${r.passes} ${rows.at(-1).conf} ${rows.at(-1).problem}`);
}
await pool.close();

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0; };
const cats = [...new Set(rows.map((r) => r.cat))];
out("category           n  exact  wrong  miss  expiry  name   p50ms  p95ms  notes");
for (const c of cats) {
  const rs = rows.filter((r) => r.cat === c);
  const exact = rs.filter((r) => r.verdict.startsWith("ok")).length;
  const wrong = rs.filter((r) => r.verdict === "WRONG").length;
  const miss = rs.filter((r) => r.verdict === "miss").length;
  const ex = rs.filter((r) => r.expiry).length;
  const nm = rs.filter((r) => r.name).length;
  const notes = rs.filter((r) => r.verdict !== "ok").map((r) => `${r.id}:${r.verdict}${r.problem ? "(" + r.problem + ")" : ""}`).join(" ");
  out(`${c.padEnd(18)} ${String(rs.length).padStart(2)}  ${String(exact).padStart(5)}  ${String(wrong).padStart(5)}  ${String(miss).padStart(4)}  ${String(ex).padStart(6)}  ${String(nm).padStart(4)}  ${String(pct(rs.map((r) => r.ms), 50)).padStart(6)}  ${String(pct(rs.map((r) => r.ms), 95)).padStart(6)}  ${notes}`);
}
const total = rows.length;
const exact = rows.filter((r) => r.verdict.startsWith("ok")).length;
const wrong = rows.filter((r) => r.verdict === "WRONG").length;
const p95 = pct(rows.map((r) => r.ms), 95);
const lowOk = rows.filter((r) => r.verdict === "ok" && r.conf === "low").length;
out(`TOTAL n=${total} exact=${exact} (${((100 * exact) / total).toFixed(1)}%) wrong=${wrong} lowConfidenceCorrect=${lowOk} expiry=${rows.filter((r) => r.expiry).length}/${total} name=${rows.filter((r) => r.name).length}/${total} p50=${pct(rows.map((r) => r.ms), 50)}ms p95=${p95}ms max=${Math.max(...rows.map((r) => r.ms))}ms workers=${workers}${heldOut ? " heldOut" : ""}${totalMs ? " totalMs=" + totalMs : ""}`);
console.warn = quiet.warn;
console.error = quiet.error;
// Plan 13.6's 3 s for a clean card still stands (Gabbai P2): at 3 workers the clean category's p95 must be under 3 s.
const cleanRows = rows.filter((r) => r.cat === "clean");
const cleanP95 = pct(cleanRows.map((r) => r.ms), 95);
const cleanOk = workers !== 3 || !cleanRows.length || cleanP95 < 3000;
if (!cleanOk) out(`CLEAN p95 ${cleanP95} ms is over the 3 s target (plan 13.6)`);
process.exitCode = wrong === 0 && exact / total >= 0.95 && p95 < 8000 && cleanOk ? 0 : 1;
