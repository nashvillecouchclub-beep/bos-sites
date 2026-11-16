// Booked Out Solutions - Cloudflare Pages front door for getbookedoutsolutions.com (Nov 16 2026).
//
// Pages can't proxy to another address from _redirects (Netlify could), so this small file does it:
// the paths below are passed to our own Cloudflare workers and the address bar stays on our domain.
// Everything else is the normal static site (pretty URLs, _headers and _redirects still apply).
// No secrets in this file. Netlify never gets it (tools/make_manifest.py leaves it out).

const PROXY = [
  // [path test, worker origin]
  [/^\/connect(\/|$)/, 'https://bookedout-connect.rickey-38a.workers.dev'],
  [/^\/c\//, 'https://bookedout-answers.rickey-38a.workers.dev'],
  [/^\/api\/client-answer(\/|$)/, 'https://bookedout-answers.rickey-38a.workers.dev'],
  [/^\/api\/free-report(\/|$)/, 'https://bookedout-freereport.rickey-38a.workers.dev'],
  [/^\/r\//, 'https://bookedout-freereport.rickey-38a.workers.dev'],
];

// Same rules as _headers, applied here too so they hold even if Pages skips _headers for a response.
const NOINDEX = [/^\/price-/, /^\/first-shop-/, /^\/welcome(\.html)?$/, /^\/forms(\.html)?$/, /^\/c\//, /^\/api\//, /^\/r\//];
const NOREF = [/^\/c\//, /^\/r\//];
const HIDDEN = new Set(['/files.json', '/_worker.js', '/_headers', '/_redirects']);

function withHeaders(res, path) {
  const h = new Headers(res.headers);
  h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'SAMEORIGIN');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (NOINDEX.some((r) => r.test(path))) h.set('X-Robots-Tag', 'noindex, nofollow');
  if (NOREF.some((r) => r.test(path))) h.set('Referrer-Policy', 'no-referrer');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function proxy(req, origin, url) {
  const target = origin + url.pathname + url.search;
  const init = { method: req.method, headers: new Headers(req.headers), redirect: 'manual' };
  init.headers.delete('host');
  init.headers.set('x-forwarded-host', url.host);
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.arrayBuffer();
  const res = await fetch(target, init);
  // keep any redirect the worker gives on our own domain
  const loc = res.headers.get('location');
  if (loc && loc.startsWith(origin)) {
    const h = new Headers(res.headers);
    h.set('location', url.origin + loc.slice(origin.length));
    return withHeaders(new Response(res.body, { status: res.status, headers: h }), url.pathname);
  }
  return withHeaders(res, url.pathname);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (HIDDEN.has(path)) return notFound(env, url);
    for (const [re, origin] of PROXY) {
      if (re.test(path)) {
        try { return await proxy(req, origin, url); }
        catch (e) { return new Response('Sorry, something went wrong. Please try again in a minute.', { status: 502, headers: { 'content-type': 'text/plain', 'x-robots-tag': 'noindex' } }); }
      }
    }
    return withHeaders(await env.ASSETS.fetch(req), path);
  },
};

async function notFound(env, url) {
  const r = await env.ASSETS.fetch(new Request(new URL('/404', url), { method: 'GET' }));
  const h = new Headers(r.headers); h.delete('location');
  return withHeaders(new Response(r.status === 200 ? r.body : 'Not found', { status: 404, headers: h }), url.pathname);
}
