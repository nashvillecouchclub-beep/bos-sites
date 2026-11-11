"""Writes files.json (path -> sha1) for every site under sites/. Run before each commit."""
import hashlib, json, os, sys
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sites')
for d in sorted(os.listdir(root)):
    base = os.path.join(root, d); m = {}
    for r, _, fs in os.walk(base):
        for f in fs:
            if f.startswith('.') or f == 'files.json': continue
            p = os.path.join(r, f); m['/' + os.path.relpath(p, base).replace(os.sep, '/')] = hashlib.sha1(open(p, 'rb').read()).hexdigest()
    json.dump(dict(sorted(m.items())), open(os.path.join(base, 'files.json'), 'w'), indent=0)
    print(d, len(m), 'files')
