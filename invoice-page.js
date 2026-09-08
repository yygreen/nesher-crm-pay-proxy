/**
 * Guest invoice page + signed long-token fallback.
 * Prefer short codes from invoice-store.js; long tokens still verify here.
 */

import crypto from "node:crypto";
import {
  isAllowedCardUrl,
  brandFromInvoiceNumber,
  brandFromRecord,
  stripDeadCardFields,
  collectScriptUrl,
  GUEST_DECLINE_DEFAULT,
  GUEST_OURS,
  GUEST_MISSING_CARD,
} from "./nmi-card.js";

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
  const clean = stripDeadCardFields(data);
  const cardUrl = isAllowedCardUrl(clean.cardUrl)
    ? String(clean.cardUrl).trim().slice(0, 500)
    : "";
  const inv = String(data.invoiceNumber || "").slice(0, 80);
  const brandId = String(clean.brandId || brandFromInvoiceNumber(inv).id).slice(
    0,
    16
  );
  const payload = {
    v: 1,
    a: amountUsd,
    n: inv,
    c: String(data.customerName || "").slice(0, 120),
    s: String(data.summary || data.lineName || "").slice(0, 240),
    m: mercuryUrl.slice(0, 500),
    exp: Math.floor(Date.now() / 1000) + (Number(data.ttlSec) || DEFAULT_TTL_SEC),
  };
  if (cardUrl) payload.k = cardUrl;
  if (brandId) payload.b = brandId;
  if (data.capture === "collectjs") payload.t = "c";
  else if (data.capture === "invoice") payload.t = "i";
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
  const cardUrl = isAllowedCardUrl(payload.k) ? payload.k : undefined;
  return {
    ok: true,
    data: {
      amountUsd: Number(payload.a),
      invoiceNumber: payload.n || "",
      customerName: payload.c || "",
      summary: payload.s || "",
      mercuryUrl: payload.m,
      cardUrl,
      brandId: payload.b || brandFromInvoiceNumber(payload.n).id,
      capture:
        payload.t === "c" ? "collectjs" : payload.t === "i" ? "invoice" : "",
      exp: payload.exp,
    },
  };
}

export function buildCombinedPayUrl(publicOrigin, codeOrToken) {
  const origin = String(publicOrigin || "https://www.flynesher.com").replace(
    /\/$/,
    ""
  );
  if (!/^https:\/\/(www\.)?(flynesher\.com|jrmhotels\.com)$/i.test(origin)) {
    return `https://www.flynesher.com/pay/${encodeURIComponent(codeOrToken)}`;
  }
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

const NESHER_LOGO_SRC = "https://assets.flynesher.com/nesher-logo.jpg";
const NESHER_LOGO_FALLBACK =
  "https://www.flynesher.com/static/core/images/nesher_logo.png";
const JRM_LOGO_SRC = "https://jrmhotels.com/images/logos/jrm-logo.png";

function brandLogoHtml(brand) {
  const isJrm = brand && brand.id === "jrm";
  const src = isJrm ? JRM_LOGO_SRC : NESHER_LOGO_SRC;
  const alt = isJrm ? "JRM Hotels" : "Nesher Travel";
  const fallback = isJrm
    ? ""
    : ` data-fallback="${esc(NESHER_LOGO_FALLBACK)}" onerror="this.onerror=null;this.src=this.getAttribute('data-fallback')"`;
  return `<p class="logo"><img src="${esc(src)}" alt="${esc(alt)}" height="40"${fallback}></p>`;
}

function renderCollectJsForm(collectKey) {
  const src = esc(collectScriptUrl());
  const key = esc(collectKey);
  return `<div id="card-form">
      <p class="card-field-label">Card number</p>
      <div id="ccnumber" class="card-field"></div>
      <div class="card-row">
        <div class="card-col">
          <p class="card-field-label">Expiration</p>
          <div id="ccexp" class="card-field"></div>
        </div>
        <div class="card-col">
          <p class="card-field-label">CVV</p>
          <div id="cvv" class="card-field"></div>
        </div>
      </div>
      <p id="card-err" class="card-err" hidden></p>
      <button type="button" class="btn btn-primary" id="pay-card-btn">Pay with card</button>
      <script src="${src}" data-tokenization-key="${key}"></script>
      <script>
      (function(){
        function showErr(m){
          var e=document.getElementById("card-err");
          if(!e) return;
          var s=String(m||"").trim();
          if(!s || s.charAt(0)==="{" || s.indexOf('"object"')>=0){
            s=${JSON.stringify(GUEST_DECLINE_DEFAULT)};
          }
          e.hidden=false;
          e.textContent=s;
        }
        function go(){
          if(!window.CollectJS) return;
          CollectJS.configure({
            variant:"inline",
            styleSniffer:true,
            customCss:{color:"#111","font-size":"16px","font-family":"-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",padding:"12px 14px","background-color":"#fff",border:"none"},
            placeholderCss:{color:"#9AA3AF","font-size":"16px"},
            focusCss:{color:"#111"},
            invalidCss:{color:"#B91C1C"},
            paymentSelector:"#pay-card-btn",
            fields:{
              ccnumber:{selector:"#ccnumber",placeholder:"ACCT-000003"},
              ccexp:{selector:"#ccexp",placeholder:"MM / YY"},
              cvv:{selector:"#cvv",placeholder:"123"}
            },
            callback:function(response){
              var token=response&&response.token;
              var btn=document.getElementById("pay-card-btn");
              if(!token){showErr(${JSON.stringify(GUEST_MISSING_CARD)});return;}
              if(btn) btn.disabled=true;
              fetch(location.pathname.replace(/\\/$/,"")+"/charge",{
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({payment_token:token})
              }).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
              .then(function(x){
                if(x.j&&x.j.ok){
                  var form=document.getElementById("card-form");
                  if(form) form.innerHTML="<p class='hint'>Card payment received. Thank you.</p>";
                } else {
                  if(btn) btn.disabled=false;
                  showErr((x.j&&x.j.message)||${JSON.stringify(GUEST_DECLINE_DEFAULT)});
                }
              }).catch(function(){
                if(btn) btn.disabled=false;
                showErr(${JSON.stringify(GUEST_OURS)});
              });
            }
          });
        }
        if(window.CollectJS) go();
        else {
          var s=document.querySelector("script[data-tokenization-key]");
          if(s) s.addEventListener("load", go);
        }
      })();
      </script>
    </div>`;
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
  const brand = brandFromRecord({
    brandId: data.brandId,
    invoiceNumber: data.invoiceNumber,
    kind: data.kind,
  });
  const paid = Boolean(data.paidAt);
  const hostedCardUrl =
    !paid && isAllowedCardUrl(data.cardUrl) ? esc(data.cardUrl) : "";
  const collectKey = String(data.collectPublicKey || "").trim();
  const collectOn = Boolean(
    !paid &&
      !hostedCardUrl &&
      collectKey &&
      data.capture === "collectjs"
  );
  const hasCard = Boolean(hostedCardUrl || collectOn);

  const cardBtn = hostedCardUrl
    ? `<a class="btn btn-primary" href="${hostedCardUrl}">Pay with card</a>`
    : collectOn
      ? renderCollectJsForm(collectKey)
      : "";
  const bankBtn = paid
    ? ""
    : `<a class="btn ${hasCard ? "btn-secondary" : "btn-primary"}" href="${mercuryUrl}">Pay with bank</a>`;
  const hint = paid ? `<p class="hint">Paid. Thank you.</p>` : "";
  const actions = `
      ${cardBtn}
      ${bankBtn}
      ${hint}`;

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
    .logo { margin: 0 0 24px; }
    .logo img {
      display: block; height: 40px; width: auto; max-width: 220px;
      object-fit: contain;
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
    button.btn { cursor: pointer; border: 0; font-family: inherit; }
    button.btn[disabled] { opacity: .6; cursor: wait; }
    .card-field-label { font-size: 13px; color: #555; margin: 0 0 6px; }
    .card-field {
      height: 48px; padding: 0; overflow: hidden; margin: 0 0 10px;
      border: 1px solid #D8DEE4; border-radius: 10px; background: #fff;
    }
    .card-field iframe { width: 100%; height: 48px; border: 0; display: block; }
    .card-row {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 0 10px;
    }
    .card-col { min-width: 0; }
    .card-row .card-field { margin: 0; }
    .card-field:focus-within {
      border-color: #3D7A99;
      box-shadow: 0 0 0 3px rgba(61,122,153,.18);
    }
    .card-err { margin: 0 0 10px; font-size: 13px; color: #b91c1c; text-align: center; }
    .btn-primary { background: #3D7A99; color: #fff; }
    .btn-primary:hover { background: #336882; }
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
    body.pay-brand-jrm { background: #FAF6EC; }
    body.pay-brand-jrm .logo img {
      filter: brightness(0) sepia(1) hue-rotate(0deg) saturate(0.5);
    }
    body.pay-brand-jrm .btn-primary { background: #5C4528; }
    body.pay-brand-jrm .btn-primary:hover { background: #3D3229; }
    body.pay-brand-jrm .card-field:focus-within {
      border-color: #5C4528;
      box-shadow: 0 0 0 3px rgba(92,69,40,.18);
    }
  </style>
</head>
<body class="pay-brand-${esc(brand.id)}">
  <div class="sheet">
    ${brandLogoHtml(brand)}
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
