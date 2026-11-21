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
// Short state forms people type (AP style and common ones), compared with dots removed and in lower case.
const STATE_SHORT = ['ala', 'ariz', 'ark', 'calif', 'cal', 'colo', 'conn', 'del', 'fla', 'ga', 'ill', 'ind', 'kan', 'kans', 'ky', 'md', 'mass',
  'mich', 'minn', 'miss', 'mo', 'mont', 'neb', 'nebr', 'nev', 'okla', 'ore', 'oreg', 'pa', 'penn', 'penna', 'tenn', 'tex', 'vt', 'va', 'wash',
  'wis', 'wisc', 'wyo', 'wva'];
const TAIL_ONE = new Set([...Object.keys(STATES).map((x) => x.toLowerCase()), ...STATE_SHORT, 'usa', 'us', 'america']);
const TAIL_MULTI = [...Object.values(STATES), 'united states', 'united states of america', 'w va', 'n c', 's c', 'n d', 's d', 'n h', 'n j', 'n m', 'n y', 'r i']
  .map((x) => x.split(' ')).sort((a, b) => b.length - a.length);
const CANON = { mt: 'mount', mount: 'mount', st: 'saint', saint: 'saint', ste: 'sainte', ft: 'fort', fort: 'fort', pt: 'point' };

// The day in Smyrna (America/Chicago), YYYY-MM-DD: lock dates are Central days, not UTC days.
export function chicagoDay(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

// A real calendar date in YYYY-MM-DD.
export function realDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// "Smyrna, TN 37167, USA" / "Smyrna, Tenn." / "Smyrna-TN" / "  smyrna  " -> {display: "Smyrna", key: "smyrna", words: ["smyrna"]}.
// key: canonical words (Mt = Mount, St = Saint) joined with no spaces, so "LaVergne" = "La Vergne". null = cannot read it.
export function townKey(raw) {
  let t = String(raw == null ? '' : raw).normalize('NFKC').replace(/[\p{Cf}​-‏﻿]/gu, '')
    .replace(/[‐-―−-]/g, ' ').replace(/[(),;:!]/g, ' ').replace(/\s+/g, ' ').trim();
  let words = t.split(' ').filter(Boolean);
  const bare = (w) => w.toLowerCase().replace(/\./g, '');
  // drop trailing ZIP codes, country names and state names or short forms (never the last word left)
  for (let again = true; again && words.length > 1;) {
    again = false;
    const last = bare(words[words.length - 1]);
    if (/^\d{4,5}$/.test(last) || /^\d{9}$/.test(last) || !last) { words.pop(); again = true; continue; }
    // "T.N." -> "tn"; multi-word state names
    if (TAIL_ONE.has(last)) { words.pop(); again = true; continue; }
    for (const m of TAIL_MULTI) {
      if (words.length > m.length && words.slice(-m.length).map(bare).join(' ') === m.join(' ')) { words.splice(-m.length); again = true; break; }
    }
  }
  if (words.length) words[words.length - 1] = words[words.length - 1].replace(/\.+$/, '');
  words = words.filter(Boolean);
  const display = words.join(' ');
  if (!display || display.length > 40 || !/^[A-Za-z][A-Za-z .']*$/.test(display)) return null;
  const canon = words.map((w) => { const b = bare(w).replace(/'/g, ''); return CANON[b] || b; });
  return { display: words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' '), key: canon.join(''), words: canon };
}
// edit distance, stops early above 1
function within1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else if (a[i + 1] === b[j] && a[i] === b[j + 1]) { i += 2; j += 2; } else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
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
export function spotFor(item, locks, day = chicagoDay()) {
  if (!LOCK_TRADES.includes(item.trade)) return null;
  const tk = townKey(item.town);
  if (!tk) return { hold: `cannot read the town "${String(item.town || '').slice(0, 80)}" as a plain town name; fill the spot by hand` };
  const active = locks.filter((l) => l.trade === item.trade && activeOn(l, day));
  for (const l of active) {
    for (const t of [l.zone, ...(l.towns || [])]) {
      const lk = townKey(t); if (!lk) continue;
      if (lk.key === tk.key) return { zone: townKey(l.zone).display, open: false };
    }
  }
  // close to a locked town but not the same: never "open"; a person decides
  for (const l of active) {
    for (const t of [l.zone, ...(l.towns || [])]) {
      const lk = townKey(t); if (!lk) continue;
      const startsWith = tk.words.length > lk.words.length && lk.words.every((w, i) => tk.words[i] === w);
      if (startsWith || tk.key.startsWith(lk.key) || within1(tk.key, lk.key))
        return { hold: `the town "${tk.display}" is close to the locked zone "${townKey(l.zone).display}" (${l.trade}); check it by hand` };
    }
  }
  return { zone: tk.display, open: true };
}
