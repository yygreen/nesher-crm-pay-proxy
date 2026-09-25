// READ ONLY drift proof (Gabbai money-sat C5, "one fact, two repos"): crm-search's REMAINING_BALANCE_SQL over EVERY
// reservation must equal the CRM's own Reservation.remaining_balance (the Django dump from scripts/dj-balance.py).
// Prints counts and reservation ids only - never an amount, a name or a URL. Exit 0 only when every reservation agrees.
//   node scripts/drift-balance.mjs <path to dj-balance.json>
// The database URL is read into memory from the Railway project token in ~/.api-keys.env and never written anywhere.
// Not part of the service image (the Dockerfile COPY names its files; scripts/ is not among them).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { REMAINING_BALANCE_SQL } from "../crm-search.js";

const dumpPath = process.argv[2];
if (!dumpPath || !fs.existsSync(dumpPath)) { console.log(JSON.stringify({ ok: false, error: "dump_missing", usage: "node scripts/drift-balance.mjs <dj-balance.json>" })); process.exit(2); }
const env = {};
for (const line of fs.readFileSync(path.join(process.env.USERPROFILE || process.env.HOME || "", ".api-keys.env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}
const RAILWAY = { project: "b1c9a5a0-6b73-470a-8f48-9fd07817b1aa", environment: "d6681e4d-5562-4f52-b560-175689ccfb00", postgres: "2b1cf08f-c6fc-4e93-8e5c-5b2feeed5c18" };
const gq = `{ variables(projectId: "${RAILWAY.project}", environmentId: "${RAILWAY.environment}", serviceId: "${RAILWAY.postgres}") }`;
const vr = await fetch("https://backboard.railway.com/graphql/v2", { method: "POST", headers: { "content-type": "application/json", "Project-Access-Token": env.RAILWAY_PROJECT_TOKEN || "" }, body: JSON.stringify({ query: gq }) });
const url = (await vr.json())?.data?.variables?.DATABASE_PUBLIC_URL;
if (!url) { console.log(JSON.stringify({ ok: false, error: "database_url_unavailable" })); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
let rows;
try {
  await c.query("BEGIN TRANSACTION READ ONLY");
  const ids = (await c.query("SELECT id FROM core_reservation ORDER BY id")).rows.map((x) => String(x.id));
  rows = (await c.query(REMAINING_BALANCE_SQL, [ids])).rows;
} finally {
  try { await c.query("ROLLBACK"); } catch { /* nothing was written */ }
  await c.end();
}
const dj = JSON.parse(fs.readFileSync(dumpPath, "utf8").trim().split(/\r?\n/).pop());
const mine = new Map(rows.map((x) => [String(x.id), Math.round(Number(x.remaining_balance) * 100)]));
let equal = 0;
const differ = [];
for (const [id, b] of dj.rows) { if (mine.get(String(id)) === Math.round(Number(b) * 100)) equal++; else differ.push(id); }
const out = { ok: differ.length === 0 && rows.length === dj.n, reservations_sql: rows.length, django: dj.n, equal, differ: differ.length, differ_ids: differ.slice(0, 10) };
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
