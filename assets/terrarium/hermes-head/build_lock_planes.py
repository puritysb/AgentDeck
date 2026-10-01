"""Hand-laid low-poly hair: lock planes along the flow (no Decimate/Remesh).

  blender --background <blend> --python build_lock_planes.py -- <out.blend>

Runs after apply_edits / refine_fringe / build_locks. The sculpted cage stays the
shape authority. Each lock is a roof-shaped strip: two long planes meeting at a
raised ridge. It runs from the crown to its own pointed tip, and its corners
are taken from cage vertices, so the layout follows the cage's flow grid:
columns fall from the crown and rings wrap the head. The locks are big and
few, as in the master's facets. Their seams are staggered and their ridge
heights vary, so the planes read as hand-cut, not as a grid.

The cage itself becomes the dark under-layer that fills the gaps between locks
(head_v19 bakes it as `hair_under`). The locks object is `hermes_hair_planes`.

Layout (cage columns, 32 around, col 0 = front centre, + = her left):
  6 fringe locks, 2 columns wide, centred on odd columns 27..5. They end at the
  fringe hem in pointed tips; the gaps between tips are the concept's splits.
  10 curtain/back locks, 2 columns wide, from col 6 round the back to col 26.
  They end at the bob's hem in pointed tips.
"""
import math, os, sys
import bpy, bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

OUT = sys.argv[sys.argv.index("--") + 1]
N = 32
FRINGE_EDGE_Z, FRINGE_TIP_Z = 1.99, 1.91   # blunt with gentle lock points, as in the master      # measured hem 1.86 + 0.14 raise (E22), +-
EDGE_LIFT = 0.012
RIDGE = 0.075


def h(a, b):   # deterministic pseudo-random in [0, 1)
    x = math.sin(a * 12.9898 + b * 78.233) * 43758.5453
    return x - math.floor(x)


cage = bpy.data.objects["hermes_hair_cage"]
me = cage.data
R, C = me.attributes["ring"].data, me.attributes["col"].data
P = {}
for v in me.vertices:
    P[(R[v.index].value, C[v.index].value)] = v.co.copy()
pole = P[(-1, -1)]

# outward normals from the cage surface without thickness or subdivision
mods = [(m, m.show_viewport) for m in cage.modifiers]
for m, _ in mods:
    m.show_viewport = False
dg = bpy.context.evaluated_depsgraph_get()
bm0 = bmesh.new(); bm0.from_mesh(cage.evaluated_get(dg).to_mesh())
BVH = BVHTree.FromBMesh(bm0)
for m, vis in mods:
    m.show_viewport = vis


def normal_at(p):
    loc, n, _, _ = BVH.find_nearest(p)
    out = Vector((p.x, p.y - 0.6, p.z - 1.9))
    if n is None:
        return out.normalized()
    return n if n.dot(out) > 0 else -n


bm = bmesh.new()


def lock(cols, rows, tip_drop, key, fringe=False):
    a, m, b = [c % N for c in cols]
    ridge_h = RIDGE * (0.7 + 0.6 * h(key, 1))
    L, M, Rr = [], [], []
    for i, r in enumerate(rows):
        pa, pm, pb = P[(r, a)].copy(), P[(r, m)].copy(), P[(r, b)].copy()
        last = i == len(rows) - 1
        if fringe and last:
            pa.z = pb.z = FRINGE_EDGE_Z
            pm.z = FRINGE_TIP_Z - 0.03 * h(key, 2)
        elif last:
            pm.z -= tip_drop * (0.8 + 0.4 * h(key, 3))
        t = min(1.0, (i + 0.5) / 2.0)          # ridge grows in from the crown
        L.append(bm.verts.new(pa + normal_at(pa) * EDGE_LIFT))
        M.append(bm.verts.new(pm + normal_at(pm) * (EDGE_LIFT + ridge_h * t * (0.6 if last else 1.0))))
        Rr.append(bm.verts.new(pb + normal_at(pb) * EDGE_LIFT))
    top = bm.verts.new(pole + Vector((0, 0, EDGE_LIFT)))
    bm.faces.new((top, L[0], M[0])); bm.faces.new((top, M[0], Rr[0]))
    for i in range(len(rows) - 1):
        bm.faces.new((L[i], L[i + 1], M[i + 1], M[i]))
        bm.faces.new((M[i], M[i + 1], Rr[i + 1], Rr[i]))


key = 0
for c in (27, 29, 31, 1, 3, 5):                       # fringe locks
    rows = [1, 3, 5, 7] if key % 2 == 0 else [1, 2, 4, 7]
    lock((c - 1, c, c + 1), rows, 0.0, key, fringe=True); key += 1
for c in range(7, 26, 2):                              # curtain + back locks
    rows = [1, 3, 5, 7, 9, 11, 13] if key % 2 == 0 else [1, 2, 4, 6, 8, 10, 13]
    lock((c - 1, c, c + 1), rows, 0.16, key); key += 1

bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
# outward: the majority of faces must point away from the head centre
if sum(1 for f in bm.faces if f.normal.dot(f.calc_center_median() - Vector((0, 0.6, 1.9))) < 0) > len(bm.faces) / 2:
    bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
mesh = bpy.data.meshes.new("hermes_hair_planes"); bm.to_mesh(mesh); bm.free()
for p in mesh.polygons:
    p.use_smooth = False
ob = bpy.data.objects.new("hermes_hair_planes", mesh)
bpy.context.scene.collection.objects.link(ob)
ob.data.materials.append(cage.data.materials[0])
sol = ob.modifiers.new("thickness", "SOLIDIFY"); sol.thickness = 0.05; sol.offset = -1
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("lock planes", key, "locks,", len(mesh.polygons), "faces")
