/**
 * WhatsApp portal UI v2 for Nesher CRM — full WhatsApp-Web-grade redesign.
 * Injected by the pay-proxy on /whatsapp/* HTML responses.
 * Django markup is never modified server-side: the script rebuilds the page
 * client-side from the rendered DOM + the proxy JSON APIs, and keeps the
 * original forms alive (hidden or moved) so every CRM function still works.
 */

export const WA_UI_MARKER = "nesher-wa-ui";

const CSS = `
<style id="${WA_UI_MARKER}-css">
  :root {
    --wa-green: #008069;
    --wa-green-deep: #075e54;
    --wa-green-bright: #00a884;
    --wa-accent: #25d366;
    --wa-out: #d9fdd3;
    --wa-out-deep: #d1f4cc;
    --wa-chat-bg: #efeae2;
    --wa-panel: #f0f2f5;
    --wa-ink: #111b21;
    --wa-sub: #667781;
    --wa-faint: #8696a0;
    --wa-divider: #e9edef;
    --wa-read: #53bdeb;
    --wa-danger: #dc2626;
    --wa-shadow: 0 1px 3px rgba(11,20,26,0.12), 0 1px 2px rgba(11,20,26,0.06);
  }

  body.nesher-wa-page {
    background: #eef2f4 !important;
    font-family: "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif !important;
    color: var(--wa-ink);
  }
  body.nesher-wa-page #back-btn-wrap { display: none !important; }
  body.nesher-wa-page .container {
    max-width: 1080px !important;
    margin: 18px auto 28px !important;
    padding: 0 14px 20px !important;
  }
  body.nesher-wa-page .container > .card {
    padding: 0 !important;
    overflow: hidden;
    border-radius: 14px !important;
    background: #fff !important;
    border: 1px solid rgba(11,20,26,0.08);
    box-shadow: 0 4px 24px rgba(11,20,26,0.10) !important;
  }
  body.nesher-wa-page .messages .message {
    border-radius: 10px !important;
  }

  /* ══ Shared header bar ══ */
  .wa-bar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 18px;
    background: linear-gradient(135deg, var(--wa-green-deep) 0%, var(--wa-green) 60%, var(--wa-green-bright) 130%);
    color: #fff;
  }
  .wa-bar .wa-logo {
    width: 42px; height: 42px;
    border-radius: 50%;
    background: rgba(255,255,255,0.14);
    display: grid; place-items: center;
    flex-shrink: 0;
  }
  .wa-bar .wa-logo svg { width: 24px; height: 24px; display: block; }
  .wa-bar-titles { min-width: 0; flex: 1; }
  .wa-bar-title { font-size: 17px; font-weight: 700; letter-spacing: .01em; line-height: 1.2; }
  .wa-bar-sub { font-size: 12.5px; opacity: .88; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .wa-pill {
    display: inline-flex; align-items: center; gap: 7px;
    background: rgba(255,255,255,0.15);
    border: 1px solid rgba(255,255,255,0.25);
    color: #fff; font-size: 12px; font-weight: 600;
    padding: 6px 13px; border-radius: 999px; white-space: nowrap;
  }
  .wa-pill .dot { width: 8px; height: 8px; border-radius: 50%; background: #7bf1a8; box-shadow: 0 0 0 3px rgba(123,241,168,0.28); }
  .wa-pill.warn .dot { background: #fbbf24; box-shadow: 0 0 0 3px rgba(251,191,36,0.28); }

  /* ══ Inbox ══ */
  body.nesher-wa-page .search-card {
    margin: 0 !important; padding: 10px 14px !important;
    background: #f7f9fa !important;
    border-radius: 0 !important; box-shadow: none !important;
    border-bottom: 1px solid var(--wa-divider);
  }
  body.nesher-wa-page .search-card form { display: flex; gap: 8px; align-items: center; margin: 0; }
  body.nesher-wa-page .search-card input[type="text"] {
    flex: 1;
    border: none !important;
    background: var(--wa-panel) !important;
    border-radius: 999px !important;
    padding: 10px 16px 10px 42px !important;
    font-size: 14px !important;
    box-shadow: none;
    outline: none;
    color: var(--wa-ink);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='15' height='15' fill='%23667781' viewBox='0 0 16 16'%3E%3Cpath d='M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.242.656a5 5 0 1 1 0-10 5 5 0 0 1 0 10z'/%3E%3C/svg%3E") !important;
    background-repeat: no-repeat !important;
    background-position: 16px center !important;
    transition: box-shadow .15s ease, background-color .15s ease;
  }
  body.nesher-wa-page .search-card input[type="text"]:focus {
    background: #fff !important;
    box-shadow: 0 0 0 2px var(--wa-green-bright);
  }
  body.nesher-wa-page .search-card button[type="submit"] { display: none !important; }

  body.nesher-wa-page .card > table,
  body.nesher-wa-page .card table.wa-source-table { display: none !important; }
  body.nesher-wa-page .container > .card > .card {
    box-shadow: none !important; border: none !important;
    border-radius: 0 !important; padding: 0 !important;
  }

  .wa-chat-list { list-style: none; margin: 0; padding: 0; background: #fff; }
  .wa-chat-list li { margin: 0; }
  .wa-section-label {
    padding: 14px 18px 6px;
    font-size: 12px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: var(--wa-faint);
  }
  .wa-chat-row {
    display: flex; align-items: center; gap: 14px;
    padding: 11px 16px;
    text-decoration: none !important;
    color: inherit !important;
    cursor: pointer;
    transition: background .12s ease;
    position: relative;
  }
  .wa-chat-row::after {
    content: ""; position: absolute; left: 82px; right: 0; bottom: 0;
    border-bottom: 1px solid #f0f2f5;
  }
  .wa-chat-list li:last-child .wa-chat-row::after { display: none; }
  .wa-chat-row:hover { background: #f5f6f6; }
  .wa-chat-row.is-unread { background: #f2faf7; }
  .wa-chat-row.is-unread:hover { background: #e9f6f0; }
  .wa-chat-row.is-archived { opacity: .62; }

  .wa-avatar {
    width: 52px; height: 52px; border-radius: 50%;
    display: grid; place-items: center;
    font-weight: 700; font-size: 18px; color: #fff;
    background: linear-gradient(145deg, #128c7e, #075e54);
    flex-shrink: 0; letter-spacing: .02em; user-select: none;
  }
  .wa-avatar[data-tone="1"] { background: linear-gradient(145deg, #4fb6e0, #0b7ea4); }
  .wa-avatar[data-tone="2"] { background: linear-gradient(145deg, #9f7aea, #6d28d9); }
  .wa-avatar[data-tone="3"] { background: linear-gradient(145deg, #f0a24b, #d97706); }
  .wa-avatar[data-tone="4"] { background: linear-gradient(145deg, #ee7bab, #be185d); }
  .wa-avatar[data-tone="5"] { background: linear-gradient(145deg, #2fbfa8, #0f766e); }

  .wa-meta { min-width: 0; flex: 1; }
  .wa-meta-top { display: flex; align-items: baseline; gap: 10px; }
  .wa-name {
    font-size: 16px; font-weight: 600; color: var(--wa-ink);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    flex: 1; min-width: 0; unicode-bidi: plaintext; text-align: left;
  }
  .wa-time { font-size: 12px; color: var(--wa-faint); flex-shrink: 0; }
  .wa-chat-row.is-unread .wa-time { color: var(--wa-accent); font-weight: 700; }
  .wa-meta-bottom { display: flex; align-items: center; gap: 8px; margin-top: 3px; }
  .wa-preview {
    font-size: 13.5px; color: var(--wa-sub);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    flex: 1; min-width: 0; text-align: left;
    display: flex; align-items: center; gap: 5px;
  }
  .wa-preview .wa-ticks { flex-shrink: 0; }
  .wa-preview-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; unicode-bidi: plaintext; }
  .wa-chat-row.is-unread .wa-preview { color: #3b4a54; font-weight: 600; }
  .wa-chip {
    flex-shrink: 0;
    font-size: 11px; font-weight: 600;
    padding: 2px 9px; border-radius: 999px;
    background: #eef2ff; color: #4f46e5;
    max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .wa-chip.unlinked { background: #f1f5f9; color: #94a3b8; }
  .wa-badge {
    min-width: 21px; height: 21px; padding: 0 6px;
    border-radius: 999px; background: var(--wa-accent); color: #fff;
    font-size: 11.5px; font-weight: 800;
    display: inline-flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .wa-empty { padding: 56px 24px; text-align: center; color: var(--wa-sub); }
  .wa-empty-icon {
    width: 76px; height: 76px; margin: 0 auto 18px; border-radius: 50%;
    background: #e7f8f0; color: var(--wa-green);
    display: grid; place-items: center;
  }
  .wa-empty-icon svg { width: 36px; height: 36px; }
  .wa-empty h2 { margin: 0 0 8px; color: var(--wa-ink); font-size: 1.15rem; }
  .wa-empty p { margin: 0; font-size: 14px; line-height: 1.55; }

  /* ══ Chat page layout ══ */
  body.nesher-wa-chat .container {
    max-width: 1320px !important;
    margin: 14px auto 14px !important;
    padding: 0 14px !important;
  }
  .wa-app {
    display: flex;
    height: calc(100vh - 158px);
    height: calc(100dvh - 158px);
    min-height: 520px;
    background: #fff;
  }
  .wa-chat-pane {
    flex: 1; min-width: 0;
    display: flex; flex-direction: column;
    position: relative;
  }

  .wa-chat-head {
    display: flex; align-items: center; gap: 12px;
    padding: 9px 14px;
    background: var(--wa-panel);
    border-bottom: 1px solid #dfe5e7;
    flex-shrink: 0;
  }
  .wa-chat-head .wa-avatar { width: 42px; height: 42px; font-size: 15px; }
  .wa-icon-btn {
    width: 40px; height: 40px; border: none; border-radius: 50%;
    background: transparent; color: #54656f; cursor: pointer;
    display: grid; place-items: center; flex-shrink: 0;
    transition: background .12s ease;
    text-decoration: none !important;
  }
  .wa-icon-btn:hover { background: rgba(11,20,26,0.08); }
  .wa-icon-btn svg { width: 22px; height: 22px; }
  .wa-icon-btn.active { background: rgba(0,128,105,0.12); color: var(--wa-green); }
  .wa-head-titles { flex: 1; min-width: 0; }
  .wa-head-name {
    font-size: 16px; font-weight: 600; color: var(--wa-ink);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    unicode-bidi: plaintext; text-align: left;
  }
  .wa-head-sub {
    font-size: 12.5px; color: var(--wa-sub); margin-top: 1px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    display: flex; align-items: center; gap: 6px;
  }
  .wa-head-sub .wa-chip { font-size: 10.5px; }

  /* Messages surface */
  .wa-msgs {
    flex: 1; overflow-y: auto;
    padding: 18px 7% 12px;
    background-color: var(--wa-chat-bg);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160' viewBox='0 0 160 160'%3E%3Cg fill='none' stroke='%230b141a' stroke-opacity='0.02' stroke-width='2' stroke-linecap='round'%3E%3Ccircle cx='24' cy='26' r='8'/%3E%3Cpath d='M96 18l9 9m0-9l-9 9'/%3E%3Cpath d='M32 108c7-9 16-9 23 0'/%3E%3Crect x='104' y='96' width='18' height='18' rx='5'/%3E%3Cpath d='M66 58h16m-8-8v16'/%3E%3Ccircle cx='134' cy='44' r='5'/%3E%3Cpath d='M14 66l7 7m0-7l-7 7'/%3E%3Cpath d='M126 140c5-6 11-6 16 0'/%3E%3Ccircle cx='58' cy='140' r='6'/%3E%3C/g%3E%3C/svg%3E");
    scroll-behavior: smooth;
    overscroll-behavior: contain;
  }
  .wa-day {
    display: flex; justify-content: center;
    margin: 14px 0 10px;
    position: sticky; top: 4px; z-index: 3;
    pointer-events: none;
  }
  .wa-day span {
    background: #ffffff;
    color: #54656f;
    font-size: 12px; font-weight: 600;
    padding: 5px 13px; border-radius: 8px;
    box-shadow: var(--wa-shadow);
    text-transform: uppercase; letter-spacing: .03em;
  }
  .wa-msg { display: flex; margin: 2px 0; }
  .wa-msg.in  { justify-content: flex-start; }
  .wa-msg.out { justify-content: flex-end; }
  .wa-msg.first { margin-top: 10px; }
  .wa-bubble {
    position: relative;
    max-width: min(72%, 560px);
    padding: 7px 9px 5px;
    border-radius: 9px;
    font-size: 14.5px; line-height: 1.42;
    color: var(--wa-ink);
    box-shadow: 0 1px 1px rgba(11,20,26,0.13);
    display: flex; flex-direction: column;
    word-break: break-word;
  }
  .wa-msg.in  .wa-bubble { background: #fff; }
  .wa-msg.out .wa-bubble { background: var(--wa-out); }
  .wa-msg.in.first  .wa-bubble { border-top-left-radius: 0; }
  .wa-msg.out.first .wa-bubble { border-top-right-radius: 0; }
  .wa-msg.in.first .wa-bubble::before {
    content: ""; position: absolute; top: 0; left: -8px;
    border-right: 8px solid #fff; border-bottom: 10px solid transparent;
  }
  .wa-msg.out.first .wa-bubble::before {
    content: ""; position: absolute; top: 0; right: -8px;
    border-left: 8px solid var(--wa-out); border-bottom: 10px solid transparent;
  }
  .wa-text { white-space: pre-wrap; unicode-bidi: plaintext; }
  .wa-text a { color: #027eb5; text-decoration: underline; word-break: break-all; }
  .wa-msg-meta {
    align-self: flex-end;
    direction: ltr;
    display: inline-flex; align-items: center; gap: 4px;
    font-size: 11px; color: var(--wa-faint);
    margin: 3px -2px -1px 10px;
    user-select: none; white-space: nowrap;
  }
  .wa-ticks svg { width: 17px; height: 12px; display: block; }
  .wa-ticks { color: var(--wa-faint); display: inline-flex; }
  .wa-ticks.read { color: var(--wa-read); }
  .wa-ticks.failed { color: var(--wa-danger); }
  .wa-ticks.pending svg { width: 13px; height: 13px; }
  .wa-msg-error {
    font-size: 12px; color: var(--wa-danger);
    margin-top: 3px;
  }
  .wa-msg.pending .wa-bubble { opacity: .82; }
  .wa-msg.failed .wa-bubble { box-shadow: 0 0 0 1px rgba(220,38,38,.4); cursor: pointer; }

  /* Agent attribution (group-chat style sender names on outbound bubbles) */
  .wa-sender { font-size: 12px; font-weight: 600; line-height: 1.25; margin-bottom: 1px; }
  .wa-sender[data-tone="1"] { color: #0b7ea4; }
  .wa-sender[data-tone="2"] { color: #6d28d9; }
  .wa-sender[data-tone="3"] { color: #d97706; }
  .wa-sender[data-tone="4"] { color: #be185d; }
  .wa-sender[data-tone="5"] { color: #0f766e; }
  .wa-preview-sender { font-weight: 600; color: #667781; margin-right: 3px; flex: none; }

  /* Voice / audio bubble */
  .wa-audio { display: flex; align-items: center; gap: 10px; min-width: 230px; padding: 3px 0 2px; }
  .wa-audio-btn {
    width: 40px; height: 40px; flex-shrink: 0;
    border: none; border-radius: 50%; cursor: pointer;
    background: var(--wa-green); color: #fff;
    display: grid; place-items: center;
    transition: transform .1s ease;
  }
  .wa-audio-btn:hover { transform: scale(1.05); }
  .wa-audio-btn:disabled { opacity: .6; cursor: wait; }
  .wa-audio-btn svg { width: 18px; height: 18px; }
  .wa-audio-mid { flex: 1; min-width: 0; }
  .wa-audio-track {
    position: relative; height: 4px; border-radius: 999px;
    background: rgba(11,20,26,0.16); cursor: pointer;
  }
  .wa-audio-fill {
    position: absolute; inset: 0 auto 0 0; width: 0%;
    border-radius: 999px; background: var(--wa-green-bright);
  }
  .wa-audio-knob {
    position: absolute; top: 50%; left: 0%;
    width: 12px; height: 12px; border-radius: 50%;
    background: var(--wa-green);
    transform: translate(-50%, -50%);
    box-shadow: 0 1px 3px rgba(11,20,26,0.3);
  }
  .wa-audio-times {
    display: flex; justify-content: space-between;
    font-size: 11px; color: var(--wa-faint); margin-top: 6px;
    direction: ltr;
  }
  .wa-audio-rate {
    border: none; border-radius: 999px; cursor: pointer;
    background: rgba(11,20,26,0.08); color: #54656f;
    font-size: 11px; font-weight: 700; padding: 4px 8px;
    flex-shrink: 0;
  }
  .wa-voice-tag {
    display: flex; align-items: center; gap: 5px;
    font-size: 11.5px; color: var(--wa-faint); margin-bottom: 1px;
  }
  .wa-voice-tag svg { width: 13px; height: 13px; }

  /* Jump-to-latest */
  .wa-jump {
    position: absolute; right: 22px; bottom: 86px; z-index: 5;
    display: none; align-items: center; gap: 7px;
    background: #fff; color: var(--wa-green);
    border: none; border-radius: 999px;
    padding: 9px 15px; font-size: 13px; font-weight: 700;
    box-shadow: 0 3px 12px rgba(11,20,26,0.24);
    cursor: pointer;
  }
  .wa-jump.show { display: inline-flex; }
  .wa-jump svg { width: 16px; height: 16px; }
  .wa-jump .wa-badge { min-width: 19px; height: 19px; }

  /* Composer */
  .wa-composer {
    display: flex; align-items: flex-end; gap: 6px;
    padding: 8px 12px;
    background: var(--wa-panel);
    border-top: 1px solid #dfe5e7;
    flex-shrink: 0;
  }
  .wa-composer .wa-icon-btn { margin-bottom: 2px; }
  .wa-input-wrap {
    flex: 1; min-width: 0;
    background: #fff; border-radius: 22px;
    padding: 5px 6px 5px 14px;
    display: flex; align-items: flex-end;
    box-shadow: inset 0 0 0 1px var(--wa-divider);
    transition: box-shadow .15s ease;
  }
  .wa-input-wrap:focus-within { box-shadow: inset 0 0 0 1px #b8dcd2; }
  .wa-input {
    flex: 1; border: none; outline: none; resize: none;
    background: transparent;
    font: 15px/1.45 inherit; font-family: inherit;
    color: var(--wa-ink);
    max-height: 132px; min-height: 24px;
    padding: 5px 0; margin: 0;
    unicode-bidi: plaintext;
  }
  .wa-send-btn {
    width: 44px; height: 44px; flex-shrink: 0;
    border: none; border-radius: 50%; cursor: pointer;
    background: var(--wa-green); color: #fff;
    display: grid; place-items: center;
    box-shadow: 0 2px 6px rgba(0,128,105,0.35);
    transition: background .12s ease, transform .1s ease;
    margin-bottom: 1px;
  }
  .wa-send-btn:hover { background: var(--wa-green-deep); transform: scale(1.04); }
  .wa-send-btn:disabled { opacity: .55; cursor: wait; transform: none; }
  .wa-send-btn svg { width: 21px; height: 21px; }
  .wa-hidden { display: none !important; }

  /* Recording state */
  .wa-rec {
    flex: 1; display: none; align-items: center; gap: 12px;
    padding: 6px 4px;
  }
  .wa-composer.recording .wa-rec { display: flex; }
  .wa-composer.recording .wa-input-wrap,
  .wa-composer.recording .wa-attach-btn,
  .wa-composer.recording .wa-send-btn:not(.wa-mic-btn) { display: none !important; }
  /* while recording the mic button IS the send-voice-note button — never hide it */
  .wa-composer.recording .wa-mic-btn { display: grid !important; }
  .wa-rec-dot {
    width: 11px; height: 11px; border-radius: 50%; background: var(--wa-danger);
    animation: wa-blink 1.1s infinite;
  }
  @keyframes wa-blink { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
  .wa-rec-timer { font-size: 15px; font-weight: 700; color: #3b4a54; font-variant-numeric: tabular-nums; min-width: 46px; }
  .wa-rec-hint { font-size: 12.5px; color: var(--wa-faint); flex: 1; }
  .wa-rec-cancel {
    border: none; background: transparent; color: var(--wa-danger);
    font-size: 13px; font-weight: 700; cursor: pointer; padding: 8px 10px;
    border-radius: 8px;
  }
  .wa-rec-cancel:hover { background: rgba(220,38,38,0.08); }

  /* Toasts */
  .wa-toasts {
    position: absolute; top: 64px; left: 50%; transform: translateX(-50%);
    z-index: 30; display: flex; flex-direction: column; gap: 8px;
    width: min(420px, 86%); pointer-events: none;
  }
  .wa-toast {
    background: #fff; border-radius: 10px;
    padding: 11px 15px; font-size: 13.5px; font-weight: 600;
    box-shadow: 0 6px 24px rgba(11,20,26,0.22);
    border-left: 4px solid var(--wa-green);
    color: var(--wa-ink);
    animation: wa-toast-in .18s ease;
  }
  .wa-toast.error { border-left-color: var(--wa-danger); color: #7f1d1d; }
  .wa-toast.warn { border-left-color: #d97706; color: #78350f; }
  @keyframes wa-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }

  /* Details drawer */
  .wa-details {
    width: 350px; flex-shrink: 0;
    border-left: 1px solid var(--wa-divider);
    background: #fff;
    display: none; flex-direction: column;
    min-height: 0;
  }
  .wa-app.details-open .wa-details { display: flex; }
  .wa-details-head {
    display: flex; align-items: center; gap: 10px;
    padding: 13px 16px;
    background: var(--wa-panel);
    border-bottom: 1px solid #dfe5e7;
    font-size: 15px; font-weight: 700; color: var(--wa-ink);
    flex-shrink: 0;
  }
  .wa-details-body { flex: 1; overflow-y: auto; padding: 16px; }
  .wa-details-body .card {
    box-shadow: none !important; border: none !important;
    padding: 0 !important; border-radius: 0 !important;
  }
  .wa-details-body h2 {
    font-size: 12px; font-weight: 700; letter-spacing: .08em;
    text-transform: uppercase; color: var(--wa-faint);
    margin: 0 0 12px;
  }
  .wa-details-body form { margin: 0 0 8px; }
  .wa-details-body .form-group { margin-bottom: 13px; }
  .wa-details-body label {
    display: block; font-size: 12.5px; font-weight: 600;
    color: var(--wa-sub); margin-bottom: 5px;
  }
  .wa-details-body input[type="text"],
  .wa-details-body select,
  .wa-details-body textarea {
    width: 100%; box-sizing: border-box;
    border: 1px solid var(--wa-divider); border-radius: 9px;
    background: #f8fafb; color: var(--wa-ink);
    padding: 9px 11px; font-size: 14px; font-family: inherit;
    outline: none;
    transition: box-shadow .15s ease, border-color .15s ease;
  }
  .wa-details-body input[type="text"]:focus,
  .wa-details-body select:focus,
  .wa-details-body textarea:focus {
    border-color: var(--wa-green-bright);
    box-shadow: 0 0 0 2px rgba(0,168,132,0.18);
    background: #fff;
  }
  .wa-details-body button[type="submit"], .wa-details-body .btn {
    background: var(--wa-green) !important; color: #fff !important;
    border: none !important; border-radius: 999px !important;
    padding: 9px 22px !important; font-size: 13.5px !important;
    font-weight: 700 !important; cursor: pointer;
  }
  .wa-details-body button[type="submit"]:hover { background: var(--wa-green-deep) !important; }
  .wa-details-body > .card > div[style] { margin-top: 20px !important; }

  /* Fallback notice */
  .wa-fallback-note {
    margin: 10px 14px; padding: 10px 14px;
    background: #fef3c7; color: #92400e;
    font-size: 13px; border-radius: 10px;
  }

  @media (max-width: 960px) {
    .wa-details {
      position: absolute; right: 0; top: 0; bottom: 0; z-index: 20;
      box-shadow: -8px 0 30px rgba(11,20,26,0.2);
      width: min(350px, 92vw);
    }
    .wa-app { position: relative; }
  }
  @media (max-width: 640px) {
    /* CRM topbar has no wrap and forces the body wider than small viewports */
    body.nesher-wa-page { overflow-x: hidden; }
    body.nesher-wa-page .topbar { padding: 8px 12px; }
    body.nesher-wa-page .topbar-inner { flex-wrap: wrap; gap: 8px; }
    body.nesher-wa-page .brand { font-size: 15px; }
    body.nesher-wa-page .navbar { padding: 6px 12px; }
    body.nesher-wa-page .container { margin: 8px auto 12px !important; padding: 0 !important; }
    body.nesher-wa-page .container > .card { border-radius: 0 !important; border-left: none; border-right: none; }
    .wa-app { height: calc(100vh - 130px); height: calc(100dvh - 130px); }
    .wa-msgs { padding: 14px 4% 10px; }
    .wa-bubble { max-width: 86%; }
    .wa-chat-row { padding: 10px 12px; gap: 11px; }
    .wa-avatar { width: 47px; height: 47px; font-size: 16px; }
    .wa-chip { display: none; }
    .wa-bar { padding: 12px 14px; }
    .wa-bar .wa-pill { display: none; }
  }
</style>
`;

const SCRIPT = `
<script id="${WA_UI_MARKER}-js">
(function () {
  "use strict";
  if (window.__nesherWaUi2) return;
  window.__nesherWaUi2 = true;

  /* ── icons (trusted static markup) ── */
  var I = {
    wa: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a9.9 9.9 0 0 0-8.6 14.9L2 22l5.3-1.4A10 10 0 1 0 12 2zm0 18.2c-1.6 0-3.1-.4-4.4-1.2l-.3-.2-3.1.8.8-3-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.6-6.1c-.3-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1-.2.3-.6.8-.8 1-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.4-3c-.3-.4 0-.5.1-.7l.4-.5c.1-.2.1-.3.2-.5s0-.4 0-.5l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.5.1-.7.3-.2.3-.9.9-.9 2.2s1 2.5 1.1 2.7c.1.2 1.9 3 4.7 4.2.7.3 1.2.5 1.6.6.7.2 1.3.2 1.8.1.6-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.6-.4z"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.4" fill="currentColor"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    clip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.4 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 1 1 5.65 5.66L9.4 17.4a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>',
    mic: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z"/><path d="M18.5 11a.9.9 0 0 0-1.8 0 4.7 4.7 0 0 1-9.4 0 .9.9 0 0 0-1.8 0 6.5 6.5 0 0 0 5.6 6.4v2.3H8.6a.9.9 0 0 0 0 1.8h6.8a.9.9 0 0 0 0-1.8h-2.5v-2.3a6.5 6.5 0 0 0 5.6-6.4z"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.4-7.5a1 1 0 0 0 0-1.8L3.4 3.6a.9.9 0 0 0-1.3 1L4 10.9l9.7 1.1L4 13.1l-1.9 6.3a.9.9 0 0 0 1.3 1z"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="5" width="3.6" height="14" rx="1"/><rect x="13.9" y="5" width="3.6" height="14" rx="1"/></svg>',
    micSm: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z"/><path d="M18.5 11a.9.9 0 0 0-1.8 0 4.7 4.7 0 0 1-9.4 0 .9.9 0 0 0-1.8 0 6.5 6.5 0 0 0 5.6 6.4v2.3H8.6a.9.9 0 0 0 0 1.8h6.8a.9.9 0 0 0 0-1.8h-2.5v-2.3a6.5 6.5 0 0 0 5.6-6.4z"/></svg>',
    down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    tick1: '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 5.7l3.1 3.1L11 2.5"/></svg>',
    tick2: '<svg viewBox="0 0 16 11" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5.7l3.1 3.1L10.5 2.5"/><path d="M6.2 8.2l.7.6L15 2.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    fail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5"/><circle cx="12" cy="16.4" r="0.4" fill="currentColor"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.8 8.8 0 0 1-3.7-.8L3 20l1.1-5.4a8 8 0 0 1-.9-3.7A8.4 8.4 0 0 1 11.7 2.6a8.5 8.5 0 0 1 9.3 8.9z"/></svg>'
  };

  /* ── tiny helpers ── */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(name, cls) {
    var s = el("span", cls || "");
    s.innerHTML = I[name] || "";
    return s;
  }
  function q(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function initials(name, phone) {
    var s = String(name || "").trim();
    if (s && s.toLowerCase() !== "unknown") {
      var parts = s.split(/\\s+/).filter(Boolean);
      if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
      return s.slice(0, 2).toUpperCase();
    }
    var p = String(phone || "").replace(/\\D/g, "");
    return p.slice(-2) || "?";
  }
  function tone(str) {
    var n = 0; str = String(str || "");
    for (var i = 0; i < str.length; i++) n = (n + str.charCodeAt(i) * (i + 1)) % 6;
    return String(n);
  }
  function fmtPhone(p) {
    p = String(p || "").replace(/\\D/g, "");
    if (!p) return "";
    if (p.indexOf("972") === 0) {
      var r = p.slice(3);
      if (r.length === 9) return "+972 " + r.slice(0, 2) + "-" + r.slice(2, 5) + "-" + r.slice(5);
      if (r.length === 8) return "+972 " + r.slice(0, 1) + "-" + r.slice(1, 4) + "-" + r.slice(4);
      return "+972 " + r;
    }
    if (p.length === 11 && p[0] === "1") {
      return "+1 (" + p.slice(1, 4) + ") " + p.slice(4, 7) + "-" + p.slice(7);
    }
    return "+" + p;
  }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function hm(d) { return d.getHours() + ":" + pad2(d.getMinutes()); }
  function dayKey(d) { return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate(); }
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  function dayLabel(d) {
    var now = new Date();
    var today = dayKey(now);
    var yest = dayKey(new Date(now.getTime() - 864e5));
    var k = dayKey(d);
    if (k === today) return "Today";
    if (k === yest) return "Yesterday";
    var lbl = DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate();
    if (d.getFullYear() !== now.getFullYear()) lbl += ", " + d.getFullYear();
    return lbl;
  }
  function listTime(d) {
    if (!d) return "";
    var now = new Date();
    var k = dayKey(d);
    if (k === dayKey(now)) return hm(d);
    if (k === dayKey(new Date(now.getTime() - 864e5))) return "Yesterday";
    if (now.getTime() - d.getTime() < 6 * 864e5) return DAYS[d.getDay()];
    var lbl = MONTHS[d.getMonth()] + " " + d.getDate();
    if (d.getFullYear() !== now.getFullYear()) lbl += ", " + d.getFullYear();
    return lbl;
  }
  function parseDt(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ":" + pad2(sec % 60);
  }
  function linkify(text) {
    var frag = document.createDocumentFragment();
    var re = /(https?:\\/\\/[^\\s<>"]+)/g;
    var last = 0, m;
    text = String(text == null ? "" : text);
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var a = el("a", "", m[1]);
      a.href = m[1];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      frag.appendChild(a);
      last = m.index + m[1].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  function ticksFor(status) {
    var s = String(status || "").toLowerCase();
    var span = el("span", "wa-ticks");
    if (s === "read") { span.classList.add("read"); span.innerHTML = I.tick2; }
    else if (s === "delivered") { span.innerHTML = I.tick2; }
    else if (s === "sent") { span.innerHTML = I.tick1; }
    else if (s === "failed" || s === "error") { span.classList.add("failed"); span.innerHTML = I.fail; }
    else if (s === "pending") { span.classList.add("pending"); span.innerHTML = I.clock; }
    else { span.innerHTML = I.tick1; }
    return span;
  }
  function isAudioMsg(m) {
    return m.messageType === "audio" || /^\\[(voice note|audio)/i.test(String(m.body || ""));
  }
  function previewFor(m) {
    if (!m) return { text: "No messages yet", voice: false };
    if (isAudioMsg(m)) return { text: m.voice !== false ? "Voice note" : "Audio", voice: true };
    return { text: String(m.body || "").replace(/\\s+/g, " ").trim(), voice: false };
  }

  /* ══════════ INBOX ══════════ */
  function enhanceInbox() {
    var path = location.pathname.replace(/\\/+$/, "") || "/";
    if (path !== "/whatsapp") return false;
    document.body.classList.add("nesher-wa-page");

    var outerCard = q(".container > .card");
    var header = q(".page-header");
    if (!outerCard || !header) return true;

    /* header bar */
    var bar = el("div", "wa-bar");
    var logo = el("div", "wa-logo"); logo.innerHTML = I.wa;
    var titles = el("div", "wa-bar-titles");
    titles.appendChild(el("div", "wa-bar-title", "WhatsApp"));
    var sub = el("div", "wa-bar-sub", "Shared team inbox \\u00B7 +972 2-966-5999");
    titles.appendChild(sub);
    var pill = el("span", "wa-pill");
    pill.appendChild(el("span", "dot"));
    pill.appendChild(document.createTextNode("Cloud API live"));
    bar.appendChild(logo); bar.appendChild(titles); bar.appendChild(pill);
    outerCard.insertBefore(bar, outerCard.firstChild);
    header.style.display = "none";

    /* seed data from the server-rendered table */
    var table = q("table", outerCard);
    var chats = [];
    if (table) {
      table.classList.add("wa-source-table");
      qa("tbody tr", table).forEach(function (tr) {
        var c = tr.querySelectorAll("td");
        if (c.length < 5) return;
        var link = tr.querySelector("a[href*='/whatsapp/']");
        var m = link && link.getAttribute("href").match(/\\/whatsapp\\/(\\d+)/);
        chats.push({
          id: m ? Number(m[1]) : 0,
          name: (c[0].textContent || "").trim(),
          customerName: /not linked/i.test(c[1].textContent || "") ? null : (c[1].textContent || "").trim(),
          phone: (c[2].textContent || "").trim(),
          unread: parseInt((c[3].textContent || "0").trim(), 10) || 0,
          archived: false,
          lastMessage: null,
          _rawTime: (c[4].textContent || "").trim()
        });
      });
    }

    var listHost = el("div");
    var innerCard = table ? (table.closest(".card") || outerCard) : q(".container > .card > .card") || outerCard;
    innerCard.appendChild(listHost);

    var searchInput = q(".search-card input[type='text']");
    var filterText = searchInput ? searchInput.value : "";

    function rowFor(chat) {
      var a = el("a", "wa-chat-row" + (chat.unread > 0 ? " is-unread" : "") + (chat.archived ? " is-archived" : ""));
      a.href = "/whatsapp/" + chat.id + "/";
      var av = el("div", "wa-avatar", initials(chat.name, chat.phone));
      av.setAttribute("data-tone", tone(chat.name || chat.phone));
      var meta = el("div", "wa-meta");
      var top = el("div", "wa-meta-top");
      top.appendChild(el("div", "wa-name", chat.name || fmtPhone(chat.phone) || "Unknown"));
      var when = chat.lastMessage ? listTime(parseDt(chat.lastMessage.messageAt)) : shortRaw(chat._rawTime);
      top.appendChild(el("div", "wa-time", when));
      var bot = el("div", "wa-meta-bottom");
      var prev = el("div", "wa-preview");
      var p = previewFor(chat.lastMessage);
      if (chat.lastMessage && chat.lastMessage.direction === "outbound") {
        prev.appendChild(ticksFor(chat.lastMessage.status));
        if (chat.lastMessage.sentBy) {
          prev.appendChild(el("span", "wa-preview-sender", String(chat.lastMessage.sentBy).split(" ")[0] + ":"));
        }
      }
      if (p.voice) prev.appendChild(icon("micSm", "wa-ticks"));
      var pt = el("span", "wa-preview-text", p.text || (chat.lastMessage ? "" : fmtPhone(chat.phone)));
      prev.appendChild(pt);
      bot.appendChild(prev);
      var chip = chat.customerName
        ? el("span", "wa-chip", chat.customerName)
        : el("span", "wa-chip unlinked", "Not linked");
      bot.appendChild(chip);
      if (chat.unread > 0) bot.appendChild(el("span", "wa-badge", String(chat.unread)));
      meta.appendChild(top); meta.appendChild(bot);
      a.appendChild(av); a.appendChild(meta);
      var li = el("li"); li.appendChild(a);
      return li;
    }
    function shortRaw(raw) {
      if (!raw) return "";
      var d = new Date(raw);
      return isNaN(d.getTime()) ? String(raw).replace(/,\\s*\\d{4}/, "") : listTime(d);
    }
    function matches(chat, f) {
      if (!f) return true;
      f = f.toLowerCase();
      return [chat.name, chat.phone, chat.customerName, chat.lastMessage && chat.lastMessage.body]
        .some(function (v) { return v && String(v).toLowerCase().indexOf(f) >= 0; });
    }
    function render() {
      listHost.innerHTML = "";
      var live = chats.filter(function (c) { return !c.archived && matches(c, filterText); });
      var arch = chats.filter(function (c) { return c.archived && matches(c, filterText); });
      if (!chats.length || (!live.length && !arch.length)) {
        var empty = el("div", "wa-empty");
        var ic = el("div", "wa-empty-icon"); ic.innerHTML = I.chat;
        empty.appendChild(ic);
        if (!chats.length) {
          empty.appendChild(el("h2", "", "No conversations yet"));
          var pEl = el("p");
          pEl.appendChild(document.createTextNode("When a customer messages "));
          var st = el("strong", "", "+972 2-966-5999");
          pEl.appendChild(st);
          pEl.appendChild(document.createTextNode(", the chat appears here for the whole team."));
          empty.appendChild(pEl);
        } else {
          empty.appendChild(el("h2", "", "No chats found"));
          empty.appendChild(el("p", "", 'Nothing matches "' + filterText + '".'));
        }
        listHost.appendChild(empty);
        return;
      }
      var ul = el("ul", "wa-chat-list");
      live.forEach(function (c) { ul.appendChild(rowFor(c)); });
      if (arch.length) {
        var lbl = el("li"); lbl.appendChild(el("div", "wa-section-label", "Archived"));
        ul.appendChild(lbl);
        arch.forEach(function (c) { ul.appendChild(rowFor(c)); });
      }
      listHost.appendChild(ul);
      var unreadTotal = chats.reduce(function (s, c) { return s + (c.unread || 0); }, 0);
      sub.textContent = "Shared team inbox \\u00B7 +972 2-966-5999 \\u00B7 " +
        chats.length + (chats.length === 1 ? " chat" : " chats") +
        (unreadTotal ? " \\u00B7 " + unreadTotal + " unread" : "");
    }
    render();

    if (searchInput) {
      searchInput.setAttribute("placeholder", "Search or filter chats");
      searchInput.addEventListener("input", function () {
        filterText = searchInput.value.trim();
        render();
      });
      document.addEventListener("keydown", function (ev) {
        if (ev.key === "/" && document.activeElement !== searchInput &&
            !/input|textarea|select/i.test((document.activeElement || {}).tagName || "")) {
          ev.preventDefault();
          searchInput.focus();
        }
      });
    }

    function refreshInbox() {
      fetch("/__nesher_wa/inbox/", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data || !data.ok || !data.chats) return;
          chats = data.chats;
          if (data.whatsappConfigured === false) {
            pill.classList.add("warn");
            pill.lastChild.textContent = "API not configured";
          }
          render();
        })
        .catch(function () {});
    }
    refreshInbox();
    setInterval(function () { if (!document.hidden) refreshInbox(); }, 15000);
    return true;
  }

  /* ══════════ CHAT ══════════ */
  function enhanceChat() {
    var m = location.pathname.match(/^\\/whatsapp\\/(\\d+)\\/?$/);
    if (!m) return false;
    var contactId = m[1];
    document.body.classList.add("nesher-wa-page", "nesher-wa-chat");

    var outerCard = q(".container > .card");
    var header = q(".page-header");
    var grid = outerCard && q(":scope > div[style*='grid-template-columns']", outerCard);
    var innerCards = grid ? qa(":scope > .card", grid) : [];
    var replyForm = outerCard && q("form[action$='/reply/']", outerCard);
    if (!outerCard || !header || !grid || innerCards.length < 2 || !replyForm) {
      // Unexpected markup: leave the Django page usable, just add a notice.
      if (outerCard) {
        var note = el("div", "wa-fallback-note",
          "WhatsApp UI could not attach to this page layout \\u2014 showing the basic view.");
        outerCard.insertBefore(note, outerCard.firstChild);
      }
      return true;
    }

    /* extract contact info from the Django header */
    var nameEl = q("strong", header);
    var contactName = (nameEl && nameEl.textContent.trim()) || "Chat";
    var phoneMatch = (header.textContent || "").match(/\\((\\d{6,16})\\)/);
    var contactPhone = phoneMatch ? phoneMatch[1] : "";
    var custLink = q("a[href*='/customers/']", header);
    var notLinked = /not linked to a customer/i.test(header.textContent || "");

    /* build layout */
    var app = el("div", "wa-app");
    var pane = el("section", "wa-chat-pane");
    var details = el("aside", "wa-details");
    app.appendChild(pane); app.appendChild(details);
    outerCard.insertBefore(app, outerCard.firstChild);
    header.style.display = "none";
    grid.style.display = "none";

    /* details drawer: move the Django settings/activity card in */
    var dHead = el("div", "wa-details-head");
    var dClose = el("button", "wa-icon-btn");
    dClose.type = "button"; dClose.innerHTML = I.close;
    dClose.setAttribute("aria-label", "Close details");
    dHead.appendChild(dClose);
    dHead.appendChild(el("span", "", "Contact info"));
    var dBody = el("div", "wa-details-body");
    dBody.appendChild(innerCards[1]);
    details.appendChild(dHead); details.appendChild(dBody);

    var DETAILS_KEY = "nesherWaDetailsOpen";
    function setDetails(open) {
      app.classList.toggle("details-open", open);
      infoBtn.classList.toggle("active", open);
      try { localStorage.setItem(DETAILS_KEY, open ? "1" : "0"); } catch (e) {}
    }

    /* chat header */
    var head = el("div", "wa-chat-head");
    var back = el("a", "wa-icon-btn");
    back.href = "/whatsapp/";
    back.innerHTML = I.back;
    back.setAttribute("aria-label", "Back to inbox");
    var av = el("div", "wa-avatar", initials(contactName, contactPhone));
    av.setAttribute("data-tone", tone(contactName || contactPhone));
    var ht = el("div", "wa-head-titles");
    var hName = el("div", "wa-head-name", contactName);
    var hSub = el("div", "wa-head-sub");
    var hPhone = el("span", "", fmtPhone(contactPhone));
    hSub.appendChild(hPhone);
    if (custLink) {
      var cc = el("a", "wa-chip", custLink.textContent.trim() || "Customer");
      cc.href = custLink.getAttribute("href");
      hSub.appendChild(cc);
    } else if (notLinked) {
      hSub.appendChild(el("span", "wa-chip unlinked", "Not linked"));
    }
    ht.appendChild(hName); ht.appendChild(hSub);
    var infoBtn = el("button", "wa-icon-btn");
    infoBtn.type = "button"; infoBtn.innerHTML = I.info;
    infoBtn.setAttribute("aria-label", "Contact details");
    infoBtn.title = "Contact details";
    head.appendChild(back); head.appendChild(av); head.appendChild(ht); head.appendChild(infoBtn);
    pane.appendChild(head);

    infoBtn.addEventListener("click", function () { setDetails(!app.classList.contains("details-open")); });
    dClose.addEventListener("click", function () { setDetails(false); });
    try { if (localStorage.getItem(DETAILS_KEY) === "1") setDetails(true); } catch (e) {}

    /* toasts */
    var toasts = el("div", "wa-toasts");
    pane.appendChild(toasts);
    function toast(msg, kind) {
      var t = el("div", "wa-toast" + (kind ? " " + kind : ""), msg);
      toasts.appendChild(t);
      setTimeout(function () { t.remove(); }, 5200);
    }

    /* surface Django one-shot banners (e.g. after Save Contact) as toasts */
    qa(".messages .message").forEach(function (b) {
      var kind = b.classList.contains("error") ? "error" : b.classList.contains("warning") ? "warn" : "";
      var txt = (b.textContent || "").trim();
      if (txt) toast(txt, kind);
      b.style.display = "none";
    });

    /* messages surface */
    var msgs = el("div", "wa-msgs");
    pane.appendChild(msgs);
    var jump = el("button", "wa-jump");
    jump.type = "button";
    jump.innerHTML = I.down;
    var jumpBadge = el("span", "wa-badge wa-hidden", "0");
    jump.appendChild(jumpBadge);
    pane.appendChild(jump);

    function nearBottom() {
      return msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 90;
    }
    function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }
    var unseen = 0;
    jump.addEventListener("click", function () {
      scrollBottom(); unseen = 0;
      jump.classList.remove("show"); jumpBadge.classList.add("wa-hidden");
    });
    msgs.addEventListener("scroll", function () {
      if (nearBottom()) {
        unseen = 0;
        jump.classList.remove("show"); jumpBadge.classList.add("wa-hidden");
      } else {
        jump.classList.add("show");
      }
    });

    /* audio players — one at a time */
    var currentAudio = null;
    function audioBubbleBody(mUi) {
      var wrap = el("div");
      if (mUi.voice !== false) {
        var tag = el("div", "wa-voice-tag");
        tag.appendChild(icon("micSm"));
        tag.appendChild(document.createTextNode("Voice note"));
        wrap.appendChild(tag);
      }
      if (!mUi.mediaId) {
        wrap.appendChild(el("div", "wa-text", mUi.body || "[audio]"));
        return wrap;
      }
      var box = el("div", "wa-audio");
      var btn = el("button", "wa-audio-btn");
      btn.type = "button"; btn.innerHTML = I.play;
      var mid = el("div", "wa-audio-mid");
      var track = el("div", "wa-audio-track");
      var fill = el("div", "wa-audio-fill");
      var knob = el("div", "wa-audio-knob");
      track.appendChild(fill); track.appendChild(knob);
      var times = el("div", "wa-audio-times");
      var tCur = el("span", "", "0:00");
      var tTot = el("span", "", "\\u2013:\\u2013\\u2013");
      times.appendChild(tCur); times.appendChild(tTot);
      mid.appendChild(track); mid.appendChild(times);
      var rate = el("button", "wa-audio-rate wa-hidden", "1\\u00D7");
      rate.type = "button";
      box.appendChild(btn); box.appendChild(mid); box.appendChild(rate);
      wrap.appendChild(box);

      var audio = null;
      var rates = [1, 1.5, 2];
      var ri = 0;
      function setProgress(p) {
        p = Math.max(0, Math.min(1, p || 0));
        fill.style.width = (p * 100) + "%";
        knob.style.left = (p * 100) + "%";
      }
      function ensureAudio() {
        if (audio) return audio;
        audio = new Audio();
        audio.preload = "metadata";
        audio.src = "/__nesher_wa/media/" + encodeURIComponent(mUi.mediaId) + "/";
        audio.addEventListener("loadedmetadata", function () {
          if (isFinite(audio.duration)) tTot.textContent = fmtClock(audio.duration);
          rate.classList.remove("wa-hidden");
        });
        audio.addEventListener("timeupdate", function () {
          tCur.textContent = fmtClock(audio.currentTime);
          if (isFinite(audio.duration) && audio.duration > 0) setProgress(audio.currentTime / audio.duration);
        });
        audio.addEventListener("ended", function () {
          btn.innerHTML = I.play; setProgress(0); tCur.textContent = "0:00";
        });
        audio.addEventListener("pause", function () { btn.innerHTML = I.play; });
        audio.addEventListener("play", function () {
          if (currentAudio && currentAudio !== audio) currentAudio.pause();
          currentAudio = audio;
          btn.innerHTML = I.pause;
        });
        audio.addEventListener("error", function () {
          btn.disabled = false;
          tTot.textContent = "error";
        });
        return audio;
      }
      btn.addEventListener("click", function () {
        var a = ensureAudio();
        if (a.paused) { a.play().catch(function () { tTot.textContent = "error"; }); }
        else a.pause();
      });
      track.addEventListener("click", function (ev) {
        var a = ensureAudio();
        if (!isFinite(a.duration) || !a.duration) return;
        var r = track.getBoundingClientRect();
        a.currentTime = ((ev.clientX - r.left) / r.width) * a.duration;
      });
      rate.addEventListener("click", function () {
        ri = (ri + 1) % rates.length;
        rate.textContent = String(rates[ri]).replace(".5", ".5") + "\\u00D7";
        if (audio) audio.playbackRate = rates[ri];
      });
      return wrap;
    }

    /* thread rendering — append-only diff so audio playback survives polls */
    var rendered = {};       // id -> {node, status, tickEl}
    var lastDayK = null;
    var lastDir = null;
    var lastOutSender = null;
    var firstLoad = true;

    function buildMsg(mUi) {
      var d = parseDt(mUi.messageAt) || new Date();
      var k = dayKey(d);
      if (k !== lastDayK) {
        var div = el("div", "wa-day");
        div.appendChild(el("span", "", dayLabel(d)));
        msgs.appendChild(div);
        lastDayK = k;
        lastDir = null;
        lastOutSender = null;
      }
      var dir = mUi.direction === "outbound" ? "out" : "in";
      var isRunStart = dir !== lastDir;
      var row = el("div", "wa-msg " + dir + (isRunStart ? " first" : ""));
      lastDir = dir;
      var bub = el("div", "wa-bubble");
      if (dir === "out" && mUi.sentBy && (isRunStart || mUi.sentBy !== lastOutSender)) {
        var sender = el("div", "wa-sender", mUi.sentBy);
        sender.setAttribute("data-tone", tone(mUi.sentBy));
        bub.appendChild(sender);
      }
      if (dir === "out") lastOutSender = mUi.sentBy || lastOutSender;
      if (isAudioMsg(mUi)) {
        bub.appendChild(audioBubbleBody(mUi));
      } else {
        var txt = el("div", "wa-text");
        txt.appendChild(linkify(mUi.body || ""));
        bub.appendChild(txt);
      }
      var meta = el("span", "wa-msg-meta");
      meta.appendChild(el("span", "", hm(d)));
      var tickEl = null;
      if (dir === "out") {
        tickEl = ticksFor(mUi.status);
        meta.appendChild(tickEl);
      }
      bub.appendChild(meta);
      if (String(mUi.status).toLowerCase() === "failed" && mUi.error) {
        bub.appendChild(el("div", "wa-msg-error", "Not delivered: " + mUi.error));
      }
      row.appendChild(bub);
      msgs.appendChild(row);
      return { node: row, status: mUi.status, tickEl: tickEl };
    }

    function applyMessages(list, removeNodes) {
      (removeNodes || []).forEach(function (n) { if (n && n.parentNode) n.remove(); });
      var added = 0;
      list.forEach(function (mUi) {
        var key = String(mUi.id);
        var r = rendered[key];
        if (r) {
          if (r.status !== mUi.status && r.tickEl) {
            var fresh = ticksFor(mUi.status);
            r.tickEl.replaceWith(fresh);
            r.tickEl = fresh;
            r.status = mUi.status;
          }
          return;
        }
        rendered[key] = buildMsg(mUi);
        added++;
      });
      if (added) {
        if (firstLoad || nearBottom()) {
          scrollBottom();
        } else {
          unseen += added;
          jumpBadge.textContent = String(unseen);
          jumpBadge.classList.remove("wa-hidden");
          jump.classList.add("show");
        }
      }
      firstLoad = false;
    }

    var loading = el("div", "wa-empty", "Loading conversation\\u2026");
    msgs.appendChild(loading);

    var failedOnce = false;
    function refresh(removeNodes) {
      var url = "/__nesher_wa/contact/" + contactId + "/messages/" +
        (document.visibilityState === "visible" ? "?read=1" : "");
      return fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) {
            if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
            return data;
          });
        })
        .then(function (data) {
          if (loading) { loading.remove(); loading = null; }
          if (data.contact) {
            if (data.contact.name) { hName.textContent = data.contact.name; av.textContent = initials(data.contact.name, data.contact.phone); }
            if (data.contact.phone) hPhone.textContent = fmtPhone(data.contact.phone);
          }
          if (data.whatsappConfigured === false) {
            toast("WhatsApp token not configured on the proxy \\u2014 sending is disabled.", "warn");
          }
          applyMessages(data.messages || [], removeNodes);
          failedOnce = false;
        })
        .catch(function (e) {
          if (loading) { loading.textContent = "Could not load messages \\u2014 " + (e.message || e); }
          if (!failedOnce) {
            failedOnce = true;
            toast("Live thread unavailable: " + (e.message || e), "error");
          }
        });
    }

    /* pending (optimistic) bubbles */
    function addPending(bodyText, isVoice) {
      var now = new Date();
      var k = dayKey(now);
      if (k !== lastDayK) {
        var div = el("div", "wa-day");
        div.appendChild(el("span", "", dayLabel(now)));
        msgs.appendChild(div);
        lastDayK = k;
        lastDir = null;
      }
      var row = el("div", "wa-msg out pending" + (lastDir !== "out" ? " first" : ""));
      lastDir = "out";
      var bub = el("div", "wa-bubble");
      if (isVoice) {
        var tag = el("div", "wa-voice-tag");
        tag.appendChild(icon("micSm"));
        tag.appendChild(document.createTextNode("Voice note \\u2014 sending\\u2026"));
        bub.appendChild(tag);
      } else {
        var txt = el("div", "wa-text");
        txt.appendChild(linkify(bodyText));
        bub.appendChild(txt);
      }
      var meta = el("span", "wa-msg-meta");
      meta.appendChild(el("span", "", hm(now)));
      meta.appendChild(ticksFor("pending"));
      bub.appendChild(meta);
      row.appendChild(bub);
      msgs.appendChild(row);
      scrollBottom();
      return row;
    }
    function markFailed(row, reason, retryFn) {
      row.classList.remove("pending");
      row.classList.add("failed");
      var bub = q(".wa-bubble", row);
      var tick = q(".wa-ticks", row);
      if (tick) { var f = ticksFor("failed"); tick.replaceWith(f); }
      if (bub && !q(".wa-msg-error", bub)) {
        bub.appendChild(el("div", "wa-msg-error", (reason || "Not sent") + " \\u2014 tap to retry"));
      }
      row.addEventListener("click", function once() {
        row.removeEventListener("click", once);
        row.remove();
        retryFn();
      });
    }

    /* composer */
    var csrfInput = q("input[name='csrfmiddlewaretoken']", replyForm);
    var replyUrl = replyForm.getAttribute("action") || ("/whatsapp/" + contactId + "/reply/");

    var composer = el("div", "wa-composer");
    var attach = el("button", "wa-icon-btn wa-attach-btn");
    attach.type = "button"; attach.innerHTML = I.clip;
    attach.title = "Send an audio file";
    attach.setAttribute("aria-label", "Send an audio file");
    var fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = "audio/*,.ogg,.mp3,.m4a,.aac,.webm";
    fileInput.className = "wa-hidden";
    var wrap = el("div", "wa-input-wrap");
    var input = el("textarea", "wa-input");
    input.rows = 1;
    input.placeholder = "Type a message";
    wrap.appendChild(input);
    var rec = el("div", "wa-rec");
    rec.appendChild(el("span", "wa-rec-dot"));
    var recTimer = el("span", "wa-rec-timer", "0:00");
    rec.appendChild(recTimer);
    rec.appendChild(el("span", "wa-rec-hint", "Recording voice note\\u2026"));
    var recCancel = el("button", "wa-rec-cancel", "Cancel");
    recCancel.type = "button";
    rec.appendChild(recCancel);
    var micBtn = el("button", "wa-send-btn wa-mic-btn");
    micBtn.type = "button"; micBtn.innerHTML = I.mic;
    micBtn.title = "Record voice note";
    micBtn.setAttribute("aria-label", "Record voice note");
    var sendBtn = el("button", "wa-send-btn wa-hidden");
    sendBtn.type = "button"; sendBtn.innerHTML = I.send;
    sendBtn.setAttribute("aria-label", "Send");
    composer.appendChild(attach);
    composer.appendChild(fileInput);
    composer.appendChild(wrap);
    composer.appendChild(rec);
    composer.appendChild(micBtn);
    composer.appendChild(sendBtn);
    pane.appendChild(composer);

    function syncButtons() {
      var has = input.value.trim().length > 0;
      sendBtn.classList.toggle("wa-hidden", !has);
    }
    function autoGrow() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 132) + "px";
    }
    input.addEventListener("input", function () { syncButtons(); autoGrow(); });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        sendText();
      }
    });

    function sendText() {
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      syncButtons(); autoGrow();
      input.focus();
      var row = addPending(text, false);
      var fd = new FormData();
      if (csrfInput) fd.append("csrfmiddlewaretoken", csrfInput.value);
      fd.append("body", text);
      fetch(replyUrl, {
        method: "POST",
        body: fd,
        credentials: "same-origin",
        redirect: "follow",
        headers: { "X-Requested-With": "XMLHttpRequest" }
      })
        .then(function (r) {
          return r.text().then(function (html) {
            if (!r.ok && r.status !== 302) throw new Error("HTTP " + r.status);
            var em = html.match(/class="message error"[^>]*>([\\s\\S]*?)<\\/div>/);
            if (em) {
              var tmp = el("div"); tmp.innerHTML = em[1];
              throw new Error(tmp.textContent.trim() || "CRM rejected the message");
            }
            return refresh([row]);
          });
        })
        .catch(function (e) {
          toast(e.message || "Send failed", "error");
          markFailed(row, e.message, function () {
            input.value = text;
            syncButtons(); autoGrow();
            sendText();
          });
        });
    }
    sendBtn.addEventListener("click", sendText);

    /* voice + audio-file sending */
    function blobToBase64(blob) {
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () {
          var s = String(r.result || "");
          var i2 = s.indexOf(",");
          resolve(i2 >= 0 ? s.slice(i2 + 1) : s);
        };
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
    }
    function sendAudioBlob(blob, mime, isVoice) {
      var row = addPending("", true);
      micBtn.disabled = true; attach.disabled = true;
      return blobToBase64(blob)
        .then(function (b64) {
          return fetch("/__nesher_wa/contact/" + contactId + "/send-audio/", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
            body: JSON.stringify({ audioBase64: b64, mimeType: mime || blob.type || "audio/webm", voice: isVoice !== false })
          });
        })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (data) {
            if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
            return refresh([row]);
          });
        })
        .catch(function (e) {
          toast("Voice note failed: " + (e.message || e), "error");
          markFailed(row, e.message, function () { sendAudioBlob(blob, mime, isVoice); });
        })
        .then(function () { micBtn.disabled = false; attach.disabled = false; });
    }
    attach.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!f) return;
      sendAudioBlob(f, f.type || "audio/mpeg", /ogg|opus|webm/i.test(f.type || f.name));
    });

    /* recorder */
    var recorder = null, chunks = [], recStart = 0, recInterval = null, discard = false;
    function stopTracks(stream) { stream.getTracks().forEach(function (t) { t.stop(); }); }
    function startRec() {
      discard = false;
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (stream) {
          var mime = "";
          var cands = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
          for (var i2 = 0; i2 < cands.length; i2++) {
            if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(cands[i2])) { mime = cands[i2]; break; }
          }
          chunks = [];
          recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
          recorder.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
          recorder.onstop = function () {
            stopTracks(stream);
            composer.classList.remove("recording");
            micBtn.innerHTML = I.mic;
            clearInterval(recInterval);
            var type = (recorder && recorder.mimeType) || mime || "audio/webm";
            recorder = null;
            if (discard) return;
            var blob = new Blob(chunks, { type: type });
            if (!blob.size) { toast("Empty recording \\u2014 try again.", "warn"); return; }
            sendAudioBlob(blob, type, true);
          };
          recorder.start();
          recStart = Date.now();
          recTimer.textContent = "0:00";
          recInterval = setInterval(function () {
            recTimer.textContent = fmtClock((Date.now() - recStart) / 1000);
          }, 250);
          composer.classList.add("recording");
          micBtn.innerHTML = I.send;
          micBtn.title = "Send voice note";
        })
        .catch(function (e) { toast(e.message || "Microphone permission denied", "error"); });
    }
    function stopRec(cancel) {
      if (!recorder) return;
      discard = Boolean(cancel);
      try { recorder.stop(); } catch (e) {}
    }
    micBtn.addEventListener("click", function () {
      if (recorder) stopRec(false);
      else startRec();
    });
    recCancel.addEventListener("click", function () { stopRec(true); });

    /* boot + poll */
    refresh().then(function () { scrollBottom(); });
    setInterval(function () { if (!document.hidden && !recorder) refresh(); }, 5000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) refresh();
    });
    if (window.matchMedia && window.matchMedia("(min-width: 641px)").matches) {
      input.focus();
    }
    return true;
  }

  function run() {
    try {
      if (!enhanceChat()) enhanceInbox();
    } catch (e) {
      if (window.console && console.warn) console.warn("nesher-wa-ui failed:", e);
    }
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
