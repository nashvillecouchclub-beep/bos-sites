"""BRAND TEMPLATE STUDIO - picture cards.

  python3 content-system/studio/cards.py <brand> <format> <data.json> <out.jpg>
  formats: feed 1080x1350 | square 1080x1080 | pin 1000x1500 | google 1200x900 | linkedin 1200x627 | og 1200x630

data: {"kicker": "...", "headline": "...", "points": ["...", "...", "..."], "tipno": 7, "footer": "domain or short line"}
Writes the .jpg and a .meta.json next to it (fonts used and loaded, smallest text size, colour pairs, overflow)
that the quality gate reads. Headline auto-shrinks to fit; if it still cannot fit, overflow=true and the gate holds it.
"""
import json, os, sys, html, re, asyncio
HERE = os.path.dirname(os.path.abspath(__file__))
CS = os.path.dirname(HERE)
ROOT = os.path.dirname(CS)
FORMATS = {'feed': (1080, 1350), 'square': (1080, 1080), 'pin': (1000, 1500), 'google': (1200, 900),
           'linkedin': (1200, 627), 'og': (1200, 630)}


def brand(bid):
    return json.load(open(os.path.join(CS, 'brands', f'{bid}.json')))


def _font_faces(b):
    out = []
    for key, f in b['fonts'].items():
        url = 'file://' + os.path.join(ROOT, f['file'])
        out.append(f"@font-face{{font-family:'{f['family']}';src:url('{url}');font-style:{f.get('style', 'normal')};"
                   f"font-weight:{f.get('weight', 400 if 'body' in key else 500 if 'display' in key else 400)}}}")
    return '\n'.join(out)


def _q(s):
    s = re.sub(r'"([^"]*)"', lambda m: '“' + m.group(1) + '”', s).replace("'", '’')
    return html.escape(s, quote=False)


# ---------------------------------------------------------------- Booked Out (navy + gold)
BO_CSS = """
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#070B1E}
.card{position:relative;width:100%;height:100%;overflow:hidden;color:#ECEFFB;font-family:'Instrument Sans',sans-serif;
 background:linear-gradient(160deg,#0E1536 0%,#0A0F26 45%,#060918 100%);padding:var(--pad);display:flex;flex-direction:column}
.glow{position:absolute;border-radius:50%;filter:blur(90px)}
.g1{width:62%;aspect-ratio:1;right:-20%;top:-16%;background:radial-gradient(circle,#FFB224 0%,rgba(255,178,36,0) 70%);opacity:.28}
.g2{width:70%;aspect-ratio:1;left:-28%;bottom:-26%;background:radial-gradient(circle,#3552D8 0%,rgba(53,82,216,0) 70%);opacity:.45}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:54px 54px;-webkit-mask-image:radial-gradient(ellipse at 70% 20%,#000 0%,transparent 70%)}
.mark{position:absolute;right:-5%;top:9%;width:48%;z-index:1;opacity:.07}
.mark path{fill:none;stroke:#FFB224;stroke-width:3.2;stroke-linecap:round;stroke-linejoin:round}
header,.mid,footer{position:relative;z-index:2}
header{display:flex;align-items:center;gap:18px}
.logo svg{width:var(--logo);height:var(--logo);display:block}
.name{font-family:'Bricolage Grotesque';font-weight:700;font-size:var(--name);letter-spacing:-.3px;color:#fff}
.tipno{margin-left:auto;font-family:'Bricolage Grotesque';font-weight:700;font-size:var(--small);color:#FFB224;letter-spacing:2px;border:2px solid rgba(255,178,36,.45);padding:8px 18px;border-radius:999px}
.mid{flex:1;display:flex;flex-direction:column;justify-content:center;padding:28px 0 16px;min-height:0}
.kicker{align-self:flex-start;display:inline-flex;align-items:center;gap:14px;font-weight:700;font-size:var(--small);letter-spacing:4px;color:#FFB224}
.dot{width:12px;height:12px;border-radius:50%;background:#FFB224;box-shadow:0 0 18px #FFB224}
.kicker:after{content:"";display:block;width:90px;height:2px;background:linear-gradient(90deg,#FFB224,transparent);margin-left:6px}
h1{margin-top:22px;font-family:'Bricolage Grotesque';font-weight:800;font-size:var(--h);line-height:1.03;letter-spacing:-2px;color:#fff}
.steps{list-style:none;margin-top:var(--gap);background:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.12);border-radius:28px;padding:30px 36px;display:flex;flex-direction:column;gap:20px;box-shadow:0 30px 60px rgba(0,0,0,.35),inset 0 1px 0 rgba(255,255,255,.08)}
.steps li{display:flex;align-items:center;gap:22px;font-size:var(--pt);font-weight:600;line-height:1.2;color:#ECEFFB}
.num{flex:none;width:calc(var(--pt)*1.55);height:calc(var(--pt)*1.55);border-radius:50%;background:#FFB224;color:#0A0F26;font-family:'Bricolage Grotesque';font-weight:800;font-size:max(var(--minf),calc(var(--pt)*.8));display:flex;align-items:center;justify-content:center}
footer{margin-top:auto;display:flex;align-items:center;justify-content:space-between;font-size:var(--small);color:#A9B2D6}
.save{display:flex;align-items:center;gap:10px}.save svg{width:26px;height:26px;color:#FFB224}
.url{font-weight:600;color:#ECEFFB}
/* wide formats: steps beside the headline */
body.wide .mid{flex-direction:row;align-items:center;gap:48px}
body.wide .left{flex:1.15}
body.wide .steps{flex:1;margin-top:0}
"""
BO_VARS = {'feed': '--minf:26px;--pad:84px 84px 72px;--logo:62px;--name:32px;--small:26px;--h:92px;--pt:33px;--gap:56px;--maxh:420',
           'square': '--minf:26px;--pad:72px;--logo:56px;--name:30px;--small:26px;--h:84px;--pt:30px;--gap:40px;--maxh:330',
           'pin': '--minf:26px;--pad:80px 76px 70px;--logo:62px;--name:32px;--small:26px;--h:96px;--pt:34px;--gap:60px;--maxh:540',
           'google': '--minf:30px;--pad:64px 72px 56px;--logo:56px;--name:32px;--small:30px;--h:76px;--pt:32px;--gap:34px;--maxh:330',
           'linkedin': '--minf:30px;--pad:42px 56px 34px;--logo:46px;--name:30px;--small:30px;--h:64px;--pt:30px;--gap:20px;--maxh:330',
           'og': '--minf:30px;--pad:42px 56px 34px;--logo:46px;--name:30px;--small:30px;--h:64px;--pt:30px;--gap:20px;--maxh:330'}


def bo_html(b, fmt, d):
    logo = open(os.path.join(ROOT, b['logo_svg'])).read()
    pts = ''.join(f'<li><span class="num">{i + 1}</span><span>{_q(t)}</span></li>' for i, t in enumerate(d.get('points', [])[:3]))
    wide = fmt in ('linkedin', 'og')
    tip = f'<div class="tipno">TIP {int(d["tipno"]):02d}</div>' if d.get('tipno') else ''
    mid = (f'<div class="left"><div class="kicker"><span class="dot"></span>{html.escape(d.get("kicker", "FREE TIP"))}</div>'
           f'<h1>{_q(d["headline"])}</h1></div>')
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{_font_faces(b)}{BO_CSS}
:root{{{BO_VARS[fmt]}}}</style></head><body class="{'wide' if wide else ''}"><div class="card">
<div class="glow g1"></div><div class="glow g2"></div><div class="grid"></div>
<svg class="mark" viewBox="0 0 34 34"><path d="M6 18l8 8 16-17"/></svg>
<header><div class="logo">{logo}</div><div class="name">{html.escape(b['name'])}</div>{tip}</header>
<main class="mid">{mid}<ol class="steps">{pts}</ol></main>
<footer><div class="save"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>Save this for later</div>
<div class="url">{html.escape(d.get('footer', b['domain']))}</div></footer></div></body></html>"""


BO_PAIRS = [{'fg': '#FFFFFF', 'bg': '#0E1536', 'large': True}, {'fg': '#ECEFFB', 'bg': '#1B2140'},
            {'fg': '#FFB224', 'bg': '#0A0F26'}, {'fg': '#A9B2D6', 'bg': '#070B1E'}, {'fg': '#0A0F26', 'bg': '#FFB224'}]

# ---------------------------------------------------------------- Stones River (paper, river and stones, coneflower)
SR_CSS = """
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%}
.card{position:relative;width:100%;height:100%;overflow:hidden;background:#EEE9E3;color:#2C2622;font-family:'Jost',sans-serif;padding:var(--pad);display:flex;flex-direction:column}
.photo{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.22;filter:saturate(.7) sepia(.15)}
.wash{position:absolute;inset:0;background:radial-gradient(ellipse at 20% 0%,rgba(247,244,240,.9),rgba(238,233,227,.55) 60%,rgba(227,218,208,.85))}
.river{position:absolute;left:0;right:0;bottom:0;width:100%;height:38%;opacity:.9}
.frame{position:absolute;inset:26px;border:1.5px solid rgba(134,102,95,.35);border-radius:4px;pointer-events:none}
header,.mid,footer{position:relative;z-index:2}
header{display:flex;align-items:center;gap:16px}
.flower{width:var(--logo);height:calc(var(--logo)*2)}
.flower svg{width:100%;height:100%}
.name{font-family:'Cormorant Garamond';font-weight:500;font-size:var(--name);letter-spacing:.5px;color:#3A322C}
.mid{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0;padding:10px 0}
.kicker{font-size:var(--small);letter-spacing:5px;text-transform:uppercase;color:#5B4F46;font-weight:400}
.kicker:before{content:"";display:inline-block;width:46px;height:1.5px;background:#86665F;vertical-align:middle;margin-right:16px}
h1{margin-top:18px;font-family:'Cormorant Garamond';font-weight:500;font-size:var(--h);line-height:1.04;color:#2C2622;letter-spacing:-.5px}
h1 em{font-style:italic;color:#5E4740}
.steps{list-style:none;margin-top:var(--gap);display:flex;flex-direction:column;gap:18px;max-width:92%}
.steps li{display:flex;gap:20px;align-items:center;font-size:var(--pt);line-height:1.3;color:#2C2622;font-weight:400}
.stone{flex:none;width:calc(var(--pt)*1.3);height:calc(var(--pt)*.95);border-radius:50%/55%;background:#6E7865;color:#FBF8F5;font-size:max(var(--minf),calc(var(--pt)*.8));font-weight:500;display:flex;align-items:center;justify-content:center;}
.steps li:nth-child(2) .stone{background:#86665F}.steps li:nth-child(3) .stone{background:#5B4F46}
footer{display:flex;justify-content:space-between;align-items:flex-end;font-size:var(--small);color:#3A322C}
.save{font-family:'Cormorant Garamond';font-style:italic;font-size:calc(var(--small)*1.25);color:#5E4740}
body.wide .mid{flex-direction:row;align-items:center;gap:44px}
body.wide .left{flex:1.1}body.wide .steps{flex:1;margin-top:0}
"""
SR_VARS = {'feed': '--minf:26px;--pad:96px 92px 84px;--logo:44px;--name:40px;--small:27px;--h:96px;--pt:34px;--gap:54px;--maxh:460',
           'square': '--minf:26px;--pad:84px;--logo:40px;--name:36px;--small:26px;--h:84px;--pt:31px;--gap:40px;--maxh:340',
           'pin': '--minf:26px;--pad:96px 88px 84px;--logo:44px;--name:40px;--small:24px;--h:100px;--pt:35px;--gap:60px;--maxh:560',
           'google': '--minf:30px;--pad:72px 80px 64px;--logo:40px;--name:36px;--small:30px;--h:76px;--pt:32px;--gap:32px;--maxh:320',
           'linkedin': '--minf:30px;--pad:44px 60px 36px;--logo:30px;--name:32px;--small:30px;--h:66px;--pt:30px;--gap:18px;--maxh:320',
           'og': '--minf:30px;--pad:44px 60px 36px;--logo:30px;--name:32px;--small:30px;--h:66px;--pt:30px;--gap:18px;--maxh:320'}
RIVER_SVG = """<svg class="river" viewBox="0 0 1200 400" preserveAspectRatio="none"><defs>
<linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9AA58E" stop-opacity=".0"/><stop offset="1" stop-color="#9AA58E" stop-opacity=".30"/></linearGradient></defs>
<path d="M0 250 C 220 180, 380 320, 620 250 S 1000 170, 1200 230 L1200 400 L0 400Z" fill="url(#w)"/>
<path d="M0 300 C 240 240, 420 360, 660 300 S 1020 230, 1200 285" fill="none" stroke="#6E7865" stroke-opacity=".35" stroke-width="2"/>
<path d="M0 330 C 260 280, 460 380, 700 330 S 1040 270, 1200 320" fill="none" stroke="#86665F" stroke-opacity=".25" stroke-width="1.5"/>
<g fill="#9C8C7D" fill-opacity=".55"><ellipse cx="930" cy="368" rx="64" ry="24"/><ellipse cx="1010" cy="352" rx="38" ry="16" fill="#86665F" fill-opacity=".45"/><ellipse cx="868" cy="384" rx="30" ry="11" fill="#5B4F46" fill-opacity=".35"/><ellipse cx="160" cy="380" rx="44" ry="15"/></g></svg>"""
SR_PAIRS = [{'fg': '#2C2622', 'bg': '#EEE9E3', 'large': True}, {'fg': '#2C2622', 'bg': '#E3DAD0'}, {'fg': '#5B4F46', 'bg': '#EEE9E3'},
            {'fg': '#3A322C', 'bg': '#E3DAD0'}, {'fg': '#FBF8F5', 'bg': '#6E7865', 'large': True}, {'fg': '#5E4740', 'bg': '#EEE9E3'}]


def sr_html(b, fmt, d):
    flower = open(os.path.join(ROOT, b['logo_svg'])).read()
    flower = re.sub(r'<metadata>.*?</metadata>', '', flower, flags=re.S)
    photo = d.get('photo', 'srt-leaf-shadow-beige.jpg')
    photo_url = 'file://' + os.path.join(ROOT, b['site_dir'], 'img', photo)
    pts = ''.join(f'<li><span class="stone">{i + 1}</span><span>{_q(t)}</span></li>' for i, t in enumerate(d.get('points', [])[:3]))
    head = _q(d['headline'])
    if d.get('emphasis'): head = head.replace(_q(d['emphasis']), f'<em>{_q(d["emphasis"])}</em>', 1)
    wide = fmt in ('linkedin', 'og')
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{_font_faces(b)}{SR_CSS}
:root{{{SR_VARS[fmt]}}}</style></head><body class="{'wide' if wide else ''}"><div class="card">
<div class="photo" style="background-image:url('{photo_url}')"></div><div class="wash"></div>{RIVER_SVG}<div class="frame"></div>
<header><div class="flower">{flower}</div><div class="name">{html.escape(b['name'])}</div></header>
<main class="mid"><div class="left"><div class="kicker">{html.escape(d.get('kicker', 'A gentle note'))}</div><h1>{head}</h1></div>
<ol class="steps">{pts}</ol></main>
<footer><div class="save">{html.escape(d.get('save', 'Save this for a hard day'))}</div><div>{html.escape(d.get('footer', b['domain']))}</div></footer>
</div></body></html>"""


TEMPLATES = {'booked-out': (bo_html, BO_PAIRS), 'stones-river': (sr_html, SR_PAIRS)}

MEASURE_JS = """(maxh)=>{const h=document.querySelector('h1');let s=parseFloat(getComputedStyle(h).fontSize);
while(h.scrollHeight>maxh&&s>36){s-=2;h.style.fontSize=s+'px'}
const mid=document.querySelector('.mid');let p=document.querySelector('.steps');
let ps=p?parseFloat(getComputedStyle(p.querySelector('li')||p).fontSize):0;
const floor=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--minf'))||22;
while(mid.scrollHeight>mid.clientHeight+2&&ps>floor){ps-=1;p.style.setProperty('--pt',ps+'px');p.querySelectorAll('li').forEach(l=>l.style.fontSize=ps+'px')}
let min=999;document.querySelectorAll('body *').forEach(e=>{if(e.children.length===0&&e.textContent.trim()&&getComputedStyle(e).display!=='none'){min=Math.min(min,parseFloat(getComputedStyle(e).fontSize))}});
const fams=new Set();document.querySelectorAll('body *').forEach(e=>{if(e.textContent.trim())fams.add(getComputedStyle(e).fontFamily.split(',')[0].replace(/["']/g,'').trim())});
const card=document.querySelector('.card');
const fb=document.querySelector('footer').getBoundingClientRect().bottom, cb=card.getBoundingClientRect().bottom;
return {min, hpx:parseFloat(getComputedStyle(h).fontSize), fams:[...fams].filter(f=>f!=='sans-serif'), overflow: h.scrollHeight>maxh+4 || mid.scrollHeight>mid.clientHeight+4 || fb>cb+1}}"""


async def _render_many(jobs):
    from playwright.async_api import async_playwright
    from PIL import Image
    out = []
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        for bid, fmt, d, path in jobs:
            b = brand(bid)
            w, h = FORMATS[fmt]
            fn, pairs = TEMPLATES[bid]
            pg = await br.new_page(viewport={'width': w, 'height': h})
            tmp = os.path.join(HERE, '_tmp_card.html')
            open(tmp, 'w').write(fn(b, fmt, d))
            await pg.goto('file://' + tmp)
            await pg.evaluate('document.fonts.ready')
            loaded = await pg.evaluate("""()=>{const fs=[...document.fonts];return fs.length>0&&fs.every(f=>f.status==='loaded'||f.status==='unloaded')&&fs.some(f=>f.status==='loaded')}""")
            maxh = int(re.search(r'--maxh:(\d+)', (BO_VARS if bid == 'booked-out' else SR_VARS)[fmt]).group(1))
            m = await pg.evaluate(MEASURE_JS, maxh)
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            png = path + '.png'
            await pg.screenshot(path=png)
            Image.open(png).convert('RGB').save(path, quality=90, optimize=True, progressive=True)
            os.remove(png)
            meta = {'brand': bid, 'format': fmt, 'w': w, 'h': h, 'fonts': m['fams'], 'fonts_loaded': bool(loaded),
                    'min_font_px': m['min'], 'headline_px': m['hpx'], 'text_pairs': pairs, 'overflow': m['overflow'], 'headline': d['headline']}
            json.dump(meta, open(re.sub(r'\.(jpg|png)$', '.meta.json', path), 'w'), indent=1)
            await pg.close()
            out.append((path, meta))
        await br.close()
    t = os.path.join(HERE, '_tmp_card.html')
    if os.path.exists(t): os.remove(t)
    return out


def render(jobs):
    """jobs: list of (brand_id, format, data, out_path)"""
    return asyncio.run(_render_many(jobs))


if __name__ == '__main__':
    bid, fmt, data, outp = sys.argv[1:5]
    for p, m in render([(bid, fmt, json.load(open(data)), outp)]):
        print(p, json.dumps(m))
