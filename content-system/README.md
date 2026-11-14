# content-system (Booked Out Solutions) - built Nov 14 2026

Everything that turns one tip into every post, checks it, draws it, and gets it approved. Free tools only
(Python, Playwright/Chromium, ffmpeg, Netlify redirects, one free Cloudflare worker). Works for any brand that has
a file in `brands/` (Booked Out, Stones River, every future client).

## The daily posting task: how to use it
1. Write or pick the source tips (fields listed at the top of `machine.py`). Booked Out's bank is `content/booked-out/posts.json`.
2. `python3 content-system/machine.py booked-out content/booked-out/posts.json 11 12 13 --cards`
   - makes every platform version, the cards, the tracked links, and runs the QUALITY GATE on each piece
   - `out/booked-out/schedule.json` = pieces that PASSED and whose link page is live: only these get scheduled
   - `out/booked-out/waiting-for-page.json` = passed, but the link page (e.g. /newsletter) is not live yet
   - anything that failed is in `out/held.jsonl` with the reason. Never post a held piece. Fix the source and rerun.
3. Client pieces (Stones River and every client) go on the client's weekly approval page first (below). Only pieces
   marked approved in `approvals/<batch>.json` may be scheduled. Booked Out's own posts follow Rickey's standing OK.
4. Site changes (cards, /go/ links, approval pages) ship in ONE bundled deploy job in `jobs.json` (Netlify credits are tight).

## Parts
| Part | File | What it does |
|---|---|---|
| Quality gate | `gate.py` | Platform limits (X counts links as 23), exactly one link CTA + one comment prompt, links resolve (live, else repo files, else held), no prices / income claims / promised results / unsourced %, no testimonials, AI-slop phrases and em dashes, client rules (Stones River: no client stories, 988 line on crisis-adjacent posts, comment prompts that never ask for personal details), cards: brand fonts loaded, size per platform, phone-size text, WCAG contrast, overflow; videos: 20-40 s, 9:16, sound, captions burned, ends on the CTA, no AI person shown as real. Fail = auto-fix and recheck, else HELD and logged. |
| Content machine | `machine.py` | One tip -> Facebook, Instagram (link in bio), X + first reply with the link, Pinterest pin, Google post, LinkedIn, newsletter section, website article (when written), video script. CTA mix from the brand file (Booked Out: 3 in 4 newsletter, 1 in 4 free look). |
| Brand configs | `brands/*.json` | Colors, fonts, logo, platforms, CTAs, rules, comment-prompt style. Add a client = add one file. |
| Template studio: cards | `studio/cards.py` | feed 1080x1350, square, pin 1000x1500, Google 1200x900, LinkedIn 1200x627, og. Booked Out navy/gold; Stones River paper, river and stones, coneflower, Cormorant Garamond + Jost, no people. Writes `.meta.json` for the gate. |
| Template studio: video | `studio/video.py`, `studio/music.py` | 9:16 1080x1920 30 fps motion video: words timed for reading (they ARE the captions; no voice-over), brand motion (drifting glow, grid, light sweep, word-by-word hook, popping step numbers), original music made in code, ends on the CTA. About 3-4 minutes to render one. |
| Tracked links | `links/golinks.py`, `links/links.json` | `/go/<code>` short links with UTM tags, written into each site's Netlify `_redirects` (free). Pinterest gets a direct UTM link (redirects look like spam to Pinterest). `GO_MODE=counted` switches them through the worker to count clicks. |
| Approval page | `approve/build.py`, `approve/sync.py` | Private noindex page per client per week at `getbookedoutsolutions.com/approve/<token>/`: picture cards and videos, Approve / Request a change with a note, progress bar, saved on the device, sent to the approvals API, email fallback. 10-15 pieces, about a week ahead (Rickey's Nov 14 rule). |
| Worker | `worker/approvals-worker.js` | Saves approval answers (KV) and counts /go/ clicks. Deploy once from the mini: `npx wrangler kv namespace create APPROVALS`, put the id in wrangler.toml, `npx wrangler secret put READ_KEY`, `npx wrangler deploy`; register each page: `npx wrangler kv key put --binding APPROVALS tokens:<token> 1`. Free plan. Until it is deployed the page still works (device save + email). |
| Scorecard | `scorecard.py` | Weekly one-page scorecard + `next_topics.json` (what won) from metrics the Monday task gathers. Never estimates. |

## Tests
`python3 content-system/tests/run_tests.py` (gate catches bad posts, machine output passes, cards pass the gate).
