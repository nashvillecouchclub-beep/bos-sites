// Free report follow-ups (Nov 20 2026). Plain logic, no network of its own: the worker hands in send and read helpers.
// The wording is LOCKED in freereport-followups-seq.js (brains + a fresh second agent, Nov 20). This file only picks
// the step, fills it from the owner's own report, checks it, and decides whether it may go.
//
// Safety, in order, before ANY follow-up goes:
//   1. FOLLOWUPS must be "on" AND LIVE must be "on". Both are "off" by default. Fake TEST shops never get one.
//   2. Stopped forever on: any reply in the thread (incl. bounces), POST /followup action "stop", a stop:<email> key.
//   3. We must KNOW there is no reply: either the Gmail thread read works (needs gmail.readonly on the token) and shows
//      only our own messages, or the inbox job stamped "clear" for this owner in the last 30 minutes. Otherwise it holds.
//   4. One email per owner per day, never before the hour the report went out (kept between 8 am and 4 pm), business days only,
//      Thanksgiving Day and Christmas Day slide to the next business day.
//   5. The filled email is checked again: under 120 words, exactly one "?" on the last line, no "$", no long dashes,
//      no emojis, no link but the report link, no {token} left. A fail goes to the step's fallback, or the step is skipped.
import SEQ from './freereport-followups-seq.js';

export const FU_SEQ = SEQ;
const CLEAR_MS = 30 * 60 * 1000; // the inbox job's "clear" is good for 30 minutes only
const FACT_ALIAS = { ai_result: 'ai_named' }; // one fact, two ways to say it
// Placeholders that name the owner or the report; they are not "facts" for the facts-used rule.
const IDENT = new Set(['first_name', 'business', 'town', 'trade_word', 'search_phrase', 'report_link', 'report_date', 'months_since', 'checks_list', 'introducer']);
const TRADE_WORD = { hvac: 'HVAC company', plumber: 'plumber', electrician: 'electrician' };
const BANNED = ['just checking in', 'sorry to bother', 'hope this finds you well', 'quick question'];

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;
const firstSentence = (s) => { const m = String(s).match(/^.*?[.!?](\s|$)/); return (m ? m[0] : String(s)).trim(); };
// A fix for {fix_n}: the fix as the report shows it, cut to its first sentence when long; dropped if still long.
// Inside a sentence it is quoted ("Ask every happy customer..."); alone on its own line it stays a plain sentence.
function fixLine(s, max = 25) {
  let x = String(s || '').trim();
  if (!x) return null;
  if (words(x) > 20) x = firstSentence(x);
  if (words(x) > max) return null;
  x = x.replace(/[.!]$/, '');
  return x.charAt(0).toUpperCase() + x.slice(1);
}

// Shared text tools for the worker and the follow-ups (Nov 21 2026).
// fold(): NFKC, every Unicode digit to 0-9 ("٥", "५", "５"), Cyrillic/Greek look-alike letters to Latin ("mіnutes" with a
// Cyrillic i), and the invisible format characters removed (zero-width spaces and joiners, word joiners, BOM, soft hyphen).
export const SPEED_FIX = 'Call or text back every new lead within 5 minutes, even after hours.';
export const INVISIBLE = /[​-‏⁠-⁤﻿­]/g;
const isNd = (ch) => /\p{Nd}/u.test(ch);
function asciiDigits(str) {
  return [...str].map((ch) => {
    if (/[0-9]/.test(ch) || !isNd(ch)) return ch;
    // Unicode decimal digits come in runs of ten starting at zero: count the digit code points just below this one
    const cp = ch.codePointAt(0);
    let k = 0;
    while (k < 60 && isNd(String.fromCodePoint(cp - k - 1))) k++;
    return String(k % 10);
  }).join('');
}
const LOOKALIKE = { 'а': 'a', 'е': 'e', 'і': 'i', 'ј': 'j', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'ѕ': 's', 'һ': 'h', 'ԁ': 'd', 'ԛ': 'q', 'ԝ': 'w',
  'А': 'a', 'В': 'b', 'Е': 'e', 'І': 'i', 'Ј': 'j', 'К': 'k', 'М': 'm', 'Н': 'h', 'О': 'o', 'Р': 'p', 'С': 'c', 'Т': 't', 'Х': 'x', 'У': 'y', 'Ѕ': 's',
  'ο': 'o', 'ι': 'i', 'ν': 'v', 'α': 'a', 'ε': 'e', 'κ': 'k', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'Ο': 'o', 'Ι': 'i', 'Α': 'a', 'Β': 'b', 'Ε': 'e',
  'Η': 'h', 'Κ': 'k', 'Μ': 'm', 'Ν': 'n', 'Ρ': 'p', 'Τ': 't', 'Χ': 'x', 'Υ': 'y', 'Ζ': 'z' };
export function fold(x) {
  return asciiDigits(String(x == null ? '' : x).normalize('NFKC').replace(INVISIBLE, '')).replace(/[Ͱ-ϿЀ-ӿԀ-ԯ]/g, (c) => LOOKALIKE[c] || c).toLowerCase();
}
const words2 = (x) => fold(x).replace(/[^a-z0-9]+/g, ' ').trim();
// FIVE_MIN_TEST: does this text talk about answering within 5 minutes? (Used for the diagnosis and fast-shop checks only; it
// no longer decides which booking fixes show.) A real decimal ("1.5", "2,5") is one number, a 5 that ends a sentence ("5.
// Minutes later") does not count, a range ending in 5 ("3-5 minutes") does, "twenty-five" does not.
export function FIVE_MIN_TEST(x) {
  let s = fold(x);
  s = s.replace(/(\d)[.,](\d)/g, '$1$2').replace(/(\d)[.!?](\s|$)/g, '$1 xstop$2');
  s = s.replace(/[^a-z0-9]+/g, ' ');
  return /(?<!(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety) )\b(5|five)(ish)?( ish)?( 5)? ?(or (fewer|less|so) |to \d+ |to [a-z]+ )?min(ute)?s?\b/.test(s);
}
// Response speed belongs to SPEED_FIX alone (Rickey's coordinator, Nov 21): a booking fix that talks about any time unit, or
// that is the standard speed sentence, is never shown as a booking fix, for any shop.
const TIME_UNIT = /(?<![a-z])(secs?|seconds?|mins?|minutes?|hrs?|hours?)(?![a-z])/;
export function bookingFixOk(x) {
  const w = words2(x);
  if (!w) return false;
  if (w === words2(SPEED_FIX)) return false;
  return !TIME_UNIT.test(w);
}
// The one filtered booking list. The page's booking test section, the three fixes (its first item) and the follow-ups'
// booking_fix_1 all come from this list, so they never disagree. Cleaned, no blanks, no repeats.
export function bookingList(fixes, plainFn) {
  const out = [], seen = new Set();
  for (const x of Array.isArray(fixes) ? fixes : []) {
    const c = plainFn(x);
    if (!c || !bookingFixOk(c)) continue;
    const k = words2(c);
    if (seen.has(k)) continue;
    seen.add(k); out.push(c);
  }
  return out;
}
export function answeredFast(sp) { return !!(sp && sp.tested === true && sp.minutes != null && +sp.minutes <= 5); }

// Every placeholder value, from the owner's own report only. A missing value is left out (never guessed).
// h: { site, townState, plain, pickFixes, TRADES, chicagoDate, now }
export function values(rec, h) {
  const v = {}, s = rec.sections || {}, g = s.google, rv = s.reviews, bk = s.booking, ai = s.ai;
  const set = (k, x) => { if (x !== null && x !== undefined && x !== '') v[k] = String(x); };
  set('first_name', h.plain(rec.first_name));
  set('business', h.plain(rec.business_name));
  set('town', h.townState(rec.town).town);
  const kw = ((h.TRADES[rec.trade] || {}).kw) || '';
  set('trade_word', TRADE_WORD[kw]);
  // A quoted search in an email is always the exact search the report ran.
  const g0 = s.google;
  set('search_phrase', String((g0 && g0.keyword) || (kw ? `${kw} ${h.townState(rec.town).town}` : '')).replace(/\bhvac\b/gi, 'HVAC'));
  set('report_link', `${h.site}/r/${rec.token}/`);
  const sent = rec.fu && rec.fu.day0 ? new Date(rec.fu.day0) : null;
  if (sent) {
    set('report_date', h.chicagoDate(sent));
    const months = Math.max(1, Math.round((h.now.getTime() - sent.getTime()) / (30.44 * 86400000)));
    set('months_since', months);
  }
  if (g && g.has_google_profile) {
    if (g.review_count != null) set('review_count', +g.review_count);
    if (g.top3 && g.top3.length) {
      const avg = Math.round(g.top3.reduce((a, x) => a + (+x.review_count || 0), 0) / g.top3.length);
      set('top3_avg', avg);
      if (g.review_count != null && avg - g.review_count > 0) set('review_gap', avg - g.review_count);
    }
    if (g.rank_for_keyword) set('rank', +g.rank_for_keyword);
    else if (kw) set('rank', 'not found');
  }
  if (rv && rv.newest_review) set('newest_review_replied', rv.owner_reply_on_newest ? 'yes' : 'no');
  if (bk && bk.score != null) set('booking_score', Math.max(0, Math.min(10, +bk.score)));
  const bfix = bk ? bookingList(bk.fixes, h.plain)[0] : null;
  // the first booking fix as the report page lists it (the same filter as the page's booking test list)
  if (bfix && words(bfix) <= 45) set('booking_fix_1', bfix);
  if (ai && ai.chatgpt && ai.gemini) {
    const named = !!(ai.chatgpt.named || ai.gemini.named), both = !!(ai.chatgpt.named && ai.gemini.named);
    // "yes" only when both named it, "no" only when neither did; a split answer is left out (the step uses its fallback).
    if (both) set('ai_named', 'yes'); else if (!named) set('ai_named', 'no');
    set('ai_result', both ? 'was named in both answers' : !named ? "wasn't named in either answer" : null);
  }
  // The fixes saved on the record when the report was sent (what he actually read); older records fall back to a re-pick.
  const fixes = rec.fu && Array.isArray(rec.fu.fixes) ? rec.fu.fixes : h.pickFixes(rec);
  fixes.forEach((f, i) => { const x = fixLine(h.plain(f)); if (x) { set('fix_' + (i + 1), `"${x}"`); set('fix_' + (i + 1) + '_line', x + '.'); } });
  const checks = [];
  if (g && g.has_google_profile) checks.push('your Google reviews', 'your map spot');
  if (ai && ai.chatgpt) checks.push('the ChatGPT and Gemini test');
  if (bk && bk.score != null) checks.push('the phone booking test');
  if (checks.length) set('checks_list', checks.length === 1 ? checks[0] : checks.slice(0, -1).join(', ') + ' and ' + checks[checks.length - 1]);
  if (rec.introducer) set('introducer', h.plain(rec.introducer));
  return v;
}

export function whenOk(w, v) {
  if (!w) return true;
  let m;
  if ((m = w.match(/^(\w+) == '([^']*)'$/))) return v[m[1]] === m[2];
  if ((m = w.match(/^(\w+) is a number$/))) return /^\d+$/.test(v[m[1]] || '');
  if ((m = w.match(/^(\w+) is set$/))) return v[m[1]] !== undefined;
  return false; // a rule we can't read never sends
}

// Problems with a filled body (empty list = ok).
export function bodyProblems(body, reportLink) {
  const p = [], lines = body.trim().split('\n');
  if (words(body) >= 120) p.push('120 words or more');
  if ((body.match(/\?/g) || []).length !== 1 || !lines[lines.length - 1].trim().endsWith('?')) p.push('not exactly one question on the last line');
  if (/\$/.test(body)) p.push('dollar sign');
  if (/[<>]/.test(body)) p.push('angle bracket (raw HTML)');
  if (/""/.test(body) || lines.some((l) => l.trim() && !/[\p{L}\p{N}]/u.test(l.replace(INVISIBLE, '')))) p.push('blank fix line');
  if (INVISIBLE.test(body)) p.push('invisible characters');
  INVISIBLE.lastIndex = 0;
  if (/[‒-―]/.test(body)) p.push('long dash');
  if (/[\p{Extended_Pictographic}]/u.test(body)) p.push('emoji');
  if (/\{[a-z_0-9]+\}/.test(body)) p.push('placeholder left');
  const links = body.match(/https?:\/\/\S+|www\.\S+/g) || [];
  if (links.some((l) => l.replace(/[.,]$/, '') !== reportLink)) p.push('link other than the report');
  // a bare domain (AirPros.com) turns into a link in most mail apps
  if (/\b[\w-]+\.(com|net|org|biz|co|us|io|info)\b/i.test(body.split(reportLink).join(' '))) p.push('bare domain');
  const low = body.toLowerCase();
  if (BANNED.some((b) => low.includes(b))) p.push('banned phrase');
  return p;
}

function fill(text, v) {
  text = text.replace(/"\{trade_word\} \{town\}"/g, '"{search_phrase}"').replace(/^\{(fix_\d)\}$/gm, '{$1_line}');
  return text.replace(/\{([a-z_0-9]+)\}/g, (all, k) => (v[k] !== undefined ? v[k] : all)); }

// Walks a step and its fallbacks. Returns {body, facts, node} or null (skip).
export function resolveStep(step, v, factsUsed = []) {
  let node = step;
  while (node && !node.skip) {
    const needs = node.needs || [];
    const whenKeys = node.when ? [String(node.when).split(' ')[0]] : [];
    const facts = [...new Set([...needs, ...whenKeys].filter((k) => !IDENT.has(k)).map((k) => FACT_ALIAS[k] || k))];
    const quotesSearch = /"\{trade_word\} \{town\}"/.test(node.body || '');
    const ok = whenOk(node.when, v) && needs.every((k) => v[k] !== undefined) && (!quotesSearch || v.search_phrase !== undefined) && !facts.some((k) => factsUsed.includes(k));
    if (ok) {
      let text = node.body;
      for (const r of node.line_rules || []) if (v[r.if_missing] === undefined) text = text.split(r.replace).join(r.with);
      const opt = node.optional || [];
      if (!opt.some((k) => v[k] === undefined && text.includes('{' + k + '}'))) {
        const body = fill(text, v).replace(/\ba HVAC\b/g, 'an HVAC');
        if (!bodyProblems(body, v.report_link).length) return { body, facts, node };
      }
    }
    node = node.fallback;
  }
  return null;
}

export function footerKind(rec) { return rec.warm ? 'warm' : rec.source === 'cold_email' ? 'cold_email' : 'cold_website'; }
export function composeText(rec, body) {
  return [body.trim(), '', SEQ.signature, '', SEQ.footer[footerKind(rec)]].join('\n');
}

// ---- dates (h gives: local(date) -> {y,m,d,h}, isBusinessDay(y,m,d), fromLocal(y,m,d,h,mi)) ----
const ymd = (p) => `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
function addDays(p, n) { const d = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() }; }
function okDay(p, h) { return h.isBusinessDay(p.y, p.m, p.d) && !(SEQ.holidays_slide_next_business_day || []).includes(ymd(p)); }
export function addBusinessDays(p, n, h) { let x = p, k = 0; while (k < n) { x = addDays(x, 1); if (okDay(x, h)) k++; } return x; }
export function slide(p, h) { let x = p; while (!okDay(x, h)) x = addDays(x, 1); return x; }

// The plan of steps for this owner, in order: [{id, node, due:{y,m,d}}]. Ladder and re-run dates hang off the last
// main step's actual send day (or the day he said "later").
export function plan(rec, h) {
  const fu = rec.fu, d0 = h.local(new Date(fu.day0));
  // Each main step keeps its planned gap after the step before it actually went (or was skipped), so a sequence that
  // was held for a while never sends a burst of back-to-back emails when it starts again.
  const main = [];
  for (const s of rec.warm ? SEQ.warm : SEQ.cold) {
    let due = addBusinessDays(d0, s.day, h);
    const prev = main[main.length - 1];
    if (prev) {
      const pd = fu.done[prev.id], base = pd ? h.local(new Date(pd.at)) : prev.due;
      const after = addBusinessDays(base, s.day - prev.node.day, h);
      if (ymd(after) > ymd(due)) due = after;
    }
    main.push({ id: s.step, node: s, due });
  }
  const out = fu.later_at ? [] : main;
  const lastMain = fu.later_at ? h.local(new Date(fu.later_at))
    : (() => { const ids = main.map((m) => m.id); const done = ids.map((i) => fu.done[i]).filter(Boolean);
      return done.length === ids.length ? h.local(new Date(done[done.length - 1].at)) : null; })();
  if (!lastMain) return out;
  for (const n of SEQ.ladder) out.push({ id: n.step, node: n, due: slide(addDays(lastMain, n.weeks_after_last * 7), h) });
  const last = SEQ.ladder[SEQ.ladder.length - 1].step;
  if (fu.done[last]) {
    let base = h.local(new Date(fu.done[last].at));
    for (let i = 1; i <= SEQ.rerun.max_no_reply; i++) {
      out.push({ id: 'rerun' + i, node: { ...SEQ.rerun, step: 'rerun' + i }, due: slide(addDays(base, SEQ.rerun.every_weeks * 7), h), reset: true });
      const r = fu.done['rerun' + i]; if (!r) break; base = h.local(new Date(r.at));
    }
  }
  return out;
}

// What to do now for one owner. Returns {action:'none'|'wait'|'hold'|'skip'|'send'|'stop', ...}.
export function next(rec, env, now, h, stopKey) {
  const fu = rec.fu;
  if (!fu || fu.stopped) return { action: 'none', why: fu && fu.stopped ? 'stopped: ' + fu.stopped.why : 'no sequence' };
  if (stopKey) return { action: 'stop', why: 'stop list' };
  if (rec.test) return { action: 'none', why: 'TEST request: never sent' };
  const today = h.local(now);
  const due = plan(rec, h).find((s) => !fu.done[s.id]);
  if (!due) return { action: 'none', why: 'sequence finished' };
  if (ymd(due.due) > ymd(today)) return { action: 'wait', step: due.id, due: ymd(due.due) };
  if (!okDay(today, h)) return { action: 'wait', step: due.id, why: 'not a sending day' };
  if (today.h < (fu.hour ?? 9)) return { action: 'wait', step: due.id, why: 'before send hour' };
  if (fu.last_sent_day === ymd(today)) return { action: 'wait', step: due.id, why: 'already emailed today' };
  const v = values(rec, { ...h, now });
  const r = resolveStep(due.node, v, due.reset ? [] : (fu.facts || []));
  if (!r) return { action: 'skip', step: due.id, why: 'no version of this step fits his report' };
  if (String(env.FOLLOWUPS || 'off').trim().toLowerCase() !== 'on') return { action: 'hold', step: due.id, why: 'FOLLOWUPS is off' };
  if (String(env.LIVE || 'off').trim().toLowerCase() !== 'on') return { action: 'hold', step: due.id, why: 'LIVE is off' };
  return { action: 'send', step: due.id, body: r.body, facts: r.facts, text: composeText(rec, r.body) };
}

// Reads the thread: {ok, replied, messageId} using a Gmail thread JSON (format=metadata).
export function readThread(t, ourAddress) {
  const msgs = (t && t.messages) || [];
  if (!msgs.length) return { ok: false };
  let replied = false, messageId = '';
  for (const m of msgs) {
    const hd = Object.fromEntries(((m.payload && m.payload.headers) || []).map((x) => [x.name.toLowerCase(), x.value]));
    const ours = (m.labelIds || []).includes('SENT') && String(hd.from || '').toLowerCase().includes(ourAddress);
    if (!ours) replied = true;
    if (hd['message-id']) messageId = hd['message-id'];
  }
  return { ok: true, replied, messageId };
}
export const CLEAR_WINDOW_MS = CLEAR_MS;
