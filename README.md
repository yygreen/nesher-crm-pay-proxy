# Nesher CRM Mercury Pay Proxy

Railway service that sits in front of **Nesher-CRM** and injects **Mercury Pay Link** buttons on:

- `/jrm/hotels/` (list + detail)
- `/reservations/` (list + detail)

## What the button does

1. Staff must be logged into the CRM (session cookie).
2. Click **Mercury Pay Link** / **Pay**.
3. Server loads customer name/email + price from Postgres.
4. Creates or reuses a Mercury AR invoice (`sendEmailOption: DontSend`).
5. Returns `https://app.mercury.com/pay/<slug>` and shows it in the UI (also copies to clipboard when possible).
6. Writes a short note on the hotel request / reservation.

## Invoice numbers

- Hotels: `JRM-1{requestId}-O{offerId}` (highest priced offer)
- Reservations: `RES-{reservation_code}` for balance `customer_price - amount_paid`
- ILS hotel prices → USD at live spot × 1.03 (Nesher rule)

## Extra hotel-request status: "Not Interested / Can't Help"

The CRM renders the **Change Status** dropdown from its own Django choices, so this
service adds the extra choice on the way to the browser (`status-option.js`) and saves
it itself:

- Injected only on `/jrm/hotels/<id>/`, into the select the **Change Status** card owns.
- Saving goes to `POST /__nesher_status/hotel/<id>/`, not through the CRM form — a value
  Django has never heard of would otherwise be rejected on validation and look like a
  no-op to staff.
- The stored string is discovered at runtime from the column itself (length limit +
  the vocabulary already in use), so it matches the CRM's own casing/slug style.
- On load the option is re-selected when the stored status is ours; without that the
  browser falls back to showing the first option ("New") and the request looks untouched.

Scope: it writes `core_jrmhotelrequest.status` and nothing else — no notes, no
timestamps, no other rows — and the endpoint refuses any value except the added one.
Because Django does not run the save, anything the CRM would normally do on a status
change (signals, history rows) does not happen for this one choice.

## Railway env (service `nesher-pay-proxy`)

| Variable | Purpose |
|----------|---------|
| `MERCURY_TOKEN_NESHER` | Full `secret-token:…` value |
| `MERCURY_DESTINATION_ACCOUNT_ID` | Checking account for AR (default Nesher ••5649) |
| `CRM_UPSTREAM` | `https://nesher-crm-production.up.railway.app` |
| `DATABASE_URL` | Public Postgres URL |
| `MERCURY_API_BASE` | Optional. When Railway egress IP is not on the Mercury token whitelist, point at a local relay (see `C:\Users\User\nesher-mercury-relay`) |

## Mercury IP whitelist

If create fails with `ipNotWhitelisted` for Railway IP `35.188.247.1`, either:

1. Add that IP to the Mercury API token whitelist in the dashboard, and clear `MERCURY_API_BASE`, or
2. Run `nesher-mercury-relay\start-relay.cmd` and set `MERCURY_API_BASE` to the tunnel URL.

## Develop

```bash
npm test
npm start
```
