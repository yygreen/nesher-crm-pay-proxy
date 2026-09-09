import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { stripStripeUi } from "../strip-stripe.js";
import { injectPayButtons } from "../inject.js";

const FORBIDDEN = [
  "Secure Stripe Card Payment",
  "Use Secure Stripe Card Form",
  "sent directly to Stripe",
  "Until the secure form is opened",
  "js.stripe.com",
];

const PANEL = `<div
    class="stripe-secure-payment-panel"
    data-stripe-secure-panel="reservation-99"
    hidden
>
    <div class="stripe-secure-payment-heading">
        <div>
            <strong>Secure Stripe Card Payment</strong>
            <div class="stripe-secure-payment-help">
                Card number, expiration date, and security code are sent
                directly to Stripe and are never stored in the CRM.
            </div>
        </div>
        <span class="stripe-secure-payment-badge">Secure</span>
    </div>
    <div class="stripe-secure-payment-controls">
        <button type="button" class="stripe-secure-payment-prepare" data-stripe-prepare>
            Use Secure Stripe Card Form
        </button>
    </div>
    <div class="stripe-secure-payment-manual-note">
        Until the secure form is opened, the normal Save Payment button
        continues to record the card payment manually without charging it.
    </div>
</div>
<style>
.stripe-secure-payment-panel { background: #eff6ff; }
.stripe-secure-payment-heading { color: #0f172a; }
.stripe-secure-payment-prepare { background: #2563eb; }
.stripe-secure-payment-help { color: #475569; }
</style>
<script src="https://js.stripe.com/v3/"></script>
<script>
(function () {
    const prepareButton = panel.querySelector("[data-stripe-prepare]");
    prepareButton.textContent = "Use Secure Stripe Card Form";
    stripeInstance = window.Stripe("pk_test_fixture");
})();
</script>`;

const PAGE = `<!doctype html><html><head><title>Add Payment for GKT5U4</title></head>
<body>
  <h1>Add Payment for GKT5U4</h1>
  <form method="post">
    <label>Amount</label>
    <input id="id_amount" name="amount" value="120.00">
    <label>Method</label>
    <select id="id_method" name="method"><option value="card" selected>Card</option></select>
    ${PANEL}
    <button type="submit">Save Payment</button>
  </form>
</body></html>`;

function assertGone(html) {
  for (const s of FORBIDDEN) {
    assert.equal(html.includes(s), false, `still contains: ${s}`);
  }
  assert.doesNotMatch(html, /class=["'][^"']*stripe-secure-payment-panel/);
  assert.doesNotMatch(html, /data-stripe-secure-panel/);
  assert.doesNotMatch(html, /data-stripe-prepare/);
}

describe("stripStripeUi", () => {
  it("removes the Django Stripe panel, styles, and scripts from a payment_create page", () => {
    const out = stripStripeUi(PAGE);
    assertGone(out);
    assert.match(out, /Add Payment for GKT5U4/);
    assert.match(out, />Save Payment</);
    assert.match(out, /id="id_amount"/);
    assert.match(out, /id="id_method"/);
  });

  it("is idempotent and leaves non-string input alone", () => {
    const once = stripStripeUi(PAGE);
    assert.equal(stripStripeUi(once), once);
    assert.equal(stripStripeUi(""), "");
    assert.equal(stripStripeUi(null), null);
  });

  it("does not strip the Mercury inject CSS hide-rule or guest Collect.js pay HTML", () => {
    const staff = `<html><head>
<style id="nesher-mercury-pay-css">
  .nesher-mercury-btn { color: #fff; }
  .stripe-secure-payment-panel { display: none !important; }
</style>
</head><body><h1>Res</h1><script id="nesher-mercury-pay-js"></script></body></html>`;
    const after = stripStripeUi(staff);
    assert.match(after, /id="nesher-mercury-pay-css"/);
    assert.match(after, /nesher-mercury-pay-js/);
    assert.match(after, /stripe-secure-payment-panel \{ display: none/);
    const guest = `<!doctype html><html><head><title>RES-555TRAIN · $55.55</title></head>
<body>
<img alt="Nesher Travel" height="40">
<div class="card-row"></div>
<script src="https://secure.nmi.com/token/Collect.js"></script>
</body></html>`;
    assert.equal(stripStripeUi(guest), guest);
  });

  it("proxyWithInject staff path calls stripStripeUi before other injectors", () => {
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /from "\.\/strip-stripe\.js"/);
    const injectAt = src.indexOf("injected = stripStripeUi(injected)");
    const payAt = src.indexOf("injected = injectPayButtons(injected");
    assert.ok(injectAt > 0 && payAt > injectAt);
  });

  it("proxyWithInject strips Stripe on POST/PUT staff HTML, not only GET", () => {
    const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
    assert.match(src, /isMutatingHtml = method === "POST" \|\| method === "PUT"/);
    assert.doesNotMatch(src, /!shouldInject \|\| req\.method !== "GET"/);
    assert.match(src, /!isGet && isPublicMarketingPath\(pathOnly\)/);
    assert.match(src, /\\\/reservations\\\/\\d\+\\\/payments\\\/add/);
    const waCount = src.split("injectWhatsAppUi(").length - 1;
    assert.equal(waCount, 1);
    const isGetAt = src.indexOf("if (isGet)");
    const waAt = src.indexOf("injectWhatsAppUi(");
    assert.ok(isGetAt > 0 && waAt > isGetAt);
    assert.match(src, /build: "2026-09-09-open-avs"/);
  });

  it("POST save-error HTML is stripped and still gets the send-pay-link", () => {
    const stripped = stripStripeUi(PAGE);
    assertGone(stripped);
    const out = injectPayButtons(stripped, "/reservations/99/payments/add/");
    assertGone(out);
    assert.match(out, /Card or bank link/);
    assert.doesNotMatch(out, /Mercury Pay/);
    assert.doesNotMatch(out, /Send card\/bank pay link/);
    assert.match(out, /id="id_amount"/);
    assert.match(out, />Save Payment</);
    assert.match(out, /Add Payment for GKT5U4/);
  });

  it("is on the Dockerfile COPY line", () => {
    const docker = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    assert.match(docker, /\bstrip-stripe\.js\b/);
  });
});
