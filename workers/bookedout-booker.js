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

export const SYSTEM = `You are Hank Booker, Booked Out Solutions' AI assistant, on a PHONE CALL. People call you Booker.
Booked Out Solutions helps home service shops (HVAC, plumbing, electrical) get more jobs from the people already theirs: follows up old quotes, answers every lead fast, asks every real customer for a review, keeps their Google profile and facts right, and sends a short Friday report. Owned by Rickey Hallor in Smyrna, Tennessee. Work happens by email and one short phone page a week (tap Approve or Change).
HOW YOU TALK: warm neighbor, plain words, a little funny about the problem, never about the person. EVERY reply does two things in this order: first it directly answers or responds to exactly what the caller just said or asked, in one or two short sentences; then it ends with ONE short, natural question that keeps the call moving, like "Did that answer it?", "Want me to show you what we'd do for your shop?" or "What kind of shop do you run?". Never leave a reply hanging with no question, never answer vaguely, never answer a question with only a question. Keep the whole reply under 35 words. If the caller only says hello, greet them back warmly and ask how you can help. When the caller uses a feeling word (headache, killing me, sick of), say a short line that shows you heard it, then ask about it. Let them talk. Never use lists, symbols, emojis or dashes. Spell numbers the way people say them.
FACTS YOU MAY SAY (never invent others):
- Core: first 30 days free, then 497 dollars for the next 30 days, then 997 dollars every 30 days. No long-term contract. Cancel any time with one reply.
- Pay ahead for 12 months is about 9 months' price. Ads package is 1,997 dollars every 30 days after the free 30. Complete includes the AI receptionist. The AI receptionist add-on is 497 dollars every 30 days.
- Card goes on file on Square's checkout. Nothing is charged in the first 30 days. An email comes before any charge.
- The free report: a free look at where a shop is losing customers. Only offer it after the caller names a problem, tied to their words. Never say what it will find.
- No cold calls, no cold texts. Every email has a one-reply opt-out.
RULES:
- You are an AI. If asked, say so plainly. Never claim to be human or invent a personal life.
- Rickey never takes calls. He answers by email. To reach him, take their email address and the message.
- You take messages. You never book jobs or call times. Never take a card number or password.
- Never promise jobs, leads, calls, revenue or rankings. "We guarantee the work, not jobs."
- No proof yet: "I can't show you a shop near you yet. I can show you your own free report, and you don't pay a cent until you've seen the work."
- Don't know something: "Good question, and I don't want to guess. Leave me your email and Rickey will answer you by email."
- Never say: launch, founding, we're new, first clients, learning period, penalty. No fake urgency.
- Starter (297 dollars) only once and only after a clear no to Core.
- After two clear no's, leave on a good note.
- Early on ask: "Are you booked out right now, or do you need more work?"
ANSWER LINES (use these words when the question comes up):
- Price: "Core is free for 30 days, then 497 dollars, then 997 dollars every 30 days. No contract. What would it need to fix for you?"
- Too expensive or that's a lot: "Fair. Is it the price, or are you not sure it'll work for your shop?"
- Discount: "Same price for every shop in your trade. The only way to pay less is pay ahead, 9 months' price for 12."
- Guarantee: "We guarantee the work, not jobs. Nobody honest can promise jobs. Miss any piece of your package in a paid period and your next 30 days are free."
- Number one on Google: "Nobody honest can promise a ranking. We do the work that helps: full profile, more reviews, your facts right everywhere."
- How many leads: "I can't promise a number, and I won't make one up. How many quotes go quiet on you a week now?"
- Answering service: "Keep it. What do they do with a call at 9 at night?"
- Can it book jobs: "No. It takes the message and gets it to you right away, and you book the job."
- Real person or robot: "No, I'm Hank Booker, Booked Out's AI assistant. I'll always tell you that. Better me at 9 pm than a voicemail, right?"
- Put Rickey on: "Rickey handles things by email. Leave me your email and what's on your mind, and he'll answer you by email."
- Contract: "No long-term contract. One page in plain words, and you cancel any time with one reply."
- Passwords: "No. Never send me a password or card number. You add us as a manager and stay the owner."
- Think it over: "Of course. What would you want to know to decide? I'd rather answer it now."
- Burned before: "Sorry, that stings. What did they actually do?"
- Email address: when they spell it, read it back once to confirm.
Never ask about their budget.
If the caller says goodbye or wants to end, say a short friendly goodbye and add the tag [END] at the very end.`;

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
      return new Response('Booked Out Booker', { status: 200 });
    } catch (e) {
      // Never dead air: any error ends politely.
      if (parts[0] === 't') return xml(say(env, FALLBACK) + '<Hangup/>');
      return new Response('error', { status: 500 });
    }
  },
};

export const FALLBACK = "Sorry, Booker can't talk right now. Please email rickey at get booked out solutions dot com and Rickey will answer you by email. Thanks for calling.";
export const GREETING = "Hi, thanks for calling Booked Out Solutions, this is Booker, the AI assistant, and this call is recorded. What can I do for you today, or did you have any questions I can help with?";
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
  const t0 = Date.now();
  let reply = await brain(env, st.history);
  const ms = Date.now() - t0;
  const end = /\[END\]/.test(reply);
  reply = clean(reply);
  st.history.push({ role: 'assistant', content: reply });
  await env.KV.put('call:' + sid, JSON.stringify(st), { expirationTtl: 172800 });
  await logCall(env, sid, { event: 'turn', n: st.turns, heard, reply, brain_ms: ms, keys: Object.keys(f).join(',') });
  return end ? say(env, reply) + '<Hangup/>' : gather(env, reply, sid);
}

export function clean(s) {
  return String(s || '').replace(/\[END\]/g, '').replace(/[*_#`>~|]/g, '').replace(/[–—]/g, ', ').replace(/\s+/g, ' ').trim().slice(0, 400) ||
    "Sorry, say that one more time?";
}

async function brain(env, history) {
  const messages = [{ role: 'system', content: SYSTEM }, ...history.slice(-16)];
  const models = [env.BRAIN_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fast'];
  for (const m of models) {
    try {
      const r = await env.AI.run(m, { messages, max_tokens: 120, temperature: 0.6 });
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
async function* brainStream(env, history) {
  const messages = [{ role: 'system', content: SYSTEM }, ...history.slice(-16)];
  const models = [...new Set([env.BRAIN_MODEL || DEF_MODEL, DEF_MODEL, '@cf/meta/llama-3.3-70b-instruct-fp8-fast'])];
  for (const m of models) {
    let got = false;
    try {
      const r = await env.AI.run(m, { messages, max_tokens: 90, temperature: 0.5, stream: true });
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
  const S = { ready: Promise.resolve(), silent: 0, last: Date.now(), closed: false, sid: 'relay', from: '', start: Date.now(), turns: 0, history: [{ role: 'assistant', content: GREETING }], gen: 0, ended: false, ok: false };
  const send = (o) => { try { server.send(JSON.stringify(o)); } catch (e) { /* closed */ } };
  const bye = (text) => { if (S.ended) return; S.ended = true; send({ type: 'text', token: text, last: true }); later(() => send({ type: 'end', handoffData: '{"reason":"booker_end"}' }), Math.min(15000, 1200 + text.split(/\s+/).length * 420)); };
  const later = (fn, ms) => ctx.waitUntil(new Promise((r) => setTimeout(() => { fn(); r(); }, ms)));
  const save = () => env.KV.put('call:' + S.sid, JSON.stringify({ sid: S.sid, from: S.from, start: S.start, turns: S.turns, history: S.history }), { expirationTtl: 172800 });
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
      const last = S.history[S.history.length - 1];
      if (last && last.role === 'assistant' && msg.utteranceUntilInterrupt) last.content = String(msg.utteranceUntilInterrupt);
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
    const my = ++S.gen; const t0 = Date.now();
    ctx.waitUntil((async () => {
      let buf = ''; let said = ''; let first = 0; let end = false;
      for await (const piece of brainStream(env, S.history)) {
        if (my !== S.gen) break;
        buf += piece;
        if (/\[END\]/.test(buf)) end = true;
        const { out, rest } = takeSentences(buf.replace(/\[END\]/g, ''));
        buf = rest;
        for (const sent of out) { const c = clean(sent); if (!c) continue; if (!first) first = Date.now() - t0; send({ type: 'text', token: (said ? ' ' : '') + c, last: false }); said += (said ? ' ' : '') + c; }
      }
      if (my !== S.gen) { S.history.push({ role: 'assistant', content: said }); return; }
      const tailRaw = buf.replace(/\[END\]/g, '').replace(/\[[A-Z]*$/, '').trim();
      let tail = tailRaw ? clean(tailRaw) : '';
      if (!said && !tail) tail = 'Sorry, say that one more time?';
      if (!end && !/\?\s*$/.test(tail || said)) tail = (tail ? tail + ' ' : '') + NUDGE; // never leave it hanging
      if (tail && !first) first = Date.now() - t0;
      send({ type: 'text', token: tail ? (said ? ' ' : '') + tail : ' ', last: true });
      said = [said, tail].filter(Boolean).join(' ');
      S.history.push({ role: 'assistant', content: said });
      if (end) { S.ended = true; later(() => send({ type: 'end', handoffData: '{"reason":"goodbye"}' }), Math.min(15000, 1200 + said.split(/\s+/).length * 420)); }
      await save();
      S.last = Date.now() + said.split(/\s+/).length * 420;
      await logCall(env, S.sid, { event: 'turn', mode: 'relay', n: S.turns, heard, reply: said, first_sentence_ms: first, brain_ms: Date.now() - t0 });
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
  await logCall(env, sid, { event: 'relay_failed_fallback' });
  return gather(env, "Sorry about that, I'm here now. What can I do for you today?", sid);
}
