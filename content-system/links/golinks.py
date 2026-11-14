"""TRACKED LINKS - short links on our own domain that add UTM tags, so every platform and post is measured.

   https://getbookedoutsolutions.com/go/bo01f  ->  /newsletter?utm_source=facebook&utm_medium=social&utm_campaign=tip-01&utm_content=bo01f

The registry is content-system/links/links.json (code -> destination + tags). `python3 content-system/links/golinks.py write`
rebuilds the "/go/" block inside each site's Netlify _redirects file (Netlify serves these for free, no worker needed).
Pinterest gets a direct link with UTM tags instead (Pinterest treats redirect links as a spam signal).
"""
import json, os, sys, urllib.parse, re
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
REG = os.path.join(HERE, 'links.json')
PLAT_LETTER = {'facebook': 'f', 'instagram': 'i', 'x': 'x', 'x_reply': 'x', 'pinterest': 'p', 'google': 'g', 'linkedin': 'l',
               'newsletter': 'n', 'article': 'w', 'video': 'v', 'youtube': 'y', 'bio': 'b'}
BEGIN, END = '# BEGIN tracked links (content-system/links/golinks.py writes this block; do not hand-edit)', '# END tracked links'


def load():
    return json.load(open(REG)) if os.path.isfile(REG) else {}


def save(reg):
    json.dump(reg, open(REG, 'w'), indent=1, sort_keys=True)


def tagged(dest, source, campaign, content, medium='social'):
    u = urllib.parse.urlsplit(dest)
    q = dict(urllib.parse.parse_qsl(u.query))
    q.update({'utm_source': source, 'utm_medium': medium, 'utm_campaign': campaign, 'utm_content': content})
    return urllib.parse.urlunsplit((u.scheme, u.netloc, u.path, urllib.parse.urlencode(q), u.fragment))


def make(brand, platform, campaign, dest, n=None):
    """Register (or reuse) a short code. Returns the public URL to put in the post."""
    reg = load()
    letter = PLAT_LETTER.get(platform, platform[:1])
    num = f'{n:02d}' if isinstance(n, int) else re.sub(r'[^a-z0-9]', '', str(n or campaign).lower())[:10]
    code = f"{brand['go_prefix']}{num}{letter}"
    source = brand.get('utm_source_names', {}).get(platform, platform)
    medium = 'email' if platform == 'newsletter' else ('organic' if platform == 'article' else 'social')
    entry = {'dest': dest, 'target': tagged(dest, source, campaign, code, medium), 'brand': brand['id'], 'platform': platform,
             'campaign': campaign}
    if reg.get(code, {}).get('dest') not in (None, dest):
        code = code + 'b'
    reg[code] = entry
    save(reg)
    if platform == 'pinterest':
        return entry['target']
    return f"https://{brand['domain']}/go/{code}"


def write_redirects():
    reg = load()
    by_domain = {}
    for code, e in sorted(reg.items()):
        b = json.load(open(os.path.join(ROOT, 'content-system', 'brands', e['brand'] + '.json')))
        if e['platform'] == 'pinterest': continue
        by_domain.setdefault(b['site_dir'], []).append(f"/go/{code}   {e['target']}   302")
    for site_dir, lines in by_domain.items():
        path = os.path.join(ROOT, site_dir, '_redirects')
        old = open(path).read() if os.path.isfile(path) else ''
        old = re.sub(re.escape(BEGIN) + r'.*?' + re.escape(END) + r'\n?', '', old, flags=re.S).rstrip('\n')
        if os.environ.get('GO_MODE') == 'counted':   # after the approvals worker is deployed: count every click
            lines = ['/go/*   https://bookedout-approvals.rickey-38a.workers.dev/go/:splat   200!']
        block = '\n'.join([BEGIN] + lines + ['/go/*   /   302', END])
        # tracked links must come BEFORE any catch-all rules, so put them first
        open(path, 'w').write(block + '\n' + (old + '\n' if old else ''))
        print(f'{path}: {len(lines)} tracked links')


def kv_bulk(path):
    """Writes the go:<code> -> target map for `npx wrangler kv bulk put --binding APPROVALS <path>` (counted mode)."""
    json.dump([{'key': 'go:' + c, 'value': e['target']} for c, e in load().items()], open(path, 'w'))


if __name__ == '__main__':
    if sys.argv[1:2] == ['kv']: kv_bulk(sys.argv[2])
    elif sys.argv[1:] == ['write']: write_redirects()
    else: print(json.dumps(load(), indent=1))
