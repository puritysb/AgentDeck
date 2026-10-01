import bpy, bmesh, json, sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree
sys.path.insert(0,"/Users/puritysb/.codex/worktrees/hermes-agent/AgentDeck/assets/terrarium/hermes-head")
from face_v2 import F
dg=bpy.context.evaluated_depsgraph_get()
def T(n):
    bm=bmesh.new(); bm.from_mesh(bpy.data.objects[n].evaluated_get(dg).to_mesh()); return BVHTree.FromBMesh(bm)
H=T("hermes_head_cage"); HR=T("hermes_hair_cage")
def z_of(y): return 1.86+(y-0.02)*8.696
def face_pt(x,z):
    h=H.ray_cast(Vector((x,-10,z)),Vector((0,1,0)))[0]; return [x,h.y,z]
L={}
L["eye_far"]=face_pt(-F.EYE_X*8.696, z_of(F.EYE_Y))
L["eye_near"]=face_pt(F.EYE_X*8.696, z_of(F.EYE_Y))
L["nose"]=face_pt(-0.03, z_of(F.NOSE_Y))
L["mouth"]=face_pt(0.0, z_of(F.MOUTH_Y))
# chin: lowest z at x=0 where the face front is still forward (y < -0.9)
zc=None
for i in range(200):
    z=0.6-i*0.01; h=H.ray_cast(Vector((0,-10,z)),Vector((0,1,0)))[0]
    if h is None or h.y>-0.95: zc=z+0.01; break
L["chin"]=face_pt(0.0,zc)
for i in range(120):
    z=1.6+i*0.01; h=HR.ray_cast(Vector((0,-10,z)),Vector((0,1,0)))[0]
    if h is not None and h.y<-1.2: L["hem"]=[0.0,round(h.y,3),z]; break
c=bpy.data.objects.get("hermes_headset_clasp")
if c: L["clasp"]=list(sum((c.matrix_world@v.co for v in c.data.vertices),Vector())/len(c.data.vertices))
print("LM3D", json.dumps({k:[round(x,3) for x in v] for k,v in L.items()}))
