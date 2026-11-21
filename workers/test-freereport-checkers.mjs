// Tests for the fill jobs (freereport-jobs.mjs), the zone-lock list (zone-locks.mjs), screenshot hosting and the
// "Free report checkers" runner (freereport-checkers.mjs). Run: node workers/test-freereport-checkers.mjs
// No network: the "worker" is the real worker code called in-process with a mock KV. Fake TEST shops only (plus one
// made-up real-looking shop that only ever lives in the mock KV, to prove nothing is sent).
import W from './bookedout-freereport.js';
import { prepareFills, findItem } from './freereport-fill.mjs';
import { planFills, researchTemplate, pendingSections, SPEED_UNTESTED, JOBS } from './freereport-jobs.mjs';
import { loadZoneLocks, checkLocks, spotFor as spotForRaw, townKey, realDate, chicagoDay, FILE } from './zone-locks.mjs';
// most tests look at zone and open only; lock_version and zone_towns have their own tests
const spotFor = (...a) => { const x = spotForRaw(...a); return x && !x.hold ? { zone: x.zone, open: x.open } : x; };
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
  assert.equal(locks.length, 0); assert.equal(locks.version, 1, 'the list carries its version');
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
  assert.equal(townKey('La Vergne, TN').key, 'lavergne');
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
  const r3 = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts: goodVerdicts(id, h, 'checker-1-SCRIPT-x', 'checker-2-scr\u200bipt-x'), out: quiet, runId: 'x5' });
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
  assert.deepEqual(rec().sections.speed, SPEED_UNTESTED); assert.deepEqual(rec().sections.spot, { zone: 'Smyrna', open: true, lock_version: 1 });
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

// ---------- second review ----------
const P = (env, id, hash) => (slot, agent, result, h = hash) => local(env)(BASE + '/api/free-report/check', { method: 'POST', body: JSON.stringify({ id, k: KEY, checker: slot, agent, result, hash: h }) }).then(async (r) => ({ ...(await r.json()), status: r.status }));
async function ready(shop = FAKE, env0 = {}) {
  const b = await built(shop, env0); const dir = rdir(b.id, withId(b.id));
  await run({ base: BASE, key: KEY, fetch: local(b.env), research: dir, locks: [], apply: true, out: quiet, runId: 'rd' });
  return { ...b, dir, hash: b.rec().hash };
}
await test('Review 2 item 1: a fresh sub-agent FAIL on this hash is posted even when checker 1 already passed, and nothing is sent later', async () => {
  const b = await ready({ ...FAKE, business_name: 'Checker Run Heating', email: 'owner@checkerrun-heating.com' }, { LIVE: 'off', SEND_ROUTE: 'gmail', GMAIL_CLIENT_ID: 'x', GMAIL_CLIENT_SECRET: 'y', GMAIL_REFRESH_TOKEN: 'z' });
  assert.equal((await P(b.env, b.id, b.hash)(1, 'sub-A-run1', 'pass')).status, 200);
  const v = { [b.id]: { 1: { agent: 'sub-A-run2', result: 'fail', hash: b.hash, notes: 'rank is wrong' }, 2: { agent: 'sub-B-run2', result: 'pass', hash: b.hash } } };
  const r = await run({ base: BASE, key: KEY, fetch: local(b.env), research: b.dir, locks: [], apply: true, verdicts: v, out: quiet, runId: 'r2' });
  assert.equal(b.rec().status, 'held', steps(r)); assert.equal(b.rec().checks['1'].result, 'fail'); assert.equal(b.rec().checks['2'], undefined);
  b.env.LIVE = 'on'; const out = [];
  await T.tick(b.env, at('2026-11-20T15:30:00-06:00'), async (u) => { out.push(String(u)); return new Response(JSON.stringify({ access_token: 't', id: 'm1', threadId: 'th' })); });
  assert.deepEqual(out, []); assert.equal(b.rec().status, 'held');
});
await test('Review 2 item 2: once a fail is on record for this version the worker refuses any pass, and sendBlock refuses too, until a fill', async () => {
  const b = await ready(); const p = P(b.env, b.id, b.hash);
  assert.equal((await p(1, 'A', 'pass')).status, 200);
  assert.equal((await p(2, 'B', 'fail')).status, 200);
  const r = await p(2, 'B', 'pass'); assert.equal(r.status, 409); assert.match(r.error, /failed this version/);
  const b2 = await ready(); const p2 = P(b2.env, b2.id, b2.hash);
  await p2(1, 'A', 'fail'); assert.equal((await p2(1, 'A', 'pass')).status, 409); assert.equal((await p2(2, 'B', 'pass')).status, 409);
  // sendBlock: a record that claims two passes but has a fail on this hash is never sent
  const rec = { ...b.rec(), status: 'checked', checks: { 1: { agent: 'a', result: 'pass', hash: b.hash }, 2: { agent: 'b', result: 'pass', hash: b.hash } } };
  assert.match(T.sendBlock({ LIVE: 'on' }, { ...rec, test: false }), /failed this version/);
  // a fill makes a new version: the fail list is cleared and passes are taken again
  await local(b2.env)(BASE + '/api/free-report/fill', { method: 'POST', body: JSON.stringify({ id: b2.id, k: KEY, section: 'booking', data: { score: 7, fixes: ['Put your phone number at the top of the home page.'] } }) });
  const nh = b2.rec().hash; assert.notEqual(nh, b2.hash); assert.ok(b2.rec().fails.includes(b2.hash), 'the old fail is never cleared');
  assert.equal((await P(b2.env, b2.id, nh)(1, 'A', 'pass')).status, 200);
  assert.equal((await P(b2.env, b2.id, nh)(2, 'B', 'pass')).status, 200);
  assert.equal(b2.rec().status, 'checked');
});
await test('Review 2 items 3+4: agent names are cleaned the same way everywhere; look-alike names are one agent; script names never pass', async () => {
  const c = T.cleanAgent;
  for (const [a, x] of [['Checker-A', 'checker-a'], ['checker a', 'checker  a'], ['checker-a', 'checker-a​'], ['checker a', 'checker a'], ['checker-a', 'checker‐a'], ['checker-a', ' checker-a  '], ['checker-a', 'ｃｈｅｃｋｅｒ-ａ']])
    assert.equal(c(a), c(x), JSON.stringify([a, x]));
  for (const [n, a, x] of [['case', 'Checker-A', 'checker-a'], ['zwsp', 'checker-a', 'checker-a​'], ['nbsp', 'checker a', 'checker a'], ['hyphen', 'checker-a', 'checker‐a']]) {
    const b = await ready();
    const r = await run({ base: BASE, key: KEY, fetch: local(b.env), research: b.dir, locks: [], apply: true, verdicts: goodVerdicts(b.id, b.hash, a, x), out: quiet, runId: 'n' });
    assert.match(r.summary[0].result, /held: .*same agent/, n); assert.deepEqual(b.rec().checks || {}, {}, n);
    // and the worker on its own
    const p = P(b.env, b.id, b.hash);
    assert.equal((await p(1, a, 'pass')).status, 200); assert.equal((await p(2, x, 'pass')).status, 409, n);
    assert.equal(b.rec().checks['1'].agent, c(a), 'stored cleaned');
  }
  const b = await ready(); const p = P(b.env, b.id, b.hash);
  for (const a of ['checker-1-script-1', 'SCRIPT', 'scr​ipt-x']) assert.equal((await p(1, a, 'pass')).status, 409, a);
  assert.equal((await p(1, 'checker-1-script-1', 'fail')).status, 200, 'a script may fail it');
});
await test('Review 2 item 5: zone towns typed every which way read the same; close or longer names are HELD, never open', () => {
  const L = checkLocks({ locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'A', since: '2026-01-01' }, { trade: 'Plumbing', zone: 'Mount Juliet', towns: ['La Vergne', 'Saint Paul'], business_name: 'B', since: '2026-01-01' }] });
  const sp = (town) => spotFor({ trade: 'Plumbing', town }, L, '2026-11-21');
  for (const t of ['Smyrna TN USA', 'Smyrna, Tenn.', 'Smyrna Tenn', 'Smyrna, TN, USA', 'Smyrna Tennessee USA', 'Smyrna TN 37167-1234', 'Smyrna  ,  TN', 'Smyrna (TN)', 'Smyrna-TN', 'Smyrna, T.N.', 'Smyrna, TN 37167, US', 'Smyrna Ｔｎ'])
    assert.deepEqual(sp(t), { zone: 'Smyrna', open: false }, t);
  for (const t of ['Mt. Juliet', 'Mt Juliet', 'LaVergne', 'Lavergne', 'La Vergne TN', 'St. Paul', 'St Paul']) assert.deepEqual(sp(t), { zone: 'Mount Juliet', open: false }, t);
  for (const t of ['Smryna', 'Smyrna Rutherford County', 'Smyrnaa', 'Smyna TN', 'La Vergne Heights']) assert.ok(sp(t).hold, t);
  assert.deepEqual(sp('Murfreesboro TN'), { zone: 'Murfreesboro', open: true });
  assert.deepEqual(spotFor({ trade: 'Electrical', town: 'Smryna' }, L, '2026-11-21'), { zone: 'Smryna', open: true }, 'other trades are not near a lock');
});
await test('Review 2 item 6: lock dates use the Central (America/Chicago) day', () => {
  assert.equal(chicagoDay(new Date('2026-11-22T03:30:00Z')), '2026-11-21', '9:30 pm Central on the 21st is still the 21st');
  assert.equal(chicagoDay(new Date('2026-11-22T06:30:00Z')), '2026-11-22');
  const L = checkLocks({ locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'A', since: '2026-11-22' }] });
  assert.deepEqual(spotFor({ trade: 'Plumbing', town: 'Smyrna' }, L, chicagoDay(new Date('2026-11-22T03:30:00Z'))), { zone: 'Smyrna', open: true }, 'not started yet in Smyrna');
  assert.deepEqual(spotFor({ trade: 'Plumbing', town: 'Smyrna' }, L, chicagoDay(new Date('2026-11-22T06:30:00Z'))), { zone: 'Smyrna', open: false });
});
await test('POST-only endpoints answer 405 to a GET', async () => {
  const { env } = await built();
  for (const u of ['shot', 'check', 'fill', 'mark-sent', 'rerender', 'followup']) assert.equal((await local(env)(BASE + '/api/free-report/' + u)).status, 405, u);
  assert.equal((await local(env)(BASE + '/api/free-report/ping')).status, 200);
});
await test('Review 2 item 7: names with angle brackets, quotes and & are compared as the page shows them (no false fail, no raw HTML)', async () => {
  const X = '<i>Z</i>"\'&';
  for (const [shop, rs] of [[{ ...FAKE, business_name: 'Acme ' + X + ' (FAKE)' }, RESEARCH], [FAKE, { ...RESEARCH, google: { ...RESEARCH.google, keyword: 'hvac ' + X } }],
    [FAKE, { ...RESEARCH, category: { main_category: 'HVAC ' + X, big_job: 'big ' + X, match: false, note: 'n ' + X } }]]) {
    const b = await built(shop);
    const r = await run({ base: BASE, key: KEY, fetch: local(b.env), research: rdir(b.id, withId(b.id, rs)), locks: [], apply: true, out: quiet, runId: 'e' });
    const h = b.env.KV.m.get('rep:' + b.id);
    assert.equal(r.summary[0].result, 'waiting for verdicts', steps(r));
    assert.ok(!h.includes('<i>Z</i>') && h.includes('&lt;i&gt;Z') && !h.includes('&amp;lt;'), 'escaped exactly once');
  }
});

// ---------- third review ----------
const LIVEENV = { LIVE: 'on', SEND_ROUTE: 'gmail', GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: 'c' };
const REALSHOP = { ...FAKE, business_name: 'Checker Run Heating', email: 'owner@checkerrun-heating.com' };
const fillX = (b, section, data) => local(b.env)(BASE + '/api/free-report/fill', { method: 'POST', body: JSON.stringify({ id: b.id, k: KEY, section, data }) }).then(async (r) => ({ ...(await r.json()), status: r.status }));
await test('Review 3 item 1: a failed version can never pass again, even when a later fill makes the same page (H1 -> H2 -> H1)', async () => {
  const b = await ready(); const H1 = b.hash, orig = JSON.parse(JSON.stringify(b.rec().sections.booking));
  await P(b.env, b.id, H1)(1, 'sub-a', 'pass'); await P(b.env, b.id, H1)(2, 'sub-b', 'fail');
  await fillX(b, 'booking', { ...orig, score: (orig.score % 10) + 1 }); assert.notEqual(b.rec().hash, H1);
  await fillX(b, 'booking', orig); assert.equal(b.rec().hash, H1, 'back to the same page');
  assert.equal((await P(b.env, b.id, H1)(1, 'sub-c', 'pass')).status, 409);
  assert.equal((await P(b.env, b.id, H1)(2, 'sub-d', 'pass')).status, 409);
  assert.deepEqual(JSON.parse(b.env.KV.m.get('fails:' + b.id)), [H1]);
  // rerender and the cron never clear it
  await T.rerender(new Request(BASE + '/x', { method: 'POST', body: JSON.stringify({ k: KEY }) }), b.env); await T.tick(b.env, new Date());
  assert.ok(JSON.parse(b.env.KV.m.get('fails:' + b.id)).includes(H1));
  const item = await findItem({ base: BASE, key: KEY, id: b.id, fetch: local(b.env) });
  assert.match(item.needs, /^fix first/);
  // capped at the last 50
  const fl = await T.addFail(b.env, b.id, 'x'.repeat(32)); for (let i = 0; i < 60; i++) await T.addFail(b.env, b.id, String(i).padStart(32, '0'));
  assert.equal(JSON.parse(b.env.KV.m.get('fails:' + b.id)).length, 50); assert.ok(fl.includes(H1));
});
await test('Review 3 item 2: a fail that races a pass still wins (own KV key); trySend re-reads the record and claims the send once', async () => {
  // race: checker 1 passed; a slot-1 fail and a slot-2 pass land at the same time
  { const b = await ready(REALSHOP, LIVEENV); const sends = [];
    await P(b.env, b.id, b.hash)(1, 'sub-a', 'pass');
    const m = b.env.KV, oget = m.get.bind(m); m.get = async (k) => { const v = await oget(k); await new Promise((r) => setTimeout(r, 5)); return v; };
    const orig = globalThis.fetch; globalThis.fetch = async (u) => { sends.push(String(u)); return new Response(JSON.stringify({ access_token: 't', id: 'm', threadId: 'th' })); };
    const [x, y] = await Promise.all([P(b.env, b.id, b.hash)(1, 'sub-c', 'fail'), P(b.env, b.id, b.hash)(2, 'sub-b', 'pass')]);
    m.get = oget; globalThis.fetch = orig;
    assert.equal(b.rec().status, 'held', JSON.stringify([x, y])); assert.ok(JSON.parse(b.env.KV.m.get('fails:' + b.id)).includes(b.hash));
    assert.deepEqual(sends, [], 'nothing sent');
    await T.tick(b.env, at('2026-11-20T16:00:00-06:00'), async (u) => { sends.push(String(u)); return new Response('{}'); });
    assert.deepEqual(sends, []); }
  // trySend: a KV copy that changed since (a fail mark on record) blocks the send even when the copy in hand looks fine
  { const b = await ready(REALSHOP, LIVEENV); const H = b.hash;
    const rec = { ...b.rec(), status: 'checked', checks: { 1: { agent: 'a', result: 'pass', hash: H }, 2: { agent: 'b', result: 'pass', hash: H } } };
    const kvRec = { ...rec, checks: { ...rec.checks, 2: { agent: 'b', result: 'fail', hash: H } } };
    b.env.KV.m.set('req:' + b.id, JSON.stringify(kvRec));
    const calls = []; const r = await T.trySend(b.env, rec, new Date(), async (u) => { calls.push(u); return new Response('{}'); });
    assert.equal(r.log, 'blocked'); assert.match(rec.send_blocked, /failed this version/); assert.deepEqual(calls, []); }
  // the claim: a second sender while the first holds the claim sends nothing
  { const b = await ready(REALSHOP, LIVEENV); const H = b.hash;
    const rec = { ...b.rec(), status: 'checked', checks: { 1: { agent: 'a', result: 'pass', hash: H }, 2: { agent: 'b', result: 'pass', hash: H } } };
    b.env.KV.m.set('req:' + b.id, JSON.stringify(rec)); b.env.KV.m.set('sendclaim:' + b.id, 'someone-else');
    const calls = []; await T.trySend(b.env, rec, new Date(), async (u) => { calls.push(u); return new Response('{}'); });
    assert.deepEqual(calls, []); assert.notEqual(rec.status, 'sent');
    b.env.KV.m.delete('sendclaim:' + b.id);
    const ok = async (u) => { calls.push(u); return new Response(JSON.stringify({ access_token: 't', id: 'm1', threadId: 'th' })); };
    await T.trySend(b.env, rec, new Date(), ok);
    assert.equal(rec.status, 'sent'); assert.equal(calls.filter((u) => /messages\/send/.test(u)).length, 1);
    assert.ok(b.env.KV.m.has('sendclaim:' + b.id)); }
});
await test('Review 3 item 3: the spot follows the zone-lock list as it is now; the worker refuses a spot not about his town; old list versions never send', async () => {
  const PL = { ...REALSHOP, trade: 'Plumbing', business_name: 'Checker Run Plumbing', email: 'owner@crp-plumb.com' };
  const b = await ready(PL, { LIVE: 'off' });
  assert.deepEqual(b.rec().sections.spot, { zone: 'Smyrna', open: true, lock_version: 1 });
  const locks = checkLocks({ version: 2, locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'Paid Plumbing Co', since: '2026-11-01' }] });
  const H = b.hash;
  const r = await run({ base: BASE, key: KEY, fetch: local(b.env), research: b.dir, locks, apply: true, verdicts: goodVerdicts(b.id, H), out: quiet, runId: 's1', allowSend: true });
  assert.match(r.summary[0].result, /spot filled again/); assert.deepEqual(b.rec().checks || {}, {}, 'no pass on the old spot');
  assert.deepEqual(b.rec().sections.spot, { zone: 'Smyrna', open: false, lock_version: 2, zone_towns: ['Smyrna'] });
  assert.doesNotMatch(b.env.KV.m.get('rep:' + b.id), /Your spot is open/);
  // a held town (close to a lock) fails checker 1 by script
  const c = await ready({ ...PL, email: 'o3@crp-plumb.com', town: 'Smryna TN' }, { LIVE: 'off' });
  const r2 = await run({ base: BASE, key: KEY, fetch: local(c.env), research: c.dir, locks, apply: true, out: quiet, runId: 's2' });
  assert.ok(r2.steps.some((x) => x.step === 'spot' || /spot/.test(x.msg || '')), steps(r2));
  // worker: a spot for another town is refused; a taken spot may name the lock zone only if its towns list his town
  const d = await ready({ ...PL, email: 'o2@crp-plumb.com', town: 'La Vergne, TN' }, { LIVE: 'off' });
  assert.equal((await fillX(d, 'spot', { zone: 'Murfreesboro', open: true, lock_version: 1 })).status, 400);
  assert.equal((await fillX(d, 'spot', { zone: 'Mount Juliet', open: true, lock_version: 1 })).status, 400, 'an open spot is always his own town');
  assert.equal((await fillX(d, 'spot', { zone: 'Mount Juliet', open: false, lock_version: 1, zone_towns: ['Mount Juliet', 'Lavergne'] })).status, 200);
  assert.equal((await fillX(d, 'spot', { zone: 'Mount Juliet', open: false, lock_version: 1, zone_towns: ['Mount Juliet'] })).status, 400);
  assert.equal((await fillX(d, 'spot', { zone: 'la vergne', open: true, lock_version: 1 })).status, 200);
  // sendBlock: an older list version than ZONE_LOCKS_VERSION never sends
  const ok = { ...d.rec(), status: 'checked', checks: { 1: { agent: 'a', result: 'pass', hash: d.rec().hash }, 2: { agent: 'b', result: 'pass', hash: d.rec().hash } } };
  assert.equal(T.sendBlock({ LIVE: 'on' }, ok), '');
  assert.match(T.sendBlock({ LIVE: 'on', ZONE_LOCKS_VERSION: '2' }, ok), /older zone-lock list/);
  assert.match(T.sendBlock({ LIVE: 'on' }, { ...ok, sections: { ...ok.sections, spot: { zone: 'La Vergne', open: true } } }), /older zone-lock list/);
  // the shipped list has a version
  assert.equal(loadZoneLocks().version, 1);
});
await test('Review 3 item 4: a sent report takes no more fills (409)', async () => {
  const b = await ready();
  const r0 = JSON.parse(b.env.KV.m.get('req:' + b.id)); r0.status = 'sent'; b.env.KV.m.set('req:' + b.id, JSON.stringify(r0));
  const h = b.rec().hash;
  const r = await fillX(b, 'booking', { score: 3, fixes: ['Put your phone number at the top of the home page.'] });
  assert.equal(r.status, 409); assert.equal(b.rec().hash, h);
});
await test('Review 3 items 5+6: emails are plain ASCII; control characters never reach a field; subjects that look like headers or encoded words are B-encoded on every route', async () => {
  const V = (o) => T.validate({ ...REALSHOP, ...o });
  for (const e of ['a@x.com\r\nBcc: e@x.com', 'a@x.com\u0000', 'a\u0085b@x.com', 'ü@x.com', 'a@x.com,e@evil.com', 'a%e@evil.com@x.com', '"a b"@x.com', 'a..b@x.com', '.a@x.com', 'a.@x.com', 'a@-x.com'])
    assert.equal(V({ email: e }).ok, false, JSON.stringify(e));
  for (const e of ['a+b@x.com', "o'brien@x.com", 'a.b_c-d%e@sub.x-y.com']) assert.equal(V({ email: e }).ok, true, e);
  const c = V({ business_name: 'Acme\r\nBcc: evil@x.com\u2028X\u0000Y', first_name: 'Bob\u000b\u000cZ', note: 'line one\r\nline two\u0000' }).clean;
  assert.ok(!/[\p{Cc}\u2028\u2029]/u.test(c.business_name + c.first_name)); assert.equal(c.note, 'line one\nline two');
  const rec = { ...c, token: 'a'.repeat(48), id: 'fr-20261120-aaaaaa' };
  const raw = T.mime(T.ownerEmail({}, rec)), lines = raw.split('\r\n\r\n')[0].split('\r\n');
  assert.ok(lines.every((l) => /^(From|To|Subject|MIME-Version|Message-ID|In-Reply-To|References|Content-Type|Content-Transfer-Encoding): /.test(l)), lines.join('\n'));
  assert.match(lines.find((l) => l.startsWith('Subject:')), /^Subject: =\?UTF-8\?B\?/);
  const encoded = T.mime(T.ownerEmail({}, { ...rec, business_name: '=?utf-8?q?Acme=0D=0ABcc:_e@x.com?=' })).split('\r\n').find((l) => l.startsWith('Subject:'));
  assert.match(encoded, /^Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
  assert.match(T.mime(T.ownerEmail({}, { ...rec, business_name: 'Test Shop Heating and Air' })), /\r\nSubject: Your free report for Test Shop Heating and Air\r\n/, 'plain names stay plain');
  for (const bad of ['<a@b>\r\nBcc: e@x.com', '<a@b>\u2028Bcc: e@x.com', 'nope']) assert.doesNotMatch(T.mime({ from: 'x', to: 'a@x.com', subject: 's', text: 't', inReplyTo: bad }), /In-Reply-To|Bcc/);
  // Resend and Cloudflare get the encoded subject when it holds "=?"
  const seen = [];
  await T.sendMail({ SEND_ROUTE: 'resend', RESEND_KEY: 'k', LIVE: 'on' }, { from: 'x', to: 'a@x.com', subject: 'Hi =?utf-8?q?x?=', text: 't' }, async (u, i) => { seen.push(JSON.parse(i.body).subject); return new Response('{"id":"r"}'); });
  await T.sendMail({ SEND_ROUTE: 'cloudflare', EMAIL: { send: async (m) => { seen.push(m.subject); return { id: 'c' }; } } }, { from: 'x', to: 'a@x.com', subject: 'Hi =?utf-8?q?x?=\r\nBcc: e', text: 't' });
  assert.equal(seen.length, 2); for (const x of seen) assert.match(x, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
});

// ---------- item 9 (write lock, one agent per version) ----------
const slowKV = (env) => { const m = env.KV, oget = m.get.bind(m); m.get = async (k) => { const v = await oget(k); await new Promise((r) => setTimeout(r, 5)); return v; }; return () => { m.get = oget; }; };
await test('Item 9: one agent posting to both slots at once (W3b) leaves the report NOT sendable, in either order', async () => {
  for (const order of ['1 first', '2 first']) {
    const b = await ready(REALSHOP, LIVEENV); const sends = [];
    await P(b.env, b.id, b.hash)(1, 'sub-a', 'pass');
    const orig = globalThis.fetch; globalThis.fetch = async (u) => { sends.push(String(u)); return new Response(JSON.stringify({ access_token: 't', id: 'm', threadId: 'th' })); };
    const undo = slowKV(b.env);
    const calls = [() => P(b.env, b.id, b.hash)(1, 'sub-x', 'pass'), () => P(b.env, b.id, b.hash)(2, 'sub-x', 'pass')];
    const res = await Promise.all(order === '1 first' ? calls.map((c) => c()) : calls.reverse().map((c) => c()));
    undo();
    assert.ok(res.some((r) => r.status === 409), order + ': ' + JSON.stringify(res));
    assert.match(T.agentsClash(await T.agentsMap(b.env, b.id), b.hash), /both checker slots/, order);
    await T.tick(b.env, at('2026-11-20T16:00:00-06:00'), async (u) => { sends.push(String(u)); return new Response(JSON.stringify({ access_token: 't', id: 'm', threadId: 'th' })); });
    globalThis.fetch = orig;
    assert.deepEqual(sends, [], order + ': nothing sent'); assert.notEqual(b.rec().status, 'sent');
    const item = await findItem({ base: BASE, key: KEY, id: b.id, fetch: local(b.env) });
    assert.match(item.needs, /^fix first .*both checker slots/, order);
  }
});
await test('Item 9: the same agent on the other slot of a version is refused even later (not only in a race)', async () => {
  const b = await ready(); const p = P(b.env, b.id, b.hash);
  assert.equal((await p(1, 'sub-a', 'fail')).status, 200);
  const b2 = await ready(); const p2 = P(b2.env, b2.id, b2.hash);
  assert.equal((await p2(1, 'sub-a', 'pass')).status, 200);
  assert.equal((await p2(1, 'sub-b', 'pass')).status, 200, 'slot 1 may be posted again by another agent');
  const r = await p2(2, 'SUB-A', 'pass'); assert.equal(r.status, 409); assert.match(r.error, /both slots/);
  assert.equal((await p2(2, 'sub-c', 'pass')).status, 200, 'a third agent is fine');
});
await test('Item 9: checks and fills take a per-report lock; a held lock makes a write wait, then 409; the lock is released', async () => {
  const b = await ready();
  b.env.KV.m.set('lock:' + b.id, 'someone-else');
  const r1 = await P(b.env, b.id, b.hash)(1, 'sub-a', 'pass'); assert.equal(r1.status, 409); assert.match(r1.error, /busy/);
  const r2 = await fillX(b, 'booking', { score: 3, fixes: ['Put your phone number at the top of the home page.'] }); assert.equal(r2.status, 409);
  assert.equal(b.rec().hash, b.hash); assert.deepEqual(b.rec().checks || {}, {});
  b.env.KV.m.delete('lock:' + b.id);
  assert.equal((await P(b.env, b.id, b.hash)(1, 'sub-a', 'pass')).status, 200);
  assert.ok(!b.env.KV.m.has('lock:' + b.id) && !b.env.KV.m.has('lockwait:' + b.id), 'released');
  // two fills at once are serialized: both land, one after the other
  const undo = slowKV(b.env);
  const [x, y] = await Promise.all([fillX(b, 'booking', { score: 4, fixes: ['Put your phone number at the top of the home page.'] }), fillX(b, 'category', { ...RESEARCH.category, match: false })]);
  undo();
  assert.equal(x.status, 200); assert.equal(y.status, 200);
  assert.equal(b.rec().sections.booking.score, 4); assert.equal(b.rec().sections.category.match, false, 'neither write lost');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
