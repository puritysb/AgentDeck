"""The white headset band + clasp, laid on the hair.

  blender --background <blend> --python build_headset.py -- <out.blend>

Measured from the head-study sheet (white pixels, 2026-10-01): the band crosses
the crown just behind the fringe (top ~ (0, -0.3, 4.35)), runs down her LEFT
side to the clasp at ~ (1.7, 0.35, 2.85), and on her RIGHT it disappears under
the hair below z ~3.85 (earcups hidden). In profile it leans forward ~24 deg.
The centreline is the intersection of that plane with the outer hair surface;
thickness is along the surface normal.
"""
import math, os, sys
import bpy, bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

OUT = sys.argv[sys.argv.index("--") + 1]
A = Vector((-1.70, 0.35, 2.85))     # her right end (hidden)
B = Vector((1.70, 0.35, 2.85))      # her left end: the clasp
C = Vector((0.0, -0.80, 3.95))      # crown, just behind the fringe; forward so the band arches over the front of the dome as in the master
WIDTH, THICK, LIFT = 0.58, 0.09, 0.10   # master: a firm band (0.78 read as a plank once it sat forward)   # profile sheet: band ~0.45 wide; lift clears the facet jitter (+-0.05)
HIDE_BELOW_Z = 3.85                 # her right side dives under the hair from here
N = 64

X = (B - A).normalized()
U = (C - (A + B) / 2); U = (U - X * U.dot(X)).normalized()
O = (A + B) / 2 + U * 0.5
PN = X.cross(U).normalized()        # plane normal

dg = bpy.context.evaluated_depsgraph_get()
# lay the band on the outermost hair: the lock planes when present
src = bpy.data.objects.get("hermes_hair_planes") or bpy.data.objects["hermes_hair_cage"]
ev = src.evaluated_get(dg)
bmh = bmesh.new(); bmh.from_mesh(ev.to_mesh())
HAIR = BVHTree.FromBMesh(bmh)


def ang(p):
    d = p - O
    return math.atan2(d.dot(U), d.dot(X))


a0, a1 = ang(B), ang(A)
if a1 < a0:
    a1 += 2 * math.pi
pts, nors = [], []
for i in range(N + 1):
    a = a0 + (a1 - a0) * i / N
    d = X * math.cos(a) + U * math.sin(a)
    loc, nor, _, _ = HAIR.ray_cast(O + d * 8.0, -d)
    if loc is None:
        continue
    lift = LIFT
    if loc.x < 0 and loc.z < HIDE_BELOW_Z + 0.25:      # tuck under the hair on her right
        lift = LIFT - 0.25 * min(1.0, (HIDE_BELOW_Z + 0.25 - loc.z) / 0.35)
    pts.append(loc + nor * lift)
    nors.append(nor)


# A rigid band: smooth the centreline over the faceted lock planes, then make
# every sample clear the hair by at least the lift (faceted ridges otherwise
# dent it into a jagged strip, 2026-10-01).
for _ in range(12):
    pts = [pts[0]] + [(pts[i - 1] + pts[i] * 2 + pts[i + 1]) / 4 for i in range(1, len(pts) - 1)] + [pts[-1]]
    nors = [nors[0]] + [(nors[i - 1] + nors[i] * 2 + nors[i + 1]).normalized() for i in range(1, len(nors) - 1)] + [nors[-1]]
for i, (p, n) in enumerate(zip(pts, nors)):
    if p.x < 0 and p.z < HIDE_BELOW_Z + 0.25:
        continue                       # the tucked end stays tucked
    loc, hn, _, _ = HAIR.ray_cast(p + n * 1.0, -n)
    if loc is not None and (p - loc).dot(n) < 0.09:
        pts[i] = loc + n * 0.09


def material(name, rgb, rough=0.55):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Roughness"].default_value = rough
    return m


# a cool white: skin-mask scoring keys on warm light pixels (R-B > 5), so the
# headset must not read as face in the fits
WHITE = material("headset_white", (0.82, 0.84, 0.88))
DOT = material("headset_dot", (0.02, 0.02, 0.025))

bm = bmesh.new()
rings = []
for i, (p, n) in enumerate(zip(pts, nors)):
    t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
    w = t.cross(n).normalized()
    hw, ht = WIDTH / 2, THICK / 2
    rings.append([bm.verts.new(p + w * sx * hw + n * sy * ht) for sx, sy in ((1, 1), (-1, 1), (-1, -1), (1, -1))])
for r0, r1 in zip(rings, rings[1:]):
    for k in range(4):
        bm.faces.new((r0[k], r0[(k + 1) % 4], r1[(k + 1) % 4], r1[k]))
bm.faces.new(rings[0]); bm.faces.new(list(reversed(rings[-1])))
bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
me = bpy.data.meshes.new("hermes_headset_band"); bm.to_mesh(me); bm.free()
band = bpy.data.objects.new("hermes_headset_band", me)
bpy.context.scene.collection.objects.link(band)
band.data.materials.append(WHITE)
bev = band.modifiers.new("round", "BEVEL"); bev.width = 0.02; bev.segments = 2

# clasp at her left end: a round disc with a black dot and two short tails
end, en = pts[0], nors[0]
tdir = (pts[1] - pts[0]).normalized()            # along the band, toward the crown
down = -tdir
side = tdir.cross(en).normalized()


def disc(name, center, normal, r, h, mat, seg=20):
    bm = bmesh.new()
    ax = normal.normalized()
    u = ax.orthogonal().normalized(); v = ax.cross(u)
    top = [bm.verts.new(center + ax * h / 2 + (u * math.cos(2 * math.pi * k / seg) + v * math.sin(2 * math.pi * k / seg)) * r) for k in range(seg)]
    bot = [bm.verts.new(center - ax * h / 2 + (u * math.cos(2 * math.pi * k / seg) + v * math.sin(2 * math.pi * k / seg)) * r) for k in range(seg)]
    bm.faces.new(top); bm.faces.new(list(reversed(bot)))
    for k in range(seg):
        bm.faces.new((top[k], bot[k], bot[(k + 1) % seg], top[(k + 1) % seg]))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    return ob


cc = end + en * 0.05 + down * 0.02
disc("hermes_headset_clasp", cc, en, 0.14, 0.07, WHITE)   # master: a small round end
disc("hermes_headset_dot", cc + en * 0.04, en, 0.045, 0.02, DOT)
for sgn in (-1, 1):   # the hook: two short tails curling down and apart
    bm = bmesh.new()
    path = [cc + down * 0.08 + side * sgn * 0.02 + en * 0.01,
            cc + down * 0.14 + side * sgn * 0.06 + en * 0.02,
            cc + down * 0.17 + side * sgn * 0.11 + en * 0.02]
    rr = []
    for i, p in enumerate(path):
        w = 0.05 * (1 - i / len(path))
        rr.append([bm.verts.new(p + side * dx + en * dy) for dx, dy in ((w, 0.02), (-w, 0.02), (-w, -0.02), (w, -0.02))])
    for r0, r1 in zip(rr, rr[1:]):
        for k in range(4):
            bm.faces.new((r0[k], r0[(k + 1) % 4], r1[(k + 1) % 4], r1[k]))
    bm.faces.new(rr[0]); bm.faces.new(list(reversed(rr[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    me = bpy.data.meshes.new(f"hermes_headset_hook_{sgn}"); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(f"hermes_headset_hook_{'a' if sgn < 0 else 'b'}", me)
    bpy.context.scene.collection.objects.link(ob); ob.data.materials.append(WHITE)
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("headset", len(pts), "band samples")
