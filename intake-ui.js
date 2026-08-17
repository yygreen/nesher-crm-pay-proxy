// JRM Inbox notifications: unread badge / bell / "NEW" markers for auto-filed CRM items.
// Data = jrm_intake_message rows written by the jrm-lead-intake service (same Postgres).
// "Seen" state is per browser (localStorage) - the team shares CRM logins, so a per-login
// read state would hide new items from the next person using the same account.

export const INTAKE_UI_MARKER = "nesher-intake-ui";

// Staff pages that get the badge (in addition to the pages the proxy already buffers).
export const INTAKE_UI_PATH_RE =
  /^\/(jrm|reservations|whatsapp|customers|my-tasks|tasks|waitlist|tickets|open-balances|flight-search|attendance|settings|users|payments|profit|expenses|points|dashboard)(\/|$)/;

const LOGIN_RE = /name=["']password["']|Nesher CRM Login/i;

/** Feed of auto-filed items for the bell. Requires a pg pool. */
export async function loadIntakeFeed(pool, { days = 7, limit = 120 } = {}) {
  const { rows } = await pool.query(
    `SELECT m.gmail_id, m.action, m.category, m.request_id, m.processed_at, m.received_at, m.subject,
            m.ai_json->>'summary' AS summary, m.ai_json->>'urgency' AS urgency,
            r.customer_name, r.status, r.requested_hotel, to_char(r.check_in, 'YYYY-MM-DD') AS check_in, to_char(r.check_out, 'YYYY-MM-DD') AS check_out
       FROM jrm_intake_message m
       LEFT JOIN core_jrmhotelrequest r ON r.id = m.request_id
      WHERE m.action IN ('created_request','note_added') AND m.request_id IS NOT NULL
        AND m.processed_at > now() - ($1 || ' days')::interval
      ORDER BY m.processed_at DESC LIMIT $2`,
    [String(days), limit]
  );
  const CH = {
    lead_website_form: "Website form", lead_chat_transcript: "Live chat", lead_agent_summary: "Chat agent summary",
    lead_direct_email: "Email", lead_phone_voicemail: "Voicemail", customer_reply: "Customer reply",
    hotel_correspondence: "Hotel reply", team_outbound: "Team email",
  };
  return rows
    .filter((r) => r.customer_name != null) // request still exists
    .map((r) => ({
      key: r.gmail_id,
      kind: r.action === "created_request" ? "request" : "note",
      requestId: Number(r.request_id),
      ref: `JRM-${1000 + Number(r.request_id)}`,
      name: r.customer_name || "",
      channel: CH[r.category] || r.category || "",
      category: r.category || "",
      hotel: r.requested_hotel || "",
      checkIn: r.check_in || "",
      status: r.status || "",
      urgent: r.urgency === "urgent",
      summary: String(r.summary || r.subject || "").slice(0, 220),
      at: new Date(r.processed_at).toISOString(),
    }));
}

const CSS = `<style id="${INTAKE_UI_MARKER}-css">
#nib-bell{position:fixed;top:10px;right:14px;z-index:99990;width:42px;height:42px;border-radius:50%;background:#1f3a5f;color:#fff;border:0;box-shadow:0 2px 10px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;justify-content:center;font:600 13px/1 system-ui,Segoe UI,Arial}
#nib-bell:hover{background:#2c507f}
#nib-bell.nib-inline{position:relative;top:auto;right:auto;display:inline-flex;vertical-align:middle;margin-right:10px;width:36px;height:36px;background:rgba(255,255,255,.14);box-shadow:none}
#nib-bell.nib-inline:hover{background:rgba(255,255,255,.28)}
#nib-bell.nib-inline svg{width:20px;height:20px}
.topbar-right{display:flex;align-items:center;justify-content:flex-end}
#nib-bell svg{width:22px;height:22px}
#nib-count,.nib-navbadge{position:absolute;top:-6px;right:-6px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#d92d20;color:#fff;font:700 11px/20px system-ui,Segoe UI,Arial;text-align:center;box-shadow:0 0 0 2px #fff;display:none}
.nib-navbadge{position:static;display:inline-block;margin-left:6px;vertical-align:middle;box-shadow:none}
#nib-bell.nib-pulse{animation:nib-pulse 1.2s ease-in-out 3}
@keyframes nib-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.15)}}
#nib-panel{position:fixed;top:58px;right:14px;z-index:99991;width:390px;max-width:calc(100vw - 20px);max-height:min(72vh,640px);background:#fff;border:1px solid #d9dee7;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden;font:14px/1.4 system-ui,Segoe UI,Arial;color:#1c2431}
#nib-panel.open{display:flex}
#nib-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:#1f3a5f;color:#fff}
#nib-head b{font-size:14px}
#nib-head button{background:transparent;border:1px solid rgba(255,255,255,.55);color:#fff;border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;margin-left:6px}
#nib-head button:hover{background:rgba(255,255,255,.15)}
#nib-list{overflow:auto;flex:1}
.nib-item{display:block;padding:10px 12px;border-bottom:1px solid #eef1f5;text-decoration:none;color:inherit;position:relative}
.nib-item:hover{background:#f4f7fb}
.nib-item.unread{background:#fff7e6}
.nib-item.unread:hover{background:#ffefcc}
.nib-item.unread:before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:#d92d20}
.nib-t{display:flex;justify-content:space-between;gap:8px;font-weight:600}
.nib-t small{font-weight:400;color:#6b7280;white-space:nowrap}
.nib-k{display:inline-block;font-size:11px;font-weight:700;padding:1px 6px;border-radius:4px;margin-right:6px;vertical-align:middle;color:#fff;background:#0f8a5f}
.nib-k.note{background:#3b6ea8}
.nib-k.urgent{background:#d92d20}
.nib-s{color:#374151;font-size:13px;margin-top:3px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.nib-empty{padding:26px 12px;text-align:center;color:#6b7280}
#nib-foot{padding:8px 12px;border-top:1px solid #eef1f5;font-size:12px;color:#6b7280;display:flex;justify-content:space-between;align-items:center}
#nib-foot label{cursor:pointer}
#nib-toasts{position:fixed;right:14px;bottom:18px;z-index:99992;display:flex;flex-direction:column;gap:8px;max-width:360px}
.nib-toast{background:#1f3a5f;color:#fff;border-left:5px solid #f59e0b;border-radius:8px;padding:10px 12px;box-shadow:0 8px 20px rgba(0,0,0,.25);font:13px/1.35 system-ui,Segoe UI,Arial;cursor:pointer;animation:nib-in .25s ease-out}
.nib-toast b{display:block;font-size:14px;margin-bottom:2px}
@keyframes nib-in{from{transform:translateY(12px);opacity:0}to{transform:none;opacity:1}}
.nib-newpill{display:inline-block;background:#d92d20;color:#fff;font:700 10px/16px system-ui,Segoe UI,Arial;padding:0 6px;border-radius:8px;margin-left:6px;vertical-align:middle;letter-spacing:.3px}
tr.nib-newrow>td:first-child{box-shadow:inset 4px 0 0 #d92d20}
tr.nib-newrow{background:#fff7e6 !important}
</style>`;

const SCRIPT = `<script id="${INTAKE_UI_MARKER}-js">(function(){
if (window.__nibLoaded) return; window.__nibLoaded = true;
var FEED='/__nesher_intake/feed/', POLL=30000, LS_SEEN='nesherIntakeSeen', LS_MUTE='nesherIntakeMute', LS_LAST='nesherIntakeLastPoll';
var firstEver = localStorage.getItem(LS_SEEN)==null;
var seen = {}; try { seen = JSON.parse(localStorage.getItem(LS_SEEN)||'{}')||{}; } catch(e){}
var muted = localStorage.getItem(LS_MUTE)==='1';
var items = [], firstPoll = true, lastAt = localStorage.getItem(LS_LAST)||'';
function save(){ try{ localStorage.setItem(LS_SEEN, JSON.stringify(seen)); }catch(e){} }
function ago(iso){ var s=(Date.now()-new Date(iso).getTime())/1000; if(s<60) return 'just now'; if(s<3600) return Math.floor(s/60)+' min ago'; if(s<86400) return Math.floor(s/3600)+' h ago'; return Math.floor(s/86400)+' d ago'; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function unread(){ return items.filter(function(i){ return !seen[i.key]; }); }
// ---- DOM
var bell=document.createElement('button'); bell.id='nib-bell'; bell.type='button'; bell.title='JRM Inbox - auto-filed leads and replies';
bell.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg><span id="nib-count"></span>';
var panel=document.createElement('div'); panel.id='nib-panel';
panel.innerHTML='<div id="nib-head"><b>JRM Inbox <span id="nib-hcount"></span></b><span><button type="button" id="nib-readall">Mark all read</button><button type="button" id="nib-close">&times;</button></span></div><div id="nib-list"></div><div id="nib-foot"><span>Auto-filed from booking@ - last 7 days</span><label><input type="checkbox" id="nib-mute"> mute sound</label></div>';
var toasts=document.createElement('div'); toasts.id='nib-toasts';
function mount(){ var host=document.querySelector('.topbar-right'); if (host) { bell.classList.add('nib-inline'); host.insertBefore(bell, host.firstChild); } else { document.body.appendChild(bell); } document.body.appendChild(panel); document.body.appendChild(toasts); document.getElementById('nib-mute').checked=muted; }
if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
bell.addEventListener('click', function(){ panel.classList.toggle('open'); if (panel.classList.contains('open')) { render(); if (window.Notification && Notification.permission==='default') { try{ Notification.requestPermission(); }catch(e){} } } bell.classList.remove('nib-pulse'); });
document.addEventListener('click', function(e){ if (!panel.contains(e.target) && e.target!==bell && !bell.contains(e.target)) panel.classList.remove('open'); });
panel.addEventListener('click', function(e){
  var t=e.target;
  if (t.id==='nib-close') { panel.classList.remove('open'); return; }
  if (t.id==='nib-readall') { items.forEach(function(i){ seen[i.key]=Date.now(); }); save(); render(); return; }
  if (t.id==='nib-mute') { muted=t.checked; localStorage.setItem(LS_MUTE, muted?'1':'0'); return; }
  var a=t.closest && t.closest('.nib-item'); if (a) { var k=a.getAttribute('data-key'); if (k) { seen[k]=Date.now(); save(); } }
});
// ---- rendering
function render(){
  var un=unread(); var n=un.length;
  var c=document.getElementById('nib-count'); if (c) { c.textContent=n>99?'99+':String(n); c.style.display=n?'block':'none'; }
  var hc=document.getElementById('nib-hcount'); if (hc) hc.textContent=n?'('+n+' unread)':'';
  document.title = document.title.replace(/^\\(\\d+\\+?\\) /,''); if (n) document.title='('+(n>99?'99+':n)+') '+document.title;
  var list=document.getElementById('nib-list'); if (list) {
    if (!items.length) list.innerHTML='<div class="nib-empty">Nothing auto-filed in the last 7 days.</div>';
    else list.innerHTML=items.slice(0,80).map(function(i){
      var k = i.kind==='request' ? '<span class="nib-k">NEW REQUEST</span>' : '<span class="nib-k note">NOTE</span>';
      if (i.urgent) k += '<span class="nib-k urgent">URGENT</span>';
      var when = i.checkIn ? ' &middot; '+esc(i.checkIn) : '';
      return '<a class="nib-item'+(seen[i.key]?'':' unread')+'" data-key="'+esc(i.key)+'" href="/jrm/hotels/'+i.requestId+'/"><div class="nib-t"><span>'+k+esc(i.ref)+' &middot; '+esc(i.name)+'</span><small>'+esc(ago(i.at))+'</small></div><div class="nib-s">'+esc(i.channel)+(i.hotel?' &middot; '+esc(i.hotel):'')+when+' - '+esc(i.summary)+'</div></a>';
    }).join('');
  }
  navBadge(n); markList();
}
function navBadge(n){
  var links=document.querySelectorAll('.navbar a[href="/jrm/hotels/"], .navbar-inner a[href="/jrm/hotels/"], nav a[href="/jrm/hotels/"]');
  links.forEach(function(a){ var b=a.querySelector('.nib-navbadge'); if(!b){ b=document.createElement('span'); b.className='nib-navbadge'; a.appendChild(b);} b.textContent=n>99?'99+':String(n); b.style.display=n?'inline-block':'none'; });
}
function markList(){
  if (!/^\\/jrm\\/hotels\\/?(\\?|$)/.test(location.pathname+location.search)) return;
  var unByReq={}; unread().forEach(function(i){ unByReq[i.requestId]=(unByReq[i.requestId]||0)+1; });
  document.querySelectorAll('a[href^="/jrm/hotels/"]').forEach(function(a){
    if (a.closest('#nib-panel') || a.closest('#nib-toasts') || a.closest('.navbar')) return;
    var m=a.getAttribute('href').match(/^\\/jrm\\/hotels\\/(\\d+)\\/?$/); if(!m) return;
    var tr=a.closest('tr'); var id=Number(m[1]);
    var pill=a.parentNode.querySelector('.nib-newpill');
    if (unByReq[id]) { if(!pill){ pill=document.createElement('span'); pill.className='nib-newpill'; pill.textContent='NEW'; a.parentNode.insertBefore(pill, a.nextSibling);} if(tr) tr.classList.add('nib-newrow'); }
    else { if(pill) pill.remove(); if(tr) tr.classList.remove('nib-newrow'); }
  });
}
// ---- attention: toast + sound + browser notification
function ding(){ if (muted) return; try { var AC=window.AudioContext||window.webkitAudioContext; if(!AC) return; var ctx=window.__nibAC||(window.__nibAC=new AC()); if (ctx.state==='suspended') ctx.resume(); var t=ctx.currentTime; [[880,0],[1174,0.16]].forEach(function(p){ var o=ctx.createOscillator(), g=ctx.createGain(); o.type='sine'; o.frequency.value=p[0]; g.gain.setValueAtTime(0.0001,t+p[1]); g.gain.exponentialRampToValueAtTime(0.18,t+p[1]+0.02); g.gain.exponentialRampToValueAtTime(0.0001,t+p[1]+0.35); o.connect(g).connect(ctx.destination); o.start(t+p[1]); o.stop(t+p[1]+0.4); }); } catch(e){} }
function toast(i){ var d=document.createElement('div'); d.className='nib-toast'; d.innerHTML='<b>'+(i.kind==='request'?'New lead: ':'New activity: ')+esc(i.ref)+' &middot; '+esc(i.name)+'</b>'+esc(i.channel)+(i.hotel?' &middot; '+esc(i.hotel):'')+' - '+esc(i.summary.slice(0,140)); d.onclick=function(){ seen[i.key]=Date.now(); save(); location.href='/jrm/hotels/'+i.requestId+'/'; }; toasts.appendChild(d); setTimeout(function(){ if(d.parentNode) d.parentNode.removeChild(d); }, 12000); }
function notify(i){ try { if (window.Notification && Notification.permission==='granted' && document.hidden) { var nn=new Notification((i.kind==='request'?'New lead ':'New activity ')+i.ref+' - '+i.name, { body: i.channel+(i.hotel?' - '+i.hotel:'')+'\\n'+i.summary.slice(0,120), tag: i.key }); nn.onclick=function(){ window.focus(); location.href='/jrm/hotels/'+i.requestId+'/'; }; } } catch(e){} }
// ---- polling
function poll(){
  fetch(FEED, {credentials:'same-origin', cache:'no-store'}).then(function(r){ return r.ok ? r.json() : null; }).then(function(j){
    if (!j || !j.items) return;
    var prev={}; items.forEach(function(i){ prev[i.key]=1; });
    items=j.items;
    // first time this browser sees the bell: only the last 24h count as unread (older backlog is history, not news)
    if (firstEver) { items.forEach(function(i){ if (Date.now()-Date.parse(i.at) > 86400000) seen[i.key]=Date.now(); }); save(); firstEver=false; }
    // auto-mark the request you are looking at
    var m=location.pathname.match(/^\\/jrm\\/hotels\\/(\\d+)\\/?$/); if (m) { var rid=Number(m[1]); var ch=false; items.forEach(function(i){ if(i.requestId===rid && !seen[i.key]){ seen[i.key]=Date.now(); ch=true; } }); if (ch) save(); }
    var fresh=items.filter(function(i){ return !seen[i.key] && !prev[i.key] && (!firstPoll || (lastAt && i.at>lastAt)); });
    if (fresh.length) { bell.classList.add('nib-pulse'); ding(); fresh.slice(0,3).forEach(function(i){ toast(i); notify(i); }); }
    firstPoll=false; lastAt=new Date().toISOString(); try{ localStorage.setItem(LS_LAST,lastAt); }catch(e){}
    render();
  }).catch(function(){});
}
poll(); setInterval(poll, POLL);
document.addEventListener('visibilitychange', function(){ if (!document.hidden) poll(); });
})();</script>`;

/** Inject the bell/badge UI into a staff CRM page. Never on login or public marketing pages. */
export function injectIntakeUi(html, path, opts = {}) {
  if (!html || typeof html !== "string") return html;
  if (html.includes(`${INTAKE_UI_MARKER}-js`)) return html;
  const original = opts.staffCheckHtml || html;
  if (LOGIN_RE.test(original)) return html;
  if (!/<html|<head|<body|<nav|<main/i.test(html)) return html; // not a page
  let out = html;
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, `${CSS}</head>`);
  else out = CSS + out;
  // The CRM templates never close <body>/<html> — append however we can.
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, `${SCRIPT}</body>`);
  else if (/<\/html>/i.test(out)) out = out.replace(/<\/html>/i, `${SCRIPT}</html>`);
  else out = out + SCRIPT;
  return out;
}
