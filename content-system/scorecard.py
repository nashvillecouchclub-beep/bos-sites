"""WEEKLY SCORECARD - one page: followers, clicks, newsletter signups, free-look requests, best and worst posts by platform.

  python3 content-system/scorecard.py <metrics.json> <out-dir>

The Monday scheduled task gathers metrics.json with the connected tools (Buffer post metrics, Metricool analytics,
beehiiv/MailerLite subscriber counts, Gmail for free-look requests, the /clicks counter once the worker is live)
and runs this. Writes <out-dir>/scorecard-YYYY-MM-DD.html (the one page), .md (for the project doc) and
next_topics.json (which kickers/topics won, so next week's writing leans toward them).

metrics.json:
 {"week_start": "2026-11-16", "week_end": "2026-11-22", "brand": "booked-out",
  "followers": {"instagram": [start, end], "facebook": [s, e], "x": [s, e], "pinterest": [s, e], "youtube": [s, e]},
  "newsletter": {"subscribers": [s, e], "source": "beehiiv"}, "free_look_requests": 0,
  "clicks": {"bo07f": 12, ...},                                  # optional (worker /clicks or Buffer link clicks)
  "posts": [{"platform": "instagram", "tip": 7, "kicker": "PHONE CALLS", "headline": "...", "impressions": 0,
             "engagements": 0, "comments": 0, "clicks": 0, "url": "..."}],
  "notes": ["anything that could not be measured and why"]}
Nothing is estimated: a number we could not get shows as "not available" with the reason.
"""
import json, os, sys, html, datetime, collections


def score(p):
    imp = p.get('impressions') or 0
    eng = (p.get('engagements') or 0) + 3 * (p.get('comments') or 0) + 5 * (p.get('clicks') or 0)
    return eng / imp if imp >= 20 else None   # too few views to judge


def build(m, outdir):
    os.makedirs(outdir, exist_ok=True)
    rows, md = [], [f"# Weekly scorecard - {m.get('brand', '')} - week of {m['week_start']}", '']
    def num(v): return 'not available' if v is None else f'{v:,}'
    md.append('## Followers')
    for plat, v in (m.get('followers') or {}).items():
        if v and None not in v: md.append(f'- {plat}: {num(v[1])} ({v[1] - v[0]:+d} this week)')
        else: md.append(f'- {plat}: not available')
    nl = m.get('newsletter') or {}
    s = nl.get('subscribers')
    md += ['', '## Leads',
           f"- Newsletter subscribers: {num(s[1]) + f' ({s[1] - s[0]:+d})' if s and None not in s else 'not available'}",
           f"- Free-look requests: {num(m.get('free_look_requests'))}",
           f"- Tracked link clicks: {sum((m.get('clicks') or {}).values()) if m.get('clicks') else 'not available (click counter not live yet)'}"]
    by = collections.defaultdict(list)
    for p in m.get('posts', []):
        p['score'] = score(p)
        by[p['platform']].append(p)
    md += ['', '## Best and worst post by platform']
    winners = collections.Counter()
    for plat, ps in sorted(by.items()):
        judged = [p for p in ps if p['score'] is not None]
        if not judged:
            md.append(f'- {plat}: {len(ps)} posts, too few views to judge yet'); continue
        judged.sort(key=lambda p: p['score'], reverse=True)
        b, w = judged[0], judged[-1]
        md.append(f"- {plat}: BEST tip {b.get('tip')} \"{b.get('headline', '')}\" ({b.get('impressions')} views, {b.get('comments', 0)} comments, {b.get('clicks', 0)} clicks)"
                  + (f"; WORST tip {w.get('tip')} \"{w.get('headline', '')}\" ({w.get('impressions')} views)" if w is not b else ''))
        for p in judged[: max(1, len(judged) // 3)]: winners[p.get('kicker', '')] += 1
    topics = [k for k, _ in winners.most_common(5) if k]
    md += ['', '## Next week leans toward', ('- ' + ', '.join(topics)) if topics else '- not enough data yet; keep the normal mix']
    if m.get('notes'): md += ['', '## Could not measure'] + [f'- {n}' for n in m['notes']]
    text = '\n'.join(md)
    day = m['week_start']
    open(os.path.join(outdir, f'scorecard-{day}.md'), 'w').write(text)
    body = ''.join(f'<h2>{html.escape(l[3:])}</h2>' if l.startswith('## ') else f'<h1>{html.escape(l[2:])}</h1>' if l.startswith('# ')
                   else f'<li>{html.escape(l[2:])}</li>' if l.startswith('- ') else '' for l in md)
    open(os.path.join(outdir, f'scorecard-{day}.html'), 'w').write(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Scorecard</title>'
        '<style>body{font:18px/1.5 system-ui;max-width:760px;margin:24px auto;padding:0 16px;color:#131935}h1{font-size:28px}h2{font-size:20px;margin-top:22px;color:#0A0F26}li{margin:4px 0}</style>' + body)
    json.dump({'week': day, 'lean_toward': topics}, open(os.path.join(outdir, 'next_topics.json'), 'w'), indent=1)
    return text


if __name__ == '__main__':
    print(build(json.load(open(sys.argv[1])), sys.argv[2]))
