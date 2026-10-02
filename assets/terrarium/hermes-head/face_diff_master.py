"""Face-mask diff at the master camera: red = master face only, blue = model
face only, grey = both. Uses fit_master_camera's registration of a
`render_views.py --like` render.  python3.13 face_diff_master.py <fit_png> <out_png>"""
import subprocess, sys
import numpy as np
P, OUT = sys.argv[1], sys.argv[2]
sys.argv = sys.argv[:1]
import fit_master_camera as F
t = F.fit_one(P)
face, sil, feat = F.model_masks(P)
cy, cx = np.argwhere(face).mean(0)
wf = F.warp(face, t["s"], t["roll"], cx, cy, t["dx"], t["dy"])
img = np.zeros((F.MH, F.MW, 3), np.uint8) + 25
img[F.MF & ~wf] = (230, 60, 60); img[wf & ~F.MF] = (60, 120, 240); img[wf & F.MF] = (200, 200, 200)
subprocess.run(["magick", "-size", f"{F.MW}x{F.MH}", "-depth", "8", "rgb:-", OUT], input=img.tobytes(), check=True)
rows = np.nonzero((F.MF | wf).any(1))[0]
for r in range(rows[0], rows[-1], 15):
    a = np.nonzero(F.MF[r])[0]; b = np.nonzero(wf[r])[0]
    f = lambda v: f"{v[0]:3d}-{v[-1]:3d}" if len(v) else "   -   "
    print(f"row {r}: master {f(a)}  model {f(b)}")
