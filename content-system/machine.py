"""ONE-TO-EVERYTHING CONTENT MACHINE.

One source tip  ->  Facebook long post, Instagram caption, X post + first reply with the link, Pinterest pin,
Google Business post, LinkedIn post, newsletter section, website article (when the tip has an article body),
short-video script, plus every picture card. Each piece is sized to its platform, has ONE comment prompt and ONE
link call to action, and goes through the quality gate. Nothing that fails the gate is ever scheduled.

  python3 content-system/machine.py <brand> <tips.json> [n ...] [--cards] [--video] [--out DIR]

  brand:     a file in content-system/brands/ (booked-out, stones-river, ...)
  tips.json: a list of source tips, or the {"posts": [...]} bank (content/booked-out/posts.json)
  --cards:   also draw the picture cards (feed, square, pin, google, linkedin) with the template studio
  --video:   also render the short video for each tip (about 2-4 minutes per video)
Output: DIR/<brand>/tip-NN/pieces.json (every piece with gate result) and the cards/video; plus DIR/<brand>/schedule.json
with only the pieces that PASSED, ready for the posting task (Buffer / Metricool / our own posting tool).

SOURCE TIP fields (the daily posting task or a writing run fills these in):
  n, headline, kicker (2-3 word label for the card), points (3 short card lines),
  long (150-300 words: hook, why, steps, example, common mistake; LAST paragraph = the comment prompt),
  x (under 240 chars, no link; ends with a question), pin_title, pin (under 500 chars),
  optional: google (under 1,400 chars), linkedin (if different from long), article (markdown, 600-1,200 words),
  video (script dict, see studio/video.py), cta ("newsletter" | "free-look" | "consult" | "articles"; else the brand mix decides),
  comment_prompt (else the last paragraph of long).
"""
import json, os, re, sys, copy, html
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE); sys.path.insert(0, os.path.join(HERE, 'studio')); sys.path.insert(0, os.path.join(HERE, 'links'))
import gate, golinks


def brand(bid): return gate.load_brand(bid)


def pick_cta(b, tip):
    """Brand mix: Booked Out = about 3 in 4 to the newsletter, 1 in 4 to the free look. Explicit cta wins,
    except the old 'site' value, which now means the newsletter (Rickey Nov 14)."""
    c = tip.get('cta')
    keys = [k for k in b['cta']['mix']]
    if c in keys: return c
    if c == 'site' and 'newsletter' in keys: c = None
    mix = b['cta']['mix']
    cycle = sum(([k] * v for k, v in mix.items()), [])
    return cycle[(int(tip['n']) - 1) % len(cycle)] if c is None else cycle[0]


def split_prompt(long):
    paras = [p for p in long.strip().split('\n\n') if p.strip()]
    return '\n\n'.join(paras[:-1]), paras[-1].strip()


def steps_from(long):
    return [re.sub(r'^\d+\.\s*', '', l).strip() for l in long.split('\n') if re.match(r'^\d+\.\s', l.strip())]


def first_sentence(t):
    m = re.match(r'(.+?[.?!])(\s|$)', t.strip().replace('\n', ' '))
    return m.group(1) if m else t.strip()


def campaign(b, tip): return f"tip-{int(tip['n']):02d}"


def build_pieces(bid, tip):
    b = brand(bid)
    kind = pick_cta(b, tip)
    cta = b['cta'][kind]
    body, prompt = split_prompt(tip['long'])
    prompt = tip.get('comment_prompt', prompt)
    camp = campaign(b, tip)
    link = lambda plat: golinks.make(b, plat, camp, cta['url'], tip['n'])
    pieces = []
    tid = f"{bid}-{int(tip['n']):02d}"

    def add(plat, text, **kw):
        pieces.append(dict(id=f'{tid}-{plat}', brand=bid, platform=plat, text=text, source_n=tip['n'], cta_kind=kind, **kw))

    if 'facebook' in b['platforms']:
        L = link('facebook')
        add('facebook', f"{body}\n\n{prompt}\n\n{cta['line']} {L}", link=L, comment_prompt=prompt, card='feed')
    if 'instagram' in b['platforms']:
        ig_line = b['cta'].get('instagram_line', {}).get(kind, 'Link in bio.')
        add('instagram', f"{body}\n\n{prompt}\n\n{ig_line}", comment_prompt=prompt, card='feed',
            bio_link=golinks.make(b, 'bio', 'profile', cta['url'], 'bio'))
    if 'x' in b['platforms'] and tip.get('x'):
        xp = tip['x'].strip()
        xprompt = [s for s in re.split(r'(?<=[.?!])\s+', xp) if s.endswith('?')]
        L = link('x')
        add('x', xp, comment_prompt=(xprompt[-1] if xprompt else ''), card='feed', thread_reply=f"{cta['short']}: {L}")
        add('x_reply', f"{cta['short']}: {L}", link=L)
    if 'pinterest' in b['platforms'] and tip.get('pin'):
        add('pinterest', tip['pin'], title=tip.get('pin_title', tip['headline'])[:100], link=link('pinterest'), card='pin')
    if 'google' in b['platforms']:
        g = tip.get('google') or google_text(tip, body)
        add('google', g, link=golinks.make(b, 'google', camp, cta['url'], tip['n']), button='LEARN_MORE', card='google')
    if 'linkedin' in b['platforms']:
        L = link('linkedin')
        li_body = tip.get('linkedin') or body
        add('linkedin', f"{li_body}\n\n{prompt}\n\n{cta['line']} {L}", link=L, comment_prompt=prompt, card='linkedin')
    if 'newsletter' in b['platforms'] and b['cta'].get('newsletter'):
        # the newsletter never points at itself: its one link goes to the free look or the website
        nkind = 'free-look' if kind == 'free-look' else 'free-look' if int(tip['n']) % 4 == 0 else None
        nl = golinks.make(b, 'newsletter', camp, (b['cta']['free-look']['url'] if nkind else f"https://{b['domain']}/"), tip['n'])
        add('newsletter', newsletter_section(tip, body, nl, nkind, b), title=tip['headline'], link=nl)
    if 'article' in b['platforms'] and tip.get('article'):
        add('article', tip['article'], title=tip['headline'], link=cta['url'])
    if 'video' in b['platforms']:
        add('video', f"{tip['headline']}. {first_sentence(body)}\n\n{prompt}", comment_prompt=prompt,
            script=video_script(b, tip, body, kind))
    return pieces


def google_text(tip, body):
    """Google posts have no comments and get cut at about 1,500 characters: hook + the steps + a short close."""
    paras = body.split('\n\n')
    hook = paras[0]
    steps = steps_from(body)
    out = hook + '\n\n' + '\n'.join(f'{i + 1}. {s}' for i, s in enumerate(steps[:5]))
    mistake = [p for p in paras if p.lower().startswith('the common mistake')]
    if mistake and len(out) + len(mistake[0]) < 1350: out += '\n\n' + mistake[0]
    return out[:1450]


def newsletter_section(tip, body, link, nkind, b):
    steps = steps_from(body)
    paras = body.split('\n\n')
    ex = re.findall(r'"([^"]{20,220})"', body)
    parts = [paras[0], '\n'.join(f'{i + 1}. {s}' for i, s in enumerate(steps[:4]))]
    if ex: parts.append(f'Words you can use: "{ex[0]}"')
    if nkind == 'free-look':
        parts.append(f"P.S. Want me to look at your own Google profile, reviews and old quotes? It's free and there's no call: {link}")
    else:
        parts.append(f"P.S. Every tip we've written is on the website: {link}")
    return '\n\n'.join(parts)


def video_script(b, tip, body, kind):
    if tip.get('video'): return tip['video']
    steps = steps_from(body)
    pts = tip.get('points') or steps[:3]
    ex = re.findall(r'"([^"]{20,140})"', body)
    smalls = [s if len(s) <= 70 else s[:67].rsplit(' ', 1)[0] + '...' for s in steps[:3]]
    if b['id'] == 'booked-out':
        c = {"line1": "Get one free tip like this every week", "line2": "The Booked Out Brief", "url": "getbookedoutsolutions.com/newsletter"}
    else:
        cc = b['cta'][kind]
        c = {"line1": cc['line'].rstrip(':'), "line2": b['name'], "url": cc['url'].replace('https://', '')}
    return {'tipno': tip['n'] if b['id'] == 'booked-out' else None, 'kicker': tip.get('kicker', ''), 'hook': tip['headline'],
            'problem': first_sentence(body.split('\n\n')[1] if '\n\n' in body else body),
            'steps': [{'big': p, 'small': smalls[i] if i < len(smalls) and smalls[i].lower() != p.lower() else ''} for i, p in enumerate(pts[:3])],
            'example': ex[0] if ex else '', 'cta': c}


def run(bid, tips, ns=None, cards_on=False, video_on=False, outdir=None):
    outdir = outdir or os.path.join(HERE, 'out')
    b = brand(bid)
    schedule, waiting, report = [], [], []
    for tip in tips:
        if ns and tip['n'] not in ns: continue
        tdir = os.path.join(outdir, bid, f"tip-{int(tip['n']):02d}")
        os.makedirs(tdir, exist_ok=True)
        pieces = build_pieces(bid, tip)
        if cards_on:
            import cards
            want = sorted({p['card'] for p in pieces if p.get('card')})
            data = {'kicker': tip.get('kicker', ''), 'headline': tip['headline'], 'points': tip.get('points') or steps_from(tip['long'])[:3],
                    'tipno': tip['n'] if bid == 'booked-out' else None}
            data.update(tip.get('card_extra', {}))
            cards.render([(bid, f, data, os.path.join(tdir, f'{f}.jpg')) for f in want])
            for p in pieces:
                if p.get('card'): p['image'] = os.path.join(tdir, f"{p['card']}.jpg")
        if video_on:
            import video
            for p in pieces:
                if p['platform'] == 'video':
                    vp = os.path.join(tdir, 'video.mp4'); video.render(bid, p['script'], vp); p['video'] = vp
        results = []
        for p in pieces:
            if p['platform'] == 'video' and not p.get('video'):
                results.append({'ok': None, 'piece': p, 'errors': [], 'warnings': ['video not rendered this run']}); continue
            r = gate.check_and_fix(p)
            results.append(r)
            if r['ok'] and not r['waits_for']: schedule.append(r['piece'])
            elif r['ok']: waiting.append(r['piece'])
        json.dump([{'ok': r['ok'], 'errors': r['errors'], 'warnings': r['warnings'], **r['piece']} for r in results],
                  open(os.path.join(tdir, 'pieces.json'), 'w'), indent=1)
        report.append((tip['n'], [(r['piece']['platform'], r['ok'], r['errors']) for r in results]))
    golinks.write_redirects()   # the /go/ short links go live with the next bundled site deploy
    json.dump(schedule, open(os.path.join(outdir, bid, 'schedule.json'), 'w'), indent=1)
    json.dump(waiting, open(os.path.join(outdir, bid, 'waiting-for-page.json'), 'w'), indent=1)
    return report


if __name__ == '__main__':
    a = sys.argv[1:]
    bid, src = a[0], a[1]
    flags = {x for x in a if x.startswith('--')}
    outdir = a[a.index('--out') + 1] if '--out' in a else None
    ns = [int(x) for x in a[2:] if x.isdigit()]
    data = json.load(open(src))
    tips = data['posts'] if isinstance(data, dict) else data
    for n, rows in run(bid, tips, ns or None, '--cards' in flags, '--video' in flags, outdir):
        bad = [f'{p}: {"; ".join(e)}' for p, ok, e in rows if ok is False]
        print(f'tip {n}: {sum(1 for _, ok, _ in rows if ok)} passed, {len(bad)} held' + (' :: ' + ' | '.join(bad) if bad else ''))
