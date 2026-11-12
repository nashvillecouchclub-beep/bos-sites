"""Builds each client's start page from clients/start.json.

One page per client at getbookedoutsolutions.com/start/<code>/ : only the taps
that client still has left (each with one button), anything we're waiting on,
and what's already done for them. Public-safe: no emails, phones or client data.
Run before make_manifest.py, then add a deploy job for getbookedoutsolutions.com.
"""
import html, json, os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
DATA = json.load(open(os.path.join(ROOT, 'clients', 'start.json')))
OUT = os.path.join(ROOT, 'sites', 'getbookedoutsolutions.com', 'start')
LIB = DATA['step_library']

LOGO = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34" width="34" height="34" aria-hidden="true">'
        '<rect x="1" y="4" width="32" height="29" rx="8" fill="#FFB224"/><rect x="8.5" y="0" width="4" height="9" rx="2" fill="#0A0F26"/>'
        '<rect x="21.5" y="0" width="4" height="9" rx="2" fill="#0A0F26"/><path d="M9.5 19.5l5 5 10-10.5" fill="none" stroke="#0A0F26" '
        'stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></svg>')

CSS = """
@font-face{font-family:"Bricolage Grotesque";src:url(/fonts/bricolage-grotesque.woff2) format("woff2");font-display:swap}
@font-face{font-family:"Instrument Sans";src:url(/fonts/instrument-sans.woff2) format("woff2");font-display:swap}
*{box-sizing:border-box}body{margin:0;background:#0A0F26;color:#F3F4F8;font:19px/1.55 "Instrument Sans",system-ui,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:28px 20px 60px}
.brand{display:flex;align-items:center;gap:12px;font:700 20px "Bricolage Grotesque",sans-serif}
h1{font:800 34px/1.15 "Bricolage Grotesque",sans-serif;margin:34px 0 10px}
.lead{color:#B8BFD6;margin:0 0 26px}
.step{background:#141A36;border:1px solid #262E55;border-radius:16px;padding:20px;margin:0 0 16px}
.step h2{font:700 22px/1.25 "Bricolage Grotesque",sans-serif;margin:0 0 8px;display:flex;gap:12px;align-items:baseline}
.num{flex:none;width:32px;height:32px;border-radius:50%;background:#FFB224;color:#0A0F26;display:inline-flex;align-items:center;justify-content:center;font-size:17px}
.step p{margin:0 0 14px;color:#D5D9E8}
.mins{font-size:15px;color:#8F97B5}
.btn{display:block;text-align:center;background:#FFB224;color:#0A0F26;font-weight:700;text-decoration:none;padding:16px;border-radius:12px;font-size:19px}
.waiting{opacity:.75}.waiting .num{background:#3A4370;color:#F3F4F8}
.donebox{margin-top:30px}.donebox h2{font:700 22px "Bricolage Grotesque",sans-serif;margin:0 0 10px}
.donebox li{list-style:none;padding:6px 0 6px 32px;position:relative}.donebox li:before{content:"\\2713";position:absolute;left:0;color:#FFB224;font-weight:700}
.donebox ul{padding:0;margin:0}
.foot{margin-top:36px;color:#8F97B5;font-size:16px}.foot a{color:#FFB224}
.gotit{border-color:#FFB224}.gotit .btn{display:none}
.all{background:#141A36;border:1px solid #FFB224;border-radius:16px;padding:22px;text-align:center;font-size:21px}
"""


def fill(text, step, client):
    out = text or ''
    for k, v in {**{'code': client['code']}, **step}.items():
        out = out.replace('{' + k + '}', str(v))
    return out


def page(c):
    todo = [s for s in c['steps'] if s['status'] == 'todo']
    waiting = [s for s in c['steps'] if s['status'] == 'waiting']
    mins = sum(LIB[s['id']].get('minutes', 0) for s in todo)
    parts = []
    n = 0
    for s in todo + waiting:
        n += 1
        lib = LIB[s['id']]
        title = s.get('title') or lib['title']
        why = s.get('why') or lib['why']
        btn = fill(s.get('button', lib.get('button', '')), s, c)
        link = fill(s.get('link', lib.get('link', '')), s, c)
        cls = 'step' + (' waiting' if s['status'] == 'waiting' else '')
        live = ' data-live-connect="1"' if s['id'] == 'connect' and s['status'] == 'todo' else ''
        body = f'<p>{html.escape(why)}</p>'
        if s['status'] == 'waiting':
            body += f'<p class="mins">Not yet. {html.escape(s.get("note", "We will tell you when it is time."))}</p>'
        else:
            body += f'<p class="mins">About {lib.get("minutes", 1)} minute{"s" if lib.get("minutes", 1) != 1 else ""}</p>'
            if btn and link and '{' not in link:
                body += f'<a class="btn" href="{html.escape(link)}">{html.escape(btn)}</a>'
        parts.append(f'<section class="{cls}"{live}><h2><span class="num">{n}</span>{html.escape(title)}</h2>{body}</section>')
    if not todo:
        parts.insert(0, '<div class="all">You\'re all set. There\'s nothing for you to do right now.</div>')
    lead = (f"Here's everything left on your side. About {mins} minutes in total. We do the rest."
            if todo else "We'll update this page if anything ever needs you.")
    done = ''.join(f'<li>{html.escape(d)}</li>' for d in c.get('done', []))
    first = html.escape(c.get('first_name') or 'there')
    return f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>Your setup - {html.escape(c['business'])} - Booked Out Solutions</title><link rel="icon" href="/favicon.svg"><style>{CSS}</style></head>
<body><div class="wrap"><div class="brand">{LOGO}Booked Out Solutions</div>
<h1>Hi {first}, here's your setup</h1><p class="lead">{html.escape(c['business'])}. {lead}</p>
{''.join(parts)}
<div class="donebox"><h2>Already done for you</h2><ul>{done}</ul></div>
<p class="foot">Stuck on anything? Email <a href="mailto:hello@getbookedoutsolutions.com">hello@getbookedoutsolutions.com</a> and we'll handle it.</p>
</div>
<script>
(function(){{var s=document.querySelector('[data-live-connect]');if(!s)return;
fetch('/connect/done?c={html.escape(c['code'])}',{{cache:'no-store'}}).then(function(r){{return r.json()}}).then(function(j){{
if(!j||!j.connected)return;s.className='step gotit';var p=s.querySelector('.mins');if(p)p.textContent='Done. Thank you, you are connected.';
var n=s.querySelector('.num');if(n)n.textContent='\u2713';}}).catch(function(){{}});}})();
</script></body></html>"""


for c in DATA['clients']:
    d = os.path.join(OUT, c['code'])
    os.makedirs(d, exist_ok=True)
    open(os.path.join(d, 'index.html'), 'w').write(page(c))
    print('start page:', c['code'])
