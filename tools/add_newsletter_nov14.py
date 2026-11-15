"""The Booked Out Brief newsletter on getbookedoutsolutions.com (Nov 14 2026, adapted Nov 15 for website v3). Safe to run more than once.
Run AFTER the footer social icons patch, BEFORE tools/make_manifest.py.
1) writes /newsletter.html (a real page on our site, signup form posts to MailerLite)
2) adds a newsletter signup band to the footer of every page
3) adds a signup box at the end of every article/tips page (pages in articles/ or tips/, or with data-article)
4) adds the CSS (styles.css) + JS (assets/app.js, the script v3 pages load), one copy each, marked, and the sitemap entry
5) sets every post's closing CTA in content/booked-out/posts.json: 3 of 4 newsletter, 1 of 4 free report
Nov 15 changes: JS goes into assets/app.js (v3 pages don't load site.js); CTA wording says "free report" (URLs stay /free-look).
"""
import json, os, re
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SITE = os.path.join(ROOT, 'sites', 'getbookedoutsolutions.com')
MARK = 'nl-nov14'
ACCOUNT = '2730893'
FORMS = {  # MailerLite embedded forms (v2, Nov 14 9 pm); each adds the reader to its segment group only
    'hvac': '204170567454032972', 'plumbing': '204170568192230499',
    'electrical': '204170568867513609', 'other': '204170569621440025'}
ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'

def select(idp):
    return (f'<select id="{idp}-type" name="type" required aria-label="Your kind of business">'
            '<option value="" selected disabled>Your kind of business</option>'
            '<option value="hvac">Heating and air</option><option value="plumbing">Plumbing</option>'
            '<option value="electrical">Electrical</option><option value="other">Another kind of local business</option></select>')

def form(idp, big=False, dark=False):
    cls = 'nlform' + (' big' if big else '') + (' ondark' if dark else '')
    name = (f'<div class="field"><label for="{idp}-name">First name</label><input id="{idp}-name" name="fields[name]" type="text" maxlength="60" autocomplete="given-name"></div>' if big else '')
    lab = (lambda t, f: f'<label for="{idp}-{f}">{t}</label>') if big else (lambda t, f: f'<label class="sr" for="{idp}-{f}">{t}</label>')
    return (f'<form class="{cls}" data-nlform data-acct="{ACCOUNT}" data-forms=\'{json.dumps(FORMS)}\' method="post" action="https://assets.mailerlite.com/jsonp/{ACCOUNT}/forms/{FORMS["other"]}/subscribe" novalidate>'
            f'{name}<div class="field">{lab("Email", "email")}<input id="{idp}-email" name="fields[email]" type="email" maxlength="120" autocomplete="email" inputmode="email" placeholder="you@yourbusiness.com" required></div>'
            f'<div class="field">{lab("Your kind of business", "type")}{select(idp)}</div>'
            '<input type="hidden" name="ml-submit" value="1"><input class="hp" type="text" name="website2" tabindex="-1" autocomplete="off" aria-hidden="true">'
            f'<button class="btn" type="submit">Send me the free weekly tip {ARROW}</button>'
            '<p class="nl-msg" role="status" aria-live="polite" hidden></p>'
            '<p class="fine nl-fine">One email a week. Unsubscribe in one click. We never sell or share your email.</p></form>')

FOOTER_BAND = (f'<!--{MARK}-footer--><div class="nlband"><div class="nlband-copy"><h3>The Booked Out Brief</h3>'
               '<p>Get one tip like this every week, free. Real steps and the exact words to use, for local business owners who live on calls, quotes and reviews.</p>'
               '<p class="fine"><a href="/newsletter">See what you get</a></p></div>' + form('ft', dark=True) + f'</div><!--/{MARK}-footer-->')

ARTICLE_BOX = (f'<!--{MARK}-article--><section class="sec nl-article"><div class="wrap narrow"><div class="card nlbox"><span class="kicker"><i></i>Free every Wednesday</span>'
               '<h2>Get one tip like this every week, free.</h2><p class="muted">The Booked Out Brief: one real how-to for local business owners, with the exact words to use and a quick win you can do in under 10 minutes.</p>'
               + form('ar') + f'</div></div></section><!--/{MARK}-article-->')

PAGE_MAIN = ('<main>\n<section class="hero"><div class="wrap hero-grid">\n'
 '<div><span class="kicker"><i></i>Free, every Wednesday morning</span>\n'
 '<h1>The Booked Out Brief</h1>\n'
 '<p class="lead">Free weekly help for local business owners who live on calls, quotes and reviews. One real how-to each week, with the exact words to use and a quick win you can do in under 10 minutes.</p>\n'
 '<ul class="ticks"><li>One email a week, early Wednesday morning. A 3 minute read.</li><li>Real steps, real scripts, real examples. No fluff and no news roundups.</li><li>A short part written for your kind of business, so the examples fit.</li><li>Unsubscribe in one click, any time.</li></ul></div>\n'
 '<div><div class="card nlbox big" id="signup"><h2>Get the free weekly tip</h2><p class="muted">Takes 10 seconds. Your first Brief lands on a Wednesday morning.</p>' + form('pg', big=True) + '</div></div>\n'
 '</div></section>\n'
 '<section class="sec white"><div class="wrap"><div class="head"><span class="kicker"><i></i>What you\'ll learn</span><h2>The problems every local business fights</h2>'
 '<p class="lead">Each issue takes one of these and shows you exactly what to do about it.</p></div>\n'
 '<div class="grid3 nltopics">'
 '<div class="card"><h3>Missed calls</h3><p>The 5-minute text back that turns a hang-up into a conversation, and the voicemail greeting that stops costing you work.</p></div>'
 '<div class="card"><h3>Quotes that go quiet</h3><p>A simple day 2, 7 and 14 follow-up, with the words that bring people back without lowering your price.</p></div>'
 '<div class="card"><h3>Reviews</h3><p>When to ask, how to ask every customer the same way under Google\'s rules, and two-line replies that read like a real person.</p></div>'
 '<div class="card"><h3>Your Google profile</h3><p>The ten-minute checks that make your listing the one people call.</p></div>'
 '<div class="card"><h3>Slow months and past customers</h3><p>How to fill a slow week from the people who already know you, before you spend a dollar on ads.</p></div>'
 '<div class="card"><h3>Speed to reply</h3><p>Why the business that answers first usually wins, and how to be that business without living on your phone.</p></div>'
 '</div></div></section>\n'
 '<section class="sec"><div class="wrap split"><div><span class="kicker"><i></i>Who it\'s for</span><h2>Any local business that lives on the phone</h2>'
 '<p class="lead">Heating and air, plumbing and electrical shops. Roofers, pool builders, remodelers and every kind of contractor. Law firms, dental offices, med spas, realtors and wedding venues. Auto shops, salons, cleaners, movers, gyms and the rest of Main Street.</p>'
 '<p class="muted" style="margin-top:16px">If customers find you on Google, call you, ask for a quote and leave reviews, this is for you. The lesson is the same for everyone. The examples change to fit your world.</p></div>\n'
 '<div class="card"><h3>From Rickey</h3><p>"I owned four dry cleaners for years. One of them was voted best in town three years running. Ask me why and the answer is short: we answered everyone. This email is everything I learned about answering, following up and getting picked, one tip at a time."</p><p class="fine" style="margin-top:12px">Rickey Hallor, Booked Out Solutions, Smyrna, Tennessee. <a href="about.html">More about Rickey</a></p></div>'
 '</div></section>\n'
 '<section class="sec dark cta"><div class="wrap narrow" style="text-align:center"><h2>One good tip a week. Free.</h2><p class="lead">No prices, no pitch every week. Just the stuff that gets local businesses picked.</p>'
 f'<div class="btn-row" style="justify-content:center"><a class="btn" href="#signup">Get the free weekly tip {ARROW}</a></div></div></section>\n'
 '</main>')

CSS = f'''
/* {MARK}: The Booked Out Brief signup (page, footer band, article box) */
.sr{{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}}
.hp{{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}}
.field input[type=email]{{width:100%;font:500 19px/1.3 var(--body);padding:15px 16px;border-radius:14px;border:1.5px solid var(--line2);background:#fff;color:var(--text);min-height:56px}}
.field input[type=email]:focus{{outline:0;border-color:var(--blue);box-shadow:0 0 0 4px rgba(94,125,255,.2)}}
.nlform .btn{{width:100%}} .nlform .field{{margin-bottom:12px}}
.nlform .nl-fine{{margin:10px 0 0;font-size:15px}}
.nl-msg{{margin:12px 0 0;padding:12px 14px;border-radius:12px;font-weight:600;background:rgba(31,201,138,.14);color:var(--greendeep)}}
.nl-msg.err{{background:rgba(229,72,77,.12);color:#9b1c20}}
.nlbox h2{{font-size:clamp(26px,3vw,36px);margin-bottom:8px}} .nlbox .muted{{margin-bottom:18px}}
.hero .nlbox{{color:var(--text)}}
.nlband{{display:grid;gap:22px;padding:28px;margin-bottom:44px;border-radius:var(--r-l);background:linear-gradient(150deg,var(--ink3),var(--ink2));border:1px solid rgba(255,178,36,.28)}}
@media(min-width:900px){{.nlband{{grid-template-columns:1fr 1.1fr;align-items:center;gap:40px;padding:36px 40px}}}}
.nlband h3{{color:var(--amber);font-size:22px;margin-bottom:8px}} .nlband p{{color:var(--ontext)}}
.nlform.ondark .nl-fine{{color:var(--onmuted)}} .nlform.ondark .field select,.nlform.ondark .field input{{border-color:transparent}}
@media(min-width:620px){{.nlform.ondark{{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}}.nlform.ondark .btn,.nlform.ondark .nl-fine,.nlform.ondark .nl-msg{{grid-column:1/-1}}}}
.nltopics .card h3{{margin-bottom:8px}}
.nl-article{{padding-top:0}}
/* /{MARK} */
'''

JS = r'''
/* nl-nov14: The Booked Out Brief signup -> MailerLite (one form per kind of business) */
(function(){
  var forms = document.querySelectorAll("[data-nlform]");
  Array.prototype.forEach.call(forms, function(f){
    f.addEventListener("submit", function(e){
      e.preventDefault();
      var msg = f.querySelector(".nl-msg"), btn = f.querySelector("button");
      function say(t, bad){ msg.hidden = false; msg.textContent = t; msg.className = "nl-msg" + (bad ? " err" : ""); }
      if (f.website2 && f.website2.value) return;
      var em = f.querySelector("[type=email]"), nm = f.querySelector("[autocomplete=given-name]"); var email = (em.value || "").trim(), sel = f.querySelector("select"), type = sel.value;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { say("Please check your email address.", true); em.focus(); return; }
      if (!type) { say("Please pick your kind of business, so the examples fit.", true); sel.focus(); return; }
      var ids = JSON.parse(f.getAttribute("data-forms")), url = "https://assets.mailerlite.com/jsonp/" + f.getAttribute("data-acct") + "/forms/" + ids[type] + "/subscribe";
      var body = new URLSearchParams(); body.append("fields[email]", email);
      if (nm && nm.value) body.append("fields[name]", nm.value.trim());
      body.append("ml-submit", "1"); body.append("anticsrf", "true");
      btn.disabled = true;
      function done(){ f.reset(); btn.disabled = false; say("You're on the list. Your first Brief lands on a Wednesday morning. Add rickey@getbookedoutsolutions.com to your contacts so it doesn't go to spam."); }
      fetch(url, {method:"POST", body: body}).then(function(r){ return r.json(); }).then(function(j){
        if (j && j.success === false) { btn.disabled = false; say("That didn't go through. Please try again, or email hello@getbookedoutsolutions.com and we'll add you.", true); } else { done(); }
      }).catch(function(){
        fetch(url, {method:"POST", body: body, mode:"no-cors"}).then(done).catch(function(){ btn.disabled = false; say("That didn't go through. Please try again, or email hello@getbookedoutsolutions.com and we'll add you.", true); });
      });
    });
  });
})();
'''

def read(p): return open(p, encoding='utf-8').read()
def write(p, s): open(p, 'w', encoding='utf-8').write(s)

def make_page():
    src = read(os.path.join(SITE, 'free-look.html'))
    t = 'The Booked Out Brief: free weekly tips for local business owners | Booked Out Solutions'
    d = 'Free weekly help for local business owners who live on calls, quotes and reviews. One real how-to each Wednesday, with the exact words to use.'
    src = re.sub(r'<title>.*?</title>', f'<title>{t}</title>', src, flags=re.S)
    src = re.sub(r'(<meta name="description" content=")[^"]*', r'\g<1>' + d, src)
    src = re.sub(r'(<meta property="og:title" content=")[^"]*', r'\g<1>' + t, src)
    src = re.sub(r'(<meta property="og:description" content=")[^"]*', r'\g<1>' + d, src)
    if 'rel="canonical"' in src:
        src = re.sub(r'(<link rel="canonical" href=")[^"]*', r'\g<1>https://getbookedoutsolutions.com/newsletter', src)
    else:
        src = src.replace('<link rel="icon"', '<link rel="canonical" href="https://getbookedoutsolutions.com/newsletter">\n<link rel="icon"', 1)
    src = re.sub(r'<main[^>]*>.*?</main>', lambda m: PAGE_MAIN, src, flags=re.S)
    src = re.sub(r'<div class="phonebar">.*?</div>\n?', '', src, count=1, flags=re.S)
    write(os.path.join(SITE, 'newsletter.html'), src)

def pages():
    for r, _, fs in os.walk(SITE):
        if os.sep + 'start' in r or os.sep + 'help' in r: continue
        for f in fs:
            if f.endswith('.html'): yield os.path.join(r, f)

def add_footer_and_article():
    nf = na = 0
    for p in pages():
        s = read(p); o = s
        if f'<!--{MARK}-footer-->' not in s and '<footer' in s:
            s = re.sub(r'(<footer[^>]*>\s*<div class="wrap">)', lambda m: m.group(1) + '\n  ' + FOOTER_BAND, s, count=1)
            s = re.sub(r'(<h3>Pages</h3><div class="links">)', r'\1<a href="/newsletter">Free weekly tips (newsletter)</a>', s, count=1)
        rel = os.path.relpath(p, SITE).replace(os.sep, '/')
        is_article = rel.startswith(('articles/', 'tips/')) or 'data-article' in s
        if is_article and f'<!--{MARK}-article-->' not in s and '</main>' in s and not rel.endswith(('articles/index.html', 'tips/index.html')):
            s = s.replace('</main>', ARTICLE_BOX + '\n</main>', 1)
        if s != o:
            write(p, s); nf += f'<!--{MARK}-footer-->' in s and f'<!--{MARK}-footer-->' not in o; na += f'<!--{MARK}-article-->' in s and f'<!--{MARK}-article-->' not in o
    return nf, na

def add_assets():
    css = os.path.join(SITE, 'styles.css'); s = read(css)
    if MARK not in s: write(css, s.rstrip() + '\n' + CSS)
    js = os.path.join(SITE, 'assets', 'app.js'); s = read(js)
    if MARK not in s: write(js, s.rstrip() + '\n' + JS)
    sm = os.path.join(SITE, 'sitemap.xml')
    if os.path.exists(sm):
        s = read(sm)
        if '/newsletter<' not in s:
            write(sm, s.replace('</urlset>', '<url><loc>https://getbookedoutsolutions.com/newsletter</loc><changefreq>weekly</changefreq></url>\n</urlset>'))

NL_RULES = ("CTA (Rickey Nov 14 9:05 am; free report wording Nov 15): every post ends with its comment question, then ONE call to action. "
            "cta 'newsletter' (3 of every 4 posts): Facebook/Pinterest 'Get one tip like this every week, free: getbookedoutsolutions.com/newsletter'; "
            "Instagram 'Free weekly tips: link in bio'; X first reply 'Get one tip like this every week, free: https://getbookedoutsolutions.com/newsletter'. "
            "cta 'free-look' (every 4th post, n divisible by 4): Facebook/Pinterest 'Want a free report on your own Google profile, reviews and old quotes? No call needed: https://getbookedoutsolutions.com/free-look'; "
            "Instagram 'Want a free report on your own Google profile, reviews and old quotes? Link in bio.'; X first reply 'Free report on your own business: https://getbookedoutsolutions.com/free-look'. "
            "Pinterest pin link = the matching URL. Never more than one link per post.")

def set_ctas():
    p = os.path.join(ROOT, 'content', 'booked-out', 'posts.json')
    if not os.path.exists(p): return 0
    data = json.load(open(p, encoding='utf-8'))
    posts = data['posts'] if isinstance(data, dict) else data
    n = 0
    for post in posts:
        cta = 'free-look' if int(post.get('n', 0)) % 4 == 0 else 'newsletter'
        if post.get('cta') != cta: post['cta'] = cta; n += 1
        if 'x_reply' in post:
            post['x_reply'] = ('Free report on your own business: https://getbookedoutsolutions.com/free-look' if cta == 'free-look'
                               else 'Get one tip like this every week, free: https://getbookedoutsolutions.com/newsletter')
    if isinstance(data, dict):
        data['cta_rules'] = NL_RULES
    json.dump(data, open(p, 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    open(p, 'a').write('\n')
    return n

if __name__ == '__main__':
    make_page(); add_assets(); nf, na = add_footer_and_article(); nc = set_ctas()
    print(f'newsletter.html written; footer band added to {nf} pages; article box added to {na} pages; {nc} post CTAs changed')
