// The fill job's one door into the free report worker (Nov 20 2026). Every job that fills a report section
// (the AI check, the booking test, the category check, the review texts, the competitor rows, the listing check,
// the zone status, and later the answer speed result) posts through here, so the data is checked BEFORE it is sent,
// in the right order (google first), with the same rules the worker uses.
//
//   node workers/freereport-fill.mjs <fr-id> <data.json> [--dry-run] [--after-go-live]
//     data.json = {"google": {...}, "ai": {...}, "known_for": {...}, ...}  (shapes in workers/DEPLOY.md)
//     STATUS_KEY comes from the environment (never printed). FREEREPORT_BASE overrides https://getbookedoutsolutions.com.
//
// It only talks to our own worker. It never contacts a business. The answer speed TEST (a real call or text to a shop) is
// not built here and must not run before GO LIVE; this file refuses a real shop's tested speed result unless
// --after-go-live is given (fake TEST shops are always fine, for tests).
import W from './bookedout-freereport.js';

const T = W._t;
export const ORDER = ['google', 'reviews', 'ai', 'booking', 'category', 'speed', 'known_for', 'competitor', 'listings', 'spot'];

// item: one entry from GET /api/free-report/review (id, test, trade, sections). Returns {fills, problems}.
export function prepareFills(item, data, opts = {}) {
  const problems = [], fills = [];
  const rec = { ...item, sections: { ...(item.sections || {}) } };
  for (const k of Object.keys(data || {})) if (!ORDER.includes(k)) problems.push(`${k}: not a report section`);
  for (const section of ORDER) {
    if (!data || !(section in data)) continue;
    const d = data[section];
    if (!d || typeof d !== 'object') { problems.push(`${section}: data must be an object`); continue; }
    if (section === 'spot' && item.trade === 'Something else') { problems.push('spot: not used for "Something else" (no zone locks for that trade)'); continue; }
    if (section === 'speed' && d.tested === true && !item.test && !opts.afterGoLive)
      { problems.push('speed: a tested result for a real shop means we contacted it; not before GO LIVE (use --after-go-live once live)'); continue; }
    const why = T.fillProblem(rec, section, d);
    if (why) { problems.push(`${section}: ${why}`); continue; }
    rec.sections[section] = d; // later sections (competitor) are checked against the google data in this same batch
    fills.push({ section, data: d });
  }
  return { fills, problems };
}

// Posts the fills one by one, in order; stops at the first refusal. Returns {ok, results, error?}. Never throws on HTTP.
export async function postFills({ base, key, id, fills, fetch: f = fetch }) {
  const results = [];
  for (const x of fills) {
    const r = await f(`${base}/api/free-report/fill`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, k: key, section: x.section, data: x.data }) });
    const j = await r.json().catch(() => ({}));
    results.push({ section: x.section, status: r.status, complete: j.complete, pending: j.pending, error: j.error });
    if (!r.ok) return { ok: false, results, error: `${x.section}: ${j.error || r.status}` };
  }
  return { ok: true, results };
}

export async function findItem({ base, key, id, fetch: f = fetch }) {
  const r = await f(`${base}/api/free-report/review?k=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error('review list ' + r.status);
  const j = await r.json();
  return (j.waiting || []).find((x) => x.id === id) || null;
}

// command line
if (import.meta.url === `file://${process.argv[1]}`) {
  const [id, file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const dry = process.argv.includes('--dry-run'), afterGoLive = process.argv.includes('--after-go-live');
  const key = process.env.STATUS_KEY, base = process.env.FREEREPORT_BASE || 'https://getbookedoutsolutions.com';
  if (!id || !file || !key) { console.error('usage: STATUS_KEY=... node workers/freereport-fill.mjs <fr-id> <data.json> [--dry-run] [--after-go-live]'); process.exit(2); }
  const { readFileSync } = await import('node:fs');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const item = await findItem({ base, key, id });
  if (!item) { console.error(`${id}: not in the review list (not built, or already sent)`); process.exit(1); }
  const { fills, problems } = prepareFills(item, data, { afterGoLive });
  for (const p of problems) console.error('refused ' + p);
  if (problems.length) process.exit(1);
  if (dry) { console.log('dry run ok: ' + fills.map((x) => x.section).join(', ')); process.exit(0); }
  const r = await postFills({ base, key, id, fills });
  for (const x of r.results) console.log(`${x.section} ${x.status}${x.error ? ' ' + x.error : ''}${x.pending ? ' pending: ' + x.pending.join(', ') : ''}`);
  process.exit(r.ok ? 0 : 1);
}
