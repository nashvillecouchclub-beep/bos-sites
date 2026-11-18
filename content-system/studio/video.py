"""BRAND TEMPLATE STUDIO - short motion videos (9:16, 1080x1920, 30 fps), captions burned in, original music, brand motion.

  python3 content-system/studio/video.py <brand> <script.json> <out.mp4>

script.json (the content machine writes it):
 {"tipno": 7, "kicker": "PHONE CALLS", "hook": "A missed call is a missed job",
  "problem": "Most callers who hit voicemail don't leave a message.",
  "steps": [{"big": "Text back fast", "small": "Within 5 minutes, from a real name"}, ... 3 steps],
  "example": "Sorry we missed your call. This is Mike at Smith Heating. What's going on?",
  "cta": {"line1": "One free tip like this every week", "line2": "The Booked Out Brief", "url": "getbookedoutsolutions.com/newsletter"}}

No voice-over (Rickey rejected the free voices; paid voices need his OK), so every word is on screen: the words ARE the
captions, timed for reading (about 3 words a second plus 1.2 s). Nothing fake: no people, no made-up jobs or results.
Text stays inside the Reels/Shorts safe area (top 14% and bottom 22% kept clear of words).
"""
import json, os, sys, re, html, subprocess, asyncio, tempfile
HERE = os.path.dirname(os.path.abspath(__file__))
CS = os.path.dirname(HERE)
ROOT = os.path.dirname(CS)
sys.path.insert(0, HERE)
import music, cards

W, H, FPS = 1080, 1920, 30


def read_time(text, base=1.4, wps=3.0, lo=2.6, hi=6.5):
    return max(lo, min(hi, base + len(text.split()) / wps))


def timeline(s):
    beats, t = [], 0.0
    def add(kind, dur, **kw):
        nonlocal t
        beats.append(dict(kind=kind, t0=round(t, 2), t1=round(t + dur, 2), **kw)); t += dur
    add('hook', max(3.4, read_time(s['hook'], 1.8)), text=s['hook'], kicker=s.get('kicker', ''), gold=s.get('hook_gold', ''))
    if s.get('problem'): add('problem', s.get('problem_seconds') or read_time(s['problem']), text=s['problem'])
    for i, st in enumerate(s['steps'][:3]):
        add('step', read_time(st['big'] + ' ' + st.get('small', ''), 1.6), n=i + 1, big=st['big'], small=st.get('small', ''), send=bool(st.get('send')))
    if s.get('example'): add('example', read_time(s['example'], 1.8, 3.2), text=s['example'], label=s.get('example_label', 'TRY SAYING'))
    if s.get('mistake'): add('problem', read_time(s['mistake']), text=s['mistake'], label='The common mistake')
    add('cta', s.get('cta_seconds') or 5.3, **s['cta'])
    return beats, t


def q(x): return html.escape(re.sub(r'"([^"]*)"', '“\\1”', x).replace("'", '’'), quote=False)


THEMES = {
 'booked-out': dict(mood='drive', css="""
  body{background:#070B1E;color:#ECEFFB;font-family:'Instrument Sans'}
  .bg{background:linear-gradient(165deg,#111A44 0%,#0A0F26 50%,#05081A 100%)}
  .glowA{background:radial-gradient(circle,rgba(255,178,36,.42) 0%,rgba(255,178,36,0) 68%)}
  .glowB{background:radial-gradient(circle,rgba(53,82,216,.55) 0%,rgba(53,82,216,0) 68%)}
  .grid{background-image:linear-gradient(rgba(255,255,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.045) 1px,transparent 1px);background-size:72px 72px}
  .display{font-family:'Bricolage Grotesque';font-weight:800;letter-spacing:-2px;color:#fff}
  .accent{color:#FFB224}.accentbg{background:#FFB224;color:#0A0F26}
  .panel{background:linear-gradient(180deg,rgba(255,255,255,.09),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.14);box-shadow:0 40px 80px rgba(0,0,0,.4)}
  .muted{color:#A9B2D6}.bar{background:#FFB224}"""),
 'stones-river': dict(mood='calm', css="""
  body{background:#EEE9E3;color:#2C2622;font-family:'Jost'}
  .bg{background:linear-gradient(170deg,#F7F4F0 0%,#EEE9E3 55%,#E3DAD0 100%)}
  .glowA{background:radial-gradient(circle,rgba(154,165,142,.45) 0%,rgba(154,165,142,0) 68%)}
  .glowB{background:radial-gradient(circle,rgba(180,143,135,.35) 0%,rgba(180,143,135,0) 68%)}
  .grid{display:none}
  .display{font-family:'Cormorant Garamond';font-weight:500;letter-spacing:-.5px;color:#2C2622}
  .accent{color:#5E4740}.accentbg{background:#6E7865;color:#FBF8F5}
  .panel{background:rgba(247,244,240,.75);border:1.5px solid rgba(134,102,95,.3)}
  .muted{color:#5B4F46}.bar{background:#86665F}"""),
}

BASE_CSS = """
*{margin:0;padding:0;box-sizing:border-box}html,body{width:1080px;height:1920px;overflow:hidden}
.layer{position:absolute;inset:0}.glow{position:absolute;border-radius:50%;filter:blur(40px)}
.glowA{width:1100px;height:1100px}.glowB{width:1300px;height:1300px}
.beat{position:absolute;left:90px;right:90px;top:390px;bottom:430px;display:flex;flex-direction:column;justify-content:center;opacity:0}
.brand{position:absolute;top:276px;left:90px;right:90px;display:flex;align-items:center;gap:18px;font-size:34px;font-weight:600}
.brand svg{width:64px;height:64px}.brand .tip{margin-left:auto;font-size:30px;letter-spacing:3px;border:2px solid currentColor;padding:8px 20px;border-radius:999px;opacity:.9}
.kicker{font-size:36px;letter-spacing:6px;font-weight:700;margin-bottom:30px}
.hook{font-size:132px;line-height:1.02}.hook .w{display:inline-block;margin-right:.22em}
.problem{font-size:76px;line-height:1.12}
.label{font-size:34px;letter-spacing:5px;font-weight:700;margin-bottom:26px;text-transform:uppercase}
.stepnum{width:150px;height:150px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:84px;font-weight:800;margin-bottom:44px}
.stepbig{font-size:104px;line-height:1.04}.stepsmall{font-size:50px;line-height:1.25;margin-top:34px}
.example{border-radius:36px;padding:60px 56px;font-size:62px;line-height:1.3;font-weight:600;color:#fff}
.example .say{font-size:32px;letter-spacing:5px;font-weight:700;margin-bottom:24px;display:block}
.sendline{font-size:58px;line-height:1.24;margin-top:34px;padding:34px 38px;border-radius:28px;font-weight:600;color:#fff}
.sendline .say{display:block;font-size:30px;letter-spacing:5px;font-weight:700;margin-bottom:14px}
.cta{align-items:flex-start;text-align:left;right:210px;bottom:520px}.cta svg{width:130px;height:130px;margin-bottom:34px}
.cta .l1{font-size:56px;line-height:1.15}.cta .l2{font-size:92px;line-height:1.05;margin:22px 0 34px}
.cta .url{font-size:42px;line-height:1.2;font-weight:700;padding:24px 36px;border-radius:30px}.cta .url span{display:block}
.wipe{position:absolute;left:0;right:0;top:0;height:100%;transform:translateY(100%);z-index:5}
.progress{position:absolute;left:90px;right:90px;top:356px;height:6px;border-radius:3px;background:rgba(127,127,127,.25);overflow:hidden}
.progress i{display:block;height:100%;width:0}
.sweep{position:absolute;top:-20%;width:300px;height:140%;background:linear-gradient(90deg,transparent,rgba(255,255,255,.10),transparent);transform:rotate(18deg)}
.river{position:absolute;left:-100px;width:1280px;bottom:0;height:520px}
"""

JS = r"""
const B = window.BEATS, T = window.TOTAL;
const ease = x => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
function render(t){
  document.querySelector('.glowA').style.transform = `translate(${520 + 140*Math.sin(t*0.35)}px, ${-200 + 90*Math.cos(t*0.27)}px)`;
  document.querySelector('.glowB').style.transform = `translate(${-520 + 120*Math.cos(t*0.22)}px, ${1100 + 100*Math.sin(t*0.31)}px)`;
  const g = document.querySelector('.grid'); if (g) g.style.backgroundPosition = `${-t*6}px ${-t*10}px`;
  const r = document.querySelector('.river'); if (r) r.style.transform = `translateX(${-60 + 40*Math.sin(t*0.4)}px)`;
  document.querySelector('.progress i').style.width = (100*t/T) + '%';
  const sw = document.querySelector('.sweep'); sw.style.left = (((t % 7) / 7) * 1800 - 500) + 'px';
  // a quick brand-color wipe marks every change of screen
  const wp = document.querySelector('.wipe'); let wy = 100;
  B.forEach((b, i) => { if (i) { const d = (t - b.t0 + 0.2) / 0.4; if (d >= 0 && d <= 1) wy = 100 - 200 * d; } });
  wp.style.transform = `translateY(${wy}%)`;
  B.forEach((b, i) => {
    const el = document.getElementById('b' + i);
    const inP = ease((t - b.t0) / 0.55), outP = ease((t - (b.t1 - 0.4)) / 0.4);
    const last = i === B.length - 1;
    let op = (t < b.t0 || t > b.t1 + (last ? 99 : 0)) ? 0 : inP * (last ? 1 : 1 - outP);
    el.style.opacity = op;
    el.style.transform = `translateY(${(1 - inP) * 70 - (last ? 0 : outP * 60)}px)`;
    el.style.filter = `blur(${(1 - inP) * 10}px)`;
    el.querySelectorAll('.w').forEach((w, k) => { const p = ease((t - b.t0 - 0.12*k) / 0.45);
      w.style.opacity = p; w.style.transform = `translateY(${(1-p)*50}px)`; });
    const n = el.querySelector('.stepnum'); if (n) { const p = ease((t - b.t0) / 0.35); n.style.transform = `scale(${0.4 + 0.6*p + 0.08*Math.sin(Math.min(1,(t-b.t0)/0.5)*Math.PI)})`; }
    const sm = el.querySelector('.stepsmall'); if (sm) { const p = ease((t - b.t0 - 0.5) / 0.5); sm.style.opacity = p; }
  });
}
window.render = render;
"""


def build_html(bid, s, beats, total):
    b = cards.brand(bid)
    th = THEMES[bid]
    logo = open(os.path.join(ROOT, b['logo_svg'])).read()
    logo = re.sub(r'<metadata>.*?</metadata>', '', logo, flags=re.S)
    els = []
    for i, bt in enumerate(beats):
        k = bt['kind']
        if k == 'hook':
            all_w, gold_w = bt['text'].split(), bt.get('gold', '').split()
            first_gold = len(all_w) - len(gold_w) if gold_w and all_w[-len(gold_w):] == gold_w else len(all_w)
            words = ''.join(f'<span class="w{" accent" if k >= first_gold else ""}">{q(w)}</span>' for k, w in enumerate(all_w))
            inner = f'<div class="kicker accent">{q(bt["kicker"])}</div><div class="display hook">{words}</div>'
        elif k == 'problem':
            lab = f'<div class="label accent">{q(bt["label"])}</div>' if bt.get('label') else ''
            inner = f'{lab}<div class="display problem">{q(bt["text"])}</div>'
        elif k == 'step':
            small = (f'<div class="stepsmall sendline panel"><span class="say accent">SEND THIS</span>“{q(bt["small"])}”</div>' if bt.get('send')
                     else f'<div class="stepsmall muted">{q(bt["small"]).replace(chr(10), "<br>")}</div>')
            inner = f'<div class="stepnum accentbg display">{bt["n"]}</div><div class="display stepbig">{q(bt["big"])}</div>{small}'
        elif k == 'example':
            inner = f'<div class="example panel"><span class="say accent">{q(bt.get("label", "TRY SAYING"))}</span>“{q(bt["text"])}”</div>'
        else:
            host, _, path = bt['url'].partition('/')
            url = f'<span>{q(bt["show"])}</span>' if bt.get('show') else f'<span>{q(host)}</span>' + (f'<span>/{q(path)}</span>' if path else '')
            inner = (f'{logo}<div class="l1 muted">{q(bt["line1"])}</div><div class="display l2">{q(bt["line2"])}</div>'
                     f'<div class="url accentbg">{url}</div>')
        els.append(f'<div class="beat {"cta" if k == "cta" else ""}" id="b{i}">{inner}</div>')
    tip = f'<span class="tip accent">TIP {int(s["tipno"]):02d}</span>' if s.get('tipno') else ''
    river = cards.RIVER_SVG.replace('class="river"', 'class="river"') if bid == 'stones-river' else ''
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{cards._font_faces(b)}{BASE_CSS}{th['css']}</style></head>
<body><div class="layer bg"></div><div class="glow glowA"></div><div class="glow glowB"></div><div class="layer grid"></div>{river}
<div class="sweep"></div><div class="wipe accentbg"></div>
<div class="brand">{logo}<span>{html.escape(b['name'])}</span>{tip}</div><div class="progress"><i class="bar"></i></div>
{''.join(els)}
<script>window.BEATS={json.dumps(beats)};window.TOTAL={total};{JS}</script></body></html>"""


async def _frames(htmlpath, total, ff):
    from playwright.async_api import async_playwright
    async with async_playwright() as pw:
        br = await pw.chromium.launch()
        pg = await br.new_page(viewport={'width': W, 'height': H})
        await pg.goto('file://' + htmlpath)
        await pg.evaluate('document.fonts.ready')
        loaded = await pg.evaluate("[...document.fonts].some(f=>f.status==='loaded')")
        n = int(round(total * FPS))
        for i in range(n):
            await pg.evaluate(f'render({i / FPS})')
            ff.stdin.write(await pg.screenshot(type='jpeg', quality=92))
        await br.close()
        return loaded, n


def render(bid, s, out):
    beats, total = timeline(s)
    total = round(total, 2)
    work = tempfile.mkdtemp(prefix='vid_')
    hp = os.path.join(work, 'v.html'); open(hp, 'w').write(build_html(bid, s, beats, total))
    wav = os.path.join(work, 'm.wav'); music.write(wav, total + 0.2, THEMES[bid]['mood'], seed=int(s.get('tipno') or 1))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', str(FPS), '-c:v', 'mjpeg', '-i', '-',
                           '-i', wav, '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p',
                           '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out], stdin=subprocess.PIPE)
    loaded, n = asyncio.run(_frames(hp, total, ff))
    ff.stdin.close(); ff.wait()
    # poster frame for the approval page and thumbnails
    poster = out.replace('.mp4', '.jpg')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', str(beats[0]['t1'] - 0.6), '-i', out, '-frames:v', '1', '-q:v', '3', poster])
    meta = {'brand': bid, 'seconds': total, 'frames': n, 'fps': FPS, 'w': W, 'h': H, 'fonts_loaded': loaded,
            'captions_burned': True, 'captions_note': 'no voice-over; every word is on screen, timed for reading',
            'ends_with_cta': beats[-1]['kind'] == 'cta', 'cta_url': s['cta']['url'], 'music': f"original, made in code ({THEMES[bid]['mood']})",
            'shows_person_as_real': False, 'ai_person': False, 'target_seconds': [20, 40], 'beats': beats}
    json.dump(meta, open(out.replace('.mp4', '.meta.json'), 'w'), indent=1)
    return out, meta


if __name__ == '__main__':
    o, m = render(sys.argv[1], json.load(open(sys.argv[2])), sys.argv[3])
    print(o, m['seconds'], 's')
