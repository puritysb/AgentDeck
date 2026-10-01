"""Render the INSTALLED app model (hermes-mermaid.blend) at the fitted master
camera and at the head-study front camera, lit roughly like the concept.

  blender --background assets/terrarium/hermes-mermaid.blend --python master_look.py -- <out_dir>

The master camera was fitted on the blockout (yaw 32, elev 4, ortho 7.0 blockout
units, 400 px, look-at (0, 0.4, 2.0)); head_v19 maps blockout -> head frame by
p' = (x k, (z - 1.86) k + 0.02, -y k), k = 1/8.696. The same camera expressed in
the head frame gives the same projection, so fit_master_camera's 2D transform
registers these renders onto the master too (look_compare.py).
"""
import math, os, sys
import bpy
from mathutils import Vector, Matrix

OUT = sys.argv[sys.argv.index("--") + 1]
os.makedirs(OUT, exist_ok=True)
K = 1 / 8.696
sc = bpy.context.scene
head = bpy.data.objects["hermes_head"]
HM = head.matrix_world
R = HM.to_3x3().normalized()


def bl2world_pt(p):
    return HM @ Vector((p[0] * K, (p[2] - 1.86) * K + 0.02, -p[1] * K))


def bl2world_dir(d):
    return (R @ Vector((d[0], d[2], -d[1]))).normalized()


for o in bpy.data.objects:                     # rest pose like the app: lids/mouth hidden
    if o.name in ("mouth_open", "closed_lid_left", "closed_lid_right"):
        o.hide_render = True
for o in list(bpy.data.objects):
    if o.type in ("LIGHT", "CAMERA"):
        bpy.data.objects.remove(o, do_unlink=True)

sc.render.engine = "BLENDER_EEVEE"
sc.world = bpy.data.worlds.new("Sea"); sc.world.use_nodes = True
bg = sc.world.node_tree.nodes["Background"]
bg.inputs[0].default_value = (0.004, 0.024, 0.045, 1); bg.inputs[1].default_value = 1.6
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Base Contrast"
sc.render.film_transparent = False
UPW = bl2world_dir((0, 0, 1))
for d, energy, size in (((-0.55, -0.75, 0.75), 6.0, 0), ((0.8, -0.2, 0.3), 1.6, 0), ((0.1, 0.9, 0.5), 2.5, 0)):
    L = bpy.data.lights.new("L", "SUN"); L.energy = energy; L.angle = math.radians(18)
    o = bpy.data.objects.new("L", L); sc.collection.objects.link(o)
    w = bl2world_dir(d)
    o.rotation_euler = (-w).to_track_quat("-Z", "Y").to_euler()

cd = bpy.data.cameras.new("C"); cd.type = "ORTHO"
cam = bpy.data.objects.new("C", cd); sc.collection.objects.link(cam); sc.camera = cam


def shoot(name, at, d, scale, rx, ry):
    sc.render.resolution_x, sc.render.resolution_y = rx, ry
    target = bl2world_pt(at)
    dw = bl2world_dir(d)
    cam.location = target + dw * 3.0
    fwd = -dw
    right = fwd.cross(UPW).normalized(); up = right.cross(fwd).normalized()
    cam.matrix_world = Matrix((right, up, -fwd)).transposed().to_4x4() @ Matrix.Identity(4)
    cam.location = target + dw * 3.0
    cd.ortho_scale = scale * K
    sc.render.filepath = os.path.join(OUT, name + ".png")
    bpy.ops.render.render(write_still=True)


a, e = math.radians(32), math.radians(4)
shoot("look-master", (0, 0.4, 2.0), (math.cos(e) * math.sin(a), -math.cos(e) * math.cos(a), math.sin(e)), 7.0, 400, 400)
shoot("look-front", (0.02, 0.0, 1.75), (0, -1, 0), 6.6, 660, 600)
shoot("look-profile", (0.0, 0.70, 1.75), (1, 0, 0), 6.6, 660, 600)
print("master_look", OUT)
