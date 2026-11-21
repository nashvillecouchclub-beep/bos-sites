// Tests for workers/bookedout-freereport.js. Run: node workers/test-freereport.mjs
// No network: mock KV, mock fetch, fixed clock. Uses a clearly fake shop only.
import W0 from './bookedout-freereport.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as FU from './freereport-followups.js';
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
// The sections added Nov 20 (item 215, item 211, the Nov 19 diagnosis line). Fake TEST data only.
const NEW = {
  speed: { tested: true, channel: 'call', when: 'Mon Nov 16, 2:10 pm', minutes: null, waited_hours: 48, after_hours: { tested: true, answered: false, when: 'Mon Nov 16, 7:40 pm', channel: 'call' } },
  known_for: { scanned: 7, reviews: ['On time and a fair price.', 'Showed up on time, fair price, clean work.', 'Fair price, on time again.', 'They were on time and clean.', 'Clean work and a fair price.', 'Great service'].map((text) => ({ text, rating: 5 }))
    .concat([{ text: 'Late and rude, not on time, not a fair price, not clean.', rating: 1 }]) },
  competitor: { name: 'Fake Air One', theirs: { photos: 80, reply_pct: 90, posts_90d: 6, website: true, hours: true }, yours: { photos: 12, reply_pct: 10, posts_90d: 0, website: true, hours: true } },
  listings: { sites: { google: { found: true, complete: true }, yelp: { found: false }, bbb: { found: true, complete: false, fix: 'Fix the old phone number on your BBB page.' },
    facebook: { found: true }, nextdoor: { found: false }, chamber: { found: true } } },
  spot: { zone: 'Smyrna', open: true },
};
const AI_FULL = (ai) => ({ ...ai, google_ai: { named: false } });
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
  assert.deepEqual(r.pending, ['0 Diagnosis', '1 Google', '2 Newest review', '3 ChatGPT and Gemini test', '4 Booking test', '5 Main category',
    '6 Answer speed', '7 What you are known for', '8 Competitor gap', '9 Listing check', 'Spot and guarantee']);
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
  assert.deepEqual(r.pending, ['3 ChatGPT and Gemini test', '4 Booking test', '5 Main category', '6 Answer speed', '7 What you are known for', '8 Competitor gap', '9 Listing check', 'Spot and guarantee']);
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
    ai: AI_FULL({ question: 'Who is the best electrician in Smyrna?', chatgpt: { named: false }, gemini: { named: true, correct: false } }),
    booking: { score: 6, fixes: ['Put the phone number at the top.', 'Make the quote button bigger.', 'Cut the form to 4 fields.'] },
    category: { main_category: 'Electrician', big_job: 'panel upgrades', match: true }, ...NEW } });
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
    const top = T.renderReport(v).html.split('<section')[0];
    assert.doesNotMatch(visible(top), /\bAI\b/, 'the top of the page never leads with AI');
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
  ai: { question: 'Who is the best heating and air company in Smyrna?', chatgpt: { named: false }, gemini: { named: true, correct: true }, google_ai: { named: false } },
  booking: { score: 6, fixes: ['Put the phone number at the top.', 'Make the quote button bigger.', 'Cut the form to 4 fields.'] },
  category: { main_category: 'HVAC contractor', big_job: 'new systems', match: true },
  ...NEW,
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
  const env = { KV: kv(), STATUS_KEY: KEY, SPEED_TEST_LIVE: 'on', ...extra };
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

// ---------- Nov 20 additions: item 215, item 211, the one-line diagnosis ----------
const G7 = { ...FIX.google, keyword: 'hvac Smyrna' }; // rank 7, 61 reviews, top 3 average 213
const FULL = { google: G7, reviews: FIX.reviews, ai: FILLS.ai, booking: FILLS.booking, category: FILLS.category, ...NEW };
const rr = (sections, extra = {}) => T.renderReport({ ...base, ...extra, sections });
const top = (html) => visible(html.split('<section')[0]).replace(/\s+/g, ' ');

await test('Diagnosis line: "not found" (no profile / not in first 20), "found but not chosen", "chosen but never followed up", backed by the data', () => {
  let r = rr({ google: { has_google_profile: false } });
  assert.match(top(r.html), /In one line: Not found\. We could not find a Google Business Profile for Test Shop Heating and Air \(FAKE\) in Smyrna TN/);
  r = rr({ google: { ...G7, rank_for_keyword: null, rank_checked: true }, ai: { chatgpt: { named: false }, gemini: { named: false } } });
  assert.match(top(r.html), /Not found\. You are not in the first 20 Google results for &quot;hvac Smyrna&quot;, and ChatGPT and Gemini did not name you either\./);
  r = rr({ google: G7 });
  assert.equal(r.diagnosis, 'found but not chosen');
  assert.match(top(r.html), /Found but not chosen\. You show at number 7 for &quot;hvac Smyrna&quot;, below the top 3, and they average 213 reviews to your 61\./);
  const g2 = { ...G7, rank_for_keyword: 2 };
  r = rr({ google: g2, speed: NEW.speed });
  assert.equal(r.diagnosis, 'chosen but never followed up');
  assert.match(top(r.html), /Chosen but never followed up\. You are number 2 for &quot;hvac Smyrna&quot;, but our test call got no answer in 48 hours\./);
  r = rr({ google: g2, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 120 } });
  assert.equal(r.diagnosis, 'chosen but slow to follow up');
  assert.match(top(r.html), /Chosen but slow to follow up\. You are number 2 for &quot;hvac Smyrna&quot;, but our test call took 120 minutes|our test call took about 2 hours to get an answer/);
  // under 120 minutes the diagnosis and the speed section use the same words
  r = rr({ google: g2, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 90 } });
  assert.match(top(r.html), /Chosen but slow to follow up\. .* our test call took 90 minutes to get an answer\./);
  assert.match(visible(r.html), /You answered in 90 minutes\./);
  assert.doesNotMatch(visible(r.html), /never followed up/, 'an answer, even a late one, is not "never followed up"');
  r = rr({ google: g2, speed: { tested: true, channel: 'text', when: 'Mon', minutes: 4, after_hours: { tested: true, answered: false, when: 'Mon 8 pm', channel: 'call' } } });
  assert.match(top(r.html), /Chosen but never followed up\. You are number 2 for &quot;hvac Smyrna&quot;, but our after-hours test call got no answer\./);
  r = rr({ google: g2, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 4 } });
  assert.equal(r.diagnosis, 'chosen'); assert.match(top(r.html), /Found and chosen\. You are number 2 .* in 4 minutes/);
  r = rr({ google: g2, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 30 } });
  assert.equal(r.diagnosis, 'chosen but slow to answer');
  assert.match(top(r.html), /Found and chosen, but slow to answer\. You are number 2 for &quot;hvac Smyrna&quot;, and our test call took 30 minutes to get an answer\./);
  // never "Not found" from missing data: no rank and no positive "we ran the search" flag = pending
  r = rr({ google: { ...G7, rank_for_keyword: null } });
  assert.equal(r.pending[0], '0 Diagnosis'); assert.ok(r.pending.includes('1 Google (search not run)'));
  assert.doesNotMatch(visible(r.html), /Not found|Not in the first 20/);
  r = rr({ google: { rating: 4 } });
  assert.equal(r.pending[0], '0 Diagnosis', 'no yes/no on the profile = pending, not "not found"');
  assert.match(T.fillProblem({ sections: {} }, 'google', { rating: 4 }), /has_google_profile/);
  assert.match(T.fillProblem({ sections: {} }, 'google', { ...G7, rank_for_keyword: null }), /rank_checked/);
  assert.match(T.fillProblem({ sections: {} }, 'google', { ...G7, rank_for_keyword: 31 }), /1 to 20/);
  assert.match(T.fillProblem({ sections: {} }, 'google', { ...G7, top3: [{ rating: 4 }] }), /top3/);
  assert.equal(T.fillProblem({ sections: {} }, 'google', G7), '');
  assert.equal(T.fillProblem({ sections: {} }, 'google', { has_google_profile: false }), '');
  r = rr({ google: g2 });
  assert.equal(r.pending[0], '0 Diagnosis', 'top 3 shop with no speed test yet: the diagnosis waits, never guessed');
  assert.doesNotMatch(top(r.html), /In one line/);
  assert.equal(rr({}).pending[0], '0 Diagnosis');
});

await test('Answer speed: booking-rate estimate is labeled, sourced, and picked by the real answer time', () => {
  const cases = [[3, /fastest group/, /Lead Response Management Study/], [20, /about 21 times between a 5 minute answer and a 30 minute answer/, /Lead Response Management Study/],
    [180, /A Harvard Business Review study found .* nearly 7 times as likely/, /Harvard Business Review, March 2011/],
    [2000, /more than 60 times as likely .* 24 hours or longer/, /Harvard Business Review/],
    [null, /A Harvard Business Review study found .* more than 60 times as likely .* 24 hours or longer/, /1\.25 million leads at 42 U\.S\. companies/]];
  for (const [m, want, src] of cases) {
    const sp = m == null ? { tested: true, channel: 'call', when: 'Mon Nov 16, 2:10 pm', minutes: null, waited_hours: 48 } : { tested: true, channel: 'call', when: 'Mon Nov 16, 2:10 pm', minutes: m };
    const txt = visible(rr({ google: G7, speed: sp }).html).replace(/\s+/g, ' ');
    assert.match(txt, /What research says about answer speed \(outside research, not your numbers\):/);
    assert.doesNotMatch(txt, /Booking-rate|booking rate/i, 'the studies measure reaching and qualifying leads, not jobs booked');
    if (m === 3) assert.doesNotMatch(txt.split('What research says')[1].split('Source:')[0], /estimate/i, 'the under-5-minutes text is not an estimate');
    assert.match(txt, want, String(m)); assert.match(txt, src, String(m));
    assert.match(txt, m == null ? /We made one test call to your business on Mon Nov 16, 2:10 pm\. We waited 48 hours and got no answer/
      : m === 180 ? /You answered in about 3 hours\./ : m === 2000 ? /The answer took a day or more\./ : new RegExp(`You answered in ${m} minutes`));
  }
  assert.match(visible(rr({ speed: { tested: false, reason: 'the shop has no phone number listed anywhere' } }).html), /We did not run this test for you: the shop has no phone number listed anywhere/);
});

await test('After-hours estimate: labeled, sourced, HVAC only; a count only when the owner told us his calls', () => {
  let txt = visible(rr({ speed: NEW.speed }).html).replace(/\s+/g, ' ');
  assert.match(txt, /After-hours calls \(estimate\): In 2025, about 9\.8 to 14\.1 of every 100 calls to home heating and air shops came outside business hours/);
  assert.match(txt, /Our after-hours test call got no answer, so some of those calls may be going unanswered now\./);
  assert.match(txt, /ServiceTitan, .*June 3 2026.*not nationally representative/);
  assert.doesNotMatch(txt, /calls a month after hours/);
  assert.doesNotMatch(txt, /Missed/);
  for (const answered of [true, undefined]) {
    const t2 = visible(rr({ speed: { ...NEW.speed, after_hours: answered === undefined ? undefined : { tested: true, answered, when: 'Mon 8 pm', channel: 'call' } } }).html);
    assert.doesNotMatch(t2, /may be going unanswered/, 'only when the after-hours call was not answered');
  }
  txt = visible(rr({ speed: { ...NEW.speed, leads_per_month: 200, leads_source: 'owner' } }).html).replace(/\s+/g, ' ');
  assert.match(txt, /You told us you get about 200 calls a month, so that is roughly 20 to 28 calls a month after hours\./);
  txt = visible(rr({ speed: NEW.speed }, { trade: 'Plumbing' }).html).replace(/\s+/g, ' ');
  assert.match(txt, /We do not have a trusted outside number for after-hours calls in your trade/);
  assert.doesNotMatch(txt, /9\.8|14\.1|ServiceTitan/);
  assert.match(T.fillProblem({ sections: {} }, 'speed', { ...NEW.speed, leads_per_month: 200 }), /only allowed when the owner told us/);
  assert.match(T.fillProblem({ sections: {} }, 'speed', { tested: true, channel: 'form', when: 'Mon', minutes: 3 }), /never send a form/);
  assert.match(T.fillProblem({ sections: {} }, 'speed', { tested: true, channel: 'call', when: 'Mon', minutes: null }), /waited_hours/);
  assert.equal(T.fillProblem({ sections: {} }, 'speed', NEW.speed), '');
});

await test('What you are known for: words repeated across his reviews, counted once per review, his own name left out', () => {
  const k = T.knownFor(NEW.known_for.reviews.filter((x) => x.rating >= 4).map((x) => x.text));
  assert.deepEqual(k.map((x) => x.word).sort(), ['clean', 'fair price', 'on time']);
  assert.equal(k.find((x) => x.word === 'fair price').count, 4); assert.equal(k.find((x) => x.word === 'on time').count, 4);
  assert.equal(T.knownFor(['Smyrna Air was on time', 'smyrna air on time', 'Smyrna Air, on time'], ['smyrna', 'air']).map((x) => x.word).join(), 'on time');
  assert.equal(T.knownFor(['on time on time on time', 'great', 'good']).length, 0, 'one review saying it 3 times is not a pattern');
  const txt = visible(rr({ google: G7, known_for: NEW.known_for }).html).replace(/\s+/g, ' ');
  assert.match(txt, /We read 7 of your Google reviews\. 6 were 4 or 5 stars with words in them\. In those, these words came up again and again: "fair price" in 4 reviews/);
  assert.match(txt, /That is what your happy customers already say you are known for/);
  assert.doesNotMatch(txt, /"late"|"rude"/, 'the 1 star review is never counted');
  // complaint words and turned-around words never surface, even in good reviews
  const mixed = ['Not happy at first but fixed it, on time', 'Never late, on time', 'Was not rude at all, on time and friendly', 'Friendly and on time', 'Friendly crew', 'Late once but friendly', 'On time, friendly'];
  const k2 = T.knownFor(mixed).map((x) => x.word);
  assert.ok(k2.includes('on time') && k2.includes('friendly'), k2.join());
  for (const bad of ['happy', 'late', 'rude', 'not', 'never']) assert.ok(!k2.some((w) => w.split(' ').includes(bad)), bad + ' in ' + k2.join());
  // "the price was high": the whole complaint sentence is dropped, so "price" never shows as a good word
  const priced = ['The price was high but they were on time', 'Price was high. On time though', 'Costly, but on time', 'They charged me twice for the price of the part', 'On time and fair price', 'Clean and on time'];
  const k3 = T.knownFor(priced).map((x) => x.word);
  assert.ok(k3.includes('on time'), k3.join());
  assert.ok(!k3.some((w) => /price|high|charged|twice|costly/.test(w)), k3.join());
  // few words: points to the review fix only when the review fix is really in the three fixes
  const fewG = { ...G7, review_count: 8, top3: [] };
  const few = visible(rr({ google: fewG, known_for: { scanned: 8, reviews: [{ text: 'Good', rating: 5 }, { text: 'Fine job', rating: 4 }, { text: 'Bad', rating: 2 }] } }).html).replace(/\s+/g, ' ');
  assert.match(few, /We read 8 of your Google reviews\. 2 were 4 or 5 stars with words in them\. That is not enough yet to see what customers say you are known for\. The review fix below is the place to start\./);
  assert.match(T.pickFixes({ ...base, sections: { google: fewG } })[0], /Google review the day/);
  const noFix = visible(rr({ google: { has_google_profile: true, rating: 5, review_count: 400, rank_for_keyword: 1, keyword: 'hvac Smyrna', top3: [] },
    reviews: { newest_review: { rating: 5, text: 'x' }, owner_reply_on_newest: true }, known_for: { scanned: 3, reviews: [{ text: 'Good', rating: 5 }] } }).html);
  assert.doesNotMatch(noFix, /review fix below/, 'no review fix in the three fixes, so the page never points to one');
  assert.match(T.fillProblem({ sections: {} }, 'known_for', { texts: ['x'] }), /up to 300 \{text, rating/);
  assert.match(T.fillProblem({ sections: {} }, 'known_for', { reviews: [{ text: 'x', rating: 5 }] }), /scanned/);
  assert.match(T.fillProblem({ sections: {} }, 'known_for', { scanned: 2, reviews: [{ text: 'x', rating: 7 }] }), /rating/);
  assert.equal(T.fillProblem({ sections: {} }, 'known_for', NEW.known_for), '');
});

await test('Item 211: few Google reviews -> the report points to the review fix, and the review fix is in the three fixes', () => {
  const g = { ...G7, review_count: 8, top3: [{ name: 'Fake Air One', rating: 4.8, review_count: 6 }, { name: 'Fake Air Two', rating: 4.7, review_count: 5 }, { name: 'Fake Air Three', rating: 4.9, review_count: 4 }] };
  const sec = { google: g, reviews: { ...FIX.reviews, owner_reply_on_newest: true } };
  const fx = T.pickFixes({ ...base, sections: sec });
  assert.match(fx[0], /^Ask every happy customer for a Google review the day the job is done\. You have 8 Google reviews so far/);
  assert.match(visible(rr(sec).html).replace(/\s+/g, ' '), /Few reviews so far\. With 8 Google reviews, a new customer has little to go on\. The review fix below is the place to start\./);
  assert.doesNotMatch(visible(rr({ google: G7 }).html), /Few reviews so far/, '61 reviews is not few');
  const one = T.pickFixes({ ...base, sections: { google: { ...g, review_count: 1, top3: [] } } });
  // a fast answer drops the base "call back within 5 minutes" fix; a slow one keeps it
  const fastFx = T.pickFixes({ ...base, sections: { google: G7, reviews: { ...FIX.reviews, owner_reply_on_newest: true }, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 2 } } });
  assert.ok(!fastFx.some((x) => /within 5 minutes/.test(x)), fastFx.join(' | '));
  const slowFx = T.pickFixes({ ...base, sections: { google: G7, reviews: { ...FIX.reviews, owner_reply_on_newest: true }, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 40 } } });
  assert.ok(slowFx.some((x) => /within 5 minutes/.test(x)), slowFx.join(' | '));
  assert.match(one[0], /You have 1 Google review so far/);
  assert.equal(T.pickFixes({ ...base, sections: { google: { ...G7, review_count: 8 } } }).filter((x) => /Google review the day/.test(x)).length, 1, 'never twice');
});

await test('Competitor gap: only a top 3 shop that outranks him, side by side, the 3 biggest gaps in order', () => {
  const rec = { ...base, sections: { google: G7 } };
  assert.match(T.fillProblem(rec, 'competitor', { name: 'Someone Else Air' }), /one of the top 3 names/);
  assert.match(T.fillProblem({ sections: {} }, 'competitor', { name: 'Fake Air One' }), /fill google/);
  assert.match(T.fillProblem({ sections: { google: { ...G7, rank_for_keyword: 2 } } }, 'competitor', { name: 'Fake Air Two' }), /does not outrank him/);
  assert.match(T.fillProblem(rec, 'competitor', { name: 'Fake Air One', theirs: { review_count: 999 } }), /not allowed/);
  assert.match(T.fillProblem(rec, 'competitor', { name: 'Fake Air One', theirs: { reply_pct: 140 } }), /bad value/);
  assert.equal(T.fillProblem(rec, 'competitor', NEW.competitor), '');
  const v = T.competitorView({ ...base, sections: { google: G7, competitor: NEW.competitor } });
  assert.equal(v.name, 'Fake Air One'); assert.equal(v.pos, 1);
  // biggest first: posts 6 vs 0 (100% behind), photos 80 vs 12 (85%), reviews 310 vs 61 (80%); replies 90% vs 10% (0.8) is fourth
  assert.deepEqual(v.gaps, ['They made 6 Google posts in the last 90 days; you made 0.', 'They show 80 photos on Google; you show 12.', 'They have 310 Google reviews; you have 61.']);
  const txt = visible(rr({ google: G7, competitor: NEW.competitor }).html).replace(/\s+/g, ' ');
  assert.match(txt, /The top shop that shows above you is Fake Air One \(number 1 in the top 3\)/);
  assert.match(txt, /Google reviews 310 61/); assert.match(txt, /Stars 4\.8 out of 5 4\.4 out of 5/);
  assert.match(txt, /The 3 biggest gaps/);
  assert.match(visible(rr({ google: { ...G7, rank_for_keyword: 1 } }).html), /You are number 1 for this search, so no shop outranks you here/);
  assert.ok(!rr({ google: { ...G7, rank_for_keyword: 1 } }).pending.includes('8 Competitor gap'));
  assert.ok(!rr({ google: { has_google_profile: false } }).pending.includes('8 Competitor gap'));
  assert.ok(rr({ google: G7 }).pending.includes('8 Competitor gap'));
  const moved = rr({ google: { ...G7, top3: G7.top3.slice(1) }, competitor: NEW.competitor });
  assert.ok(moved.pending.includes('8 Competitor gap'), 'google filled again with a new top 3: the old competitor pick waits for a new fill');
  assert.ok(rr({ google: { ...G7, rank_for_keyword: 1 }, competitor: NEW.competitor }).pending.every((x) => x !== '8 Competitor gap'));
});

await test('Listing check: all six places, one simple fix per weak one, a missing fix is refused', () => {
  assert.match(T.fillProblem({ sections: {} }, 'listings', { sites: { google: { found: true } } }), /listings\.sites\.yelp/);
  assert.match(T.fillProblem({ sections: {} }, 'listings', { sites: { ...NEW.listings.sites, bbb: { found: true, complete: false } } }), /bbb\.fix/);
  assert.equal(T.fillProblem({ sections: {} }, 'listings', NEW.listings), '');
  const txt = visible(rr({ listings: NEW.listings }).html).replace(/\s+/g, ' ');
  for (const x of ['Google Found', 'Yelp Not found', 'BBB Found, needs work', 'Facebook Found', 'Nextdoor Not found', 'Local chamber of commerce Found']) assert.ok(txt.includes(x), x);
  assert.match(txt, /Yelp: Claim your free Yelp business page/); assert.match(txt, /BBB: Fix the old phone number on your BBB page\./);
  assert.match(txt, /Nextdoor: Claim your free Nextdoor business page/);
  assert.doesNotMatch(txt, /Facebook: /, 'no fix for a place in good shape');
});

await test('Open spot and the named guarantee: written for this shop, true to the site terms, no promise of jobs', () => {
  let txt = visible(rr({ spot: NEW.spot }).html).replace(/\s+/g, ' ');
  assert.match(txt, /Your spot is open\. We lock each zone to one heating and air shop\. The Smyrna zone is open for your trade right now\./);
  assert.match(txt, /The Test Shop Heating and Air \(FAKE\) Quote Guarantee\. Once your first paid month starts: new quotes you forward are contacted within 2 business days\./);
  assert.ok(txt.includes('We guarantee our part of every piece: the writing, the sending, the posting, the submitting. Not the printer, the mail, Google or your customers. We never promise jobs, revenue or a spot on Google. If we miss any piece of your package, your next month is free.'));
  assert.ok(txt.includes('There are no guarantees during a free period, because nothing is being charged.'));
  assert.doesNotMatch(txt, /Quote Promise/);
  // the guarantee sentences are word for word on the site's terms page
  const terms = readFileSync(new URL('../sites/getbookedoutsolutions.com/terms.html', import.meta.url), 'utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  for (const line of ['We guarantee our part of every piece: the writing, the sending, the posting, the submitting. Not the printer, the mail, Google or your customers. We never promise jobs, revenue or a spot on Google.',
    'If we miss any piece of your package, your next month is free.', 'There are no guarantees during a free period, because nothing is being charged.', 'New quotes you forward are contacted within 2 business days.'])
    assert.ok(terms.includes(line), 'not on the terms page: ' + line);
  txt = visible(rr({ spot: { zone: 'Smyrna', open: false } }).html);
  assert.doesNotMatch(txt, /Your spot is open/); assert.match(txt, /Quote Guarantee/);
  assert.ok(rr({}).pending.includes('Spot and guarantee'));
  // "Something else": the site offers no zone lock there, so no spot line, no guarantee, and nothing pending for it
  const other = rr({ spot: NEW.spot }, { trade: 'Something else' });
  assert.doesNotMatch(visible(other.html), /Your spot is open|Quote Guarantee|zone/);
  assert.ok(!rr({}, { trade: 'Something else' }).pending.includes('Spot and guarantee'));
  assert.match(T.fillProblem({ sections: {} }, 'spot', { zone: 'Smyrna' }), /open/);
});

await test('AI answer check: ChatGPT, Gemini and Google AI, who each named, screenshots only from our own site', () => {
  const ai = { question: 'Who is the best heating and air company in Smyrna, TN?', chatgpt: { named: false, top: ['Fake Air One', 'Fake Air Two'] }, gemini: { named: true }, google_ai: { named: false, top: ['Fake Air Three'] },
    screenshots: [{ engine: 'chatgpt', url: 'https://getbookedoutsolutions.com/r-img/test-chatgpt.png' }] };
  assert.equal(T.fillProblem({ sections: {} }, 'ai', ai), '');
  assert.match(T.fillProblem({ sections: {} }, 'ai', { ...ai, screenshots: [{ engine: 'chatgpt', url: 'https://evil.example/x.png' }] }), /screenshots/);
  for (const bad of ['https://getbookedoutsolutions.com//evil.example/x.png', 'https://getbookedoutsolutions.com/r-img/../../x.png', 'https://getbookedoutsolutions.com/a//b.png'])
    assert.match(T.fillProblem({ sections: {} }, 'ai', { ...ai, screenshots: [{ engine: 'chatgpt', url: bad }] }), /screenshots/, bad);
  assert.match(T.fillProblem({ sections: {} }, 'ai', { ...ai, google_ai: { note: 'x' } }), /google_ai/);
  const r = rr({ ai });
  const txt = visible(r.html).replace(/\s+/g, ' ');
  assert.match(txt, /Who ChatGPT, Gemini and Google say is best in Smyrna/);
  assert.match(txt, /ChatGPT: you were not on the list\. It named: Fake Air One, Fake Air Two\./);
  assert.match(txt, /Google AI answer: you were not on the list\. It named: Fake Air Three\./);
  assert.match(r.html, /<img src="https:\/\/getbookedoutsolutions\.com\/r-img\/test-chatgpt\.png"/);
  assert.ok(!r.pending.some((x) => x.startsWith('3 ')));
  const old = rr({ ai: { chatgpt: { named: false }, gemini: { named: true } } });
  assert.ok(old.pending.includes('3 Google AI answer'), 'an AI check without Google AI stays pending');
  assert.doesNotMatch(rr({ ai: { ...ai, screenshots: [{ engine: 'chatgpt', url: 'https://evil.example/x.png' }] } }).html, /evil\.example/);
});

await test('Full report with every new section: complete, the gentle growth line, no dashes, emojis or promises anywhere', () => {
  const r = rr(FULL, { revenue: '$500K to $1M' });
  assert.equal(r.complete, true, r.pending.join(', '));
  // section titles go through the same cleaning as every other visitor text (a long dash in the town never reaches an h2)
  const dashed = rr(FULL, { town: 'Smyrna \u2014 Rutherford' });
  for (const h of dashed.html.match(/<h2>[\s\S]*?<\/h2>/g)) assert.doesNotMatch(h, DASH, h);
  const txt = visible(r.html).replace(/\s+/g, ' ');
  assert.match(txt, /Is your growth making you money\? Some shops get busier and keep less\./);
  assert.doesNotMatch(txt, DASH); assert.doesNotMatch(txt, EMOJI);
  assert.doesNotMatch(txt, /you will rank|guaranteed? (more )?(jobs|calls|leads|revenue)|more jobs guaranteed|we promise (you )?(jobs|calls)|double your/i);
  assert.doesNotMatch(txt, /\bClaude\b|\bagents?\b|free look|free check/i);
  for (const x of ['Shops your size spend 6 to 8% of revenue to grow;', 'Start your free 30 days', 'Built from your real Google listing and a few quick checks. It is yours to keep.']) assert.ok(txt.includes(x.replace(/'/g, '&#39;')), x);
  // every estimate on the page is labeled as one and carries a source line
  const ests = (r.html.match(/<p class="est"><b>[^<]*<\/b>/g) || []).map((x) => x.replace(/<[^>]+>/g, ''));
  assert.ok(ests.length >= 2);
  for (const e of ests.filter((x) => !/Quote Guarantee/.test(x))) assert.match(e, /\(estimate\)|\(outside research, not your numbers\)/, e);
  assert.equal((r.html.match(/class="src">Source:/g) || []).length, ests.filter((x) => !/Quote Guarantee/.test(x)).length, 'every outside number has a source line');
});

await test('Pending new sections stop the checkers: a report missing any one of them cannot pass', async () => {
  for (const missing of ['speed', 'known_for', 'competitor', 'listings', 'spot']) {
    const env = { KV: kv(), STATUS_KEY: KEY, SPEED_TEST_LIVE: 'on' };
    const j = await (await T.submit(post(REAL), env, at('2026-11-17T10:30:00-06:00'))).json();
    await T.tick(env, at('2026-11-17T10:45:00-06:00'), sendFetch());
    for (const [section, data] of Object.entries(FILLS)) if (section !== missing) await call(env, '/api/free-report/fill', { id: j.id, k: KEY, section, data });
    const rec = JSON.parse(env.KV.m.get('req:' + j.id));
    assert.equal(rec.complete, false, missing);
    const rv = await (await call(env, '/api/free-report/review?k=' + KEY)).json();
    assert.equal(rv.waiting[0].needs, 'fill pending sections first', missing);
    assert.equal((await mark(env, j.id, 1, 'checker-a', 'pass', rec.hash)).status, 409, missing);
  }
  // a bad fill is refused and changes nothing
  const { env, id, rec } = await ready();
  const h = rec().hash;
  const bad = await call(env, '/api/free-report/fill', { id, k: KEY, section: 'competitor', data: { name: 'Not In Top Three' } });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /top 3/);
  assert.equal(rec().hash, h);
});

await test('Old-shape record (built by older code, stale complete + hash): check and cron re-render first; the old page can never pass or send', async () => {
  const OLD = { google: FILLS.google, reviews: FILLS.reviews, ai: { question: 'Q?', chatgpt: { named: false }, gemini: { named: true } }, booking: FILLS.booking, category: FILLS.category };
  const make = async (status, checks) => {
    const f = sendFetch();
    const env = { KV: kv(), STATUS_KEY: KEY, SPEED_TEST_LIVE: 'on', ...GMAIL, LIVE: 'on', _f: f };
    const j = await (await T.submit(post(REAL), env, at('2026-11-17T10:30:00-06:00'))).json();
    const r = JSON.parse(env.KV.m.get('req:' + j.id));
    Object.assign(r, { status, sections: OLD, complete: true, pending: [], hash: 'f'.repeat(32), checks: checks || {} });
    env.KV.m.set('req:' + j.id, JSON.stringify(r));
    env.KV.m.set('rep:' + j.id, '<html>old page</html>');
    return { env, f, id: j.id, rec: () => JSON.parse(env.KV.m.get('req:' + j.id)) };
  };
  // check(): the stale hash no longer matches what the current code renders -> 409, and the record is brought up to date
  const a = await make('built');
  const r1 = await mark(a.env, a.id, 1, 'checker-a', 'pass', 'f'.repeat(32));
  assert.equal(r1.status, 409); assert.match((await r1.json()).error, /report changed/);
  assert.equal(a.rec().complete, false); assert.notEqual(a.rec().hash, 'f'.repeat(32));
  assert.ok(a.rec().pending.includes('6 Answer speed'));
  assert.equal((await mark(a.env, a.id, 1, 'checker-a', 'pass', a.rec().hash)).status, 409, 'the fresh page still has pending sections');
  // tick(): an old "checked" record with two old pass marks is re-rendered before any send, its marks cleared, nothing sent
  const old = { agent: 'x', result: 'pass', hash: 'f'.repeat(32) };
  const b = await make('checked', { 1: { ...old, agent: 'checker-a' }, 2: { ...old, agent: 'checker-b' } });
  const log = await T.tick(b.env, at('2026-11-17T11:15:00-06:00'), b.f);
  assert.ok(log.some((x) => x.startsWith('rerendered ')), log.join());
  assert.equal(b.f.calls.length, 0, 'the old page is never sent');
  assert.equal(b.rec().status, 'built'); assert.deepEqual(b.rec().checks, {});
  assert.notEqual(b.env.KV.m.get('rep:' + b.id), '<html>old page</html>');
  // once every new section is filled and both checkers pass the new version, it sends once
  for (const [section, data] of Object.entries(FILLS)) await call(b.env, '/api/free-report/fill', { id: b.id, k: KEY, section, data });
  const h = b.rec().hash;
  await mark(b.env, b.id, 1, 'checker-a', 'pass', h);
  assert.equal((await (await mark(b.env, b.id, 2, 'checker-b', 'pass', h)).json()).sent, true);
});

await test('Three fixes always show three: fast, slow, no answer, after-hours unanswered, not tested; after-hours gets its own fix', () => {
  const strong = { google: { ...G7, review_count: 400, rank_for_keyword: 1 }, reviews: { ...FIX.reviews, owner_reply_on_newest: true }, category: { main_category: 'HVAC contractor', match: true } };
  const cases = [
    { tested: true, channel: 'call', when: 'Mon', minutes: 2 },
    { tested: true, channel: 'call', when: 'Mon', minutes: 2, after_hours: { tested: true, answered: true, when: 'Mon 8 pm', channel: 'text' } },
    { tested: true, channel: 'call', when: 'Mon', minutes: 2, after_hours: { tested: true, answered: false, when: 'Mon 8 pm', channel: 'call' } },
    { tested: true, channel: 'call', when: 'Mon', minutes: 30 },
    { tested: true, channel: 'call', when: 'Mon', minutes: null, waited_hours: 48 },
    { tested: false, reason: 'no phone listed' }, undefined];
  for (const sp of cases) for (const sec of [strong, {}, { google: { has_google_profile: false } }]) {
    const fx = T.pickFixes({ ...base, sections: { ...sec, ...(sp ? { speed: sp } : {}) } });
    assert.equal(fx.length, 3, JSON.stringify(sp) + ' -> ' + fx.join(' | '));
    assert.equal(new Set(fx).size, 3, 'no fix twice');
    const ahNo = sp && sp.after_hours && sp.after_hours.answered === false;
    assert.equal(fx.some((x) => /after-hours call reaches a person/.test(x)), !!ahNo, 'after-hours fix exactly when that call got no answer: ' + fx.join(' | '));
    if (sp && sp.minutes != null && sp.minutes <= 5) assert.ok(!fx.some((x) => /within 5 minutes/.test(x)), fx.join(' | '));
  }
});

await test('Speed gate: tested must be a real true/false; a real shop tested result is refused by the worker unless SPEED_TEST_LIVE is on', async () => {
  const sp = { channel: 'call', when: 'Mon', minutes: 3 };
  assert.match(T.fillProblem({ sections: {} }, 'speed', sp), /tested must be true or false/, 'no tested key');
  assert.match(T.fillProblem({ sections: {} }, 'speed', { ...sp, tested: 'yes' }), /tested must be true or false/);
  assert.match(T.fillProblem({ sections: {} }, 'speed', { ...sp, tested: true, channel: 'constructor' }), /channel/, 'no inherited keys as channels');
  assert.match(T.fillProblem({ sections: {} }, 'speed', { ...sp, tested: true, after_hours: { tested: true, answered: false, when: 'Mon 8 pm' } }), /after_hours needs .*channel/);
  for (const [flag, want] of [[undefined, 403], ['off', 403], ['on', 200]]) {
    const env = { KV: kv(), STATUS_KEY: KEY, ...(flag ? { SPEED_TEST_LIVE: flag } : {}) };
    const j = await (await T.submit(post(REAL), env, at('2026-11-17T10:30:00-06:00'))).json();
    await T.tick(env, at('2026-11-17T10:45:00-06:00'), sendFetch());
    const r = await call(env, '/api/free-report/fill', { id: j.id, k: KEY, section: 'speed', data: { ...sp, tested: true } });
    assert.equal(r.status, want, String(flag));
    if (want === 403) assert.equal(JSON.parse(env.KV.m.get('req:' + j.id)).sections.speed, undefined);
    // an explicit "not tested" note never contacts anyone, so it is always allowed
    assert.equal((await call(env, '/api/free-report/fill', { id: j.id, k: KEY, section: 'speed', data: { tested: false, reason: 'not before GO LIVE' } })).status, 200);
  }
  // fake TEST shops are fine without the flag (tests only)
  const env = { KV: kv(), STATUS_KEY: KEY };
  const j = await (await T.submit(post(SHOP), env, at('2026-11-17T10:30:00-06:00'))).json();
  await T.tick(env, at('2026-11-17T10:45:00-06:00'), sendFetch());
  assert.equal((await call(env, '/api/free-report/fill', { id: j.id, k: KEY, section: 'speed', data: { ...sp, tested: true } })).status, 200);
});

await test('After-hours line uses the real channel; inherited names never pass as channels or engines', () => {
  let txt = visible(rr({ speed: { ...NEW.speed, after_hours: { tested: true, answered: true, when: 'Mon 8 pm', channel: 'text' } } }).html).replace(/\s+/g, ' ');
  assert.match(txt, /We also sent one test text after hours on Mon 8 pm\. We got an answer\./);
  assert.doesNotMatch(txt, /We also called/);
  txt = visible(rr({ speed: { ...NEW.speed, after_hours: { tested: true, answered: false, when: 'Mon 8 pm', channel: 'email' } } }).html).replace(/\s+/g, ' ');
  assert.match(txt, /We also sent one test email after hours on Mon 8 pm\. We got no answer\./);
  assert.match(txt, /Our after-hours test email got no answer/);
  assert.match(T.fillProblem({ sections: {} }, 'ai', { chatgpt: { named: true }, gemini: { named: true }, google_ai: { named: true }, screenshots: [{ engine: 'constructor', url: 'https://getbookedoutsolutions.com/a.png' }] }), /screenshots/);
});

await test('trySend backstop: a report that is not complete is never sent, even with status checked and two marks', async () => {
  const f = sendFetch();
  const rec = { id: 'fr-20261117-abc123', status: 'checked', complete: false, pending: ['6 Answer speed'], test: false, email: 'owner@fakeshop-test.com', token: 'a'.repeat(48),
    checks: { 1: { agent: 'a', result: 'pass', hash: 'h' }, 2: { agent: 'b', result: 'pass', hash: 'h' } }, hash: 'h' };
  const r = await T.trySend({ KV: kv(), LIVE: 'on', ...GMAIL }, rec, new Date(), f);
  assert.equal(r.changed, false); assert.equal(f.calls.length, 0); assert.equal(rec.status, 'checked');
});

await test('Re-render pages through every open record (KV list cursor)', async () => {
  const env = { KV: kv(), STATUS_KEY: KEY };
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const j = await (await T.submit(post({ ...SHOP, email: `test${i}@example.com` }), env, at('2026-11-17T10:30:00-06:00'))).json();
    ids.push(j.id);
  }
  await T.tick(env, at('2026-11-17T10:45:00-06:00'), sendFetch());
  for (const id of ids) { const r = JSON.parse(env.KV.m.get('req:' + id)); r.hash = 'e'.repeat(32); env.KV.m.set('req:' + id, JSON.stringify(r)); }
  // a KV that hands out 2 keys per page
  const list = env.KV.list.bind(env.KV);
  env.KV.list = async ({ prefix, cursor }) => { const all = (await list({ prefix })).keys; const at0 = +(cursor || 0); const keys = all.slice(at0, at0 + 2);
    return at0 + 2 < all.length ? { keys, list_complete: false, cursor: String(at0 + 2) } : { keys, list_complete: true }; };
  const j = await (await call(env, '/api/free-report/rerender', { k: KEY })).json();
  assert.equal(j.checked, 5); assert.equal(j.changed, 5);
});

await test('Fix picker: the fix that matches his speed result keeps a place even when three other fixes come first', () => {
  const weak = { google: { ...G7, review_count: 4, rank_for_keyword: 2, top3: [{ name: 'Fake Air One', rating: 4.8, review_count: 300 }] },
    reviews: { ...FIX.reviews, owner_reply_on_newest: false }, category: { main_category: 'Plumber', big_job: 'new systems', match: false } };
  const ah = (answered, channel = 'call') => ({ tested: true, answered, when: 'Mon 8 pm', channel });
  // fast day answer, after-hours test unanswered -> the after-hours fix replaces the last other fix
  let fx = T.pickFixes({ ...base, sections: { ...weak, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 3, after_hours: ah(false) } } });
  assert.equal(fx.length, 3);
  assert.match(fx[0], /Google review the day/); assert.match(fx[1], /Reply to your newest Google review/);
  assert.equal(fx[2], 'Make sure every after-hours call reaches a person or gets a call back first thing the next morning.');
  // no answer -> "never followed up" -> the 5-minute fix is in
  fx = T.pickFixes({ ...base, sections: { ...weak, speed: { tested: true, channel: 'call', when: 'Mon', minutes: null, waited_hours: 48 } } });
  assert.equal(fx.length, 3); assert.equal(fx[2], 'Call or text back every new lead within 5 minutes, even after hours.');
  // slow answer -> the 5-minute fix is in
  fx = T.pickFixes({ ...base, sections: { ...weak, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 90 } } });
  assert.ok(fx.includes('Call or text back every new lead within 5 minutes, even after hours.'), fx.join(' | '));
  // no profile + reply gap + booking + unanswered after-hours (by text)
  const np = { google: { has_google_profile: false }, reviews: { ...FIX.reviews, owner_reply_on_newest: false }, booking: { score: 4, fixes: ['Cut the quote form to 4 fields.'] } };
  fx = T.pickFixes({ ...base, sections: { ...np, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 2, after_hours: ah(false, 'text') } } });
  assert.equal(fx.length, 3);
  assert.match(fx[0], /^Set up your free Google Business Profile/);
  assert.equal(fx[2], 'Make sure every after-hours text reaches a person or gets an answer first thing the next morning.');
  // email channel wording too
  fx = T.pickFixes({ ...base, sections: { speed: { tested: true, channel: 'call', when: 'Mon', minutes: 2, after_hours: ah(false, 'email') } } });
  assert.ok(fx.includes('Make sure every after-hours email reaches a person or gets an answer first thing the next morning.'), fx.join(' | '));
  // no answer AND after-hours unanswered: both speed fixes are kept, the one the diagnosis names first
  fx = T.pickFixes({ ...base, sections: { ...weak, speed: { tested: true, channel: 'call', when: 'Mon', minutes: null, waited_hours: 48, after_hours: ah(false) } } });
  assert.equal(fx.length, 3); assert.match(fx[0], /Google review the day/);
  assert.equal(fx[1], 'Call or text back every new lead within 5 minutes, even after hours.');
  assert.equal(fx[2], 'Make sure every after-hours call reaches a person or gets a call back first thing the next morning.');
  fx = T.pickFixes({ ...base, sections: { speed: { tested: true, channel: 'call', when: 'Mon', minutes: null, waited_hours: 48, after_hours: ah(false) } } });
  assert.ok(fx.some((x) => /within 5 minutes/.test(x)) && fx.some((x) => /after-hours call/.test(x)), fx.join(' | '));
  // the diagnosis and the reserved fix agree for the weak shop
  assert.match(T.diagnose({ ...base, sections: { ...weak, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 3, after_hours: ah(false) } } }).line, /after-hours test call got no answer/);
});

await test('Fix picker: the booking fix is never a duplicate and is dropped for a fast answerer when it is the 5-minute fix', () => {
  const sp = { tested: true, channel: 'call', when: 'Mon', minutes: 2 };
  let fx = T.pickFixes({ ...base, sections: { booking: { score: 5, fixes: ['Call or text back every new lead within 5 minutes, even after hours.'] }, speed: sp } });
  assert.ok(!fx.some((x) => /within 5 minutes/.test(x)), fx.join(' | ')); assert.equal(fx.length, 3);
  fx = T.pickFixes({ ...base, sections: { booking: { score: 5, fixes: ['put your phone number and a clear "get a quote" button at the top of every page of your website'] } } });
  assert.equal(fx.length, 3);
  assert.equal(fx.filter((x) => /get a quote/i.test(x)).length, 1, 'same fix in other words-case is not listed twice: ' + fx.join(' | '));
  fx = T.pickFixes({ ...base, sections: { booking: { score: 5, fixes: ['Call or text back every new lead within 5 minutes, even after hours.'] }, speed: { ...sp, minutes: 40 } } });
  assert.equal(fx.filter((x) => /within 5 minutes/.test(x)).length, 1, fx.join(' | '));
});

await test('A fast answer with an unanswered after-hours test never says "Keep it up, after hours too"', () => {
  const sp = { tested: true, channel: 'call', when: 'Mon', minutes: 2 };
  assert.match(T.speedEstimate(sp).text, /Keep it up, after hours too\./);
  assert.doesNotMatch(T.speedEstimate({ ...sp, after_hours: { tested: true, answered: false, when: 'Mon 8 pm', channel: 'call' } }).text, /after hours too/);
  assert.match(T.speedEstimate({ ...sp, after_hours: { tested: true, answered: true, when: 'Mon 8 pm', channel: 'call' } }).text, /after hours too/);
});

await test('Cron re-render writes nothing when the page did not change (no KV writes every 15 minutes)', async () => {
  const f = sendFetch();
  const { env, id, rec } = await ready({ ...GMAIL, _f: f });
  const h = rec().hash;
  await mark(env, id, 1, 'checker-a', 'pass', h); await mark(env, id, 2, 'checker-b', 'pass', h);
  assert.equal(rec().status, 'checked');
  const puts = [];
  const put = env.KV.put.bind(env.KV);
  env.KV.put = async (k, v, o) => { puts.push(k); return put(k, v, o); };
  for (let i = 0; i < 4; i++) await T.tick(env, at(`2026-11-17T11:${15 + i * 10}:00-06:00`), f);
  assert.ok(!puts.some((k) => k.startsWith('rep:') || k.startsWith('tok:')), 'no page rewrite: ' + puts.join(','));
  assert.equal(rec().status, 'checked'); assert.equal(rec().hash, h);
  assert.equal(await T.refreshReport(env, rec()), false);
});

await test('Fourth review regressions: reserved fix wins over a duplicate, every "5 minutes" wording is filtered, picker follows the diagnosis', () => {
  const weak = { google: { ...G7, review_count: 4, rank_for_keyword: 2, top3: [{ name: 'Fake Air One', rating: 4.8, review_count: 300 }] },
    reviews: { ...FIX.reviews, owner_reply_on_newest: false }, category: { main_category: 'Plumber', big_job: 'new systems', match: false } };
  const ah = (answered, channel = 'call') => ({ tested: true, answered, when: 'Mon 8 pm', channel });
  const SPEED = 'Call or text back every new lead within 5 minutes, even after hours.';
  const AH = 'Make sure every after-hours call reaches a person or gets a call back first thing the next morning.';
  // 1. the booking fix has the same words as the reserved fix: the reserved one still shows, once
  let fx = T.pickFixes({ ...base, sections: { ...weak, booking: { score: 4, fixes: [SPEED] }, speed: { tested: true, channel: 'call', when: 'Mon', minutes: null, waited_hours: 48 } } });
  assert.equal(fx.length, 3); assert.equal(fx.filter((x) => x === SPEED).length, 1, fx.join(' | '));
  fx = T.pickFixes({ ...base, sections: { booking: { score: 4, fixes: [AH] }, reviews: weak.reviews, category: weak.category, google: weak.google,
    speed: { tested: true, channel: 'call', when: 'Mon', minutes: 3, after_hours: ah(false) } } });
  assert.equal(fx.length, 3); assert.equal(fx.filter((x) => x === AH).length, 1, fx.join(' | '));
  // 2. every way of writing "5 minutes" is filtered for a shop that answered within 5 minutes: picker, booking list, follow-ups
  const fiveWays = ['Answer every new call in under 5 minutes.', 'Reply to every lead within five minutes.', 'Set a 5-minute callback rule for the office.', 'Call back in 5 mins.', 'Put your phone number at the top.'];
  const fastSp = { tested: true, channel: 'call', when: 'Mon', minutes: 2 };
  for (const x of fiveWays.slice(0, 4)) assert.ok(T.FIVE_MIN_TEST(x), x);
  fx = T.pickFixes({ ...base, sections: { booking: { score: 5, fixes: fiveWays }, speed: fastSp } });
  assert.ok(!fx.some((x) => T.FIVE_MIN_TEST(x)), fx.join(' | ')); assert.equal(fx.length, 3);
  const page = visible(rr({ booking: { score: 5, fixes: fiveWays.slice(0, 2).concat(fiveWays[4]) }, speed: fastSp }).html).replace(/\s+/g, ' ');
  assert.match(page, /5 out of 10 One fix: Put your phone number at the top\./);
  assert.doesNotMatch(page.split('Booking test from a phone')[1].split('Your Google main category')[0], /under 5 minutes|five minutes/);
  const slowPage = visible(rr({ booking: { score: 5, fixes: fiveWays.slice(0, 2) }, speed: { ...fastSp, minutes: 40 } }).html);
  assert.doesNotMatch(slowPage, /under 5 minutes|five minutes/, 'only the one standard 5-minute sentence is ever shown, to any shop');
  // 3. a 6 to 60 minute answer with an unanswered after-hours test: the diagnosis talks about after hours, so the picker keeps the after-hours fix
  const sp3 = { tested: true, channel: 'call', when: 'Mon', minutes: 30, after_hours: ah(false) };
  assert.match(T.diagnose({ ...base, sections: { ...weak, speed: sp3 } }).line, /after-hours test call got no answer/);
  assert.equal(T.speedFinding(sp3).fix, 'after hours');
  fx = T.pickFixes({ ...base, sections: { ...weak, speed: sp3 } });
  assert.equal(fx.length, 3); assert.equal(fx[1], AH, fx.join(' | ')); assert.equal(fx[2], SPEED, 'a slow answerer still gets the one 5-minute fix');
  // the picker and the diagnosis agree in every speed case for a top 3 shop
  for (const sp of [{ ...fastSp, minutes: null, waited_hours: 24 }, { ...fastSp, minutes: 90 }, { ...fastSp, minutes: 30 }, sp3, { ...fastSp, after_hours: ah(false, 'text') }, fastSp]) {
    const f = T.speedFinding(sp), d = T.diagnose({ ...base, sections: { ...weak, speed: sp } }), p3 = T.pickFixes({ ...base, sections: { ...weak, speed: sp } });
    if (!f) { assert.equal(d.kind, 'chosen'); continue; }
    const want = f.fix === 'after hours' ? T.pickFixes({ ...base, sections: { speed: sp } }).find((x) => /after-hours/.test(x)) : SPEED;
    assert.ok(p3.includes(want), JSON.stringify(sp) + ' -> ' + p3.join(' | '));
    assert.equal(p3.filter((x) => T.FIVE_MIN_TEST(x)).length, sp.minutes == null || sp.minutes > 5 ? 1 : 0, 'one 5-minute fix for a slow answerer, none for a fast one');
    assert.equal(/after-hours/.test(d.line), f.fix === 'after hours', d.line);
  }
});

await test('Five-minute test: any hyphen or dash, "five (5) minutes", "5 or fewer minutes"; the kept 5-minute fix is never said twice', () => {
  const yes = ['Use a 5‑minute callback rule.', 'Use a 5–minute callback rule.', 'Use a 5—minute callback rule.', 'Reply within five (5) minutes.',
    'Answer in 5 or fewer minutes.', 'Answer in 5 or less minutes.', 'Call back in 5 mins.', 'Under 5 min, every time.', 'Within FIVE MINUTES.', 'A 5-minute rule.'];
  const no = ['Answer within 15 minutes.', 'Five stars on Google.', 'Post 5 photos a month.', 'Reply in 25 minutes.', 'A 5 star review.', ''];
  for (const x of yes) assert.equal(T.FIVE_MIN_TEST(x), true, x);
  for (const x of no) assert.equal(T.FIVE_MIN_TEST(x), false, x);
  const fastSp = { tested: true, channel: 'call', when: 'Mon', minutes: 2 };
  // fast answerer: every one of these is filtered in the picker and the booking list
  let fx = T.pickFixes({ ...base, sections: { booking: { score: 5, fixes: [yes[0]] }, speed: fastSp } });
  assert.ok(!fx.some((x) => T.FIVE_MIN_TEST(x)), fx.join(' | ')); assert.equal(fx.length, 3);
  const page = visible(rr({ booking: { score: 5, fixes: [yes[0], yes[1], yes[3], 'Put your phone number at the top.'] }, speed: fastSp }).html).replace(/\s+/g, ' ');
  assert.match(page, /5 out of 10 One fix: Put your phone number at the top\./);
  // slow answerer: the kept 5-minute fix shows once, and a booking fix saying the same thing in other words is dropped
  fx = T.pickFixes({ ...base, sections: { booking: { score: 5, fixes: ['Reply to every lead within five (5) minutes.'] }, speed: { ...fastSp, minutes: null, waited_hours: 48 } } });
  assert.equal(fx.length, 3);
  assert.deepEqual(fx.filter((x) => T.FIVE_MIN_TEST(x)), ['Call or text back every new lead within 5 minutes, even after hours.'], fx.join(' | '));
});

await test('Sixth review: at most one 5-minute fix ever; decimals are not five minutes; a dash inside a word stays a hyphen', () => {
  const ah = { tested: true, answered: false, when: 'Mon 8 pm', channel: 'call' };
  // slow answerer (6 to 60 minutes) with the after-hours test unanswered and a booking fix saying "within 5 minutes"
  for (const m of [6, 20, 60]) for (const bf of ['Answer every quote request within 5–minutes.', 'Text back in five (5) minutes or less.', 'Call or text back every new lead within 5 minutes, even after hours.']) {
    const fx = T.pickFixes({ ...base, sections: { booking: { score: 3, fixes: [bf, 'Put a quote button on top.'] }, speed: { tested: true, channel: 'call', when: 'Mon', minutes: m, after_hours: ah } } });
    assert.equal(fx.length, 3, fx.join(' | '));
    assert.ok(fx.filter((x) => T.FIVE_MIN_TEST(x)).length <= 1, m + ' ' + bf + ' -> ' + fx.join(' | '));
    assert.ok(fx.some((x) => /after-hours call reaches a person/.test(x)), 'the kept after-hours fix: ' + fx.join(' | '));
    for (const x of fx) if (T.FIVE_MIN_TEST(x)) assert.equal(x, 'Call or text back every new lead within 5 minutes, even after hours.', 'the only 5-minute wording');
  }
  // no speed test at all: a booking 5-minute fix in other words is replaced by nothing; the one wording comes from the base list
  const fx2 = T.pickFixes({ ...base, sections: { booking: { score: 3, fixes: ['Reply in 5min.'] } } });
  assert.ok(fx2.filter((x) => T.FIVE_MIN_TEST(x)).length <= 1); assert.ok(!fx2.includes('Reply in 5min.'), fx2.join(' | '));
  // decimals
  for (const x of ['1.5 minutes', '0.5 min', '2.5-minute', 'about 3.5 minutes']) assert.equal(T.FIVE_MIN_TEST(x), false, x);
  for (const x of ['5 minutes', 'under 5 minutes.']) assert.equal(T.FIVE_MIN_TEST(x), true, x);
  assert.equal(T.FIVE_MIN_TEST('Step 5. Minutes later, call back'), false, 'a 5 that ends a sentence is not five minutes');
  // dashes
  assert.equal(T.plain('within 5–minutes'), 'within 5-minutes');
  assert.equal(T.plain('a 5‑minute rule'), 'a 5-minute rule');
  assert.equal(T.plain('fast — and fair'), 'fast, and fair');
  assert.equal(T.plain('Great work—fast'), 'Great work-fast');
  const page = visible(rr({ booking: { score: 4, fixes: ['Use a call\u2013back list.', 'Answer within 5\u2013minutes.'] }, speed: { tested: true, channel: 'call', when: 'Mon', minutes: 40 } }).html);
  assert.match(page, /Use a call-back list\./); assert.doesNotMatch(page, DASH);
  assert.doesNotMatch(page, /Answer within 5-minutes/, 'a non-standard 5-minute wording is dropped for every shop');
});

await test('Seventh review: other 5-minute wordings dropped for every shop; ranges, Unicode digits; plain() trims; no raw HTML in follow-ups', async () => {
  const slow = { tested: true, channel: 'call', when: 'Mon', minutes: 30 };
  const SF = 'Call or text back every new lead within 5 minutes, even after hours.';
  for (const x of ['Answer within five minutes.', 'ANSWER EVERY CALL WITHIN 5 MINUTES!!!']) {
    const page = visible(rr({ booking: { score: 4, fixes: [x, 'Shorten the form.'] }, speed: slow }).html).replace(/\s+/g, ' ');
    const s4 = page.split('Booking test from a phone')[1].split('Your Google main category')[0];
    assert.doesNotMatch(s4, /five minutes|5 MINUTES/i, x); assert.match(s4, /One fix: Shorten the form\./);
    assert.equal(FU.values({ ...base, sections: { booking: { score: 4, fixes: [x] }, speed: slow } }, { ...T.fuHelpers(), now: new Date() }).booking_fix_1, undefined, x);
  }
  assert.equal(FU.values({ ...base, sections: { booking: { score: 4, fixes: [SF] }, speed: slow } }, { ...T.fuHelpers(), now: new Date() }).booking_fix_1, undefined, 'the speed sentence only comes from the speed logic');
  // a dropped first booking fix: the picker, the page and the follow-ups all use the next one ("Shorten the form.")
  const two = { ...base, sections: { booking: { score: 4, fixes: ['Answer within five minutes.', 'Shorten the form.'] }, speed: slow } };
  assert.ok(T.pickFixes(two).includes('Shorten the form.'), T.pickFixes(two).join(' | '));
  assert.equal(FU.values(two, { ...T.fuHelpers(), now: new Date() }).booking_fix_1, 'Shorten the form.');
  for (const x of ['Respond within 3-5 minutes', 'Respond within 3–5 minutes', 'Reply in 1-5 min', 'Answer within ٥ minutes.', 'Answer within ５ minutes.', '5 MINUTES!!!'])
    assert.equal(T.FIVE_MIN_TEST(x), true, x);
  for (const x of ['1.5 minutes', '2,5 minutes', '0.5 min', '15 minutes', 'Answer within ١٥ minutes.'])
    assert.equal(T.FIVE_MIN_TEST(x), false, x);
  assert.equal(T.plain('— Shorten the form —'), 'Shorten the form');
  assert.equal(T.plain(', , Shorten the form ,'), 'Shorten the form');
  assert.ok(FU.bodyProblems('Hi,\n<img src=x> Add a <b>Book now</b> button\nWant it?', 'https://getbookedoutsolutions.com/r/x/').includes('angle bracket (raw HTML)'));
});

await test('Eighth review: booking fixes about any time unit never show; one filtered list for section 4, the three fixes and the follow-ups', () => {
  const SF = FU.SPEED_FIX;
  const slow = { tested: true, channel: 'call', when: 'Mon', minutes: 30 }, fast = { tested: true, channel: 'text', when: 'Mon', minutes: 2 }, none = { tested: true, channel: 'call', when: 'Mon', minutes: null, waited_hours: 24 };
  const dropped = ['Answer within five-ish minutes.', 'Answer in 5 or so minutes', 'Within 5 to 10 minutes, call back.', 'Reply within twenty-five minutes.', SF, SF.toUpperCase(), SF.replace(/\.$/, ''),
    'Add a 2-minute form.', 'Call back within the hour.', 'Reply in 30 secs.', 'Answer in 2 hrs.', 'Reply in 5​minutes.', 'Reply in 5 mіnutes (Cyrillic i).', '​', '﻿⁠', '   ', '— , —', null];
  for (const x of dropped) assert.equal(T.bookingList([x], T.plain).length, 0, JSON.stringify(x));
  for (const x of ['Shorten the form.', 'Add a Book now button.', 'Put the minimum fields on the form.', 'Make the admin page simpler.']) assert.deepEqual(T.bookingList([x], T.plain), [x], x);
  assert.deepEqual(T.bookingList(['Shorten the form', 'Shorten the form.', 'SHORTEN THE FORM. '], T.plain), ['Shorten the form'], 'no repeats');
  for (const sp of [slow, fast, none, { ...slow, after_hours: { tested: true, answered: false, when: 'Mon 8 pm', channel: 'call' } }]) {
    for (const fixes of [['Answer within five-ish minutes.', '  ', 'Shorten the form.'], ['​', 'Add a Book now button.'], [SF, 'Shorten the form.'], ['Shorten the form.', SF], [SF.toUpperCase()]]) {
      const rec = { ...base, sections: { booking: { score: 4, fixes }, speed: sp } };
      const list = T.bookingList(fixes, T.plain);
      const page = visible(T.renderReport(rec).html).replace(/\s+/g, ' ');
      const s4 = page.split('Booking test from a phone')[1].split('Your Google main category')[0];
      for (const x of list) assert.ok(s4.includes(x), x + ' in section 4');
      assert.doesNotMatch(s4, /minute|even after hours/i, 'no time talk in the booking list: ' + s4);
      const three = T.pickFixes(rec);
      assert.equal(three.length, 3); assert.equal(new Set(three.map((x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())).size, 3);
      if (list[0]) assert.ok(three.includes(list[0]), 'the three fixes use the first booking fix: ' + three.join(' | '));
      const fiveFixes = three.filter((x) => T.FIVE_MIN_TEST(x));
      assert.deepEqual(fiveFixes, sp.minutes == null || sp.minutes > 5 ? [SF] : [], 'speed sentence only from the speed logic');
      const v = FU.values(rec, { ...T.fuHelpers(), now: new Date() });
      assert.equal(v.booking_fix_1, list[0], 'booking_fix_1 = the first item of the same list');
    }
  }
  // plain() removes invisible characters; a fix that is blank after that is dropped everywhere
  assert.equal(T.plain('Short​en the­ form﻿'), 'Shorten the form');
  assert.ok(FU.bodyProblems('Hi,\nThe first of its three fixes is "".\nWant it?', 'https://x/').includes('blank fix line'));
  assert.ok(FU.bodyProblems('Hi,\n.\nWant it?', 'https://x/').includes('blank fix line'));
  // FIVE_MIN_TEST for the diagnosis / fast checks
  for (const [x, want] of [['within 5​minutes', true], ['5­minutes', true], ['within 5 mіnutes', true], ['five-ish minutes', true], ['within 5 or so minutes', true], ['5 to 10 minutes', true],
    ['within 5ish minutes', true], ['॰५ minutes', true], ['fifteen minutes', false], ['twenty-five minutes', false], ['twenty five minutes', false], ['5 m', false], ['10-15 minutes', false],
    ['१५ minutes', false], ['within ٥ мinutes', false], ['5. Minutes later', false]])
    assert.equal(T.FIVE_MIN_TEST(x), want, JSON.stringify(x));
});

await test('E2E mirror of fr-20261120-vbukvz: fill all, checker 1 + checker 2 pass; LIVE off sends nothing; LIVE on sends once; TEST never', async () => {
  // the exact fake data used on the live worker Nov 20 (plus the new sections)
  const E2E = { google: { has_google_profile: true, rating: 4.3, review_count: 27, rank_for_keyword: 9, keyword: 'hvac Smyrna',
      top3: [{ name: 'Fake Air One (TEST)', rating: 4.8, review_count: 240 }, { name: 'Fake Air Two (TEST)', rating: 4.7, review_count: 160 }, { name: 'Fake Air Three (TEST)', rating: 4.9, review_count: 101 }] },
    reviews: { newest_review: { rating: 5, text: 'test review: quick and fair, fixed our furnace the same day', date: 'Nov 12 2026' }, owner_reply_on_newest: false },
    ai: { question: 'Who is the best heating and air company in Smyrna, TN?', chatgpt: { named: false }, gemini: { named: true }, google_ai: { named: false } },
    booking: { score: 6, fixes: ['Put your phone number at the top of the home page.', 'Make the Get a quote button bigger on a phone.', 'Cut the quote form to 4 fields.'] },
    category: { main_category: 'HVAC contractor', big_job: 'new system installs', match: true },
    ...NEW, competitor: { name: 'Fake Air One (TEST)', theirs: { photos: 80 }, yours: { photos: 12 } } };
  for (const [shop, live, want] of [[{ ...SHOP, business_name: 'E2E Heating (FAKE)', email: 'e2e-nov20@example.com' }, 'on', 0], [REAL, 'off', 0], [REAL, 'on', 2]]) {
    const f = sendFetch();
    const env = { KV: kv(), STATUS_KEY: KEY, SPEED_TEST_LIVE: 'on', ...GMAIL, LIVE: live, _f: f };
    const j = await (await T.submit(post(shop), env, at('2026-11-20T14:38:00-06:00'))).json();
    await T.tick(env, at('2026-11-20T14:45:00-06:00'), f);
    for (const [section, data] of Object.entries(E2E)) assert.equal((await call(env, '/api/free-report/fill', { id: j.id, k: KEY, section, data })).status, 200, section);
    const rec = () => JSON.parse(env.KV.m.get('req:' + j.id));
    assert.equal(rec().complete, true, rec().pending.join(', '));
    const page = visible(env.KV.m.get('rep:' + j.id)).replace(/\s+/g, ' ');
    assert.match(page, /Found but not chosen\. You show at number 9 for &quot;hvac Smyrna&quot;, below the top 3, and they average 167 reviews to your 27\./);
    const rv = (await (await call(env, '/api/free-report/review?k=' + KEY)).json()).waiting[0];
    assert.equal(rv.needs, 'checker 1');
    assert.equal((await mark(env, j.id, 1, 'checker-1-e2e', 'pass', rv.hash)).status, 200);
    const r2 = await (await mark(env, j.id, 2, 'checker-2-e2e', 'pass', rv.hash)).json();
    assert.equal(r2.status, want ? 'sent' : 'checked');
    await T.tick(env, at('2026-11-20T15:00:00-06:00'), f);
    assert.equal(f.calls.length, want, `${shop.email} LIVE=${live}`);
    if (live === 'off') assert.match(T.sendBlock(env, rec()), /LIVE is off/);
    if (shop.email.endsWith('@example.com')) assert.match(T.sendBlock(env, rec()), /TEST/);
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
