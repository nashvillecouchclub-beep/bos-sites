# Deploy notes

## bookedout-freereport (free report form, report pages, 1-business-day clock)

- Worker name: `bookedout-freereport` (on the account's workers.dev subdomain, the same one the other proxied workers use)
- Script: `workers/bookedout-freereport.js` (one ES module, no build step). Compatibility date 2026-11-01 or later.
- KV binding: `KV` (a new namespace just for this worker, for example `bookedout-freereport`)
- Cron trigger: `*/15 * * * *` (every 15 minutes)
- Secrets (added in the dashboard, never in this repo):
  - `STATUS_KEY` (long random string; needed for status, mark-sent and fill)
  - `LOOKUP_URL` and `LOOKUP_KEY` (optional; the lookup worker. Without them the Google parts of each report say "pending check")
- Plain variables (optional):
  - `LIVE` = `off` (default). Leave it off until GO LIVE. While off, nothing is ever sent to a business owner.
  - `ALERT_FORM_URL` = `https://getbookedoutsolutions.com/` (default). Must be the address that answers without a redirect.
- Routes: none on the worker itself. The site's `_redirects` proxies these paths to it:
  - `/api/free-report`, `/api/free-report/*`, `/r/*`
- Site setup (host Forms settings): form detection ON; email notifications for forms `free-report` and `bo-alert` to the site owner's inbox.
- Check after deploy: `GET /api/free-report/ping` returns `{"ok":true,"live":false}`.
- Tests: `node workers/test-freereport.mjs` (no network, fake shop only).

Endpoints for later jobs (all need `k` = STATUS_KEY):
- `GET /api/free-report/status?k=...` open requests, soonest due first
- `POST /api/free-report/mark-sent` `{"id":"fr-...","k":"..."}`
- `POST /api/free-report/fill` `{"id":"fr-...","k":"...","section":"ai|booking|category|google|reviews","data":{...}}`
  - ai: `{"question":"...","chatgpt":{"named":true,"correct":true,"note":""},"gemini":{...}}`
  - booking: `{"score":7,"fixes":["...","...","..."]}`
  - category: `{"main_category":"...","big_job":"...","match":false,"note":""}`
