"""Hermes (Nous girl) mermaid, built from the official mark (`design/brand/hermes.svg`).

The face is designed as a flat sheet in `hermes_face.py` (the approved 2D source)
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

ROOT = Path(__file__).resolve().parents[2]
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
INSTALL = '--preview-only' not in argv
OUT = Path(argv[argv.index('--out') + 1]) if '--out' in argv else ROOT / 'diagnostics/hermes-mermaid/nous-v18'
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
skin = material('Ivory skin', 'tide-100', .85, .08, glow=.12)   # the concept's warm cream reads grey under plain lighting
# Glossy black: the mark's white strokes on the hair are light reflections, so
# they must come from the material, not from painted decals.
hair = material('Nous ink hair', 'ink-900', .65, .15, scale=.045, neutral=True)
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
    bone_specs += [(f'arm_{label}', 'spine', (side * .050, -.030, .004)),
                   (f'elbow_{label}', f'arm_{label}', (side * .098, -.115, .018)),
                   (f'wrist_{label}', f'elbow_{label}', (side * .118, -.190, .036))]
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
    (.070, .000, .024, .023, 'skin'), (.010, .000, .025, .023, 'skin'),
    (-.014, .000, .042, .032, 'skin'), (-.032, .000, .062, .044, 'skin'),
    (-.054, .002, .066, .049, 'neck'),
    (-.090, .004, .062, .050, 'teal'), (-.130, .003, .056, .046, 'teal'),
    (-.180, .000, .080, .064, 'teal'), (-.232, -.012, .077, .061, 'teal'),
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
    pts = [(side * .022, -.012, .001), (side * .048, -.030, .004), (side * .076, -.072, .010), (side * .098, -.115, .018),
           (side * .110, -.155, .027), (side * .118, -.190, .036), (side * .121, -.214, .040), (side * .121, -.234, .041)]
    radii = [.026, .021, .017, .014, .0125, .0105, .0100, .0090]
    ARM_PATHS[label] = ([Vector(p) for p in pts], radii)
    parts.append(tube('arm_' + label, root, pts[:-1], radii[:-1], skin, 16))
    hand = ellipsoid('hand_' + label, root, (side * .121, -.214, .040), (.012, .022, .009), skin, 20, 12)
    thumb = ellipsoid('thumb_' + label, root, (side * .113, -.206, .050), (.0055, .011, .0055), skin, 12, 8)
    parts += [hand, thumb]
bpy.ops.object.select_all(action='DESELECT')
for o in parts: o.select_set(True)
bpy.context.view_layer.objects.active = body; bpy.ops.object.join()
apply_mod(body, 'REMESH', mode='VOXEL', voxel_size=.0027)
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
head = joint('hermes_head', spine, (0, .215, .006))
# The face is designed as a flat sheet in hermes_face.py (the approved 2D
# source); this builder only shapes a head to fit that sheet and lays its
# artwork on it unchanged.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import hermes_face as F
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
FA, FB, FC = F.FACE_W, -F.CHIN_Y, .150

# Head construction from silhouettes: a cranium over a face plane. The front
# width follows the sheet's face outline exactly; the side profile gives a
# forehead, a flat eye plane, a small nose bridge, and a chin that sits slightly
# forward while the jaw underside slopes back to the neck. Every horizontal
# section is a superellipse (flatter at the front).
H_TOP = .205
def spline(points, y):
    """Catmull-Rom through (y, value) keys ordered top to bottom."""
    ys = [p[0] for p in points]
    if y >= ys[0]: return points[0][1]
    if y <= ys[-1]: return points[-1][1]
    k = next(i for i in range(len(ys) - 1) if ys[i] >= y >= ys[i + 1])
    p0, p1, p2, p3 = (points[max(k - 1, 0)][1], points[k][1], points[k + 1][1], points[min(k + 2, len(points) - 1)][1])
    t = (ys[k] - y) / (ys[k] - ys[k + 1])
    return .5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)
def width(y):
    if y > .080: return spline([(H_TOP, 0), (.192, .075), (.150, .133), (.110, .153), (.080, F.half_width(.080))], y)
    return F.half_width(y)
FRONT = [(H_TOP, 0), (.192, .055), (.150, .103), (.080, .138), (.020, FC * .975), (-.050, FC),
         (-.100, FC * .990), (-.136, FC * .955), (-.165, FC * .880), (-FB + .012, FC * .760), (-FB, FC * .66)]
BACK = [(H_TOP, 0), (.192, .075), (.150, .140), (.080, .170), (.020, .178), (-.030, .168),
        (-.070, .140), (-.105, .085), (-.140, .020), (-FB + .022, -.050), (-FB + .006, -FC * .45), (-FB, -FC * .55)]
def section(y, phi):
    s, c_ = math.sin(phi), math.cos(phi)
    e = 2 / (2.6 if c_ > 0 else 2.1)
    front, back = spline(FRONT, y), spline(BACK, y)
    zc, depth = (front - back) / 2, (front + back) / 2
    return Vector((width(y) * math.copysign(abs(s) ** e, s), y, zc + depth * math.copysign(abs(c_) ** e, c_)))
bm = bmesh.new(); bmesh.ops.create_cube(bm, size=2)
bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=29, use_grid_fill=True)
for v in bm.verts:
    u = v.co.normalized()                        # cube-sphere: no pole pinching
    y = -FB + (u.y + 1) / 2 * (H_TOP + FB)
    v.co = section(y, math.atan2(u.x, u.z)) if abs(u.y) < .9999 else Vector((0, y, 0))
bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-6)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
face = bm_to('face', bm, skin, head, True)
apply_mod(face, 'SUBSURF', levels=1, render_levels=1)
# A small nose bridge and tip, so the three-quarter view has a profile.
for v in face.data.vertices:
    if v.co.z > .05:
        ridge = smoothstep(-.060, -.104, v.co.y) * (1 - smoothstep(-.104, -.116, v.co.y))
        v.co.z += .010 * ridge * math.exp(-(v.co.x / .012) ** 2)
for p_ in face.data.polygons: p_.use_smooth = True
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
    f = bm.faces.new(verts)
    bmesh.ops.triangulate(bm, faces=[f], quad_method='BEAUTY', ngon_method='BEAUTY')
    bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
    base = Vector((0, 0, 0)); p = parent
    while p is not None and p != head: base += p.location; p = p.parent
    surface = {}
    for v in bm.verts:
        x, y = v.co.x + base.x, v.co.y + base.y
        hit, normal = face_hit(x, y)
        if hit is None or normal.z < .2:           # past the face plane: take the nearest surface point
            hit, normal, _, _ = FACE_BVH.find_nearest(Vector((x, y, .2)))
        surface[v] = normal
        v.co = hit + normal * depth - base
    for f in bm.faces:  # RealityKit culls back faces: orient against the surface under each triangle
        f.normal_update()
        if f.normal.dot(sum((surface[v] for v in f.verts), Vector())) < 0: f.normal_flip()
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
    lid = joint('hermes_lid_' + label, head, (side * EYE_X, EYE_Y, 0))
    decal('closed_lid_' + label, lid, F.closed_lid(side), .0070, m_line)
    brow = joint('hermes_brow_' + label, head, (side * .076, F.BROW_Y, 0))   # fine brows just under the fringe hem
    decal('eyebrow_' + label, brow, F.brow(side), .0036, m_line, 2)
decal('nose_shadow', head, F.nose(), .0022, m_shade, 2)
mouth = joint('hermes_mouth', head, (0, F.MOUTH_Y, 0))
up = joint('hermes_lip_upper', mouth)
decal('lip_upper', up, F.lip_upper(), .0030, m_lipdark, 2)
decal('lip_line', up, F.lip_line(), .0036, m_line, 2)
lo = joint('hermes_lip_lower', mouth)
decal('lip_lower', lo, F.lip_lower(), .0026, m_lip, 2)
decal('lip_lower_rim', lo, F.lip_lower_rim(), .0032, m_lipdark, 2)
decal('mouth_open', mouth, F.mouth_open(), .0034, m_line, 2)

# ---------------------------------------------------------------- hair ----
# One smooth bob shell. Each column runs over the dome and down to its own end:
# high at the front (hairline under the fringe), shoulder-long at the sides and
# back, where the ends flip outward and up into the mark's C-curls.
HC = Vector((0, .058, -.056)); RX, RY, RZ = .272, .226, .252   # the concept's big, round bob
N, ROWS, SKIRT = 208, 40, 1.0
FRINGE_K = .095   # skirt fraction at the front: hem at about y = .02, just above the brows
# Shallow strand grooves: on glossy hair they break the reflection into the
# jagged highlight band the mark draws, instead of a lacquered-plastic sheen.
# Broad, uneven locks (the mark's hair falls in a few large strands), not a
# fine corduroy of equal ridges.
def groove(theta): return .0045 * math.cos(11 * theta + 1.2 * math.sin(2 * theta)) + .0020 * math.cos(23 * theta + .7)
def column(theta, v):
    m = smoothstep(.46, .62, abs(theta))             # 0 front, 1 side curtain
    # The front columns run over the forehead and stop at the fringe hem, so the
    # bangs are the shell itself: no separate sheet, no seam on the crown.
    split = max(0.0, math.cos(15 * theta + .5)) ** 10     # a few pointed splits in the blunt bangs
    s = v * lerp(math.pi / 2 + FRINGE_K * (1 + .45 * split) * SKIRT, math.pi / 2 + SKIRT, m)
    squash = 1.0
    if s <= math.pi / 2:
        y = HC.y + RY * math.cos(s); rr = math.sin(s)
    else:
        k = (s - math.pi / 2) / SKIRT
        side = abs(math.sin(theta)) ** 1.3
        curl = smoothstep(.72, 1, k)
        tuck = math.sin(math.pi * min(k / .78, 1)) * (k < .78) + (k >= .78) * 0
        # The concept's ends: the hem breaks into pointed locks that flick out
        # and up, strongest at the sides and back; between locks it tucks in.
        tooth = max(0.0, math.cos(6 * theta + .9)) ** 2   # broad locks; sharper peaks read as horns from the front
        rr = 1 - .11 * tuck * smoothstep(0, .5, k) + side * curl ** 1.4 * (.07 + .20 * tooth) - .08 * (1 - side) * curl
        y = HC.y - .320 * k + side * curl ** 1.8 * (.030 + .060 * tooth)
        # Below the cheek the curtains fall back so the jaw reads in profile; at eye
        # level they must still wrap the face, or its edge shows through.
        if math.cos(theta) > 0: squash = 1 - .45 * smoothstep(.35, .65, k) * math.cos(theta)
    # Natural wave: below the crown each lock swings gently side to side and in and
    # out as it falls, with a phase that drifts around the head, so the strand
    # grooves ripple instead of running as straight parallel ridges.
    fall = smoothstep(.30, .75, v) * m
    tw = theta + .11 * fall * math.sin(2.4 * math.pi * v + 2.3 * theta)
    rr *= 1 + .045 * fall * math.sin(2.0 * math.pi * v + 3.1 * theta + 1.0)
    rr *= 1 + groove(tw) * smoothstep(.04, .30, v) * m   # no strand ridges on the bangs: they read as slats
    return Vector((RX * rr * math.sin(tw), y, HC.z + RZ * rr * math.cos(tw) * squash))
vs, fs = [Vector((0, HC.y + RY, HC.z))], []
for j in range(1, ROWS + 1):
    for i in range(N):
        vs.append(column(2 * math.pi * i / N - math.pi, j / ROWS))
for i in range(N): fs.append((0, 1 + (i + 1) % N, 1 + i))
for j in range(ROWS - 1):
    for i in range(N):
        a = 1 + j * N + i; b = 1 + j * N + (i + 1) % N; fs.append((a, b, b + N, a + N))
bob = mesh('portrait_bob', vs, fs, hair, head, True)
bm = bmesh.new(); bm.from_mesh(bob.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5); bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=1e-5)
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:]); bm.to_mesh(bob.data); bm.free()
# Collapse-decimate into large irregular planes: the concept's faceted bob. The
# silhouette stays the mark's; only the surface breaks into facets.
# Low-poly: collapse-decimate into large irregular planes and flat-shade them,
# as in the concept's faceted bob.
apply_mod(bob, 'DECIMATE', decimate_type='COLLAPSE', ratio=.035, use_symmetry=True, symmetry_axis='X')
apply_mod(bob, 'SOLIDIFY', thickness=.010, offset=-1)
for p in bob.data.polygons: p.use_smooth = False

fringe = None   # the bangs are the front of the shell (see column())

# (The mark's stray strand is left out: at aquarium scale it read as a crack.)

# Hair clumps. The shell above carries the hair's volume; the
# visible hair is ~30 tapered clumps with a raised ridge, flat-shaded so light
# catches their planes the way it does on the concept's faceted bob. A single
# smooth shell reads as a helmet however well it is shaped.
def clump(name, parent, path, normals, widths, ridge, origin=Vector()):
    vs, fs = [], []
    n = len(path)
    for i, (p, nrm, w, h) in enumerate(zip(path, normals, widths, ridge)):
        t = (path[min(i + 1, n - 1)] - path[max(i - 1, 0)]).normalized()
        b = t.cross(nrm).normalized(); nrm = b.cross(t).normalized()
        vs += [p + b * w / 2 - origin, p + nrm * h - origin, p - b * w / 2 - origin, p - nrm * .004 - origin]
    for i in range(n - 1):
        for k in range(4):
            a0 = i * 4 + k; a1 = i * 4 + (k + 1) % 4; fs.append((a0, a1, a1 + 4, a0 + 4))
    fs.append((3, 2, 1, 0))
    tip = len(vs); vs.append(path[-1] + (path[-1] - path[-2]).normalized() * .006 - origin)
    for k in range(4): fs.append(((n - 1) * 4 + k, (n - 1) * 4 + (k + 1) % 4, tip))
    o = mesh(name, vs, fs, hair, parent, True); fix_normals(o)
    return o
def shell_normal(theta, v):
    e = 1e-3
    d_t = column(theta + e, v) - column(theta - e, v); d_v = column(theta, min(1, v + e)) - column(theta, max(0, v - e))
    nrm = d_t.cross(d_v).normalized()
    return nrm if nrm.dot(column(theta, v) - HC) > 0 else -nrm
# The ends are shaped into the shell (see `tooth` in column()); only the rig's
# sway controls remain, placed at the longest side locks.
for side_sign, label in ((-1, 'left'), (1, 'right')):
    joint('hermes_hair_' + label, head, column(side_sign * 1.55, 1.0))

# Hair-surface projection for the headband (the smooth under-layer, lifted clear of the clumps).
_hair_bm = bmesh.new()
_hair_bm.from_mesh(bob.data)
HAIR_BVH = BVHTree.FromBMesh(_hair_bm)
def hug(p, lift):
    d = (HC - p).normalized(); hit, normal, _, _ = HAIR_BVH.ray_cast(p, d)
    return (hit + normal * lift) if hit else p

# Headset, not a headband: the white arc in the mark is a headset band, the small
# shape where it meets the hair is its yoke, and the earcups sit under the hair.
# The band runs over the crown and sinks into the hair at both sides; a yoke
# marks each entry point.
vs, fs = [], []; BETA = .86   # tilt toward +Z: the concept's band sits forward, just behind the bangs
A_END = 1.40
def band_lift(a): return .006 - .008 * smoothstep(1.30, A_END, abs(a))     # tucks into the hair at the yokes
for j in range(49):
    a = -A_END + 2 * A_END * j / 48
    for d in (-.085, .085):
        b = BETA + d
        vs.append(hug(HC + Vector((RX * math.sin(a), RY * math.cos(a) * math.cos(b), RZ * math.cos(a) * math.sin(b))) * 1.6, band_lift(a)))
def relax(vs, n):
    for _ in range(n): vs = [vs[k] if k < 2 or k >= len(vs) - 2 else (vs[k - 2] + vs[k] * 2 + vs[k + 2]) / 4 for k in range(len(vs))]
    return vs
vs = relax(vs, 6)
vs = [hug(HC + (v - HC) * 1.5, band_lift(-A_END + 2 * A_END * (k // 2) / 48)) for k, v in enumerate(vs)]; vs = relax(vs, 3)
for j in range(48): fs.append((j * 2, j * 2 + 1, j * 2 + 3, j * 2 + 2))
band = mesh('Nous_headband', vs, fs, white, head, True)
apply_mod(band, 'SOLIDIFY', thickness=.008, offset=0)
apply_mod(band, 'BEVEL', width=.0025, segments=2, limit_method='ANGLE')
for p_ in band.data.polygons: p_.use_smooth = True
# Yokes: a rounded block on each side where the band enters the hair.
yokes = []
for side, name in ((1, 'Nous_band_hook'), (-1, 'headset_yoke_left')):
    k = round((side * 1.33 + A_END) / (2 * A_END) * 48)
    c = (vs[2 * k] + vs[2 * k + 1]) / 2; along = (vs[2 * k + 2] - vs[2 * k]).normalized()
    out = (c - HC).normalized()
    frame = Matrix((out.cross(along).normalized(), along, out)).transposed()   # x across, y along the band, z out of the hair
    # The concept's clasp: a round white end with a black dot, and a small white
    # hook curling back up beneath it (the Nous mark's band end).
    y = ellipsoid(name, head, Vector(), (.022, .022, .010), white, 20, 12)
    for v in y.data.vertices: v.co = c + out * .004 + frame @ (v.co + Vector((0, -.010, 0)))
    dot = ellipsoid(name + '_dot', head, Vector(), (.0085, .0085, .005), line_dark, 16, 10)
    for v in dot.data.vertices: v.co = c + out * .013 + frame @ (v.co + Vector((0, -.010, 0)))
    hook_pts = [c + out * .006 + frame @ Vector((side * .010 * math.sin(a_), -.026 - .012 * math.sin(a_ * .8) + .010 * (1 - math.cos(a_)) * .6, 0))
                for a_ in [math.pi * 1.1 * i / 10 for i in range(11)]]
    hook = tube(name + '_hook', head, hook_pts, [.0045 * (1 - .6 * i / 10) for i in range(11)], white, 8)
    yokes += [y, dot, hook]

# ------------------------------------------------------ rest-pose check ----
# Face artwork is single-sided in RealityKit: every decal must face the viewer.
decals = [o for o in head.children_recursive if o.type == 'MESH' and o.name not in
          ('face', 'portrait_bob', 'portrait_fringe', 'Nous_headband', 'Nous_band_hook')
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
