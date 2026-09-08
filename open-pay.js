/**
 * Nesher open-amount guest card page.
 * Staff paste https://www.flynesher.com/pay/open — the guest types USD, then
 * Collect.js tokenizes, then POST /pay/open/charge {payment_token, amountUsd}.
 *
 * Not the CRM-priced /pay/<8-char> path (that amount stays store-locked).
 * Not JRM. Not Collect Checkout customPayment. No Mercury mint (no amount
 * until the guest types one). No processed-by sermon.
 */

import crypto from "node:crypto";
import {
  chargeWithToken,
  collectScriptUrl,
  looksLikePan,
} from "./nmi-card.js";

export const OPEN_PAY_PATH = "/pay/open";
export const OPEN_PAY_MIN_USD = 1;
export const OPEN_PAY_MAX_USD = 25000;
export const NESHER_LOGO_URL = "https://assets.flynesher.com/nesher-logo.jpg";
const NESHER_LOGO_FALLBACK =
  "https://www.flynesher.com/static/core/images/nesher_logo.png";

function normPath(pathname) {
  const p = String(pathname || "").split("?")[0];
  if (!p || p === "/") return "/";
  return p.replace(/\/+$/, "") || "/";
}

export function isOpenPayPath(pathname) {
  const p = normPath(pathname);
  return (
    p === "/pay/open" ||
    p === "/pay/open/charge" ||
    p === "/__nesher_pay/open" ||
    p === "/__nesher_pay/open/charge"
  );
}

export function isOpenPayChargePath(pathname) {
  const p = normPath(pathname);
  return p === "/pay/open/charge" || p === "/__nesher_pay/open/charge";
}

/** JRM hosts never serve an open-amount card page. */
export function openPayHostForbidden(host) {
  const h = String(host || "")
    .split(",")[0]
    .split(":")[0]
    .trim()
    .toLowerCase();
  return /(^|\.)jrmhotels\.com$/.test(h);
}

export function parseOpenAmountUsd(value) {
  if (value == null || value === "") {
    return { ok: false, error: "amount_required" };
  }
  const raw = String(value).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
    return { ok: false, error: "amount_invalid" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, error: "amount_invalid" };
  }
  const rounded = Math.round(n * 100) / 100;
  if (rounded < OPEN_PAY_MIN_USD) {
    return { ok: false, error: "amount_too_small" };
  }
  if (rounded > OPEN_PAY_MAX_USD) {
    return { ok: false, error: "amount_too_large" };
  }
  return { ok: true, amountUsd: rounded };
}

export function mintOpenInvoiceNumber(now = new Date()) {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const short = crypto.randomBytes(3).toString("hex");
  return `OPEN-${stamp}-${short}`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function httpStatusFor(error) {
  if (
    error === "amount_required" ||
    error === "amount_invalid" ||
    error === "amount_too_small" ||
    error === "amount_too_large" ||
    error === "payment_token required" ||
    error === "raw_card_rejected" ||
    error === "open_ref_required"
  ) {
    return 400;
  }
  if (error === "jrm_not_supported" || error === "second_dba_pending") {
    return 403;
  }
  if (error === "keys_missing") return 503;
  if (String(error || "").startsWith("nmi_sale_")) return 200;
  return 200;
}

/**
 * Open-amount capture. Amount comes from the guest POST (validated here).
 * CRM /pay/:code/charge must keep ignoring body.amount — this is the only
 * route that reads amountUsd from the client.
 */
export async function chargeOpenPay(opts = {}) {
  const kind = String(opts.kind || "open").toLowerCase();
  const brandId = String(opts.brandId || "").toLowerCase();
  if (brandId === "jrm" || kind === "hotel" || kind === "hotel-offer") {
    return { ok: false, error: "jrm_not_supported", httpStatus: 403 };
  }
  const parsed = parseOpenAmountUsd(opts.amountUsd);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, httpStatus: 400 };
  }
  const token = String(opts.paymentToken || "").trim();
  if (looksLikePan(token)) {
    return { ok: false, error: "raw_card_rejected", httpStatus: 400 };
  }
  if (!token) {
    return { ok: false, error: "payment_token required", httpStatus: 400 };
  }
  const invoiceNumber = String(
    opts.invoiceNumber || mintOpenInvoiceNumber()
  ).trim();
  if (!/^OPEN-/i.test(invoiceNumber)) {
    return { ok: false, error: "open_ref_required", httpStatus: 400 };
  }
  const sale = await chargeWithToken({
    amountUsd: parsed.amountUsd,
    invoiceNumber,
    kind: "open",
    customerName: opts.customerName || "Guest",
    summary: opts.summary || "Open amount",
    paymentToken: token,
    fetchImpl: opts.fetchImpl,
    privateKey: opts.privateKey,
  });
  if (!sale.ok) {
    const err = sale.error || "nmi_sale_failed";
    return {
      ok: false,
      error: err,
      blockedReason: sale.blockedReason,
      httpStatus: httpStatusFor(err),
    };
  }
  return {
    ok: true,
    amountUsd: parsed.amountUsd,
    invoiceNumber,
    transactionId: sale.transactionId || null,
    httpStatus: 200,
  };
}

export function renderOpenPayErrorHtml(message) {
  const msg = esc(message || "This page is not available.");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>Payment</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f4f5f7;padding:24px}
  .box{max-width:360px;background:#fff;border-radius:16px;padding:28px;text-align:center;
  box-shadow:0 12px 32px rgba(0,0,0,.08)}
  h1{font-size:17px;margin:0 0 8px} p{margin:0;color:#666;line-height:1.5;font-size:14px}
</style></head>
<body><div class="box"><h1>Link unavailable</h1><p>${msg}</p></div></body></html>`;
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
          e.hidden=false;
          e.textContent=m;
        }
        function readAmt(){
          var el=document.getElementById("amount-usd");
          if(!el) return null;
          var v=String(el.value||"").trim();
          if(!/^\\d+(\\.\\d{1,2})?$/.test(v)) return null;
          var n=Number(v);
          if(!isFinite(n)||n<1||n>25000) return null;
          return n;
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
              var amt=readAmt();
              if(!token){showErr("Card could not be tokenized. Try again.");return;}
              if(amt==null){showErr("Enter an amount between $1.00 and $25,000.00.");return;}
              if(btn) btn.disabled=true;
              fetch("/pay/open/charge",{
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify({payment_token:token,amountUsd:amt})
              }).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
              .then(function(x){
                if(x.j&&x.j.ok){
                  var form=document.getElementById("card-form");
                  var wrap=document.getElementById("amount-wrap");
                  if(wrap) wrap.hidden=true;
                  if(form) form.innerHTML="<p class='hint'>Card payment received. Thank you.</p>";
                } else {
                  if(btn) btn.disabled=false;
                  showErr((x.j&&(x.j.message||x.j.error))||"Card was declined. Try another card.");
                }
              }).catch(function(){
                if(btn) btn.disabled=false;
                showErr("Could not reach the card processor. Try again.");
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

export function renderOpenPayHtml(data = {}) {
  const collectKey = String(data.collectPublicKey || "").trim();
  const collectOn = Boolean(collectKey);
  const card = collectOn
    ? renderCollectJsForm(collectKey)
    : `<p class="hint">Card pay is not available right now.</p>`;
  const logo = esc(NESHER_LOGO_URL);
  const logoFallback = esc(NESHER_LOGO_FALLBACK);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex,nofollow" />
  <title>Pay Nesher</title>
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
      padding: 28px 28px 24px;
    }
    .logo { margin: 0 0 22px; }
    .logo img { display: block; height: 40px; width: auto; }
    .label { font-size: 13px; color: #888; margin: 0 0 6px; }
    .amount-row {
      display: flex; align-items: center; gap: 8px; margin: 0 0 8px;
    }
    .amount-prefix {
      font-size: 28px; font-weight: 700; letter-spacing: -.03em; color: #111;
    }
    #amount-usd {
      flex: 1; min-width: 0;
      font-size: 32px; font-weight: 700; letter-spacing: -.03em;
      font-variant-numeric: tabular-nums;
      border: 1px solid #D8DEE4; border-radius: 10px;
      padding: 10px 12px; color: #111; background: #fff;
      font-family: inherit;
    }
    #amount-usd:focus {
      outline: none; border-color: #3D7A99;
      box-shadow: 0 0 0 3px rgba(61,122,153,.18);
    }
    .line { height: 1px; background: #eee; margin: 22px 0; }
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
    .hint {
      margin: 14px 0 0; font-size: 12.5px; color: #888;
      text-align: center; line-height: 1.45;
    }
    .foot {
      margin-top: 28px; font-size: 12px; color: #aaa; text-align: center;
    }
  </style>
</head>
<body class="pay-brand-nesher">
  <div class="sheet">
    <p class="logo"><img src="${logo}" alt="Nesher Travel" height="40" data-fallback="${logoFallback}" onerror="this.onerror=null;this.src=this.getAttribute('data-fallback')"></p>
    <div id="amount-wrap">
      <p class="label">Amount</p>
      <div class="amount-row">
        <span class="amount-prefix">$</span>
        <input id="amount-usd" type="number" inputmode="decimal" min="1" max="25000" step="0.01" autocomplete="off" />
      </div>
    </div>
    <div class="line"></div>
    ${card}
    <p class="foot">Nesher Travel</p>
  </div>
</body>
</html>`;
}
