"""Pull client answers from the approvals API and mark pieces approved / change-requested.

  python3 content-system/approve/sync.py <token>            (needs env APPROVALS_READ_KEY)
  python3 content-system/approve/sync.py --from-email <file> (answers pasted from the email fallback)

Writes content-system/approvals/<batch_id>.json  {piece_id: {"status": "approved"|"change", "note": "...", "at": "..."}}.
The posting task schedules ONLY pieces whose status is "approved" here. Changes go back to the writer, get fixed,
re-checked by the quality gate and shown again in next week's batch.
"""
import json, os, sys, urllib.request, re
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'approvals')


def save(batch_id, answers):
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, f'{batch_id}.json')
    json.dump(answers, open(p, 'w'), indent=1)
    ok = sum(1 for v in answers.values() if v.get('status') == 'approved')
    print(f'{batch_id}: {ok} approved, {sum(1 for v in answers.values() if v.get("status") == "change")} changes')


def from_api(token):
    key = os.environ['APPROVALS_READ_KEY']
    rec = json.load(urllib.request.urlopen(f'https://getbookedoutsolutions.com/approve-api/{token}?key={key}', timeout=20))
    if rec: save(rec['batch_id'], rec['answers'])


def from_email(path, batch_path):
    batch = json.load(open(batch_path)); txt = open(path).read()
    ans = {}
    for it in batch['items']:
        m = re.search(r'(APPROVED|CHANGE|NOT YET) - [^\n]*' + re.escape(it['date']) + ': ' + re.escape(it['title']) + r'(\n   Change: ([^\n]*))?', txt)
        if m and m.group(1) != 'NOT YET':
            ans[it['id']] = {'status': 'approved' if m.group(1) == 'APPROVED' else 'change', 'note': m.group(3) or ''}
    save(batch['batch_id'], ans)


if __name__ == '__main__':
    if sys.argv[1] == '--from-email': from_email(sys.argv[2], sys.argv[3])
    else: from_api(sys.argv[1])
