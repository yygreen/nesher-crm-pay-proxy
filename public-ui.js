/**
 * Fixes for the public Nesher Travel homepage that we cannot make in Django.
 *
 * The homepage ships two "coming soon" placeholder buttons bottom-right
 * (.floating-chat-button and .floating-whatsapp-button, both wired to a
 * "<name> is coming soon." toast). Now that real SnapEngage chat is live:
 *   - the placeholder CHAT button is hidden (the real one replaces it),
 *   - the WhatsApp button is lifted clear of SnapEngage's button, and hidden
 *     outright while the SnapEngage panel is open, so the two never overlap.
 *
 * Position is computed from SnapEngage's live rects rather than hard-coded,
 * because its button sits at a different offset on mobile and moves itself
 * off-screen while the chat panel is open.
 */

const MARKER = "nesher-public-ui";

/** Only the homepage carries the floating buttons. */
export function isHomePath(path) {
  const p = String(path || "/").split("?")[0].split("#")[0].replace(/\/+$/, "");
  return p === "";
}

/** Gap between the WhatsApp button and SnapEngage's button, in px. */
const GAP = 12;
/** A SnapEngage element taller than this is the panel/invite, not the button. */
const PANEL_MIN_HEIGHT = 100;

const STYLE = `
<style id="${MARKER}-css">
  /* Real chat is live — retire the "Website chat is coming soon" placeholder. */
  .floating-contact-buttons .floating-chat-button { display: none !important; }

  .floating-contact-buttons {
    transition: bottom .2s ease, right .2s ease, opacity .18s ease;
  }
  .floating-contact-buttons[data-se-state="panel"] {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
</style>`;

const SCRIPT = `
<script id="${MARKER}-js">
(function () {
  var GAP = ${GAP}, PANEL_MIN_HEIGHT = ${PANEL_MIN_HEIGHT};
  var box = document.querySelector(".floating-contact-buttons");
  if (!box) return;

  var baseBottom = 22, baseRight = 18;
  try {
    var cs = getComputedStyle(box);
    baseBottom = parseInt(cs.bottom, 10) || baseBottom;
    baseRight = parseInt(cs.right, 10) || baseRight;
  } catch (e) {}

  function onScreen(r) {
    return r.width > 0 && r.height > 0 &&
      r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight;
  }

  function snapEngageRects() {
    var out = [];
    var nodes = document.querySelectorAll(
      'iframe[id^="iframe-"], iframe#designstudio-iframe, iframe[src*="snapengage" i]'
    );
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      var r = el.getBoundingClientRect();
      if (onScreen(r)) out.push(r);
    }
    return out;
  }

  function apply() {
    var rects = snapEngageRects();
    var panel = null, button = null;
    for (var i = 0; i < rects.length; i++) {
      if (rects[i].height >= PANEL_MIN_HEIGHT) {
        if (!panel || rects[i].height > panel.height) panel = rects[i];
      } else if (!button || rects[i].top < button.top) {
        button = rects[i];
      }
    }

    // Panel or proactive invite is showing — get out of its way entirely.
    if (panel) {
      box.setAttribute("data-se-state", "panel");
      return;
    }
    box.setAttribute("data-se-state", "idle");

    if (button) {
      // sit directly above SnapEngage's button, aligned to the same right edge
      box.style.bottom = Math.round(innerHeight - button.top + GAP) + "px";
      box.style.right = Math.max(0, Math.round(innerWidth - button.right)) + "px";
    } else {
      box.style.bottom = baseBottom + "px";
      box.style.right = baseRight + "px";
    }
  }

  apply();
  setInterval(apply, 500);
  addEventListener("resize", apply);
  addEventListener("orientationchange", apply);
})();
</script>`;

/**
 * @param {string} html
 * @param {string} path
 * @param {{host?: string, isPublicHost?: boolean}} [opts]
 */
export function injectPublicHomeUi(html, path, opts = {}) {
  if (!html || typeof html !== "string") return html;
  if (html.includes(`${MARKER}-js`)) return html;
  if (!isHomePath(path)) return html;
  if (opts.isPublicHost === false) return html;
  // nothing to fix if the upstream template no longer ships these buttons
  if (!html.includes("floating-contact-buttons")) return html;

  const block = `${STYLE}${SCRIPT}`;
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${block}</body>`);
  if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${block}</html>`);
  return html + block;
}
