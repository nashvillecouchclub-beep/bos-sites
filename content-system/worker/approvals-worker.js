// Booked Out approvals API (Cloudflare Worker, free plan is enough: KV writes are tiny and rare).
// Deploy once from the Mac mini:   cd content-system/worker && npx wrangler deploy
//   wrangler.toml below; KV namespace APPROVALS; secret READ_KEY (npx wrangler secret put READ_KEY).
// Routes (reached through getbookedoutsolutions.com/approve-api/* via the Netlify _redirects proxy):
//   POST /approve-api/<token>        body {batch_id, answers, final}  -> saves the client's answers (no login; the token is the key)
//   GET  /approve-api/<token>?key=READ_KEY                             -> our posting task reads the answers
// Only tokens listed in KV "tokens:<token>" (written by approve/sync.py register) are accepted, so random tokens are refused.
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Tracked short links with click counts: /go/<code> -> 302 to the UTM-tagged page; counts clicks per code per day.
    const g = url.pathname.match(/^\/go\/([a-z0-9]{2,24})\/?$/);
    if (g) {
      const target = await env.APPROVALS.get('go:' + g[1]);
      const day = new Date().toISOString().slice(0, 10);
      if (target && !/bot|crawl|spider|preview|facebookexternalhit|slurp/i.test(req.headers.get('user-agent') || '')) {
        const k = 'clicks:' + g[1] + ':' + day;
        const n = Number(await env.APPROVALS.get(k) || 0) + 1;
        await env.APPROVALS.put(k, String(n), { expirationTtl: 60 * 60 * 24 * 800 });
      }
      return Response.redirect(target || 'https://getbookedoutsolutions.com/', 302);
    }
    if (url.pathname === '/clicks' && url.searchParams.get('key') === env.READ_KEY) {
      const list = await env.APPROVALS.list({ prefix: 'clicks:' + (url.searchParams.get('prefix') || '') });
      const out = {};
      for (const k of list.keys) out[k.name.slice(7)] = Number(await env.APPROVALS.get(k.name));
      return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    }
    const m = url.pathname.match(/^\/approve-api\/([A-Za-z0-9]{12,64})\/?$/);
    const cors = { 'Access-Control-Allow-Origin': 'https://getbookedoutsolutions.com', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                   'Access-Control-Allow-Headers': 'Content-Type', 'Cache-Control': 'no-store' };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!m) return new Response('not found', { status: 404, headers: cors });
    const token = m[1];
    const known = await env.APPROVALS.get('tokens:' + token);
    if (!known) return new Response('unknown page', { status: 404, headers: cors });
    if (req.method === 'POST') {
      const len = Number(req.headers.get('content-length') || 0);
      if (len > 200000) return new Response('too big', { status: 413, headers: cors });
      let body; try { body = await req.json() } catch (e) { return new Response('bad json', { status: 400, headers: cors }) }
      const rec = { batch_id: String(body.batch_id || ''), answers: body.answers || {}, final: !!body.final, saved_at: new Date().toISOString() };
      await env.APPROVALS.put('answers:' + token, JSON.stringify(rec));
      if (rec.final) await env.APPROVALS.put('final:' + token + ':' + rec.saved_at, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 800 });
      return new Response(JSON.stringify({ ok: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    if (req.method === 'GET') {
      if (url.searchParams.get('key') !== env.READ_KEY) return new Response('no', { status: 403, headers: cors });
      const v = await env.APPROVALS.get('answers:' + token);
      return new Response(v || '{}', { headers: { ...cors, 'Content-Type': 'application/json' } });
    }
    return new Response('method', { status: 405, headers: cors });
  }
};
