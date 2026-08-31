/**
 * ONE extra JRM hotel-request status: "Not interested/Can't help".
 *
 * Richter's Django app owns the status list and we have no access to that repo, so
 * this adds the option from our proxy instead. Verified against the live CRM on
 * 2026-08-25 with a zero-write probe (a POST missing a required field, so the form
 * could only fail): Django DOES validate the value —
 *   "Select a valid choice. not_interested is not one of the available choices."
 * so a client-side <option> on its own would break Save. Hence:
 *
 *   GET     append our <option> to the status <select>, and mark it selected when
 *           the row already holds it — otherwise the widget falls back to the first
 *           option and a staff member could silently save the request back to "New".
 *   POST    only when the submitted status is ours: swap it for a value Django
 *           accepts, let Django save every other field normally, then write the real
 *           value straight to Postgres. Every other POST is forwarded byte-for-byte.
 *   Display Django renders the raw key for a value it doesn't know about; swap that
 *           one token for the label.
 *
 * Scope guard — deliberately NOT touched: the "Reservation Progress" stepper and the
 * per-status count cards are Django templates keyed to their own choices. Leaving
 * them alone is what keeps this change to exactly one added status.
 *
 * The list filter needs no help: /jrm/hotels/?status=<x> is an unvalidated
 * .filter(status=...) (verified — returns 0 rows and no error for an unknown value).
 */

import { PassThrough } from "node:stream";

export const EXTRA_STATUS = "not_interested";
export const EXTRA_LABEL = "Not interested/Can't help";

/** The add form, the edit form, and the quick-change select on the detail page. */
export const STATUS_POST_RE = /^\/jrm\/hotels\/(?:add|(\d+)\/(?:edit|status))\/$/;

/** Pages that render a status <select> we should extend. */
export const STATUS_PAGE_RE = /^\/jrm\/hotels\/(?:$|add\/$|\d+\/(?:$|edit\/$))/;

// Every status <select> in this CRM carries the full choice list; "cancelled" is the
// marker that tells it apart from the other selects on the page (source, assigned_to…).
const ANCHOR = 'value="cancelled"';
const SELECT_RE = /<select\b[^>]*\bname="status"[^>]*>[\s\S]*?<\/select>/gi;
const SELECTED_RE = /\s+selected(?:="[^"]*")?(?=[\s>])/gi;

/**
 * Append our option to any status <select> in the html.
 * Fail-silent: if the markup isn't what we expect, the page is returned untouched.
 */
export function injectStatusOption(html, { selected = false } = {}) {
  if (typeof html !== "string" || !html) return html;
  if (html.includes(`value="${EXTRA_STATUS}"`)) return html; // already present
  if (!html.includes(ANCHOR)) return html;
  return html.replace(SELECT_RE, (block) => {
    if (!block.includes(ANCHOR)) return block;
    let out = block;
    // Only one option may be selected — clear Django's pick before adding ours.
    if (selected) out = out.replace(SELECTED_RE, "");
    const option = `  <option value="${EXTRA_STATUS}"${selected ? " selected" : ""}>${EXTRA_LABEL}</option>\n`;
    const close = out.lastIndexOf("</select>");
    if (close < 0) return block;
    return `${out.slice(0, close)}${option}${out.slice(close)}`;
  });
}

/** Django prints the raw key for a status it doesn't know; show the label instead. */
export function relabelStatus(html) {
  if (typeof html !== "string" || !html) return html;
  // Element text only — `class="badge not_interested"` and `value="not_interested"`
  // are quoted and must survive untouched.
  return html.split(`>${EXTRA_STATUS}<`).join(`>${EXTRA_LABEL}<`);
}

const FIELD_RE = new RegExp(`(^|&)status=${EXTRA_STATUS}(?=&|$)`);

export function bodyHasExtraStatus(body) {
  return typeof body === "string" && FIELD_RE.test(body);
}

/**
 * Surgical swap of the single status field. Every other byte of the body is left
 * exactly as the browser sent it (no URLSearchParams round-trip, which would
 * re-encode fields we have no business touching).
 */
export function swapStatusInBody(body, replacement) {
  if (!bodyHasExtraStatus(body)) return null;
  return body.replace(FIELD_RE, (_m, pre) => `${pre}status=${encodeURIComponent(replacement)}`);
}

/**
 * What to hand Django in our place. Re-using the row's CURRENT status means Django
 * sees no status change at all, so nothing downstream of a status change can fire.
 * Only a brand-new request (or a row already holding our value) falls back to "new",
 * which is the add form's own default.
 */
export function swapValueFor(currentStatus) {
  return currentStatus && currentStatus !== EXTRA_STATUS ? currentStatus : "new";
}

/** id of the request being saved: from the URL, or from Django's redirect after an add. */
export function requestIdFrom(pathOnly, location) {
  const inPath = pathOnly.match(/^\/jrm\/hotels\/(\d+)\//);
  if (inPath) return inPath[1];
  const inRedirect = String(location || "").match(/\/jrm\/hotels\/(\d+)\//);
  return inRedirect ? inRedirect[1] : null;
}

// ── save path ────────────────────────────────────────────────────────────────

const MAX_BODY = 1024 * 1024;

async function currentStatusOf(pool, id) {
  if (!pool || !id) return null;
  try {
    const r = await pool.query(`SELECT status FROM core_jrmhotelrequest WHERE id = $1`, [id]);
    return r.rows[0] ? r.rows[0].status : null;
  } catch (e) {
    console.error("status-extra: read status", e.message);
    return null;
  }
}

async function applyExtraStatus(pool, id) {
  if (!pool || !id) return false;
  try {
    // status only — updated_at is Django's, already stamped by the save above.
    const r = await pool.query(
      `UPDATE core_jrmhotelrequest SET status = $2 WHERE id = $1`,
      [id, EXTRA_STATUS]
    );
    return r.rowCount === 1;
  } catch (e) {
    console.error("status-extra: apply status", e.message);
    return false;
  }
}

function streamOf(buf) {
  const s = new PassThrough();
  s.end(buf);
  return s;
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Holds Django's response until the real status is written, so the browser is never
 * redirected to a page still showing the swapped value.
 */
function captureResponse(res, onDone) {
  const chunks = [];
  let statusCode = 200;
  const headers = {};
  return {
    writeHead(code, hdrs) {
      statusCode = code;
      if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v;
    },
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    getHeader(k) {
      return headers[k.toLowerCase()];
    },
    removeHeader(k) {
      delete headers[k.toLowerCase()];
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) this.write(chunk);
      const body = Buffer.concat(chunks);
      Promise.resolve()
        .then(() => onDone(statusCode, headers))
        .catch((e) => console.error("status-extra: post-save", e.message))
        .finally(() => {
          try {
            res.writeHead(statusCode, headers);
            res.end(body);
          } catch (e) {
            console.error("status-extra: flush", e.message);
          }
        });
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
    pipe() {
      return this;
    },
  };
}

/**
 * POST handler for the three save endpoints. Anything that is not a form post
 * carrying OUR status value is forwarded exactly as the browser sent it.
 */
export async function handleStatusPost(req, res, { proxy, pool }) {
  const pathOnly = (req.url || "/").split("?")[0];
  const ct = String(req.headers["content-type"] || "");
  const len = Number(req.headers["content-length"] || 0);

  // Not a plain form post (or implausibly large) — never touch the stream.
  if (!ct.includes("application/x-www-form-urlencoded") || !len || len > MAX_BODY) {
    proxy.web(req, res);
    return;
  }

  let raw;
  try {
    raw = await readBody(req, MAX_BODY);
  } catch (e) {
    console.error("status-extra: read body", e.message);
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad request");
    }
    return;
  }

  const body = raw.toString("utf8");
  if (!bodyHasExtraStatus(body)) {
    proxy.web(req, res, { buffer: streamOf(raw) }); // byte-for-byte replay
    return;
  }

  const current = await currentStatusOf(pool, requestIdFrom(pathOnly, null));
  const swapped = swapStatusInBody(body, swapValueFor(current));
  if (!swapped) {
    proxy.web(req, res, { buffer: streamOf(raw) });
    return;
  }

  const out = Buffer.from(swapped, "utf8");
  req.headers["content-length"] = String(out.length);

  const captured = captureResponse(res, async (statusCode, headers) => {
    // 2xx here means Django re-rendered the form with errors and saved nothing.
    if (statusCode < 300 || statusCode >= 400) return;
    const id = requestIdFrom(pathOnly, headers.location);
    if (!(await applyExtraStatus(pool, id))) {
      console.error("status-extra: saved but status not applied", pathOnly, id);
    }
  });

  proxy.web(req, captured, { buffer: streamOf(out) });
}

/**
 * Everything the read path needs, in one call: show the label where Django printed
 * the raw key, and add our option to the status <select> — marked selected when this
 * request already holds it.
 */
export async function injectStatusExtra(html, pathOnly, pool) {
  if (typeof html !== "string" || !html) return html;
  let out = relabelStatus(html);
  if (!STATUS_PAGE_RE.test(pathOnly)) return out;
  const id = requestIdFrom(pathOnly, null);
  const selected = id ? (await currentStatusOf(pool, id)) === EXTRA_STATUS : false;
  return injectStatusOption(out, { selected });
}
