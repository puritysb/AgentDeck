"""Face nose form + painted shading, measured from the concepts (2026-10-01).

The concept's face is flat, lit ivory (front sheet ~252/236/226). Its shading
lives in a few painted accents, not in lighting:
- neck under the chin: 228/202/187 (sheet), and the jaw's underside plane
  ~225/209/198 (master);
- a faint warm band under the fringe hem: 248/229/216 at the sides;
- the nose: a small tip whose sides carry a warm shade (230/207/195) and
  soft nostrils (197/178/171). It is not a dark line.

RealityKit's lighting of a near-white albedo stays almost flat (the review
renders measured lit 241/231/222 with p99 244). So these accents are painted
into an albedo texture as ratios to the lit ivory. The nose also gets a small
geometric tip and bridge, so it has a real profile in 3/4 and side views.

All coordinates are in the builder's head frame (metres, y up, face toward
+z). face_v2's sheet y equals head y (head_v19 maps the hem to HEM_Y and the
chin to CHIN_Y).
"""
import math, os
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, "face_shade.png")
RES = 1024
U0, U1, V0, V1 = -0.20, 0.20, -0.32, 0.08     # head-frame window the texture covers


def smooth(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def nose_form(face, F):
    """Nose and lip forms on the evaluated face (vertices already in head frame).

    The master's nose reads through its far-side plane (a shade line from the
    eye down to the tip) and a small pink tip. In 3D that needs a nose with a
    defined bridge ridge and side planes for the light to catch; the first,
    softer version (tip 6.5 mm) rendered almost flat in RealityKit. The lips
    get a slight pout so the 3/4 and side views have one, as the master does.
    """
    yt = F.NOSE_Y + 0.006
    ye = F.EYE_Y - 0.008
    ym = F.MOUTH_Y
    disp = {}
    # (Local subdivision around the nose was tried for a sharper bridge: every
    # variant left single dark pixels in RealityKit, at its border and on the
    # bridge. The bridge is instead kept broad enough, >= 5.8 mm, for the
    # face's ~2.5 mm vertex spacing.)
    for v in face.data.vertices:
        x, y, z = v.co
        if z < 0.05:
            continue
        # the profile sheet's nose stands 0.30 blockout units (~0.035 m) proud of
        # the cheek plane; the face already gives ~0.012 there
        sy = 0.0075 if y >= yt else 0.0105    # longer below: the sheet's tip is a rounded wedge with a flat underside
        tip = 0.0330 * math.exp(-((x / 0.0095) ** 2 + ((y - yt) / sy) ** 2))
        # bridge ridge from between the eyes to the tip, narrowing downward
        t = min(1.0, max(0.0, (ye - y) / (ye - yt))) if y <= ye else 0.0
        w = 0.0080 - 0.0022 * t      # broad enough that the front view shows a soft bridge, not two dark lines
        # smooth across x = 0 (|x|^1.35 had a kink there that folded a few
        # triangles: pinholes in RealityKit, which culls back faces)
        bridge = 0.0150 * t ** 1.25 * math.exp(-(x / w) ** 2) * min(1.0, max(0.0, (y - (yt - 0.006)) / 0.004))
        # the nostril underside tucks back under the tip
        under = -0.0045 * math.exp(-((x / 0.0095) ** 2 + ((y - (yt - 0.0150)) / 0.0040) ** 2))
        # lips: upper and lower pout, a soft groove between lower lip and chin
        lip = (0.0022 * math.exp(-((x / 0.017) ** 2 + ((y - (ym + 0.0035)) / 0.0035) ** 2))
               + 0.0030 * math.exp(-((x / 0.015) ** 2 + ((y - (ym - 0.0050)) / 0.0040) ** 2))
               - 0.0012 * math.exp(-((x / 0.014) ** 2 + ((y - (ym - 0.0120)) / 0.0030) ** 2)))
        # smooth union of tip and bridge (max() left a V crease on the bridge)
        form = (tip ** 4 + bridge ** 4) ** 0.25
        disp[v.index] = form + under + lip
        v.co.z = z + disp[v.index]
    # Relax the displaced heights: on the ~2.5 mm grid the 2 cm tip came to a
    # point (vertex normals 60 deg off their faces), which RealityKit shaded with
    # a stray dark pixel. The sheet's nose is a soft rounded wedge anyway.
    me = face.data
    nbr = {i: [] for i in disp}
    for e in me.edges:
        a, b = e.vertices
        if a in nbr: nbr[a].append(b)
        if b in nbr: nbr[b].append(a)
    # heightfield smoothing of the displacement only (the face itself is untouched)
    for _ in range(7):
        new = {}
        for i, ns in nbr.items():
            if abs(disp[i]) < 0.0004 or not ns:
                continue
            new[i] = 0.5 * disp[i] + 0.5 * sum(disp.get(j, 0.0) for j in ns) / len(ns)
        for i, d in new.items():
            me.vertices[i].co.z += d - disp[i]
            disp[i] = d
    face.data.update()
    # Triangulate here, choosing the better diagonal per quad: left to the USD
    # exporter, one steep quad beside the tip split along the wrong diagonal
    # and its sliver rendered as a dark pixel in RealityKit.
    import bmesh
    bm = bmesh.new(); bm.from_mesh(face.data)
    bmesh.ops.triangulate(bm, faces=bm.faces[:], quad_method="BEAUTY", ngon_method="BEAUTY")
    bm.normal_update()
    flipped = [f for f in bm.faces if f.normal.dot(sum((v.normal for v in f.verts), f.normal * 0)) < 0]
    bm.to_mesh(face.data); bm.free()
    face.data.update()
    print("face triangles opposing their vertex normals:", len(flipped))


def paint(face, F, base_srgb, jaw=None):
    """Write TEX: base ivory x measured ratios, sampled from the face surface."""
    bvh = BVHTree.FromPolygons([v.co.copy() for v in face.data.vertices], [p.vertices[:] for p in face.data.polygons])
    xs = np.linspace(U0, U1, RES)
    ys = np.linspace(V0, V1, RES)
    X, Y = np.meshgrid(xs, ys)
    NX = np.zeros_like(X); NY = np.zeros_like(X); NZ = np.ones_like(X); HIT = np.zeros_like(X, bool)
    for j in range(0, RES, 2):               # normals at half resolution, then upsampled
        for i in range(0, RES, 2):
            loc, n, _, _ = bvh.ray_cast(Vector((X[j, i], Y[j, i], 0.4)), Vector((0, 0, -1)))
            if loc is not None:
                NX[j:j + 2, i:i + 2] = n.x; NY[j:j + 2, i:i + 2] = n.y; NZ[j:j + 2, i:i + 2] = n.z; HIT[j:j + 2, i:i + 2] = True
    lit = np.array([252, 236, 226], float)
    ratio = np.ones(X.shape + (3,))

    def apply(weight, rgb):
        r = np.array(rgb, float) / lit
        ratio[:] = ratio * (1 - weight[..., None]) + ratio * r * weight[..., None]

    # the chin as the mesh has it (the jaw edits move it; the sheet's CHIN_Y is
    # only the drawing's frame): the lowest centre-line point still clear of
    # the neck front
    cl = [v.co for v in face.data.vertices if abs(v.co.x) < 0.005 and v.co.z > 0.0]
    neck_z = max((c.z for c in cl if c.y < -0.235), default=0.03)
    chin_y = min(c.y for c in cl if c.z > neck_z + 0.012)
    # The jaw edge as a curve y(|x|) (head_v19 passes the creased ring-10 loop).
    # Everything keyed on "below the chin" follows it: a band at constant height
    # drew a flat-bottomed chin across the V.
    if jaw:
        jx, jy = np.array([p[0] for p in jaw]), np.array([p[1] for p in jaw])
        JAW = np.interp(np.abs(X), jx, jy)
        JAW = JAW - (jy[0] - chin_y)          # anchor the curve to the measured chin point
    else:
        JAW = np.full_like(X, chin_y)
    # The neck sits in the jaw's shadow in the concept (228/202/187 against a
    # 252/236/226 face). RealityKit casts no such shadow and the app's high sun
    # lights the neck like the face, so it is painted darker than the target.
    apply(smooth(-0.001, -0.008, Y - JAW) * HIT, (244, 224, 212))   # 2026-10-02: lighter; the sheet's only shadow is a soft neck tone
    # Lift the albedo where the face front tilts down above the jaw (lower
    # cheeks and chin): the concept lights them like the rest of the face, but
    # the app's high sun leaves them dim. Clipped at white by the final clip.
    tilt = smooth(-0.05, -0.55, NY) * (Y > JAW + 0.002) * HIT
    ratio[:] = ratio * (1 + 0.14 * tilt[..., None])
    # a soft cast-shadow band right under the jaw, fading down the neck
    apply(np.clip(smooth(-0.002, -0.006, Y - JAW) * smooth(-0.030, -0.012, Y - JAW), 0, 1) * HIT, (248, 232, 222))
    # (jaw-underside shade removed 2026-10-02: the concept's lower face is flat lit)
    # faint warm band under the fringe hem, strongest at the sides
    hem = F.HEM_Y + 0.016
    band = smooth(hem - 0.020, hem - 0.004, Y) * (Y < hem + 0.02) * (0.45 + 0.55 * smooth(0.02, 0.10, np.abs(X)))
    apply(band, (244, 225, 213))
    # the nose: the sheet's tip is ~8% of the face width (~0.024), with warm
    # shade on both wings (230/207/195) and nostrils (197/178/171) along its
    # lower edge. The first pass painted it at half that size and it vanished.
    yt = F.NOSE_Y + 0.003
    for s in (-1, 1):
        side = np.exp(-(((X - s * 0.0105) / 0.0050) ** 2 + ((Y - (yt - 0.003)) / 0.0050) ** 2))
        apply(np.clip(side * 1.0, 0, 1), (216, 186, 174))   # stronger: the app's 5000 lx sun washes painted accents out
        nost = np.exp(-(((X - s * 0.0062) / 0.0034) ** 2 + ((Y - (yt - 0.0075)) / 0.0019) ** 2))
        apply(np.clip(nost * 1.3, 0, 1), (192, 166, 158))
    under = np.exp(-((X / 0.006) ** 2 + ((Y - (yt - 0.0088)) / 0.0016) ** 2))
    apply(np.clip(under * 0.9, 0, 1), (206, 178, 168))
    # (a side-plane shade keyed on normals was tried: it rendered as stepped
    # bars down the bridge, visible from the front. The 3/4 contour is left to
    # the nose form and the lighting.)
    # the sheet's bridge carries a light strip above the tip, not dark side lines
    # (the side streaks of the previous pass read as a long grooved nose)
    br = np.exp(-((X / 0.0030) ** 2)) * smooth(F.EYE_Y - 0.012, F.EYE_Y - 0.030, Y) * (Y > yt + 0.002)
    apply(np.clip(br * 0.9, 0, 1), (255, 247, 240))
    tipc = np.exp(-((X / 0.0095) ** 2 + ((Y - yt) / 0.0070) ** 2))
    apply(np.clip(tipc * 0.9, 0, 1), (238, 205, 193))       # the tip is a touch pinker
    # the face's side planes near the hair turn a little warmer and darker
    # (sheet cheek edges ~248/229/216 vs 252/236/226 lit)
    edge = smooth(0.35, 0.80, np.abs(NX)) * HIT * (Y > JAW + 0.004)
    # (side-plane shade removed 2026-10-02: it read as dirty cheeks next to the flat-lit sheet)
    # faint cheek warmth under the eyes
    for s in (-1, 1):
        ck = np.exp(-(((X - s * 0.085) / 0.028) ** 2 + ((Y - (F.EYE_Y - 0.050)) / 0.018) ** 2))
        apply(np.clip(ck * 0.6, 0, 1), (250, 226, 218))
    # soften: normal-keyed terms inherit the face's facets and the half-res sampling
    k = np.array([1, 4, 6, 4, 1], float); k /= k.sum()
    for _ in range(3):
        for ax in (0, 1):
            ratio = sum(np.roll(ratio, i - 2, axis=ax) * k[i] for i in range(5))
    # crisp marks after the blur: the sheet's nostrils are small definite shapes
    for s in (-1, 1):
        nost = np.exp(-(((X - s * 0.0058) / 0.0026) ** 2 + ((Y - (yt - 0.0078)) / 0.0013) ** 2))
        apply(np.clip(nost * 1.4, 0, 1), (186, 160, 152))
    img = np.clip(np.array(base_srgb)[None, None, :] * ratio, 0, 1)
    rgba = np.concatenate([img, np.ones(X.shape + (1,))], 2).astype(np.float32)
    im = bpy.data.images.get("face_shade") or bpy.data.images.new("face_shade", RES, RES, alpha=False)
    im.pixels.foreach_set(rgba.ravel())
    im.filepath_raw = TEX
    im.file_format = "PNG"
    im.save()
    return im


def uv_and_material(face, skin, im):
    me = face.data
    uv = me.uv_layers.new(name="UVMap")
    for loop in me.loops:
        co = me.vertices[loop.vertex_index].co
        # A pure front projection collapses triangles that face sideways (nose
        # sides) or downward (nose underside) to zero UV area. RealityKit then
        # derives a NaN tangent frame for them and shades single pixels black.
        # A small depth term keeps every UV triangle non-degenerate; at the face
        # front (z ~0.15) it moves the painting by under half a texel.
        dz = 0.02 * (co.z - 0.15)
        uv.data[loop.index].uv = ((co.x - U0) / (U1 - U0) + dz, (co.y - V0) / (V1 - V0) + dz)
    m = skin.copy(); m.name = "Face skin"
    nt = m.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = im; tex.extension = "EXTEND"
    nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    me.materials.clear(); me.materials.append(m)
