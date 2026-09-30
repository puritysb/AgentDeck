"""Measure the Hermes model against 2D turnaround views, silhouette by silhouette.

For each reference view, the reference image is segmented by colour into hair,
light (skin, eyes, headset) and teal (tail), then the model is rendered from the
matching orthographic camera with the same flat class colours. Both figures are
cropped to their bounding box and scaled to the same height, so the comparison
measures proportion (head size, hair volume, tail length), not pixel placement.

Writes <out>/fit.json (IoU per class per view) and <out>/<view>-overlay.png:
red = reference only, cyan = model only, grey = both.

Run:
  blender --background <model.blend> --python assets/terrarium/fit-hermes-views.py -- \
      --views front=path.png@0 three-quarter=path.png@45 ... --out DIR
The angle is the camera azimuth in degrees: 0 = front, 90 = profile facing the
viewer's left, 180 = back.
"""
import bpy, sys, json, math
from pathlib import Path
from mathutils import Vector, Matrix
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
OUT = Path(argv[argv.index('--out') + 1]); OUT.mkdir(parents=True, exist_ok=True)
VIEWS = []
for tok in argv[argv.index('--views') + 1:]:
    if tok.startswith('--'): break
    name, rest = tok.split('=', 1); path, ang = rest.rsplit('@', 1)
    VIEWS.append((name, Path(path), float(ang)))

CLASSES = ('hair', 'light', 'teal')
H = 512                       # comparison height in pixels

def load_rgb(path):
    img = bpy.data.images.load(str(path), check_existing=False)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1, :, :3]
    bpy.data.images.remove(img)
    return px   # sRGB-encoded floats 0..1, row 0 = top

def segment(rgb, bg):
    """Label pixels 0=background, 1=hair, 2=light, 3=teal by colour."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    lum = .2126 * r + .7152 * g + .0722 * b
    mx, mn = rgb.max(-1), rgb.min(-1)
    sat = (mx - mn) / np.maximum(mx, 1e-4)
    dist_bg = np.linalg.norm(rgb - bg, axis=-1)
    lab = np.zeros(lum.shape, np.uint8)
    fg = dist_bg > .06
    teal = fg & (sat > .22) & (g > r + .06) & (lum > .16)
    light = fg & ~teal & (lum > .55)
    hair = fg & ~teal & ~light & (lum < .42)
    lab[hair] = 1; lab[light] = 2; lab[teal] = 3
    return lab

def normalise(lab):
    """Crop to the figure's bounding box and scale to height H (nearest)."""
    ys, xs = np.nonzero(lab)
    if len(ys) == 0: return np.zeros((H, H), np.uint8)
    crop = lab[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = crop.shape; W = max(1, round(w * H / h))
    yi = (np.arange(H) * h / H).astype(int); xi = (np.arange(W) * w / W).astype(int)
    return crop[yi][:, xi]

def pad_to(a, W):
    out = np.zeros((a.shape[0], W), np.uint8); off = (W - a.shape[1]) // 2
    out[:, off:off + a.shape[1]] = a; return out

# ---- model render with flat class colours --------------------------------
scene = bpy.context.scene
root = bpy.data.objects.get('resident_hermes')
if root: root.rotation_euler.x = 0
CLASS_RGB = {'hair': (0.0, 0.0, 0.0), 'light': (1.0, 1.0, 1.0), 'teal': (0.0, 0.6, 0.45)}
def flat(name, rgb):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs[0].default_value = (*rgb, 1)
    o = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e.outputs[0], o.inputs[0])
    return m
FLAT = {k: flat('fit_' + k, v) for k, v in CLASS_RGB.items()}
def material_class(mat):
    n = (mat.name if mat else '').lower()
    if 'teal' in n or 'fin' in n: return 'teal'
    if 'hair' in n: return 'hair'
    return 'light'
for o in bpy.data.objects:
    if o.type != 'MESH': continue
    if o.name in ('mouth_open', 'closed_lid_left', 'closed_lid_right'): o.hide_render = True
    for slot in o.material_slots: slot.material = FLAT[material_class(slot.material)]
scene.world = bpy.data.worlds.new('fit'); scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.2, 0.0, 0.2, 1)
scene.render.engine = 'BLENDER_EEVEE'
scene.view_settings.view_transform = 'Standard'
scene.render.resolution_x, scene.render.resolution_y = 800, 1200
scene.render.film_transparent = False
for o in list(bpy.data.objects):
    if o.type in ('CAMERA', 'LIGHT'): bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.camera_add(); cam = bpy.context.object; scene.camera = cam
cam.data.type = 'ORTHO'; cam.data.ortho_scale = 1.35
target = Vector((0, -.08, 0))

report = {}
for name, path, ang in VIEWS:
    a = math.radians(ang)
    d = Vector((math.sin(a), 0, math.cos(a)))
    cam.location = target + d * 4
    back = d; right = Vector((0, 1, 0)).cross(back).normalized(); up = back.cross(right)
    cam.rotation_euler = Matrix((right, up, back)).transposed().to_euler()
    shot = OUT / f'{name}-model.png'
    scene.render.filepath = str(shot); bpy.ops.render.render(write_still=True)
    mrgb = load_rgb(shot)
    mlab = np.zeros(mrgb.shape[:2], np.uint8)
    cols = np.array([CLASS_RGB[c] for c in CLASSES]); bgc = np.array((0.2, 0.0, 0.2))
    dists = np.stack([np.linalg.norm(mrgb - bgc, axis=-1)] + [np.linalg.norm(mrgb - c, axis=-1) for c in cols], -1)
    mlab = dists.argmin(-1).astype(np.uint8)
    rrgb = load_rgb(path)
    corner = np.concatenate([rrgb[:8, :8].reshape(-1, 3), rrgb[:8, -8:].reshape(-1, 3)]).mean(0)
    rlab = segment(rrgb, corner)
    rn, mn_ = normalise(rlab), normalise(mlab)
    W = max(rn.shape[1], mn_.shape[1]); rn, mn_ = pad_to(rn, W), pad_to(mn_, W)
    row = {}
    for i, c in enumerate(('all',) + CLASSES):
        ra = rn > 0 if c == 'all' else rn == i
        ma = mn_ > 0 if c == 'all' else mn_ == i
        union = (ra | ma).sum(); row[c] = round(float((ra & ma).sum() / union), 3) if union else None
    def extent(mask, axis):
        """Span of rows (axis=1) or columns (axis=0) holding a real share of the
        class; stray antialiased edge pixels must not stretch the measurement."""
        counts = mask.sum(axis=axis); idx = np.nonzero(counts > max(3, .04 * counts.max()))[0] if counts.max() else []
        return round(float((idx.max() - idx.min()) / H), 3) if len(idx) else None
    row['hair_height_ratio'] = {'reference': extent(rn == 1, 1), 'model': extent(mn_ == 1, 1)}
    row['hair_width_over_height'] = {'reference': extent(rn == 1, 0), 'model': extent(mn_ == 1, 0)}
    report[name] = row
    ov = np.zeros((H, W, 3), np.float32) + .08
    ra, ma = rn > 0, mn_ > 0
    ov[ra & ~ma] = (.9, .25, .25); ov[ma & ~ra] = (.2, .8, .9); ov[ra & ma] = (.55, .55, .55)
    ov[(rn == 1) & (mn_ == 1)] = (.3, .3, .3)
    img = bpy.data.images.new(f'{name}-overlay', W, H)
    img.pixels[:] = np.concatenate([ov[::-1], np.ones((H, W, 1), np.float32)], -1).ravel()
    img.filepath_raw = str(OUT / f'{name}-overlay.png'); img.file_format = 'PNG'; img.save()
(OUT / 'fit.json').write_text(json.dumps(report, indent=2) + '\n')
print('FIT', json.dumps(report))
