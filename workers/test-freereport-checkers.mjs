// Tests for the fill jobs (freereport-jobs.mjs), the zone-lock list (zone-locks.mjs), screenshot hosting and the
// "Free report checkers" runner (freereport-checkers.mjs). Run: node workers/test-freereport-checkers.mjs
// No network: the "worker" is the real worker code called in-process with a mock KV. Fake TEST shops only (plus one
// made-up real-looking shop that only ever lives in the mock KV, to prove nothing is sent).
import W from './bookedout-freereport.js';
import { prepareFills, findItem } from './freereport-fill.mjs';
import { planFills, researchTemplate, pendingSections, SPEED_UNTESTED, JOBS } from './freereport-jobs.mjs';
import { loadZoneLocks, checkLocks, spotFor, townKey, realDate, FILE } from './zone-locks.mjs';
import { run, checker1, checker2, args } from './freereport-checkers.mjs';
import { baseFromEnv } from './freereport-fill.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const T = W._t;
let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); } }
function kv() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
}
const KEY = 'k'.repeat(32), BASE = 'https://getbookedoutsolutions.com';
const at = (s) => new Date(s);
const FAKE = { first_name: 'Testy', business_name: 'Checker Run Heating (FAKE)', email: 'checker-run@example.com', phone: '615 555 0123', town: 'Smyrna TN',
  trade: 'Heating and air', revenue: '$500K to $1M', note: 'Old quotes going quiet lately.', consent: false, elapsed_ms: 5000, page: '/hvac-free-look.html' };
const RESEARCH = {
  google: { has_google_profile: true, rating: 4.3, review_count: 27, rank_for_keyword: 9, rank_checked: true,
    top3: [{ name: 'Fake Air One (TEST)', rating: 4.8, review_count: 240 }, { name: 'Fake Air Two (TEST)', rating: 4.7, review_count: 160 }, { name: 'Fake Air Three (TEST)', rating: 4.9, review_count: 101 }] },
  reviews: { newest_review: { rating: 5, text: 'test review', date: 'Nov 12 2026' }, owner_reply_on_newest: false },
  ai: { chatgpt: { named: false, top: ['Fake Air One (TEST)'] }, gemini: { named: true }, google_ai: { named: false, top: ['Fake Air Two (TEST)'] } },
  booking: { score: 6, fixes: ['Put your phone number at the top of the home page.'] },
  category: { main_category: 'HVAC contractor', big_job: 'new system installs', match: true },
  known_for: { scanned: 9, reviews: ['On time, fair price', 'Fair price and on time', 'On time and clean', 'Clean, fair price', 'Clean and on time', 'Fair price'].map((text) => ({ text, rating: '5' })) },
  competitor: { theirs: { photos: 80, reply_pct: 90, rating: 5 }, yours: { photos: 12, reply_pct: 10 } },
  listings: { sites: { yelp: { found: false }, bbb: { found: true, complete: false, fix: 'Fix the old phone number on your BBB page.' }, facebook: { found: true }, nextdoor: { found: false }, chamber: { found: false } } },
};
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
const local = (env, spy) => async (url, init) => { if (spy) spy.push({ url, method: (init && init.method) || 'GET', body: init && init.body }); return W.fetch(new Request(url, init), env, {}); };
async function built(shop = FAKE, env0 = {}) {
  const env = { KV: kv(), STATUS_KEY: KEY, ...env0 };
  const j = await (await T.submit(new Request(BASE + '/api/free-report', { method: 'POST', body: JSON.stringify(shop) }), env, at('2026-11-20T14:38:00-06:00'))).json();
  await T.tick(env, at('2026-11-20T14:45:00-06:00'), async () => new Response('{}'));
  return { env, id: j.id, rec: () => JSON.parse(env.KV.m.get('req:' + j.id)) };
}
const quiet = () => {};
// Nothing may leave the process: any real network call fails the test.
globalThis.fetch = async (u) => { throw new Error('network call attempted: ' + u); };

// ---------- zone locks ----------
await test('Zone locks: the shipped list is empty and valid, and an empty list reads "open"', () => {
  const locks = loadZoneLocks();
  assert.deepEqual(locks, []);
  const doc = JSON.parse(readFileSync(FILE, 'utf8'));
  assert.ok(doc.schema && doc.schema.trade && doc.schema.zone, 'schema is in the file');
  assert.deepEqual(spotFor({ trade: 'Heating and air', town: 'Smyrna TN' }, locks), { zone: 'Smyrna', open: true });
  assert.deepEqual(spotFor({ trade: 'Plumbing', town: 'La Vergne, TN' }, []), { zone: 'La Vergne', open: true });
  assert.equal(spotFor({ trade: 'Something else', town: 'Smyrna TN' }, []), null, 'no zone locks for Something else');
});
await test('Zone locks: a sold zone reads "taken" for that trade only; towns in the zone count; ended locks do not', () => {
  const locks = checkLocks({ locks: [{ trade: 'Heating and air', zone: 'Smyrna', towns: ['La Vergne'], business_name: 'Some Real Shop', since: '2026-11-01' },
    { trade: 'Plumbing', zone: 'Murfreesboro', business_name: 'Old Plumbing Client', since: '2025-01-01', until: '2025-12-31' }] });
  assert.deepEqual(spotFor({ trade: 'Heating and air', town: 'Smyrna TN' }, locks, '2026-11-21'), { zone: 'Smyrna', open: false });
  assert.deepEqual(spotFor({ trade: 'Heating and air', town: 'la vergne, tn' }, locks, '2026-11-21'), { zone: 'Smyrna', open: false });
  assert.deepEqual(spotFor({ trade: 'Electrical', town: 'Smyrna TN' }, locks, '2026-11-21'), { zone: 'Smyrna', open: true });
  assert.deepEqual(spotFor({ trade: 'Plumbing', town: 'Murfreesboro TN' }, locks, '2026-11-21'), { zone: 'Murfreesboro', open: true }, 'an ended lock is open again');
  assert.deepEqual(spotFor({ trade: 'Heating and air', town: 'Smyrna TN' }, locks, '2026-10-15'), { zone: 'Smyrna', open: true }, 'not started yet');
});
await test('Zone locks: a bad list is an error, never a quiet "open" (bad trades, unreal dates, fakes, overlaps incl. future ones)', () => {
  assert.throws(() => checkLocks({}), /locks/);
  assert.throws(() => checkLocks({ locks: [null] }), /must be an object/);
  assert.throws(() => checkLocks({ locks: [{ trade: 'Roofing', zone: 'Smyrna', business_name: 'X', since: '2026-11-01' }] }), /trade/);
  for (const bad of ['Nov 1', '2026-13-45', '2026-02-30', '2026-11-1'])
    assert.throws(() => checkLocks({ locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'X', since: bad }] }), /real date/, bad);
  assert.throws(() => checkLocks({ locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'X', since: '2026-05-01', until: '2026-04-01' }] }), /before since/);
  assert.throws(() => checkLocks({ locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'Fake (TEST)', since: '2026-11-01' }] }), /fake/i);
  assert.throws(() => checkLocks({ locks: [{ trade: 'Plumbing', zone: '37167', business_name: 'X', since: '2026-11-01' }] }), /plain town name/);
  const L = (...x) => ({ locks: x.map(([zone, business_name, since, until]) => ({ trade: 'Plumbing', zone, business_name, since, ...(until ? { until } : {}) })) });
  assert.throws(() => checkLocks(L(['Smyrna', 'A', '2026-01-01'], ['Smyrna', 'B', '2026-02-01'])), /overlaps/);
  // an ended lock in between does not hide a clash between the two open-ended ones (the attack: A, ended B, C)
  assert.throws(() => checkLocks(L(['Smyrna', 'A', '2026-01-01'], ['Smyrna', 'B', '2025-01-01', '2025-06-01'], ['Smyrna', 'C', '2026-02-01'])), /locks\[2\].*overlaps the lock held by A/);
  assert.throws(() => checkLocks(L(['Smyrna', 'A', '2027-01-01', '2027-12-31'], ['Smyrna, TN', 'B', '2027-06-01'])), /overlaps/, 'future locks, same town written two ways');
  assert.equal(checkLocks(L(['Smyrna', 'A', '2025-01-01', '2025-12-31'], ['Smyrna', 'B', '2026-01-01'])).length, 2, 'back to back is fine');
  assert.ok(realDate('2028-02-29') && !realDate('2027-02-29'));
});
await test('Zone locks: towns are read the same however they are typed (ZIP, full state name, punctuation); unreadable towns are held', () => {
  const locks = checkLocks({ locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'A', since: '2026-01-01' }] });
  for (const town of ['Smyrna, Tennessee', 'Smyrna TN 37167', 'Smyrna, TN.', '  smyrna  ', 'SMYRNA tn 37167-1234'])
    assert.deepEqual(spotFor({ trade: 'Plumbing', town }, locks, '2026-11-21'), { zone: 'Smyrna', open: false }, town);
  assert.deepEqual(spotFor({ trade: 'Plumbing', town: 'Mt. Juliet, Tennessee' }, locks, '2026-11-21'), { zone: 'Mt. Juliet', open: true });
  for (const town of ['37167', '<b>x</b>', 'Smyrna 2', ''])
    assert.ok(spotFor({ trade: 'Plumbing', town }, locks, '2026-11-21').hold, JSON.stringify(town));
  assert.equal(townKey('La Vergne, TN').key, 'la vergne');
});
await test('Open-spot line on the page: open zone shows "Your spot is open", a taken zone does not (the guarantee stays)', async () => {
  const { rec } = await built();
  const r = rec();
  r.sections = { ...RESEARCH, spot: spotFor(r, []) };
  assert.match(T.renderReport(r).html, /Your spot is open\.<\/b>.*The Smyrna zone is open for your trade/);
  r.sections.spot = spotFor(r, checkLocks({ locks: [{ trade: 'Heating and air', zone: 'Smyrna', business_name: 'Some Real Shop', since: '2026-01-01' }] }));
  const h = T.renderReport(r).html;
  assert.doesNotMatch(h, /Your spot is open/); assert.match(h, /Quote Guarantee/);
});

// ---------- fill jobs ----------
await test('Speed job: always the "We did not run this test for you" result, and it passes the door for a real shop', async () => {
  assert.deepEqual(JOBS.speed(), SPEED_UNTESTED);
  const item = { id: 'fr-20261121-aaaaaa', test: false, trade: 'Heating and air', town: 'Smyrna TN', sections: {} };
  const { fills, problems } = prepareFills(item, { speed: JOBS.speed() });
  assert.deepEqual(problems, []); assert.equal(fills[0].data.tested, false);
  const r = { ...item, business_name: 'X', received: '2026-11-20T20:00:00Z', sections: { speed: JOBS.speed() } };
  assert.match(T.renderReport(r).html, /We did not run this test for you: we do not call, text or email your business for this report\./);
});
await test('planFills: every section from research plus speed and spot; the competitor defaults to the top shop above him; nothing left', async () => {
  const { rec } = await built();
  const item = rec();
  const p = planFills(item, RESEARCH, { locks: [] });
  assert.deepEqual(p.missing, [], p.pendingAfter.join(', '));
  assert.deepEqual(Object.keys(p.data), ['google', 'reviews', 'ai', 'booking', 'category', 'speed', 'known_for', 'competitor', 'listings', 'spot']);
  assert.equal(p.data.competitor.name, 'Fake Air One (TEST)');
  assert.equal(p.data.competitor.theirs.rating, undefined, 'stars always come from the google section');
  assert.deepEqual(p.data.listings.sites.google, { found: true }, 'google row from the google section; "complete" is never guessed');
  assert.equal(p.data.known_for.reviews[0].rating, 5); assert.equal(p.data.known_for.scanned, 9);
  assert.equal(p.data.ai.question, 'Who is the best heating and air company in Smyrna, TN?');
  assert.equal(p.data.ai.screenshots, undefined, 'no screenshots unless hosted');
  const { problems } = prepareFills(item, p.data);
  assert.deepEqual(problems, [], 'every planned fill passes fillProblem');
});
await test('planFills: no research yet = only speed and spot; a research template lists exactly what is still needed', async () => {
  const { rec } = await built();
  const p = planFills(rec(), {}, { locks: [] });
  assert.deepEqual(Object.keys(p.data), ['speed', 'spot']);
  assert.deepEqual(p.missing, ['google', 'reviews', 'ai', 'booking', 'category', 'known_for', 'competitor', 'listings']);
  const t = researchTemplate(rec(), p.missing);
  assert.ok(t.google && t.ai && t.listings && t.screenshots && !t.speed && !t.spot);
  assert.match(t._rules, /Never send his form, never call, text or email the shop/);
});
await test('planFills: no Google profile means no known_for or competitor work; research speed and spot are ignored', async () => {
  const { rec } = await built();
  const rs = { ...RESEARCH, google: { has_google_profile: false }, reviews: undefined, known_for: undefined, competitor: undefined,
    speed: { tested: true, channel: 'call', when: 'x', minutes: 3 }, spot: { zone: 'Elsewhere', open: true } };
  const p = planFills(rec(), rs, { locks: [] });
  assert.deepEqual(p.missing, []);
  assert.ok(!('known_for' in p.data) && !('competitor' in p.data));
  assert.deepEqual(p.data.speed, SPEED_UNTESTED); assert.equal(p.data.spot.zone, 'Smyrna');
  assert.equal(p.notes.length, 2);
  assert.deepEqual(pendingSections(p.rec).sections, []);
});
await test('planFills: "Something else" gets no spot; a missing listing site is research still to do', async () => {
  const { rec } = await built({ ...FAKE, trade: 'Something else' });
  const rs = { ...RESEARCH, google: { ...RESEARCH.google, keyword: 'roofer Smyrna' }, listings: { sites: { google: { found: true } } } };
  const p = planFills(rec(), rs, { locks: [] });
  assert.ok(!('spot' in p.data));
  assert.deepEqual(p.missing, ['listings']);
});

// ---------- worker fill rules (item 5) ----------
await test('Fill rules: reviews, category and ai text fields are type and size checked; junk never reaches a page', async () => {
  const F = (sec, d) => T.fillProblem({ sections: {} }, sec, d);
  const R = RESEARCH.reviews, C = RESEARCH.category, A = RESEARCH.ai;
  assert.equal(F('reviews', R), ''); assert.equal(F('category', C), ''); assert.equal(F('ai', A), '');
  for (const d of [{ ...R, newest_review: { ...R.newest_review, rating: 99 } }, { ...R, newest_review: { ...R.newest_review, text: { x: 1 } } },
    { ...R, newest_review: { ...R.newest_review, date: 7 } }, { ...R, newest_review: { ...R.newest_review, text: 'a'.repeat(5001) } }, { ...R, owner_reply_on_newest: 'yes' }, { owner_reply_on_newest: true }])
    assert.match(F('reviews', d), /reviews/, JSON.stringify(d).slice(0, 80));
  for (const d of [{ main_category: { a: 1 }, big_job: [1, 2], match: 'yes' }, { main_category: 5, match: true }, { ...C, match: 'yes' }, { ...C, big_job: 'a'.repeat(121) }, { ...C, note: 'a'.repeat(301) }, { ...C, main_category: 'a'.repeat(121) }])
    assert.match(F('category', d), /category/, JSON.stringify(d).slice(0, 80));
  for (const d of [{ ...A, chatgpt: { named: false, note: 'a'.repeat(2000000) } }, { ...A, gemini: { named: true, correct: 'banana' } }, { ...A, question: { q: 1 } }, { ...A, google_ai: { named: false, note: 5 } }])
    assert.ok(F('ai', d), JSON.stringify(d).slice(0, 80));
  // and through the worker door
  const { env, id } = await built();
  const r = await local(env)(BASE + '/api/free-report/fill', { method: 'POST', body: JSON.stringify({ id, k: KEY, section: 'category', data: { main_category: { a: 1 }, match: true } }) });
  assert.equal(r.status, 400);
  assert.doesNotMatch(env.KV.m.get('rep:' + id), /\[object Object\]/);
});

// ---------- screenshot hosting (item 6) ----------
await test('Screenshots: hosted in KV for one report, served as a PNG, URL carries the image sha; foreign, missing, swapped or late ones refused', async () => {
  const { env, id, rec } = await built();
  const f = local(env);
  const up = (body, i = id) => f(BASE + '/api/free-report/shot', { method: 'POST', body: JSON.stringify({ id: i, k: KEY, ...body }) });
  assert.equal((await up({ engine: 'chatgpt', png: PNG.toString('base64'), k: 'nope' })).status, 403);
  assert.equal((await up({ engine: 'chatgpt', png: Buffer.from('GIF89a not a png at all').toString('base64') })).status, 400);
  assert.equal((await up({ engine: 'bing', png: PNG.toString('base64') })).status, 400);
  assert.equal((await up({ engine: 'chatgpt', png: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]).toString('base64') })).status, 400, 'over 1 MB');
  const j = await (await up({ engine: 'chatgpt', png: PNG.toString('base64') })).json();
  const v = (await T.sha(PNG.toString('base64'))).slice(0, 8);
  assert.equal(j.url, `${BASE}/r/${rec().token}/ai-chatgpt.png?v=${v}`);
  assert.equal((await up({ engine: 'chatgpt', png: PNG.toString('base64') })).status, 200, 'the same image again is fine');
  const PNG2 = Buffer.concat([PNG, Buffer.from('another image')]);
  assert.equal((await up({ engine: 'chatgpt', png: PNG2.toString('base64') })).status, 409, 'a different image for the same engine');
  const g = await f(j.url);
  assert.equal(g.status, 200); assert.equal(g.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await g.arrayBuffer()), PNG);
  assert.equal((await f(`${BASE}/r/${rec().token}/ai-gemini.png`)).status, 404, 'not uploaded');
  assert.equal((await f(`${BASE}/r/${'b'.repeat(48)}/ai-chatgpt.png`)).status, 404, 'wrong token');
  for (const u of [`/r/${rec().token}/ai-..%2frep.png`, `/r/${rec().token}/ai-bing.png`, `/r/${rec().token}/../rep`]) assert.equal((await f(BASE + u)).status, 404, u);
  const fillAi = (screenshots) => f(BASE + '/api/free-report/fill', { method: 'POST', body: JSON.stringify({ id, k: KEY, section: 'ai', data: { ...RESEARCH.ai, screenshots } }) });
  assert.equal((await fillAi([{ engine: 'gemini', url: `${BASE}/r/${rec().token}/ai-gemini.png?v=${v}` }])).status, 400, 'not hosted');
  assert.equal((await fillAi([{ engine: 'chatgpt', url: `${BASE}/r/${rec().token}/ai-chatgpt.png` }])).status, 400, 'no version');
  assert.equal((await fillAi([{ engine: 'chatgpt', url: `${BASE}/r/${rec().token}/ai-chatgpt.png?v=00000000` }])).status, 400, 'wrong version');
  assert.equal((await fillAi([{ engine: 'chatgpt', url: `${BASE}/some/other.png` }])).status, 400, 'not this report');
  // a shot hosted for another report can't be used here
  const o = await built(); const oj = await (await local(o.env)(BASE + '/api/free-report/shot', { method: 'POST', body: JSON.stringify({ id: o.id, k: KEY, engine: 'gemini', png: PNG.toString('base64') }) })).json();
  assert.equal((await local(o.env)(oj.url)).status, 200);
  assert.equal((await fillAi([{ engine: 'gemini', url: oj.url }])).status, 400, 'another report');
  assert.equal((await fillAi([{ engine: 'chatgpt', url: j.url }])).status, 200);
  assert.ok(env.KV.m.get('rep:' + id).includes(`<img src="${j.url}" alt="ChatGPT answer"`));
  const item = await findItem({ base: BASE, key: KEY, id, fetch: f });
  assert.match(prepareFills(item, { ai: { ...RESEARCH.ai, screenshots: [{ engine: 'chatgpt', url: `${BASE}/elsewhere/x.png` }] } }).problems[0], /hosted for this report/);
  // once checked, screenshots are frozen
  const c = await built(); const cr = JSON.parse(c.env.KV.m.get('req:' + c.id)); cr.status = 'checked'; c.env.KV.m.set('req:' + c.id, JSON.stringify(cr));
  assert.equal((await local(c.env)(BASE + '/api/free-report/shot', { method: 'POST', body: JSON.stringify({ id: c.id, k: KEY, engine: 'chatgpt', png: PNG.toString('base64') }) })).status, 409);
});

// ---------- the runner ----------
const rdir = (id, rs) => { const d = mkdtempSync(join(tmpdir(), 'frc-')); if (rs !== undefined) writeFileSync(join(d, id + '.json'), typeof rs === 'string' ? rs : JSON.stringify(rs)); return d; };
const withId = (id, rs = RESEARCH) => ({ id, ...rs });
const steps = (r) => r.steps.map((s) => s.step + ' ' + (s.msg || '')).join('\n');
const goodVerdicts = (id, hash, a = 'checker-1-sub-run9', b = 'checker-2-sub-run9') => ({ [id]: { 1: { agent: a, result: 'pass', hash }, 2: { agent: b, result: 'pass', hash } } });

await test('Runner dry run (default): reads, plans and checks, but posts nothing at all', async () => {
  const { env, id, rec } = await built();
  const spy = [], before = env.KV.m.get('req:' + id);
  const r = await run({ base: BASE, key: KEY, fetch: local(env, spy), research: rdir(id, withId(id)), locks: [], out: quiet, runId: 't1' });
  assert.equal(r.ok, true);
  assert.deepEqual(spy.filter((x) => x.method !== 'GET'), [], 'no POST in a dry run');
  assert.equal(env.KV.m.get('req:' + id), before, 'record untouched');
  assert.equal(r.summary[0].result, 'waiting for verdicts', steps(r));
  assert.ok(r.steps.some((s) => s.step === 'checker 1' && /pass/.test(s.msg)) && r.steps.some((s) => s.step === 'checker 2' && /pass/.test(s.msg)), steps(r));
  assert.ok(r.steps.every((s) => s.mode === 'dry-run'));
});
await test('Runner: script checks alone NEVER post a pass; passes need two sub-agent verdicts on this exact hash (item 1)', async () => {
  const { env, id, rec } = await built({ ...FAKE, business_name: 'Checker Run Heating', email: 'owner@checkerrun-heating.com' }, { LIVE: 'off', SEND_ROUTE: 'gmail' });
  const dir = rdir(id, withId(id)), spy = [];
  const r = await run({ base: BASE, key: KEY, fetch: local(env, spy), research: dir, locks: [], apply: true, out: quiet, runId: 'x1' });
  assert.equal(r.summary[0].result, 'waiting for verdicts', steps(r));
  assert.deepEqual(rec().checks || {}, {}, 'no marks at all'); assert.equal(rec().status, 'built'); assert.equal(rec().complete, true);
  assert.equal(spy.filter((c) => /\/check$/.test(c.url)).length, 0);
  // the attack: LIVE flips on afterwards; nothing was passed, so the cron has nothing to send
  env.LIVE = 'on'; const out = [];
  await T.tick(env, at('2026-11-20T15:00:00-06:00'), async (u) => { out.push(String(u)); return new Response('{}'); });
  assert.deepEqual(out, []); assert.equal(rec().status, 'built');
  env.LIVE = 'off';
  // half verdicts (slot 1 only): still nothing posted
  const h = rec().hash;
  const r2 = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts: { [id]: { 1: { agent: 'sub1', result: 'pass', hash: h } } }, out: quiet, runId: 'x4' });
  assert.match(steps(r2), /waiting for a sub-agent pass verdict from checker 2/); assert.deepEqual(rec().checks || {}, {});
  // script-named sub-agents are not accepted
  const r3 = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts: goodVerdicts(id, h, 'checker-1-script-x', 'checker-2-script-x'), out: quiet, runId: 'x5' });
  assert.match(steps(r3), /not a script name/); assert.deepEqual(rec().checks || {}, {});
  // two real verdicts on this hash: checked (LIVE off: not sent)
  const r4 = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts: goodVerdicts(id, h), out: quiet, runId: 'x6' });
  assert.deepEqual(r4.summary, [{ id, result: 'checked', sent: false }], steps(r4));
  assert.equal(rec().checks['1'].agent, 'checker-1-sub-run9'); assert.equal(rec().checks['2'].agent, 'checker-2-sub-run9');
  assert.match(rec().send_blocked || '', /LIVE/i);
});
await test('Runner: the same agent name in both slots is held and logged, never renamed (item 2)', async () => {
  const { env, id, rec } = await built();
  const dir = rdir(id, withId(id));
  await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, out: quiet, runId: 's1' });
  const r = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts: goodVerdicts(id, rec().hash, 'same', 'same'), out: quiet, runId: 's2' });
  assert.match(steps(r), /same agent/); assert.deepEqual(rec().checks || {}, {});
  assert.ok(!steps(r).includes('same-b'));
});
await test('Runner: a verdict on an old version (hash) is ignored (item 3)', async () => {
  const { env, id, rec } = await built();
  const dir = rdir(id, withId(id));
  const r = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts: goodVerdicts(id, 'e'.repeat(32)), out: quiet, runId: 'h1' });
  assert.match(steps(r), /verdict read version eeeeeeeeeeee/); assert.deepEqual(rec().checks || {}, {});
  const r2 = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts: { [id]: { 1: { agent: 'a1', result: 'pass' }, 2: { agent: 'a2', result: 'pass' } } }, out: quiet, runId: 'h2' });
  assert.match(steps(r2), /verdict read version none/); assert.deepEqual(rec().checks || {}, {});
});
await test('Runner: stops without a clear LIVE answer; re-reads /ping before the checker 2 pass and holds while LIVE is on (item 4)', async () => {
  const shop = { ...FAKE, business_name: 'Checker Run Heating', email: 'owner@checkerrun-heating.com' };
  // /review without "live" (an old deploy): stop, nothing done
  { const { env, id, rec } = await built(shop, { LIVE: 'on', SEND_ROUTE: 'gmail' }); const spy = [];
    const f0 = local(env, spy);
    const f = async (u, i) => { const r = await f0(u, i); if (/\/review\?/.test(u)) { const j = await r.json(); delete j.live; return new Response(JSON.stringify(j)); } return r; };
    const r = await run({ base: BASE, key: KEY, fetch: f, research: rdir(id, withId(id)), locks: [], apply: true, out: quiet, runId: 'l1' });
    assert.equal(r.ok, false); assert.equal(spy.filter((c) => c.method === 'POST').length, 0); assert.equal(rec().status, 'built'); }
  // LIVE off when listed, flipped on before checker 2: ping catches it
  { const { env, id, rec } = await built(shop, { LIVE: 'off', SEND_ROUTE: 'gmail' });
    const dir = rdir(id, withId(id));
    await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, out: quiet, runId: 'l2' });
    const f0 = local(env), spy = [];
    const f = async (u, i) => { spy.push(u); if (/\/check$/.test(u)) env.LIVE = 'on'; return f0(u, i); };
    const r = await run({ base: BASE, key: KEY, fetch: f, research: dir, locks: [], apply: true, verdicts: goodVerdicts(id, rec().hash), out: quiet, runId: 'l3' });
    assert.ok(spy.some((u) => /\/ping$/.test(u)), 'ping read before checker 2');
    assert.match(steps(r), /LIVE is on/); assert.equal(rec().checks['1'].result, 'pass'); assert.equal(rec().checks['2'], undefined); assert.equal(rec().status, 'built'); }
  // ping with no clear answer: hold
  { const { env, id, rec } = await built(shop);
    const dir = rdir(id, withId(id));
    await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, out: quiet, runId: 'l4' });
    const f0 = local(env); const f = async (u, i) => (/\/ping$/.test(u) ? new Response('{"ok":true}') : f0(u, i));
    const r = await run({ base: BASE, key: KEY, fetch: f, research: dir, locks: [], apply: true, verdicts: goodVerdicts(id, rec().hash), out: quiet, runId: 'l5' });
    assert.match(steps(r), /no clear LIVE answer/); assert.equal(rec().checks['2'], undefined); }
});
await test('Runner: junk research (type junk, huge text, "[object Object]") is refused or caught by checker 1 (item 5)', async () => {
  for (const patch of [{ category: { main_category: { a: 1 }, big_job: [1, 2], match: 'yes' } }, { reviews: { newest_review: { rating: 99, text: 'x', date: 'x' }, owner_reply_on_newest: false } },
    { ai: { ...RESEARCH.ai, chatgpt: { named: false, note: 'a'.repeat(3000000) } } }, { reviews: { newest_review: { rating: 5, text: { x: 1 }, date: 7 }, owner_reply_on_newest: true } }]) {
    const { env, id, rec } = await built();
    const r = await run({ base: BASE, key: KEY, fetch: local(env), research: rdir(id, withId(id, { ...RESEARCH, ...patch })), locks: [], apply: true, out: quiet, runId: 'j' });
    assert.equal(r.summary[0].result, 'needs research', steps(r));
    assert.match(steps(r), /refused/);
    const h = env.KV.m.get('rep:' + id) || '';
    assert.doesNotMatch(h, /\[object Object\]|99 stars/); assert.ok(h.length < 150000);
  }
  // checker 1 on a page that somehow carries junk
  const { rec } = await built();
  const item = { ...rec(), sections: { ...planFills(rec(), RESEARCH, { locks: [] }).data } };
  const html = T.renderReport(item).html;
  for (const junk of ['[object Object]', 'undefined', 'NaN', 'x'.repeat(200000)])
    assert.ok((await checker1(item, html.replace('</main>', junk + '</main>'))).problems.some((p) => /bad data|over the/.test(p)), junk.slice(0, 20));
});
await test('Runner: a research file for another id, or not an object, is skipped (item 10)', async () => {
  for (const rs of ['<html>nope', '[1,2]', 'null', JSON.stringify({ ...RESEARCH, id: 'fr-20990101-zzzzzz' }), JSON.stringify(RESEARCH)]) {
    const { env, id, rec } = await built();
    const r = await run({ base: BASE, key: KEY, fetch: local(env), research: rdir(id, rs), locks: [], apply: true, out: quiet, runId: 'i' });
    assert.equal(r.summary[0].result, 'needs research', rs.slice(0, 30));
    assert.equal(rec().sections.google, undefined, 'nothing from that file was used');
  }
});
await test('Runner options: values must not be another option; --only needs a real id; FREEREPORT_BASE only our site (items 11, 12)', async () => {
  assert.throws(() => args(['--only', '--apply']), /needs a value/);
  assert.throws(() => args(['--only']), /needs a value/);
  assert.throws(() => args(['--only', 'abc']), /request id/);
  assert.throws(() => args(['--research', '--templates']), /needs a value/);
  assert.equal(args(['--only', 'fr-20261121-abc123', '--apply']).only, 'fr-20261121-abc123');
  assert.equal(baseFromEnv(undefined), BASE); assert.equal(baseFromEnv(''), BASE); assert.equal(baseFromEnv(BASE + '/'), BASE);
  for (const b of ['https://evil.example', 'http://getbookedoutsolutions.com', 'https://getbookedoutsolutions.com.evil.example', 'https://bookedout-freereport.rickey-38a.workers.dev'])
    assert.throws(() => baseFromEnv(b), /FREEREPORT_BASE/, b);
  await assert.rejects(() => run({ base: 'https://evil.example', key: KEY, fetch: async () => { throw new Error('called'); }, locks: [], out: quiet }), /base must be/);
});
await test('Runner --apply with no research: fills speed and spot only, waits, and --templates writes the research file', async () => {
  const { env, id, rec } = await built();
  const dir = rdir(id);
  const r = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, templates: true, out: quiet, runId: 't4' });
  assert.equal(r.summary[0].result, 'needs research');
  assert.deepEqual(rec().sections.speed, SPEED_UNTESTED); assert.deepEqual(rec().sections.spot, { zone: 'Smyrna', open: true });
  assert.deepEqual(rec().checks || {}, {}, 'no check marks on an incomplete report');
  assert.equal(JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')).id, id, 'the template carries the id, so it is accepted once filled');
});
await test('Runner --apply full path with screenshots: fills, waits for verdicts, then checked; LIVE off sends nothing; log has every step', async () => {
  const { env, id, rec } = await built();
  const dir = rdir(id);
  const shotFile = join(dir, 'chatgpt.png'); writeFileSync(shotFile, PNG);
  writeFileSync(join(dir, id + '.json'), JSON.stringify(withId(id, { ...RESEARCH, screenshots: { chatgpt: shotFile } })));
  const spy = [], logFile = join(dir, 'log.jsonl');
  const r1 = await run({ base: BASE, key: KEY, fetch: local(env, spy), research: dir, locks: [], apply: true, out: quiet, runId: 'p1', logFile });
  assert.equal(r1.summary[0].result, 'waiting for verdicts', steps(r1));
  const x = rec();
  assert.match(x.sections.ai.screenshots[0].url, new RegExp(`^${BASE}/r/${x.token}/ai-chatgpt\\.png\\?v=[a-f0-9]{8}$`));
  assert.deepEqual(x.sections.speed, SPEED_UNTESTED);
  const r2 = await run({ base: BASE, key: KEY, fetch: local(env, spy), research: dir, locks: [], apply: true, verdicts: goodVerdicts(id, x.hash), out: quiet, runId: 'p2', logFile });
  assert.deepEqual(r2.summary, [{ id, result: 'checked', sent: false }], steps(r2));
  assert.equal(rec().status, 'checked');
  assert.ok(spy.every((c) => c.url.startsWith(BASE + '/api/free-report/') || c.url.startsWith(BASE + '/r/')), 'only our own worker');
  assert.ok(!spy.some((c) => /mark-sent/.test(c.url)));
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 10 && lines.some((l) => l.step === 'fill') && lines.some((l) => l.step === 'mark') && lines.at(-1).step === 'done');
  const r3 = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, out: quiet, runId: 'p3' });
  assert.deepEqual(r3.summary, [{ id, result: 'checked' }]);
});
await test('Runner: a script fail is posted (fail mark + watch entry) even with sub-agent passes; the next run skips it until fixed', async () => {
  const { env, id, rec } = await built();
  // the owner's private note copied into the category note: checker 2 must catch it
  const dir = rdir(id, withId(id, { ...RESEARCH, category: { ...RESEARCH.category, note: FAKE.note } }));
  const r = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, out: quiet, runId: 't5' });
  assert.equal(rec().status, 'held', steps(r));
  assert.ok(r.steps.some((s) => s.step === 'checker 2' && /private note/.test(s.msg)));
  assert.equal(rec().checks['2'].result, 'fail'); assert.match(rec().checks['2'].agent, /script/);
  assert.ok([...env.KV.m.keys()].some((k) => k.startsWith('watch:')));
  const r2 = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts: goodVerdicts(id, rec().hash), out: quiet, runId: 't6' });
  assert.equal(r2.summary[0].result, 'held, fix first');
});
await test('Runner --verdicts: a sub-agent fail on this hash is posted with its own name', async () => {
  const { env, id, rec } = await built();
  const dir = rdir(id, withId(id));
  await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, out: quiet, runId: 't7' });
  const verdicts = { [id]: { 1: { agent: 'checker-1-run77', result: 'fail', hash: rec().hash, notes: 'rank looks wrong on the live listing' } } };
  await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts, out: quiet, runId: 't8' });
  assert.equal(rec().status, 'held'); assert.equal(rec().checks['1'].agent, 'checker-1-run77'); assert.match(rec().checks['1'].notes, /rank looks wrong/);
});
await test('Checkers catch wording and fact problems on a page', async () => {
  const { rec } = await built();
  const item = { ...rec(), sections: { ...planFills(rec(), RESEARCH, { locks: [] }).data } };
  const r = T.renderReport(item); item.complete = r.complete; item.pending = r.pending; item.hash = await T.sha(r.html);
  assert.deepEqual((await checker1(item, r.html)).problems, []); assert.deepEqual(checker2(item, r.html).problems, []);
  const bad = r.html.replace('It is yours to keep.', 'It is yours to keep — our agents built it. You will rank higher \u{1F600}');
  const p2 = checker2(item, bad).problems.join(' | ');
  for (const re of [/locked wording/, /long dash/, /emoji/, /tools/, /promises/]) assert.match(p2, re);
  assert.match((await checker1(item, bad)).problems.join(' | '), /not what the current code renders/);
  assert.match(checker2(item, r.html.replace('Number 9', 'Number 2')).problems.join(' | '), /rank on the page/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
