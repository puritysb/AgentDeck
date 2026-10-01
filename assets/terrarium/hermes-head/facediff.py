"""Face-mask diff images: red = reference only, blue = model only, grey = both.
  python3.13 facediff.py <render_dir>  -> <render_dir>/facediff.png"""
import os, subprocess, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
D = sys.argv[1]
def load(p, ch):
    raw = subprocess.run(["magick", p, "-depth", "8", f"{ch}:-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(600, 660, len(ch)).astype(int)
def fill(mk):
    out = np.zeros_like(mk)
    for y in range(mk.shape[0]):
        xs = np.nonzero(mk[y])[0]
        if len(xs):
            out[y, xs[0]:xs[-1] + 1] = True
    return out
panels = []
for v in ("front", "profile"):
    r = load(os.path.join(HERE, "ref", f"{v}.png"), "rgb")
    rs = fill((r[..., 0] > 150) & (r[..., 0] - r[..., 2] > 5))
    m = load(os.path.join(D, f"{v}-id.png"), "rgba")
    ms = fill((m[..., 3] > 127) & (m[..., 0] > 160))
    img = np.zeros((600, 660, 3), np.uint8) + 30
    img[rs & ~ms] = (230, 60, 60); img[ms & ~rs] = (60, 120, 240); img[rs & ms] = (220, 220, 220)
    p = os.path.join(D, f"{v}-facediff.png")
    subprocess.run(["magick", "-size", "660x600", "-depth", "8", "rgb:-", p], input=img.tobytes(), check=True)
    panels.append(p)
subprocess.run(["magick", *panels, "+append", os.path.join(D, "facediff.png")], check=True)
