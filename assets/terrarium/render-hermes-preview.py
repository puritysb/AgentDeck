"""Render the shipped mesh using poses sampled from the real Swift controller.
Outputs close-up motion plus contact sheet under ignored diagnostics/.
"""
from pathlib import Path
import bpy,json,math,os
from mathutils import Vector,Matrix,Quaternion
ROOT=Path(__file__).resolve().parents[2];out=ROOT/'diagnostics/hermes-mermaid'
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'assets/terrarium/hermes-mermaid.blend'))
scene=bpy.context.scene;root=bpy.data.objects['resident_hermes'];root.rotation_euler=(0,0,0)
frames=json.loads((out/'motion.json').read_text());rig=bpy.data.objects['hermes_skeleton']
def rotation(v):return Quaternion((1,0,0),v[0])@Quaternion((0,1,0),v[1])@Quaternion((0,0,1),v[2])
def rotate(name,v,f):
    obj=bpy.data.objects[name];obj.rotation_mode='QUATERNION';obj.rotation_quaternion=rotation(v);obj.keyframe_insert('rotation_quaternion',frame=f)
names={'spine':'spine','tail_base':'tailBase','tail_mid':'tailMid','tail_tip':'tailTip','fin':'fin','fin_left':'finLeft','fin_right':'finRight','arm_left':'armLeft','elbow_left':'elbowLeft','wrist_left':'wristLeft','arm_right':'armRight','elbow_right':'elbowRight','wrist_right':'wristRight'}
rest={name:obj.location.copy() for name,obj in bpy.data.objects.items()}
for frame in frames:
    f=frame['frame'];p=frame['pose']
    # Close view retains true orientation and a scaled travel excursion.
    root.location=(Vector(frame['position'])-Vector((0,2.7,0)))*.20
    root.rotation_mode='QUATERNION';root.rotation_quaternion=Quaternion((0,1,0),frame['yaw']*.65)@Quaternion((1,0,0),frame['pitch'])@Quaternion((0,0,1),frame['roll'])
    root.keyframe_insert('location',frame=f);root.keyframe_insert('rotation_quaternion',frame=f)
    for bone,key in names.items():
        b=rig.pose.bones[bone];b.rotation_quaternion=rotation(p[key]);b.keyframe_insert('rotation_quaternion',frame=f)
    rotate('hermes_spine',p['spine'],f);rotate('hermes_head',p['head'],f)
    for side in ['left','right']:
        cap=side.title();rotate('hermes_hair_'+side,[p['hair'+cap],0,0],f)
        eye=bpy.data.objects['hermes_eye_'+side];openness=p['eye'+cap];eye.scale.y=max(.05,openness);eye.keyframe_insert('scale',frame=f)
        for child in eye.children_recursive:
            if child.type=='MESH':child.hide_render=openness<=.12;child.keyframe_insert('hide_render',frame=f)
        lid=bpy.data.objects['closed_lid_'+side];lid.hide_render=openness>.12;lid.keyframe_insert('hide_render',frame=f)
        pupil=bpy.data.objects['hermes_pupil_'+side];pupil.location=rest[pupil.name]+Vector((*p['pupil'],0));pupil.keyframe_insert('location',frame=f)
        brow=bpy.data.objects['hermes_brow_'+side];rotate(brow.name,[0,0,p['brow'+cap]],f);brow.location=rest[brow.name]+Vector((0,p['browLift'],0));brow.keyframe_insert('location',frame=f)
    lip=bpy.data.objects['hermes_lip_lower'];lip.location=rest[lip.name]+Vector((0,-p['mouthOpen']*.012,0));lip.scale.y=1+p['mouthCurve'];lip.keyframe_insert('location',frame=f);lip.keyframe_insert('scale',frame=f)
    lip=bpy.data.objects['hermes_lip_upper'];lip.scale.y=1-p['mouthCurve'];lip.keyframe_insert('scale',frame=f)
    opening=bpy.data.objects['mouth_open'];opening.hide_render=p['mouthOpen']<=.03;opening.scale.y=max(.01,p['mouthOpen']);opening.keyframe_insert('hide_render',frame=f);opening.keyframe_insert('scale',frame=f)
bpy.ops.object.camera_add(location=(.7,.28,4));camera=bpy.context.object;scene.camera=camera
back=(camera.location-Vector((0,-.07,0))).normalized();right=Vector((0,1,0)).cross(back).normalized();up=back.cross(right)
camera.rotation_euler=Matrix((right,up,back)).transposed().to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=1.7
for pos,power,size in [((1.5,2.5,3),220,3),((-2,1,1),170,2)]:
    bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=power;o.data.size=size;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
scene.world=bpy.data.worlds.new('Dark aquarium');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.02,.04,.05,1)
scene.render.engine='CYCLES';scene.cycles.samples=12;scene.view_settings.view_transform='AgX'
scene.render.resolution_x=640;scene.render.resolution_y=640;scene.render.resolution_percentage=100
scene.render.fps=12;scene.frame_start=1;scene.frame_end=len(frames);scene.render.image_settings.file_format='PNG'
# HERMES_STILLS=1 makes four quick review frames before paying for the clip.
if os.environ.get('HERMES_STILLS')=='1':
    for number in [24,84,150,260]:
        scene.frame_set(number);scene.render.filepath=str(out/f'rig-pose-{number}.png');bpy.ops.render.render(write_still=True)
else:
    scene.render.filepath=str(out/'rig-frames/frame-');bpy.ops.render.render(animation=True)
