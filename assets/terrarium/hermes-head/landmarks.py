"""Landmarks at the master camera: eyes (dark blobs in the upper face), mouth
(dark blob in the lower face), face box, chin. Master vs the registered model
render (look_compare.py's reg-master.png). Master pixels; + = model lower/right.
  python3.13 landmarks.py <look_dir>"""
import os, subprocess, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
def load(p, w=620, h=560):
    raw = subprocess.run(["magick", p, "-depth", "8", "rgb:-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(h, w, 3).astype(int)
def comps(mask):
    lab = np.zeros(mask.shape, int); n = 0; out = []
    ys, xs = np.nonzero(mask)
    seen = set()
    for y0, x0 in zip(ys, xs):
        if lab[y0, x0]: continue
        n += 1; st = [(y0, x0)]; lab[y0, x0] = n; pts = []
        while st:
            y, x = st.pop(); pts.append((y, x))
            for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
                yy, xx = y+dy, x+dx
                if 0 <= yy < mask.shape[0] and 0 <= xx < mask.shape[1] and mask[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = n; st.append((yy, xx))
        out.append(np.array(pts))
    return out
def analyse(a, skin_test):
    skin = skin_test(a)
    rows = np.nonzero(skin.sum(1) > 25)[0]
    top, bot = rows[0], rows[-1]
    face = np.zeros_like(skin)
    for y in range(top, bot + 1):
        xs = np.nonzero(skin[y])[0]
        if len(xs) > 25: face[y, xs[0]:xs[-1]+1] = True
    dark = face & ~skin & (a.mean(2) < 120)
    dark[:, :] &= (np.arange(a.shape[0])[:, None] > top + 12)   # skip the fringe hem
    blobs = [c for c in comps(dark) if len(c) > 25]
    blobs.sort(key=lambda c: -len(c))
    res = {"face_top": top, "chin": bot}
    eyes = sorted([c for c in blobs if c[:,0].mean() < top + 0.55*(bot-top)][:2], key=lambda c: c[:,1].mean())
    for name, c in zip(("eye_near", "eye_far"), eyes):
        res[name] = (round(c[:,1].mean()), round(c[:,0].mean()), c[:,1].max()-c[:,1].min(), c[:,0].max()-c[:,0].min())
    low = [c for c in blobs if c[:,0].mean() > top + 0.6*(bot-top)]
    if low:
        m = low[0]; res["mouth"] = (round(m[:,1].mean()), round(m[:,0].mean()), m[:,1].max()-m[:,1].min())
    return res
m = load(os.path.join(HERE, "ref", "master-tq.png"))
BOX = (np.arange(560)[:,None] > 200) & (np.arange(560)[:,None] < 470) & (np.arange(620)[None,:] > 100) & (np.arange(620)[None,:] < 420)
mm = analyse(m, lambda a: (a[...,0] > 170) & (a[...,0]-a[...,2] > 5) & BOX & (np.arange(560)[:,None] < 430))
r = load(os.path.join(sys.argv[1], "reg-master.png"))
rr = analyse(r, lambda a: (a.mean(2) > 150) & (np.abs(a[...,0]-a[...,2]) < 30) & BOX)
for k in ("face_top", "chin", "eye_near", "eye_far", "mouth"):
    print(f"{k:9s} master {mm.get(k)}   model {rr.get(k)}")
