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
- Routes: none on the worker itself. On Cloudflare Pages the site's `_worker.js` passes these paths to it
  (on the Netlify fallback, `_redirects` does the same):
  - `/api/free-report`, `/api/free-report/*`, `/r/*`
- No host forms and no alert emails (Nov 16 Pages move). Every lead is kept in KV as `lead:<id>` (no expiry);
  clock trouble goes to `watch:` entries (warn = 75% of the clock, problem = overdue) that the watchdog reads from
  `GET /api/free-report/status?k=...` (`watch` and `problems`).
- Check after deploy: `GET /api/free-report/ping` returns `{"ok":true,"live":false}`.
- Tests: `node workers/test-freereport.mjs` (no network, fake shop only).

Endpoints for later jobs (all need `k` = STATUS_KEY):
- `GET /api/free-report/status?k=...` open requests, soonest due first
- `POST /api/free-report/mark-sent` `{"id":"fr-...","k":"..."}`
- `POST /api/free-report/fill` `{"id":"fr-...","k":"...","section":"ai|booking|category|google|reviews","data":{...}}`
  - ai: `{"question":"...","chatgpt":{"named":true,"correct":true,"note":""},"gemini":{...}}`
  - booking: `{"score":7,"fixes":["...","...","..."]}`
  - category: `{"main_category":"...","big_job":"...","match":false,"note":""}`

## getbookedoutsolutions.com on Cloudflare Pages (Nov 16)

- Pages project `getbookedoutsolutions`, connected to this repo (production branch `main`), no build command,
  build output `sites/getbookedoutsolutions.com`. A merge to `main` deploys by itself.
- `sites/getbookedoutsolutions.com/_worker.js` is the front door: it passes `/connect*`, `/c/*`, `/api/client-answer*`,
  `/api/free-report*` and `/r/*` to our workers (Pages `_redirects` can't proxy to another address) and adds the noindex
  headers. Everything else is the static site. Tests: `node workers/test-pages-frontdoor.mjs`.
- `_routes.json` limits the front door to those paths (static pages never run it, so they use no worker requests).
- `tools/make_manifest.py` leaves `_worker.js` and `_routes.json` out of files.json so the Netlify fallback never serves it.
