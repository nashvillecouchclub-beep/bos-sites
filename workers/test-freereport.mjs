// Tests for workers/bookedout-freereport.js. Run: node workers/test-freereport.mjs
// No network: mock KV, mock fetch, fixed clock. Uses a clearly fake shop only.
import W0 from './bookedout-freereport.js';
import assert from 'node:assert/strict';
// BUNDLE=1 runs the same tests against the one-file dashboard bundle (node workers/build-freereport-bundle.mjs first).
const W = process.env.BUNDLE ? (await import('./dist/bookedout-freereport.bundle.js')).default : W0;

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

await test('Form test close guard: test_only closes a TEST entry as closed_test and refuses a real one', async () => {
  const env = { KV: kv(), STATUS_KEY: 'k'.repeat(32) };
  const fake = await (await T.submit(post({ ...SHOP, business_name: '(FAKE) Booked Out weekly form test 2026-11-24', email: 'formtest-20261124-1@example.com' }), env, at('2026-11-24T10:00:00-06:00'))).json();
  const real = await (await T.submit(post({ ...SHOP, business_name: 'Real Shop Heating', email: 'owner@realshop-test.com' }), env, at('2026-11-24T10:01:00-06:00'))).json();
  const close = (id) => W.fetch(new Request('https://x/api/free-report/mark-sent', { method: 'POST', body: JSON.stringify({ id, k: env.STATUS_KEY, test_only: true }) }), env, {});
  const r1 = await close(fake.id);
  assert.equal(r1.status, 200); assert.equal((await r1.json()).status, 'closed_test');
  const recF = JSON.parse(env.KV.m.get('req:' + fake.id));
  assert.equal(recF.status, 'closed_test'); assert.equal(recF.sent, undefined, 'a closed test is never counted as sent');
  assert.equal(env.KV.m.has('open:' + fake.id), false);
  const r2 = await close(real.id);
  assert.equal(r2.status, 409);
  const recR = JSON.parse(env.KV.m.get('req:' + real.id));
  assert.equal(recR.status, 'new'); assert.equal(env.KV.m.has('open:' + real.id), true, 'the real request stays open');
  const st = await (await W.fetch(new Request('https://x/api/free-report/status?k=' + env.STATUS_KEY), env, {})).json();
  assert.deepEqual(st.open.map((o) => o.id), [real.id]);
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

// ---------- the 2-agent check and the automatic send (Nov 16 4:46 pm: no check by Rickey) ----------
const KEY = 'k'.repeat(32);
const REAL = { ...SHOP, email: 'owner@fakeshop-test.com', business_name: 'Test Shop Heating and Air' }; // not a TEST marker, so it can "send" in tests
const FILLS = {
  google: { ...FIX.google, keyword: 'hvac Smyrna' }, reviews: FIX.reviews,
  ai: { question: 'Who is the best heating and air company in Smyrna?', chatgpt: { named: false }, gemini: { named: true, correct: true } },
  booking: { score: 6, fixes: ['Put the phone number at the top.', 'Make the quote button bigger.', 'Cut the form to 4 fields.'] },
  category: { main_category: 'HVAC contractor', big_job: 'new systems', match: true },
};
const call = (env, path, body) => W.fetch(new Request('https://x' + path, body ? { method: 'POST', body: JSON.stringify(body) } : {}), env, {});
// a full fake that also answers the Gmail token and send calls and the Resend call
function sendFetch(opts = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'tok' }), { status: opts.tokenStatus || 200 });
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') return new Response(JSON.stringify({ id: 'gm-1' }), { status: opts.sendStatus || 200 });
    if (url === 'https://api.resend.com/emails') return new Response(JSON.stringify({ id: 're-1' }), { status: 200 });
    return new Response('ok', { status: 200 });
  };
  f.calls = calls;
  return f;
}
const GMAIL = { SEND_ROUTE: 'gmail', GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'sec', GMAIL_REFRESH_TOKEN: 'ref' };
// a built, complete report for a non-test shop
async function ready(extra = {}, shop = REAL) {
  const env = { KV: kv(), STATUS_KEY: KEY, ...extra };
  const j = await (await T.submit(post(shop), env, at('2026-11-17T10:30:00-06:00'))).json();
  await T.tick(env, at('2026-11-17T10:45:00-06:00'), sendFetch());
  for (const [section, data] of Object.entries(FILLS)) await call(env, '/api/free-report/fill', { id: j.id, k: KEY, section, data });
  const rec = () => JSON.parse(env.KV.m.get('req:' + j.id));
  return { env, id: j.id, rec };
}
const mark = (env, id, checker, agent, result, hash, notes) => T.check(new Request('https://x/', { method: 'POST', body: JSON.stringify({ id, k: KEY, checker, agent, result, hash, notes }) }), env, at('2026-11-17T11:00:00-06:00'), env._f);
const watchOf = (env) => [...env.KV.m.entries()].filter(([k]) => k.startsWith('watch:')).map(([, v]) => JSON.parse(v));

await test('Review list needs the key and shows a complete report waiting for checker 1, with the lookup data', async () => {
  const { env, id, rec } = await ready();
  assert.equal((await call(env, '/api/free-report/review?k=nope')).status, 403);
  const r = await (await call(env, '/api/free-report/review?k=' + KEY)).json();
  assert.equal(r.count, 1);
  const w = r.waiting[0];
  assert.equal(w.id, id); assert.equal(w.complete, true); assert.equal(w.needs, 'checker 1');
  assert.equal(w.hash, rec().hash); assert.match(w.hash, /^[a-f0-9]{32}$/);
  assert.equal(w.sections.google.review_count, 61, 'lookup data is there to trace facts');
  assert.equal(w.business_name, 'Test Shop Heating and Air'); assert.equal(w.first_name, 'Testy');
});
await test('Check rules: no pass on pending sections, checker 1 first, two different agents, current version only', async () => {
  const env = { KV: kv(), STATUS_KEY: KEY };
  const j = await (await T.submit(post(REAL), env, at('2026-11-17T10:30:00-06:00'))).json();
  await T.tick(env, at('2026-11-17T10:45:00-06:00'), sendFetch());
  const h0 = JSON.parse(env.KV.m.get('req:' + j.id)).hash;
  assert.equal((await mark(env, j.id, 1, 'checker-a', 'pass', h0)).status, 409, 'pending sections cannot pass');
  const { env: e2, id, rec } = await ready();
  const h = rec().hash;
  assert.equal((await mark(e2, id, 2, 'checker-b', 'pass', h)).status, 409, 'checker 1 must pass first');
  assert.equal((await mark(e2, id, 1, 'checker-a', 'pass', 'f'.repeat(32))).status, 409, 'old version');
  assert.equal((await mark(e2, id, 1, 'checker-a', 'pass', h)).status, 200);
  assert.equal((await mark(e2, id, 2, 'checker-a', 'pass', h)).status, 409, 'same agent twice');
  assert.equal(rec().status, 'built');
  const bad = await T.check(new Request('https://x/', { method: 'POST', body: JSON.stringify({ id, k: 'nope', checker: 2, agent: 'b', result: 'pass', hash: h }) }), e2);
  assert.equal(bad.status, 403);
});
await test('Two passes with LIVE off: status checked, nothing sent, no outside call, no email to anyone', async () => {
  const f = sendFetch();
  const { env, id, rec } = await ready({ ...GMAIL, _f: f });
  const h = rec().hash;
  await mark(env, id, 1, 'checker-a', 'pass', h);
  const r = await (await mark(env, id, 2, 'checker-b', 'pass', h)).json();
  assert.equal(r.status, 'checked'); assert.equal(r.sent, false); assert.match(r.blocked, /LIVE is off/);
  await T.tick(env, at('2026-11-17T11:15:00-06:00'), f);
  assert.equal(f.calls.length, 0, 'no calls at all');
  assert.equal(rec().status, 'checked'); assert.ok(env.KV.m.has('open:' + id));
  assert.equal(watchOf(env).length, 0);
});
await test('Two passes with LIVE on (Gmail route): the owner gets one plain email with his report link, clock stops', async () => {
  const f = sendFetch();
  const { env, id, rec } = await ready({ ...GMAIL, LIVE: 'on', _f: f });
  const h = rec().hash;
  await mark(env, id, 1, 'checker-a', 'pass', h);
  assert.equal(f.calls.length, 0, 'one pass never sends');
  const r = await (await mark(env, id, 2, 'checker-b', 'pass', h)).json();
  assert.equal(r.sent, true); assert.equal(rec().status, 'sent'); assert.equal(rec().sent_by, 'auto'); assert.equal(rec().send_route, 'gmail');
  assert.ok(!env.KV.m.has('open:' + id));
  assert.deepEqual(f.calls.map((c) => c.url), ['https://oauth2.googleapis.com/token', 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send']);
  const raw = JSON.parse(f.calls[1].init.body).raw.replace(/-/g, '+').replace(/_/g, '/');
  const msg = Buffer.from(raw, 'base64').toString('utf8');
  assert.match(msg, /^From: Rickey Hallor <rickey@getbookedoutsolutions\.com>\r\nTo: owner@fakeshop-test\.com\r\nSubject: Your free report for Test Shop Heating and Air\r\n/);
  const body = Buffer.from(msg.split('\r\n\r\n')[1], 'base64').toString('utf8');
  assert.ok(body.includes(`https://getbookedoutsolutions.com/r/${rec().token}/`));
  assert.match(body, /^Hi Testy,/); assert.match(body, /P\.O\. Box 1166, Smyrna, TN 37167/); assert.match(body, /Reply "stop"/);
  assert.doesNotMatch(body, DASH); assert.doesNotMatch(body, EMOJI); assert.doesNotMatch(body, /\bAI\b|guarantee|rank #|more jobs|more calls/i);
  await T.tick(env, at('2026-11-18T12:00:00-06:00'), f);
  assert.equal(f.calls.length, 2, 'sent once only, no overdue after');
  assert.equal(watchOf(env).length, 0);
});
await test('A change after the checks clears both marks; the new version needs both checks again', async () => {
  const f = sendFetch();
  const { env, id, rec } = await ready({ ...GMAIL, _f: f });
  const h = rec().hash;
  await mark(env, id, 1, 'checker-a', 'pass', h); await mark(env, id, 2, 'checker-b', 'pass', h);
  assert.equal(rec().status, 'checked');
  await call(env, '/api/free-report/fill', { id, k: KEY, section: 'booking', data: { score: 7, fixes: ['Put the phone number at the top.'] } });
  assert.equal(rec().status, 'built'); assert.notEqual(rec().hash, h); assert.deepEqual(rec().checks, {});
  env.LIVE = 'on';
  await T.tick(env, at('2026-11-17T11:30:00-06:00'), f);
  assert.equal(f.calls.length, 0, 'never sent on old marks');
});
await test('A failed check holds the report and puts it on the watch list; the fix sends it back for both checks', async () => {
  const { env, id, rec } = await ready();
  const h = rec().hash;
  await mark(env, id, 1, 'checker-a', 'pass', h);
  const r = await (await mark(env, id, 2, 'checker-b', 'fail', h, 'Booking score not in the lookup data')).json();
  assert.equal(r.status, 'held');
  const w = watchOf(env);
  assert.equal(w.length, 1); assert.equal(w[0].level, 'problem'); assert.equal(w[0].id, id);
  assert.match(w[0].message, /Booking score not in the lookup data/);
  const st = await (await call(env, '/api/free-report/status?k=' + KEY)).json();
  assert.equal(st.problems, 1); assert.equal(st.open[0].status, 'held');
  await call(env, '/api/free-report/fill', { id, k: KEY, section: 'booking', data: { score: 5, fixes: ['Put the phone number at the top.'] } });
  assert.equal(rec().status, 'built');
  const rv = await (await call(env, '/api/free-report/review?k=' + KEY)).json();
  assert.equal(rv.waiting[0].needs, 'checker 1');
});
await test('A failed send goes to the watch list (not to Rickey) and is tried again on the next run', async () => {
  const f = sendFetch({ sendStatus: 500 });
  const { env, id, rec } = await ready({ ...GMAIL, LIVE: 'on', _f: f });
  const h = rec().hash;
  await mark(env, id, 1, 'checker-a', 'pass', h);
  const r = await (await mark(env, id, 2, 'checker-b', 'pass', h)).json();
  assert.equal(r.sent, false); assert.equal(rec().status, 'checked'); assert.equal(rec().send_fails, 1);
  const w = watchOf(env);
  assert.equal(w.length, 1); assert.equal(w[0].level, 'problem'); assert.match(w[0].subject, /send failed/);
  const ok = sendFetch();
  await T.tick(env, at('2026-11-17T11:15:00-06:00'), ok);
  assert.equal(rec().status, 'sent');
  for (const c of [...f.calls, ...ok.calls]) assert.ok(!/getbookedoutsolutions\.com/.test(c.url), 'no email or form post to us');
});
await test('Fake TEST shops are never sent, even with LIVE on and two passes', async () => {
  const f = sendFetch();
  const { env, id, rec } = await ready({ ...GMAIL, LIVE: 'on', _f: f }, SHOP);
  const h = rec().hash;
  await mark(env, id, 1, 'checker-a', 'pass', h); await mark(env, id, 2, 'checker-b', 'pass', h);
  await T.tick(env, at('2026-11-17T11:15:00-06:00'), f);
  assert.equal(f.calls.length, 0); assert.equal(rec().status, 'checked');
  assert.match(T.sendBlock({ LIVE: 'on' }, rec()), /TEST/);
});
await test('Send routes: Resend works, a route with no settings fails softly, an unknown route is refused', async () => {
  const f = sendFetch();
  const m = T.ownerEmail({}, { first_name: 'Testy', business_name: 'Test Shop\r\nBcc: x@y.com', email: 'owner@fakeshop-test.com', token: 'a'.repeat(48) });
  assert.doesNotMatch(T.mime(m), /\r\nBcc:/, 'no header injection from the business name');
  const r1 = await T.sendMail({ LIVE: 'on', SEND_ROUTE: 'resend', RESEND_KEY: 'x' }, m, f);
  assert.equal(r1.ok, true); assert.equal(f.calls[0].url, 'https://api.resend.com/emails');
  assert.equal(JSON.parse(f.calls[0].init.body).to[0], 'owner@fakeshop-test.com');
  assert.deepEqual(await T.sendMail({ LIVE: 'on', SEND_ROUTE: 'gmail' }, m, f), { ok: false, route: 'gmail', error: 'gmail route not set up' });
  assert.equal((await T.sendMail({ LIVE: 'on', SEND_ROUTE: 'cloudflare' }, m, f)).error, 'cloudflare route not set up');
  const sent = [];
  assert.equal((await T.sendMail({ LIVE: 'on', SEND_ROUTE: 'cloudflare', EMAIL: { send: async (x) => { sent.push(x); return { messageId: 'cf-1' }; } } }, m, f)).id, 'cf-1');
  assert.equal(sent[0].to, 'owner@fakeshop-test.com');
  assert.equal((await T.sendMail({ LIVE: 'on', SEND_ROUTE: 'smtp' }, m, f)).error, 'unknown SEND_ROUTE');
  const off = await T.sendMail({ SEND_ROUTE: 'resend', RESEND_KEY: 'x' }, m, f);
  assert.equal(off.ok, false, 'with LIVE off even a direct sendMail call is blocked'); assert.match(off.error, /blocked outbound/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
