"""Quality gate tests: bad posts must be caught, good ones must pass. python3 content-system/tests/run_tests.py"""
import os, sys, json
HERE = os.path.dirname(os.path.abspath(__file__)); CS = os.path.dirname(HERE)
sys.path.insert(0, CS)
import gate
gate._net_ok = False   # tests never depend on the network
L = 'https://getbookedoutsolutions.com/free-look'
good_fb = {'brand': 'booked-out', 'platform': 'facebook', 'comment_prompt': 'Did yours pass? Reply PASS or FAIL.',
           'text': 'Open your site on your phone.\n\nDid yours pass? Reply PASS or FAIL.\n\nFree look: ' + L, 'link': L}
cases = [
 ('good facebook post passes', good_fb, True),
 ('two links fail', dict(good_fb, text=good_fb['text'] + ' https://getbookedoutsolutions.com/'), None),   # auto-fix removes one
 ('price is held', dict(good_fb, text='Only $499 a month!\n\n' + good_fb['text']), False),
 ('income claim is held', dict(good_fb, text='We will get you 20 more jobs.\n\n' + good_fb['text']), False),
 ('slop phrase held', dict(good_fb, text='Unlock your potential in the ever-evolving landscape of HVAC.\n\n' + good_fb['text']), False),
 ('missing prompt held', dict(good_fb, comment_prompt=''), False),
 ('x too long held', {'brand': 'booked-out', 'platform': 'x', 'comment_prompt': 'Yes?', 'text': 'word ' * 70 + 'Yes?'}, False),
 ('x with link gets fixed', {'brand': 'booked-out', 'platform': 'x', 'comment_prompt': 'Yes?', 'text': 'Tip. ' + L + ' Yes?'}, True),
 ('instagram needs link in bio (fixed)', {'brand': 'booked-out', 'platform': 'instagram', 'comment_prompt': 'Yes?', 'text': 'Tip.\n\nYes?'}, True),
 ('broken link held', dict(good_fb, link='https://getbookedoutsolutions.com/nope', text=good_fb['text'].replace(L, 'https://getbookedoutsolutions.com/nope')), False),
 ('SR asks for personal story held', {'brand': 'stones-river', 'platform': 'facebook', 'comment_prompt': 'Share your story below?',
   'text': 'Sleep tips.\n\nShare your story below?\n\nhttps://stonesrivertherapy.com/book.html', 'link': 'https://stonesrivertherapy.com/book.html'}, False),
 ('SR crisis topic without 988 gets fixed', {'brand': 'stones-river', 'platform': 'facebook', 'comment_prompt': 'Save this for a hard day.',
   'text': 'Grief comes in waves.\n\nSave this for a hard day.\n\nhttps://stonesrivertherapy.com/book.html', 'link': 'https://stonesrivertherapy.com/book.html'}, True),
 ('SR client story held', {'brand': 'stones-river', 'platform': 'facebook', 'comment_prompt': 'Save this.',
   'text': 'A client of mine once said sleep fixed everything.\n\nSave this.\n\nhttps://stonesrivertherapy.com/book.html', 'link': 'https://stonesrivertherapy.com/book.html'}, False),
 ('testimonial held', dict(good_fb, text='"Best plumber we ever had" - Karen S.\n\n' + good_fb['text']), False),
]
bad = 0
for name, piece, want in cases:
    r = gate.check_and_fix(piece, log=False)
    got = r['ok']
    okk = (got == want) if want is not None else got
    bad += not okk
    print(('ok  ' if okk else 'FAIL') + f' {name}: ok={got} {r["errors"][:2]}')
print('ALL PASS' if not bad else f'{bad} FAILED'); sys.exit(bad)
