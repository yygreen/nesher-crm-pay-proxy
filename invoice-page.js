/**
 * Guest invoice page + signed long-token fallback.
 * Prefer short codes from invoice-store.js; long tokens still verify here.
 */

import crypto from "node:crypto";

const DEFAULT_TTL_SEC = 60 * 60 * 24 * 45;

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

export function mintInvoiceToken(data) {
  const amountUsd = Math.round(Number(data.amountUsd) * 100) / 100;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("amountUsd required");
  }
  const mercuryUrl = String(data.mercuryUrl || "").trim();
  if (!/^https:\/\//i.test(mercuryUrl)) {
    throw new Error("mercuryUrl required");
  }
  const payload = {
    v: 1,
    a: amountUsd,
    n: String(data.invoiceNumber || "").slice(0, 80),
    c: String(data.customerName || "").slice(0, 120),
    s: String(data.summary || data.lineName || "").slice(0, 240),
    m: mercuryUrl.slice(0, 500),
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
  // Older tokens may carry q/p (dead Square card fields) — deliberately ignored.
  return {
    ok: true,
    data: {
      amountUsd: Number(payload.a),
      invoiceNumber: payload.n || "",
      customerName: payload.c || "",
      summary: payload.s || "",
      mercuryUrl: payload.m,
      exp: payload.exp,
    },
  };
}

export function buildCombinedPayUrl(publicOrigin, codeOrToken) {
  const origin = String(publicOrigin || "https://www.flynesher.com").replace(
    /\/$/,
    ""
  );
  return `${origin}/pay/${encodeURIComponent(codeOrToken)}`;
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
 * Clean guest invoice — white, calm, two clear actions max.
 */
export function renderInvoiceHtml(data) {
  const amount = money(data.amountUsd);
  const inv = esc(data.invoiceNumber || "");
  const name = esc(data.customerName || "");
  const summary = esc(data.summary || "");
  const mercuryUrl = esc(data.mercuryUrl);

  // Bank-only by design: no card processor exists (stored/tokenized card URLs
  // from the Square era must never render — that account is closed).
  const actions = `
      <a class="btn btn-primary" href="${mercuryUrl}">Pay with bank</a>
      <p class="hint">Secure bank transfer on the next screen.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>${inv ? inv + " · " : ""}${amount}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #f4f5f7; color: #111;
      display: flex; align-items: center; justify-content: center;
      padding: 24px 16px;
    }
    .sheet {
      width: 100%; max-width: 400px;
      background: #fff;
      border-radius: 16px;
      box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 12px 32px rgba(0,0,0,.08);
      padding: 32px 28px 28px;
    }
    .logo {
      font-size: 13px; font-weight: 600; color: #666;
      letter-spacing: .02em; margin: 0 0 28px;
    }
    .label { font-size: 13px; color: #888; margin: 0 0 6px; }
    .amount {
      font-size: 40px; font-weight: 700; letter-spacing: -.03em;
      margin: 0 0 8px; font-variant-numeric: tabular-nums;
    }
    .meta { font-size: 14px; color: #555; margin: 0 0 4px; line-height: 1.4; }
    .meta strong { color: #111; font-weight: 600; }
    .line {
      height: 1px; background: #eee; margin: 24px 0;
    }
    .btn {
      display: block; width: 100%; text-align: center; text-decoration: none;
      border-radius: 12px; padding: 14px 16px; font-size: 16px; font-weight: 600;
      margin-bottom: 10px;
    }
    .btn-primary { background: #0f766e; color: #fff; }
    .btn-primary:hover { background: #0d6a63; }
    .btn-secondary {
      background: #fff; color: #111;
      border: 1px solid #ddd;
    }
    .btn-secondary:hover { background: #fafafa; }
    .hint {
      margin: 14px 0 0; font-size: 12.5px; color: #888;
      text-align: center; line-height: 1.45;
    }
    .foot {
      margin-top: 28px; font-size: 12px; color: #aaa; text-align: center;
    }
  </style>
</head>
<body>
  <div class="sheet">
    <p class="logo">Nesher · JRM Hotels</p>
    <p class="label">Amount due</p>
    <p class="amount">${amount}</p>
    ${name ? `<p class="meta">For <strong>${name}</strong></p>` : ""}
    ${inv ? `<p class="meta">Invoice <strong>${inv}</strong></p>` : ""}
    ${summary ? `<p class="meta">${summary}</p>` : ""}
    <div class="line"></div>
    ${actions}
    <p class="foot">Questions? Reply to your booking message.</p>
  </div>
</body>
</html>`;
}

export function renderInvoiceErrorHtml(message) {
  const msg = esc(
    message || "This payment link is invalid or has expired."
  );
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Payment link</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f5f7;padding:24px}
  .box{max-width:360px;background:#fff;border-radius:16px;padding:28px;text-align:center;
  box-shadow:0 12px 32px rgba(0,0,0,.08)}
  h1{font-size:17px;margin:0 0 8px} p{margin:0;color:#666;line-height:1.5;font-size:14px}
</style></head>
<body><div class="box"><h1>Link unavailable</h1><p>${msg}</p></div></body></html>`;
}
