// Booked Out Solutions - free report worker "bookedout-freereport" (Nov 16 2026).
// Saves each free report request from getbookedoutsolutions.com, builds the one-page report,
// and keeps the 1-business-day clock. Netlify proxies /api/free-report* and /r/* on our domain
// to this worker, so visitors only ever see our domain.
//
// Routes:
//   POST /api/free-report                 the form (JSON) -> {saved:true, id}
//   GET  /api/free-report/ping            health check
//   GET  /api/free-report/status?k=KEY    open requests with due times (evening list and TV)
//   POST /api/free-report/mark-sent       {id, k} -> status "sent", clock stops
//   POST /api/free-report/fill            {id, k, section, data} -> a later job fills a pending section
//                                         section: "google" | "reviews" | "ai" | "booking" | "category"
//   GET  /r/<token>/                      the report page (noindex, no-store, no-referrer)
// Cron (every 15 minutes): build new reports, then tell Rickey: built (check and send), 75% of the clock, overdue.
//
// Storage (KV binding KV):
//   req:<id>      the request and its clock {status: new | built | sent, ...}
//   open:<id>     marker while the request is not sent (the cron reads these)
//   tok:<token>   report token -> id
//   rep:<id>      the report page HTML
//   rl:<email>    one request per email per 10 minutes
//   alert:last    result of the last alert post
//
// Settings (names only, values are added in the Cloudflare dashboard, never here):
//   LOOKUP_URL, LOOKUP_KEY   optional; the lookup worker. Without them the Google parts say "pending check".
//   STATUS_KEY               needed for status, mark-sent and fill.
//   ALERT_FORM_URL           where alerts are posted as the hidden site form "bo-alert" (default our site).
//   LIVE                     "off" by default. While off, nothing is ever sent to a business owner.
// Alerts go to Rickey only (the site form emails the site owner). No secrets in this file.

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

// ---------- the LIVE guard ----------
// Before GO LIVE (LIVE is not "on") the worker never emails or texts a business owner. It only tells Rickey.
function isLive(env) { return String((env && env.LIVE) || 'off').trim().toLowerCase() === 'on'; }
async function deliverToOwner(env, rec) {
  if (!isLive(env)) return { sent: false, blocked: true, reason: 'LIVE is off: nothing goes to a business before GO LIVE' };
  // No automatic owner email exists yet. After GO LIVE, Rickey checks each report and sends it himself.
  return { sent: false, blocked: false, reason: 'no automatic owner email yet; Rickey sends after checking' };
}
// Every outside call goes through here. Only the alert form and the lookup worker are allowed.
function allowed(env, url) {
  const ok = [env.ALERT_FORM_URL || SITE + '/', env.LOOKUP_URL].filter(Boolean);
  return ok.includes(url);
}
async function out(env, url, init, f) {
  if (!allowed(env, url)) throw new Error('blocked outbound call');
  return (f || fetch)(url, init);
}

// ---------- alerts to Rickey (hidden site form "bo-alert", emailed to the site owner) ----------
async function sendAlert(env, subject, message, f) {
  const url = env.ALERT_FORM_URL || SITE + '/';
  const body = new URLSearchParams({ 'form-name': 'bo-alert', subject: String(subject).slice(0, 200), message: String(message).slice(0, 5000) });
  let res = '';
  try {
    const r = await out(env, url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString() }, f);
    res = String(r.status);
  } catch (e) { res = 'error ' + String((e && e.message) || e); }
  if (env.KV) await env.KV.put('alert:last', JSON.stringify({ at: new Date().toISOString(), subject, res }));
  return res;
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
  const google = { has_google_profile: !!g.has_google_profile, rating: g.rating ?? null, review_count: g.review_count ?? null,
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
  return String(s == null ? '' : s).replace(/\s*[\u2012-\u2015]\s*/g, ', ').replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, '').replace(/\s{2,}/g, ' ').trim();
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

function pickFixes(rec) {
  const s = rec.sections || {}, g = s.google, rv = s.reviews, bk = s.booking, ct = s.category, ai = s.ai, out = [];
  if (g && !g.has_google_profile) out.push('Set up your free Google Business Profile with your real address or service area, hours and phone number. Without it, you do not show on the Google map.');
  if (g && g.has_google_profile && g.top3 && g.top3.length && g.review_count != null) {
    const avg = Math.round(g.top3.reduce((a, x) => a + (+x.review_count || 0), 0) / g.top3.length);
    if (avg > g.review_count) out.push(`Ask every happy customer for a Google review the day the job is done. The top 3 near you average ${avg} reviews; you have ${g.review_count}.`);
  }
  if (rv && rv.newest_review && !rv.owner_reply_on_newest) out.push('Reply to your newest Google review today, and to every new review within a day from now on. The next customer reads those replies.');
  if (ct && ct.match === false) out.push(`Change your Google main category to the one that fits ${plain(ct.big_job || 'the big-ticket job you want most')}, so Google shows you for that work.`);
  if (bk && Array.isArray(bk.fixes) && bk.fixes[0]) out.push(plain(bk.fixes[0]));
  if (ai && ai.chatgpt && ai.chatgpt.named === false) out.push('Put your town, your main services and your best reviews in plain words on your website, so ChatGPT and Gemini have something to say about you.');
  const base = [
    'Put your phone number and a clear "Get a quote" button at the top of every page of your website.',
    'Call or text back every new lead within 5 minutes, even after hours.',
    'Follow up on every quote you send: a short note 2 days later, then again a week later.',
  ];
  for (const b of base) if (out.length < 3) out.push(b);
  return out.slice(0, 3);
}

const PENDING = '<p class="pending"><b>Pending check.</b> We are finishing this part now. It will be filled in before we send your report.</p>';

// Returns {html, pending:[section names], complete}
function renderReport(rec) {
  const s = rec.sections || {}, g = s.google, rv = s.reviews, ai = s.ai, bk = s.booking, ct = s.category;
  const trade = TRADES[rec.trade] || TRADES['Something else'];
  const pending = [], parts = [];
  let n = 0;
  const sec = (title, body) => { n++; parts.push(`<section class="rsec"><h2><span class="num">${n}</span>${esc(title)}</h2>${body}</section>`); };

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
    else rows.push([`Where you show for "${t(kw)}"`, 'Not in the first 20 results']);
    b1 = '<div class="rows">' + rows.map(([a, v]) => `<div><span>${esc(a)}</span><b>${v}</b></div>`).join('') + '</div>';
    if (!kw) b1 += PENDING;
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
    const line = (name, x) => `<li><b>${name}:</b> ${x.named ? 'you were on the list' : 'you were not on the list'}${x.correct === false ? ', and some of what it said about you was wrong' : ''}.${x.note ? ' ' + t(x.note) : ''}</li>`;
    b3 = (ai.question ? `<p>We asked both: "${t(ai.question)}"</p>` : '') + `<ul class="plainlist">${line('ChatGPT', ai.chatgpt)}${line('Gemini', ai.gemini)}</ul>`;
  } else { b3 = PENDING; pending.push('3 ChatGPT and Gemini test'); }
  sec('The ChatGPT and Gemini 2-minute test', '<p class="sub">More people now ask ChatGPT or Gemini who to call. We ask both the question your best customer would ask, and check if you come up.</p>' + b3);

  // 4 booking test
  let b4 = '';
  if (bk && bk.score != null) {
    const fx = (bk.fixes || []).slice(0, 3).map((x) => `<li>${t(x)}</li>`).join('');
    b4 = `<p class="score"><b>${t(Math.max(0, Math.min(10, +bk.score)))}</b> out of 10</p>${fx ? `<p>Three fixes:</p><ol class="plainlist">${fx}</ol>` : ''}`;
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

  // 6 budget (only when the owner told us a range)
  const bl = budgetLine(rec.revenue);
  if (bl) sec('A marketing budget line for your size', `<p>${esc(bl)}</p><p class="sub">Based only on the range you gave us.</p>`);

  // 7 three fixes
  sec('Three fixes, in plain words', '<ol class="plainlist">' + pickFixes(rec).map((x) => `<li>${t(x)}</li>`).join('') + '</ol>');

  // 8 next step
  const href = `${SITE}/${trade.price}`;
  sec('One next step', `<p><a class="btn" href="${href}">Start your free 30 days</a></p><p class="sub">Nothing is charged for 30 days. Cancel any time with one reply.</p>`);

  const day = new Date(rec.received || Date.now()).toLocaleDateString('en-US', { timeZone: TZ, month: 'long', day: 'numeric', year: 'numeric' });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>Your free report | Booked Out Solutions</title><style>${CSS}</style></head><body><main>`
    + `<p class="brand">Booked Out Solutions</p><p class="kicker">Free report, ${esc(day)}</p>`
    + `<h1>Your free report for ${t(rec.business_name)}</h1>`
    + `<p class="lead">${t(rec.town)}. Built from your real Google listing and a few quick checks. It is yours to keep.</p>`
    + parts.join('')
    + `<footer><p>Questions? Reply to the email this came in, or write to <a href="mailto:hello@getbookedoutsolutions.com">hello@getbookedoutsolutions.com</a>.</p><p>Booked Out Solutions, Smyrna, Tennessee</p></footer>`
    + '</main></body></html>';
  return { html, pending, complete: pending.length === 0 };
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
  return json({ saved: true, id });
}

async function saveReport(env, rec) {
  const r = renderReport(rec);
  rec.pending = r.pending; rec.complete = r.complete;
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
    `Request id: ${rec.id}. Mark it sent once it is out.`,
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
      await sendAlert(env, `${rec.test ? 'TEST ' : ''}Free report built: check and send, ${rec.business_name}${rec.big_shop ? ' (Booker call now option first)' : ''}`,
        alertText(rec, 'A free report is built. Please check it and send it.'), f);
      rec.alerts.built = now.toISOString(); log.push('built ' + id);
    } else if (rec.status === 'built' && rec.sections.reviews && rec.sections.reviews.task && !rec.sections.reviews.newest_review && (rec.sections.reviews.tries || 0) < 4) {
      rec.sections.reviews.tries = (rec.sections.reviews.tries || 0) + 1;
      try { Object.assign(rec.sections.reviews, await reviewsCall(env, rec.sections.reviews.task, f)); } catch (e) { /* next run */ }
      await saveReport(env, rec); changed = true; log.push('reviews ' + id);
    }
    if (rec.status !== 'new') {
      const due = Date.parse(rec.due), warn = Date.parse(rec.warn), at = now.getTime();
      if (at >= due && !rec.alerts.overdue) {
        await sendAlert(env, `OVERDUE free report: ${rec.business_name}`, alertText(rec, 'This free report is past its 1 business day promise and is not marked sent.'), f);
        rec.alerts.overdue = now.toISOString(); rec.alerts.warn = rec.alerts.warn || now.toISOString(); changed = true; log.push('overdue ' + id);
      } else if (at >= warn && at < due && !rec.alerts.warn) {
        await sendAlert(env, `Free report due soon: ${rec.business_name}`, alertText(rec, 'This free report is 75% of the way to its due time and is not marked sent.'), f);
        rec.alerts.warn = now.toISOString(); changed = true; log.push('warn ' + id);
      }
    }
    if (changed) await putJ(env, 'req:' + id, rec, KEEP);
  }
  return log;
}

async function markSent(req, env) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!keyOk(env, b && b.k)) return json({ ok: false, error: 'no' }, 403);
  if (!ID.test(String(b.id || ''))) return json({ ok: false, error: 'bad id' }, 400);
  const rec = await getJ(env, 'req:' + b.id);
  if (!rec) return json({ ok: false, error: 'not found' }, 404);
  rec.status = 'sent'; rec.sent = new Date().toISOString();
  await putJ(env, 'req:' + rec.id, rec, KEEP);
  await env.KV.delete('open:' + rec.id);
  return json({ ok: true, id: rec.id, status: 'sent' });
}

const FILL = ['google', 'reviews', 'ai', 'booking', 'category'];
async function fill(req, env) {
  let b; try { b = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }
  if (!keyOk(env, b && b.k)) return json({ ok: false, error: 'no' }, 403);
  if (!ID.test(String(b.id || '')) || !FILL.includes(b.section) || !b.data || typeof b.data !== 'object') return json({ ok: false, error: 'bad fill' }, 400);
  const rec = await getJ(env, 'req:' + b.id);
  if (!rec) return json({ ok: false, error: 'not found' }, 404);
  rec.sections[b.section] = b.data;
  const r = await saveReport(env, rec);
  await putJ(env, 'req:' + rec.id, rec, KEEP);
  return json({ ok: true, id: rec.id, complete: r.complete, pending: r.pending });
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
      overdue: now >= Date.parse(r.due), complete: !!r.complete, pending: r.pending || [], report: `${SITE}/r/${r.token}/` });
  }
  list.sort((a, b) => a.due.localeCompare(b.due));
  return json({ open: list, count: list.length, live: isLive(env) });
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
      if (p === '/api/free-report/mark-sent' && req.method === 'POST') return await markSent(req, env);
      if (p === '/api/free-report/fill' && req.method === 'POST') return await fill(req, env);
      const m = p.match(/^\/r\/([a-f0-9]{48})$/);
      if (m && req.method === 'GET') return await report(m[1], u, env);
      return new Response('Booked Out free report', { status: 200, headers: { 'x-robots-tag': 'noindex' } });
    } catch (e) {
      return json({ saved: false, error: 'server' }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, new Date()));
  },
  // for workers/test-freereport.mjs (plain node, no network)
  _t: { validate, businessClock, federalHolidays, isBusinessDay, local, fromLocal, chicagoText, isLive, deliverToOwner,
    sendAlert, isTestRequest, plain, budgetLine, renderReport, submit, build, tick, TRADES, REVENUE },
};

const GONE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Report not found | Booked Out Solutions</title><style>body{margin:0;font:18px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;background:#F6F1E7;color:#0A0F26}main{max-width:34rem;margin:0 auto;padding:3rem 1.2rem}</style></head><body><main><h1>This report is not here</h1><p>The link may be old or mistyped. Reply to the email it came in and we will send it again, or write to hello@getbookedoutsolutions.com.</p><p>Booked Out Solutions</p></main></body></html>';

function json(o, s = 200) {
  return new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
