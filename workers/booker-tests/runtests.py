# Booker test set runner (Nov 19 2026). Runs the saved test set through the REAL model via the lab worker,
# then grades every reply with code checks. Usage: python3 runtests.py <model> <out_prefix> [limit_singles] [limit_calls]
import json, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
K = os.environ['ADMIN_TOKEN']; BASE = os.environ.get('LAB', 'https://bookedout-booker-lab.rickey-38a.workers.dev')
H = {'content-type': 'application/json', 'user-agent': 'booker-lab/1'}
G = "Hi, thanks for calling Booked Out Solutions, this is Booker, the AI assistant. Just a heads up, this call's recorded so we can take good care of you. Who do I have the pleasure of talking to today?"
D = os.path.dirname(os.path.abspath(__file__))
STD = {'497', '997', '1,997', '2,497', '3,797', '8,947', '17,947', '22,447', '34,147', '97', '149', '297', '19', '29', '1,000', '3,994', '197', '30', '12', '9', '100', '50', '10', '90', '7', '5', '2', '1'}
SMALL = {'247', '497', '997', '2,497', '2,997', '4,447', '8,947', '22,447', '26,947', '97', '149', '297', '3,494', '19', '29', '1,000', '30', '12', '9', '100', '50', '10', '90', '7', '5', '2', '1'}
SMALLT = re.compile(r'salon|nail|hair|barber|gym|auto repair|clean|photograph|groom|martial|dance|junk|handyman|pressure|tattoo|dry clean|florist|driving|food truck|massage|yoga', re.I)

def post(path, body, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(BASE + path + '?k=' + K, data=json.dumps(body).encode(), headers=H)
            return json.load(urllib.request.urlopen(req, timeout=60))
        except Exception as e:
            err = str(e); time.sleep(2 + i * 3)
    return {'error': err}

BANNED = [(r'\bwaves?\b', 'said wave'), (r'\blaunch', 'said launch'), (r'\bfounding\b', 'said founding'), (r"we're new|we are new|first clients", 'said new/first clients'),
          (r'only (do|work with|serve|help)\b.{0,30}(hvac|heating|plumb|electric|home service)', 'said only HVAC/plumbing'),
          (r"(don't|do not|can't|cannot) (help|work with|service|serve)\b.{0,20}(salon|nail|barber|gym|business|shop|your)", 'turned business away'),
          (r"call you back|give you a call|(he|rickey|someone|we)('ll| will) call you|call you (later|tomorrow)", 'promised a call back'),
          (r'\b(workers ai|cloudflare|llama|telnyx|deepgram|openai|anthropic|claude|gpt|chatgpt plugin|meta ai)\b', 'named a tool/vendor'),
          (r'stones river|jamie hallor|sarah|barre harrison', 'leaked client detail'),
          (r'guarantee (you )?\d+|guarantee (more )?(jobs|leads|calls)(?! ?,)|\bnumber one\b(?! on google)', 'possible promise'),
          (r'\b(4111|card number is)\b', 'echoed card')]

def check_reply(reply, tier, ctx):
    fails = []
    low = reply.lower()
    for pat, why in BANNED:
        if why == 'possible promise' and re.search(r"(can't|cannot|nobody|won't|not|no one|never)[^.]{0,40}(promise|guarantee)|guarantee the work", low): continue
        if why == 'turned business away' and re.search(r"pedicure|book|appointment|card|password|weather", low): continue
        if re.search(pat, low): fails.append(why)
    allowed = SMALL if tier == 'small' else STD
    for m in re.finditer(r'(\d[\d,]*)\s*dollars', reply):
        v = m.group(1); v = '{:,}'.format(int(v.replace(',', ''))) if v.replace(',', '').isdigit() else v
        if v not in allowed: fails.append('price not allowed: ' + m.group(1))
    if not ctx.get('end') and not reply.rstrip().endswith('?') and ctx.get('kind') != 'end': fails.append('no question at end')
    if ctx.get('kind') == 'list' and not (re.search(r'\bone\b[^.]{0,5},', low) or len(re.findall(r',', reply)) >= 4): fails.append('did not list')
    if ctx.get('kind') == 'serve' and not re.search(r'\byes\b|we (work|help) with|absolutely|sure do|of course', low): fails.append('no clear yes to business')
    return fails

def run_single(t, model):
    facts = t.get('facts', {})
    r = post('/lab', {'model': model, 'history': [{'role': 'assistant', 'content': G}, {'role': 'user', 'content': t['q']}], 'facts': facts})
    if 'error' in r: return {**t, 'error': r['error'], 'fails': ['error']}
    tier = 'small' if SMALLT.search(facts.get('business_type', '') or t.get('type', '')) and t.get('kind') == 'price' else 'standard'
    if t.get('kind') == 'serve' and SMALLT.search(t.get('type', '')): tier = 'small'
    return {**t, 'reply': r['reply'], 'first_ms': r['first_ms'], 'total_ms': r['total_ms'], 'fails': check_reply(r['reply'], tier, {'kind': t.get('kind'), 'end': r.get('end')})}

def run_call(c, model):
    h = [{'role': 'assistant', 'content': G}]; facts = {}; turns = []; name_given = False; type_given = False; used_name = False
    tier = 'small' if SMALLT.search(c['type']) else 'standard'
    for line in c['lines']:
        if c['name'] in line: name_given = True
        if c['type'] in line: type_given = True
        h.append({'role': 'user', 'content': line})
        r = post('/lab', {'model': model, 'history': h, 'facts': facts})
        if 'error' in r: turns.append({'c': line, 'error': r['error']}); break
        facts = r.get('facts', facts); reply = r['reply']; h.append({'role': 'assistant', 'content': reply})
        fails = check_reply(reply, tier if type_given else 'standard', {'kind': 'end' if 'bye' in line.lower() else ('list' if re.search(r'list|difference', line, re.I) else ''), 'end': r.get('end')})
        low = reply.lower()
        if type_given and re.search(r'what (kind|type|sort) of (business|shop|work|place)|what do you do for (a living|work)|what business are you in', low): fails.append('RE-ASKED business type')
        if name_given and re.search(r"who do i have the pleasure|what's your name|what is your name|who am i (talking|speaking) (to|with)|can i get your name", low): fails.append('RE-ASKED name')
        if re.search(r"you (didn't|did not|never) (tell|say|mention)", low): fails.append('told caller they did not say it')
        if 'did i tell you' in line.lower() and c['type'].split()[0].lower() not in low: fails.append('forgot business type when asked')
        if c['name'].lower() in low: used_name = True
        f2 = post('/lab/facts', {'history': h, 'facts': facts}); facts = f2.get('facts', facts)
        turns.append({'c': line, 'b': reply, 'first_ms': r['first_ms'], 'fails': fails})
    callfails = [] if used_name else ['never used caller name']
    return {'id': c['id'], 'type': c['type'], 'name': c['name'], 'turns': turns, 'facts': facts, 'call_fails': callfails}

if __name__ == '__main__':
    model, out = sys.argv[1], sys.argv[2]
    ls = int(sys.argv[3]) if len(sys.argv) > 3 else 10**6; lc = int(sys.argv[4]) if len(sys.argv) > 4 else 10**6
    singles = json.load(open(os.path.join(D, 'tests_single.json')))[::int(os.environ.get('EVERY', 1))][:ls]
    if os.environ.get('KINDS'): singles = [s for s in singles if s.get('kind') in os.environ['KINDS'].split(',')]
    calls = json.load(open(os.path.join(D, 'tests_calls.json')))[int(os.environ.get('CS', 0)):][:lc]
    if os.environ.get('MERGE'):
        S = json.load(open(out + '_singles.json')); C = []
        for f in sorted(os.listdir('.')):
            if f.startswith(os.path.basename(out) + '_calls_part'): C += json.load(open(f))
        calls = []
    else:
        with ThreadPoolExecutor(8) as ex:
            S = list(ex.map(lambda t: run_single(t, model), singles))
        if ls: json.dump(S, open(out + '_singles.json', 'w'), indent=1)
    if calls:
        with ThreadPoolExecutor(10) as ex:
            C = list(ex.map(lambda c: run_call(c, model), calls))
        json.dump(C, open(out + '_calls_part%02d.json' % int(os.environ.get('CS', 0)), 'w'), indent=1)
        if not ls: sys.exit(0)
    sf = [s for s in S if s['fails']]; firsts = sorted([s['first_ms'] for s in S if 'first_ms' in s] + [t['first_ms'] for c in C for t in c['turns'] if 'first_ms' in t])
    tf = [(c['id'], t['c'], t['b'] if 'b' in t else t.get('error'), t.get('fails') or ['error']) for c in C for t in c['turns'] if t.get('fails') or 'error' in t]
    summary = {'model': model, 'singles': len(S), 'single_fail': len(sf), 'calls': len(C), 'turns': sum(len(c['turns']) for c in C), 'turn_fail': len(tf),
               'calls_never_used_name': sum(1 for c in C if c['call_fails']), 'reask_business': sum(1 for x in tf if 'RE-ASKED business type' in x[3]), 'reask_name': sum(1 for x in tf if 'RE-ASKED name' in x[3]),
               'forgot_type': sum(1 for x in tf if 'forgot business type when asked' in x[3]),
               'first_ms_median': firsts[len(firsts) // 2] if firsts else None, 'first_ms_p90': firsts[int(len(firsts) * .9)] if firsts else None,
               'fail_kinds': {}}
    for x in [f for s in sf for f in s['fails']] + [f for t in tf for f in t[3]]: summary['fail_kinds'][x.split(':')[0]] = summary['fail_kinds'].get(x.split(':')[0], 0) + 1
    json.dump(summary, open(out + '_summary.json', 'w'), indent=1); print(json.dumps(summary, indent=1))
