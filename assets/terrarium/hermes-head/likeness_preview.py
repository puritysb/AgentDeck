"""Likeness diagnostic: solid near-black hair + the reference FRONT face projected
onto the evaluated head surface from the registered front camera.

  blender --background hermes-head-blockout.blend --python likeness_preview.py -- <out_dir>

Not a texture pipeline and never exported: it only shows whether the face
surface under the drawing holds up when the camera turns (3/4, profile).
"""
import math, os, sys
import bpy, bmesh
from mathutils import Vector

HERE = os.path.dirname(bpy.data.filepath)

# front crop registration (see measure_refs.py / review_blockout.py)
CROP_X0, CROP_Y0, CW, CH = 770, 60, 660, 600
FRONT_CX, CHIN_Y = 1098.0, 535.0
# Piecewise-linear remap from model z to sheet z, so drawn features stay on
# their anatomy when the model's hem / mouth / chin move away from the sheet's.
# (model_z, sheet_z), ascending. Update when E-edits move these landmarks.
Z_ANCHORS = [(-1.20, -1.00), (-0.20, 0.00), (0.49, 0.55), (1.20, 1.20), (5.0, 5.0)]


def ref_z(z):
    for (m0, r0), (m1, r1) in zip(Z_ANCHORS, Z_ANCHORS[1:]):
        if z <= m1:
            return r0 + (z - m0) * (r1 - r0) / (m1 - m0)
    return z


def setup_projection():
    dg = bpy.context.evaluated_depsgraph_get()
    head = bpy.data.objects["hermes_head_cage"]
    me = bpy.data.meshes.new_from_object(head.evaluated_get(dg))
    bm = bmesh.new(); bm.from_mesh(me)
    uv = bm.loops.layers.uv.new("front_proj")
    for f in bm.faces:
        for l in f.loops:
            x, z = l.vert.co.x, ref_z(l.vert.co.z)
            px, py = FRONT_CX + 100 * x, CHIN_Y - 100 * z
            l[uv].uv = ((px - CROP_X0) / CW, 1 - (py - CROP_Y0) / CH)
    bm.to_mesh(me); bm.free()
    proj = bpy.data.objects.new("head_projected", me)
    bpy.context.scene.collection.objects.link(proj)
    head.hide_render = True

    img = bpy.data.images.load(os.path.join(HERE, "ref", "front.png"))
    mat = bpy.data.materials.new("front_projection")
    mat.use_nodes = True
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img
    tex.extension = "EXTEND"
    nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    me.materials.clear(); me.materials.append(mat)
    hair = bpy.data.objects["hermes_hair_cage"]
    hair.data.materials[0].diffuse_color = (0.018, 0.018, 0.024, 1)


if __name__ == "__main__":
    OUT = sys.argv[sys.argv.index("--") + 1]
    os.makedirs(OUT, exist_ok=True)
    setup_projection()
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "TEXTURE"
    sc.render.film_transparent = True
    sc.render.resolution_x, sc.render.resolution_y = 660, 600
    sc.view_settings.view_transform = "Standard"
    cam_data = bpy.data.cameras.new("likeness_cam"); cam_data.type = "ORTHO"
    cam = bpy.data.objects.new("likeness_cam", cam_data)
    sc.collection.objects.link(cam); sc.camera = cam
    views = {"front": ((0.02, -20, 1.75), (0.02, 0, 1.75), 6.6),
             "profile": ((20, 0.70, 1.75), (0, 0.70, 1.75), 6.6)}
    for tag, deg in (("tq25", 25), ("tq40", 40)):
        az, el = math.radians(deg), math.radians(10)
        views[tag] = ((20 * math.cos(el) * math.sin(az), -20 * math.cos(el) * math.cos(az), 1.9 + 20 * math.sin(el)),
                      (0, 0.3, 1.9), 7.2)
    for name, (loc, at, scale) in views.items():
        cam.location = loc
        cam.rotation_euler = (Vector(at) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        cam_data.ortho_scale = scale
        sc.render.filepath = os.path.join(OUT, f"like-{name}.png")
        bpy.ops.render.render(write_still=True)
    print("likeness", OUT)

