"""Extract target contours from the head-study front/profile panels.

Run with Blender's bundled Python (numpy, no PIL):
  magick <candidate-02.png> -depth 8 rgb:/tmp/c2.rgb
  python3.13 measure_refs.py /tmp/c2.rgb ref/targets.json

World mapping (1 unit = 100 source px): x = (px - FRONT_CX)/100,
y = (px - PROFILE_Y0)/100 (face looks toward -y), z = (CHIN_Y - py)/100.
These contours are proposals from a generated sheet, not calibrated geometry.
"""
import json, sys
import numpy as np

W, H = 2172, 724
FRONT = (782, 1424)
PROFILE = (1547, 2095)
FRONT_CX = 1098.0
PROFILE_Y0 = 1760.0
CHIN_Y = 535.0

a = np.fromfile(sys.argv[1], np.uint8).reshape(H, W, 3).astype(int)
R, G, B = a[..., 0], a[..., 1], a[..., 2]
bg = (B - R > 35) & (R < 30)
skin = (R > 150) & (R - B > 5)
fg = ~bg

def z(py): return round((CHIN_Y - py) / 100, 3)

out = {"mapping": {"FRONT_CX": FRONT_CX, "PROFILE_Y0": PROFILE_Y0, "CHIN_Y": CHIN_Y, "unit_px": 100},
       "front_hair": [], "front_face": [], "profile_hair": [], "profile_face": []}
for py in range(80, 620, 4):
    xs = np.nonzero(fg[py, FRONT[0]:FRONT[1]])[0] + FRONT[0]
    if len(xs): out["front_hair"].append([z(py), round((xs[0]-FRONT_CX)/100, 3), round((xs[-1]-FRONT_CX)/100, 3)])
    xs = np.nonzero(skin[py, 900:1300])[0] + 900
    if len(xs) and 336 <= py <= 530: out["front_face"].append([z(py), round((xs[0]-FRONT_CX)/100, 3), round((xs[-1]-FRONT_CX)/100, 3)])
    xs = np.nonzero(fg[py, PROFILE[0]:PROFILE[1]])[0] + PROFILE[0]
    if len(xs): out["profile_hair"].append([z(py), round((xs[0]-PROFILE_Y0)/100, 3), round((xs[-1]-PROFILE_Y0)/100, 3)])
    xs = np.nonzero(skin[py, 1560:1900])[0] + 1560
    if len(xs) and 340 <= py <= 545: out["profile_face"].append([z(py), round((xs[0]-PROFILE_Y0)/100, 3)])
json.dump(out, open(sys.argv[2], "w"), indent=0)
print({k: len(v) for k, v in out.items() if isinstance(v, list)})
