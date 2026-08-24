/**
 * "Ask the hotels for a price" — composes the quote-request email that staff
 * send to a hotel from a JRM hotel request, and injects the button that opens
 * it.
 *
 * Deliberately composes rather than sends. The CRM has no verified hotel
 * address book this service can see, and a wrong auto-send goes to a real
 * hotel under Nesher's name with no undo. So the draft is built from CRM data
 * and handed to staff already addressed and written; they press send. See
 * README for how to turn this into a true one-click send.
 */

const MARKER = "nesher-quote-email";

/** Identifiers coming back from the catalog are still checked before use. */
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/;

/** Only the hotel request detail page carries a request to quote. */
export function isHotelRequestPath(path) {
  const p = String(path || "").split("?")[0].split("#")[0];
  const m = p.match(/^\/jrm\/hotels\/(\d+)\/?$/);
  return m ? m[1] : null;
}

/* ── formatting ─────────────────────────────────────────────────────── */

/** Postgres dates arrive as Date or ISO string; both must render the same. */
export function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Monday, 31 August 2026" — unambiguous for an Israeli hotel desk. */
export function formatDate(v) {
  const d = toDate(v);
  if (!d) return null;
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Short form for the subject line: "31 Aug". */
export function formatShort(v) {
  const d = toDate(v);
  if (!d) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}`;
}

export function nightsBetween(checkIn, checkOut) {
  const a = toDate(checkIn);
  const b = toDate(checkOut);
  if (!a || !b) return null;
  const n = Math.round((b.getTime() - a.getTime()) / 86400000);
  return n > 0 ? n : null;
}

/** "2 adults, 3 children" — omits whatever the CRM does not hold. */
export function describeGuests({ adults, children, rooms } = {}) {
  const bits = [];
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const a = n(adults);
  const c = n(children);
  const r = n(rooms);
  if (a) bits.push(`${a} adult${a === 1 ? "" : "s"}`);
  if (c) bits.push(`${c} child${c === 1 ? "" : "ren"}`);
  return { guests: bits.join(", ") || null, rooms: r };
}

/* ── the email ──────────────────────────────────────────────────────── */

export const SIGN_OFF = "JRM Hotels — Nesher Travel";

/**
 * Build the draft. Pure: everything it needs is in `ctx`, so the wording is
 * testable without a database.
 *
 * @param {object} ctx    { request, offer }
 * @param {object} [opts] { replyTo }
 */
export function buildQuoteEmail(ctx, opts = {}) {
  const request = (ctx && ctx.request) || {};
  const offer = (ctx && ctx.offer) || null;
  const hotelName = offer && offer.hotel_name ? String(offer.hotel_name).trim() : null;

  const city = request.city ? String(request.city).trim() : null;
  const checkIn = formatDate(request.check_in);
  const checkOut = formatDate(request.check_out);
  const nights = nightsBetween(request.check_in, request.check_out);
  const { guests, rooms } = describeGuests(request);
  const roomType = offer && offer.room_type ? String(offer.room_type).trim() : null;

  /* Subject: dates first — a hotel triages by stay, not by our request id. */
  const span =
    formatShort(request.check_in) && formatShort(request.check_out)
      ? `${formatShort(request.check_in)}–${formatShort(request.check_out)} ${
          toDate(request.check_out).getUTCFullYear()
        }`
      : null;
  const subject =
    ["Price request", span, nights ? `${nights} night${nights === 1 ? "" : "s"}` : null]
      .filter(Boolean)
      .join(" — ") || "Price request";

  /* Body: a facts block, then exactly what we need back. */
  const facts = [
    ["Hotel", hotelName],
    ["City", city],
    ["Check-in", checkIn],
    ["Check-out", checkOut],
    ["Nights", nights ? String(nights) : null],
    ["Rooms", rooms ? String(rooms) : null],
    ["Guests", guests],
    ["Room type", roomType],
  ].filter(([, v]) => v);

  const width = facts.reduce((w, [k]) => Math.max(w, k.length), 0);
  const factLines = facts.map(([k, v]) => `  ${(k + ":").padEnd(width + 2)}${v}`);

  const body = [
    "Hello,",
    "",
    "Could you please send us your best available rate for the following stay?",
    "",
    ...factLines,
    "",
    "So we can quote our client accurately, please include:",
    "",
    "  - Rate per night and the total, with the currency",
    "  - What the rate includes (breakfast, taxes / VAT)",
    "  - Cancellation policy",
    "  - Confirmation that the dates are available",
    "",
    "Thank you very much.",
    "",
    "Kind regards,",
    SIGN_OFF,
    opts.replyTo ? String(opts.replyTo) : null,
  ]
    .filter((l) => l !== null)
    .join("\n");

  /* What staff must supply before this can go out. */
  const missing = [];
  if (!hotelName) missing.push("hotel name");
  if (!city) missing.push("city");
  if (!checkIn || !checkOut) missing.push("stay dates");

  return { subject, body, missing, hotelName };
}

/* ── context + address discovery ────────────────────────────────────── */

async function soft(pool, sql, params = []) {
  try {
    const r = await pool.query(sql, params);
    return (r && r.rows) || [];
  } catch (e) {
    return [];
  }
}

/** Which of the optional guest-count columns this CRM actually has. */
export async function discoverRequestColumns(pool) {
  const rows = await soft(
    pool,
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'core_jrmhotelrequest'
        AND column_name = ANY($1)`,
    [["adults", "children", "rooms"]]
  );
  return rows.map((r) => r.column_name).filter((c) => SAFE_IDENT.test(c));
}

/**
 * Hotel request plus its offers, with guest counts when the CRM stores them.
 * `offerId` picks one offer; otherwise the newest is used.
 */
export async function loadQuoteContext(pool, requestId, offerId = null) {
  const id = Number(requestId);
  if (!Number.isFinite(id)) throw new Error("Invalid hotel request id");

  const extra = await discoverRequestColumns(pool);
  const cols = ["id", "customer_name", "city", "check_in", "check_out", ...extra].join(", ");
  const reqRows = await soft(
    pool,
    `SELECT ${cols} FROM core_jrmhotelrequest WHERE id = $1`,
    [id]
  );
  if (!reqRows.length) throw new Error(`Hotel request ${id} not found`);

  const offers = await soft(
    pool,
    `SELECT id, hotel_name, room_type FROM core_jrmhoteloffer
      WHERE request_id = $1 ORDER BY id DESC`,
    [id]
  );

  let offer = null;
  if (offerId != null && offerId !== "") {
    offer = offers.find((o) => String(o.id) === String(offerId)) || null;
  }
  if (!offer) offer = offers[0] || null;

  return { request: reqRows[0], offer, offers };
}

/**
 * Look for a hotel address book. The CRM may not have one — every failure
 * path returns [] so the draft simply opens with an empty To field.
 */
export async function discoverHotelEmail(pool, hotelName) {
  const name = String(hotelName || "").trim();
  if (!name) return [];

  const cands = await soft(
    pool,
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name LIKE '%hotel%'
        AND c.column_name LIKE '%email%'
      LIMIT 10`
  );

  for (const { table_name: table, column_name: emailCol } of cands) {
    if (!SAFE_IDENT.test(table) || !SAFE_IDENT.test(emailCol)) continue;

    const nameCols = await soft(
      pool,
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
          AND column_name LIKE '%name%' LIMIT 3`,
      [table]
    );

    for (const { column_name: nameCol } of nameCols) {
      if (!SAFE_IDENT.test(nameCol)) continue;
      const hits = await soft(
        pool,
        `SELECT ${emailCol} AS email FROM ${table}
          WHERE ${nameCol} ILIKE $1 AND ${emailCol} IS NOT NULL AND ${emailCol} <> ''
          LIMIT 3`,
        [name]
      );
      const found = hits.map((h) => String(h.email).trim()).filter((e) => e.includes("@"));
      if (found.length) return [...new Set(found)];
    }
  }
  return [];
}

/** Everything the modal needs, assembled. */
export async function buildQuoteDraft(pool, requestId, offerId = null, opts = {}) {
  const ctx = await loadQuoteContext(pool, requestId, offerId);
  const draft = buildQuoteEmail(ctx, opts);
  const to = await discoverHotelEmail(pool, draft.hotelName);
  return {
    ...draft,
    to,
    offers: (ctx.offers || []).map((o) => ({ id: Number(o.id), hotel_name: o.hotel_name })),
    selectedOfferId: ctx.offer ? Number(ctx.offer.id) : null,
  };
}

export { MARKER, SAFE_IDENT };

/* ── injected UI ────────────────────────────────────────────────────── */

const CSS = `
<style id="${MARKER}-css">
  .${MARKER}-btn {
    display: inline-flex; align-items: center; gap: 6px;
    margin-left: 8px; padding: 7px 13px;
    border: 1px solid #0f766e; border-radius: 8px;
    background: #fff; color: #0f766e;
    font: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer; vertical-align: middle;
  }
  .${MARKER}-btn:hover { background: #f0fdfa; }
  .${MARKER}-ov {
    position: fixed; inset: 0; z-index: 2147483000;
    background: rgba(15, 23, 42, 0.45);
    display: flex; align-items: center; justify-content: center; padding: 16px;
  }
  .${MARKER}-modal {
    width: min(680px, 100%); max-height: 90vh; overflow: auto;
    background: #fff; border-radius: 12px; padding: 20px;
    box-shadow: 0 18px 48px rgba(0,0,0,.25);
    font: 14px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; color: #0f172a;
  }
  .${MARKER}-modal h2 { margin: 0 0 4px; font-size: 17px; }
  .${MARKER}-sub { margin: 0 0 14px; color: #64748b; font-size: 13px; }
  .${MARKER}-modal label {
    display: block; margin: 12px 0 4px;
    font-size: 12px; font-weight: 600; text-transform: uppercase;
    letter-spacing: .03em; color: #475569;
  }
  .${MARKER}-modal input, .${MARKER}-modal textarea, .${MARKER}-modal select {
    width: 100%; box-sizing: border-box; padding: 8px 10px;
    border: 1px solid #cbd5e1; border-radius: 8px;
    font: inherit; font-size: 13px; color: #0f172a; background: #fff;
  }
  .${MARKER}-modal textarea { min-height: 260px; resize: vertical; font-family: ui-monospace, Menlo, Consolas, monospace; }
  .${MARKER}-warn {
    margin: 12px 0 0; padding: 8px 11px;
    border: 1px solid #fde68a; border-radius: 8px;
    background: #fffbeb; color: #92400e; font-size: 13px;
  }
  .${MARKER}-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .${MARKER}-row button {
    padding: 9px 15px; border-radius: 8px; border: 1px solid #cbd5e1;
    background: #fff; font: inherit; font-size: 13px; font-weight: 600;
    color: #0f172a; cursor: pointer;
  }
  .${MARKER}-row button.primary { background: #0f766e; border-color: #0f766e; color: #fff; }
  .${MARKER}-row button.ghost { margin-left: auto; color: #64748b; }
  .${MARKER}-say { margin: 10px 0 0; font-size: 13px; color: #0f766e; min-height: 18px; }
</style>`;

function scriptFor(requestId) {
  return `
<script id="${MARKER}-js">
(function () {
  var REQ = ${JSON.stringify(String(requestId))};
  var API = "/__nesher_quote/hotel/" + REQ + "/";
  var MARK = ${JSON.stringify(MARKER)};
  var draft = null;
  var ov = null;

  function el(tag, cls, txt) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  /* Sit beside the Mercury button when it is there, else under the heading. */
  function place(btn) {
    var pay = document.querySelector("[data-nesher-mercury-pay]");
    if (pay && pay.parentNode && pay.parentNode.parentNode) {
      pay.parentNode.parentNode.insertBefore(btn, pay.parentNode.nextSibling);
      return true;
    }
    var h1 = document.querySelector("h1");
    if (h1 && h1.parentNode) {
      h1.parentNode.insertBefore(btn, h1.nextSibling);
      return true;
    }
    return false;
  }

  function close() {
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
    ov = null;
    document.removeEventListener("keydown", onKey);
  }
  function onKey(e) { if (e.key === "Escape") close(); }

  function field(parent, label, tag, value) {
    parent.appendChild(el("label", null, label));
    var f = document.createElement(tag);
    f.value = value == null ? "" : value;
    parent.appendChild(f);
    return f;
  }

  function open() {
    close();
    ov = el("div", MARK + "-ov");
    ov.addEventListener("click", function (e) { if (e.target === ov) close(); });
    var m = el("div", MARK + "-modal");
    ov.appendChild(m);

    m.appendChild(el("h2", null, "Ask the hotel for a price"));
    m.appendChild(el("p", MARK + "-sub",
      "Written from this request. Check it, then send from your own mailbox."));

    /* Offer picker only earns its place when there is a choice to make. */
    var offerSel = null;
    if (draft.offers && draft.offers.length > 1) {
      m.appendChild(el("label", null, "Hotel"));
      offerSel = document.createElement("select");
      draft.offers.forEach(function (o) {
        var opt = document.createElement("option");
        opt.value = String(o.id);
        opt.textContent = o.hotel_name || ("Offer #" + o.id);
        if (draft.selectedOfferId === o.id) opt.selected = true;
        offerSel.appendChild(opt);
      });
      offerSel.addEventListener("change", function () { load(offerSel.value); });
      m.appendChild(offerSel);
    }

    var to = field(m, "To", "input", (draft.to || []).join(", "));
    to.placeholder = "hotel@example.com";
    var su = field(m, "Subject", "input", draft.subject);
    var body = field(m, "Message", "textarea", draft.body);

    if (!draft.to || !draft.to.length) {
      m.appendChild(el("p", MARK + "-warn",
        "No email on file for this hotel — type the address above."));
    }
    if (draft.missing && draft.missing.length) {
      m.appendChild(el("p", MARK + "-warn",
        "Missing from the CRM: " + draft.missing.join(", ") + ". Fill it in before sending."));
    }

    var say = el("p", MARK + "-say", "");
    var row = el("div", MARK + "-row");

    function compose(kind) {
      var t = to.value.trim();
      if (!t) { say.textContent = "Add the hotel's email address first."; to.focus(); return; }
      var url = kind === "gmail"
        ? "https://mail.google.com/mail/?view=cm&fs=1&to=" + encodeURIComponent(t) +
          "&su=" + encodeURIComponent(su.value) + "&body=" + encodeURIComponent(body.value)
        : "mailto:" + encodeURIComponent(t) +
          "?subject=" + encodeURIComponent(su.value) + "&body=" + encodeURIComponent(body.value);
      window.open(url, kind === "gmail" ? "_blank" : "_self");
      say.textContent = "Opened — press send there.";
    }

    var gmail = el("button", "primary", "Open in Gmail");
    gmail.addEventListener("click", function () { compose("gmail"); });
    var mail = el("button", null, "Open in mail app");
    mail.addEventListener("click", function () { compose("mailto"); });
    var copy = el("button", null, "Copy message");
    copy.addEventListener("click", function () {
      var text = body.value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { say.textContent = "Copied."; },
          function () { say.textContent = "Copy failed — select the text instead."; }
        );
      } else {
        body.select();
        say.textContent = "Selected — press Ctrl+C.";
      }
    });
    var shut = el("button", "ghost", "Close");
    shut.addEventListener("click", close);

    row.appendChild(gmail); row.appendChild(mail); row.appendChild(copy); row.appendChild(shut);
    m.appendChild(row);
    m.appendChild(say);

    document.body.appendChild(ov);
    document.addEventListener("keydown", onKey);
    (to.value ? su : to).focus();
  }

  function load(offerId) {
    var url = offerId ? API + "?offer=" + encodeURIComponent(offerId) : API;
    return fetch(url, { credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.error) || "Could not build the email");
        draft = d.draft;
        open();
      })
      .catch(function (e) {
        close();
        window.alert("Could not build the email: " + e.message);
      });
  }

  function init() {
    if (document.getElementById(MARK + "-btn")) return;
    var btn = el("button", MARK + "-btn", "Email hotel for price");
    btn.id = MARK + "-btn";
    btn.type = "button";
    btn.addEventListener("click", function () { load(null); });
    place(btn);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
</script>`;
}

/**
 * @param {string} html
 * @param {string} path
 */
export function injectQuoteEmail(html, path) {
  if (!html || typeof html !== "string") return html;
  if (html.includes(`${MARKER}-js`)) return html;
  const requestId = isHotelRequestPath(path);
  if (!requestId) return html;

  const block = `${CSS}${scriptFor(requestId)}`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, () => `${block}</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, () => `${block}</html>`);
  return html + block;
}

export { CSS, scriptFor };
