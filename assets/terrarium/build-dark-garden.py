"""Author a native-friendly dark garden from the retained swimming study.
Run through Blender MCP or blender --background --python. No external assets.
"""
from pathlib import Path
import bpy, math, random
ROOT = Path(__file__).resolve().parents[2]
bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'assets/terrarium/living-aquarium.blend'))
s = bpy.data.scenes['AgentDeck Living Aquarium']
bpy.context.window_manager.windows[0].scene = s
s.frame_set(1)
rng = random.Random(42)
# Preserve the authored fish hierarchy and its seamless 24-second motion.
for o in list(s.objects):
    ancestor = o
    while ancestor.parent:
        ancestor = ancestor.parent
    fish = ancestor.name.startswith('Fish yaw')
    if o.type not in {'CAMERA', 'LIGHT'}:
        o.hide_render = not fish
        o.hide_set(not fish)
    if fish and o == ancestor:
        o.scale *= 1.30

def mat(name, rgb, roughness=0.8):
    m = bpy.data.materials.new('Garden ' + name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    p = m.node_tree.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*rgb, 1)
    p.inputs['Roughness'].default_value = roughness
    return m
water = mat('deep water', (.008, .035, .043))
sand = mat('warm sand', (.19, .17, .105))
stone = mat('slate', (.045, .082, .075))
wood = mat('weathered wood', (.10, .055, .027))
leaves = [mat('leaf '+str(i), c) for i,c in enumerate([(.025,.16,.095),(.05,.24,.13),(.09,.29,.16),(.017,.095,.073)])]

def mesh(name, verts, faces, material):
    me=bpy.data.meshes.new(name); me.from_pydata(verts, [], faces); me.update()
    o=bpy.data.objects.new(name,me); s.collection.objects.link(o); me.materials.append(material)
    for p in me.polygons: p.use_smooth=True
    return o
# Curved dark bowl, without a horizon seam in the native camera.
verts=[]; faces=[]
for j in range(65):
    y=-8+j*.5
    z=max(0,y-2)**2*.16-.10
    for i in range(41): verts.append((-12+i*.6,y,z))
for j in range(64):
    for i in range(40):
        a=j*41+i; faces.append((a,a+1,a+42,a+41))
mesh('Garden water bowl',verts,faces,water)
# A meandering pale substrate ribbon narrows into the rear planting.
verts=[];faces=[]
for j in range(41):
    y=-7+j*.275; t=j/40
    center=.3+1.15*math.sin(t*3.5)
    width=(4.0*(1-t)+.35)*(1+.055*math.sin(t*31))
    z=max(0,y-2)**2*.16-.075
    for i in range(9):
        u=i/8; verts.append((center+(u-.5)*width,y,z+.05*math.sin(math.pi*u)))
for j in range(40):
    for i in range(8):
        a=j*9+i;faces.append((a,a+1,a+10,a+9))
mesh('Garden winding sand',verts,faces,sand)
# Unequal stone groups create a foreground anchor and quieter distant edge.
for idx,(x,y,z,scale) in enumerate([(-3.1,.4,.35,(1.5,.8,.65)),(-4.2,1.5,.4,(.9,.8,.9)),(-2.3,1.1,.2,(.65,.5,.45)),(3.3,2.5,.2,(.95,.65,.5)),(4.2,3,.3,(.6,.5,.7))]):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3,radius=1,location=(x,y,z))
    o=bpy.context.object;o.name='Garden stone '+str(idx);o.scale=scale
    for v in o.data.vertices: v.co *= 1+rng.uniform(-.09,.09)
    o.data.materials.append(stone)
    for p in o.data.polygons:p.use_smooth=True
# Broad, curved leaves with raised central veins. Each is its own animated mesh;
# transforms survive USDZ and GLB, unlike the study's Apple-stripped shape keys.
for cluster,(cx,cy,count,height) in enumerate([(-3.5,1.7,19,2.4),(-4.5,2.7,13,2.9),(-2.2,2.5,10,1.35),(3.8,3.1,14,1.7),(4.8,3.8,9,2.2),(-3.5,-.5,10,.65),(3.7,.5,7,.6)]):
    for n in range(count):
        length=height*rng.uniform(.6,1.1); width=length*rng.uniform(.12,.21)
        angle=rng.uniform(-math.pi,math.pi); lean=rng.uniform(.35,.95)
        vv=[];ff=[]
        for j in range(13):
            t=j/12; bulge=math.sin(math.pi*t)**.75
            for k in range(3):
                side=k-1
                vv.append((side*width*bulge, lean*t*t+(.06*bulge if side==0 else 0),length*t))
        for j in range(12):
            for k in range(2):
                a=j*3+k;ff.append((a,a+1,a+4,a+3))
        o=mesh('Garden broad leaf',vv,ff,leaves[(cluster+n)%len(leaves)])
        o.location=(cx+rng.uniform(-.6,.6),cy+rng.uniform(-.45,.45),.02)
        o.rotation_euler[2]=angle
        phase=rng.uniform(0,math.tau)
        for frame in range(1,722,15):
            o.rotation_euler[0]=.035*math.sin((frame-1)/720*math.tau*2+phase)
            o.rotation_euler[1]=.025*math.sin((frame-1)/720*math.tau*2+phase+.7)
            o.keyframe_insert(data_path='rotation_euler',frame=frame)
# Branching wood on the left, kept clear of the central session stage.
for n,points in enumerate([[(-3.6,1,.3),(-2.8,1.1,.8),(-2.1,1.2,1.45),(-1.8,1.4,2.2)],[(-2.8,1.1,.8),(-3,1.4,1.5),(-3.5,1.6,2.2)],[(-2.1,1.2,1.45),(-1.4,1.7,1.7),(-.9,1.9,1.85)]]):
    cu=bpy.data.curves.new('Garden branch','CURVE');cu.dimensions='3D';cu.bevel_depth=.09;cu.bevel_resolution=3
    sp=cu.splines.new('BEZIER');sp.bezier_points.add(len(points)-1)
    for i,(p,co) in enumerate(zip(sp.bezier_points,points)):
        p.co=co;p.handle_left_type='AUTO';p.handle_right_type='AUTO';p.radius=1-i/len(points)*.85
    o=bpy.data.objects.new('Garden branch',cu);s.collection.objects.link(o);cu.materials.append(wood)
    bpy.context.view_layer.objects.active=o;o.select_set(True)
    # Only this curve is selected before converting for portable native import.
    for other in s.objects:
        if other!=o:other.select_set(False)
    bpy.ops.object.convert(target='MESH')
# Sparse foreground pebbles, not a uniform grid.
for n in range(48):
    x=rng.choice([-1,1])*rng.uniform(2.0,5.8); y=rng.uniform(-1.5,3.5)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1,radius=rng.uniform(.035,.10),location=(x,y,.015))
    o=bpy.context.object;o.name='Garden pebble';o.scale.z=.45;o.data.materials.append(stone)
s.world.color=(.025,.025,.025)
for o in s.objects:
    if o.type=='LIGHT':
        o.data.energy=650 if o.location.x<0 else 250
s.frame_set(1)
s.render.resolution_x=1280;s.render.resolution_y=800;s.render.resolution_percentage=100
s.render.engine='CYCLES';s.cycles.samples=24
import runpy
runpy.run_path(str(ROOT/'assets/terrarium/enhance-garden-fauna.py'))
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/terrarium/dark-garden.blend'))
print('Saved dark garden with portable plant transform animation')
