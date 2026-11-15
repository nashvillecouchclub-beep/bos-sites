"""Booked Out social picture cards (Nov 14 2026 design: navy and gold, Bricolage + Instrument).

Usage: python3 tools/make_social_cards.py [n ...]   (no numbers = all posts)
Reads content/booked-out/cards.json (n, kicker, headline, points) and writes
sites/getbookedoutsolutions.com/img/social/card-NN.jpg (1080x1350, Instagram/Facebook/X)
and pin-NN.jpg (1000x1500, Pinterest). Needs Playwright with Chromium and Pillow.
"""
import json, html, asyncio, sys, os
from PIL import Image
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT=os.path.join(ROOT,'sites/getbookedoutsolutions.com/img/social')
from playwright.async_api import async_playwright
P=json.load(open(os.path.join(ROOT,'content/booked-out/cards.json')))
LOGO=open(os.path.join(ROOT,'sites/getbookedoutsolutions.com/favicon.svg')).read()
CSS=open(os.path.join(ROOT,'tools/social_card.css')).read()
def page(p, kind):
    pts=''.join(f'<li><span class="num">{i+1}</span><span>{html.escape(t.replace(chr(39),chr(8217)),quote=False)}</span></li>' for i,t in enumerate(p['points']))
    import re as _r
    h=html.escape(_r.sub(r'"([^"]*)"',lambda m:'“'+m.group(1)+'”',p['headline']).replace("'",'’'),quote=False)
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{CSS}</style></head>
<body class="{kind}"><div class="card">
<div class="glow g1"></div><div class="glow g2"></div><div class="grid"></div><svg class="mark" viewBox="0 0 34 34"><path d="M6 18l8 8 16-17"/></svg>
<header><div class="logo">{LOGO}</div><div class="name">Booked Out Solutions</div><div class="tipno">TIP {p['n']:02d}</div></header>
<main class="mid"><div class="kicker"><span class="dot"></span>{html.escape(p['kicker'])}</div>
<h1>{h}</h1>
<ol class="steps">{pts}</ol></main>
<footer><div class="save"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>Save this for later</div><div class="url">getbookedoutsolutions.com</div></footer>
</div></body></html>'''
async def main(ns):
    async with async_playwright() as pw:
        b=await pw.chromium.launch()
        for kind,(w,hh) in {'feed':(1080,1350),'pin':(1000,1500)}.items():
            pg=await b.new_page(viewport={'width':w,'height':hh})
            for p in P:
                if ns and p['n'] not in ns: continue
                tmp=os.path.join(ROOT,'tools/_card_tmp.html'); open(tmp,'w').write(page(p,kind))
                await pg.goto('file://'+tmp); await pg.wait_for_timeout(120)
                # auto-fit headline
                await pg.evaluate("""()=>{const h=document.querySelector('h1');let s=parseFloat(getComputedStyle(h).fontSize);const max=parseFloat(getComputedStyle(h).getPropertyValue('--maxh'));while(h.scrollHeight>max&&s>40){s-=3;h.style.fontSize=s+'px'}}""")
                name=('card' if kind=='feed' else 'pin')+f"-{p['n']:02d}.png"
                png=os.path.join(OUT,'_tmp.png'); await pg.screenshot(path=png)
                Image.open(png).convert('RGB').save(os.path.join(OUT,name.replace('.png','.jpg')),quality=90,optimize=True,progressive=True); os.remove(png)
        await b.close()
    t=os.path.join(ROOT,'tools/_card_tmp.html')
    if os.path.exists(t): os.remove(t)
asyncio.run(main([int(x) for x in sys.argv[1:]]))
