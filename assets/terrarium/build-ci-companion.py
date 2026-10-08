"""Preserve the original GitHub Octocat artwork as a shallow native silhouette.
Upstream: https://octodex.github.com/images/original.png (unmodified source PNG).
No invented anatomy, extra eyes/ears/arms, private Mona model, or fixed station.
"""
from pathlib import Path
import bpy, bmesh, math, re
ROOT=Path(__file__).resolve().parents[2]
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene;scene.name='GitHub Octocat CI Companion'
source=ROOT/'assets/terrarium/ci-companion-source.png'
image=bpy.data.images.load(str(source),check_existing=True);image.pack();w,h=image.size;pixels=list(image.pixels)
front=bpy.data.materials.new('Original Octocat artwork');front.use_nodes=True
nodes=front.node_tree.nodes;nodes.clear();tex=nodes.new('ShaderNodeTexImage');tex.image=image
# USD export only converts supported Principled nodes. A standalone Emission
# node produced an empty USD Material and a gray RealityKit fallback in the app.
shader=nodes.new('ShaderNodeBsdfPrincipled');output=nodes.new('ShaderNodeOutputMaterial')
shader.inputs['Base Color'].default_value=(0,0,0,1)
shader.inputs['Specular IOR Level'].default_value=0
shader.inputs['Roughness'].default_value=1
shader.inputs['Emission Strength'].default_value=1
front.node_tree.links.new(tex.outputs['Color'],shader.inputs['Emission Color'])
front.node_tree.links.new(shader.outputs['BSDF'],output.inputs['Surface'])
# The front retains every original pixel. Only profile/edge thickness is added,
# equivalent to the canonical SVG extrusion used for other native residents.
back=bpy.data.materials.new('Octocat silhouette edge');back.use_nodes=True
value=re.search(r'--ink-900:\s*#([0-9a-fA-F]{6})',(ROOT/'design/tokens.css').read_text()).group(1)
rgb=[int(value[i:i+2],16)/255 for i in (0,2,4)];rgb=[x/12.92 if x<=.04045 else ((x+.055)/1.055)**2.4 for x in rgb]
back.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(*rgb,1)
back.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.8
# Alpha cells form the exact artwork's visible envelope; they are not a rectangle.
N=192
occupied=set()
for j in range(N):
 for i in range(N):
  px=min(w-1,int((i+.5)/N*w));py=min(h-1,int((j+.5)/N*h))
  if pixels[(py*w+px)*4+3]>.1:occupied.add((i,j))
verts=[];faces=[];materials=[];lookup={}
def vertex(i,j,front_side):
 key=(i,j,front_side)
 if key not in lookup:
  lookup[key]=len(verts);verts.append(((i/N-.5)*1.1,(j/N-.5)*1.1,.035 if front_side else -.035))
 return lookup[key]
for i,j in occupied:
 face=[vertex(i,j,True),vertex(i+1,j,True),vertex(i+1,j+1,True),vertex(i,j+1,True)]
 faces.append(face);materials.append(0)
 faces.append([vertex(i,j+1,False),vertex(i+1,j+1,False),vertex(i+1,j,False),vertex(i,j,False)]);materials.append(1)
 for neighbor,edge in [((i-1,j),[(i,j+1),(i,j)]),((i+1,j),[(i+1,j),(i+1,j+1)]),((i,j-1),[(i,j),(i+1,j)]),((i,j+1),[(i+1,j+1),(i,j+1)])]:
  if neighbor not in occupied:
   a,b=edge;faces.append([vertex(*a,True),vertex(*b,True),vertex(*b,False),vertex(*a,False)]);materials.append(1)
mesh=bpy.data.meshes.new('Original Octocat alpha silhouette');mesh.from_pydata(verts,[],faces);mesh.update();mesh.materials.append(front);mesh.materials.append(back)
uv=mesh.uv_layers.new(name='Original artwork pixels')
for p,material in zip(mesh.polygons,materials):
 p.material_index=material
 for li in p.loop_indices:
  v=mesh.vertices[mesh.loops[li].vertex_index].co;uv.data[li].uv=(v.x/1.1+.5,v.y/1.1+.5)
# Dissolve coplanar cell interiors without changing the silhouette or linear UV mapping.
bm=bmesh.new();bm.from_mesh(mesh);bm.normal_update()
bmesh.ops.dissolve_limit(bm,angle_limit=.001,verts=list(bm.verts),edges=list(bm.edges),delimit={'MATERIAL'})
bm.to_mesh(mesh);bm.free();mesh.update()
uv=mesh.uv_layers.active
for loop in mesh.loops:
 v=mesh.vertices[loop.vertex_index].co;uv.data[loop.index].uv=(v.x/1.1+.5,v.y/1.1+.5)
mesh.calc_loop_triangles();print('COMPANION_TRIANGLES',len(mesh.loop_triangles))
root=bpy.data.objects.new('ci_companion',None);scene.collection.objects.link(root);root.rotation_euler.x=math.pi/2
obj=bpy.data.objects.new('octocat_original_profile',mesh);scene.collection.objects.link(obj);obj.parent=root
bpy.ops.object.select_all(action='SELECT')
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/terrarium/ci-companion.blend'))
bpy.ops.wm.usd_export(filepath=str(ROOT/'apple/AgentDeck/Resources/Aquarium/ci-companion.usdz'),selected_objects_only=True,export_animation=False,triangulate_meshes=True,generate_preview_surface=True,convert_orientation=True,export_global_forward_selection='NEGATIVE_Z',export_global_up_selection='Y')
bpy.ops.export_scene.gltf(filepath=str(ROOT/'android/app/src/main/assets/residents/ci-companion.glb'),export_format='GLB',use_selection=True,export_yup=True)
# Canvas/e-ink keep the unmodified upstream raster, not a newly drawn interpretation.
(ROOT/'apple/AgentDeck/Resources/Aquarium/ci-companion.png').write_bytes(source.read_bytes())
(ROOT/'android/app/src/main/res/drawable-nodpi/ci_companion.png').write_bytes(source.read_bytes())
print('Original Octocat profile exported:',len(mesh.polygons),'faces')
