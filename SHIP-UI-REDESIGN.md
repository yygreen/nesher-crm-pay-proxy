# Ship the Mercury Pay modal UI redesign — full implementer handoff

**Read this if you will actually code, test, commit, push, and verify live.**  
Design brief alone is not enough. This is the ops + code map.

---

## 0. Mission

Redesign the **Mercury payment-link modal** (and optionally the pay button chrome) so staff get a clean, structured UI. **Backend is already correct and live.** You mostly touch **one file**: `inject.js`.

Do **not** change payment math, Mercury API, soft-fail rules, or CRM SQL unless a tiny hook is required for the new layout.

---

## 1. Repo & machine paths

| Item | Value |
|------|--------|
| Local path | `C:\Users\User\nesher-crm-pay-proxy` |
| GitHub | `https://github.com/yygreen/nesher-crm-pay-proxy.git` |
| Default branch | **`main`** (production) |
| Runtime | Node 20 ESM (`"type": "module"`) |
| Hosting | Railway project **romantic-caring**, service **`nesher-pay-proxy`** |
| Live hosts | `https://crm.flynesher.com` and `https://www.flynesher.com` (both hit this proxy) |

```powershell
cd C:\Users\User\nesher-crm-pay-proxy
git status
git pull origin main
```

---

## 2. What file(s) to edit

### Primary (almost always only this)

**`inject.js`**

Contains three big string/function areas:

1. **`CSS`** — `<style id="nesher-mercury-pay-css">…</style>`  
2. **`SCRIPT`** — browser IIFE with modal logic (`renderModal`, `submitCreate`, `openPayFlow`, …)  
3. **`injectPayButtons(html, path)`** — where buttons are injected into CRM HTML  

Also exports: `BUTTON_MARKER`, `buttonHtml`, `CSS`, `SCRIPT`.

### Usually leave alone

| File | Why |
|------|-----|
| `server.js` | Pay API + proxy; no design |
| `draft.js` | Draft / missing fields / memo text |
| `db.js` | CRM SQL |
| `mercury.js` | Mercury HTTP |
| `quote.js` | Email placeholder + quote snapshots |
| `auth.js` | Staff session check |
| `whatsapp-*.js` | Unrelated |
| `Dockerfile` | Only if you **add a new .js file** to the app |

### Dockerfile trap (critical)

Image is built with an **explicit file list**, not `COPY . .`:

```dockerfile
COPY mercury.js inject.js db.js auth.js quote.js http.js draft.js whatsapp-ui.js whatsapp-media.js server.js ./
```

- Editing **`inject.js` only** → no Dockerfile change needed (file already listed).  
- If you create a **new** module imported by `server.js` → add it to that `COPY` line or the container crashes with `ERR_MODULE_NOT_FOUND` (this already bit us with `draft.js`).

---

## 3. How the UI gets to production (injection model)

There is **no React, no Vite, no separate frontend deploy**.

1. Staff opens a CRM page (`/reservations/…`, `/jrm/hotels/…`).
2. Proxy buffers HTML and calls `injectPayButtons(html, path)` then WhatsApp inject.
3. `inject.js` injects CSS + JS into `</head>` / `</body>` and green pay buttons.
4. Browser runs the injected script; modal is pure DOM.

**Cache note:** hard-refresh after deploy (`Ctrl+Shift+R`). Injection is per HTML response; no CDN for the script.

---

## 4. Stable IDs / contracts you must not break

### Form fields (read by `readFormOverrides()`)

| ID | Purpose | POST body key |
|----|---------|----------------|
| `#nesher-f-amount` | Amount USD | `amountUsd` |
| `#nesher-f-email` | Customer email | `customerEmail` |
| `#nesher-f-name` | Customer name | `customerName` |
| `#nesher-f-inv` | Invoice number | `invoiceNumber` |
| `#nesher-f-line` | Line item title | `lineItemName` |
| `#nesher-f-memo` | Staff note | `payerMemo` |

### Modal shell

| ID / class | Role |
|------------|------|
| `#nesher-pay-modal-root` | Overlay root; class `open` shows it |
| `#nesher-pay-body` | Dynamic body (`renderModal` sets `innerHTML`) |
| `#nesher-pay-title` | Title text |
| `#nesher-pay-status` | Error/success line |
| `#nesher-pay-create` | Primary button → `submitCreate` |
| `.nesher-pay-close` / `.nesher-pay-cancel` | Close |

### Buttons on CRM pages

- Attribute: `data-nesher-mercury-pay` (`BUTTON_MARKER`)
- `data-kind`: `reservation` | `hotel` | `hotel-offer`
- `data-id`: numeric CRM id
- `data-label`: restore label after loading

### API paths (same origin)

```
GET  /__nesher_pay/reservation/{id}/
GET  /__nesher_pay/hotel/{id}/
GET  /__nesher_pay/hotel-offer/{id}/
POST same URLs with JSON body { create: true, amountUsd, customerEmail, ... }
```

Staff must be logged in (Django `sessionid` cookie). API returns 401 if not.

### Response shapes (UI must handle)

**Preview (GET):**
```json
{
  "ok": true,
  "preview": true,
  "canCreate": true,
  "needsInput": false,
  "missing": [{ "field": "amountUsd", "label": "...", "reason": "...", "required": true }],
  "advice": ["..."],
  "draft": {
    "customerName": "...",
    "customerEmail": "...",
    "emailPlaceholder": false,
    "amountUsd": 2604,
    "invoiceNumber": "RES-...",
    "lineItems": [{ "name": "...", "unitPrice": 2604, "quantity": 1 }],
    "lineItemName": "...",
    "payerMemo": "multiline...",
    "summary": "one line",
    "details": { }
  }
}
```

**Create success (POST):**
```json
{
  "ok": true,
  "payUrl": "https://app.mercury.com/pay/...",
  "reused": false,
  "amountUsd": 2604,
  "invoiceNumber": "...",
  "draft": { }
}
```

**Soft incomplete (POST, still HTTP 200):**
```json
{
  "ok": false,
  "needsInput": true,
  "message": "...",
  "missing": [],
  "draft": { }
}
```

Use `data.payUrl` as success signal. Use `data.needsInput` / missing amount to re-render edit form.

---

## 5. Functions in `SCRIPT` you will touch

| Function | What to do |
|----------|------------|
| `CSS` constant | Replace with new design styles |
| `ensureModal()` | Optional: new shell HTML (keep IDs + event wiring) |
| `renderModal(data)` | **Main redesign** — structure body from `data.draft` / `missing` / `advice` |
| `readFormOverrides()` | Keep reading same field IDs; extend only if you add fields |
| `submitCreate()` | Prefer add a **success render** path when `data.payUrl` is set; keep POST shape |
| `openPayFlow()` | Usually unchanged |
| `buttonHtml` / list inject | Optional polish only |

### Success state

Today, on success, code often re-calls `renderModal(data)` then `setStatus(url)`.  
**Redesign should** render a dedicated success panel (URL + Copy + Open + Done) when `data.payUrl` is present.

Example branch in `submitCreate` after success:

```js
if (data.payUrl) {
  renderSuccess(data);  // new function you add
  // still update wrap link + clipboard as today
  return;
}
```

### Escaping

Always use `esc()` for any string put into HTML. Never inject raw CRM fields.

### SCRIPT is a template literal

`const SCRIPT = \`...\`;` — be careful with backticks and `${` inside the browser JS. Existing code uses string concat for HTML to avoid nested template issues. Prefer the same pattern.

---

## 6. Design goals (product)

Full IA: see `DESIGN-BRIEF-pay-modal.md`.

Short version:

1. Summary strip: booking · customer · amount  
2. Hero editable amount  
3. Customer name + email (+ placeholder badge)  
4. Structured invoice preview (table + details), **not** a raw `<pre>` dump  
5. One calm missing-data cue; no triple warnings  
6. Advanced fields collapsed (invoice #, line title, staff note)  
7. Dedicated success screen  
8. Teal accent `#0f766e`  
9. Mobile-friendly sticky footer  

---

## 7. Local test (required before push)

```powershell
cd C:\Users\User\nesher-crm-pay-proxy
npm test
```

- Runner: `node --test test/*.test.js`  
- Inject coverage: `test/mercury.test.js`, `test/draft.test.js` (checks button marker + modal assets)  
- If you change markup strings tests look for, **update tests** so they still assert:
  - `data-nesher-mercury-pay` present on reservation/hotel pages
  - modal-related markers still present (e.g. `nesher-pay-create` or `nesher-f-amount`)
  - inject is idempotent

Optional syntax check of emitted browser script (already in `test/whatsapp-ui.test.js` style patterns).

**You do not need** DATABASE_URL or MERCURY_TOKEN for a pure UI change.

---

## 8. Commit & push (this deploys)

Railway watches **`main`** on this repo for service `nesher-pay-proxy`.

```powershell
cd C:\Users\User\nesher-crm-pay-proxy
git pull origin main
# edit inject.js (+ tests if needed)
npm test
git add inject.js test/
git status   # confirm only intended files
git commit -m "ui: redesign Mercury pay modal for clarity"
git push origin main
```

### Auth for git

- Push needs access to `yygreen/nesher-crm-pay-proxy` (HTTPS token or SSH as already configured on this machine).  
- Do **not** commit secrets (`.env`, tokens, cookies). `.gitignore` has `node_modules/`, `.env`, `scratch-*`.

### After push

1. Wait ~1–3 minutes for Railway build + deploy.  
2. Confirm health:

```powershell
curl.exe -sS "https://crm.flynesher.com/__nesher_pay/health"
# expect: {"ok":true,...,"hasMercury":true,"hasDb":true}
```

3. If deploy **CRASHED**, check Railway logs for `ERR_MODULE_NOT_FOUND` → you added a file without Dockerfile COPY.

### Force redeploy (if auto-deploy stuck)

Railway GraphQL with project token (in `C:\Users\User\.api-keys.env` as `RAILWAY_PROJECT_TOKEN`):

- Project id: `b1c9a5a0-6b73-470a-8f48-9fd07817b1aa`  
- Environment id: `d6681e4d-5562-4f52-b560-175689ccfb00`  
- Service id (`nesher-pay-proxy`): `964d731e-6768-4a49-95fd-16799d910c47`  

```http
POST https://backboard.railway.app/graphql/v2
Header: Project-Access-Token: <RAILWAY_PROJECT_TOKEN>
Header: Content-Type: application/json

{"query":"mutation($serviceId: String!, $environmentId: String!) { serviceInstanceDeploy(serviceId: $serviceId, environmentId: $environmentId) }","variables":{"serviceId":"964d731e-6768-4a49-95fd-16799d910c47","environmentId":"d6681e4d-5562-4f52-b560-175689ccfb00"}}
```

---

## 9. Live verify (staff session)

UI only loads when logged into CRM.

**Staff login (CRM):**

- URL: `https://crm.flynesher.com/login/`  
- Username: `info` (or `info@orchim.com` depending on form; `info` worked)  
- Password: use the known ops password for that admin (do not put passwords in commits; available in operator env / prior session notes).

**Manual check:**

1. Open `https://crm.flynesher.com/reservations/345/`  
2. Hard-refresh.  
3. Click **Mercury Pay (balance due)**.  
4. Confirm new layout (summary, hero amount, structured preview).  
5. Optional: create/reuse link — must still return `payUrl` and copy.  
6. Also spot-check `/jrm/hotels/89/` offer pay button.

**API smoke (after cookie jar login):**

```text
GET https://crm.flynesher.com/__nesher_pay/reservation/345/
→ canCreate true, draft.amountUsd 2604-ish, payerMemo present
```

---

## 10. What NOT to do

- Do not rewrite `server.js` pay flow “for the redesign.”  
- Do not add npm UI frameworks or a build step without explicit owner approval.  
- Do not remove soft-fail (empty amount must still open modal).  
- Do not send Mercury emails (`sendEmailOption: DontSend` stays server-side).  
- Do not change invoice number schemes (`RES-…`, `JRM-1{req}-O{offer}`).  
- Do not force-push `main`.  
- Do not commit cookie jars, tokens, or `scratch-*` files.

---

## 11. Suggested implementation order

1. Read current `inject.js` (`CSS`, `renderModal`, `submitCreate`, `ensureModal`).  
2. Sketch new HTML structure preserving field IDs.  
3. Replace `CSS`.  
4. Rewrite `renderModal(data)` for Review state.  
5. Add `renderSuccess(data)` and call it from `submitCreate` when `payUrl` exists.  
6. Collapse Advanced with a `<details>` or toggle (no new deps).  
7. `npm test` → fix tests if string markers changed.  
8. Commit + push `main`.  
9. Health check + browser hard-refresh on reservation 345.  

---

## 12. Paste-ready prompt for Claude Code / implementer agent

```
Implement and ship a UI redesign of the Nesher Mercury pay modal.

Repo: C:\Users\User\nesher-crm-pay-proxy
GitHub: yygreen/nesher-crm-pay-proxy  branch main
Live: crm.flynesher.com + www.flynesher.com (Railway service nesher-pay-proxy)

READ FIRST:
- SHIP-UI-REDESIGN.md (this ship guide)
- DESIGN-BRIEF-pay-modal.md (design goals + API shapes)

WORK:
1. Redesign only inject.js (CSS + ensureModal shell if needed + renderModal + success state in submitCreate).
2. Preserve field IDs: nesher-f-amount, nesher-f-email, nesher-f-name, nesher-f-inv, nesher-f-line, nesher-f-memo
   and #nesher-pay-create, #nesher-pay-body, #nesher-pay-modal-root, #nesher-pay-status, #nesher-pay-title.
3. Keep POST body keys and GET/POST /__nesher_pay/* behavior.
4. Design goals: summary strip, hero amount, customer block, structured invoice preview (not raw pre dump),
   one missing-data cue, advanced collapsed, dedicated success panel with Copy/Open, teal #0f766e.
5. npm test must pass. Update inject tests if needed.
6. Commit and push to origin main.
7. Wait for Railway; curl https://crm.flynesher.com/__nesher_pay/health → ok:true.
8. If you add any NEW .js imported by server, update Dockerfile COPY list.

DO NOT change draft.js payment rules, mercury create logic, or db.js unless absolutely required.
DO NOT commit secrets.

Report: commit sha, test result, health JSON, and what the new modal structure looks like.
```

---

## 13. Quick reference — current key code locations in `inject.js`

| Piece | Approx. name |
|-------|----------------|
| Styles | `const CSS = \`…\`` |
| Browser app | `const SCRIPT = \`…\`` |
| Modal shell | `ensureModal()` |
| Edit form body | `renderModal(data)` |
| Collect fields | `readFormOverrides()` |
| Create + success | `submitCreate()` |
| Open from button | `openPayFlow(kind, id, btn)` |
| Inject into CRM | `export function injectPayButtons(html, path)` |

---

*Handoff for implement-and-push. UI redesign only; flexible invoice backend already live.*
