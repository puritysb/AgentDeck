"""Author Hermes' hinged scallop home; no downloaded assets.

blender --background --python assets/terrarium/build-hermes-shell.py
Writes the editable source, Apple USDZ, portable GLB, and three review frames.
The lid's object origin is the rear hinge; runtime rotates only this node.
"""
from pathlib import Path
import bpy, math, re, sys
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).parent))
from brand_materials import linear_rgb
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'diagnostics/hermes-shell'
OUT.mkdir(parents=True, exist_ok=True)
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.name = 'Hermes scallop home'
tokens = (ROOT / 'design/tokens.css').read_text()
def material(name, token, roughness=.5):
    value = re.search(r'--' + token + r':\s*#([0-9a-fA-F]{6})', tokens).group(1)
    rgb = linear_rgb(tuple(int(value[i:i+2],16) for i in (0,2,4)))
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*rgb, 1)
    p.inputs['Roughness'].default_value = roughness
    p.inputs['Coat Weight'].default_value = .18
    m.diffuse_color = (*rgb, 1)
    return m
outer = material('Scallop warm exterior', 'tide-200', .58)
inner = material('Scallop nacre', 'tide-100', .34)
rim = material('Scallop growth rim', 'tide-300', .52)
root = bpy.data.objects.new('hermes_shell', None)
scene.collection.objects.link(root)
# Fan opens toward -Y (viewer); export converts Z-up to native Y-up.
# Both valves share a rear hinge. Closed lid curves over the concave bowl.
rings, slices = 18, 72
for lid in (False, True):
    verts, faces = [], []
    for layer in (0,1):
        for ring in range(rings+1):
            r = ring/rings
            for sl in range(slices+1):
                a = (sl/slices - .5)*2.95
                rib = math.cos(a*13)
                radius = r*(1 + .018*math.cos(a*13)*r*r)
                x = math.sin(a)*radius*1.03
                y = -math.cos(a)*radius*1.35
                # Rounded domed valves; raised lip, deep usable pearl basin.
                boundary = max(0, math.sin(math.pi*r)) * max(0, math.cos(a/1.475*math.pi/2))
                dome = (.30 if lid else .22)*boundary
                z = (dome if lid else -dome) + .026*math.cos(a*13)*boundary
                z += (.018 if layer else -.018)
                verts.append((x,y,z))
    n=(rings+1)*(slices+1)
    for ring in range(rings):
        for sl in range(slices):
            a=ring*(slices+1)+sl; b=a+slices+1
            faces.extend([(a,a+1,b+1,b),(n+a,n+b,n+b+1,n+a+1)])
    for sl in range(slices):
        a=rings*(slices+1)+sl
        faces.append((a,n+a,n+a+1,a+1))
    for ring in range(rings):
        for sl in (0,slices):
            a=ring*(slices+1)+sl; b=a+slices+1
            faces.append((a,b,n+b,n+a))
    mesh=bpy.data.meshes.new('Fluted scallop valve')
    mesh.from_pydata(verts,[],faces);mesh.materials.clear()
    for m in (outer,inner,rim):mesh.materials.append(m)
    mesh.update()
    obj=bpy.data.objects.new('shell_lid' if lid else 'shell_seat',mesh)
    scene.collection.objects.link(obj);obj.parent=root;obj.location=(0,.40,.16)
    for i,p in enumerate(mesh.polygons):
        p.use_smooth=True
        p.material_index=(0 if lid else 1) if i%2==0 else (1 if lid else 0)
        if i >= rings*slices*2:p.material_index=2
    # The runtime opens the lid around its origin; no baked animation libraries.
    obj.rotation_euler.x = 0
# Small hinge preserves the recognisable bivalve shape from a side view.
bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=1, location=(0,.40,.16))
hinge=bpy.context.object;hinge.name='shell-hinge';hinge.scale=(.24,.13,.10);hinge.parent=root;hinge.data.materials.append(rim)
for p in hinge.data.polygons:p.use_smooth=True
bpy.ops.object.select_all(action='SELECT')
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/terrarium/hermes-shell.blend'))
bpy.ops.wm.usd_export(filepath=str(ROOT/'apple/AgentDeck/Resources/Aquarium/hermes-shell.usdz'),
    selected_objects_only=True, export_animation=False, triangulate_meshes=True, generate_preview_surface=True,
    convert_orientation=True, export_global_forward_selection='NEGATIVE_Z', export_global_up_selection='Y')
portable=ROOT/'assets/terrarium/hermes-shell.glb'
bpy.ops.export_scene.gltf(filepath=str(portable),export_format='GLB',use_selection=True,export_animations=False,export_cameras=False,export_lights=False)
# Review with the actual bundled mermaid, preserving her materials and anatomy.
shell_objects=set(bpy.data.objects)
bpy.ops.wm.usd_import(filepath=str(ROOT/'apple/AgentDeck/Resources/Aquarium/hermes-mermaid.usdz'))
imported=[o for o in bpy.data.objects if o not in shell_objects]
character=bpy.data.objects.new('Review mermaid',None);scene.collection.objects.link(character)
for o in imported:
    if o.parent is None:o.parent=character
# USD importer handles the authored stage axes. Seat contact uses mesh bounds.
scene.view_layers[0].update()
points=[o.matrix_world @ Vector(c) for o in imported if o.type=='MESH' for c in o.bound_box]
minz=min(p.z for p in points);character.location.z=.20-minz
character.location.y=-.30
rest_z=character.location.z
floor=material('Water garden floor','ink-800',.85)
bpy.ops.mesh.primitive_plane_add(size=200, location=(0,0,-.17))
bpy.context.object.data.materials.append(floor)
scene.world=bpy.data.worlds.new('Water');scene.world.use_nodes=True
bg=scene.world.node_tree.nodes['Background'];bg.inputs[0].default_value=(*linear_rgb(tuple(int(re.search(r'--ink-900:\s*#([0-9a-fA-F]{6})', tokens).group(1)[i:i+2],16) for i in (0,2,4))),1);bg.inputs[1].default_value=.5
for location,power,size in [((2,-4,6),550,5),((-3,-1,2),220,3),((0,3,5),400,3)]:
    bpy.ops.object.light_add(type='AREA',location=location)
    light=bpy.context.object;light.data.energy=power;light.data.shape='DISK';light.data.size=size
    light.rotation_euler=(Vector((0,0,.8))-light.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add(location=(2.8,-6.5,3.3))
cam=bpy.context.object;scene.camera=cam;cam.data.type='ORTHO';cam.data.ortho_scale=3.8
cam.rotation_euler=(Vector((0,-.1,.85))-cam.location).to_track_quat('-Z','Y').to_euler()
scene.render.engine='BLENDER_EEVEE';scene.render.resolution_x=1000;scene.render.resolution_y=900;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
lid=bpy.data.objects['shell_lid']
for name,angle,lift,visible in [('rest',.04,0,False),('emerge',1.22,.12,True),('swim',1.22,.70,True)]:
    lid.rotation_euler.x=-angle
    character.location.z=rest_z+lift
    for o in imported:o.hide_render=not visible
    scene.render.filepath=str(OUT/(name+'.png'));bpy.ops.render.render(write_still=True)
print('HERMES_SHELL exported; rear hinge, 2 thick ribbed valves; review:',OUT)
