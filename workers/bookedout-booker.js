// Booked Out Solutions - Booker phone line worker "bookedout-booker" (Nov 19 2026).
// Telnyx TeXML application -> this worker. Number +1 615 821 1607 (Telnyx trial).
// Routes (all under /t/<HOOK_TOKEN>/ so only Telnyx, which knows the token, can drive calls):
//   POST voice   new inbound call   -> greeting + speech Gather
//   POST turn    Gather result      -> brain reply + next Gather (or polite wrap-up)
//   POST status  call status        -> adds minutes to today's total, logs the call
//   POST fallback (voice fallback)  -> short "can't talk right now, email us" line
//   GET  calls   (needs ADMIN_TOKEN) -> today's minutes, caps and last calls (JSON)
// COST GUARDS (Rickey Nov 16: no surprise phone bill), all in our own code:
//   - Callers: before GO LIVE only numbers in ALLOWED_CALLERS get Booker; others hear a short line and hang up.
//   - Per call: MAX_CALL_SECONDS (default 480). Past it Booker says goodbye and hangs up.
//   - Per day: DAILY_MINUTE_CAP (default 30, Central day). At the cap Booker offers email and hangs up.
//   - Turns per call: MAX_TURNS (default 24).
//   - Telnyx trial balance is prepaid credit with no auto-recharge (hard ceiling).
// Brain: Cloudflare Workers AI (free tier) until the AWS key exists (BACKUPS doc: text brain fallback).
// Voice: BOOKER_VOICE (a Telnyx hosted voice id). Voice E (Chatterbox) is not on this path yet: see the build log.
// Storage (KV binding KV): call:<CallSid> (history, 2 days), day:<YYYY-MM-DD> (seconds used), log:<iso>:<CallSid> (90 days).
// No secrets in this file. Nothing here calls out to anyone.

const DEF = { MAX_CALL_SECONDS: 480, DAILY_MINUTE_CAP: 30, MAX_TURNS: 24 };

import { buildSystem, FACTS_PROMPT, parseFacts, quickFacts, guardPrice, guardSay, isGoodbye, goodbyeLine, pinned } from './booker-brain.js';
export const SYSTEM = buildSystem({});

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const parts = u.pathname.split('/').filter(Boolean);
    try {
      if (parts[0] === 't' && parts[1] && env.HOOK_TOKEN && parts[1] === env.HOOK_TOKEN) {
        const route = parts[2] || '';
        if (parts[2] === 'relay') return onRelay(req, env, ctx);
        const form = req.method === 'POST' ? await readForm(req) : Object.fromEntries(u.searchParams);
        if (route === 'after') return xml(await onAfter(form, env));
        if (route === 'voice') return xml(await onVoice(form, env));
        if (route === 'turn') return xml(await onTurn(form, env, u));
        if (route === 'status') return await onStatus(form, env);
        if (route === 'fallback') return xml(say(env, FALLBACK) + '<Hangup/>');
        return new Response('not found', { status: 404 });
      }
      if (parts[0] === 'calls' && env.ADMIN_TOKEN && u.searchParams.get('k') === env.ADMIN_TOKEN) return await calls(env);
      if (parts[0] === 'lab' && req.method === 'POST' && env.ADMIN_TOKEN && u.searchParams.get('k') === env.ADMIN_TOKEN) return await lab(req, env, parts[1]);
      return new Response('Booked Out Booker', { status: 200 });
    } catch (e) {
      // Never dead air: any error ends politely.
      if (parts[0] === 't') return xml(say(env, FALLBACK) + '<Hangup/>');
      return new Response('error', { status: 500 });
    }
  },
};

export const FALLBACK = "Sorry, Booker can't talk right now. Please email rickey at get booked out solutions dot com and Rickey will answer you by email. Thanks for calling.";
export const GREETING = "Hi, thanks for calling Booked Out Solutions, this is Booker, the AI assistant. Just a heads up, this call's recorded so we can take good care of you. Who do I have the pleasure of talking to today?";
export const NOT_OPEN = "Thanks for calling Booked Out Solutions. This line isn't open yet. Please email rickey at get booked out solutions dot com and Rickey will answer you by email. Goodbye.";
export const CAP_LINE = "I've hit my phone time for today. Please email rickey at get booked out solutions dot com and Rickey will answer you by email. Thanks for calling.";
export const TIME_LINE = "I've got to let you go, we're at my time limit for one call. Email rickey at get booked out solutions dot com and he'll pick it up. Thanks for calling.";

function n(env, k) { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : DEF[k]; }
export function centralDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
export function allowed(env, from) {
  const list = String(env.ALLOWED_CALLERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (String(env.GO_LIVE || '') === 'true') return true;
  return list.includes(String(from || '').trim());
}
export function esc(s) { return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c])); }
function say(env, text) { return `<Say voice="${esc(env.BOOKER_VOICE || 'Telnyx.KokoroTTS.am_michael')}">${esc(text)}</Say>`; }
function xml(body) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { headers: { 'content-type': 'application/xml' } });
}
async function readForm(req) {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('application/json')) return await req.json();
  const t = await req.text();
  return Object.fromEntries(new URLSearchParams(t));
}
function gather(env, text, sid) {
  const base = `${env.SELF_URL || ''}/t/${env.HOOK_TOKEN}`;
  return `<Gather input="speech" action="${base}/turn" speechTimeout="1" timeout="6" language="en-US">${say(env, text)}</Gather>` +
    `<Redirect>${base}/turn?silent=1</Redirect>`;
}
async function daySeconds(env) { return Number((await env.KV.get('day:' + centralDay())) || 0); }

export async function onVoice(f, env) {
  const sid = f.CallSid || f.call_sid || 'unknown';
  const from = f.From || f.from || '';
  if (!allowed(env, from)) { await logCall(env, sid, { event: 'blocked', from }); return say(env, NOT_OPEN) + '<Hangup/>'; }
  if ((await daySeconds(env)) >= n(env, 'DAILY_MINUTE_CAP') * 60) { await logCall(env, sid, { event: 'cap', from }); return say(env, CAP_LINE) + '<Hangup/>'; }
  const st = { sid, from, start: Date.now(), turns: 0, history: [{ role: 'assistant', content: GREETING }], silent: 0 };
  await env.KV.put('call:' + sid, JSON.stringify(st), { expirationTtl: 172800 });
  await logCall(env, sid, { event: 'start', from, mode: relayMode(env) ? 'relay' : 'gather' });
  if (relayMode(env)) return relayTeXML(env, sid, from);
  return gather(env, GREETING, sid);
}

export async function onTurn(f, env, u) {
  const sid = f.CallSid || f.call_sid || 'unknown';
  const st = JSON.parse((await env.KV.get('call:' + sid)) || 'null') || { sid, start: Date.now(), turns: 0, history: [], silent: 0 };
  const heard = String(f.SpeechResult || f.Speech || f.speech || f.Digits || '').trim();
  const elapsed = (Date.now() - st.start) / 1000;
  if (elapsed >= n(env, 'MAX_CALL_SECONDS') || st.turns >= n(env, 'MAX_TURNS')) {
    await logCall(env, sid, { event: 'time_limit', elapsed });
    return say(env, TIME_LINE) + '<Hangup/>';
  }
  if (!heard) {
    st.silent = (st.silent || 0) + 1;
    await env.KV.put('call:' + sid, JSON.stringify(st), { expirationTtl: 172800 });
    if (st.silent >= 2) return say(env, "I'll let you go. Email rickey at get booked out solutions dot com any time. Take care.") + '<Hangup/>';
    return gather(env, 'You still there?', sid);
  }
  st.silent = 0; st.turns += 1;
  st.history.push({ role: 'user', content: heard.slice(0, 800) });
  st.facts = quickFacts(heard, st.facts || {});
  const t0 = Date.now();
  let reply = await brain(env, st.history, st.facts);
  const ms = Date.now() - t0;
  const end = /\[END\]/.test(reply);
  reply = (reply.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [reply]).filter((x) => x.trim()).map((x) => guardSay(clean(x), { ...(st.facts || {}), _said: saidBy(st.history) })).join(' ');
  st.history.push({ role: 'assistant', content: reply });
  st.facts = await updateFacts(env, st.history, st.facts);
  await env.KV.put('call:' + sid, JSON.stringify(st), { expirationTtl: 172800 });
  await logCall(env, sid, { event: 'turn', n: st.turns, heard, reply, brain_ms: ms, facts: st.facts });
  return end ? say(env, reply) + '<Hangup/>' : gather(env, reply, sid);
}

export function clean(s) {
  return String(s || '').replace(/\$\s?([\d,]+(?:\.\d\d)?)(?:\s*dollars)?/g, '$1 dollars').replace(/\[END\]/g, '').replace(/[*_#`>~|]/g, '').replace(/[–—]/g, ', ').replace(/\s+/g, ' ').trim().slice(0, 1200) ||
    "Sorry, say that one more time?";
}

// Every turn sends the WHOLE call so far (no trimming: the Nov 19 nail salon call lost turn 2 to a 16-message cut)
// plus the caller facts note and the library entries for what was just asked.
export function buildMessages(history, facts = {}) {
  const h = [];
  for (const m of history) { const c = String(m.content || '').trim(); if (!c) continue; const last = h[h.length - 1]; if (last && last.role === m.role) last.content += ' ' + c; else h.push({ role: m.role, content: c }); }
  const recent = h.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ');
  return [{ role: 'system', content: buildSystem({ facts, recent }) }, ...h];
}
const FACTS_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export async function updateFacts(env, history, facts) {
  try {
    const convo = history.filter((m) => m.content).map((m) => `${m.role === 'user' ? 'CALLER' : 'BOOKER'}: ${m.content}`).join('\n').slice(-6000);
    const r = await env.AI.run(FACTS_MODEL, { messages: [{ role: 'system', content: FACTS_PROMPT }, { role: 'user', content: convo + '\nKnown so far: ' + JSON.stringify(facts) }], max_tokens: 120, temperature: 0 });
    return parseFacts(r && (r.response ?? ''), facts);
  } catch (e) { return facts; }
}
async function brain(env, history, facts = {}) {
  const messages = buildMessages(history, facts);
  const models = [env.BRAIN_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fast'];
  for (const m of models) {
    try {
      const r = await env.AI.run(m, { messages, max_tokens: 260, temperature: 0.6 });
      const t = r && (r.response || (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content));
      if (t && String(t).trim()) return String(t);
    } catch (e) { /* try next */ }
  }
  return "Good question, and I don't want to guess. Leave me your email and Rickey will answer you by email.";
}

export async function onStatus(f, env) {
  const sid = f.CallSid || f.call_sid || 'unknown';
  const status = f.CallStatus || f.call_status || '';
  const dur = Number(f.CallDuration || f.call_duration || f.Duration || 0);
  if (/completed|busy|failed|no-answer|canceled/i.test(status)) {
    const key = 'day:' + centralDay();
    let secs = Number(dur) || 0;
    if (!secs) { const st = JSON.parse((await env.KV.get('call:' + sid)) || 'null'); if (st) secs = Math.round((Date.now() - st.start) / 1000); }
    const done = await env.KV.get('done:' + sid);
    if (!done) {
      await env.KV.put(key, String((await daySeconds(env)) + secs), { expirationTtl: 60 * 60 * 24 * 40 });
      await env.KV.put('done:' + sid, '1', { expirationTtl: 172800 });
    }
    await logCall(env, sid, { event: 'end', status, seconds: secs });
  }
  return new Response('ok');
}

async function logCall(env, sid, row) {
  const now = new Date().toISOString();
  await env.KV.put(`log:${now}:${sid}`, JSON.stringify({ time: now, sid, ...row }), { expirationTtl: 60 * 60 * 24 * 90 });
}

async function calls(env) {
  const keys = (await env.KV.list({ prefix: 'log:' })).keys.slice(-200);
  const rows = [];
  for (const k of keys) rows.push(JSON.parse((await env.KV.get(k.name)) || '{}'));
  return new Response(JSON.stringify({
    today: centralDay(), seconds_today: await daySeconds(env),
    caps: { daily_minutes: n(env, 'DAILY_MINUTE_CAP'), per_call_seconds: n(env, 'MAX_CALL_SECONDS'), max_turns: n(env, 'MAX_TURNS') },
    go_live: String(env.GO_LIVE || '') === 'true', rows,
  }, null, 1), { headers: { 'content-type': 'application/json' } });
}

// ---- Fast path (Nov 19 3:40 pm, Rickey's test call: ~10 s gaps on the Gather path) ----
// Telnyx <Connect><ConversationRelay>: Telnyx runs speech-to-text (Deepgram Flux end-of-turn), text-to-speech and barge-in;
// this worker gets the caller's words over a WebSocket and streams Booker's reply back sentence by sentence,
// so the voice starts on the first sentence. Price: Telnyx $0.05 a minute (pay as you go) on top of the call minute.
// BOOKER_MODE=gather switches back to the old Gather path with one setting.
const DEF_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const NUDGE = 'What else can I help you with?';
export function relayMode(env) { return String(env.BOOKER_MODE || 'relay') !== 'gather'; }
export function relayTeXML(env, sid, from = '') {
  const base = `${env.SELF_URL || ''}/t/${env.HOOK_TOKEN}`;
  const wss = base.replace(/^http/, 'ws') + '/relay';
  return `<Connect action="${esc(base + '/after')}"><ConversationRelay url="${esc(wss)}" voice="${esc(env.BOOKER_VOICE || 'Telnyx.KokoroTTS.am_michael')}" language="en-US" transcriptionProvider="deepgram" speechModel="flux" interruptible="speech" welcomeGreetingInterruptible="speech" welcomeGreeting="${esc(GREETING)}"><Parameter name="sid" value="${esc(sid)}"/><Parameter name="from" value="${esc(from)}"/></ConversationRelay></Connect>`;
}
// Split streamed text into speakable pieces: send each finished sentence at once.
export function takeSentences(buf) {
  const out = []; let rest = buf; let m;
  while ((m = rest.match(/^([\s\S]*?[.!?])\s+/))) { if (m[1].trim()) out.push(m[1].trim()); rest = rest.slice(m[0].length); }
  return { out, rest };
}
async function* brainStream(env, history, facts = {}) {
  const messages = buildMessages(history, facts);
  const models = [...new Set([env.BRAIN_MODEL || DEF_MODEL, DEF_MODEL, '@cf/meta/llama-3.3-70b-instruct-fp8-fast'])];
  for (const m of models) {
    let got = false;
    try {
      const r = await env.AI.run(m, { messages, max_tokens: 260, temperature: 0.5, stream: true });
      if (r && typeof r.getReader === 'function') {
        const rd = r.pipeThrough(new TextDecoderStream()).getReader(); let carry = '';
        for (;;) {
          const { value, done } = await rd.read(); if (done) break;
          carry += value; const lines = carry.split('\n'); carry = lines.pop();
          for (const ln of lines) {
            const t = ln.replace(/^data:\s*/, '').trim(); if (!t || t === '[DONE]') continue;
            try { const j = JSON.parse(t); const piece = j.response ?? (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) ?? ''; if (piece) { got = true; yield piece; } } catch (e) { /* skip */ }
          }
        }
      } else {
        const t = r && (r.response || (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content));
        if (t && String(t).trim()) { got = true; yield String(t); }
      }
    } catch (e) { if (got) return; }
    if (got) return;
  }
  yield "Good question, and I don't want to guess. Leave me your email and Rickey will answer you by email. Is there anything else I can help with?";
}
export function onRelay(req, env, ctx) {
  if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
  const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
  server.accept();
  const S = { ready: Promise.resolve(), silent: 0, last: Date.now(), closed: false, sid: 'relay', from: '', start: Date.now(), turns: 0, history: [{ role: 'assistant', content: GREETING }], facts: {}, cur: null, gen: 0, ended: false, ok: false };
  const send = (o) => { try { server.send(JSON.stringify(o)); } catch (e) { /* closed */ } };
  const bye = (text) => { if (S.ended) return; S.ended = true; S.gen++; send({ type: 'text', token: text, last: true }); later(() => send({ type: 'end', handoffData: '{"reason":"booker_end"}' }), Math.min(15000, 1200 + text.split(/\s+/).length * 420)); };
  const later = (fn, ms) => ctx.waitUntil(new Promise((r) => setTimeout(() => { fn(); r(); }, ms)));
  const save = () => env.KV.put('call:' + S.sid, JSON.stringify({ sid: S.sid, from: S.from, start: S.start, turns: S.turns, history: S.history, facts: S.facts }), { expirationTtl: 172800 });
  server.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    S.last = Date.now();
    if (msg.type === 'setup') {
      const cp = msg.customParameters || {};
      S.sid = cp.sid || msg.callSid || 'relay'; S.from = cp.from || msg.from || '';
      if (!cp.sid) ctx.waitUntil(logCall(env, S.sid, { event: 'relay_no_sid_param', callSid: msg.callSid || '' }));
      S.ready = (async () => {
        const st = JSON.parse((await env.KV.get('call:' + S.sid)) || 'null');
        // onVoice only writes call:<sid> for callers it let through, so either check is enough
        S.ok = allowed(env, S.from) || !!st;
        if (st && st.start) S.start = st.start;
        if (!S.ok) { bye(NOT_OPEN); return; }
        await env.KV.put('relayok:' + S.sid, '1', { expirationTtl: 172800 });
      })();
      ctx.waitUntil(S.ready);
      // warm the brain while the greeting plays, so the first answer is not a cold start
      ctx.waitUntil(env.AI.run(env.BRAIN_MODEL || DEF_MODEL, { messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: 'hi' }], max_tokens: 1 }).catch(() => null));
      // hard per-call time cap and silence guard, even if the caller never speaks
      const left = Math.max(5000, n(env, 'MAX_CALL_SECONDS') * 1000 - (Date.now() - S.start));
      later(() => { if (!S.ended) { ctx.waitUntil(logCall(env, S.sid, { event: 'time_limit_timer' })); bye(TIME_LINE); } }, left);
      S.last = Date.now() + 9000; // greeting is playing
      ctx.waitUntil(new Promise((resolve) => {
        const iv = setInterval(() => {
          if (S.ended || S.closed) { clearInterval(iv); resolve(); return; }
          if (Date.now() - S.last < 20000) return;
          S.silent = (S.silent || 0) + 1; S.last = Date.now();
          if (S.silent === 1) { send({ type: 'text', token: 'You still there?', last: true }); S.history.push({ role: 'assistant', content: 'You still there?' }); }
          else { bye("I'll let you go. Email rickey at get booked out solutions dot com any time. Take care."); clearInterval(iv); resolve(); }
        }, 4000);
      }));
      return;
    }
    if (msg.type === 'interrupt') {
      S.gen++; // stop the reply being spoken
      if (S.cur && msg.utteranceUntilInterrupt) S.cur.content = String(msg.utteranceUntilInterrupt);
      return;
    }
    if (msg.type !== 'prompt' || msg.last === false || S.ended) return;
    const heard = String(msg.voicePrompt || '').trim(); if (!heard) return;
    ctx.waitUntil((async () => { await S.ready; if (!S.ok || S.ended) return; S.silent = 0; onPrompt(heard); })());
  });
  const onPrompt = (heard) => {
    const elapsed = (Date.now() - S.start) / 1000;
    if (elapsed >= n(env, 'MAX_CALL_SECONDS') || S.turns >= n(env, 'MAX_TURNS')) { ctx.waitUntil(logCall(env, S.sid, { event: 'time_limit', elapsed })); bye(TIME_LINE); return; }
    S.turns += 1; S.history.push({ role: 'user', content: heard.slice(0, 800) });
    S.facts = quickFacts(heard, S.facts);
    if (isGoodbye(heard)) { const g = goodbyeLine(S.facts); S.history.push({ role: 'assistant', content: g }); ctx.waitUntil(logCall(env, S.sid, { event: 'turn', mode: 'relay', n: S.turns, heard, reply: g, first_sentence_ms: 0, facts: S.facts })); ctx.waitUntil(save()); bye(g); return; }
    const cur = { role: 'assistant', content: '' }; S.history.push(cur); S.cur = cur;
    const pin = pinned(heard, S.facts);
    if (pin) { const my0 = ++S.gen; cur.content = pin; send({ type: 'text', token: pin, last: true }); S.last = Date.now() + pin.split(/\s+/).length * 420; ctx.waitUntil((async () => { S.facts = await updateFacts(env, S.history, S.facts); await save(); await logCall(env, S.sid, { event: 'turn', mode: 'relay', n: S.turns, heard, reply: pin, pinned: true, first_sentence_ms: 0, facts: S.facts }); })()); return; } // keeps turn order right even if the caller talks over Booker
    const my = ++S.gen; const t0 = Date.now();
    ctx.waitUntil((async () => {
      let buf = ''; let said = ''; let first = 0; let end = false; let long = false;
      for await (const piece of brainStream(env, S.history.filter((m) => m !== cur), S.facts)) {
        if (my !== S.gen) break;
        buf += piece;
        if (/\[END\]/.test(buf)) end = true;
        const { out, rest } = takeSentences(buf.replace(/\[END\]/g, ''));
        buf = rest;
        for (const sent of out) { if (said.split(/\s+/).length > 85) { long = true; continue; } const c = guardSay(clean(sent), { ...S.facts, _said: saidBy(S.history) }); if (!c) continue; if (!first) first = Date.now() - t0; send({ type: 'text', token: (said ? ' ' : '') + c, last: false }); said += (said ? ' ' : '') + c; cur.content = said; }
      }
      if (my !== S.gen) { if (!cur.content) cur.content = said; ctx.waitUntil(updateFacts(env, S.history, S.facts).then((f) => { S.facts = f; return save(); })); return; }
      const tailRaw = buf.replace(/\[END\]/g, '').replace(/\[[A-Z]*$/, '').trim();
      let tail = (tailRaw && !long) ? guardSay(clean(tailRaw), { ...S.facts, _said: saidBy(S.history) }) : '';
      if (long) tail = 'Want the rest of that by email?'; // hard length cap, about 85 words
      if (!said && !tail) tail = 'Sorry, say that one more time?';
      if (!end && !/\?\s*$/.test(tail || said)) tail = (tail ? tail + ' ' : '') + NUDGE; // never leave it hanging
      if (tail && !first) first = Date.now() - t0;
      send({ type: 'text', token: tail ? (said ? ' ' : '') + tail : ' ', last: true });
      said = [said, tail].filter(Boolean).join(' ');
      cur.content = said;
      if (end) { S.ended = true; later(() => send({ type: 'end', handoffData: '{"reason":"goodbye"}' }), Math.min(15000, 1200 + said.split(/\s+/).length * 420)); }
      S.last = Date.now() + said.split(/\s+/).length * 420;
      const brainMs = Date.now() - t0;
      S.facts = await updateFacts(env, S.history, S.facts);
      await save();
      await logCall(env, S.sid, { event: 'turn', mode: 'relay', n: S.turns, heard, reply: said, first_sentence_ms: first, brain_ms: brainMs, facts: S.facts });
    })());
  };
  server.addEventListener('close', () => { S.gen++; S.closed = true; });
  return new Response(null, { status: 101, webSocket: client });
}

// After the relay ends. If the relay never connected (no setup frame), the caller is not left in dead air:
// fall back to the old Gather path for the rest of the call.
export async function onAfter(f, env) {
  const sid = f.CallSid || f.call_sid || 'unknown';
  if (await env.KV.get('relayok:' + sid)) return '<Hangup/>';
  const st = JSON.parse((await env.KV.get('call:' + sid)) || 'null'); if (st && st.turns > 0) return '<Hangup/>';
  await logCall(env, sid, { event: 'relay_failed_fallback' });
  return gather(env, "Sorry about that, I'm here now. What can I do for you today?", sid);
}

// Test bench (needs ADMIN_TOKEN): runs the exact prompt, library look-up and model the phone line uses.
// POST /lab {model, history, facts} -> reply + time to first sentence; POST /lab/facts {history, facts} -> facts.
async function lab(req, env, what) {
  const b = await req.json();
  if (what === 'facts') return Response.json({ facts: await updateFacts(env, b.history || [], b.facts || {}) });
  const lastU = (b.history || []).filter((m) => m.role === 'user').slice(-1).map((m) => m.content).join(' ');
  const pin = pinned(lastU, quickFacts(lastU, b.facts || {})); if (pin) return Response.json({ reply: pin, end: false, first_ms: 0, total_ms: 0, sys_chars: 0, pinned: true, facts: quickFacts(lastU, b.facts || {}) });
  if (isGoodbye(lastU)) return Response.json({ reply: goodbyeLine(b.facts || {}), end: true, first_ms: 0, total_ms: 0, sys_chars: 0, facts: b.facts || {} });
  const t0 = Date.now(); let first = 0; let text = '';
  const e2 = { ...env, BRAIN_MODEL: b.model || env.BRAIN_MODEL };
  const facts = quickFacts((b.history || []).filter((m) => m.role === 'user').slice(-1).map((m) => m.content).join(' '), b.facts || {});
  try {
    for await (const piece of brainStreamOnly(e2, b.history || [], facts)) { text += piece; if (!first && /[.!?]\s/.test(text)) first = Date.now() - t0; }
  } catch (e) { return Response.json({ error: String(e) }); }
  const sys = buildMessages(b.history || [], facts)[0].content;
  let rep = ''; let long = false; for (const x of (text.replace(/\[END\]/g, '').match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []).filter((y) => y.trim())) { if (rep.split(/\s+/).length > 85) { long = true; break; } const g = guardSay(clean(x), { ...facts, _said: saidBy(b.history || []) }); if (g) rep += (rep ? ' ' : '') + g; }
  if (long) rep += ' Want the rest of that by email?'; if (!/\[END\]/.test(text) && !/\?\s*$/.test(rep)) rep += ' ' + NUDGE; // same rule as the phone path
  return Response.json({ reply: rep, end: /\[END\]/.test(text), first_ms: first || Date.now() - t0, total_ms: Date.now() - t0, sys_chars: sys.length, facts });
}
async function* brainStreamOnly(env, history, facts) {
  const m = env.BRAIN_MODEL;
  const r = await env.AI.run(m, { messages: buildMessages(history, facts), max_tokens: 260, temperature: 0.5, stream: true });
  if (r && typeof r.getReader === 'function') {
    const rd = r.pipeThrough(new TextDecoderStream()).getReader(); let carry = '';
    for (;;) { const { value, done } = await rd.read(); if (done) break; carry += value; const lines = carry.split('\n'); carry = lines.pop();
      for (const ln of lines) { const t = ln.replace(/^data:\s*/, '').trim(); if (!t || t === '[DONE]') continue; try { const j = JSON.parse(t); const p = j.response ?? (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) ?? ''; if (p) yield p; } catch (e) { /* skip */ } } }
  } else { const t = r && (r.response || (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content)); if (t) yield String(t); }
}

function saidBy(history) { return (history || []).filter((m) => m.role === 'user').map((m) => m.content).join(' '); }
