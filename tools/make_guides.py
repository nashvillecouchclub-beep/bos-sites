"""Builds the client help guides from clients/guides.json.

One page per step only the client can do, at getbookedoutsolutions.com/help/<id>/ :
what you need, numbered steps, the narrated walkthrough video (help/<id>/walkthrough.mp4
when it exists), fixes for common problems, and what we do next. Plus /help/ index.
Run before make_manifest.py.
"""
import html, json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_start_pages import CSS, LOGO  # same look as the start pages

DATA = json.load(open(os.path.join(ROOT, 'clients', 'guides.json')))
SITE = os.path.join(ROOT, 'sites', 'getbookedoutsolutions.com')
E = html.escape

EXTRA = """
.crumb{margin:18px 0 0;font-size:16px}.crumb a{color:#FFB224}
video{width:100%;border-radius:14px;background:#000;margin:6px 0 24px}
ol.steps{padding:0;margin:0;list-style:none;counter-reset:s}
ol.steps li{background:#141A36;border:1px solid #262E55;border-radius:16px;padding:18px 18px 18px 64px;margin:0 0 14px;position:relative;counter-increment:s}
ol.steps li:before{content:counter(s);position:absolute;left:18px;top:18px;width:32px;height:32px;border-radius:50%;background:#FFB224;color:#0A0F26;font-weight:700;display:flex;align-items:center;justify-content:center}
ol.steps b{display:block;font:700 20px/1.3 "Bricolage Grotesque",sans-serif;margin-bottom:6px}
.box{background:#141A36;border-radius:16px;padding:18px;margin:0 0 22px}.box h2{margin:0 0 8px;font:700 21px "Bricolage Grotesque",sans-serif}
.box ul{margin:0;padding-left:20px}.box li{margin:4px 0}
h2.sec{font:700 24px "Bricolage Grotesque",sans-serif;margin:30px 0 12px}
.guides a{display:block;background:#141A36;border:1px solid #262E55;border-radius:14px;padding:16px;margin:0 0 12px;color:#F3F4F8;text-decoration:none;font-weight:600}
"""


def shell(title, body):
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>{E(title)} - Booked Out Solutions</title><link rel="icon" href="/favicon.svg"><style>{CSS}{EXTRA}</style></head>
<body><div class="wrap"><div class="brand">{LOGO}Booked Out Solutions</div>{body}
<p class="foot">Stuck? Email <a href="mailto:hello@getbookedoutsolutions.com">hello@getbookedoutsolutions.com</a> and we'll walk you through it.</p>
</div></body></html>"""


def guide_page(g):
    d = os.path.join(SITE, 'help', g['id'])
    has_video = os.path.exists(os.path.join(d, 'walkthrough.mp4'))
    video = (f'<video controls playsinline preload="metadata" poster="/help/{g["id"]}/poster.png">'
             f'<source src="/help/{g["id"]}/walkthrough.mp4" type="video/mp4"></video>') if has_video else ''
    before = ''.join(f'<li>{E(x)}</li>' for x in g['before'])
    steps = ''.join(f'<li><b>{E(s["title"])}</b>{E(s["text"])}</li>' for s in g['steps'])
    trouble = ''.join(f'<li>{E(x)}</li>' for x in g['trouble'])
    body = (f'<p class="crumb"><a href="/help/">All guides</a></p><h1>{E(g["title"])}</h1>'
            f'<p class="lead">{E(g["intro"])} {E(g["time"])}.</p>{video}'
            f'<div class="box"><h2>Have these ready</h2><ul>{before}</ul></div>'
            f'<h2 class="sec">Step by step</h2><ol class="steps">{steps}</ol>'
            f'<div class="box"><h2>If something doesn\'t look right</h2><ul>{trouble}</ul></div>'
            f'<div class="box"><h2>What happens next</h2><p style="margin:0">{E(g["after"])}</p></div>')
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'index.html'), 'w').write(shell(g['title'], body))


def index_page():
    links = ''.join(f'<a href="/help/{g["id"]}/">{E(g["title"])}</a>' for g in DATA['guides'])
    body = ('<h1>Setup guides</h1><p class="lead">Every step only you can do, with a short video and the exact taps.</p>'
            f'<div class="guides">{links}</div>')
    os.makedirs(os.path.join(SITE, 'help'), exist_ok=True)
    open(os.path.join(SITE, 'help', 'index.html'), 'w').write(shell('Setup guides', body))


if __name__ == '__main__':
    for g in DATA['guides']:
        guide_page(g)
        print('guide:', g['id'])
    index_page()
