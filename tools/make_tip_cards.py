"""Make Booked Out tip image cards (1080x1080) in the same style as tip-01..tip-40.

Usage: python3 tools/make_tip_cards.py 41 70
Reads headlines from content/booked-out/posts.json, writes
sites/getbookedoutsolutions.com/img/social/tip-NN.png.
The logo is copied from tip-01.png so it matches exactly.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "sites/getbookedoutsolutions.com/img/social"
FONTS = "/usr/share/fonts/opentype/inter/"

BG = (10, 15, 38)
GOLD = (255, 178, 36)
WHITE = (245, 246, 250)
GREY = (170, 180, 210)
X = 92
MAXW = 1080 - 2 * X
FOOT = "For heating and air, plumbing and electrical shops"


def font(name, size):
    return ImageFont.truetype(FONTS + name, size)


def wrap(text, ft, maxw):
    words, lines, cur = text.split(), [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if ft.getlength(t) <= maxw:
            cur = t
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    return lines


def card(n, headline, logo):
    im = Image.new("RGB", (1080, 1080), BG)
    im.paste(logo, (0, 0))
    d = ImageDraw.Draw(im)
    d.text((183, 125), "Booked Out Solutions", font=font("Inter-Medium.otf", 36), fill=WHITE, anchor="lm")
    d.text((X - 1, 337), f"TIP {n}", font=font("Inter-Bold.otf", 37), fill=GOLD, anchor="ls")
    size = 80
    hf = font("Inter-Bold.otf", size)
    lines = wrap(headline, hf, MAXW)
    while len(lines) > 4:
        size -= 4
        hf = font("Inter-Bold.otf", size)
        lines = wrap(headline, hf, MAXW)
    lh = int(size * 1.25)
    base = 450
    for i, ln in enumerate(lines):
        d.text((X - 2, base + i * lh), ln, font=hf, fill=WHITE, anchor="ls")
    d.text((X - 1, 988), FOOT, font=font("Inter-Regular.otf", 30), fill=GREY, anchor="ls")
    return im


def main(a, b):
    posts = {p["n"]: p for p in json.load(open(ROOT / "content/booked-out/posts.json"))["posts"]}
    logo = Image.open(OUT / "tip-01.png").convert("RGB").crop((0, 0, 175, 200))
    for n in range(a, b + 1):
        card(n, posts[n]["headline"], logo).save(OUT / f"tip-{n:02d}.png", optimize=True)
        print("made", f"tip-{n:02d}.png")


if __name__ == "__main__":
    main(int(sys.argv[1]), int(sys.argv[2]))
