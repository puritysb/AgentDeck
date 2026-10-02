"""Silhouette and exposed-face IoU of a review render against the reference crop.
  python3.13 score.py <render_dir>     (Blender's python + magick)
Diagnostic only: the reference is a generated proposal, not calibrated geometry."""
import os, subprocess, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
def load(p, ch):
    raw = subprocess.run(["magick", p, "-depth", "8", f"{ch}:-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(600, 660, len(ch)).astype(int)
for v in ("front", "profile"):
    r = load(os.path.join(HERE, "ref", f"{v}.png"), "rgb")
    R, G, B = r[..., 0], r[..., 1], r[..., 2]
    ref_fg = ~((B - R > 35) & (R < 30))
    ref_skin = (R > 150) & (R - B > 5)
    m = load(os.path.join(sys.argv[1], f"{v}-id.png"), "rgba")
    mod_fg = m[..., 3] > 127
    mod_skin = mod_fg & (m[..., 0] > 160)
    # compare the face only above the neck line (chin z=0 -> row 475)
    rows = np.arange(600)[:, None] < 475
    def fill(mk):  # row-wise span fill: eyes/brows/lips are face, not holes
        out = np.zeros_like(mk)
        for y in range(mk.shape[0]):
            xs = np.nonzero(mk[y])[0]
            if len(xs):
                out[y, xs[0]:xs[-1] + 1] = True
        return out
    ref_skin, mod_skin = fill(ref_skin), fill(mod_skin)
    iou = lambda a, b: (a & b).sum() / max(1, (a | b).sum())
    print(f"{v:8s} silhouette IoU {iou(ref_fg, mod_fg):.3f}   exposed face IoU {iou(ref_skin & rows, mod_skin & rows):.3f}")
