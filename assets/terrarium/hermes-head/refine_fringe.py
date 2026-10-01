"""Cut the measured fringe hem (blunt, with the V-splits at x~-0.55 / +0.66) into
the hair mass itself.

  blender --background <blend> --python refine_fringe.py -- <out.blend>

Runs AFTER apply_edits.py, so (ring, col) addressing of edits.json is unaffected.
A separate fringe panel laid on the mass was tried first (2026-10-01) and always
showed a seam — different tessellation shades differently and the panel's cut
ends show. So the mass's own front rows 5-7 are split into quarter columns,
and the hem row takes the measured profile. The splits can only reach just
below ring 6 (~z 2.1; the reference shows skin to ~2.3); the final low-poly
topology will model them properly.
"""
import os, sys
import bpy, bmesh
from mathutils import Vector

OUT = sys.argv[sys.argv.index("--") + 1]
N = 32
FRONT_K = 5            # columns |k| <= 5 (up to ~56 deg) get refined
CUTS = 7   # dense hem: narrow lock splits need ~0.045 vertex spacing
# Hem profile z(x), measured from ref/front.png (first skin row under the fringe).
HEM = [(-1.6, 1.78), (-1.36, 1.84), (-1.3, 1.86), (-1.0, 1.855), (-0.76, 1.821), (-0.7, 1.818), (-0.64, 1.875), (-0.58, 1.872), (-0.52, 1.868), (-0.46, 1.865), (-0.4, 1.857), (-0.34, 1.819), (0.26, 1.814), (0.32, 1.777), (0.5, 1.807), (0.56, 1.871), (0.62, 1.874), (0.68, 1.877), (0.74, 1.88), (0.8, 1.874), (0.86, 1.857), (1.1, 1.87), (1.34, 1.82), (1.6, 1.78)]   # centre 0.06 lower (profile sheet fringe tips at z ~1.75); blunt; splits hairline-thin on the sheet


SPLITS = [(-0.92, 0.18), (-0.50, 0.24), (-0.08, 0.16), (0.38, 0.24), (0.80, 0.18)]   # x, depth (front sheet / master)
HEM_RAISE = 0.0   # 2026-10-02: the sheet hem (z 1.86) sits right on the brows; 0.10 left a strip of forehead   # E43: between E22 (0.14) and E40 (0.04); landmark solve put 0.04 0.27 too low   # E40: the master's hem sits on the upper lid line (was 0.14 from the landmark solve)  # master landmarks put the hem higher above the eyes than candidate-02 (E22)


def hem_z(x):
    for (x0, z0), (x1, z1) in zip(HEM, HEM[1:]):
        if x0 <= x <= x1:
            return z0 + HEM_RAISE + (z1 - z0) * (x - x0) / (x1 - x0)
    return None


hair = bpy.data.objects["hermes_hair_cage"]
bm = bmesh.new(); bm.from_mesh(hair.data)
lr, lc = bm.verts.layers.int["ring"], bm.verts.layers.int["col"]


def front(v):
    c = v[lc]
    return min(c, N - c) <= FRONT_K


sel = [e for e in bm.edges
       if e.verts[0][lr] == e.verts[1][lr] and e.verts[0][lr] == 7   # only the hem row: refining rows 5-6 left a jagged band above the fringe
       and front(e.verts[0]) and front(e.verts[1])]
ring6_z = {}
for v in bm.verts:
    if v[lr] == 6:
        ring6_z[v[lc]] = v.co.z
n_before = len(bm.verts)   # new verts are appended; BMVert wrappers are NOT stable
bmesh.ops.subdivide_edges(bm, edges=sel, cuts=CUTS, use_grid_fill=True)
bm.verts.ensure_lookup_table()
hem = [v for v in bm.verts[:n_before] if v[lr] == 7 and front(v)]
# new verts cut from ring-7 edges are the only new ones below ring 6 (z < 1.98)
for v in bm.verts[n_before:]:
    v[lr], v[lc] = -2, -2          # refined verts: not addressable by edits.json
    if v.co.z < 1.98:
        hem.append(v)
cap = min(ring6_z.get(k, 2.15) for k in range(0, FRONT_K + 1)) - 0.06
for v in hem:
    z = hem_z(v.co.x)
    if z is None:
        continue
    # the concept's bangs are blunt with a few narrow splits; a faint lock
    # rhythm only (0.10 teeth read as a sawtooth in RealityKit)
    import math as _m
    tooth = 0.035 * max(0.0, _m.cos(_m.pi * (v.co.x + 0.05) / 0.34)) ** 3
    zt = min(z - tooth, cap)
    # Narrow splits between the locks, as both references draw them: one hem
    # vertex raised per split, a slim wedge ~0.18 wide, not the wide V that read
    # as forehead horns (2026-10-02).
    for xn, depth in SPLITS:
        if abs(v.co.x - xn) < 0.026:
            zt = min(z + depth, cap)
    lift = max(0.0, zt - 1.86)
    v.co = Vector((v.co.x, v.co.y + 0.35 * lift, zt))   # splits tuck toward the forehead
bm.to_mesh(hair.data); bm.free()
hair.data.update()
so = hair.modifiers["thickness"]
so.edge_crease_rim = 1.0          # blunt, crisp cut edges on every hem
bpy.ops.wm.save_as_mainfile(filepath=OUT)
print("fringe hem refined:", len(hem), "hem verts, split cap z=%.2f" % cap)
