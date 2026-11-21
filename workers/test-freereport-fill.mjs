// Tests for workers/freereport-fill.mjs (the fill job door) and the one-time re-render. Run: node workers/test-freereport-fill.mjs
// No network: the "worker" is the real worker code called in-process with a mock KV. Fake TEST shops only.
import W from './bookedout-freereport.js';
import { prepareFills, postFills, findItem, ORDER } from './freereport-fill.mjs';
import assert from 'node:assert/strict';

const T = W._t;
let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); } }
function kv() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
}
const KEY = 'k'.repeat(32), BASE = 'https://getbookedoutsolutions.com';
const at = (s) => new Date(s);
const FAKE = { first_name: 'Testy', business_name: 'Fill Job Heating (FAKE)', email: 'fill-job@example.com', phone: '615 555 0123', town: 'Smyrna TN',
  trade: 'Heating and air', revenue: '', consent: false, elapsed_ms: 5000, page: '/hvac-free-look.html' };
const DATA = {
  // deliberately out of order: the door puts google first so the competitor can be checked against it
  competitor: { name: 'Fake Air One (TEST)', theirs: { photos: 80 }, yours: { photos: 12 } },
  google: { has_google_profile: true, rating: 4.3, review_count: 27, rank_for_keyword: 9, rank_checked: true, keyword: 'hvac Smyrna',
    top3: [{ name: 'Fake Air One (TEST)', rating: 4.8, review_count: 240 }, { name: 'Fake Air Two (TEST)', rating: 4.7, review_count: 160 }, { name: 'Fake Air Three (TEST)', rating: 4.9, review_count: 101 }] },
  reviews: { newest_review: { rating: 5, text: 'test review', date: 'Nov 12 2026' }, owner_reply_on_newest: false },
  ai: { question: 'Who is the best heating and air company in Smyrna, TN?', chatgpt: { named: false }, gemini: { named: true }, google_ai: { named: false } },
  booking: { score: 6, fixes: ['Put your phone number at the top of the home page.'] },
  category: { main_category: 'HVAC contractor', big_job: 'new system installs', match: true },
  speed: { tested: true, channel: 'call', when: 'Mon Nov 16, 2:10 pm', minutes: 30 },
  known_for: { scanned: 6, reviews: ['On time, fair price', 'Fair price and on time', 'On time and clean', 'Clean, fair price', 'Clean and on time', 'Fair price'].map((text) => ({ text, rating: 5 })) },
  listings: { sites: { google: { found: true }, yelp: { found: false }, bbb: { found: true }, facebook: { found: true }, nextdoor: { found: false }, chamber: { found: false } } },
  spot: { zone: 'Smyrna', open: true },
};
// a fetch that answers like our live worker (same code), for one env
const local = (env) => async (url, init) => W.fetch(new Request(url, init), env, {});
async function built(shop = FAKE) {
  const env = { KV: kv(), STATUS_KEY: KEY };
  const j = await (await T.submit(new Request(BASE + '/api/free-report', { method: 'POST', body: JSON.stringify(shop) }), env, at('2026-11-20T14:38:00-06:00'))).json();
  await T.tick(env, at('2026-11-20T14:45:00-06:00'), async () => new Response('{}'));
  return { env, id: j.id, f: local(env), rec: () => JSON.parse(env.KV.m.get('req:' + j.id)) };
}

await test('Fill door: checks every section first, posts google first, and the report comes out complete', async () => {
  const { env, id, f, rec } = await built();
  const item = await findItem({ base: BASE, key: KEY, id, fetch: f });
  assert.equal(item.id, id); assert.equal(item.test, true);
  const { fills, problems } = prepareFills(item, DATA);
  assert.deepEqual(problems, []);
  assert.deepEqual(fills.map((x) => x.section), ORDER);
  const r = await postFills({ base: BASE, key: KEY, id, fills, fetch: f });
  assert.equal(r.ok, true, r.error);
  assert.equal(rec().complete, true, rec().pending.join(', '));
  assert.match(env.KV.m.get('rep:' + id), /Found but not chosen/);
});

await test('Fill door refuses bad data before anything is sent (AI without Google, unknown section, wrong competitor)', async () => {
  const { id, f, rec } = await built();
  const item = await findItem({ base: BASE, key: KEY, id, fetch: f });
  const { fills, problems } = prepareFills(item, { ...DATA, ai: { chatgpt: { named: false }, gemini: { named: true } }, extra: {}, competitor: { name: 'Not Top Three' } });
  assert.ok(problems.some((p) => /^ai: .*google_ai/.test(p)), problems.join(' | '));
  assert.ok(problems.some((p) => /^extra: not a report section/.test(p)));
  assert.ok(problems.some((p) => /^competitor: .*top 3/.test(p)));
  assert.ok(!fills.some((x) => ['ai', 'competitor'].includes(x.section)));
  // the worker itself also refuses an AI fill without google_ai (in case a job skips the door)
  const r = await f(BASE + '/api/free-report/fill', { method: 'POST', body: JSON.stringify({ id, k: KEY, section: 'ai', data: { chatgpt: { named: false }, gemini: { named: true } } }) });
  assert.equal(r.status, 400); assert.equal(rec().sections.ai, undefined);
});

await test('The answer speed result for a REAL shop is refused before GO LIVE; a fake TEST shop is fine', async () => {
  const item = { id: 'fr-20261120-aaaaaa', test: false, trade: 'Heating and air', sections: {} };
  let r = prepareFills(item, { speed: DATA.speed });
  assert.match(r.problems[0], /not before GO LIVE/); assert.equal(r.fills.length, 0);
  r = prepareFills(item, { speed: DATA.speed }, { afterGoLive: true });
  assert.deepEqual(r.problems, []);
  r = prepareFills(item, { speed: { tested: false, reason: 'not tested before GO LIVE' } });
  assert.deepEqual(r.problems, [], 'an untested note needs no contact, so it is fine');
  r = prepareFills({ ...item, test: true }, { speed: DATA.speed });
  assert.deepEqual(r.problems, []);
  r = prepareFills({ ...item, trade: 'Something else' }, { spot: DATA.spot });
  assert.match(r.problems[0], /Something else/);
});

await test('One-time re-render after deploy: every open report is rendered with the current code; old marks on a changed page are cleared', async () => {
  const { env, id, f, rec } = await built({ ...FAKE, email: 'owner@fakeshop-test.com', business_name: 'Fill Job Heating' });
  // make it look like a record from the old code: old sections only, stale "complete", stale hash, two old pass marks
  const r0 = rec();
  Object.assign(r0, { status: 'checked', complete: true, pending: [], hash: 'e'.repeat(32), sections: { google: DATA.google, reviews: DATA.reviews },
    checks: { 1: { agent: 'a', result: 'pass', hash: 'e'.repeat(32) }, 2: { agent: 'b', result: 'pass', hash: 'e'.repeat(32) } } });
  env.KV.m.set('req:' + id, JSON.stringify(r0));
  assert.equal((await f(BASE + '/api/free-report/rerender', { method: 'POST', body: JSON.stringify({ k: 'nope' }) })).status, 403);
  const j = await (await f(BASE + '/api/free-report/rerender', { method: 'POST', body: JSON.stringify({ k: KEY }) })).json();
  assert.equal(j.ok, true); assert.equal(j.checked, 1); assert.equal(j.changed, 1); assert.equal(j.marks_cleared, 1);
  assert.equal(rec().status, 'built'); assert.deepEqual(rec().checks, {}); assert.equal(rec().complete, false);
  // run again: nothing changes
  const j2 = await (await f(BASE + '/api/free-report/rerender', { method: 'POST', body: JSON.stringify({ k: KEY }) })).json();
  assert.equal(j2.changed, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
