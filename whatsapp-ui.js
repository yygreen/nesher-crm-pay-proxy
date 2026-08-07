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

  /* Transcribe-to-English on voice notes */
  .wa-transcribe-btn {
    display: inline-flex; align-items: center; gap: 5px;
    border: none; background: transparent; color: #027eb5;
    font-size: 12px; font-weight: 600; cursor: pointer;
    padding: 3px 0 0; margin: 0;
  }
  .wa-transcribe-btn:hover { text-decoration: underline; }
  .wa-transcribe-btn:disabled { color: #8696a0; cursor: wait; text-decoration: none; }
  .wa-transcript {
    margin-top: 6px; padding: 7px 10px;
    background: rgba(11,20,26,0.05); border-left: 3px solid #027eb5;
    border-radius: 6px; font-size: 13px; color: #1f2c33; line-height: 1.45;
    direction: ltr; text-align: left; white-space: pre-wrap;
  }
  .wa-transcript .wa-transcript-label {
    display: block; font-size: 10.5px; font-weight: 700; color: #667781;
    text-transform: uppercase; letter-spacing: .04em; margin-bottom: 2px;
  }

  /* New chat (business-initiated, template) */
  .wa-newchat-btn {
    border: 1.5px solid rgba(255,255,255,0.7); background: rgba(255,255,255,0.12);
    color: #fff; font-size: 13px; font-weight: 700; border-radius: 999px;
    padding: 6px 14px; cursor: pointer; white-space: nowrap; flex: none; margin-right: 10px;
  }
  .wa-newchat-btn:hover { background: rgba(255,255,255,0.24); }
  .wa-nc-body {
    background: #f8fafb; border: 1px solid #e2e8ea; border-radius: 8px;
    padding: 8px 10px; font-size: 12.5px; color: #3b4a54; margin-bottom: 10px; line-height: 1.4;
  }
  .wa-nc-err { color: #dc2626; font-size: 12.5px; margin-bottom: 8px; min-height: 16px; }

  /* "Sign as" identity chip + picker */
  .wa-identity {
    display: inline-flex; align-items: center; gap: 5px;
    border: 1.5px solid #d1d7db; background: #fff; color: #3b4a54;
    font-size: 12.5px; font-weight: 600; border-radius: 999px;
    padding: 4px 11px; cursor: pointer; white-space: nowrap; flex: none;
  }
  .wa-identity:hover { border-color: var(--wa-green); color: var(--wa-green-deep); }
  .wa-identity.unset { border-style: dashed; color: #8696a0; }
  .wa-identity svg { width: 13px; height: 13px; }
  .wa-id-overlay {
    position: fixed; inset: 0; z-index: 60;
    background: rgba(11,20,26,0.45);
    display: flex; align-items: center; justify-content: center;
  }
  .wa-id-card {
    background: #fff; border-radius: 14px; padding: 20px 22px;
    width: min(330px, 90vw); box-shadow: 0 12px 40px rgba(11,20,26,0.3);
  }
  .wa-id-card h3 { margin: 0 0 4px; font-size: 16px; color: #111b21; }
  .wa-id-card p { margin: 0 0 12px; font-size: 12.5px; color: #667781; }
  .wa-id-list { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 12px; }
  .wa-id-opt {
    border: 1.5px solid #d1d7db; background: #f8fafb; color: #3b4a54;
    font-size: 13px; font-weight: 600; border-radius: 999px;
    padding: 6px 13px; cursor: pointer;
  }
  .wa-id-opt:hover, .wa-id-opt.sel { border-color: var(--wa-green); background: #e7f8f2; color: var(--wa-green-deep); }
  .wa-id-free {
    width: 100%; box-sizing: border-box; border: 1.5px solid #d1d7db;
    border-radius: 9px; padding: 8px 11px; font-size: 13.5px; margin-bottom: 12px;
  }
  .wa-id-free:focus { outline: none; border-color: var(--wa-green); }
  .wa-id-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .wa-id-save {
    border: none; background: var(--wa-green); color: #fff; font-weight: 700;
    font-size: 13.5px; border-radius: 999px; padding: 8px 18px; cursor: pointer;
  }
  .wa-id-save:disabled { opacity: .5; cursor: default; }
  .wa-id-cancel {
    border: none; background: transparent; color: #667781; font-size: 13.5px;
    border-radius: 999px; padding: 8px 12px; cursor: pointer;
  }

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

  /* Image / video / sticker / document media */
  .wa-bubble.wa-has-media { padding: 4px 4px 5px; max-width: min(78%, 420px); }
  .wa-media { position: relative; border-radius: 7px; overflow: hidden; background: rgba(11,20,26,0.06); }
  .wa-media img, .wa-media video {
    display: block; width: 100%; max-height: 360px; object-fit: contain;
    background: #0b141a0a; cursor: zoom-in; vertical-align: middle;
  }
  .wa-media.wa-sticker {
    background: transparent; max-width: 180px;
  }
  .wa-media.wa-sticker img {
    max-height: 180px; width: auto; max-width: 180px; cursor: default;
    background: transparent;
  }
  .wa-media-fallback {
    padding: 28px 18px; text-align: center; color: var(--wa-faint);
    font-size: 13px; min-width: 160px;
  }
  .wa-media-caption {
    white-space: pre-wrap; unicode-bidi: plaintext;
    padding: 6px 6px 2px; font-size: 14.5px; line-height: 1.42;
  }
  .wa-doc {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px; min-width: 200px; max-width: 320px;
    border-radius: 8px; background: rgba(11,20,26,0.05);
    text-decoration: none; color: inherit;
  }
  .wa-doc:hover { background: rgba(11,20,26,0.09); }
  .wa-doc-icon {
    width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
    background: var(--wa-green); color: #fff;
    display: grid; place-items: center; font-size: 11px; font-weight: 800;
    letter-spacing: .02em;
  }
  .wa-doc-meta { min-width: 0; flex: 1; }
  .wa-doc-name {
    font-size: 13.5px; font-weight: 600; color: var(--wa-ink);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .wa-doc-sub { font-size: 11.5px; color: var(--wa-faint); margin-top: 2px; }

  /* Fullscreen image lightbox */
  .wa-lightbox {
    position: fixed; inset: 0; z-index: 10050;
    background: rgba(11,20,26,0.88);
    display: flex; align-items: center; justify-content: center;
    padding: 24px; cursor: zoom-out;
  }
  .wa-lightbox img {
    max-width: min(96vw, 1200px); max-height: 92vh;
    object-fit: contain; border-radius: 6px;
    box-shadow: 0 12px 48px rgba(0,0,0,0.45);
    cursor: default;
  }
  .wa-lightbox-close {
    position: absolute; top: 16px; right: 18px;
    border: none; background: rgba(255,255,255,0.12); color: #fff;
    width: 40px; height: 40px; border-radius: 50%; cursor: pointer;
    display: grid; place-items: center; font-size: 22px; line-height: 1;
  }
  .wa-lightbox-close:hover { background: rgba(255,255,255,0.22); }

  /* Contacts card */
  .wa-contact-card {
    display: flex; align-items: flex-start; gap: 10px;
    padding: 8px 6px 4px; min-width: 200px;
  }
  .wa-contact-av {
    width: 42px; height: 42px; border-radius: 50%; flex-shrink: 0;
    background: var(--wa-green); color: #fff;
    display: grid; place-items: center; font-weight: 700; font-size: 14px;
  }
  .wa-contact-meta { min-width: 0; flex: 1; }
  .wa-contact-name { font-weight: 700; font-size: 14.5px; color: var(--wa-ink); }
  .wa-contact-phone {
    font-size: 13px; color: #027eb5; margin-top: 2px;
    text-decoration: none; display: block;
  }
  .wa-contact-phone:hover { text-decoration: underline; }

  /* Location card */
  .wa-loc {
    display: block; text-decoration: none; color: inherit;
    border-radius: 8px; overflow: hidden; min-width: 210px;
    background: rgba(11,20,26,0.05);
  }
  .wa-loc:hover { background: rgba(11,20,26,0.09); }
  .wa-loc-map {
    height: 96px; background:
      linear-gradient(135deg, #c8e6c9 0%, #a5d6a7 40%, #81c784 100%);
    display: grid; place-items: center; font-size: 28px;
  }
  .wa-loc-body { padding: 8px 10px 6px; }
  .wa-loc-name { font-weight: 700; font-size: 13.5px; }
  .wa-loc-addr { font-size: 12px; color: var(--wa-faint); margin-top: 2px; }
  .wa-loc-link { font-size: 12px; color: #027eb5; margin-top: 4px; font-weight: 600; }

  /* Interactive / button reply */
  .wa-interactive {
    border-left: 3px solid var(--wa-green);
    padding: 4px 0 4px 10px; margin-bottom: 2px;
  }
  .wa-interactive-label {
    font-size: 11px; font-weight: 700; color: var(--wa-faint);
    text-transform: uppercase; letter-spacing: .04em; margin-bottom: 2px;
  }
  .wa-interactive-title { font-size: 14.5px; font-weight: 600; }

  /* Forwarded badge */
  .wa-fwd {
    font-size: 11.5px; color: var(--wa-faint); font-style: italic;
    margin-bottom: 3px;
  }

  /* Reactions pinned on a bubble */
  .wa-reactions {
    display: inline-flex; gap: 2px; align-items: center;
    margin-top: 4px; padding: 2px 6px;
    background: #fff; border-radius: 999px;
    box-shadow: 0 1px 2px rgba(11,20,26,0.12);
    font-size: 14px; line-height: 1.2;
    align-self: flex-start;
  }
  .wa-msg.out .wa-reactions { align-self: flex-end; }
  .wa-reaction-solo {
    font-size: 28px; line-height: 1; padding: 4px 8px;
  }
  .wa-react-host { display: contents; }
  .wa-copy-btn {
    align-self: flex-end;
    border: none; background: transparent;
    color: var(--wa-faint); font-size: 11px; font-weight: 600;
    cursor: pointer; padding: 0 2px; margin-top: 2px;
    opacity: 0; transition: opacity .12s ease;
  }
  .wa-bubble:hover .wa-copy-btn, .wa-copy-btn:focus { opacity: 1; }
  .wa-copy-btn:hover { color: var(--wa-green); }

  /* Quoted reply strip */
  .wa-quote {
    border-left: 3px solid var(--wa-green);
    background: rgba(11,20,26,0.05);
    border-radius: 0 6px 6px 0;
    padding: 5px 8px; margin-bottom: 5px;
    font-size: 12.5px; color: #54656f;
    max-height: 52px; overflow: hidden;
  }
  .wa-quote-label {
    font-size: 11px; font-weight: 700; color: var(--wa-green);
    margin-bottom: 1px;
  }
  .wa-quote-body {
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  /* 24h free-form window banner */
  .wa-window-banner {
    flex-shrink: 0;
    display: none;
    align-items: center; gap: 8px;
    padding: 8px 14px;
    background: #fff8e6;
    border-top: 1px solid #f0e0b0;
    color: #7a5b00;
    font-size: 12.5px; line-height: 1.35;
  }
  .wa-window-banner.show { display: flex; }
  .wa-window-banner strong { font-weight: 700; }
  .wa-window-banner a {
    color: #075e54; font-weight: 700; margin-left: auto; white-space: nowrap;
  }
  .wa-window-banner.open {
    background: #e8f8ef; border-color: #b7e4c7; color: #0b5c36;
  }

  /* Drag-drop overlay */
  .wa-drop-active .wa-composer {
    outline: 2px dashed var(--wa-green);
    outline-offset: -4px;
    background: #e8f8ef;
  }

  /* Truncation notice */
  .wa-trunc {
    text-align: center; font-size: 12px; color: var(--wa-faint);
    padding: 6px 10px; margin: 4px 0 8px;
  }

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
  /* Israel-local parts for day separators + list times (Nesher is IL-based). */
  function ilParts(d) {
    try {
      var fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Jerusalem",
        year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", hour12: false,
        weekday: "short"
      });
      var parts = fmt.formatToParts(d);
      var get = function (t) {
        for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value;
        return "";
      };
      return {
        y: Number(get("year")),
        m: Number(get("month")),
        day: Number(get("day")),
        h: Number(get("hour") === "24" ? "0" : get("hour")),
        min: Number(get("minute")),
        wd: get("weekday")
      };
    } catch (e) {
      return {
        y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate(),
        h: d.getHours(), min: d.getMinutes(),
        wd: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]
      };
    }
  }
  function hm(d) {
    var p = ilParts(d);
    return pad2(p.h) + ":" + pad2(p.min);
  }
  function dayKey(d) {
    var p = ilParts(d);
    return p.y + "-" + p.m + "-" + p.day;
  }
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  function dayLabel(d) {
    var now = new Date();
    var today = dayKey(now);
    var yest = dayKey(new Date(now.getTime() - 864e5));
    var k = dayKey(d);
    if (k === today) return "Today";
    if (k === yest) return "Yesterday";
    var p = ilParts(d);
    var lbl = (p.wd || DAYS[d.getDay()]) + ", " + MONTHS[p.m - 1] + " " + p.day;
    if (p.y !== ilParts(now).y) lbl += ", " + p.y;
    return lbl;
  }
  function listTime(d) {
    if (!d) return "";
    var now = new Date();
    var k = dayKey(d);
    if (k === dayKey(now)) return hm(d);
    if (k === dayKey(new Date(now.getTime() - 864e5))) return "Yesterday";
    if (now.getTime() - d.getTime() < 6 * 864e5) return ilParts(d).wd || DAYS[d.getDay()];
    var p = ilParts(d);
    var lbl = MONTHS[p.m - 1] + " " + p.day;
    if (p.y !== ilParts(now).y) lbl += ", " + p.y;
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
    // URLs (with/without scheme), emails, intl phone numbers
    var re = /(https?:\\/\\/[^\\s<>"]+|www\\.[^\\s<>"]+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}|\\+?\\d[\\d\\s().-]{7,}\\d)/g;
    var last = 0, m;
    text = String(text == null ? "" : text);
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      var raw = m[1];
      var a = el("a", "", raw);
      var href = raw;
      if (/^www\\./i.test(raw)) href = "https://" + raw;
      else if (raw.indexOf("@") > 0 && !/^https?:/i.test(raw) && !/^\\+?\\d/.test(raw)) href = "mailto:" + raw;
      else if (/^\\+?\\d[\\d\\s().-]{7,}\\d$/.test(raw) && raw.indexOf("@") < 0 && !/^https?:/i.test(raw)) {
        href = "tel:" + raw.replace(/[^\\d+]/g, "");
      }
      // block javascript: and data: schemes that somehow slip through
      if (/^(javascript|data|vbscript):/i.test(href)) {
        frag.appendChild(document.createTextNode(raw));
      } else {
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        frag.appendChild(a);
      }
      last = m.index + raw.length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  function copyText(str) {
    str = String(str || "");
    if (!str) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(str).then(function () { return true; }).catch(function () { return false; });
    }
    try {
      var ta = document.createElement("textarea");
      ta.value = str; ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return Promise.resolve(ok);
    } catch (e) { return Promise.resolve(false); }
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
    return m.messageType === "audio" || m.mediaKind === "audio" ||
      /^\\[(voice note|audio)/i.test(String(m.body || ""));
  }
  function isImageMsg(m) {
    return m.messageType === "image" || m.mediaKind === "image" ||
      /^\\[image/i.test(String(m.body || ""));
  }
  function isVideoMsg(m) {
    return m.messageType === "video" || m.mediaKind === "video" ||
      /^\\[video/i.test(String(m.body || ""));
  }
  function isStickerMsg(m) {
    return m.messageType === "sticker" || m.mediaKind === "sticker" ||
      /^\\[sticker/i.test(String(m.body || ""));
  }
  function isDocMsg(m) {
    return m.messageType === "document" || m.mediaKind === "document" ||
      /^\\[document/i.test(String(m.body || ""));
  }
  function isLocationMsg(m) {
    return m.messageType === "location" || !!m.location ||
      /^\\[location/i.test(String(m.body || ""));
  }
  function isContactsMsg(m) {
    return m.messageType === "contacts" || m.messageType === "contact" ||
      (Array.isArray(m.contacts) && m.contacts.length > 0) ||
      /^\\[contacts?/i.test(String(m.body || ""));
  }
  function isReactionMsg(m) {
    return m.messageType === "reaction" || !!m.reaction ||
      /^\\[reaction/i.test(String(m.body || ""));
  }
  function isInteractiveMsg(m) {
    return !!m.interactive || m.messageType === "interactive" || m.messageType === "button" ||
      /^\\[(button|interactive)/i.test(String(m.body || ""));
  }
  function mediaUrl(mediaId) {
    return "/__nesher_wa/media/" + encodeURIComponent(mediaId) + "/";
  }
  function captionOf(m) {
    var c = String(m.caption || "").trim();
    if (c) return c;
    var b = String(m.body || "").trim();
    // Django stores placeholders like "[image message received]" — never show those as caption
    if (!b || /^\\[(image|video|sticker|document|voice note|audio|location|contacts?|reaction|button|interactive|unknown|unsupported)/i.test(b)) return "";
    return b;
  }
  function openLightbox(src) {
    var existing = q(".wa-lightbox");
    if (existing) existing.remove();
    var lb = el("div", "wa-lightbox");
    var img = document.createElement("img");
    img.src = src;
    img.alt = "Photo";
    var close = el("button", "wa-lightbox-close", "\\u00D7");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    function dismiss() { lb.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(ev) { if (ev.key === "Escape") dismiss(); }
    close.addEventListener("click", function (ev) { ev.stopPropagation(); dismiss(); });
    lb.addEventListener("click", dismiss);
    img.addEventListener("click", function (ev) { ev.stopPropagation(); });
    lb.appendChild(img);
    lb.appendChild(close);
    document.body.appendChild(lb);
    document.addEventListener("keydown", onKey);
  }
  function previewFor(m) {
    if (!m) return { text: "No messages yet", voice: false };
    if (isAudioMsg(m)) return { text: m.voice !== false ? "Voice note" : "Audio", voice: true };
    if (isImageMsg(m)) {
      var ic = captionOf(m);
      return { text: ic ? ("Photo \\u00B7 " + ic) : "Photo", voice: false };
    }
    if (isVideoMsg(m)) {
      var vc = captionOf(m);
      return { text: vc ? ("Video \\u00B7 " + vc) : "Video", voice: false };
    }
    if (isStickerMsg(m)) return { text: "Sticker", voice: false };
    if (isDocMsg(m)) return { text: m.filename || "Document", voice: false };
    if (isLocationMsg(m)) {
      var ln = (m.location && (m.location.name || m.location.address)) || "Location";
      return { text: "Location \\u00B7 " + ln, voice: false };
    }
    if (isContactsMsg(m)) {
      var cn = (m.contacts && m.contacts[0] && m.contacts[0].name) || "Contact";
      return { text: "Contact \\u00B7 " + cn, voice: false };
    }
    if (isReactionMsg(m)) {
      var em = (m.reaction && m.reaction.emoji) || "\\uD83D\\uDC4D";
      return { text: "Reacted " + em, voice: false };
    }
    if (isInteractiveMsg(m)) {
      return { text: (m.interactive && m.interactive.title) || "Reply", voice: false };
    }
    var plain = String(m.body || "").replace(/\\s+/g, " ").trim();
    if (/^\\[image message received\\]/i.test(plain)) return { text: "Photo", voice: false };
    if (/^\\[contacts? message received\\]/i.test(plain)) return { text: "Contact", voice: false };
    if (/^\\[reaction message received\\]/i.test(plain)) return { text: "Reaction", voice: false };
    if (/^\\[location message received\\]/i.test(plain)) return { text: "Location", voice: false };
    if (/^\\[.+ message received\\]/i.test(plain)) return { text: plain.replace(/^\\[| message received\\]$/gi, ""), voice: false };
    return { text: plain, voice: false };
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
    var newBtn = el("button", "wa-newchat-btn", "+ New chat");
    newBtn.type = "button";
    newBtn.title = "Start a WhatsApp conversation with someone who has not messaged us (uses an approved template)";
    newBtn.addEventListener("click", openNewChat);
    bar.appendChild(logo); bar.appendChild(titles); bar.appendChild(newBtn); bar.appendChild(pill);
    outerCard.insertBefore(bar, outerCard.firstChild);
    header.style.display = "none";

    function openNewChat() {
      var overlay = el("div", "wa-id-overlay");
      var card = el("div", "wa-id-card");
      card.style.width = "min(420px, 94vw)";
      card.appendChild(el("h3", "", "New WhatsApp chat"));
      card.appendChild(el("p", "", "To message someone who has NEVER written us, WhatsApp requires an approved template first. After they reply, free-form chat works. Numbers already in the inbox open immediately."));
      var phone = el("input", "wa-id-free");
      phone.type = "tel"; phone.placeholder = "Phone \\u2014 972501234567 or 0501234567"; phone.maxLength = 22;
      var nameIn = el("input", "wa-id-free");
      nameIn.type = "text"; nameIn.placeholder = "Name (optional)"; nameIn.maxLength = 80;
      var tplSel = el("select", "wa-id-free");
      var bodyPrev = el("div", "wa-nc-body", "Loading templates\\u2026");
      var pendingNote = el("div", "wa-nc-body", "");
      pendingNote.style.display = "none";
      pendingNote.style.background = "#fff7ed";
      pendingNote.style.borderColor = "#fdba74";
      pendingNote.style.color = "#9a3412";
      var varHost = el("div");
      var err = el("div", "wa-nc-err", "");
      var templates = [];
      var pending = [];
      function normalizeDigits(raw) {
        var d = String(raw || "").replace(/\\D/g, "");
        if (d.length === 10 && d.charAt(0) === "0") d = "972" + d.slice(1);
        if (d.length === 9 && d.charAt(0) === "5") d = "972" + d;
        return d;
      }
      function renderTpl() {
        var t = templates[tplSel.selectedIndex];
        varHost.innerHTML = "";
        if (!t) {
          bodyPrev.textContent = pending.length
            ? ("No production template is APPROVED yet. Meta is still reviewing: " + pending.map(function (p) { return p.name + " (" + p.language + ")"; }).join(", ") + ". You can still open a number that already messaged us.")
            : "No approved templates available.";
          send.disabled = true;
          send.textContent = "Waiting for Meta\\u2026";
          openExisting.disabled = false;
          return;
        }
        send.disabled = false;
        send.textContent = "Send template";
        bodyPrev.textContent = t.body || "(no body)";
        for (var i = 1; i <= (t.varCount || 0); i++) {
          var vi = el("input", "wa-id-free");
          vi.type = "text"; vi.placeholder = "Value for {{" + i + "}}"; vi.maxLength = 500;
          vi.setAttribute("data-var", String(i));
          varHost.appendChild(vi);
        }
      }
      fetch("/__nesher_wa/templates/", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || ("HTTP " + r.status)); return d; }); })
        .then(function (d) {
          templates = d.templates || d.approved || [];
          pending = d.pending || [];
          tplSel.innerHTML = "";
          if (!templates.length) {
            var empty = el("option", "", "\\u2014 no approved template yet \\u2014");
            empty.disabled = true; empty.selected = true;
            tplSel.appendChild(empty);
          } else {
            templates.forEach(function (t, idx) {
              var o = document.createElement("option");
              o.value = String(idx);
              o.textContent = t.name + " (" + t.language + ")" + (t.varCount ? " \\u00B7 " + t.varCount + " field" + (t.varCount > 1 ? "s" : "") : "");
              tplSel.appendChild(o);
            });
          }
          if (pending.length) {
            pendingNote.style.display = "block";
            pendingNote.textContent = "Pending Meta approval: " + pending.map(function (p) { return p.name + " (" + p.language + ")"; }).join(", ") + ". Sample hello_world is hidden \\u2014 it only works on Meta test numbers.";
          }
          renderTpl();
        })
        .catch(function (e) { bodyPrev.textContent = "Could not load templates: " + (e.message || e); });
      tplSel.addEventListener("change", renderTpl);
      var actions = el("div", "wa-id-actions");
      var cancel = el("button", "wa-id-cancel", "Cancel");
      cancel.type = "button";
      cancel.addEventListener("click", function () { overlay.remove(); });
      var openExisting = el("button", "wa-id-cancel", "Open if exists");
      openExisting.type = "button";
      openExisting.title = "Open the chat if this number already wrote us \\u2014 no template needed";
      var send = el("button", "wa-id-save", "Send template");
      send.type = "button";
      function postNewChat(payload, busyLabel) {
        err.textContent = "";
        send.disabled = true; openExisting.disabled = true;
        send.textContent = busyLabel || "Working\\u2026";
        return fetch("/__nesher_wa/new-chat/", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
          body: JSON.stringify(payload)
        })
          .then(function (r) {
            return r.json().catch(function () { return {}; }).then(function (d) {
              if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
              return d;
            });
          })
          .then(function (d) { location.href = "/whatsapp/" + d.contactId + "/"; })
          .catch(function (e) {
            send.disabled = !templates.length;
            openExisting.disabled = false;
            send.textContent = templates.length ? "Send template" : "Waiting for Meta\\u2026";
            err.textContent = e.message || String(e);
          });
      }
      openExisting.addEventListener("click", function () {
        var digits = normalizeDigits(phone.value);
        if (digits.length < 9) { err.textContent = "Enter the full number (972\\u2026 or 05\\u2026)."; return; }
        var who = "";
        try { who = (localStorage.getItem("nesherWaAgentName") || "").trim(); } catch (e) {}
        postNewChat({ phone: digits, name: nameIn.value.trim(), openExistingOnly: true, agentTag: who }, "Looking\\u2026");
      });
      send.addEventListener("click", function () {
        err.textContent = "";
        var t = templates[tplSel.selectedIndex];
        var digits = normalizeDigits(phone.value);
        if (!t) { err.textContent = "No approved production template yet \\u2014 Meta is still reviewing. Use Open if exists for numbers already in the inbox."; return; }
        if (digits.length < 9) { err.textContent = "Enter the full number (972\\u2026 or 05\\u2026)."; return; }
        var params = [];
        var ok = true;
        qa("input[data-var]", varHost).forEach(function (vi) {
          if (!vi.value.trim()) ok = false;
          params.push(vi.value.trim());
        });
        if (!ok) { err.textContent = "Fill in every template value."; return; }
        var who = "";
        try { who = (localStorage.getItem("nesherWaAgentName") || "").trim(); } catch (e) {}
        postNewChat({ phone: digits, name: nameIn.value.trim(), templateName: t.name, params: params, agentTag: who }, "Sending\\u2026");
      });
      actions.appendChild(cancel); actions.appendChild(openExisting); actions.appendChild(send);
      card.appendChild(phone); card.appendChild(nameIn); card.appendChild(tplSel);
      card.appendChild(bodyPrev); card.appendChild(pendingNote); card.appendChild(varHost); card.appendChild(err); card.appendChild(actions);
      overlay.appendChild(card);
      overlay.addEventListener("click", function (ev) { if (ev.target === overlay) overlay.remove(); });
      function onEsc(ev) {
        if (ev.key === "Escape") {
          overlay.remove();
          document.removeEventListener("keydown", onEsc);
        }
      }
      document.addEventListener("keydown", onEsc);
      document.body.appendChild(overlay);
      phone.focus();
    }

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
        var lmWho = chat.lastMessage.agentTag || chat.lastMessage.sentBy;
        if (lmWho) {
          prev.appendChild(el("span", "wa-preview-sender", String(lmWho).split(" ")[0] + ":"));
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
      var lm = chat.lastMessage;
      var hay = [
        chat.name, chat.phone, chat.customerName,
        lm && lm.body, lm && lm.caption, lm && lm.filename, lm && lm.agentTag, lm && lm.sentBy
      ];
      return hay.some(function (v) { return v && String(v).toLowerCase().indexOf(f) >= 0; });
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
        .then(function (r) {
          if (r.status === 401 || r.status === 403) throw new Error("SESSION_EXPIRED");
          return r.ok ? r.json() : null;
        })
        .then(function (data) {
          if (!data || !data.ok || !data.chats) return;
          chats = data.chats;
          if (data.whatsappConfigured === false) {
            pill.classList.add("warn");
            pill.lastChild.textContent = "API not configured";
          }
          var unreadTotal = chats.reduce(function (s, c) { return s + (c.unread || 0); }, 0);
          try {
            document.title = (unreadTotal ? "(" + unreadTotal + ") " : "") + "WhatsApp \\u00B7 Nesher CRM";
          } catch (e) {}
          render();
        })
        .catch(function (e) {
          if (e && e.message === "SESSION_EXPIRED") {
            toast("CRM session expired \\u2014 refresh and log in again.", "error");
          }
        });
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

    /* "Sign as" identity — self-declared, per browser, shown only internally */
    var ID_KEY = "nesherWaAgentName";
    function agentName() {
      try { return (localStorage.getItem(ID_KEY) || "").trim(); } catch (e) { return ""; }
    }
    var PEN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    var idChip = el("button", "wa-identity");
    idChip.type = "button";
    idChip.title = "Who is replying from this computer";
    function refreshIdChip() {
      var n = agentName();
      idChip.innerHTML = PEN_SVG + "<span>" + (n ? n.replace(/</g, "&lt;") : "Sign as\\u2026") + "</span>";
      idChip.classList.toggle("unset", !n);
    }
    refreshIdChip();
    function openIdentityPicker(onDone) {
      var overlay = el("div", "wa-id-overlay");
      var card = el("div", "wa-id-card");
      card.appendChild(el("h3", "", "Who is replying?"));
      card.appendChild(el("p", "", "Shown only inside the CRM \\u2014 customers never see it. Saved on this computer."));
      var list = el("div", "wa-id-list");
      var free = el("input", "wa-id-free");
      free.type = "text"; free.placeholder = "Or type your name\\u2026"; free.maxLength = 40;
      var chosen = "";
      function syncSave() { save.disabled = !(chosen || free.value.trim()); }
      fetch("/__nesher_wa/agents/", { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var seen = {};
          (d.agents || []).forEach(function (a) {
            var nm = (a.name || a.username || "").trim();
            if (!nm || seen[nm]) return;
            seen[nm] = true;
            var b = el("button", "wa-id-opt", nm);
            b.type = "button";
            b.addEventListener("click", function () {
              chosen = nm; free.value = "";
              Array.prototype.forEach.call(list.children, function (c) { c.classList.remove("sel"); });
              b.classList.add("sel");
              syncSave();
            });
            list.appendChild(b);
          });
        })
        .catch(function () {});
      free.addEventListener("input", function () {
        chosen = "";
        Array.prototype.forEach.call(list.children, function (c) { c.classList.remove("sel"); });
        syncSave();
      });
      var actions = el("div", "wa-id-actions");
      var cancel = el("button", "wa-id-cancel", "Cancel");
      cancel.type = "button";
      var save = el("button", "wa-id-save", "Save");
      save.type = "button"; save.disabled = true;
      cancel.addEventListener("click", function () { overlay.remove(); });
      save.addEventListener("click", function () {
        var n = (chosen || free.value.trim()).slice(0, 40);
        if (!n) return;
        try { localStorage.setItem(ID_KEY, n); } catch (e) {}
        refreshIdChip();
        overlay.remove();
        if (onDone) onDone();
      });
      free.addEventListener("keydown", function (ev) { if (ev.key === "Enter") save.click(); });
      actions.appendChild(cancel); actions.appendChild(save);
      card.appendChild(list); card.appendChild(free); card.appendChild(actions);
      overlay.appendChild(card);
      overlay.addEventListener("click", function (ev) { if (ev.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
    }
    idChip.addEventListener("click", function () { openIdentityPicker(null); });

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
    head.appendChild(back); head.appendChild(av); head.appendChild(ht);
    head.appendChild(idChip); head.appendChild(infoBtn);
    pane.appendChild(head);

    infoBtn.addEventListener("click", function () { setDetails(!app.classList.contains("details-open")); });
    dClose.addEventListener("click", function () { setDetails(false); });
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape") {
        if (q(".wa-lightbox")) return; /* lightbox has its own Escape */
        if (app.classList.contains("details-open")) setDetails(false);
      }
    });
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

      /* Transcribe → English (Yiddish/Hebrew voice notes; cached per message) */
      function showTranscript(text) {
        var t = el("div", "wa-transcript");
        t.appendChild(el("span", "wa-transcript-label", "English \\u00b7 auto-transcribed"));
        t.appendChild(document.createTextNode(text));
        wrap.appendChild(t);
      }
      if (mUi.transcriptEn) {
        showTranscript(mUi.transcriptEn);
      } else if (mUi.id) {
        var trBtn = el("button", "wa-transcribe-btn");
        trBtn.type = "button";
        trBtn.textContent = "Transcribe \\u2192 English";
        trBtn.title = "Transcribe this voice note into English (only your team sees it)";
        trBtn.addEventListener("click", function () {
          trBtn.disabled = true;
          trBtn.textContent = "Transcribing\\u2026";
          fetch("/__nesher_wa/message/" + mUi.id + "/transcribe/", {
            method: "POST",
            credentials: "same-origin",
            headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" }
          })
            .then(function (r) {
              return r.json().catch(function () { return {}; }).then(function (d) {
                if (!r.ok) throw new Error(d.error || ("HTTP " + r.status));
                return d;
              });
            })
            .then(function (d) {
              trBtn.remove();
              showTranscript(d.text || "");
            })
            .catch(function (e) {
              trBtn.disabled = false;
              trBtn.textContent = "Transcribe \\u2192 English";
              toast("Transcription failed: " + (e.message || e), "error");
            });
        });
        wrap.appendChild(trBtn);
      }

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

    function mediaBubbleBody(mUi, kind) {
      var wrap = el("div");
      var cap = captionOf(mUi);
      if (!mUi.mediaId) {
        wrap.appendChild(el("div", "wa-media-fallback",
          kind === "video" ? "Video unavailable" :
          kind === "sticker" ? "Sticker unavailable" :
          kind === "document" ? (mUi.filename || "Document unavailable") :
          "Photo unavailable"));
        if (cap) {
          var c0 = el("div", "wa-media-caption");
          c0.appendChild(linkify(cap));
          wrap.appendChild(c0);
        }
        return wrap;
      }
      var src = mediaUrl(mUi.mediaId);
      if (kind === "document") {
        var a = el("a", "wa-doc");
        a.href = src;
        a.target = "_blank";
        a.rel = "noopener";
        if (mUi.filename) a.href += (a.href.indexOf("?") >= 0 ? "&" : "?") + "filename=" + encodeURIComponent(mUi.filename);
        a.download = mUi.filename || "document";
        var ext = String(mUi.filename || mUi.mimeType || "FILE").split(/[./]/).pop().slice(0, 4).toUpperCase() || "FILE";
        a.appendChild(el("div", "wa-doc-icon", ext));
        var meta = el("div", "wa-doc-meta");
        meta.appendChild(el("div", "wa-doc-name", mUi.filename || "Document"));
        meta.appendChild(el("div", "wa-doc-sub", "Tap to download"));
        a.appendChild(meta);
        wrap.appendChild(a);
        if (cap) {
          var cDoc = el("div", "wa-media-caption");
          cDoc.appendChild(linkify(cap));
          wrap.appendChild(cDoc);
        }
        return wrap;
      }
      var box = el("div", "wa-media" + (kind === "sticker" ? " wa-sticker" : ""));
      if (kind === "video") {
        var vid = document.createElement("video");
        vid.src = src;
        vid.controls = true;
        vid.preload = "metadata";
        vid.playsInline = true;
        box.appendChild(vid);
      } else {
        var img = document.createElement("img");
        img.src = src;
        img.alt = kind === "sticker" ? "Sticker" : "Photo";
        img.loading = "lazy";
        img.addEventListener("error", function () {
          box.innerHTML = "";
          box.appendChild(el("div", "wa-media-fallback",
            kind === "sticker" ? "Sticker expired or unavailable" : "Photo expired or unavailable"));
        });
        if (kind !== "sticker") {
          img.addEventListener("click", function () { openLightbox(src); });
        }
        box.appendChild(img);
      }
      wrap.appendChild(box);
      if (cap) {
        var c1 = el("div", "wa-media-caption");
        c1.appendChild(linkify(cap));
        wrap.appendChild(c1);
      }
      return wrap;
    }

    function locationBubbleBody(mUi) {
      var loc = mUi.location || {};
      var wrap = el("div");
      var lat = loc.lat != null ? loc.lat : loc.latitude;
      var lng = loc.lng != null ? loc.lng : loc.longitude;
      var maps = (lat != null && lng != null)
        ? ("https://www.google.com/maps?q=" + encodeURIComponent(lat + "," + lng))
        : null;
      var a = el(maps ? "a" : "div", "wa-loc");
      if (maps) { a.href = maps; a.target = "_blank"; a.rel = "noopener"; }
      a.appendChild(el("div", "wa-loc-map", "\\uD83D\\uDCCD"));
      var body = el("div", "wa-loc-body");
      body.appendChild(el("div", "wa-loc-name", loc.name || "Shared location"));
      if (loc.address) body.appendChild(el("div", "wa-loc-addr", loc.address));
      if (maps) body.appendChild(el("div", "wa-loc-link", "Open in Maps"));
      a.appendChild(body);
      wrap.appendChild(a);
      return wrap;
    }

    function contactsBubbleBody(mUi) {
      var list = Array.isArray(mUi.contacts) ? mUi.contacts : [];
      var wrap = el("div");
      if (!list.length) {
        wrap.appendChild(el("div", "wa-text", "Shared contact"));
        return wrap;
      }
      list.forEach(function (c) {
        var card = el("div", "wa-contact-card");
        var name = c.name || "Contact";
        card.appendChild(el("div", "wa-contact-av", initials(name, (c.phones && c.phones[0]) || "")));
        var meta = el("div", "wa-contact-meta");
        meta.appendChild(el("div", "wa-contact-name", name));
        (c.phones || []).forEach(function (ph) {
          var digits = String(ph).replace(/\\D/g, "");
          var link = el("a", "wa-contact-phone", ph);
          if (digits) {
            link.href = "https://wa.me/" + digits;
            link.target = "_blank";
            link.rel = "noopener";
          }
          meta.appendChild(link);
        });
        card.appendChild(meta);
        wrap.appendChild(card);
      });
      return wrap;
    }

    function interactiveBubbleBody(mUi) {
      var it = mUi.interactive || {};
      var wrap = el("div", "wa-interactive");
      wrap.appendChild(el("div", "wa-interactive-label",
        it.kind === "list_reply" ? "List reply" : "Button reply"));
      wrap.appendChild(el("div", "wa-interactive-title", it.title || "Reply"));
      if (it.description) wrap.appendChild(el("div", "wa-text", it.description));
      return wrap;
    }

    function appendReactions(host, mUi) {
      if (!host) return;
      var rs = Array.isArray(mUi.reactions) ? mUi.reactions : [];
      if (!rs.length) return;
      var bar = el("div", "wa-reactions");
      rs.forEach(function (r) {
        bar.appendChild(document.createTextNode(r.emoji || "\\uD83D\\uDC4D"));
      });
      host.appendChild(bar);
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
      var who = mUi.agentTag || mUi.sentBy;
      if (dir === "out" && who && (isRunStart || who !== lastOutSender)) {
        var sender = el("div", "wa-sender", who);
        sender.setAttribute("data-tone", tone(who));
        bub.appendChild(sender);
      }
      if (dir === "out") lastOutSender = who || lastOutSender;
      if (mUi.forwarded) {
        bub.appendChild(el("div", "wa-fwd", "Forwarded"));
      }
      if (mUi.quote && mUi.quote.body) {
        var q = el("div", "wa-quote");
        q.appendChild(el("div", "wa-quote-label",
          mUi.quote.direction === "outbound" ? "You" : "Customer"));
        q.appendChild(el("div", "wa-quote-body", mUi.quote.body));
        bub.appendChild(q);
      }
      if (isAudioMsg(mUi)) {
        bub.appendChild(audioBubbleBody(mUi));
      } else if (isImageMsg(mUi)) {
        bub.classList.add("wa-has-media");
        bub.appendChild(mediaBubbleBody(mUi, "image"));
      } else if (isVideoMsg(mUi)) {
        bub.classList.add("wa-has-media");
        bub.appendChild(mediaBubbleBody(mUi, "video"));
      } else if (isStickerMsg(mUi)) {
        bub.classList.add("wa-has-media");
        bub.appendChild(mediaBubbleBody(mUi, "sticker"));
      } else if (isDocMsg(mUi)) {
        bub.classList.add("wa-has-media");
        bub.appendChild(mediaBubbleBody(mUi, "document"));
      } else if (isLocationMsg(mUi)) {
        bub.appendChild(locationBubbleBody(mUi));
      } else if (isContactsMsg(mUi)) {
        bub.appendChild(contactsBubbleBody(mUi));
      } else if (isInteractiveMsg(mUi)) {
        bub.appendChild(interactiveBubbleBody(mUi));
      } else if (isReactionMsg(mUi)) {
        /* orphan reaction (target not in loaded thread) */
        var re = (mUi.reaction && mUi.reaction.emoji) || "\\uD83D\\uDC4D";
        bub.appendChild(el("div", "wa-reaction-solo", re));
        bub.appendChild(el("div", "wa-text", "Reacted to a message"));
      } else if (
        mUi.messageType === "unsupported" ||
        mUi.messageType === "ephemeral" ||
        mUi.messageType === "system" ||
        mUi.messageType === "unknown" ||
        /^\\[(unsupported|unknown|ephemeral)/i.test(String(mUi.body || ""))
      ) {
        bub.appendChild(el("div", "wa-text",
          mUi.messageType === "ephemeral"
            ? "View-once media \\u2014 open it in WhatsApp on the phone (not available via the API)."
            : mUi.messageType === "system"
              ? (mUi.body || "System message")
              : "Unsupported message type \\u2014 ask the customer to resend as text or a regular photo."
        ));
      } else {
        var bodyText = mUi.body || "";
        if (/^\\[.+ message (received|sent)\\]$/i.test(String(bodyText).trim())) {
          bodyText = previewFor(mUi).text || bodyText;
        }
        var txt = el("div", "wa-text");
        txt.appendChild(linkify(bodyText));
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
      /* copy — long GDS / PNR pastes are common */
      var copyBody = captionOf(mUi) || mUi.body || "";
      if (copyBody && !/^\\[/.test(String(copyBody).trim())) {
        var copyBtn = el("button", "wa-copy-btn", "Copy");
        copyBtn.type = "button";
        copyBtn.title = "Copy message text";
        copyBtn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          copyText(copyBody).then(function (ok) {
            toast(ok ? "Copied" : "Could not copy", ok ? "" : "error");
          });
        });
        bub.appendChild(copyBtn);
      }
      var reactHost = el("div", "wa-react-host");
      bub.appendChild(reactHost);
      appendReactions(reactHost, mUi);
      var errEl = null;
      if (String(mUi.status).toLowerCase() === "failed" && mUi.error) {
        errEl = el("div", "wa-msg-error", "Not delivered: " + mUi.error);
        bub.appendChild(errEl);
      }
      row.appendChild(bub);
      msgs.appendChild(row);
      return {
        node: row,
        status: mUi.status,
        tickEl: tickEl,
        reactHost: reactHost,
        errEl: errEl,
        bub: bub,
        reactionKey: (mUi.reactions || []).map(function (x) { return x.emoji; }).join("")
      };
    }

    function applyMessages(list, removeNodes) {
      (removeNodes || []).forEach(function (n) { if (n && n.parentNode) n.remove(); });
      var added = 0;
      list.forEach(function (mUi) {
        var key = String(mUi.id);
        var r = rendered[key];
        if (r) {
          /* live-patch status ticks (sent → delivered → read / failed) */
          if (r.status !== mUi.status && r.tickEl) {
            var fresh = ticksFor(mUi.status);
            r.tickEl.replaceWith(fresh);
            r.tickEl = fresh;
            r.status = mUi.status;
          }
          /* late-arriving reactions */
          var rk = (mUi.reactions || []).map(function (x) { return x.emoji; }).join("");
          if (rk !== r.reactionKey && r.reactHost) {
            r.reactHost.innerHTML = "";
            appendReactions(r.reactHost, mUi);
            r.reactionKey = rk;
          }
          /* failed error text */
          if (String(mUi.status).toLowerCase() === "failed" && mUi.error && r.bub && !r.errEl) {
            r.errEl = el("div", "wa-msg-error", "Not delivered: " + mUi.error);
            r.bub.appendChild(r.errEl);
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
    var truncNote = null;
    var windowBanner = el("div", "wa-window-banner");
    pane.appendChild(windowBanner);
    var freeFormOpen = true;
    var sending = false;

    function updateWindowBanner(meta) {
      if (!meta) return;
      freeFormOpen = meta.freeFormOpen !== false;
      windowBanner.classList.add("show");
      if (meta.freeFormOpen) {
        windowBanner.classList.add("open");
        windowBanner.classList.remove("closed");
        var until = meta.freeFormOpenUntil ? new Date(meta.freeFormOpenUntil) : null;
        var left = until ? Math.max(0, until.getTime() - Date.now()) : 0;
        var hrs = Math.floor(left / 3600000);
        var mins = Math.floor((left % 3600000) / 60000);
        windowBanner.innerHTML = "<strong>Free-form open</strong> \\u00B7 closes in " +
          (hrs > 0 ? hrs + "h " : "") + mins + "m (Israel time, 24h after their last message)";
      } else {
        windowBanner.classList.remove("open");
        windowBanner.innerHTML =
          "<strong>24h window closed</strong> \\u00B7 free-form text/media will fail. " +
          '<a href="/whatsapp/" id="wa-window-cta">New chat \\u2192 send template</a>';
      }
      // Soft-disable free-form when closed (still allow try so Meta error is visible)
      if (input) {
        input.placeholder = freeFormOpen
          ? "Type a message"
          : "Window closed \\u2014 send a template from New chat to re-open";
      }
    }

    var failedOnce = false;
    function refresh(removeNodes) {
      var url = "/__nesher_wa/contact/" + contactId + "/messages/?limit=300" +
        (document.visibilityState === "visible" ? "&read=1" : "");
      return fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
        .then(function (r) {
          if (r.status === 401 || r.status === 403) {
            throw new Error("SESSION_EXPIRED");
          }
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
          if (data.meta) updateWindowBanner(data.meta);
          if (data.meta && data.meta.truncated) {
            if (!truncNote) {
              truncNote = el("div", "wa-trunc",
                "Showing latest " + (data.meta.returned || "") + " of " + (data.meta.total || "") + " messages");
              msgs.insertBefore(truncNote, msgs.firstChild);
            }
          }
          applyMessages(data.messages || [], removeNodes);
          /* warm-cache recent media via fetch (Image() cannot warm audio/docs) */
          (data.messages || []).slice(-15).forEach(function (m) {
            if (!m.mediaId) return;
            if (m.mediaKind === "image" || m.messageType === "image" ||
                m.mediaKind === "audio" || m.messageType === "audio" ||
                m.mediaKind === "document" || m.messageType === "document" ||
                m.mediaKind === "video" || m.messageType === "video" ||
                m.mediaKind === "sticker" || m.messageType === "sticker") {
              fetch(mediaUrl(m.mediaId), { credentials: "same-origin", method: "GET" }).catch(function () {});
            }
          });
          failedOnce = false;
        })
        .catch(function (e) {
          if (e && e.message === "SESSION_EXPIRED") {
            if (loading) loading.textContent = "Session expired \\u2014 refresh the page and log in again.";
            if (!failedOnce) {
              failedOnce = true;
              toast("CRM session expired \\u2014 refresh and log in again.", "error");
            }
            return;
          }
          if (loading) { loading.textContent = "Could not load messages \\u2014 " + (e.message || e); }
          if (!failedOnce) {
            failedOnce = true;
            toast("Live thread unavailable: " + (e.message || e), "error");
          }
        });
    }

    /* pending (optimistic) bubbles */
    function addPending(bodyText, kind) {
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
      if (kind === "voice" || kind === true) {
        var tag = el("div", "wa-voice-tag");
        tag.appendChild(icon("micSm"));
        tag.appendChild(document.createTextNode("Voice note \\u2014 sending\\u2026"));
        bub.appendChild(tag);
      } else if (kind === "image") {
        bub.appendChild(el("div", "wa-media-fallback", "Sending photo\\u2026"));
      } else if (kind === "video") {
        bub.appendChild(el("div", "wa-media-fallback", "Sending video\\u2026"));
      } else if (kind === "document") {
        bub.appendChild(el("div", "wa-media-fallback", "Sending file\\u2026"));
      } else if (kind === "audio") {
        bub.appendChild(el("div", "wa-media-fallback", "Sending audio\\u2026"));
      } else {
        var txt = el("div", "wa-text");
        txt.appendChild(linkify(bodyText || ""));
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
    attach.title = "Attach photo, video, PDF, or audio";
    attach.setAttribute("aria-label", "Attach file");
    var fileInput = el("input");
    fileInput.type = "file";
    fileInput.accept = "image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.ogg,.mp3,.m4a,.aac,.webm,.jpg,.jpeg,.png,.webp,.mp4,.mov";
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
      if (!text || sending) return;
      if (!freeFormOpen) {
        toast("24h window is closed \\u2014 free-form text will likely fail. Open via New chat + approved template.", "warn");
      }
      var who = agentName();
      if (!who) { openIdentityPicker(function () { sendText(); }); return; }
      sending = true;
      sendBtn.disabled = true;
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
        headers: { "X-Requested-With": "XMLHttpRequest", "X-Agent-Tag": encodeURIComponent(who) }
      })
        .then(function (r) {
          if (r.status === 401 || r.status === 403) throw new Error("SESSION_EXPIRED");
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
          var msg = e.message || "Send failed";
          if (msg === "SESSION_EXPIRED") msg = "Session expired \\u2014 refresh and log in again";
          toast(msg, "error");
          markFailed(row, msg, function () {
            input.value = text;
            syncButtons(); autoGrow();
            sendText();
          });
        })
        .then(function () { sending = false; sendBtn.disabled = false; });
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
      var who = agentName();
      if (!who) { openIdentityPicker(function () { sendAudioBlob(blob, mime, isVoice); }); return Promise.resolve(); }
      var row = addPending("", isVoice !== false ? "voice" : "audio");
      micBtn.disabled = true; attach.disabled = true;
      return blobToBase64(blob)
        .then(function (b64) {
          return fetch("/__nesher_wa/contact/" + contactId + "/send-audio/", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
            body: JSON.stringify({ audioBase64: b64, mimeType: mime || blob.type || "audio/webm", voice: isVoice !== false, agentTag: who })
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
    function guessKind(file) {
      var t = String(file.type || "").toLowerCase();
      var n = String(file.name || "").toLowerCase();
      if (t.startsWith("image/") || /\\.(jpe?g|png|gif|webp)$/i.test(n)) return "image";
      if (t.startsWith("video/") || /\\.(mp4|mov|3gp|webm)$/i.test(n)) return "video";
      if (t.startsWith("audio/") || /\\.(ogg|mp3|m4a|aac|opus|wav|webm)$/i.test(n)) return "audio";
      return "document";
    }
    function compressImageIfNeeded(file) {
      return new Promise(function (resolve) {
        var kind = guessKind(file);
        if (kind !== "image") { resolve(file); return; }
        if (/heic|heif/i.test(file.type || file.name || "")) {
          resolve(file); // server will reject with a clear message
          return;
        }
        // Always re-encode large phone photos so Meta's 5 MB image limit doesn't trip
        if (file.size < 900 * 1024) { resolve(file); return; }
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          try {
            var max = 1600;
            var w = img.naturalWidth || img.width;
            var h = img.naturalHeight || img.height;
            var scale = Math.min(1, max / Math.max(w, h));
            var cw = Math.max(1, Math.round(w * scale));
            var ch = Math.max(1, Math.round(h * scale));
            var canvas = document.createElement("canvas");
            canvas.width = cw; canvas.height = ch;
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, cw, ch);
            canvas.toBlob(function (blob) {
              URL.revokeObjectURL(url);
              if (!blob || blob.size >= file.size) { resolve(file); return; }
              var name = String(file.name || "photo.jpg").replace(/\\.[^.]+$/, "") + ".jpg";
              resolve(new File([blob], name, { type: "image/jpeg" }));
            }, "image/jpeg", 0.82);
          } catch (e) {
            URL.revokeObjectURL(url);
            resolve(file);
          }
        };
        img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
        img.src = url;
      });
    }
    function sendMediaFile(file) {
      if (sending) return Promise.resolve();
      var who = agentName();
      if (!who) { openIdentityPicker(function () { sendMediaFile(file); }); return Promise.resolve(); }
      if (!freeFormOpen) {
        toast("24h window is closed \\u2014 media may fail until a template re-opens the chat.", "warn");
      }
      if (/heic|heif/i.test(file.type || file.name || "")) {
        toast("iPhone HEIC photos aren't accepted. Export as JPEG first.", "error");
        return Promise.resolve();
      }
      var kind = guessKind(file);
      if (kind === "audio") {
        return sendAudioBlob(file, file.type || "audio/mpeg", /ogg|opus|webm/i.test(file.type || file.name));
      }
      if (file.size > 64 * 1024 * 1024) {
        toast("File too large (max 64 MB)", "error");
        return Promise.resolve();
      }
      sending = true;
      micBtn.disabled = true; attach.disabled = true;
      return compressImageIfNeeded(file)
        .then(function (ready) {
          kind = guessKind(ready);
          var row = addPending("", kind);
          return blobToBase64(ready)
            .then(function (b64) {
              return fetch("/__nesher_wa/contact/" + contactId + "/send-media/", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
                body: JSON.stringify({
                  fileBase64: b64,
                  mimeType: ready.type || "application/octet-stream",
                  filename: ready.name || "file.bin",
                  agentTag: who
                })
              });
            })
            .then(function (r) {
              if (r.status === 401 || r.status === 403) throw new Error("SESSION_EXPIRED");
              return r.json().catch(function () { return {}; }).then(function (data) {
                if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
                return refresh([row]);
              });
            })
            .catch(function (e) {
              var msg = e.message || String(e);
              if (msg === "SESSION_EXPIRED") msg = "Session expired \\u2014 refresh and log in again";
              toast("Send failed: " + msg, "error");
              markFailed(row, msg, function () { sendMediaFile(file); });
            });
        })
        .then(function () { sending = false; micBtn.disabled = false; attach.disabled = false; });
    }
    attach.addEventListener("click", function () { fileInput.click(); });
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!f) return;
      sendMediaFile(f);
    });

    /* Paste image from clipboard (screenshot / Ctrl+V) */
    input.addEventListener("paste", function (ev) {
      var items = ev.clipboardData && ev.clipboardData.items;
      if (!items) return;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf("image/") === 0) {
          ev.preventDefault();
          var blob = items[i].getAsFile();
          if (!blob) return;
          var f = new File([blob], "pasted-" + Date.now() + ".png", { type: blob.type || "image/png" });
          sendMediaFile(f);
          return;
        }
      }
    });

    /* Drag & drop files onto the chat pane */
    ["dragenter", "dragover"].forEach(function (evName) {
      pane.addEventListener(evName, function (ev) {
        ev.preventDefault();
        pane.classList.add("wa-drop-active");
      });
    });
    ["dragleave", "drop"].forEach(function (evName) {
      pane.addEventListener(evName, function (ev) {
        ev.preventDefault();
        pane.classList.remove("wa-drop-active");
      });
    });
    pane.addEventListener("drop", function (ev) {
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (f) sendMediaFile(f);
    });

    /* recorder */
    var recorder = null, chunks = [], recStart = 0, recInterval = null, discard = false;
    var recStarting = false, recAborted = false, recStopping = false;
    function stopTracks(stream) { stream.getTracks().forEach(function (t) { t.stop(); }); }
    function startRec() {
      if (recorder || recStarting) return;
      recStarting = true; recAborted = false; discard = false;
      micBtn.disabled = true;
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(function (stream) {
          recStarting = false;
          micBtn.disabled = false;
          if (recAborted) { stopTracks(stream); return; }
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
            micBtn.title = "Record voice note";
            clearInterval(recInterval);
            var type = (recorder && recorder.mimeType) || mime || "audio/webm";
            var durMs = Date.now() - recStart;
            recorder = null; recStopping = false;
            if (discard) return;
            if (durMs < 700) { toast("Too short \\u2014 tap the mic, speak after the timer starts, then tap send.", "warn"); return; }
            var blob = new Blob(chunks, { type: type });
            if (!blob.size) { toast("Empty recording \\u2014 try again.", "warn"); return; }
            sendAudioBlob(blob, type, true);
          };
          /* timeslice so long notes flush chunks as they go */
          recorder.start(1000);
          recStart = Date.now();
          recTimer.textContent = "0:00";
          recInterval = setInterval(function () {
            var sec = (Date.now() - recStart) / 1000;
            recTimer.textContent = fmtClock(sec);
            /* Meta audio max ~16 MB; stop at 3 minutes to stay safe + keep UX sane */
            if (sec >= 180 && recorder && !recStopping) {
              toast("Voice note auto-stopped at 3 minutes.", "warn");
              stopRec(false);
            }
          }, 250);
          composer.classList.add("recording");
          micBtn.innerHTML = I.send;
          micBtn.title = "Send voice note";
        })
        .catch(function (e) {
          recStarting = false;
          micBtn.disabled = false;
          toast(e.message || "Microphone permission denied", "error");
        });
    }
    function stopRec(cancel) {
      if (recStarting) { recAborted = true; discard = true; return; }
      if (!recorder || recStopping) return;
      recStopping = true;
      discard = Boolean(cancel);
      var r = recorder;
      /* grace so the tail of the last word is captured, then flush + stop */
      setTimeout(function () {
        try { r.requestData(); } catch (e) {}
        try { r.stop(); } catch (e) {}
      }, cancel ? 0 : 350);
    }
    micBtn.addEventListener("click", function () {
      if (recorder || recStarting) stopRec(false);
      else startRec();
    });
    recCancel.addEventListener("click", function () { stopRec(true); });

    /* boot + poll (faster when focused, pause when hidden, resume on focus) */
    refresh().then(function () { scrollBottom(); });
    var pollMs = 5000;
    var pollTimer = setInterval(function () {
      if (!document.hidden && !recorder && !sending) refresh();
    }, pollMs);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        pollMs = 4000;
        refresh();
      } else {
        pollMs = 20000;
      }
    });
    window.addEventListener("online", function () {
      toast("Back online \\u2014 refreshing chat\\u2026", "");
      refresh();
    });
    window.addEventListener("offline", function () {
      toast("You are offline \\u2014 sends will fail until the connection returns.", "warn");
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
/* WhatsApp presence card on a customer detail page — self-contained script,
 * fetches /__nesher_wa/by-customer/<id>/ and renders a link into the chat. */
function customerCardScript(customerId) {
  return `
<script id="${WA_UI_MARKER}-cust">
(function () {
  fetch("/__nesher_wa/by-customer/${customerId}/", { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var w = d && d.whatsapp;
      if (!w) return;
      var card = document.createElement("div");
      card.style.cssText = "margin:12px 0;padding:13px 16px;border:1px solid #b9e6d3;border-left:4px solid #008069;border-radius:10px;background:#f0faf6;font-size:14px;color:#1f2c33;display:flex;align-items:center;gap:10px;flex-wrap:wrap;";
      var when = w.lastAt ? new Date(w.lastAt).toLocaleString() : "no messages yet";
      card.innerHTML =
        '<strong style="color:#008069">WhatsApp</strong>' +
        '<span>' + (w.name || w.phone) + ' \\u00b7 ' + w.messages + ' messages \\u00b7 last: ' + when + '</span>' +
        '<a href="/whatsapp/' + w.contactId + '/" style="margin-left:auto;background:#008069;color:#fff;font-weight:700;border-radius:999px;padding:6px 16px;text-decoration:none;">Open conversation</a>';
      var host = document.querySelector(".container") || document.body;
      host.insertBefore(card, host.children[1] || null);
    })
    .catch(function () {});
})();
</script>`;
}

export function injectWhatsAppUi(html, path) {
  if (!html || typeof html !== "string") return html;
  if (html.includes(`${WA_UI_MARKER}-js`)) return html;
  const custMatch = String(path || "").match(/^\/customers\/(\d+)\/?$/);
  if (custMatch) {
    if (html.includes(`${WA_UI_MARKER}-cust`)) return html;
    const script = customerCardScript(custMatch[1]);
    // The CRM's customer template never closes <body> — append however we can.
    if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}</body>`);
    if (/<\/html>/i.test(html)) return html.replace(/<\/html>/i, `${script}</html>`);
    return html + script;
  }
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
