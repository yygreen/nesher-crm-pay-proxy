/**
 * Nesher open-amount card pages.
 * External (the link they send): https://www.flynesher.com/pay/open
 *   Customer name, then Card (amount, AVS, Collect.js). POST /pay/open/charge
 *   ignores staffName / processor / notes even if posted.
 * Internal (office fills): https://www.flynesher.com/pay/office
 *   Office (Taken by roster select, Customer name, More info) then Card.
 *   POST /pay/office/charge accepts staffName only when it is exactly
 *   one of OPEN_PAY_STAFF; otherwise omit field_5 (still charge).
 * Empty omitted. Address is AVS, never a descriptor. Never Guest.
 * Decline copy is guestCardMessage, never raw JSON.
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
  recordName,
  guestCardMessage,
  GUEST_DECLINE_DEFAULT,
  GUEST_OURS,
  GUEST_MISSING_AMOUNT,
  GUEST_MISSING_CARD,
} from "./nmi-card.js";

export const OPEN_PAY_PATH = "/pay/open";
export const OFFICE_PAY_PATH = "/pay/office";
export const OPEN_PAY_MIN_USD = 1;
export const OPEN_PAY_MAX_USD = 25000;
export const NESHER_LOGO_URL = "https://assets.flynesher.com/nesher-logo.jpg";
const NESHER_LOGO_FALLBACK =
  "https://www.flynesher.com/static/core/images/nesher_logo.png";

/** Hardcoded desk roster. Exact strings only. No CRM fetch. */
export const OPEN_PAY_STAFF = [
  "Hershy",
  "Sruly",
  "Richter",
  "Goldie",
  "Joseph",
  "John",
  "Aby",
  "Anne",
  "Purity",
  "Lennart",
  "Kimberly",
];

export function rosterStaffName(value) {
  const n = recordName(value);
  if (!n) return "";
  return OPEN_PAY_STAFF.includes(n) ? n : "";
}

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

export function isOfficePayPath(pathname) {
  const p = normPath(pathname);
  return (
    p === "/pay/office" ||
    p === "/pay/office/charge" ||
    p === "/__nesher_pay/office" ||
    p === "/__nesher_pay/office/charge"
  );
}

export function isOfficePayChargePath(pathname) {
  const p = normPath(pathname);
  return p === "/pay/office/charge" || p === "/__nesher_pay/office/charge";
}

/**
 * Guest open-amount is Nesher-origin only.
 * Allowlist: flynesher.com and www.flynesher.com.
 * crm.flynesher.com is the live JRM /pay/:code rewrite destination
 * (Host becomes crm; the browser URL stays jrmhotels.com) — never serve
 * Collect.js / FLYNESHER.COM there. Empty or unknown Host is 404.
 */
const OPEN_PAY_ALLOWED_HOSTS = new Set(["flynesher.com", "www.flynesher.com"]);

export function normalizeOpenPayHost(value) {
  let h = String(value || "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (!h) return "";
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    if (end > 0) h = h.slice(1, end);
  } else {
    h = h.split(":")[0];
  }
  return h;
}

export function openPayHostAllowed(host) {
  const h = normalizeOpenPayHost(host);
  return Boolean(h) && OPEN_PAY_ALLOWED_HOSTS.has(h);
}

function forwardedHosts(raw) {
  const out = [];
  for (const element of String(raw || "").split(",")) {
    const m = /(?:^|;)\s*host\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(element);
    if (!m) continue;
    const v = String(m[1] || m[2] || "").trim();
    if (v) out.push(v);
  }
  return out;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const want = String(name).toLowerCase();
  if (headers[want] != null) return String(headers[want]);
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === want) return v == null ? "" : String(v);
  }
  return "";
}

/** Host, X-Forwarded-Host, and Forwarded must each be Nesher or absent. */
export function openPayRequestAllowed(headers = {}) {
  if (!openPayHostAllowed(headerValue(headers, "host"))) return false;
  const xfh = headerValue(headers, "x-forwarded-host").trim();
  if (xfh) {
    for (const part of xfh.split(",")) {
      if (!openPayHostAllowed(part)) return false;
    }
  }
  const fwd = headerValue(headers, "forwarded").trim();
  if (fwd) {
    for (const h of forwardedHosts(fwd)) {
      if (!openPayHostAllowed(h)) return false;
    }
  }
  return true;
}

export function decideOpenPayPage(headers, data = {}) {
  if (!openPayRequestAllowed(headers)) {
    return {
      status: 404,
      html: renderOpenPayErrorHtml("This payment page is not available here."),
    };
  }
  return {
    status: 200,
    html: renderOpenPayHtml(data),
  };
}

export function decideOfficePayPage(headers, data = {}) {
  if (!openPayRequestAllowed(headers)) {
    return {
      status: 404,
      html: renderOpenPayErrorHtml("This payment page is not available here."),
    };
  }
  return {
    status: 200,
    html: renderOfficePayHtml(data),
  };
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
  if (
    error === "declined" ||
    error === "processor_error" ||
    String(error || "").startsWith("nmi_sale_")
  ) {
    return 200;
  }
  return 200;
}

/**
 * Open-amount capture. Amount comes from the guest POST (validated here).
 * CRM /pay/:code/charge must keep ignoring body.amount — this is the only
 * route that reads amountUsd from the client. Guest path ignores staff /
 * notes even if posted. Office path (opts.office) records Taken by only
 * when it matches OPEN_PAY_STAFF exactly (field_5) and notes (field_6).
 * Customer name is field_4 on both. Billing address is optional AVS —
 * never a charge gate, never payment_descriptor, never invented as "Guest".
 */
export async function chargeOpenPay(opts = {}) {
  const kind = String(opts.kind || "open").toLowerCase();
  const brandId = String(opts.brandId || "").toLowerCase();
  if (brandId === "jrm" || kind === "hotel" || kind === "hotel-offer") {
    const message = guestCardMessage({ error: "keys_missing" });
    return { ok: false, error: "jrm_not_supported", message, httpStatus: 403 };
  }
  const parsed = parseOpenAmountUsd(opts.amountUsd);
  if (!parsed.ok) {
    const message = guestCardMessage({ error: parsed.error });
    return {
      ok: false,
      error: parsed.error,
      message,
      httpStatus: 400,
    };
  }
  const token = String(opts.paymentToken || "").trim();
  if (looksLikePan(token)) {
    const message = guestCardMessage({ error: "raw_card_rejected" });
    return {
      ok: false,
      error: "raw_card_rejected",
      message,
      httpStatus: 400,
    };
  }
  if (!token) {
    const message = guestCardMessage({ error: "payment_token required" });
    return {
      ok: false,
      error: "payment_token required",
      message,
      httpStatus: 400,
    };
  }
  const invoiceNumber = String(
    opts.invoiceNumber || mintOpenInvoiceNumber()
  ).trim();
  if (!/^OPEN-/i.test(invoiceNumber)) {
    const message = guestCardMessage({ error: "open_ref_required" });
    return {
      ok: false,
      error: "open_ref_required",
      message,
      httpStatus: 400,
    };
  }
  const office = opts.office === true;
  const customerName = recordName(opts.customerName);
  const staffName = office ? rosterStaffName(opts.staffName) : "";
  const notes = office ? recordName(opts.notes || opts.moreInfo, 255) : "";
  const address1 = recordName(opts.address1 || opts.address, 255);
  const city = recordName(opts.city, 80);
  const state = recordName(opts.state, 40);
  const zip = recordName(opts.zip || opts.postalCode || opts.postal_code, 20);
  const country = recordName(opts.country, 40);
  const email = recordName(opts.email, 120);
  const sale = await chargeWithToken({
    amountUsd: parsed.amountUsd,
    invoiceNumber,
    kind: "open",
    ...(customerName ? { customerName } : {}),
    ...(staffName ? { staffName } : {}),
    ...(notes ? { notes } : {}),
    ...(address1 ? { address1 } : {}),
    ...(city ? { city } : {}),
    ...(state ? { state } : {}),
    ...(zip ? { zip } : {}),
    ...(country ? { country } : {}),
    ...(email ? { email } : {}),
    summary: opts.summary || "Open amount",
    paymentToken: token,
    fetchImpl: opts.fetchImpl,
    privateKey: opts.privateKey,
  });
  if (!sale.ok) {
    const err = sale.error || "declined";
    const message = sale.message || guestCardMessage(sale);
    return {
      ok: false,
      error: err,
      message,
      blockedReason: message || sale.blockedReason,
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

export function chargeOfficePay(opts = {}) {
  return chargeOpenPay({ ...opts, office: true });
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

function renderCollectJsForm(collectKey, opts = {}) {
  const src = esc(collectScriptUrl());
  const key = esc(collectKey);
  const office = opts.office === true;
  const chargePath = office ? "/pay/office/charge" : "/pay/open/charge";
  const officeFields = office
    ? `              var staffName=readName("staff-name");
              var notes=readName("more-info",255);
              if(staffName) payload.staffName=staffName;
              if(notes) payload.notes=notes;
`
    : "";
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
        function readAmt(){
          var el=document.getElementById("amount-usd");
          if(!el) return null;
          var v=String(el.value||"").trim();
          if(!/^\\d+(\\.\\d{1,2})?$/.test(v)) return null;
          var n=Number(v);
          if(!isFinite(n)||n<1||n>25000) return null;
          return n;
        }
        function readName(id,max){
          var el=document.getElementById(id);
          if(!el) return "";
          var n=max||80;
          return String(el.value||"").replace(/[\\r\\n\\t]+/g," ").trim().slice(0,n);
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
              if(!token){showErr(${JSON.stringify(GUEST_MISSING_CARD)});return;}
              if(amt==null){showErr(${JSON.stringify(GUEST_MISSING_AMOUNT)});return;}
              var payload={payment_token:token,amountUsd:amt};
              var customerName=readName("customer-name");
              var address1=readName("billing-address",255);
              var city=readName("billing-city");
              var state=readName("billing-state",40);
              var zip=readName("billing-zip",20);
              var country=readName("billing-country",40);
              var email=readName("billing-email",120);
              if(customerName) payload.customerName=customerName;
${officeFields}              if(address1) payload.address1=address1;
              if(city) payload.city=city;
              if(state) payload.state=state;
              if(zip) payload.zip=zip;
              if(country) payload.country=country;
              if(email) payload.email=email;
              if(btn) btn.disabled=true;
              fetch(${JSON.stringify(chargePath)},{
                method:"POST",
                headers:{"Content-Type":"application/json"},
                body:JSON.stringify(payload)
              }).then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
              .then(function(x){
                if(x.j&&x.j.ok){
                  var form=document.getElementById("card-form");
                  var wrap=document.getElementById("amount-wrap");
                  var office=document.getElementById("office-group");
                  var avs=document.querySelector(".avs-block");
                  if(office) office.hidden=true;
                  if(wrap) wrap.hidden=true;
                  if(avs) avs.hidden=true;
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

function staffSelectHtml() {
  const opts = ['<option value=""></option>'].concat(
    OPEN_PAY_STAFF.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)
  );
  return `<select id="staff-name" autocomplete="off">${opts.join("")}</select>`;
}

function renderPaySheet(data = {}, opts = {}) {
  const office = opts.office === true;
  const collectKey = String(data.collectPublicKey || "").trim();
  const collectOn = Boolean(collectKey);
  const card = collectOn
    ? renderCollectJsForm(collectKey, { office })
    : `<p class="hint">Card pay is not available right now.</p>`;
  const logo = esc(NESHER_LOGO_URL);
  const logoFallback = esc(NESHER_LOGO_FALLBACK);
  const top = office
    ? `<div class="group" id="office-group">
      <h2 class="group-title">Office</h2>
      <div class="meta-field">
        <p class="label">Taken by</p>
        ${staffSelectHtml()}
      </div>
      <div class="meta-field">
        <p class="label">Customer name</p>
        <input id="customer-name" type="text" maxlength="80" autocomplete="name" />
      </div>
      <div class="meta-field">
        <p class="label">More info</p>
        <textarea id="more-info" maxlength="255" rows="2"></textarea>
      </div>
    </div>`
    : `<div class="meta-field" id="guest-name">
      <p class="label">Customer name</p>
      <input id="customer-name" type="text" maxlength="80" autocomplete="name" />
    </div>`;

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
    .group {
      border: 1px solid #E6E9EE;
      border-radius: 12px;
      padding: 14px 14px 16px;
      margin: 0 0 14px;
    }
    .group-card { margin-bottom: 0; }
    .group-title {
      font-size: 12px; font-weight: 700; letter-spacing: .06em;
      text-transform: uppercase; color: #6B7280; margin: 0 0 12px;
    }
    .meta-field { margin: 12px 0 0; }
    .meta-field:first-of-type { margin-top: 0; }
    #guest-name { margin: 0 0 14px; }
    .meta-field input, .meta-field select {
      width: 100%; font-size: 15px; font-family: inherit; color: #111;
      border: 1px solid #D8DEE4; border-radius: 10px; padding: 10px 12px;
      background: #fff;
    }
    .meta-field input:focus, .meta-field textarea:focus, .meta-field select:focus {
      outline: none; border-color: #3D7A99;
      box-shadow: 0 0 0 3px rgba(61,122,153,.18);
    }
    .meta-field textarea {
      width: 100%; min-height: 64px; resize: vertical;
      font-size: 15px; font-family: inherit; color: #111;
      border: 1px solid #D8DEE4; border-radius: 10px; padding: 10px 12px;
      background: #fff;
    }
    .meta-row {
      display: grid; grid-template-columns: 1fr 1fr; gap: 10px;
    }
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
    .avs-hint {
      margin: 0 0 10px; font-size: 12.5px; color: #6B7280; line-height: 1.4;
    }
    .avs-block { margin: 12px 0 4px; }
    .foot {
      margin-top: 28px; font-size: 12px; color: #aaa; text-align: center;
    }
  </style>
</head>
<body class="pay-brand-nesher">
  <div class="sheet">
    <p class="logo"><img src="${logo}" alt="Nesher Travel" height="40" data-fallback="${logoFallback}" onerror="this.onerror=null;this.src=this.getAttribute('data-fallback')"></p>
    ${top}
    <div class="group group-card" id="card-group">
      <h2 class="group-title">Card</h2>
      <div id="amount-wrap">
        <p class="label">Amount</p>
        <div class="amount-row">
          <span class="amount-prefix">$</span>
          <input id="amount-usd" type="number" inputmode="decimal" min="1" max="25000" step="0.01" autocomplete="off" />
        </div>
      </div>
      <div class="avs-block">
        <p class="avs-hint">Used to match the card.</p>
        <div class="meta-field">
          <p class="label">Address</p>
          <input id="billing-address" type="text" maxlength="255" autocomplete="street-address" />
        </div>
        <div class="meta-field meta-row">
          <div>
            <p class="label">City</p>
            <input id="billing-city" type="text" maxlength="80" autocomplete="address-level2" />
          </div>
          <div>
            <p class="label">State</p>
            <input id="billing-state" type="text" maxlength="40" autocomplete="address-level1" />
          </div>
        </div>
        <div class="meta-field meta-row">
          <div>
            <p class="label">ZIP</p>
            <input id="billing-zip" type="text" maxlength="20" autocomplete="postal-code" />
          </div>
          <div>
            <p class="label">Country</p>
            <input id="billing-country" type="text" maxlength="40" placeholder="US" autocomplete="country" />
          </div>
        </div>
        <div class="meta-field">
          <p class="label">Email</p>
          <input id="billing-email" type="email" maxlength="120" autocomplete="email" />
        </div>
      </div>
      ${card}
    </div>
    <p class="foot">Nesher Travel</p>
  </div>
</body>
</html>`;
}

export function renderOpenPayHtml(data = {}) {
  return renderPaySheet(data, { office: false });
}

export function renderOfficePayHtml(data = {}) {
  return renderPaySheet(data, { office: true });
}
