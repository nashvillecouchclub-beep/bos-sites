"""Adds the Booked Out social icon row (Instagram, Facebook, X, YouTube, Pinterest) to the footer of every
getbookedoutsolutions.com page that has <p class="legal">, plus the CSS once. Safe to run twice."""
import glob, os
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE=os.path.join(ROOT,'sites/getbookedoutsolutions.com')
ICONS=[('Instagram','https://www.instagram.com/getbookedoutsolutions','<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.3" cy="6.7" r="1.2" fill="currentColor"/>'),
('Facebook','https://www.facebook.com/getbookedoutsolutions','<path d="M13.5 21v-7.5h2.6l.4-3h-3V8.6c0-.9.3-1.5 1.6-1.5h1.6V4.4c-.3 0-1.2-.1-2.3-.1-2.3 0-3.9 1.4-3.9 4v2.2H8v3h2.5V21z" fill="currentColor"/>'),
('X','https://x.com/BookedOutHQ','<path d="M17.8 3h3l-6.6 7.6L22 21h-6.1l-4.8-6.2L5.6 21h-3l7.1-8.1L2.2 3h6.2l4.3 5.7zm-1 16.2h1.7L7.3 4.7H5.5z" fill="currentColor"/>'),
('YouTube','https://www.youtube.com/channel/UCr0BoKD7Dki8urs58UPXfpQ','<path d="M21.6 7.2a2.6 2.6 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.6 2.6 0 0 0 2.4 7.2 27 27 0 0 0 2 12a27 27 0 0 0 .4 4.8 2.6 2.6 0 0 0 1.8 1.8C5.8 19 12 19 12 19s6.2 0 7.8-.4a2.6 2.6 0 0 0 1.8-1.8A27 27 0 0 0 22 12a27 27 0 0 0-.4-4.8zM10 15V9l5.2 3z" fill="currentColor"/>'),
('Pinterest','https://www.pinterest.com/bookedoutsolutions','<path d="M12 2a10 10 0 0 0-3.6 19.3c-.1-.8-.2-2 0-2.9l1.2-5s-.3-.6-.3-1.5c0-1.4.8-2.4 1.8-2.4.9 0 1.3.6 1.3 1.4 0 .9-.5 2.1-.8 3.3-.2 1 .5 1.8 1.5 1.8 1.8 0 3.1-1.9 3.1-4.6 0-2.4-1.7-4.1-4.2-4.1-2.9 0-4.5 2.1-4.5 4.4 0 .9.3 1.8.8 2.3.1.1.1.2.1.3l-.3 1.2c0 .2-.2.2-.4.1-1.3-.6-2.1-2.5-2.1-4 0-3.3 2.4-6.3 6.9-6.3 3.6 0 6.4 2.6 6.4 6 0 3.6-2.3 6.5-5.4 6.5-1 0-2-.5-2.4-1.2l-.6 2.5c-.2.9-.9 2.1-1.3 2.8A10 10 0 1 0 12 2z" fill="currentColor"/>')]
links=''.join(f'<a href="{u}" target="_blank" rel="noopener me" aria-label="Booked Out Solutions on {n}" title="{n}"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">{p}</svg></a>' for n,u,p in ICONS)
BLOCK=f'\n  <div class="social"><span>Follow along for free tips</span><div class="icons">{links}</div></div>'
CSS='''
footer .social{margin-top:34px;display:flex;flex-wrap:wrap;align-items:center;gap:14px 18px}
footer .social>span{color:#fff;font-weight:600;font-size:16px}
footer .social .icons{display:flex;gap:10px}
footer .social a{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,178,36,.45);color:var(--amber);text-decoration:none;transition:background .2s ease-out,color .2s ease-out,transform .2s ease-out}
footer .social a:hover,footer .social a:focus-visible{background:var(--amber);color:#0A0F26;transform:translateY(-2px)}
footer .social svg{display:block}
'''
n=0
for f in glob.glob(os.path.join(SITE,'*.html')):
    s=open(f).read()
    if 'class="social"' in s or '\n  <p class="legal">' not in s: continue
    open(f,'w').write(s.replace('\n  <p class="legal">',BLOCK+'\n  <p class="legal">',1)); n+=1
css=os.path.join(SITE,'styles.css'); c=open(css).read()
if 'footer .social{' not in c: open(css,'a').write(CSS)
print('footer icons added to',n,'pages')
