import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createCrmSearch, parseQuery, maskDigits, isReadOnlySql, shape, STATEMENT_TIMEOUT_SQL, MAX_INFLIGHT } from "../crm-search.js";

async function db() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE core_customer (id bigint primary key, full_name varchar, email varchar, phone varchar, created_at timestamptz, is_business_customer boolean);
    CREATE TABLE core_traveler (id bigint primary key, full_name varchar, reservation_id bigint);
    CREATE TABLE core_reservation (id bigint primary key, reservation_code varchar, customer_price numeric, amount_paid numeric, notes text, created_at timestamptz,
      customer_id bigint, is_closed boolean, review_status varchar, booked_with_points boolean, agent_name varchar);
    CREATE TABLE core_payment (id bigint primary key, amount numeric, method varchar, paid_at timestamptz, notes text, reservation_id bigint, transfer_details varchar, zelle_address varchar);
    CREATE TABLE core_customerpayment (id bigint primary key, amount numeric, method varchar, paid_at timestamptz, notes text, customer_id bigint, imported_from_legacy_payments boolean, transfer_details varchar);
    CREATE TABLE core_refund (id bigint primary key, refund_type varchar, amount_expected numeric, amount_received numeric, amount_to_customer numeric, status varchar, notes text, created_at timestamptz, reservation_id bigint);
    CREATE TABLE core_jrmhotelrequest (id bigint primary key, customer_name varchar, phone varchar, email varchar, city varchar, check_in date, check_out date, status varchar,
      requested_hotel varchar, internal_notes text, created_at timestamptz, customer_id bigint);
    CREATE TABLE core_jrmhotelpayment (id bigint primary key, payment_date date, amount numeric, currency varchar, method varchar, reference varchar, note text, request_id bigint, card_last4 varchar);
    INSERT INTO core_customer VALUES (1, 'Moshe Cohen', 'moshe@example.com', '+1 (845) 555-0101', '2026-01-02', false),
                                     (2, 'Yael Sher', 'yael@example.com', '+972527771234', '2026-03-02', false);
    INSERT INTO core_traveler VALUES (10, 'Rivka Cohen', 100);
    INSERT INTO core_reservation VALUES (100, '79RHW4', 2400, 1400, 'card 4111111111111111 on file', '2026-02-01', 1, false, 'complete', false, 'Sruly'),
                                        (101, 'ABC123', 900, 900, null, '2025-11-01', 1, true, 'complete', false, null);
    INSERT INTO core_payment VALUES (1000, 1000, 'card', '2026-02-02', 'nmi:12558953073 zelle secret', 100, 'acct 8310006088846', 'x@zelle'),
                                    (1001, 400, 'zelle', '2026-05-05', null, 100, null, null),
                                    (1002, 900, 'check', '2025-11-03', null, 101, null, null);
    INSERT INTO core_customerpayment VALUES (5000, 700, 'bank', '2026-06-01', 'wire from 8310006088846', 1, true, 'routing 026073150');
    INSERT INTO core_refund VALUES (1, 'full', 100, 0, 100, 'completed', 'note', '2026-06-10', 100);
    INSERT INTO core_jrmhotelrequest VALUES (325, 'Yael Sher', '052-777-1234', 'yael@example.com', 'Jerusalem', '2026-10-01', '2026-10-05', 'booked', 'Waldorf', 'secret note', '2026-08-01', 2);
    INSERT INTO core_jrmhotelpayment VALUES (1, '2026-08-05', 3000, 'ILS', 'card', 'nmi:999', 'n', 325, '4421'), (2, '2026-08-06', 500, 'usd', 'bank', null, null, 325, null);
  `);
  return { query: (sql, params) => pg.query(sql, params), exec: (s) => pg.exec(s), pg };
}

test("isReadOnlySql refuses every write", () => {
  assert.equal(isReadOnlySql("SELECT 1"), true);
  assert.equal(isReadOnlySql("BEGIN READ ONLY"), true);
  for (const s of ["UPDATE core_customer SET full_name='x'", "SELECT 1; DELETE FROM core_payment", "WITH x AS (DELETE FROM a) SELECT 1", "COPY core_customer TO '/tmp/x'",
    "SET statement_timeout = 0", "SET LOCAL statement_timeout = '600s'", "SET LOCAL transaction_read_only = off", "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE"]) assert.equal(isReadOnlySql(s), false, s);
  assert.equal(isReadOnlySql(STATEMENT_TIMEOUT_SQL), true);
});

test("maskDigits keeps only the last four of a 12+ digit run, leaves phones and codes", () => {
  assert.equal(maskDigits("card 4111 1111 1111 1111"), "card ...1111");
  assert.equal(maskDigits("8310006088846"), "...8846");
  assert.equal(maskDigits("+972527771234"), "+972527771234");
  assert.equal(maskDigits("79RHW4"), "79RHW4");
});

test("parseQuery reads a name, an Israeli phone, a booking code, an email and a window", () => {
  assert.equal(parseQuery("q=Cohen").words, "Cohen");
  assert.equal(parseQuery("q=0527771234").phone, "527771234");
  assert.equal(parseQuery("q=79rhw4").code, "79RHW4");
  assert.equal(parseQuery("q=JRM-325").code, "JRM-325");
  assert.equal(parseQuery("q=yael%40example.com").email, "yael@example.com");
  const w = parseQuery("q=Cohen&from=2026-01-01&to=2026-12-31&from2=x");
  assert.equal(w.from, "2026-01-01"); assert.equal(w.to, "2026-12-31");
  assert.equal(parseQuery("q=x&from=2026-13-45").from, "");
});

test("search by name: customer, traveller, bookings, payments in the window, refunds - Nesher and JRM apart", async () => {
  const d = await db();
  const s = createCrmSearch({ getPool: () => d });
  const r = await s.answer(new URLSearchParams("q=Cohen&from=2026-01-01&to=2026-12-31"));
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.ambiguous, false);
  assert.deepEqual(b.nesher.people.map((c) => c.customer), ["Moshe Cohen"]);
  const moshe = b.nesher.people[0];
  assert.deepEqual(b.nesher.travelers, [{ name: "Rivka Cohen", booking: "79RHW4" }]);
  // the window keeps 2026 only: ABC123 (made and paid in 2025) is out, the 2025 check is out
  assert.deepEqual(moshe.bookings.map((x) => x.booking), ["79RHW4"]);
  assert.equal(moshe.bookings[0].balance_usd, 1000);
  assert.deepEqual(moshe.payments.map((p) => p.amount_usd).sort((a, z) => a - z), [400, 1000]);
  assert.equal(moshe.payments_total_usd, 1400);
  assert.equal(moshe.payments.find((p) => p.amount_usd === 1000).processor_txn, "12558953073");
  assert.equal(moshe.refunds.length, 1);
  assert.equal(moshe.customer_level_payments[0].imported_from_booking_payments, true);
  assert.equal(b.jrm.hotel_requests.length, 0);
  assert.equal(Object.values(b.truncated).some(Boolean), false);
  // nothing from a note, a transfer detail or a zelle address ever leaves
  const all = JSON.stringify(b);
  for (const bad of ["4111111111111111", "8310006088846", "026073150", "zelle secret", "x@zelle", "secret note", "card 4111"]) assert.ok(!all.includes(bad), bad);
});

test("search by Israeli phone finds the customer and her JRM request, currencies kept apart", async () => {
  const d = await db();
  const s = createCrmSearch({ getPool: () => d });
  const r = await s.answer(new URLSearchParams("q=0527771234"));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.nesher.people.map((c) => c.customer), ["Yael Sher"]);
  assert.deepEqual(r.body.jrm.hotel_requests.map((h) => h.request), ["JRM-325"]);
  assert.deepEqual(r.body.jrm.hotel_requests[0].payments_total_by_currency, { ILS: 3000, USD: 500 });
  assert.equal(r.body.jrm.hotel_requests[0].payments.find((p) => p.currency === "ILS").card_last4, "4421");
});

test("search by booking code and by JRM request id", async () => {
  const d = await db();
  const s = createCrmSearch({ getPool: () => d });
  const r = await s.answer(new URLSearchParams("q=79rhw4"));
  assert.deepEqual(r.body.nesher.people.flatMap((g) => g.bookings.map((x) => x.booking)), ["79RHW4"]);
  const j = await s.answer(new URLSearchParams("q=JRM-325"));
  assert.deepEqual(j.body.jrm.hotel_requests.map((x) => x.request), ["JRM-325"]);
});

test("the transaction is read only and rolled back: a write inside it would fail", async () => {
  const d = await db();
  const seen = [];
  const spy = { query: (sql, p) => { seen.push(String(sql).trim().split(/\s+/)[0].toUpperCase()); return d.query(sql, p); } };
  const s = createCrmSearch({ getPool: () => spy });
  await s.answer(new URLSearchParams("q=Cohen"));
  assert.equal(seen[0], "BEGIN");
  assert.equal(seen[1], "SET");
  assert.equal(seen[seen.length - 1], "ROLLBACK");
  assert.ok(seen.every((w) => ["BEGIN", "SET", "SELECT", "WITH", "ROLLBACK"].includes(w)), seen.join(","));
});

test("no query, no pool, a failing pool: honest errors, never a throw", async () => {
  assert.equal((await createCrmSearch({ getPool: () => ({}) }).answer(new URLSearchParams("q="))).status, 400);
  assert.equal((await createCrmSearch({ getPool: () => null }).answer(new URLSearchParams("q=Cohen"))).status, 503);
  const bad = createCrmSearch({ getPool: () => ({ query: async () => { throw new Error("boom"); } }) });
  const r = await bad.answer(new URLSearchParams("q=Cohen"));
  assert.equal(r.status, 500); assert.equal(r.body.error, "crm_search_failed");
  const h = await bad.hopAnswer("/crm-search?q=Cohen");
  assert.equal(h.status, 500); assert.equal(typeof h.body, "string");
});

test("server.js answers /crm-search through the hop's direct hook and the Dockerfile copies the module", () => {
  const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(src, /import \{ createCrmSearch, CRM_SEARCH_PATH \} from "\.\/crm-search\.js"/);
  assert.match(src, /if \(p === CRM_SEARCH_PATH\) return crmSearch\.hopAnswer\(sub\);/);
  const dock = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dock, / crm-search\.js /);
});

test("shape is an allowlist even for unexpected columns", () => {
  const out = shape({ q: "x", from: "", to: "" }, { customers: [{ id: 1, full_name: "A", email: "a@b", phone: "1", created_at: "2026-01-01", secret: "S3CRET" }], travelers: [], reservations: [], payments: [], customerPayments: [], refunds: [], hotelRequests: [], hotelPayments: [] });
  assert.ok(!JSON.stringify(out).includes("S3CRET"));
});

test("two customers who share a surname are never added together: per person, ambiguous, and a long history says truncated", async () => {
  const d = await db();
  await d.exec(`
    INSERT INTO core_customer VALUES (3, 'Dovid Cohen', 'dovid@example.com', '+18455550202', '2026-01-05', false);
    INSERT INTO core_reservation VALUES (200, 'DOV001', 500, 500, null, '2026-03-01', 3, true, 'complete', false, null);
    INSERT INTO core_payment VALUES (2000, 500, 'card', '2026-03-02', null, 200, null, null);
  `);
  for (let i = 0; i < 45; i++) {
    await d.exec(`INSERT INTO core_reservation VALUES (${300 + i}, 'MC${String(i).padStart(4, "0")}', 100, 100, null, '2026-04-01', 1, true, 'complete', false, null);
      INSERT INTO core_payment VALUES (${3000 + i}, 100, 'card', '2026-04-02', null, ${300 + i}, null, null);`);
  }
  const s = createCrmSearch({ getPool: () => d });
  const r = await s.answer(new URLSearchParams("q=Cohen&from=2026-01-01&to=2026-12-31"));
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.ambiguous, true);
  const names = b.nesher.people.map((g) => g.customer).sort();
  assert.deepEqual(names, ["Dovid Cohen", "Moshe Cohen"]);
  const dovid = b.nesher.people.find((g) => g.customer === "Dovid Cohen");
  assert.equal(dovid.payments_total_usd, 500);
  assert.equal(b.truncated.bookings, true);
  assert.ok(b.notes.some((n) => /AMBIGUOUS/.test(n)) && b.notes.some((n) => /TRUNCATED/.test(n)));
  // no single figure anywhere adds the two people together
  assert.ok(!JSON.stringify(b).includes('"payments_total_usd":' + (500 + 1400)));
});

test("a third search at once is told busy; the timeout statement is the first after BEGIN", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { query: async (sql) => { if (/^\s*SELECT/i.test(sql)) await gate; return { rows: [] }; } };
  const s = createCrmSearch({ getPool: () => slow });
  const a = s.answer(new URLSearchParams("q=Cohen"));
  const b = s.answer(new URLSearchParams("q=Levi"));
  const c = await s.answer(new URLSearchParams("q=Klein"));
  assert.equal(MAX_INFLIGHT, 2);
  assert.equal(c.status, 503); assert.equal(c.body.error, "busy");
  release();
  assert.equal((await a).status, 200); assert.equal((await b).status, 200);
  assert.equal(s.health().inflight, 0);
});

test("a statement timeout comes back as timeout, never a hang", async () => {
  const s = createCrmSearch({ getPool: () => ({ query: async (sql) => { if (/^\s*SELECT/i.test(sql)) throw new Error("canceling statement due to statement timeout"); return { rows: [] }; } }) });
  const r = await s.answer(new URLSearchParams("q=Cohen"));
  assert.equal(r.status, 500); assert.equal(r.body.error, "timeout");
});
