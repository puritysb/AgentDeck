"""AgentDeck's Nous girl mermaid adaptation. Run with Blender --background --python.
Authored mesh/hinge source; runtime states and swimming are owned by HermesSwim.
The original brand mark remains unchanged. Exports USDZ + portable GLB.
"""
from pathlib import Path
import bpy, math, re
from mathutils import Vector, Matrix
ROOT = Path(__file__).resolve().parents[2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version=0
scene = bpy.context.scene
tokens = (ROOT / 'design/tokens.css').read_text()
def material(name, token):
    value = re.search(r'--' + token + r':\s*#([0-9a-fA-F]{6})', tokens).group(1)
    rgb = [int(value[i:i+2],16)/255 for i in (0,2,4)]
    rgb = [c/12.92 if c <= .04045 else ((c+.055)/1.055)**2.4 for c in rgb]
    mat = bpy.data.materials.new(name); mat.use_nodes = True
    shader = mat.node_tree.nodes['Principled BSDF']
    shader.inputs['Base Color'].default_value = (*rgb, 1)
    shader.inputs['Roughness'].default_value = .82
    return mat
ink=material('Nous hair', 'ink-900'); skin=material('Nous face','tide-50')
tailmat=material('Mermaid kelp','kelp-500'); finmat=material('Fin edge','kelp-300')
def joint(name, parent=None, position=(0,0,0)):
    obj=bpy.data.objects.new(name,None);scene.collection.objects.link(obj)
    obj.parent=parent;obj.location=position;return obj
root=joint('resident_hermes')
def mesh(name, verts, faces, mat, parent):
    data=bpy.data.meshes.new(name);data.from_pydata(verts,[],faces);data.update()
    obj=bpy.data.objects.new(name,data);scene.collection.objects.link(obj)
    obj.parent=parent;data.materials.append(mat);return obj
def ellipsoid(name, parent, pos, scale, mat, segments=16, rings=8):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments,ring_count=rings)
    obj=bpy.context.object;obj.name=name;obj.parent=parent;obj.location=pos
    # Bake scale into geometry: articulation acts on clean parent joints.
    for v in obj.data.vertices:
        v.co.x*=scale[0];v.co.y*=scale[1];v.co.z*=scale[2]
    obj.data.materials.append(mat);return obj
# One continuous bob shell, with a cut fringe/cheek opening. The prototype's
# separate spheres produced a parted bun; this surface follows the reference bob.
head=joint('hermes_head',root,(0,.20,0))
ink_shader=ink.node_tree.nodes['Principled BSDF']
base=ink_shader.inputs['Base Color'].default_value
carbon=sum(base[:3])/3*.4
ink_shader.inputs['Base Color'].default_value=(carbon,carbon,carbon*1.08,1)
ink_shader.inputs['Specular IOR Level'].default_value=.18
face=ellipsoid('face',head,(0,-.015,.075),(.225,.218,.142),skin,24,14)
for polygon in face.data.polygons:polygon.use_smooth=True
verts=[];faces=[];segments=48;rows=9
for j in range(rows):
    v=j/(rows-1)
    if v <= .6:
        alpha=v/.6*math.pi/2
        radius=max(.018,math.sin(alpha))
    else:
        radius=1-.12*((v-.6)/.4)**2
    for i in range(segments):
        theta=2*math.pi*i/segments
        angle=abs((theta+math.pi)%(2*math.pi)-math.pi)
        blend=max(0,min(1,(angle-.68)/.28));blend=blend*blend*(3-2*blend)
        lower=.092*(1-blend)-.272*blend
        if angle<.68:lower+=.008*math.cos(theta*12)
        y=.10+.21*math.cos(v/.6*math.pi/2) if v<=.6 else .10+(lower-.10)*(v-.6)/.4
        x=math.sin(theta)*.337*radius
        z=math.cos(theta)*.255*radius-.025
        verts.append((x,y,z))
for j in range(rows-1):
    for i in range(segments):
        a=j*segments+i;b=j*segments+(i+1)%segments
        faces.append((a,b,b+segments,a+segments))
# Rim thickness preserves a solid hairline in oblique/rear views.
for i in range(segments):
    x,y,z=verts[(rows-1)*segments+i];verts.append((x*.95,y+.018,z*.94))
for i in range(segments):
    a=(rows-1)*segments+i;b=(rows-1)*segments+(i+1)%segments
    faces.append((a,b,rows*segments+(i+1)%segments,rows*segments+i))
mesh('continuous_bob',verts,faces,ink,head)
def tube(name,parent,points,radii,mat,sides=10):
    vs=[];fs=[]
    for k,p in enumerate(points):
        p=Vector(p)
        tangent=Vector(points[min(k+1,len(points)-1)])-Vector(points[max(k-1,0)])
        tangent.normalize();normal=tangent.cross(Vector((0,0,1))).normalized();binormal=tangent.cross(normal).normalized()
        for i in range(sides):
            a=2*math.pi*i/sides;vs.append(p+radii[k]*(math.cos(a)*normal+math.sin(a)*binormal))
    for k in range(len(points)-1):
        for i in range(sides):
            a=k*sides+i;b=k*sides+(i+1)%sides;fs.append((a,b,b+sides,a+sides))
    fs.extend([tuple(reversed(range(sides))),tuple(range((len(points)-1)*sides,len(points)*sides))])
    return mesh(name,vs,fs,mat,parent)
curl_points=[Vector(p) for p in [(-.278,-.13,.11),(-.300,-.215,.13),(-.341,-.223,.15),(-.359,-.184,.16),(-.351,-.147,.17)]]
curl_radii=[.042,.042,.027,.014,.001]
sampled=[];radii=[]
for k in range(len(curl_points)-1):
    a=curl_points[max(0,k-1)];b=curl_points[k];c=curl_points[k+1];d=curl_points[min(len(curl_points)-1,k+2)]
    for j in range(5):
        t=j/5
        sampled.append(.5*((2*b)+(-a+c)*t+(2*a-5*b+4*c-d)*t*t+(-a+3*b-3*c+d)*t*t*t))
        radii.append(curl_radii[k]*(1-t)+curl_radii[k+1]*t)
sampled.append(curl_points[-1]);radii.append(curl_radii[-1])
tube('signature_curl',head,sampled,radii,ink,12)
for side in [-1,1]:
    eye=joint('hermes_eye_left' if side<0 else 'hermes_eye_right',head,(side*.087,-.018,.207))
    pupil=ellipsoid('eye',eye,(0,0,0),(.041,.052,.012),ink,20,10)
    for polygon in pupil.data.polygons:polygon.use_smooth=True
    ellipsoid('glint',eye,(-.011,.024,.012),(.011,.015,.004),skin,12,6)
    ellipsoid('small_glint',eye,(.013,-.023,.012),(.005,.006,.003),skin,8,4)
    tube('upper_lid',eye,[(-.047,.018,.005),(-.025,.048,.005),(0,.057,.005),(.030,.043,.005),(.048,.018,.005)],
         [.003,.006,.007,.007,.003],ink,8)
# Small curved smile, not an open dot.
smile=joint('smile',head,(0,-.092,.216))
tube('smile_curve',smile,[(-.030,.008,0),(-.015,0,.003),(0,-.003,.004),(.015,0,.003),(.030,.008,0)],
     [.002,.003,.003,.003,.002],ink,8)
ellipsoid('neck',root,(0,-.035,.015),(.044,.055,.045),skin,16,8)
ellipsoid('chest',root,(0,-.092,.01),(.088,.080,.062),skin,16,10)
for side in [-1,1]:
    arm=joint('hermes_arm_left' if side<0 else 'hermes_arm_right',root,(side*.073,-.070,.01))
    tube('tapered_arm',arm,[(0,0,0),(side*.037,-.054,.005),(side*.086,-.102,.015),(side*.103,-.105,.017)],
         [.030,.028,.022,.010],skin,10)
tailmat=material('Deep teal tail','ink-500')
finmat=material('Broad kelp fin','kelp-500')
tail=joint('hermes_tail',root,(0,-.14,0))
verts=[];faces=[];sides=18
rings=[(0,.024,.012,.090),(0,-.055,-.004,.123),(0,-.145,-.035,.117),(0,-.225,-.087,.083),(0,-.285,-.16,.042),(0,-.30,-.205,.018)]
for x,y,z,r in rings:
    for i in range(sides):
        a=2*math.pi*i/sides;verts.append((x+math.cos(a)*r,y,z+math.sin(a)*r*.78))
for j in range(len(rings)-1):
    for i in range(sides):
        a=j*sides+i;b=j*sides+(i+1)%sides;faces.append((a,b,b+sides,a+sides))
faces.extend([tuple(reversed(range(sides))),tuple(range((len(rings)-1)*sides,len(rings)*sides))])
mesh('continuous_tail',verts,faces,tailmat,tail)
fin=joint('hermes_fin',tail,(0,-.30,-.205))
for side in [-1,1]:
    outline=[(0,0,0),(side*.085,-.04,-.01),(side*.19,-.18,-.025),(side*.052,-.125,.015)]
    vs=outline+[(side*.075,-.075,.027),(side*.075,-.075,-.027)]
    fs=[]
    for i in range(4):fs.extend([(4,i,(i+1)%4),(5,(i+1)%4,i)])
    mesh('broad_fin',vs,fs,finmat,fin)
# Model-local Y is up. The authoring root converts to Blender Z-up; exporters
# convert back, leaving all hinge-local axes identical on both native clients.
root.rotation_euler.x=math.pi/2
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/terrarium/hermes-mermaid.blend'))
bpy.ops.object.select_all(action='SELECT')
bpy.ops.wm.usd_export(filepath=str(ROOT/'apple/AgentDeck/Resources/Aquarium/hermes-mermaid.usdz'),selected_objects_only=True,
    export_animation=False,triangulate_meshes=True,generate_preview_surface=True,convert_orientation=True,
    export_global_forward_selection='NEGATIVE_Z',export_global_up_selection='Y')
out=ROOT/'assets/terrarium/hermes-mermaid.glb'
bpy.ops.export_scene.gltf(filepath=str(out),export_format='GLB',use_selection=True,export_animations=False,
    export_cameras=False,export_lights=False,export_yup=True)
# Reproducible turntable still of the actual mesh, not an AI mock-up.
root.rotation_euler.x=0
bpy.ops.object.camera_add(location=(.95,.42,4));camera=bpy.context.object
back=camera.location.normalized();right=Vector((0,1,0)).cross(back).normalized();up=back.cross(right)
camera.rotation_euler=Matrix((right,up,back)).transposed().to_euler()
camera.data.type='ORTHO';camera.data.ortho_scale=1.45;scene.camera=camera
for pos,power,size in [((1.5,2.5,3),350,3),((-2,1,1),200,2)]:
    bpy.ops.object.light_add(type='AREA',location=pos);light=bpy.context.object
    light.data.energy=power;light.data.shape='DISK';light.data.size=size
    light.rotation_euler=(-light.location).to_track_quat('-Z','Y').to_euler()
scene.render.engine='CYCLES';scene.cycles.samples=32
scene.world=bpy.data.worlds.new('Preview');scene.world.use_nodes=True
scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.035,.055,.07,1)
scene.render.resolution_x=800;scene.render.resolution_y=800;scene.render.resolution_percentage=100
preview=ROOT/'diagnostics/hermes-mermaid';preview.mkdir(parents=True,exist_ok=True)
scene.render.filepath=str(preview/'mesh.png');bpy.ops.render.render(write_still=True)
print('Hermes mermaid exported; mesh count:',sum(o.type=='MESH' for o in root.children_recursive))
