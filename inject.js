/**
 * HTML injection helpers for CRM list/detail pages.
 * Flexible invoice modal: pack every detail, list what's missing, let staff fill it in.
 */

export const BUTTON_MARKER = "data-nesher-mercury-pay";

const CSS = `
<style id="nesher-mercury-pay-css">
  .nesher-mercury-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #0f766e;
    color: #fff !important;
    border: none;
    border-radius: 6px;
    padding: 6px 12px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    text-decoration: none !important;
    margin: 2px 4px;
    line-height: 1.2;
  }
  .nesher-mercury-btn:hover { background: #0d9488; color: #fff !important; }
  .nesher-mercury-btn[disabled] { opacity: 0.6; cursor: wait; }
  .nesher-mercury-link {
    display: inline-block;
    margin-left: 8px;
    font-size: 12px;
    color: #0f766e;
    font-weight: 600;
    word-break: break-all;
  }
  .nesher-mercury-wrap {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    max-width: 100%;
  }
  .nesher-mercury-err { color: #b91c1c; font-size: 12px; margin-left: 6px; }
  .nesher-mercury-quote {
    display: block;
    width: 100%;
    margin-top: 4px;
    font-size: 12px;
    color: #334155;
    font-weight: 600;
  }
  #nesher-pay-modal-root {
    position: fixed; inset: 0; z-index: 99999;
    display: none; align-items: flex-start; justify-content: center;
    padding: 4vh 12px; overflow-y: auto;
    background: rgba(15, 23, 42, 0.55);
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  #nesher-pay-modal-root.open { display: flex; }
  .nesher-pay-panel {
    background: #fff; border-radius: 12px; width: 100%; max-width: 560px;
    box-shadow: 0 20px 50px rgba(0,0,0,.25); overflow: hidden;
  }
  .nesher-pay-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px; background: #0f766e; color: #fff;
  }
  .nesher-pay-head h2 { margin: 0; font-size: 16px; font-weight: 700; }
  .nesher-pay-close {
    background: transparent; border: 0; color: #fff; font-size: 22px;
    cursor: pointer; line-height: 1; padding: 0 4px;
  }
  .nesher-pay-body { padding: 16px 18px 8px; max-height: 70vh; overflow-y: auto; }
  .nesher-pay-advice {
    background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46;
    border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 12px;
  }
  .nesher-pay-advice.warn {
    background: #fffbeb; border-color: #fcd34d; color: #92400e;
  }
  .nesher-pay-missing {
    background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px;
    padding: 10px 12px; margin-bottom: 12px;
  }
  .nesher-pay-missing h3 {
    margin: 0 0 8px; font-size: 13px; color: #991b1b; font-weight: 700;
  }
  .nesher-pay-missing ul { margin: 0; padding-left: 18px; font-size: 12px; color: #7f1d1d; }
  .nesher-pay-missing li { margin-bottom: 4px; }
  .nesher-pay-field { margin-bottom: 12px; }
  .nesher-pay-field label {
    display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 4px;
  }
  .nesher-pay-field label .req { color: #b91c1c; }
  .nesher-pay-field input, .nesher-pay-field textarea {
    width: 100%; box-sizing: border-box; border: 1px solid #cbd5e1;
    border-radius: 6px; padding: 8px 10px; font-size: 14px;
  }
  .nesher-pay-field input:focus, .nesher-pay-field textarea:focus {
    outline: 2px solid #99f6e4; border-color: #0f766e;
  }
  .nesher-pay-field .hint { font-size: 11px; color: #64748b; margin-top: 3px; }
  .nesher-pay-preview {
    background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px;
    padding: 10px 12px; margin-bottom: 12px;
  }
  .nesher-pay-preview h3 {
    margin: 0 0 6px; font-size: 12px; text-transform: uppercase;
    letter-spacing: .04em; color: #64748b;
  }
  .nesher-pay-preview pre {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font-size: 12px; line-height: 1.45; color: #0f172a;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    max-height: 180px; overflow-y: auto;
  }
  .nesher-pay-lines { font-size: 12px; color: #334155; margin: 6px 0 0; padding-left: 16px; }
  .nesher-pay-foot {
    display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end;
    padding: 12px 18px 16px; border-top: 1px solid #e2e8f0;
  }
  .nesher-pay-foot button {
    border-radius: 6px; padding: 8px 14px; font-size: 13px; font-weight: 600;
    cursor: pointer; border: 1px solid #cbd5e1; background: #fff; color: #0f172a;
  }
  .nesher-pay-foot .primary {
    background: #0f766e; color: #fff; border-color: #0f766e;
  }
  .nesher-pay-foot .primary:disabled { opacity: .6; cursor: wait; }
  .nesher-pay-status { font-size: 12px; color: #b91c1c; margin: 0 18px 10px; }
  .nesher-pay-status.ok { color: #047857; }
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

  function ensureModal() {
    var root = document.getElementById("nesher-pay-modal-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "nesher-pay-modal-root";
    root.innerHTML =
      '<div class="nesher-pay-panel" role="dialog" aria-modal="true">' +
        '<div class="nesher-pay-head">' +
          '<h2 id="nesher-pay-title">Payment link / invoice</h2>' +
          '<button type="button" class="nesher-pay-close" aria-label="Close">&times;</button>' +
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
    return root;
  }

  var modalState = { kind: null, id: null, btn: null, wrap: null, data: null };

  function closeModal() {
    var root = document.getElementById("nesher-pay-modal-root");
    if (root) root.classList.remove("open");
    modalState = { kind: null, id: null, btn: null, wrap: null, data: null };
  }

  function setStatus(msg, ok) {
    var el = document.getElementById("nesher-pay-status");
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ""; return; }
    el.hidden = false;
    el.textContent = msg;
    el.className = "nesher-pay-status" + (ok ? " ok" : "");
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

  function renderModal(data) {
    var root = ensureModal();
    var body = document.getElementById("nesher-pay-body");
    var draft = data.draft || {};
    var missing = data.missing || [];
    var advice = data.advice || [];
    var needs = data.needsInput || missing.some(function (m) { return m.required; });

    document.getElementById("nesher-pay-title").textContent =
      needs ? "Complete invoice details" : "Review invoice & create pay link";

    var html = "";

    if (advice.length) {
      html += '<div class="nesher-pay-advice' + (needs ? " warn" : "") + '">';
      advice.forEach(function (a) {
        html += "<div>" + esc(a) + "</div>";
      });
      html += "</div>";
    }

    if (missing.length) {
      html += '<div class="nesher-pay-missing"><h3>What still needs attention</h3><ul>';
      missing.forEach(function (m) {
        html += "<li><strong>" + esc(m.label) +
          (m.required ? " (required)" : " (optional)") +
          ":</strong> " + esc(m.reason) + "</li>";
      });
      html += "</ul></div>";
    }

    // Editable fields — always show amount, email, name so staff can override anything
    html += '<div class="nesher-pay-field">' +
      '<label>Amount due (USD) ' + (needs && !(Number(draft.amountUsd) > 0) ? '<span class="req">*</span>' : '') + '</label>' +
      '<input type="number" step="0.01" min="0" id="nesher-f-amount" value="' +
      esc(draft.amountUsd > 0 ? draft.amountUsd : "") + '" placeholder="e.g. 2604.00" />' +
      '<div class="hint">Customer will be charged this amount. Pre-filled from CRM when available.</div></div>';

    html += '<div class="nesher-pay-field">' +
      '<label>Customer email' + (draft.emailPlaceholder ? ' <span class="req">(placeholder — replace if you can)</span>' : '') + '</label>' +
      '<input type="email" id="nesher-f-email" value="' + esc(draft.customerEmail || "") + '" />' +
      '<div class="hint">Mercury needs an email. Placeholder booking+…@jrmhotels.com works if CRM has none.</div></div>';

    html += '<div class="nesher-pay-field">' +
      '<label>Customer name</label>' +
      '<input type="text" id="nesher-f-name" value="' + esc(draft.customerName || "") + '" /></div>';

    html += '<div class="nesher-pay-field">' +
      '<label>Invoice number</label>' +
      '<input type="text" id="nesher-f-inv" value="' + esc(draft.invoiceNumber || "") + '" />' +
      '<div class="hint">Stable number for reuse if link already exists unpaid.</div></div>';

    html += '<div class="nesher-pay-field">' +
      '<label>Line item title (shown on invoice)</label>' +
      '<input type="text" id="nesher-f-line" value="' + esc(draft.lineItemName || "") + '" /></div>';

    html += '<div class="nesher-pay-field">' +
      '<label>Extra staff note (added to customer-visible memo)</label>' +
      '<textarea id="nesher-f-memo" rows="2" placeholder="Optional note for this charge"></textarea></div>';

    // Full invoice preview — every detail we packed
    html += '<div class="nesher-pay-preview"><h3>Invoice preview (what the customer sees)</h3>';
    if (draft.lineItems && draft.lineItems.length) {
      html += '<ul class="nesher-pay-lines">';
      draft.lineItems.forEach(function (li) {
        html += "<li>" + esc(li.name) + " — $" + Number(li.unitPrice).toFixed(2) +
          (li.quantity > 1 ? " × " + li.quantity : "") + "</li>";
      });
      html += "</ul>";
    }
    html += "<pre>" + esc(draft.payerMemo || draft.summary || "(memo builds after amount is set)") + "</pre></div>";

    body.innerHTML = html;
    setStatus("");
    var createBtn = document.getElementById("nesher-pay-create");
    createBtn.disabled = false;
    createBtn.textContent = "Create payment link";
    root.classList.add("open");
    // Focus first empty required field
    var amt = document.getElementById("nesher-f-amount");
    if (amt && !(Number(draft.amountUsd) > 0)) amt.focus();
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
    if (!modalState.kind || !modalState.id) return;
    var createBtn = document.getElementById("nesher-pay-create");
    createBtn.disabled = true;
    createBtn.textContent = "Creating…";
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

      if (data.payUrl) {
        setStatus(
          (data.reused ? "Existing unpaid link ready: " : "Pay link created: ") + data.payUrl,
          true
        );
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
        try { await navigator.clipboard.writeText(data.payUrl); } catch (e) {}
        createBtn.textContent = "Done";
        createBtn.disabled = false;
        // Refresh preview with final memo
        if (data.draft) renderModal(data);
        setStatus(
          (data.reused ? "Existing unpaid link (copied): " : "Created & copied: ") + data.payUrl,
          true
        );
        return;
      }

      // Still missing fields — re-render form with server advice
      if (data.needsInput || data.draft) {
        renderModal(data);
        setStatus(data.message || data.error || "Fill required fields above, then create again.");
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

  async function openPayFlow(kind, id, btn) {
    if (btn.getAttribute("data-busy") === "1") return;
    var wrap = btn.closest(".nesher-mercury-wrap") || btn.parentElement;
    var err = wrap.querySelector(".nesher-mercury-err");
    if (err) err.textContent = "";
    btn.setAttribute("data-busy", "1");
    btn.disabled = true;
    var defaultLabel = btn.getAttribute("data-label") || "Mercury Pay Link";
    btn.textContent = "Loading…";
    var url = pathFor(kind, id);
    if (!url) {
      btn.disabled = false;
      btn.removeAttribute("data-busy");
      btn.textContent = defaultLabel;
      return;
    }
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
      modalState = { kind: kind, id: id, btn: btn, wrap: wrap, data: data };
      renderModal(data);
      showQuote(wrap, data);
      btn.textContent = defaultLabel;
    } catch (e) {
      if (!err) {
        err = document.createElement("span");
        err.className = "nesher-mercury-err";
        wrap.appendChild(err);
      }
      var msg = e && e.name === "AbortError"
        ? "Timed out — try again"
        : (e.message || String(e));
      err.textContent = msg;
      // Open empty modal so staff can still enter amount manually
      modalState = { kind: kind, id: id, btn: btn, wrap: wrap, data: null };
      renderModal({
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
      btn.textContent = defaultLabel;
    } finally {
      btn.disabled = false;
      btn.removeAttribute("data-busy");
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

  if (!out.includes("nesher-mercury-pay-css")) {
    if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, `${CSS}</head>`);
    } else {
      out = CSS + out;
    }
  }
  if (!out.includes("nesher-mercury-pay-js")) {
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, `${SCRIPT}</body>`);
    } else {
      out = out + SCRIPT;
    }
  }

  return out;
}

export { buttonHtml, CSS, SCRIPT };
