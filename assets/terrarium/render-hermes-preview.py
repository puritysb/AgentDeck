"""Render the actual exported mesh with sampled HermesSwim poses; no AI animation.
First run preview-hermes-motion.swift; outputs diagnostics/hermes-mermaid/frames.
"""
from pathlib import Path
import bpy, json, math
from mathutils import Vector, Matrix, Quaternion
ROOT=Path(__file__).resolve().parents[2]
output=ROOT/'diagnostics/hermes-mermaid'
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'assets/terrarium/hermes-mermaid.blend'))
scene=bpy.context.scene;root=bpy.data.objects['resident_hermes'];root.rotation_euler=(0,0,0);root.scale=(.8,)*3
with bpy.data.libraries.load(str(ROOT/'assets/terrarium/3d-residents.blend'),link=False) as (source,destination):
    destination.objects=source.objects
peers={'resident_claudecode':(1.1,2,0),'resident_codex':(-1.2,2.8,.1),'resident_opencode':(1.7,3.3,-.2)}
for obj in destination.objects:
    if obj is None: continue
    top=obj
    while top.parent:top=top.parent
    if top.name in peers:scene.collection.objects.link(obj)
for name,position in peers.items():
    obj=bpy.data.objects[name];obj.location=position;obj.rotation_euler=(0,0,0);obj.scale=(.8,)*3
frames=json.loads((output/'motion.json').read_text())
for frame in frames:
    f=frame['frame'];root.location=frame['position']
    root.rotation_mode='QUATERNION'
    root.rotation_quaternion=Quaternion((0,1,0),frame['yaw'])@Quaternion((1,0,0),frame['pitch'])@Quaternion((0,0,1),frame['roll'])
    root.keyframe_insert('location',frame=f);root.keyframe_insert('rotation_quaternion',frame=f)
    for name,axis,angle in [('hermes_tail',(1,0,0),frame['tail']),('hermes_fin',(1,0,0),frame['fin']),
                             ('hermes_arm_left',(0,0,1),-frame['arm']),('hermes_arm_right',(0,0,1),frame['rightArm'])]:
        obj=bpy.data.objects[name];obj.rotation_mode='QUATERNION';obj.rotation_quaternion=Quaternion(axis,angle)
        if name=='hermes_tail':obj.rotation_quaternion @= Quaternion((0,0,1),frame['turn'])
        obj.keyframe_insert('rotation_quaternion',frame=f)
    for name in ['hermes_eye_left','hermes_eye_right']:
        obj=bpy.data.objects[name];obj.scale.y=frame['blink'];obj.scale.x=frame['eyeWidth'];obj.keyframe_insert('scale',frame=f)
    obj=bpy.data.objects['hermes_head'];obj.rotation_mode='QUATERNION'
    obj.rotation_quaternion=Quaternion((0,0,1),frame['headRoll'])@Quaternion((1,0,0),frame['headPitch'])
    obj.keyframe_insert('rotation_quaternion',frame=f)
    obj=bpy.data.objects['smile'];obj.scale.y=frame['smileHeight'];obj.keyframe_insert('scale',frame=f)
bpy.ops.object.camera_add(location=(1.5,3.4,7.5));camera=bpy.context.object;scene.camera=camera
back=(camera.location-Vector((0,2.7,0))).normalized();right=Vector((0,1,0)).cross(back).normalized();up=back.cross(right)
camera.rotation_euler=Matrix((right,up,back)).transposed().to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=4.7
for pos,power,size in [((2,6,5),600,5),((-3,4,2),400,4)]:
    bpy.ops.object.light_add(type='AREA',location=pos);obj=bpy.context.object;obj.data.energy=power;obj.data.size=size
    obj.rotation_euler=(Vector((0,2.7,0))-obj.location).to_track_quat('-Z','Y').to_euler()
scene.world=bpy.data.worlds.new('Dark aquarium');scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.015,.028,.045,1)
scene.render.engine='CYCLES';scene.cycles.samples=8
scene.render.resolution_x=720;scene.render.resolution_y=480;scene.render.resolution_percentage=100
scene.render.fps=12;scene.frame_start=1;scene.frame_end=len(frames)
scene.render.image_settings.file_format='PNG';scene.render.filepath=str(output/'frames/frame-')
bpy.ops.render.render(animation=True)
