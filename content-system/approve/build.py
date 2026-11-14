"""ONE-TAP APPROVAL PAGE - a private page per client per week: picture cards, Approve / Request a change, a note box.

  python3 content-system/approve/build.py <batch.json> [--token TOKEN]

Writes sites/<agency site>/approve/<token>/index.html + batch.json + img/ (the week's cards, copied in).
The page is noindex (meta tag + X-Robots-Tag header in _headers) and its address is a long random token,
so only the person we send it to can find it. It never shows our back-end tools.

Answers are saved three ways, so nothing is lost:
  1. every tap is saved in the browser (the client can stop and come back on the same device);
  2. every tap is sent to our approvals API  /approve-api/<token>  (Cloudflare worker, content-system/worker/approvals-worker.js,
     proxied through our own domain in _redirects), which stores it and lets the posting task read what is approved;
  3. if the API cannot be reached, "Send my answers" falls back to the client's email app with a tidy summary
     addressed to hello@getbookedoutsolutions.com (the method already tested on Nov 14).
Only APPROVED pieces are ever scheduled (content-system/approve/sync.py pulls the answers).

batch.json:
 {"batch_id": "stones-river-2026-11-w47", "brand": "stones-river", "title": "Your posts for the week of Nov 16",
  "intro": "...", "person": "Jamie", "due": "2026-11-15",
  "items": [{"id": "facebook-01", "platform": "facebook", "date": "2026-11-17", "title": "...", "image": "path/to/card.jpg",
             "video": "optional.mp4", "text": "the full post text", "audience": "optional (LinkedIn)", "button": "optional (Google)"}]}
"""
import json, os, sys, html, shutil, secrets, re
HERE = os.path.dirname(os.path.abspath(__file__))
CS = os.path.dirname(HERE)
ROOT = os.path.dirname(CS)
AGENCY_SITE = os.path.join(ROOT, 'sites', 'getbookedoutsolutions.com')
PLATFORM_NAMES = {'facebook': 'Facebook', 'instagram': 'Instagram', 'x': 'X', 'pinterest': 'Pinterest', 'google': 'Google profile',
                  'linkedin': 'LinkedIn', 'newsletter': 'Newsletter', 'article': 'Website article', 'video': 'Video'}

THEME = {
 'stones-river': {'bg': '#EEE9E3', 'raised': '#F7F4F0', 'surface': '#E3DAD0', 'ink': '#2C2622', 'muted': '#5B4F46', 'accent': '#86665F',
                  'accent_ink': '#FBF8F5', 'ok': '#5F6B57', 'display': "'Cormorant Garamond', Georgia, serif", 'body': "'Jost', system-ui, sans-serif",
                  'fonts': [('Cormorant Garamond', 'cg-500.woff2', 500), ('Jost', 'jost-400.woff2', 400), ('Jost', 'jost-500.woff2', 500)],
                  'font_src': 'sites/stonesrivertherapy.com/assets/fonts', 'logo': 'sites/stonesrivertherapy.com/logo/flower-only.svg'},
 'booked-out':   {'bg': '#F3F4F9', 'raised': '#FFFFFF', 'surface': '#E6E8F2', 'ink': '#131935', 'muted': '#535D7E', 'accent': '#0A0F26',
                  'accent_ink': '#FFB224', 'ok': '#1F7A4D', 'display': "'Bricolage Grotesque', system-ui, sans-serif", 'body': "'Instrument Sans', system-ui, sans-serif",
                  'fonts': [('Bricolage Grotesque', 'bricolage-grotesque.woff2', 700), ('Instrument Sans', 'instrument-sans.woff2', 400)],
                  'font_src': 'sites/getbookedoutsolutions.com/fonts', 'logo': 'sites/getbookedoutsolutions.com/favicon.svg'},
}

PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow,noarchive">
<title>__TITLE__</title><style>
__FONTS__
:root{--bg:__bg;--raised:__raised;--surface:__surface;--ink:__ink;--muted:__muted;--accent:__accent;--accent-ink:__accent_ink;--ok:__ok;
--display:__display;--body:__body}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font-family:var(--body);font-size:18px;line-height:1.55}
.wrap{max-width:860px;margin:0 auto;padding:0 18px 140px}
header.top{display:flex;align-items:center;gap:14px;padding:26px 0 8px}
header.top svg{width:38px;height:38px}
header.top .who{font-family:var(--display);font-size:26px}
h1{font-family:var(--display);font-weight:500;font-size:clamp(34px,6vw,52px);line-height:1.08;margin:18px 0 12px}
.lead{color:var(--muted);font-size:19px;max-width:640px}
.how{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:24px 0 8px}
.how div{background:var(--raised);border-radius:14px;padding:16px 18px;font-size:16px;color:var(--muted)}
.how b{display:block;color:var(--ink);font-size:17px;margin-bottom:2px}
.item{background:var(--raised);border-radius:20px;margin:26px 0;overflow:hidden;box-shadow:0 1px 0 rgba(0,0,0,.04),0 12px 30px rgba(44,38,34,.06)}
.item .meta{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;padding:18px 22px 0;font-size:15px;color:var(--muted)}
.chip{background:var(--surface);color:var(--ink);padding:4px 12px;border-radius:999px;font-weight:500}
.item h2{font-family:var(--display);font-weight:500;font-size:28px;line-height:1.15;padding:10px 22px 0}
.media{padding:16px 22px 0}.media img,.media video{width:100%;max-width:520px;display:block;border-radius:12px;background:var(--surface)}
.text{padding:16px 22px 4px;white-space:pre-wrap;font-size:17px}
.text.clamp{max-height:9.5em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 60%,transparent)}
.more{margin:0 22px;background:none;border:0;color:var(--accent);font:inherit;font-weight:500;text-decoration:underline;cursor:pointer;padding:6px 0}
.extra{padding:4px 22px 0;font-size:15px;color:var(--muted)}
.act{display:flex;flex-wrap:wrap;gap:12px;padding:18px 22px 22px}
.btn{flex:1 1 200px;min-height:56px;border-radius:14px;border:2px solid var(--accent);font:inherit;font-size:18px;font-weight:500;cursor:pointer;background:transparent;color:var(--ink)}
.btn.ok{background:var(--accent);color:var(--accent-ink)}
.btn:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.note{width:100%;min-height:96px;border-radius:12px;border:1.5px solid var(--muted);padding:12px;font:inherit;font-size:17px;background:#fff;color:var(--ink)}
.notebox{display:none;padding:0 22px 22px}.notebox.open{display:block}
.notebox label{display:block;font-weight:500;margin-bottom:6px}
.done{display:none;padding:16px 22px 22px;align-items:center;gap:12px;font-weight:500}
.item.approved .act,.item.change .act{display:none}.item.approved .done,.item.change .done{display:flex}
.item.approved{outline:2px solid var(--ok)}.item.change{outline:2px solid var(--accent)}
.undo{margin-left:auto;background:none;border:0;color:var(--accent);font:inherit;text-decoration:underline;cursor:pointer;min-height:44px}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--raised);border-top:1px solid var(--surface);padding:12px 18px;box-shadow:0 -8px 24px rgba(0,0,0,.06)}
.bar .in{max-width:860px;margin:0 auto;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center}
.prog{flex:1 1 220px}.prog .track{height:8px;border-radius:4px;background:var(--surface);overflow:hidden;margin-top:6px}.prog i{display:block;height:100%;background:var(--ok);width:0}
.send{min-height:52px;padding:0 22px;border-radius:12px;border:0;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:500;font-size:17px;cursor:pointer}
.saved{font-size:14px;color:var(--muted)}
.final{background:var(--raised);border-radius:20px;padding:22px;margin-top:30px}
.final h2{font-family:var(--display);font-weight:500;font-size:28px;margin-bottom:8px}
footer{color:var(--muted);font-size:14px;margin-top:40px;text-align:center}
@media (min-width:1600px){body{font-size:22px}.wrap{max-width:1100px}}
</style></head><body><div class="wrap">
<header class="top">__LOGO__<span class="who">__CLIENT__</span></header>
<h1>__TITLE__</h1>
<p class="lead">__INTRO__</p>
<div class="how"><div><b>1. Read each post</b>Tap "Read all" to see the whole thing.</div>
<div><b>2. Approve or ask for a change</b>One tap. Type what you'd like changed, in your own words.</div>
<div><b>3. That's it</b>Your answers save as you go. Nothing is posted until you approve it.</div></div>
<div id="items"></div>
<div class="final"><h2>All done?</h2><p class="lead">Tap below and we'll get to work. If anything still needs a look, it simply waits.</p>
<p style="margin-top:14px"><button class="send" id="send2">Send my answers</button></p>
<p class="saved" id="mailnote" style="margin-top:10px"></p></div>
<footer>Prepared for __CLIENT__ by Booked Out Solutions</footer></div>
<div class="bar"><div class="in"><div class="prog"><span id="count"></span><div class="track"><i id="fill"></i></div></div>
<span class="saved" id="saved"></span><button class="send" id="send">Send my answers</button></div></div>
<script>
const BATCH = __BATCH__;
const API = '/approve-api/' + BATCH.token;
const KEY = 'approve:' + BATCH.batch_id;
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}') } catch (e) {}
const esc = s => (s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const PN = __PNAMES__;
function day(d){ try { return new Date(d + 'T12:00:00').toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}) } catch(e){ return d } }
function render(){
  const box = document.getElementById('items'); box.innerHTML = '';
  BATCH.items.forEach(it => {
    const s = state[it.id] || {};
    const el = document.createElement('article');
    el.className = 'item ' + (s.status || ''); el.id = 'it-' + it.id;
    const media = it.video ? `<div class="media"><video controls playsinline preload="metadata" poster="${esc(it.poster||'')}" src="${esc(it.video)}"></video></div>`
                : it.image ? `<div class="media"><img loading="lazy" src="${esc(it.image)}" alt="Picture that goes with this post"></div>` : '';
    const long = (it.text || '').length > 420;
    el.innerHTML = `<div class="meta"><span class="chip">${esc(PN[it.platform] || it.platform)}</span><span>${esc(day(it.date))}</span>${it.audience?`<span>For: ${esc(it.audience)}</span>`:''}</div>
      <h2>${esc(it.title)}</h2>${media}<div class="text ${long?'clamp':''}">${esc(it.text)}</div>
      ${long?'<button class="more">Read all</button>':''}
      ${it.button?`<p class="extra">Button on the post: ${esc(it.button)}</p>`:''}
      <div class="act"><button class="btn ok" data-a="approve">Approve</button><button class="btn" data-a="change">Request a change</button></div>
      <div class="notebox ${s.status==='editing'?'open':''}"><label for="n-${it.id}">What would you like changed?</label>
        <textarea class="note" id="n-${it.id}">${esc(s.note||'')}</textarea>
        <div class="act" style="padding:12px 0 0"><button class="btn ok" data-a="savechange">Save my note</button></div></div>
      <div class="done"><span>${s.status==='approved'?'Approved':'Change requested'+(s.note?': '+esc(s.note):'')}</span><button class="undo">Undo</button></div>`;
    el.querySelector('[data-a=approve]').onclick = () => set(it.id, {status:'approved'});
    el.querySelector('[data-a=change]').onclick = () => { el.querySelector('.notebox').classList.add('open'); el.querySelector('textarea').focus() };
    el.querySelector('[data-a=savechange]').onclick = () => { const n = el.querySelector('textarea').value.trim(); if (!n) { el.querySelector('textarea').focus(); return } set(it.id, {status:'change', note:n}) };
    el.querySelector('.undo').onclick = () => set(it.id, null);
    const m = el.querySelector('.more'); if (m) m.onclick = () => { el.querySelector('.text').classList.remove('clamp'); m.remove() };
    box.appendChild(el);
  });
  const done = BATCH.items.filter(i => state[i.id] && ['approved','change'].includes(state[i.id].status)).length;
  const ok = BATCH.items.filter(i => state[i.id] && state[i.id].status === 'approved').length;
  document.getElementById('count').textContent = `${done} of ${BATCH.items.length} answered (${ok} approved)`;
  document.getElementById('fill').style.width = (100 * done / BATCH.items.length) + '%';
}
let timer;
function set(id, v){
  if (v) state[id] = Object.assign({}, v, {at: new Date().toISOString()}); else delete state[id];
  try { localStorage.setItem(KEY, JSON.stringify(state)) } catch (e) {}
  render(); clearTimeout(timer); timer = setTimeout(push, 800);
}
async function push(final){
  const s = document.getElementById('saved');
  try {
    const r = await fetch(API, {method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({batch_id: BATCH.batch_id, answers: state, final: !!final})});
    if (!r.ok) throw new Error(r.status);
    s.textContent = final ? 'Sent. Thank you!' : 'Saved'; return true;
  } catch (e) { s.textContent = 'Saved on this device'; return false; }
}
function summary(){
  const L = [BATCH.title, ''];
  BATCH.items.forEach(i => { const s = state[i.id] || {};
    L.push(`${s.status==='approved'?'APPROVED':s.status==='change'?'CHANGE':'NOT YET'} - ${PN[i.platform]||i.platform}, ${i.date}: ${i.title}` + (s.note?`\n   Change: ${s.note}`:'')) });
  return L.join('\n');
}
async function send(){
  if (await push(true)) { document.getElementById('mailnote').textContent = 'Your answers are in. Thank you!'; return }
  location.href = 'mailto:' + BATCH.agency_email + '?subject=' + encodeURIComponent(BATCH.client + ' - ' + BATCH.title) + '&body=' + encodeURIComponent(summary());
  document.getElementById('mailnote').textContent = 'Your email app should open with your answers filled in. Just press send.';
}
document.getElementById('send').onclick = send; document.getElementById('send2').onclick = send;
render();
</script></body></html>"""


def build(batch_path, token=None):
    batch = json.load(open(batch_path))
    th = THEME[batch['brand']]
    brand = json.load(open(os.path.join(CS, 'brands', batch['brand'] + '.json')))
    token = token or batch.get('token') or secrets.token_urlsafe(18).replace('-', 'x').replace('_', 'y')
    batch['token'] = token
    batch.setdefault('client', brand['name'])
    batch.setdefault('agency_email', 'hello@getbookedoutsolutions.com')
    out = os.path.join(AGENCY_SITE, 'approve', token)
    os.makedirs(os.path.join(out, 'img'), exist_ok=True)
    os.makedirs(os.path.join(out, 'fonts'), exist_ok=True)
    for it in batch['items']:
        for k in ('image', 'video', 'poster'):
            if it.get(k) and os.path.isfile(it[k]):
                name = re.sub(r'[^a-z0-9.-]', '-', f"{it['id']}-{os.path.basename(it[k])}".lower())
                shutil.copy(it[k], os.path.join(out, 'img', name)); it[k] = 'img/' + name
    faces = []
    for fam, f, wt in th['fonts']:
        shutil.copy(os.path.join(ROOT, th['font_src'], f), os.path.join(out, 'fonts', f))
        faces.append(f"@font-face{{font-family:'{fam}';src:url(fonts/{f}) format('woff2');font-weight:{wt};font-display:swap}}")
    logo = re.sub(r'<metadata>.*?</metadata>', '', open(os.path.join(ROOT, th['logo'])).read(), flags=re.S)
    page = PAGE
    for k, v in th.items():
        if isinstance(v, str): page = page.replace('__' + k, v)
    page = (page.replace('__FONTS__', '\n'.join(faces)).replace('__LOGO__', logo)
            .replace('__TITLE__', html.escape(batch['title'])).replace('__INTRO__', html.escape(batch.get('intro', '')))
            .replace('__CLIENT__', html.escape(batch['client'])).replace('__PNAMES__', json.dumps(PLATFORM_NAMES))
            .replace('__BATCH__', json.dumps(batch).replace('</', '<\\/')))
    open(os.path.join(out, 'index.html'), 'w').write(page)
    json.dump(batch, open(os.path.join(out, 'batch.json'), 'w'), indent=1)
    _ensure_headers_and_proxy()
    return out, token


def _ensure_headers_and_proxy():
    h = os.path.join(AGENCY_SITE, '_headers')
    s = open(h).read() if os.path.isfile(h) else ''
    if '/approve/*' not in s:
        open(h, 'a').write('\n/approve/*\n  X-Robots-Tag: noindex, nofollow, noarchive\n  Cache-Control: no-store\n  Referrer-Policy: no-referrer\n')
    r = os.path.join(AGENCY_SITE, '_redirects')
    s = open(r).read() if os.path.isfile(r) else ''
    if '/approve-api/' not in s:
        open(r, 'a').write('\n# Client approvals API (Cloudflare worker, content-system/worker/approvals-worker.js); URL stays on our domain\n'
                           '/approve-api/*   https://bookedout-approvals.rickey-38a.workers.dev/approve-api/:splat   200!\n')
    # robots.txt is left alone on purpose: a Disallow would stop search engines from seeing the noindex header

if __name__ == '__main__':
    a = sys.argv[1:]
    tok = a[a.index('--token') + 1] if '--token' in a else None
    o, t = build(a[0], tok)
    print('built', o, '\nlink: https://getbookedoutsolutions.com/approve/' + t + '/')
