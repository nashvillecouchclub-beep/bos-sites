# bos-sites

Booked Out Solutions client websites and site jobs. Public website files only, no secrets.

- `sites/<domain>/` is the live website for that client; `files.json` lists every file's fingerprint (run `python3 tools/make_manifest.py` before committing).
- `sites.json` holds each site's Netlify site id, the client's email and its IndexNow key (all public, not secrets).
- `jobs.json` is the job list. The Booked Out SITE OPS Cloudflare worker checks it every 10 minutes and runs any job id it hasn't run: `deploy` (push the site to Netlify, only changed files) and `search` (IndexNow for Bing and others, and the Google robot: verify, add the client as owner, Search Console, sitemap).
- To run a job again, add a new entry with a new id.
- `clients/start.json` + `tools/make_start_pages.py`: each client's one-link setup page at getbookedoutsolutions.com/start/<code>/ (only the taps they have left, public-safe, noindex). The Connect step turns to done on its own once they tap Allow (worker route /connect/done). Private client details live in the Google Sheet "BOOKED OUT - client roster (master)", never here.
