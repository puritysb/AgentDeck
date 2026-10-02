"""3D eyes for the Hermes head (2026-10-02).

The eyes were front-projected drawings on the face, so in profile they read
as front-facing pictures stuck on the side of the face. The profile sheet
draws a side eye: a narrow almond with the iris facing forward. Here each
eye is real geometry:

- an almond opening is cut in `face` and `face_backing`, and its rim is
  snapped onto the drawn almond outline;
- an eyeball sphere (white) sits behind the opening, parented to
  `hermes_eye_*`, so the app's blink squash and disable still work;
- the iris, iris glow, pupil and glints are projected onto the sphere along
  +z, parented to `hermes_pupil_*`, so the gaze offset still slides them;
- a skin-coloured socket sphere behind the eyeball is always visible, so a
  squashed eyeball never shows the inside of the head;
- the face faces cut out of the opening become `lid_skin_*` under
  `hermes_lid_*`, which closes the opening when the app shows the closed lid.

Liner, lashes, crease and brows stay as decals on the face, around the
opening. Node names and the rig manifest are unchanged.
"""
import math
import bmesh, bpy
from mathutils import Vector, Matrix
from mathutils.geometry import tessellate_polygon

R_EYE = 0.065          # eyeball radius (head frame, metres)
SINK = 0.0018          # eyeball front sits this far behind the face at the eye centre


def _inside(pt, poly):
    x, y = pt; c = False; n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            c = not c
    return c


def _nearest_on(poly, p):
    best = None
    n = len(poly)
    for i in range(n):
        a = Vector(poly[i]); b = Vector(poly[(i + 1) % n]); ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / (ab.length_squared or 1e-12)))
        q = a + ab * t
        d = (q - p).length
        if best is None or d < best[0]:
            best = (d, q)
    return best


def cut_opening(obj, outline, lid=None):
    """Delete front faces whose centre lies inside `outline` (head-frame xy),
    with the rim vertices snapped onto the outline.

    lid = (name, parent, origin): the removed faces become that object instead
    of being thrown away -- the closed lid. It keeps the face's material and
    UVs, and the face and lid both get the normals of the uncut mesh as
    custom normals, so a blink shows the face's painted skin with no outline or
    crease (a separate skin decal read as a patch)."""
    me = obj.data
    bm = bmesh.new(); bm.from_mesh(me)
    kill = {f for f in bm.faces if f.calc_center_median().z > 0.05
            and _inside((f.calc_center_median().x, f.calc_center_median().y), outline)}
    # normals of the smooth, uncut surface: the snap below leaves sliver
    # triangles at the rim whose own normals would streak the shading
    bm.normal_update()
    oi = bm.verts.layers.int.new("oi")
    for v in bm.verts:
        v[oi] = v.index
    normals = [v.normal.copy() for v in bm.verts]
    rim = {v for f in kill for v in f.verts if any(g not in kill for g in v.link_faces)}
    for v in rim:                       # snap on the whole mesh, before cutting
        d, q = _nearest_on(outline, Vector((v.co.x, v.co.y)))
        if d < 0.006:
            v.co.x, v.co.y = q.x, q.y
    if lid is not None:
        name, parent, origin = lid
        lbm = bm.copy()
        lbm.faces.ensure_lookup_table()
        keep = {f.index for f in kill}
        bmesh.ops.delete(lbm, geom=[f for f in lbm.faces if f.index not in keep], context="FACES")
        bmesh.ops.delete(lbm, geom=[v for v in lbm.verts if not v.link_faces], context="VERTS")
        loi = lbm.verts.layers.int["oi"]
        vn = [normals[v[loi]] for v in lbm.verts]
        for v in lbm.verts:
            v.co -= origin
        lme = bpy.data.meshes.new(name); lbm.to_mesh(lme); lbm.free()
        lme.attributes.remove(lme.attributes["oi"])
        for poly in lme.polygons:
            poly.use_smooth = True
        lme.normals_split_custom_set_from_vertices(vn)
        for m in me.materials:
            lme.materials.append(m)
        ob = bpy.data.objects.new(name, lme); bpy.context.scene.collection.objects.link(ob)
        ob.parent = parent
    bmesh.ops.delete(bm, geom=list(kill), context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    fn = [normals[v[oi]] for v in bm.verts]
    bm.to_mesh(me); bm.free()
    me.attributes.remove(me.attributes["oi"])
    if lid is not None:                 # the face keeps the uncut normals at the rim
        me.normals_split_custom_set_from_vertices(fn)
    me.update()
    return ob if lid is not None else None


def _offset_poly(poly, d):
    """Grow a CCW/CW polygon outward by d (vertex normal offset)."""
    n = len(poly); out = []
    cx = sum(p[0] for p in poly) / n; cy = sum(p[1] for p in poly) / n
    for x, y in poly:
        v = Vector((x - cx, y - cy)); L = v.length or 1
        out.append((x + v.x / L * d, y + v.y / L * d))
    return out


class EyeSurface:
    """z(x, y) of the eye: the sphere, but never in front of the face. The
    centre (iris) is a forward-facing sphere; toward the corners, where the
    round face turns away faster than any sphere, it tucks just inside the face."""

    def __init__(self, center, radius, face_bvh, gap):
        self.c, self.r, self.bvh, self.gap = center, radius, face_bvh, gap

    def z(self, x, y):
        dx, dy = x - self.c.x, y - self.c.y
        zs = self.c.z + math.sqrt(max(0.0, self.r * self.r - dx * dx - dy * dy))
        hit, _, _, _ = self.bvh.ray_cast(Vector((x, y, 1)), Vector((0, 0, -1)))
        return min(zs, hit.z - self.gap) if hit else zs


def _patch(name, outline, surf, depth, mat, parent, origin, step=0.0016, smooth=True):
    """A mesh covering `outline` (head-frame xy) lying on surf.z + depth."""
    xs = [p[0] for p in outline]; ys = [p[1] for p in outline]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    nx = max(2, int((x1 - x0) / step) + 2); ny = max(2, int((y1 - y0) / step) + 2)
    bm = bmesh.new(); grid = {}
    for i in range(nx):
        for j in range(ny):
            x = x0 + (x1 - x0) * i / (nx - 1); y = y0 + (y1 - y0) * j / (ny - 1)
            grid[i, j] = bm.verts.new((x, y, surf.z(x, y) + depth))
    for i in range(nx - 1):
        for j in range(ny - 1):
            q = [grid[i, j], grid[i + 1, j], grid[i + 1, j + 1], grid[i, j + 1]]
            c = sum((v.co for v in q), Vector()) / 4
            if _inside((c.x, c.y), outline):
                bm.faces.new(q)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    # snap the patch rim onto the outline
    for v in bm.verts:
        if any(e.is_boundary for e in v.link_edges):
            d, q = _nearest_on(outline, Vector((v.co.x, v.co.y)))
            if d < step * 1.5:
                v.co.x, v.co.y = q.x, q.y
                v.co.z = surf.z(q.x, q.y) + depth
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    for f in bm.faces:
        f.normal_update()
        if f.normal.z < 0:
            f.normal_flip()
    for v in bm.verts:
        v.co -= origin
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    return ob


def build(F, head, face, backing, face_bvh, eyes, pupils, lids, mats, skin_decal):
    """eyes/pupils/lids: {side: joint object}. mats: white, iris, glow, line, skin, lidshadow.
    skin_decal(name, parent, outline, depth, mat): the builder's face decal()."""
    made = []
    for s, label in ((-1, "left"), (1, "right")):
        x0, y0 = s * F.EYE_X, F.EYE_Y
        outline = [(x + x0, y + y0) for x, y in F.almond(s)]
        hit, _, _, _ = face_bvh.ray_cast(Vector((x0, y0, 1)), Vector((0, 0, -1)))
        zc = hit.z if hit else 0.15
        center = Vector((x0, y0, zc - SINK - R_EYE))
        eye_s = EyeSurface(center, R_EYE, face_bvh, 0.0008)
        sock_s = EyeSurface(center - Vector((0, 0, 0.004)), R_EYE, face_bvh, 0.0045)
        eye, pupil, lid = eyes[label], pupils[label], lids[label]
        eo = Vector((x0, y0, 0)); po = eo + pupil.location
        big = _offset_poly(outline, 0.0025)
        made.append(_patch("eyeball_" + label, big, eye_s, 0.0, mats["white"], eye, eo))
        made.append(_patch("eye_socket_" + label, _offset_poly(outline, 0.0035), sock_s, 0.0, mats["skin"], head, Vector()))
        made.append(_patch("lid_shadow_" + label, [(x + x0, y + y0) for x, y in F.lid_shadow(s)], eye_s, .0005, mats["lidshadow"], eye, eo))
        for nm, pts, d, m in (("iris_", F.iris(s), .0008, "iris"), ("iris_glow_", F.iris_glow(s), .0011, "glow"),
                              ("pupil_", F.pupil(s), .0014, "line"), ("highlight_", F.glint(s), .0018, "white"),
                              ("highlight_small_", F.glint_small(s), .0018, "white")):
            made.append(_patch(nm + label, [(x + x0, y + y0) for x, y in pts], eye_s, d, mats[m], pupil, po, step=0.0011))
        made.append(cut_opening(face, outline, ("lid_skin_" + label, lid, eo)))
        if backing is not None:
            cut_opening(backing, outline)
    return made
