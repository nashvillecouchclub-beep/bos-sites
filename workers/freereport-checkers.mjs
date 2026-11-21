// "Free report checkers" runner (Nov 21 2026). Run BY HAND from a live chat; there is no scheduled task for it.
//
//   STATUS_KEY=... node workers/freereport-checkers.mjs [--apply] [--only fr-...] [--research DIR] [--templates]
//                                                       [--verdicts FILE] [--log FILE] [--allow-send]
//
// Default is a DRY RUN: it reads the review list and the report pages, works out every fill and both checks, and logs what
// it WOULD do. Nothing is posted. --apply posts the fills (through workers/freereport-fill.mjs), hosts screenshots,
// and posts the checker 1 and checker 2 marks.
//
// Steps, for every report in GET /api/free-report/review (soonest due first):
//   1. fill   sections still pending, from the fill jobs (workers/freereport-jobs.mjs): answer speed is always "not tested",
//             the spot comes from workers/data/zone-locks.json, the rest from <research DIR>/<fr-id>.json (public pages only,
//             gathered by the live chat). --templates writes a research file to fill in for each report that is missing one.
//   2. check 1  facts: the live page is exactly what the current code renders from the report's own data and form answers,
//             nothing pending, each section passes the worker's fill rules, and the checker 1 list in FREEREPORT-CHECKERS.md.
//   3. check 2  wording, rules and risk (the checker 2 list), then checker 1's rank and review gap again.
//   4. mark   POST /api/free-report/check for checker 1, then checker 2 (different agent names). Two passes on the same
//             version = status "checked".
// --verdicts FILE: {"fr-...": {"1": {"agent","result","notes"}, "2": {...}}} from the live chat's two checker sub-agents.
//   A script fail always wins; otherwise the sub-agent's verdict and agent name are posted. Without it the script checks
//   alone decide, as agents "checker-<slot>-script-<run id>".
//
// Never sends: it never calls mark-sent or any send route. While LIVE is off the worker sends nothing. If the review list
// says LIVE is on, a checker 2 pass would make the worker send right away, so that mark is only posted with --allow-send.
// It never contacts a business and never asks Rickey for anything.
import W from './bookedout-freereport.js';
import { prepareFills, postFills, postShot, findItem } from './freereport-fill.mjs';
import { planFills, researchTemplate, SPEED_REASON } from './freereport-jobs.mjs';
import { loadZoneLocks } from './zone-locks.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const T = W._t;
const SITE = 'https://getbookedoutsolutions.com';
const text = (html) => String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const LOCKED = [
  'Built from your real Google listing and a few quick checks. It is yours to keep.',
  'Start your free 30 days',
  'Nothing is charged for 30 days. Cancel any time with one reply.',
];
const TERMS_LINES = ['Once your first paid month starts', 'We never promise jobs, revenue or a spot on Google.', 'There are no guarantees during a free period, because nothing is being charged.'];

// ---------- checker 1: facts and data ----------
export async function checker1(item, html) {
  const p = [];
  const local = T.renderReport(item);
  if (html !== local.html) p.push('the page is not what the current code renders from this report\'s data (deployed code differs from this repo, or the page is old); re-render, then check again');
  if (item.hash && (await T.sha(local.html)) !== item.hash) p.push('the report hash does not match the rendered page (read it again)');
  if (!local.complete || local.pending.length || !item.complete || (item.pending || []).length) p.push('pending sections: ' + (local.pending.join(', ') || (item.pending || []).join(', ')));
  if (/Pending check\./.test(html)) p.push('the page still says "Pending check"');
  const s = item.sections || {}, g = s.google, v = text(html);
  for (const [k, d] of Object.entries(s)) { if (k === 'reviews') continue; const why = T.fillProblem(item, k, d); if (why) p.push(`${k}: ${why}`); }
  if (s.speed && !(s.speed.tested === false || item.test)) p.push('speed: a tested result on a real report (no speed test is run before GO LIVE)');
  for (const [k, label] of [['business_name', 'business name'], ['town', 'town']]) if (!v.includes(text(T.plain(item[k])))) p.push(`the ${label} "${item[k]}" is not on the page as written on the form`);
  const bl = T.budgetLine(item.revenue);
  if (bl && !v.includes(bl)) p.push('budget line missing or wrong for the revenue range');
  if (!bl && /Shops your size spend/.test(v)) p.push('budget line shown without a revenue range');
  if (/could not find a Google Business Profile/.test(v) !== (!!g && g.has_google_profile === false)) p.push('the "No Google profile" wording does not match has_google_profile');
  if (g && g.has_google_profile === false && /Where you show for/.test(v)) p.push('a rank line shows for a shop with no Google profile');
  const trade = T.TRADES[item.trade] || T.TRADES['Something else'];
  if (!html.includes(`href="${SITE}/${trade.price}"`)) p.push(`the price link is not ${trade.price}`);
  const fixes = T.pickFixes(item);
  if (fixes.length !== 3 || new Set(fixes.map((x) => x.toLowerCase())).size !== 3) p.push('the three fixes are not three different fixes');
  const cv = T.competitorView(item);
  if (cv && cv.name && !(g.top3 || []).some((x) => x.name === cv.name)) p.push('the competitor is not in the google top 3');
  if (s.spot && trade.slug === 'other') p.push('a spot for "Something else"');
  if (/Your spot is open/.test(v) !== !!(s.spot && s.spot.open && trade.slug !== 'other')) p.push('the open-spot line does not match the zone lock list');
  if (s.spot && s.spot.open && !v.includes(`The ${T.plain(s.spot.zone)} zone is open`)) p.push('the open-spot line names the wrong zone');
  return { pass: !p.length, problems: p };
}

// ---------- checker 2: wording, rules and risk ----------
export function checker2(item, html) {
  const p = [], v = text(html), s = item.sections || {}, g = s.google;
  for (const x of LOCKED) if (!v.includes(x)) p.push(`locked wording missing: "${x}"`);
  if (/free (look|check)\b/i.test(v)) p.push('says "free look" or "free check" (it is the "free report")');
  if (/[–—―]/.test(v)) p.push('a long dash on the page');
  if (/\p{Extended_Pictographic}/u.test(v)) p.push('an emoji on the page');
  if (/\b(claude|anthropic|llm|agents?|chatbot|our stack|automation tools?)\b/i.test(v)) p.push('names our tools or how we run');
  if (/you will rank|will rank you|guarantee(d|s)? (you )?(more )?(jobs|calls|revenue|results|leads)|more (jobs|calls) guaranteed|we promise (you )?(jobs|calls|revenue)/i.test(v)) p.push('promises jobs, calls, revenue, a ranking or a result');
  const est = (v.match(/\(outside research, not your numbers\)|\(estimate\)/g) || []).length, src = (v.match(/Source: /g) || []).length;
  if (est > src) p.push('an outside number without its source line');
  if (/booking rate/i.test(v)) p.push('calls the research a booking rate');
  if ((T.TRADES[item.trade] || {}).slug !== 'other' && s.spot) for (const x of TERMS_LINES) if (!v.includes(x)) p.push(`terms line missing: "${x}"`);
  if (item.note && item.note.trim().length >= 12 && v.includes(item.note.trim().slice(0, 60))) p.push('the owner\'s private note shows on the page');
  if (!/One honest question/.test(v) || /One honest question[^.]*\$\d/.test(v)) p.push('the honest question is missing or has a number');
  if (!item.test && (T.isTestRequest(item) || /\(TEST\)/i.test(item.business_name || ''))) p.push('a fake TEST shop marked as real');
  if (s.speed && s.speed.tested === false && !v.includes('We did not run this test for you:')) p.push('the answer speed part does not say the test was not run');
  // checker 1's two riskiest facts again: rank and review gap
  if (g && g.has_google_profile) {
    if (g.rank_for_keyword && !v.includes(`Number ${g.rank_for_keyword}`)) p.push('the rank on the page does not match the google data');
    if (g.top3 && g.top3.length && g.review_count != null) {
      const avg = Math.round(g.top3.reduce((a, x) => a + (+x.review_count || 0), 0) / g.top3.length);
      if (avg > g.review_count && !v.includes(`they average ${avg} reviews; you have ${g.review_count}`)) p.push('the review gap on the page does not match the google data');
    }
  }
  return { pass: !p.length, problems: p };
}

// ---------- the run ----------
function args(argv) {
  const o = { apply: false, allowSend: false, templates: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--allow-send') o.allowSend = true;
    else if (a === '--templates') o.templates = true;
    else if (['--only', '--research', '--verdicts', '--log', '--locks'].includes(a)) o[a.slice(2)] = argv[++i];
    else throw new Error('unknown option ' + a);
  }
  return o;
}

export async function run(opts) {
  const { base = SITE, key, fetch: f = fetch, apply = false, allowSend = false, only, templates = false,
    research = join(homedir(), '.bookedout', 'freereport-research'), verdicts = null, locks: locksIn, logFile, out = console.log } = opts;
  const runId = opts.runId || new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const steps = [];
  const log = (step, o = {}) => {
    const e = { at: new Date().toISOString(), run: runId, mode: apply ? 'apply' : 'dry-run', step, ...o };
    steps.push(e);
    out(`[${e.mode}] ${step}${o.id ? ' ' + o.id : ''}${o.msg ? ': ' + o.msg : ''}`);
    if (logFile) { mkdirSync(dirname(logFile), { recursive: true }); appendFileSync(logFile, JSON.stringify(e) + '\n'); }
  };
  if (!key) throw new Error('STATUS_KEY is needed');
  const locks = locksIn || loadZoneLocks();
  log('start', { msg: `zone locks: ${locks.length}; research: ${research}; speed result: not tested ("${SPEED_REASON}")` });
  const r0 = await f(`${base}/api/free-report/review?k=${encodeURIComponent(key)}`);
  if (!r0.ok) { log('stop', { msg: 'review list ' + r0.status }); return { ok: false, steps }; }
  const list = await r0.json();
  const live = !!list.live;
  log('list', { msg: `${list.count} waiting; LIVE is ${live ? 'ON' : 'off'}` });
  const summary = [];
  for (let item of list.waiting || []) {
    if (only && item.id !== only) continue;
    log('item', { id: item.id, msg: `${item.business_name} (${item.trade}, ${item.town}) status ${item.status}, needs ${item.needs}, due ${item.due_text}${item.test ? ', TEST shop' : ''}` });
    if (item.needs === 'send') { log('skip', { id: item.id, msg: 'both checks already passed this version; the worker sends it only when LIVE is on' }); summary.push({ id: item.id, result: 'checked' }); continue; }
    const failed = Object.entries(item.checks || {}).find(([, c]) => c && c.result === 'fail' && c.hash === item.hash);
    if (failed && item.needs !== 'fill pending sections first') {
      log('skip', { id: item.id, msg: `checker ${failed[0]} failed this exact version (${failed[1].notes || 'no notes'}); fix the data with a fill first, then run again` });
      summary.push({ id: item.id, result: 'held, fix first' }); continue;
    }
    // 1. fill
    let planned = null;
    if (item.needs === 'fill pending sections first') {
      const file = join(research, item.id + '.json');
      let rs = {};
      if (existsSync(file)) { try { rs = JSON.parse(readFileSync(file, 'utf8')); log('research', { id: item.id, msg: 'read ' + file }); } catch (e) { log('research', { id: item.id, msg: 'unreadable ' + file + ': ' + e.message }); rs = {}; } }
      else log('research', { id: item.id, msg: 'no research file yet (' + file + ')' });
      // screenshots: host them first (apply), or check the files and use the URL they will get (dry run)
      const shots = [];
      for (const [engine, path] of Object.entries((rs && rs.screenshots) || {})) {
        if (!path || !T.SHOT_ENGINES.includes(engine)) continue;
        let png; try { png = readFileSync(path).toString('base64'); } catch (e) { log('shot', { id: item.id, msg: `${engine}: cannot read ${path}` }); continue; }
        if (!T.pngBytes(png)) { log('shot', { id: item.id, msg: `${engine}: not a PNG of 1 MB or less, left out` }); continue; }
        const url = `${item.report.replace(/\/$/, '')}/ai-${engine}.png`;
        if (!apply) { shots.push({ engine, url }); log('shot', { id: item.id, msg: `${engine}: would host ${path}` }); continue; }
        const h = await postShot({ base, key, id: item.id, engine, png, fetch: f });
        log('shot', { id: item.id, msg: `${engine}: ${h.ok ? 'hosted ' + h.url : 'refused ' + h.status + ' ' + (h.error || '')}` });
        if (h.ok) shots.push({ engine, url: h.url });
      }
      const plan = planFills(item, rs, { locks, shots });
      for (const n of plan.notes) log('note', { id: item.id, msg: n });
      const { fills, problems } = prepareFills(item, plan.data);
      for (const x of problems) log('refused', { id: item.id, msg: x });
      log('fills', { id: item.id, msg: (fills.map((x) => x.section).join(', ') || 'none') + (plan.missing.length ? `; still needs research: ${plan.missing.join(', ')}` : '; nothing else needed') });
      if (plan.missing.length && templates && !existsSync(file)) {
        mkdirSync(research, { recursive: true });
        writeFileSync(file, JSON.stringify(researchTemplate({ ...item, sections: plan.rec.sections }, plan.missing), null, 2) + '\n');
        log('template', { id: item.id, msg: 'wrote ' + file + ' (fill it from public pages, then run again)' });
      }
      if (apply && fills.length) {
        const pr = await postFills({ base, key, id: item.id, fills, fetch: f });
        for (const x of pr.results) log('fill', { id: item.id, msg: `${x.section} ${x.status}${x.error ? ' ' + x.error : ''}` });
        const again = await findItem({ base, key, id: item.id, fetch: f });
        if (again) item = again;
      } else if (!apply) {
        planned = { ...item, sections: { ...item.sections } };
        for (const x of fills) planned.sections[x.section] = x.data;
        const rr = T.renderReport(planned);
        planned.complete = rr.complete; planned.pending = rr.pending; planned.hash = await T.sha(rr.html); planned.html = rr.html;
      }
      if (problems.length || (apply ? !item.complete : !planned.complete)) {
        log('wait', { id: item.id, msg: 'not complete after fills: ' + ((apply ? item.pending : planned.pending) || []).join(', ') });
        summary.push({ id: item.id, result: 'needs research', missing: plan.missing, refused: problems });
        continue;
      }
    }
    // 2 + 3. the two checks, on the live page (apply) or on the page the planned fills would make (dry run)
    const target = planned || item;
    let html;
    if (planned) html = planned.html;
    else {
      const pr = await f(target.report.replace(SITE, base));
      html = pr.ok ? await pr.text() : '';
      if (!pr.ok) { log('stop', { id: item.id, msg: 'report page ' + pr.status }); summary.push({ id: item.id, result: 'page not readable' }); continue; }
    }
    const c1 = await checker1(target, html), c2 = checker2(target, html);
    log('checker 1', { id: item.id, msg: c1.pass ? 'pass' : 'FAIL: ' + c1.problems.join(' | ') });
    log('checker 2', { id: item.id, msg: c2.pass ? 'pass' : 'FAIL: ' + c2.problems.join(' | ') });
    // 4. marks
    const v = (verdicts && verdicts[item.id]) || {};
    const mark = (slot, c) => {
      const sub = v[slot];
      if (!c.pass) return { result: 'fail', agent: (sub && sub.agent) || `checker-${slot}-script-${runId}`, notes: c.problems.join(' | ').slice(0, 1900) };
      if (sub && ['pass', 'fail'].includes(sub.result) && sub.agent) return { result: sub.result, agent: String(sub.agent), notes: String(sub.notes || '') };
      return { result: 'pass', agent: `checker-${slot}-script-${runId}`, notes: 'script checks passed' };
    };
    const m1 = mark('1', c1), m2 = mark('2', c2);
    if (m1.agent === m2.agent) m2.agent += '-b';
    if (!apply) {
      log('would mark', { id: item.id, msg: `checker 1 ${m1.result} (${m1.agent}); checker 2 ${m1.result === 'pass' ? m2.result : 'not reached'} (${m2.agent})` });
      summary.push({ id: item.id, result: m1.result === 'pass' && m2.result === 'pass' ? 'would be checked' : 'would be held' });
      continue;
    }
    const post = async (slot, m) => {
      const r = await f(`${base}/api/free-report/check`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, k: key, checker: +slot, agent: m.agent, result: m.result, hash: item.hash, notes: m.notes }) });
      const j = await r.json().catch(() => ({}));
      log('mark', { id: item.id, msg: `checker ${slot} ${m.result}: ${r.status} ${j.status || j.error || ''}${j.sent ? ' SENT' : ''}` });
      return { ok: r.ok, ...j };
    };
    const have1 = item.checks && item.checks['1'] && item.checks['1'].result === 'pass' && item.checks['1'].hash === item.hash;
    let r1 = { ok: true, status: item.status };
    if (!have1) r1 = await post('1', m1);
    if (!r1.ok || m1.result !== 'pass') { summary.push({ id: item.id, result: 'held (checker 1)' }); continue; }
    if (m2.result === 'pass' && live && !allowSend && !item.test) {
      log('skip', { id: item.id, msg: 'LIVE is on: a checker 2 pass would send this report now. Not posted (run with --allow-send to let it go).' });
      summary.push({ id: item.id, result: 'checker 1 passed; checker 2 waiting (LIVE on)' });
      continue;
    }
    const r2 = await post('2', m2);
    summary.push({ id: item.id, result: r2.ok && r2.status === 'checked' ? 'checked' : r2.ok ? r2.status : 'mark refused', sent: !!r2.sent });
  }
  log('done', { msg: summary.map((x) => `${x.id} ${x.result}`).join('; ') || 'nothing waiting' });
  return { ok: true, live, summary, steps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let o;
  try { o = args(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const key = process.env.STATUS_KEY;
  if (!key) { console.error('usage: STATUS_KEY=... node workers/freereport-checkers.mjs [--apply] [--only fr-...] [--research DIR] [--templates] [--verdicts FILE] [--log FILE] [--allow-send]'); process.exit(2); }
  const logFile = o.log || join(homedir(), '.bookedout', 'logs', `freereport-checkers-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const verdicts = o.verdicts ? JSON.parse(readFileSync(o.verdicts, 'utf8')) : null;
  const locks = o.locks ? loadZoneLocks(o.locks) : undefined;
  const r = await run({ base: process.env.FREEREPORT_BASE || SITE, key, apply: o.apply, allowSend: o.allowSend, only: o.only, templates: o.templates,
    research: o.research, verdicts, locks, logFile });
  process.exit(r.ok ? 0 : 1);
}
