# Nesher CRM (crm.flynesher.com) — working map for Claude Code

## What this repo is

`crm.flynesher.com` and `www.flynesher.com` are served by **this Node proxy**
(Railway service `nesher-pay-proxy`). Every request goes:

    browser → this proxy (server.js) → Django CRM upstream
              https://nesher-crm-production.up.railway.app

The Django CRM ("Nesher-CRM", built by Richter) is a **separate codebase we do
not have**. Every customisation of the CRM is therefore done here, by:

1. **Rewriting the HTML** Django returns (injectors), or
2. **Adding our own routes** in front of Django (`/__nesher_*`, `/board`, `/pay/…`), or
3. **Reading/writing the CRM's Postgres directly** (`db.js`, `DATABASE_URL`).

So "change the CRM" almost always means: edit an injector or add a route here,
`npm test`, push, deploy.

## File map

| File | Role |
|------|------|
| `server.js` | HTTP entry. Route dispatch (search `url.pathname`), `proxyWithInject()` decides which pages get which injectors. Health: `GET /__nesher_pay/health` (bump the `build` tag on every deploy). |
| `inject.js` | Mercury **Pay Link** button + modal (CSS / SCRIPT strings) on `/jrm/hotels/*`, `/reservations/*`; PAID badges. |
| `draft.js`, `quote.js`, `mercury.js`, `invoice-*.js`, `payments-sync.js` | Invoice drafting, Mercury AR API, guest pay page `/pay/<slug>`, paid-invoice sync. |
| `db.js` | All CRM SQL (Postgres, Django tables e.g. `core_jrmhotelrequest`, `core_reservation`). |
| `auth.js` | Staff-session check: validates the Django `sessionid` cookie against upstream. Use `requireStaff()` in server.js for any new staff route. |
| `whatsapp-ui.js`, `whatsapp-media.js`, `whatsapp-webhook.js` | WhatsApp inbox UI on `/whatsapp/*`, Meta media/send API, webhook `/__nesher_wa/webhook/`. |
| `intake-ui.js` | JRM Inbox bell / unread badge on every staff page; feed `/__nesher_intake/feed/`. |
| `status-extra.js` | Adds one extra hotel-request status ("Not interested/Can't help") on top of Django's fixed choices. Pattern to copy for other "Django won't accept this value" cases. |
| `board.js` | `/board` — all-tasks board across the team (staff-gated). |
| `snapengage.js`, `public-ui.js` | Public marketing pages on www.flynesher.com only (live chat, WhatsApp button). |
| `test/*.test.js` | `node --test`. Injector tests assert markers + idempotency. |

### Which pages get injected (server.js `proxyWithInject`)

- **staffCore** = `/jrm/hotels*`, `/reservations*`, `/whatsapp*`, `/customers/<id>` → pay buttons, WhatsApp UI, paid badges, status-extra.
- Every other staff page (`INTAKE_UI_PATH_RE`) → only the JRM Inbox bell.
- Public marketing paths → SnapEngage / public UI only. **Never** let staff injectors run there.
- Only `GET` HTML responses are rewritten; everything else is streamed through untouched.

## Rules that have bitten before

- **New `.js` file ⇒ add it to the `COPY` line in `Dockerfile`**, or the container
  crashes on boot (`ERR_MODULE_NOT_FOUND`) and the whole CRM 502s.
- Keep injectors idempotent (check for their own marker before inserting).
- Don't widen the `staffCore` path set casually (8/12 outage).
- Never commit secrets. Tokens live in Railway env vars (see README table).
- Bump `build` in the health JSON in `server.js` with each shippable change.

## Develop

```bash
npm install          # SessionStart hook already does this on the web
npm test             # 116 tests, ~2s, needs no secrets
node --check <file>  # no linter configured; syntax-check emitted modules
```

A pure UI change needs no `DATABASE_URL` / `MERCURY_TOKEN`. Anything that
touches live data needs the Railway env vars from the README.

## Deploy

`main` is production. Railway auto-deploys on push to `main` but is not always
reliable; the fallback is `railway up` or the GraphQL `serviceInstanceDeploy`
mutation (ids in `SHIP-UI-REDESIGN.md` §8). Verify with:

```
curl -sS https://crm.flynesher.com/__nesher_pay/health   # expect new build tag
```

## Claude Code on the web — environment notes

- Network egress to `crm.flynesher.com`, `*.up.railway.app` and
  `backboard.railway.app` is **blocked by default** in the web environment.
  To verify live or trigger deploys from a session, allow those hosts in the
  environment's network settings and add `RAILWAY_PROJECT_TOKEN` (and
  optionally `DATABASE_URL`) as environment variables.
- Without that, the loop is: edit → `npm test` → push branch → merge to `main`
  → Railway deploys.
