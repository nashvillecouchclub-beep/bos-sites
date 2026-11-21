// The free report fill jobs (Nov 21 2026). One job per report section. Each job turns what was gathered for one request
// (a research file a live chat writes after looking at PUBLIC pages only) into the exact section shape the worker takes.
// Nothing here contacts a business, and nothing here posts: every fill still goes through workers/freereport-fill.mjs
// (prepareFills -> fillProblem -> postFills), the one door into the worker.
//
//   speed      always the "We did not run this test for you" result (Rickey has not picked a test method; no real contact)
//   spot       from the sold zone-lock list (workers/data/zone-locks.json), never from research
//   google, reviews, ai, booking, category, known_for, competitor, listings   from the research file
//   ai screenshots  only ones hosted for this report through POST /api/free-report/shot (free, same KV); else left out
//
// Research file (one per request, <research dir>/<fr-id>.json), every key optional, shapes as in workers/DEPLOY.md:
//   {"google":{...}, "reviews":{...}, "ai":{"question":"...","chatgpt":{...},"gemini":{...},"google_ai":{...}},
//    "booking":{...}, "category":{...}, "known_for":{"scanned":25,"reviews":[{"text":"...","rating":5}]},
//    "competitor":{"name":"(optional, one of the google top 3)","theirs":{...},"yours":{...}},
//    "listings":{"sites":{"google":{...},"yelp":{...},"bbb":{...},"facebook":{...},"nextdoor":{...},"chamber":{...}}},
//    "screenshots":{"chatgpt":"/full/path/to.png", ...}}
import W from './bookedout-freereport.js';
import { ORDER } from './freereport-fill.mjs';
import { spotFor } from './zone-locks.mjs';

const T = W._t;
// The one answer speed result until Rickey picks a method. The page shows: "We did not run this test for you: <reason>"
export const SPEED_REASON = 'we do not call, text or email your business for this report.';
export const SPEED_UNTESTED = Object.freeze({ tested: false, reason: SPEED_REASON });
const ENGINE_KEYS = ['named', 'correct', 'top', 'note'];
const CMP_KEYS = ['photos', 'reply_pct', 'posts_90d', 'website', 'hours'];
const LISTING_SITES = ['google', 'yelp', 'bbb', 'facebook', 'nextdoor', 'chamber'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);

// Pending labels on the page -> the section that fills them ("0 Diagnosis" follows from google, ai and speed).
const LABEL = [[/^1 Google/, 'google'], [/^2 /, 'reviews'], [/^3 /, 'ai'], [/^4 /, 'booking'], [/^5 /, 'category'], [/^6 /, 'speed'],
  [/^7 /, 'known_for'], [/^8 /, 'competitor'], [/^9 /, 'listings'], [/^Spot/, 'spot']];
export function pendingSections(rec) {
  const r = T.renderReport(rec), out = new Set();
  for (const p of r.pending) for (const [re, s] of LABEL) if (re.test(p)) out.add(s);
  return { sections: ORDER.filter((s) => out.has(s)), pending: r.pending, complete: r.complete };
}

export function defaultQuestion(item) {
  const what = { 'Heating and air': 'heating and air company', Plumbing: 'plumber', Electrical: 'electrician' }[item.trade] || 'company for my job';
  const ts = T.townState(item.town || '');
  return `Who is the best ${what} in ${ts.town}${ts.state ? ', ' + ts.state : ''}?`;
}

// Each job: (item, research, ctx) -> section data, or null when there is nothing honest to fill yet.
export const JOBS = {
  google(item, r) {
    if (!obj(r.google)) return null;
    const g = { ...r.google };
    if (g.has_google_profile && !g.keyword) {
      const kw = (T.TRADES[item.trade] || {}).kw;
      if (kw) g.keyword = `${kw} ${T.townState(item.town).town}`;
    }
    if (Array.isArray(g.top3)) g.top3 = g.top3.slice(0, 3).map((x) => pick(x, ['name', 'rating', 'review_count']));
    return g;
  },
  reviews(item, r) {
    const v = r.reviews;
    if (!obj(v) || !obj(v.newest_review) || typeof v.owner_reply_on_newest !== 'boolean') return null;
    return { newest_review: pick(v.newest_review, ['rating', 'text', 'date']), owner_reply_on_newest: v.owner_reply_on_newest };
  },
  ai(item, r, ctx) {
    const a = r.ai;
    if (!obj(a) || !['chatgpt', 'gemini', 'google_ai'].every((e) => obj(a[e]))) return null;
    const out = { question: typeof a.question === 'string' && a.question.trim() ? a.question.trim() : defaultQuestion(item) };
    for (const e of ['chatgpt', 'gemini', 'google_ai']) out[e] = pick(a[e], ENGINE_KEYS);
    const shots = (ctx.shots || []).filter((x) => T.SHOT_ENGINES.includes(x.engine)).slice(0, 3);
    if (shots.length) out.screenshots = shots.map((x) => ({ engine: x.engine, url: x.url }));
    return out;
  },
  booking(item, r) { return obj(r.booking) ? pick(r.booking, ['score', 'fixes']) : null; },
  category(item, r) { return obj(r.category) ? pick(r.category, ['main_category', 'big_job', 'match', 'note']) : null; },
  speed() { return { ...SPEED_UNTESTED }; },
  known_for(item, r) {
    const k = r.known_for;
    if (!obj(k) || !Array.isArray(k.reviews)) return null;
    const reviews = k.reviews.filter((x) => obj(x) && typeof x.text === 'string').slice(0, 300)
      .map((x) => ({ text: x.text.trim(), rating: typeof x.rating === 'string' ? +x.rating : x.rating }));
    const scanned = Math.max(Number.isInteger(k.scanned) ? k.scanned : 0, reviews.length);
    return { scanned, reviews };
  },
  competitor(item, r, ctx) {
    const c = r.competitor, g = ctx.rec.sections.google;
    if (!obj(c) || !g || !Array.isArray(g.top3) || !g.top3.length) return null;
    // default pick: the highest top 3 shop that shows above him
    const rank = g.rank_for_keyword ? +g.rank_for_keyword : null;
    const name = c.name || (g.top3.find((x, i) => !rank || i + 1 < rank) || {}).name;
    if (!name) return null;
    return { name, theirs: pick(c.theirs, CMP_KEYS), yours: pick(c.yours, CMP_KEYS) };
  },
  listings(item, r, ctx) {
    const src = obj(r.listings) ? (obj(r.listings.sites) ? r.listings.sites : r.listings) : null;
    if (!src) return null;
    const sites = {};
    const g = ctx.rec.sections.google;
    for (const k of LISTING_SITES) {
      let x = src[k];
      // the google row can come from the google section (found = he has a profile); "complete" is never guessed
      if (!obj(x) && k === 'google' && g && typeof g.has_google_profile === 'boolean') x = { found: g.has_google_profile };
      if (!obj(x)) return null; // all six are needed; a missing one is research still to do
      sites[k] = pick(x, ['found', 'complete', 'fix']);
    }
    return { sites };
  },
  spot(item, r, ctx) {
    const sp = spotFor(item, ctx.locks || []);
    if (sp && sp.hold) { ctx.notes.push('spot held: ' + sp.hold); return null; }
    return sp;
  },
};

// Works out the fills one request still needs, in the door's order, applying each to a copy so later jobs see earlier
// fills (competitor sees google). Returns {data, missing, notes, pendingAfter}. data goes to prepareFills unchanged.
export function planFills(item, research = {}, { locks = [], shots = [] } = {}) {
  const rec = { ...item, sections: { ...(item.sections || {}) } };
  const data = {}, notes = [];
  if (!research || typeof research !== 'object' || Array.isArray(research)) research = {};
  if (research && 'speed' in research) notes.push('research speed ignored: the answer speed result is always "not tested" until a method is picked');
  if (research && 'spot' in research) notes.push('research spot ignored: the spot comes from workers/data/zone-locks.json');
  for (const section of ORDER) {
    if (!pendingSections(rec).sections.includes(section)) continue;
    const d = JOBS[section](item, research || {}, { rec, locks, shots, notes });
    if (!d) continue;
    // the worker's own type and range rules, before anything is planned (the fill door checks again before posting)
    const why = T.fillProblem(rec, section, d);
    if (why) { notes.push(`research ${section} refused: ${why}`); continue; }
    data[section] = d;
    rec.sections[section] = d;
  }
  const after = pendingSections(rec);
  return { data, missing: after.sections, notes, pendingAfter: after.pending, rec };
}

// A research file to fill in by hand from a live chat (public pages only), with only the sections still needed.
export function researchTemplate(item, missing) {
  const g = (item.sections || {}).google;
  const t = { id: item.id, business_name: item.business_name, town: item.town, trade: item.trade,
    _rules: 'Public pages only. Never send his form, never call, text or email the shop. Copy numbers exactly; leave a section out if you could not check it.' };
  const H = {
    google: { has_google_profile: null, keyword: '', rating: null, review_count: null, rank_for_keyword: null, rank_checked: null, top3: [{ name: '', rating: null, review_count: null }] },
    reviews: { newest_review: { rating: null, text: '', date: '' }, owner_reply_on_newest: null },
    ai: { question: defaultQuestion(item), chatgpt: { named: null, correct: null, top: [] }, gemini: { named: null, correct: null, top: [] }, google_ai: { named: null, correct: null, top: [] } },
    booking: { score: null, fixes: [] },
    category: { main_category: '', big_job: '', match: null },
    known_for: { scanned: null, reviews: [{ text: '', rating: null }] },
    competitor: { name: g && g.top3 && g.top3[0] ? g.top3[0].name : '', theirs: { photos: null, reply_pct: null, posts_90d: null, website: null, hours: null }, yours: { photos: null, reply_pct: null, posts_90d: null, website: null, hours: null } },
    listings: { sites: Object.fromEntries(LISTING_SITES.map((k) => [k, { found: null, complete: null, fix: '' }])) },
  };
  for (const s of missing) if (H[s]) t[s] = H[s];
  if (missing.includes('ai')) t.screenshots = { chatgpt: '', gemini: '', google_ai: '' };
  return t;
}
