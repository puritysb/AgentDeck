"""Nous girl mermaid: portrait-based face, skinned body and expressive face rig.
Run: blender --background --python assets/terrarium/build-hermes-mermaid.py
Model-local Y-up. Named controls are shared by RealityKit and offline previews.
"""
from pathlib import Path
import bpy, math, re, json
from mathutils import Vector, Matrix
ROOT=Path(__file__).resolve().parents[2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version=0
scene=bpy.context.scene
tokens=(ROOT/'design/tokens.css').read_text()
def material(name,token,unlit=False):
    value=re.search(r'--'+token+r':\s*#([0-9a-fA-F]{6})',tokens).group(1)
    rgb=[int(value[i:i+2],16)/255 for i in (0,2,4)]
    rgb=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in rgb]
    m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes['Principled BSDF']
    p.inputs['Base Color'].default_value=(*rgb,1);p.inputs['Roughness'].default_value=.88
    p.inputs['Specular IOR Level'].default_value=.12
    if unlit:p.inputs['Emission Color'].default_value=(*rgb,1);p.inputs['Emission Strength'].default_value=.25
    return m
ink=material('Nous ink','ink-900');skin=material('Warm portrait','tide-50')
white=material('Headband and eyes','tide-50',True)
teal=material('Mermaid teal','kelp-500');finmat=material('Translucent-looking fin','kelp-300')
iris_material=material('Portrait iris','ink-700')
lip=ink
iris_shader=iris_material.node_tree.nodes['Principled BSDF']
iris_value=sum(iris_shader.inputs['Base Color'].default_value[:3])/3
iris_shader.inputs['Base Color'].default_value=(iris_value,iris_value,iris_value,1)
face_shader=skin.node_tree.nodes['Principled BSDF']
face_shader.inputs['Emission Color'].default_value=face_shader.inputs['Base Color'].default_value
face_shader.inputs['Emission Strength'].default_value=.18
p=ink.node_tree.nodes['Principled BSDF'];c=sum(p.inputs['Base Color'].default_value[:3])/3*.35
p.inputs['Base Color'].default_value=(c,c,c*1.06,1)
def joint(name,parent=None,pos=(0,0,0)):
    o=bpy.data.objects.new(name,None);scene.collection.objects.link(o);o.parent=parent;o.location=pos;return o
root=joint('resident_hermes')
def mesh(name,vertices,faces,mat,parent,smooth=False):
    d=bpy.data.meshes.new(name);d.from_pydata(vertices,[],faces);d.update()
    o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.parent=parent;d.materials.append(mat)
    for p in d.polygons:p.use_smooth=smooth
    return o
def sphere(name,parent,pos,scale,mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=64,ring_count=40)
    o=bpy.context.object;o.name=name;o.parent=parent;o.location=pos
    for v in o.data.vertices:v.co=Vector((v.co.x*scale[0],v.co.y*scale[1],v.co.z*scale[2]))
    o.data.materials.append(mat)
    for p in o.data.polygons:p.use_smooth=True
    return o
def tube(name,parent,points,radii,mat,sides=8):
    vs=[];fs=[]
    for j,point in enumerate(points):
        p=Vector(point);t=(Vector(points[min(j+1,len(points)-1)])-Vector(points[max(0,j-1)])).normalized()
        n=t.cross(Vector((0,0,1))).normalized()
        if n.length<.01:n=t.cross(Vector((1,0,0))).normalized()
        b=t.cross(n).normalized()
        for i in range(sides):
            a=2*math.pi*i/sides;vs.append(p+radii[j]*(math.cos(a)*n+math.sin(a)*b))
    for j in range(len(points)-1):
        for i in range(sides):
            a=j*sides+i;b=j*sides+(i+1)%sides;fs.append((a,b,b+sides,a+sides))
    fs += [tuple(reversed(range(sides))),tuple(range((len(points)-1)*sides,len(points)*sides))]
    return mesh(name,vs,fs,mat,parent,True)
# FK controls use +Y-oriented rest bones, even along the curved tail. This keeps
# pose rotations in the same model-local axes in Blender and RealityKit.
bone_specs=[('spine',None,(0,0,0)),('tail_base','spine',(0,-.13,0)),
 ('tail_mid','tail_base',(0,-.27,-.028)),('tail_tip','tail_mid',(0,-.40,-.09)),
 ('fin','tail_tip',(0,-.46,-.14)),('fin_left','fin',(-.07,-.49,-.15)),('fin_right','fin',(.07,-.49,-.15))]
for side,label in [(-1,'left'),(1,'right')]:
    bone_specs += [(f'arm_{label}','spine',(side*.09,-.005,.015)),(f'elbow_{label}',f'arm_{label}',(side*.17,-.095,.035)),(f'wrist_{label}',f'elbow_{label}',(side*.215,-.17,.045))]
bpy.ops.object.armature_add();rig=bpy.context.object;rig.name='hermes_skeleton';rig.parent=root
bpy.ops.object.mode_set(mode='EDIT');rig.data.edit_bones.remove(rig.data.edit_bones[0])
for name,parent,position in bone_specs:
    b=rig.data.edit_bones.new(name);b.head=position;b.tail=Vector(position)+Vector((0,.06,0));b.roll=0
    if parent:b.parent=rig.data.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT');rig.show_in_front=True
for b in rig.pose.bones:b.rotation_mode='QUATERNION'
def skin_mesh(obj,weights):
    for name,_,_ in bone_specs:obj.vertex_groups.new(name=name)
    for index,w in enumerate(weights):
        total=sum(w.values())
        for name,value in w.items():
            if value>0:obj.vertex_groups[name].add([index],value/total,'REPLACE')
    m=obj.modifiers.new('Continuous deformation','ARMATURE');m.object=rig;m.use_deform_preserve_volume=False
    obj.parent=rig
    return obj
def chain_weights(t,stops):
    if t<=stops[0][0]:return {stops[0][1]:1}
    for (a,an),(b,bn) in zip(stops,stops[1:]):
        if t<=b:
            u=(t-a)/(b-a);u=u*u*(3-2*u);return {an:1-u,bn:u}
    return {stops[-1][1]:1}
# Continuous torso-tail skin: many longitudinal rings, no separated rigid beads.
profile=[(.035,0,.045,.043),(-.02,.004,.09,.059),(-.095,0,.131,.075),(-.16,-.008,.147,.09),
 (-.24,-.022,.137,.084),(-.31,-.045,.106,.067),(-.38,-.077,.061,.041),(-.44,-.12,.028,.022),(-.47,-.15,.008,.008)]
vs=[];fs=[];weights=[];sides=32;steps=4
for k in range((len(profile)-1)*steps+1):
    seg=min(k//steps,len(profile)-2);u=(k-seg*steps)/steps
    a=profile[max(0,seg-1)];b=profile[seg];c=profile[seg+1];d=profile[min(len(profile)-1,seg+2)]
    y,z,rx,rz=[.5*(2*b[i]+(-a[i]+c[i])*u+(2*a[i]-5*b[i]+4*c[i]-d[i])*u*u+(-a[i]+3*b[i]-3*c[i]+d[i])*u*u*u) for i in range(4)]
    for i in range(sides):
        a=2*math.pi*i/sides;vs.append((math.cos(a)*rx,y,z+math.sin(a)*rz))
        weights.append(chain_weights(-y,[(0,'spine'),(.17,'tail_base'),(.30,'tail_mid'),(.43,'tail_tip'),(.47,'fin')]))
rows=len(vs)//sides
for j in range(rows-1):
    for i in range(sides):
        a=j*sides+i;b=j*sides+(i+1)%sides;fs.append((a,b,b+sides,a+sides))
fs += [tuple(reversed(range(sides))),tuple(range((rows-1)*sides,rows*sides))]
body=skin_mesh(mesh('hermes_body_skin',vs,fs,teal,root,True),weights);body.data.materials.append(skin)
for p in body.data.polygons:
    if p.center.y>-.055:p.material_index=1
# Two broad, curved fin lobes, each independently spreading and curling at its edge.
for side,label in [(-1,'left'),(1,'right')]:
    vs=[];fs=[];ww=[];rows=12;cols=8
    for j in range(rows):
        t=j/(rows-1);width=math.sin(math.pi*t)**.75*.071+.002
        for k in range(cols):
            u=2*k/(cols-1)-1
            vs.append((side*(.007+.24*t)+u*width*.53,-.46-.15*t+side*u*width*.85,-.145-.035*t+.022*math.sin(math.pi*t)*(1-u*u)))
            ww.append(chain_weights(t,[(0,'fin'),(.55,'fin_'+label)]))
    for j in range(rows-1):
        for k in range(cols-1):
            a=j*cols+k;fs.append((a,a+1,a+1+cols,a+cols))
    fin=skin_mesh(mesh('fin_surface_'+label,vs,fs,finmat,root,True),ww)
    solid=fin.modifiers.new('Fin thickness','SOLIDIFY');solid.thickness=.006
    # Apply thickness before skin; the export must keep skin weights, not bake a pose.
    bpy.context.view_layer.objects.active=fin;bpy.ops.object.modifier_move_up(modifier=solid.name);bpy.ops.object.modifier_apply(modifier=solid.name)
# Continuous arms with an elbow and mitten-like palm; weights follow limb length.
for side,label in [(-1,'left'),(1,'right')]:
    # Explicit ASCII geometry below (keeps authoring source portable).
    points=[(side*.087,-.005,.015),(side*.132,-.05,.025),(side*.17,-.095,.035),(side*.20,-.14,.043),(side*.218,-.18,.05)]
    arm=tube('arm_skin_'+label,root,points,[.036,.033,.028,.027,.018],skin,16)
    ww=[chain_weights(j//16,[(0,'arm_'+label),(2,'elbow_'+label),(4,'wrist_'+label)]) for j in range(len(arm.data.vertices))]
    skin_mesh(arm,ww)
    hand=sphere('hand_skin_'+label,root,(side*.218,-.176,.05),(.028,.035,.025),skin)
    skin_mesh(hand,[{'wrist_'+label:1} for _ in hand.data.vertices])
# Head follows the same spine rotation as the skinned torso.
spine=joint('hermes_spine',root)
head=joint('hermes_head',spine,(0,.19,.015))
def nose_relief(x,y):return .025*math.exp(-((x/.018)**2+((y+.111)/.031)**2))
face=sphere('face',head,(0,-.028,.094),(.249,.219,.115),skin)
# Taper the lower jaw; no protruding toy eyes or sculpted human nose.
for v in face.data.vertices:
    if v.co.y<-.025:v.co.x*=1-.28*min(1,(-v.co.y-.025)/.19)
    if v.co.z>0:v.co.z+=nose_relief(v.co.x,v.co.y-.028)
def face_z(x,y):
    xr=.249*(1-.28*max(0,min(1,(-y-.028-.025)/.19)))
    return .094+.115*math.sqrt(max(.015,1-(x/xr)**2-((y+.028)/.219)**2))+nose_relief(x,y)
def patch(name,parent,coords,mat,center=(0,0),depth=.003):
    cx,cy=center;vs=[(x,y,face_z(x+cx,y+cy)+depth) for x,y in coords]
    # Control origin is on the face plane; coordinates remain small and eye motion bounded.
    origin=Vector((cx,cy,face_z(cx,cy)+depth));vs=[Vector((x+cx,y+cy,z))-origin for x,y,z in vs]
    o=mesh(name,vs,[tuple(range(len(vs)))],mat,parent);o.location=origin;return o
# Portrait eyes are flattened almond artwork lying on the face surface.
for side,label in [(-1,'left'),(1,'right')]:
    cx=side*.100;cy=-.070
    eye=joint('hermes_eye_'+label,head,(cx,cy,face_z(cx,cy)+.004))
    def eye_patch(name,coords,mat,depth):
        vs=[(x,y,face_z(x+cx,y+cy)+depth-eye.location.z) for x,y in coords]
        return mesh(name,vs,[tuple(range(len(vs)))],mat,eye)
    outline=[]
    for i in range(33):
        x=-.063+.126*i/32;t=i/32;outline.append((x,math.sin(math.pi*t)**.72*.040+side*x*.10))
    for i in range(32,-1,-1):
        x=-.063+.126*i/32;t=i/32;outline.append((x,-math.sin(math.pi*t)**.85*.026+side*x*.10))
    eye_patch('sclera_'+label,outline,white,.005)
    pupil=joint('hermes_pupil_'+label,eye)
    coords=[]
    for i in range(48):
        a=2*math.pi*i/48;x=math.cos(a)*.035;y=math.sin(a)*.040
        limit=math.sin(math.pi*(x+.063)/.126)**.8
        y=max(-limit*.026+side*x*.10,min(limit*.040+side*x*.10,y));coords.append((x,y))
    iris=eye_patch('iris_'+label,coords,iris_material,.006);iris.parent=pupil
    inner=[(math.cos(2*math.pi*i/32)*.020, .002+math.sin(2*math.pi*i/32)*.026) for i in range(32)]
    pupil_mesh=eye_patch('pupil_'+label,inner,ink,.0066);pupil_mesh.parent=pupil
    highlight=[(-.009+math.cos(2*math.pi*i/24)*.005,.012+math.sin(2*math.pi*i/24)*.006) for i in range(24)]
    glint=eye_patch('highlight_'+label,highlight,white,.007);glint.parent=pupil
    top=[(x,y,face_z(cx+x,cy+y)+.008-eye.location.z) for x,y in outline[:33]]
    tube('eyeliner_'+label,eye,top,[.0015+.0040*math.sin(math.pi*i/32) for i in range(33)],ink)
    eye_patch('outer_lash_'+label,[(side*.049,.022),(side*.077,.034),(side*.061,.002)],ink,.008)
    # Eyelid crease is a separate control, so a full blink is an actual closed lid.
    lid=joint('hermes_lid_'+label,head,eye.location)
    points=[(x,-.004+side*x*.10,face_z(cx+x,cy-.004+side*x*.10)+.006-eye.location.z) for x in [-.05,-.03,0,.03,.05]]
    tube('closed_lid_'+label,lid,points,[.0015,.003,.0035,.003,.0015],ink)
    for child in lid.children:child.hide_render=True
    brow=joint('hermes_brow_'+label,head,(cx,-.009,face_z(cx,-.009)+.007))
    points=[(-.048,0,0),(-.027,.008,.005),(.003,.010,.009),(.03,.006,.005),(.048,0,0)]
    tube('eyebrow_'+label,brow,points,[.0005,.0015,.002,.0015,.0005],ink)
# Closed, reserved original-style mouth. Independent corner / upper / lower controls.
mouth=joint('hermes_mouth',head,(0,-.153,face_z(0,-.153)+.008))
for name,points,rad in [('upper',[(-.019,0,0),(-.009,.002,.001),(0,.001,.002),(.009,.002,.001),(.019,0,0)],.0018),
                        ('lower',[(-.013,-.003,0),(0,-.005,.002),(.013,-.003,0)],.0009)]:
    control=joint('hermes_lip_'+name,mouth);tube('lip_'+name,control,points,[rad]*len(points),lip)
opening=sphere('mouth_open',mouth,(0,-.003,-.001),(.018,.01,.001),ink);opening.hide_render=True
nosepoints=[(.002,-.099,face_z(.002,-.099)+.004),(-.006,-.111,face_z(-.006,-.111)+.004),(.003,-.115,face_z(.003,-.115)+.004)]
# Nose contour is modeled into the face, not drawn as a dark zigzag.
# Continuous rounded bob shell. Front is cut high; shaped ribbon bangs cover it.
vs=[];fs=[];n=64;rows=17
for j in range(rows):
    v=j/(rows-1)
    for i in range(n):
        theta=2*math.pi*i/n;angle=abs((theta+math.pi)%(2*math.pi)-math.pi)
        mix=max(0,min(1,(angle-.58)/.34));mix=mix*mix*(3-2*mix)
        lower=.15*(1-mix)-.235*mix
        if v<.60:
            a=v/.60*math.pi/2;r=max(.008,math.sin(a));y=.045+.29*math.cos(a)
        else:r=1-.12*((v-.60)/.4)**2;y=.045+(lower-.045)*(v-.6)/.4
        vs.append((math.sin(theta)*.322*r,y,math.cos(theta)*.238*r-.012))
for j in range(rows-1):
    for i in range(n):
        a=j*n+i;b=j*n+(i+1)%n;fs.append((a,b,b+n,a+n))
mesh('portrait_bob',vs,fs,ink,head,True)
# One curved fringe sheet conforms to the scalp; its scalloped lower edge
# preserves the portrait fringe without floating rectangular bang blocks.
vs=[];fs=[];nrow=25;ncol=65
for j in range(nrow):
    t=j/(nrow-1)
    for i in range(ncol):
        u=2*i/(ncol-1)-1;theta=u*.91
        edge=[(-1,.055),(-.75,.01),(-.68,.025),(-.32,.003),(-.25,.026),(.05,.016),(.13,.038),(.47,.009),(.54,.031),(.84,.022),(1,.085)]
        for (a,ay),(b,by) in zip(edge,edge[1:]):
            if a<=u<=b:bottom=ay+(by-ay)*(u-a)/(b-a);break
        phi=.08+t*(math.acos((bottom-.045)/.29)-.08)
        vs.append((.322*math.sin(phi)*math.sin(theta),.045+.29*math.cos(phi),-.012+.239*math.sin(phi)*math.cos(theta)))
for j in range(nrow-1):
    for i in range(ncol-1):
        a=j*ncol+i;fs.append((a,a+1,a+ncol+1,a+ncol))
o=mesh('portrait_fringe',vs,fs,ink,head,True)
solid=o.modifiers.new('Solid fringe','SOLIDIFY');solid.thickness=.004;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=solid.name)
# Curved cheek-framing locks with inward-tapered tips. Their roots sit inside
# the bob shell, so secondary motion cannot expose a detached hair slab.
for side,label in [(-1,'left'),(1,'right')]:
    lock=joint('hermes_hair_'+label,head,(side*.255,.07,.08))
    vs=[];fs=[];rows=18;cols=9
    for j in range(rows):
        t=j/(rows-1);cx=side*(.014-.10*t*t+.04*t**5);cy=-.30*t+.012*t**6
        width=.050*math.sin(math.pi*.5*t)**.7*(1-t**6)+.001
        for i in range(cols):
            u=2*i/(cols-1)-1
            vs.append((cx+u*width,cy+.022*u*u*t,.028+.09*math.sin(math.pi*.7*t)-.018*u*u))
    for j in range(rows-1):
        for i in range(cols-1):
            a=j*cols+i;fs.append((a,a+1,a+cols+1,a+cols))
    o=mesh('side_lock_'+label,vs,fs,ink,lock,True)
    solid=o.modifiers.new('Lock thickness','SOLIDIFY');solid.thickness=.016;bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=solid.name)
# Original outward curl, fine at the tip, joined to the left bob.
points=[];radii=[]
for i in range(25):
    t=i/24;points.append((-.268-.12*math.sin(t*math.pi*.68),-.13-.11*math.sin(t*math.pi),.085+.035*t));radii.append(.028*(1-t)**.75+.0008)
curl=tube('portrait_curl',head,points,radii,ink,12)
for i,v in enumerate(curl.data.vertices):
    center=points[i//12][2];v.co.z=center+(v.co.z-center)*.4
# White band with the recognizable hooked end, laid just above the crown.
vs=[];fs=[]
for j in range(40):
    t=j/39;x=-.09+.302*t;y=.319-.226*t*t
    for side in [-1,1]:
        xx=x+side*(.017+.012*t)
        z=.252*math.sqrt(max(.025,1-(xx/.324)**2-((y-.045)/.291)**2))+.01
        vs.append((xx,y,z+.006))
for j in range(39):fs.append((j*2,j*2+1,j*2+3,j*2+2))
mesh('Nous_headband',vs,fs,white,head)
hook_xy=[(.211,.106),(.221,.085),(.211,.070),(.225,.065)]
hook_points=[(x,y,.252*math.sqrt(max(.025,1-(x/.324)**2-((y-.045)/.291)**2))+.021) for x,y in hook_xy]
tube('Nous_band_hook',head,hook_points,[.009,.007,.005,.001],white,12)
# Rest silhouette is a swimming curve, not a vertical tapered capsule.
def swim_rest(v):
    x,y,z=v
    if y>=0:return Vector((x,y,z))
    t=max(0,min(1,(-y-.08)/.43));t=t*t*(3-2*t)
    return Vector((x*.91,y*.82,z-.22*t))
for obj in rig.children:
    if obj.type=='MESH':
        forward=.06 if obj.name.startswith(('arm_skin_', 'hand_skin_')) else 0
        for v in obj.data.vertices:v.co=swim_rest(v.co+obj.location)-obj.location+Vector((0,0,forward))
bpy.context.view_layer.objects.active=rig;bpy.ops.object.mode_set(mode='EDIT')
for bone in rig.data.edit_bones:
    position=swim_rest(bone.head)
    if bone.name.startswith(('arm_', 'elbow_', 'wrist_')):position.z+=.06
    bone.head=position;bone.tail=position+Vector((0,.06,0))
bpy.ops.object.mode_set(mode='OBJECT')
# Serialize rest/deformation contract for review and use by the preview sampler.
manifest={'schema':2,'boneNames':[x[0] for x in bone_specs],'controls':[o.name for o in root.children_recursive if o.type=='EMPTY'],'skinnedMeshes':[o.name for o in rig.children if o.type=='MESH']}
(ROOT/'assets/terrarium/hermes-rig.json').write_text(json.dumps(manifest,indent=2)+'\n')
root.rotation_euler.x=math.pi/2
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/terrarium/hermes-mermaid.blend'))
bpy.ops.object.select_all(action='SELECT')
# Export closed lids and the mouth opening as geometry. Hidden render meshes
# are omitted by the exporter; RealityKit must receive them and hide controls.
hidden=[o for o in bpy.data.objects if o.type=='MESH' and o.hide_render]
for o in hidden:o.hide_render=False
bpy.ops.wm.usd_export(filepath=str(ROOT/'apple/AgentDeck/Resources/Aquarium/hermes-mermaid.usdz'),selected_objects_only=True,export_animation=False,export_armatures=True,export_shapekeys=False,triangulate_meshes=True,generate_preview_surface=True,convert_orientation=True,export_global_forward_selection='NEGATIVE_Z',export_global_up_selection='Y')
bpy.ops.export_scene.gltf(filepath=str(ROOT/'assets/terrarium/hermes-mermaid.glb'),export_format='GLB',use_selection=True,export_animations=False,export_cameras=False,export_lights=False,export_yup=True)
for o in hidden:o.hide_render=True
root.rotation_euler.x=0
bpy.ops.object.camera_add(location=(.9,.30,4));camera=bpy.context.object
back=(camera.location-Vector((0,-.04,0))).normalized();right=Vector((0,1,0)).cross(back).normalized();up=back.cross(right)
camera.rotation_euler=Matrix((right,up,back)).transposed().to_euler();camera.data.type='ORTHO';camera.data.ortho_scale=1.40;scene.camera=camera
for pos,power,size in [((1.5,2.5,3),220,3),((-2,1,1),170,2)]:
    bpy.ops.object.light_add(type='AREA',location=pos);o=bpy.context.object;o.data.energy=power;o.data.size=size;o.rotation_euler=(-o.location).to_track_quat('-Z','Y').to_euler()
scene.render.engine='CYCLES';scene.cycles.samples=32
scene.world=bpy.data.worlds.new('Preview');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.035,.055,.07,1)
scene.view_settings.view_transform='AgX';scene.render.resolution_x=900;scene.render.resolution_y=900;scene.render.resolution_percentage=100
out=ROOT/'diagnostics/hermes-mermaid';out.mkdir(parents=True,exist_ok=True);scene.render.filepath=str(out/'rigged-model.png');bpy.ops.render.render(write_still=True)
print('Exported skinned Hermes:',manifest)
