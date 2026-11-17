# Deploy notes

## bookedout-freereport (free report form, report pages, 1-business-day clock)

- Worker name: `bookedout-freereport` (on the account's workers.dev subdomain, the same one the other proxied workers use)
- Script: `workers/bookedout-freereport.js` (one ES module, no build step). Compatibility date 2026-11-01 or later.
- KV binding: `KV` = namespace `bookedout-freereport-kv` (id af5c56f58df745f986b252814cd44056)
- DEPLOYED Nov 16 2026 about 5:36 pm Central from the dashboard (code from this branch, LIVE=off, cron every 15 minutes).
  Secrets STATUS_KEY, LOOKUP_URL and LOOKUP_KEY are NOT set yet (status, fill and mark-sent answer 403 until STATUS_KEY is added).
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
- 2-agent check and automatic send (Nov 16 night; Rickey's Nov 16 4:46 pm rule: no check by Rickey):
  built report -> checker 1 pass -> checker 2 pass (a different agent, same report version) -> sent to the owner by the
  picked route, only when `LIVE` = `on`. A fail sets status `held` and writes a `problem` watch entry; a fill after a check
  clears both marks. A failed send writes a `problem` watch entry and is tried again every 15 minutes. Fake TEST shops
  are never sent. Nothing emails Rickey.
- Send route settings (add only when the route is being set up; all secrets in the dashboard):
  - `SEND_ROUTE` = `gmail` (picked), `cloudflare` or `resend` (backups). `SEND_FROM` optional
    (default `Rickey Hallor <rickey@getbookedoutsolutions.com>`).
  - gmail: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (an OAuth client in our own Google Cloud
    project, scope `https://www.googleapis.com/auth/gmail.send` only, consent given once by rickey@getbookedoutsolutions.com).
  - cloudflare: a `send_email` binding named `EMAIL` (Cloudflare Email Sending, Workers Paid). Check the binding's call
    shape on Cloudflare's docs before switching to it.
  - resend: `RESEND_KEY` (domain verified in Resend first; read Resend's acceptable-use policy first).
- Check after deploy: `GET /api/free-report/ping` returns `{"ok":true,"live":false}`.
- Tests: `node workers/test-freereport.mjs` (no network, fake shop only).

Endpoints for later jobs (all need `k` = STATUS_KEY):
- `GET /api/free-report/status?k=...` open requests, soonest due first, with check marks, `needs`, `watch`, `problems`
- `GET /api/free-report/review?k=...` reports waiting for the 2-agent check (status built, held or checked), each with
  `hash`, `sections` (the lookup data), `needs` ("checker 1", "checker 2", "send" or "fill pending sections first")
- `POST /api/free-report/check` `{"id":"fr-...","k":"...","checker":1,"agent":"checker-1-<run id>","result":"pass|fail","hash":"<hash read>","notes":"..."}`
  - 409 when: the hash is old, the report still has pending sections (pass), checker 2 passes before checker 1,
    or both slots would carry the same agent name.
- `POST /api/free-report/mark-sent` `{"id":"fr-...","k":"..."}` (only for a report sent some other way; recorded as manual)
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

### Live switch (Nov 16 2026, about 5:55 pm Central)
- getbookedoutsolutions.com and www now point at the Pages project (proxied CNAMEs to getbookedoutsolutions.pages.dev).
  www goes to the bare address by the zone Redirect Rule "Redirect from WWW to root" (301, path and query kept).
- Zone Worker routes (so the proxied paths work even before this PR is merged, and stay as a second path after):
  `getbookedoutsolutions.com/api/free-report*` and `/r/*` -> bookedout-freereport;
  `/c/*` and `/api/client-answer*` -> bookedout-answers; `/connect` and `/connect/*` -> bookedout-connect.
- Email records were not touched (MX smtp.google.com, SPF, google._domainkey DKIM, _dmarc, MailerLite DKIM CNAME,
  verification TXTs, wildcard CNAME to uixie.porkbun.com).
- Fallback until Nov 23: put the bare-address records back to A 75.2.60.5 and A 99.83.231.61 (DNS only) and www back to
  CNAME getbookedoutsolutions.netlify.app (DNS only). The Netlify project bookedout-solutions is untouched.
