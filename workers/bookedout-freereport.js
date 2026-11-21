// Booked Out Solutions - free report worker "bookedout-freereport" (Nov 16 2026).
// Saves each free report request from getbookedoutsolutions.com, builds the one-page report,
// and keeps the 1-business-day clock. The site (Cloudflare Pages, its _worker.js) passes /api/free-report*
// and /r/* on our domain to this worker, so visitors only ever see our domain.
//
// Routes:
//   POST /api/free-report                 the form (JSON) -> {saved:true, id}
//   GET  /api/free-report/ping            health check
//   GET  /api/free-report/status?k=KEY    open requests with due times, check marks, plus the watch list (watchdog)
//   GET  /api/free-report/review?k=KEY    reports waiting for the 2-agent check, with the lookup data to trace every fact
//   POST /api/free-report/check           {id, k, checker: 1|2, agent, result: "pass"|"fail", hash, notes}
//                                         one check mark. Checker 1 and checker 2 must be different agents, and a pass
//                                         only counts for the exact report version it read (hash). Any change to the
//                                         report clears both marks. A fail holds the report and goes on the watch list.
//   POST /api/free-report/mark-sent       {id, k} -> status "sent", clock stops (only for a report sent some other way)
//   POST /api/free-report/fill            {id, k, section, data} -> a later job fills a pending section
//                                         section: "google" | "reviews" | "ai" | "booking" | "category" |
//                                         "speed" | "known_for" | "competitor" | "listings" | "spot" (Nov 20; shapes in DEPLOY.md)
//   POST /api/free-report/rerender        {k} -> every open report rendered again with the current code (once after a deploy)
//   POST /api/free-report/shot            {id, k, engine: "chatgpt"|"gemini"|"google_ai", png: "<base64>"} -> {url} (url ends ?v=<sha8>)
//                                         hosts one AI answer screenshot in KV (PNG only, up to 1 MB) for the ai fill;
//                                         refused once the report is checked or when the engine already has another image
//   GET  /r/<token>/                      the report page (noindex, no-store, no-referrer)
//   GET  /r/<token>/ai-<engine>.png       a hosted AI answer screenshot (same token as the page)
// Cron (every 15 minutes): build new reports; send reports that have two pass marks (only when LIVE is on);
// put clock trouble (75% of the clock, overdue), failed checks and failed sends on the watch list.
// Rickey is out of the workflow (Nov 16 4:46 pm): no per-report emails to him, no "check and send", no 75% or overdue
// emails. Claude checks, a second separate Claude agent checks, then the report goes to the owner automatically.
// The watchdog reads the watch list and the agents fix it.
//
// Statuses: new -> built -> (check 1 pass + check 2 pass) checked -> sent.  A failed check -> held (fixed, re-checked).
//
// Storage (KV binding KV):
//   req:<id>      the request and its clock {status: new | built | held | checked | sent, checks, ...}
//   open:<id>     marker while the request is not sent (the cron reads these)
//   tok:<token>   report token -> id
//   rep:<id>      the report page HTML
//   shot:<id>:<engine>  one AI answer screenshot {v: first 8 of its sha, png: base64}, kept as long as the report
//   rl:<email>    one request per email per 10 minutes
//   lead:<id>     every lead, kept for good (no expiry): name, business, contact, trade, town, when, page
//   watch:<time>:<id>  a problem for the watchdog (warn = 75% of the clock, problem = overdue, failed check or failed send), 30 days
//   alert:last    the last watch entry written
//
// Settings (names only, values are added in the Cloudflare dashboard, never here):
//   LOOKUP_URL, LOOKUP_KEY   optional; the lookup worker. Without them the Google parts say "pending check".
//   STATUS_KEY               needed for status, review, check, mark-sent and fill.
//   LIVE                     "off" by default. While off, nothing is ever sent to a business owner.
//   SPEED_TEST_LIVE          "off" by default. While off, a tested answer speed result for a real shop is refused (403):
//                            that test contacts a real business, so it waits until after GO LIVE.
//   SEND_ROUTE               "gmail" (picked, Nov 16 night), "cloudflare" or "resend" (the backups). See sendMail().
//   SEND_FROM                default "Rickey Hallor <rickey@getbookedoutsolutions.com>"
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN   for "gmail" (Gmail API on our own Workspace mailbox)
//   EMAIL (send_email binding)                                  for "cloudflare" (Cloudflare Email Sending, Workers Paid)
//   RESEND_KEY                                                  for "resend"
// No alerts to anyone (no host forms, no email to Rickey). The only email is the report to the owner who asked for it.
// No secrets in this file.

import * as FU from './freereport-followups.js';

const SITE = 'https://getbookedoutsolutions.com';
const TZ = 'America/Chicago';
const DAY = 86400;
const ID = /^fr-[0-9]{8}-[a-z0-9]{6}$/;
const TOK = /^[a-f0-9]{48}$/;

const TRADES = {
  'Heating and air': { slug: 'hvac', kw: 'hvac', price: 'price-hvac.html' },
  'Plumbing': { slug: 'plumbing', kw: 'plumber', price: 'price-plumbing.html' },
  'Electrical': { slug: 'electrical', kw: 'electrician', price: 'price-electrical.html' },
  'Something else': { slug: 'other', kw: '', price: 'free-look.html' },
};
const REVENUE = {
  'Under $250K': [0, 250000],
  '$250K to $500K': [250000, 500000],
  '$500K to $1M': [500000, 1000000],
  '$1M to $3M': [1000000, 3000000],
  'Over $3M': [3000000, 0],
  'Rather not say': null,
};
const BIG = ['$1M to $3M', 'Over $3M'];

// ---------- validation (the page uses the same rules) ----------
function validate(b) {
  const s = (k, n) => String((b && b[k]) == null ? '' : b[k]).trim().slice(0, n);
  const c = {
    first_name: s('first_name', 200), business_name: s('business_name', 300), email: s('email', 300).toLowerCase(),
    phone: s('phone', 60), town: s('town', 200), trade: s('trade', 40) || 'Something else',
    note: s('note', 5000), revenue: s('revenue', 40),
    consent: b && (b.consent === true || b.consent === 'yes' || b.consent === 'on'),
    page: s('page', 120),
  };
  const e = {};
  if (c.first_name.length < 1 || c.first_name.length > 60) e.first_name = 'Please add your first name.';
  if (c.business_name.length < 2 || c.business_name.length > 120) e.business_name = 'Please add your business name.';
  if (!/^[^\s@<>()",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(c.email) || c.email.length > 160) e.email = 'Please check your email address. It should look like name@yourbusiness.com.';
  let n = c.phone.replace(/\D/g, '');
  if (n.length === 11 && n[0] === '1') n = n.slice(1);
  if (!/^[2-9]\d{9}$/.test(n)) e.phone = 'Please add a phone number with area code, like 615 555 0123.';
  else c.phone = `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  if (c.town.length < 2 || c.town.length > 80) e.town = 'Please add the town your business is in.';
  if (!TRADES[c.trade]) e.trade = 'Please pick your trade.';
  if (c.note.length > 1000) e.note = 'Please keep this under 1,000 characters.';
  if (c.revenue && !(c.revenue in REVENUE)) e.revenue = 'Please pick one of the choices.';
  return { ok: !Object.keys(e).length, errors: e, clean: c };
}

// ---------- the 1-business-day clock (America/Chicago) ----------
const FMT = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' });
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function local(date) {
  const o = {};
  for (const p of FMT.formatToParts(date)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, dow: WD.indexOf(o.weekday) };
}
function fromLocal(y, m, d, h, mi) {
  const want = Date.UTC(y, m - 1, d, h, mi);
  let t = want + 6 * 3600e3;
  for (let i = 0; i < 3; i++) {
    const p = local(new Date(t));
    const diff = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - want;
    if (!diff) break;
    t -= diff;
  }
  return new Date(t);
}
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
function nth(y, m, dow, n) {
  if (n > 0) { const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); return 1 + ((dow - first + 7) % 7) + 7 * (n - 1); }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate(), lw = new Date(Date.UTC(y, m - 1, last)).getUTCDay();
  return last - ((lw - dow + 7) % 7);
}
function observed(y, m, d) {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return iso(y, m, d + (w === 6 ? -1 : w === 0 ? 1 : 0));
}
// US federal holidays with the observed weekday (Saturday -> Friday, Sunday -> Monday).
function federalHolidays(y) {
  return [observed(y, 1, 1), iso(y, 1, nth(y, 1, 1, 3)), iso(y, 2, nth(y, 2, 1, 3)), iso(y, 5, nth(y, 5, 1, -1)),
    observed(y, 6, 19), observed(y, 7, 4), iso(y, 9, nth(y, 9, 1, 1)), iso(y, 10, nth(y, 10, 1, 2)),
    observed(y, 11, 11), iso(y, 11, nth(y, 11, 4, 4)), observed(y, 12, 25)];
}
function isBusinessDay(y, m, d) {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (w === 0 || w === 6) return false;
  const day = iso(y, m, d);
  return ![y - 1, y, y + 1].some((yy) => federalHolidays(yy).includes(day));
}
function nextBusinessDay(y, m, d) {
  for (let i = 1; i < 15; i++) {
    const t = new Date(Date.UTC(y, m - 1, d + i));
    const a = [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
    if (isBusinessDay(...a)) return a;
  }
  throw new Error('no business day');
}
// A request on a business day between 8 am and 5 pm is due at the same clock time the next business day.
// Before 8 am it counts from 8 am that day. After 5 pm, on a weekend or on a holiday it counts from
// 8 am the next business day, so it is due at 8 am the business day after that.
// Returns {start, due, warn} as Dates; warn is 75% of the way from start to due.
function businessClock(received) {
  const p = local(received);
  let start, due;
  if (isBusinessDay(p.y, p.m, p.d) && p.h < 17) {
    const [h, mi] = p.h < 8 ? [8, 0] : [p.h, p.mi];
    start = p.h < 8 ? fromLocal(p.y, p.m, p.d, 8, 0) : received;
    const n = nextBusinessDay(p.y, p.m, p.d);
    due = fromLocal(n[0], n[1], n[2], h, mi);
  } else {
    const s = nextBusinessDay(p.y, p.m, p.d);
    start = fromLocal(s[0], s[1], s[2], 8, 0);
    const n = nextBusinessDay(s[0], s[1], s[2]);
    due = fromLocal(n[0], n[1], n[2], 8, 0);
  }
  const warn = new Date(start.getTime() + 0.75 * (due.getTime() - start.getTime()));
  return { start, due, warn };
}
function chicagoText(date) {
  return new Date(date).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------- the LIVE guard and the send to the owner ----------
// Before GO LIVE (LIVE is not "on") the worker never emails or texts a business owner.
function fuOn(env) { return String((env && env.FOLLOWUPS) || 'off').trim().toLowerCase() === 'on'; }
function speedLive(env) { return String((env && env.SPEED_TEST_LIVE) || 'off').trim().toLowerCase() === 'on'; }
function isLive(env) { return String((env && env.LIVE) || 'off').trim().toLowerCase() === 'on'; }

const GMAIL_TOKEN = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const RESEND_SEND = 'https://api.resend.com/emails';
const GMAIL_THREAD = 'https://gmail.googleapis.com/gmail/v1/users/me/threads/';
const FROM = 'Rickey Hallor <rickey@getbookedoutsolutions.com>';

// The one email that goes to the owner: a short plain note with the link to his report.
// Visitor text rules apply (no long dashes, no emojis); it never promises jobs, calls or rank.
function ownerEmail(env, rec) {
  const link = `${SITE}/r/${rec.token}/`;
  const subject = plain(`Your free report for ${rec.business_name}`).replace(/[\r\n]+/g, ' ');
  const text = [
    `Hi ${plain(rec.first_name)},`,
    '',
    `Here's the free report you asked for on ${plain(rec.business_name)}:`,
    link,
    '',
    'It is built from your real Google listing and a few quick checks, and it ends with three fixes you can make yourself.',
    '',
    'Questions? Just reply to this email.',
    '',
    'Rickey Hallor',
    'Booked Out Solutions',
    'P.O. Box 1166, Smyrna, TN 37167',
    '',
    'You got this because you asked for a free report on our website. Reply "stop" and we will not email you again.',
  ].join('\n');
  return { from: env.SEND_FROM || FROM, to: rec.email, subject, text, messageId: rec.send_msgid || '' };
}
const b64u = (str) => { const by = new TextEncoder().encode(str); let bin = ''; for (const x of by) bin += String.fromCharCode(x); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64 = (str) => { const by = new TextEncoder().encode(str); let bin = ''; for (const x of by) bin += String.fromCharCode(x); return btoa(bin); };
function mime(m) {
  const hdr = (v) => (v = String(v).replace(/[\r\n]+/g, ' ')) && /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${b64(v)}?=`;
  return [`From: ${m.from}`, `To: ${m.to}`, `Subject: ${hdr(m.subject)}`, 'MIME-Version: 1.0',
    ...(m.messageId && /^<[\w.-]+@getbookedoutsolutions\.com>$/.test(m.messageId) ? [`Message-ID: ${m.messageId}`] : []),
    ...(m.inReplyTo ? [`In-Reply-To: ${hdr(m.inReplyTo)}`, `References: ${hdr(m.inReplyTo)}`] : []),
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(m.text)].join('\r\n');
}

// Sends one email by the picked route. Returns {ok, route, id?, error?}. Never throws.
async function sendMail(env, m, f) {
  const route = String(env.SEND_ROUTE || 'gmail').trim().toLowerCase();
  try {
    if (route === 'gmail') {
      if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) return { ok: false, route, error: 'gmail route not set up' };
      const tok = await gmailToken(env, f);
      if (!tok.ok) return { ok: false, route, error: tok.error };
      const r = await out(env, GMAIL_SEND, { method: 'POST', headers: { authorization: 'Bearer ' + tok.token, 'content-type': 'application/json' },
        body: JSON.stringify(m.threadId ? { raw: b64u(mime(m)), threadId: m.threadId } : { raw: b64u(mime(m)) }) }, f);
      if (!r.ok) return { ok: false, route, error: 'gmail send ' + r.status };
      const j = await r.json();
      return { ok: true, route, id: j.id || '', threadId: j.threadId || '' };
    }
    if (route === 'cloudflare') {
      // Cloudflare Email Sending (public beta since Apr 16 2026, Workers Paid). The binding's exact call shape is
      // checked on Cloudflare's docs before this route is ever switched on.
      if (!env.EMAIL || typeof env.EMAIL.send !== 'function') return { ok: false, route, error: 'cloudflare route not set up' };
      const r = await env.EMAIL.send({ from: m.from, to: m.to, subject: m.subject, text: m.text });
      return { ok: true, route, id: (r && (r.messageId || r.id)) || '' };
    }
    if (route === 'resend') {
      if (!env.RESEND_KEY) return { ok: false, route, error: 'resend route not set up' };
      const r = await out(env, RESEND_SEND, { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ from: m.from, to: [m.to], subject: m.subject, text: m.text }) }, f);
      if (!r.ok) return { ok: false, route, error: 'resend send ' + r.status };
      return { ok: true, route, id: (await r.json()).id || '' };
    }
    return { ok: false, route, error: 'unknown SEND_ROUTE' };
  } catch (e) { return { ok: false, route, error: String((e && e.message) || e).slice(0, 200) }; }
}

async function gmailToken(env, f) {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) return { ok: false, error: 'gmail route not set up' };
  const t = await out(env, GMAIL_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }).toString() }, f);
  if (!t.ok) return { ok: false, error: 'gmail token ' + t.status };
  return { ok: true, token: (await t.json()).access_token };
}
// Reads one of our Gmail threads (needs the gmail.readonly scope on the token). Never throws.
async function gmailThread(env, threadId, f) {
  try {
    if (!/^[a-f0-9]{6,40}$/i.test(String(threadId || ''))) return { ok: false, error: 'no thread id' };
    const tok = await gmailToken(env, f);
    if (!tok.ok) return { ok: false, error: tok.error };
    const r = await out(env, GMAIL_THREAD + threadId + '?format=metadata&metadataHeaders=From&metadataHeaders=Message-ID',
      { headers: { authorization: 'Bearer ' + tok.token } }, f);
    if (!r.ok) return { ok: false, error: 'gmail thread ' + r.status };
    return { ok: true, thread: await r.json() };
  } catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
}

// Every check that must be true before a report goes to an owner. Returns '' when it may go, else the reason.
function sendBlock(env, rec) {
  if (!isLive(env)) return 'LIVE is off: nothing goes to a business before GO LIVE';
  if (rec.test) return 'TEST request (fake shop): never sent';
  if (rec.status === 'sent') return 'already sent';
  if (rec.status !== 'checked') return 'not checked by both agents';
  if (!rec.complete || (rec.pending || []).length) return 'report still has pending sections';
  const c = rec.checks || {}, c1 = c['1'], c2 = c['2'];
  if (!c1 || !c2 || c1.result !== 'pass' || c2.result !== 'pass') return 'needs two pass marks';
  if (!c1.agent || !c2.agent || c1.agent === c2.agent) return 'the two checks must come from two different agents';
  if (c1.hash !== rec.hash || c2.hash !== rec.hash) return 'report changed after it was checked';
  if (!validate({ ...rec, consent: rec.consent }).ok) return 'contact details no longer valid';
  return '';
}
async function deliverToOwner(env, rec, f) {
  const why = sendBlock(env, rec);
  if (why) return { sent: false, blocked: true, reason: why };
  // Our own Message-ID, so follow-ups can say In-Reply-To even when we cannot read the thread back.
  if (!rec.send_msgid) rec.send_msgid = `<${rec.id}.${rand(6)}@getbookedoutsolutions.com>`;
  const r = await sendMail(env, ownerEmail(env, rec), f);
  return r.ok ? { sent: true, blocked: false, route: r.route, id: r.id, threadId: r.threadId || '' } : { sent: false, blocked: false, route: r.route, reason: r.error };
}
// Every outside call goes through here. Only the lookup worker and the picked send route are allowed.
function allowed(env, url) {
  const route = String(env.SEND_ROUTE || 'gmail').trim().toLowerCase();
  const ok = [env.LOOKUP_URL];
  if (isLive(env) && route === 'gmail') ok.push(GMAIL_TOKEN, GMAIL_SEND);
  if (isLive(env) && route === 'resend') ok.push(RESEND_SEND);
  // Thread reads, only for follow-ups, only with LIVE and FOLLOWUPS on, only our own thread ids.
  if (isLive(env) && fuOn(env) && route === 'gmail' && url.startsWith(GMAIL_THREAD) && /^[a-f0-9]{6,40}\?format=metadata&metadataHeaders=From&metadataHeaders=Message-ID$/i.test(url.slice(GMAIL_THREAD.length))) return true;
  return ok.filter(Boolean).includes(url);
}
async function out(env, url, init, f) {
  if (!allowed(env, url)) throw new Error('blocked outbound call');
  return (f || fetch)(url, init);
}

// ---------- the watch list (read by the watchdog; nothing is emailed) ----------
// level: "warn" (75% of the clock) or "problem" (overdue); "test" for fake TEST shops (never counted as problems).
// The 2-agent checkers and the watchdog act on warn and problem.
async function sendAlert(env, subject, message, f, level = 'warn', id = '') {
  const at = new Date().toISOString();
  const entry = { at, level, id, subject: String(subject).slice(0, 200), message: String(message).slice(0, 5000) };
  if (env.KV) {
    await env.KV.put(`watch:${at}:${level}:${id || 'x'}`, JSON.stringify(entry), { expirationTtl: 30 * DAY });
    await env.KV.put('alert:last', JSON.stringify({ at, level, subject: entry.subject }));
  }
  return 'kv';
}

// ---------- lookup (only for real requests; each call costs us a little) ----------
function isTestRequest(rec) {
  return /@example\.(com|org|net)$/i.test(rec.email || '') || /\(FAKE\)/i.test(rec.business_name || '');
}
function townState(town) {
  const m = String(town).match(/^(.*?)[\s,]+([A-Za-z]{2})$/);
  return m ? { town: m[1].trim(), state: m[2].toUpperCase() } : { town: String(town).trim(), state: '' };
}
async function lookup(env, rec, f) {
  if (!env.LOOKUP_URL || !env.LOOKUP_KEY || isTestRequest(rec)) return null;
  const ts = townState(rec.town), kw = (TRADES[rec.trade] || {}).kw || '';
  const call = async (body) => {
    const r = await out(env, env.LOOKUP_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lookup-key': env.LOOKUP_KEY }, body: JSON.stringify(body) }, f);
    if (!r.ok) throw new Error('lookup ' + r.status);
    return r.json();
  };
  const g = await call({ business_name: rec.business_name, town: ts.town, state: ts.state, keyword: kw ? `${kw} ${ts.town}` : '' });
  // No yes/no answer about the profile = the lookup failed; the section stays pending (never "not found" from missing data).
  if (typeof g.has_google_profile !== 'boolean') throw new Error('lookup gave no profile answer');
  const google = { has_google_profile: g.has_google_profile, rank_checked: !!kw && Object.prototype.hasOwnProperty.call(g, 'rank_for_keyword'), rating: g.rating ?? null, review_count: g.review_count ?? null,
    rank_for_keyword: g.rank_for_keyword ?? null, top3: Array.isArray(g.top3) ? g.top3.slice(0, 3) : [], keyword: kw ? `${kw} ${ts.town}` : '' };
  let reviews = null;
  if (google.has_google_profile && g.reviews_task_id) {
    reviews = { task: g.reviews_task_id, tries: 0 };
    try { Object.assign(reviews, await reviewsCall(env, g.reviews_task_id, f)); } catch (e) { /* tried again by the cron */ }
  } else if (google.has_google_profile && g.newest_review) {
    reviews = { newest_review: g.newest_review, owner_reply_on_newest: !!g.owner_reply_on_newest };
  }
  return { google, reviews };
}
async function reviewsCall(env, task, f) {
  const r = await out(env, env.LOOKUP_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lookup-key': env.LOOKUP_KEY }, body: JSON.stringify({ reviews_task_id: task }) }, f);
  if (!r.ok) throw new Error('reviews ' + r.status);
  const j = await r.json();
  if (!j.newest_review) return {};
  return { newest_review: j.newest_review, owner_reply_on_newest: !!j.owner_reply_on_newest };
}

// ---------- the report ----------
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Visitor text rules: no long dashes, no emojis (also cleans text that comes from Google reviews).
function plain(s) {
  // a dash joining two words ("5\u2013minute") becomes a plain hyphen; a dash used as a pause ("fast \u2014 fair") becomes a comma
  return String(s == null ? '' : s).replace(FU.INVISIBLE, '').replace(/([\p{L}\p{N}])[\u2010-\u2015\u2212]([\p{L}\p{N}])/gu, '$1-$2').replace(/\s*[\u2012-\u2015]\s*/g, ', ').replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, '').replace(/\s{2,}/g, ' ').trim()
    .replace(/^[\s,]+|[\s,]+$/g, '');
}
const t = (s) => esc(plain(s));
const money = (n) => '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function budgetLine(revenue) {
  const r = REVENUE[revenue];
  if (!r) return '';
  const [lo, hi] = r;
  let x;
  if (!lo) x = `up to about ${money(hi * 0.08 / 12)} a month`;
  else if (!hi) x = `about ${money(lo * 0.06 / 12)} a month or more`;
  else x = `about ${money(lo * 0.06 / 12)} to ${money(hi * 0.08 / 12)} a month`;
  return `Shops your size spend 6 to 8% of revenue to grow; for you that's ${x}. Core is $997.`;
}

const SPEED_FIX = FU.SPEED_FIX; // the one 5-minute wording (freereport-followups.js)
function afterHoursFix(ch) {
  const c = own(CHANNEL, ch) || 'call';
  return `Make sure every after-hours ${c} reaches a person or gets ${c === 'call' ? 'a call back' : 'an answer'} first thing the next morning.`;
}
const normFix = (x) => plain(x).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// What his answer speed test found, in the order the diagnosis line uses. diagnose() and pickFixes() both read this, so the
// fix kept among the three is always the one the diagnosis points at. Returns null (nothing to fix), or
// {kind: 'no answer' | 'slow follow up' | 'after hours' | 'slow answer', fix: 'speed' | 'after hours'}.
function speedFinding(sp) {
  if (!sp || sp.tested !== true) return null;
  if (sp.minutes == null) return { kind: 'no answer', fix: 'speed' };
  const m = +sp.minutes;
  if (m > 60) return { kind: 'slow follow up', fix: 'speed' };
  if (sp.after_hours && sp.after_hours.tested === true && sp.after_hours.answered === false) return { kind: 'after hours', fix: 'after hours' };
  if (m > 5) return { kind: 'slow answer', fix: 'speed' };
  return null;
}
// The three fixes. The fix matching his speed finding is built first and always keeps a place (it takes the place of the last
// other fix); any other fix with the same words is dropped. No fix twice. Always three.
function pickFixes(rec) {
  const s = rec.sections || {}, g = s.google, rv = s.reviews, bk = s.booking, ct = s.category, ai = s.ai, sp = s.speed;
  const fast = FU.answeredFast(sp);
  const ahNo = !!(sp && sp.tested === true && sp.after_hours && sp.after_hours.tested === true && sp.after_hours.answered === false);
  const found = speedFinding(sp);
  const reserved = found ? (found.fix === 'after hours' ? afterHoursFix(sp.after_hours.channel) : SPEED_FIX) : '';
  // Both speed problems are kept when both are true (a slow or missing answer AND an unanswered after-hours test): the one the
  // diagnosis names first, then the other. A slow answerer always sees the one 5-minute fix.
  const extra = [];
  if (sp && sp.tested === true && (sp.minutes == null || +sp.minutes > 5) && normFix(SPEED_FIX) !== normFix(reserved)) extra.push(SPEED_FIX);
  if (ahNo && normFix(afterHoursFix(sp.after_hours.channel)) !== normFix(reserved)) extra.push(afterHoursFix(sp.after_hours.channel));
  const keep = reserved ? [reserved, ...extra] : [];
  const out = [];
  const seen = (x, list) => list.some((y) => normFix(y) === normFix(x));
  const add = (x) => {
    x = plain(x);
    if (!x || (fast && FU.FIVE_MIN_TEST(x))) return; // he already answers that fast
    // at most one 5-minute fix ever, and it is always worded as SPEED_FIX (any other 5-minute wording is dropped)
    if (FU.FIVE_MIN_TEST(x) && normFix(x) !== normFix(SPEED_FIX)) return;
    if (seen(x, keep) || seen(x, out)) return; // a kept speed fix wins over any other fix with the same words
    if (reserved === SPEED_FIX && FU.FIVE_MIN_TEST(x)) return; // the kept 5-minute fix already says it; no second fix saying the same
    out.push(x);
  };
  if (g && !g.has_google_profile) add('Set up your free Google Business Profile with your real address or service area, hours and phone number. Without it, you do not show on the Google map.');
  if (g && g.has_google_profile && g.top3 && g.top3.length && g.review_count != null) {
    const avg = Math.round(g.top3.reduce((a, x) => a + (+x.review_count || 0), 0) / g.top3.length);
    if (avg > g.review_count) add(`Ask every happy customer for a Google review the day the job is done. The top 3 near you average ${avg} reviews; you have ${g.review_count}.`);
  }
  // Item 211: a shop with few Google reviews always gets the review fix, even when the top 3 are small too.
  if (fewReviews(g) && !out.some((x) => /^Ask every happy customer for a Google review/.test(x)))
    add(`Ask every happy customer for a Google review the day the job is done. You have ${g.review_count} Google ${g.review_count === 1 ? 'review' : 'reviews'} so far, and the next customer reads them before they call.`);
  if (rv && rv.newest_review && !rv.owner_reply_on_newest) add('Reply to your newest Google review today, and to every new review within a day from now on. The next customer reads those replies.');
  if (ct && ct.match === false) add(`Change your Google main category to the one that fits ${plain(ct.big_job || 'the big-ticket job you want most')}, so Google shows you for that work.`);
  // the first booking fix the page's booking test list shows (other 5-minute wordings, and 5-minute fixes for a fast shop, are skipped)
  // the first item of the one filtered booking list (the same list the page's booking test section shows)
  if (bk) { const b0 = FU.bookingList(bk.fixes, plain)[0]; if (b0) add(b0); }
  if (ai && ai.chatgpt && ai.chatgpt.named === false) add('Put your town, your main services and your best reviews in plain words on your website, so ChatGPT and Gemini have something to say about you.');
  const pick = out.slice(0, 3 - keep.length).concat(keep);
  const base = [
    ...out.slice(3 - keep.length),
    'Put your phone number and a clear "Get a quote" button at the top of every page of your website.',
    SPEED_FIX,
    'Follow up on every quote you send: a short note 2 days later, then again a week later.',
    'Keep your hours, phone number and service area the same on your website and your Google profile, so no customer calls a wrong number.',
  ];
  for (const b of base) {
    if (pick.length >= 3) break;
    if (FU.FIVE_MIN_TEST(b) && (fast || pick.some((y) => FU.FIVE_MIN_TEST(y)))) continue; // never a second 5-minute fix
    if (!seen(b, pick)) pick.push(b);
  }
  // the reserved fix keeps its place even when the fill-up above came before it in the list order
  return pick.slice(0, 3);
}

// ---------- item 215 / 211 / Nov 19 additions (Nov 20 2026) ----------
// Every number below either comes from the owner's own lookup data (sections) or from a named outside study.
// Outside numbers are always shown as an estimate, with the source on the page. Nothing promises jobs, money or rank.
const FEW_REVIEWS = 20; // under this many Google reviews, the report points to the review fix (item 211)
function fewReviews(g) { return !!(g && g.has_google_profile && g.review_count != null && +g.review_count < FEW_REVIEWS); }
// Outside research (checked Nov 20 2026). Only these numbers may appear in an estimate.
const SOURCES = {
  hbr: 'Oldroyd, McElheran and Elkington, "The Short Life of Online Sales Leads," Harvard Business Review, March 2011 (an analysis of 1.25 million leads at 42 U.S. companies)',
  mit: 'Oldroyd (MIT Sloan) and InsideSales.com, "Lead Response Management Study," 2007',
  st: 'ServiceTitan, "When Summer Demand Spikes, After-Hours Calls Do Too," June 3 2026 (residential heating and air shops on its platform, 2025; ServiceTitan says the figures are not nationally representative)',
};
// After-hours share of inbound calls, by trade. Only trades with a sourced number get an after-hours estimate.
const AFTER_HOURS = { hvac: { low: 9.8, high: 14.1, src: 'st', who: 'home heating and air shops' } };
// True only when the three fixes on the page really include the Google review fix.
function reviewFixIn(rec) { return pickFixes(rec).some((x) => /^Ask every happy customer for a Google review/.test(x)); }
function slowAnswer(sp) { return !!(sp && sp.tested !== false && (sp.minutes == null || +sp.minutes > 5)); }
// Answer speed -> what outside research says about it (never his own numbers, never a booking rate).
function speedEstimate(sp) {
  if (!sp || sp.tested === false) return null;
  const m = sp.minutes == null ? null : +sp.minutes;
  const ahNo = sp.after_hours && sp.after_hours.tested === true && sp.after_hours.answered === false;
  if (m != null && m <= 5) return { text: `In the research on lead speed, answering within 5 minutes is the fastest group there is.${ahNo ? '' : ' Keep it up, after hours too.'}`, src: 'mit' };
  if (m != null && m <= 60) return { text: 'One study found the odds of qualifying a lead (a real talk about a real job) fell about 21 times between a 5 minute answer and a 30 minute answer.', src: 'mit' };
  if (m != null && m < 1440) return { text: 'A Harvard Business Review study found companies that answered within an hour were nearly 7 times as likely to qualify the lead as companies that answered an hour or more later.', src: 'hbr' };
  return { text: 'A Harvard Business Review study found companies that answered within an hour were more than 60 times as likely to qualify the lead as companies that waited 24 hours or longer.', src: 'hbr' };
}
// Screenshot links: our own domain, a plain path, an image; no "//" and no ".." anywhere in the path.
function shotOk(u) {
  u = String(u || '');
  const m = u.match(/^https:\/\/getbookedoutsolutions\.com(\/[\w./-]+\.(png|jpe?g|webp))(\?v=[a-f0-9]{8})?$/i);
  return !!m && !m[1].includes('//') && !m[1].includes('..');
}
const pct = (n) => (Math.round(n * 10) / 10).toString();

// The one-line diagnosis (Nov 19 batch): "not found", "found but not chosen", "chosen but never followed up".
// Backed only by the lookup data. Returns {kind, line} or null when the data it needs is not in yet (pending).
function diagnose(rec) {
  const s = rec.sections || {}, g = s.google, ai = s.ai, sp = s.speed;
  if (!g) return null;
  const trade = TRADES[rec.trade] || TRADES['Something else'];
  const kw = g.keyword || (trade.kw ? `${trade.kw} ${townState(rec.town).town}` : '');
  const aiNone = ai && ai.chatgpt && ai.gemini && ai.chatgpt.named === false && ai.gemini.named === false && (!ai.google_ai || ai.google_ai.named === false);
  if (g.has_google_profile !== true && g.has_google_profile !== false) return null;
  if (!g.has_google_profile) return { kind: 'not found', line: `Not found. We could not find a Google Business Profile for ${plain(rec.business_name)} in ${plain(rec.town)}, so you do not show on the Google map.` };
  if (!kw) return null;
  const avg = g.top3 && g.top3.length ? Math.round(g.top3.reduce((a, x) => a + (+x.review_count || 0), 0) / g.top3.length) : null;
  // "Not found" from the search only when the lookup really ran the search (a positive flag), never from missing data.
  if (!g.rank_for_keyword && g.rank_checked !== true) return null;
  if (!g.rank_for_keyword) return { kind: 'not found', line: `Not found. You are not in the first 20 Google results for "${plain(kw)}"${aiNone ? ', and ChatGPT and Gemini did not name you either' : ''}.` };
  const r = +g.rank_for_keyword;
  if (r > 3) return { kind: 'found but not chosen', line: `Found but not chosen. You show at number ${r} for "${plain(kw)}", below the top 3${avg != null && g.review_count != null && avg > g.review_count ? `, and they average ${avg} reviews to your ${g.review_count}` : ''}.` };
  if (!sp) return null;
  if (sp.tested === false) return { kind: 'chosen', line: `Found and chosen. You are number ${r} for "${plain(kw)}". We could not test how fast you answer, so we cannot say more than that.` };
  const ch = own(CHANNEL, sp.channel) || 'request';
  const ahCh = sp.after_hours ? own(CHANNEL, sp.after_hours.channel) || 'request' : '';
  const m = sp.minutes == null ? null : +sp.minutes;
  const found = speedFinding(sp); // the same finding the fix picker keeps a place for
  if (found && found.kind === 'no answer') return { kind: 'chosen but never followed up', line: `Chosen but never followed up. You are number ${r} for "${plain(kw)}", but our test ${ch} got no answer in ${+sp.waited_hours || 24} hours.` };
  if (found && found.kind === 'slow follow up') return { kind: 'chosen but slow to follow up', line: `Chosen but slow to follow up. You are number ${r} for "${plain(kw)}", but our test ${ch} took ${waitText(m)} to get an answer.` };
  if (found && found.kind === 'after hours') return { kind: 'chosen but never followed up', line: `Chosen but never followed up. You are number ${r} for "${plain(kw)}", but our after-hours test ${ahCh} got no answer.` };
  if (found && found.kind === 'slow answer') return { kind: 'chosen but slow to answer', line: `Found and chosen, but slow to answer. You are number ${r} for "${plain(kw)}", and our test ${ch} took ${waitText(m)} to get an answer.` };
  return { kind: 'chosen', line: `Found and chosen. You are number ${r} for "${plain(kw)}", and you answered our test ${ch} in ${waitText(m)}. The fixes below are about keeping it that way.` };
}
const CHANNEL = { call: 'call', text: 'text', email: 'email' };
// Own keys only, so a name like "constructor" or "__proto__" is never taken for a channel or an engine.
const own = (o, k) => (typeof k === 'string' && Object.hasOwn(o, k) ? o[k] : undefined);
// How long an answer took, in the same words everywhere on the page (speed section and diagnosis line).
function waitText(m) { return m < 120 ? `${m} ${m === 1 ? 'minute' : 'minutes'}` : m < 1440 ? `about ${Math.round(m / 60)} hours` : 'a day or more'; }
const TESTED = { call: 'We made one test call to your business', text: 'We sent one test text to your business', email: 'We sent one test email to your business' };
const AH_TESTED = { call: 'We also made one test call after hours', text: 'We also sent one test text after hours', email: 'We also sent one test email after hours' };
const AI_NAME = { chatgpt: 'ChatGPT', gemini: 'Gemini', google_ai: 'Google AI answer' };
// Word for word from sites/getbookedoutsolutions.com/terms.html (and the trade terms pages). Do not reword.
const TERMS_GUARANTEE = 'We guarantee our part of every piece: the writing, the sending, the posting, the submitting. Not the printer, the mail, Google or your customers. We never promise jobs, revenue or a spot on Google. If we miss any piece of your package, your next month is free.';
const TERMS_FREE = 'There are no guarantees during a free period, because nothing is being charged.';
const TRADE_NAME = { hvac: 'heating and air shop', plumbing: 'plumbing shop', electrical: 'electrical shop', other: 'shop in your trade' };

// "What you're known for": the words that repeat across his Google reviews. The worker counts them itself from the
// review texts the fill gives, so nothing is guessed. A phrase counts once per review; it must be in 3 or more reviews.
const STOP = new Set(('a an and are as at be been but by can did do for from had has have he her him his how i if in is it its just me my of on or our out so than that the their them then there they this to too up us very was we were what when which who will with would you your yours also all any after again back came come could get got here into more most much no not now one only over said she some two way well went where while who why yes am being both each few just like make made many may might must need off own same should such take very really highly recommend recommended great good excellent amazing awesome best service services job jobs work worked company business thanks thank called call guy guys team everything definitely always never ever will again use used').split(' '));
// Words that turn the next words around ("not happy", "never on time"), and complaint words that are never shown.
const NEGATE = new Set('not no never nor without hardly barely wasnt wasn\'t didnt didn\'t isnt isn\'t wont won\'t dont don\'t couldnt couldn\'t wouldnt wouldn\'t cant can\'t arent aren\'t werent weren\'t'.split(' '));
const NEGATIVE = new Set(('late rude slow expensive overpriced pricey dirty mess messy bad worst terrible awful horrible poor unprofessional rip scam ' +
  'waited waiting wait cancel cancelled canceled broke broken problem problems issue issues complaint complain disappointed disappointing ' +
  'ignored unhappy angry careless lazy damage damaged leak leaking leaked wrong mistake refund lied liar rushed sloppy unreliable noshow ' +
  'high pricey costly expensive charged overcharged overcharge twice behind delay delayed delays waited hour hours forever finally ' +
  'unanswered voicemail ghosted missed miss dirty mud stain stained scratch scratched hidden fee fees upsell upsold pushy').split(' '));
function knownFor(texts, extraStop = []) {
  const stop = new Set([...STOP, ...extraStop]);
  const df = new Map();
  for (const raw0 of texts) {
    // drop every sentence (or clause after "but") that has a complaint word in it: "The price was high but they were on time"
    const raw = plain(raw0).split(/[.!?;\n]+|\bbut\b|\bhowever\b|\bthough\b/i).filter((part) => !part.toLowerCase().replace(/\u2019/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).some((w) => NEGATIVE.has(w.replace(/'s$/, '')))).join('. ');
    const words = plain(raw).toLowerCase().replace(/\u2019/g, "'").replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).map((w) => w.replace(/^'+|'+$/g, '').replace(/'s$/, '')).filter(Boolean);
    // a word is "turned around" when one of the 3 words before it negates it
    const neg = words.map((_, i) => words.slice(Math.max(0, i - 3), i).some((x) => NEGATE.has(x)));
    const bad = (i) => NEGATE.has(words[i]) || NEGATIVE.has(words[i]) || neg[i];
    const seen = new Set();
    for (let i = 0; i < words.length; i++) {
      const a = words[i], b = words[i + 1];
      if (bad(i)) continue;
      if (a.length > 2 && !stop.has(a) && !/^\d+$/.test(a)) seen.add(a);
      if (b == null || bad(i + 1)) continue;
      if (!stop.has(a) && !stop.has(b) && a.length > 1 && b.length > 1 && !/^\d+$/.test(a + b)) seen.add(a + ' ' + b);
      // "on time", "fair price" style pairs: a short word in front of a real word
      if (['on', 'fair', 'fast', 'same', 'very'].includes(a) && !stop.has(b) && b.length > 2) seen.add(a + ' ' + b);
    }
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  const all = [...df.entries()].filter(([, n]) => n >= 3).sort((x, y) => y[1] - x[1] || (y[0].includes(' ') ? 1 : 0) - (x[0].includes(' ') ? 1 : 0) || x[0].localeCompare(y[0]));
  const out = [];
  for (const [w, n] of all) {
    // skip a single word already inside a picked pair with the same count, and a pair whose word is already picked alone
    if (out.some((o) => (o.word.includes(' ') && o.word.split(' ').includes(w) && o.count >= n) || (w.includes(' ') && w.split(' ').includes(o.word) && o.count >= n))) continue;
    out.push({ word: w, count: n });
    if (out.length === 3) break;
  }
  return out;
}

// The listing check: six places a customer may look. One simple fix per weak site.
const SITES = [
  ['google', 'Google', 'Set up your free Google Business Profile with your real address or service area, hours and phone number.'],
  ['yelp', 'Yelp', 'Claim your free Yelp business page and add your phone number, hours and service area.'],
  ['bbb', 'BBB', 'Look up your business on bbb.org and make sure your phone number, address and hours are right.'],
  ['facebook', 'Facebook', 'Make a free Facebook business page with your phone number, hours and service area, and post one recent job photo.'],
  ['nextdoor', 'Nextdoor', 'Claim your free Nextdoor business page, so neighbors who recommend you can point to it.'],
  ['chamber', 'Local chamber of commerce', 'Ask your local chamber of commerce how its member directory works. If you are a member, make sure your listing has your phone number and website.'],
];

// The competitor gap: the top shop that outranks him, side by side, and the 3 biggest gaps.
const CMP = [
  // key, label, how to show, how big the gap is (0 to 1+), the gap line
  ['review_count', 'Google reviews', (v) => v, (t, y) => (t - y) / Math.max(t, 1), (t, y) => `They have ${t} Google reviews; you have ${y}.`],
  ['rating', 'Stars', (v) => `${v} out of 5`, (t, y) => (t - y), (t, y) => `They average ${t} stars; you average ${y}.`],
  ['photos', 'Photos on Google', (v) => v, (t, y) => (t - y) / Math.max(t, 1), (t, y) => `They show ${t} photos on Google; you show ${y}.`],
  ['reply_pct', 'Reviews with an owner reply', (v) => `${v}%`, (t, y) => (t - y) / 100, (t, y) => `They reply to ${t}% of their reviews; you reply to ${y}%.`],
  ['posts_90d', 'Google posts in the last 90 days', (v) => v, (t, y) => (t - y) / Math.max(t, 1), (t, y) => `They made ${t} Google posts in the last 90 days; you made ${y}.`],
  ['website', 'Website on the Google profile', (v) => (v ? 'Yes' : 'No'), (t, y) => (t && !y ? 1 : 0), () => 'They have a website on their Google profile; you do not.'],
  ['hours', 'Hours on the Google profile', (v) => (v ? 'Yes' : 'No'), (t, y) => (t && !y ? 1 : 0), () => 'They list their hours on Google; you do not.'],
];
function competitorView(rec) {
  const s = rec.sections || {}, g = s.google, c = s.competitor;
  if (!g || !g.has_google_profile || !g.top3 || !g.top3.length) return null;
  if (g.rank_for_keyword && +g.rank_for_keyword === 1) return { first: true };
  if (!c) return null;
  const pos = g.top3.findIndex((x) => x.name === c.name);
  // google filled again after the competitor (new top 3 or new rank): the old pick no longer fits, so it waits for a new fill
  if (pos < 0 || (g.rank_for_keyword && pos + 1 >= +g.rank_for_keyword)) return null;
  const top = g.top3[pos];
  const theirs = { review_count: top.review_count, rating: top.rating, ...(c.theirs || {}) };
  const yours = { review_count: g.review_count, rating: g.rating, ...(c.yours || {}) };
  const rows = [], gaps = [];
  for (const [k, label, show, size, line] of CMP) {
    const tv = theirs[k], yv = yours[k];
    if (tv == null || yv == null) continue;
    rows.push([label, show(tv), show(yv)]);
    const z = size(+tv, +yv);
    if (z > 0) gaps.push({ z, line: line(tv, yv) });
  }
  gaps.sort((a, b) => b.z - a.z);
  return { name: top.name, pos: pos + 1, rows, gaps: gaps.slice(0, 3).map((x) => x.line) };
}

// Checks a fill for the new sections before it is saved. Returns '' when ok, else the reason.
function fillProblem(rec, section, d) {
  const g = (rec.sections || {}).google;
  const str = (x, n) => typeof x === 'string' && x.trim().length > 0 && x.length <= n;
  const bool = (x) => typeof x === 'boolean';
  const num = (x, lo, hi) => typeof x === 'number' && isFinite(x) && x >= lo && x <= hi;
  if (section === 'google') {
    if (!bool(d.has_google_profile)) return 'google.has_google_profile must be true or false';
    if (d.has_google_profile) {
      if (d.rating != null && !num(d.rating, 1, 5)) return 'google.rating must be 1 to 5 or null';
      if (d.review_count != null && !(Number.isInteger(d.review_count) && d.review_count >= 0)) return 'google.review_count must be a whole number or null';
      if (d.rank_for_keyword != null && !(Number.isInteger(d.rank_for_keyword) && d.rank_for_keyword >= 1 && d.rank_for_keyword <= 20)) return 'google.rank_for_keyword must be 1 to 20 or null';
      if (d.rank_for_keyword == null && d.rank_checked !== true && d.rank_checked !== false) return 'google.rank_checked (true = we ran the search and he was not in the first 20) is needed when rank_for_keyword is null';
      if (d.keyword != null && !str(d.keyword, 120)) return 'google.keyword must be text';
      if (d.top3 != null && (!Array.isArray(d.top3) || d.top3.length > 3 || !d.top3.every((x) => x && str(x.name, 160) && (x.rating == null || num(x.rating, 1, 5)) && (x.review_count == null || (Number.isInteger(x.review_count) && x.review_count >= 0)))))
        return 'google.top3 must be up to 3 of {name, rating, review_count}';
    }
  }
  const optStr = (x, n) => x == null || (typeof x === 'string' && x.length <= n);
  if (section === 'reviews') {
    const r = d.newest_review;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'reviews.newest_review must be {rating, text, date}';
    if (r.rating != null && !num(r.rating, 1, 5)) return 'reviews.newest_review.rating must be 1 to 5 or null';
    if (!optStr(r.text, 5000)) return 'reviews.newest_review.text must be text (up to 5000 characters)';
    if (!optStr(r.date, 80)) return 'reviews.newest_review.date must be text (up to 80 characters)';
    if (!bool(d.owner_reply_on_newest)) return 'reviews.owner_reply_on_newest must be true or false';
  }
  if (section === 'category') {
    if (!str(d.main_category, 120)) return 'category.main_category must be text (up to 120 characters)';
    if (!optStr(d.big_job, 120)) return 'category.big_job must be text (up to 120 characters)';
    if (!bool(d.match)) return 'category.match must be true or false';
    if (!optStr(d.note, 300)) return 'category.note must be text (up to 300 characters)';
  }
  if (section === 'ai') {
    if (!d.chatgpt || !bool(d.chatgpt.named) || !d.gemini || !bool(d.gemini.named)) return 'ai needs chatgpt {named} and gemini {named}';
    if (!d.google_ai || typeof d.google_ai !== 'object' || !bool(d.google_ai.named)) return 'ai needs google_ai {named: true|false} (the AI fill job asks Google too)';
    if (!optStr(d.question, 300)) return 'ai.question must be text (up to 300 characters)';
    for (const e of ['chatgpt', 'gemini', 'google_ai']) {
      if (d[e].correct != null && !bool(d[e].correct)) return e + '.correct must be true or false';
      if (!optStr(d[e].note, 300)) return e + '.note must be text (up to 300 characters)';
    }
    for (const e of ['chatgpt', 'gemini', 'google_ai']) if (d[e] && d[e].top != null && (!Array.isArray(d[e].top) || d[e].top.length > 5 || !d[e].top.every((x) => str(x, 120)))) return e + '.top must be a list of up to 5 names';
    if (d.screenshots != null && (!Array.isArray(d.screenshots) || d.screenshots.length > 3 || !d.screenshots.every((x) => x && ['chatgpt', 'gemini', 'google_ai'].includes(x.engine) && shotOk(x.url))))
      return 'screenshots: up to 3 of {engine: chatgpt|gemini|google_ai, url: https://getbookedoutsolutions.com/....png}';
  }
  if (section === 'booking') {
    if (!num(d.score, 0, 10)) return 'booking.score must be a number from 0 to 10';
    if (!Array.isArray(d.fixes) || d.fixes.length > 10 || !d.fixes.every((x) => str(x, 500) && plain(x).length > 0)) return 'booking.fixes must be a list of up to 10 fixes, each one non-empty text';
  }
  if (section === 'speed') {
    if (typeof d.tested !== 'boolean') return 'speed.tested must be true or false';
    if (d.tested === false) return str(d.reason, 300) ? '' : 'speed with tested:false needs a reason';
    if (!own(CHANNEL, d.channel)) return 'speed.channel must be call, text or email (we never send a form)';
    if (!str(d.when, 80)) return 'speed.when (when we tested, in words) is needed';
    if (d.minutes !== null && !num(d.minutes, 0, 100000)) return 'speed.minutes must be a number, or null for no answer';
    if (d.minutes === null && !num(d.waited_hours, 1, 1000)) return 'speed.waited_hours is needed when there was no answer';
    if (d.after_hours != null && (typeof d.after_hours !== 'object' || !bool(d.after_hours.tested) || (d.after_hours.tested && (!bool(d.after_hours.answered) || !str(d.after_hours.when, 80) || !own(CHANNEL, d.after_hours.channel))))) return 'speed.after_hours needs {tested, answered, when, channel: call|text|email}';
    if (d.leads_per_month != null && (!num(d.leads_per_month, 1, 100000) || d.leads_source !== 'owner')) return 'speed.leads_per_month is only allowed when the owner told us (leads_source: "owner")';
  }
  if (section === 'known_for') {
    if (!Array.isArray(d.reviews) || d.reviews.length > 300 || !d.reviews.every((x) => x && typeof x.text === 'string' && x.text.length <= 5000 && num(x.rating, 1, 5)))
      return 'known_for.reviews must be a list of up to 300 {text, rating 1 to 5} copied from his Google reviews';
    if (!Number.isInteger(d.scanned) || d.scanned < d.reviews.length || d.scanned > 10000) return 'known_for.scanned (how many reviews we scanned, at least the number sent) is needed';
  }
  if (section === 'competitor') {
    if (!g || !g.has_google_profile || !g.top3 || !g.top3.length) return 'fill google (with the top 3) first';
    const pos = g.top3.findIndex((x) => x.name === d.name);
    if (pos < 0) return 'competitor.name must be one of the top 3 names in the google section, spelled the same';
    if (g.rank_for_keyword && pos + 1 >= +g.rank_for_keyword) return 'that shop does not outrank him';
    for (const side of ['theirs', 'yours']) {
      const o = d[side] || {};
      if (typeof o !== 'object') return side + ' must be an object';
      for (const k of Object.keys(o)) {
        const row = CMP.find((x) => x[0] === k);
        if (!row || k === 'review_count' || k === 'rating') return `${side}.${k} is not allowed (stars and reviews come from the google section)`;
        if (['website', 'hours'].includes(k) ? !bool(o[k]) : !num(o[k], 0, k === 'reply_pct' ? 100 : 100000)) return `${side}.${k} has a bad value`;
      }
    }
  }
  if (section === 'listings') {
    if (!d.sites || typeof d.sites !== 'object') return 'listings.sites is needed';
    for (const [k] of SITES) {
      const x = d.sites[k];
      if (!x || !bool(x.found)) return `listings.sites.${k} needs {found: true|false}`;
      if (x.found && x.complete != null && !bool(x.complete)) return `listings.sites.${k}.complete must be true or false`;
      if (x.found && x.complete === false && !str(x.fix, 240)) return `listings.sites.${k}.fix (one simple fix) is needed when it is not complete`;
    }
  }
  if (section === 'spot') {
    if (!str(d.zone, 80) || !bool(d.open)) return 'spot needs {zone: "...", open: true|false}';
  }
  return '';
}

const PENDING = '<p class="pending"><b>Pending check.</b> We are finishing this part now. It will be filled in before we send your report.</p>';

// Returns {html, pending:[section names], complete}
function renderReport(rec) {
  const s = rec.sections || {}, g = s.google, rv = s.reviews, ai = s.ai, bk = s.booking, ct = s.category;
  const trade = TRADES[rec.trade] || TRADES['Something else'];
  const pending = [], parts = [];
  let n = 0;
  const sec = (title, body) => { n++; parts.push(`<section class="rsec"><h2><span class="num">${n}</span>${t(title)}</h2>${body}</section>`); };

  // 1 Google
  let b1 = '';
  if (!g) { b1 = PENDING; pending.push('1 Google'); }
  else if (!g.has_google_profile) {
    b1 = `<p>We could not find a Google Business Profile for ${t(rec.business_name)} in ${t(rec.town)}. Without one, you do not show on the Google map at all, so there is no place to report yet. The good news: it is free to set up, and fix 1 below shows how.</p>`;
  } else {
    const rows = [];
    rows.push(['Google profile', 'Found']);
    if (g.rating != null) rows.push(['Stars', `${t(g.rating)} out of 5`]);
    if (g.review_count != null) rows.push(['Reviews', t(g.review_count)]);
    const kw = g.keyword || (trade.kw ? `${trade.kw} ${townState(rec.town).town}` : '');
    if (!kw) { pending.push('1 Google (search to check)'); }
    else if (g.rank_for_keyword) rows.push([`Where you show for "${t(kw)}"`, `Number ${t(g.rank_for_keyword)}`]);
    else if (g.rank_checked === true) rows.push([`Where you show for "${t(kw)}"`, 'Not in the first 20 results']);
    else pending.push('1 Google (search not run)');
    b1 = '<div class="rows">' + rows.map(([a, v]) => `<div><span>${esc(a)}</span><b>${v}</b></div>`).join('') + '</div>';
    if (!kw) b1 += PENDING;
    if (fewReviews(g)) b1 += `<p class="gap"><b>Few reviews so far.</b> With ${t(g.review_count)} Google ${+g.review_count === 1 ? 'review' : 'reviews'}, a new customer has little to go on.${reviewFixIn(rec) ? ' The review fix below is the place to start.' : ''}</p>`;
    if (g.top3 && g.top3.length) {
      b1 += '<h3>The top 3 near you</h3><ol class="top3">' + g.top3.map((x) => `<li><b>${t(x.name)}</b> <span>${x.rating != null ? t(x.rating) + ' stars, ' : ''}${t(x.review_count ?? 0)} reviews</span></li>`).join('') + '</ol>';
      if (g.review_count != null) {
        const avg = Math.round(g.top3.reduce((a, x) => a + (+x.review_count || 0), 0) / g.top3.length);
        const inTop = g.rank_for_keyword && g.rank_for_keyword <= 3;
        b1 += inTop ? `<p class="gap">You are already in the top 3 for this search. The top 3 average ${avg} reviews; you have ${t(g.review_count)}.</p>`
          : avg > g.review_count ? `<p class="gap"><b>Gap to the top 3:</b> they average ${avg} reviews; you have ${t(g.review_count)}. That is about ${avg - g.review_count} reviews behind.</p>`
            : `<p class="gap">You already have as many reviews as the top 3 (they average ${avg}). The gap is in other places, like the fixes below.</p>`;
      }
    }
  }
  sec('What we found on Google', b1);

  // 2 newest review
  let b2 = '';
  if (g && !g.has_google_profile) b2 = '<p>No Google profile yet, so there are no Google reviews to check.</p>';
  else if (rv && rv.newest_review) {
    const r = rv.newest_review, txt = plain(r.text || '').slice(0, 280);
    b2 = `<blockquote>${r.rating != null ? `<b>${t(r.rating)} stars.</b> ` : ''}${txt ? '"' + esc(txt) + (plain(r.text || '').length > 280 ? '..."' : '"') : '(No words, stars only.)'}${r.date ? ` <span class="when">${t(r.date)}</span>` : ''}</blockquote>`
      + (rv.owner_reply_on_newest ? '<p><b>Did it get a reply from you?</b> Yes. Nice work. Keep replying to every review.</p>'
        : '<p><b>Did it get a reply from you?</b> Not yet. A short, kind reply within a day shows the next customer that you care.</p>');
  } else { b2 = PENDING; pending.push('2 Newest review'); }
  sec('Your newest review, and whether it got a reply', b2);

  // 3 ChatGPT and Gemini
  let b3 = '';
  if (ai && ai.chatgpt && ai.gemini) {
    const line = (name, x) => `<li><b>${name}:</b> ${x.named ? 'you were on the list' : 'you were not on the list'}${x.correct === false ? ', and some of what it said about you was wrong' : ''}.${Array.isArray(x.top) && x.top.length ? ` It named: ${x.top.slice(0, 5).map((n) => t(n)).join(', ')}.` : ''}${x.note ? ' ' + t(x.note) : ''}</li>`;
    b3 = (ai.question ? `<p>We asked each one: "${t(ai.question)}"</p>` : '') + `<ul class="plainlist">${line('ChatGPT', ai.chatgpt)}${line('Gemini', ai.gemini)}${ai.google_ai ? line('Google AI answer', ai.google_ai) : ''}</ul>`;
    if (!ai.google_ai) { b3 += PENDING; pending.push('3 Google AI answer'); }
    const shots = Array.isArray(ai.screenshots) ? ai.screenshots.filter((x) => x && shotOk(x.url)).slice(0, 3) : [];
    if (shots.length) b3 += '<h3>What they said (screenshots)</h3><div class="shots">' + shots.map((x) => `<figure><img src="${esc(x.url)}" alt="${esc(own(AI_NAME, x.engine) || 'AI')} answer" loading="lazy"><figcaption>${esc(own(AI_NAME, x.engine) || '')}</figcaption></figure>`).join('') + '</div>';
  } else { b3 = PENDING; pending.push('3 ChatGPT and Gemini test'); }
  sec(`Who ChatGPT, Gemini and Google say is best in ${townState(rec.town).town}`, '<p class="sub">More people now ask ChatGPT, Gemini or Google\'s AI answer who to call. We ask each one the question your best customer would ask, and check if you come up.</p>' + b3);

  // 4 booking test
  let b4 = '';
  if (bk && bk.score != null) {
    // a shop that already answered our test within 5 minutes is not told to answer within 5 minutes
    // the one filtered booking list: no fix about any time unit (answer speed belongs to the speed section), no blanks, no repeats
    const list = FU.bookingList(bk.fixes, plain).slice(0, 3);
    const fx = list.map((x) => `<li>${t(x)}</li>`).join('');
    b4 = `<p class="score"><b>${t(Math.max(0, Math.min(10, +bk.score)))}</b> out of 10</p>${fx ? `<p>${['', 'One fix', 'Two fixes', 'Three fixes'][list.length]}:</p><ol class="plainlist">${fx}</ol>` : ''}`;
  } else { b4 = PENDING; pending.push('4 Booking test'); }
  sec('Booking test from a phone', '<p class="sub">We open your website on a phone the way a customer would and score how easy it is to ask for a quote. We never send your form.</p>' + b4);

  // 5 main category
  let b5 = '';
  if (ct && ct.main_category) {
    b5 = `<div class="rows"><div><span>Your Google main category</span><b>${t(ct.main_category)}</b></div>${ct.big_job ? `<div><span>The big-ticket job you want</span><b>${t(ct.big_job)}</b></div>` : ''}</div>`
      + (ct.match === false ? '<p>These do not match. Google leans on your main category to decide which searches to show you for.</p>' : '<p>These match. Good.</p>')
      + (ct.note ? `<p>${t(ct.note)}</p>` : '');
  } else { b5 = PENDING; pending.push('5 Main category'); }
  sec('Your Google main category and the big job you want', b5);

  // 6 answer speed: what research says about answer speed, and the after-hours estimate
  let b6 = '';
  const sp = s.speed;
  if (sp && sp.tested === false) b6 = `<p>We did not run this test for you: ${t(sp.reason)}</p>`;
  else if (sp) {
    const m = sp.minutes == null ? null : +sp.minutes;
    b6 = `<p>${own(TESTED, sp.channel)} on ${t(sp.when)}. `
      + (m == null ? `We waited ${t(+sp.waited_hours)} hours and got no answer.</p>`
        : m < 1440 ? `You answered in ${waitText(m)}.</p>` : `The answer took a day or more.</p>`);
    const e = speedEstimate(sp);
    if (e) b6 += `<p class="est"><b>What research says about answer speed (outside research, not your numbers):</b> ${esc(e.text)}</p><p class="src">Source: ${esc(SOURCES[e.src])}.</p>`;
    const ah = sp.after_hours;
    if (ah && ah.tested) b6 += `<p>${own(AH_TESTED, ah.channel)} on ${t(ah.when)}. ${ah.answered ? 'We got an answer.' : 'We got no answer.'}</p>`;
    const share = AFTER_HOURS[trade.slug];
    if (share) {
      let x = `In 2025, about ${pct(share.low)} to ${pct(share.high)} of every 100 calls to ${share.who} came outside business hours, depending on the month.`;
      if (sp.leads_per_month) x += ` You told us you get about ${t(+sp.leads_per_month)} calls a month, so that is roughly ${Math.round(+sp.leads_per_month * share.low / 100)} to ${Math.round(+sp.leads_per_month * share.high / 100)} calls a month after hours.`;
      if (ah && ah.tested && ah.answered === false) x += ` Our after-hours test ${own(CHANNEL, ah.channel)} got no answer, so some of those calls may be going unanswered now.`;
      b6 += `<p class="est"><b>After-hours calls (estimate):</b> ${esc(x)}</p><p class="src">Source: ${esc(SOURCES[share.src])}.</p>`;
    } else b6 += '<p class="sub">We do not have a trusted outside number for after-hours calls in your trade, so we give no after-hours estimate.</p>';
  } else { b6 = PENDING; pending.push('6 Answer speed'); }
  sec('How fast you answer a new customer', b6);

  // 7 what you're known for (repeated words in his Google reviews)
  let b7 = '';
  const kf = s.known_for;
  if (g && !g.has_google_profile) b7 = '<p>No Google profile yet, so there are no Google reviews to read.</p>';
  else if (kf && Array.isArray(kf.reviews)) {
    // only his 4 and 5 star reviews with words in them; the count of reviews we scanned comes from the fill
    const texts = kf.reviews.filter((x) => x && +x.rating >= 4 && plain(x.text).length > 0).map((x) => x.text);
    const scanned = +kf.scanned;
    const own = plain(rec.business_name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const words = texts.length >= 5 ? knownFor(texts, own) : [];
    const read = `We read ${scanned === 1 ? 'your one Google review' : `${scanned} of your Google reviews`}. ${texts.length === 1 ? 'One was' : `${texts.length} were`} 4 or 5 stars with words in ${texts.length === 1 ? 'it' : 'them'}.`;
    const toFix = reviewFixIn(rec) ? ' The review fix below is the place to start.' : '';
    if (words.length) b7 = `<p>${read} In those, these words came up again and again:</p><ul class="plainlist">${words.map((w) => `<li><b>"${esc(w.word)}"</b> in ${w.count} reviews</li>`).join('')}</ul><p>That is what your happy customers already say you are known for. Those are good words to use on your website and your Google profile.</p>`;
    else if (texts.length < 5) b7 = `<p>${read} That is not enough yet to see what customers say you are known for.${toFix}</p>`;
    else b7 = `<p>${read} No one word or phrase came up in 3 or more of them, so customers have not settled on one thing you are known for yet.</p>`;
  } else { b7 = PENDING; pending.push('7 What you are known for'); }
  sec('What your reviews say you are known for', b7);

  // 8 the competitor gap
  let b8 = '';
  const cv = competitorView(rec);
  if (g && !g.has_google_profile) b8 = '<p>You are not on the Google map yet, so there is no side by side to show. Fix 1 below comes first.</p>';
  else if (g && g.has_google_profile && (!g.top3 || !g.top3.length)) b8 = '<p>Google did not show a top 3 for your search, so there is no shop to compare you with.</p>';
  else if (cv && cv.first) b8 = '<p>You are number 1 for this search, so no shop outranks you here.</p>';
  else if (cv) {
    b8 = `<p>The top shop that shows above you is <b>${t(cv.name)}</b> (number ${cv.pos} in the top 3).</p>`
      + `<div class="rows cmp"><div><span></span><b>${t(cv.name)}</b><b>You</b></div>${cv.rows.map(([a, x, y]) => `<div><span>${esc(a)}</span><b>${t(x)}</b><b>${t(y)}</b></div>`).join('')}</div>`
      + (cv.gaps.length ? `<h3>The ${cv.gaps.length === 1 ? 'biggest gap' : cv.gaps.length + ' biggest gaps'}</h3><ol class="plainlist">${cv.gaps.map((x) => `<li>${t(x)}</li>`).join('')}</ol>` : '<p>We found no gap where they are ahead of you on these checks.</p>');
  } else { b8 = PENDING; pending.push('8 Competitor gap'); }
  sec('You and the top shop, side by side', b8);

  // 9 the listing check
  let b9 = '';
  const ls = s.listings;
  if (ls && ls.sites) {
    b9 = '<div class="rows">' + SITES.map(([k, label]) => { const x = ls.sites[k] || {}; return `<div><span>${esc(label)}</span><b>${!x.found ? 'Not found' : x.complete === false ? 'Found, needs work' : 'Found'}</b></div>`; }).join('') + '</div>';
    const weak = SITES.map(([k, label, fix]) => { const x = ls.sites[k] || {}; return !x.found ? [label, fix] : x.complete === false ? [label, x.fix] : null; }).filter(Boolean);
    b9 += weak.length ? '<h3>One simple fix for each weak one</h3><ul class="plainlist">' + weak.map(([label, fix]) => `<li><b>${esc(label)}:</b> ${t(fix)}</li>`).join('') + '</ul>' : '<p>Every one of these is in good shape.</p>';
  } else { b9 = PENDING; pending.push('9 Listing check'); }
  sec('Where customers can find you', '<p class="sub">We looked for your business in the six places customers check most.</p>' + b9);

  // budget (only when the owner told us a range)
  const bl = budgetLine(rec.revenue);
  if (bl) sec('A marketing budget line for your size', `<p>${esc(bl)}</p><p class="sub">Based only on the range you gave us.</p>`);

  // a gentle question (no data, no promise)
  sec('One honest question', '<p>Is your growth making you money? Some shops get busier and keep less. If more jobs have not meant more money in your pocket, that is worth a look before you spend more to grow.</p>');

  // three fixes
  sec('Three fixes, in plain words', '<ol class="plainlist">' + pickFixes(rec).map((x) => `<li>${t(x)}</li>`).join('') + '</ol>');

  // his open spot and his named guarantee. Every guarantee sentence is the site's own terms wording (terms.html).
  // Zone locks are only offered on the heating and air, plumbing and electrical price pages, so "Something else" gets neither.
  const spt = s.spot;
  if (trade.slug !== 'other') {
    if (spt) {
      const tw = TRADE_NAME[trade.slug];
      const spotP = spt.open ? `<p><b>Your spot is open.</b> We lock each zone to one ${esc(tw)}. The ${t(spt.zone)} zone is open for your trade right now. If your area is locked to you, we never work for or email another shop in your trade in your zone.</p>` : '';
      sec('Your spot and your guarantee', spotP
        + `<p class="est"><b>The ${t(rec.business_name)} Quote Guarantee.</b> Once your first paid month starts: new quotes you forward are contacted within 2 business days. ${esc(TERMS_GUARANTEE)}</p>`
        + `<p class="sub">${esc(TERMS_FREE)}</p>`);
    } else { pending.push('Spot and guarantee'); sec('Your spot and your guarantee', PENDING); }
  }

  // next step
  const href = `${SITE}/${trade.price}`;
  sec('One next step', `<p><a class="btn" href="${href}">Start your free 30 days</a></p><p class="sub">Nothing is charged for 30 days. Cancel any time with one reply.</p>`);

  const dg = diagnose(rec);
  if (!dg) pending.unshift('0 Diagnosis');
  const day = new Date(rec.received || Date.now()).toLocaleDateString('en-US', { timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric' });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Your free report | Booked Out Solutions</title><style>${CSS}</style></head><body><main>`
    + `<p class="brand">Booked Out Solutions</p><p class="kicker">Free report, ${esc(day)}</p>`
    + `<h1>Your free report for ${t(rec.business_name)}</h1>`
    + `<p class="lead">${t(rec.town)}. Built from your real Google listing and a few quick checks. It is yours to keep.</p>`
    + (dg ? `<p class="diag"><b>In one line:</b> ${t(dg.line)}</p>` : PENDING)
    + parts.join('')
    + `<footer><p>Questions? Reply to the email this came in, or write to <a href="mailto:hello@getbookedoutsolutions.com">hello@getbookedoutsolutions.com</a>.</p><p>Booked Out Solutions, Smyrna, Tennessee</p></footer>`
    + '</main></body></html>';
  return { html, pending, complete: pending.length === 0, diagnosis: dg ? dg.kind : '' };
}

const CSS = '@font-face{font-family:"Bricolage";src:url("/fonts/bricolage-grotesque.woff2") format("woff2");font-weight:200 800;font-display:swap}'
  + '@font-face{font-family:"Instrument";src:url("/fonts/instrument-sans.woff2") format("woff2");font-weight:400 700;font-display:swap}'
  + ':root{--ink:#0A0F26;--navy:#16204A;--royal:#2D3E86;--paper:#F6F1E7;--card:#FFFDF7;--gold:#EDB547;--goldhi:#FFD56B;--muted:#565B70;--line:rgba(10,15,38,.12)}'
  + '*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:18px/1.6 "Instrument",system-ui,-apple-system,"Segoe UI",sans-serif;overflow-x:hidden}'
  + 'main{max-width:46rem;margin:0 auto;padding:28px 16px 60px}h1,h2,h3{font-family:"Bricolage","Instrument",system-ui,sans-serif;letter-spacing:-.02em;line-height:1.1;margin:0}'
  + 'h1{font-size:clamp(30px,6vw,46px);margin:6px 0 10px}h2{font-size:22px;display:flex;gap:12px;align-items:center;margin-bottom:12px}h3{font-size:18px;margin:16px 0 8px}'
  + '.brand{font:800 15px/1 "Bricolage",sans-serif;letter-spacing:.06em;text-transform:uppercase;color:var(--royal);margin:0 0 4px}.kicker{color:var(--muted);margin:0}.lead{font-size:19px;color:var(--muted)}'
  + '.rsec{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px 18px;margin:16px 0;box-shadow:0 12px 30px -20px rgba(10,15,38,.35)}'
  + '.num{flex:none;display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--navy);color:var(--goldhi);font-size:16px}'
  + '.rows div{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-top:1px solid var(--line)}.rows div:first-child{border-top:0}.rows span{color:var(--muted)}.rows b{text-align:right}'
  + '.top3{margin:0;padding-left:22px}.top3 li{margin:4px 0}.top3 span{color:var(--muted)}.gap{background:#FFF1D2;border-radius:12px;padding:10px 12px;margin:12px 0 0}'
  + 'blockquote{margin:0 0 10px;padding:12px 14px;border-left:4px solid var(--gold);background:#fff;border-radius:8px}.when{color:var(--muted);font-size:15px}'
  + '.pending{background:rgba(45,62,134,.08);color:var(--royal);border-radius:12px;padding:10px 12px;margin:0}.sub{color:var(--muted);font-size:16.5px}'
  + '.plainlist{margin:0;padding-left:22px}.plainlist li{margin:6px 0}.score{font-size:20px}.score b{font:800 40px/1 "Bricolage",sans-serif;color:var(--royal)}'
  + '.btn{display:inline-block;background:linear-gradient(180deg,#FFF3C8 0%,#FFD56B 30%,#EDB547 62%,#C08A23 100%);color:#140F02;font-weight:700;text-decoration:none;padding:16px 26px;border-radius:999px}'
  + '.diag{background:var(--navy);color:#fff;border-radius:14px;padding:12px 14px;font-size:19px}.diag b{color:var(--goldhi)}'
  + '.est{background:#FFF1D2;border-radius:12px;padding:10px 12px}.src{color:var(--muted);font-size:14.5px;margin-top:4px}'
  + '.cmp div{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:8px}.cmp b{text-align:right}'
  + '.shots{display:grid;gap:10px}.shots img{max-width:100%;border:1px solid var(--line);border-radius:10px}.shots figcaption{color:var(--muted);font-size:15px}'
  + 'footer{color:var(--muted);font-size:16px;margin-top:28px}a{color:var(--royal)}';

// ---------- KV helpers ----------
const getJ = async (env, k) => JSON.parse((await env.KV.get(k)) || 'null');
const putJ = (env, k, v, ttl) => env.KV.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined);
const KEEP = 365 * DAY;
function rand(n) { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join(''); }
function newId(now) {
  const p = local(now), a = 'abcdefghijklmnopqrstuvwxyz0123456789', r = new Uint8Array(6);
  crypto.getRandomValues(r);
  return `fr-${p.y}${String(p.m).padStart(2, '0')}${String(p.d).padStart(2, '0')}-${Array.from(r, (x) => a[x % a.length]).join('')}`;
}
const keyOk = (env, k) => !!env.STATUS_KEY && typeof k === 'string' && k.length === env.STATUS_KEY.length && k === env.STATUS_KEY;

// ---------- request handlers ----------
async function submit(req, env, now = new Date()) {
  const raw = await req.text();
  if (raw.length > 10000) return json({ saved: false, error: 'too big' }, 413);
  let b; try { b = JSON.parse(raw); } catch { return json({ saved: false, error: 'bad json' }, 400); }
  if (b && (b.bot_field || b['bot-field'] || b.website)) return json({ saved: true, id: null }); // bots get a quiet "ok"
  if (!(+b.elapsed_ms >= 3000)) return json({ saved: false, error: 'too fast' }, 400);
  const v = validate(b);
  if (!v.ok) return json({ saved: false, error: 'check fields', errors: v.errors }, 400);
  const c = v.clean;
  if (await env.KV.get('rl:' + c.email)) return json({ saved: false, duplicate: true, error: 'already have it' }, 429);
  await env.KV.put('rl:' + c.email, '1', { expirationTtl: 600 });
  const id = newId(now), clock = businessClock(now);
  const rec = { id, token: rand(24), ...c, received: now.toISOString(), start: clock.start.toISOString(), due: clock.due.toISOString(),
    warn: clock.warn.toISOString(), status: 'new', alerts: {}, sections: {}, pending: [], complete: false,
    big_shop: BIG.includes(c.revenue), test: isTestRequest(c) };
  await putJ(env, 'req:' + id, rec, KEEP);
  await env.KV.put('open:' + id, '1', { expirationTtl: KEEP });
  await putJ(env, 'lead:' + id, { id, received: rec.received, first_name: c.first_name, business_name: c.business_name, email: c.email,
    phone: c.phone, trade: c.trade, town: c.town, revenue: c.revenue || '', consent: !!c.consent, page: c.page || '', test: rec.test });
  return json({ saved: true, id });
}

async function sha(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Renders and hashes first; writes to KV only when the page changed (the cron calls this every 15 minutes).
// Returns true when the page changed.
async function refreshReport(env, rec) {
  const r = renderReport(rec);
  const h = await sha(r.html);
  if (h === rec.hash) { rec.pending = r.pending; rec.complete = r.complete; return false; }
  await saveReport(env, rec);
  return true;
}
async function saveReport(env, rec) {
  const r = renderReport(rec);
  rec.pending = r.pending; rec.complete = r.complete;
  const h = await sha(r.html);
  if (h !== rec.hash) {
    // A new version of the report: any earlier check marks were for the old version, so they no longer count.
    if (rec.checks && Object.keys(rec.checks).length) rec.checks_cleared = (rec.checks_cleared || 0) + 1;
    rec.checks = {};
    if (rec.status === 'checked' || rec.status === 'held') rec.status = 'built';
    rec.hash = h;
  }
  await env.KV.put('rep:' + rec.id, r.html, { expirationTtl: KEEP });
  await env.KV.put('tok:' + rec.token, rec.id, { expirationTtl: KEEP });
  return r;
}

async function build(env, rec, f) {
  try {
    const l = await lookup(env, rec, f);
    if (l) { rec.sections.google = l.google; if (l.reviews) rec.sections.reviews = l.reviews; }
  } catch (e) { rec.lookup_error = String((e && e.message) || e).slice(0, 200); }
  await saveReport(env, rec);
  rec.status = 'built';
  rec.built = new Date().toISOString();
}

function alertText(rec, why) {
  const lines = [
    why,
    '',
    `Business: ${rec.business_name}`, `Town: ${rec.town}`, `Trade: ${rec.trade}`,
    `Name: ${rec.first_name}`, `Email: ${rec.email}`, `Phone: ${rec.phone}`,
    `OK to call or text: ${rec.consent ? 'yes' : 'no (email only)'}`,
    `Revenue range: ${rec.revenue || 'not given'}`,
  ];
  if (rec.big_shop) lines.push('FLAG: Booker call now option first (shop does $1M or more a year).');
  if (rec.note) lines.push(`What's going on: ${rec.note}`);
  lines.push('', `Received: ${chicagoText(rec.received)}`, `Due by: ${chicagoText(rec.due)} (Central)`,
    `Report: ${SITE}/r/${rec.token}/`,
    rec.complete ? 'Report is complete.' : `Still pending: ${(rec.pending || []).join(', ') || 'none'}`,
    rec.lookup_error ? `Lookup problem: ${rec.lookup_error}` : '',
    rec.test ? 'This is a TEST request (fake shop). Do not send.' : '',
    `Request id: ${rec.id}.`,
    'Nothing has been sent to this business.');
  return lines.filter((x, i, a) => x !== '' || a[i - 1] !== '').join('\n');
}

// The cron. Returns a short log of what it did (handy for tests).
async function tick(env, now = new Date(), f) {
  const log = [];
  const keys = (await env.KV.list({ prefix: 'open:' })).keys.slice(0, 200);
  let builds = 0;
  for (const k of keys) {
    const id = k.name.slice(5);
    const rec = await getJ(env, 'req:' + id);
    if (!rec || rec.status === 'sent') { await env.KV.delete(k.name); continue; }
    let changed = false;
    if (rec.status === 'new' && builds < 10) {
      builds++;
      await build(env, rec, f);
      changed = true;
      rec.alerts.built = now.toISOString(); log.push('built ' + id);
    } else if (rec.status === 'built' && rec.sections.reviews && rec.sections.reviews.task && !rec.sections.reviews.newest_review && (rec.sections.reviews.tries || 0) < 4) {
      rec.sections.reviews.tries = (rec.sections.reviews.tries || 0) + 1;
      try { Object.assign(rec.sections.reviews, await reviewsCall(env, rec.sections.reviews.task, f)); } catch (e) { /* next run */ }
      await saveReport(env, rec); changed = true; log.push('reviews ' + id);
    }
    if (rec.status === 'checked' && !rec.test) {
      // Re-render first: if the current code makes a different page (old record, new sections), the old marks are cleared
      // and nothing is sent until both checkers pass the new version.
      if (await refreshReport(env, rec)) { changed = true; log.push('rerendered ' + id); }
    }
    if (rec.status === 'checked' && !rec.test) {
      const r = await trySend(env, rec, now, f);
      if (r.changed) { changed = true; log.push(r.log + ' ' + id); }
      if (rec.status === 'sent') { await putJ(env, 'req:' + id, rec, KEEP); continue; }
    }
    if (rec.status !== 'new') {
      const due = Date.parse(rec.due), warn = Date.parse(rec.warn), at = now.getTime();
      if (at >= due && !rec.alerts.overdue) {
        await sendAlert(env, `OVERDUE free report: ${rec.business_name}`, alertText(rec, 'This free report is past its 1 business day promise and is not marked sent.'), f, rec.test ? 'test' : 'problem', id);
        rec.alerts.overdue = now.toISOString(); rec.alerts.warn = rec.alerts.warn || now.toISOString(); changed = true; log.push('overdue ' + id);
      } else if (at >= warn && at < due && !rec.alerts.warn) {
        await sendAlert(env, `Free report due soon: ${rec.business_name}`, alertText(rec, 'This free report is 75% of the way to its due time and is not marked sent.'), f, rec.test ? 'test' : 'warn', id);
        rec.alerts.warn = now.toISOString(); changed = true; log.push('warn ' + id);
      }
    }
    if (changed) await putJ(env, 'req:' + id, rec, KEEP);
  }
  return log;
}

// Sends a report that has two pass marks. Blocked sends (LIVE off) are only noted, once; real failures go on the
// watch list so the agents fix them. Returns {changed, log}.
async function trySend(env, rec, now, f) {
  if (!rec.complete || (rec.pending || []).length) return { changed: false, log: '' }; // backstop: never send an incomplete report
  const r = await deliverToOwner(env, rec, f);
  if (r.sent) {
    rec.status = 'sent'; rec.sent = now.toISOString(); rec.sent_by = 'auto'; rec.send_route = r.route; rec.send_id = r.id || '';
    await env.KV.delete('open:' + rec.id);
    try { await startFollowups(env, rec, now, r.threadId || ''); } catch (e) { /* never blocks saving the sent report */ }
    return { changed: true, log: 'sent' };
  }
  if (r.blocked) {
    if (rec.send_blocked === r.reason) return { changed: false, log: '' };
    rec.send_blocked = r.reason;
    return { changed: true, log: 'blocked' };
  }
  rec.send_fails = (rec.send_fails || 0) + 1;
  rec.send_error = r.reason;
  if (rec.send_fails === 1 || rec.send_fails % 4 === 0) {
    await sendAlert(env, `Free report send failed: ${rec.business_name}`, alertText(rec, `The report passed both checks but the send failed (${r.route}): ${r.reason}. It is tried again every 15 minutes. If the route is down, switch SEND_ROUTE to a backup.`), f, 'problem', rec.id);
  }
  return { changed: true, log: 'sendfail' };
}

// What the two checkers read: everything needed to trace every fact in the report to the lookup data.
function reviewItem(r) {
  const c = r.checks || {};
  return { id: r.id, status: r.status, test: !!r.test, first_name: r.first_name, business_name: r.business_name, email: r.email,
    town: r.town, trade: r.trade, revenue: r.revenue || '', note: r.note || '', big_shop: !!r.big_shop,
    received: r.received, due: r.due, due_text: chicagoText(r.due), complete: !!r.complete, pending: r.pending || [],
    report: `${SITE}/r/${r.token}/`, hash: r.hash || '', sections: r.sections || {}, lookup_error: r.lookup_error || '',
    checks: { 1: c['1'] || null, 2: c['2'] || null },
    needs: !r.complete ? 'fill pending sections first' : !(c['1'] && c['1'].result === 'pass' && c['1'].hash === r.hash) ? 'checker 1'
      : !(c['2'] && c['2'].result === 'pass' && c['2'].hash === r.hash) ? 'checker 2' : 'send' };
}
async function review(u, env) {
  if (!keyOk(env, u.searchParams.get('k'))) return json({ error: 'no' }, 403);
  const list = [];
  for (const k of (await env.KV.list({ prefix: 'open:' })).keys) {
    const r = await getJ(env, 'req:' + k.name.slice(5));
    if (!r || !['built', 'held', 'checked'].includes(r.status)) continue;
    list.push(reviewItem(r));
  }
  list.sort((a, b) => a.due.localeCompare(b.due));
  return json({ waiting: list, count: list.length, live: isLive(env) });
}
async function check(req, env, now = new Date(), f) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!keyOk(env, b && b.k)) return json({ ok: false, error: 'no' }, 403);
  const slot = String(b.checker);
  const agent = String(b.agent || '').trim().slice(0, 80);
  if (!ID.test(String(b.id || '')) || !['1', '2'].includes(slot) || !agent || !['pass', 'fail'].includes(b.result)) return json({ ok: false, error: 'bad check' }, 400);
  const rec = await getJ(env, 'req:' + b.id);
  if (!rec) return json({ ok: false, error: 'not found' }, 404);
  if (rec.status === 'sent') return json({ ok: false, error: 'already sent' }, 409);
  if (!['built', 'held', 'checked'].includes(rec.status)) return json({ ok: false, error: 'not built yet' }, 409);
  // Always judge the page as the CURRENT code renders it: an old record (saved by older code) can carry a stale
  // complete flag and hash. A re-render that changes the page clears the old marks and makes a new version.
  if (await refreshReport(env, rec)) await putJ(env, 'req:' + rec.id, rec, KEEP);
  if (String(b.hash || '') !== rec.hash) return json({ ok: false, error: 'report changed; read it again', hash: rec.hash }, 409);
  rec.checks = rec.checks || {};
  const other = rec.checks[slot === '1' ? '2' : '1'];
  if (other && other.agent === agent) return json({ ok: false, error: 'checker 1 and checker 2 must be different agents' }, 409);
  if (slot === '2' && b.result === 'pass' && !(rec.checks['1'] && rec.checks['1'].result === 'pass' && rec.checks['1'].hash === rec.hash))
    return json({ ok: false, error: 'checker 1 must pass first' }, 409);
  if (b.result === 'pass' && !rec.complete) return json({ ok: false, error: 'report has pending sections; it cannot pass' }, 409);
  const notes = String(b.notes || '').slice(0, 2000);
  rec.checks[slot] = { agent, result: b.result, hash: rec.hash, at: now.toISOString(), notes };
  let sent = false;
  if (b.result === 'fail') {
    rec.status = 'held';
    await sendAlert(env, `Free report failed check ${slot}: ${rec.business_name}`, alertText(rec, `Checker ${slot} (${agent}) failed this report: ${notes || 'no notes'}. Fix it (fill the section again), then both checkers read it again.`), f, rec.test ? 'test' : 'problem', rec.id);
  } else if (rec.checks['1'] && rec.checks['2'] && rec.checks['1'].result === 'pass' && rec.checks['2'].result === 'pass') {
    rec.status = 'checked';
    if (!rec.test) { const r = await trySend(env, rec, now, f); sent = rec.status === 'sent'; }
  }
  await putJ(env, 'req:' + rec.id, rec, KEEP);
  return json({ ok: true, id: rec.id, status: rec.status, sent, blocked: rec.send_blocked || '' });
}

// ---------- follow-ups (locked sequence in freereport-followups-seq.js; logic in freereport-followups.js) ----------
function fuHelpers() {
  return { site: SITE, townState, plain, pickFixes, TRADES, local, isBusinessDay, fromLocal,
    chicagoDate: (d) => new Date(d).toLocaleDateString('en-US', { timeZone: TZ, month: 'long', day: 'numeric' }) };
}
async function startFollowups(env, rec, now, threadId) {
  if (rec.test || rec.fu) return;
  rec.fu = { day0: now.toISOString(), hour: Math.min(16, Math.max(8, local(now).h)), thread: threadId, msgid: rec.send_msgid || '',
    subject: ownerEmail(env, rec).subject, done: {}, facts: [], started: now.toISOString(),
    // the three fixes exactly as they were on the page he got; follow-ups quote these, never a re-pick by newer code
    fixes: pickFixes(rec) };
  try { await env.KV.put('fu:' + rec.id, '1', { expirationTtl: 3 * KEEP }); } catch (e) { rec.fu.marker_error = String((e && e.message) || e).slice(0, 200); }
}
async function fuStop(env, rec, why, now) {
  rec.fu.stopped = { why, at: now.toISOString() };
  await env.KV.delete('fu:' + rec.id);
  if (rec.email) await env.KV.put('stop:' + rec.email, why);
}
// One pass over every running sequence. At most one email per owner per day; any doubt = hold.
async function fuTick(env, now, f) {
  const log = [], h = fuHelpers();
  // Every running sequence, paged (finished ones delete their key, so the list stays short); newest first.
  let keys = [], cursor;
  for (let i = 0; i < 10; i++) {
    const r = await env.KV.list({ prefix: 'fu:', cursor });
    keys = keys.concat(r.keys || []);
    if (r.list_complete !== false || !r.cursor) break;
    cursor = r.cursor;
  }
  keys.reverse();
  for (const k of keys.slice(0, 300)) {
    try { await fuOne(env, k, now, f, h, log); } catch (e) { log.push('fu-error ' + k.name + ' ' + String((e && e.message) || e).slice(0, 80)); }
  }
  return log;
}
async function fuOne(env, k, now, f, h, log) {
  {
    const id = k.name.slice(3), rec = await getJ(env, 'req:' + id);
    if (!rec || !rec.fu || rec.fu.stopped) { await env.KV.delete(k.name); return; }
    const stopKey = rec.email ? await env.KV.get('stop:' + rec.email) : null;
    const n = FU.next(rec, env, now, h, stopKey);
    if (n.action === 'none' && /finished/.test(n.why || '')) { await env.KV.delete(k.name); log.push('fu-finished ' + id); return; }
    if (n.action === 'stop') { await fuStop(env, rec, n.why, now); await putJ(env, 'req:' + id, rec, KEEP); log.push('fu-stop ' + id); return; }
    if (n.action === 'skip') { rec.fu.done[n.step] = { at: now.toISOString(), status: 'skipped', why: n.why }; await putJ(env, 'req:' + id, rec, KEEP); log.push('fu-skip ' + n.step + ' ' + id); return; }
    if (n.action === 'hold' && rec.fu.hold !== n.why) { rec.fu.hold = n.why; await putJ(env, 'req:' + id, rec, KEEP); log.push('fu-hold ' + id); return; }
    if (n.action !== 'send') return;
    // Know there is no reply: the thread read, or a fresh "clear" stamp from the inbox job.
    let inReplyTo = rec.fu.msgid || '';
    const t = await gmailThread(env, rec.fu.thread, f);
    if (t.ok) {
      const th = FU.readThread(t.thread, 'rickey@getbookedoutsolutions.com');
      if (th.replied) { await fuStop(env, rec, 'reply or bounce in the thread', now); await putJ(env, 'req:' + id, rec, KEEP); log.push('fu-stop-reply ' + id); return; }
      inReplyTo = th.messageId || inReplyTo;
    } else if (!(rec.fu.clear_at && now.getTime() - Date.parse(rec.fu.clear_at) < FU.CLEAR_WINDOW_MS)) {
      const why = 'cannot confirm no reply (' + t.error + '); needs the thread read or an inbox clear stamp';
      if (rec.fu.hold !== why) {
        rec.fu.hold = why; await putJ(env, 'req:' + id, rec, KEEP);
        await sendAlert(env, `Free report follow-up held: ${rec.business_name}`, `Step ${n.step} is due but we cannot confirm there is no reply. ${why}.`, f, 'warn', id);
      }
      log.push('fu-hold-noread ' + id); return;
    }
    const m = { from: env.SEND_FROM || FROM, to: rec.email, subject: 'Re: ' + rec.fu.subject, text: n.text, threadId: rec.fu.thread || '', inReplyTo };
    // Claim the step and the day BEFORE sending: a missed email is safe, a double email is not.
    const day = new Date(now).toLocaleDateString('en-CA', { timeZone: TZ });
    const ck = `fusend:${id}:${day}`, mine = n.step + ':' + rand(6);
    if (await env.KV.get(ck)) { log.push('fu-claimed ' + id); return; }
    await env.KV.put(ck, mine, { expirationTtl: 3 * DAY });
    if ((await env.KV.get(ck)) !== mine) { log.push('fu-claimed ' + id); return; } // another run claimed it first
    const prevDay = rec.fu.last_sent_day;
    rec.fu.done[n.step] = { at: now.toISOString(), status: 'sending' };
    rec.fu.last_sent_day = day;
    await putJ(env, 'req:' + id, rec, KEEP);
    const r = await sendMail(env, m, f);
    if (r.ok) {
      rec.fu.done[n.step] = { at: now.toISOString(), status: 'sent', id: r.id || '' };
      rec.fu.facts = [...new Set([...(rec.fu.facts || []), ...n.facts])];
      rec.fu.hold = ''; rec.fu.clear_at = '';
      log.push('fu-sent ' + n.step + ' ' + id);
    } else {
      // Free the day only when the email surely did not go (no token, or Gmail said no with a 4xx). On a timeout or a
      // 5xx it may have gone, so today stays claimed; the step is tried again on the next sending day.
      delete rec.fu.done[n.step];
      if (/^(gmail route not set up|gmail token|gmail send 4)/.test(String(r.error || ''))) { rec.fu.last_sent_day = prevDay; await env.KV.delete(`fusend:${id}:${day}`); }
      rec.fu.fails = (rec.fu.fails || 0) + 1;
      if (rec.fu.fails === 1 || rec.fu.fails % 4 === 0) await sendAlert(env, `Free report follow-up send failed: ${rec.business_name}`, `Step ${n.step}: ${r.error}`, f, 'problem', id);
      log.push('fu-fail ' + id);
    }
    await putJ(env, 'req:' + id, rec, KEEP);
  }
}
// POST /api/free-report/followup {id, k, action: "stop" | "later" | "clear" | "status", why}
// stop  = any reply, "no", "stop", bounce, anger, or he paid/started (the reply desk calls this). Forever.
// later = he said "later" / "check back": the main steps end, the not-now ladder starts from today.
// clear = the inbox job just looked: no reply from him in the thread (good for 2 hours).
async function followup(req, env, now = new Date()) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!keyOk(env, b && b.k)) return json({ ok: false, error: 'no' }, 403);
  if (!ID.test(String(b.id || '')) || !['stop', 'later', 'clear', 'status'].includes(b.action)) return json({ ok: false, error: 'bad followup' }, 400);
  const rec = await getJ(env, 'req:' + b.id);
  if (!rec || !rec.fu) return json({ ok: false, error: 'no sequence for this id' }, 404);
  if (b.action === 'stop') await fuStop(env, rec, String(b.why || 'stopped by the reply desk').slice(0, 200), now);
  else if (b.action === 'later' && !rec.fu.stopped) rec.fu.later_at = now.toISOString();
  else if (b.action === 'clear' && !rec.fu.stopped) rec.fu.clear_at = now.toISOString();
  if (b.action !== 'status') await putJ(env, 'req:' + rec.id, rec, KEEP);
  const plan = rec.fu.stopped ? [] : FU.plan(rec, fuHelpers()).map((s) => ({ step: s.id, due: `${s.due.y}-${String(s.due.m).padStart(2, '0')}-${String(s.due.d).padStart(2, '0')}`, done: rec.fu.done[s.id] || null }));
  return json({ ok: true, id: rec.id, stopped: rec.fu.stopped || null, later_at: rec.fu.later_at || '', hold: rec.fu.hold || '', plan,
    next: FU.next(rec, env, now, fuHelpers(), null).action });
}

async function markSent(req, env) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!keyOk(env, b && b.k)) return json({ ok: false, error: 'no' }, 403);
  if (!ID.test(String(b.id || ''))) return json({ ok: false, error: 'bad id' }, 400);
  const rec = await getJ(env, 'req:' + b.id);
  if (!rec) return json({ ok: false, error: 'not found' }, 404);
  rec.status = 'sent'; rec.sent = new Date().toISOString(); rec.sent_by = 'manual';
  await putJ(env, 'req:' + rec.id, rec, KEEP);
  await env.KV.delete('open:' + rec.id);
  return json({ ok: true, id: rec.id, status: 'sent' });
}

const FILL = ['google', 'reviews', 'ai', 'booking', 'category', 'speed', 'known_for', 'competitor', 'listings', 'spot'];
async function fill(req, env) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!keyOk(env, b && b.k)) return json({ ok: false, error: 'no' }, 403);
  if (!ID.test(String(b.id || '')) || !FILL.includes(b.section) || !b.data || typeof b.data !== 'object') return json({ ok: false, error: 'bad fill' }, 400);
  const rec = await getJ(env, 'req:' + b.id);
  if (!rec) return json({ ok: false, error: 'not found' }, 404);
  const why = fillProblem(rec, b.section, b.data);
  if (why) return json({ ok: false, error: 'bad fill: ' + why }, 400);
  // Screenshots: only ones hosted for THIS report through /shot (so the page never points at a missing or foreign image).
  if (b.section === 'ai' && Array.isArray(b.data.screenshots)) {
    for (const x of b.data.screenshots) {
      const st = await shotRead(env, rec.id, x.engine);
      if (!st || x.url !== shotUrl(rec, x.engine, st.v))
        return json({ ok: false, error: `bad fill: screenshot for ${x.engine} is not hosted for this report (POST /api/free-report/shot first)` }, 400);
    }
  }
  // A tested answer speed result means someone contacted a real business. Refused for real requests until SPEED_TEST_LIVE is on.
  if (b.section === 'speed' && b.data.tested !== false && !rec.test && !speedLive(env))
    return json({ ok: false, error: 'speed test results for a real shop are refused until SPEED_TEST_LIVE is on (after GO LIVE)' }, 403);
  rec.sections[b.section] = b.data;
  const r = await saveReport(env, rec);
  await putJ(env, 'req:' + rec.id, rec, KEEP);
  return json({ ok: true, id: rec.id, complete: r.complete, pending: r.pending, diagnosis: r.diagnosis });
}

// AI answer screenshots, hosted in the same KV namespace (free; no new storage). PNG only, up to 1 MB each, one per engine.
const SHOT_ENGINES = ['chatgpt', 'gemini', 'google_ai'];
const SHOT_MAX = 1024 * 1024;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// ?v= is the first 8 of the image's sha, so the page (and its hash) changes when the image changes.
function shotUrl(rec, engine, v) { return `${SITE}/r/${rec.token}/ai-${engine}.png${v ? '?v=' + v : ''}`; }
async function shotRead(env, id, engine) {
  const raw = await env.KV.get(`shot:${id}:${engine}`);
  if (!raw) return null;
  try { const j = JSON.parse(raw); return j && typeof j.png === 'string' && /^[a-f0-9]{8}$/.test(j.v || '') ? j : null; } catch { return null; }
}
function pngBytes(b64) {
  if (typeof b64 !== 'string' || !b64.length || b64.length > Math.ceil(SHOT_MAX / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  let bin; try { bin = atob(b64); } catch { return null; }
  if (bin.length < 16 || bin.length > SHOT_MAX) return null;
  const by = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) by[i] = bin.charCodeAt(i);
  return PNG_MAGIC.every((x, i) => by[i] === x) ? by : null;
}
async function shot(req, env) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!keyOk(env, b && b.k)) return json({ ok: false, error: 'no' }, 403);
  if (!ID.test(String(b.id || '')) || !SHOT_ENGINES.includes(b.engine)) return json({ ok: false, error: 'bad shot' }, 400);
  if (!pngBytes(b.png)) return json({ ok: false, error: 'bad shot: png must be a base64 PNG image of 1 MB or less' }, 400);
  const rec = await getJ(env, 'req:' + b.id);
  if (!rec) return json({ ok: false, error: 'not found' }, 404);
  if (rec.status === 'sent') return json({ ok: false, error: 'already sent' }, 409);
  // A checked report is frozen: a new image would change what both checkers passed.
  if (rec.status === 'checked') return json({ ok: false, error: 'report already checked; screenshots are frozen' }, 409);
  const v = (await sha(b.png)).slice(0, 8);
  const had = await shotRead(env, rec.id, b.engine);
  if (had) {
    // the same image again is fine (a re-run); a different one is refused (one screenshot per engine)
    if (had.v === v) return json({ ok: true, id: rec.id, engine: b.engine, url: shotUrl(rec, b.engine, v), again: true });
    return json({ ok: false, error: 'this engine already has a screenshot for this report' }, 409);
  }
  await env.KV.put(`shot:${rec.id}:${b.engine}`, JSON.stringify({ v, png: b.png }), { expirationTtl: KEEP });
  return json({ ok: true, id: rec.id, engine: b.engine, url: shotUrl(rec, b.engine, v) });
}
async function shotGet(token, engine, env) {
  const id = await env.KV.get('tok:' + token);
  const st = id ? await shotRead(env, id, engine) : null;
  const by = st ? pngBytes(st.png) : null;
  if (!by) return new Response('not found', { status: 404, headers: { 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store' } });
  return new Response(by, { status: 200, headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=300',
    'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
}

// POST /api/free-report/rerender {k}: renders every open request again with the current code (run once after a deploy that
// changes the report). A page that changes gets a new hash and loses its old check marks. Sends nothing, calls nothing.
async function rerender(req, env) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!keyOk(env, b && b.k)) return json({ ok: false, error: 'no' }, 403);
  const out = { ok: true, checked: 0, changed: 0, marks_cleared: 0, items: [] };
  let keys = [], cursor;
  for (let i = 0; i < 50; i++) {
    const page = await env.KV.list({ prefix: 'open:', cursor });
    keys = keys.concat(page.keys || []);
    if (page.list_complete !== false || !page.cursor) break;
    cursor = page.cursor;
  }
  for (const k of keys) {
    const rec = await getJ(env, 'req:' + k.name.slice(5));
    if (!rec || rec.status === 'sent' || rec.status === 'new') continue;
    out.checked++;
    const before = rec.hash, hadMarks = !!(rec.checks && Object.keys(rec.checks).length);
    if (await refreshReport(env, rec)) {
      out.changed++; if (hadMarks) out.marks_cleared++;
      await putJ(env, 'req:' + rec.id, rec, KEEP);
    }
    out.items.push({ id: rec.id, status: rec.status, changed: rec.hash !== before, complete: rec.complete, pending: rec.pending });
  }
  return json(out);
}

async function status(u, env) {
  if (!keyOk(env, u.searchParams.get('k'))) return json({ error: 'no' }, 403);
  const keys = (await env.KV.list({ prefix: 'open:' })).keys;
  const now = Date.now(), list = [];
  for (const k of keys) {
    const r = await getJ(env, 'req:' + k.name.slice(5));
    if (!r || r.status === 'sent') continue;
    list.push({ id: r.id, business_name: r.business_name, town: r.town, trade: r.trade, status: r.status, test: !!r.test,
      big_shop: !!r.big_shop, consent: !!r.consent, received: r.received, due: r.due, due_text: chicagoText(r.due),
      overdue: now >= Date.parse(r.due), complete: !!r.complete, pending: r.pending || [], report: `${SITE}/r/${r.token}/`,
      checks: reviewItem(r).checks, needs: reviewItem(r).needs, send_blocked: r.send_blocked || '', send_error: r.send_error || '' });
  }
  list.sort((a, b) => a.due.localeCompare(b.due));
  const watch = [];
  for (const k of (await env.KV.list({ prefix: 'watch:' })).keys.slice(-50)) {
    const w = await getJ(env, k.name); if (w) watch.push({ at: w.at, level: w.level, id: w.id, subject: w.subject });
  }
  return json({ open: list, count: list.length, live: isLive(env), watch, problems: watch.filter((w) => w.level === 'problem').length });
}

async function report(token, u, env) {
  if (!u.pathname.endsWith('/')) return Response.redirect(`${SITE}/r/${token}/`, 301);
  const id = await env.KV.get('tok:' + token);
  const html = id ? await env.KV.get('rep:' + id) : null;
  return new Response(html || GONE, { status: html ? 200 : 404, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer', 'x-frame-options': 'SAMEORIGIN' } });
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const p = u.pathname.replace(/\/+$/, '');
    try {
      if (p === '/api/free-report' && req.method === 'POST') return await submit(req, env);
      if (p === '/api/free-report/ping') return json({ ok: true, at: new Date().toISOString(), live: isLive(env) });
      if (p === '/api/free-report/status' && req.method === 'GET') return await status(u, env);
      if (p === '/api/free-report/review' && req.method === 'GET') return await review(u, env);
      if (p === '/api/free-report/check' && req.method === 'POST') return await check(req, env);
      if (p === '/api/free-report/mark-sent' && req.method === 'POST') return await markSent(req, env);
      if (p === '/api/free-report/fill' && req.method === 'POST') return await fill(req, env);
      if (p === '/api/free-report/rerender' && req.method === 'POST') return await rerender(req, env);
      if (p === '/api/free-report/followup' && req.method === 'POST') return await followup(req, env);
      if (p === '/api/free-report/shot' && req.method === 'POST') return await shot(req, env);
      const m = p.match(/^\/r\/([a-f0-9]{48})$/);
      if (m && req.method === 'GET') return await report(m[1], u, env);
      const ms = p.match(/^\/r\/([a-f0-9]{48})\/ai-(chatgpt|gemini|google_ai)\.png$/);
      if (ms && req.method === 'GET') return await shotGet(ms[1], ms[2], env);
      // anything else under /r/ is not a page we serve
      if (p.startsWith('/r/')) return new Response(GONE, { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' } });
      return new Response('Booked Out free report', { status: 200, headers: { 'x-robots-tag': 'noindex' } });
    } catch (e) {
      return json({ saved: false, error: 'server' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, new Date()).then(() => fuTick(env, new Date())));
  },
  // for workers/test-freereport.mjs (plain node, no network)
  _t: { validate, businessClock, federalHolidays, isBusinessDay, local, fromLocal, chicagoText, isLive, deliverToOwner,
    sendAlert, isTestRequest, plain, ownerEmail, mime, sendMail, sendBlock, check, review, trySend, sha, budgetLine, renderReport, submit, build, tick, TRADES, REVENUE,
    fuTick, followup, startFollowups, fuHelpers, gmailThread, allowed, pickFixes,
    diagnose, speedFinding, FIVE_MIN_TEST: FU.FIVE_MIN_TEST, bookingList: FU.bookingList, bookingFixOk: FU.bookingFixOk, knownFor, competitorView, refreshReport, speedEstimate, fillProblem, fill, rerender, SOURCES, FEW_REVIEWS, FILL,
    shot, shotUrl, pngBytes, SHOT_ENGINES, townState },
};

const GONE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Report not found | Booked Out Solutions</title><style>body{margin:0;font:18px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#F6F1E7;color:#0A0F26}main{max-width:34rem;margin:0 auto;padding:3rem 1.2rem}</style></head><body><main><h1>This report is not here</h1><p>The link may be old or mistyped. Reply to the email it came in and we will send it again, or write to hello@getbookedoutsolutions.com.</p><p>Booked Out Solutions</p></main></body></html>';

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
