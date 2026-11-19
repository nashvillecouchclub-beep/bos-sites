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
HOW YOU TALK: warm neighbor, plain words, a little funny about the problem, never about the person. Most replies are ONE short sentence plus ONE question, under 25 words total. When the caller uses a feeling word (headache, killing me, sick of), echo it as a question ("Headache how?"). When the caller asks a direct question, answer it straight first with the matching line below, then ask one question. Let them talk. Never use lists, symbols, emojis or dashes. Spell numbers the way people say them.
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
        const form = req.method === 'POST' ? await readForm(req) : Object.fromEntries(u.searchParams);
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
export const GREETING = "I'm Hank Booker, Booked Out's AI assistant. Everybody around here just calls me Booker. This call is recorded. Before I show you anything, what's eating your evenings right now?";
export const NOT_OPEN = "Thanks for calling Booked Out Solutions. This line isn't open yet. Please email rickey at get booked out solutions dot com and Rickey will answer you by email. Goodbye.";
export const CAP_LINE = "I've hit my phone time for today. Leave your email with Rickey at rickey at get booked out solutions dot com and he'll answer you by email. Thanks for calling.";
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
  return `<Gather input="speech" action="${base}/turn" speechTimeout="2" timeout="8" language="en-US">${say(env, text)}</Gather>` +
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
  await logCall(env, sid, { event: 'start', from });
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
  return String(s || '').replace(/\[END\]/g, '').replace(/[*_#`>~|]/g, '').replace(/\s*[–—]\s*/g, ', ').replace(/\p{Extended_Pictographic}/gu, '').replace(/\s+/g, ' ').trim().slice(0, 400) ||
    "Sorry, say that one more time?";
}

async function brain(env, history) {
  const messages = [{ role: 'system', content: SYSTEM }, ...history.slice(-16)];
  const models = [env.BRAIN_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct-fast'];
  for (const m of models) {
    try {
      const r = await Promise.race([env.AI.run(m, { messages, max_tokens: 120, temperature: 0.6 }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))]);
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
  const since = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
  let keys = [];
  for (let d = 0; d < 4; d++) { const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10); keys = keys.concat((await env.KV.list({ prefix: 'log:' + day })).keys); }
  keys = keys.filter((k) => k.name.slice(4, 14) >= since).sort((a, b) => (a.name < b.name ? -1 : 1)).slice(-200);
  const rows = [];
  for (const k of keys) rows.push(JSON.parse((await env.KV.get(k.name)) || '{}'));
  return new Response(JSON.stringify({
    today: centralDay(), seconds_today: await daySeconds(env),
    caps: { daily_minutes: n(env, 'DAILY_MINUTE_CAP'), per_call_seconds: n(env, 'MAX_CALL_SECONDS'), max_turns: n(env, 'MAX_TURNS') },
    go_live: String(env.GO_LIVE || '') === 'true', rows,
  }, null, 1), { headers: { 'content-type': 'application/json' } });
}
