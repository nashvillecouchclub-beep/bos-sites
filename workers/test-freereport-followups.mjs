// Tests for the free report follow-ups. Run: node workers/test-freereport-followups.mjs
// No network: mock KV, mock fetch, fixed clock, fake shops only.
import W0 from './bookedout-freereport.js';
import * as FU from './freereport-followups.js';
import assert from 'node:assert/strict';
// BUNDLE=1 runs the same tests against the one-file dashboard bundle (node workers/build-freereport-bundle.mjs first).
const W = process.env.BUNDLE ? (await import('./dist/bookedout-freereport.bundle.js')).default : W0;

const T = W._t;
let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e).toString().split('\n').slice(0, 3).join('\n     ')); }
}
function kv() {
  const m = new Map();
  return { m, async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, String(v)); }, async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; } };
}
const KEY = 'k'.repeat(32);
const at = (s) => new Date(s);
const SHOP = { first_name: 'Testy', business_name: 'Test Shop Heating and Air', email: 'owner@fakeshop-test.com', phone: '615 555 0123',
  town: 'Smyrna TN', trade: 'Heating and air', revenue: '$500K to $1M', consent: false, elapsed_ms: 5000, page: '/hvac-free-look.html' };
const FILLS = {
  google: { has_google_profile: true, rating: 4.4, review_count: 61, rank_for_keyword: 7, keyword: 'hvac Smyrna',
    top3: [{ name: 'Fake Air One', rating: 4.8, review_count: 310 }, { name: 'Fake Air Two', rating: 4.7, review_count: 190 }, { name: 'Fake Air Three', rating: 4.9, review_count: 140 }] },
  reviews: { newest_review: { rating: 5, text: 'Great work', date: 'Nov 10 2026' }, owner_reply_on_newest: false },
  ai: { question: 'Who is the best heating and air company in Smyrna?', chatgpt: { named: false }, gemini: { named: false } },
  booking: { score: 6, fixes: ['Put your phone number as a tap-to-call button at the top of the home page.', 'Make the quote button bigger.'] },
  category: { main_category: 'HVAC contractor', big_job: 'new systems', match: true },
};
const GMAIL = { SEND_ROUTE: 'gmail', GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'sec', GMAIL_REFRESH_TOKEN: 'ref' };
// Fake Google: token, send (returns a thread id), thread read (ours only, or with a reply, or refused).
function gfetch(o = {}) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (url === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') return new Response(JSON.stringify({ id: 'gm-' + calls.length, threadId: 'abc123def' }), { status: 200 });
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads/')) {
      if (o.threadStatus) return new Response('{}', { status: o.threadStatus });
      const msgs = [{ labelIds: ['SENT'], payload: { headers: [{ name: 'From', value: 'Rickey Hallor <rickey@getbookedoutsolutions.com>' }, { name: 'Message-ID', value: '<first@mail.gmail.com>' }] } }];
      if (o.reply) msgs.push({ labelIds: ['INBOX'], payload: { headers: [{ name: 'From', value: 'Testy <owner@fakeshop-test.com>' }, { name: 'Message-ID', value: '<r@x>' }] } });
      return new Response(JSON.stringify({ messages: msgs }), { status: 200 });
    }
    return new Response('ok', { status: 200 });
  };
  f.calls = calls; return f;
}
const call = (env, path, body) => W.fetch(new Request('https://x' + path, body ? { method: 'POST', body: JSON.stringify(body) } : {}), env, {});
const post = (b) => new Request('https://x/api/free-report', { method: 'POST', body: JSON.stringify(b) });
// A report sent Tue Nov 17 2026 at 11:00 am Central, through the real flow.
async function sent(extra = {}, shop = SHOP, fills = FILLS) {
  const f = gfetch();
  const env = { KV: kv(), STATUS_KEY: KEY, LIVE: 'on', ...GMAIL, ...extra };
  const j = await (await T.submit(post(shop), env, at('2026-11-17T10:30:00-06:00'))).json();
  await T.tick(env, at('2026-11-17T10:45:00-06:00'), f);
  for (const [section, data] of Object.entries(fills)) await call(env, '/api/free-report/fill', { id: j.id, k: KEY, section, data });
  const rec = () => JSON.parse(env.KV.m.get('req:' + j.id));
  const h = rec().hash;
  const mark = (c, a) => T.check(new Request('https://x/', { method: 'POST', body: JSON.stringify({ id: j.id, k: KEY, checker: c, agent: a, result: 'pass', hash: h }) }), env, at('2026-11-17T11:00:00-06:00'), f);
  await mark(1, 'checker-a'); await mark(2, 'checker-b');
  return { env, id: j.id, rec, f };
}
const sends = (f) => f.calls.filter((c) => c.url.endsWith('/messages/send'));
const decode = (c) => { const raw = JSON.parse(c.init.body).raw.replace(/-/g, '+').replace(/_/g, '/'); const top = Buffer.from(raw, 'base64').toString(); const [hd, body] = top.split('\r\n\r\n'); return { hd, text: Buffer.from(body, 'base64').toString(), threadId: JSON.parse(c.init.body).threadId }; };

await test('The locked sequence lints clean: every body, one question on the last line, no $, dashes, links, banned words', () => {
  const S = FU.FU_SEQ; const all = [];
  const walk = (n) => { if (n.body) all.push(n.body); if (n.fallback && typeof n.fallback === 'object') walk(n.fallback); };
  [...S.cold, ...S.warm, ...S.ladder, S.rerun].forEach(walk);
  assert.ok(all.length >= 25);
  for (const b of all) {
    const filled = b.replace(/\{report_link\}/g, 'https://getbookedoutsolutions.com/r/x/').replace(/\{[a-z_0-9]+\}/g, 'X');
    assert.deepEqual(FU.bodyProblems(filled, 'https://getbookedoutsolutions.com/r/x/'), [], b.slice(0, 60));
  }
  assert.deepEqual(S.cold.map((s) => s.day), [1, 3, 7, 12, 18]); assert.deepEqual(S.warm.map((s) => s.day), [2, 7, 12]);
  assert.ok(S.holidays_slide_next_business_day.includes('2026-11-26') && S.holidays_slide_next_business_day.includes('2026-12-25'));
});

await test('Sending the report starts the sequence with its thread; a TEST shop never gets one', async () => {
  const { env, id, rec } = await sent();
  assert.equal(rec().status, 'sent'); assert.equal(rec().fu.thread, 'abc123def'); assert.equal(rec().fu.hour, 11);
  assert.ok(env.KV.m.has('fu:' + id));
  const t = await sent({}, { ...SHOP, email: 'test@example.com', business_name: 'X (FAKE)' });
  assert.equal(t.rec().fu, undefined);
});

await test('Cold plan dates: business days 1, 3, 7, 12, 18; Thanksgiving (Nov 26) is skipped', async () => {
  const { env, id } = await sent();
  const r = await (await call(env, '/api/free-report/followup', { id, k: KEY, action: 'status' })).json();
  assert.deepEqual(r.plan.map((p) => p.step + ' ' + p.due), ['c1 2026-11-18', 'c2 2026-11-20', 'c3 2026-11-27', 'c4 2026-12-04', 'c5 2026-12-14']);
});

await test('FOLLOWUPS off (the default): nothing sent, the step holds', async () => {
  const { env, id, rec, f } = await sent();
  const n0 = sends(f).length;
  await T.fuTick(env, at('2026-11-18T12:00:00-06:00'), f);
  assert.equal(sends(f).length, n0); assert.equal(rec().fu.hold, 'FOLLOWUPS is off');
  assert.ok(!f.calls.some((c) => c.url.includes('/threads/')), 'no thread read while off');
});

await test('FOLLOWUPS on: day 1 goes once, in the same thread, after the send hour, with In-Reply-To and the true footer', async () => {
  const { env, id, rec, f } = await sent({ FOLLOWUPS: 'on' });
  const n0 = sends(f).length;
  await T.fuTick(env, at('2026-11-18T09:00:00-06:00'), f); assert.equal(sends(f).length, n0, 'before 11 am: waits');
  await T.fuTick(env, at('2026-11-18T11:15:00-06:00'), f); assert.equal(sends(f).length, n0 + 1);
  await T.fuTick(env, at('2026-11-18T15:00:00-06:00'), f); assert.equal(sends(f).length, n0 + 1, 'never two the same day');
  const m = decode(sends(f).at(-1));
  assert.equal(m.threadId, 'abc123def'); assert.match(m.hd, /In-Reply-To: <first@mail\.gmail\.com>/); assert.match(m.hd, /Subject: Re: Your free report for Test Shop Heating and Air/);
  assert.match(m.text, /average 213 reviews\. Test Shop Heating and Air has 61\. That's a gap of 152\./);
  assert.match(m.text, /"HVAC Smyrna"/, 'the exact search the report ran');
  assert.match(m.text, /asked for a free report on our website\.\nReply "stop"/); assert.match(m.text, /P\.O\. Box 1166, Smyrna, TN 37167/);
  assert.equal(rec().fu.done.c1.status, 'sent'); assert.deepEqual(rec().fu.facts.sort(), ['review_count', 'review_gap', 'top3_avg']);
});

await test('A reply (or bounce) in the thread stops the sequence forever; nothing more is sent', async () => {
  const { env, id, rec } = await sent({ FOLLOWUPS: 'on' });
  const f = gfetch({ reply: true });
  await T.fuTick(env, at('2026-11-18T11:15:00-06:00'), f);
  assert.equal(sends(f).length, 0); assert.match(rec().fu.stopped.why, /reply/);
  assert.ok(!env.KV.m.has('fu:' + id)); assert.ok(env.KV.m.has('stop:owner@fakeshop-test.com'));
  await T.fuTick(env, at('2026-11-20T11:15:00-06:00'), gfetch()); assert.equal(rec().fu.done.c2, undefined);
});

await test('No thread read (token has send scope only): holds with a watch entry; a fresh inbox "clear" lets it go; an old one does not', async () => {
  const { env, id, rec } = await sent({ FOLLOWUPS: 'on' });
  const f = gfetch({ threadStatus: 403 });
  await T.fuTick(env, at('2026-11-18T11:15:00-06:00'), f);
  assert.equal(sends(f).length, 0); assert.match(rec().fu.hold, /cannot confirm no reply/);
  assert.ok([...env.KV.m.keys()].some((k) => k.startsWith('watch:') && k.includes(id)));
  await T.followup(new Request('https://x/', { method: 'POST', body: JSON.stringify({ id, k: KEY, action: 'clear' }) }), env, at('2026-11-18T08:00:00-06:00'));
  await T.fuTick(env, at('2026-11-18T11:15:00-06:00'), f); assert.equal(sends(f).length, 0, 'clear stamp over 2 hours old');
  await T.followup(new Request('https://x/', { method: 'POST', body: JSON.stringify({ id, k: KEY, action: 'clear' }) }), env, at('2026-11-18T11:00:00-06:00'));
  await T.fuTick(env, at('2026-11-18T11:30:00-06:00'), f); assert.equal(sends(f).length, 1);
  assert.equal(decode(sends(f)[0]).threadId, 'abc123def');
});

await test('The reply desk can stop or move him to "later" (ladder starts from that day)', async () => {
  const a = await sent({ FOLLOWUPS: 'on' });
  assert.equal((await call(a.env, '/api/free-report/followup', { id: a.id, k: 'bad', action: 'stop' })).status, 403);
  await call(a.env, '/api/free-report/followup', { id: a.id, k: KEY, action: 'stop', why: 'said no' });
  assert.equal(a.rec().fu.stopped.why, 'said no');
  const b = await sent({ FOLLOWUPS: 'on' });
  await T.followup(new Request('https://x/', { method: 'POST', body: JSON.stringify({ id: b.id, k: KEY, action: 'later' }) }), b.env, at('2026-11-18T10:00:00-06:00'));
  const r = await (await call(b.env, '/api/free-report/followup', { id: b.id, k: KEY, action: 'status' })).json();
  assert.deepEqual(r.plan.map((p) => p.step + ' ' + p.due), ['n1 2026-12-02', 'n2 2026-12-30', 'n3 2027-02-10']);
});

await test('Fallbacks: AI split answer -> map spot line; no booking fix -> newest-review offer; facts are never repeated', async () => {
  const fills = { ...FILLS, ai: { chatgpt: { named: true }, gemini: { named: false } }, booking: { score: 6, fixes: [] } };
  const { env, rec } = await sent({ FOLLOWUPS: 'on' }, SHOP, fills);
  const f = gfetch(); const texts = [];
  for (const d of ['2026-11-18', '2026-11-20', '2026-11-27']) { await T.fuTick(env, at(d + 'T11:15:00-06:00'), f); texts.push(decode(sends(f).at(-1)).text); }
  assert.match(texts[1], /came up at #7\./); assert.doesNotMatch(texts[1], /ChatGPT/);
  assert.match(texts[2], /newest Google review had no reply yet/);
  assert.equal(sends(f).length, 3);
});

await test('Whole cold run to the end: every email passes the checks, one per day at most, holidays skipped, then the ladder', async () => {
  const { env, rec } = await sent({ FOLLOWUPS: 'on' });
  const f = gfetch(); const days = new Set();
  let d = new Date('2026-11-18T17:15:00Z');
  for (let i = 0; i < 400; i++) {
    await T.fuTick(env, d, f);
    d = new Date(d.getTime() + 86400000);
  }
  const s = sends(f).map(decode);
  const link = 'https://getbookedoutsolutions.com/r/' + rec().token + '/';
  for (const m of s) { const body = m.text.split('\n\nRickey Hallor')[0]; assert.deepEqual(FU.bodyProblems(body, link), [], body.slice(0, 80)); }
  const done = rec().fu.done;
  for (const k of Object.keys(done)) { const day = done[k].at.slice(0, 10); assert.ok(!days.has(day), 'two on ' + day); days.add(day); }
  assert.ok(!days.has('2026-11-26') && !days.has('2026-12-25'));
  assert.ok(done.c1 && done.c5 && done.n1 && done.n3, Object.keys(done).join(','));
  assert.ok(Object.values(done).filter((x) => x.status === 'sent').length >= 8);
});

await test('Warm (introducer on file): 3 steps on business days 2, 7, 12, introducer named, warm footer', async () => {
  const { env, id, rec } = await sent({ FOLLOWUPS: 'on' });
  const r0 = rec(); r0.warm = true; r0.introducer = 'Jamie'; env.KV.m.set('req:' + id, JSON.stringify(r0));
  const r = await (await call(env, '/api/free-report/followup', { id, k: KEY, action: 'status' })).json();
  assert.deepEqual(r.plan.map((p) => p.step + ' ' + p.due), ['w1 2026-11-19', 'w2 2026-11-27', 'w3 2026-12-04']);
  const f = gfetch(); await T.fuTick(env, at('2026-11-19T11:15:00-06:00'), f);
  const m = decode(sends(f)[0]);
  assert.match(m.text, /Since Jamie put us in touch/); assert.match(m.text, /You got this because you asked for a free report\.\nReply "stop"/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
