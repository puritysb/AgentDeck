"""Export the original mermaid hierarchy with a lightweight live skin, without changing the source blend.
Run: blender --background --python-exit-code 1 --python assets/terrarium/export-android-hermes.py
"""
from pathlib import Path
import bpy
from mathutils import Vector
ROOT = Path(__file__).resolve().parents[2]
bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'assets/terrarium/hermes-mermaid.blend'))
for arm in (o for o in bpy.data.objects if o.type == 'ARMATURE'):
    arm.data.pose_position = 'REST'
# Decimate before skinning so vertex groups and the original bone hierarchy survive.
meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.visible_get()]
for obj in meshes:
    if len(obj.data.vertices) > 500:
        mod = obj.modifiers.new('Android decimate', 'DECIMATE')
        mod.ratio = max(.03, 320 / len(obj.data.vertices))
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_move_up(modifier=mod.name) if len(obj.modifiers) > 1 else None
        bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.context.view_layer.update()
points = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
lo=Vector(tuple(min(p[i] for p in points) for i in range(3)))
hi=Vector(tuple(max(p[i] for p in points) for i in range(3)))
center=(lo+hi)/2; scale=1/(hi.z-lo.z)
original=bpy.data.objects['resident_hermes'];original.name='hermes_character'
root=bpy.data.objects.new('resident_hermes',None);bpy.context.scene.collection.objects.link(root)
original.parent=root;original.location-=center
root.scale=(scale,scale,scale)
bpy.ops.object.select_all(action='DESELECT')
for o in bpy.data.objects:
    if o.type in {'MESH','EMPTY','ARMATURE'}: o.select_set(True)
destination=ROOT/'android/app/src/main/assets/residents/hermes.glb'
bpy.ops.export_scene.gltf(filepath=str(destination),export_format='GLB',use_selection=True,
    export_animations=False,export_cameras=False,export_lights=False,export_yup=True,
    export_apply=False,export_skins=True,export_all_influences=False)
print('EXPORTED',destination,'vertices',sum(len(o.data.vertices) for o in meshes))
