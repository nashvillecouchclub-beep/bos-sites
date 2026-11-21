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
// --verdicts FILE: {"fr-...": {"1": {"agent","result","notes","hash"}, "2": {...}}} from the live chat's two checker sub-agents.
//   The script checks may only post FAILS. A pass is posted only when BOTH slots have a sub-agent "pass" with a non-script agent
//   name and hash = the report's current hash; the same name in both slots is held. A script fail always wins.
// Never sends: it never calls mark-sent or any send route. While LIVE is off the worker sends nothing. It stops unless the
// review list says LIVE is true or false, and re-reads /ping right before each checker 2 pass (which would make the worker send
// at once when LIVE is on): on or unclear = held unless --allow-send. Base address: https://getbookedoutsolutions.com only.
// It never contacts a business and never asks Rickey for anything.
import W from './bookedout-freereport.js';
import { prepareFills, postFills, postShot, findItem, baseFromEnv } from './freereport-fill.mjs';
import { planFills, researchTemplate, SPEED_REASON } from './freereport-jobs.mjs';
import { loadZoneLocks, spotFor, LOCK_TRADES } from './zone-locks.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const T = W._t;
const SITE = 'https://getbookedoutsolutions.com';
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
// The visible page text: tags removed first, then entities decoded in ONE pass (so "&amp;lt;" stays "&lt;"), spaces squeezed.
const text = (html) => String(html).replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENT[m]).replace(/\s+/g, ' ').trim();
// A form answer as the page shows it once decoded (plain() as the worker does; no tag stripping: the page escapes it).
const shown = (x) => T.plain(x).replace(/\s+/g, ' ').trim();
const LOCKED = [
  'Built from your real Google listing and a few quick checks. It is yours to keep.',
  'Start your free 30 days',
  'Nothing is charged for 30 days. Cancel any time with one reply.',
];
const MAX_PAGE = 150000; // a full real report is about 11 KB; anything near this size means oversized data got in
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
  for (const [k, d] of Object.entries(s)) {
    // the worker's own lookup saves google and reviews with extra keys (task, tries); the rules are the same
    if (k === 'reviews' && d && d.task && !d.newest_review) { p.push('reviews: the review lookup has not answered yet'); continue; }
    const why = T.fillProblem(item, k, d); if (why) p.push(`${k}: ${why}`);
  }
  const junk = html.match(/\[object Object\]|\bundefined\b|\bNaN\b/);
  if (junk) p.push(`the page contains "${junk[0]}" (bad data reached the page)`);
  if (html.length > MAX_PAGE) p.push(`the page is ${html.length} characters, over the ${MAX_PAGE} limit (something oversized got in)`);
  if (s.speed && !(s.speed.tested === false || item.test)) p.push('speed: a tested result on a real report (no speed test is run before GO LIVE)');
  for (const [k, label] of [['business_name', 'business name'], ['town', 'town']]) if (!v.includes(shown(item[k]))) p.push(`the ${label} "${item[k]}" is not on the page as written on the form`);
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
  if (s.spot && s.spot.open && !v.includes(`The ${shown(s.spot.zone)} zone is open`)) p.push('the open-spot line names the wrong zone');
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
export function args(argv) {
  const o = { apply: false, allowSend: false, templates: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--dry-run') o.apply = false;
    else if (a === '--allow-send') o.allowSend = true;
    else if (a === '--templates') o.templates = true;
    else if (['--only', '--research', '--verdicts', '--log', '--locks'].includes(a)) {
      const val = argv[++i];
      if (val == null || val === '' || val.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--only' && !/^fr-[0-9]{8}-[a-z0-9]{6}$/.test(val)) throw new Error('--only needs a request id like fr-20261121-abc123');
      o[a.slice(2)] = val;
    }
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
  if (base !== SITE && !opts.testMock) throw new Error(`base must be ${SITE}`);
  const locks = locksIn || loadZoneLocks();
  log('start', { msg: `zone locks: ${locks.length}; research: ${research}; speed result: not tested ("${SPEED_REASON}")` });
  const r0 = await f(`${base}/api/free-report/review?k=${encodeURIComponent(key)}`);
  if (!r0.ok) { log('stop', { msg: 'review list ' + r0.status }); return { ok: false, steps }; }
  const list = await r0.json().catch(() => null);
  if (!list || typeof list.live !== 'boolean' || !Array.isArray(list.waiting)) { log('stop', { msg: 'the review list gave no clear LIVE answer (old deploy?); nothing done' }); return { ok: false, steps }; }
  const live = list.live;
  log('list', { msg: `${list.count} waiting; LIVE is ${live ? 'ON' : 'off'}` });
  const summary = [];
  for (let item of list.waiting || []) {
    if (only && item.id !== only) continue;
    log('item', { id: item.id, msg: `${item.business_name} (${item.trade}, ${item.town}) status ${item.status}, needs ${item.needs}, due ${item.due_text}${item.test ? ', TEST shop' : ''}` });
    if (item.needs === 'send') { log('skip', { id: item.id, msg: 'both checks already passed this version; the worker sends it only when LIVE is on' }); summary.push({ id: item.id, result: 'checked' }); continue; }
    if (/^fix first/.test(item.needs || '')) {
      log('skip', { id: item.id, msg: 'a checker failed this exact version; fix the data with a fill (a new version) first' });
      summary.push({ id: item.id, result: 'held, fix first' }); continue;
    }
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
      if (existsSync(file)) {
        try { rs = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { log('research', { id: item.id, msg: 'unreadable ' + file + ': ' + e.message }); rs = {}; }
        if (!rs || typeof rs !== 'object' || Array.isArray(rs)) { log('research', { id: item.id, msg: 'skipped ' + file + ': not a research object' }); rs = {}; }
        else if (rs.id !== item.id) { log('research', { id: item.id, msg: `skipped ${file}: its id is ${JSON.stringify(rs.id)}, not this report` }); rs = {}; }
        else log('research', { id: item.id, msg: 'read ' + file });
      }
      else log('research', { id: item.id, msg: 'no research file yet (' + file + ')' });
      // screenshots: host them first (apply), or check the files and use the URL they will get (dry run)
      const shots = [];
      for (const [engine, path] of Object.entries((rs && rs.screenshots) || {})) {
        if (!path || !T.SHOT_ENGINES.includes(engine)) continue;
        let png; try { png = readFileSync(path).toString('base64'); } catch (e) { log('shot', { id: item.id, msg: `${engine}: cannot read ${path}` }); continue; }
        if (!T.pngBytes(png)) { log('shot', { id: item.id, msg: `${engine}: not a PNG of 1 MB or less, left out` }); continue; }
        const url = `${item.report.replace(/\/$/, '')}/ai-${engine}.png?v=${(await T.sha(png)).slice(0, 8)}`;
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
    // 3b. the spot, from the zone-lock list as it is NOW (a lock may have been sold since the spot was filled)
    if (LOCK_TRADES.includes(target.trade)) {
      const want = spotFor(target, locks), have = (target.sections || {}).spot;
      const same = want && !want.hold && have && have.zone === want.zone && have.open === want.open && have.lock_version === want.lock_version
        && JSON.stringify(have.zone_towns || null) === JSON.stringify(want.zone_towns || null);
      if (want && want.hold) {
        c1.pass = false; c1.problems.push('spot: ' + want.hold);
        log('spot', { id: item.id, msg: 'held: ' + want.hold });
      } else if (!same) {
        log('spot', { id: item.id, msg: `the zone-lock list now says ${JSON.stringify(want)}, the report has ${JSON.stringify(have || null)}; ${apply ? 'filling it again' : 'would fill it again'}` });
        if (apply) {
          const { fills, problems } = prepareFills(item, { spot: want });
          for (const x of problems) log('refused', { id: item.id, msg: x });
          if (fills.length) { const pr = await postFills({ base, key, id: item.id, fills, fetch: f }); for (const x of pr.results) log('fill', { id: item.id, msg: `${x.section} ${x.status}${x.error ? ' ' + x.error : ''}` }); }
        }
        summary.push({ id: item.id, result: apply ? 'spot filled again; new version, check again' : 'would fill the spot again' });
        continue;
      }
    }
    // 4. marks. The script may only post FAILS. A pass is posted only from a sub-agent verdict that says pass, names a
    // non-script agent, and read this exact version (hash). Both slots need one before any pass is posted.
    const v = (verdicts && Object.hasOwn(verdicts, item.id) && verdicts[item.id]) || {};
    const have1 = !!(item.checks && item.checks['1'] && item.checks['1'].result === 'pass' && item.checks['1'].hash === target.hash);
    const verdict = (slot) => {
      const sub = Object.hasOwn(v, slot) ? v[slot] : null;
      if (!sub || typeof sub !== 'object') return { state: 'missing' };
      if (!['pass', 'fail'].includes(sub.result)) return { state: 'bad', why: `checker ${slot} verdict has no pass/fail result` };
      const agent = T.cleanAgent(sub.agent);
      if (!agent || /script/.test(agent)) return { state: 'bad', why: `checker ${slot} verdict needs a real sub-agent name (not a script name)` };
      if (typeof sub.hash !== 'string' || sub.hash !== target.hash) return { state: 'bad', why: `checker ${slot} verdict read version ${String(sub.hash || 'none').slice(0, 12)}, the report is now ${target.hash.slice(0, 12)}; read it again` };
      return { state: 'ok', result: sub.result, agent, notes: String(sub.notes || '').slice(0, 1900) };
    };
    const v1 = verdict('1'), v2 = verdict('2');
    for (const x of [v1, v2]) if (x.state === 'bad') log('verdict', { id: item.id, msg: 'ignored: ' + x.why });
    const marks = []; // [slot, {result, agent, notes}]
    const scriptFail = (slot, c) => ({ result: 'fail', agent: `checker-${slot}-script-${runId}`, notes: c.problems.join(' | ').slice(0, 1900) });
    let hold = '';
    const ok = (x, r) => x.state === 'ok' && x.result === r;
    if (!c1.pass) marks.push(['1', scriptFail('1', c1)]);               // a script fail always wins
    else if (!c2.pass) marks.push(['2', scriptFail('2', c2)]);
    else if (ok(v1, 'fail')) marks.push(['1', v1]);                     // a sub-agent fail on this hash always wins, whatever is on record
    else if (ok(v2, 'fail')) marks.push(['2', v2]);
    else {
      const need = [];
      if (!have1 && !ok(v1, 'pass')) need.push('checker 1');
      if (!ok(v2, 'pass')) need.push('checker 2');
      const first = T.cleanAgent(have1 ? item.checks['1'].agent : v1.agent);
      if (need.length) hold = `script checks passed; waiting for a sub-agent pass verdict from ${need.join(' and ')} on version ${target.hash} (--verdicts)`;
      else if (first === v2.agent) hold = `checker 1 and checker 2 name the same agent (${v2.agent}); they must be two different agents`;
      else { if (!have1) marks.push(['1', v1]); marks.push(['2', v2]); }
    }
    // a fail and a pass from the same agent name in both slots is refused by the worker too; hold instead of renaming
    if (!hold && marks.length === 2 && T.cleanAgent(marks[0][1].agent) === T.cleanAgent(marks[1][1].agent)) { hold = `the same agent name in both slots (${marks[0][1].agent})`; marks.length = 0; }
    if (hold) {
      log('hold', { id: item.id, msg: hold });
      summary.push({ id: item.id, result: /^script checks passed; waiting/.test(hold) ? 'waiting for verdicts' : 'held: ' + hold, hash: target.hash });
      continue;
    }
    if (!apply) {
      log('would mark', { id: item.id, msg: marks.map(([s, m]) => `checker ${s} ${m.result} (${m.agent})`).join('; ') });
      summary.push({ id: item.id, result: marks.some(([, m]) => m.result === 'fail') ? 'would be held' : 'would be checked' });
      continue;
    }
    const post = async (slot, m) => {
      const r = await f(`${base}/api/free-report/check`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: item.id, k: key, checker: +slot, agent: m.agent, result: m.result, hash: item.hash, notes: m.notes }) });
      const j = await r.json().catch(() => ({}));
      log('mark', { id: item.id, msg: `checker ${slot} ${m.result} (${m.agent}): ${r.status} ${j.status || j.error || ''}${j.sent ? ' SENT' : ''}` });
      return { ok: r.ok, ...j };
    };
    let last = { ok: true, status: item.status }, stopped = '';
    for (const [slot, m] of marks) {
      if (slot === '2' && m.result === 'pass') {
        // re-read LIVE right before the one mark that can make the worker send
        const pg = await f(`${base}/api/free-report/ping`);
        const pj = pg.ok ? await pg.json().catch(() => ({})) : {};
        if (typeof pj.live !== 'boolean') { stopped = 'ping gave no clear LIVE answer; checker 2 pass not posted'; break; }
        if (pj.live && !allowSend) { stopped = 'LIVE is on: a checker 2 pass would send this report now. Not posted (run with --allow-send to let it go).'; break; }
      }
      last = await post(slot, m);
      if (!last.ok || m.result === 'fail') break;
    }
    if (stopped) { log('hold', { id: item.id, msg: stopped }); summary.push({ id: item.id, result: 'checker 2 waiting (LIVE on or unknown)' }); continue; }
    const failedMark = marks.find(([, m]) => m.result === 'fail');
    summary.push({ id: item.id, result: !last.ok ? 'mark refused' : failedMark ? `held (checker ${failedMark[0]})` : last.status === 'checked' ? 'checked' : last.status, sent: !!last.sent });
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
  let base; try { base = baseFromEnv(process.env.FREEREPORT_BASE); } catch (e) { console.error(e.message); process.exit(2); }
  const r = await run({ base, key, apply: o.apply, allowSend: o.allowSend, only: o.only, templates: o.templates,
    research: o.research, verdicts, locks, logFile });
  process.exit(r.ok ? 0 : 1);
}
