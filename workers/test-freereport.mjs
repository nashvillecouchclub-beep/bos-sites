// Tests for workers/bookedout-freereport.js. Run: node workers/test-freereport.mjs
// No network: mock KV, mock fetch, fixed clock. Uses a clearly fake shop only.
import W from './bookedout-freereport.js';
import assert from 'node:assert/strict';

const T = W._t;
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message)); }
}

function kv() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
  };
}
// A fake fetch that records every call and answers like the lookup worker.
function fakeFetch(fixture) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://lookup.test/') {
      const b = JSON.parse(init.body);
      if (b.reviews_task_id) return new Response(JSON.stringify(fixture.reviews), { status: 200 });
      return new Response(JSON.stringify(fixture.google), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  };
  f.calls = calls;
  return f;
}
const SHOP = {
  first_name: 'Testy', business_name: 'Test Shop Heating and Air (FAKE)', email: 'test@example.com',
  phone: '615 555 0123', town: 'Smyrna TN', trade: 'Heating and air', note: 'Old quotes going quiet.',
  revenue: '$500K to $1M', consent: false, elapsed_ms: 5000, page: '/hvac-free-look.html',
};
const post = (body) => new Request('https://getbookedoutsolutions.com/api/free-report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const at = (s) => new Date(s); // ISO with offset
const ct = (d) => T.chicagoText(d);
const FIX = {
  google: { has_google_profile: true, rating: 4.4, review_count: 61, rank_for_keyword: 7, reviews_pending: true, reviews_task_id: 'task-1',
    top3: [{ name: 'Fake Air One', rating: 4.8, review_count: 310 }, { name: 'Fake Air Two', rating: 4.7, review_count: 190 }, { name: 'Fake Air Three', rating: 4.9, review_count: 140 }] },
  reviews: { newest_review: { rating: 5, text: 'Great work \u2014 fast and fair \u{1F600}', date: 'Nov 10 2026' }, owner_reply_on_newest: false },
};
// Visible text only (tags, styles and attributes removed)
const visible = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ');
const DASH = /[\u2012-\u2015]/, EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;

// ---------- validation ----------
await test('valid fake shop passes and phone is tidied', () => {
  const v = T.validate(SHOP);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.equal(v.clean.phone, '(615) 555-0123');
  assert.equal(v.clean.email, 'test@example.com');
});
await test('missing and bad fields give plain errors', () => {
  const v = T.validate({ ...SHOP, first_name: ' ', email: 'test@example', phone: '555-0123', town: '', trade: 'Roofing', revenue: 'Lots' });
  assert.equal(v.ok, false);
  for (const k of ['first_name', 'email', 'phone', 'town', 'trade', 'revenue']) assert.ok(v.errors[k], 'expected error for ' + k);
  assert.match(v.errors.email, /name@yourbusiness\.com/);
});
await test('phone with leading 1 ok, note over 1000 chars rejected', () => {
  assert.equal(T.validate({ ...SHOP, phone: '+1 (615) 555-0123' }).ok, true);
  assert.ok(T.validate({ ...SHOP, note: 'x'.repeat(1001) }).errors.note);
});

// ---------- submit: honeypot, 3-second check, rate limit ----------
await test('honeypot filled: quiet ok, nothing saved', async () => {
  const env = { KV: kv() };
  const r = await T.submit(post({ ...SHOP, bot_field: 'http://spam' }), env);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).id, null);
  assert.equal(env.KV.m.size, 0);
});
await test('under 3 seconds on the page is refused', async () => {
  const env = { KV: kv() };
  const r = await T.submit(post({ ...SHOP, elapsed_ms: 1200 }), env);
  assert.equal(r.status, 400);
  assert.equal(env.KV.m.size, 0);
});
await test('saves request with clock, then one per email per 10 minutes', async () => {
  const env = { KV: kv() };
  const now = at('2026-11-17T10:30:00-06:00');
  const r1 = await T.submit(post(SHOP), env, now);
  const j = await r1.json();
  assert.equal(j.saved, true);
  assert.match(j.id, /^fr-20261117-[a-z0-9]{6}$/);
  const rec = JSON.parse(env.KV.m.get('req:' + j.id));
  assert.equal(rec.status, 'new');
  assert.equal(rec.test, true);
  assert.equal(rec.due, at('2026-11-18T10:30:00-06:00').toISOString());
  assert.ok(env.KV.m.has('open:' + j.id));
  const r2 = await T.submit(post({ ...SHOP, email: 'TEST@example.com' }), env, now);
  assert.equal(r2.status, 429);
  assert.equal((await r2.json()).duplicate, true);
});

// ---------- the business-day clock ----------
const due = (s) => T.businessClock(at(s)).due.toISOString();
await test('Friday 4 pm -> Monday 4 pm', () => assert.equal(due('2026-11-20T16:00:00-06:00'), at('2026-11-23T16:00:00-06:00').toISOString()));
await test('Friday 6 pm -> counts from Monday 8 am -> Tuesday 8 am', () => {
  const c = T.businessClock(at('2026-11-20T18:00:00-06:00'));
  assert.equal(c.start.toISOString(), at('2026-11-23T08:00:00-06:00').toISOString());
  assert.equal(c.due.toISOString(), at('2026-11-24T08:00:00-06:00').toISOString());
  assert.equal(c.warn.toISOString(), at('2026-11-24T02:00:00-06:00').toISOString());
});
await test('Saturday -> Tuesday 8 am', () => assert.equal(due('2026-11-21T11:00:00-06:00'), at('2026-11-24T08:00:00-06:00').toISOString()));
await test('Thanksgiving eve 3 pm -> Friday 3 pm (skips Thanksgiving)', () => assert.equal(due('2026-11-25T15:00:00-06:00'), at('2026-11-27T15:00:00-06:00').toISOString()));
await test('Thanksgiving eve 6 pm -> Monday Nov 30 8 am', () => assert.equal(due('2026-11-25T18:00:00-06:00'), at('2026-11-30T08:00:00-06:00').toISOString()));
await test('On a holiday (Christmas 2026) -> Tuesday Dec 29 8 am', () => assert.equal(due('2026-12-25T10:00:00-06:00'), at('2026-12-29T08:00:00-06:00').toISOString()));
await test('Christmas Eve 2027 is observed: Thu Dec 23 2 pm -> Mon Dec 27 2 pm', () => assert.equal(due('2027-12-23T14:00:00-06:00'), at('2027-12-27T14:00:00-06:00').toISOString()));
await test('Before 8 am on a weekday counts from 8 am', () => assert.equal(due('2026-11-17T06:15:00-06:00'), at('2026-11-18T08:00:00-06:00').toISOString()));
await test('Exactly 5 pm counts as after hours', () => assert.equal(due('2026-11-17T17:00:00-06:00'), at('2026-11-19T08:00:00-06:00').toISOString()));
await test('Across the March 2027 clock change keeps the same clock time', () => assert.equal(due('2027-03-12T10:00:00-06:00'), at('2027-03-15T10:00:00-05:00').toISOString()));
await test('Federal holiday list 2026-2027 matches the calendar', () => {
  const want = ['2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-07-05',
    '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24'];
  for (const d of want) { const [y, m, dd] = d.split('-').map(Number); assert.equal(T.isBusinessDay(y, m, dd), false, d + ' should be a holiday'); }
  assert.ok(T.federalHolidays(2028).includes('2027-12-31'), 'New Year 2028 observed on Fri Dec 31 2027');
  assert.equal(T.isBusinessDay(2026, 11, 27), true, 'day after Thanksgiving is a business day');
});

// ---------- LIVE off never sends to the owner ----------
await test('LIVE off (default): owner delivery is blocked and makes no call', async () => {
  const f = fakeFetch(FIX);
  for (const LIVE of [undefined, 'off', 'OFF', '', 'yes']) {
    const r = await T.deliverToOwner({ LIVE }, { email: 'test@example.com' }, f);
    assert.equal(r.sent, false); assert.equal(r.blocked, true);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(T.isLive({ LIVE: 'on' }), true);
});
await test('Full run with LIVE off: only the lookup is called; clock trouble goes to the watch list, never an email', async () => {
  const env = { KV: kv(), LOOKUP_URL: 'https://lookup.test/', LOOKUP_KEY: 'fake', STATUS_KEY: 'k'.repeat(32) };
  const f = fakeFetch(FIX);
  const now = at('2026-11-17T10:30:00-06:00');
  const j = await (await T.submit(post({ ...SHOP, email: 'owner@fakeshop-test.com', business_name: 'Test Shop Heating and Air' }), env, now)).json();
  assert.ok(env.KV.m.has('lead:' + j.id), 'every lead is kept');
  assert.equal(JSON.parse(env.KV.m.get('lead:' + j.id)).business_name, 'Test Shop Heating and Air');
  await T.tick(env, at('2026-11-17T10:45:00-06:00'), f);
  assert.equal([...env.KV.m.keys()].filter((k) => k.startsWith('watch:')).length, 0, 'a built report is not a problem');
  await T.tick(env, at('2026-11-18T05:00:00-06:00'), f); // past 75%
  await T.tick(env, at('2026-11-18T10:31:00-06:00'), f); // overdue
  await T.tick(env, at('2026-11-18T11:00:00-06:00'), f); // nothing new
  for (const c of f.calls) assert.equal(c.url, 'https://lookup.test/', 'unexpected call to ' + c.url);
  const watch = [...env.KV.m.entries()].filter(([k]) => k.startsWith('watch:')).map(([, v]) => JSON.parse(v));
  assert.equal(watch.length, 2, '75% + overdue, once each');
  assert.deepEqual(watch.map((w) => w.level).sort(), ['problem', 'warn']);
  const over = watch.find((w) => w.level === 'problem');
  assert.match(over.subject, /OVERDUE/); assert.equal(over.id, j.id);
  assert.match(over.message, /Still pending: 3 ChatGPT and Gemini test, 4 Booking test, 5 Main category/);
  assert.match(over.message, /Nothing has been sent to this business/);
  const st = await (await W.fetch(new Request('https://x/api/free-report/status?k=' + env.STATUS_KEY), env, {})).json();
  assert.equal(st.problems, 1); assert.equal(st.watch.length, 2);
  const rec = JSON.parse(env.KV.m.get('req:' + j.id));
  assert.equal(rec.status, 'built');
  assert.equal(f.calls.filter((c) => c.url === 'https://lookup.test/').length, 2, 'one profile call and one reviews call');
});
await test('Fake shops never use the paid lookup; mark-sent stops the clock', async () => {
  const env = { KV: kv(), LOOKUP_URL: 'https://lookup.test/', LOOKUP_KEY: 'fake', STATUS_KEY: 'k'.repeat(32) };
  const f = fakeFetch(FIX);
  const j = await (await T.submit(post(SHOP), env, at('2026-11-17T10:30:00-06:00'))).json();
  await T.tick(env, at('2026-11-17T10:45:00-06:00'), f);
  assert.equal(f.calls.filter((c) => c.url === 'https://lookup.test/').length, 0);
  const bad = await W.fetch(new Request('https://x/api/free-report/mark-sent', { method: 'POST', body: JSON.stringify({ id: j.id, k: 'nope' }) }), env, {});
  assert.equal(bad.status, 403);
  const ok = await W.fetch(new Request('https://x/api/free-report/mark-sent', { method: 'POST', body: JSON.stringify({ id: j.id, k: env.STATUS_KEY }) }), env, {});
  assert.equal((await ok.json()).status, 'sent');
  await T.tick(env, at('2026-11-18T12:00:00-06:00'), f);
  assert.equal(f.calls.length, 0, 'no outside calls at all for a fake shop');
  assert.equal([...env.KV.m.keys()].filter((k) => k.startsWith('watch:')).length, 0, 'no overdue after sent');
  const st = await (await W.fetch(new Request('https://x/api/free-report/status?k=' + env.STATUS_KEY), env, {})).json();
  assert.equal(st.count, 0);
});

// ---------- the report ----------
const base = { id: 'fr-20261117-abc123', token: 'a'.repeat(48), first_name: 'Testy', business_name: 'Test Shop Heating and Air (FAKE)',
  email: 'test@example.com', town: 'Smyrna TN', trade: 'Heating and air', revenue: '', received: '2026-11-17T16:30:00.000Z', sections: {} };
await test('Report without lookup data: Google parts pending, not complete', () => {
  const r = T.renderReport(base);
  assert.equal(r.complete, false);
  assert.deepEqual(r.pending, ['1 Google', '2 Newest review', '3 ChatGPT and Gemini test', '4 Booking test', '5 Main category']);
  assert.match(r.html, /Your free report for Test Shop Heating and Air \(FAKE\)/);
  assert.match(r.html, /Start your free 30 days/);
  assert.match(r.html, /price-hvac\.html/);
  assert.match(r.html, /Nothing is charged for 30 days\. Cancel any time with one reply\./);
  assert.match(r.html, /noindex/);
  assert.doesNotMatch(r.html, /marketing budget/i);
});
await test('Report with lookup data (fixture): stars, rank, top 3, gap, newest review', () => {
  const g = { ...FIX.google, keyword: 'hvac Smyrna' };
  const r = T.renderReport({ ...base, sections: { google: g, reviews: FIX.reviews } });
  assert.deepEqual(r.pending, ['3 ChatGPT and Gemini test', '4 Booking test', '5 Main category']);
  for (const s of ['4.4 out of 5', 'Number 7', 'Fake Air One', '310 reviews', 'they average 213 reviews; you have 61', 'Not yet', 'hvac Smyrna'])
    assert.ok(r.html.includes(s.replace(/"/g, '&quot;')), 'missing: ' + s);
});
await test('No Google profile: the no-listing line, never a rank line', () => {
  const r = T.renderReport({ ...base, sections: { google: { has_google_profile: false } } });
  assert.match(r.html, /could not find a Google Business Profile/);
  assert.doesNotMatch(r.html, /Where you show for/);
  assert.doesNotMatch(r.html, /Number \d/);
  assert.match(r.html, /Set up your free Google Business Profile/);
});
await test('Complete report when every section is filled; other trades link to the free report page', () => {
  const r = T.renderReport({ ...base, trade: 'Electrical', sections: {
    google: { ...FIX.google, keyword: 'electrician Smyrna' }, reviews: FIX.reviews,
    ai: { question: 'Who is the best electrician in Smyrna?', chatgpt: { named: false }, gemini: { named: true, correct: false } },
    booking: { score: 6, fixes: ['Put the phone number at the top.', 'Make the quote button bigger.', 'Cut the form to 4 fields.'] },
    category: { main_category: 'Electrician', big_job: 'panel upgrades', match: true } } });
  assert.equal(r.complete, true);
  assert.match(r.html, /price-electrical\.html/);
  assert.match(r.html, /6<\/b> out of 10/);
  assert.match(T.renderReport({ ...base, trade: 'Something else' }).html, /getbookedoutsolutions\.com\/free-look\.html/);
});
await test('Budget line math for each range, absent when not given', () => {
  const want = {
    'Under $250K': "for you that's up to about $1,667 a month.",
    '$250K to $500K': "for you that's about $1,250 to $3,333 a month.",
    '$500K to $1M': "for you that's about $2,500 to $6,667 a month.",
    '$1M to $3M': "for you that's about $5,000 to $20,000 a month.",
    'Over $3M': "for you that's about $15,000 a month or more.",
  };
  for (const [k, v] of Object.entries(want)) {
    const line = T.budgetLine(k);
    assert.ok(line.startsWith('Shops your size spend 6 to 8% of revenue to grow; '), k);
    assert.ok(line.includes(v), k + ' -> ' + line);
    assert.ok(line.endsWith('Core is $997.'));
    assert.ok(T.renderReport({ ...base, revenue: k }).html.includes(v.replace(/'/g, '&#39;')), 'in report: ' + k);
  }
  assert.equal(T.budgetLine('Rather not say'), '');
  assert.equal(T.budgetLine(''), '');
  assert.doesNotMatch(T.renderReport({ ...base, revenue: 'Rather not say' }).html, /Shops your size/);
});
await test('No long dashes or emojis in any rendered visitor text (even from review text)', () => {
  const variants = [base, { ...base, revenue: 'Over $3M', sections: { google: { ...FIX.google, keyword: 'hvac Smyrna' }, reviews: FIX.reviews } },
    { ...base, sections: { google: { has_google_profile: false } } }];
  for (const v of variants) {
    const txt = visible(T.renderReport(v).html);
    assert.doesNotMatch(txt, DASH); assert.doesNotMatch(txt, EMOJI);
    assert.doesNotMatch(txt.split('\n')[0], /\bAI\b/);
  }
  assert.doesNotMatch(T.renderReport(base).html.match(/<h1>.*?<\/h1>/)[0], /\bAI\b/);
});
await test('Report page served with noindex, no-store and no-referrer', async () => {
  const env = { KV: kv() };
  const f = fakeFetch(FIX);
  const j = await (await T.submit(post(SHOP), env, at('2026-11-17T10:30:00-06:00'))).json();
  await T.tick(env, at('2026-11-17T10:45:00-06:00'), f);
  const rec = JSON.parse(env.KV.m.get('req:' + j.id));
  const r = await W.fetch(new Request(`https://getbookedoutsolutions.com/r/${rec.token}/`), env, {});
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await W.fetch(new Request(`https://getbookedoutsolutions.com/r/${'b'.repeat(48)}/`), env, {})).status, 404);
});
await test('Bigger shops are flagged for the Booker call now option (status list and watch text)', async () => {
  const env = { KV: kv(), STATUS_KEY: 'k'.repeat(32) };
  const f = fakeFetch(FIX);
  await T.submit(post({ ...SHOP, revenue: '$1M to $3M' }), env, at('2026-11-17T10:30:00-06:00'));
  await T.tick(env, at('2026-11-17T10:45:00-06:00'), f);
  const st = await (await W.fetch(new Request('https://x/api/free-report/status?k=' + env.STATUS_KEY), env, {})).json();
  assert.equal(st.open[0].big_shop, true); assert.equal(st.open[0].test, true);
  await T.tick(env, at('2026-11-18T10:31:00-06:00'), f);
  const w = [...env.KV.m.entries()].filter(([k]) => k.startsWith('watch:')).map(([, v]) => JSON.parse(v)).find((x) => x.level === 'test');
  const st2 = await (await W.fetch(new Request('https://x/api/free-report/status?k=' + env.STATUS_KEY), env, {})).json();
  assert.equal(st2.problems, 0, 'fake TEST shops never count as problems');
  assert.match(w.message, /FLAG: Booker call now option first/);
  assert.match(w.message, /TEST request/);
  assert.equal(f.calls.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
