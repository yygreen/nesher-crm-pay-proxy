import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  ORGANIZATION_PAYMENT_PATH,
  handleOrganizationPayment,
  injectOrganizationPayments,
} from "../organization-payments.js";

function fixturePool() {
  const rows = [
    { id: 2, organization_id: 1, amount: "3900.00", payment_date: "2026-09-25", method: "bank", reference: "", notes: "" },
    { id: 1, organization_id: 1, amount: "13103.37", payment_date: "2026-08-24", method: "bank", reference: "", notes: "" },
    { id: 3, organization_id: 2, amount: "50.00", payment_date: "2026-09-25", method: "cash", reference: "", notes: "" },
  ];
  return {
    rows,
    async query(sql, params) {
      if (sql.startsWith("SELECT") && sql.includes("ORDER BY")) {
        return { rows: rows.filter((r) => r.organization_id === params[0]) };
      }
      if (sql.startsWith("SELECT")) {
        return { rows: rows.filter((r) => r.id === params[0] && r.organization_id === params[1]) };
      }
      assert.match(sql, /id = \$1 AND organization_id = \$2/);
      const index = rows.findIndex((r) => r.id === params[0] && r.organization_id === params[1] &&
        r.amount === params[2] && r.payment_date === params[3] && r.method === params[4] &&
        r.reference === params[5] && r.notes === params[6]);
      if (index < 0) return { rowCount: 0, rows: [] };
      if (sql.startsWith("UPDATE")) {
        rows[index].amount = params[7];
      } else if (sql.startsWith("DELETE")) rows.splice(index, 1);
      else throw new Error("Unexpected query");
      return { rowCount: 1, rows: [{ id: params[0] }] };
    },
  };
}

async function request(pool, method, path, body = "", headers = {}, authorized = true) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = { host: "crm.flynesher.com", origin: "https://crm.flynesher.com",
    "content-type": "application/x-www-form-urlencoded", ...headers };
  const res = { status: 200, headers: {}, body: "",
    writeHead(status, responseHeaders) { this.status = status; this.headers = responseHeaders; },
    end(chunk = "") { this.body += chunk; },
  };
  const match = path.match(ORGANIZATION_PAYMENT_PATH);
  assert.ok(match);
  const pending = handleOrganizationPayment(req, res, match, {
    pool, requireStaff: async () => authorized,
  });
  if (method === "POST") setImmediate(() => { req.emit("data", Buffer.from(body)); req.emit("end"); });
  await pending;
  return res;
}

test("organization detail gets payment actions for its own rows only", async () => {
  const pool = fixturePool();
  const html = `<h2>Organization Payments Received</h2><div><table><tr><td>old</td></tr></table></div>`;
  const out = await injectOrganizationPayments(html, "/organizations/1/", pool);
  assert.match(out, /payments\/2\/edit\//);
  assert.match(out, /✎/);
  assert.match(out, /payments\/1\/delete\//);
  assert.doesNotMatch(out, /payments\/3\//);
  assert.equal(await injectOrganizationPayments(out, "/organizations/1/", pool), out);
  assert.equal(await injectOrganizationPayments(html, "/organizations/1/edit/", pool), html);
});

test("editing requires staff and same-origin submission, then changes only scoped payment", async () => {
  const pool = fixturePool();
  const path = "/__nesher_org/organizations/1/payments/2/edit/";
  const denied = await request(pool, "GET", path, "", {}, false);
  assert.equal(denied.body, "");
  const page = await request(pool, "GET", path);
  assert.match(page.body, /value="3900\.00"/);
  assert.doesNotMatch(page.body, /name="payment_date"/);
  const version = page.body.match(/name="version" value="([a-f0-9]+)"/)[1];
  const body = new URLSearchParams({ version, amount: "4000.25" }).toString();
  const crossSite = await request(pool, "POST", path, body, { origin: "https://attacker.example" });
  assert.equal(crossSite.status, 403);
  assert.equal(pool.rows[0].amount, "3900.00");
  const saved = await request(pool, "POST", path, body);
  assert.equal(saved.status, 303);
  assert.equal(saved.headers.Location, "/organizations/1/");
  assert.equal(pool.rows[0].amount, "4000.25");
  assert.equal(pool.rows[0].payment_date, "2026-09-25");
  assert.equal(pool.rows[2].amount, "50.00");
  const stale = await request(pool, "POST", path, body);
  assert.equal(stale.status, 409);
});

test("deletion requires the confirmation form and cannot cross organizations", async () => {
  const pool = fixturePool();
  const wrongOrg = await request(pool, "GET", "/__nesher_org/organizations/1/payments/3/delete/");
  assert.equal(wrongOrg.status, 404);
  const path = "/__nesher_org/organizations/1/payments/1/delete/";
  const page = await request(pool, "GET", path);
  assert.match(page.body, /13103\.37/);
  const version = page.body.match(/name="version" value="([a-f0-9]+)"/)[1];
  const refused = await request(pool, "POST", path, new URLSearchParams({ version }).toString());
  assert.equal(refused.status, 400);
  assert.equal(pool.rows.length, 3);
  const deleted = await request(pool, "POST", path, new URLSearchParams({ version, confirm: "yes" }).toString());
  assert.equal(deleted.status, 303);
  assert.deepEqual(pool.rows.map((r) => r.id), [2, 3]);
});
