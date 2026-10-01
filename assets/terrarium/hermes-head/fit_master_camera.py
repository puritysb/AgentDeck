"""Fit an orthographic camera (yaw, elevation, image roll, scale, shift) that maps
the blockout onto the master 3/4 concept (ref/master-tq.png).

  python3.13 fit_master_camera.py <render_dir> [top_n]

<render_dir> holds `render_views.py --like` output (y<yaw>_e<el>.png, 400x400,
flat, reference front face projected). Score = IoU of the filled face mask +
IoU of the head silhouette ABOVE the ear line (the master's lower hair is
flicked locks, which the blockout leaves out) + 2 x IoU of the dark facial
features inside the face (eyes/brows/lips). Silhouettes alone are nearly flat
over yaw 35-55; the features are what pin the angle.
The master is an illustration, so the result is a best-fit judgment camera,
not a calibration.
"""
import glob, os, re, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MW, MH = 620, 560
CHIN_ROW = 425        # master: face/neck boundary; arms and body are below
DOME_ROW = 300        # master: above this the silhouette is dome + headset only


def load(p, ch, w, h):
    raw = subprocess.run(["magick", p, "-depth", "8", f"{ch}:-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, len(ch)).astype(int)


def fill_rows(m):
    out = np.zeros_like(m)
    for y in range(m.shape[0]):
        xs = np.nonzero(m[y])[0]
        if len(xs):
            out[y, xs[0]:xs[-1] + 1] = True
    return out


def master_masks():
    a = load(os.path.join(HERE, "ref", "master-tq.png"), "rgb", MW, MH)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    bg = B - R > 35
    skin = (R > 150) & (R - B > 5)
    rows = np.arange(MH)[:, None]
    face = fill_rows(skin & (rows < CHIN_ROW))
    dome = ~bg & (rows < DOME_ROW)
    feat = face & (R < 110)
    return face, dome, feat


def model_masks(p):
    m = load(p, "rgba", 400, 400)
    fg = m[..., 3] > 127
    face = fill_rows(fg & (m[..., 0] > 150) & (m[..., 0] - m[..., 2] > 5))
    return face, fg, face & fg & (m[..., 0] < 110)


MF, MD, MX = master_masks()
vv, uu = np.mgrid[0:MH, 0:MW]
mcy, mcx = np.argwhere(MF).mean(0)


def warp(mask, s, roll, cx, cy, dx, dy):
    """Sample a model mask into master pixel space."""
    c, sn = np.cos(np.radians(roll)), np.sin(np.radians(roll))
    u = (uu - mcx - dx) / s
    v = (vv - mcy - dy) / s
    x = c * u + sn * v + cx
    y = -sn * u + c * v + cy
    xi, yi = np.round(x).astype(int), np.round(y).astype(int)
    ok = (xi >= 0) & (xi < 400) & (yi >= 0) & (yi < 400)
    out = np.zeros((MH, MW), bool)
    out[ok] = mask[yi[ok], xi[ok]]
    return out


def iou(a, b):
    return (a & b).sum() / max(1, (a | b).sum())


def score(face, sil, feat, s, roll, dx=0, dy=0):
    cy, cx = np.argwhere(face).mean(0)
    wf = warp(face, s, roll, cx, cy, dx, dy) & (vv < CHIN_ROW)   # same cut as the master mask (no neck)
    ws = warp(sil, s, roll, cx, cy, dx, dy) & (vv < DOME_ROW)
    wx = warp(feat, s, roll, cx, cy, dx, dy)
    fi, di, xi = iou(wf, MF), iou(ws, MD), iou(wx, MX)
    return fi + di + 2 * xi, fi, di, xi


def fit_one(p):
    """Best (score, s, roll, dx, dy, face, dome, features) for one render."""
    face, sil, feat = model_masks(p)
    s0 = np.sqrt(MF.sum() / face.sum())
    best = max((score(face, sil, feat, s0 * k, r) + (k, r) for k in np.linspace(0.85, 1.15, 13)
                for r in range(-6, 7, 1)), key=lambda t: t[0])
    k, r = best[4], best[5]
    best = max((score(face, sil, feat, s0 * k, r, dx, dy) + (k, r, dx, dy)
                for dx in range(-12, 13, 2) for dy in range(-12, 13, 2)), key=lambda t: t[0])
    cy, cx = np.argwhere(face).mean(0)
    return dict(score=best[0], s=s0 * best[4], roll=best[5], dx=best[6], dy=best[7], cx=cx, cy=cy,
                face=best[1], dome=best[2], features=best[3])


if __name__ == "__main__":
    results = []
    for p in sorted(glob.glob(os.path.join(sys.argv[1], "y*_e*.png"))):
        yaw, el = map(float, re.findall(r"y(-?[\d.]+)_e(-?[\d.]+)", os.path.basename(p))[0])
        face, sil, feat = model_masks(p)
        if face.sum() < 50:
            continue
        s0 = np.sqrt(MF.sum() / face.sum())
        best = max((score(face, sil, feat, s0 * k, r) + (k, r) for k in np.linspace(0.85, 1.15, 7)
                    for r in range(-15, 16, 3)), key=lambda t: t[0])
        # refine shift around the centroid alignment
        k, r = best[4], best[5]
        best = max((score(face, sil, feat, s0 * k, r, dx, dy) + (k, r, dx, dy)
                    for dx in range(-12, 13, 4) for dy in range(-12, 13, 4)), key=lambda t: t[0])
        results.append((best[0], yaw, el, best[5], s0 * best[4], best[6], best[7], best[1], best[2], best[3]))
    results.sort(reverse=True)
    for r in results[:int(sys.argv[2]) if len(sys.argv) > 2 else 8]:
        print("score %.3f  yaw %5.1f  elev %5.1f  roll %+3d  scale %.3f  shift %+d,%+d  face %.3f  dome %.3f  features %.3f" % r)

