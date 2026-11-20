// Booker's brain: persona, who we serve, price tier by business type, knowledge look-up, caller facts.
// Nov 19 2026 (Rickey's test calls 2 and 3). Knowledge library = kb.json (answer bank nov17 + live price page fixes).
// Prompt stays short; each caller turn pulls only the few library entries it needs (look-up is plain code, under 1 ms).
import KB from './kb.js';

export const TIERS = {
  standard: { CORE2: '497', CORE: '997', ADS: '1,997', METRO: '2,497', COMPLETE: '3,797', PA_CORE: '8,947', PA_ADS: '17,947', PA_METRO: '22,447', PA_COMPLETE: '34,147', PIECES: '3,994 dollars', SAVE: '197 dollars' },
  small: { CORE2: '247', CORE: '497', ADS: '997', METRO: '2,497', COMPLETE: '2,997', PA_CORE: '4,447', PA_ADS: '8,947', PA_METRO: '22,447', PA_COMPLETE: '26,947', PIECES: '3,494 dollars', SAVE: '497 dollars' },
};
// Business types that pay the smaller-business prices (Rickey Oct 27 + Nov 3 + Nov 17). Every other type pays standard.
// Unknown types that clearly are not home service, legal, medical or real estate also go small (open to every other business).
const SMALL = /\b(clean|maid|janitor|pressure wash|power wash|junk|handyman|appliance|auto repair|mechanic|car repair|oil change|detail|tint|wrap|tire|tow|photograph|dj\b|florist|flower|event rental|party rental|cake|bakery|photo booth|groom|dog|pet|kennel|boarding|trainer|gym|fitness|crossfit|yoga|pilates|martial|karate|jiu|dance|music lesson|driving school|home inspect|stag|self storage|storage unit|sign shop|print|it support|computer repair|uniform|mat service|salon|nail|hair|barber|tailor|alteration|dry clean|laundr|beauty|lash|brow|wax|tattoo|massage|spa\b|boutique|restaurant|cafe|coffee|food truck|bar\b|retail|store|shop\b)/i;
const STANDARD = /\b(hvac|heating|air condition|a\/c|ac repair|furnace|plumb|electric|pool|custom home|home build|barndominium|roof|storm|solar|kitchen|bath|remodel|foundation|elevator|generator|window|door|dock|law|attorney|lawyer|legal|dentist|dental|orthodont|realtor|real estate|venue|cabinet|hot tub|fenc|concrete|deck|floor|paint|landscap|lawn|tree|irrigation|sprinkler|water treatment|home theater|smart home|gutter|pest|mov(ing|ers)|med spa|medspa|medical spa|doctor|clinic|physician|chiropract|auto body|collision|\brv\b|boat|security|alarm|cater|property manag|contractor|construction|builder)/i;
export function tierFor(type) {
  const t = String(type || '');
  if (!t) return null;
  if (/med ?spa|medical spa/i.test(t)) return 'standard';
  if (STANDARD.test(t) && !/\b(nail|hair|barber|salon|clean)/i.test(t)) return 'standard';
  if (SMALL.test(t)) return 'small';
  return 'small';
}
export function fill(s, tier) { const v = TIERS[tier || 'standard']; return String(s).replace(/\{([A-Z0-9_]+)\}/g, (m, k) => (v[k] ?? m)); }

const STOP = new Set('a an the and or but if is are am was be to of in on for with at by it its this that do does did i you we they he she my your our me us so what how can could would will just like um uh yeah okay ok well hey hi hello there have has get got about any all some one not no yes really then than too very much also'.split(' '));
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|es|s)$/, ''));
const IDX = KB.map((e) => ({ e, t: new Set(words(e.title)), a: new Set(words(e.asks)) }));
const BOOST = [
  [/\b(list|break (it )?down|everything|all the (stuff|things|services)|what all|each package|how many (things|packages))\b/i, ['X1']],
  [/\b(differen|compare|bigger|more stuff|biggest|top package)\b/i, ['X2', 'C12']],
  [/\bcomplete\b/i, ['C12']], [/\bcore\b/i, ['C3']], [/\bmetro|lock|exclusive|zone\b/i, ['C9']], [/\bads?\b|google ads|advertis/i, ['C5']],
  [/\b(price|cost|how much|charge|expensive|afford|dollars|four forty|nine ninety|497|997)\b/i, ['C1']],
  [/\b(record|transcript)/i, ['X3']], [/receptionist/i, ['H1', 'X4']], [/guarantee/i, ['N1']], [/(real person|human|someone|somebody|anyone).{0,20}(call|talk|speak)|(call|talk|speak).{0,20}(real person|human)/i, ['X9']], [/robot|real person|human|\bai\b|artificial/i, ['O2']],
  [/rickey|ricky|owner|manager|supervisor|talk to (a|someone)/i, ['O3']], [/contract|cancel/i, ['M1', 'M2']], [/free report/i, ['K1']],
  [/pay ahead|year|annual|upfront/i, ['F1']], [/spanish|español|espanol/i, ['X6']], [/sign up|start|get started/i, ['X5', 'Q2']],
  [/how (does it|do you) work|how it works|process/i, ['A7']], [/what do you (do|guys do)|what is (this|booked out)/i, ['A1']],
  [/dentist|dental|doctor|medical|patient|med ?spa|clinic/i, ['B6']], [/new company|how long have you been|how many (clients|customers|businesses)/i, ['X7']],
  [/case stud|success stor|reference|proof|results? (near|like)/i, ['X8']], [/software|model|what ai|which ai/i, ['A9']], [/your email|contact you|reach you/i, ['Q1']],
  [/client|work with (them|anyone)|stones river|sarah|other business/i, ['O6']], [/lock start|when is it mine/i, ['C10']], [/lawyer|attorney|law firm|realtor|real estate/i, ['B7']],
];
export function lookup(text, max = 3) {
  if (/\b(differen|compare|versus|vs\.?)\b/i.test(text)) return KB.filter((e) => e.id === 'X2');
  const w = words(text); const scores = new Map();
  for (const { e, t, a } of IDX) { let s = 0; for (const x of w) { if (t.has(x)) s += 2; if (a.has(x)) s += 1; } if (s >= Math.min(3, Math.max(1, w.length))) scores.set(e.id, s); }
  if (!/booked out|more than i can handle|too busy|don't need|do not need|slammed/i.test(text)) scores.delete('B5');
  for (const [re, ids] of BOOST) if (re.test(text)) ids.forEach((id, i) => scores.set(id, (scores.get(id) || 0) + 10 - i));
  if (!/booked out|more than i can handle|too busy|don't need|do not need|slammed/i.test(text)) scores.delete('B5');
  return [...scores.entries()].sort((x, y) => y[1] - x[1]).slice(0, max).map(([id]) => KB.find((e) => e.id === id)).filter(Boolean);
}

export const PERSONA = `You are Hank Booker, people call you Booker, the AI assistant for Booked Out Solutions, on a live PHONE CALL. You are a warm, funny, easygoing shop foreman type: personable, never stiff, never robotic, never salesy.
Booked Out Solutions (owner Rickey Hallor, Smyrna, Tennessee) gets local businesses more booked customers while the owner does almost none of the work: quotes and inquiries followed up, every lead answered fast, more Google reviews and every review answered, the Google profile kept full, past customers brought back, postcards, ads on bigger packages, and a Friday report. Everything runs by email.
WHO WE SERVE: every kind of local business. Home service shops (heating and air, plumbing, electrical, roofing, pools, remodelers and so on), and just as much salons and nail salons, barbers, spas, gyms, auto repair and body shops, cleaners, photographers, groomers, dentists, doctors and med spas, law firms, realtors, wedding venues, caterers and any other local business. When a caller names their business, say yes warmly, for example "A nail salon, love it, yes, we work with salons." NEVER say we only work with HVAC, plumbing or electrical. Never turn a business away. If it truly sounds like a poor fit, say "Let me get your email and Rickey will send you what fits."
HOW YOU TALK:
- This is a real conversation. React to what they just said like a person would ("Oh nice", "Got it", and "Oof, that's rough" only when something is actually going wrong), then answer, then ask ONE easy question. Use contractions, short sentences, a light joke now and then about the problem, never about them.
- Early in the call, if you don't have it yet, ask their first name ("Who do I have the pleasure of talking to?"), then use their name now and then. Then learn their business name and what kind of business it is, and what's bugging them.
- MEMORY: read CALLER FACTS and the whole conversation before every reply. NEVER ask for something they already told you. Never tell a caller "you didn't tell me" or "you haven't mentioned" or argue. If you truly missed something, own it warmly: "Sorry about that, Pat, say that one more time for me?"
- EVERY reply: first directly answer exactly what they asked, with real specifics, then end with ONE short natural question that keeps things moving. Never vague, never answer a question with only a question.
- Normal replies are 1 to 3 short sentences, under 45 words. When they ask for a list or what's in a package, LIST the pieces out loud one by one ("One, ... Two, ...") with a few words on why each matters, top 5 or 6, then ask "Want the rest, or should I email you the full list?" Never answer a list request with only package names.
- Spoken words only: no bullet points, symbols, emojis or dashes. Say prices like "997 dollars".
RULES:
- You are an AI. If asked, say so plainly and kindly. Never claim to be human or invent a personal life.
- Rickey answers by email only. Never say Rickey or anyone is going to phone them back. To reach Rickey, take their email and their question.
- You take messages. Never book jobs or appointments. Never take a card number or password.
- Never promise jobs, leads, calls, revenue or rankings. We guarantee the work, not jobs.
- Facts and prices come ONLY from PRICES and REFERENCE below. If it isn't there: "Good question, and I don't want to guess. Leave me your email and Rickey will answer you by email."
- Never mention: waves, launch dates, launch, founding, first clients, we're new, internal costs, tools, vendors or software (Square checkout is fine), any client or any other business we work with. Never confirm anyone is a client. No fake urgency, no pushing.
- Starter (297 dollars) only once, only after a clear no to Core. After two clear no's, leave on a good note.
- If asked about waves, launch dates or when we take their kind of business: never use those words; say every kind of local business can get started now, and offer to have Rickey email the sign up page for their business.
- Never ask about their budget. When they spell an email, read it back once.
- NAMES: use a person's name or business name ONLY if it is in CALLER FACTS or they said it in this call. Never make one up and never use a name from the sample moments. No name yet? Use none.
- PACKAGES: exactly four, smallest to biggest: Core, Ads, Metro Lock, Complete. Complete is the biggest and includes everything in Core, Ads and Metro Lock, plus five more. Never say two packages, never call any package most popular, nothing is above Complete.
- HONESTY: never claim success stories, results, popularity, how many businesses we work with, or anything about any other business. Never say yes or no about whether anyone is a client: "I don't share who we work with, either way." Nobody else can join this call; Rickey answers by email.
- Metro Lock means only this: we don't work for any other business like theirs in their zone. Never say it makes them show up first or the only one in search.
- If they already said they need more work (or are booked out), never ask that again.
- List and compare answers: up to 6 pieces, about 70 words, then offer the rest by email. Vary your closing questions; don't reuse the same line twice in a call.
- Before the call ends, if you don't have their email yet and they showed interest, ask for it once so Rickey can send details.
- Never refer to other calls or other callers. Never say you'll send anything yourself; once you have their email, Rickey sends it by email.
- If the caller says goodbye or wants to end, say a short warm goodbye using their name and add [END] at the very end.`;

export const SAMPLES = `SAMPLE MOMENTS (match this voice; never copy word for word):
Caller: Hi. / Booker: Hey there, thanks for calling! Who do I have the pleasure of talking to?
Caller: This is Pat. / Booker: Hi Pat, good to meet you. What can I do for you today?
Caller: I have a nail salon. / Booker: A nail salon, love it. Yes, we work with salons. How long have you been open?
(later in the same call) Caller: What kind of help would my salon get? / Booker: For your salon, Pat, the big ones are more Google reviews, every inquiry answered the same day, and past clients reminded to come back. Which of those would help most?
Caller: I already told you what I do. / Booker: You did, a nail salon, my bad. So for your salon, what's the biggest headache right now?
Caller: Are you a robot? / Booker: Ha, guilty, I'm Booker, Booked Out's AI assistant. I'll always tell you that. What can I help you figure out?
Caller: Give me the list of what's in Core. / Booker: Sure. One, your old quotes followed up so priced work gets a second chance. Two, every inquiry answered the same day. Three, every customer asked for a Google review. Four, your Google profile kept full and posted on weekly. Five, past customers reminded to come back. Six, a Friday report on what it brought in. Want the rest, or should I email you the full list?
Caller: How much is it? / Booker: Your first 30 days are free. Core is then {CORE2} dollars for the next 30 days and {CORE} after that, no contract. Want to hear what that gets you?
Caller: That's a lot of money. / Booker: Fair, it's real money. Is it the price itself, or not being sure it'll work for you?
Caller: Can I talk to Rickey? / Booker: Rickey handles everything by email. Give me your email and what's on your mind and he'll answer you there. What should I tell him?
Caller: I got burned by a marketing company. / Booker: Oof, I'm sorry, that stings. What did they actually do for you?
Caller: I run a barbershop called Fade Factory. / Booker: Fade Factory, great name. Yes, we work with barbers. Are you slammed right now or wanting more customers?
Caller: I'm a dentist. / Booker: Great, yes, we help dental offices with the marketing side, and we never touch patient information. What's your practice called?
Caller: (spells out their email) / Booker: (reads back exactly what they said, once) Did I get that right?
Caller: Tell me about the report you did for another business. / Booker: I don't share anything about other businesses, either way. Happy to tell you how your own free report works, though. Want that?
Caller: Okay, thanks, bye. / Booker: Thanks for calling, Pat, take care! [END]`;

export function buildSystem({ facts = {}, recent = '' } = {}) {
  const tier = tierFor(facts.business_type) || 'standard';
  const known = Object.entries(facts).filter(([k, v]) => v && !k.startsWith('_')).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`).join('; ');
  const priceIntro = facts.business_type ? `PRICES for a ${facts.business_type} (say only these):` : 'PRICES (for heating and air, plumbing, electrical and most home service, legal, medical and real estate businesses; if they haven\'t said their business yet, give these and add that some kinds of businesses pay less, then ask what kind of business they run):';
  const prices = fill(`${priceIntro} First 30 days free on every package, nothing charged, card on file on Square's checkout, email before any charge, no long-term contract, cancel any time with one reply. Core: {CORE2} dollars for the second 30 days, then {CORE} every 30 days. Ads: {ADS} every 30 days, ad budget is their own paid to Google on top. Metro Lock: {METRO} every 30 days. Complete: {COMPLETE} every 30 days, includes Core, Ads, Metro Lock and your own AI receptionist plus office help. AI receptionist add-on 497 every 30 days. Full website for Core 97 every 30 days. More postcards 149 per 100. Pay ahead 12 months for the price of 9: Core {PA_CORE}, Ads {PA_ADS}, Metro Lock {PA_METRO}, Complete {PA_COMPLETE}. Guarantee: we guarantee the work, not jobs; miss any piece of your package in a paid period and your next 30 days are free.${tier === 'small' ? ' For this kind of business Rickey emails the sign up page; offer to take their email.' : ''}`, tier);
  const refs = lookup(recent).map((e) => `- ${e.title}: ${fill(e.answer, tier)}`).join('\n');
  const nm = String(facts.name || '').trim();
  const samples = nm ? fill(SAMPLES, tier).replace(/\bPat\b/g, nm) : fill(SAMPLES, tier).replace(/,? Pat\b/g, '').replace(/\bPat\b/g, '');
  return [PERSONA, samples, prices,
    `CALLER FACTS (already given, never ask again): ${known || 'none yet'}`,
    refs ? `REFERENCE for this question (use these facts, say it in your own warm words):\n${refs}` : ''].filter(Boolean).join('\n\n');
}

// Caller facts: a tiny model call after each turn (runs in the background, never slows the reply).
export const FACTS_PROMPT = 'Read the phone call so far. Use ONLY what the CALLER said about themselves, never what BOOKER said (Booker, Booked Out Solutions and AI assistant are never the caller). Return ONLY a JSON object with these keys, using "" when not stated by the CALLER: name (caller first name), business_name, business_type (e.g. nail salon, plumbing), problem (what is bugging them, under 12 words), email, town. Never guess.';
export function parseFacts(txt, old = {}) {
  let j = {}; if (txt && typeof txt === 'object') txt = JSON.stringify(txt); try { const m = String(txt || '').match(/\{[\s\S]*\}/); j = m ? JSON.parse(m[0]) : {}; } catch (e) { j = {}; }
  const out = { ...old };
  for (const k of ['name', 'business_name', 'business_type', 'problem', 'email', 'town']) { const v = String(j[k] || '').trim(); if (v && v.length < 80 && !/^(unknown|none|n\/a|null)$/i.test(v) && !/booked out|ai assistant|\bbooker\b/i.test(v)) out[k] = v; }
  return out;
}
// Quick catch in code too, so facts are there even before the model answers.
export function quickFacts(heard, old = {}) {
  const f = { ...old }; const h = String(heard || '');
  let m = h.match(/\b(?:my name is|my name's|this is|it's|i'm|i am)\s+([A-Z][a-z]{1,15})\b/);
  if (m && !f.name && !/^(Booked|Just|Good|Fine|Calling|Looking|Not|So|Really|Here|Okay|Interested)$/i.test(m[1])) f.name = m[1];
  m = h.match(/\b(?:i (?:have|own|run)|we (?:have|own|run|are)|i'm|it's)\s+(?:a|an)\s+([a-z ]{3,40}?)(?:\s+(?:business|shop|company|place|called|in|and|but|so)\b|[.,!?]|$)/i);
  if (m && !f.business_type && tierFor(m[1]) && (SMALL.test(m[1]) || STANDARD.test(m[1]))) f.business_type = m[1].trim();
  if (!f.business_type && /^\s*(?:a|an)\s+([a-z ]{3,30})[.!?]?\s*$/i.test(h)) { const t = h.replace(/^\s*(?:a|an)\s+/i, '').replace(/[.!?]/g, '').trim(); if (SMALL.test(t) || STANDARD.test(t)) f.business_type = t; }
  m = h.match(/[\w.+-]+@[\w-]+\.[\w.]+/); if (m && !f.email) f.email = m[0];
  return f;
}

// Price guard: a spoken sentence with a dollar figure that isn't on this business's price list is swapped for a safe line.
const OK = { standard: new Set(), small: new Set() };
for (const t of ['standard', 'small']) { for (const v of Object.values(TIERS[t])) String(v).split(' ')[0] && OK[t].add(String(v).split(' ')[0].replace(/,/g, '')); ['497', '97', '149', '297', '19', '29', '1000', '0'].forEach((x) => OK[t].add(x)); }
export const PRICE_SAFE = "I want to give you the exact number, not a guess, so leave me your email and Rickey will send it.";
export function guardPrice(sentence, facts = {}) {
  const tier = tierFor(facts.business_type) || 'standard';
  for (const m of String(sentence).matchAll(/\$?\s?(\d[\d,]*)\s*(dollars|bucks)|\$\s?(\d[\d,]*)/gi)) { const v = (m[1] || m[3]).replace(/,/g, ''); if (Number(v) >= 10 && !OK[tier].has(v) && !(tier === 'standard' && OK.small.has(v) && !facts.business_type)) return PRICE_SAFE; }
  return sentence;
}

// Say guard: hard rules enforced in code on every spoken sentence (the model can slip; the caller never hears it).
export const CALLBACK_SAFE = "Rickey answers by email, so leave me your email and he'll get back to you there.";
export function guardSay(sentence, facts = {}) {
  let x = guardPrice(guardPackages(sentence, facts), facts);
  if (/\b(call|ring|phone) (you|ya) (back|later|tomorrow|soon)|give you a (call|ring)|(he|rickey|someone|somebody|i|we)('ll| will| can) (call|phone|ring) you|call you\b/i.test(x)) return CALLBACK_SAFE;
  x = x.replace(/\bour two main packages\b/gi, 'two of our four packages').replace(/,? (?:it's |is )?our most popular( package)?,?/gi, ',').replace(/\bmost popular\b/gi, 'starting');
  if (/\b(i|we)('ll| will) get back to you\b/i.test(x)) return CALLBACK_SAFE;
  if (/only one (showing|show) up|show(ing)? up first|find you first|top of (google|search)/i.test(x)) return "With Metro Lock, we don't work for any other business like yours in your zone.";
  if (!/Metro Lock/.test(x)) x = x.replace(/\bComplete\b([^.]{0,30}?)\b(is|has|adds|includes|gives you|covers) (everything|all) (in|of) (Core|that)\b,?( plus)?/, (m, a, v) => `Complete${a}${v} everything in Core, Ads and Metro Lock, plus`).replace(/plus,? plus/g, 'plus');
  x = x.replace(/\b([A-Z][a-z]+)'s ((?:[A-Z][a-z]+ ?){1,3})/g, (m, who, rest) => (/^(Booked|Out|Rickey|Square|Google)$/.test(who) || String(facts._said || '').toLowerCase().includes(who.toLowerCase() + "'s")) ? m : 'your ' + (/(salon|shop|business|company|studio|place)/i.exec(rest) || ['business'])[0].toLowerCase() + ' ');
  x = x.replace(/\b([A-Z][a-z]+)'s ((?:[a-z]+ ){0,2})(salon|shop|business|company|studio|place|gym|office|practice|firm)\b/g, (m, who, mid, noun) => (/^(Booked|Out|Rickey|Square|Google)$/.test(who) || String(facts._said || '').toLowerCase().includes(who.toLowerCase() + "'s")) ? m : `your ${mid}${noun}`).replace(/\b(a|your) ([a-z ]{3,25}), your \2\b/g, '$1 $2');
  x = x.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').replace(/\bplus,? and\b/g, 'and').replace(/\b(we work with [^.]{1,40}?) before\b/gi, '$1');
  x = x.replace(/\bwe('ve| have) (helped|worked with)\b(?! (lots|a lot|many|plenty|tons|hundreds|dozens|so many))/gi, 'we work with'); x = x.replace(/\b(we work with [^.]{1,40}?) before\b/gi, '$1');
  if (/\bComplete\b/.test(x) && /\badd(-on| on| an?)?\b[^.]{0,20}AI receptionist|AI receptionist[^.]{0,15}add-on/i.test(x)) return fill('Complete, {COMPLETE} dollars every 30 days, already includes your own AI receptionist.', tierFor(facts.business_type) || 'standard');
  if (/(email is|got it,?|so that's)[^.?]{0,40}\b(at|@)\b[^.?]{0,30}\b(dot|\.)\s?(com|net|org|us|co)\b/i.test(x) && !facts.email && !/(@|\bat\b)[^.]{0,40}\b(dot|\.)\s?(com|net|org|us|co)\b/i.test(String(facts._said || ''))) return "What's the best email for you?";
  if (/\b(high|higher|first|top|number one)( up)? (in|on) (search|google|the map)|show up (high|higher|first|on top|at the top)/i.test(x)) return "We do the work that helps you get found, but nobody honest can promise a ranking.";
  x = x.replace(/\bwe help (a lot|lots|many|plenty|tons|so many) of\b/gi, 'we work with').replace(/\bwe've found that\b/gi, 'the idea is that');
  if ((facts.years_open || /\b(open|in business|around|been doing (it|this))\b[^.]{0,20}\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|\w+teen|twenty|thirty) (years?|months?)|\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty|thirty) (years?|months?) (now|open|in business)/i.test(String(facts._said || ''))) && /how long (have you|has it|have y'all|you been)/i.test(x)) return '';
  x = x.replace(/\bwe work with a lot of\b/gi, 'we work with');
  if (/sticks? with us|sees? (an|a big|real) (increase|bump|jump)|see(s)? more (leads|customers|jobs|calls)|you('ll| will) (get|see) more (leads|customers|jobs|calls)/i.test(x)) return "I can't promise results, but we guarantee the work.";
  if (/(receptionist|Complete)[^.]{0,60}\b(book|schedul)\w*\b/i.test(x) && !/(doesn't|does not|never|won't|can't|no)\b[^.]{0,15}\b(book|schedul)/i.test(x)) return "Your AI receptionist answers your calls day and night and emails you every message; it takes messages and doesn't book jobs.";
  if (/patient/i.test(x) && !/dent|doctor|medical|clinic|med ?spa|chiro|physician|therap|orthodon|optom|vet/i.test(String(facts.business_type || '') + ' ' + String(facts._said || ''))) return '';
  if (/not a marketing (company|agency)/i.test(x)) return '';
  if (/different call|another call|earlier call|other call/i.test(x)) return '';
  if (/helped (lots|a lot|many|plenty|tons|hundreds|dozens) of|we've seen (it|great|real|businesses)|businesses (just )?like yours (have|saw|got)|our clients (have|see|saw)/i.test(x)) return "I won't make up stories; what I can show you is your own free report.";
  if (/first one (in|showing|people|they)|the one people see|people see (you )?first|first in (search|google)|in search results|top spot/i.test(x)) return "With Metro Lock, we don't work for any other business like yours in your zone.";
  if (/price of (8|eight|10|ten|11|eleven)\b|for (9|nine) months\b(?!,? (and )?(you )?get)/i.test(x)) return fill('Pay ahead is pay for 9 months and get 12: Core {PA_CORE} dollars, Ads {PA_ADS}, Metro Lock {PA_METRO}, Complete {PA_COMPLETE}.', tierFor(facts.business_type) || 'standard');
  if (/go-to (shop|business|name|place)|the only (one|shop|business) (people|customers) (see|find|call)/i.test(x)) return "With Metro Lock, we don't work for any other business like yours in your zone.";
  if (/\b(i|we)('ll| will| can) (send|email) you\b/i.test(x) && !facts.email) return "Leave me your email and Rickey will send it to you.";
  if (/not a (specific |real )?model|custom[- ]built ai|no model|in-house ai|own ai model|proprietary|built (it )?by booked out|\bour own ai\b(?! receptionist)/i.test(x)) return "I'm an AI assistant, and how we build things is our side of the house.";
  if (/\bwaves?\b|\blaunch(ing|ed)?\b|\bfounding\b/i.test(x)) return ''; // never said to callers: drop the sentence
  if (/success stor|case stud(y|ies) (from|near)|businesses just like yours (in|near)/i.test(x)) return "I don't share who we work with, and I won't make up stories.";
  return x.replace(/\s+,/g, ',').replace(/,\s*,/g, ',').trim();
}

// Caller is saying goodbye: answer warmly in code and end the call (no model, no extra pitch).
export function isGoodbye(heard) { return /^(ok(ay)?[, ]*)?(thanks?( you)?[, ]*)?(ok(ay)?[, ]*)?(bye|goodbye|good bye|bye bye|have a good (one|day|night)|talk (to you )?later|i('ve)? (gotta|got to|have to) go|that's all)[.! ]*(bye)?[.! ]*$/i.test(String(heard || '').trim()); }
export function goodbyeLine(facts = {}) { return `Thanks for calling${facts.name ? ', ' + facts.name : ''}, take care!`; }

// Package price guard: a number said right after a package name must be that package's price for this business.
const PKG = { Core: ['CORE', 'CORE2', 'PA_CORE'], Ads: ['ADS', 'PA_ADS'], 'Metro Lock': ['METRO', 'PA_METRO'], Complete: ['COMPLETE', 'PA_COMPLETE'] };
export function priceLine(facts = {}) { return fill('Your first 30 days are free. Then Core is {CORE2} dollars for the next 30 days and {CORE} after that, Ads is {ADS}, Metro Lock {METRO} and Complete {COMPLETE}, every 30 days.', tierFor(facts.business_type) || 'standard'); }
export function guardPackages(x, facts = {}) {
  const tiers = facts.business_type ? [tierFor(facts.business_type)] : ['standard', 'small'];
  for (const [name, keys] of Object.entries(PKG)) {
    const re = new RegExp('\\b' + name + '\\b[^.\\d]{0,45}?(\\d[\\d,]*)\\s*(?:dollars)?', 'g');
    for (const m of String(x).matchAll(re)) {
      const v = m[1].replace(/,/g, ''); if (Number(v) < 50) continue;
      const ok = tiers.some((t) => keys.some((k) => TIERS[t][k].replace(/,/g, '') === v));
      if (!ok) return priceLine(facts);
    }
  }
  if ((tierFor(facts.business_type) || 'standard') === 'standard') x = x.replace(/\b997 dollars every 30 days after the free (month|30 days|30)\b/g, '497 dollars for the second 30 days, then 997 every 30 days');
  if ((tierFor(facts.business_type) || '') === 'standard' && /\bCore\b[^.]{0,40}\b497\b[^.]{0,25}every 30 days/i.test(x) && !/second|next 30|then 997/i.test(x)) return priceLine(facts);
  return x;
}

// Pinned answers: for the questions that matter most, Booker says the locked library answer word for word (with the right
// prices for this business). No model, so no slips, and it starts speaking at once.
const PIN = [
  [/\b(differen\w*|compare|versus|vs\.?)\b[^?]{0,40}\b(core|complete|ads|metro|package)|\b(core|complete|ads|metro)\b[^?]{0,30}\b(differen\w*|compare|versus|vs\.?)\b/i, 'X2'],
  [/\b(bigger|biggest|top|largest|more stuff|most stuff|everything) (package|one|plan)|is there (a )?(bigger|more)|package with more/i, 'X2'],
  [/\b(list|name|tell me|what are|break down|go over|run through)\b[^?]{0,25}\b(the |all |your )?(packages|options|plans)\b|how many packages/i, 'C2'],
  [/(what('s| is| all is)?|tell me|break (it )?down|list)[^?]{0,25}\b(in|with|inside|include[sd]?|get (with|in))\b[^?]{0,12}\bcomplete\b|\bcomplete\b[^?]{0,20}(include|come with|get me|have in it)/i, 'C12'],
  [/(what('s| is| all is)?|tell me|break (it )?down|list)[^?]{0,25}\b(in|with|inside|include[sd]?|get (with|in))\b[^?]{0,12}\bmetro( lock)?\b|what('s| is) metro lock/i, 'C9'],
  [/(what('s| is| all is)?|tell me|break (it )?down|list)[^?]{0,25}\b(in|with|inside|include[sd]?|get (with|in))\b[^?]{0,12}\bcore\b|\bcore\b[^?]{0,20}(include|come with)/i, 'C3'],
  [/(what('s| is| all is)?|tell me|break (it )?down|list)[^?]{0,25}\b(in|with|inside|include[sd]?|get (with|in))\b[^?]{0,12}\b(the )?ads( package)?\b/i, 'C5'],
  [/\b(pay ahead|pay (for )?(the |a )?(whole )?year|annual|up ?front)\b/i, 'F1'],
  [/\bguarantee/i, 'N1'], [/spanish|español|espanol|\bhabla/i, 'X6'],
  [/\b(what|which) (ai|a\.i\.|model|software|llm)\b|(ai|model) (are you|do you) (run|use|built)/i, 'A9'],
];
export function pinned(heard, facts = {}) {
  const h = String(heard || '');
  for (const [re, id] of PIN) if (re.test(h)) { const e = KB.find((x) => x.id === id); if (e) return fill(e.answer, tierFor(facts.business_type) || 'standard').replace(/\s*\(If they want[^)]*\)/, ''); }
  return null;
}
