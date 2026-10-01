"""Grow hair locks out of the blockout mass (flicked ends, cheek-framing locks).

  blender --background <blend> --python build_locks.py -- <out.blend>

Each lock is DESIGN DATA below: a few control points (root buried in the mass ->
tip), a width profile and a thickness. Its cross-section is a flat lens whose
thickness axis is the surface normal at the root, parallel-transported along
the spine (never a global axis), and whose width lies along the surface.
Control points marked "snap" are projected onto the head (face) surface and
lifted by a clearance, so framing locks follow the cheek instead of floating.

Reading of the references (2026-10-01; x = her left +, z up, chin z~-0.2):
- cheek-framing lock, both sides: runs down the curtain's front edge beside the
  cheek and curls under the jaw toward the chin (front sheet tips at x~+-0.65,
  z~0.35; in the master it covers the far cheek up to the eye).
- two flicked locks per side, layered: fall down the side mass and hook
  outward-up (front sheet tips: her right (-x) (-3.13, 0.95) and (-2.88, 0.10);
  her left (+x) (3.22, 0.9) and (2.75, -0.3)). Deliberately not mirrored.
"""
import math, os, sys
import bpy, bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

OUT = sys.argv[sys.argv.index("--") + 1]
SEG = 8          # samples along each Bezier span
RING = 6         # cross-section vertices

# Control points are SURFACE-RELATIVE: (target, theta_deg, z, offset)
#   ("cage", ring, col, offset) names a hair cage vertex placed by edits.json;
#   target "hair" -> the outer hair mass, "head" -> the skin; theta from the front
#   (-Y) toward her left (+X), negative = her right; offset along the surface
#   normal (negative = buried, so a lock grows OUT of the mass). ("xyz", x, y, z)
#   is a free point for tips that leave the surface.
# Layered bob, per the front sheet + master: an upper layer ending near ear level
# that flips out, and a lower layer flipping at the hem. Her right (-X) flips
# bigger than her left, as drawn. Her RIGHT carries the layered flicks (front
# sheet: bigger there; master: the far side, flicks visible), her LEFT is smooth
# with one small front-side flick (master near side and profile sheet: smooth).
# Nothing behind |theta| ~100: side/back locks read as scales (2026-10-01).
# Her LEFT has no flicks at all (iteration 24): the profile sheet and the
# master's near side are smooth, and front-facing blades there covered the
# cheek in profile.
LOCKS = [
    # name, control points, widths (root..tip), thickness
    # (framing locks removed 2026-10-01: a separate lock left skin showing between
    # it and the curtain, a dark stripe across the cheek; the curtain edge itself
    # now curls under the jaw, edits.json E13)
    # was: framing locks: the curtain's INNER edge, where it touches the cheek (front
    # sheet: hair inner edge = face outline; profile sheet: cheek bare back to
    # y~-0.4), addressed by the cage vertices edits.json placed there (col 6/26).
    # Only the tip curls a short way under the jaw toward the chin (front sheet
    # tips at x~+-0.65, z~0.3). Placing it on the curtain's outer front face made
    # it cross the curtain to reach the jaw and read as a chin strap (2026-10-01).
    # her right (far side in the master): three thick C-curls stacked from ear to
    # chin level, hooking out and up (master crop x~70-130, y~330-470)
    # her right (near side in the master): thick C-curls stacked from CHIN level
    # down (master rows 360-480, below the chin at 424), hooking out and up.
    ("up_R1", [("hair", -76, 2.1, -0.05), ("hair", -78, 1.0, 0.10), ("hair", -80, 0.25, 0.10),
               ("hair", -82, -0.05, 0.85), ("hair", -82, 0.35, 1.60), ("hair", -78, 0.85, 1.55)],
     [1.75, 1.85, 1.6, 1.05, 0.45, 0.0], 0.36),
    ("up_R2", [("hair", -96, 2.0, -0.05), ("hair", -97, 0.8, 0.10), ("hair", -98, -0.20, 0.12),
               ("hair", -99, -0.55, 0.85), ("hair", -99, -0.15, 1.55), ("hair", -95, 0.32, 1.50)],
     [1.8, 1.9, 1.65, 1.1, 0.45, 0.0], 0.36),
    ("lo_R1", [("hair", -86, 1.0, -0.05), ("hair", -87, 0.0, 0.10), ("hair", -88, -0.55, 0.10),
               ("hair", -89, -0.92, 0.75), ("hair", -89, -0.60, 1.40), ("hair", -85, -0.15, 1.38)],
     [1.75, 1.85, 1.6, 1.0, 0.42, 0.0], 0.34),
    # her left (far side in the master): one soft outward flip at the back hem
    ("lo_L2", [("hair", 112, 0.9, -0.05), ("hair", 112, 0.0, 0.10), ("hair", 113, -0.40, 0.10),
               ("hair", 114, -0.62, 0.55), ("hair", 114, -0.42, 1.00), ("hair", 112, -0.15, 0.98)],
     [1.5, 1.6, 1.4, 0.9, 0.38, 0.0], 0.30),
]
HAIR_AXIS_Y = 0.6   # hair mass widest-at depth (bootstrap HAIR_M)
HEAD_AXIS_Y = 0.0


dg = bpy.context.evaluated_depsgraph_get()


def bvh_of(name):
    ev = bpy.data.objects[name].evaluated_get(dg)
    bm = bmesh.new(); bm.from_mesh(ev.to_mesh())
    t = BVHTree.FromBMesh(bm)
    return t, bm


HEAD, _hb = bvh_of("hermes_head_cage")
HAIR, _mb = bvh_of("hermes_hair_cage")


def surface_point(target, theta, z, off):
    """Ray-cast the target along the horizontal radial line at (theta, z)."""
    th = math.radians(theta)
    d = Vector((math.sin(th), -math.cos(th), 0.0))
    axis = Vector((0.0, HAIR_AXIS_Y if target == "hair" else HEAD_AXIS_Y, z))
    tree = HAIR if target == "hair" else HEAD
    loc, nor, _, _ = tree.ray_cast(axis + d * 8.0, -d)
    if loc is None:   # below a hem: take the nearest surface point instead
        loc, nor, _, _ = tree.find_nearest(axis + d * 3.0)
    return loc + nor * off


CAGE = {}
_hm = bpy.data.objects["hermes_hair_cage"].data
for _v in _hm.vertices:
    CAGE[(_hm.attributes["ring"].data[_v.index].value, _hm.attributes["col"].data[_v.index].value)] = _v.co.copy()


def resolve(cp):
    if cp[0] == "xyz":
        return Vector(cp[1:4])
    if cp[0] == "cage":   # ("cage", ring, col, radial offset) -> an edits.json vertex
        p = CAGE[(cp[1], cp[2])]
        d = Vector((p.x, p.y, 0.0)).normalized()
        return p + d * cp[3]
    return surface_point(*cp)


def catmull(pts, n):
    """Centripetal-ish Catmull-Rom through pts (with end padding)."""
    P = [pts[0] + (pts[0] - pts[1])] + pts + [pts[-1] + (pts[-1] - pts[-2])]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for s in range(n):
            t = s / n
            t2, t3 = t * t, t * t * t
            out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
                              + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    out.append(pts[-1])
    return out


def surface_normal(p):
    loc, nor, _, _ = HAIR.find_nearest(p)
    if loc is None:
        loc, nor, _, _ = HEAD.find_nearest(p)
    return nor


def build(name, cps, widths, thick):
    pts = [resolve(c) for c in cps]
    spine = catmull(pts, SEG)
    n = len(spine)
    # width profile along the spine, interpolated between control points
    wprof = []
    for i in range(n):
        f = i / (n - 1) * (len(widths) - 1)
        a = int(min(f, len(widths) - 2))
        wprof.append(widths[a] + (widths[a + 1] - widths[a]) * (f - a))
    # frame: thickness axis = surface normal at the root, parallel-transported
    T0 = (spine[1] - spine[0]).normalized()
    N0 = surface_normal(spine[0])
    if name.startswith(("up_", "lo_")):
        # The concept draws the bob's flipped ends as broad crescents seen from
        # the front: turn the blade's broad face toward the front (thickness
        # axis mostly front-back) instead of along the side of the head, where
        # the front/3-4 cameras saw it edge-on as a thin hook (2026-10-01).
        N0 = (N0 * 0.35 + Vector((0, -1, 0))).normalized()
    N0 = (N0 - T0 * N0.dot(T0)).normalized()
    frames = []
    Nn = N0
    for i in range(n):
        T = (spine[min(i + 1, n - 1)] - spine[max(i - 1, 0)]).normalized()
        Nn = (Nn - T * Nn.dot(T)).normalized()
        B = T.cross(Nn).normalized()
        frames.append((T, Nn, B))
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(spine):
        T, Nn, B = frames[i]
        w = max(wprof[i], 0.01) * 0.5
        t = thick * 0.5 * (0.35 + 0.65 * min(1.0, wprof[i] / max(widths[0], 1e-6)))
        ring = []
        for k in range(RING):
            a = 2 * math.pi * k / RING
            # lens: flat along B (width), thin along N (thickness)
            ring.append(bm.verts.new(p + B * (w * math.cos(a)) + Nn * (t * math.sin(a))))
        rings.append(ring)
    for i in range(n - 1):
        for k in range(RING):
            k1 = (k + 1) % RING
            bm.faces.new((rings[i][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k]))
    root_cap = bm.faces.new(list(reversed(rings[0])))
    tip = bm.verts.new(spine[-1] + frames[-1][0] * 0.02)
    for k in range(RING):
        bm.faces.new((rings[-1][k], rings[-1][(k + 1) % RING], tip))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    me = bpy.data.meshes.new(f"hermes_lock_{name}")
    bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(f"hermes_lock_{name}", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(bpy.data.objects["hermes_hair_cage"].data.materials[0])
    sd = ob.modifiers.new("smooth", "SUBSURF"); sd.levels = sd.render_levels = 1
    return ob


for name, cps, widths, thick in LOCKS:
    build(name, cps, widths, thick)
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("locks", len(LOCKS))
