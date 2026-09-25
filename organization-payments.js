import crypto from "node:crypto";

const METHODS = new Map([
  ["cash", "Cash"], ["card", "Card"], ["bank", "Bank Transfer"],
  ["zelle", "Zelle"], ["check", "Check"], ["other", "Other"],
  ["points", "Points"], ["seller_credit", "Seller Credit"],
]);

export const ORGANIZATION_PAYMENT_PATH =
  /^\/__nesher_org\/organizations\/(\d+)\/payments\/(\d+)\/(edit|delete)\/?$/;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function dateLabel(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function money(value) {
  return Number(value).toFixed(2);
}

function paymentVersion(row) {
  return crypto.createHash("sha256").update(JSON.stringify([
    String(row.id), String(row.amount), String(row.payment_date),
    String(row.method), String(row.reference ?? ""), String(row.notes ?? ""),
  ])).digest("hex");
}

const SELECT_FIELDS = `id, amount::text AS amount, payment_date::text AS payment_date,
  method, COALESCE(reference, '') AS reference, COALESCE(notes, '') AS notes`;

async function listPayments(pool, organizationId) {
  const result = await pool.query(
    `SELECT ${SELECT_FIELDS} FROM core_organizationpayment
     WHERE organization_id = $1 ORDER BY payment_date DESC, created_at DESC, id DESC`,
    [organizationId]
  );
  return result.rows;
}

async function loadPayment(pool, organizationId, paymentId) {
  const result = await pool.query(
    `SELECT ${SELECT_FIELDS} FROM core_organizationpayment
     WHERE id = $1 AND organization_id = $2`,
    [paymentId, organizationId]
  );
  return result.rows[0] || null;
}

function paymentTable(organizationId, rows) {
  const cells = rows.map((row) => {
    const base = `/__nesher_org/organizations/${organizationId}/payments/${row.id}`;
    const td = 'style="padding:9px;border-top:1px solid #e2e8f0;"';
    return `<tr>
      <td ${td}>${escapeHtml(dateLabel(row.payment_date))}</td>
      <td ${td}>${escapeHtml(METHODS.get(row.method) || row.method)}</td>
      <td ${td}>${escapeHtml(row.reference || "-")}</td>
      <td ${td}>${escapeHtml(row.notes || "-")}</td>
      <td ${td} style="text-align:right;font-weight:900;white-space:nowrap;">$${escapeHtml(money(row.amount))}
        <a href="${base}/edit/" aria-label="Edit payment" title="Edit payment" style="margin-left:9px;font-size:18px;text-decoration:none;">✎</a>
        <a href="${base}/delete/" aria-label="Delete payment" title="Delete payment" style="margin-left:9px;color:#b91c1c;text-decoration:none;">🗑</a></td>
    </tr>`;
  }).join("\n");
  return `<div style="overflow-x:auto;" data-nesher-org-payments="1">
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr style="background:#f8fafc;">
        <th style="text-align:left;padding:9px;">Date</th>
        <th style="text-align:left;padding:9px;">Method</th>
        <th style="text-align:left;padding:9px;">Reference</th>
        <th style="text-align:left;padding:9px;">Notes</th>
        <th style="text-align:right;padding:9px;">Amount</th>
      </tr></thead><tbody>${cells}</tbody>
    </table></div>`;
}

/** Replace only the Django payment table, leaving sponsorships and card usage alone. */
export async function injectOrganizationPayments(html, path, pool) {
  const match = String(path).match(/^\/organizations\/(\d+)\/?$/);
  if (!match || typeof html !== "string" || html.includes('data-nesher-org-payments="1"')) return html;
  const section = /(<h2>\s*Organization Payments Received\s*<\/h2>[\s\S]*?)(<div\b[^>]*>\s*<table\b[\s\S]*?<\/table>\s*<\/div>)/i;
  if (!section.test(html)) return html;
  try {
    const rows = await listPayments(pool, Number(match[1]));
    return html.replace(section, (_all, before) => before + paymentTable(match[1], rows));
  } catch (error) {
    console.error("organization payments: list", error.message);
    return html;
  }
}

function page(title, body, organizationId, status = 200) {
  const back = `/organizations/${organizationId}/`;
  return { status, html: `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - CRM</title>
    <style>body{font:16px system-ui,sans-serif;background:#f5f7fb;color:#17233b;margin:0;padding:28px}
    main{max-width:620px;background:white;border-radius:12px;padding:28px;margin:24px auto;box-shadow:0 2px 14px #17233b12}
    label{display:block;font-weight:600;margin:16px 0 5px}input,select,textarea{box-sizing:border-box;width:100%;padding:10px;border:1px solid #b8c2d3;border-radius:6px;font:inherit}
    button{background:#244dbc;color:white;border:0;border-radius:6px;padding:11px 18px;font:inherit;cursor:pointer;margin-top:22px}
    button.danger{background:#b91c1c}a{color:#244dbc}.error{color:#b91c1c}</style></head>
    <body><main><a href="${back}">← Back to organization</a><h1>${escapeHtml(title)}</h1>${body}</main></body></html>` };
}

function sendPage(res, result) {
  res.writeHead(result.status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(result.html);
}

function editForm(organizationId, row, error = "", values = row) {
  const action = `/__nesher_org/organizations/${organizationId}/payments/${row.id}/edit/`;
  const body = `${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post" action="${action}">
      <input type="hidden" name="version" value="${paymentVersion(row)}">
      <label for="amount">Amount ($)</label><input id="amount" name="amount" type="number" min="0.01" step="0.01" required value="${escapeHtml(values.amount)}">
      <button type="submit">Save amount</button>
    </form>`;
  return page("Edit payment amount", body, organizationId, error ? 400 : 200);
}

function deleteForm(organizationId, row) {
  const action = `/__nesher_org/organizations/${organizationId}/payments/${row.id}/delete/`;
  const body = `<p>Delete the ${escapeHtml(dateLabel(row.payment_date))} payment of <strong>$${escapeHtml(money(row.amount))}</strong>?
    This will remove it from the organization's payment total and balance.</p>
    <form method="post" action="${action}">
      <input type="hidden" name="version" value="${paymentVersion(row)}">
      <input type="hidden" name="confirm" value="yes">
      <button class="danger" type="submit">Delete payment</button>
    </form>`;
  return page("Delete organization payment", body, organizationId);
}

function sameOrigin(req) {
  const source = req.headers.origin || req.headers.referer;
  if (!source || !req.headers.host) return false;
  try {
    return new URL(String(source)).host.toLowerCase() === String(req.headers.host).toLowerCase();
  } catch {
    return false;
  }
}

async function readForm(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/x-www-form-urlencoded")) {
    throw new Error("Unsupported form submission");
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16_384) { reject(new Error("Form is too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

function validatedAmount(form) {
  const amount = String(form.get("amount") || "").trim();
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) throw new Error("Enter a positive amount with no more than two decimal places.");
  return amount;
}

export async function handleOrganizationPayment(req, res, match, { pool, requireStaff }) {
  const [, orgText, paymentText, action] = match;
  const organizationId = Number(orgText);
  const paymentId = Number(paymentText);
  if (req.method !== "GET" && req.method !== "POST") {
    res.writeHead(405, { Allow: "GET, POST" }); res.end("Method not allowed"); return;
  }
  if (!(await requireStaff(req, res))) return;
  if (req.method === "POST" && !sameOrigin(req)) {
    sendPage(res, page("Request refused", "<p class=\"error\">Open this form from the CRM and try again.</p>", organizationId, 403));
    return;
  }
  let row;
  try { row = await loadPayment(pool, organizationId, paymentId); }
  catch (error) { console.error("organization payments: load", error.message); sendPage(res, page("Payment unavailable", "<p>Try again later.</p>", organizationId, 503)); return; }
  if (!row) { sendPage(res, page("Payment not found", "<p>This payment no longer exists for this organization.</p>", organizationId, 404)); return; }
  if (req.method === "GET") { sendPage(res, action === "edit" ? editForm(organizationId, row) : deleteForm(organizationId, row)); return; }

  let form;
  try { form = await readForm(req); }
  catch (error) { sendPage(res, page("Invalid form", `<p class="error">${escapeHtml(error.message)}</p>`, organizationId, 400)); return; }
  if (form.get("version") !== paymentVersion(row)) {
    sendPage(res, page("Payment changed", "<p>This payment changed since the form was opened. Return to the organization and review it before trying again.</p>", organizationId, 409));
    return;
  }
  if (action === "delete" && form.get("confirm") !== "yes") {
    sendPage(res, page("Confirmation required", "<p class=\"error\">Use the Delete payment button on the confirmation page.</p>", organizationId, 400));
    return;
  }
  let amount;
  if (action === "edit") {
    try { amount = validatedAmount(form); }
    catch (error) { sendPage(res, editForm(organizationId, row, error.message, { amount: form.get("amount") || "" })); return; }
  }
  try {
    const predicates = `id = $1 AND organization_id = $2 AND amount = $3 AND payment_date = $4
      AND method = $5 AND COALESCE(reference, '') = $6 AND COALESCE(notes, '') = $7`;
    const original = [paymentId, organizationId, row.amount, row.payment_date,
      row.method, row.reference, row.notes];
    const result = action === "edit"
      ? await pool.query(
        `UPDATE core_organizationpayment SET amount = $8 WHERE ${predicates} RETURNING id`,
        [...original, amount])
      : await pool.query(`DELETE FROM core_organizationpayment WHERE ${predicates} RETURNING id`, original);
    if (result.rowCount !== 1) {
      sendPage(res, page("Payment changed", "<p>This payment changed since the form was opened. Return to the organization and review it before trying again.</p>", organizationId, 409));
      return;
    }
  } catch (error) {
    console.error(`organization payments: ${action}`, error.message);
    sendPage(res, page("Payment not saved", "<p class=\"error\">The payment was not changed. Try again later.</p>", organizationId, 503));
    return;
  }
  res.writeHead(303, { Location: `/organizations/${organizationId}/`, "Cache-Control": "no-store" });
  res.end();
}
