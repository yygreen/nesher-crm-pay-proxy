/**
 * Adds a "Not Interested / Can't Help" choice to the Change Status control on
 * the JRM hotel request page — without touching the Django CRM.
 *
 * The CRM renders that <select> from its own choices list, so an option we add
 * client-side is a value Django has never heard of. Two things follow:
 *
 *   1. Posting it through the CRM's own form is not safe. If the view validates
 *      against its choices the save is rejected, and the staff member gets the
 *      silent no-op this feature exists to avoid. So we intercept the submit
 *      and write the one column ourselves.
 *   2. Once stored, the CRM re-renders the select with nothing matching, which
 *      makes the browser display the FIRST option ("New") — the request would
 *      look untouched. So we re-select our option on load whenever the stored
 *      status is ours.
 *
 * The stored string is discovered at runtime rather than hard-coded: we read
 * the column's length limit and the vocabulary already in use, so we match the
 * CRM's own casing/slug style and never overflow the column. See pickStatusValue.
 *
 * Scope discipline — this writes core_jrmhotelrequest.status and nothing else.
 * No notes, no timestamps, no other row. The API refuses any value but ours,
 * so it can never be used as a general status editor.
 */

const MARKER = "nesher-status-option";

/** What staff see in the dropdown. */
export const STATUS_LABEL = "Not Interested / Can't Help";

/** Only the hotel request detail page carries the Change Status card. */
export function isHotelRequestPath(path) {
  const p = String(path || "").split("?")[0].split("#")[0];
  const m = p.match(/^\/jrm\/hotels\/(\d+)\/?$/);
  return m ? m[1] : null;
}

/**
 * Choose the string to store, given the vocabulary already in the column and
 * the column's length limit.
 *
 * A CRM whose statuses read "new"/"quoted" wants a slug; one whose statuses
 * read "New"/"Quoted" wants a label. Guessing wrong is not fatal but shows up
 * raw in every CRM list, so match what is already there.
 *
 * @param {string[]} existing  distinct values already in the column
 * @param {number|null} maxLen character_maximum_length, or null when unbounded
 */
export function pickStatusValue(existing = [], maxLen = null) {
  const vals = (existing || []).map((v) => String(v == null ? "" : v).trim()).filter(Boolean);
  const slugStyle = vals.length > 0 && vals.every((v) => /^[a-z0-9][a-z0-9_-]*$/.test(v));
  const sep =
    vals.some((v) => v.includes("-")) && !vals.some((v) => v.includes("_")) ? "-" : "_";
  const slug = `not${sep}interested`;

  const candidates = slugStyle
    ? [slug, "no" + sep + "help"]
    : [STATUS_LABEL, "Not Interested", slug];

  const limit = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : Infinity;
  for (const c of candidates) if (c.length <= limit) return c;
  return candidates[candidates.length - 1].slice(0, limit);
}

/** Column length + vocabulary in use. Both queries degrade to null/[] on error. */
export async function loadStatusMeta(pool) {
  const meta = { maxLen: null, existing: [] };
  try {
    const r = await pool.query(
      `SELECT character_maximum_length AS len
         FROM information_schema.columns
        WHERE table_name = 'core_jrmhotelrequest' AND column_name = 'status'`
    );
    if (r.rows.length && r.rows[0].len != null) meta.maxLen = Number(r.rows[0].len);
  } catch (e) {
    /* unbounded / no permission on the catalog — fall back to no limit */
  }
  try {
    const r = await pool.query(
      `SELECT DISTINCT status FROM core_jrmhotelrequest
        WHERE status IS NOT NULL AND status <> '' LIMIT 50`
    );
    meta.existing = r.rows.map((x) => x.status);
  } catch (e) {
    /* label style is the safer default when we cannot see the vocabulary */
  }
  return meta;
}

export async function loadHotelRequestStatus(pool, requestId) {
  const r = await pool.query(
    `SELECT status FROM core_jrmhotelrequest WHERE id = $1`,
    [Number(requestId)]
  );
  if (!r.rows.length) return null;
  return r.rows[0].status == null ? "" : String(r.rows[0].status);
}

/** Writes ONLY the status column. Returns rows affected. */
export async function setHotelRequestStatus(pool, requestId, value) {
  const r = await pool.query(
    `UPDATE core_jrmhotelrequest SET status = $1 WHERE id = $2`,
    [value, Number(requestId)]
  );
  return r.rowCount == null ? 0 : r.rowCount;
}

const CSS = `
<style id="${MARKER}-css">
  .${MARKER}-note {
    display: none;
    margin: 8px 0 0;
    padding: 7px 10px;
    border: 1px solid #99f6e4;
    border-radius: 8px;
    background: #f0fdfa;
    color: #0f766e;
    font-size: 13px;
    line-height: 1.35;
  }
  .${MARKER}-note.on { display: block; }
  .${MARKER}-note.err { border-color: #fecaca; background: #fef2f2; color: #b91c1c; }
</style>`;

function scriptFor(requestId) {
  return `
<script id="${MARKER}-js">
(function () {
  var REQ = ${JSON.stringify(String(requestId))};
  var API = "/__nesher_status/hotel/" + REQ + "/";
  var LABEL = ${JSON.stringify(STATUS_LABEL)};
  var MARK = ${JSON.stringify(MARKER)};

  /**
   * The hotel request page carries other <select>s (per-offer answer status),
   * so a loose "anything with status in the name" match can bind the wrong
   * control. Score candidates and take the clear winner; bind nothing rather
   * than bind wrongly.
   */
  function findSelect() {
    var best = null, bestScore = 0;
    var sels = document.querySelectorAll("select");
    for (var i = 0; i < sels.length; i++) {
      var sel = sels[i], score = 0;
      var name = (sel.getAttribute("name") || "").toLowerCase();
      var id = (sel.id || "").toLowerCase();
      if (name === "status" || id === "status") score += 3;
      else if (/(^|_)status$/.test(name) || /status/.test(name) || /status/.test(id)) score += 1;
      var node = sel, hops = 0;
      while (node && hops < 4) {
        node = node.parentElement;
        hops++;
        if (!node) break;
        var head = node.querySelector("h1,h2,h3,h4,h5,legend,label,strong");
        if (head && /change\\s*status/i.test(head.textContent || "")) { score += 3; break; }
      }
      if (score > bestScore) { bestScore = score; best = sel; }
    }
    return bestScore >= 3 ? best : null;
  }

  var sel = findSelect();
  if (!sel) return;
  if (sel.getAttribute("data-" + MARK) === "1") return;
  sel.setAttribute("data-" + MARK, "1");

  var note = document.createElement("p");
  note.className = MARK + "-note";
  (sel.parentNode || document.body).insertBefore(note, sel.nextSibling);
  function say(msg, bad) {
    note.textContent = msg;
    note.className = MARK + "-note on" + (bad ? " err" : "");
  }

  function hasValue(v) {
    for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === v) return true;
    return false;
  }

  var VALUE = null;

  function addOption(value, current) {
    VALUE = value;
    if (!hasValue(value)) {
      var opt = document.createElement("option");
      opt.value = value;
      opt.textContent = LABEL;
      opt.setAttribute("data-" + MARK, "1");
      sel.appendChild(opt);
    }
    // Django rendered no match for our stored value, so the browser is showing
    // the first option. Put the real one back.
    if (current && current === value) sel.value = value;
  }

  function form() {
    var f = sel.form;
    if (f) return f;
    var node = sel, hops = 0;
    while (node && hops < 5) { node = node.parentElement; hops++; if (node && node.tagName === "FORM") return node; }
    return null;
  }

  function save(done) {
    say("Saving\\u2026", false);
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ status: VALUE })
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d || !res.d.ok) throw new Error((res.d && res.d.error) || "Could not save");
        say("Status set to " + LABEL + ".", false);
        done(true);
      })
      .catch(function (e) {
        say(e.message || "Could not save the status. Try again.", true);
        done(false);
      });
  }

  var f = form();
  if (f) {
    f.addEventListener("submit", function (ev) {
      if (!VALUE || sel.value !== VALUE) return; // a normal CRM status — leave it alone
      ev.preventDefault();
      ev.stopPropagation();
      save(function (ok) { if (ok) setTimeout(function () { location.reload(); }, 450); });
    }, true);
  }

  fetch(API, { credentials: "same-origin" })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || !d.ok || !d.value) return;
      addOption(d.value, d.current);
    })
    .catch(function () {});
})();
</script>`;
}

/**
 * @param {string} html
 * @param {string} path
 */
export function injectStatusOption(html, path) {
  if (!html || typeof html !== "string") return html;
  if (html.includes(`${MARKER}-js`)) return html;
  const requestId = isHotelRequestPath(path);
  if (!requestId) return html;
  // No <select> on the page means no Change Status card to extend.
  if (!/<select/i.test(html)) return html;

  const block = `${CSS}${scriptFor(requestId)}`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, () => `${block}</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, () => `${block}</html>`);
  return html + block;
}

export { MARKER };
