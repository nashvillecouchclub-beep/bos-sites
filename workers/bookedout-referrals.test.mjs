import * as W from './bookedout-referrals.js';
import assert from 'node:assert/strict';

class KV { constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, v); } async delete(k) { this.m.delete(k); }
  async list({ prefix = '', limit } = {}) { return { keys: [...this.m.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })) }; } }

// 1) SigV4 against AWS's published example (IAM ListUsers, 2015-08-30)
const h = await W.signV4({ method: 'GET', url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
  headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body: '', region: 'us-east-1', service: 'iam',
  key: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', amzDate: '20150830T123600Z' });
assert.match(h.authorization, /Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7$/);
console.log('ok sigv4 AWS example');

const CFG = { 'stones-river': { name: 'Jamie Hallor', from: 'jamie@notes.stonesrivertherapy.com', reply_to: 'jamie@stonesrivertherapy.com',
  identity: 'notes.stonesrivertherapy.com', mail_from: 'bounce.notes.stonesrivertherapy.com', selector: 'bos1', test_to: 'nashvillecouchclub@gmail.com',
  window: [570, 750], cap_ramp: [[14, 5], [9999, 10]], optout_base: 'https://x.workers.dev/u' } };
const mk = () => ({ KV: new KV(), ANSWERS: new KV(), CLIENTS: JSON.stringify(CFG), WORKER_TOKEN: 't0k', AWS_ACCESS_KEY_ID: 'AKIDTEST', AWS_SECRET_ACCESS_KEY: 'sec', AWS_REGION: 'us-east-1' });
const sent = [];
const fakeFetch = async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ MessageId: 'ses-' + sent.length }), { status: 200 }); };
const req = (path, body, method = 'POST', auth = true) => new Request('https://w' + path, { method, headers: auth ? { authorization: 'Bearer t0k', 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
const TUE_10AM = Date.parse('2026-11-17T16:00:00Z'); // 10:00 Central, Tuesday
const TOKEN = 'a'.repeat(40);
const seq = { id: 'mtsu-ccps', to: 'ccps@mtsu.edu', subject: 'Hello from a new local therapist', signature: 'Jamie Hallor, MSW, LCSW',
  touches: [{ text: 'Hi, first note', due: '2026-11-17' }, { text: 'Follow-up one', due: '2026-12-01' }],
  approval: { token: TOKEN, item: 'ref-mtsu-ccps' }, sig_approval: { token: TOKEN, item: 'ref-signature' } };

const env = mk();
// unauthenticated admin is refused
assert.equal((await W.handle(req('/status', null, 'GET', false), env)).status, 401);
let r = await (await W.handle(req('/stage', { client: 'stones-river', sequence: seq }), env)).json();
assert.equal(r.approval_check, 'approval page not found for this client');
// 2) lock shut: nothing sends even when everything else is right
await env.ANSWERS.put('page:' + TOKEN, JSON.stringify({ client: 'stones-river', items: { 'ref-mtsu-ccps': { title: 'x', sha: r.seq_sha }, 'ref-signature': { title: 's', sha: r.sig_sha } } }));
await env.ANSWERS.put('agg:' + TOKEN, JSON.stringify({ 'ref-mtsu-ccps': { answer: 'approved' } }));
let t = await W.tick(env, TUE_10AM, { fetch: fakeFetch });
assert.equal(t['stones-river'].why, 'send lock shut'); assert.equal(sent.length, 0);
console.log('ok lock shut blocks');
// open lock needs the exact confirm text
assert.equal((await W.handle(req('/lock', { client: 'stones-river', open: true }), env)).status, 400);
await W.handle(req('/lock', { client: 'stones-river', open: true, confirm: 'open stones-river' }), env);
// 3) signature not approved -> refused
t = await W.tick(env, TUE_10AM, { fetch: fakeFetch });
assert.match(t['stones-river'].why, /not approved/); assert.equal(sent.length, 0);
await env.ANSWERS.put('agg:' + TOKEN, JSON.stringify({ 'ref-mtsu-ccps': { answer: 'approved' }, 'ref-signature': { answer: 'approved' } }));
// 4) weekend and outside the window
assert.equal((await W.tick(env, Date.parse('2026-11-21T16:00:00Z'), { fetch: fakeFetch }))['stones-river'].why, 'weekend');
assert.equal((await W.tick(env, Date.parse('2026-11-17T13:00:00Z'), { fetch: fakeFetch }))['stones-river'].why, 'outside send window');
assert.equal((await W.tick(env, Date.parse('2026-11-24T16:00:00Z'), { fetch: fakeFetch }))['stones-river'].why, 'holiday pause');
// 5) approved + lock open -> sends exactly one, with Reply-To, List-Unsubscribe and the footer
t = await W.tick(env, TUE_10AM, { fetch: fakeFetch });
assert.equal(t['stones-river'].sent, 1); assert.equal(sent.length, 1);
const call = JSON.parse(sent[0].init.body);
assert.equal(call.FromEmailAddress, 'jamie@notes.stonesrivertherapy.com');
assert.deepEqual(call.ReplyToAddresses, ['jamie@stonesrivertherapy.com']);
const mime = Buffer.from(call.Content.Raw.Data, 'base64').toString();
assert.match(mime, /^From: "Jamie Hallor" <jamie@notes\.stonesrivertherapy\.com>/m);
assert.match(mime, /^Reply-To: <jamie@stonesrivertherapy\.com>/m);
assert.match(mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
assert.match(sent[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-1\/ses\/aws4_request/);
assert.equal(sent[0].url, 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails');
console.log('ok approved sends one, headers right');
// 6) the follow-up is not due yet; nothing more today
t = await W.tick(env, TUE_10AM + 900000, { fetch: fakeFetch });
assert.equal(t['stones-river'].why, 'nothing due'); assert.equal(sent.length, 1);
// 7) edited text after approval -> hash mismatch -> refused (stage new id with changed words)
const seq2 = { ...seq, id: 'mtsu-ccps-2', to: 'other@mtsu.edu', touches: [{ text: 'changed words', due: '2026-11-17' }] };
await W.handle(req('/stage', { client: 'stones-river', sequence: seq2 }), env);
t = await W.tick(env, TUE_10AM + 1800000, { fetch: fakeFetch });
assert.match(t['stones-river'].why, /hash/); assert.equal(sent.length, 1);
console.log('ok changed text refused');
// 8) opt-out link: GET shows a button only, POST stops; follow-up then never sends
const tok = await W.unsubToken(env, 'stones-river', 'ccps@mtsu.edu');
let o = await W.handle(new Request(`https://w/u?c=stones-river&e=ccps%40mtsu.edu&t=${tok}`), env);
assert.equal(JSON.parse((await env.KV.get('stopped:stones-river')) || '[]').length, 0);
o = await W.handle(new Request(`https://w/u?c=stones-river&e=ccps%40mtsu.edu&t=${tok}`, { method: 'POST' }), env);
assert.equal(o.status, 200); assert.deepEqual(JSON.parse(await env.KV.get('stopped:stones-river')), ['ccps@mtsu.edu']);
assert.equal((await W.handle(new Request(`https://w/u?c=stones-river&e=ccps%40mtsu.edu&t=bad`, { method: 'POST' }), env)).status, 403);
t = await W.tick(env, Date.parse('2026-12-01T16:00:00Z'), { fetch: fakeFetch });
assert.equal(sent.length, 1);
const s1 = JSON.parse(await env.KV.get('seq:stones-river:mtsu-ccps')); assert.equal(s1.done, 'stopped');
console.log('ok opt-out stops follow-ups');
// 9) daily cap: 5 a day in the first 2 weeks
const env2 = mk(); sent.length = 0;
const items = {}; const agg = { 'sig': { answer: 'approved' } };
for (let i = 0; i < 7; i++) {
  const s = { ...seq, id: 'p' + i, to: `p${i}@ex.org`, approval: { token: TOKEN, item: 'c' + i }, sig_approval: { token: TOKEN, item: 'sig' } };
  const rr = await (await W.handle(req('/stage', { client: 'stones-river', sequence: s }), env2)).json();
  items['c' + i] = { sha: rr.seq_sha }; items.sig = { sha: rr.sig_sha }; agg['c' + i] = { answer: 'approved' };
}
await env2.ANSWERS.put('page:' + TOKEN, JSON.stringify({ client: 'stones-river', items }));
await env2.ANSWERS.put('agg:' + TOKEN, JSON.stringify(agg));
await env2.KV.put('lock:stones-river', 'open');
for (let k = 0; k < 10; k++) await W.tick(env2, TUE_10AM + k * 900000, { fetch: fakeFetch });
assert.equal(sent.length, 5);
console.log('ok daily cap 5');
// 10) logs are written for every send
const logs = (await env2.KV.list({ prefix: 'log:stones-river:' })).keys.length;
assert.ok(logs >= 5);
// 11) global STOP
await env2.KV.put('STOP', '1'); assert.deepEqual(await W.tick(env2, TUE_10AM + 86400000), { stopped: true });
// 12) /test refuses before SES says verified
const env3 = mk();
const idFetch = async () => new Response(JSON.stringify({ VerifiedForSendingStatus: false, DkimAttributes: { Status: 'PENDING' } }), { status: 200 });
r = await (await W.handle(req('/test', { client: 'stones-river' }), env3, { fetch: idFetch })).json();
assert.equal(r.sent, false); assert.equal(r.why, 'subdomain not verified yet');
console.log('ok test waits for verification; all tests passed');
