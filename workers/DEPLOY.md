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
  - booking: `{"score":7,"fixes":["...","...","..."]}` (checked on fill: score a number 0 to 10, fixes a list of up to 10 non-empty
    texts. Fixes about answer time are never shown: any fix mentioning seconds, minutes or hours is dropped, since answer speed belongs
    to the speed section; "a second button" and "business hours" / "opening hours" are fine. Blank and repeated fixes are dropped too.)
  - category: `{"main_category":"...","big_job":"...","match":false,"note":""}`
  - Nov 20 additions (item 215, item 211, Nov 19 diagnosis). Section names: `speed|known_for|competitor|listings|spot`, and `ai` grew.
    A fill that breaks these shapes is refused with 400 and changes nothing. Every one of them is required: the report stays
    "fill pending sections first" (checkers get 409 on a pass) until each is in.
  - ai (now 3 answers): add `"google_ai":{"named":false,"correct":true,"note":""}`. Optional on each engine: `"top":["names it gave", ...]` (up to 5).
    Optional `"screenshots":[{"engine":"chatgpt|gemini|google_ai","url":"https://getbookedoutsolutions.com/....png"}]` (up to 3,
    our own domain only; hosting for these is not built yet, so leave it out until it is). Without google_ai the AI part stays pending.
  - speed: `{"tested":true,"channel":"call|text|email","when":"Mon Nov 16, 2:10 pm","minutes":42,"after_hours":{"tested":true,"answered":false,"when":"Mon Nov 16, 7:40 pm","channel":"call"}}`
    `tested` must be a real true or false. A tested result for a real (non-TEST) request is refused by the worker (403) unless the
    plain variable `SPEED_TEST_LIVE` = `on` (default off; turn on only after GO LIVE, once the speed test is OK'd).
    `minutes:null` means no answer and then `waited_hours` is needed. Never `form` (the report says we never send his form).
    `leads_per_month` only with `"leads_source":"owner"` (he told us). Can't test: `{"tested":false,"reason":"..."}`.
    The page shows "What research says about answer speed (outside research, not your numbers)" (HBR 2011 or the 2007 lead response
    study, picked by his answer time; these studies measure reaching and qualifying web leads, not jobs booked) and, for heating
    and air only, "After-hours calls (estimate)" (ServiceTitan June 3 2026: 9.8 to 14.1 of every 100 calls arrive after hours).
    Each has its source line. "May be going unanswered" shows only when the after-hours call was not answered.
  - known_for: `{"scanned":25,"reviews":[{"text":"review text","rating":5}, ...]}` (the Google reviews we scanned, up to 300, with
    their stars; `scanned` = how many we looked at). Only 4 and 5 star reviews are counted. The worker counts the repeated words itself
    (once per review, 3 or more reviews, his own business name left out, complaint words and words after "not", "never" and the like
    left out). Under 5 usable reviews it says so, and points to the review fix only when that fix is in his three fixes.
    No Google profile: not needed.
  - competitor: `{"name":"<exactly one of the google top3 names, above him>","theirs":{"photos":80,"reply_pct":90,"posts_90d":6,"website":true,"hours":true},"yours":{...same keys}}`
    Stars and review counts always come from the google section. Not needed when he is number 1, has no profile, or Google gave no top 3.
  - listings: `{"sites":{"google":{"found":true,"complete":true},"yelp":{"found":false},"bbb":{"found":true,"complete":false,"fix":"one simple fix"},"facebook":{...},"nextdoor":{...},"chamber":{...}}}`
    All six needed. Not found gets the standard free fix; found but not complete needs its own `fix`.
  - spot: `{"zone":"Smyrna","open":true}` (is his trade's zone lock still free?). The named guarantee ("The <business> Quote Guarantee")
    uses the terms page word for word (quotes contacted within 2 business days; "Not the printer, the mail, Google or your customers";
    "your next month is free"; no guarantees during a free period). "Something else" trades get no spot and no guarantee (the site
    offers zone locks only for heating and air, plumbing and electrical), and spot is not needed for them.
  - google (now checked on fill): `has_google_profile` must be true or false. With a profile, `rank_for_keyword` is 1 to 20 or null,
    and null needs `rank_checked: true` (we ran the search and he was not in the first 20). Without that flag the report never says
    "Not found" or "Not in the first 20 results"; it stays pending. The worker's own lookup sets `rank_checked` itself, and a lookup
    answer with no yes/no on the profile is treated as a failed lookup.
  - Re-render rule: check (before any mark) and the cron (before any send) render the report again with the current code. An old
    record whose page changes gets a new hash, its marks are cleared and it needs both checks again. The three fixes are saved on the
    record when it is sent (`fu.fixes`) and the follow-ups quote those.
  - The one-line diagnosis at the top is not filled: the worker works it out from google, ai and speed ("Not found", "Found but not
    chosen", "Chosen but never followed up" (no answer, or an unanswered after-hours test), "Found and chosen, but slow
    to answer" (6 to 60 minutes), "Chosen but slow to follow up" (over 60 minutes), or "Found and chosen"). "Never followed up" is only
    for no answer (the main test or the after-hours test). It stays pending ("0 Diagnosis") until the data it needs is in.

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

## Free report follow-ups (Nov 20 2026, PR "free report follow-up sequence")

- Wording is LOCKED in `workers/freereport-followups-seq.js` (Salesperson brain wrote it; Hormozi, Platten and owner clones 8+;
  a fresh second agent PASS 8.5/8.5). Full text and grades: Drive "FREE REPORT FOLLOW-UP SEQUENCE - locked v4 (Nov 20)".
- Logic: `workers/freereport-followups.js`. The worker starts a sequence when a report is SENT (key `fu:<id>`), and the cron
  runs `fuTick` after the normal tick.
- Cold (website form, or `rec.source = "cold_email"`): business days 1, 3, 7, 12, 18 after the report, then the not-now ladder
  (2, 6, 12 weeks after the last main step) and up to 2 quarterly re-run offers. Warm (`rec.warm = true`, optional
  `rec.introducer`): business days 2, 7, 12, then the same ladder.
- Each email: same Gmail thread (threadId + In-Reply-To), subject "Re: <report subject>", one per owner per day, not before the
  hour the report went out, business days only, Thanksgiving and Christmas slide. Every fact comes from his own report; a step
  that can't be filled truthfully goes to its fallback or is skipped. No price, no links but his report link.
- Switches: `FOLLOWUPS` = `off` (default). Nothing goes unless `FOLLOWUPS` = `on` AND `LIVE` = `on`.
- Stop rules: any message in the thread that is not ours (a reply or a bounce) stops it forever; `stop:<email>` stops it.
- Knowing there is no reply: the token today has `gmail.send` only, so the thread read fails and every step HOLDS (watch entry)
  unless the inbox job posts `{action:"clear"}` for that owner within the last 30 minutes. The report email now carries our
  own Message-ID, so follow-ups set In-Reply-To even without the thread read (check on the first live send that Gmail kept it). To make it fully automatic, the same
  OAuth client needs `gmail.readonly` added and consent given once by rickey@getbookedoutsolutions.com (a Rickey sign-in step).
- Endpoint: `POST /api/free-report/followup {id, k, action}` with action `stop` (any reply, "no", bounce, anger, paid/started),
  `later` (he said later / check back: main steps end, ladder starts today), `clear` (inbox checked, no reply), `status` (plan).
- Deploy: the dashboard editor takes one file, so run `node workers/build-freereport-bundle.mjs` and paste
  `workers/dist/bookedout-freereport.bundle.js`. Tests: `node workers/test-freereport.mjs`, `node workers/test-freereport-followups.mjs`,
  and the same two with `BUNDLE=1` against the bundle.

## Free report fill jobs (Nov 20 2026, PR 30): who fills each section

Every fill goes through `workers/freereport-fill.mjs` (`STATUS_KEY=... node workers/freereport-fill.mjs <fr-id> <data.json> [--dry-run]`).
It checks the data with the worker's own rules first, posts google first, and stops at the first refusal. It only talks to our
worker. Tests: `node workers/test-freereport-fill.mjs`.

| Section | Who fills it | Where the data comes from | Built? |
|---|---|---|---|
| google, reviews | the worker itself at build time (`lookup()`) | the lookup worker at `LOOKUP_URL` | The lookup worker's code is NOT in this repo or in the Mac mini engine folder (`~/.bookedout/engine`, searched Nov 20), and `LOOKUP_URL`/`LOOKUP_KEY` are not set. Until they are, the fill job sends google and reviews (with `rank_checked`) through the door. |
| ai (ChatGPT, Gemini AND google_ai) | the "Free report checkers" scheduled task (FREEREPORT-CHECKERS.md, Timing), before checker 1 | asking each engine the customer's question | Not built (the task is created when GO LIVE is near). Its prompt must send `google_ai {named}`; the worker now refuses an ai fill without it. |
| booking, category | the same task | his website on a phone (never sending the form), his public Google listing | Not built (same task). |
| known_for | the same task | his public Google reviews: text AND stars (`{scanned, reviews:[{text, rating}]}`) | Not built. If the lookup worker learns to return reviews with stars, move this to `lookup()`. |
| competitor | the same task | the public Google listing of the top 3 shop above him (photos, replies, posts, website, hours) | Not built. |
| listings | the same task | public searches of Google, Yelp, BBB, Facebook, Nextdoor and the local chamber directory | Not built. |
| spot | the same task | the list of zone locks we have sold (one shop per trade per zone) | Not built, and there is no zone lock list in this repo yet: one is needed before deploy (until a lock is sold, every zone is open). Not used for "Something else". |
| speed | a separate answer speed job, AFTER GO LIVE only | one test call, text or email to the shop | NOT built on purpose: it contacts a real business. Two locks: the fill door refuses any real-shop speed data that is not `tested:false` unless `--after-go-live` is given, and the worker itself refuses a real-shop tested result unless `SPEED_TEST_LIVE` = `on`. Before GO LIVE the job can only send `{"tested":false,"reason":"..."}`, which shows on the page, so no real report should be checked before this is settled. |

After the deploy that brings these sections (one time): `POST /api/free-report/rerender {"k":"..."}` renders every open report
with the new code. Every report built before it goes back to "fill pending sections first" and loses any old check marks. The test
request fr-20261120-vbukvz (two passes on the old page) will show `changed: true` and lose both marks. check() and the cron
also re-render on their own before a pass or a send, so an old page can never be passed or sent even if this step is missed.
