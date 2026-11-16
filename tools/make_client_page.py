#!/usr/bin/env python3
"""Build one client's one-tap page for getbookedoutsolutions.com/c/<token>/.

Usage: python3 tools/make_client_page.py <spec.json> <out_dir>
Writes <out_dir>/page.html (the page) and <out_dir>/register.json (the page register the answers worker checks).
Both are uploaded to the bookedout-answers KV as html:<token> and page:<token> (the weekly client-pages task
does this through the Cloudflare dashboard API in the mini's Chrome). Specs and tokens never go in this public repo.

Spec: {token, client, client_name, week, title, kick, heading, signoff, footer:[..], done_intro, done:[..],
       sections:[{key, title, desc, batch?, items:[{id, meta, title, body:[..], sign?, serp?, choice?, kind?, guide?, input?, sha?}]}]}
Rules: max 15 items a page. Instruction cards use kind "todo" (Done / I need help).
Every page gets an "Ask a question" button on each card and a "Have a question about anything?" box at the bottom
(Rickey Nov 15 12:20 pm). Questions save apart from answers (worker q:<token>) and never count as answering a card.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_ITEMS = 15


def build(spec):
    tok = spec["token"]
    assert re.fullmatch(r"[a-f0-9]{32,64}", tok), "token must be 32-64 hex"
    items = [it for s in spec["sections"] for it in s["items"]]
    assert 0 < len(items) <= MAX_ITEMS, f"{len(items)} items: 1 to {MAX_ITEMS} per page"
    ids = [it["id"] for it in items]
    assert len(ids) == len(set(ids)), "duplicate item ids"
    for i in ids:
        assert re.fullmatch(r"[a-z0-9][a-z0-9-]{0,60}", i), "bad id " + i
    page = {k: spec.get(k) for k in ("kick", "heading", "signoff", "footer", "done_intro", "done", "sections")}
    tpl = open(os.path.join(HERE, "client_page_template.html"), encoding="utf-8").read()
    data = json.dumps(page, ensure_ascii=False).replace("</", "<\\/")
    html = tpl.replace("/*__PAGE__*/null", data).replace("__TITLE__", spec.get("title", "A few things to OK"))
    reg = {"client": spec["client"], "client_name": spec["client_name"], "week": spec.get("week", ""),
           "items": {it["id"]: {**({"title": it["title"], "choices": it["choice"]} if it.get("choice") else {"title": it["title"]}),
                                  **({"sha": it["sha"]} if it.get("sha") else {})}
                     for it in items}}
    return html, reg


if __name__ == "__main__":
    spec = json.load(open(sys.argv[1], encoding="utf-8"))
    out = sys.argv[2]
    os.makedirs(out, exist_ok=True)
    html, reg = build(spec)
    open(os.path.join(out, "page.html"), "w", encoding="utf-8").write(html)
    json.dump(reg, open(os.path.join(out, "register.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(len(html), "bytes,", len(reg["items"]), "items")
