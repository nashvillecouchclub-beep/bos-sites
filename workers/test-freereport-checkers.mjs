// Tests for the fill jobs (freereport-jobs.mjs), the zone-lock list (zone-locks.mjs), screenshot hosting and the
// "Free report checkers" runner (freereport-checkers.mjs). Run: node workers/test-freereport-checkers.mjs
// No network: the "worker" is the real worker code called in-process with a mock KV. Fake TEST shops only (plus one
// made-up real-looking shop that only ever lives in the mock KV, to prove nothing is sent).
import W from './bookedout-freereport.js';
import { prepareFills, findItem } from './freereport-fill.mjs';
import { planFills, researchTemplate, pendingSections, SPEED_UNTESTED, JOBS } from './freereport-jobs.mjs';
import { loadZoneLocks, checkLocks, spotFor, FILE } from './zone-locks.mjs';
import { run, checker1, checker2 } from './freereport-checkers.mjs';
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
await test('Zone locks: a bad list is an error, never a quiet "open"', () => {
  assert.throws(() => checkLocks({}), /locks/);
  assert.throws(() => checkLocks({ locks: [{ trade: 'Roofing', zone: 'Smyrna', business_name: 'X', since: '2026-11-01' }] }), /trade/);
  assert.throws(() => checkLocks({ locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'X', since: 'Nov 1' }] }), /since/);
  assert.throws(() => checkLocks({ locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'Fake (TEST)', since: '2026-11-01' }] }), /fake/i);
  assert.throws(() => checkLocks({ locks: [{ trade: 'Plumbing', zone: 'Smyrna', business_name: 'A', since: '2026-01-01' }, { trade: 'Plumbing', zone: 'Smyrna', business_name: 'B', since: '2026-02-01' }] }), /already locked/);
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

// ---------- screenshot hosting ----------
await test('Screenshots: hosted in KV for one report, served as a PNG on our domain, shown on the page; foreign or missing ones refused', async () => {
  const { env, id, rec } = await built();
  const f = local(env);
  const up = (body) => f(BASE + '/api/free-report/shot', { method: 'POST', body: JSON.stringify({ id, k: KEY, ...body }) });
  assert.equal((await up({ engine: 'chatgpt', png: PNG.toString('base64'), k: 'nope' })).status, 403);
  assert.equal((await up({ engine: 'chatgpt', png: Buffer.from('GIF89a not a png at all').toString('base64') })).status, 400);
  assert.equal((await up({ engine: 'bing', png: PNG.toString('base64') })).status, 400);
  assert.equal((await up({ engine: 'chatgpt', png: Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]).toString('base64') })).status, 400, 'over 1 MB');
  const j = await (await up({ engine: 'chatgpt', png: PNG.toString('base64') })).json();
  assert.equal(j.url, `${BASE}/r/${rec().token}/ai-chatgpt.png`);
  const g = await f(j.url);
  assert.equal(g.status, 200); assert.equal(g.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await g.arrayBuffer()), PNG);
  assert.equal((await f(`${BASE}/r/${rec().token}/ai-gemini.png`)).status, 404, 'not uploaded');
  assert.equal((await f(`${BASE}/r/${'b'.repeat(48)}/ai-chatgpt.png`)).status, 404, 'wrong token');
  // fills
  const fillAi = (screenshots) => f(BASE + '/api/free-report/fill', { method: 'POST', body: JSON.stringify({ id, k: KEY, section: 'ai', data: { ...RESEARCH.ai, screenshots } }) });
  assert.equal((await fillAi([{ engine: 'gemini', url: `${BASE}/r/${rec().token}/ai-gemini.png` }])).status, 400, 'not hosted');
  assert.equal((await fillAi([{ engine: 'chatgpt', url: `${BASE}/some/other.png` }])).status, 400, 'not this report');
  assert.equal((await fillAi([{ engine: 'chatgpt', url: j.url }])).status, 200);
  assert.match(env.KV.m.get('rep:' + id), new RegExp(`<img src="${j.url.replace(/[.]/g, '\\.')}" alt="ChatGPT answer"`));
  // the door refuses a screenshot that is not this report's own hosted URL before anything is posted
  const item = await findItem({ base: BASE, key: KEY, id, fetch: f });
  assert.match(prepareFills(item, { ai: { ...RESEARCH.ai, screenshots: [{ engine: 'chatgpt', url: `${BASE}/elsewhere/x.png` }] } }).problems[0], /hosted for this report/);
});

// ---------- the runner ----------
await test('Runner dry run (default): reads, plans and checks, but posts nothing at all', async () => {
  const { env, id, rec } = await built();
  const dir = mkdtempSync(join(tmpdir(), 'frc-')); writeFileSync(join(dir, id + '.json'), JSON.stringify(RESEARCH));
  const spy = [], before = env.KV.m.get('req:' + id);
  const r = await run({ base: BASE, key: KEY, fetch: local(env, spy), research: dir, locks: [], out: quiet, runId: 't1' });
  assert.equal(r.ok, true);
  assert.deepEqual(spy.filter((x) => x.method !== 'GET'), [], 'no POST in a dry run');
  assert.equal(env.KV.m.get('req:' + id), before, 'record untouched');
  assert.deepEqual(r.summary, [{ id, result: 'would be checked' }]);
  assert.ok(r.steps.some((s) => s.step === 'checker 1' && /pass/.test(s.msg)) && r.steps.some((s) => s.step === 'checker 2' && /pass/.test(s.msg)), r.steps.map((s) => s.step + ' ' + s.msg).join('\n'));
  assert.ok(r.steps.every((s) => s.mode === 'dry-run'));
  assert.equal(rec().status, 'built');
});
await test('Runner --apply: fills every section, both checkers pass, status "checked"; LIVE off sends nothing; log file has every step', async () => {
  const { env, id, rec } = await built();
  const dir = mkdtempSync(join(tmpdir(), 'frc-'));
  const shotFile = join(dir, 'chatgpt.png'); writeFileSync(shotFile, PNG);
  writeFileSync(join(dir, id + '.json'), JSON.stringify({ ...RESEARCH, screenshots: { chatgpt: shotFile } }));
  const spy = [], logFile = join(dir, 'log.jsonl');
  const r = await run({ base: BASE, key: KEY, fetch: local(env, spy), research: dir, locks: [], apply: true, out: quiet, runId: 't2', logFile });
  assert.deepEqual(r.summary, [{ id, result: 'checked', sent: false }], r.steps.map((s) => s.step + ' ' + (s.msg || '')).join('\n'));
  const x = rec();
  assert.equal(x.status, 'checked'); assert.equal(x.complete, true);
  assert.equal(x.checks['1'].agent, 'checker-1-script-t2'); assert.equal(x.checks['2'].agent, 'checker-2-script-t2');
  assert.equal(x.sections.ai.screenshots[0].url, `${BASE}/r/${x.token}/ai-chatgpt.png`);
  assert.deepEqual(x.sections.speed, SPEED_UNTESTED);
  assert.ok(spy.every((c) => c.url.startsWith(BASE + '/api/free-report/') || c.url.startsWith(BASE + '/r/')), 'only our own worker');
  assert.ok(!spy.some((c) => /mark-sent/.test(c.url)));
  const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 10 && lines.some((l) => l.step === 'fill') && lines.some((l) => l.step === 'mark') && lines.at(-1).step === 'done');
  // a second run finds nothing left to do for it
  const r2 = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, out: quiet, runId: 't3' });
  assert.deepEqual(r2.summary, [{ id, result: 'checked' }]);
});
await test('Runner --apply with no research: fills speed and spot only, waits, and --templates writes the research file', async () => {
  const { env, id, rec } = await built();
  const dir = mkdtempSync(join(tmpdir(), 'frc-'));
  const r = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, templates: true, out: quiet, runId: 't4' });
  assert.equal(r.summary[0].result, 'needs research');
  assert.deepEqual(rec().sections.speed, SPEED_UNTESTED); assert.deepEqual(rec().sections.spot, { zone: 'Smyrna', open: true });
  assert.deepEqual(rec().checks || {}, {}, 'no check marks on an incomplete report');
  assert.ok(existsSync(join(dir, id + '.json')));
  assert.equal(JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')).id, id);
});
await test('Runner: a REAL shop with LIVE off is checked but never sent; with LIVE on the checker 2 pass is held back without --allow-send', async () => {
  const shop = { ...FAKE, business_name: 'Checker Run Heating', email: 'owner@checkerrun-heating.com' };
  for (const live of ['off', 'on']) {
    const { env, id, rec } = await built(shop, { LIVE: live, SEND_ROUTE: 'gmail' });
    const dir = mkdtempSync(join(tmpdir(), 'frc-')); writeFileSync(join(dir, id + '.json'), JSON.stringify(RESEARCH));
    const spy = [];
    const r = await run({ base: BASE, key: KEY, fetch: local(env, spy), research: dir, locks: [], apply: true, out: quiet, runId: 'r' + live });
    const marks = spy.filter((c) => /\/check$/.test(c.url)).map((c) => JSON.parse(c.body).checker);
    if (live === 'off') {
      assert.deepEqual(marks, [1, 2]); assert.equal(rec().status, 'checked'); assert.equal(r.summary[0].sent, false);
      assert.match(rec().send_blocked || '', /LIVE/i);
    } else {
      assert.deepEqual(marks, [1], 'checker 2 not posted while LIVE is on');
      assert.match(r.summary[0].result, /LIVE on/); assert.equal(rec().status, 'built');
    }
  }
});
await test('Runner: a script fail holds the report (fail mark + watch entry); the next run skips it until the data is fixed', async () => {
  const { env, id, rec } = await built();
  const dir = mkdtempSync(join(tmpdir(), 'frc-'));
  // a reviewer's private note copied into the category note: checker 2 must catch it
  writeFileSync(join(dir, id + '.json'), JSON.stringify({ ...RESEARCH, category: { ...RESEARCH.category, note: FAKE.note } }));
  const r = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, out: quiet, runId: 't5' });
  assert.equal(rec().status, 'held', r.steps.map((s) => s.step + ' ' + (s.msg || '')).join('\n'));
  assert.ok(r.steps.some((s) => s.step === 'checker 2' && /private note/.test(s.msg)));
  assert.ok([...env.KV.m.keys()].some((k) => k.startsWith('watch:')));
  const r2 = await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, out: quiet, runId: 't6' });
  assert.equal(r2.summary[0].result, 'held, fix first');
});
await test('Runner --verdicts: a sub-agent fail is posted with its own name; a script fail always wins over a sub-agent pass', async () => {
  const { env, id, rec } = await built();
  const dir = mkdtempSync(join(tmpdir(), 'frc-')); writeFileSync(join(dir, id + '.json'), JSON.stringify(RESEARCH));
  const verdicts = { [id]: { 1: { agent: 'checker-1-run77', result: 'fail', notes: 'rank looks wrong on the live listing' } } };
  await run({ base: BASE, key: KEY, fetch: local(env), research: dir, locks: [], apply: true, verdicts, out: quiet, runId: 't7' });
  assert.equal(rec().status, 'held'); assert.equal(rec().checks['1'].agent, 'checker-1-run77'); assert.match(rec().checks['1'].notes, /rank looks wrong/);
  // script fail (private note on the page) + sub-agent pass for checker 2: the fail is posted
  const b = await built();
  const dir2 = mkdtempSync(join(tmpdir(), 'frc-'));
  writeFileSync(join(dir2, b.id + '.json'), JSON.stringify({ ...RESEARCH, category: { ...RESEARCH.category, note: FAKE.note } }));
  const v2 = { [b.id]: { 1: { agent: 'checker-1-run78', result: 'pass' }, 2: { agent: 'checker-2-run78', result: 'pass' } } };
  await run({ base: BASE, key: KEY, fetch: local(b.env), research: dir2, locks: [], apply: true, verdicts: v2, out: quiet, runId: 't8' });
  const y = b.rec();
  assert.equal(y.status, 'held'); assert.equal(y.checks['1'].agent, 'checker-1-run78'); assert.equal(y.checks['2'].result, 'fail');
  assert.equal(y.checks['2'].agent, 'checker-2-run78'); assert.match(y.checks['2'].notes, /private note/);
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
  const wrongRank = r.html.replace('Number 9', 'Number 2');
  assert.match(checker2(item, wrongRank).problems.join(' | '), /rank on the page/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
