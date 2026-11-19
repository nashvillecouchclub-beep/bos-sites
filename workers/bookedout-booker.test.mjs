// node workers/bookedout-booker.test.mjs  (no network; fake KV and AI)
import assert from 'node:assert/strict';
import w, { allowed, centralDay, clean, esc } from './bookedout-booker.js';
const store = new Map();
const KV = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }) };
let aiReply = 'Headache how? [END]'; let aiFail = false;
const AI = { run: async () => { if (aiFail) throw new Error('x'); return { response: aiReply }; } };
const env = { KV, AI, HOOK_TOKEN: 'tok123', ADMIN_TOKEN: 'adm', ALLOWED_CALLERS: '+13098636854', SELF_URL: 'https://b.example', BOOKER_VOICE: 'Telnyx.Ultra.x', DAILY_MINUTE_CAP: '1', MAX_CALL_SECONDS: '480', MAX_TURNS: '3' };
const post = (path, body) => w.fetch(new Request('https://b.example' + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }), env, {});
let ok = 0; const t = async (name, fn) => { await fn(); ok++; console.log('ok', name); };

await t('wrong token gets no TeXML', async () => { const x = await (await post('/t/bad/voice', { CallSid: 'a', From: '+13098636854' })).text(); assert.doesNotMatch(x, /Gather|Hank/); });
await t('stranger hears not-open line and hangup', async () => { const x = await (await post('/t/tok123/voice', { CallSid: 's1', From: '+16155550100' })).text(); assert.match(x, /isn't open yet/); assert.match(x, /<Hangup\/>/); assert.doesNotMatch(x, /Gather/); });
await t('Rickey gets greeting in a speech Gather with absolute action', async () => { const x = await (await post('/t/tok123/voice', { CallSid: 'c1', From: '+13098636854' })).text(); assert.match(x, /Hank Booker/); assert.match(x, /This call is recorded/); assert.match(x, /<Gather input="speech" action="https:\/\/b.example\/t\/tok123\/turn"/); assert.match(x, /voice="Telnyx.Ultra.x"/); });
await t('turn: reply spoken, [END] hangs up, tag removed', async () => { const x = await (await post('/t/tok123/turn', { CallSid: 'c1', SpeechResult: 'quotes go quiet' })).text(); assert.match(x, /Headache how\?/); assert.doesNotMatch(x, /\[END\]/); assert.match(x, /<Hangup\/>/); });
await t('turn without END keeps listening', async () => { aiReply = 'Booked out, or need more work?'; const x = await (await post('/t/tok123/turn', { CallSid: 'c1', SpeechResult: 'hi' })).text(); assert.match(x, /<Gather/); });
await t('brain down -> safe default line, still no dead air', async () => { aiFail = true; const x = await (await post('/t/tok123/turn', { CallSid: 'c1', SpeechResult: 'price?' })).text(); assert.match(x, /don't want to guess/); aiFail = false; });
await t('max turns -> time line and hangup', async () => { const x = await (await post('/t/tok123/turn', { CallSid: 'c1', SpeechResult: 'more' })).text(); assert.match(x, /time limit/); assert.match(x, /<Hangup\/>/); });
await t('silence twice -> polite hangup', async () => { await post('/t/tok123/voice', { CallSid: 'c2', From: '+13098636854' }); let x = await (await post('/t/tok123/turn?silent=1', { CallSid: 'c2' })).text(); assert.match(x, /still there/); x = await (await post('/t/tok123/turn?silent=1', { CallSid: 'c2' })).text(); assert.match(x, /<Hangup\/>/); });
await t('status adds minutes once; daily cap blocks next call', async () => { await post('/t/tok123/status', { CallSid: 'c1', CallStatus: 'completed', CallDuration: '70' }); await post('/t/tok123/status', { CallSid: 'c1', CallStatus: 'completed', CallDuration: '70' }); assert.equal(store.get('day:' + centralDay()), '70'); const x = await (await post('/t/tok123/voice', { CallSid: 'c3', From: '+13098636854' })).text(); assert.match(x, /phone time for today/); assert.match(x, /<Hangup\/>/); });
await t('admin calls page needs key', async () => { assert.equal((await w.fetch(new Request('https://b.example/calls?k=no'), env, {})).status, 200); const r = await w.fetch(new Request('https://b.example/calls?k=adm'), env, {}); const j = await r.json(); assert.equal(j.seconds_today, 70); assert.ok(j.rows.length > 3); });
await t('helpers: escape, clean, allowed, GO_LIVE', async () => { assert.equal(esc('<a&"'), '&lt;a&amp;&quot;'); assert.equal(clean('Hi — there **ok** 😀 [END]'), 'Hi, there ok'); assert.ok(!allowed(env, '+1615')); assert.ok(allowed({ ...env, GO_LIVE: 'true' }, '+1615')); });
await t('no dashes or emoji in fixed lines', async () => { const m = await import('./bookedout-booker.js'); for (const k of ['GREETING', 'FALLBACK', 'NOT_OPEN', 'CAP_LINE', 'TIME_LINE']) assert.doesNotMatch(m[k], /[–—]|\p{Extended_Pictographic}/u); });
console.log(`${ok} passed`);
