"""One-shot seed for the Hermes head blockout (grey, no details).

This only SEEDS two low-vertex cages; after this the .blend is the source and
changes are edits to named vertices, logged in NOTES.md. Do not re-run this to
"fix" a shape — that is the regenerate-and-tweak loop we are leaving behind.

  blender --background --python bootstrap_blockout.py -- <out.blend>

Units: 1 = 100 px of the head-study sheet (see measure_refs.py). Face looks -Y,
her left is +X, chin at z=0, crown near z=4.5.
Ring seam convention: segment k sits at angle th = 2*pi*k/N measured from the
front (-Y) toward her left (+X); k=0 is the front centre line.
"""
import json, math, os, sys
import bpy, bmesh

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = sys.argv[sys.argv.index("--") + 1]
T = json.load(open(os.path.join(HERE, "ref", "targets.json")))


def interp(rows, zq, col):
    rows = sorted(rows, key=lambda r: r[0])
    if zq <= rows[0][0]:
        return rows[0][col]
    if zq >= rows[-1][0]:
        return rows[-1][col]
    for a, b in zip(rows, rows[1:]):
        if a[0] <= zq <= b[0]:
            t = (zq - a[0]) / (b[0] - a[0] or 1)
            return a[col] + t * (b[col] - a[col])


def section(th, W, F, K, M, nf, nb):
    """Split superellipse: front half reaches y=F, back half y=K, widest at y=M."""
    s, c = math.sin(th), math.cos(th)
    if c >= 0:
        e = 2.0 / nf
        return (math.copysign(W * abs(s) ** e, s), M - (M - F) * abs(c) ** e)
    e = 2.0 / nb
    return (math.copysign(W * abs(s) ** e, s), M + (K - M) * abs(c) ** e)


def new_cage_bmesh():
    # layers must exist before any vertex is created, or the refs go stale
    bm = bmesh.new()
    bm.verts.layers.int.new("ring")
    bm.verts.layers.int.new("col")
    return bm


def face_outward(bm):
    # rings run front -> her left (counter-clockwise from above) and downward,
    # which winds every face inward; flip once so Solidify's inward offset is
    # really inward and single-sided renderers (RealityKit) see the outside.
    bmesh.ops.reverse_faces(bm, faces=list(bm.faces))


def tag(bm, top, grid):
    """Store (ring, col) on every cage vertex so edits can address them; pole = -1."""
    lr = bm.verts.layers.int["ring"]
    lc = bm.verts.layers.int["col"]
    top[lr] = top[lc] = -1
    for r, row in enumerate(grid):
        for k, v in enumerate(row):
            if v is not None:
                v[lr], v[lc] = r, k


# ---- skull + face -----------------------------------------------------------
# z, half-width W, front F (centre line), back K, widest-at M, front/back squareness.
# Face rows follow the measured front face edge and profile centre line; skull
# rows under the hair are estimates (hair shell thickness ~0.35-0.8 assumed).
HEAD_RINGS = [
    # z     W     F      K     M     nf   nb
    (3.90, 0.95, -0.15, 1.25, 0.55, 2.2, 2.2),
    (3.55, 1.45, -0.75, 1.95, 0.55, 2.3, 2.2),
    (3.00, 1.78, -1.18, 2.35, 0.50, 2.4, 2.2),
    (2.40, 1.86, -1.36, 2.45, 0.45, 2.5, 2.2),
    (1.95, 1.78, -1.37, 2.35, 0.35, 2.7, 2.2),
    (1.65, 1.46, -1.29, 2.15, 0.20, 2.9, 2.2),
    (1.30, 1.42, -1.31, 1.90, 0.05, 2.8, 2.2),
    (0.95, 1.30, -1.36, 1.55, -0.05, 2.6, 2.2),
    (0.60, 1.08, -1.40, 1.05, -0.10, 2.4, 2.2),
    (0.30, 0.78, -1.33, 0.70, -0.10, 2.2, 2.2),
    (0.08, 0.50, -1.24, 0.45, -0.15, 2.1, 2.2),
    (-0.08, 0.50, -0.55, 0.55, 0.00, 2.0, 2.0),
    (-0.70, 0.52, -0.30, 0.55, 0.12, 2.0, 2.0),
]
HEAD_TOP = (0.0, 0.55, 4.08)
N_HEAD = 16


def build_head():
    bm = new_cage_bmesh()
    top = bm.verts.new(HEAD_TOP)
    rings = []
    for z, W, F, K, M, nf, nb in HEAD_RINGS:
        ring = []
        for k in range(N_HEAD):
            th = 2 * math.pi * k / N_HEAD
            x, y = section(th, W, F, K, M, nf, nb)
            ring.append(bm.verts.new((x, y, z)))
        rings.append(ring)
    for k in range(N_HEAD):
        bm.faces.new((top, rings[0][(k + 1) % N_HEAD], rings[0][k]))
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(N_HEAD):
            k1 = (k + 1) % N_HEAD
            bm.faces.new((r0[k], r0[k1], r1[k1], r1[k]))
    tag(bm, top, [r for r in rings])
    face_outward(bm)
    bm.normal_update()
    me = bpy.data.meshes.new("hermes_head_cage")
    bm.to_mesh(me)
    ob = bpy.data.objects.new("hermes_head_cage", me)
    return ob


# ---- hair mass --------------------------------------------------------------
# Hair grows from the skull: every hair vertex is a skull point pushed out along
# its outward direction by a thickness t(theta, z). t is solved so the mass meets
# the measured front/profile silhouettes at the side (90), back (180) and bangs
# (0), and is small (hugging) where the curtain meets the cheek. Below z=0.9 the
# hair stops following the jaw inward and drapes from the z=0.9 section.
N_HAIR = 32
BANG_Z = 1.95        # measured bang line (y~338 px)
SIDE_HEM_Z = -0.45   # side hem (y~580 px)
BACK_HEM_Z = -0.30   # back hem (profile y~565 px)
HAIR_TOP_Z = 4.50
CURTAIN_DEG = 66     # skull angle whose x equals the visible face edge at eye level
HUG_T = 0.10         # curtain clearance over the cheek
DRAPE_Z = 0.90


def smooth(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3 - 2 * t)


def head_params(zq):
    rows = [(4.08, 0.02, 0.50, 0.60, 0.55, 2.0, 2.0)] + HEAD_RINGS
    rows = sorted(rows, key=lambda r: r[0])
    zq = max(zq, DRAPE_Z)
    for a, b in zip(rows, rows[1:]):
        if a[0] <= zq <= b[0]:
            u = (zq - a[0]) / (b[0] - a[0])
            return [a[i] + u * (b[i] - a[i]) for i in range(1, 7)]
    return list(rows[-1][1:])


def skull_point(th, zq):
    W, F, K, M, nf, nb = head_params(zq)
    x, y = section(th, W, F, K, M, nf, nb)
    return x, y, (W, F, K, M)


def hair_hem(th):
    """Hem height of a column that hangs past the bang line (side -> back)."""
    a = abs(math.degrees(math.atan2(math.sin(th), math.cos(th))))
    return SIDE_HEM_Z + (BACK_HEM_Z - SIDE_HEM_Z) * smooth((a - 90) / 90)


def hair_targets(zq):
    fh, ph = T["front_hair"], T["profile_hair"]
    Wh = (interp(fh, zq, 2) - interp(fh, zq, 1)) / 2
    Fh = interp([r for r in ph if r[0] >= BANG_Z - 0.1], zq, 1)
    Kh = interp(ph, zq, 2)
    return Wh, Fh, Kh


# Shared horizontal rings. Above the bang line every column exists (closed dome);
# below it the face window removes columns with |theta| < CURTAIN_DEG.
DOME_Z = [4.42, 4.25, 3.95, 3.55, 3.05, 2.55, 2.20, BANG_Z]
DRAPE_ROWS = [1.55, 1.15, 0.75, 0.35, 0.00, None]   # None = per-column hem
HAIR_M = 0.60


def dome_point(th, zq):
    Wh, Fh, Kh = hair_targets(zq)
    x, y = section(th, Wh, Fh, Kh, HAIR_M, 2.3, 2.2)
    return (x, y, zq)


def drape_point(th, zq):
    """Skull-grown drape: skull section (frozen at DRAPE_Z) pushed out by t."""
    x, y, (W, F, K, M) = skull_point(th, zq)
    Wh, Fh, Kh = hair_targets(zq)
    a = abs(math.degrees(math.atan2(math.sin(th), math.cos(th))))
    t_side = max(0.1, Wh - W)
    t_back = max(0.1, Kh - K)
    if a <= 90:
        h = smooth((a - CURTAIN_DEG) / (90 - CURTAIN_DEG))
        t = HUG_T + (t_side - HUG_T) * h
    else:
        t = t_side + (t_back - t_side) * smooth((a - 90) / 90)
    dx, dy = x, y - M
    n = math.hypot(dx, dy) or 1
    return (x + dx / n * t, y + dy / n * t, zq)


def build_hair():
    bm = new_cage_bmesh()
    cols = [2 * math.pi * k / N_HAIR for k in range(N_HAIR)]

    def in_window(th):
        return abs(math.degrees(math.atan2(math.sin(th), math.cos(th)))) < CURTAIN_DEG

    top = bm.verts.new((0.0, HAIR_M, HAIR_TOP_Z))
    grid = [[bm.verts.new(dome_point(th, zq)) for th in cols] for zq in DOME_Z]
    for zq in DRAPE_ROWS:
        grid.append([None if in_window(th) else
                     bm.verts.new(drape_point(th, hair_hem(th) if zq is None else zq))
                     for th in cols])
    n = N_HAIR
    for k in range(n):
        bm.faces.new((top, grid[0][(k + 1) % n], grid[0][k]))
    for r in range(len(grid) - 1):
        for k in range(n):
            q = (grid[r][k], grid[r][(k + 1) % n], grid[r + 1][(k + 1) % n], grid[r + 1][k])
            if all(q):
                bm.faces.new(q)
    tag(bm, top, grid)
    face_outward(bm)
    bm.normal_update()
    me = bpy.data.meshes.new("hermes_hair_cage")
    bm.to_mesh(me)
    return bpy.data.objects.new("hermes_hair_cage", me)


def grey(name, v):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (v, v, v, 1)
    return m


bpy.ops.wm.read_factory_settings(use_empty=True)
coll = bpy.context.scene.collection
head = build_head()
hair = build_hair()
for ob in (head, hair):
    coll.objects.link(ob)
head.data.materials.append(grey("blockout_skin", 0.72))
hair.data.materials.append(grey("blockout_hair", 0.16))
sd = head.modifiers.new("smooth", "SUBSURF"); sd.levels = sd.render_levels = 2
# thin at the fringe (the concept's bangs are a thin sheet; 0.30 read as a
# thick visor), full thickness at the sides and back
vg = hair.vertex_groups.new(name="thick")
RR, CC = hair.data.attributes["ring"].data, hair.data.attributes["col"].data
for v in hair.data.vertices:
    k = CC[v.index].value; r = RR[v.index].value
    front = k >= 0 and min(k, N_HAIR - k) <= 5 and r >= 3
    vg.add([v.index], 0.35 if front else 1.0, "REPLACE")
so = hair.modifiers.new("thickness", "SOLIDIFY"); so.thickness = 0.30; so.offset = -1
so.vertex_group = "thick"; so.thickness_vertex_group = 0.35
sh = hair.modifiers.new("smooth", "SUBSURF"); sh.levels = sh.render_levels = 1
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("seeded", OUT, len(head.data.vertices), "head verts", len(hair.data.vertices), "hair verts")
