"""Landmark-level comparison at the master camera (run after run_master.sh).
  python3.13 master_metrics.py <dir>
Prints, in master pixels and in model units (px / (scale * 400/7)), where the
model's crown, bang line, chin, face extents and hair back/front sit relative to
the master's."""
import os, sys
import numpy as np
D = sys.argv[1]
sys.argv = sys.argv[:1]
import fit_master_camera as F
t = F.fit_one(os.path.join(D, "like", "y32_e4.png"))
px_per_unit = t["s"] * 400 / 7.0


def warp_rgba(p):
    img = F.load(p, "rgba", 400, 400)
    c, sn = np.cos(np.radians(t["roll"])), np.sin(np.radians(t["roll"]))
    u = (F.uu - F.mcx - t["dx"]) / t["s"]; v = (F.vv - F.mcy - t["dy"]) / t["s"]
    x = np.round(c * u + sn * v + t["cx"]).astype(int); y = np.round(-sn * u + c * v + t["cy"]).astype(int)
    ok = (x >= 0) & (x < 400) & (y >= 0) & (y < 400)
    out = np.zeros((F.MH, F.MW, 4), int); out[ok] = img[y[ok], x[ok]]; return out


w = warp_rgba(os.path.join(D, "like", "y32_e4.png"))
m_sil = w[..., 3] > 127
m_face = F.fill_rows(m_sil & (w[..., 0] > 150) & (w[..., 0] - w[..., 2] > -8) & (F.vv < 470))
a = F.load(os.path.join(F.HERE, "ref", "master-tq.png"), "rgb", F.MW, F.MH)
r_sil = ~(a[..., 2] - a[..., 0] > 35)
r_face = F.fill_rows((a[..., 0] > 150) & (a[..., 0] - a[..., 2] > 5) & (F.vv < F.CHIN_ROW))


def rows_of(m):
    r = np.nonzero(m.any(1))[0]; return r[0], r[-1]


def report(name, rv, mv):
    print(f"  {name:34s} master {rv:6.1f}  model {mv:6.1f}  diff {mv - rv:+6.1f}px = {(mv - rv) / px_per_unit:+.2f}u")


print(f"px per unit {px_per_unit:.1f}")
rt, rb = rows_of(r_face); mt, mb = rows_of(m_face)
report("face top row (bang at face)", rt, mt)
report("face bottom row (chin)", rb, mb)
report("face height", rb - rt, mb - mt)
report("crown row", rows_of(r_sil[:300])[0], rows_of(m_sil[:300])[0])
for row in (150, 250, 330):
    rx = np.nonzero(r_sil[row])[0]; mx = np.nonzero(m_sil[row])[0]
    report(f"row {row}: hair front x", rx[0], mx[0])
    report(f"row {row}: hair back x", rx[-1], mx[-1])
for row in (280, 330, 380):
    rx = np.nonzero(r_face[row])[0]; mx = np.nonzero(m_face[row])[0]
    if len(rx) and len(mx):
        report(f"row {row}: face near edge x", rx[0], mx[0]); report(f"row {row}: face far edge x", rx[-1], mx[-1])
ra = r_face.sum(); ma = m_face.sum()
rh = (r_sil & (F.vv < 300)).sum(); mh = (m_sil & (F.vv < 300)).sum()
print(f"  face area master {ra} model {ma} ({ma / ra:.2f}x); dome area (rows<300) master {rh} model {mh} ({mh / rh:.2f}x)")
print(f"  face / dome ratio: master {ra / rh:.3f} model {ma / mh:.3f}")
