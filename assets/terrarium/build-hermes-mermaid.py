"""Hermes (Nous girl) mermaid, built from the official mark (`design/brand/hermes.svg`).

v19: the head (skin, faceted hair, flicked locks, headset) is the measured
blockout from `hermes-head/` (see its NOTES.md), converted by `head_v19.py`.
The face artwork is the v18 drawing code with proportions re-measured from the
guide (`hermes-head/face_v2.py`), laid on that head as decals.
(v18 text follows.) The face is designed as a flat sheet in `hermes_face.py`
and laid onto a head fitted to that sheet. The mark's white arc is a headset: its
band runs over the crown into the hair, with a yoke at each side and the earcups
hidden. Its white strokes on the hair are light, so the hair is satin black
with broad strand grooves and no painted highlights. The bangs are the front of
the hair shell, and the body, tail and fins are smooth.

Face artwork is decals projected onto the face mesh and oriented per triangle,
because RealityKit culls back faces. The schema-2 contract (bone names, control
empties, skinned meshes) is unchanged, so HermesMermaid.swift / HermesSwim.swift
drive it without code changes.

Run:  blender --background --python assets/terrarium/build-hermes-mermaid.py [-- --preview-only] [--out DIR] [--views front,mark,face]
      Writes the app USDZ, the portable GLB, hermes-mermaid.blend and hermes-rig.json
      (--preview-only skips them) plus review renders and a USDZ under --out.
"""
from pathlib import Path
import bpy, bmesh, math, re, json, sys
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree
from mathutils.geometry import tessellate_polygon

ROOT = Path(__file__).resolve().parents[2]
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
INSTALL = '--preview-only' not in argv
OUT = Path(argv[argv.index('--out') + 1]) if '--out' in argv else ROOT / 'diagnostics/hermes-mermaid/nous-v19'
OUT.mkdir(parents=True, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene
tokens = (ROOT / 'design/tokens.css').read_text()

def token_rgb(token):
    value = re.search(r'--' + token + r':\s*#([0-9a-fA-F]{6})', tokens).group(1)
    rgb = [int(value[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in rgb]

def material(name, token, roughness=.8, specular=.15, glow=0.0, scale=1.0, neutral=False):
    rgb = [c * scale for c in token_rgb(token)]
    if neutral: rgb = [sum(rgb) / 3] * 3   # the Nous girl is monochrome
    m = bpy.data.materials.new(name); m.use_nodes = True
    p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*rgb, 1)
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Specular IOR Level'].default_value = specular
    if glow:
        p.inputs['Emission Color'].default_value = (*rgb, 1)
        p.inputs['Emission Strength'].default_value = glow
    return m

# Ink on cream: the mark's two tones are the design system's ink and tide sand.
skin = material('Ivory skin', 'tide-100', .75, .10, glow=.03)
# v19: the master's warm ivory (sampled ~#f3e6da on the lit cheek), set directly;
# tide-100 rendered grey-green and its glow flattened the face's soft shading.
skin.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (.83, .69, .60, 1)   # measured under the app's lights against the concept's lit cheek (~247/235/226) without clipping
# The concept's skin is matte: RealityKit's image light left a white hotspot on
# the forehead and cheek at the default IOR, so the reflection is cut as for the hair.
skin.node_tree.nodes['Principled BSDF'].inputs['IOR'].default_value = 1.15
# The concept's face is flat-lit ivory: a little self-light so the side and
# underside planes don't fall into heavy shadow under the app's high sun.
skin.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value = (.80, .66, .57, 1)
skin.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = .22
# Glossy black: the mark's white strokes on the hair are light reflections, so
# they must come from the material, not from painted decals.
hair = material('Nous ink hair', 'ink-900', .35, .10, scale=.045, neutral=True)
# v19: the master's hair is a cool navy-black (mean sRGB ~ 29/34/43, facet
# highlights up to ~100), not neutral: tinted base and a little more sheen.
hair.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (.012, .015, .024, 1)
# RealityKit's image light made any specular read as a flat grey sheen (median
# 59 vs the concept's 27): the concept's facets are diffuse shade, so the
# reflection is cut with a low IOR (UsdPreviewSurface carries ior, not
# Blender's specular level).
hair.node_tree.nodes['Principled BSDF'].inputs['IOR'].default_value = 1.12
# The concept's hair is a near-flat ink (~26 sRGB top to bottom on the sheet);
# under the app's high sun the crown read ~52 and the fringe hem ~16, a dark
# band between. Lower albedo plus a faint navy emission narrows that range.
_hb = hair.node_tree.nodes['Principled BSDF']
_hb.inputs['Base Color'].default_value = tuple(c * 0.3 for c in _hb.inputs['Base Color'].default_value[:3]) + (1,)
_hb.inputs['Emission Color'].default_value = (.0045, .0058, .0095, 1); _hb.inputs['Emission Strength'].default_value = 3.0
hair_under = material('Hair under-layer', 'ink-900', .9, .05, scale=.12, neutral=True)
line = material('Ink line', 'ink-900', .9, .0, scale=.30, neutral=True)
iris = material('Iris', 'ink-900', .4, .3, scale=.22, neutral=True)
white = material('Cream accents', 'tide-50', .6, .1, glow=.30)
lip = material('Soft ink', 'ink-500', .8, .1, scale=1.1, neutral=True)
lip_dark = material('Lip ink', 'ink-700', .7, .1, scale=.9, neutral=True)
line_dark = material('Clasp dot', 'ink-900', .5, .2, scale=.3, neutral=True)
teal = material('Mermaid teal', 'kelp-500', .5, .3)
finmat = material('Fin teal', 'kelp-300', .45, .3, glow=.04)

def joint(name, parent=None, pos=(0, 0, 0)):
    o = bpy.data.objects.new(name, None); scene.collection.objects.link(o)
    o.parent = parent; o.location = pos; return o

def mesh(name, vs, fs, mat, parent, smooth=False):
    d = bpy.data.meshes.new(name); d.from_pydata([tuple(v) for v in vs], [], fs); d.update()
    o = bpy.data.objects.new(name, d); scene.collection.objects.link(o); o.parent = parent
    d.materials.append(mat)
    for p in d.polygons: p.use_smooth = smooth
    return o

def bm_to(name, bm, mat, parent, smooth=False):
    d = bpy.data.meshes.new(name); bm.to_mesh(d); bm.free()
    o = bpy.data.objects.new(name, d); scene.collection.objects.link(o); o.parent = parent
    d.materials.append(mat)
    for p in d.polygons: p.use_smooth = smooth
    return o

def apply_mod(o, kind, **kw):
    m = o.modifiers.new(kind, kind)
    for k, v in kw.items(): setattr(m, k, v)
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=m.name)

def fix_normals(o):
    bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(o.data); bm.free()

def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a))); return t * t * (3 - 2 * t)

def lerp(a, b, t): return a + (b - a) * t

# ---------------------------------------------------------------- rig ----
bone_specs = [('spine', None, (0, 0, 0)), ('tail_base', 'spine', (0, -.15, 0)),
              ('tail_mid', 'tail_base', (0, -.26, -.03)), ('tail_tip', 'tail_mid', (0, -.36, -.085)),
              ('fin', 'tail_tip', (0, -.445, -.15)), ('fin_left', 'fin', (-.05, -.48, -.17)),
              ('fin_right', 'fin', (.05, -.48, -.17))]
for side, label in [(-1, 'left'), (1, 'right')]:
    bone_specs += [(f'arm_{label}', 'spine', (side * .068, -.030, .004)),       # v19: follow the broader shoulders
                   (f'elbow_{label}', f'arm_{label}', (side * .118, -.115, .036)),
                   (f'wrist_{label}', f'elbow_{label}', (side * .090, -.170, .094))]
root = joint('resident_hermes')
bpy.ops.object.armature_add(); rig = bpy.context.object; rig.name = 'hermes_skeleton'; rig.parent = root
bpy.ops.object.mode_set(mode='EDIT'); rig.data.edit_bones.remove(rig.data.edit_bones[0])
for name, parent, pos in bone_specs:
    b = rig.data.edit_bones.new(name); b.head = pos; b.tail = Vector(pos) + Vector((0, .05, 0)); b.roll = 0
    if parent: b.parent = rig.data.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT'); rig.show_in_front = True
for b in rig.pose.bones: b.rotation_mode = 'QUATERNION'

def skin_mesh(obj, weights):
    for name, _, _ in bone_specs: obj.vertex_groups.new(name=name)
    for i, w in enumerate(weights):
        total = sum(w.values())
        for name, value in w.items():
            if value > 0: obj.vertex_groups[name].add([i], value / total, 'REPLACE')
    m = obj.modifiers.new('Skin', 'ARMATURE'); m.object = rig; m.use_deform_preserve_volume = False
    obj.parent = rig
    return obj

def chain(t, stops):
    if t <= stops[0][0]: return {stops[0][1]: 1}
    for (a, an), (b, bn) in zip(stops, stops[1:]):
        if t <= b:
            u = smoothstep(a, b, t); return {an: 1 - u, bn: u} if an != bn else {an: 1}
    return {stops[-1][1]: 1}

def tube(name, parent, points, radii, mat, sides=10, smooth=True, flat=1.0):
    vs, fs = [], []
    for j, point in enumerate(points):
        p = Vector(point); t = (Vector(points[min(j + 1, len(points) - 1)]) - Vector(points[max(0, j - 1)])).normalized()
        n = t.cross(Vector((0, 0, 1))).normalized()
        if n.length < .01: n = t.cross(Vector((1, 0, 0))).normalized()
        b = t.cross(n).normalized()
        for i in range(sides):
            a = 2 * math.pi * i / sides; vs.append(p + radii[j] * (math.cos(a) * n + math.sin(a) * b * flat))
    for j in range(len(points) - 1):
        for i in range(sides):
            a = j * sides + i; b = j * sides + (i + 1) % sides; fs.append((a, b, b + sides, a + sides))
    fs += [tuple(reversed(range(sides))), tuple(range((len(points) - 1) * sides, len(points) * sides))]
    o = mesh(name, vs, fs, mat, parent, smooth); fix_normals(o)
    return o

def ellipsoid(name, parent, pos, radii, mat, seg=20, rings=12, smooth=True):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings)
    o = bpy.context.object; o.name = name; o.data.name = name
    for v in o.data.vertices: v.co = Vector((v.co.x * radii[0], v.co.y * radii[1], v.co.z * radii[2])) + Vector(pos)
    o.parent = parent; o.data.materials.append(mat)
    for p in o.data.polygons: p.use_smooth = smooth
    return o

# --------------------------------------------------------- body + tail ----
# Slender neck, sloping shoulders, a sweetheart top and a smooth tail. (Rotating
# alternate rings half a step gives diamond facets; they read as a body in pieces.)
SIDES = 24
stations = [  # y, z-centre, rx, rz, kind
    (.070, .000, .030, .027, 'skin'), (.010, .000, .031, .028, 'skin'),   # v19: thicker neck; the painted face neck (head_v19 NECK_R) sits just outside it
    (-.014, .000, .068, .037, 'skin'), (-.032, .000, .106, .050, 'skin'),   # v19: the master's chibi body is chunky,
    (-.054, .002, .106, .053, 'neck'),                                       # chest about as wide as the face
    (-.090, .004, .084, .052, 'teal'), (-.130, .003, .072, .048, 'teal'),
    (-.180, .000, .094, .066, 'teal'), (-.232, -.012, .086, .062, 'teal'),
    (-.288, -.034, .062, .051, 'teal'), (-.342, -.066, .045, .039, 'teal'),
    (-.392, -.104, .029, .027, 'teal'), (-.430, -.138, .016, .016, 'teal'),
    (-.452, -.160, .008, .008, 'teal')]
# Resample the stations with Catmull-Rom: straight segments between a dozen rings
# showed as horizontal bands once the surface was remeshed and smoothed.
def _resample(st, per=5):
    out = []
    for j in range(len(st) - 1):
        a, b, c, d = st[max(j - 1, 0)], st[j], st[j + 1], st[min(j + 2, len(st) - 1)]
        for q in range(per):
            t = q / per
            vals = [.5 * (2 * b[i] + (-a[i] + c[i]) * t + (2 * a[i] - 5 * b[i] + 4 * c[i] - d[i]) * t * t + (-a[i] + 3 * b[i] - 3 * c[i] + d[i]) * t ** 3) for i in range(4)]
            out.append((*vals, 'teal' if b[4] == 'teal' and q else b[4] if q == 0 else ('teal' if c[4] == 'teal' and b[4] != 'skin' else b[4] if b[4] == 'skin' and c[4] == 'skin' else 'teal')))
    out.append(st[-1])
    return out
stations = _resample(stations)
off = lambda j: False   # smooth tail: the diamond facets read as a body in pieces
vs, fs, ws, mats = [], [], [], []
for j, (y, zc, rx, rz, kind) in enumerate(stations):
    for i in range(SIDES):
        a_ = 2 * math.pi * (i + (.5 if off(j) else 0)) / SIDES  # a=0 at the front (+Z)
        yy = y
        if kind == 'neck': yy = y - .026 * max(0, math.cos(a_)) ** 6 + .006 * (1 - max(0, math.cos(a_)))
        vs.append((math.sin(a_) * rx, yy, zc + math.cos(a_) * rz))
        ws.append(chain(-yy, [(-.02, 'spine'), (.12, 'spine'), (.20, 'tail_base'), (.30, 'tail_mid'),
                              (.39, 'tail_tip'), (.45, 'fin')]))
for j in range(len(stations) - 1):
    m = 0 if stations[j][4] != 'teal' and stations[j + 1][4] != 'teal' else 1
    for i in range(SIDES):
        a0 = j * SIDES + i; b0 = j * SIDES + (i + 1) % SIDES
        if off(j + 1) and not off(j):      # next ring half a step ahead: diamond facets
            fs += [(a0, b0, a0 + SIDES), (b0, b0 + SIDES, a0 + SIDES)]; mats += [m, m]
        elif off(j) and not off(j + 1):
            fs += [(a0, b0, b0 + SIDES), (a0, b0 + SIDES, a0 + SIDES)]; mats += [m, m]
        else:
            fs.append((a0, b0, b0 + SIDES, a0 + SIDES)); mats.append(m)
fs.append(tuple(reversed(range(SIDES)))); mats.append(0)
fs.append(tuple(range((len(stations) - 1) * SIDES, len(stations) * SIDES))); mats.append(1)
body = mesh('hermes_body_skin', vs, fs, skin, root, True)
body.data.materials.append(teal)
for p_, m in zip(body.data.polygons, mats): p_.material_index = m; p_.use_smooth = True
fix_normals(body)

# Fluke: two broad smooth lobes with a soft ridge,
# spreading sideways, down and back.
for side, label in [(-1, 'left'), (1, 'right')]:
    R = Vector((side * .004, -.450, -.162)); D = Vector((side * .190, -.170, -.115))
    W = D.cross(Vector((0, 0, 1))).normalized(); N = D.cross(W).normalized()
    vs, fs, ww = [], [], []; rows, cols = 12, 7
    for j in range(rows):
        t = j / (rows - 1); width = math.sin(math.pi * t) ** .6 * .085 * (1 - .30 * t) + .003
        for k in range(cols):
            u = 2 * k / (cols - 1) - 1
            vs.append(R + D * (t + .12 * u * t) + W * u * width + N * .024 * math.sin(math.pi * t) * (1 - abs(u)))
            ww.append(chain(t, [(0, 'fin'), (.5, 'fin_' + label)]))
    for j in range(rows - 1):
        for k in range(cols - 1):
            a0 = j * cols + k; fs += [(a0, a0 + 1, a0 + 1 + cols), (a0, a0 + 1 + cols, a0 + cols)] if (j + k) % 2 else [(a0, a0 + 1, a0 + cols), (a0 + 1, a0 + 1 + cols, a0 + cols)]
    fin = mesh('fin_surface_' + label, vs, fs, finmat, root, True)
    apply_mod(fin, 'SOLIDIFY', thickness=.008, offset=0)
    for p_ in fin.data.polygons: p_.use_smooth = True
    skin_mesh(fin, ww + ww)  # solidify duplicates the vertex list in order

# Slender arms that reach the hips, with a soft mitten hand and thumb. Torso,
# arms and hands are fused into ONE surface (voxel remesh + smooth): separate
# tubes and balls met the torso in visible steps at the shoulder and wrist.
ARM_PATHS = {}
parts = [body]
TORSO_BVH = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())   # before the fusion
for side, label in [(-1, 'left'), (1, 'right')]:
    # v19: the master's rest pose has the elbows bent and the hands brought
    # forward in front of the body (the swim pose adds small rotations on top)
    pts = [(side * .034, -.012, .001), (side * .086, -.030, .004), (side * .110, -.072, .016), (side * .118, -.115, .036),
           (side * .106, -.148, .070), (side * .090, -.170, .094), (side * .076, -.183, .108), (side * .070, -.190, .114)]
    radii = [.032, .028, .024, .020, .018, .0155, .0145, .0130]   # v19: the master's soft, chunky arms
    ARM_PATHS[label] = ([Vector(p) for p in pts], radii)
    parts.append(tube('arm_' + label, root, pts[:-1], radii[:-1], skin, 16))
    hand = ellipsoid('hand_' + label, root, (side * .072, -.192, .116), (.016, .022, .013), skin, 20, 12)
    thumb = ellipsoid('thumb_' + label, root, (side * .060, -.184, .124), (.0070, .012, .0070), skin, 12, 8)
    parts += [hand, thumb]
bpy.ops.object.select_all(action='DESELECT')
for o in parts: o.select_set(True)
bpy.context.view_layer.objects.active = body; bpy.ops.object.join()
apply_mod(body, 'REMESH', mode='VOXEL', voxel_size=.0032)   # v19: the broader body at .0027 cost 110k tris; .0032 keeps the v18 budget
apply_mod(body, 'SMOOTH', factor=.6, iterations=6)
body.data.materials.clear(); body.data.materials.append(skin); body.data.materials.append(teal)
for p_ in body.data.polygons: p_.use_smooth = True
fix_normals(body)

def arm_hit(p, label):
    """(distance to the arm path minus its radius, fractional path index)."""
    path, radii = ARM_PATHS[label]; best = (1e9, 0.0)
    for i in range(len(path) - 1):
        a, b = path[i], path[i + 1]; ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
        d = (p - (a + ab * t)).length - lerp(radii[i], radii[i + 1], t)
        if d < best[0]: best = (d, i + t)
    return best
def torso_weights(y):
    return chain(-y, [(-.02, 'spine'), (.12, 'spine'), (.20, 'tail_base'), (.30, 'tail_mid'), (.39, 'tail_tip'), (.45, 'fin')])
def neckline(x, z):   # sweetheart top: skin above, teal below
    c = max(0.0, math.cos(math.atan2(x, z)))
    return -.054 - .026 * c ** 6 + .006 * (1 - c)
weights, arm_share = [], []
for v in body.data.vertices:
    p = v.co; w = torso_weights(p.y); share = 0.0
    if abs(p.x) > .012:
        label = 'right' if p.x > 0 else 'left'
        d, u = arm_hit(p, label)
        # Ownership by the nearer source surface: a torso vertex close to the arm
        # must not follow it (that stretched the hip into spikes when she waved).
        d_torso = TORSO_BVH.find_nearest(p)[3]
        share = smoothstep(-.008, .008, d_torso - d) * smoothstep(.2, 1.6, u)
        if share > 0:
            aw = chain(u, [(1, 'arm_' + label), (3, 'elbow_' + label), (5, 'wrist_' + label)])
            w = {k: w.get(k, 0) * (1 - share) + aw.get(k, 0) * share for k in set(w) | set(aw)}
    weights.append(w); arm_share.append(share)
# Snap the vertices nearest the neckline onto it, so the skin/teal border is a
# clean curve rather than the remesh grid's staircase.
for v, share in zip(body.data.vertices, arm_share):
    if share < .5:
        ny = neckline(v.co.x, v.co.z)
        if abs(v.co.y - ny) < .0013: v.co.y = ny
for poly in body.data.polygons:
    c = poly.center; arm = max(arm_share[i] for i in poly.vertices) > .5
    poly.material_index = 0 if arm or c.y > neckline(c.x, c.z) + 1e-5 else 1
skin_mesh(body, weights)

# ---------------------------------------------------------------- head ----
spine = joint('hermes_spine', root)
head = joint('hermes_head', spine, (0, .196, .006))   # v19: the concept's chin sits almost on the shoulders (was .215)
# The face is designed as a flat sheet in hermes_face.py (the approved 2D
# source); this builder only shapes a head to fit that sheet and lays its
# artwork on it unchanged.
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / 'hermes-head'))
from face_v2 import F      # v18 drawing code, proportions re-measured from the guide
import head_v19
def palette_material(name, key, roughness=.8, specular=.1, glow=0.0):
    h = F.PALETTE[key][1:]; rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    rgb = [v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in rgb]
    m = bpy.data.materials.new(name); m.use_nodes = True; p = m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value = (*rgb, 1); p.inputs['Roughness'].default_value = roughness
    p.inputs['Specular IOR Level'].default_value = specular
    if glow: p.inputs['Emission Color'].default_value = (*rgb, 1); p.inputs['Emission Strength'].default_value = glow
    return m
m_white = palette_material('Eye white', 'white', .6, .1, glow=.15)
m_lidshadow = palette_material('Lid shadow', 'lid_shadow')
m_iris = palette_material('Iris', 'iris', .4, .3)
m_glow = palette_material('Iris glow', 'glow', .5, .2)
m_line = palette_material('Ink line', 'line', .9, .0)
m_shade = palette_material('Nose shade', 'shade')
m_lip = palette_material('Lower lip', 'lip', .6, .2)
m_lipdark = palette_material('Upper lip', 'lip_dark', .6, .2)
# The head (skin, hair, locks, headset) is authored as a blockout in
# assets/terrarium/hermes-head/ and fitted to the guide by measurement; see its
# NOTES.md. head_v19 converts it into this frame and names the parts.
face = head_v19.build(head, {'skin': skin, 'hair': hair, 'under': hair, 'white': white, 'dot': line_dark}, joint)   # under-layer in the same ink: a darker one showed through the lock seams as jagged teeth
# The body's shoulders and chest face up into the app's high sun (cos ~0.78 vs
# ~0.49 for the forward-facing face) and clipped to white under the chin. A
# slightly darker body skin renders at the face's brightness there.
skin_body = skin.copy(); skin_body.name = 'Ivory skin (body)'
_b = skin_body.node_tree.nodes['Principled BSDF'].inputs['Base Color']
_b.default_value = tuple(c * 0.70 for c in _b.default_value[:3]) + (1,)
for _i, _m in enumerate(body.data.materials):
    if _m == skin: body.data.materials[_i] = skin_body
bpy.context.view_layer.update()
FACE_BVH = BVHTree.FromObject(face, bpy.context.evaluated_depsgraph_get())
def face_hit(x, y):
    hit, normal, _, _ = FACE_BVH.ray_cast(Vector((x, y, 1)), Vector((0, 0, -1)))
    return hit, normal
def face_z(x, y):
    hit, _ = face_hit(x, y); return hit.z if hit else 0.0
# No custom split normals: bending face normals toward a sphere renders as a
# dotted speckle in RealityKit after Blender's USD export (verified against a
# no-normals control).

def decal(name, parent, outline, depth, mat, cuts=3):
    """Sheet artwork on the face: subdivided, then every vertex projected onto the face mesh."""
    bm = bmesh.new(); verts = [bm.verts.new((x, y, 0)) for x, y in outline]
    # Scanfill keeps every triangle inside a concave outline.
    for tri in tessellate_polygon([[Vector((x, y, 0)) for x, y in outline]]):
        try:
            bm.faces.new([verts[i] for i in tri])
        except ValueError:
            pass
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    # ...and no edge may stay long: a long triangle projected onto the curved face
    # is a chord through the head that pokes out near one end. With v19's wider
    # eyes the closed lid's wing reaches round the side of the face and did exactly
    # that (a dark chip above the lid in the RealityKit blink check, 2026-10-01).
    for _ in range(8):
        long_edges = [e for e in bm.edges if e.calc_length() > .007]
        if not long_edges: break
        bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=bm.faces[:])
    base = Vector((0, 0, 0)); p = parent
    while p is not None and p != head: base += p.location; p = p.parent
    surface = {}
    for v in bm.verts:
        x, y = v.co.x + base.x, v.co.y + base.y
        hit, normal = face_hit(x, y)
        # v19's face is round, so a ray from the front that hits its side is still
        # right. v18 treated normal.z < .2 as "past the face plane" and snapped to
        # the surface nearest (x, y, .2), which on this head threw the closed lid's
        # side vertices onto the front: dark chips above the lids (2026-10-01).
        if hit is None:                            # outside the silhouette: nearest surface from the mid-plane
            hit, normal, _, _ = FACE_BVH.find_nearest(Vector((x, y, 0)))
        surface[v] = normal
        v.co = hit + normal * depth - base
    # drop slivers the projection flattened to nothing: their normal is noise
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.calc_area() < 1e-10], context='FACES_ONLY')
    for f in bm.faces:  # RealityKit culls back faces: orient against the surface under each triangle
        f.normal_update()
        # judged exactly as the rest-pose check below does (nearest surface at the centre)
        under = FACE_BVH.find_nearest(f.calc_center_median() + base)[1]
        if f.normal.dot(under if under is not None else sum((surface[v] for v in f.verts), Vector())) < 0: f.normal_flip()
    # faces standing edge-on to the surface (where a wide liner wing wraps round
    # the side of the face) have an orientation decided by float noise, and
    # cannot be seen from the front anyway
    edge_on = [f for f in bm.faces if abs(f.normal.dot(FACE_BVH.find_nearest(f.calc_center_median() + base)[1])) < 0.15]
    bmesh.ops.delete(bm, geom=edge_on, context='FACES_ONLY')
    return bm_to(name, bm, mat, parent)

EYE_X, EYE_Y = F.EYE_X, F.EYE_Y
for side, label in [(-1, 'left'), (1, 'right')]:
    eye = joint('hermes_eye_' + label, head, (side * EYE_X, EYE_Y, 0))
    decal('sclera_' + label, eye, F.almond(side), .0018, m_white)
    decal('lid_shadow_' + label, eye, F.lid_shadow(side), .0024, m_lidshadow, 2)
    pupil = joint('hermes_pupil_' + label, eye)
    decal('iris_' + label, pupil, F.iris(side), .0030, m_iris)
    decal('iris_glow_' + label, pupil, F.iris_glow(side), .0036, m_glow, 2)
    decal('pupil_' + label, pupil, F.pupil(side), .0040, m_line)
    decal('highlight_' + label, pupil, F.glint(side), .0050, m_white, 2)
    decal('highlight_small_' + label, pupil, F.glint_small(side), .0050, m_white, 2)
    decal('lower_lash_' + label, eye, F.lower_lash(side), .0054, m_line, 2)
    for i, spike in enumerate(F.lash_spikes(side)): decal(f'lash_spike_{label}_{i}', eye, spike, .0062, m_line, 1)
    for i, spike in enumerate(F.lower_spikes(side)): decal(f'lower_spike_{label}_{i}', eye, spike, .0054, m_line, 1)
    decal('upper_lash_' + label, eye, F.upper_liner(side), .0062, m_line)
    decal('lid_crease_' + label, eye, F.crease(side), .0040, m_line, 2)
    lid = joint('hermes_lid_' + label, head, (side * EYE_X, EYE_Y, 0))
    decal('closed_lid_' + label, lid, F.closed_lid(side), .0070, m_line)
    brow = joint('hermes_brow_' + label, head, (side * F.BROW_X, F.BROW_Y, 0))   # fine brows just under the fringe hem
    decal('eyebrow_' + label, brow, F.brow(side), .0036, m_line, 2)
# v19: the nose is a form on the face plus painted shade (hermes-head/face_paint.py), not a line decal
mouth = joint('hermes_mouth', head, (0, F.MOUTH_Y, 0))
up = joint('hermes_lip_upper', mouth)
decal('lip_upper', up, F.lip_upper(), .0030, m_lipdark, 2)
decal('lip_line', up, F.lip_line(), .0036, m_line, 2)
lo = joint('hermes_lip_lower', mouth)
decal('lip_lower', lo, F.lip_lower(), .0026, m_lip, 2)
decal('lip_lower_rim', lo, F.lip_lower_rim(), .0032, m_lipdark, 2)
decal('mouth_open', mouth, F.mouth_open(), .0034, m_line, 2)

# Hair, flicked locks and headset come from head_v19.build() above.

# ------------------------------------------------------ rest-pose check ----
# Face artwork is single-sided in RealityKit: every decal must face the viewer.
decals = [o for o in head.children_recursive if o.type == 'MESH' and o.name not in
          ('face', 'face_backing', 'portrait_bob', 'portrait_fringe', 'hair_under', 'Nous_headband', 'Nous_band_hook')
          and not o.name.startswith(('side_lock', 'hair_clump', 'hair_flick', 'bang_strand', 'bang_clump', 'headset', 'Nous_band_hook'))]
for o in decals:
    offset = Vector(); q = o.parent
    while q is not None and q != head: offset += q.location; q = q.parent
    backward = [p for p in o.data.polygons if p.normal.dot(FACE_BVH.find_nearest(p.center + offset)[1]) < 0]
    assert not backward, f'{o.name}: {len(backward)} faces point into the head'

manifest = {'schema': 2, 'boneNames': [b[0] for b in bone_specs],
            'controls': sorted(o.name for o in root.children_recursive if o.type == 'EMPTY'),
            'skinnedMeshes': sorted(o.name for o in rig.children if o.type == 'MESH')}
root.rotation_euler.x = math.pi / 2
bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'hermes.blend'))

def export(usdz, glb):
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.wm.usd_export(filepath=str(usdz), selected_objects_only=True, export_animation=False, export_armatures=True,
                          export_shapekeys=False, triangulate_meshes=True, generate_preview_surface=True, convert_orientation=True,
                          export_global_forward_selection='NEGATIVE_Z', export_global_up_selection='Y')
    if glb:
        bpy.ops.export_scene.gltf(filepath=str(glb), export_format='GLB', use_selection=True, export_animations=False,
                                  export_cameras=False, export_lights=False, export_yup=True)
export(OUT / 'hermes.usdz', None)
if INSTALL:
    export(ROOT / 'apple/AgentDeck/Resources/Aquarium/hermes-mermaid.usdz', ROOT / 'assets/terrarium/hermes-mermaid.glb')
    (ROOT / 'assets/terrarium/hermes-rig.json').write_text(json.dumps(manifest, indent=2) + '\n')
    bpy.ops.wm.save_as_mainfile(filepath=str(ROOT / 'assets/terrarium/hermes-mermaid.blend'))
root.rotation_euler.x = 0

# ------------------------------------------------------------- review ----
for o in list(bpy.data.objects):
    if o.name in ('mouth_open', 'closed_lid_left', 'closed_lid_right'): o.hide_render = True
scene.render.engine = 'BLENDER_EEVEE'
scene.world = bpy.data.worlds.new('Water'); scene.world.use_nodes = True
bg = scene.world.node_tree.nodes['Background']; bg.inputs[0].default_value = (.012, .035, .055, 1); bg.inputs[1].default_value = 1.2
scene.view_settings.view_transform = 'AgX'; scene.view_settings.look = 'AgX - Medium High Contrast'
scene.render.resolution_x = scene.render.resolution_y = 900
for pos, power, size in [((1.6, 2.4, 3.0), 260, 3), ((-2.2, .8, 1.5), 140, 2), ((0, 1.2, -2.5), 160, 1.5)]:
    bpy.ops.object.light_add(type='AREA', location=pos); L = bpy.context.object; L.data.energy = power; L.data.size = size
    L.rotation_euler = (Vector((0, 0, 0)) - L.location).to_track_quat('-Z', 'Z').to_euler()
bpy.ops.object.camera_add(); cam = bpy.context.object; scene.camera = cam; cam.data.type = 'ORTHO'
# name: (direction, ortho scale, aim offset). 'mark' matches the official mark's
# three-quarter head turn (face toward image left) for a like-for-like check.
views = {'front': ((0, 0, 1), 1.3, 0), 'three-quarter': ((.62, .10, 1), 1.26, 0), 'side': ((1, 0, 0), 1.3, 0),
         'back': ((0, .1, -1), 1.3, 0), 'portrait': ((.40, .12, 1), .62, .24), 'mark': ((.78, .06, 1), .60, .22),
         'face': ((0, 0, 1), .55, .24)}
if '--views' in argv: views = {k: views[k] for k in argv[argv.index('--views') + 1].split(',')}
for name, (d, scale, lift) in views.items():
    aim = Vector((0, -.04 + lift, 0)); cam.location = aim + Vector(d).normalized() * 4
    back = (cam.location - aim).normalized(); right = Vector((0, 1, 0)).cross(back).normalized(); upv = back.cross(right)
    cam.rotation_euler = Matrix((right, upv, back)).transposed().to_euler(); cam.data.ortho_scale = scale
    scene.render.filepath = str(OUT / f'{name}.png'); bpy.ops.render.render(write_still=True)
print('HERMES_BUILD', json.dumps(manifest))
