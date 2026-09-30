"""Build an articulated replacement candidate; no app resources are overwritten."""
from pathlib import Path
import sys,runpy,json
sys.argv.append('--no-preview')
ns=runpy.run_path(str(Path(__file__).with_name('build-hermes-portrait.py')))
globals().update({k:v for k,v in ns.items() if not k.startswith('__')})
from mathutils import Quaternion
OUT=ROOT/'diagnostics/hermes-mermaid/character-v6';OUT.mkdir(parents=True,exist_ok=True)
root.name='resident_hermes'
for o in list(scene.objects):
 if o.type in ['CAMERA','LIGHT']:bpy.data.objects.remove(o,do_unlink=True)
teal=material('Mermaid garment and tail','kelp-500',.48);finmat=material('Fin satin','kelp-300',.5)
body=body_source;body.name='hermes_body_skin';body.hide_render=False;body.hide_set(False);body.parent=root
bm=bmesh.new();bm.from_mesh(body.data)
bmesh.ops.delete(bm,geom=[v for v in bm.verts if v.co.z>1.32 or (v.co.z<.99 and abs(v.co.x)<.22)],context='VERTS')
bm.to_mesh(body.data);bm.free()
source_coords=[v.co.copy() for v in body.data.vertices]
def body_map(v):return Vector((v.x*.72,(v.z-1.25)*.72+.10,-v.y*.72+.005))
for v in body.data.vertices:v.co=body_map(v.co)
body.data.materials.clear();body.data.materials.append(skin);body.data.materials.append(teal)
# Continue the actual waist boundary into the tail, maintaining one connected skin.
bm=bmesh.new();bm.from_mesh(body.data);bm.verts.ensure_lookup_table()
boundary=[e for e in bm.edges if e.is_boundary and all(v.co.y<-.06 and abs(v.co.x)<.15 for v in e.verts)]
adj={}
for e in boundary:
 a,b=[v.index for v in e.verts];adj.setdefault(a,[]).append(b);adj.setdefault(b,[]).append(a)
assert adj and all(len(v)==2 for v in adj.values()),'Waist boundary must be one manifold loop'
ring=[next(iter(adj))];previous=None;current=ring[0]
while True:
 nxt=next(x for x in adj[current] if x!=previous)
 if nxt==ring[0]:break
 ring.append(nxt);previous,current=current,nxt
assert len(ring)==len(adj)
vs=[tuple(v.co) for v in body.data.vertices];fs=[tuple(p.vertices) for p in body.data.polygons];matindices=[0]*len(fs)
center=sum((Vector(vs[i]) for i in ring),Vector())/len(ring)
# Arc length parametrization eliminates reversals in the irregular source cut.
# Each generated ring has exactly one winding and strictly positive edge spans.
raw=[Vector(vs[i]) for i in ring]
raw_angles=[math.atan2(p.z-center.z,p.x-center.x) for p in raw]
winding=sum(math.atan2(math.sin(b-a),math.cos(b-a)) for a,b in zip(raw_angles,raw_angles[1:]+raw_angles[:1]))
direction=1 if winding>0 else -1
lengths=[(b-a).length for a,b in zip(raw,raw[1:]+raw[:1])]
angles=[];walk=0
for distance in lengths:
 angles.append(raw_angles[0]+direction*math.tau*walk/sum(lengths));walk+=distance
assert all(0<direction*(b-a)<math.pi for a,b in zip(angles,angles[1:])), 'Tail ring may not reverse or fold'
for i,a in zip(ring,angles):vs[i]=(math.cos(a)*.080,-.089,.002+math.sin(a)*.056)
prior=ring
stations=[(-.089,.002,.080,.056),(-.14,-.006,.091,.064),(-.205,-.032,.095,.069),(-.27,-.072,.084,.061),(-.335,-.124,.065,.048),(-.395,-.174,.044,.034),(-.44,-.220,.025,.022),(-.47,-.255,.012,.013)]
for j in range(1,49):
 t=j/48*(len(stations)-1);k=min(len(stations)-2,int(t));u=t-k
 a=stations[k];b=stations[k+1];p=stations[max(0,k-1)];n=stations[min(len(stations)-1,k+2)]
 values=[]
 for dim in range(4):
  ma=(b[dim]-p[dim])/(2 if k else 1);mb=(n[dim]-a[dim])/(2 if k+2<len(stations) else 1)
  values.append((2*u**3-3*u*u+1)*a[dim]+(u**3-2*u*u+u)*ma+(-2*u**3+3*u*u)*b[dim]+(u**3-u*u)*mb)
 y,z,rx,rz=values;row=[]
 for angle in angles:row.append(len(vs));vs.append((math.cos(angle)*rx,y,z+math.sin(angle)*rz))
 for i in range(len(row)):fs.append((prior[i],prior[(i+1)%len(row)],row[(i+1)%len(row)],row[i]));matindices.append(1)
 prior=row
fs.append(tuple(reversed(prior)));matindices.append(1)
body.data=bpy.data.meshes.new('Connected anatomy and tail');body.data.from_pydata(vs,[],fs);body.data.materials.append(skin);body.data.materials.append(teal)
for p,mi in zip(body.data.polygons,matindices):p.material_index=mi;p.use_smooth=True
bm.clear();bm.from_mesh(body.data);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(body.data);bm.free()
# Joint centers measured from the source anatomy; hand vertices stay with wrists.
bones=[('spine',None,(0,.03,0)),('tail_base','spine',(0,-.105,.005)),('tail_mid','tail_base',(0,-.24,-.07)),('tail_tip','tail_mid',(0,-.37,-.20)),('fin','tail_tip',(0,-.47,-.255)),('fin_left','fin',(-.055,-.49,-.265)),('fin_right','fin',(.055,-.49,-.265))]
for side,label in [(-1,'left'),(1,'right')]:
 for name,parent,p in [('arm','spine',(side*.125,.01,1.26)),('elbow','arm_'+label,(side*.215,.016,1.085)),('wrist','elbow_'+label,(side*.312,-.01,.925))]:bones.append((name+'_'+label,parent,body_map(Vector(p))))
bpy.ops.object.armature_add();rig=bpy.context.object;rig.name='hermes_skeleton';rig.parent=root;bpy.ops.object.mode_set(mode='EDIT');rig.data.edit_bones.remove(rig.data.edit_bones[0])
for name,parent,p in bones:
 b=rig.data.edit_bones.new(name);b.head=p;b.tail=Vector(p)+Vector((0,.05,0))
 if parent:b.parent=rig.data.edit_bones[parent]
bpy.ops.object.mode_set(mode='OBJECT')
for bone in rig.pose.bones:bone.rotation_mode='QUATERNION'
def chain(t,stops):
 if t<=stops[0][0]:return {stops[0][1]:1}
 for (a,an),(b,bn) in zip(stops,stops[1:]):
  if t<=b:
   if an==bn:return {an:1}
   u=(t-a)/(b-a);u=u*u*(3-2*u);return {an:1-u,bn:u}
 return {stops[-1][1]:1}
def weights(p):
 x,y,z=p;srcz=(y-.1)/.72+1.25;srcx=x/.72;side='left' if x<0 else 'right'
 # No height cutoff: fingers below the waist must never inherit tail weights.
 arm_threshold=.10+.075*max(0,min(1,(1.25-srcz)/.16))
 if abs(srcx)>arm_threshold and y>-.29:
  arm=chain(-srcz,[(-1.13,'arm_'+side),(-1.04,'elbow_'+side),(-.965,'elbow_'+side),(-.905,'wrist_'+side)])
  blend=max(0,min(1,(abs(srcx)-arm_threshold)/.050));w={n:v*blend for n,v in arm.items()};w['spine']=1-blend;return w
 return chain(-y,[(-.01,'spine'),(.13,'tail_base'),(.245,'tail_mid'),(.39,'tail_tip'),(.47,'fin')])
def skin_object(o,ww):
 for name,_,_ in bones:o.vertex_groups.new(name=name)
 for i,w in enumerate(ww):
  total=sum(w.values())
  assert total>0
  for name,value in w.items():
   if value>0:o.vertex_groups[name].add([i],value/total,'REPLACE')
 modifier=o.modifiers.new('Portable linear skin','ARMATURE');modifier.object=rig;o.parent=rig
 return o
# Distinguish generated tail rings from source hands by vertex provenance.
ww=[weights(v.co) if i<len(source_coords) else chain(-v.co.y,[(.09,'spine'),(.13,'tail_base'),(.245,'tail_mid'),(.39,'tail_tip'),(.47,'fin')]) for i,v in enumerate(body.data.vertices)]
for i,v in enumerate(source_coords):
 if v.z<.93 and abs(v.x)>.26:
  assert sum(weight for name,weight in ww[i].items() if name.startswith(('arm_','elbow_','wrist_')))>.999, 'Hand attached to tail'
skin_object(body,ww)
# Fitted bodice has a continuous shaped neckline; no jagged polygon material mask.
bpy.context.view_layer.update();body_bvh=BVHTree.FromObject(body,bpy.context.evaluated_depsgraph_get())
vs=[];fs=[];rows=48;cols=96
for j in range(rows):
 t=j/(rows-1)
 for i in range(cols):
  a=math.tau*i/cols;top=.049-.036*abs(math.sin(a))**4;y=top*(1-t)-.17*t
  origin=Vector((0,y,.003));direction=Vector((math.sin(a),0,math.cos(a)))
  hit,normal,_,_=body_bvh.ray_cast(origin,direction,.20)
  q=(hit+direction*.0045*(1-t**4)) if hit else origin+Vector((direction.x*.087,0,direction.z*.061))
  # Rays through the armpit must not accidentally pick the upper arm.
  limit=.077+max(0,.018-y)*.14
  q.x=max(-limit,min(limit,q.x));vs.append(q)
for j in range(rows-1):
 for i in range(cols):
  a=j*cols+i;b=j*cols+(i+1)%cols;fs.append((a,b,b+cols,a+cols))
bodice=mesh('fitted_bodice',vs,fs,teal,root)
bpy.context.view_layer.objects.active=bodice
modifier=bodice.modifiers.new('Relax fitted fabric','SMOOTH');modifier.factor=.45;modifier.iterations=4;bpy.ops.object.modifier_apply(modifier=modifier.name)
modifier=bodice.modifiers.new('Fabric edge','SOLIDIFY');modifier.thickness=.001;modifier.offset=-1;bpy.ops.object.modifier_apply(modifier=modifier.name)
skin_object(bodice,[weights(v.co) for v in bodice.data.vertices])
for side,label in [(-1,'left'),(1,'right')]:
 points=[]
 for i in range(25):
  t=i/24;points.append((side*(.056+.012*math.sin(math.pi*t)),.047+.084*math.sin(math.pi*t),.067-.113*t))
 strap=tube('bodice_strap_'+label,points,[.006]*len(points),teal,root);skin_object(strap,[{'spine':1} for v in strap.data.vertices])
# Thick curved flukes remain readable from the side and have separate fin bones.
for side,label in [(-1,'left'),(1,'right')]:
 vs=[];fs=[];rows=30;cols=24;ww=[]
 for j in range(rows):
  t=j/(rows-1);center=Vector((side*.23*t,-.47-.12*t,-.255-.08*t+.05*math.sin(math.pi*t)))
  tangent=Vector((side*.23,-.12,-.08)).normalized();across=Vector((.12*side,.23,0)).normalized();normal=tangent.cross(across).normalized()
  width=.078*math.sin(math.pi*t)**.9+.0007;thickness=.013*math.sin(math.pi*t)+.0008
  for k in range(cols):
   a=math.tau*k/cols;vs.append(center+across*width*math.cos(a)+normal*thickness*math.sin(a));ww.append(chain(t,[(0,'fin'),(.65,'fin_'+label)]))
 for j in range(rows-1):
  for k in range(cols):
   a=j*cols+k;b=j*cols+(k+1)%cols;fs.append((a,b,b+cols,a+cols))
 fs+=[tuple(reversed(range(cols))),tuple(range((rows-1)*cols,rows*cols))]
 skin_object(mesh('fin_surface_'+label,vs,fs,finmat,root),ww)
# Deform the actual orbital surface for blinks; no eye-scale trick.
def facial_delta(v,name):
 q=v.copy();x,y,z=v
 for label,c in centers.items():
  if name!='blink_'+('left' if label=='R' else 'right'):continue
  nearest=min(lid_rims[label],key=lambda r:abs(r[0]-x))
  q.y=c.y-.009+.003*((x-c.x)/.065)**2+(y-nearest[1]-.0011)
  hit=eye_surfaces[label].ray_cast(Vector((x,q.y,1)),Vector((0,0,-1)))[0]
  if hit:q.z=hit.z+.009+max(-.0015,min(.0015,z-facepoint(x,y,.0015).z))
 if name in ['smile','concern']:
  w=gauss(abs(x),.039,.027)*gauss(y,.274,.029)*max(0,min(1,(z-.06)/.04));q.y+=w*(.010 if name=='smile' else -.008)
 if name=='jaw_open':
  w=gauss(x,0,.105)*max(0,min(1,(.286-y)/.018))*max(0,min(1,(y-.14)/.05))*max(0,min(1,(z-.04)/.06));q.y-=.024*w;q.z-=.003*w
 if name=='brow_lift':q.y+=.009*gauss(y,.459,.045)*max(0,min(1,(z-.03)/.06))
 if name=='brow_frown':q.y-=.007*gauss(y,.448,.033)*gauss(x,0,.065)*max(0,min(1,(z-.03)/.06))
 return q
shape_names=['blink_left','blink_right','smile','concern','jaw_open','brow_lift','brow_frown']
face_meshes=[head]+[o for o in headroot.children if o.name.startswith(('upper_lash_','lip_','brow_'))]
for o in face_meshes:
 o.shape_key_add(name='Basis')
 for name in shape_names:
  if name.startswith('blink_') and not o.name.startswith('upper_lash_'):continue
  key=o.shape_key_add(name=name,from_mix=False);key.value=0
  for v,k in zip(o.data.vertices,key.data):
   k.co=v.co if o.name.startswith('brow_') and name.startswith('blink_') else facial_delta(v.co,name)
# Dedicated upper/lower lids sweep the actual corneal surface. The forehead and
# nose do not collapse into the orbit when blinking. A middle corrective keeps
# the interpolated lid outside the eyeball during a half blink.
for label,c in centers.items():
 side='left' if label=='R' else 'right'
 rims=lid_rims[label]
 for upper in [True,False]:
  vs=[];closed=[];middle=[];fs=[];rows=9;cols=len(rims)
  for j in range(rows):
   t=j/(rows-1)
   for x,hi,lo in rims:
    outer=hi+.008 if upper else lo-.006
    edge=hi+.001 if upper else lo-.001
    line=c.y-.009+.003*((x-c.x)/.065)**2
    end=max(lo,min(hi,line+(-.0007 if upper else .0007)))
    y=outer*(1-t)+edge*t;cy=outer*(1-t)+end*t
    def lidpoint(y,amount):
     face=facepoint(x,y,.001)
     hit=eye_surfaces[label].ray_cast(Vector((x,y,1)),Vector((0,0,-1)))[0]
     z=max(face.z,hit.z+.008 if hit else face.z)
     return Vector((x,y,z))
    p=lidpoint(y,0);q=lidpoint(cy,1);mid=lidpoint((y+cy)/2,.5)
    vs.append(p);closed.append(q);middle.append(p+mid-(p+q)/2)
  for j in range(rows-1):
   for i in range(cols-1):
    a=j*cols+i;b=a+1;fs.append((a,a+cols,b+cols,b) if upper else (a,b,b+cols,a+cols))
  lid=mesh(('upper' if upper else 'lower')+'_eyelid_'+side,vs,fs,skin,headroot)
  # Open sheets have a deliberately authored +Z-facing winding.
  lid.shape_key_add(name='Basis')
  for name,points in [('blink_'+side,closed),('blink_mid_'+side,middle)]:
   key=lid.shape_key_add(name=name,from_mix=False);key.value=0
   for v,p in zip(key.data,points):v.co=p
  face_meshes.append(lid)
# Secondary motion deforms only the lower locks, leaving the crown accessory fixed.
bob.shape_key_add(name='Basis')
for side,label in [(-1,'left'),(1,'right')]:
 key=bob.shape_key_add(name='hair_sway_'+label,from_mix=False);key.value=0
 for v,k in zip(bob.data.vertices,key.data):
  w=max(0,min(1,(.40-v.co.y)/.24))*max(0,min(1,side*v.co.x/.14))
  k.co=v.co+Vector((side*.012*w,0,.025*w))
head.name='face'
# Gaze origins and real head pivot are retained as explicit rigid controls.
for source_label,label in [('R','left'),('L','right')]:
 pupil=empty('hermes_pupil_'+label,headroot)
 for o in list(headroot.children):
  if o.name in ['iris_'+source_label,'pupil_'+source_label,'limbal_ring_'+source_label,'glint_large_'+source_label,'glint_small_'+source_label]:o.parent=pupil
# Translate authored vertices with their basis and shapes, then place the pivot.
pivot=Vector((0,.125,0))
for o in list(headroot.children):
 o.location-=pivot
headroot.location=pivot
spine=empty('hermes_spine',root);headroot.parent=spine
root.scale=(.73,.73,.73)
manifest={'schema':3,'boneNames':[n for n,_,_ in bones],'faceShapes':shape_names+['blink_mid_left','blink_mid_right'],'hairShapes':['hair_sway_left','hair_sway_right'],'source':'Blender Studio CC0 Human Base Meshes v1.4.1; Nous girl portrait adaptation','status':'candidate'}
(ROOT/'assets/terrarium/hermes-character-rig.json').write_text(json.dumps(manifest,indent=2)+'\n')
root.rotation_euler.x=math.pi/2
bpy.ops.object.select_all(action='DESELECT')
for o in [root]+list(root.children_recursive):o.select_set(True)
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/terrarium/hermes-character.blend'))
bpy.ops.wm.usd_export(filepath=str(ROOT/'assets/terrarium/hermes-character.usdz'),selected_objects_only=True,export_animation=False,export_armatures=True,export_shapekeys=True,triangulate_meshes=True,generate_preview_surface=True,convert_orientation=True,export_global_forward_selection='NEGATIVE_Z',export_global_up_selection='Y')
bpy.ops.export_scene.gltf(filepath=str(ROOT/'assets/terrarium/hermes-character.glb'),export_format='GLB',use_selection=True,export_animations=False,export_yup=True)
root.rotation_euler.x=0
# Fixed snapshots of neutral, working, waiting and fully closed eyelids.
for loc,power,size in [((1.5,2,3),230,3),((-2,1,1),140,2),((.5,1,-2),170,2)]:
 bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=power;o.data.size=size;o.rotation_euler=(Vector((0,.1,0))-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add();cam=bpy.context.object;scene.camera=cam;cam.data.type='ORTHO';cam.data.ortho_scale=1.13
scene.render.engine='CYCLES';scene.cycles.samples=32;scene.render.resolution_x=scene.render.resolution_y=900
for label,angle,mode in [('front',0,'neutral'),('portrait',40,'neutral'),('side',85,'neutral'),('work',30,'work'),('wait',30,'wait'),('blink',30,'blink')]:
 for b in rig.pose.bones:b.rotation_quaternion=Quaternion()
 for o in face_meshes:
  for key in o.data.shape_keys.key_blocks:key.value=0
 if mode in ['work','wait']:
  angles={'arm_left':(-.18,-.15,.12),'elbow_left':(-.85,0,.15),'arm_right':(-.10,.12,-.08),'elbow_right':(-.65,0,-.12)} if mode=='work' else {'arm_left':(-.35,-.25,-.20),'elbow_left':(-1.10,0,-.25)}
  for name,(x,y,z) in angles.items():rig.pose.bones[name].rotation_quaternion=Quaternion((1,0,0),x)@Quaternion((0,1,0),y)@Quaternion((0,0,1),z)
 if mode=='blink':
  for o in face_meshes:
   for name in ['blink_left','blink_right']:
    if name in o.data.shape_keys.key_blocks:o.data.shape_keys.key_blocks[name].value=1
 a=math.radians(angle);target=Vector((-.01,.045,-.02));cam.location=target+Vector((4*math.sin(a),.10,4*math.cos(a)));back=(cam.location-target).normalized();right=Vector((0,1,0)).cross(back).normalized();up=back.cross(right);cam.rotation_euler=Matrix((right,up,back)).transposed().to_euler();scene.render.filepath=str(OUT/(label+'.png'));bpy.ops.render.render(write_still=True)
print('CHARACTER',sum(len(o.data.polygons) for o in root.children_recursive if o.type=='MESH'),'polygons',len(rig.data.bones),'bones')
