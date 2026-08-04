/**
 * HTML injection helpers for CRM list/detail pages.
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
  .nesher-mercury-wrap { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .nesher-mercury-err { color: #b91c1c; font-size: 12px; margin-left: 6px; }
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

  async function createLink(kind, id, btn) {
    var wrap = btn.closest(".nesher-mercury-wrap") || btn.parentElement;
    var err = wrap.querySelector(".nesher-mercury-err");
    var link = wrap.querySelector(".nesher-mercury-link");
    if (err) err.textContent = "";
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      var res = await fetch("/__nesher_pay/" + kind + "/" + id + "/", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRFToken": csrf(),
          "X-Requested-With": "XMLHttpRequest"
        },
        body: JSON.stringify({})
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      if (!link) {
        link = document.createElement("a");
        link.className = "nesher-mercury-link";
        link.target = "_blank";
        link.rel = "noopener";
        wrap.appendChild(link);
      }
      link.href = data.payUrl;
      link.textContent = data.reused ? "Pay link (existing)" : "Pay link (ready)";
      btn.textContent = data.reused ? "Show pay link" : "Pay link ready";
      try { await navigator.clipboard.writeText(data.payUrl); } catch (e) {}
    } catch (e) {
      if (!err) {
        err = document.createElement("span");
        err.className = "nesher-mercury-err";
        wrap.appendChild(err);
      }
      err.textContent = e.message || String(e);
      btn.textContent = "Mercury Pay Link";
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[" + ${JSON.stringify(BUTTON_MARKER)} + "]");
    if (!btn) return;
    ev.preventDefault();
    var kind = btn.getAttribute("data-kind");
    var id = btn.getAttribute("data-id");
    if (!kind || !id) return;
    createLink(kind, id, btn);
  });
})();
</script>
`;

function buttonHtml(kind, id, label) {
  return (
    `<span class="nesher-mercury-wrap">` +
    `<button type="button" class="nesher-mercury-btn" ${BUTTON_MARKER} ` +
    `data-kind="${kind}" data-id="${id}">${label || "Mercury Pay Link"}</button>` +
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
  // only HTML documents
  if (!/<\/body>/i.test(html) && !/<html/i.test(html)) return html;

  let out = html;
  const p = path || "";

  // Hotel detail: /jrm/hotels/89/
  const hotelDetail = p.match(/^\/jrm\/hotels\/(\d+)\/?$/);
  if (hotelDetail) {
    const id = hotelDetail[1];
    const btn = buttonHtml("hotel", id);
    // Prefer next to existing payment button
    if (/payment\/add\//i.test(out)) {
      out = out.replace(
        /(<a[^>]+href="\/jrm\/hotels\/\d+\/payment\/add\/"[^>]*>[\s\S]*?<\/a>)/i,
        `$1 ${btn}`
      );
    } else if (/class="jrm-btn[^"]*"[^>]*>/i.test(out)) {
      out = out.replace(
        /(class="jrm-btn[^"]*"[^>]*>[\s\S]*?<\/a>)/i,
        `$1 ${btn}`
      );
    } else {
      out = out.replace(/<\/body>/i, `${btn}</body>`);
    }
  }

  // Hotel list: /jrm/hotels/
  if (/^\/jrm\/hotels\/?$/.test(p) || /^\/jrm\/hotels\/\?/.test(p)) {
    // After each detail link /jrm/hotels/ID/
    out = out.replace(
      /href="(\/jrm\/hotels\/(\d+)\/)"/g,
      (match, href, id, offset, whole) => {
        // only transform once per id near the link - add marker in a following injection pass
        return match;
      }
    );
    // Inject a small action cell by appending buttons near request links in table rows
    out = out.replace(
      /(<a[^>]*href="\/jrm\/hotels\/(\d+)\/"[^>]*>)([\s\S]*?)(<\/a>)/gi,
      (full, open, id, text, close) => {
        // Skip nav-only repeats: if text is very short number or # only, still OK
        if (full.includes(BUTTON_MARKER)) return full;
        return `${open}${text}${close} ${buttonHtml("hotel", id, "Pay")}`;
      }
    );
  }

  // Reservation detail: /reservations/280/
  const resDetail = p.match(/^\/reservations\/(\d+)\/?$/);
  if (resDetail) {
    const id = resDetail[1];
    const btn = buttonHtml("reservation", id);
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
        // skip edit/delete only links already matched separately
        if (/\/(edit|delete)\//i.test(open)) return full;
        return `${open}${text}${close} ${buttonHtml("reservation", id, "Pay")}`;
      }
    );
  }

  // assets once
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
