"""Side-by-side of the installed model (master_look.py renders) with the concepts.

  python3.13 look_compare.py <look_dir> <fit_render>
<fit_render> is a `render_views.py --like` y32_e4.png of the current blockout;
its fitted 2D transform (fit_master_camera.fit_one) warps look-master.png into
master space. Writes <look_dir>/compare.png:
  row 1: master | model at master camera | model + master silhouette/face lines
  row 2: head-study front | model front | head-study profile | model profile
"""
import os, subprocess, sys
import numpy as np
D, FIT = sys.argv[1], sys.argv[2]
sys.argv = sys.argv[:1]
import fit_master_camera as F

t = F.fit_one(FIT)
img = F.load(os.path.join(D, "look-master.png"), "rgba", 400, 400)
c, sn = np.cos(np.radians(t["roll"])), np.sin(np.radians(t["roll"]))
u = (F.uu - F.mcx - t["dx"]) / t["s"]; v = (F.vv - F.mcy - t["dy"]) / t["s"]
x = np.round(c * u + sn * v + t["cx"]).astype(int); y = np.round(-sn * u + c * v + t["cy"]).astype(int)
ok = (x >= 0) & (x < 400) & (y >= 0) & (y < 400)
bg = np.array([7, 46, 65])
w = np.zeros((F.MH, F.MW, 3), np.uint8) + bg.astype(np.uint8)
w[ok] = img[y[ok], x[ok], :3]
a = F.load(os.path.join(F.HERE, "ref", "master-tq.png"), "rgb", F.MW, F.MH)
sil = ~(a[..., 2] - a[..., 0] > 35); sil[:, 560:] = False
skin = (a[..., 0] > 150) & (a[..., 0] - a[..., 2] > 5) & (F.vv < F.CHIN_ROW)


def edge(m):
    e = np.zeros_like(m)
    e[1:-1, 1:-1] = m[1:-1, 1:-1] & ~(m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:])
    return e | np.roll(e, 1, 0) | np.roll(e, 1, 1)


lined = w.copy(); lined[edge(sil)] = (80, 220, 255); lined[edge(skin)] = (255, 214, 64)


def save(arr, name):
    p = os.path.join(D, name)
    subprocess.run(["magick", "-size", f"{arr.shape[1]}x{arr.shape[0]}", "-depth", "8", "rgb:-", p], input=arr.tobytes(), check=True)
    return p


pm, pl = save(w, "reg-master.png"), save(lined, "reg-master-lines.png")
row1 = os.path.join(D, "row1.png")
subprocess.run(["magick", os.path.join(F.HERE, "ref", "master-tq.png"), pm, pl, "+append", row1], check=True)
row2 = os.path.join(D, "row2.png")
subprocess.run(["magick", os.path.join(F.HERE, "ref", "front.png"), os.path.join(D, "look-front.png"),
                os.path.join(F.HERE, "ref", "profile.png"), os.path.join(D, "look-profile.png"), "+append",
                "-resize", "1860x", row2], check=True)
subprocess.run(["magick", row1, row2, "-append", os.path.join(D, "compare.png")], check=True)
print(os.path.join(D, "compare.png"))
