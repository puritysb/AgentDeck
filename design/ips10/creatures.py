"""Blender: extrude existing canonical alpha silhouettes; never redraw agent marks.
Run blender -b --python design/ips10/creatures.py. Creates an isolated scene.
112px RGBA renders are baked to RGB565+A8 for IPS10; no runtime 3D engine.
"""
from pathlib import Path
import re
import bpy, bmesh
from mathutils import Vector
OUT=Path(__file__).resolve().parent
ROOT=OUT.parents[1]
source=(ROOT/'esp32/src/ui/terrarium/creature_glyphs_generated.h').read_text()
tokens=(ROOT/'design/tokens.css').read_text()
previous=bpy.context.window.scene
scene=bpy.data.scenes.new('IPS10 canonical creature reliefs');bpy.context.window.scene=scene
scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=True
scene.render.resolution_x=scene.render.resolution_y=112;scene.render.resolution_percentage=100
scene.render.film_transparent=True;scene.view_settings.view_transform='Standard'
scene.world=bpy.data.worlds.new('Creature studio');scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[1].default_value=.65
camera=bpy.data.objects.new('Camera',bpy.data.cameras.new('Camera'));scene.collection.objects.link(camera)
camera.location=(0,-1.3,5);camera.rotation_euler=(.254,0,0);camera.data.type='ORTHO';camera.data.ortho_scale=2.25;scene.camera=camera
for location,power,size in [((-3,4,6),380,5),((3,-1,4),120,4)]:
 light=bpy.data.objects.new('Softbox',bpy.data.lights.new('Softbox','AREA'));scene.collection.objects.link(light);light.location=location;light.rotation_euler=(-light.location).to_track_quat('-Z','Y').to_euler();light.data.energy=power;light.data.size=size
try:
 for name,mask,token in [('claude','OCTOPUS','brand-claude-code'),('codex','CODEX','brand-codex'),('openclaw','OPENCLAW_MARK','brand-openclaw')]:
  a=[int(x) for x in re.search(mask+r'_A8\[.*?\] = \{(.*?)\};',source,re.S).group(1).replace('\n','').split(',') if x.strip()]
  vertices=[];faces=[]
  for y in range(64):
   for x in range(64):
    if a[y*64+x]<128:continue
    n=len(vertices);vertices.extend([((x-32)/32,(32-y)/32,0),((x+1-32)/32,(32-y)/32,0),((x+1-32)/32,(31-y)/32,0),((x-32)/32,(31-y)/32,0)]);faces.append((n+3,n+2,n+1,n))
  mesh=bpy.data.meshes.new(name);mesh.from_pydata(vertices,[],faces)
  bm=bmesh.new();bm.from_mesh(mesh);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.001);bmesh.ops.dissolve_limit(bm,angle_limit=.01,verts=list(bm.verts),edges=list(bm.edges));bm.to_mesh(mesh);bm.free()
  obj=bpy.data.objects.new(name,mesh);scene.collection.objects.link(obj)
  solid=obj.modifiers.new('Depth','SOLIDIFY');solid.thickness=.18
  bevel=obj.modifiers.new('Soft edges','BEVEL');bevel.width=.025;bevel.segments=3
  obj.modifiers.new('Normals','WEIGHTED_NORMAL')
  material=bpy.data.materials.new(name);material.use_nodes=True
  value=re.search('--'+token+r':\s*#([0-9a-fA-F]{6})',tokens).group(1)
  rgb=[int(value[i:i+2],16)/255 for i in (0,2,4)];linear=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb]
  bsdf=material.node_tree.nodes['Principled BSDF'];bsdf.inputs['Base Color'].default_value=(*linear,1);bsdf.inputs['Roughness'].default_value=.3
  obj.data.materials.append(material)
  scene.render.image_settings.file_format='PNG';scene.render.image_settings.color_mode='RGBA';scene.render.filepath=str(OUT/(name+'-relief.png'))
  bpy.ops.render.render(write_still=True,scene=scene.name);bpy.data.objects.remove(obj,do_unlink=True)
finally:bpy.context.window.scene=previous
