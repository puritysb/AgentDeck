"""Portable solid fins and quiet freshwater inhabitants for build-dark-garden.py.
Executed inside the authored scene; no replacement agent characters.
"""
import bpy, math, re
from pathlib import Path
from mathutils import Vector
scene = bpy.context.scene
# Fin membranes need side walls, not merely double-sided rasterization. Rebase
# the caudal mesh to its peduncle: rotation around the body origin tears it away.
for obj in list(scene.objects):
    if obj.type != 'MESH' or 'fin' not in obj.name.lower():
        continue
    obj.data = obj.data.copy()
    if 'caudal' in obj.name.lower():
        hinge = Vector((max(v.co.x for v in obj.data.vertices), 0, 0))
        for v in obj.data.vertices:
            v.co -= hinge
        obj.location += hinge
    bpy.context.view_layer.objects.active = obj
    modifier = obj.modifiers.new('Membrane volume', 'SOLIDIFY')
    modifier.thickness = 0.045
    modifier.offset = 0
    bpy.ops.object.modifier_apply(modifier=modifier.name)

# Use existing design tokens rather than a second material palette.
css = (Path(__file__).resolve().parents[2] / 'design/tokens.css').read_text()
def material(name, token, roughness):
    value = re.search(r'--' + token + r':\s*#([0-9a-fA-F]{6})', css).group(1)
    srgb = [int(value[i:i+2],16)/255 for i in (0,2,4)]
    rgb = [v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in srgb]
    m=bpy.data.materials.new('Fauna '+name);m.diffuse_color=(*rgb,1);m.use_nodes=True
    shader=m.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value=(*rgb,1)
    shader.inputs['Roughness'].default_value=roughness
    return m
shell=material('shell','tide-300',.44)
stripe=material('shell bands','ink-700',.58)
flesh=material('foot','kelp-500',.65)
eye=material('eyes','ink-900',.3)
highlight=material('eye whites','tide-50',.32)

def root(name, location):
    o=bpy.data.objects.new(name,None);scene.collection.objects.link(o);o.location=location;return o

def ellipsoid(name, parent, location, scale, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=1)
    o=bpy.context.object;o.name=name;o.parent=parent;o.location=location;o.scale=scale
    o.data.materials.append(mat)
    for face in o.data.polygons: face.use_smooth=True
    return o

def strand(name,parent,points,radius,mat):
    curve=bpy.data.curves.new(name,'CURVE');curve.dimensions='3D';curve.bevel_depth=radius;curve.bevel_resolution=2
    spline=curve.splines.new('BEZIER');spline.bezier_points.add(len(points)-1)
    for p,co in zip(spline.bezier_points,points):p.co=co;p.handle_left_type='AUTO';p.handle_right_type='AUTO'
    o=bpy.data.objects.new(name,curve);scene.collection.objects.link(o);o.parent=parent;curve.materials.append(mat)
    bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
    bpy.ops.object.convert(target='MESH')
    return o

def forage(obj, center, radii, rock, offset=0):
    """Follow a slow closed path nose-first; unwrap yaw across the loop seam."""
    previous = None
    for frame in range(1,722,5):
        t=(frame-1)/720*math.tau+offset
        x=center[0]+radii[0]*math.sin(t);y=center[1]+radii[1]*math.cos(t)
        cx,cy,cz,rx,ry,rz=rock
        z=cz+rz*math.sqrt(max(0,1-((x-cx)/rx)**2-((y-cy)/ry)**2))+.015
        heading=math.atan2(-radii[1]*math.sin(t),radii[0]*math.cos(t))
        if previous is not None:
            heading=previous+(heading-previous+math.pi)%math.tau-math.pi
        previous=heading
        obj.location=(x,y,z);obj.rotation_euler[2]=heading
        obj.keyframe_insert(data_path='location',frame=frame)
        obj.keyframe_insert(data_path='rotation_euler',frame=frame)

left_rock=(-3.1,.4,.35,1.5,.8,.65)
# Rounded head and shorter eyestalks make the face legible at dashboard scale.
snail=root('Fauna snail',(-3.1,-.02,.93))
ellipsoid('Snail foot',snail,(0,0,.075),(.30,.16,.075),flesh)
ellipsoid('Snail head',snail,(.20,0,.14),(.135,.13,.115),flesh)
ellipsoid('Snail shell',snail,(-.09,0,.27),(.25,.205,.25),shell)
for side in (-1,1):
    spiral=[]
    for i in range(100):
        t=i/99;angle=t*math.tau*1.8;r=.012+.18*t
        spiral.append((-.09+math.cos(angle)*r,side*(.185+.02*(1-t)),.27+math.sin(angle)*r))
    strand('Snail shell spiral',snail,spiral,.012,stripe)
    feeler=root('Snail feeler',(0,0,0));feeler.parent=snail;feeler.location=(.21,side*.075,.19)
    strand('Snail eyestalk',feeler,[(0,0,0),(.025,side*.02,.055),(.035,side*.03,.09)],.017,flesh)
    ellipsoid('Snail eye white',feeler,(.035,side*.03,.10),(.043,.043,.047),highlight)
    ellipsoid('Snail pupil',feeler,(.066,side*.042,.10),(.018,.025,.028),eye)
    for frame in range(1,722,15):
        feeler.rotation_euler[1]=.08*math.sin((frame-1)/720*math.tau*2+side)
        feeler.keyframe_insert(data_path='rotation_euler',frame=frame)
forage(snail,(-3.1,-.02),(.24,.12),left_rock)

# Check evaluated animation, not merely the path formula: no backwards slide,
# no position/orientation discontinuity when the 24-second clip repeats.
for animal in [o for o in scene.objects if o.name.startswith('Fauna ')]:
    for frame in range(1,719,7):
        scene.frame_set(frame)
        start=animal.matrix_world.translation.copy()
        forward=animal.matrix_world.to_3x3() @ Vector((1,0,0))
        scene.frame_set(frame+1)
        displacement=animal.matrix_world.translation-start
        assert displacement.dot(forward)>0, (animal.name,frame,'backwards')
    scene.frame_set(1);start=animal.matrix_world.copy()
    scene.frame_set(721);end=animal.matrix_world.copy()
    assert max(abs(start[i][j]-end[i][j]) for i in range(4) for j in range(4))<.0001, animal.name
scene.frame_set(1)
print('Rounded snail; forward-only motion and loop seams verified; shrimp omitted')
