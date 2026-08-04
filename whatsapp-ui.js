/**
 * WhatsApp inbox redesign for Nesher CRM.
 * Injected by the pay-proxy on /whatsapp/* HTML responses.
 * Does not change Django — progressive enhancement of the existing table/chat HTML.
 */

export const WA_UI_MARKER = "nesher-wa-ui";

const CSS = `
<style id="${WA_UI_MARKER}-css">
  /* ── WhatsApp-inspired shell (scoped under body when on WA pages) ── */
  body.nesher-wa-page {
    background: #e8edef !important;
    font-family: "Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif !important;
  }
  body.nesher-wa-page .container {
    max-width: 1100px !important;
    margin: 16px auto 32px !important;
    padding: 0 12px 40px !important;
  }
  body.nesher-wa-page .container > .card {
    padding: 0 !important;
    overflow: hidden;
    border-radius: 16px !important;
    box-shadow: 0 2px 12px rgba(11, 20, 26, 0.12) !important;
    border: 1px solid rgba(11, 20, 26, 0.08);
    background: #fff !important;
  }
  body.nesher-wa-page #back-btn-wrap { display: none !important; }
  body.nesher-wa-page .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
    padding: 16px 20px;
    margin: 0 !important;
    background: linear-gradient(135deg, #075e54 0%, #128c7e 55%, #25d366 160%);
    color: #fff !important;
  }
  body.nesher-wa-page .page-header h1 {
    margin: 0 !important;
    font-size: 1.25rem !important;
    font-weight: 700 !important;
    letter-spacing: 0.01em;
    color: #fff !important;
  }
  body.nesher-wa-page .page-header .muted,
  body.nesher-wa-page .page-header p {
    margin: 4px 0 0 !important;
    color: rgba(255,255,255,0.85) !important;
    font-size: 0.875rem !important;
  }
  body.nesher-wa-page .wa-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(255,255,255,0.16);
    border: 1px solid rgba(255,255,255,0.22);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 999px;
    white-space: nowrap;
  }
  body.nesher-wa-page .wa-status-pill .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #86efac;
    box-shadow: 0 0 0 3px rgba(134, 239, 172, 0.25);
  }

  /* Search */
  body.nesher-wa-page .search-card {
    margin: 0 !important;
    padding: 12px 16px !important;
    background: #f0f2f5 !important;
    border-radius: 0 !important;
    box-shadow: none !important;
    border-bottom: 1px solid #e9edef;
  }
  body.nesher-wa-page .search-card form {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  body.nesher-wa-page .search-card input[type="text"] {
    flex: 1;
    border: none !important;
    background: #fff !important;
    border-radius: 999px !important;
    padding: 10px 16px 10px 40px !important;
    font-size: 14px !important;
    box-shadow: inset 0 0 0 1px #e9edef;
    outline: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%2354656f' viewBox='0 0 16 16'%3E%3Cpath d='M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.242.656a5 5 0 1 1 0-10 5 5 0 0 1 0 10z'/%3E%3C/svg%3E") !important;
    background-repeat: no-repeat !important;
    background-position: 14px center !important;
  }
  body.nesher-wa-page .search-card input[type="text"]:focus {
    box-shadow: inset 0 0 0 2px #25d366;
  }
  body.nesher-wa-page .search-card button[type="submit"] {
    background: #075e54 !important;
    color: #fff !important;
    border: none !important;
    border-radius: 999px !important;
    padding: 10px 18px !important;
    font-weight: 600 !important;
    font-size: 13px !important;
    cursor: pointer;
  }
  body.nesher-wa-page .search-card button[type="submit"]:hover {
    background: #064e46 !important;
  }

  /* Hide raw table once JS builds the modern list */
  body.nesher-wa-page .card > table,
  body.nesher-wa-page .card table.wa-source-table {
    display: none !important;
  }

  /* Modern conversation list */
  .wa-chat-list {
    list-style: none;
    margin: 0;
    padding: 0;
    background: #fff;
  }
  .wa-chat-list li { margin: 0; }
  .wa-chat-row {
    display: grid;
    grid-template-columns: 56px 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 12px 16px;
    text-decoration: none !important;
    color: inherit !important;
    border-bottom: 1px solid #f0f2f5;
    transition: background 0.12s ease;
    cursor: pointer;
  }
  .wa-chat-row:hover { background: #f5f6f6; }
  .wa-chat-row.is-unread { background: #f0faf7; }
  .wa-chat-row.is-unread:hover { background: #e7f7f0; }
  .wa-avatar {
    width: 52px;
    height: 52px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-weight: 700;
    font-size: 1.05rem;
    color: #fff;
    background: linear-gradient(145deg, #128c7e, #075e54);
    flex-shrink: 0;
    letter-spacing: 0.02em;
    user-select: none;
  }
  .wa-avatar[data-tone="1"] { background: linear-gradient(145deg, #53bdeb, #0b7ea4); }
  .wa-avatar[data-tone="2"] { background: linear-gradient(145deg, #a855f7, #6d28d9); }
  .wa-avatar[data-tone="3"] { background: linear-gradient(145deg, #f59e0b, #d97706); }
  .wa-avatar[data-tone="4"] { background: linear-gradient(145deg, #ec4899, #be185d); }
  .wa-avatar[data-tone="5"] { background: linear-gradient(145deg, #14b8a6, #0f766e); }
  .wa-meta { min-width: 0; }
  .wa-meta-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 3px;
  }
  .wa-name {
    font-size: 16px;
    font-weight: 600;
    color: #111b21;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .wa-time {
    font-size: 12px;
    color: #667781;
    flex-shrink: 0;
  }
  .wa-chat-row.is-unread .wa-time { color: #25d366; font-weight: 700; }
  .wa-meta-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .wa-preview {
    font-size: 13.5px;
    color: #667781;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .wa-chat-row.is-unread .wa-preview { color: #3b4a54; font-weight: 600; }
  .wa-phone-line {
    font-size: 12px;
    color: #8696a0;
    margin-top: 2px;
  }
  .wa-badge {
    min-width: 20px;
    height: 20px;
    padding: 0 6px;
    border-radius: 999px;
    background: #25d366;
    color: #fff;
    font-size: 11px;
    font-weight: 800;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
  .wa-empty {
    padding: 48px 24px;
    text-align: center;
    color: #667781;
  }
  .wa-empty .wa-empty-icon {
    width: 72px; height: 72px; margin: 0 auto 16px;
    border-radius: 50%;
    background: #e7f8f0;
    display: grid; place-items: center;
    font-size: 32px;
  }
  .wa-empty h2 { margin: 0 0 8px; color: #111b21; font-size: 1.15rem; }
  .wa-empty p { margin: 0; font-size: 14px; line-height: 1.5; }

  /* Nested card under list — remove double chrome */
  body.nesher-wa-page .container > .card > .card {
    box-shadow: none !important;
    border-radius: 0 !important;
    padding: 0 !important;
    border: none !important;
  }

  /* ── Chat detail ── */
  body.nesher-wa-chat .container { max-width: 900px !important; }
  body.nesher-wa-chat .wa-chat-shell {
    display: flex;
    flex-direction: column;
    min-height: 70vh;
    background: #efeae2;
    background-image:
      radial-gradient(circle at 20% 20%, rgba(7,94,84,0.04) 0, transparent 40%),
      radial-gradient(circle at 80% 80%, rgba(37,211,102,0.05) 0, transparent 45%);
  }
  body.nesher-wa-chat .wa-chat-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: #075e54;
    color: #fff;
  }
  body.nesher-wa-chat .wa-chat-header a.wa-back {
    color: #fff;
    text-decoration: none;
    font-size: 20px;
    line-height: 1;
    padding: 4px 8px;
    border-radius: 8px;
  }
  body.nesher-wa-chat .wa-chat-header a.wa-back:hover { background: rgba(255,255,255,0.12); }
  body.nesher-wa-chat .wa-chat-header .wa-title { font-weight: 700; font-size: 16px; }
  body.nesher-wa-chat .wa-chat-header .wa-sub { font-size: 12px; opacity: 0.85; }

  /* Message bubbles — style common patterns + our marked nodes */
  body.nesher-wa-chat .wa-messages,
  body.nesher-wa-chat .messages-thread,
  body.nesher-wa-chat .chat-messages,
  body.nesher-wa-chat .message-list {
    flex: 1;
    padding: 16px 12px 24px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  body.nesher-wa-chat .wa-bubble,
  body.nesher-wa-chat .message-bubble,
  body.nesher-wa-chat .chat-bubble,
  body.nesher-wa-chat .msg {
    max-width: min(78%, 520px);
    padding: 8px 10px 6px;
    border-radius: 10px;
    font-size: 14.5px;
    line-height: 1.4;
    position: relative;
    box-shadow: 0 1px 0.5px rgba(11,20,26,0.13);
    word-wrap: break-word;
  }
  body.nesher-wa-chat .wa-bubble.inbound,
  body.nesher-wa-chat .message-bubble.inbound,
  body.nesher-wa-chat .msg.inbound,
  body.nesher-wa-chat .msg-in,
  body.nesher-wa-chat .from-customer {
    align-self: flex-start;
    background: #fff;
    color: #111b21;
    border-top-left-radius: 0;
  }
  body.nesher-wa-chat .wa-bubble.outbound,
  body.nesher-wa-chat .message-bubble.outbound,
  body.nesher-wa-chat .msg.outbound,
  body.nesher-wa-chat .msg-out,
  body.nesher-wa-chat .from-agent,
  body.nesher-wa-chat .from-staff {
    align-self: flex-end;
    background: #d9fdd3;
    color: #111b21;
    border-top-right-radius: 0;
  }

  /* Generic table-free message blocks on detail pages */
  body.nesher-wa-chat .card .message,
  body.nesher-wa-chat article.message {
    max-width: min(78%, 520px);
    margin: 6px 12px !important;
    padding: 8px 12px !important;
    border-radius: 10px !important;
    box-shadow: 0 1px 0.5px rgba(11,20,26,0.13);
  }

  /* Composer */
  body.nesher-wa-chat .wa-composer,
  body.nesher-wa-chat form.reply-form,
  body.nesher-wa-chat .reply-box,
  body.nesher-wa-chat .composer {
    display: flex;
    gap: 8px;
    align-items: flex-end;
    padding: 10px 12px;
    background: #f0f2f5;
    border-top: 1px solid #e9edef;
  }
  body.nesher-wa-chat textarea,
  body.nesher-wa-chat input[type="text"].message-input,
  body.nesher-wa-chat .composer textarea,
  body.nesher-wa-chat form.reply-form textarea {
    flex: 1;
    border: none !important;
    border-radius: 12px !important;
    padding: 12px 14px !important;
    font-size: 15px !important;
    min-height: 44px;
    max-height: 140px;
    resize: vertical;
    background: #fff !important;
    box-shadow: inset 0 0 0 1px #e9edef;
    font-family: inherit;
  }
  body.nesher-wa-chat textarea:focus,
  body.nesher-wa-chat form.reply-form textarea:focus {
    outline: none;
    box-shadow: inset 0 0 0 2px #25d366 !important;
  }
  body.nesher-wa-chat button[type="submit"],
  body.nesher-wa-chat .send-btn {
    background: #25d366 !important;
    color: #fff !important;
    border: none !important;
    border-radius: 999px !important;
    width: 48px;
    height: 48px;
    min-width: 48px;
    font-weight: 700 !important;
    cursor: pointer;
    box-shadow: 0 2px 6px rgba(37, 211, 102, 0.35);
  }
  body.nesher-wa-chat button[type="submit"]:hover,
  body.nesher-wa-chat .send-btn:hover {
    background: #1ebe57 !important;
  }

  /* Live thread overlay (API-driven, plays audio + send voice) */
  .wa-live-thread {
    display: flex;
    flex-direction: column;
    min-height: 62vh;
    background: #efeae2;
  }
  .wa-live-msgs {
    flex: 1;
    overflow-y: auto;
    padding: 14px 12px 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .wa-live-bubble {
    max-width: min(78%, 520px);
    padding: 8px 10px 4px;
    border-radius: 10px;
    font-size: 14.5px;
    line-height: 1.4;
    box-shadow: 0 1px 0.5px rgba(11,20,26,0.13);
    word-wrap: break-word;
  }
  .wa-live-bubble.in {
    align-self: flex-start;
    background: #fff;
    border-top-left-radius: 0;
  }
  .wa-live-bubble.out {
    align-self: flex-end;
    background: #d9fdd3;
    border-top-right-radius: 0;
  }
  .wa-live-bubble .wa-ts {
    display: block;
    text-align: right;
    font-size: 11px;
    color: #667781;
    margin-top: 4px;
  }
  .wa-live-bubble audio {
    display: block;
    width: min(260px, 70vw);
    margin: 4px 0 2px;
    height: 36px;
  }
  .wa-voice-label {
    font-size: 12px;
    color: #54656f;
    margin-bottom: 2px;
  }
  .wa-live-composer {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: #f0f2f5;
    border-top: 1px solid #e9edef;
  }
  .wa-mic-btn, .wa-file-btn {
    width: 46px;
    height: 46px;
    border: none;
    border-radius: 50%;
    background: #075e54;
    color: #fff;
    font-size: 18px;
    cursor: pointer;
    flex-shrink: 0;
    display: grid;
    place-items: center;
  }
  .wa-mic-btn.recording {
    background: #dc2626;
    animation: wa-pulse 1s infinite;
  }
  @keyframes wa-pulse {
    0% { box-shadow: 0 0 0 0 rgba(220,38,38,0.45); }
    70% { box-shadow: 0 0 0 12px rgba(220,38,38,0); }
    100% { box-shadow: 0 0 0 0 rgba(220,38,38,0); }
  }
  .wa-mic-btn:disabled, .wa-file-btn:disabled { opacity: 0.55; cursor: wait; }
  .wa-rec-status {
    flex: 1;
    font-size: 13px;
    color: #54656f;
    min-width: 0;
  }
  .wa-rec-status strong { color: #dc2626; }
  .wa-live-error {
    color: #b91c1c;
    font-size: 12px;
    padding: 0 12px 8px;
    background: #f0f2f5;
  }
  .wa-live-hint {
    font-size: 11px;
    color: #8696a0;
    padding: 0 12px 10px;
    background: #f0f2f5;
  }

  /* Warning banners keep readable */
  body.nesher-wa-page .message.warning,
  body.nesher-wa-page .message.error,
  body.nesher-wa-page .message.success,
  body.nesher-wa-page .message.info {
    margin: 12px 16px !important;
    border-radius: 10px !important;
  }

  @media (max-width: 640px) {
    body.nesher-wa-page .container { margin-top: 8px !important; padding: 0 0 24px !important; }
    body.nesher-wa-page .container > .card { border-radius: 0 !important; border-left: none; border-right: none; }
    .wa-chat-row { grid-template-columns: 48px 1fr auto; padding: 12px; }
    .wa-avatar { width: 46px; height: 46px; font-size: 0.95rem; }
  }
</style>
`;

const SCRIPT = `
<script id="${WA_UI_MARKER}-js">
(function () {
  if (window.__nesherWaUiBound) return;
  window.__nesherWaUiBound = true;

  function initials(name, phone) {
    var s = (name || "").trim();
    if (s && s.toLowerCase() !== "unknown") {
      var parts = s.split(/\\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return s.slice(0, 2).toUpperCase();
    }
    var p = (phone || "").replace(/\\D/g, "");
    return p.slice(-2) || "WA";
  }
  function tone(str) {
    var n = 0;
    str = String(str || "");
    for (var i = 0; i < str.length; i++) n = (n + str.charCodeAt(i) * (i + 1)) % 6;
    return String(n);
  }
  function shortTime(raw) {
    if (!raw) return "";
    // "Aug 04, 2026 22:27" style
    var m = String(raw).match(/(\\d{1,2}):(\\d{2})\\s*(AM|PM)?/i);
    if (m) {
      if (m[3]) return m[1] + ":" + m[2] + " " + m[3].toUpperCase();
      var h = parseInt(m[1], 10), min = m[2];
      var ap = h >= 12 ? "PM" : "AM";
      h = h % 12; if (!h) h = 12;
      return h + ":" + min + " " + ap;
    }
    return String(raw).replace(/,\\s*\\d{4}/, "");
  }

  function enhanceInbox() {
    var path = location.pathname.replace(/\\/+$/, "") || "/";
    if (path !== "/whatsapp") return false;

    document.body.classList.add("nesher-wa-page");

    var header = document.querySelector(".page-header");
    if (header && !header.querySelector(".wa-status-pill")) {
      var pill = document.createElement("span");
      pill.className = "wa-status-pill";
      pill.innerHTML = '<span class="dot"></span> Cloud API live · +972 2-966-5999';
      header.appendChild(pill);
    }
    if (header) {
      var muted = header.querySelector(".muted, p");
      if (muted) muted.textContent = "Shared team inbox — tap a chat to reply within the 24h window.";
    }

    var table = document.querySelector(".container table");
    if (!table) {
      // empty state already may show
      var emptyHost = document.querySelector(".container .card:last-of-type");
      if (emptyHost && !emptyHost.querySelector(".wa-chat-list") && !emptyHost.querySelector(".wa-empty")) {
        if (/no whatsapp conversations/i.test(emptyHost.textContent || "")) {
          emptyHost.innerHTML =
            '<div class="wa-empty"><div class="wa-empty-icon">💬</div>' +
            "<h2>No conversations yet</h2>" +
            "<p>When a customer messages <strong>+972 2-966-5999</strong>, the chat appears here for the whole team.</p></div>";
        }
      }
      return true;
    }

    table.classList.add("wa-source-table");
    var rows = Array.prototype.slice.call(table.querySelectorAll("tbody tr"));
    var list = document.createElement("ul");
    list.className = "wa-chat-list";
    list.setAttribute("data-" + "${WA_UI_MARKER}", "1");

    rows.forEach(function (tr) {
      var cells = tr.querySelectorAll("td");
      if (cells.length < 5) return;
      var contact = (cells[0].textContent || "").trim();
      var customer = (cells[1].textContent || "").trim();
      var phone = (cells[2].textContent || "").trim();
      var unread = parseInt((cells[3].textContent || "0").trim(), 10) || 0;
      var last = (cells[4].textContent || "").trim();
      var link = cells[cells.length - 1].querySelector("a[href*='/whatsapp/']");
      var href = link ? link.getAttribute("href") : "#";

      var a = document.createElement("a");
      a.className = "wa-chat-row" + (unread > 0 ? " is-unread" : "");
      a.href = href;

      var av = document.createElement("div");
      av.className = "wa-avatar";
      av.setAttribute("data-tone", tone(contact || phone));
      av.textContent = initials(contact, phone);

      var meta = document.createElement("div");
      meta.className = "wa-meta";
      var top = document.createElement("div");
      top.className = "wa-meta-top";
      var name = document.createElement("div");
      name.className = "wa-name";
      name.textContent = contact || phone || "Unknown";
      var time = document.createElement("div");
      time.className = "wa-time";
      time.textContent = shortTime(last);
      top.appendChild(name);
      top.appendChild(time);

      var bot = document.createElement("div");
      bot.className = "wa-meta-bottom";
      var prev = document.createElement("div");
      prev.className = "wa-preview";
      var custLabel = /not linked/i.test(customer) ? "Not linked to CRM customer" : ("Customer: " + customer);
      prev.textContent = custLabel;
      bot.appendChild(prev);
      if (unread > 0) {
        var badge = document.createElement("span");
        badge.className = "wa-badge";
        badge.textContent = String(unread);
        bot.appendChild(badge);
      }

      var phoneLine = document.createElement("div");
      phoneLine.className = "wa-phone-line";
      phoneLine.textContent = phone ? ("+" + phone.replace(/^\\+/, "")) : "";

      meta.appendChild(top);
      meta.appendChild(bot);
      if (phone) meta.appendChild(phoneLine);

      a.appendChild(av);
      a.appendChild(meta);
      // spacer col for grid balance
      var end = document.createElement("div");
      a.appendChild(end);

      var li = document.createElement("li");
      li.appendChild(a);
      list.appendChild(li);
    });

    var host = table.closest(".card") || table.parentElement;
    if (host && !host.querySelector(".wa-chat-list")) {
      host.appendChild(list);
    }
    return true;
  }

  function contactIdFromPath() {
    var m = location.pathname.match(/\\/whatsapp\\/(\\d+)\\/?/);
    return m ? m[1] : null;
  }

  function fmtTs(iso) {
    if (!iso) return "";
    try {
      var d = new Date(iso);
      return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (e) { return String(iso); }
  }

  function enhanceChat() {
    var path = location.pathname.replace(/\\/+$/, "");
    if (!/^\\/whatsapp\\/\\d+$/.test(path)) return false;

    document.body.classList.add("nesher-wa-page", "nesher-wa-chat");

    var mainCard = document.querySelector(".container > .card") || document.querySelector(".container");
    if (!mainCard) return true;
    mainCard.classList.add("wa-chat-shell");

    // Promote page header into chat header strip
    var header = document.querySelector(".page-header");
    if (header && !document.querySelector(".wa-chat-header")) {
      var bar = document.createElement("div");
      bar.className = "wa-chat-header";
      var back = document.createElement("a");
      back.className = "wa-back";
      back.href = "/whatsapp/";
      back.setAttribute("aria-label", "Back to inbox");
      back.textContent = "\\u00AB";
      var titles = document.createElement("div");
      var h = header.querySelector("h1");
      var t = document.createElement("div");
      t.className = "wa-title";
      t.textContent = (h && h.textContent) || "Chat";
      var sub = document.createElement("div");
      sub.className = "wa-sub";
      var muted = header.querySelector(".muted, p");
      sub.textContent = (muted && muted.textContent) || "WhatsApp · voice + text · 24h reply window";
      titles.appendChild(t);
      titles.appendChild(sub);
      bar.appendChild(back);
      bar.appendChild(titles);
      mainCard.insertBefore(bar, mainCard.firstChild);
      header.style.display = "none";
    }

    // Mark direction classes when Django uses data attributes or keywords
    document.querySelectorAll("[data-direction], .message, .msg, .chat-message, article").forEach(function (el) {
      var d = (el.getAttribute("data-direction") || el.className || "").toLowerCase();
      var text = (el.textContent || "").slice(0, 40).toLowerCase();
      if (/outbound|outgoing|sent|agent|staff|you:/.test(d + " " + text)) el.classList.add("outbound");
      if (/inbound|incoming|received|customer|them:/.test(d + " " + text)) el.classList.add("inbound");
    });

    // Composer form: last form with textarea
    var forms = document.querySelectorAll("form");
    forms.forEach(function (f) {
      if (f.querySelector("textarea") || f.querySelector('input[name="body"], input[name="text"], input[name="message"]')) {
        f.classList.add("reply-form", "wa-composer");
      }
    });

    // Live thread with audio play + send (API)
    mountLiveThread(mainCard, contactIdFromPath());

    return true;
  }

  function mountLiveThread(mainCard, contactId) {
    if (!contactId || mainCard.querySelector(".wa-live-thread")) return;

    var shell = document.createElement("div");
    shell.className = "wa-live-thread";
    shell.innerHTML =
      '<div class="wa-live-msgs" data-role="msgs"><div class="wa-rec-status" style="padding:16px">Loading messages…</div></div>' +
      '<div class="wa-live-error" data-role="err" hidden></div>' +
      '<div class="wa-live-composer">' +
      '  <button type="button" class="wa-file-btn" data-role="file" title="Attach audio file">📎</button>' +
      '  <input type="file" accept="audio/*,.ogg,.mp3,.m4a,.aac,.webm" data-role="file-input" hidden>' +
      '  <div class="wa-rec-status" data-role="status">Hold mic to record a voice note, or attach an audio file.</div>' +
      '  <button type="button" class="wa-mic-btn" data-role="mic" title="Record voice note">🎤</button>' +
      "</div>" +
      '<div class="wa-live-hint">Voice notes are sent as WhatsApp voice (OGG/Opus). Inbound audio plays here.</div>';

    // Insert after chat header if present
    var headerEl = mainCard.querySelector(".wa-chat-header");
    if (headerEl && headerEl.nextSibling) {
      mainCard.insertBefore(shell, headerEl.nextSibling);
    } else {
      mainCard.appendChild(shell);
    }

    var msgsEl = shell.querySelector('[data-role="msgs"]');
    var errEl = shell.querySelector('[data-role="err"]');
    var statusEl = shell.querySelector('[data-role="status"]');
    var micBtn = shell.querySelector('[data-role="mic"]');
    var fileBtn = shell.querySelector('[data-role="file"]');
    var fileInput = shell.querySelector('[data-role="file-input"]');
    var recorder = null;
    var chunks = [];
    var recording = false;

    function showErr(msg) {
      if (!msg) { errEl.hidden = true; errEl.textContent = ""; return; }
      errEl.hidden = false;
      errEl.textContent = msg;
    }

    function renderMessages(payload) {
      var list = (payload && payload.messages) || [];
      msgsEl.innerHTML = "";
      if (!list.length) {
        msgsEl.innerHTML = '<div class="wa-rec-status" style="padding:20px;text-align:center">No messages yet in this chat.</div>';
        return;
      }
      list.forEach(function (m) {
        var b = document.createElement("div");
        b.className = "wa-live-bubble " + (m.direction === "outbound" ? "out" : "in");
        if (m.messageType === "audio") {
          var label = document.createElement("div");
          label.className = "wa-voice-label";
          label.textContent = m.voice || /voice/i.test(m.body || "") ? "🎤 Voice note" : "🔊 Audio";
          b.appendChild(label);
          if (m.mediaId) {
            var audio = document.createElement("audio");
            audio.controls = true;
            audio.preload = "none";
            audio.src = "/__nesher_wa/media/" + encodeURIComponent(m.mediaId) + "/";
            b.appendChild(audio);
          } else {
            var p = document.createElement("div");
            p.textContent = m.body || "[audio]";
            b.appendChild(p);
          }
        } else {
          var text = document.createElement("div");
          text.textContent = m.body || "";
          b.appendChild(text);
        }
        var ts = document.createElement("span");
        ts.className = "wa-ts";
        ts.textContent = fmtTs(m.messageAt) + (m.status && m.direction === "outbound" ? " · " + m.status : "");
        b.appendChild(ts);
        msgsEl.appendChild(b);
      });
      msgsEl.scrollTop = msgsEl.scrollHeight;

      if (payload.contact && payload.contact.name) {
        var title = document.querySelector(".wa-chat-header .wa-title");
        if (title) title.textContent = payload.contact.name;
        var sub = document.querySelector(".wa-chat-header .wa-sub");
        if (sub && payload.contact.phone) sub.textContent = "+" + String(payload.contact.phone).replace(/^\\+/, "") + " · WhatsApp";
      }
      if (payload.whatsappConfigured === false) {
        showErr("WhatsApp token not configured on proxy — set WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID.");
      }
    }

    async function refresh() {
      try {
        var res = await fetch("/__nesher_wa/contact/" + contactId + "/messages/", {
          credentials: "same-origin",
          headers: { Accept: "application/json" }
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        showErr("");
        renderMessages(data);
      } catch (e) {
        msgsEl.innerHTML = "";
        showErr(e.message || String(e));
        statusEl.textContent = "Could not load messages (are you logged in?). Django thread still below if present.";
      }
    }

    function blobToBase64(blob) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () {
          var s = String(r.result || "");
          var i = s.indexOf(",");
          resolve(i >= 0 ? s.slice(i + 1) : s);
        };
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
    }

    async function sendAudioBlob(blob, mime, voice) {
      showErr("");
      statusEl.innerHTML = "Sending voice note…";
      micBtn.disabled = true;
      fileBtn.disabled = true;
      try {
        var b64 = await blobToBase64(blob);
        var res = await fetch("/__nesher_wa/contact/" + contactId + "/send-audio/", {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Requested-With": "XMLHttpRequest"
          },
          body: JSON.stringify({
            audioBase64: b64,
            mimeType: mime || blob.type || "audio/webm",
            voice: voice !== false
          })
        });
        var data = await res.json().catch(function () { return {}; });
        if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
        statusEl.textContent = "Voice note sent ✓";
        await refresh();
      } catch (e) {
        showErr(e.message || String(e));
        statusEl.textContent = "Send failed — try again.";
      } finally {
        micBtn.disabled = false;
        fileBtn.disabled = false;
      }
    }

    async function startRec() {
      if (recording) return;
      showErr("");
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        var mime = "";
        var candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
        for (var i = 0; i < candidates.length; i++) {
          if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) {
            mime = candidates[i];
            break;
          }
        }
        chunks = [];
        recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
        recorder.ondataavailable = function (ev) {
          if (ev.data && ev.data.size) chunks.push(ev.data);
        };
        recorder.onstop = async function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          var type = (recorder && recorder.mimeType) || mime || "audio/webm";
          var blob = new Blob(chunks, { type: type });
          recorder = null;
          if (!blob.size) {
            statusEl.textContent = "Empty recording — try again.";
            return;
          }
          await sendAudioBlob(blob, type, true);
        };
        recorder.start();
        recording = true;
        micBtn.classList.add("recording");
        micBtn.textContent = "⏹";
        statusEl.innerHTML = "<strong>Recording…</strong> click mic again to send.";
      } catch (e) {
        showErr(e.message || "Microphone permission denied");
      }
    }

    function stopRec() {
      if (!recording || !recorder) return;
      recording = false;
      micBtn.classList.remove("recording");
      micBtn.textContent = "🎤";
      try { recorder.stop(); } catch (e) {}
    }

    micBtn.addEventListener("click", function () {
      if (recording) stopRec();
      else startRec();
    });
    fileBtn.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", async function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!f) return;
      await sendAudioBlob(f, f.type || "audio/mpeg", /ogg|opus|webm/i.test(f.type || f.name));
    });

    refresh();
    // light poll so inbound audio appears without full reload
    setInterval(function () {
      if (!document.hidden) refresh();
    }, 12000);
  }

  function run() {
    enhanceInbox();
    enhanceChat();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
</script>
`;

/**
 * @param {string} html
 * @param {string} path
 */
export function injectWhatsAppUi(html, path) {
  if (!html || typeof html !== "string") return html;
  if (html.includes(`${WA_UI_MARKER}-js`)) return html;
  if (!/^\/whatsapp(\/|$)/.test(path || "")) return html;
  if (!/<\/body>/i.test(html) && !/<html/i.test(html)) return html;

  let out = html;
  if (!out.includes(`${WA_UI_MARKER}-css`)) {
    if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, `${CSS}</head>`);
    } else {
      out = CSS + out;
    }
  }
  if (!out.includes(`${WA_UI_MARKER}-js`)) {
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, `${SCRIPT}</body>`);
    } else {
      out = out + SCRIPT;
    }
  }
  return out;
}
