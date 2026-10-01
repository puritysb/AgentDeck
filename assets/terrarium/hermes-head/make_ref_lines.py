"""Write ref/<view>-lines.png: reference face contour (yellow) and full silhouette
(cyan) as transparent line art, registered to the 660x600 review cameras.
  python3.13 make_ref_lines.py   (needs magick on PATH)"""
import os, subprocess
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
for v in ("front", "profile"):
    src = os.path.join(HERE, "ref", f"{v}.png")
    raw = subprocess.run(["magick", src, "-depth", "8", "rgb:-"], capture_output=True, check=True).stdout
    a = np.frombuffer(raw, np.uint8).reshape(600, 660, 3).astype(int)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    fg = ~((B - R > 35) & (R < 30))
    skin = (R > 150) & (R - B > 5)
    def edge(m):
        e = np.zeros_like(m)
        e[1:-1, 1:-1] = m[1:-1, 1:-1] & ~(m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:])
        e2 = e.copy()
        e2[1:, :] |= e[:-1, :]; e2[:, 1:] |= e[:, :-1]
        return e2
    out = np.zeros((600, 660, 4), np.uint8)
    out[edge(fg)] = (80, 220, 255, 255)
    out[edge(skin)] = (255, 214, 64, 255)
    p = subprocess.run(["magick", "-size", "660x600", "-depth", "8", "rgba:-",
                        os.path.join(HERE, "ref", f"{v}-lines.png")], input=out.tobytes(), check=True)
print("ok")
