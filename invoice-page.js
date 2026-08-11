/**
 * One guest-facing invoice page that unifies Mercury (bank/ACH) + Square (card).
 * Mercury and Square cannot share a hosted checkout — this page is the product UX
 * layer that presents one invoice and routes each method to the right processor.
 *
 * Token is a signed, stateless payload (no DB). Secret:
 *   PAY_PAGE_SECRET || MERCURY_RELAY_KEY
 */

import crypto from "node:crypto";

const DEFAULT_TTL_SEC = 60 * 60 * 24 * 45; // 45 days

function signingSecret() {
  const s = String(
    process.env.PAY_PAGE_SECRET ||
      process.env.MERCURY_RELAY_KEY ||
      process.env.MERCURY_TOKEN_NESHER ||
      ""
  ).trim();
  return s || "nesher-pay-page-dev-only";
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}

function fromB64url(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64").toString("utf8");
}

function sign(payloadB64) {
  return b64url(
    crypto.createHmac("sha256", signingSecret()).update(payloadB64).digest()
  );
}

/**
 * @param {object} data
 * @param {number} data.amountUsd
 * @param {string} data.invoiceNumber
 * @param {string} [data.customerName]
 * @param {string} [data.summary]
 * @param {string} [data.lineName]
 * @param {string} data.mercuryUrl
 * @param {string} [data.squareUrl]
 * @param {string} [data.cardProcessor] stripe|square|none
 * @param {number} [data.ttlSec]
 */
export function mintInvoiceToken(data) {
  const amountUsd = Math.round(Number(data.amountUsd) * 100) / 100;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("amountUsd required");
  }
  const mercuryUrl = String(data.mercuryUrl || "").trim();
  if (!/^https:\/\//i.test(mercuryUrl)) {
    throw new Error("mercuryUrl required");
  }
  const squareUrl = String(data.squareUrl || "").trim();
  const payload = {
    v: 1,
    a: amountUsd,
    n: String(data.invoiceNumber || "").slice(0, 80),
    c: String(data.customerName || "").slice(0, 120),
    s: String(data.summary || data.lineName || "").slice(0, 240),
    m: mercuryUrl.slice(0, 500),
    q: squareUrl && /^https:\/\//i.test(squareUrl) ? squareUrl.slice(0, 500) : "",
    p: String(data.cardProcessor || (squareUrl ? "square" : "none")).slice(0, 16),
    exp: Math.floor(Date.now() / 1000) + (Number(data.ttlSec) || DEFAULT_TTL_SEC),
  };
  const body = b64urlJson(payload);
  return `${body}.${sign(body)}`;
}

export function verifyInvoiceToken(token) {
  const raw = String(token || "").trim();
  const dot = raw.lastIndexOf(".");
  if (dot < 8) return { ok: false, error: "bad token" };
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = sign(body);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, error: "bad signature" };
    }
  } catch {
    return { ok: false, error: "bad signature" };
  }
  let payload;
  try {
    payload = JSON.parse(fromB64url(body));
  } catch {
    return { ok: false, error: "bad payload" };
  }
  if (!payload || payload.v !== 1) return { ok: false, error: "bad version" };
  if (payload.exp && Number(payload.exp) < Math.floor(Date.now() / 1000)) {
    return { ok: false, error: "expired" };
  }
  if (!payload.m || !/^https:\/\//i.test(payload.m)) {
    return { ok: false, error: "missing pay url" };
  }
  return {
    ok: true,
    data: {
      amountUsd: Number(payload.a),
      invoiceNumber: payload.n || "",
      customerName: payload.c || "",
      summary: payload.s || "",
      mercuryUrl: payload.m,
      squareUrl: payload.q || "",
      cardProcessor: payload.p || "none",
      exp: payload.exp,
    },
  };
}

export function buildCombinedPayUrl(publicOrigin, token) {
  const origin = String(publicOrigin || "https://www.flynesher.com").replace(
    /\/$/,
    ""
  );
  return `${origin}/pay/${token}`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function money(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "$—";
  return (
    "$" +
    x.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/**
 * Stunning single-invoice HTML for guests.
 * @param {ReturnType<typeof verifyInvoiceToken> extends {ok:true} ? any : never} data
 */
export function renderInvoiceHtml(data, opts = {}) {
  const amount = money(data.amountUsd);
  const inv = esc(data.invoiceNumber || "Invoice");
  const name = esc(data.customerName || "Guest");
  const summary = esc(data.summary || "");
  const mercuryUrl = esc(data.mercuryUrl);
  const squareUrl = data.squareUrl ? esc(data.squareUrl) : "";
  const hasSquare = Boolean(data.squareUrl);
  const stripeCombo = data.cardProcessor === "stripe";
  // When Stripe is healthy, Mercury page already has card+bank — one primary CTA.
  // When Square backup, two equal method cards.
  const title = hasSquare
    ? "Pay your invoice"
    : stripeCombo
      ? "Pay your invoice"
      : "Pay by bank transfer";

  const methodsBlock = hasSquare
    ? `
    <div class="methods">
      <a class="method primary" href="${squareUrl}" rel="noopener">
        <div class="method-kicker">Recommended · Instant</div>
        <div class="method-title">Pay by card</div>
        <div class="method-sub">Secure checkout · Visa, Mastercard, Amex</div>
        <div class="method-cta">Continue →</div>
      </a>
      <a class="method" href="${mercuryUrl}" rel="noopener">
        <div class="method-kicker">No card fee path</div>
        <div class="method-title">Pay by bank / ACH</div>
        <div class="method-sub">US bank transfer · settles to our account</div>
        <div class="method-cta">Continue →</div>
      </a>
    </div>`
    : `
    <div class="methods single">
      <a class="method primary" href="${mercuryUrl}" rel="noopener">
        <div class="method-kicker">${stripeCombo ? "Bank or card" : "Bank transfer / ACH"}</div>
        <div class="method-title">${stripeCombo ? "Pay securely" : "Pay by bank / ACH"}</div>
        <div class="method-sub">${stripeCombo ? "Card and ACH on the next screen" : "Secure payment instructions on the next screen"}</div>
        <div class="method-cta">Continue to payment →</div>
      </a>
    </div>`;

  const brand = esc(opts.brand || "Nesher · JRM Hotels");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="robots" content="noindex,nofollow" />
  <title>${inv} · ${amount}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=Fraunces:opsz,wght@9..144,560;9..144,650&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #0b1220;
      --bg2: #111a2e;
      --card: #ffffff;
      --ink: #0f172a;
      --muted: #64748b;
      --line: #e2e8f0;
      --teal: #0f766e;
      --teal-d: #0c5f58;
      --teal-s: #ccfbf1;
      --gold: #b45309;
      --gold-s: #fffbeb;
      --shadow: 0 24px 60px rgba(2, 8, 23, .35);
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; }
    body {
      font-family: "DM Sans", system-ui, -apple-system, Segoe UI, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 600px at 10% -10%, #1e3a5f 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #134e4a 0%, transparent 50%),
        linear-gradient(165deg, var(--bg), var(--bg2));
      padding: 28px 16px 48px;
    }
    .wrap { max-width: 480px; margin: 0 auto; }
    .brand {
      display: flex; align-items: center; justify-content: space-between;
      color: rgba(255,255,255,.78); font-size: 13px; font-weight: 600;
      letter-spacing: .02em; margin-bottom: 18px;
    }
    .brand span { opacity: .7; font-weight: 500; }
    .card {
      background: var(--card); border-radius: 22px; box-shadow: var(--shadow);
      overflow: hidden; border: 1px solid rgba(255,255,255,.08);
    }
    .hero {
      padding: 28px 28px 22px;
      background: linear-gradient(180deg, #f8fafc 0%, #fff 100%);
      border-bottom: 1px solid var(--line);
    }
    .eyebrow {
      font-size: 12px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: var(--teal); margin: 0 0 8px;
    }
    h1 {
      font-family: Fraunces, Georgia, serif; font-weight: 650;
      font-size: 28px; line-height: 1.15; margin: 0 0 6px; letter-spacing: -.02em;
    }
    .to { color: var(--muted); font-size: 14.5px; margin: 0 0 18px; }
    .amount {
      font-variant-numeric: tabular-nums;
      font-size: 42px; font-weight: 700; letter-spacing: -.03em;
      color: var(--ink); line-height: 1;
    }
    .inv {
      margin-top: 10px; display: inline-flex; gap: 8px; flex-wrap: wrap;
      font-size: 13px; color: var(--muted);
    }
    .inv b { color: #334155; font-weight: 650; }
    .summary {
      margin-top: 14px; padding: 12px 14px; border-radius: 12px;
      background: #f8fafc; border: 1px solid var(--line);
      font-size: 13.5px; line-height: 1.45; color: #334155;
    }
    .body { padding: 22px 22px 26px; }
    .methods { display: grid; gap: 12px; }
    .method {
      display: block; text-decoration: none !important; color: inherit;
      border: 1px solid var(--line); border-radius: 16px; padding: 16px 16px 14px;
      background: #fff; transition: border-color .15s, box-shadow .15s, transform .12s;
    }
    .method:hover {
      border-color: #99f6e4; box-shadow: 0 8px 24px rgba(15, 118, 110, .12);
      transform: translateY(-1px);
    }
    .method.primary {
      border-color: #5eead4;
      background: linear-gradient(180deg, #f0fdfa 0%, #fff 70%);
    }
    .method-kicker {
      font-size: 11px; font-weight: 700; letter-spacing: .06em;
      text-transform: uppercase; color: var(--teal); margin-bottom: 6px;
    }
    .method-title { font-size: 18px; font-weight: 700; letter-spacing: -.01em; }
    .method-sub { font-size: 13px; color: var(--muted); margin-top: 4px; line-height: 1.4; }
    .method-cta {
      margin-top: 12px; display: inline-flex; align-items: center;
      font-size: 13.5px; font-weight: 700; color: var(--teal-d);
    }
    .method.primary .method-cta {
      background: var(--teal); color: #fff; padding: 10px 14px; border-radius: 10px;
    }
    .method.primary:hover .method-cta { background: var(--teal-d); }
    .trust {
      margin-top: 18px; font-size: 12px; color: var(--muted); line-height: 1.5;
      text-align: center;
    }
    .foot {
      margin-top: 18px; text-align: center; color: rgba(255,255,255,.45);
      font-size: 12px;
    }
    @media (max-width: 420px) {
      .amount { font-size: 36px; }
      h1 { font-size: 24px; }
      .hero, .body { padding-left: 18px; padding-right: 18px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand"><div>${brand}</div><span>Secure payment</span></div>
    <div class="card">
      <div class="hero">
        <p class="eyebrow">${title}</p>
        <h1>Balance due</h1>
        <p class="to">For ${name}</p>
        <div class="amount">${amount}</div>
        <div class="inv">
          <span>Invoice <b>${inv}</b></span>
        </div>
        ${summary ? `<div class="summary">${summary}</div>` : ""}
      </div>
      <div class="body">
        ${methodsBlock}
        <p class="trust">You’ll complete payment on a secure page. One payment is enough — please don’t pay twice.</p>
      </div>
    </div>
    <p class="foot">Questions? Reply to your booking email or WhatsApp.</p>
  </div>
</body>
</html>`;
}

export function renderInvoiceErrorHtml(message) {
  const msg = esc(message || "This payment link is invalid or has expired.");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Payment link</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;
  background:#0b1220;color:#e2e8f0;padding:24px}
  .box{max-width:400px;background:#fff;color:#0f172a;border-radius:16px;padding:28px;text-align:center}
  h1{font-size:18px;margin:0 0 8px} p{margin:0;color:#64748b;line-height:1.5;font-size:14px}
</style></head>
<body><div class="box"><h1>Link unavailable</h1><p>${msg}</p></div></body></html>`;
}
