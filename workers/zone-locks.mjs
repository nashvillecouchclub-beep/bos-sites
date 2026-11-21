// The sold zone-lock list (workers/data/zone-locks.json) and the open-spot answer for a free report (Nov 21 2026).
// One shop per trade per zone at any one time. A bad list is an error (it never quietly reads "open"); an empty list reads
// "open" everywhere. A town we cannot read cleanly is HELD (no spot is filled), never guessed.
import { readFileSync } from 'node:fs';

export const LOCK_TRADES = ['Heating and air', 'Plumbing', 'Electrical'];
export const FILE = new URL('./data/zone-locks.json', import.meta.url);
const STATES = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware',
  DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas',
  KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi',
  MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york',
  NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina',
  SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia',
  WI: 'wisconsin', WY: 'wyoming' };
const STATE_RE = new RegExp(`(?:[\\s,]+)(?:${[...Object.keys(STATES), ...Object.values(STATES)].sort((a, b) => b.length - a.length).map((x) => x.replace(/ /g, '\\s+')).join('|')})\\.?$`, 'i');

// A real calendar date in YYYY-MM-DD.
export function realDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// "Smyrna, TN 37167." / "Smyrna, Tennessee" / "  smyrna  " -> "Smyrna" (display) and "smyrna" (key). null = cannot read it.
export function townKey(raw) {
  let t = String(raw == null ? '' : raw).normalize('NFKC').replace(/\s+/g, ' ').trim();
  t = t.replace(/[\s,.;:!]+$/, '');
  t = t.replace(/[\s,]*\b\d{5}(?:-\d{4})?$/, '').replace(/[\s,.;:!]+$/, '');
  t = t.replace(STATE_RE, '').replace(/[\s,.;:!]+$/, '').trim();
  if (!t || t.length > 40 || !/^[A-Za-z][A-Za-z .'-]*$/.test(t) || /\d/.test(t)) return null;
  const display = t.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
  return { display, key: t.toLowerCase().replace(/[^a-z]+/g, ' ').trim() };
}

const overlap = (a, b) => a.since <= (b.until || '9999-12-31') && b.since <= (a.until || '9999-12-31');
const activeOn = (l, day) => l.since <= day && (!l.until || l.until >= day);

// Returns the checked list of locks. Throws with every problem found.
export function checkLocks(doc) {
  const problems = [];
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.locks)) throw new Error('zone-locks: "locks" must be a list');
  const byKey = new Map(); // trade|town -> every lock on it (past, current and future)
  doc.locks.forEach((l, i) => {
    const at = `zone-locks: locks[${i}]`;
    if (!l || typeof l !== 'object' || Array.isArray(l)) { problems.push(`${at} must be an object`); return; }
    if (!LOCK_TRADES.includes(l.trade)) problems.push(`${at}.trade must be one of ${LOCK_TRADES.join(', ')}`);
    const zk = typeof l.zone === 'string' ? townKey(l.zone) : null;
    if (!zk) problems.push(`${at}.zone must be a plain town name`);
    if (l.towns != null && (!Array.isArray(l.towns) || !l.towns.every((t) => typeof t === 'string' && townKey(t)))) problems.push(`${at}.towns must be a list of plain town names`);
    if (typeof l.business_name !== 'string' || !l.business_name.trim()) problems.push(`${at}.business_name is needed`);
    if (!realDate(l.since)) problems.push(`${at}.since must be a real date, YYYY-MM-DD`);
    if (l.until != null && !realDate(l.until)) problems.push(`${at}.until must be a real date, YYYY-MM-DD`);
    if (realDate(l.since) && realDate(l.until) && l.until < l.since) problems.push(`${at}.until is before since`);
    if (/\(FAKE\)|\(TEST\)/i.test(String(l.business_name || ''))) problems.push(`${at}: no fake TEST shops in the real list`);
    if (!zk || !realDate(l.since)) return;
    for (const t of [l.zone, ...(Array.isArray(l.towns) ? l.towns : [])]) {
      const tk = townKey(t); if (!tk) continue;
      const k = `${l.trade}|${tk.key}`;
      const list = byKey.get(k) || [];
      const clash = list.find((o) => overlap(o, l));
      if (clash) problems.push(`${at}: ${l.trade} in ${tk.display} overlaps the lock held by ${clash.business_name} (one shop per trade per zone at a time)`);
      list.push(l); byKey.set(k, list);
    }
  });
  if (problems.length) throw new Error(problems.join('; '));
  return doc.locks;
}

export function loadZoneLocks(file = FILE) { return checkLocks(JSON.parse(readFileSync(file, 'utf8'))); }

// The spot for one request: {zone, open}; null for "Something else" (no zone locks, no spot line);
// {hold: reason} when his town cannot be read cleanly (nothing is filled; a person looks at it).
export function spotFor(item, locks, day = new Date().toISOString().slice(0, 10)) {
  if (!LOCK_TRADES.includes(item.trade)) return null;
  const tk = townKey(item.town);
  if (!tk) return { hold: `cannot read the town "${String(item.town || '').slice(0, 80)}" as a plain town name; fill the spot by hand` };
  const hit = locks.find((l) => l.trade === item.trade && activeOn(l, day) && [l.zone, ...(l.towns || [])].some((t) => (townKey(t) || {}).key === tk.key));
  return hit ? { zone: townKey(hit.zone).display, open: false } : { zone: tk.display, open: true };
}
