"""Solve an orthographic camera (yaw, elevation, roll, scale, shift) that maps
model landmarks onto hand-marked master landmarks, by least squares.
The master is an illustration: residuals show where the model disagrees.

  python3.13 solve_camera.py '<LM3D json>' [exclude,...]
"""
import json, math, sys
import numpy as np
M2 = {  # ref/master-tq.png pixels, read on a 20 px grid (2026-10-01)
    "eye_far": (156, 310), "eye_near": (252, 288), "nose": (182, 344), "mouth": (192, 370),
    "chin": (200, 418), "hem": (190, 246), "clasp": (365, 168)}
L3 = json.loads(sys.argv[1]); excl = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else set()
keys = [k for k in M2 if k in L3 and k not in excl]
P = np.array([L3[k] for k in keys]); Q = np.array([M2[k] for k in keys], float)


def project(yaw, el, roll):
    a, e = math.radians(yaw), math.radians(el)
    d = np.array([math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)])   # toward camera
    u = np.cross([0, 0, 1], d); u /= np.linalg.norm(u)          # screen right
    v = np.cross(d, u)                                          # screen up
    x, y = P @ u, -(P @ v)
    c, s = math.cos(math.radians(roll)), math.sin(math.radians(roll))
    return np.stack([c * x - s * y, s * x + c * y], 1)


best = None
YAWS = [int(a) for a in __import__("os").environ.get("YAWS", "10-65").split("-")]
for yaw in range(YAWS[0], YAWS[-1] + 1, 1):
    for el in range(-25, 31, 1):
        for roll in range(-20, 21, 1):
            X = project(yaw, el, roll)
            Xm, Qm = X - X.mean(0), Q - Q.mean(0)
            s = (Xm * Qm).sum() / (Xm * Xm).sum()
            r = np.sqrt(((s * Xm - Qm) ** 2).sum(1).mean())
            if best is None or r < best[0]:
                best = (r, yaw, el, roll, s, s * Xm + Q.mean(0))
r, yaw, el, roll, s, fit = best
print(f"rms {r:.1f}px  yaw {yaw}  elev {el}  roll {roll}  scale {s:.1f} px/unit")
for k, f, q in zip(keys, fit, Q):
    print(f"  {k:9s} master {q}  model {f.round(1)}  residual {(f - q).round(1)} = {((f - q) / s).round(2)} u")
