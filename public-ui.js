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
/**
 * SnapEngage's launcher is a small square iframe (~60x60). Everything else it
 * renders — the 404x524 chat panel, the 300x85 proactive invite bar — is an
 * overlay we must stay out of. Classifying by height alone let the 85px-tall
 * invite bar pass as the launcher, which anchored this button to the wrong
 * element and pushed it up into the hero card.
 */
const LAUNCHER_MAX = 90;
/** Page elements the floating button must never cover. */
const KEEP_CLEAR = ".premium-service-panel";

const STYLE = `
<style id="${MARKER}-css">
  /* Real chat is live — retire the "Website chat is coming soon" placeholder. */
  .floating-contact-buttons .floating-chat-button { display: none !important; }

  .floating-contact-buttons {
    transition: bottom .2s ease, right .2s ease, opacity .18s ease;
  }
  .floating-contact-buttons[data-se-state="panel"],
  .floating-contact-buttons[data-se-state="blocked"] {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
</style>`;

const SCRIPT = `
<script id="${MARKER}-js">
(function () {
  var GAP = ${GAP}, LAUNCHER_MAX = ${LAUNCHER_MAX}, KEEP_CLEAR = ${JSON.stringify(KEEP_CLEAR)};
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

  function intersects(a, b) {
    return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
  }

  function blockers() {
    var out = [], all = document.querySelectorAll(KEEP_CLEAR);
    for (var i = 0; i < all.length; i++) {
      var s = getComputedStyle(all[i]);
      if (s.display === "none" || s.visibility === "hidden") continue;
      var r = all[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push(r);
    }
    return out;
  }

  function hitsAny(rect, list) {
    for (var i = 0; i < list.length; i++) if (intersects(rect, list[i])) return true;
    return false;
  }

  /**
   * Stand down only when WE would cover the hero card and the chat launcher
   * would not — i.e. when this button alone is sticking up into the content.
   * If the launcher covers the card too (narrow screens, where the card spans
   * the full width), floating over it is simply how the page works, and
   * hiding one button of the pair would look broken.
   */
  function shouldStandDown(bottomPx, rightPx, launcher) {
    var w = box.offsetWidth, h = box.offsetHeight;
    if (!w || !h) return false;
    var cards = blockers();
    if (!cards.length) return false;
    var probe = {
      left: innerWidth - rightPx - w,
      right: innerWidth - rightPx,
      top: innerHeight - bottomPx - h,
      bottom: innerHeight - bottomPx
    };
    if (!hitsAny(probe, cards)) return false;
    return !(launcher && hitsAny(launcher, cards));
  }

  function apply() {
    var rects = snapEngageRects();
    var overlay = null, launcher = null;
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      var isLauncher = r.width <= LAUNCHER_MAX && r.height <= LAUNCHER_MAX;
      if (isLauncher) {
        if (!launcher || r.top < launcher.top) launcher = r;
      } else if (!overlay || r.height > overlay.height) {
        overlay = r;
      }
    }

    // Chat panel or proactive invite is showing — get out of its way entirely.
    if (overlay) {
      box.setAttribute("data-se-state", "panel");
      return;
    }

    var bottom = baseBottom, right = baseRight;
    if (launcher) {
      // stack directly above SnapEngage's launcher, CENTRE-aligned with it
      bottom = Math.round(innerHeight - launcher.top + GAP);
      right = Math.round(
        innerWidth - (launcher.left + launcher.width / 2) - box.offsetWidth / 2
      );
      if (!(right >= 0)) right = baseRight;
    }

    // Never be the odd one out sitting on the hero card.
    if (shouldStandDown(bottom, right, launcher)) {
      box.setAttribute("data-se-state", "blocked");
      return;
    }

    box.setAttribute("data-se-state", "idle");
    box.style.bottom = bottom + "px";
    box.style.right = right + "px";
  }

  apply();
  setInterval(apply, 500);
  addEventListener("resize", apply);
  addEventListener("orientationchange", apply);
  addEventListener("scroll", apply, { passive: true });
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
