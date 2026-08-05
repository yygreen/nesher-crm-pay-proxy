# Nesher / FlyNesher — Mercury Pay Invoice Modal  
## Background + design brief for Claude

**Status (2026-08-05):** Backend + flexible draft logic is **live and correct**. UI is functional but **messy / poorly structured**. Design-only redesign of the modal (and small related chrome). Do **not** change payment rules, API contracts, or CRM data logic unless required for layout.

---

## 1. What this product is

**Nesher / FlyNesher** is a travel CRM (Django) for hotels (JRM) and flight/service reservations. Staff create **Mercury AR payment links** so customers can pay by card/ACH.

We run an edge reverse-proxy (`nesher-crm-pay-proxy` on Railway) on:

- `https://crm.flynesher.com`
- `https://www.flynesher.com`

The proxy:

1. Proxies normal CRM pages to the Django app.
2. Injects green **Mercury Pay** buttons on hotel + reservation list/detail pages.
3. Serves `/__nesher_pay/*` APIs that build a rich invoice draft from CRM DB + create Mercury invoices.
4. Also hosts a WhatsApp staff UI (unrelated to this design task).

**Repo:** `C:\Users\User\nesher-crm-pay-proxy` (GitHub `yygreen/nesher-crm-pay-proxy`)  
**Key UI file:** `inject.js` (CSS + modal HTML + client JS — all injected into CRM HTML)  
**Draft/API logic:** `draft.js`, `server.js`, `db.js`, `mercury.js`

---

## 2. Product goals (non-negotiable product rules)

Two requirements that must both feel true in the UI:

### A. Perfect, detail-rich invoices (when CRM has data)
The customer-facing Mercury invoice memo + line items should pack **every useful booking detail**:

**Reservations (Fly Nesher / services):**
- Booking / PNR code
- CRM reservation id
- Customer name, email, phone
- Booking method
- Quoted total, amount already paid, amount due (USD)
- Price source (e.g. journey line sum)
- Travelers (names)
- Flights (airline, number, route, dates/times)
- Service / ticket lines with prices + confirmation numbers

**Hotels (JRM):**
- CRM request # + offer #
- Invoice number (`JRM-1{req}-O{offer}`)
- Customer name, email, phone
- Hotel name, room type, city
- Stay / check-in / check-out
- Guests (adults/children/rooms) when present
- Quoted amount + currency + VAT
- Amount due in USD (ILS converted with Nesher rule: spot × 1.03)

### B. Never hard-fail — always a path to create
If price, email, name, or offer is missing:

- Still open a useful screen
- **Say exactly what is missing** (required vs optional)
- **Let staff fill it in on that same screen**
- Create the link once amount (+ email, always resolved) is present
- Missing CRM email → placeholder `booking+{ref}@jrmhotels.com` (warn, allow override)

**Never** show only a red error and stop. Soft path always.

---

## 3. Current user flow

1. Staff is logged into CRM, on:
   - `/reservations/` or `/reservations/{id}/`
   - `/jrm/hotels/` or `/jrm/hotels/{id}/` (per-offer: “Mercury Pay (this quote)”)
2. Clicks teal **Mercury Pay / Pay due / Pay quote** button.
3. Modal opens after `GET /__nesher_pay/{kind}/{id}/` returns a draft JSON.
4. Staff reviews preview, edits fields if needed, clicks **Create payment link**.
5. `POST` with overrides → Mercury invoice → pay URL shown + copied to clipboard + CRM note written.

Kinds: `reservation` | `hotel` | `hotel-offer`

---

## 4. API contract the UI must keep (do not redesign away)

### GET `/__nesher_pay/{kind}/{id}/` → draft preview
```json
{
  "ok": true,
  "preview": true,
  "kind": "reservation" | "hotel",
  "canCreate": true | false,
  "needsInput": true | false,
  "missing": [
    {
      "field": "amountUsd" | "customerEmail" | "customerName" | "offerId" | "crmPrice" | "...",
      "label": "Amount due (USD)",
      "reason": "Human explanation…",
      "required": true
    }
  ],
  "advice": ["One or more short guidance strings"],
  "draft": {
    "customerName": "…",
    "customerEmail": "…",
    "emailPlaceholder": false,
    "amountUsd": 2604,
    "currency": "USD",
    "invoiceNumber": "RES-… or JRM-…",
    "lineItems": [{ "name": "…", "unitPrice": 2604, "quantity": 1 }],
    "lineItemName": "…",
    "payerMemo": "Multiline memo shown on Mercury invoice…",
    "summary": "One-line summary for list chrome",
    "details": { /* structured booking facts for richer UI if desired */ }
  }
}
```

### POST body (create)
```json
{
  "create": true,
  "amountUsd": 2604,
  "customerEmail": "…",
  "customerName": "…",
  "invoiceNumber": "…",
  "lineItemName": "…",
  "payerMemo": "optional staff note appended to memo"
}
```

### Success response
```json
{
  "ok": true,
  "payUrl": "https://app.mercury.com/pay/…",
  "reused": false,
  "invoiceNumber": "…",
  "amountUsd": 2604,
  "draft": { /* same shape */ }
}
```

### Soft “not ready” (HTTP 200, not 400)
```json
{
  "ok": false,
  "needsInput": true,
  "message": "Cannot create yet — fill required fields…",
  "missing": [ … ],
  "advice": [ … ],
  "draft": { … }
}
```

---

## 5. What exists today (and why it feels messy)

**Implementation:** vanilla JS + CSS string inside `inject.js` (no React/Vue). Injected into Django CRM pages.

**Current layout (top → bottom, single narrow column ~560px):**

1. Teal header bar + title + ×  
2. Green/amber **advice** box (often repeats missing info)  
3. Red **“What still needs attention”** bullet list (duplicates field labels)  
4. Form fields stacked: Amount, Email, Name, Invoice #, Line item title, Extra staff note  
5. **Invoice preview** = monospace `<pre>` dump of the raw memo + raw line list  
6. Footer: Cancel | Create payment link  
7. Status line for errors / success URL  

**Pain points (design debt):**
- Advice + missing list + form = triple redundancy
- Everything same visual weight — no hierarchy between “must fix” vs “nice review”
- Raw memo dump looks like a debug log, not a customer invoice
- No clear **summary strip** (who · booking · $ due)
- Success state re-renders the whole form; URL is easy to miss
- Modal feels like an engineer’s admin panel, not a calm staff tool
- Teal works as brand accent but head is heavy; body is flat gray boxes
- Mobile: long scroll, no sticky primary action
- No progressive disclosure (advanced fields always open)
- List-page buttons can wrap messily next to CRM links

**What is fine to keep:**
- Product logic / API / field names
- Teal accent family (`#0f766e` / similar — FlyNesher / money / trust)
- Injected modal pattern (no new SPA framework required)
- English UI (staff English; customers may be Hebrew-speaking but memo is English today)

---

## 6. Brand / audience

| | |
|---|---|
| **Users** | Travel agents / ops staff (busy, 10 seconds to get a link) |
| **Context** | Embedded in existing Django CRM (not a standalone SaaS homepage) |
| **Tone** | Professional, calm, precise — not playful fintech startup |
| **Brand names** | Nesher, FlyNesher, JRM Hotels, Mercury (pay processor) |
| **Accent** | Teal/emerald (existing buttons) |
| **Avoid** | Purple AI gradients, dark neon crypto, cluttered dashboards |

---

## 7. Design goals for the redesign

1. **Scan in 2 seconds:** Who · what booking · how much · ready or not.
2. **One primary path:** Fix gaps → create link → copy/open URL.
3. **Structure the invoice preview** like a real invoice (header, line table, total, memo as readable body) — not a raw log.
4. **Missing data without shame:** Clear, calm callouts next to the fields that need input; no triple warnings.
5. **Progressive disclosure:** Core fields always visible; advanced (invoice #, line title, staff note) collapsed by default.
6. **Success state is its own clean screen:** Big pay link, Copy, Open, Done — not a buried status line.
7. **Works on 1280px desktop and phone** (staff sometimes use phone).
8. **Accessible:** focus trap, Escape, labels, contrast.
9. **Drop-in to `inject.js`:** Prefer pure CSS + small HTML structure changes; keep IDs the form JS already uses if possible:
   - `#nesher-f-amount`, `#nesher-f-email`, `#nesher-f-name`, `#nesher-f-inv`, `#nesher-f-line`, `#nesher-f-memo`
   - `#nesher-pay-create`, `#nesher-pay-status`, `#nesher-pay-body`, `#nesher-pay-modal-root`

---

## 8. Suggested information architecture (for the designer)

### State A — Loading
Skeleton or subtle spinner: “Loading booking details…”

### State B — Review & edit (default)
```
┌─────────────────────────────────────────────┐
│  Create payment link                    [×] │
│  RES · SVC-194-… · Mendy Tambor            │  ← summary strip
├─────────────────────────────────────────────┤
│  AMOUNT DUE                    $ 2,604.00   │  ← hero number (editable)
│  [edit amount if needed]                    │
│                                             │
│  Customer                                   │
│  Name  […………]   Email […………]  ⚠ placeholder │
│                                             │
│  ┌─ Invoice preview ─────────────────────┐  │
│  │  Line items table                      │  │
│  │  Total                                 │  │
│  │  Details (travelers, flights, stay)    │  │
│  │  as clean sections — not pre dump      │  │
│  └────────────────────────────────────────┘  │
│                                             │
│  ▸ Advanced (invoice #, line title, note)   │
│                                             │
│  [Cancel]              [Create payment link]│
└─────────────────────────────────────────────┘
```

If `needsInput` / required missing: soft amber banner **once**, and highlight the empty required field(s). Do **not** also list the same text in a red box above.

### State C — Success
```
┌─────────────────────────────────────────────┐
│  Payment link ready                     [×] │
│  $2,604 · RES-… · Mendy Tambor             │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  https://app.mercury.com/pay/xxxxx  │   │
│  └─────────────────────────────────────┘   │
│  [Copy link]  [Open in Mercury]  [Done]    │
│  Optional: “Existing unpaid link reused”   │
└─────────────────────────────────────────────┘
```

### State D — Soft error / Mercury failure
One clear message + keep form values + Retry.

---

## 9. Sample real data (for mockups)

### Reservation ready (live example shape)
- Customer: Mendy Tambor  
- Email: info@flynesher.com  
- Booking: `SVC-194-20260804145928`  
- Amount due: **$2,604.00**  
- Line: “Tickets nissan bayer” $2604  
- Invoice: `RES-SVC-194-20260804145928`  
- Advice: “All key details found…”

### Reservation missing price (design this carefully)
- Customer name may be empty  
- Email placeholder: `booking+resnoprice@jrmhotels.com`  
- Amount: empty / $0  
- Required: Amount due  
- Optional: real email, customer name  
- Memo still shows booking id if known  

### Hotel quote
- Hotel: Inbal, Jerusalem  
- Stay: 2026-09-10 → 2026-09-15  
- Offer #50, Request #89  
- Amount: $1,200 USD (or ILS source converted)  
- Invoice: `JRM-189-O50`

---

## 10. Deliverables expected from Claude (design pass)

1. **Visual design** of States B + C (+ optional A/D) — desktop and mobile.
2. **Component structure** (sections, hierarchy, spacing scale).
3. **Concrete CSS + HTML structure** ready to drop into `inject.js` (`CSS` constant + `renderModal()` markup).
4. Keep form field IDs above so create/submit JS barely changes.
5. Optional: tidy the **list/detail button** chrome (`.nesher-mercury-btn`, link next to it) so it doesn’t look slapped on.
6. Short rationale: why this structure is clearer for a busy agent.

**Out of scope:**
- Changing Mercury API, quote math, ILS×1.03 rule
- Redesigning whole CRM or WhatsApp UI
- New frameworks / build steps
- Hebrew RTL layout (unless trivial to leave ready)

---

## 11. Paste-ready prompt for Claude

Copy everything below the line into Claude:

---

**Prompt:**

You are a product designer + front-end implementer. Redesign the **Nesher / FlyNesher Mercury payment-link modal** so it is calm, structured, and scannable. Backend is done and live; the current UI is messy.

### Context
- Staff tool embedded in a Django travel CRM via injected CSS/JS (`inject.js`).
- Creates Mercury pay links for hotel quotes and reservation balances.
- Must support two goals at once: (1) rich invoice detail when CRM has data; (2) never hard-fail — show exactly what’s missing and let staff fill it in on the same screen.
- Brand accent: teal `#0f766e`. Audience: busy travel ops staff. Tone: professional, not startup-playful.
- No React. Pure HTML/CSS/vanilla JS strings in `inject.js`.

### Current problems
- Advice banner + red missing list + form fields triple-repeat the same info.
- Invoice preview is a raw monospace memo dump (looks like debug output).
- No visual hierarchy (who / booking / amount).
- Success state is weak (URL buried in a status line).
- Advanced fields always visible; modal feels engineer-built.
- Long single column, max-width 560px, heavy teal header.

### What you must preserve
- Field IDs: `#nesher-f-amount`, `#nesher-f-email`, `#nesher-f-name`, `#nesher-f-inv`, `#nesher-f-line`, `#nesher-f-memo`
- Buttons: `#nesher-pay-create`, cancel/close, `#nesher-pay-status`
- Root: `#nesher-pay-modal-root`, body `#nesher-pay-body`
- API draft JSON shape (amountUsd, customerEmail, customerName, invoiceNumber, lineItems, payerMemo, missing[], advice[], canCreate, needsInput, details)
- Soft-fail behavior: missing amount → highlight amount field + short guidance, still show whatever booking detail we have
- English copy

### Design requirements
1. **Summary strip** under title: booking code · customer · $ amount due.
2. **Hero amount** editable, primary visual weight.
3. **Customer block**: name + email; badge if email is placeholder.
4. **Invoice preview** structured like a real invoice: line items table, total, then secondary details (travelers, flights, hotel stay) as clean sections — **not** a raw `<pre>` dump of the whole memo (memo can be “details” or collapsible).
5. **Missing data UX**: one calm banner max; required empty fields highlighted; remove the redundant red bullet list if fields already show the problem.
6. **Advanced** collapsed by default: invoice number, line item title, staff note.
7. **Success state**: dedicated clean panel with pay URL, Copy, Open, Done; show if link was reused.
8. Sticky footer actions on mobile; Escape/close; good focus/contrast.
9. Keep teal accent; improve spacing, type scale, and sectioning so it doesn’t feel messy.

### Sample data for mockups
- Ready reservation: Mendy Tambor · SVC-194-20260804145928 · $2,604 · line “Tickets nissan bayer” · email info@flynesher.com
- Missing price: empty amount, placeholder email `booking+res…@jrmhotels.com`, still show reservation id if known
- Hotel: Inbal, Jerusalem, 2026-09-10→15, JRM-189-O50, $1,200

### Deliverables
1. Redesigned layout description (desktop + mobile) for Review and Success states.
2. Drop-in CSS + HTML for `inject.js` (`CSS` constant + `renderModal` structure) preserving field IDs.
3. Minimal JS notes if success state needs a separate render path.
4. Optional polish for the green “Mercury Pay” button + result link next to CRM rows.

Do not change payment business rules. Prefer clarity over decoration. Ship implementable CSS/HTML, not only Figma prose.

---

## 12. Implementation note for whoever codes after design

After Claude returns CSS/HTML:

1. Replace `CSS` and the modal markup / `renderModal()` in `inject.js`.
2. Keep `submitCreate` / `openPayFlow` field IDs working.
3. Run `npm test` (includes inject tests).
4. Deploy Railway service `nesher-pay-proxy` (Dockerfile must COPY all `*.js` used by server).
5. Live-check: open reservation 345 → modal → structure looks good; create still works.

---

*Generated for design handoff · flexible invoice system live · UI polish next.*
