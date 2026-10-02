"""Render flat material-ID silhouettes over a yaw x elevation grid (for fitting
a camera to the uncalibrated master concept).
  blender --background <blend> --python render_views.py -- <out_dir> <yaw0> <yaw1> <ystep> <el0> <el1> <estep>
Camera: orthographic, scale 7.0, 400x400, looking at (0, 0.4, 2.0). Yaw turns the
camera from the front toward her left (+X) so the face points image-left, like
the master; positive elevation looks down."""
import math, os, sys
import bpy
from mathutils import Vector
a = sys.argv[sys.argv.index("--") + 1:]
LIKE = "--like" in a
STUDIO = "--studio" in a      # lit grey for judging form (default: flat ID pass)
a = [x for x in a if x not in ("--like", "--studio")]
if LIKE:  # project the reference front face so features can be matched too
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import likeness_preview
    likeness_preview.setup_projection()
OUT = a[0]; y0, y1, ys, e0, e1, es = map(float, a[1:7])
os.makedirs(OUT, exist_ok=True)
sc = bpy.context.scene
sc.render.engine = "BLENDER_WORKBENCH"; sc.display.shading.light = "STUDIO" if STUDIO else "FLAT"
sc.display.shading.color_type = "TEXTURE" if LIKE else "MATERIAL"; sc.render.film_transparent = True
sc.render.resolution_x = sc.render.resolution_y = 400
sc.view_settings.view_transform = "Standard"
cd = bpy.data.cameras.new("fit"); cd.type = "ORTHO"; cd.ortho_scale = 7.0
cam = bpy.data.objects.new("fit", cd); sc.collection.objects.link(cam); sc.camera = cam
AT = Vector((0, 0.4, 2.0))
def frange(s, e, st):
    v = s
    while v <= e + 1e-6:
        yield round(v, 2); v += st
for yaw in frange(y0, y1, ys):
    for el in frange(e0, e1, es):
        ya, ea = math.radians(yaw), math.radians(el)
        cam.location = AT + 20 * Vector((math.cos(ea) * math.sin(ya), -math.cos(ea) * math.cos(ya), math.sin(ea)))
        cam.rotation_euler = (AT - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(OUT, f"y{yaw:g}_e{el:g}.png")
        bpy.ops.render.render(write_still=True)
