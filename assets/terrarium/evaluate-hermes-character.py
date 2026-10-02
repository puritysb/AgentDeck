"""Inspect actual candidate geometry and render the dashboard-size asset.
Run with Blender --background --python. Does not change app resources.
"""
from pathlib import Path
import bpy, bmesh, hashlib, json, math
from mathutils import Matrix, Vector

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'diagnostics/hermes-mermaid/character-v6'
OUT.mkdir(parents=True, exist_ok=True)
model = ROOT / 'assets/terrarium/hermes-character.blend'
bpy.ops.wm.open_mainfile(filepath=str(model))
root = bpy.data.objects['resident_hermes']
root.rotation_euler = (0, 0, 0)
meshes = [o for o in root.children_recursive if o.type == 'MESH']
rows = []
for obj in meshes:
    obj.data.calc_loop_triangles()
    weights = []
    if any(m.type == 'ARMATURE' for m in obj.modifiers):
        weights = [sum(g.weight for g in v.groups) for v in obj.data.vertices]
        assert all(abs(w - 1) < .00001 for w in weights), obj.name
    shapes = obj.data.shape_keys
    if shapes:
        assert all(k.value == 0 for k in list(shapes.key_blocks)[1:]), obj.name
        assert all(len(k.data) == len(obj.data.vertices) for k in shapes.key_blocks)
    rows.append(dict(name=obj.name, vertices=len(obj.data.vertices), triangles=len(obj.data.loop_triangles),
                     relative_shapes=list(shapes.key_blocks.keys())[1:] if shapes else [],
                     weighted_vertices=len(weights)))
report = dict(status='candidate; visual acceptance incomplete',
              source_sha256=hashlib.sha256(model.read_bytes()).hexdigest(),
              usdz_sha256=hashlib.sha256((ROOT/'assets/terrarium/hermes-character.usdz').read_bytes()).hexdigest(),
              bones=list(bpy.data.objects['hermes_skeleton'].data.bones.keys()), meshes=rows,
              total_vertices=sum(r['vertices'] for r in rows), total_triangles=sum(r['triangles'] for r in rows),
              checks=['normalized skin weights', 'zero-valued independent expression defaults', 'shape vertex counts'])
(OUT/'geometry-review.json').write_text(json.dumps(report, indent=2)+'\n')
scene = bpy.context.scene
for loc, power, size in [((1.5, 2, 3), 230, 3), ((-2, 1, 1), 140, 2), ((.5, 1, -2), 170, 2)]:
    bpy.ops.object.light_add(type='AREA', location=loc)
    light = bpy.context.object
    light.data.energy = power
    light.data.size = size
    light.rotation_euler = (Vector((0, .1, 0))-light.location).to_track_quat('-Z', 'Y').to_euler()
bpy.ops.object.camera_add()
camera = bpy.context.object
scene.camera = camera
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 1.13
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.render.resolution_x = scene.render.resolution_y = 96
for label, angle in [('front', 0), ('portrait', 40), ('profile', 85), ('back', 180)]:
    angle = math.radians(angle)
    target = Vector((-.01, .045, -.02))
    camera.location = target + Vector((4*math.sin(angle), .1, 4*math.cos(angle)))
    back = (camera.location-target).normalized()
    right = Vector((0, 1, 0)).cross(back).normalized()
    camera.rotation_euler = Matrix((right, back.cross(right), back)).transposed().to_euler()
    scene.render.filepath = str(OUT / (label+'-96.png'))
    bpy.ops.render.render(write_still=True)
print(json.dumps({k:v for k,v in report.items() if k != 'meshes'}))
