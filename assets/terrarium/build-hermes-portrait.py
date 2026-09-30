"""Author the replacement Nous girl head from connected CC0 facial topology.
The original portrait is authoritative. This file does not deploy an app asset.
"""
from pathlib import Path
import bpy,bmesh,math,re,sys
from mathutils import Vector,Matrix
from mathutils.bvhtree import BVHTree
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'diagnostics/hermes-mermaid/portrait-v6';OUT.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True);bpy.context.preferences.filepaths.save_version=0
scene=bpy.context.scene
with bpy.data.libraries.load(str(ROOT/'assets/terrarium/sources/blender-studio-base.blend'),link=False) as (src,dst):dst.objects=list(src.objects)
source={o.name:o for o in dst.objects}
for o in source.values():scene.collection.objects.link(o)
body_source=source.pop('GEO-body_female_stylized');body_source.hide_render=True;body_source.hide_set(True)
def material(name,token,roughness=.6,gray=False):
    hx=re.search(r'--'+token+r':\s*#([0-9a-fA-F]{6})',(ROOT/'design/tokens.css').read_text()).group(1)
    values=[int(hx[i:i+2],16)/255 for i in (0,2,4)]
    rgb=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in values]
    if gray:rgb=[sum(rgb)/3]*3
    m=bpy.data.materials.new(name);m.use_nodes=True;p=m.node_tree.nodes['Principled BSDF'];p.inputs['Base Color'].default_value=(*rgb,1);p.inputs['Roughness'].default_value=roughness;p.inputs['Specular IOR Level'].default_value=.25
    return m
skin=material('Pale portrait skin','tide-50');hair=material('Nous black bob','ink-900',.6,True);white=material('Ivory band and sclera','tide-50',.38)
ink=material('Lashes and pupil','ink-900',.95,True);iris=material('Graphite iris','ink-500',.55,True)
lip=material('Subtle lip','coral-700',.65)
for m in [hair,ink]:
 p=m.node_tree.nodes['Principled BSDF'];rgba=p.inputs['Base Color'].default_value;p.inputs['Base Color'].default_value=(*[v*.38 for v in rgba[:3]],1)
p=lip.node_tree.nodes['Principled BSDF'];a=skin.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value;b=p.inputs['Base Color'].default_value;p.inputs['Base Color'].default_value=(*[a[i]*.7+b[i]*.3 for i in range(3)],1)
def empty(name,parent=None):
 o=bpy.data.objects.new(name,None);scene.collection.objects.link(o);o.parent=parent;return o
root=empty('resident_hermes_portrait');headroot=empty('hermes_head',root)
def mesh(name,vs,fs,mat,parent=headroot):
 d=bpy.data.meshes.new(name);d.from_pydata(vs,[],fs);d.update();o=bpy.data.objects.new(name,d);scene.collection.objects.link(o);o.parent=parent;d.materials.append(mat)
 for p in d.polygons:p.use_smooth=True
 bm=bmesh.new();bm.from_mesh(d);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-7);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(d);bm.free();return o
def tube(name,points,radii,mat,parent=headroot,sides=12):
 vs=[];fs=[]
 for j,c in enumerate(points):
  c=Vector(c);t=(Vector(points[min(j+1,len(points)-1)])-Vector(points[max(j-1,0)])).normalized();n=t.cross(Vector((0,0,1))).normalized()
  if n.length<.01:n=t.cross(Vector((0,1,0))).normalized()
  b=t.cross(n).normalized()
  for k in range(sides):
   a=math.tau*k/sides;vs.append(c+radii[j]*(math.cos(a)*n+math.sin(a)*b))
 for j in range(len(points)-1):
  for k in range(sides):
   a=j*sides+k;b=j*sides+(k+1)%sides;fs.append((a,b,b+sides,a+sides))
 fs.extend([tuple(reversed(range(sides))),tuple(range((len(points)-1)*sides,len(points)*sides))]);return mesh(name,vs,fs,mat,parent)
def gauss(x,c,w):return math.exp(-((x-c)/w)**2)
def mapped(v):
 x,y,z=v;front=max(0,min(1,(-y-.025)/.07));origx=x
 x*=1-.48*gauss(z,.132,.025)*gauss(x,0,.036)*front
 x*=1-.16*gauss(z,.082,.021)*gauss(x,0,.07)*front
 x*=1.68*(1-.07*gauss(z,.06,.04))
 zz=.172+(z-.172)*(.86 if z<.172 else 1)
 zz-=.020*gauss(z,0,.029)
 eyef=gauss(abs(origx),.044,.035)*gauss(z,.172,.036)*front
 zz-=.18*(z-.172)*eyef
 zz-=.0035*gauss(z,.187,.020)*eyef
 zz+=.17*(abs(origx)-.044)*eyef
 height=.12+1.65*zz
 depth=-y*1.55-.07-.016*gauss(z,.131,.022)*gauss(origx,0,.028)*front-.020*gauss(z,.081,.029)*gauss(origx,0,.052)*front
 if z<.025:
  neck=1-.30*max(0,min(1,(.025-z)/.035));x*=neck;depth=(depth+.02)*neck-.02
 if height<.24:
  t=max(0,min(1,(.24-height)/.125));t=t*t*(3-2*t)
  a=math.atan2(depth+.035,x)
  x=x*(1-t)+.030*math.cos(a)*t
  depth=depth*(1-t)+(.014+.029*math.sin(a))*t
 return Vector((x,height,depth))
head=source.pop('GEO-head_stylized');head.name='portrait_face';head.parent=headroot
bm=bmesh.new();bm.from_mesh(head.data);bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),dist=.00001,plane_co=(0,0,-.012),plane_no=(0,0,1),clear_inner=True);bm.to_mesh(head.data);bm.free()
for v in head.data.vertices:v.co=mapped(v.co)
head.data.materials.append(skin)
for p in head.data.polygons:p.use_smooth=True
m=head.modifiers.new('Facial surface subdivision','SUBSURF');m.levels=1;bpy.context.view_layer.objects.active=head;bpy.ops.object.modifier_apply(modifier=m.name)
centers={};eye_surfaces={}
for sign,label in [(1,'L'),(-1,'R')]:
 center=Vector((sign*.04401803,-.09320105,.17259991));centers[label]=mapped(center)
 eye=source['GEO-head_stylized.eye.'+label];eye.name='sclera_'+label;eye.parent=headroot
 bm=bmesh.new();bmesh.ops.create_uvsphere(bm,u_segments=64,v_segments=32,radius=1)
 for v in bm.verts:v.co=centers[label]+Vector((v.co.x*.065,v.co.y*.045,v.co.z*.052))
 eye.data=bpy.data.meshes.new('Smooth ocular surface '+label);bm.to_mesh(eye.data);bm.free()
 eye.data.materials.append(white)
 for p in eye.data.polygons:p.use_smooth=True
 # Use the actual corneal surface to place an iris with concentric tonal rings.
 bpy.context.view_layer.update();eye_bvh=BVHTree.FromObject(eye,bpy.context.evaluated_depsgraph_get());c=centers[label];eye_surfaces[label]=eye_bvh
 for name,radius,mat in [('iris',.036,iris),('pupil',.022,ink),('limbal',.037,ink)]:
  if name=='limbal':
   pts=[]
   for i in range(65):
    a=math.tau*i/64;x=c.x+radius*math.cos(a);y=c.y+radius*1.05*math.sin(a);hit=eye_bvh.ray_cast(Vector((x,y,1)),Vector((0,0,-1)))[0];pts.append((x,y,(hit.z if hit else c.z+.052)+.004))
   tube('limbal_ring_'+label,pts,[.0012]*65,mat);continue
  vs=[];fs=[];ns=64;nr=9
  for j in range(nr):
   r=radius*j/(nr-1)
   for i in range(ns):
    a=math.tau*i/ns;x=c.x+r*math.cos(a);y=c.y+r*1.05*math.sin(a);hit=eye_bvh.ray_cast(Vector((x,y,1)),Vector((0,0,-1)))[0];vs.append((x,y,(hit.z if hit else c.z+.052)+(.003 if name=='iris' else .005)))
  for j in range(nr-1):
   for i in range(ns):
    a=j*ns+i;b=j*ns+(i+1)%ns;fs.append((a,b,b+ns,a+ns))
  mesh(name+'_'+label,vs,fs,mat)
# Small explicit catchlights retain the portrait's readable eye highlights at
# dashboard scale, without relying on renderer-specific corneal transmission.
for label,c in centers.items():
 for name,dx,dy,r in [('large',-.010,.012,.0055),('small',.009,-.009,.0025)]:
  x=c.x+dx;y=c.y+dy
  hit=eye_surfaces[label].ray_cast(Vector((x,y,1)),Vector((0,0,-1)))[0]
  bpy.ops.mesh.primitive_uv_sphere_add(segments=16,ring_count=8,radius=1)
  glint=bpy.context.object;glint.name='glint_'+name+'_'+label;glint.parent=headroot
  for v in glint.data.vertices:v.co=Vector((x+v.co.x*r,y+v.co.y*r,(hit.z if hit else c.z+.052)+.006+v.co.z*.001))
  glint.data.materials.append(white)
  for poly in glint.data.polygons:poly.use_smooth=True
# Find lid margins on the actual socket by ray sampling. The deepest transition
# between facial skin and eye identifies the rim, avoiding floating eyeliner.
bpy.context.view_layer.update();face_bvh=BVHTree.FromObject(head,bpy.context.evaluated_depsgraph_get())
def facepoint(x,y,offset=.001):
 hit=face_bvh.ray_cast(Vector((x,y,1)),Vector((0,0,-1)))[0]
 return Vector((x,y,(hit.z if hit else .12)+offset))
lid_rims={}
for label,c in centers.items():
 rims=[]
 eye_bvh=eye_surfaces[label];pts=[]
 for i in range(65):
  x=c.x-.062+.124*i/64;visible=[]
  for j in range(101):
   y=c.y-.055+.11*j/100
   f=face_bvh.ray_cast(Vector((x,y,1)),Vector((0,0,-1)))[0];e=eye_bvh.ray_cast(Vector((x,y,1)),Vector((0,0,-1)))[0]
   if f and e and e.z>f.z+.0001:visible.append(y)
  if visible:
   rims.append((x,max(visible),min(visible)))
   y=max(visible)+.0011;pts.append(facepoint(x,y,.0015))
 lid_rims[label]=rims
 if pts:tube('upper_lash_'+label,pts,[.0008+.0025*math.sin(math.pi*i/(len(pts)-1)) for i in range(len(pts))],ink)
 pts=[facepoint(c.x+u*.044,c.y+.044+.008*(1-u*u),.0015) for u in [-1,-.75,-.5,-.25,0,.25,.5,.75,1]]
 tube('brow_'+label,pts,[.0004,.001,.0016,.0018,.0019,.0018,.0015,.001,.0002],ink)
# Lip contours follow the real mouth rather than a rectangle of face polygons.
for label,dy in [('upper',.0),('lower',-.006)]:
 pts=[]
 for i in range(33):
  u=-1+2*i/32;x=u*.026;y=mapped((0,-.16,.083)).y+dy+.002*(1-u*u)
  pts.append(facepoint(x,y,.001))
 tube('lip_'+label,pts,[.0002+(.0017 if label=='upper' else .00055)*math.sin(math.pi*i/32) for i in range(33)],ink if label=='upper' else lip)
# A continuous bob with a smooth hem transition: fringe is part of the scalp,
# not separate thick rectangular plates.
profile=[(.735,.003,.003),(.71,.095,.085),(.665,.18,.17),(.60,.24,.22),(.51,.275,.24),(.41,.29,.235),(.31,.293,.225),(.21,.285,.215),(.13,.258,.185)]
def radii(y):
 for k,((ya,xa,za),(yb,xb,zb)) in enumerate(zip(profile,profile[1:])):
  if y>=yb:
   t=max(0,min(1,(y-ya)/(yb-ya)));dy=yb-ya
   p0=profile[max(0,k-1)];p3=profile[min(len(profile)-1,k+2)]
   out=[]
   for dim in [1,2]:
    va=profile[k][dim];vb=profile[k+1][dim]
    ma=(vb-p0[dim])/(yb-p0[0]);mb=(p3[dim]-va)/(p3[0]-ya)
    out.append((2*t**3-3*t*t+1)*va+(t**3-2*t*t+t)*dy*ma+(-2*t**3+3*t*t)*vb+(t**3-t*t)*dy*mb)
   return out
 return profile[-1][1:]
def bob_z(x,y):
 rx,rz=radii(y);return -.05+rz*math.sqrt(max(.001,1-(x/rx)**2))
vs=[];fs=[];nr=48;ns=160
for j in range(nr):
 t=j/(nr-1)
 for i in range(ns):
  a=math.tau*i/ns;angle=abs((a+math.pi)%math.tau-math.pi);u=max(0,min(1,(angle-.72)/.38));u=u*u*(3-2*u)
  signed=(a+math.pi)%math.tau-math.pi
  fringe=.435+.007*math.cos(a*7+.4)+sum(.018*gauss(signed,notch,.026) for notch in [-.47,-.16,.21,.48])
  end=fringe*(1-u)+(.16+.012*math.cos(a*3))*u;y=.734+(.0+end-.734)*t
  rx,rz=radii(y);groove=.0007*math.cos(a*19+.4*math.sin(math.pi*t))*math.sin(math.pi*t)**1.5
  vs.append(((rx+groove)*math.sin(a),y,-.05+(rz+groove)*math.cos(a)))
for j in range(nr-1):
 for i in range(ns):
  a=j*ns+i;b=j*ns+(i+1)%ns;fs.append((a,b,b+ns,a+ns))
bob=mesh('continuous_bob',vs,fs,hair);m=bob.modifiers.new('Smooth authored hair','SUBSURF');m.levels=2;bpy.context.view_layer.objects.active=bob;bpy.ops.object.modifier_apply(modifier=m.name)
def bezier(points,t):
 p=[Vector(x) for x in points]
 while len(p)>1:p=[a*(1-t)+b*t for a,b in zip(p,p[1:])]
 return p[0]
def lock(name,points,width,thickness):
 vs=[];fs=[];rows=40;cols=20
 for j in range(rows):
  t=j/(rows-1);c=bezier(points,t);tangent=(bezier(points,min(1,t+.001))-bezier(points,max(0,t-.001))).normalized();across=tangent.cross(Vector((0,0,1))).normalized();normal=across.cross(tangent).normalized();profile=math.sin(math.pi*t)**.48+.005
  for k in range(cols):
   a=math.tau*k/cols;vs.append(c+across*width*profile*math.cos(a)+normal*thickness*profile*math.sin(a))
 for j in range(rows-1):
  for i in range(cols):
   a=j*cols+i;b=j*cols+(i+1)%cols;fs.append((a,b,b+cols,a+cols))
 fs+=[tuple(reversed(range(cols))),tuple(range((rows-1)*cols,rows*cols))];return mesh(name,vs,fs,hair)
lock('left_face_frame',[(-.22,.56,.03),(-.27,.32,.14),(-.20,.17,.18),(-.15,.23,.16)],.039,.010)
lock('right_face_frame',[(.22,.56,.03),(.27,.32,.14),(.20,.17,.18),(.15,.23,.16)],.039,.010)
lock('portrait_curl_upper',[(-.27,.38,.02),(-.28,.16,.16),(-.43,.20,.15),(-.39,.30,.13)],.027,.011)
lock('portrait_curl_lower',[(-.26,.30,-.015),(-.29,.08,.12),(-.43,.14,.13),(-.435,.22,.13)],.021,.010)
for o in list(headroot.children):
 if o.type=='MESH' and o.data.materials and o.data.materials[0]==hair:
  for v in o.data.vertices:
   v.co.x*=.94
   if v.co.y>.445:v.co.y=.445+(v.co.y-.445)*.83
# Union overlapping roots so close views do not show separate cylinder caps.
bpy.ops.object.select_all(action='DESELECT')
hair_objects=[o for o in headroot.children if o.type=='MESH' and o.data.materials and o.data.materials[0]==hair]
for o in hair_objects:o.select_set(True)
bpy.context.view_layer.objects.active=bob
# A closed shell is required for voxel union; an open sheet erodes into holes.
m=bob.modifiers.new('Closed hair shell','SOLIDIFY');m.thickness=.008;bpy.ops.object.modifier_apply(modifier=m.name)
bpy.ops.object.join()
bob.data.remesh_voxel_size=.0025;bpy.ops.object.voxel_remesh()
m=bob.modifiers.new('Relax sculpt surface','SMOOTH');m.factor=.55;m.iterations=4;bpy.ops.object.modifier_apply(modifier=m.name)
m=bob.modifiers.new('Hair runtime topology','DECIMATE');m.ratio=.065;bpy.ops.object.modifier_apply(modifier=m.name)
for poly in bob.data.polygons:poly.use_smooth=True
bpy.context.view_layer.update();hair_bvh=BVHTree.FromObject(bob,bpy.context.evaluated_depsgraph_get())
def bob_z(x,y):
 hit=hair_bvh.ray_cast(Vector((x,y,1)),Vector((0,0,-1)))[0]
 if hit:return hit.z
 rx,rz=radii(y);return -.05+rz*math.sqrt(max(.001,1-(x/rx)**2))
# Analytic projection onto one continuous shell prevents the earlier folded band.
vs=[];fs=[];n=60
for i in range(n):
 t=i/(n-1);x=(-.047+.274*t)*.94;y=.445+(.709-.203*t*t-.445)*.83
 tangent=Vector((.274*.94,-.406*t*.83,0)).normalized();across=Vector((-tangent.y,tangent.x,0));width=.0065+.003*t
 for sign in [-1,1]:
  q=Vector((x,y,0))+across*width*sign;q.z=bob_z(q.x,q.y)+.003;vs.append(q)
for i in range(n-1):fs.append((2*i,2*i+1,2*i+3,2*i+2))
band=mesh('Nous_headpiece',vs,fs,white);m=band.modifiers.new('Band edge thickness','SOLIDIFY');m.thickness=.001;bpy.context.view_layer.objects.active=band;bpy.ops.object.modifier_apply(modifier=m.name)
xy=[(.226,.51),(.236,.499),(.234,.487),(.224,.484),(.226,.492)]
pts=[]
for i in range(33):
 q=bezier([(x*.94,.445+(y-.445)*.83,0) for x,y in xy],i/32);q.z=bob_z(q.x,q.y)+.0035;pts.append(q)
tube('Nous_single_curled_tip',pts,[.0035*(1-i/40) for i in range(33)],white)
# Save an editable head study. The body remains a hidden authoring source.
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'hermes-portrait.blend'))
scene.world=bpy.data.worlds.new('Portrait studio');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.055,.07,.075,1)
for loc,power,size in [((1.5,2,3),170,3),((-2,1,1),100,2),((.5,1,-2),140,2)]:
 bpy.ops.object.light_add(type='AREA',location=loc);o=bpy.context.object;o.data.energy=power;o.data.size=size;o.rotation_euler=(Vector((0,.35,0))-o.location).to_track_quat('-Z','Y').to_euler()
bpy.ops.object.camera_add();cam=bpy.context.object;cam.data.type='ORTHO';cam.data.ortho_scale=.90;scene.camera=cam
scene.render.engine='CYCLES';scene.cycles.samples=32;scene.view_settings.view_transform='AgX';scene.render.resolution_x=scene.render.resolution_y=900;scene.render.resolution_percentage=100
for label,deg in ([] if '--no-preview' in sys.argv else [('front',0),('portrait',40),('side',85)]):
 a=math.radians(deg);target=Vector((-.02,.40,0));cam.location=target+Vector((4*math.sin(a),.015,4*math.cos(a)));back=(cam.location-target).normalized();right=Vector((0,1,0)).cross(back).normalized();up=back.cross(right);cam.rotation_euler=Matrix((right,up,back)).transposed().to_euler();scene.render.filepath=str(OUT/(label+'.png'));bpy.ops.render.render(write_still=True)
