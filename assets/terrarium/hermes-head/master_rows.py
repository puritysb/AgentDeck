"""Per-row silhouette extents at the master camera (run after run_master.sh).
  python3.13 master_rows.py <dir> [row0 row1 step]
Prints master vs model leftmost/rightmost silhouette x per row, in model units
(+ = model sticks out further). Rows are master pixels (560 tall)."""
import os, sys
import numpy as np
D = sys.argv[1]; r0, r1, st = (map(int, sys.argv[2:5]) if len(sys.argv) > 4 else (60, 470, 30))
sys.argv = sys.argv[:1]
import fit_master_camera as F
t = F.fit_one(os.path.join(D, "like", "y32_e4.png"))
ppu = t["s"] * 400 / 7.0
img = F.load(os.path.join(D, "like", "y32_e4.png"), "rgba", 400, 400)
c, sn = np.cos(np.radians(t["roll"])), np.sin(np.radians(t["roll"]))
u = (F.uu - F.mcx - t["dx"]) / t["s"]; v = (F.vv - F.mcy - t["dy"]) / t["s"]
x = np.round(c * u + sn * v + t["cx"]).astype(int); y = np.round(-sn * u + c * v + t["cy"]).astype(int)
ok = (x >= 0) & (x < 400) & (y >= 0) & (y < 400)
msil = np.zeros((F.MH, F.MW), bool); msil[ok] = img[y[ok], x[ok], 3] > 127
a = F.load(os.path.join(F.HERE, "ref", "master-tq.png"), "rgb", F.MW, F.MH)
rsil = ~(a[..., 2] - a[..., 0] > 35)
rsil[:, 560:] = False          # the neighbouring concept head at the crop's right edge
for row in range(r0, r1, st):
    rx = np.nonzero(rsil[row])[0]; mx = np.nonzero(msil[row])[0]
    if len(rx) and len(mx):
        print(f"row {row:3d}  left: master {rx[0]:3d} model {mx[0]:3d} ({(rx[0]-mx[0])/ppu:+.2f})"
              f"   right: master {rx[-1]:3d} model {mx[-1]:3d} ({(mx[-1]-rx[-1])/ppu:+.2f})")
