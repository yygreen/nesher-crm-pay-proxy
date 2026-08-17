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

## JRM Inbox bell (intake-ui.js)

Unread badge / bell / NEW markers for leads auto-filed by the jrm-lead-intake service. Feed API `/__nesher_intake/feed/` (staff session). Full build doc: `C:\Users\User\jrm-lead-intake\docs\BUILD-DOC.html` and https://docs.google.com/document/d/1trJWjAAVgZXl5AamVDpmhjpAaYl15okRSWUR7U0mKC0/edit?usp=drivesdk
