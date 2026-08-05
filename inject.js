/**
 * HTML injection helpers for CRM list/detail pages.
 * Flexible invoice modal: pack every detail, list what's missing, let staff fill it in.
 */

export const BUTTON_MARKER = "data-nesher-mercury-pay";

const CSS = `
<style id="nesher-mercury-pay-css">
  /* ── Row chrome: buttons injected next to CRM links ── */
  .nesher-mercury-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    background: #0f766e;
    color: #fff !important;
    border: none;
    border-radius: 7px;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none !important;
    margin: 2px 4px;
    line-height: 1.2;
    box-shadow: inset 0 -1px 0 rgba(0,0,0,.15);
    transition: background .12s ease;
  }
  .nesher-mercury-btn::before {
    content: "";
    width: 6px; height: 6px; border-radius: 50%;
    background: #5eead4; flex: 0 0 auto;
  }
  .nesher-mercury-btn:hover { background: #0c5f58; color: #fff !important; }
  .nesher-mercury-btn[disabled] { opacity: 0.6; cursor: wait; }
  .nesher-mercury-link {
    display: inline-flex;
    align-items: center;
    margin-left: 6px;
    padding: 3px 9px;
    border: 1px solid #99f6e4;
    border-radius: 999px;
    background: #f0fdfa;
    font-size: 12px;
    font-weight: 600;
    color: #0f766e !important;
    text-decoration: none !important;
    word-break: break-all;
  }
  .nesher-mercury-link:hover { background: #ccfbf1; }
  .nesher-mercury-wrap {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    max-width: 100%;
  }
  .nesher-mercury-err { color: #b91c1c; font-size: 12px; margin-left: 6px; }
  .nesher-paid-badge {
    display: inline-flex; align-items: center; gap: 5px;
    background: #dcfce7; border: 1px solid #86efac; color: #15803d;
    font: 600 12px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 2px 10px; border-radius: 999px; margin: 2px 6px;
    white-space: nowrap; vertical-align: middle;
  }
  .nesher-paid-badge::before {
    content: ""; width: 6px; height: 6px; border-radius: 50%; background: #22c55e;
  }
  .nesher-paid-badge.part { background: #fef9c3; border-color: #fde047; color: #a16207; }
  .nesher-paid-badge.part::before { background: #eab308; }
  .nesher-mercury-quote {
    display: block;
    width: 100%;
    margin-top: 4px;
    font-size: 12px;
    color: #475569;
    font-weight: 500;
  }

  /* ── Modal shell ── */
  #nesher-pay-modal-root {
    position: fixed; inset: 0; z-index: 99999;
    display: none; align-items: flex-start; justify-content: center;
    padding: 4vh 16px; overflow-y: auto;
    background: rgba(15, 23, 42, 0.55);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #0f172a;
    -webkit-font-smoothing: antialiased;
  }
  #nesher-pay-modal-root.open { display: flex; }
  .nesher-pay-panel {
    background: #fff; border-radius: 14px; width: 100%; max-width: 640px;
    box-shadow: 0 24px 60px rgba(15, 23, 42, .3);
    border-top: 3px solid #0f766e;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .nesher-pay-head { padding: 15px 20px 12px; border-bottom: 1px solid #e2e8f0; }
  .nesher-pay-head-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
  }
  .nesher-pay-head h2 {
    margin: 0; font-size: 16px; font-weight: 700;
    letter-spacing: -0.01em; color: #0f172a;
  }
  .nesher-pay-close {
    background: transparent; border: 0; color: #64748b; font-size: 22px;
    cursor: pointer; line-height: 1; padding: 2px 7px; border-radius: 6px;
  }
  .nesher-pay-close:hover { background: #f1f5f9; color: #0f172a; }
  .nesher-pay-sub {
    display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    margin-top: 6px; font-size: 13px; color: #475569; min-height: 20px;
  }
  .nesher-pay-sub b { color: #0f172a; font-weight: 600; overflow-wrap: anywhere; }
  .nesher-pay-sub .sep { color: #cbd5e1; }
  .nesher-chip {
    display: inline-flex; align-items: center; padding: 2px 8px;
    border-radius: 999px; font-size: 10.5px; font-weight: 700;
    letter-spacing: .03em; text-transform: uppercase; line-height: 1.5;
  }
  .nesher-chip.ok { background: #f0fdfa; color: #0f766e; border: 1px solid #99f6e4; }
  .nesher-chip.warn { background: #fffbeb; color: #92400e; border: 1px solid #fde68a; }
  .nesher-chip.mut { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; }

  .nesher-pay-body { padding: 16px 20px 4px; overflow-y: auto; max-height: 72vh; }

  /* ── Single guidance banner ── */
  .nesher-banner {
    display: flex; gap: 10px; align-items: flex-start;
    border-radius: 10px; padding: 10px 12px; margin-bottom: 14px;
    font-size: 13px; line-height: 1.45;
  }
  .nesher-banner.warn { background: #fffbeb; border: 1px solid #fde68a; color: #92400e; }
  .nesher-banner.info { background: #f0fdfa; border: 1px solid #99f6e4; color: #115e59; }
  .nesher-banner .ic { flex: 0 0 auto; margin-top: 1px; }
  .nesher-banner div div + div { margin-top: 3px; }

  /* ── Hero amount ── */
  .nesher-hero { margin-bottom: 16px; }
  .nesher-sec-label {
    display: block; font-size: 11px; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; color: #64748b; margin-bottom: 6px;
  }
  .nesher-sec-label .req { color: #d97706; }
  .nesher-amt {
    display: flex; align-items: center; gap: 5px;
    border: 1px solid #cbd5e1; border-radius: 10px; padding: 10px 14px;
    background: #fff;
    transition: border-color .12s ease, box-shadow .12s ease;
  }
  .nesher-amt:focus-within { border-color: #0f766e; box-shadow: 0 0 0 3px #ccfbf1; }
  .nesher-amt .cur { font-size: 22px; font-weight: 600; color: #94a3b8; }
  .nesher-amt input {
    border: 0; outline: 0; flex: 1; min-width: 0; padding: 0;
    font-size: 26px; font-weight: 650; color: #0f172a;
    font-variant-numeric: tabular-nums; background: transparent;
    font-family: inherit;
  }
  .nesher-amt input::placeholder { color: #cbd5e1; font-weight: 500; }
  .nesher-amt input::-webkit-outer-spin-button,
  .nesher-amt input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .nesher-amt input[type="number"] { -moz-appearance: textfield; appearance: textfield; }
  .nesher-hero.miss .nesher-amt { border-color: #f59e0b; background: #fffdf5; }
  .nesher-hero.miss .nesher-amt:focus-within { border-color: #d97706; box-shadow: 0 0 0 3px #fef3c7; }
  .nesher-hint { font-size: 12px; color: #64748b; margin-top: 5px; line-height: 1.4; }
  .nesher-hint.warn { color: #92400e; font-weight: 500; }

  /* ── Sections / fields ── */
  .nesher-sec { margin-bottom: 16px; }
  .nesher-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 12px; }
  .nesher-field label {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 4px;
  }
  .nesher-field input, .nesher-field textarea {
    width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1;
    border-radius: 8px; padding: 8px 10px; font-size: 14px; color: #0f172a;
    background: #fff; font-family: inherit;
    transition: border-color .12s ease, box-shadow .12s ease;
  }
  .nesher-field input:focus, .nesher-field textarea:focus {
    outline: none; border-color: #0f766e; box-shadow: 0 0 0 3px #ccfbf1;
  }
  .nesher-field.miss input { border-color: #f59e0b; background: #fffdf5; }

  /* ── Invoice preview card ── */
  .nesher-card {
    border: 1px solid #e2e8f0; border-radius: 12px; background: #fff;
    margin-bottom: 16px; overflow: hidden;
  }
  .nesher-inv-head {
    display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
    padding: 10px 14px; background: #f8fafc; border-bottom: 1px solid #e2e8f0;
  }
  .nesher-inv-head .nesher-sec-label { margin: 0; }
  .nesher-inv-num {
    font-size: 12px; color: #475569; font-weight: 600;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow-wrap: anywhere; text-align: right;
  }
  .nesher-inv-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .nesher-inv-table td {
    padding: 8px 14px; border-bottom: 1px solid #f1f5f9;
    color: #0f172a; vertical-align: top;
  }
  .nesher-inv-table td.num {
    text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums;
  }
  .nesher-inv-table .qty { color: #64748b; font-size: 12px; }
  .nesher-inv-table tfoot td {
    border-bottom: 0; font-weight: 700; background: #f0fdfa; color: #115e59;
  }
  .nesher-inv-empty { padding: 12px 14px; font-size: 12.5px; color: #94a3b8; font-style: italic; }
  .nesher-inv-sec { padding: 10px 14px; border-top: 1px solid #f1f5f9; }
  .nesher-inv-sec:first-of-type { border-top: 0; }
  .nesher-inv-sec .nesher-sec-label { margin-bottom: 5px; }
  .nesher-inv-row {
    display: flex; justify-content: space-between; gap: 12px;
    font-size: 13px; padding: 2px 0; color: #475569;
  }
  .nesher-inv-row b { color: #0f172a; font-weight: 600; text-align: right; overflow-wrap: anywhere; }
  .nesher-inv-row .conf {
    font-style: normal; font-size: 11px; color: #64748b;
    background: #f1f5f9; border-radius: 4px; padding: 1px 5px;
    margin-left: 4px; white-space: nowrap;
  }
  .nesher-inv-text { font-size: 13px; color: #0f172a; line-height: 1.5; }
  .nesher-flight {
    display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline;
    font-size: 13px; padding: 3px 0; color: #475569;
  }
  .nesher-flight b { color: #0f172a; font-weight: 600; }
  .nesher-flight .mut { color: #94a3b8; font-size: 12px; }
  .nesher-inv-pay {
    display: flex; gap: 14px; flex-wrap: wrap;
    font-size: 12.5px; color: #64748b; background: #f8fafc;
  }
  .nesher-inv-pay .due { color: #115e59; font-weight: 700; }
  .nesher-memo { border-top: 1px solid #f1f5f9; }
  .nesher-memo summary {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 14px; font-size: 12px; font-weight: 600; color: #64748b;
    cursor: pointer; user-select: none; list-style: none;
  }
  .nesher-memo summary::-webkit-details-marker { display: none; }
  .nesher-memo summary::before {
    content: ""; width: 5px; height: 5px; flex: 0 0 auto;
    border-right: 2px solid #94a3b8; border-bottom: 2px solid #94a3b8;
    transform: rotate(-45deg); transition: transform .12s ease;
  }
  .nesher-memo[open] summary::before { transform: rotate(45deg); }
  .nesher-memo pre {
    margin: 0; padding: 0 14px 12px; white-space: pre-wrap; word-break: break-word;
    font-size: 12px; line-height: 1.5; color: #334155;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    max-height: 220px; overflow-y: auto;
  }

  /* ── Advanced (collapsed) ── */
  .nesher-adv { border: 1px solid #e2e8f0; border-radius: 12px; margin-bottom: 16px; }
  .nesher-adv > summary {
    display: flex; align-items: center; gap: 8px;
    padding: 11px 14px; cursor: pointer; user-select: none; list-style: none;
    font-size: 12.5px; font-weight: 700; color: #334155;
  }
  .nesher-adv > summary::-webkit-details-marker { display: none; }
  .nesher-adv > summary::before {
    content: ""; width: 5px; height: 5px; flex: 0 0 auto;
    border-right: 2px solid #94a3b8; border-bottom: 2px solid #94a3b8;
    transform: rotate(-45deg); transition: transform .12s ease;
  }
  .nesher-adv[open] > summary::before { transform: rotate(45deg); }
  .nesher-adv > summary .mut {
    color: #94a3b8; font-weight: 500; font-size: 12px; text-transform: none;
  }
  .nesher-adv[open] > summary { border-bottom: 1px solid #f1f5f9; }
  .nesher-adv-body { padding: 12px 14px 14px; display: grid; gap: 12px; }
  .nesher-tips { font-size: 12px; color: #94a3b8; margin: -6px 0 14px; line-height: 1.5; }

  /* ── Status + footer ── */
  .nesher-pay-status {
    margin: 0 20px 10px; padding: 8px 12px; border-radius: 8px;
    font-size: 13px; line-height: 1.4;
    background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c;
  }
  .nesher-pay-status.ok { background: #f0fdfa; border-color: #99f6e4; color: #0f766e; }
  .nesher-pay-foot {
    display: flex; gap: 10px; justify-content: flex-end; align-items: center;
    padding: 12px 20px; border-top: 1px solid #e2e8f0; background: #fff;
  }
  .nesher-pay-foot button {
    border-radius: 8px; padding: 9px 16px; font-size: 13.5px; font-weight: 600;
    cursor: pointer; border: 1px solid #cbd5e1; background: #fff; color: #334155;
    font-family: inherit;
  }
  .nesher-pay-foot button:hover { background: #f8fafc; }
  .nesher-pay-foot .primary {
    background: #0f766e; color: #fff; border-color: #0f766e; min-width: 170px;
  }
  .nesher-pay-foot .primary:hover { background: #0c5f58; }
  .nesher-pay-foot .primary:disabled { opacity: .6; cursor: wait; }
  .nesher-pay-panel.success .nesher-pay-cancel { display: none; }

  /* ── Loading skeleton ── */
  .nesher-skel {
    height: 16px; border-radius: 6px; margin-bottom: 12px;
    background: linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%);
    background-size: 200% 100%;
    animation: nesherShimmer 1.2s infinite linear;
  }
  .nesher-skel.lg { height: 52px; }
  .nesher-skel.md { height: 34px; width: 60%; }
  @keyframes nesherShimmer {
    from { background-position: 200% 0; }
    to { background-position: -200% 0; }
  }

  /* ── Success panel ── */
  .nesher-success { text-align: center; padding: 18px 6px 12px; }
  .nesher-success-check {
    width: 52px; height: 52px; margin: 0 auto 12px; border-radius: 50%;
    background: #f0fdfa; border: 1px solid #99f6e4; color: #0f766e;
    display: flex; align-items: center; justify-content: center;
  }
  .nesher-success-amt {
    font-size: 30px; font-weight: 700; letter-spacing: -.02em;
    font-variant-numeric: tabular-nums; color: #0f172a;
  }
  .nesher-success-meta { font-size: 13px; color: #64748b; margin-top: 4px; overflow-wrap: anywhere; }
  .nesher-pill {
    display: inline-flex; margin-top: 10px; padding: 3px 10px;
    border-radius: 999px; background: #fffbeb; border: 1px solid #fde68a;
    color: #92400e; font-size: 12px; font-weight: 600;
  }
  .nesher-url-box { display: flex; gap: 8px; margin: 16px 0 10px; }
  .nesher-url-box input {
    flex: 1; min-width: 0; border: 1px solid #cbd5e1; border-radius: 8px;
    padding: 9px 12px; font-size: 13px; color: #115e59; background: #f8fafc;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .nesher-url-box input:focus { outline: none; border-color: #0f766e; box-shadow: 0 0 0 3px #ccfbf1; }
  .nesher-btn-sec {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    border: 1px solid #cbd5e1; border-radius: 8px; background: #fff;
    color: #334155 !important; padding: 8px 14px; font-size: 13px; font-weight: 600;
    cursor: pointer; text-decoration: none !important; font-family: inherit;
  }
  .nesher-btn-sec:hover { background: #f8fafc; }
  .nesher-success-actions { display: flex; justify-content: center; gap: 10px; }

  /* ── Mobile: full-height sheet, sticky actions ── */
  @media (max-width: 640px) {
    #nesher-pay-modal-root { padding: 0; align-items: stretch; }
    .nesher-pay-panel { max-width: none; border-radius: 0; min-height: 100dvh; }
    .nesher-pay-body { max-height: none; flex: 1; }
    .nesher-pay-foot {
      position: sticky; bottom: 0;
      padding-bottom: calc(12px + env(safe-area-inset-bottom));
      box-shadow: 0 -4px 12px rgba(15, 23, 42, .06);
    }
    .nesher-pay-foot .primary { flex: 1; }
    .nesher-grid2 { grid-template-columns: 1fr; }
  }
</style>
`;

const SCRIPT = `
<script id="nesher-mercury-pay-js">
(function () {
  if (window.__nesherMercuryPayBound) return;
  window.__nesherMercuryPayBound = true;

  function csrf() {
    var m = document.cookie.match(/(?:^|;\\s*)csrftoken=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }

  function pathFor(kind, id) {
    if (kind === "hotel-offer") return "/__nesher_pay/hotel-offer/" + id + "/";
    if (kind === "hotel") return "/__nesher_pay/hotel/" + id + "/";
    if (kind === "reservation") return "/__nesher_pay/reservation/" + id + "/";
    return null;
  }

  var ICON_WARN = '<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  var ICON_INFO = '<svg class="ic" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
  var ICON_CHECK = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

  function ensureModal() {
    var root = document.getElementById("nesher-pay-modal-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "nesher-pay-modal-root";
    root.innerHTML =
      '<div class="nesher-pay-panel" role="dialog" aria-modal="true" aria-labelledby="nesher-pay-title">' +
        '<div class="nesher-pay-head">' +
          '<div class="nesher-pay-head-row">' +
            '<h2 id="nesher-pay-title">Create payment link</h2>' +
            '<button type="button" class="nesher-pay-close" aria-label="Close">&times;</button>' +
          '</div>' +
          '<div class="nesher-pay-sub" id="nesher-pay-sub"></div>' +
        '</div>' +
        '<div class="nesher-pay-body" id="nesher-pay-body"></div>' +
        '<p class="nesher-pay-status" id="nesher-pay-status" hidden></p>' +
        '<div class="nesher-pay-foot">' +
          '<button type="button" class="nesher-pay-cancel">Cancel</button>' +
          '<button type="button" class="primary" id="nesher-pay-create">Create payment link</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener("click", function (ev) {
      if (ev.target === root) closeModal();
    });
    root.querySelector(".nesher-pay-close").addEventListener("click", closeModal);
    root.querySelector(".nesher-pay-cancel").addEventListener("click", closeModal);
    root.querySelector("#nesher-pay-create").addEventListener("click", submitCreate);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && root.classList.contains("open")) closeModal();
    });
    // Keep Tab inside the dialog while it is open
    root.addEventListener("keydown", function (ev) {
      if (ev.key !== "Tab") return;
      var panel = root.querySelector(".nesher-pay-panel");
      var sel = 'a[href], button:not([disabled]), input, textarea, select, summary, [tabindex]:not([tabindex="-1"])';
      var list = Array.prototype.filter.call(panel.querySelectorAll(sel), function (el) {
        return el.offsetParent !== null;
      });
      if (!list.length) return;
      var first = list[0];
      var last = list[list.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    });
    // Enter in a text field submits
    root.querySelector("#nesher-pay-body").addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && ev.target && ev.target.tagName === "INPUT") {
        ev.preventDefault();
        submitCreate();
      }
    });
    return root;
  }

  var modalState = { kind: null, id: null, btn: null, wrap: null, data: null, success: null };

  function lockScroll(on) {
    try { document.documentElement.style.overflow = on ? "hidden" : ""; } catch (e) {}
  }

  function openRoot(root) {
    root.classList.add("open");
    lockScroll(true);
  }

  function closeModal() {
    var root = document.getElementById("nesher-pay-modal-root");
    if (root) {
      root.classList.remove("open");
      var panel = root.querySelector(".nesher-pay-panel");
      if (panel) panel.classList.remove("success");
    }
    lockScroll(false);
    modalState = { kind: null, id: null, btn: null, wrap: null, data: null, success: null };
  }

  function setStatus(msg, ok) {
    var el = document.getElementById("nesher-pay-status");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
    el.className = "nesher-pay-status" + (ok ? " ok" : "");
  }

  function setSub(html) {
    var el = document.getElementById("nesher-pay-sub");
    if (el) el.innerHTML = html;
  }

  function showQuote(wrap, data) {
    var q = data && (data.quote || data.draft);
    var el = wrap && wrap.querySelector(".nesher-mercury-quote");
    if (!q || !wrap) return;
    if (!el) {
      el = document.createElement("span");
      el.className = "nesher-mercury-quote";
      wrap.appendChild(el);
    }
    el.textContent = (q.summary) || ("$" + (data.amountUsd || "") + " · " + (data.invoiceNumber || ""));
  }

  function fetchJson(url, opts, timeoutMs) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 28000);
    var o = opts || {};
    o.signal = ctrl.signal;
    o.credentials = "same-origin";
    return fetch(url, o).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { res: res, data: data };
      });
    }).finally(function () { clearTimeout(t); });
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return "";
    return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Our own inboxes sometimes stand in for a missing customer email.
  function isOwnEmail(v) {
    return /@(jrmhotels\\.com|flynesher\\.com)\\s*$/i.test(String(v || "").trim());
  }

  function banner(kind, lines) {
    var out = '<div class="nesher-banner ' + kind + '">' +
      (kind === "warn" ? ICON_WARN : ICON_INFO) + "<div>";
    lines.forEach(function (l) { out += "<div>" + esc(l) + "</div>"; });
    out += "</div></div>";
    return out;
  }

  function invRow(label, value) {
    if (value == null || value === "") return "";
    return '<div class="nesher-inv-row"><span>' + esc(label) + "</span><b>" + esc(value) + "</b></div>";
  }

  function plural(n, word) {
    return n + " " + word + (Number(n) === 1 ? "" : "s");
  }

  // Booking reference for the summary strip
  function bookingRef(data) {
    var draft = data.draft || {};
    var d = draft.details || {};
    if (d.reservationCode) return d.reservationCode;
    if (d.requestId) return "Request #" + d.requestId + (d.offerId ? " · Offer " + d.offerId : "");
    return draft.invoiceNumber || "";
  }

  function subFor(data, statusChip) {
    var draft = data.draft || {};
    var kindLabel = data.kind === "hotel" ? "Hotel" : (data.kind === "reservation" ? "Reservation" : "");
    var amt = Number(draft.amountUsd) > 0 ? money(draft.amountUsd) : "amount TBD";
    var mid = [];
    var ref = bookingRef(data);
    if (ref) mid.push("<b>" + esc(ref) + "</b>");
    var name = String(draft.customerName || "").trim();
    if (name && name !== "Customer") mid.push("<span>" + esc(name) + "</span>");
    mid.push("<b>" + esc(amt) + "</b>");
    return (kindLabel ? '<span class="nesher-chip mut">' + esc(kindLabel) + "</span>" : "") +
      mid.join('<span class="sep">·</span>') +
      (statusChip || "");
  }

  // ── Invoice preview: structured like a real invoice, not a memo dump ──
  function invoiceCard(draft) {
    var d = draft.details || {};
    var html = '<section class="nesher-card">';
    html += '<div class="nesher-inv-head"><span class="nesher-sec-label">Invoice preview</span>' +
      '<span class="nesher-inv-num">' + esc(draft.invoiceNumber || "") + "</span></div>";

    var items = draft.lineItems || [];
    if (items.length) {
      var total = 0;
      html += '<table class="nesher-inv-table"><tbody>';
      items.forEach(function (li) {
        var qty = Number(li.quantity) || 1;
        var amt = Number(li.unitPrice) * qty;
        total += amt;
        html += "<tr><td>" + esc(li.name) +
          (qty > 1 ? ' <span class="qty">&times; ' + qty + "</span>" : "") +
          '</td><td class="num">' + money(amt) + "</td></tr>";
      });
      html += "</tbody><tfoot><tr><td>Total due</td><td class=\\"num\\">" + money(total) + "</td></tr></tfoot></table>";
    } else {
      html += '<div class="nesher-inv-empty">Line items appear once the amount is set.</div>';
    }

    // Quoted / paid / due strip (reservations with partial payment)
    if (Number(d.amountPaid) > 0) {
      html += '<div class="nesher-inv-sec nesher-inv-pay">' +
        "<span>Quoted " + money(d.customerPrice) + "</span>" +
        "<span>Paid " + money(d.amountPaid) + "</span>" +
        '<span class="due">Due ' + money(d.balance) + "</span></div>";
    }

    // Booking facts
    var facts = "";
    if (d.hotelName || d.stay || d.checkIn) {
      facts += invRow("Hotel", [d.hotelName, d.city].filter(Boolean).join(", "));
      facts += invRow("Room", d.roomType);
      facts += invRow("Stay", d.stay || [d.checkIn, d.checkOut].filter(Boolean).join(" \\u2192 "));
      var guests = [];
      if (d.adults) guests.push(plural(d.adults, "adult"));
      if (d.children) guests.push(plural(d.children, "child").replace("childs", "children"));
      if (d.rooms) guests.push(plural(d.rooms, "room"));
      if (guests.length) facts += invRow("Guests", guests.join(" · "));
      facts += invRow("VAT", d.vatStatus);
      if (d.requestId) {
        facts += invRow("CRM ref", "Request #" + d.requestId + (d.offerId ? " · Offer " + d.offerId : ""));
      }
    }
    if (d.reservationCode) {
      facts += invRow("Booking / PNR", d.reservationCode);
      if (d.reservationId) facts += invRow("CRM ref", "#" + d.reservationId);
      facts += invRow("Booked via", d.bookingMethod);
      facts += invRow("Price source", d.priceSource);
    }
    if (d.phone) facts += invRow("Phone", d.phone);
    if (facts) html += '<div class="nesher-inv-sec">' + facts + "</div>";

    if (d.travelers && d.travelers.length) {
      html += '<div class="nesher-inv-sec"><span class="nesher-sec-label">Travelers (' + d.travelers.length + ')</span>' +
        '<div class="nesher-inv-text">' +
        esc(d.travelers.map(function (t) { return t.full_name || "Traveler"; }).join(", ")) +
        "</div></div>";
    }

    if (d.flights && d.flights.length) {
      html += '<div class="nesher-inv-sec"><span class="nesher-sec-label">Flights</span>';
      d.flights.slice(0, 12).forEach(function (f) {
        var head = ((f.airline || "") + " " + (f.flight_number || "")).trim() || "Flight";
        var when = ((f.departure_date || "") + " " + (f.departure_time || "")).trim();
        html += '<div class="nesher-flight"><b>' + esc(head) + "</b>" +
          "<span>" + esc((f.from_location || "?") + " \\u2192 " + (f.to_location || "?")) + "</span>" +
          (when ? '<span class="mut">' + esc(when) + "</span>" : "") +
          "</div>";
      });
      html += "</div>";
    }

    if (d.journeyLines && d.journeyLines.length) {
      html += '<div class="nesher-inv-sec"><span class="nesher-sec-label">Services &amp; tickets</span>';
      d.journeyLines.slice(0, 20).forEach(function (j) {
        var price = Number(j.customer_price) > 0 ? money(j.customer_price) : "";
        html += '<div class="nesher-inv-row"><span>' + esc(j.label || j.line_type || "Service") +
          (j.confirmation_number ? ' <i class="conf">conf ' + esc(j.confirmation_number) + "</i>" : "") +
          "</span><b>" + price + "</b></div>";
      });
      html += "</div>";
    }

    if (draft.payerMemo) {
      html += '<details class="nesher-memo"><summary>Full memo (what the customer sees)</summary><pre>' +
        esc(draft.payerMemo) + "</pre></details>";
    }
    html += "</section>";
    return html;
  }

  function renderLoading(kind) {
    var root = ensureModal();
    root.querySelector(".nesher-pay-panel").classList.remove("success");
    modalState.success = null;
    document.getElementById("nesher-pay-title").textContent = "Create payment link";
    var kindLabel = kind === "reservation" ? "Reservation" : "Hotel";
    setSub('<span class="nesher-chip mut">' + esc(kindLabel) + "</span><span>Loading booking details\\u2026</span>");
    document.getElementById("nesher-pay-body").innerHTML =
      '<div class="nesher-skel lg"></div><div class="nesher-skel md"></div>' +
      '<div class="nesher-skel"></div><div class="nesher-skel"></div>' +
      '<div class="nesher-skel" style="width:40%"></div>';
    setStatus("");
    var createBtn = document.getElementById("nesher-pay-create");
    createBtn.disabled = true;
    createBtn.textContent = "Create payment link";
    openRoot(root);
  }

  function renderModal(data, keep) {
    var root = ensureModal();
    root.querySelector(".nesher-pay-panel").classList.remove("success");
    modalState.success = null;
    var body = document.getElementById("nesher-pay-body");
    var draft = data.draft || {};
    var missing = data.missing || [];
    var advice = data.advice || [];
    var needs = data.needsInput || missing.some(function (m) { return m.required; });
    var byField = {};
    missing.forEach(function (m) { if (m && m.field) byField[m.field] = m; });
    var formFields = { amountUsd: 1, customerEmail: 1, customerName: 1 };

    document.getElementById("nesher-pay-title").textContent =
      needs ? "Complete payment details" : "Create payment link";
    setSub(subFor(data, needs
      ? '<span class="nesher-chip warn">Needs input</span>'
      : '<span class="nesher-chip ok">Ready</span>'));

    var html = "";

    // One calm banner, max. Field-level hints carry the specifics.
    var extraReq = missing.filter(function (m) { return m.required && !formFields[m.field]; });
    if (needs) {
      var lines = [advice[0] || "Fill the highlighted fields, then create the payment link."];
      advice.slice(1).forEach(function (a) { lines.push(a); });
      extraReq.forEach(function (m) { lines.push(m.label + ": " + m.reason); });
      html += banner("warn", lines);
    } else if (advice.length > 1) {
      html += banner("info", advice.slice(1));
    }

    // Hero amount
    var amtMiss = byField.amountUsd;
    var amtEmpty = !(Number(draft.amountUsd) > 0);
    var amtHint;
    if (amtMiss) {
      amtHint = '<div class="nesher-hint warn">' + esc(amtMiss.reason) + "</div>";
    } else {
      var srcNote = "";
      if (Number(draft.sourceAmount) > 0 && draft.sourceCurrency && draft.sourceCurrency !== "USD") {
        srcNote = " Converted from " + draft.sourceCurrency + " " +
          Number(draft.sourceAmount).toLocaleString("en-US") + ".";
      }
      amtHint = '<div class="nesher-hint">Charged to the customer via Mercury.' + esc(srcNote) + "</div>";
    }
    html += '<div class="nesher-hero' + (amtMiss && amtMiss.required && amtEmpty ? " miss" : "") + '">' +
      '<label class="nesher-sec-label" for="nesher-f-amount">Amount due (USD)' +
      (amtMiss && amtMiss.required ? ' <span class="req">*</span>' : "") + "</label>" +
      '<div class="nesher-amt"><span class="cur">$</span>' +
      '<input type="number" step="0.01" min="0" inputmode="decimal" id="nesher-f-amount" value="' +
      esc(amtEmpty ? "" : draft.amountUsd) + '" placeholder="0.00" /></div>' +
      amtHint + "</div>";

    // Customer
    var nameMiss = byField.customerName;
    var emailMiss = byField.customerEmail;
    html += '<div class="nesher-sec"><span class="nesher-sec-label">Customer</span><div class="nesher-grid2">';
    html += '<div class="nesher-field">' +
      '<label for="nesher-f-name">Name</label>' +
      '<input type="text" id="nesher-f-name" value="' + esc(draft.customerName || "") + '" placeholder="Customer name" />' +
      (nameMiss ? '<div class="nesher-hint warn">' + esc(nameMiss.reason) + "</div>" : "") +
      "</div>";
    var ownEmail = draft.emailPlaceholder || isOwnEmail(draft.customerEmail);
    html += '<div class="nesher-field' + (emailMiss && emailMiss.required ? " miss" : "") + '">' +
      '<label for="nesher-f-email">Email' +
      ' <span class="nesher-chip warn nesher-own-chip"' + (ownEmail ? "" : ' style="display:none"') + ">our email</span></label>" +
      '<input type="email" id="nesher-f-email" value="' + esc(draft.customerEmail || "") + '" placeholder="customer@email.com" />' +
      '<div class="nesher-hint warn nesher-own-note"' + (ownEmail ? "" : ' style="display:none"') + ">" +
      "This is OUR inbox, not the customer's — the invoice email comes to us. Share the pay link with the customer directly, or enter their real email.</div>" +
      (!ownEmail && emailMiss
        ? '<div class="nesher-hint warn">' + esc(emailMiss.reason) + "</div>"
        : "") +
      "</div>";
    html += "</div></div>";

    // Invoice preview
    html += invoiceCard(draft);

    // Advanced, collapsed by default (open if a staff note is carried over)
    var memoVal = keep && keep.payerMemo ? keep.payerMemo : "";
    html += '<details class="nesher-adv"' + (memoVal ? " open" : "") + ">" +
      "<summary>Advanced <span class=\\"mut\\">invoice number · line item · staff note</span></summary>" +
      '<div class="nesher-adv-body">' +
      '<div class="nesher-field"><label for="nesher-f-inv">Invoice number</label>' +
      '<input type="text" id="nesher-f-inv" value="' + esc(draft.invoiceNumber || "") + '" />' +
      '<div class="nesher-hint">Stable number — an existing unpaid link with this number is reused.</div></div>' +
      '<div class="nesher-field"><label for="nesher-f-line">Line item title</label>' +
      '<input type="text" id="nesher-f-line" value="' + esc(draft.lineItemName || "") + '" /></div>' +
      '<div class="nesher-field"><label for="nesher-f-memo">Staff note (added to the customer-visible memo)</label>' +
      '<textarea id="nesher-f-memo" rows="2" placeholder="Optional note for this charge">' + esc(memoVal) + "</textarea></div>" +
      "</div></details>";

    // Optional CRM housekeeping tips, out of the way
    var tips = missing.filter(function (m) { return !m.required && !formFields[m.field]; });
    if (tips.length) {
      html += '<div class="nesher-tips">' +
        tips.map(function (m) { return "Tip: " + esc(m.reason); }).join("<br/>") +
        "</div>";
    }

    body.innerHTML = html;
    setStatus("");
    var createBtn = document.getElementById("nesher-pay-create");
    createBtn.disabled = false;
    createBtn.textContent = "Create payment link";
    openRoot(root);

    var emailInput = document.getElementById("nesher-f-email");
    if (emailInput) {
      emailInput.addEventListener("input", function () {
        var own = isOwnEmail(emailInput.value);
        var fld = emailInput.closest(".nesher-field");
        var chip = fld.querySelector(".nesher-own-chip");
        var note = fld.querySelector(".nesher-own-note");
        if (chip) chip.style.display = own ? "" : "none";
        if (note) note.style.display = own ? "" : "none";
      });
    }

    var amt = document.getElementById("nesher-f-amount");
    if (amt && amtEmpty) amt.focus();
    else createBtn.focus();
  }

  // ── Success: its own clean screen ──
  function renderSuccess(data) {
    var root = ensureModal();
    var draft = data.draft || {};
    modalState.success = { url: data.payUrl };
    root.querySelector(".nesher-pay-panel").classList.add("success");

    document.getElementById("nesher-pay-title").textContent = "Payment link ready";
    setSub(subFor({ kind: data.kind || (modalState.kind === "reservation" ? "reservation" : "hotel"), draft: draft },
      '<span class="nesher-chip ok">Link ready</span>'));

    var amount = Number(data.amountUsd || draft.amountUsd);
    var emailBit = draft.customerEmail
      ? draft.customerEmail + (isOwnEmail(draft.customerEmail) ? " (our inbox — send the customer the link)" : "")
      : "";
    var meta = [data.invoiceNumber || draft.invoiceNumber, draft.customerName, emailBit]
      .filter(function (x) { return x && String(x).trim(); }).join(" · ");

    var body = document.getElementById("nesher-pay-body");
    body.innerHTML =
      '<div class="nesher-success">' +
        '<div class="nesher-success-check">' + ICON_CHECK + "</div>" +
        '<div class="nesher-success-amt">' + money(amount) + "</div>" +
        '<div class="nesher-success-meta">' + esc(meta) + "</div>" +
        (data.reused ? '<div class="nesher-pill">Existing unpaid link reused — same URL as before</div>' : "") +
        '<div class="nesher-url-box">' +
          '<input id="nesher-success-url" readonly value="' + esc(data.payUrl) + '" aria-label="Payment link URL" />' +
          '<button type="button" class="nesher-btn-sec" id="nesher-copy-url">Copy</button>' +
        "</div>" +
        '<div class="nesher-success-actions">' +
          '<a class="nesher-btn-sec" href="' + esc(data.payUrl) + '" target="_blank" rel="noopener">Open in Mercury</a>' +
        "</div>" +
      "</div>";

    var createBtn = document.getElementById("nesher-pay-create");
    createBtn.disabled = false;
    createBtn.textContent = "Done";

    var urlInput = document.getElementById("nesher-success-url");
    urlInput.addEventListener("focus", function () { urlInput.select(); });
    document.getElementById("nesher-copy-url").addEventListener("click", function () {
      var btn = this;
      function done() {
        btn.textContent = "Copied";
        setTimeout(function () { btn.textContent = "Copy"; }, 1600);
      }
      function fallback() {
        try { urlInput.select(); document.execCommand("copy"); done(); } catch (e) {}
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(data.payUrl).then(done, fallback);
      } else fallback();
    });

    openRoot(root);
    createBtn.focus();
  }

  function readFormOverrides() {
    function val(id) {
      var el = document.getElementById(id);
      return el ? String(el.value || "").trim() : "";
    }
    var amount = val("nesher-f-amount");
    return {
      create: true,
      amountUsd: amount === "" ? undefined : Number(amount),
      customerEmail: val("nesher-f-email") || undefined,
      customerName: val("nesher-f-name") || undefined,
      invoiceNumber: val("nesher-f-inv") || undefined,
      lineItemName: val("nesher-f-line") || undefined,
      payerMemo: val("nesher-f-memo") || undefined
    };
  }

  async function submitCreate() {
    if (modalState.success) { closeModal(); return; }
    if (!modalState.kind || !modalState.id) return;
    var createBtn = document.getElementById("nesher-pay-create");
    if (createBtn.disabled) return;
    createBtn.disabled = true;
    createBtn.textContent = "Creating\\u2026";
    setStatus("");
    var url = pathFor(modalState.kind, modalState.id);
    var overrides = readFormOverrides();
    try {
      var out = await fetchJson(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": csrf(),
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json"
        },
        body: JSON.stringify(overrides)
      }, 30000);
      var data = out.data || {};
      modalState.data = data;
      if (data.payUrl && !/^https:\\/\\//i.test(String(data.payUrl))) {
        setStatus("Unexpected pay link format — not opening it. Contact dev.");
        createBtn.disabled = false;
        createBtn.textContent = "Create payment link";
        return;
      }

      if (data.payUrl) {
        // Update the row chrome behind the modal
        showQuote(modalState.wrap, data);
        var wrap = modalState.wrap;
        if (wrap) {
          var link = wrap.querySelector(".nesher-mercury-link");
          if (!link) {
            link = document.createElement("a");
            link.className = "nesher-mercury-link";
            link.target = "_blank";
            link.rel = "noopener";
            wrap.appendChild(link);
          }
          link.href = data.payUrl;
          link.textContent = data.reused ? "Open pay link (existing)" : "Open pay link (ready)";
          if (modalState.btn) {
            modalState.btn.textContent = data.reused ? "Show pay link" : "Pay link ready";
          }
        }
        renderSuccess(data);
        try {
          await navigator.clipboard.writeText(data.payUrl);
          setStatus("Link copied to clipboard.", true);
        } catch (e) {}
        return;
      }

      // Still missing fields — re-render form with server guidance, keep the staff note
      if (data.needsInput || data.draft) {
        renderModal(data, { payerMemo: overrides.payerMemo || "" });
        setStatus(data.message || data.error || "Fill the highlighted fields, then create again.");
        return;
      }

      setStatus(data.error || "Could not create link — check details and try again.");
      createBtn.disabled = false;
      createBtn.textContent = "Create payment link";
    } catch (e) {
      var msg = e && e.name === "AbortError"
        ? "Timed out — try again (Mercury/network slow)"
        : (e.message || String(e));
      setStatus(msg);
      createBtn.disabled = false;
      createBtn.textContent = "Create payment link";
    }
  }

  function modalStillOn(kind, id) {
    var root = document.getElementById("nesher-pay-modal-root");
    return root && root.classList.contains("open") &&
      modalState.kind === kind && String(modalState.id) === String(id);
  }

  async function openPayFlow(kind, id, btn) {
    if (btn.getAttribute("data-busy") === "1") return;
    var wrap = btn.closest(".nesher-mercury-wrap") || btn.parentElement;
    var err = wrap.querySelector(".nesher-mercury-err");
    if (err) err.textContent = "";
    btn.setAttribute("data-busy", "1");
    btn.disabled = true;
    var defaultLabel = btn.getAttribute("data-label") || "Mercury Pay Link";
    var url = pathFor(kind, id);
    if (!url) {
      btn.disabled = false;
      btn.removeAttribute("data-busy");
      btn.textContent = defaultLabel;
      return;
    }
    modalState = { kind: kind, id: id, btn: btn, wrap: wrap, data: null, success: null };
    renderLoading(kind);
    try {
      // Always load flexible draft first — never hard-fail on missing price
      var out = await fetchJson(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest"
        }
      }, 20000);
      var data = out.data || {};
      if (data.error && !data.draft) {
        // True failure (not found / auth) — still try to be useful
        throw new Error(data.error);
      }
      if (!modalStillOn(kind, id)) return; // staff closed the modal while loading
      modalState.data = data;
      renderModal(data);
      showQuote(wrap, data);
    } catch (e) {
      var msg = e && e.name === "AbortError"
        ? "Timed out — try again"
        : (e.message || String(e));
      if (!err) {
        err = document.createElement("span");
        err.className = "nesher-mercury-err";
        wrap.appendChild(err);
      }
      err.textContent = msg;
      if (modalStillOn(kind, id)) {
        // Open a manual-entry form so staff can still create a link
        renderModal({
          kind: kind === "reservation" ? "reservation" : "hotel",
          needsInput: true,
          advice: [
            "Could not fully load CRM details (" + msg + "). Enter amount and email below to create a payment link anyway."
          ],
          missing: [
            { field: "amountUsd", label: "Amount due (USD)", reason: "Enter manually.", required: true },
            { field: "customerEmail", label: "Customer email", reason: "Enter customer email.", required: true }
          ],
          draft: {
            customerName: "Customer",
            customerEmail: "",
            amountUsd: 0,
            invoiceNumber: kind === "reservation" ? ("RES-ID" + id) : ("JRM-1" + id),
            lineItemName: "Payment",
            payerMemo: "",
            lineItems: []
          }
        });
      }
    } finally {
      btn.disabled = false;
      btn.removeAttribute("data-busy");
      btn.textContent = defaultLabel;
    }
  }

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[" + ${JSON.stringify(BUTTON_MARKER)} + "]");
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    var kind = btn.getAttribute("data-kind");
    var id = btn.getAttribute("data-id");
    if (!kind || !id) return;
    openPayFlow(kind, id, btn);
  });
})();
</script>
`;

function buttonHtml(kind, id, label) {
  const text = label || "Mercury Pay Link";
  return (
    `<span class="nesher-mercury-wrap">` +
    `<button type="button" class="nesher-mercury-btn" ${BUTTON_MARKER} ` +
    `data-kind="${kind}" data-id="${id}" data-label="${text.replace(/"/g, "&quot;")}">${text}</button>` +
    `</span>`
  );
}

/**
 * Inject pay controls into CRM HTML.
 * @param {string} html
 * @param {string} path  request path
 */
export function injectPayButtons(html, path) {
  if (!html || typeof html !== "string") return html;
  if (html.includes("nesher-mercury-pay-js")) return html;
  if (!/<\/body>/i.test(html) && !/<html/i.test(html)) return html;

  let out = html;
  const p = path || "";

  // Hotel detail: bind Pay to EACH offer (exact quote)
  const hotelDetail = p.match(/^\/jrm\/hotels\/(\d+)\/?$/);
  if (hotelDetail) {
    const requestId = hotelDetail[1];
    out = out.replace(
      /(<div class="jrm-offer-actions">)([\s\S]*?)(<\/div>)/gi,
      (full, open, inner, close) => {
        if (inner.includes(BUTTON_MARKER)) return full;
        const m = inner.match(/\/jrm\/hotels\/offer\/(\d+)\//);
        if (!m) return full;
        const offerId = m[1];
        const btn = buttonHtml(
          "hotel-offer",
          offerId,
          "Mercury Pay (this quote)"
        );
        return `${open}${inner} ${btn}${close}`;
      }
    );
    if (!out.includes(BUTTON_MARKER)) {
      const btn = buttonHtml("hotel", requestId, "Mercury Pay Link");
      if (/payment\/add\//i.test(out)) {
        out = out.replace(
          /(<a[^>]+href="\/jrm\/hotels\/\d+\/payment\/add\/"[^>]*>[\s\S]*?<\/a>)/i,
          `$1 ${btn}`
        );
      } else {
        out = out.replace(/<\/body>/i, `${btn}</body>`);
      }
    }
  }

  // Hotel list
  if (/^\/jrm\/hotels\/?$/.test(p) || /^\/jrm\/hotels\/\?/.test(p)) {
    out = out.replace(
      /(<a[^>]*href="\/jrm\/hotels\/(\d+)\/"[^>]*>)([\s\S]*?)(<\/a>)/gi,
      (full, open, id, text, close) => {
        if (full.includes(BUTTON_MARKER)) return full;
        return `${open}${text}${close} ${buttonHtml("hotel", id, "Pay quote")}`;
      }
    );
  }

  // Reservation detail
  const resDetail = p.match(/^\/reservations\/(\d+)\/?$/);
  if (resDetail) {
    const id = resDetail[1];
    const btn = buttonHtml("reservation", id, "Mercury Pay (balance due)");
    if (/payments\/add\//i.test(out)) {
      out = out.replace(
        /(<a[^>]+href="\/reservations\/\d+\/payments\/add\/"[^>]*>[\s\S]*?<\/a>)/i,
        `$1 ${btn}`
      );
    } else {
      out = out.replace(/<\/h1>/i, `</h1> ${btn}`);
      if (!out.includes(BUTTON_MARKER)) {
        out = out.replace(/<\/body>/i, `${btn}</body>`);
      }
    }
  }

  // Reservation list
  if (/^\/reservations\/?$/.test(p) || /^\/reservations\/\?/.test(p)) {
    out = out.replace(
      /(<a[^>]*href="\/reservations\/(\d+)\/"[^>]*>)([\s\S]*?)(<\/a>)/gi,
      (full, open, id, text, close) => {
        if (full.includes(BUTTON_MARKER)) return full;
        if (/\/(edit|delete)\//i.test(open)) return full;
        return `${open}${text}${close} ${buttonHtml("reservation", id, "Pay due")}`;
      }
    );
  }

  // Replacer functions so "$"-sequences inside CSS/SCRIPT are never
  // interpreted as String.replace substitution patterns.
  if (!out.includes("nesher-mercury-pay-css")) {
    if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, () => `${CSS}</head>`);
    } else {
      out = CSS + out;
    }
  }
  if (!out.includes("nesher-mercury-pay-js")) {
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, () => `${SCRIPT}</body>`);
    } else {
      out = out + SCRIPT;
    }
  }

  return out;
}

function usdBadge(paid, price) {
  const fmt = (n) =>
    "$" +
    Number(n).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const full = !(price > 0) || paid >= price - 0.01;
  return full
    ? `<span class="nesher-paid-badge">PAID ${fmt(paid)}</span>`
    : `<span class="nesher-paid-badge part">PAID ${fmt(paid)} of ${fmt(price)}</span>`;
}

/**
 * Server-side "PAID" badges on CRM list/detail pages, straight from the
 * payment tables — visible no matter how the CRM's own templates render.
 * Soft: any DB error or a slow query (>1.5s) returns the HTML unchanged.
 */
export async function injectPaidBadges(html, path, pool) {
  if (!html || typeof html !== "string" || !pool) return html;
  const p = path || "";
  if (!/^\/reservations(\/|$)|^\/jrm\/hotels(\/|$)/.test(p)) return html;
  const withTimeout = (prom) =>
    Promise.race([prom, new Promise((r) => setTimeout(() => r(null), 1500))]);
  try {
    const resDetail = p.match(/^\/reservations\/(\d+)\/?$/);
    if (resDetail) {
      const out = await withTimeout(
        pool.query(
          `SELECT customer_price, amount_paid FROM core_reservation WHERE id = $1`,
          [Number(resDetail[1])]
        )
      );
      const row = out && out.rows && out.rows[0];
      if (row && Number(row.amount_paid) > 0) {
        html = html.replace(
          /<\/h1>/i,
          `</h1> ${usdBadge(Number(row.amount_paid), Number(row.customer_price))}`
        );
      }
      return html;
    }
    const hotelDetail = p.match(/^\/jrm\/hotels\/(\d+)\/?$/);
    if (hotelDetail) {
      const out = await withTimeout(
        pool.query(
          `SELECT COALESCE(SUM(amount) FILTER (WHERE UPPER(TRIM(currency)) IN ('USD','US$','$')), 0) AS paid
           FROM core_jrmhotelpayment WHERE request_id = $1`,
          [Number(hotelDetail[1])]
        )
      );
      const paid = Number(out && out.rows && out.rows[0] && out.rows[0].paid) || 0;
      if (paid > 0) html = html.replace(/<\/h1>/i, `</h1> ${usdBadge(paid, 0)}`);
      return html;
    }
    if (/^\/reservations\/?(\?|$)/.test(p)) {
      const ids = [
        ...new Set(
          [...html.matchAll(/href="\/reservations\/(\d+)\//g)].map((m) =>
            Number(m[1])
          )
        ),
      ];
      if (!ids.length) return html;
      const out = await withTimeout(
        pool.query(
          `SELECT id, customer_price, amount_paid FROM core_reservation
           WHERE id = ANY($1) AND COALESCE(amount_paid, 0) > 0`,
          [ids]
        )
      );
      for (const row of (out && out.rows) || []) {
        const re = new RegExp(
          `(<a[^>]*href="/reservations/${row.id}/"[^>]*>[\\s\\S]*?</a>)`,
          "i"
        );
        html = html.replace(re, (m) =>
          /\/(edit|delete)\//i.test(m)
            ? m
            : `${m} ${usdBadge(Number(row.amount_paid), Number(row.customer_price))}`
        );
      }
      return html;
    }
    if (/^\/jrm\/hotels\/?(\?|$)/.test(p)) {
      const ids = [
        ...new Set(
          [...html.matchAll(/href="\/jrm\/hotels\/(\d+)\//g)].map((m) =>
            Number(m[1])
          )
        ),
      ];
      if (!ids.length) return html;
      const out = await withTimeout(
        pool.query(
          `SELECT request_id,
                  COALESCE(SUM(amount) FILTER (WHERE UPPER(TRIM(currency)) IN ('USD','US$','$')), 0) AS paid
           FROM core_jrmhotelpayment WHERE request_id = ANY($1)
           GROUP BY request_id`,
          [ids]
        )
      );
      for (const row of (out && out.rows) || []) {
        if (!(Number(row.paid) > 0)) continue;
        const re = new RegExp(
          `(<a[^>]*href="/jrm/hotels/${row.request_id}/"[^>]*>[\\s\\S]*?</a>)`,
          "i"
        );
        html = html.replace(re, (m) => `${m} ${usdBadge(Number(row.paid), 0)}`);
      }
      return html;
    }
  } catch (e) {
    console.error("paid badges failed", e.message);
  }
  return html;
}

export { buttonHtml, CSS, SCRIPT };
