"""Builds a narrated screen walkthrough video from real screen captures.

Input: a spec JSON (kept OUTSIDE this public repo, because raw captures can hold
private details) like:
  {"out": ".../help/<id>/walkthrough.mp4", "poster": ".../help/<id>/poster.png",
   "segments": [{"frame": "a.jpg", "audio": "00.aiff", "caption": "Step 1 ...",
                 "click": [x, y] | null, "point": [x, y] | null,
                 "blur": [[x0, y0, x1, y1], ...]}, ...,
                {"card": "That's it", "sub": "...", "audio": "06.aiff"}]}
Coordinates are in the capture's own pixels. For each segment the cursor glides
to "click" (and ripples) or to "point" (and pulses a highlight ring, no click)
while the narration plays; private areas in "blur" are blurred before anything
is drawn. Output: 1920x1080 H.264 + AAC, plus a poster image.
"""
import json, os, subprocess, sys, tempfile
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H, FPS = 1920, 1080, 30
BAR = 150
NAVY, GOLD, WHITE = (10, 15, 38), (255, 178, 36), (243, 244, 248)
F = '/usr/share/fonts/opentype/inter/'
FONT_CAP = ImageFont.truetype(F + 'Inter-SemiBold.otf', 40)
FONT_BIG = ImageFont.truetype(F + 'Inter-Bold.otf', 84)
FONT_SUB = ImageFont.truetype(F + 'Inter-Regular.otf', 42)
FONT_BRAND = ImageFont.truetype(F + 'Inter-SemiBold.otf', 34)
LOGO_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'sites', 'getbookedoutsolutions.com', 'img', 'social', 'tip-07.png')
LOGO = Image.open(LOGO_SRC).convert('RGB').crop((88, 94, 164, 163)).resize((56, 51))


def dur(path):
    out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
                         capture_output=True, text=True).stdout.strip()
    return float(out)


def ease(t):
    return t * t * (3 - 2 * t)


def prep(seg, base):
    im = Image.open(os.path.join(base, seg['frame'])).convert('RGB')
    sp = seg.get('spotlight')
    if sp:
        box = tuple(int(v) for v in sp)
        keep = im.crop(box)
        im = im.filter(ImageFilter.GaussianBlur(16))
        im = Image.blend(im, Image.new('RGB', im.size, (10, 15, 38)), 0.35)
        im.paste(keep, box)
    for b in seg.get('blur', []):
        box = tuple(int(v) for v in b)
        im.paste(im.crop(box).filter(ImageFilter.GaussianBlur(14)), box)
    sw, sh = im.size
    scale = W / sw
    shot = im.resize((W, int(sh * scale)), Image.LANCZOS)
    if shot.height > H - BAR:
        shot = shot.crop((0, 0, W, H - BAR))
    return shot, scale


def wrap(draw, text, font, maxw):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = (cur + ' ' + w).strip()
        if draw.textlength(t, font=font) <= maxw:
            cur = t
        else:
            lines.append(cur); cur = w
    lines.append(cur)
    return lines


def caption_bar(img, text):
    d = ImageDraw.Draw(img)
    top = H - BAR
    d.rectangle((0, top, W, H), fill=NAVY)
    d.rectangle((0, top, W, top + 6), fill=GOLD)
    lines = wrap(d, text, FONT_CAP, W - 160)[:2]
    y = top + (BAR - len(lines) * 52) // 2 + 4
    for ln in lines:
        d.text((80, y), ln, font=FONT_CAP, fill=WHITE); y += 52


def cursor(d, x, y):
    pts = [(x, y), (x, y + 44), (x + 11, y + 33), (x + 20, y + 52), (x + 28, y + 48), (x + 19, y + 30), (x + 34, y + 30)]
    d.polygon([(px + 2, py + 2) for px, py in pts], fill=(0, 0, 0))
    d.polygon(pts, fill=WHITE, outline=(0, 0, 0))


def card(text, sub):
    img = Image.new('RGB', (W, H), NAVY)
    d = ImageDraw.Draw(img)
    img.paste(LOGO, (96, 84)); d.text((170, 92), 'Booked Out Solutions', font=FONT_BRAND, fill=WHITE)
    y = 380
    for ln in wrap(d, text, FONT_BIG, W - 240):
        d.text((120, y), ln, font=FONT_BIG, fill=WHITE); y += 104
    y += 20
    for ln in wrap(d, sub, FONT_SUB, W - 240):
        d.text((120, y), ln, font=FONT_SUB, fill=GOLD); y += 58
    return img


def build(spec_path):
    spec = json.load(open(spec_path)); base = os.path.dirname(os.path.abspath(spec_path))
    tmp = tempfile.mkdtemp()
    ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}',
                           '-r', str(FPS), '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
                           '-pix_fmt', 'yuv420p', os.path.join(tmp, 'v.mp4')], stdin=subprocess.PIPE)
    audio_parts, cur = [], (W * 0.5, (H - BAR) * 0.55)
    poster = None
    for i, seg in enumerate(spec['segments']):
        a = os.path.join(base, seg['audio']) if seg.get('audio') else None
        d_audio = dur(a) if a else seg.get('seconds', 1.6)
        total = d_audio + (0.9 if seg.get('card') is None else 1.2) if a else d_audio
        n = int(total * FPS)
        wav = os.path.join(tmp, f'a{i:02d}.wav')
        src = ['-i', a, '-af', 'apad'] if a else ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono']
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error'] + src + ['-t', f'{n / FPS:.3f}',
                        '-ar', '44100', '-ac', '1', wav], check=True)
        audio_parts.append(wav)
        if seg.get('card') is not None:
            frame = card(seg['card'], seg.get('sub', ''))
            for _ in range(n):
                ff.stdin.write(frame.tobytes())
            continue
        shot, sc = prep(seg, base)
        target = seg.get('click') or seg.get('point')
        tx, ty = (target[0] * sc, target[1] * sc) if target else cur
        t0, t1 = int(n * 0.35), int(n * 0.70)
        for f in range(n):
            img = Image.new('RGB', (W, H), NAVY); img.paste(shot, (0, 0))
            d = ImageDraw.Draw(img, 'RGBA')
            if f <= t0:
                x, y = cur
            elif f >= t1:
                x, y = tx, ty
            else:
                k = ease((f - t0) / (t1 - t0)); x, y = cur[0] + (tx - cur[0]) * k, cur[1] + (ty - cur[1]) * k
            if target and f >= t1:
                k = (f - t1) / max(1, n - t1)
                if seg.get('click'):
                    r = 18 + 50 * min(1, k * 2)
                    alpha = int(220 * max(0, 1 - k * 1.6))
                    d.ellipse((tx - r, ty - r, tx + r, ty + r), outline=GOLD + (alpha,), width=7)
                else:
                    r = 46 + 8 * abs(((f - t1) % 30) / 15 - 1)
                    d.ellipse((tx - r, ty - r, tx + r, ty + r), outline=GOLD + (230,), width=7)
            cursor(d, x, y)
            caption_bar(img, seg['caption'])
            ff.stdin.write(img.tobytes())
            if poster is None and f == n // 2:
                poster = img.copy()
        cur = (tx, ty)
    ff.stdin.close(); ff.wait()
    lst = os.path.join(tmp, 'a.txt')
    open(lst, 'w').write(''.join(f"file '{p}'\n" for p in audio_parts))
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c:a', 'pcm_s16le',
                    os.path.join(tmp, 'a.wav')], check=True)
    os.makedirs(os.path.dirname(spec['out']), exist_ok=True)
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', os.path.join(tmp, 'v.mp4'), '-i', os.path.join(tmp, 'a.wav'),
                    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', spec['out']], check=True)
    if poster:
        poster.resize((960, 540)).save(spec['poster'])
    print('video:', spec['out'], f"{dur(spec['out']):.1f}s")


if __name__ == '__main__':
    build(sys.argv[1])
