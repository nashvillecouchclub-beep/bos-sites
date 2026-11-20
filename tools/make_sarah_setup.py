#!/usr/bin/env python3
"""Build Sarah Barre Harrison Photography's setup page (Nov 19 2026).
Writes clients/pages/sarah-barre-harrison-setup.html and .register.json. No token inside:
the page reads its token from the URL, like every client page."""
import json, html, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT = os.path.join(ROOT, 'sites/getbookedoutsolutions.com/report/sarah-azix2rbxso/index.html')
LOGO = re.search(r'<svg aria-hidden="true" width="42".*?</svg>', open(REPORT).read(), re.S).group(0)
EMAIL = 'rickey@getbookedoutsolutions.com'

# ---------- illustrated screens (our drawings; labels as the real screens show them) ----------
def frame(title, body, h=300, url=''):
    return (f'<svg viewBox="0 0 640 {h}" role="img" aria-label="{html.escape(title)}" xmlns="http://www.w3.org/2000/svg" '
            f'font-family="Arial, Helvetica, sans-serif">'
            f'<rect x="1" y="1" width="638" height="{h-2}" rx="14" fill="#fff" stroke="#d6d9e0" stroke-width="2"/>'
            f'<rect x="1" y="1" width="638" height="40" rx="14" fill="#f1f3f4"/><rect x="1" y="28" width="638" height="13" fill="#f1f3f4"/>'
            f'<circle cx="24" cy="21" r="6" fill="#ff6159"/><circle cx="44" cy="21" r="6" fill="#ffbd2e"/><circle cx="64" cy="21" r="6" fill="#28c941"/>'
            f'<rect x="90" y="10" width="520" height="22" rx="11" fill="#fff"/>'
            f'<text x="104" y="26" font-size="12" fill="#5f6368">{html.escape(url)}</text>{body}</svg>')

def ring(cx, cy, rx, ry):
    return (f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="none" stroke="#E5484D" stroke-width="4"/>')

def btn(x, y, w, label, fill='#1a73e8', color='#fff', h=34, r=17, fs=14):
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{r}" fill="{fill}"/>'
            f'<text x="{x+w/2}" y="{y+h/2+5}" font-size="{fs}" fill="{color}" text-anchor="middle" font-weight="bold">{html.escape(label)}</text>')

def t(x, y, s, fs=14, fill='#202124', bold=False, anchor='start'):
    return f'<text x="{x}" y="{y}" font-size="{fs}" fill="{fill}" text-anchor="{anchor}"{" font-weight=\"bold\"" if bold else ""}>{html.escape(s)}</text>'

G1 = frame('Google Business Profile Manager with your business listed', ''.join([
    t(30, 72, 'Google Business Profile Manager', 18, '#5f6368'),
    t(30, 112, 'Businesses', 15, '#1a73e8', True),
    '<rect x="30" y="130" width="580" height="1" fill="#e0e0e0"/>',
    t(46, 160, 'Business', 12, '#5f6368'), t(400, 160, 'Status', 12, '#5f6368'),
    '<rect x="30" y="172" width="580" height="1" fill="#e0e0e0"/>',
    t(46, 204, 'Sarah Barre Harrison Photo', 16, '#1a73e8', True), t(46, 224, 'Murfreesboro, TN', 12, '#5f6368'),
    t(400, 210, 'Verified', 13, '#188038'),
    ring(150, 204, 128, 22)]), 260, 'business.google.com/locations')

G2 = frame('Your Business Profile with the three dots menu', ''.join([
    t(30, 76, 'Your business on Google', 13, '#5f6368'),
    t(30, 104, 'Sarah Barre Harrison Photo', 20, '#202124', True),
    btn(30, 124, 110, 'Edit profile', '#e8f0fe', '#1a73e8'), btn(150, 124, 90, 'Read reviews', '#e8f0fe', '#1a73e8'),
    btn(250, 124, 70, 'Photos', '#e8f0fe', '#1a73e8'),
    '<circle cx="560" cy="88" r="3.5" fill="#5f6368"/><circle cx="572" cy="88" r="3.5" fill="#5f6368"/><circle cx="584" cy="88" r="3.5" fill="#5f6368"/>',
    ring(572, 88, 30, 20),
    '<rect x="380" y="112" width="230" height="120" rx="8" fill="#fff" stroke="#dadce0"/>',
    t(398, 142, 'Business Profile settings', 14), t(398, 176, 'Advertise', 14, '#5f6368'), t(398, 210, 'Remove from Search', 14, '#5f6368'),
    ring(488, 137, 104, 18)]), 260, 'google.com/search?q=my+business')

G3 = frame('Business Profile settings, People and access', ''.join([
    t(30, 76, 'Business Profile settings', 18, '#202124', True),
    t(46, 116, 'People and access', 15), t(46, 150, 'Profile status', 15, '#5f6368'),
    t(46, 184, 'Advanced settings', 15, '#5f6368'), t(46, 218, 'Linked accounts', 15, '#5f6368'),
    ring(112, 111, 90, 20)]), 250, 'google.com/search?q=my+business')

G4 = frame('People and access window with the Add button', ''.join([
    t(30, 76, 'People and access', 18, '#202124', True),
    '<g transform="translate(560,58)"><circle cx="10" cy="8" r="6" fill="none" stroke="#1a73e8" stroke-width="2.5"/>'
    '<path d="M0 26c1-7 6-10 10-10s9 3 10 10" fill="none" stroke="#1a73e8" stroke-width="2.5"/>'
    '<path d="M24 6v12M18 12h12" stroke="#1a73e8" stroke-width="2.5"/></g>',
    t(583, 104, 'Add', 12, '#1a73e8', anchor='middle'),
    ring(576, 80, 34, 34),
    t(46, 140, 'Sarah Harrison', 15), t(46, 160, 'Primary owner', 12, '#5f6368')]), 200, 'google.com/search?q=my+business')

G5 = frame('Add new users window: paste our email, choose Manager, click Invite', ''.join([
    t(30, 76, 'Add new users', 18, '#202124', True),
    '<rect x="30" y="96" width="580" height="46" rx="6" fill="#fff" stroke="#1a73e8" stroke-width="2"/>',
    t(44, 125, EMAIL, 15),
    t(30, 178, 'Access', 13, '#5f6368'),
    '<rect x="30" y="188" width="200" height="40" rx="6" fill="#fff" stroke="#80868b"/>',
    t(44, 213, 'Manager', 15, '#202124', True), '<path d="M206 204l7 7 7-7" fill="none" stroke="#5f6368" stroke-width="2"/>',
    ring(130, 208, 112, 30),
    btn(500, 250, 100, 'Invite'), ring(550, 267, 66, 28)]), 310, 'google.com/search?q=my+business')

S1 = frame('Squarespace: your websites list', ''.join([
    t(30, 76, 'Websites', 18, '#000', True),
    '<rect x="30" y="96" width="250" height="150" rx="8" fill="#f2f2f2" stroke="#ddd"/>',
    '<rect x="44" y="110" width="222" height="90" rx="4" fill="#d9d9d9"/>',
    t(44, 226, 'Sarah Barre Harrison Photography', 13, '#000', True),
    ring(155, 170, 140, 92)]), 270, 'account.squarespace.com')

S2 = frame('Squarespace site menu: Settings', ''.join([
    t(30, 76, 'Website', 15, '#777'), t(30, 110, 'Pages', 16), t(30, 144, 'Design', 16),
    t(30, 178, 'Commerce', 16), t(30, 212, 'Settings', 16, '#000', True), ring(62, 207, 52, 20),
    '<rect x="230" y="60" width="380" height="190" rx="6" fill="#f7f7f7"/>', t(420, 160, '(your website preview)', 13, '#999', anchor='middle')]),
    260, 'your-site.squarespace.com/config')

S3 = frame('Squarespace Settings: Permissions & Ownership', ''.join([
    t(30, 76, 'Settings', 18, '#000', True), t(30, 112, 'Website', 13, '#777'),
    t(30, 142, 'Site availability', 15), t(30, 172, 'Domains', 15), t(30, 202, 'Permissions & Ownership', 15, '#000', True),
    ring(118, 197, 104, 20), t(30, 232, 'Billing', 15)]), 250, 'your-site.squarespace.com/config/settings')

S4 = frame('Permissions & Ownership with Invite contributor', ''.join([
    t(30, 76, 'Permissions & Ownership', 18, '#000', True),
    t(30, 116, 'Owner', 13, '#777'), t(30, 140, 'Sarah Harrison', 15),
    btn(30, 170, 190, 'Invite contributor', '#000', '#fff', 40, 4), ring(125, 190, 112, 32)]), 240,
    'your-site.squarespace.com/config/settings/permissions')

S5 = frame('Invite contributor form: name, email, Website Editor, Invite', ''.join([
    t(30, 72, 'Invite contributor', 18, '#000', True),
    t(30, 100, 'Contributor name', 12, '#777'), '<rect x="30" y="106" width="580" height="34" rx="4" fill="#fff" stroke="#bbb"/>', t(42, 129, 'Rickey Hallor', 14),
    t(30, 162, 'Email', 12, '#777'), '<rect x="30" y="168" width="580" height="34" rx="4" fill="#fff" stroke="#bbb"/>', t(42, 191, EMAIL, 14),
    t(30, 226, 'Permissions', 12, '#777'),
    '<rect x="30" y="236" width="16" height="16" rx="3" fill="#000"/><path d="M33 244l4 4 7-8" stroke="#fff" stroke-width="2" fill="none"/>',
    t(56, 249, 'Website Editor', 14, '#000', True), ring(105, 244, 92, 20),
    btn(500, 272, 110, 'Invite', '#000', '#fff', 36, 4), ring(555, 290, 70, 28)]), 330,
    'your-site.squarespace.com/config/settings/permissions')

F1 = frame('Facebook request from Booked Out Solutions with the Approve button', ''.join([
    t(30, 76, 'Requests', 18, '#1c2b33', True),
    '<rect x="30" y="96" width="580" height="110" rx="10" fill="#f5f6f7" stroke="#dddfe2"/>',
    t(50, 128, 'Booked Out Solutions', 16, '#1c2b33', True),
    t(50, 152, 'wants to help manage your Page:', 13, '#65676b'),
    t(50, 174, 'Sarah Barre Harrison Photography LLC', 13, '#1c2b33'),
    btn(470, 130, 120, 'Approve', '#0866ff', '#fff', 38, 8), ring(530, 149, 76, 30),
    btn(350, 130, 110, 'Decline', '#e4e6eb', '#1c2b33', 38, 8)]), 230, 'business.facebook.com/latest/settings/requests')

# ---------- cards ----------
def copybox():
    return (f'<div class="copy"><code>{EMAIL}</code>'
            f'<button type="button" class="cbtn" data-copy="{EMAIL}">Copy</button></div>')

def shot(svg, cap):
    return f'<figure class="shot">{svg}<figcaption>{html.escape(cap)}</figcaption></figure>'

CARDS = [
 dict(id='google', n=1, title='Google: add us as a manager', time='about 2 minutes',
      device='A computer is easiest.',
      why='So we can fix and fill in your Google profile for you, without ever needing your password.',
      button=('Open Google Business Profile', 'https://business.google.com/locations'),
      steps=[
        'Click the gold button above. It opens Google in a new tab.',
        'If Google asks you to sign in, sign in with the Google account you use for your business profile.',
        'If you see a list, click <b>Sarah Barre Harrison Photo</b>. If your business opens right away, go to the next step.',
        shot(G1, 'Click your business name.'),
        'Your business profile opens at the top of a Google page. Click the <b>three dots</b> next to it. (If you don\'t see three dots, look for a <b>Menu</b> button, or just reply to our email.)',
        'Click <b>Business Profile settings</b>.',
        shot(G2, 'Click the three dots, then Business Profile settings.'),
        'Click <b>People and access</b>.',
        shot(G3, 'Click People and access.'),
        'Click <b>Add</b> (the little person with a plus sign).',
        shot(G4, 'Click Add.'),
        'Click in the email box and paste our email address. Use the Copy button below, then paste it in.',
        'COPY',
        'Under <b>Access</b>, choose <b>Manager</b>. (Not Owner, so you stay in charge.)',
        'Click <b>Invite</b>.',
        shot(G5, 'Paste our email, choose Manager, then click Invite.'),
      ],
      worked=f'You\'ll see {EMAIL} in the People and access list with the word <b>Pending</b> or <b>Invited</b> next to it. That is all you need to do.',
      note='You stay the owner. As a manager, we can update your profile, but we can\'t remove you or delete your profile.'),
 dict(id='squarespace', n=2, title='Squarespace website: add us as an editor', time='about 2 minutes',
      device='A computer is easiest.',
      why='So we can make the website fixes in your plan for you. A contributor is someone you let help edit your site. You can remove us any time.',
      button=('Open Squarespace', 'https://account.squarespace.com/'),
      steps=[
        'Click the gold button above. It opens Squarespace in a new tab.',
        'Log in the way you normally do.',
        'Click your website.',
        shot(S1, 'Click your website.'),
        'In the menu on the left, click <b>Settings</b> (you may need to scroll down).',
        shot(S2, 'Click Settings.'),
        'Click <b>Permissions &amp; Ownership</b>.',
        shot(S3, 'Click Permissions & Ownership.'),
        'Click <b>Invite contributor</b>.',
        shot(S4, 'Click Invite contributor.'),
        'For the name, type <b>Rickey Hallor</b>.',
        'For the email, paste our email address (use the Copy button below).',
        'COPY',
        'Under Permissions, choose <b>Website Editor</b>.',
        'Click <b>Invite</b> (it may say <b>Send invite</b>).',
        shot(S5, 'Type the name, paste our email, choose Website Editor, click Invite.'),
      ],
      worked='Our email shows on the Permissions page as <b>pending</b>.',
      note='If the Invite button is greyed out, or Squarespace asks you to upgrade your plan, please don\'t upgrade. Just reply to our email and we\'ll find another way.'),
 dict(id='facebook', n=3, title='Facebook: approve our request', time='about 30 seconds',
      device='Your phone or a computer is fine.',
      why='We\'ve sent you a request from Booked Out Solutions to help manage your Page, so we can post for you.',
      button=('Open your Facebook requests', 'https://business.facebook.com/latest/settings/requests'),
      steps=[
        'Look for a Facebook notification or an email from Meta that says <b>Booked Out Solutions</b> wants access to your Page.',
        'Tap it. (The gold button above is a backup. If Facebook asks you to set up a business portfolio, which is a business account, stop and use the notification instead.)',
        'Don\'t see a request? Reply to our email and we\'ll send it again. Don\'t create anything new on Facebook.',
        'Check that it says <b>Booked Out Solutions</b>.',
        'Tap <b>Approve</b>.',
        shot(F1, 'Check it says Booked Out Solutions, then tap Approve.'),
        'If Facebook asks for your password or a code, that is normal. Enter it, and it finishes.',
      ],
      worked='Facebook says the request is <b>approved</b>.',
      note='We can post, reply to comments on your Page and see how your posts are doing. We won\'t have access to your messages or ads, and you stay the owner.'),
]

def card_html(c):
    out = [f'<article class="card" id="card-{c["id"]}" data-item="{c["id"]}">',
           f'<div class="num">Step {c["n"]} of 3</div><h2>{html.escape(c["title"])}</h2>',
           f'<p class="time">{c["time"]}. {c["device"]}</p>',
           f'<p class="why"><b>Why:</b> {html.escape(c["why"])}</p>',
           f'<a class="gold" href="{c["button"][1]}" target="_blank" rel="noopener">{html.escape(c["button"][0])} &rarr;</a>',
           '<ol class="steps">']
    for s in c['steps']:
        if s == 'COPY':
            out.append(f'<li class="nonum">{copybox()}</li>')
        elif s.startswith('<figure'):
            out.append(f'<li class="nonum">{s}</li>')
        else:
            out.append(f'<li>{s}</li>')
    out += ['</ol>',
            f'<div class="worked"><b>How you know it worked:</b> {c["worked"]}</div>',
            f'<p class="note">{c["note"]}</p>',
            '<p class="stuck"><b>Stuck?</b> Just reply to our email and we\'ll help.</p>',
            f'<button type="button" class="done" data-item="{c["id"]}">Done</button>',
            f'<div class="state" id="st-{c["id"]}" aria-live="polite"></div>',
            '</article>']
    return '\n'.join(out)

PHOTO_CHOICES = ['Use the photos on my website', 'Ask me first']

PAGE = r'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>Your 3 easy setup steps | Booked Out Solutions</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
@font-face{font-family:"Bricolage Grotesque";src:url(/fonts/bricolage-grotesque.woff2) format("woff2");font-weight:200 800;font-display:swap}
@font-face{font-family:"Instrument Sans";src:url(/fonts/instrument-sans.woff2) format("woff2");font-weight:400 700;font-display:swap}
:root{--navy:#0b1d3a;--night:#06122a;--gold:#e3b341;--goldd:#b8891f;--cream:#F6F1E7;--paper:#FFFDF7;--ink:#0a0f26;--muted:#5b6078;--line:#e6dccb;--green:#2f9e6a;--red:#E5484D}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--cream);color:var(--ink);font:18px/1.55 "Instrument Sans",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
h1,h2{font-family:"Bricolage Grotesque","Instrument Sans",system-ui,sans-serif;line-height:1.15;margin:0}
.wrap{max-width:760px;margin:0 auto;padding:0 18px}
.top{background:var(--night)}
.top .wrap{display:flex;align-items:center;gap:12px;padding-top:14px;padding-bottom:14px}
.word b{display:block;font-family:"Bricolage Grotesque",sans-serif;font-weight:800;letter-spacing:.04em;font-size:17px;color:var(--gold)}
.word span{display:block;font-size:11px;letter-spacing:.32em;color:#cfc6b2;font-weight:600}
.hero{background:radial-gradient(120% 90% at 50% 0%,#17306a 0%,var(--navy) 60%,var(--night) 100%);color:var(--cream);padding:34px 0 40px}
.hero h1{font-size:clamp(28px,6vw,44px);font-weight:800}
.hero h1 em{font-style:normal;color:var(--gold)}
.hero p{margin:14px 0 0;color:#e1dacb}
.prog{position:sticky;top:0;z-index:5;background:rgba(255,253,247,.97);border-bottom:1px solid var(--line);padding:10px 0}
.prog .wrap{display:flex;align-items:center;gap:12px;font-size:16px}
.track{flex:1;height:10px;background:var(--line);border-radius:99px;overflow:hidden}
.track i{display:block;height:100%;width:0;background:var(--green);transition:width .3s}
main{padding:22px 0 10px}
.card{background:var(--paper);border:1px solid var(--line);border-left:7px solid var(--gold);border-radius:18px;padding:22px 20px;margin:0 0 22px}
.card.ok{border-left-color:var(--green)}
.num{font-size:13px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--goldd)}
.card h2{font-size:clamp(24px,5vw,30px);font-weight:800;margin:6px 0 6px}
.time{margin:0 0 6px;color:var(--muted);font-size:16px}
.why{margin:0 0 16px}
a.gold{display:block;text-align:center;background:var(--gold);color:var(--navy);font-weight:800;font-size:20px;text-decoration:none;border-radius:14px;padding:18px 16px;margin:0 0 18px;box-shadow:0 2px 0 var(--goldd)}
a.gold:active{transform:translateY(1px)}
.steps{margin:0 0 14px;padding-left:0;list-style:none;counter-reset:st}
.steps li{margin:0 0 12px;position:relative;padding-left:40px}
.steps li:not(.nonum):before{counter-increment:st;content:counter(st);position:absolute;left:0;top:0;width:28px;height:28px;border-radius:50%;background:var(--navy);color:#fff;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center}
.steps li.nonum{padding-left:0}
.shot{margin:4px 0 6px}
.shot svg{display:block;width:100%;height:auto;max-width:640px}
.shot figcaption{font-size:14px;color:var(--muted);margin-top:4px}
.shot figcaption:before{content:"Sample screen. ";font-weight:700}
.copy{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:#fff;border:2px dashed var(--gold);border-radius:12px;padding:12px 14px}
.copy code{font:700 17px/1.3 ui-monospace,Menlo,Consolas,monospace;word-break:break-all;flex:1;min-width:200px}
.cbtn{background:var(--navy);color:#fff;border:0;border-radius:10px;font-family:inherit;font-size:17px;font-weight:700;line-height:1;padding:12px 20px;cursor:pointer}
.worked{background:#eaf6ef;border-radius:12px;padding:12px 14px;margin:0 0 10px}
.note{font-size:16px;color:var(--muted);margin:0 0 8px}
.stuck{margin:0 0 16px}
button.done,.choice button{display:block;width:100%;background:var(--navy);color:#fff;border:0;border-radius:14px;font-family:inherit;font-size:20px;font-weight:800;line-height:1.2;padding:18px;cursor:pointer}
button.done[disabled],.choice button[disabled]{opacity:.6}
.state{margin-top:10px;font-weight:700;color:var(--green);min-height:1em}
.state.err{color:var(--red)}
.choice{display:grid;gap:12px;margin:14px 0 10px}
.choice button.alt{background:#fff;color:var(--navy);border:2px solid var(--navy)}
.choice button.sel{outline:4px solid var(--gold)}
.close{text-align:center;padding:10px 0 40px}
.close h2{font-size:28px;font-weight:800}
.close p{margin:10px 0 0}
footer{background:var(--night);color:#cfc6b2;font-size:14px;text-align:center;padding:18px}
@media (min-width:700px){.choice{grid-template-columns:1fr 1fr}.card{padding:28px 30px}}
</style>
</head>
<body>
<div class="top"><div class="wrap">__LOGO__<div class="word"><b>BOOKED OUT</b><span>SOLUTIONS</span></div></div></div>
<div class="hero"><div class="wrap">
<h1>Sarah Barre Harrison Photography: <em>your 3 easy setup steps</em> (about 5 minutes)</h1>
<p>Hi Sarah, these 3 steps let us do the work for you. You never share a password with us, and you stay the owner of everything. Tap <b>Done</b> after each one.</p>
</div></div>
<div class="prog"><div class="wrap"><span id="pc">0 of 3 steps done</span><div class="track"><i id="pb"></i></div></div></div>
<main><div class="wrap">
__CARDS__
<article class="card" id="card-photos" data-item="photos">
<div class="num">Last question</div>
<h2>Can we use the photos on your website?</h2>
<p class="why">For your Google and Facebook posts. Tap one:</p>
<div class="choice">
<button type="button" data-choice="Use the photos on my website">Use the photos on my website for my Google and Facebook posts</button>
<button type="button" class="alt" data-choice="Ask me first">Ask me first</button>
</div>
<p class="note">Either way, we leave out photos of kids, and we never edit, filter or crop your images without asking.</p>
<div class="state" id="st-photos" aria-live="polite"></div>
</article>
<div class="close"><h2>That's it. Everything else is on us.</h2>
<p>Rickey Hallor<br>Booked Out Solutions</p></div>
</div></main>
<footer>Booked Out Solutions &middot; Questions? Just reply to our email.</footer>
<script>
(function(){
var TOKEN=(location.pathname.match(/\/c\/([a-f0-9]{32,64})/)||[])[1]||"";
var API="/api/client-answer";
var ITEMS=["google","squarespace","facebook","photos"];
var answers={};
function el(id){return document.getElementById(id)}
function progress(){var n=["google","squarespace","facebook"].filter(function(i){return answers[i]}).length;el("pc").textContent=n+" of 3 steps done";el("pb").style.width=(n*100/3)+"%"}
function show(id){var a=answers[id],st=el("st-"+id),c=el("card-"+id);if(!a||!st)return;st.className="state";c.classList.add("ok");
 if(id==="photos"){st.textContent="✓ Saved: "+a.answer+". Thank you!";[].forEach.call(c.querySelectorAll("[data-choice]"),function(b){b.classList.toggle("sel",b.getAttribute("data-choice")===a.answer)})}
 else{st.textContent="✓ Done. Thank you!";var b=c.querySelector("button.done");if(b){b.textContent="Done ✓";}}
 progress()}
function save(id,answer,btn){
 if(!TOKEN){el("st-"+id).textContent="Saved on this screen.";return}
 if(btn)btn.disabled=true;var st=el("st-"+id);st.className="state";st.textContent="Saving...";
 var timer=setTimeout(function(){st.className="state err";st.textContent="Not saved yet. Please try again, or just reply to our email.";if(btn)btn.disabled=false},10000);
 fetch(API,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:TOKEN,answers:[{item:id,answer:answer,note:""}]})})
 .then(function(r){return r.json()}).then(function(j){clearTimeout(timer);if(btn)btn.disabled=false;
  if(j&&j.saved){answers[id]={answer:answer,time:j.time};show(id)}else{st.className="state err";st.textContent="Not saved yet. Please try again, or just reply to our email."}})
 .catch(function(){clearTimeout(timer);if(btn)btn.disabled=false;st.className="state err";st.textContent="Not saved yet. Please try again, or just reply to our email."})}
[].forEach.call(document.querySelectorAll("button.done"),function(b){b.addEventListener("click",function(){save(b.getAttribute("data-item"),"done",b)})});
[].forEach.call(document.querySelectorAll("[data-choice]"),function(b){b.addEventListener("click",function(){save("photos",b.getAttribute("data-choice"),b)})});
[].forEach.call(document.querySelectorAll("[data-copy]"),function(b){b.addEventListener("click",function(){
 var v=b.getAttribute("data-copy");function ok(){b.textContent="Copied!";setTimeout(function(){b.textContent="Copy"},2000)}
 if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(v).then(ok,fallback)}else fallback();
 function fallback(){var t=document.createElement("textarea");t.value=v;t.setAttribute("readonly","");t.style.position="absolute";t.style.left="-9999px";document.body.appendChild(t);t.select();try{document.execCommand("copy");ok()}catch(e){b.textContent="Press and hold the address to copy"}document.body.removeChild(t)}
})});
if(TOKEN)fetch(API+"/state?t="+TOKEN,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){Object.keys(j.answers||{}).forEach(function(id){if(ITEMS.indexOf(id)>=0){answers[id]=j.answers[id];show(id)}});progress()}).catch(function(){});
progress();
})();
</script>
</body>
</html>
'''

def main():
    page = PAGE.replace('__LOGO__', LOGO).replace('__CARDS__', '\n'.join(card_html(c) for c in CARDS))
    reg = {'client': 'sarah-barre-harrison', 'client_name': 'Sarah Barre Harrison Photography', 'week': 'setup',
           'created': '2026-11-19',
           'items': {'google': {'title': 'Google: add us as a manager'},
                     'squarespace': {'title': 'Squarespace website: add us as an editor'},
                     'facebook': {'title': 'Facebook: approve our request'},
                     'photos': {'title': 'Use website photos for Google and Facebook posts?', 'choices': PHOTO_CHOICES}}}
    out = os.path.join(ROOT, 'clients/pages')
    open(os.path.join(out, 'sarah-barre-harrison-setup.html'), 'w').write(page)
    open(os.path.join(out, 'sarah-barre-harrison-setup.register.json'), 'w').write(json.dumps(reg, indent=1))
    print('ok', len(page))

if __name__ == '__main__':
    main()
