"""Apply the ordered sculpt edits in edits.json to a freshly seeded blockout.

  blender --background seed.blend --python apply_edits.py -- <out.blend>

Each edit addresses cage vertices by their (ring, col) attributes and is
mirrored to the opposite column (x negated) unless "mirror": false.
  {"obj": "hair"|"head", "ring": r, "col": k, "set": [x, y, z]}   absolute
  {"obj": ..., "ring": r, "col": k, "move": [dx, dy, dz]}          relative
  {"obj": ..., "ring": r, "cols": [k, ...] | "all", "scale": [sx, sy, sz], "center": [cx, cy, cz]}
  (scale about center, default origin; "move" may also take "cols")
Any of x/y/z in "set" may be null to keep that axis.
"""
import json, os, sys
import bpy

OUT = sys.argv[sys.argv.index("--") + 1]
HERE = os.path.dirname(os.path.abspath(__file__))
OBJ = {"hair": "hermes_hair_cage", "head": "hermes_head_cage"}
N = {"hair": 32, "head": 16}

edits = json.load(open(os.path.join(HERE, "edits.json")))
for name in OBJ:
    me = bpy.data.objects[OBJ[name]].data
    R, C = me.attributes["ring"].data, me.attributes["col"].data
    index = {(R[v.index].value, C[v.index].value): v for v in me.vertices}
    count = 0
    for e in edits:
        if e.get("note") and "obj" not in e:
            continue
        if e["obj"] != name:
            continue
        cols = []
        sel = e.get("cols", [e.get("col")])
        if sel == "all":
            sel = sorted({k for (r, k) in index if r == e["ring"]})
            e = dict(e, mirror=False)
        for c in sel:
            cols.append((c, 1))
            mc = (N[name] - c) % N[name]
            if e.get("mirror", True) and mc != c:
                cols.append((mc, -1))
        for k, sx in cols:
            v = index[(e["ring"], k)]
            if "set" in e:
                x, y, z = e["set"]
                v.co = (v.co.x if x is None else x * sx, v.co.y if y is None else y, v.co.z if z is None else z)
            elif "scale" in e:
                sx_, sy_, sz_ = e["scale"]
                cx, cy, cz = e.get("center", (0, 0, 0))
                v.co = (cx + (v.co.x - cx) * sx_, cy + (v.co.y - cy) * sy_, cz + (v.co.z - cz) * sz_)
            else:
                dx, dy, dz = e["move"]
                v.co = (v.co.x + dx * sx, v.co.y + dy, v.co.z + dz)
            count += 1
    me.update()
    print("applied", count, "vertex edits to", name)
bpy.ops.wm.save_as_mainfile(filepath=OUT)
