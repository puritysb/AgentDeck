"""Fixed-angle visual evidence of the actual Blender model, never concept art.
Run with Blender --background --python; optional -- --label before to retain a baseline.
Views share scale, lighting and camera elevation; also render at 96 px.
"""
from pathlib import Path
import bpy, math, sys
from mathutils import Vector, Matrix
ROOT=Path(__file__).resolve().parents[2]
args=sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else []
label=args[args.index('--label')+1] if '--label' in args else 'after'
out=ROOT/'diagnostics/hermes-mermaid'/label;out.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(ROOT/'assets/terrarium/hermes-mermaid.blend'))
scene=bpy.context.scene;bpy.data.objects['resident_hermes'].rotation_euler=(0,0,0)
bpy.ops.object.camera_add();camera=bpy.context.object;scene.camera=camera
camera.data.type='ORTHO';camera.data.ortho_scale=1.40
for pos,power,size in [((1.5,2.5,3),220,3),((-2,1,1),170,2)]:
    bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=power;o.data.size=size;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
scene.render.engine='CYCLES';scene.cycles.samples=24
scene.world=bpy.data.worlds.new('Fixed evaluation');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.035,.055,.07,1)
scene.view_settings.view_transform='AgX';scene.render.resolution_percentage=100
for name,degrees in [('front',0),('portrait',40),('profile',85)]:
    a=math.radians(degrees);camera.location=(math.sin(a)*4,.08,math.cos(a)*4)
    back=(camera.location-Vector((0,-.04,0))).normalized();right=Vector((0,1,0)).cross(back).normalized();up=back.cross(right)
    camera.rotation_euler=Matrix((right,up,back)).transposed().to_euler()
    for size in (640,96):
        scene.render.resolution_x=scene.render.resolution_y=size
        scene.render.filepath=str(out/f'{name}-{size}.png');bpy.ops.render.render(write_still=True)
