"""Low-poly facets for the hair mass, laid along its designed flow grid.

The cage's columns follow the hair's fall from the crown and its rings wrap the
head; that grid IS the intended facet layout. Flat-shaded as-is it reads as a
checkerboard (regular equal quads, tried 2026-10-01). So each quad is split along
the diagonal chosen by grid parity (diamond facets, as on the concept), and every
vertex is nudged along the surface by a small deterministic offset so the planes
vary like the concept's hand-cut facets. No Decimate/Remesh: the layout stays the
designed one, only its regularity is broken.
"""
import math
import bmesh
from mathutils import Vector


import os
FOLD = float(os.environ.get('HERMES_HAIR_FOLD', 0.05))


def _hash(a, b, salt):
    h = (a * 73856093) ^ (b * 19349663) ^ (salt * 83492791)
    return ((h & 0xFFFF) / 0xFFFF) * 2 - 1


def facet_mass(me, jitter=0.11, lift=0.035, axis_y=0.6, fold=FOLD):
    bm = bmesh.new(); bm.from_mesh(me)
    lr = bm.verts.layers.int.get("ring"); lc = bm.verts.layers.int.get("col")
    bm.verts.ensure_lookup_table()
    for i, v in enumerate(bm.verts):
        r = v[lr] if lr else i; c = v[lc] if lc else i
        refined = r == -2
        if refined:                      # refined fringe verts: hash by index, they share (-2,-2)
            r, c = 1000 + i, 2000 + i
        radial = Vector((v.co.x, v.co.y - axis_y, 0))
        radial = radial.normalized() if radial.length > 1e-6 else Vector((0, 0, 1))
        tang = Vector((0, 0, 1)).cross(radial).normalized() if radial.length > 0 else Vector((1, 0, 0))
        down = Vector((0, 0, 1))
        on_rim = any(e.is_boundary for e in v.link_edges)
        k = 0.25 if on_rim else 1.0    # rims (hems, the face window) keep their measured line
        if refined:
            k *= 0.0                   # dense fringe rows: full jitter read as a band of spikes
        # sideways jitter only: vertical jitter staggered the rings and cut the
        # surface into horizontal bands (a 'brim' read in RealityKit, 2026-10-02)
        v.co += (tang * _hash(r, c, 1) * jitter * 0.8 + down * _hash(r, c, 2) * jitter * 0.15) * k
        # alternate ridge / groove by column: the concept's facets run as long
        # strand planes from the crown down, not as a random diamond quilt with
        # horizontal ring bands (RealityKit review, 2026-10-01)
        # (a strict +/- alternation read as a pleated lampshade; per-column random
        # heights give irregular strand planes)
        ridge = _hash(0, c, 7) if not refined else 0.0
        # the per-column ridge carries the facet look: strand planes from the crown down
        v.co += radial * (ridge * 1.8 + _hash(r, c, 3) * 0.25) * lift * k
        # fold each quad along the diagonal it is split on: the diagonal's two
        # corners share (ring + col) parity, so pushing that parity out and the
        # other in creases every quad into two visible triangles. Flat pairs
        # read as a grid of squares on the crown, where the concept shows
        # large irregular triangles (2026-10-02). Dome rings only; the curtain
        # keeps its strand planes.
        if not refined and 0 <= r <= 6:
            sgn = 1.0 if (r + c) % 2 == 0 else -1.0
            v.co += radial * sgn * fold * (0.6 + 0.4 * abs(_hash(r, c, 11))) * k
    quads = [f for f in bm.faces if len(f.verts) == 4]
    for f in quads:
        vs = list(f.verts)
        r0 = min((v[lr] if lr else 0) for v in vs); c0 = min((v[lc] if lc else 0) for v in vs)
        use_a = (r0 + c0) % 2 == 0
        a, b, c, d = vs
        bmesh.ops.connect_verts(bm, verts=[a, c] if use_a else [b, d])
    bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = False
