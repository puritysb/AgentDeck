"""Render the blockout at the reference cameras (grey, Workbench).

  blender --background <blockout.blend> --python review_blockout.py -- <out_dir>

front/profile cameras are orthographic and pixel-registered to ref/front.png and
ref/profile.png (crops of candidate-02, 660x600). three-quarter is a judgment
view only; the master concept is not a calibrated camera.
"""
import math, os, sys
import bpy
from mathutils import Vector

OUT = sys.argv[sys.argv.index("--") + 1]
os.makedirs(OUT, exist_ok=True)
sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"
sc.display.shading.light = "STUDIO"
sc.display.shading.color_type = "MATERIAL"
sc.display.shading.show_cavity = False
sc.render.film_transparent = True
sc.render.resolution_x, sc.render.resolution_y = 660, 600
sc.view_settings.view_transform = "Standard"

VIEWS = {
    # name: (location, look-at, ortho_scale)
    "front": ((0.02, -20, 1.75), (0.02, 0, 1.75), 6.6),
    "profile": ((20, 0.70, 1.75), (0, 0.70, 1.75), 6.6),
}
az, el, d = math.radians(40), math.radians(10), 20
VIEWS["three-quarter"] = ((d * math.cos(el) * math.sin(az), -d * math.cos(el) * math.cos(az), 1.9 + d * math.sin(el)),
                          (0, 0.3, 1.9), 7.2)

cam_data = bpy.data.cameras.new("review_cam")
cam_data.type = "ORTHO"
cam = bpy.data.objects.new("review_cam", cam_data)
sc.collection.objects.link(cam)
sc.camera = cam
for name, (loc, at, scale) in VIEWS.items():
    cam.location = loc
    cam.rotation_euler = (Vector(at) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    cam_data.ortho_scale = scale
    sc.render.filepath = os.path.join(OUT, f"{name}.png")
    sc.display.shading.light = "STUDIO"
    bpy.ops.render.render(write_still=True)
    if name != "three-quarter":  # flat material-ID pass for scoring (no shading)
        sc.display.shading.light = "FLAT"
        for ob in bpy.data.objects:   # the white headset would read as skin
            if ob.name.startswith("hermes_headset"):
                ob.hide_render = True
        sc.render.filepath = os.path.join(OUT, f"{name}-id.png")
        bpy.ops.render.render(write_still=True)
        for ob in bpy.data.objects:
            if ob.name.startswith("hermes_headset"):
                ob.hide_render = False
print("rendered", OUT)
