// Tests for sites/getbookedoutsolutions.com/_worker.js (the Cloudflare Pages front door). Run: node workers/test-pages-frontdoor.mjs
import W from '../sites/getbookedoutsolutions.com/_worker.js';
import assert from 'node:assert/strict';
let pass = 0, fail = 0;
const test = async (n, fn) => { try { await fn(); pass++; console.log('ok   ' + n); } catch (e) { fail++; console.log('FAIL ' + n + '\n     ' + e.message); } };
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init });
  if (String(url).includes('/r/')) return new Response(null, { status: 301, headers: { location: 'https://bookedout-freereport.rickey-38a.workers.dev/r/x/' } });
  return new Response('{"saved":true}', { status: 200, headers: { 'content-type': 'application/json' } }); };
const env = { ASSETS: { fetch: async (req) => { const p = new URL(req.url).pathname; return new Response('page ' + p, { status: p === '/404' ? 200 : 200, headers: { 'content-type': 'text/html' } }); } } };
const S = 'https://bookedout.pages.dev';
await test('free report POST goes to the freereport worker with its body', async () => {
  const r = await W.fetch(new Request(S + '/api/free-report', { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } }), env);
  assert.equal(r.status, 200); const c = calls.at(-1);
  assert.equal(c.url, 'https://bookedout-freereport.rickey-38a.workers.dev/api/free-report');
  assert.equal(new TextDecoder().decode(c.init.body), '{"a":1}');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
});
await test('report redirect stays on our domain, noindex and no-referrer', async () => {
  const r = await W.fetch(new Request(S + '/r/x'), env);
  assert.equal(r.headers.get('location'), S + '/r/x/');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});
await test('client pages, client answers and connect go to their workers', async () => {
  await W.fetch(new Request(S + '/c/abc?x=1'), env); assert.equal(calls.at(-1).url, 'https://bookedout-answers.rickey-38a.workers.dev/c/abc?x=1');
  await W.fetch(new Request(S + '/api/client-answer', { method: 'POST', body: 'x' }), env); assert.equal(calls.at(-1).url, 'https://bookedout-answers.rickey-38a.workers.dev/api/client-answer');
  await W.fetch(new Request(S + '/connect/start'), env); assert.equal(calls.at(-1).url, 'https://bookedout-connect.rickey-38a.workers.dev/connect/start');
  await W.fetch(new Request(S + '/connect'), env); assert.equal(calls.at(-1).url, 'https://bookedout-connect.rickey-38a.workers.dev/connect');
});
await test('normal pages are static, price pages noindex, home page indexable', async () => {
  const n = calls.length;
  const h = await W.fetch(new Request(S + '/'), env); assert.equal(h.headers.get('x-robots-tag'), null);
  const p = await W.fetch(new Request(S + '/price-hvac'), env); assert.equal(p.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(calls.length, n, 'no outside calls'); assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await (await W.fetch(new Request(S + '/connections'), env)).text(), 'page /connections', '/connections is not /connect');
});
await test('files.json and _worker.js are hidden', async () => {
  for (const p of ['/files.json', '/_worker.js']) assert.equal((await W.fetch(new Request(S + p), env)).status, 404);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
