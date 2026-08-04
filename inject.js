/**
 * HTML injection helpers for CRM list/detail pages.
 * Buttons bind to exact quotes: hotel-offer/:offerId or reservation/:id.
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

  function showQuote(wrap, data) {
    var q = data && data.quote;
    var el = wrap.querySelector(".nesher-mercury-quote");
    if (!q) return;
    if (!el) {
      el = document.createElement("span");
      el.className = "nesher-mercury-quote";
      wrap.appendChild(el);
    }
    el.textContent = q.summary || ("$" + (data.amountUsd || "") + " · " + (data.invoiceNumber || ""));
  }

  function fetchJson(url, opts, timeoutMs) {
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, timeoutMs || 25000);
    var o = opts || {};
    o.signal = ctrl.signal;
    o.credentials = "same-origin";
    return fetch(url, o).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { res: res, data: data };
      });
    }).finally(function () { clearTimeout(t); });
  }

  async function createLink(kind, id, btn) {
    if (btn.getAttribute("data-busy") === "1") return;
    var wrap = btn.closest(".nesher-mercury-wrap") || btn.parentElement;
    var err = wrap.querySelector(".nesher-mercury-err");
    var link = wrap.querySelector(".nesher-mercury-link");
    if (err) err.textContent = "";
    btn.setAttribute("data-busy", "1");
    btn.disabled = true;
    var defaultLabel = btn.getAttribute("data-label") || "Mercury Pay Link";
    btn.textContent = "Creating…";
    var url = pathFor(kind, id);
    if (!url) {
      btn.disabled = false;
      btn.removeAttribute("data-busy");
      btn.textContent = defaultLabel;
      return;
    }
    try {
      // Single POST (returns quote + payUrl) — one round-trip, less chance to hang
      var out = await fetchJson(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": csrf(),
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json"
        },
        body: JSON.stringify({})
      }, 28000);
      var data = out.data || {};
      if (!out.res.ok) throw new Error(data.error || ("HTTP " + out.res.status));
      if (!data.payUrl) throw new Error("No pay URL returned");
      showQuote(wrap, data);
      if (!link) {
        link = document.createElement("a");
        link.className = "nesher-mercury-link";
        link.target = "_blank";
        link.rel = "noopener";
        wrap.appendChild(link);
      }
      link.href = data.payUrl;
      link.textContent = data.reused ? "Open pay link (existing)" : "Open pay link (ready)";
      btn.textContent = data.reused ? "Show pay link" : "Pay link ready";
      try { await navigator.clipboard.writeText(data.payUrl); } catch (e) {}
    } catch (e) {
      if (!err) {
        err = document.createElement("span");
        err.className = "nesher-mercury-err";
        wrap.appendChild(err);
      }
      var msg = e && e.name === "AbortError"
        ? "Timed out — try again (Mercury/network slow)"
        : (e.message || String(e));
      err.textContent = msg;
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
    createLink(kind, id, btn);
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
    // Inject next to each offer's action row (quote/pdf links identify offer id)
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
    // Fallback if no offer-actions found: request-level with resolve
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

  // Hotel list: request-level Pay (server resolves exact sent/accepted quote)
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
