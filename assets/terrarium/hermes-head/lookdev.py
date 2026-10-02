"""Look-dev render of the finished head (not a pipeline step; nothing is saved).

  blender --background hermes-head-blockout.blend --python lookdev.py -- <out_dir> [--smooth]

Low-poly surface = the designed cages themselves, flat-shaded: the hair mass at
cage level (its columns follow the hair's fall from the crown, its rings wrap
the head), the locks at their lens resolution. No Decimate/Remesh. The face
stays smooth, with the face_v2 sheet laid on it as decals (front projection
onto the evaluated face, lifted along the surface normal).
"""
import math, os, sys
import bpy, bmesh
from mathutils import Vector
from mathutils.bvhtree import BVHTree

A = sys.argv[sys.argv.index("--") + 1:]
OUT = A[0]; SMOOTH = "--smooth" in A
os.makedirs(OUT, exist_ok=True)
HERE = os.path.dirname(bpy.data.filepath)
sys.path.insert(0, HERE)
from face_v2 import F

sc = bpy.context.scene


def mat(name, rgb, rough, spec=0.3):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*rgb, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Specular IOR Level"].default_value = spec
    return m


def srgb(h):
    h = h.lstrip("#"); c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in c)


HAIR = mat("hair_ink", (0.010, 0.011, 0.014), 0.55, 0.22)
SKIN = mat("skin", srgb(F.PALETTE["skin"]), 0.6, 0.2)
for ob in bpy.data.objects:
    if ob.type != "MESH":
        continue
    if ob.name == "hermes_hair_cage" and not SMOOTH:
        from facets import facet_mass
        facet_mass(ob.data)
    if ob.name.startswith(("hermes_hair_cage", "hermes_lock_")):
        ob.data.materials.clear(); ob.data.materials.append(HAIR)
        for m in ob.modifiers:
            if m.type == "SUBSURF":
                m.levels = m.render_levels = (1 if SMOOTH else 0)
        for p in ob.data.polygons:
            p.use_smooth = SMOOTH
    if ob.name == "hermes_head_cage":
        ob.data.materials.clear(); ob.data.materials.append(SKIN)
        for p in ob.data.polygons:
            p.use_smooth = True

# ---- face_v2 decals ----------------------------------------------------------
dg = bpy.context.evaluated_depsgraph_get()
hb = bmesh.new(); hb.from_mesh(bpy.data.objects["hermes_head_cage"].evaluated_get(dg).to_mesh())
FACE = BVHTree.FromBMesh(hb)
S, HEM = F.MODEL_SCALE, F.MODEL_HEM_Z


def to_model(x, y):
    return x * S, HEM + (y - F.HEM_Y) * S


mats = {}
for name, key, pts in F.layers():
    if name == "face" or name.startswith(("closed_lid", "mouth_open")):
        continue
    # paint order -> stacking depth above the skin (later layers sit higher)
    ORDER = ["nose", "sclera", "lid_shadow", "iris_glow", "iris", "pupil", "highlight", "lower", "upper",
             "eyebrow", "lash", "lip_lower_rim", "lip_lower", "lip_upper", "lip_line"]
    k = next(i for i, p in enumerate(ORDER) if name.startswith(p))
    depth = 0.010 + 0.004 * k
    bm = bmesh.new()
    vs = [bm.verts.new((*to_model(x, y), 0)) for x, y in pts]
    f = bm.faces.new(vs)
    bmesh.ops.triangulate(bm, faces=[f], quad_method="BEAUTY", ngon_method="BEAUTY")
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=2, use_grid_fill=True)
    for v in bm.verts:
        X, Z = v.co.x, v.co.y
        loc, nor, _, _ = FACE.ray_cast(Vector((X, -10, Z)), Vector((0, 1, 0)))
        if loc is None:
            loc, nor, _, _ = FACE.find_nearest(Vector((X, -2, Z)))
        v.co = loc + nor * depth
    for f in bm.faces:
        f.normal_update()
        if f.normal.y > 0:
            f.normal_flip()
    me = bpy.data.meshes.new("decal_" + name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new("decal_" + name, me); sc.collection.objects.link(ob)
    if key not in mats:
        mats[key] = mat("face_" + key, srgb(F.PALETTE[key]), 0.5, 0.2)
    ob.data.materials.append(mats[key])

# ---- light + cameras ---------------------------------------------------------
sc.render.engine = "BLENDER_EEVEE"
sc.world = bpy.data.worlds.new("Water"); sc.world.use_nodes = True
bg = sc.world.node_tree.nodes["Background"]; bg.inputs[0].default_value = (.012, .035, .055, 1); bg.inputs[1].default_value = 1.0
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"
sc.render.resolution_x, sc.render.resolution_y = 700, 640
sc.render.film_transparent = False
for pos, power, size in [((6, -14, 16), 5200, 10), ((-14, -6, 6), 2400, 8), ((2, 14, 8), 2600, 6)]:
    L = bpy.data.lights.new("L", "AREA"); L.energy = power; L.size = size
    o = bpy.data.objects.new("L", L); sc.collection.objects.link(o); o.location = pos
    o.rotation_euler = (Vector((0, 0.4, 2.0)) - o.location).to_track_quat("-Z", "Y").to_euler()
cd = bpy.data.cameras.new("C"); cd.type = "ORTHO"; cam = bpy.data.objects.new("C", cd)
sc.collection.objects.link(cam); sc.camera = cam
AT = Vector((0, 0.4, 1.9))
for name, yaw, el, scale in (("front", 0, 0, 7.4), ("master", 32, 4, 7.4), ("profile", 90, 0, 7.4)):
    a, e = math.radians(yaw), math.radians(el)
    cam.location = AT + 20 * Vector((math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)))
    cam.rotation_euler = (AT - cam.location).to_track_quat("-Z", "Y").to_euler()
    cd.ortho_scale = scale
    sc.render.filepath = os.path.join(OUT, f"look-{name}.png")
    bpy.ops.render.render(write_still=True)
print("lookdev", OUT)
