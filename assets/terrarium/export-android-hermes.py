"""Export the bundled Hermes mermaid as a lightweight Android aquarium resident.

The Apple USDZ keeps the full rig (~70k vertices, face controls, laptop). The
Android 3D aquarium draws every resident as a static glTF template from
android/app/src/main/assets/residents/ and animates it with whole-body
transforms (AquariumResidents.kt), so this export:

- evaluates every mesh in its REST pose (armature/shape keys applied), with
  no write back to the source blend;
- decimates only the heavy meshes (face, body) so the template stays near the
  other residents (Kiro ~6.9k vertices, < 1 MB);
- normalizes it into the residents' frame: ~1 unit tall and centered on the
  origin like resident_kiro in 3d-residents.blend.

Run: blender --background --python-exit-code 1 --python assets/terrarium/export-android-hermes.py
"""
from pathlib import Path
import bpy
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[2]
TARGET_HEIGHT = 1.0
HEAVY_VERTS = 500
TARGET_VERTS_PER_HEAVY_MESH = 320

bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'assets/terrarium/hermes-mermaid.blend'))
for arm in (o for o in bpy.data.objects if o.type == 'ARMATURE'):
    arm.data.pose_position = 'REST'
bpy.context.view_layer.update()

depsgraph = bpy.context.evaluated_depsgraph_get()
baked = []
for source in [o for o in bpy.data.objects if o.type == 'MESH' and o.visible_get()]:
    evaluated = source.evaluated_get(depsgraph)
    mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
    copy = bpy.data.objects.new(source.name + '_android', mesh)
    copy.matrix_world = source.matrix_world.copy()
    bpy.context.scene.collection.objects.link(copy)
    baked.append(copy)

# Decimate through the evaluated mesh, not bpy.ops.object.modifier_apply: the
# operator needs a UI context and silently does nothing in --background.
bpy.context.view_layer.update()
for obj in baked:
    count = len(obj.data.vertices)
    if count <= HEAVY_VERTS:
        continue
    mod = obj.modifiers.new('decimate', 'DECIMATE')
    mod.ratio = max(0.03, TARGET_VERTS_PER_HEAVY_MESH / count)
    bpy.context.view_layer.update()
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    reduced = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True,
                                              depsgraph=bpy.context.evaluated_depsgraph_get())
    obj.modifiers.remove(mod)
    obj.data = reduced

points = [obj.matrix_world @ v.co for obj in baked for v in obj.data.vertices]
lo = Vector((min(p.x for p in points), min(p.y for p in points), min(p.z for p in points)))
hi = Vector((max(p.x for p in points), max(p.y for p in points), max(p.z for p in points)))
center = (lo + hi) / 2
scale = TARGET_HEIGHT / max(1e-6, hi.z - lo.z)

# The source rig already owns the name; the template root must carry it
# exactly (AquariumResidentsTest checks `resident_<kind>`).
if 'resident_hermes' in bpy.data.objects:
    bpy.data.objects['resident_hermes'].name = 'resident_hermes_source'
root = bpy.data.objects.new('resident_hermes', None)
bpy.context.scene.collection.objects.link(root)
for obj in baked:
    obj.matrix_world.translation -= center
    obj.parent = root
    obj.matrix_parent_inverse = root.matrix_world.inverted()
root.scale = (scale, scale, scale)
bpy.context.view_layer.update()

bpy.ops.object.select_all(action='DESELECT')
root.select_set(True)
for obj in baked:
    obj.select_set(True)
destination = ROOT / 'android/app/src/main/assets/residents/hermes.glb'
bpy.ops.export_scene.gltf(
    filepath=str(destination), export_format='GLB',
    use_selection=True, use_active_scene=True, export_animations=False, export_cameras=False,
    export_lights=False, export_yup=True, export_apply=True,
)
print('EXPORTED', destination, 'verts', sum(len(o.data.vertices) for o in baked),
      'extent', tuple(round((hi - lo)[i] * scale, 3) for i in range(3)))
