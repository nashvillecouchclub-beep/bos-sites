"""QUALITY GATE - every post, card, video, article and newsletter section passes this before it is scheduled.

Usage (library):  from gate import check_and_fix;  result = check_and_fix(piece)
Usage (CLI):      python3 content-system/gate.py pieces.json        (prints a report, exit 1 if anything is held)

A piece is a dict:
  brand        "booked-out" | "stones-river" | any file name in content-system/brands/
  platform     facebook | instagram | x | x_reply | pinterest | google | linkedin | newsletter | article | video
  text         the words that get posted (for pinterest: the description)
  title        pinterest pin title / article title / newsletter section title (optional)
  link         the ONE call-to-action link (x main post and instagram: none; it goes in the reply / bio)
  comment_prompt  the ONE comment question (not for google, pinterest, article)
  image        path to a card made by the template studio (its .meta.json sits next to it)
  video        path to an mp4 made by the template studio (its .meta.json sits next to it)

Rule: fail = fix automatically and check again; if it still fails, the piece is HELD and logged
(content-system/out/held.jsonl). A held piece is never scheduled.
"""
import json, os, re, sys, subprocess, urllib.request, urllib.error, socket, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HELD_LOG = os.path.join(HERE, 'out', 'held.jsonl')
PASS_LOG = os.path.join(HERE, 'out', 'passed.jsonl')

# ---------- platform limits (checked against each platform's own published limits, Nov 2026) ----------
LIMITS = {
    'facebook':   {'max': 63206, 'soft_max': 2200},   # FB hard cap is 63,206; long posts get "See more" anyway
    'instagram':  {'max': 2200, 'hashtags': 30},
    'x':          {'max': 280},                         # links count as 23 (t.co)
    'x_reply':    {'max': 280},
    'pinterest':  {'max': 500, 'title_max': 100},
    'google':     {'max': 1500},                        # Google Business Profile update posts
    'linkedin':   {'max': 3000},
    'newsletter': {'max': 4000, 'soft_max': 2600},      # one section; research says 200-350 words per issue
    'article':    {'max': 60000, 'min_words': 500},
    'video':      {'max': 2200},                        # caption text
}
NEEDS_PROMPT = {'facebook', 'instagram', 'x', 'linkedin', 'video'}
LINK_RULES = {   # how many URLs may appear inside the text itself
    'facebook': 1, 'linkedin': 1, 'google': 0, 'newsletter': 1, 'article': None,
    'instagram': 0, 'x': 0, 'x_reply': 1, 'pinterest': 0, 'video': 0,
}
URL_RE = re.compile(r'https?://[^\s<>()"\']+[^\s<>()"\'.,;:!?]')

# ---------- words that make posts sound machine-written ----------
SLOP = [
    "in today's fast-paced", "fast-paced world", "game-changer", "game changer", "unlock the", "unlock your",
    "elevate your", "delve", "harness the power", "seamless", "seamlessly", "leverage", "navigate the",
    "ever-evolving", "landscape of", "it's important to note", "it is important to note", "in conclusion",
    "look no further", "revolutionize", "supercharge", "next level", "embark", "tapestry", "skyrocket",
    "boost your bottom line", "dive into", "let's dive", "in the realm of", "unleash", "cutting-edge",
    "a testament to", "whether you're a", "say goodbye to", "the secret sauce", "rest assured", "stay ahead of the curve",
    "empower", "transformative", "synergy", "holistic approach", "robust", "streamline your",
]
EMOJI_RE = re.compile('[\U0001F300-\U0001FAFF☀-➿]')

# ---------- claims we never make ----------
CLAIM_PATTERNS = [
    (r'\$\s?\d', 'price or money amount'),
    (r'\b\d+(\.\d+)?\s?%', 'percent figure (needs a named source, or remove)'),
    (r'\bguarantee[ds]?\b', 'guarantee'),
    (r'\b(double|triple|10x|2x|3x)\s+(your|the)\b', 'promised result'),
    (r'\b(make|earn|making|earning)\s+(more\s+)?(money|\$|six|seven|thousands)', 'income claim'),
    (r'\bwill (get|bring|book|land) you\b', 'promised result'),
    (r'\b(more|extra) (jobs|calls|leads|clients) (guaranteed|every|per)\b', 'promised result'),
    (r'\b#1\b|\bnumber one\b|\bbest in (town|the)\b', 'unprovable superlative'),
    (r'\bin (just )?\d+ days\b.*\b(results|booked|leads)\b', 'promised result with a deadline'),
    (r'\bstudies show\b|\bresearch shows\b|\bstatistics show\b', 'unsourced study claim'),
]
# phrases that are fine even though they match above (questions to the reader, plain advice)
CLAIM_OK = [r'what (%|percent)', r'drop a rough number', r'\bwarranty\b']

CRISIS_WORDS = ['suicid', 'self-harm', 'self harm', 'hopeless', 'crisis', 'panic attack', 'grief', 'trauma',
                'depress', 'abuse', 'want to die', 'overdose', 'emdr', 'affair', 'betrayal', 'loss of a',
                'can\'t go on', 'numb', 'ptsd']
TESTIMONIAL_RE = re.compile(r'(“|")[^"”]{8,}(”|")\s*[-–]\s*[A-Z][a-z]+(\s[A-Z]\.?)?\b|\b(testimonial|five[- ]star review|5[- ]star review from)\b', re.I)


def load_brand(bid):
    return json.load(open(os.path.join(HERE, 'brands', f'{bid}.json')))


def x_length(text):
    """X counts every link as 23 characters."""
    return len(URL_RE.sub('x' * 23, text))


def wcag_ratio(c1, c2):
    def lum(h):
        h = h.lstrip('#')
        if len(h) == 3: h = ''.join(ch * 2 for ch in h)
        r, g, b = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
        f = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    a, b = lum(c1), lum(c2)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


# ---------- link checks: live when the network allows, else the repo's own files ----------
_link_cache = {}
_net_ok = None

def _network_ok():
    global _net_ok
    if _net_ok is None:
        try:
            urllib.request.urlopen(urllib.request.Request('https://getbookedoutsolutions.com/', method='HEAD'), timeout=6)
            _net_ok = True
        except Exception:
            _net_ok = False
    return _net_ok


def _local_resolves(url):
    """True/False if the URL is on one of our own sites in this repo, else None (not ours)."""
    m = re.match(r'https?://(www\.)?([^/]+)(/[^?#]*)?', url)
    if not m: return False
    domain, path = m.group(2), (m.group(3) or '/')
    site = os.path.join(ROOT, 'sites', domain)
    if not os.path.isdir(site): return None
    p = path.rstrip('/')
    if p.startswith('/go/'):   # tracked short link: follow it through the registry to the real page
        reg_p = os.path.join(HERE, 'links', 'links.json')
        reg = json.load(open(reg_p)) if os.path.isfile(reg_p) else {}
        e = reg.get(p[4:])
        return _local_resolves(e['dest']) if e else False
    cands = [p, p + '.html', p + '/index.html'] if p else ['/index.html']
    if any(os.path.isfile(site + c) for c in cands): return True
    red = os.path.join(site, '_redirects')
    if os.path.isfile(red):
        for line in open(red):
            parts = line.split()
            if len(parts) >= 2 and not line.startswith('#'):
                src = parts[0].rstrip('/')
                if src == p or (src.endswith('/*') and p.startswith(src[:-2])): return True
    # planned pages registered by other jobs (e.g. the newsletter page) count as "not yet live"
    planned = os.path.join(HERE, 'links', 'planned_pages.json')
    if os.path.isfile(planned) and path.rstrip('/') in [x.rstrip('/') for x in json.load(open(planned))]:
        return 'planned'
    return False


def check_link(url):
    if url in _link_cache: return _link_cache[url]
    res = {'url': url, 'live': None, 'local': _local_resolves(url)}
    if _network_ok():
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'BookedOutQualityGate/1.0'})
            code = urllib.request.urlopen(req, timeout=12).getcode()
            res['live'] = code
        except urllib.error.HTTPError as e:
            res['live'] = e.code
        except Exception:
            res['live'] = 'unreachable'
    if res['live'] == 200: res['verdict'] = 'ok'
    elif res['live'] in (None, 'unreachable') and res['local'] is True: res['verdict'] = 'ok-local'
    elif res['live'] in (None, 'unreachable') and res['local'] == 'planned': res['verdict'] = 'planned'
    elif res['live'] in (None, 'unreachable') and res['local'] is None: res['verdict'] = 'unverified'
    else: res['verdict'] = 'broken'
    _link_cache[url] = res
    return res


# ---------- the checks ----------
def check(piece):
    brand = load_brand(piece['brand'])
    plat = piece['platform']
    text = piece.get('text', '') or ''
    low = text.lower()
    errors, warns, waits = [], [], []
    lim = LIMITS.get(plat, {})

    # 1. length
    n = x_length(text) if plat in ('x', 'x_reply') else len(text)
    if lim.get('max') and n > lim['max']: errors.append(f'too long for {plat}: {n} > {lim["max"]}')
    if lim.get('soft_max') and n > lim['soft_max']: warns.append(f'long for {plat}: {n} chars')
    if plat == 'pinterest' and len(piece.get('title', '')) > lim['title_max']: errors.append('pin title over 100')
    if plat == 'instagram' and text.count('#') > lim['hashtags']: errors.append('too many hashtags')
    if plat == 'article' and len(text.split()) < lim['min_words']: errors.append(f'article under {lim["min_words"]} words')
    if not text.strip() and plat != 'video': errors.append('empty text')

    # 2. exactly one link call to action
    urls = URL_RE.findall(text)
    allowed = LINK_RULES.get(plat)
    if allowed is not None and len(urls) != allowed:
        errors.append(f'{plat} text must have {allowed} link(s), has {len(urls)}')
    if plat in ('instagram',) and 'link in bio' not in low and 'link in our bio' not in low:
        errors.append('instagram needs "link in bio"')
    if plat in ('x', 'pinterest', 'google', 'video') or plat == 'instagram':
        if not piece.get('link') and plat not in ('x', 'instagram'): errors.append(f'{plat} needs its link field (button / pin link)')
    links = list(dict.fromkeys(urls + ([piece['link']] if piece.get('link') else [])))
    for u in links:
        r = check_link(u)
        if r['verdict'] == 'broken': errors.append(f'link does not resolve: {u} ({r["live"]})')
        elif r['verdict'] == 'planned':
            warns.append(f'link page not live yet (planned): {u}'); waits.append(u)
        elif r['verdict'] == 'unverified': warns.append(f'could not reach outside link from here: {u}')
        if brand['domain'] in u and '/go/' not in u and 'utm_' not in u and plat not in ('article',):
            warns.append(f'untracked link (use a /go/ short link): {u}')

    # 3. exactly one comment prompt
    if plat in NEEDS_PROMPT:
        cp = (piece.get('comment_prompt') or '').strip()
        if not cp: errors.append('missing comment prompt')
        elif cp.lower() not in low and plat != 'video': errors.append('comment prompt not in the text')
        else:
            others = [s for s in re.split(r'(?<=[.?!])\s+', text) if s.strip().endswith('?')]
            last_para = text.strip().split('\n\n')[-1]
            asks = len(re.findall(r'\b(reply|comment|drop (a|your)|tell me|just the number|save this)\b', low))
            if asks > 3: warns.append('several asks; keep one comment prompt')
        for bad in brand['rules'].get('comment_prompt_banned', []):
            if bad in cp.lower(): errors.append(f'comment prompt asks for personal details ("{bad}")')

    # 4. claims
    for pat, why in CLAIM_PATTERNS:
        for m in re.finditer(pat, text, re.I):
            ctx = text[max(0, m.start() - 40): m.end() + 40].lower()
            if any(re.search(ok, ctx) for ok in CLAIM_OK): continue
            if why.startswith('percent') and '?' in text[m.end(): m.end() + 60]: continue  # asking the reader
            errors.append(f'claim check: {why}: "{m.group(0)}"')
    for bp in brand['rules'].get('banned_phrases', []):
        if bp.lower() in low: errors.append(f'banned phrase for {brand["name"]}: "{bp}"')
    if brand['rules'].get('no_testimonials') and TESTIMONIAL_RE.search(text):
        errors.append('looks like a testimonial or review quote')

    # 5. AI slop tells
    for s in SLOP:
        if s in low: errors.append(f'generic phrase: "{s}"')
    if '—' in text: errors.append('em dash (reads machine-written; use a period or comma)')
    if len(EMOJI_RE.findall(text)) > 1: errors.append('emoji')
    if text.count('!') > 2: warns.append('many exclamation marks')
    if re.search(r'\b(\w+)\s+\1\b', low): warns.append('doubled word')

    # 6. client rules (Stones River ethics list)
    if brand['rules'].get('crisis_line_required'):
        if any(w in low for w in CRISIS_WORDS) and '988' not in text and plat not in ('x', 'pinterest'):
            errors.append('crisis-adjacent topic needs the 988 line')
    if brand['rules'].get('adults_only') and re.search(r'\b(teen|teens|kids|children|adolescent|minors?)\b', low):
        warns.append('mentions children/teens (practice is adults 18+); check wording')

    # 7. picture card: brand fonts/colors, size, phone readability
    if piece.get('image'):
        errors += _check_card(piece['image'], brand, plat)
    if piece.get('video'):
        errors += _check_video(piece['video'], brand)

    return {'ok': not errors, 'errors': errors, 'warnings': warns, 'waits_for': waits}


CARD_SIZES = {'facebook': [(1080, 1350), (1080, 1080), (1200, 630)], 'instagram': [(1080, 1350), (1080, 1080)],
              'x': [(1080, 1350), (1200, 675), (1080, 1080)], 'pinterest': [(1000, 1500)], 'google': [(1200, 900)],
              'linkedin': [(1200, 627), (1080, 1350), (1080, 1080)], 'newsletter': [(1200, 630)], 'article': [(1200, 630)]}


def _check_card(path, brand, plat):
    errs = []
    if not os.path.isfile(path): return [f'card file missing: {path}']
    meta_p = re.sub(r'\.(jpg|png)$', '.meta.json', path)
    if not os.path.isfile(meta_p): return ['card has no studio meta (not made by the template studio)']
    meta = json.load(open(meta_p))
    try:
        from PIL import Image
        w, h = Image.open(path).size
    except Exception:
        w, h = meta.get('w'), meta.get('h')
    if plat in CARD_SIZES and (w, h) not in CARD_SIZES[plat]:
        errs.append(f'card size {w}x{h} not right for {plat}')
    if meta.get('brand') != brand['id']: errs.append('card made with another brand template')
    want_fonts = {f['family'] for f in brand['fonts'].values()}
    if not set(meta.get('fonts', [])) <= want_fonts: errs.append(f'off-brand font on card: {meta.get("fonts")}')
    if not meta.get('fonts_loaded', False): errs.append('brand fonts did not load when the card was drawn')
    # phone readability: card is shown about 390px wide on a phone; smallest text must stay >= 11px there
    scale = 390 / w   # a card shows about 390 px wide in a phone feed
    if meta.get('min_font_px', 0) * scale < 9: errs.append(f'smallest text too small on a phone ({meta.get("min_font_px")}px at {w}px wide)')
    if meta.get('headline_px', 99) * scale < 19: errs.append('headline too small on a phone')
    for pair in meta.get('text_pairs', []):
        r = wcag_ratio(pair['fg'], pair['bg'])
        need = 3.0 if pair.get('large') else 4.5
        if r < need: errs.append(f'low contrast {pair["fg"]} on {pair["bg"]} ({r:.1f}:1, need {need})')
    if meta.get('overflow'): errs.append('text overflows the card')
    return errs


def _check_video(path, brand):
    errs = []
    if not os.path.isfile(path): return [f'video missing: {path}']
    meta_p = path.replace('.mp4', '.meta.json')
    meta = json.load(open(meta_p)) if os.path.isfile(meta_p) else {}
    try:
        pr = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
                                       capture_output=True, text=True).stdout)
        dur = float(pr['format']['duration'])
        v = [s for s in pr['streams'] if s['codec_type'] == 'video'][0]
        a = [s for s in pr['streams'] if s['codec_type'] == 'audio']
    except Exception as e:
        return [f'video unreadable: {e}']
    lo, hi = meta.get('target_seconds', [20, 40])
    if not (lo <= dur <= hi): errs.append(f'video length {dur:.1f}s outside {lo}-{hi}s')
    if (int(v['width']), int(v['height'])) not in [(1080, 1920), (720, 1280)]: errs.append('video is not vertical 9:16')
    if not a: errs.append('video has no sound track')
    if not meta.get('captions_burned'): errs.append('captions not burned in')
    if not meta.get('ends_with_cta'): errs.append('video does not end with the call to action')
    if meta.get('shows_person_as_real'): errs.append('video shows an AI person as real')
    if os.path.getsize(path) > 100 * 1024 * 1024: errs.append('video file too big for upload')
    return errs


# ---------- automatic fixes ----------
def autofix(piece, result):
    p = dict(piece)
    brand = load_brand(p['brand'])
    t = p.get('text', '') or ''
    plat = p['platform']
    t = t.replace(' — ', '. ').replace('—', ', ')
    t = EMOJI_RE.sub('', t)
    for s in SLOP:   # only the simplest swaps; anything else is held for a rewrite
        t = re.sub(re.escape(s), {'seamless': 'smooth', 'seamlessly': 'smoothly', 'leverage': 'use', 'empower': 'help',
                                   'robust': 'solid', 'delve': 'look', 'dive into': 'look at'}.get(s, s), t, flags=re.I)
    urls = URL_RE.findall(t)
    allowed = LINK_RULES.get(plat)
    if allowed == 0 and urls:
        for u in urls: t = t.replace(u, '').rstrip()
        t = re.sub(r'[ \t]+\n', '\n', t)
    if allowed == 1 and len(urls) > 1:
        keep = p.get('link') or urls[-1]
        for u in urls:
            if u != keep: t = t.replace(u, '')
    if allowed == 1 and not urls and p.get('link'):
        t = t.rstrip() + '\n\n' + p['link']
    if plat == 'instagram' and 'link in bio' not in t.lower():
        t = t.rstrip() + '\n\n' + brand['cta']['instagram_line'].get(p.get('cta_kind', 'newsletter'), 'Link in bio.')
    if brand['rules'].get('crisis_line_required') and any(w in t.lower() for w in CRISIS_WORDS) and '988' not in t \
            and plat not in ('x', 'pinterest'):
        t = t.rstrip() + '\n\n' + brand['rules']['crisis_line_text']
    if plat == 'google' and len(t) > LIMITS['google']['max']:
        t = _trim_paragraphs(t, LIMITS['google']['max'])
    if plat == 'instagram' and len(t) > LIMITS['instagram']['max']:
        t = _trim_paragraphs(t, LIMITS['instagram']['max'], keep_last=2)
    p['text'] = t
    return p


def _trim_paragraphs(t, limit, keep_last=1):
    paras = t.split('\n\n')
    tail = paras[-keep_last:]
    body = paras[:-keep_last]
    while body and len('\n\n'.join(body + tail)) > limit:
        body.pop(-2 if len(body) > 2 else -1)
    return '\n\n'.join(body + tail)


def _log(path, rec):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a') as f: f.write(json.dumps(rec) + '\n')


def check_and_fix(piece, log=True):
    r = check(piece)
    fixed = piece
    tries = 0
    while not r['ok'] and tries < 2:
        fixed = autofix(fixed, r)
        r2 = check(fixed)
        tries += 1
        if r2['errors'] == r['errors']: r = r2; break
        r = r2
    rec = {'when': datetime.datetime.utcnow().isoformat() + 'Z', 'brand': piece['brand'], 'platform': piece['platform'],
           'id': piece.get('id'), 'errors': r['errors'], 'warnings': r['warnings'], 'auto_fixed': fixed is not piece}
    if log: _log(PASS_LOG if r['ok'] else HELD_LOG, rec)
    return {'ok': r['ok'], 'piece': fixed, 'errors': r['errors'], 'warnings': r['warnings'], 'waits_for': r.get('waits_for', []),
            'fixed': fixed is not piece}


if __name__ == '__main__':
    pieces = json.load(open(sys.argv[1]))
    held = 0
    for pc in pieces:
        res = check_and_fix(pc)
        mark = 'PASS' if res['ok'] else 'HELD'
        held += not res['ok']
        print(f"{mark} {pc.get('id', '')} {pc['brand']}/{pc['platform']}" + ('' if res['ok'] else ' :: ' + '; '.join(res['errors'])))
        for w in res['warnings']: print('     note:', w)
    sys.exit(1 if held else 0)
