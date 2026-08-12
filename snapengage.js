/**
 * SnapEngage live-chat widget for the PUBLIC Nesher Travel site.
 *
 * The marketing site (www.flynesher.com) and the staff CRM are the SAME Django
 * app behind this proxy, sharing hosts and paths. So the widget is gated three
 * ways and every gate must pass:
 *   1. host is the public marketing host (not crm.flynesher.com),
 *   2. path is one of the known marketing pages,
 *   3. the rendered HTML does NOT look like the staff CRM.
 * Gate 3 matters because Django serves the CRM dashboard at "/" for a
 * logged-in staff member — without it, agents would end up chatting themselves.
 */

const MARKER = "nesher-snapengage";

/** Given by Joseph 2026-08-12; overridable without a code change. */
export const DEFAULT_WIDGET_ID = "c4b14451-5977-400d-b64e-89f1252d5d85";

/** Public marketing pages, normalised without a trailing slash ("" === "/"). */
const PUBLIC_PATHS = new Set(["", "/flights", "/points-request"]);

const DEFAULT_HOSTS = ["www.flynesher.com", "flynesher.com"];

/** Rendered only by the authenticated CRM templates, never by the marketing site. */
const STAFF_MARKERS = [
  /\/attendance\/clock-in\//i,
  /id=["']nesher-pay-title["']/i,
  /class=["'][^"']*\bpage-title\b/i,
  /\bLog\s?out\b/i,
];

function normalisePath(path) {
  const p = String(path || "/").split("?")[0].split("#")[0];
  return p.replace(/\/+$/, "");
}

export function isPublicMarketingPath(path) {
  return PUBLIC_PATHS.has(normalisePath(path));
}

export function isPublicMarketingHost(host, allowed = DEFAULT_HOSTS) {
  const raw = String(host || "").split(":")[0].toLowerCase();
  return allowed.some((h) => h.toLowerCase() === raw);
}

export function looksLikeStaffPage(html) {
  const text = String(html || "");
  return STAFF_MARKERS.some((re) => re.test(text));
}

/** Reject anything that is not a plain widget UUID — the id lands inside a <script>. */
export function isValidWidgetId(id) {
  return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(id || ""));
}

export function snapEngageSnippet(widgetId) {
  return `
<!-- begin ${MARKER} -->
<script type="text/javascript">
  (function() {
    var se = document.createElement('script'); se.type = 'text/javascript'; se.async = true;
    se.src = 'https://storage.googleapis.com/code.snapengage.com/js/${widgetId}.js';
    var done = false;
    se.onload = se.onreadystatechange = function() {
      if (!done&&(!this.readyState||this.readyState==='loaded'||this.readyState==='complete')) {
        done = true;
      }
    };
    var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(se, s);
  })();
</script>
<!-- end ${MARKER} -->
`;
}

/**
 * @param {string} html   upstream HTML
 * @param {string} path   request path
 * @param {{host?: string, widgetId?: string, enabled?: boolean, hosts?: string[],
 *          staffCheckHtml?: string}} [opts]
 *   staffCheckHtml — the ORIGINAL upstream HTML, when earlier injectors have
 *   already added markup that would trip the staff-page check.
 */
export function injectSnapEngage(html, path, opts = {}) {
  if (!html || typeof html !== "string") return html;

  const enabled = opts.enabled !== false;
  if (!enabled) return html;

  const widgetId = opts.widgetId || DEFAULT_WIDGET_ID;
  if (!isValidWidgetId(widgetId)) return html;

  if (html.includes(MARKER)) return html; // already injected
  if (html.includes("code.snapengage.com")) return html; // upstream added its own

  if (!isPublicMarketingHost(opts.host, opts.hosts || DEFAULT_HOSTS)) return html;
  if (!isPublicMarketingPath(path)) return html;
  if (looksLikeStaffPage(opts.staffCheckHtml ?? html)) return html;

  const snippet = snapEngageSnippet(widgetId);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${snippet}</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${snippet}</html>`);
  return html + snippet;
}
