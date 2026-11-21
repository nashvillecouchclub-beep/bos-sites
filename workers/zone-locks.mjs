// The sold zone-lock list (workers/data/zone-locks.json) and the open-spot answer for a free report (Nov 21 2026).
// One shop per trade per zone. A bad list is an error (it never quietly reads "open"); an empty list reads "open" everywhere.
import { readFileSync } from 'node:fs';

export const LOCK_TRADES = ['Heating and air', 'Plumbing', 'Electrical'];
export const FILE = new URL('./data/zone-locks.json', import.meta.url);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Returns the checked list of locks. Throws with every problem found.
export function checkLocks(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.locks)) throw new Error('zone-locks: "locks" must be a list');
  const seen = new Map();
  doc.locks.forEach((l, i) => {
    const at = `zone-locks: locks[${i}]`;
    if (!l || typeof l !== 'object') { problems.push(`${at} must be an object`); return; }
    if (!LOCK_TRADES.includes(l.trade)) problems.push(`${at}.trade must be one of ${LOCK_TRADES.join(', ')}`);
    if (typeof l.zone !== 'string' || !norm(l.zone)) problems.push(`${at}.zone is needed`);
    if (l.towns != null && (!Array.isArray(l.towns) || !l.towns.every((t) => typeof t === 'string' && norm(t)))) problems.push(`${at}.towns must be a list of town names`);
    if (typeof l.business_name !== 'string' || !l.business_name.trim()) problems.push(`${at}.business_name is needed`);
    if (!DATE.test(String(l.since || ''))) problems.push(`${at}.since must be YYYY-MM-DD`);
    if (l.until != null && !DATE.test(String(l.until))) problems.push(`${at}.until must be YYYY-MM-DD`);
    if (/\(FAKE\)|\(TEST\)/i.test(String(l.business_name || ''))) problems.push(`${at}: no fake TEST shops in the real list`);
    for (const t of [l.zone, ...(l.towns || [])]) {
      const k = `${l.trade}|${norm(t)}`;
      if (seen.has(k) && activeOn(l) && activeOn(seen.get(k))) problems.push(`${at}: ${l.trade} in ${t} is already locked (one shop per trade per zone)`);
      seen.set(k, l);
    }
  });
  if (problems.length) throw new Error(problems.join('; '));
  return doc.locks;
}
function activeOn(l, day = new Date().toISOString().slice(0, 10)) { return l.since <= day && (!l.until || l.until >= day); }

export function loadZoneLocks(file = FILE) { return checkLocks(JSON.parse(readFileSync(file, 'utf8'))); }

// The spot section for one request: {zone, open}, or null for "Something else" (no zone locks for that trade, no spot line).
// zone = the lock's zone when his town is one of its towns, else his own town (without the state).
export function spotFor(item, locks, day = new Date().toISOString().slice(0, 10)) {
  if (!LOCK_TRADES.includes(item.trade)) return null;
  const m = String(item.town || '').match(/^(.*?)[\s,]+([A-Za-z]{2})$/);
  const town = (m ? m[1] : String(item.town || '')).trim();
  if (!town) return null;
  const hit = locks.find((l) => l.trade === item.trade && activeOn(l, day) && [l.zone, ...(l.towns || [])].some((t) => norm(t) === norm(town)));
  return hit ? { zone: hit.zone, open: false } : { zone: town, open: true };
}
