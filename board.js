/**
 * All-Tasks board — one page showing EVERY open task across the whole team.
 * The stock /tasks/ page is per-logged-in-user; managers need the whole floor.
 *
 * GET  /board                → staff-gated HTML board (redirects to /login/ if not)
 * POST /__nesher_board/done  → {id} marks a task done (done_by = session user)
 */

import { validateStaffSession, extractSessionId } from "./auth.js";
import { sessionUserId } from "./whatsapp-media.js";

const LABEL_RE = /^\[([A-Z][A-Z /-]{1,14})\]\s*/;

const LABEL_COLORS = {
  DEAL: "#1d6feb",
  LEAD: "#0c8a4d",
  FLIGHT: "#8a3ffc",
  ADMIN: "#b35a00",
  "CALL SHEET": "#5b6470",
};

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(d) {
  if (!d) return "";
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return "";
  return t.toISOString().slice(0, 10);
}

async function staffOk(req, deps) {
  return validateStaffSession({
    cookieHeader: req.headers.cookie || "",
    upstream: deps.upstream,
    publicHost: deps.publicHost,
  });
}

export async function handleBoardPage(req, res, deps) {
  const auth = await staffOk(req, deps);
  if (!auth.ok) {
    res.writeHead(302, { Location: "/login/?next=/board" });
    res.end();
    return;
  }
  const pool = deps.pool;
  if (!pool) {
    res.writeHead(503, { "Content-Type": "text/plain" });
    res.end("database not configured");
    return;
  }
  const q = await pool.query(
    `SELECT t.id, t.description, t.priority, t.created_at,
            COALESCE(ua.username,'unassigned') AS assigned,
            t.jrm_hotel_request_id AS hr_id,
            hr.customer_name AS guest, hr.status AS hr_status, hr.check_in
       FROM core_task t
       LEFT JOIN auth_user ua ON ua.id = t.assigned_to_id
       LEFT JOIN core_jrmhotelrequest hr ON hr.id = t.jrm_hotel_request_id
      WHERE t.is_done = false
      ORDER BY (t.priority = 'urgent') DESC, t.created_at ASC`
  );
  const rows = q.rows;

  // stable section order: heaviest queues first, known people in fixed order
  const ORDER = ["sgrunfeld", "info", "Hershy", "goldy", "admin", "Avrumy"];
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.assigned)) groups.set(r.assigned, []);
    groups.get(r.assigned).push(r);
  }
  const names = [...groups.keys()].sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  });

  const urgentTotal = rows.filter((r) => r.priority === "urgent").length;
  const sections = names
    .map((name) => {
      const list = groups.get(name);
      const items = list
        .map((r) => {
          let desc = String(r.description || "");
          let label = "";
          const m = desc.match(LABEL_RE);
          if (m) {
            label = m[1];
            desc = desc.slice(m[0].length);
          }
          const color = LABEL_COLORS[label] || "#5b6470";
          const hrBit = r.hr_id
            ? `<a class="hr" href="/jrm/hotels/${r.hr_id}/" title="open request">${esc(
                r.guest || "request #" + r.hr_id
              )}${r.check_in ? " · " + fmtDate(r.check_in) : ""}${
                r.hr_status ? " · " + esc(r.hr_status) : ""
              }</a>`
            : "";
          return `<div class="task${r.priority === "urgent" ? " urgent" : ""}" id="task-${r.id}">
  <div class="meta">
    ${r.priority === "urgent" ? `<span class="chip hot">URGENT</span>` : ""}
    ${label ? `<span class="chip" style="background:${color}">${esc(label)}</span>` : ""}
    <span class="tid">#${r.id}</span>
    <span class="dt">${fmtDate(r.created_at)}</span>
  </div>
  <div class="desc" dir="auto">${esc(desc)}</div>
  ${hrBit ? `<div class="hrline">${hrBit}</div>` : ""}
  <button class="done" onclick="markDone(${r.id}, this)">Done</button>
</div>`;
        })
        .join("\n");
      return `<section>
<h2>${esc(name)} <span class="count">${list.length}</span></h2>
${items}
</section>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All Tasks — Nesher CRM</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; background:#f2f4f7; font:14px/1.45 -apple-system,'Segoe UI',Roboto,Arial,sans-serif; color:#1a2233; }
  header { position:sticky; top:0; background:#101d33; color:#fff; padding:12px 20px; display:flex; gap:16px; align-items:baseline; z-index:5; }
  header h1 { margin:0; font-size:17px; font-weight:600; }
  header .sum { color:#9fb2d1; font-size:13px; }
  header a { color:#9fb2d1; font-size:13px; margin-left:auto; text-decoration:none; }
  main { max-width:860px; margin:0 auto; padding:16px; }
  section h2 { font-size:15px; margin:22px 4px 8px; color:#101d33; }
  section h2 .count { background:#d8dfeb; border-radius:10px; padding:1px 9px; font-size:12px; vertical-align:2px; }
  .task { position:relative; background:#fff; border:1px solid #e2e7ef; border-left:4px solid #cdd6e4; border-radius:8px; padding:10px 84px 10px 12px; margin-bottom:8px; }
  .task.urgent { border-left-color:#d5341f; }
  .meta { display:flex; gap:8px; align-items:center; margin-bottom:4px; flex-wrap:wrap; }
  .chip { color:#fff; border-radius:4px; font-size:10.5px; font-weight:700; padding:1px 7px; letter-spacing:.4px; }
  .chip.hot { background:#d5341f; }
  .tid { color:#8b97ab; font-size:12px; }
  .dt { color:#8b97ab; font-size:12px; }
  .desc { white-space:pre-wrap; word-break:break-word; }
  .hrline { margin-top:5px; font-size:12.5px; }
  .hrline .hr { color:#1d6feb; text-decoration:none; }
  .done { position:absolute; right:10px; top:50%; transform:translateY(-50%); background:#fff; color:#0c8a4d; border:1px solid #0c8a4d; border-radius:6px; padding:5px 12px; cursor:pointer; font-weight:600; }
  .done:hover { background:#0c8a4d; color:#fff; }
  .task.gone { opacity:.35; }
  .task.gone .done { border-color:#8b97ab; color:#8b97ab; pointer-events:none; }
</style>
</head>
<body>
<header>
  <h1>All Tasks</h1>
  <span class="sum">${rows.length} open · ${urgentTotal} urgent · ${names.length} people</span>
  <a href="/tasks/">my tasks →</a>
</header>
<main>
${sections || "<p>No open tasks. Enjoy it while it lasts.</p>"}
</main>
<script>
async function markDone(id, btn) {
  btn.disabled = true;
  try {
    const r = await fetch("/__nesher_board/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ id })
    });
    const j = await r.json();
    if (j.ok) { document.getElementById("task-" + id).classList.add("gone"); }
    else { alert(j.error || "failed"); btn.disabled = false; }
  } catch (e) { alert("network error"); btn.disabled = false; }
}
</script>
</body>
</html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

export async function handleBoardDone(req, res, deps) {
  const auth = await staffOk(req, deps);
  const sendJson = (status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };
  if (!auth.ok) {
    sendJson(401, { ok: false, error: "Login required" });
    return;
  }
  const pool = deps.pool;
  if (!pool) {
    sendJson(503, { ok: false, error: "database not configured" });
    return;
  }
  let body = "";
  try {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => {
        chunks.push(c);
        if (Buffer.concat(chunks).length > 4096) reject(new Error("too large"));
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  } catch {
    sendJson(400, { ok: false, error: "bad body" });
    return;
  }
  let id;
  try {
    id = Number(JSON.parse(body || "{}").id);
  } catch {
    sendJson(400, { ok: false, error: "bad json" });
    return;
  }
  if (!Number.isInteger(id) || id <= 0) {
    sendJson(400, { ok: false, error: "bad id" });
    return;
  }
  let doneBy = null;
  try {
    doneBy = await sessionUserId(extractSessionId(req.headers.cookie || ""));
  } catch {
    /* best-effort attribution */
  }
  const r = await pool.query(
    `UPDATE core_task SET is_done = true, done_at = now(), done_by_id = $2
      WHERE id = $1 AND is_done = false`,
    [id, doneBy]
  );
  sendJson(200, { ok: true, changed: r.rowCount });
}
