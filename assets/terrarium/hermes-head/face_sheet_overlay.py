"""Draw a face sheet (v18 `hermes_face.py`, or `--v2` for face_v2.py) (assets/terrarium/hermes_face.py) onto a front
review render of the blockout, mapped by its landmarks: sheet hem (0.020) ->
model bang line, sheet chin (-0.210) -> model chin. Writes <dir>/face-sheet.png:
[front grey + sheet outlines | sheet artwork painted over the grey].
  python3.13 face_sheet_overlay.py <render_dir> [model_hem_z model_chin_z]"""
import os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
V2 = "--v2" in sys.argv
sys.argv = [a for a in sys.argv if a != "--v2"]
if V2:
    sys.path.insert(0, HERE)
    from face_v2 import F
else:
    import hermes_face as F
D = sys.argv[1]
HEM_Z = float(sys.argv[2]) if len(sys.argv) > 2 else 1.86
CHIN_Z = float(sys.argv[3]) if len(sys.argv) > 3 else -0.14
S = (HEM_Z - CHIN_Z) / (F.HEM_Y - F.CHIN_Y)


def px(x, y):  # sheet head units -> front crop pixels
    X, Z = x * S, HEM_Z + (y - F.HEM_Y) * S
    return 1098 + 100 * X - 770, 535 - 100 * Z - 60


outline, fill = [], []
for name, key, pts in F.layers():
    if name == "face":
        continue
    P = " ".join(f"{a:.1f},{b:.1f}" for a, b in (px(*p) for p in pts))
    fill.append(f"fill '{F.PALETTE[key]}' polygon {P}")
    outline.append(f"polygon {P}")
face = " ".join(f"{a:.1f},{b:.1f}" for a, b in (px(*p) for p in [p for n, k, pts in F.layers() if n == 'face' for p in pts]))
open(os.path.join(D, "sheet-outline.mvg"), "w").write("fill none stroke '#ffd640' stroke-width 1\n" + "\n".join(outline)
                                                      + f"\nstroke '#ff5a36' polyline {face}\n")
open(os.path.join(D, "sheet-fill.mvg"), "w").write("stroke none\n" + "\n".join(fill) + "\n")
g = os.path.join(D, "front-grey.png")
subprocess.run(["magick", g, "-draw", "@" + os.path.join(D, "sheet-outline.mvg"), os.path.join(D, "face-sheet-lines.png")], check=True)
subprocess.run(["magick", g, "-draw", "@" + os.path.join(D, "sheet-fill.mvg"), os.path.join(D, "face-sheet-paint.png")], check=True)
subprocess.run(["magick", os.path.join(HERE, "ref", "front.png"), "-draw", "@" + os.path.join(D, "sheet-outline.mvg"),
                os.path.join(D, "face-sheet-ref.png")], check=True)
subprocess.run(["magick", os.path.join(D, "face-sheet-ref.png"), os.path.join(D, "face-sheet-lines.png"),
                os.path.join(D, "face-sheet-paint.png"), "+append", os.path.join(D, "face-sheet.png")], check=True)
print("scale", round(S, 3), "->", os.path.join(D, "face-sheet.png"))
