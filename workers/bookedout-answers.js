// Booked Out Solutions - client answers worker "bookedout-answers" (Nov 15 2026).
// Saves every tap from a client's one-tap page at getbookedoutsolutions.com/c/<token>/.
// Netlify proxies /api/client-answer* on our domain to this worker, so clients only ever see our domain.
// Routes:
//   POST /api/client-answer        {token, answers:[{item, answer, note}], test?}  -> saves, returns {saved:true}
//   GET  /api/client-answer/state?t=<token>                                         -> that page's saved answers
// Storage (KV binding KV):
//   page:<token>          the page register (written by the weekly client-pages task through the Cloudflare API)
//                         {client, client_name, week, created, items:{<id>:{title, choices?}}}
//   ans:<token>:<item>    latest answer {client, token, item, title, answer, note, time}
//   log:<iso>:<token>:<item>  one row per tap (90 days), for the weekly task's read-and-act pass
//   fin:<token>           time the page was finished (every item answered)
//   test:<token>          the TEST save done at deploy (never a client answer)
//   html:<token>          the page itself (built by tools/make_client_page.py)
//   alert:last            result of the last alert email (when ALERT_TO is set)
// Alert email: optional (env.ALERT_TO via FormSubmit). OFF since Nov 15: FormSubmit rate-limits Worker IPs (429).
// Alerts are sent by the client-pages scheduled task instead. No secrets in this file. Nothing here sends anything to a client.

const TOKEN = /^[a-f0-9]{32,64}$/;
const ITEM = /^[a-z0-9][a-z0-9-]{0,60}$/;
const BASE = ['approved', 'change', 'done', 'help'];

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const p = u.pathname.replace(/\/+$/, '');
    try {
      if (p === '/api/client-answer' && req.method === 'POST') return await answer(req, env, ctx);
      if (p === '/api/client-answer/state' && req.method === 'GET') return await state(u, env);
      if (p === '/api/client-answer/ping') return json({ ok: true, at: new Date().toISOString() });
      const m = p.match(/^\/c\/([a-f0-9]{32,64})$/);
      if (m && req.method === 'GET') {
        if (!u.pathname.endsWith('/')) return Response.redirect(`https://getbookedoutsolutions.com/c/${m[1]}/`, 301);
        const html = await env.KV.get('html:' + m[1]);
        return new Response(html || GONE, { status: html ? 200 : 404, headers: {
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN' } });
      }
      return new Response('Booked Out answers', { status: 200 });
    } catch (e) {
      return json({ saved: false, error: 'server' }, 500);
    }
  },
};

async function answer(req, env, ctx) {
  const raw = await req.text();
  if (raw.length > 20000) return json({ saved: false, error: 'too big' }, 413);
  let b; try { b = JSON.parse(raw); } catch { return json({ saved: false, error: 'bad json' }, 400); }
  const token = String(b.token || '');
  if (!TOKEN.test(token)) return json({ saved: false, error: 'bad page' }, 400);
  const page = JSON.parse((await env.KV.get('page:' + token)) || 'null');
  if (!page) return json({ saved: false, error: 'unknown page' }, 404);
  const now = new Date().toISOString();
  if (b.test === true) {
    await env.KV.put('test:' + token, JSON.stringify({ time: now, note: String(b.note || '').slice(0, 200) }), { expirationTtl: 60 * 60 * 24 * 30 });
    return json({ saved: true, test: true, time: now });
  }
  const list = Array.isArray(b.answers) ? b.answers.slice(0, 25) : [];
  if (!list.length) return json({ saved: false, error: 'no answers' }, 400);
  const rows = [];
  for (const a of list) {
    const item = String(a.item || '');
    const def = page.items && page.items[item];
    if (!ITEM.test(item) || !def) return json({ saved: false, error: 'unknown item ' + item.slice(0, 40) }, 400);
    const ans = String(a.answer || '').slice(0, 60);
    if (!BASE.includes(ans) && !(def.choices || []).includes(ans)) return json({ saved: false, error: 'bad answer' }, 400);
    const note = String(a.note || '').slice(0, 2000);
    if (ans === 'change' && !note.trim()) return json({ saved: false, error: 'empty change note' }, 400);
    rows.push({ client: page.client, token, item, title: def.title || item, answer: ans, note, time: now });
  }
  for (const r of rows) {
    await env.KV.put(`ans:${token}:${r.item}`, JSON.stringify(r));
    await env.KV.put(`log:${now}:${token}:${r.item}`, JSON.stringify(r), { expirationTtl: 60 * 60 * 24 * 90 });
  }
  const answered = (await env.KV.list({ prefix: `ans:${token}:` })).keys.length;
  const total = Object.keys(page.items || {}).length;
  let finished = false;
  if (answered >= total && !(await env.KV.get('fin:' + token))) { finished = true; await env.KV.put('fin:' + token, now); }
  ctx.waitUntil(alert(env, page, token, rows, answered, total, finished));
  return json({ saved: true, time: now, answered, total, finished });
}

async function state(u, env) {
  const token = u.searchParams.get('t') || '';
  if (!TOKEN.test(token)) return json({ error: 'bad page' }, 400);
  if (!(await env.KV.get('page:' + token))) return json({ error: 'unknown page' }, 404);
  const out = {};
  const keys = (await env.KV.list({ prefix: `ans:${token}:` })).keys;
  for (const k of keys) {
    const r = JSON.parse((await env.KV.get(k.name)) || 'null');
    if (r) out[r.item] = { answer: r.answer, note: r.note, time: r.time };
  }
  return json({ answers: out, finished: Boolean(await env.KV.get('fin:' + token)) });
}

async function alert(env, page, token, rows, answered, total, finished) {
  if (!env.ALERT_TO) return;
  const lines = rows.map((r) => `${r.title}: ${r.answer}${r.note ? ' - ' + r.note : ''}`);
  const body = {
    _subject: `Client answer - ${page.client_name || page.client}${finished ? ' - PAGE FINISHED' : ''} (${answered} of ${total})`,
    _template: 'table',
    _captcha: 'false',
    client: page.client,
    page_week: page.week || '',
    answers: lines.join('\n'),
    progress: `${answered} of ${total}${finished ? ' - finished' : ''}`,
    page: `https://getbookedoutsolutions.com/c/${token}/`,
  };
  let res = '';
  try {
    const r = await fetch('https://formsubmit.co/ajax/' + env.ALERT_TO, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json',
        origin: 'https://getbookedoutsolutions.com', referer: `https://getbookedoutsolutions.com/c/${token}/` },
      body: JSON.stringify(body),
    });
    res = r.status + ' ' + (await r.text()).slice(0, 300);
  } catch (e) { res = 'error ' + String(e && e.message || e); }
  await env.KV.put('alert:last', JSON.stringify({ at: new Date().toISOString(), res }));
}

const GONE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Page not found | Booked Out Solutions</title><style>body{margin:0;font:18px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#EFE8DF;color:#2E2629}main{max-width:34rem;margin:0 auto;padding:3rem 1.2rem}h1{font-weight:500}</style></head><body><main><h1>This page isn\'t here</h1><p>This link may be from an older week. Please use the newest link in your email from Booked Out Solutions, or just reply to that email and we\'ll send it again.</p><p>Booked Out Solutions</p></main></body></html>';

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
