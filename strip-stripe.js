/**
 * Stripe is dead. Drop the Django include from proxied staff HTML.
 * CSS-hide is not enough — the panel unhides when method=card.
 */

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

function openTagEnd(html, lt) {
  let q = null;
  for (let i = lt + 1; i < html.length; i++) {
    const c = html[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      continue;
    }
    if (c === ">") return i;
  }
  return -1;
}

function tagNameAt(html, lt) {
  const m = /^<\/?([a-zA-Z][\w:-]*)/.exec(html.slice(lt));
  return m ? m[1].toLowerCase() : "";
}

function elementEnd(html, lt) {
  const name = tagNameAt(html, lt);
  const gt = openTagEnd(html, lt);
  if (!name || gt < 0) return -1;
  const open = html.slice(lt, gt + 1);
  if (/\/>\s*$/.test(open) || VOID_TAGS.has(name)) return gt + 1;
  let i = gt + 1;
  let depth = 1;
  while (i < html.length) {
    const next = html.indexOf("<", i);
    if (next < 0) return -1;
    if (html.startsWith("<!--", next)) {
      const end = html.indexOf("-->", next + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const n = tagNameAt(html, next);
    if (!n) {
      i = next + 1;
      continue;
    }
    if (html[next + 1] === "/") {
      const closeGt = html.indexOf(">", next);
      if (closeGt < 0) return -1;
      if (n === name) {
        depth -= 1;
        if (depth === 0) return closeGt + 1;
      }
      i = closeGt + 1;
      continue;
    }
    const ogt = openTagEnd(html, next);
    if (ogt < 0) return -1;
    const o = html.slice(next, ogt + 1);
    if (n === name && !(/\/>\s*$/.test(o) || VOID_TAGS.has(n))) depth += 1;
    i = ogt + 1;
  }
  return -1;
}

function nextNamedTag(html, from, name) {
  const needle = "<" + name;
  const lower = html.toLowerCase();
  let i = from;
  while (i < html.length) {
    const at = lower.indexOf(needle, i);
    if (at < 0) return -1;
    const after = html[at + needle.length];
    if (!after || /[\s>\/]/.test(after)) return at;
    i = at + 1;
  }
  return -1;
}

function stripMatching(html, tag, pred) {
  let i = 0;
  let out = "";
  for (;;) {
    const at = nextNamedTag(html, i, tag);
    if (at < 0) {
      out += html.slice(i);
      break;
    }
    const end = elementEnd(html, at);
    const gt = openTagEnd(html, at);
    if (end < 0 || gt < 0) {
      out += html.slice(i);
      break;
    }
    const open = html.slice(at, gt + 1);
    const inner = html.slice(gt + 1, end);
    if (pred(open, inner)) {
      out += html.slice(i, at);
      i = end;
      continue;
    }
    out += html.slice(i, end);
    i = end;
  }
  return out;
}

const STRIPE_OPEN_RE =
  /stripe-secure-payment-panel|data-stripe-secure-panel/i;
const STRIPE_STYLE_RE =
  /stripe-secure-payment-heading|stripe-secure-payment-prepare|stripe-secure-payment-help/i;
const STRIPE_SCRIPT_SRC_RE = /js\.stripe\.com/i;
const STRIPE_SCRIPT_BODY_RE =
  /Use Secure Stripe Card Form|Secure Stripe Card Payment|data-stripe-prepare|stripe_create_payment_intent|stripe-secure-payment-panel/i;

export function stripStripeUi(html) {
  if (!html || typeof html !== "string") return html;
  let out = html;
  out = stripMatching(out, "div", (open) => STRIPE_OPEN_RE.test(open));
  out = stripMatching(
    out,
    "style",
    (open, inner) =>
      !/\bid\s*=\s*["']nesher-mercury-pay-css["']/i.test(open) &&
      STRIPE_STYLE_RE.test(inner)
  );
  out = stripMatching(
    out,
    "script",
    (open, inner) =>
      STRIPE_SCRIPT_SRC_RE.test(open) || STRIPE_SCRIPT_BODY_RE.test(inner)
  );
  return out;
}
