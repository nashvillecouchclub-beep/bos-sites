// Booked Out Solutions - client referral sender "bookedout-referrals" (Nov 15 2026).
// Rickey, Nov 15 2:51 pm: client referral emails no longer use a helper inside the client's own Google account.
// This worker sends them in the client's name from a SUBDOMAIN of the client's own domain
// (Stones River: "Jamie Hallor <jamie@notes.stonesrivertherapy.com>", Reply-To jamie@stonesrivertherapy.com),
// through Amazon SES (us-east-1) on Booked Out's AWS account, which is under the AWS BAA. The client touches nothing.
// The client's root domain mail records (MX, SPF, DKIM, DMARC) are never touched: the subdomain has its own.
//
// What it sends, and nothing else:
//   - Only sequences (first email + up to 4 follow-ups) that the client APPROVED on her own client page:
//     the answers KV (bookedout-answers) must show answer "approved" for the sequence's card AND for the
//     signature card, and each card's register entry must carry the sha256 of exactly the text staged here.
//     Any change to the text changes the hash, so an old approval can never send new words.
//   - Only when the client's send lock is OPEN (KV lock:<client> = "open"). It is SHUT by default.
//   - Test mode: POST /test sends ONE fixed test note, only to the client's test_to address
//     (nashvillecouchclub@gmail.com), only after SES shows the subdomain verified. Never to anyone else.
//   - Weekdays only, inside the client's send window (Central time), never on a holiday pause day,
//     at most ONE email per 15-minute tick, at most the client's daily cap (hard ceiling 15 a day).
//   - Never to an address on the stop list (opt-out link, List-Unsubscribe one-click, manual stop from the
//     client page "they replied" card, or a bounce/complaint the check-in reports). Follow-ups stop at once.
//   - Every send (and every refusal) is logged in KV: log:<client>:<iso>:<seq>:<touch>, kept 2 years.
// Secrets (Cloudflare secrets, never in this file): WORKER_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
//   DKIM_KEY_<CLIENT> (BYODKIM private key, PKCS#1 base64; made in the browser, never written anywhere else).
// Bindings: KV (bookedout-referrals-kv), ANSWERS (bookedout-answers-kv, read only by this code).
// Vars: CLIENTS (JSON, below), AWS_REGION ("us-east-1").
//
// CLIENTS = {"stones-river": {"name":"Jamie Hallor","from":"jamie@notes.stonesrivertherapy.com",
//   "reply_to":"jamie@stonesrivertherapy.com","identity":"notes.stonesrivertherapy.com",
//   "mail_from":"bounce.notes.stonesrivertherapy.com","selector":"bos1","test_to":"nashvillecouchclub@gmail.com",
//   "window":[570,750],"cap_ramp":[[14,5],[9999,10]],"optout_base":"https://bookedout-referrals.rickey-38a.workers.dev/u"}}

export const HARD_CAP = 15;
export const TZ = 'America/Chicago';
export const LOG_TTL = 60 * 60 * 24 * 731; // keep dated copies 2 years (therapy rule)
export const DEFAULT_BLACKOUTS = [ // Jamie's referral pauses (approval page, Nov 14) + Booked Out's holiday pauses
  { first: '2026-11-23', last: '2026-11-29' },
  { first: '2026-12-18', last: '2027-01-03' },
];
export const FOOTER = (url) =>
  `If you'd rather not get notes like this from me, just reply "no thanks" or use this link and I won't write again: ${url}`;

const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256hex = async (t) => hex(await crypto.subtle.digest('SHA-256', typeof t === 'string' ? enc.encode(t) : t));
async function hmac(key, data, raw = false) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, enc.encode(data));
  return raw ? s : hex(s);
}
export function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}

// ---------- AWS Signature V4 (checked against AWS's published IAM ListUsers example in the tests) ----------
export async function signV4({ method, url, headers = {}, body = '', region, service, key, secret, amzDate }) {
  const u = new URL(url);
  const date = amzDate.slice(0, 8);
  const h = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, 'x-amz-date': amzDate };
  const names = Object.keys(h).sort();
  const canonHeaders = names.map((n) => `${n}:${h[n]}\n`).join('');
  const signed = names.join(';');
  const q = [...u.searchParams.entries()].map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const path = u.pathname.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/') || '/';
  const creq = [method, path, q, canonHeaders, signed, await sha256hex(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256hex(creq)].join('\n');
  let k = await hmac('AWS4' + secret, date, true);
  k = await hmac(k, region, true); k = await hmac(k, service, true); k = await hmac(k, 'aws4_request', true);
  const sig = await hmac(k, sts);
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${key}/${scope}, SignedHeaders=${signed}, Signature=${sig}` };
}
export const amzNow = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

async function ses(env, method, path, bodyObj, deps = {}) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw Object.assign(new Error('no AWS key set yet'), { definite: true, code: 'no_key' });
  const region = env.AWS_REGION || 'us-east-1';
  const url = `https://email.${region}.amazonaws.com${path}`;
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const headers = await signV4({ method, url, headers: body ? { 'content-type': 'application/json' } : {}, body, region, service: 'ses',
    key: env.AWS_ACCESS_KEY_ID, secret: env.AWS_SECRET_ACCESS_KEY, amzDate: amzNow(deps.now || Date.now()) });
  delete headers.host;
  let r;
  try { r = await (deps.fetch || fetch)(url, { method, headers, body: body || undefined }); }
  catch (e) { throw Object.assign(new Error('network: ' + e.message), { definite: false }); }
  const text = await r.text();
  let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 300) }; }
  if (!r.ok) throw Object.assign(new Error(`ses ${r.status} ${j.message || j.Message || ''}`.trim()), { definite: r.status < 500, status: r.status });
  return j;
}

// ---------- time, pauses, caps ----------
export function localParts(ms) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday), date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}
export function pausedOn(date, env = {}) {
  let extra = []; try { extra = JSON.parse(env.BLACKOUTS || '[]'); } catch { extra = []; }
  return DEFAULT_BLACKOUTS.concat(Array.isArray(extra) ? extra : []).find((r) => r && r.first <= date && date <= r.last) || null;
}
export function capFor(cfg, firstSendDate, today) {
  if (!firstSendDate) return Math.min(HARD_CAP, (cfg.cap_ramp || [[9999, 5]])[0][1]);
  const days = Math.round((Date.parse(today) - Date.parse(firstSendDate)) / 86400000);
  for (const [upTo, cap] of cfg.cap_ramp || [[9999, 5]]) if (days < upTo) return Math.min(HARD_CAP, cap);
  return Math.min(HARD_CAP, 5);
}

// ---------- the approved text and its hash ----------
// The hash covers exactly what the recipient reads: address, subject, every touch's text and the signature.
export async function seqSha(seq) {
  return sha256hex(JSON.stringify({ to: String(seq.to).toLowerCase(), subject: seq.subject, texts: seq.touches.map((t) => t.text), signature: seq.signature }));
}
export const sigSha = (signature) => sha256hex(JSON.stringify({ signature }));
export async function approvalOk(env, seq) {
  const a = seq.approval || {}, s = seq.sig_approval || {};
  for (const [ap, want] of [[a, await seqSha(seq)], [s, await sigSha(seq.signature)]]) {
    if (!/^[a-f0-9]{32,64}$/.test(ap.token || '') || !ap.item) return 'no approval card';
    const reg = JSON.parse((await env.ANSWERS.get('page:' + ap.token)) || 'null');
    if (!reg || reg.client !== seq.client) return 'approval page not found for this client';
    const def = reg.items && reg.items[ap.item];
    if (!def || !def.sha || !sameText(def.sha, want)) return 'approved text does not match (hash)';
    const agg = JSON.parse((await env.ANSWERS.get('agg:' + ap.token)) || '{}');
    if (!agg[ap.item] || agg[ap.item].answer !== 'approved') return 'not approved by the client yet';
  }
  return null;
}

// ---------- the email itself (RFC 5322, plain text, UTF-8, quoted-printable) ----------
const qp = (s) => {
  const bytes = enc.encode(s.replace(/\r?\n/g, '\r\n'));
  let out = '', line = '';
  const push = (t) => { if (line.length + t.length > 75) { out += line + '=\r\n'; line = ''; } line += t; };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 13 && bytes[i + 1] === 10) { out += line.replace(/[ \t]$/, (m) => '=' + m.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')) + '\r\n'; line = ''; i++; continue; }
    push((b >= 33 && b <= 126 && b !== 61) || b === 32 ? String.fromCharCode(b) : '=' + b.toString(16).toUpperCase().padStart(2, '0'));
  }
  return out + line;
};
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...enc.encode(s)))}?=`);
export function buildMime({ fromName, from, to, replyTo, subject, text, messageId, inReplyTo, unsubUrl, date }) {
  const h = [
    `From: "${fromName.replace(/"/g, '')}" <${from}>`, `To: <${to}>`, `Reply-To: <${replyTo}>`, `Subject: ${encWord(subject)}`,
    `Date: ${new Date(date).toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${messageId}>`,
  ];
  if (inReplyTo) h.push(`In-Reply-To: <${inReplyTo}>`, `References: <${inReplyTo}>`);
  if (unsubUrl) h.push(`List-Unsubscribe: <${unsubUrl}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  h.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: quoted-printable');
  return h.join('\r\n') + '\r\n\r\n' + qp(text) + '\r\n';
}
const b64 = (s) => { const b = enc.encode(s); let o = ''; for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(o); };
export async function unsubToken(env, client, email) {
  return (await hmac(env.WORKER_TOKEN || 'x', `unsub|${client}|${String(email).toLowerCase()}`)).slice(0, 24);
}
async function unsubUrl(env, cfg, client, email) {
  return `${cfg.optout_base}?c=${encodeURIComponent(client)}&e=${encodeURIComponent(String(email).toLowerCase())}&t=${await unsubToken(env, client, email)}`;
}

// ---------- KV helpers ----------
const getJ = async (kv, k, d) => { const v = await kv.get(k); return v ? JSON.parse(v) : d; };
async function log(env, client, row, now) {
  const at = new Date(now).toISOString();
  await env.KV.put(`log:${client}:${at}:${row.seq || '-'}:${row.touch ?? '-'}`, JSON.stringify({ at, ...row }), { expirationTtl: LOG_TTL });
}
const clients = (env) => { try { return JSON.parse(env.CLIENTS || '{}'); } catch { return {}; } };

// ---------- one tick: at most one email per client ----------
export async function tick(env, now = Date.now(), deps = {}) {
  const report = {};
  if (await env.KV.get('STOP')) return { stopped: true };
  const lp = localParts(now);
  for (const [client, cfg] of Object.entries(clients(env))) {
    const r = (report[client] = { sent: 0, why: null });
    if ((await env.KV.get(`lock:${client}`)) !== 'open') { r.why = 'send lock shut'; continue; }
    if (lp.weekday > 4) { r.why = 'weekend'; continue; }
    if (pausedOn(lp.date, env)) { r.why = 'holiday pause'; continue; }
    const [w0, w1] = cfg.window || [570, 750];
    if (lp.minute < w0 || lp.minute >= w1) { r.why = 'outside send window'; continue; }
    const st = { day: lp.date, sent_today: 0, ...(await getJ(env.KV, `state:${client}`, {})) };
    if (st.day !== lp.date) { st.day = lp.date; st.sent_today = 0; }
    const cap = capFor(cfg, st.first_send_date, lp.date);
    if (st.sent_today >= cap) { r.why = `daily cap ${cap} reached`; continue; }
    const stopped = new Set(await getJ(env.KV, `stopped:${client}`, []));
    // due touches: follow-ups first, then first emails, oldest due day first
    const keys = (await env.KV.list({ prefix: `seq:${client}:` })).keys.map((k) => k.name);
    const due = [];
    for (const k of keys) {
      const seq = await getJ(env.KV, k, null);
      if (!seq || seq.done) continue;
      const i = seq.touches.findIndex((t) => !t.sent_at);
      if (i < 0) continue;
      if (seq.touches[i].due > lp.date) continue;
      if (i > 0 && !seq.touches[0].message_id) continue;
      due.push({ k, seq, i });
    }
    due.sort((a, b) => (b.i > 0) - (a.i > 0) || (a.seq.touches[a.i].due < b.seq.touches[b.i].due ? -1 : 1));
    for (const d of due) {
      const { seq, i, k } = d;
      const to = String(seq.to).toLowerCase();
      if (stopped.has(to)) { seq.done = 'stopped'; await env.KV.put(k, JSON.stringify(seq)); await log(env, client, { kind: 'skipped_stopped', seq: seq.id, touch: i, to }, now); continue; }
      const bad = await approvalOk(env, seq);
      if (bad) { // log a refusal once per day per reason, not every tick
        const tag = `${lp.date}|${bad}`;
        if (seq.last_refusal !== tag) { seq.last_refusal = tag; await env.KV.put(k, JSON.stringify(seq)); await log(env, client, { kind: 'refused', seq: seq.id, touch: i, to, why: bad }, now); }
        r.why = 'refused: ' + bad; continue;
      }
      const res = await sendTouch(env, cfg, client, seq, i, now, deps);
      if (res.ok) {
        seq.touches[i].sent_at = new Date(now).toISOString(); seq.touches[i].message_id = res.message_id; seq.touches[i].ses_id = res.ses_id;
        if (i === seq.touches.length - 1) seq.done = 'all sent';
        st.sent_today++; if (!st.first_send_date) st.first_send_date = lp.date;
        await env.KV.put(k, JSON.stringify(seq)); r.sent++;
        await log(env, client, { kind: 'sent', seq: seq.id, touch: i, to, subject: res.subject, message_id: res.message_id, ses_id: res.ses_id }, now);
      } else {
        if (!res.definite) { seq.touches[i].sent_at = 'uncertain ' + new Date(now).toISOString(); await env.KV.put(k, JSON.stringify(seq)); } // might have gone: never retried
        await log(env, client, { kind: res.definite ? 'send_failed' : 'uncertain', seq: seq.id, touch: i, to, error: res.error }, now);
        r.why = res.error;
      }
      break; // one email per client per tick
    }
    if (!r.why && !r.sent) r.why = 'nothing due';
    await env.KV.put(`state:${client}`, JSON.stringify(st));
  }
  return report;
}

export async function sendTouch(env, cfg, client, seq, i, now, deps = {}) {
  const t = seq.touches[i];
  const to = String(seq.to).toLowerCase();
  const uurl = await unsubUrl(env, cfg, client, to);
  const text = `${t.text}\n\n${seq.signature}\n\n${FOOTER(uurl)}`;
  const subject = i === 0 ? seq.subject : (/^re:/i.test(seq.subject) ? seq.subject : 'Re: ' + seq.subject);
  const messageId = `${crypto.randomUUID()}@${cfg.identity}`;
  const raw = buildMime({ fromName: cfg.name, from: cfg.from, to, replyTo: cfg.reply_to, subject, text, messageId,
    inReplyTo: i > 0 ? seq.touches[0].message_id : null, unsubUrl: uurl, date: now });
  try {
    const j = await ses(env, 'POST', '/v2/email/outbound-emails', { FromEmailAddress: cfg.from, Destination: { ToAddresses: [to] },
      ReplyToAddresses: [cfg.reply_to], Content: { Raw: { Data: b64(raw) } } }, { ...deps, now });
    return { ok: true, message_id: messageId, ses_id: j.MessageId || null, subject };
  } catch (e) { return { ok: false, definite: e.definite !== false, error: String(e.message || e) }; }
}

// ---------- HTTP ----------
const json = (o, s = 200) => new Response(JSON.stringify(o, null, 1), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const authed = (req, env) => Boolean(env.WORKER_TOKEN) && sameText(req.headers.get('authorization') || '', `Bearer ${env.WORKER_TOKEN}`);
const OPTOUT_PAGE = (done) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${done ? 'Done' : 'Stop these notes'}</title><body style="font:18px/1.5 Georgia,serif;max-width:34em;margin:3em auto;padding:0 1em;color:#333">${done ? '<p>Done. You won\'t get another note like this. Thank you, and sorry for the bother.</p>' : '<form method="post"><p>Tap the button and you won\'t get another note like this.</p><button style="font-size:18px;padding:.6em 1.2em">Stop these notes</button></form>'}</body>`;

export async function handle(req, env, deps = {}) {
  const u = new URL(req.url);
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (p === '/u') { // opt-out: GET shows a button (mail scanners can't opt people out by prefetching); POST = one-click
    const c = u.searchParams.get('c') || '', e = (u.searchParams.get('e') || '').toLowerCase(), t = u.searchParams.get('t') || '';
    if (!clients(env)[c] || !sameText(await unsubToken(env, c, e), t)) return new Response('This link is not valid.', { status: 403 });
    if (req.method !== 'POST') return new Response(OPTOUT_PAGE(false), { headers: { 'content-type': 'text/html; charset=utf-8' } });
    const s = new Set(await getJ(env.KV, `stopped:${c}`, []));
    if (!s.has(e)) { s.add(e); await env.KV.put(`stopped:${c}`, JSON.stringify([...s])); await log(env, c, { kind: 'opt_out', to: e }, Date.now()); }
    return new Response(OPTOUT_PAGE(true), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (p === '/') return new Response('ok', { status: 200 });
  if (!authed(req, env)) return json({ error: 'not allowed' }, 401);
  const body = req.method === 'POST' || req.method === 'PUT' ? await req.json().catch(() => ({})) : {};
  const cfgs = clients(env);
  const c = body.client || u.searchParams.get('client') || '';
  const cfg = cfgs[c];
  if (p === '/status') {
    const out = { stop: Boolean(await env.KV.get('STOP')), clients: {} };
    for (const [k, v] of Object.entries(cfgs)) {
      const seqs = (await env.KV.list({ prefix: `seq:${k}:` })).keys.length;
      out.clients[k] = { from: v.from, lock: (await env.KV.get(`lock:${k}`)) === 'open' ? 'OPEN' : 'shut', sequences: seqs,
        stopped: (await getJ(env.KV, `stopped:${k}`, [])).length, state: await getJ(env.KV, `state:${k}`, {}), aws_key: Boolean(env.AWS_ACCESS_KEY_ID), dkim_key: Boolean(env['DKIM_KEY_' + k.toUpperCase().replace(/-/g, '_')]) };
    }
    return json(out);
  }
  if (!cfg) return json({ error: 'unknown client' }, 400);
  if (p === '/stage' && req.method === 'POST') { // stage an approved-on-page sequence; it still can't send until the page shows approved + lock open
    const seq = body.sequence || {};
    if (!seq.id || !/^[a-z0-9-]{1,60}$/.test(seq.id) || !/^[^@\s<>]+@[^@\s<>]+\.[a-z]{2,}$/i.test(seq.to || '') || !seq.subject || !Array.isArray(seq.touches) || !seq.touches.length || seq.touches.length > 5 || !seq.signature)
      return json({ error: 'bad sequence' }, 400);
    for (const t of seq.touches) if (!t.text || !/^\d{4}-\d{2}-\d{2}$/.test(t.due || '')) return json({ error: 'each touch needs text and due YYYY-MM-DD' }, 400);
    const k = `seq:${c}:${seq.id}`;
    const old = await getJ(env.KV, k, null);
    if (old && old.touches.some((t) => t.sent_at)) return json({ error: 'already started; stage a new id' }, 409);
    const rec = { id: seq.id, client: c, to: String(seq.to).toLowerCase(), name: seq.name || '', subject: seq.subject, signature: seq.signature,
      touches: seq.touches.map((t) => ({ text: t.text, due: t.due })), approval: seq.approval, sig_approval: seq.sig_approval, staged_at: new Date().toISOString() };
    await env.KV.put(k, JSON.stringify(rec));
    return json({ staged: k, seq_sha: await seqSha(rec), sig_sha: await sigSha(rec.signature), approval_check: (await approvalOk(env, rec)) || 'approved' });
  }
  if (p === '/hash' && req.method === 'POST') { // what to put in the page register for a card (sha) before it goes on the page
    const s = body.sequence || {};
    return json({ seq_sha: await seqSha({ to: s.to, subject: s.subject, touches: s.touches || [], signature: s.signature }), sig_sha: await sigSha(s.signature) });
  }
  if (p === '/stopped' && req.method === 'POST') {
    const s = new Set(await getJ(env.KV, `stopped:${c}`, []));
    for (const e of body.emails || []) s.add(String(e).toLowerCase());
    await env.KV.put(`stopped:${c}`, JSON.stringify([...s]));
    return json({ stopped: s.size });
  }
  if (p === '/lock' && req.method === 'POST') { // only Rickey's GO for this client opens it
    if (body.open === true && body.confirm !== `open ${c}`) return json({ error: 'confirm must be "open <client>"' }, 400);
    if (body.open === true) await env.KV.put(`lock:${c}`, 'open'); else await env.KV.delete(`lock:${c}`);
    await log(env, c, { kind: body.open === true ? 'lock_opened' : 'lock_shut' }, Date.now());
    return json({ lock: body.open === true ? 'OPEN' : 'shut' });
  }
  if (p === '/log') {
    const ks = (await env.KV.list({ prefix: `log:${c}:`, limit: 1000 })).keys;
    const rows = []; for (const k of ks.slice(-200)) rows.push(await getJ(env.KV, k.name, null));
    return json({ rows });
  }
  if (p === '/aws/account') return json(await ses(env, 'GET', '/v2/email/account', undefined, deps).catch((e) => ({ error: e.message })));
  if (p === '/aws/identity') return json(await ses(env, 'GET', `/v2/email/identities/${cfg.identity}`, undefined, deps).catch((e) => ({ error: e.message })));
  if (p === '/aws/setup' && req.method === 'POST') { // one time: create the SES identity with our own DKIM key + the bounce MAIL FROM
    const key = env['DKIM_KEY_' + c.toUpperCase().replace(/-/g, '_')];
    if (!key) return json({ error: 'DKIM key secret not set' }, 400);
    const out = {};
    out.identity = await ses(env, 'POST', '/v2/email/identities', { EmailIdentity: cfg.identity,
      DkimSigningAttributes: { DomainSigningSelector: cfg.selector, DomainSigningPrivateKey: key } }, deps).catch((e) => ({ error: e.message }));
    out.mail_from = await ses(env, 'PUT', `/v2/email/identities/${cfg.identity}/mail-from`, { MailFromDomain: cfg.mail_from, BehaviorOnMxFailure: 'USE_DEFAULT_VALUE' }, deps).catch((e) => ({ error: e.message }));
    return json(out);
  }
  if (p === '/test' && req.method === 'POST') { // ONE test note, only to the client's test address, only once SES says verified
    const id = await ses(env, 'GET', `/v2/email/identities/${cfg.identity}`, undefined, deps).catch((e) => ({ error: e.message }));
    if (id.error) return json({ sent: false, why: id.error });
    if (!id.VerifiedForSendingStatus || (id.DkimAttributes || {}).Status !== 'SUCCESS') return json({ sent: false, why: 'subdomain not verified yet', dkim: (id.DkimAttributes || {}).Status, mail_from: (id.MailFromAttributes || {}).MailFromDomainStatus });
    if (await env.KV.get(`test_sent:${c}`) && body.again !== true) return json({ sent: false, why: 'test already sent; pass again:true for one more' });
    const seq = { id: 'test', to: cfg.test_to, subject: 'Test: referral note sender for ' + cfg.identity,
      signature: body.signature || `${cfg.name}`, touches: [{ text: 'This is a test of the referral note sender. It only ever goes to the Booked Out test inbox. Nothing went to any partner.' }] };
    const res = await sendTouch(env, cfg, c, seq, 0, Date.now(), deps);
    await log(env, c, { kind: res.ok ? 'test_sent' : 'test_failed', to: cfg.test_to, ...res }, Date.now());
    if (res.ok) await env.KV.put(`test_sent:${c}`, new Date().toISOString());
    return json({ sent: res.ok, ...res });
  }
  if (p === '/tick' && req.method === 'POST') return json(await tick(env, Date.now(), deps));
  return json({ error: 'not found' }, 404);
}

export default {
  async scheduled(_e, env, ctx) { ctx.waitUntil(tick(env, Date.now())); },
  async fetch(req, env) { try { return await handle(req, env); } catch (e) { return json({ error: 'server', detail: String(e.message || e) }, 500); } },
};
