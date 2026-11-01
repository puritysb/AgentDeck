"""Bundled Dot pearl. Geometry comes from dot-appearance.ts; no host/session state is authored here."""
from pathlib import Path
import bpy, re, sys
sys.path.insert(0,str(Path(__file__).parent))
from brand_materials import linear_rgb
ROOT=Path(__file__).resolve().parents[2]
source=(ROOT/'shared/src/dot-appearance.ts').read_text()
def g(key):return float(re.search(r'\b'+key+r':\s*(-?[\d.]+)',source).group(1))
tokens=(ROOT/'design/tokens.css').read_text()
def mat(name,token,rough):
 h=re.search(r'--'+token+r':\s*#([a-fA-F0-9]{6})',tokens).group(1)
 rgb=linear_rgb(tuple(int(h[i:i+2],16) for i in (0,2,4)))
 m=bpy.data.materials.new(name);m.diffuse_color=(*rgb,1);m.use_nodes=True
 p=m.node_tree.nodes['Principled BSDF'];p.inputs['Base Color'].default_value=(*rgb,1);p.inputs['Roughness'].default_value=rough
 return m
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
root=bpy.data.objects.new('resident_dot',None);bpy.context.scene.collection.objects.link(root)
def orb(name,radius,loc,scale,material):
 bpy.ops.mesh.primitive_uv_sphere_add(segments=32,ring_count=20,radius=radius,location=loc)
 o=bpy.context.object;o.name=name;o.parent=root;o.scale=scale;o.data.materials.append(material)
 for p in o.data.polygons:p.use_smooth=True
body=mat('Pearl nacre','tide-100',.22);eye=mat('Dot eyes','ink-900',.8);shine=mat('Pearl glint','tide-50',.5)
orb('pearl',g('pearlRadius'),(0,0,0),(1,1,1),body)
for side in [-1,1]:orb('pearl-eye',g('pearlEyeRadius'),(side*g('pearlEyeX'),-g('pearlEyeZ'),g('pearlEyeY')),(1,g('pearlEyeDepth'),g('pearlEyeAspect')),eye)
orb('pearl-shine',g('pearlShineRadius'),(g('pearlShineX'),-g('pearlShineZ'),g('pearlShineY')),(g('pearlShineWidth'),g('pearlShineDepth'),g('pearlShineHeight')),shine)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/terrarium/dot-pearl.blend'))
bpy.ops.export_scene.gltf(filepath=str(ROOT/'android/app/src/main/assets/residents/dot.glb'),export_format='GLB',use_selection=True,export_animations=False,export_cameras=False,export_lights=False)
print('DOT_PEARL_EXPORTED canonical geometry',g('pearlRadius'))
