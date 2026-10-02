"""Compare the blockout with the master concept at the fitted master camera.

  blender --background <blend> --python render_views.py -- <dir>/grey 32 32 1 4 4 1
  blender --background <blend> --python render_views.py -- <dir>/like 32 32 1 4 4 1 --like
  python3.13 master_overlay.py <dir>        -> <dir>/master-compare.png

The master camera (yaw 32, elevation 4, fitted 2026-10-01 by fit_master_camera.py;
the fit is flat over yaw 28-36 / elevation 0-8) is a judgment camera for an
illustration, not a calibration. Scale/roll/shift are fitted on the textured
render and applied to both. Lines: master face (yellow), master silhouette (cyan).
"""
import os, subprocess, sys
import numpy as np
sys.argv = sys.argv[:2]
import fit_master_camera as F

D = sys.argv[1]
like_p = os.path.join(D, "like", "y32_e4.png")
grey_p = os.path.join(D, "grey", "y32_e4.png")
t = F.fit_one(like_p)
print("fit: scale %.3f roll %+d shift %+d,%+d  face %.3f dome %.3f features %.3f"
      % (t["s"], t["roll"], t["dx"], t["dy"], t["face"], t["dome"], t["features"]))


def warp_rgba(p):
    img = F.load(p, "rgba", 400, 400)
    c, sn = np.cos(np.radians(t["roll"])), np.sin(np.radians(t["roll"]))
    u = (F.uu - F.mcx - t["dx"]) / t["s"]
    v = (F.vv - F.mcy - t["dy"]) / t["s"]
    x = np.round(c * u + sn * v + t["cx"]).astype(int)
    y = np.round(-sn * u + c * v + t["cy"]).astype(int)
    ok = (x >= 0) & (x < 400) & (y >= 0) & (y < 400)
    out = np.zeros((F.MH, F.MW, 4), np.uint8)
    out[ok] = img[y[ok], x[ok]]
    return out


def edge(m):
    e = np.zeros_like(m)
    e[1:-1, 1:-1] = m[1:-1, 1:-1] & ~(m[:-2, 1:-1] & m[2:, 1:-1] & m[1:-1, :-2] & m[1:-1, 2:])
    return e | np.roll(e, 1, 0) | np.roll(e, 1, 1)


a = F.load(os.path.join(F.HERE, "ref", "master-tq.png"), "rgb", F.MW, F.MH)
sil = ~(a[..., 2] - a[..., 0] > 35)
skin = (a[..., 0] > 150) & (a[..., 0] - a[..., 2] > 5) & (F.vv < F.CHIN_ROW)
panels = []
studio_p = os.path.join(D, "studio", "y32_e4.png")
for name, p in (("grey", grey_p), ("like", like_p), ("studio", studio_p)):
    w = warp_rgba(p).astype(float)
    bg = np.array([35, 64, 74], float)
    al = w[..., 3:4] / 255
    rgb = w[..., :3] * al + bg * (1 - al)
    rgb[edge(sil)] = (80, 220, 255)
    rgb[edge(skin)] = (255, 214, 64)
    out = os.path.join(D, f"master-{name}.png")
    subprocess.run(["magick", "-size", f"{F.MW}x{F.MH}", "-depth", "8", "rgb:-", out],
                   input=rgb.astype(np.uint8).tobytes(), check=True)
    panels.append(out)
subprocess.run(["magick", os.path.join(F.HERE, "ref", "master-tq.png"), panels[2], panels[1], "+append",
                os.path.join(D, "master-compare.png")], check=True)
print(os.path.join(D, "master-compare.png"))
