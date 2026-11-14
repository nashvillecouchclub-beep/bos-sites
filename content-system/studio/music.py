"""Original background music made in code (no licensed music, nothing to credit, safe on every platform).

  python3 content-system/studio/music.py <seconds> <out.wav> [mood] [seed]
  mood: "drive" (Booked Out: warm, steady, a little forward) | "calm" (Stones River: slow pads, soft bells)
"""
import sys, wave, numpy as np

SR = 44100


def _env(n, a, r):
    e = np.ones(n)
    a, r = int(a * SR), int(r * SR)
    if a: e[:a] = np.linspace(0, 1, a)
    if r: e[-r:] *= np.linspace(1, 0, r)
    return e


def _note(freq, dur, kind='pad', vol=0.2):
    n = int(dur * SR)
    t = np.arange(n) / SR
    if kind == 'pad':
        w = sum(np.sin(2 * np.pi * freq * m * t + np.sin(2 * np.pi * 0.2 * t) * 0.3) / (m * 1.6) for m in (1, 2, 3))
        w += 0.5 * np.sin(2 * np.pi * freq * 1.003 * t)
        return vol * w * _env(n, min(1.2, dur / 3), min(1.5, dur / 2))
    if kind == 'pluck':
        w = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * freq * 2 * t) + 0.12 * np.sin(2 * np.pi * freq * 3 * t)
        return vol * w * np.exp(-t * 5.5) * _env(n, 0.004, 0.05)
    if kind == 'bell':
        w = np.sin(2 * np.pi * freq * t) + 0.4 * np.sin(2 * np.pi * freq * 2.76 * t) * np.exp(-t * 3)
        return vol * w * np.exp(-t * 1.6) * _env(n, 0.01, 0.2)
    if kind == 'kick':
        f = 110 * np.exp(-t * 18) + 42
        return vol * np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)
    if kind == 'hat':
        rng = np.random.default_rng(int(freq))
        return vol * rng.standard_normal(n) * np.exp(-t * 60) * 0.3


def _add(buf, sig, at):
    i = int(at * SR)
    j = min(len(buf), i + len(sig))
    if i < len(buf): buf[i:j] += sig[: j - i]


def hz(m): return 440 * 2 ** ((m - 69) / 12)


def make(seconds, mood='drive', seed=1):
    rng = np.random.default_rng(seed)
    L = np.zeros(int(seconds * SR) + SR)
    R = np.zeros_like(L)
    if mood == 'calm':
        bpm, prog = 66, [[57, 64, 69, 72], [53, 60, 65, 69], [48, 55, 64, 67], [55, 62, 67, 71]]   # Am F C G
    else:
        bpm, prog = 92, [[48, 55, 64, 67], [45, 52, 60, 64], [41, 48, 57, 60], [43, 50, 59, 62]]   # C Am F G
    beat = 60 / bpm
    bar = beat * 4
    t, k = 0.0, 0
    while t < seconds:
        ch = prog[k % 4]
        for i, m in enumerate(ch):
            s = _note(hz(m), bar * 1.05, 'pad', 0.05 if mood == 'drive' else 0.06)
            pan = 0.3 + 0.4 * (i / 3)
            _add(L, s * (1 - pan), t); _add(R, s * pan, t)
        if mood == 'drive':
            arp = [ch[1] + 12, ch[2] + 12, ch[3] + 12, ch[2] + 12]
            for b in range(8):
                s = _note(hz(arp[b % 4]), beat * 0.6, 'pluck', 0.06)
                _add(L, s * 0.6, t + b * beat / 2); _add(R, s * 0.4, t + b * beat / 2 + 0.012)
            if t > bar * 0.99:
                for b in range(4):
                    s = _note(0, beat, 'kick', 0.16); _add(L, s, t + b * beat); _add(R, s, t + b * beat)
                    h = _note(1000 + b, 0.06, 'hat', 0.05); _add(L, h * .4, t + b * beat + beat / 2); _add(R, h * .6, t + b * beat + beat / 2)
        else:
            for b in (0, 2.5):
                m = rng.choice(ch) + 24
                s = _note(hz(m), 3.0, 'bell', 0.035)
                _add(L, s * 0.55, t + b * beat); _add(R, s * 0.45, t + b * beat + 0.02)
        t += bar
        k += 1
    n = int(seconds * SR)
    st = np.stack([L[:n], R[:n]], 1)
    # simple room: two short echoes
    for d, g in ((0.11, 0.18), (0.23, 0.1)):
        di = int(d * SR)
        st[di:] += g * st[:-di][:, ::-1]
    fade = np.ones(n); fi, fo = int(0.8 * SR), int(2.0 * SR)
    fade[:fi] = np.linspace(0, 1, fi); fade[-fo:] = np.linspace(1, 0, fo)
    st *= fade[:, None]
    st /= max(1e-9, np.abs(st).max()) / 0.5   # leave headroom; music sits under the words
    return st


def write(path, seconds, mood='drive', seed=1):
    st = make(seconds, mood, seed)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes((st * 32767).astype('<i2').tobytes())


if __name__ == '__main__':
    write(sys.argv[2], float(sys.argv[1]), sys.argv[3] if len(sys.argv) > 3 else 'drive', int(sys.argv[4]) if len(sys.argv) > 4 else 1)
