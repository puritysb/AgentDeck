"""Give canonical character silhouettes depth without redesigning their anatomy.
No added eyes, shells, fins, tentacles, insignia, or substitute body shapes.
"""
from pathlib import Path
import bpy, bmesh, math, re, json, hashlib, sys
from mathutils.bvhtree import BVHTree
from mathutils import Vector
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'assets/terrarium'))
from brand_materials import linear_rgb
scene=bpy.data.scenes.new('AgentDeck 3D Residents');bpy.context.window.scene=scene
tokens=(ROOT/'design/tokens.css').read_text()
brands=['claudecode','codex','openclaw','opencode','antigravity','kiro']
features = json.loads((ROOT/'design/creatures/brand-features.generated.json').read_text())['agents']
feature_meshes = []
feature_materials = {}

def feature_material(rgb):
    key = tuple(rgb)
    if key not in feature_materials:
        mat = bpy.data.materials.new('Canonical opaque RGB ' + '-'.join(map(str, rgb)))
        mat.diffuse_color = (*linear_rgb(rgb), 1)
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        nodes.clear()
        # Principled emission converts to USD Preview Surface on RealityKit;
        # an unsupported standalone Emission node becomes a gray fallback.
        shader = nodes.new('ShaderNodeBsdfPrincipled')
        shader.inputs['Base Color'].default_value = (0, 0, 0, 1)
        shader.inputs['Emission Color'].default_value = mat.diffuse_color
        shader.inputs['Emission Strength'].default_value = 1
        shader.inputs['Specular IOR Level'].default_value = 0
        shader.inputs['Roughness'].default_value = 1
        output = nodes.new('ShaderNodeOutputMaterial')
        mat.node_tree.links.new(shader.outputs['BSDF'], output.inputs['Surface'])
        feature_materials[key] = mat
    return feature_materials[key]


def fill_feature(source, descriptor, brand, root):
    inlay = source.copy()
    inlay.data = source.data.copy()
    scene.collection.objects.link(inlay)
    selected = set(descriptor['subpathIndices'])
    for index, spline in reversed(list(enumerate(inlay.data.splines))):
        if index not in selected:
            inlay.data.splines.remove(spline)
    # Exact source contours are opaque front details, not see-through cutouts.
    inlay.location.z += source.data.extrude + source.data.bevel_depth + .014
    inlay.data.extrude = .004
    inlay.data.bevel_depth = 0
    inlay.data.materials.clear()
    inlay.data.materials.append(feature_material(descriptor['rgb']))
    inlay = convert(inlay)
    inlay.name = brand + '_feature_' + descriptor['role'] + '_' + str(descriptor['pathIndex'])
    inlay.parent = root
    feature_meshes.append((inlay, descriptor['rgb']))
    return inlay

def color(name):
    value=re.search(r'--brand-'+name+r':\s*#([0-9a-fA-F]{6})',tokens).group(1)
    rgb=[int(value[i:i+2],16)/255 for i in (0,2,4)]
    return tuple(c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4 for c in rgb)
def rainbow_material(mat):
    # Official full-color press asset, kept byte-for-byte in design/brand.
    # Its broad blue base and warm crown are not a linear rainbow ramp.
    image=bpy.data.images.load(str(ROOT/'design/brand/antigravity-color.png'),check_existing=True)
    image.pack()
    tex=mat.node_tree.nodes.new('ShaderNodeTexImage');tex.image=image
    tex.extension='EXTEND'
    mat.node_tree.links.new(tex.outputs['Color'],mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    return image

def rainbow_uv(meshes,image):
    # Fit the official transparent icon's occupied bounds to the unchanged SVG.
    # Sample edge UVs from the nearest opaque texel to avoid black transparent
    # padding bleeding onto the small bevel. The source image is never edited.
    width,height=image.size;pixels=list(image.pixels)
    opaque=[(i%width,i//width) for i in range(width*height) if pixels[i*4+3]>.98]
    # Leave a mip-filter footprint inside the opaque region: otherwise the
    # PNG's transparent black padding becomes dark stripes on the bevel.
    margin=8
    safe=[(x,y) for x,y in opaque if margin<=x<width-margin and margin<=y<height-margin
          and all(pixels[((y+dy)*width+x+dx)*4+3]>.999
                  for dx,dy in [(-margin,0),(margin,0),(0,-margin),(0,margin)])]
    safe_set=set(safe)
    lo=(min(x for x,y in opaque),min(y for x,y in opaque))
    hi=(max(x for x,y in opaque),max(y for x,y in opaque))
    points=[o.matrix_local@v.co for o in meshes for v in o.data.vertices]
    low=(min(p.x for p in points),min(p.y for p in points))
    high=(max(p.x for p in points),max(p.y for p in points))
    for o in meshes:
        uv=o.data.uv_layers.new(name='Official color mark')
        o.data.uv_layers.active=uv;uv.active_render=True
        coords={}
        for v in o.data.vertices:
            p=o.matrix_local@v.co
            x=lo[0]+(p.x-low[0])/(high[0]-low[0])*(hi[0]-lo[0])
            y=lo[1]+(p.y-low[1])/(high[1]-low[1])*(hi[1]-lo[1])
            if (round(x),round(y)) not in safe_set:
                x,y=min(safe,key=lambda q:(q[0]-x)**2+(q[1]-y)**2)
            coords[v.index]=((x+.5)/width,(y+.5)/height)
        for loop in o.data.loops:uv.data[loop.index].uv=coords[loop.vertex_index]

def convert(o):
    bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
    bpy.ops.object.convert(target='MESH');return bpy.context.object
def hinge(o,name,pivot,root):
    anchor=bpy.data.objects.new('joint_'+name,None);scene.collection.objects.link(anchor)
    anchor.parent=root;anchor.location=pivot;o.parent=anchor;o.location-=Vector(pivot)
def clipped(source,name,planes):
    bm=bmesh.new();bm.from_mesh(source.data)
    bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=.00001)
    bmesh.ops.triangulate(bm,faces=list(bm.faces))
    for origin,normal in planes:
        cut=bmesh.ops.bisect_plane(bm,geom=list(bm.verts)+list(bm.edges)+list(bm.faces),dist=.000001,
            plane_co=origin,plane_no=normal,clear_outer=True,clear_inner=False)
        edges=[e for e in cut['geom_cut'] if isinstance(e,bmesh.types.BMEdge) and e.is_boundary]
        if edges:bmesh.ops.holes_fill(bm,edges=edges,sides=0)
        bmesh.ops.triangulate(bm,faces=list(bm.faces))
    mesh=bpy.data.meshes.new(name);bm.to_mesh(mesh);bm.free()
    # Intersecting the SVG's pixel-step edges can leave a zero-area cap;
    # glTF rejects that even though Blender displays the silhouette normally.
    mesh.validate(clean_customdata=False)
    check=bmesh.new();check.from_mesh(mesh)
    broken=sum(not edge.is_manifold for edge in check.edges);check.free()
    if broken:raise RuntimeError(f'{name}: {broken} open or overlapping cut edges')
    o=bpy.data.objects.new(name,mesh);scene.collection.objects.link(o)
    o.data.materials.append(source.data.materials[0]);return o
for brand in brands:
    root=bpy.data.objects.new('resident_'+brand,None);scene.collection.objects.link(root)
    contract = features.get(brand)
    if contract:
        source = ROOT / contract['sourcePath']
        if hashlib.sha256(source.read_bytes()).hexdigest() != contract['sourceHash']:
            raise RuntimeError(brand + ': regenerate canonical feature contract after source changes')
    rgb=color('claude-code' if brand=='claudecode' else brand)
    mat=bpy.data.materials.new(brand+' original');mat.diffuse_color=(*rgb,1);mat.use_nodes=True
    shader=mat.node_tree.nodes.get('Principled BSDF');shader.inputs['Base Color'].default_value=mat.diffuse_color
    shader.inputs['Roughness'].default_value=.46;shader.inputs['Metallic'].default_value=0
    if brand=='antigravity':rainbow=rainbow_material(mat)
    before=set(scene.objects);bpy.ops.import_curve.svg(filepath=str(ROOT/'design/brand'/f'{brand}.svg'))
    parts=[o for o in scene.objects if o not in before and o.type=='CURVE']
    bpy.context.view_layer.update();bounds=[o.matrix_world@Vector(c) for o in parts for c in o.bound_box]
    low=Vector(tuple(min(p[i] for p in bounds) for i in range(3)));high=Vector(tuple(max(p[i] for p in bounds) for i in range(3)))
    center=(low+high)/2;factor=1/max(high.x-low.x,high.y-low.y)
    meshes=[]
    for n,o in enumerate(parts):
        bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
        o.location=(o.location-center)*factor;o.scale*=factor
        bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
        for spline in o.data.splines:
            for p in list(spline.bezier_points)+list(spline.points):p.radius=1
        o.data.dimensions='2D';o.data.fill_mode='BOTH';o.data.extrude=.115
        # Restrained edge softening preserves the source's pixel/curve character.
        o.data.bevel_depth=.006 if brand in {'claudecode','opencode'} else .012
        o.data.bevel_resolution=4;o.data.resolution_u=16
        o.data.materials.clear();o.data.materials.append(mat)
        descriptors = [item for item in (contract['features'] if contract else []) if item['pathIndex'] == n]
        for descriptor in descriptors:
            if descriptor['mode'] == 'fill':
                # Existing OpenClaw highlight paths sit above the exact black eye inlay.
                if set(descriptor['subpathIndices']) == set(range(len(o.data.splines))):
                    o.data.materials.clear()
                    o.data.materials.append(feature_material(descriptor['rgb']))
                    o.location.z += o.data.extrude + o.data.bevel_depth + .030
                    o.data.extrude = .004
                    o.data.bevel_depth = 0
                else:
                    fill_feature(o, descriptor, brand, root)
        # Close facial cutouts only at the rear. The back follows the exact
        # outer outline, without a convex hull, dorsal bumps or a second body.
        if len(o.data.splines)>1 and not any(item['mode'] == 'hole' for item in descriptors):
            back=o.copy();back.data=o.data.copy();scene.collection.objects.link(back)
            def area(sp):
                pts=[p.co for p in (sp.bezier_points if sp.type=='BEZIER' else sp.points)]
                return abs(sum(a.x*b.y-b.x*a.y for a,b in zip(pts,pts[1:]+pts[:1])))
            outer=max(back.data.splines,key=area)
            for sp in list(back.data.splines):
                if sp!=outer:back.data.splines.remove(sp)
            back.data.extrude=.025;back.data.bevel_depth=0
            back.location.z=-.089-o.data.bevel_depth
            back=convert(back);back.name=brand+'_rear';back.parent=root;meshes.append(back)
        o=convert(o);o.name=brand+'_canonical_'+str(n);o.parent=root;meshes.append(o)
        for descriptor in descriptors:
            if descriptor['mode'] == 'fill' and descriptor['role'] == 'eye-highlight':
                o.name = brand + '_feature_eye-highlight_' + str(n)
                feature_meshes.append((o, descriptor['rgb']))
    if brand=='claudecode':
        # Split only existing limbs from the source; neutral pose is unchanged.
        # Fuse the rear closure before cutting limbs. Object-join leaves two
        # overlapping shells, so bisect caps can contain intersecting loops.
        source=meshes[-1]
        bpy.ops.object.select_all(action='DESELECT');source.select_set(True)
        bpy.context.view_layer.objects.active=source
        for closure in meshes[:-1]:
            union=source.modifiers.new('Fuse rear closure','BOOLEAN')
            union.operation='UNION';union.solver='EXACT';union.object=closure
            bpy.ops.object.modifier_apply(modifier=union.name)
            bpy.data.objects.remove(closure,do_unlink=True)
        bpy.ops.object.transform_apply(location=True,rotation=False,scale=True)
        middle=[((.375,0,0),(1,0,0)),((-.375,0,0),(-1,0,0))]
        # Cut just inside the torso rather than through the bevel's existing
        # collinear junction vertices, which would produce overlapping caps.
        foot_top=-.19079
        torso_cut=-.1906
        torso=clipped(source,'claudecode_canonical_body',middle+[((0,torso_cut,0),(0,-1,0))]);torso.parent=root
        for v in torso.data.vertices:
            if abs(v.co.y-torso_cut)<.000001:v.co.y=foot_top
        # The SVG's horizontal arms occupy y=10.949..14.051 (in a 24-unit
        # viewBox). Clipping only by x also picked up the full-height outer
        # torso edge; rotating that edge produced broken-looking spikes behind
        # the character. Keep the non-arm parts of each side fixed to the body.
        # Include the complete bevel. Cutting at the SVG's un-beveled edge
        # leaves its top/bottom skin attached to the fixed flank like shards.
        arm_edge_margin=.00601
        arm_top=(12.5-10.949)/24+arm_edge_margin
        arm_bottom=(12.5-14.051)/24-arm_edge_margin
        for index,side in enumerate([-1,1]):
            outer=[((side*.375,0,0),(-side,0,0))]
            arm=clipped(source,'claudecode_canonical_arm',outer+[
                ((0,arm_top,0),(0,1,0)),((0,arm_bottom,0),(0,-1,0))])
            hinge(arm,'arm_'+str(index),(side*.375,0,0),root)
            for name,cut in [('upper',((0,arm_top,0),(0,-1,0))),
                             ('lower',((0,arm_bottom,0),(0,1,0)))]:
                flank=clipped(source,'claudecode_canonical_flank_'+name,outer+[cut])
                flank.parent=root
        # Original four pixel feet, cut at their existing junction with the body.
        intervals=[(-.31305,-.25),(-.18805,-.125),(.125,.18805),(.25,.31305)]
        for i,(left,right) in enumerate(intervals):
            foot=clipped(source,'claudecode_canonical_foot', [((0,foot_top,0),(0,1,0)),((left,0,0),(-1,0,0)),((right,0,0),(1,0,0))])
            hinge(foot,'foot_'+str(i),((left+right)/2,foot_top,0),root)
        bpy.data.objects.remove(source,do_unlink=True)
    elif brand=='openclaw':
        # SVG paths already separate the two canonical claws from the torso.
        for o in meshes:
            bpy.context.view_layer.update()
            points=[o.matrix_local@Vector(c) for c in o.bound_box]
            cx=sum(p.x for p in points)/8;w=max(p.x for p in points)-min(p.x for p in points)
            if abs(cx)>.30 and w<.30:
                hinge(o,'claw_'+str(int(cx>0)),(cx*.8,0,0),root)
    if brand=='antigravity':
        bpy.context.view_layer.update()
        rainbow_uv(meshes,rainbow)
    root.rotation_euler.x=math.pi/2;root.location.x=brands.index(brand)*1.5
# One portable resting shelf for the bottom dwellers on both native clients.
# Authored Z-up here; each native exporter converts it to its Y-up scene.
vertices=[];faces=[];sides=24
for radius,height in [(.82,1),(1,.86),(1.12,0)]:
    for i in range(sides):
        angle=i/sides*2*math.pi;edge=radius*(1+math.sin(angle*3+.4)*.045)
        vertices.append((math.cos(angle)*edge,math.sin(angle)*edge,height))
vertices.append((0,0,1))
for i in range(sides):
    n=(i+1)%sides;faces.append((72,i,n))
    for row in range(2):
        a=row*sides+i;b=row*sides+n
        faces.extend([(a,a+24,b+24),(a,b+24,b)])
mesh=bpy.data.meshes.new('Substrate resting shelf');mesh.from_pydata(vertices,[],faces);mesh.update()
support=bpy.data.objects.new('aquarium_substrate',mesh);scene.collection.objects.link(support)
value=re.search(r'--ink-700:\s*#([0-9a-fA-F]{6})',tokens).group(1)
rgb=[int(value[i:i+2],16)/255 for i in (0,2,4)]
rgb=[c/12.92 if c<=.04045 else ((c+.055)/1.055)**2.4 for c in rgb]
mat=bpy.data.materials.new('Substrate ink stone');mat.use_nodes=True
mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value=(*rgb,1)
mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value=.9
mesh.materials.append(mat)
# Probe generated geometry rather than merely checking a declared material name.
bpy.context.view_layer.update()
def nearest_hit(root, origin, direction):
    hits = []
    for obj in root.children_recursive:
        if obj.type != 'MESH':
            continue
        inverse = obj.matrix_world.inverted()
        local_origin = inverse @ origin
        local_direction = inverse.to_3x3() @ direction
        hit, normal, index, distance = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get()).ray_cast(local_origin, local_direction)
        if hit is not None:
            point = obj.matrix_world @ hit
            hits.append(((point - origin).length, obj, index))
    return min(hits, key=lambda hit: hit[0]) if hits else None

for obj, expected_rgb in feature_meshes:
    front = max(obj.data.polygons, key=lambda face: face.center.z)
    normal = obj.matrix_world.to_3x3() @ Vector((0, 0, 1))
    point = obj.matrix_world @ front.center
    hit = nearest_hit(obj.parent, point + normal, -normal)
    if hit is None or hit[1] != obj:
        raise RuntimeError(obj.name + ': canonical feature is hidden behind the body')
    actual = list(obj.data.materials[0].diffuse_color[:3])
    if any(abs(value - expected) > .00001 for value, expected in zip(actual, linear_rgb(expected_rgb))):
        raise RuntimeError(obj.name + ': wrong opaque feature material')
    print('VERIFIED_VISIBLE_FEATURE', obj.name, expected_rgb)

opencode = bpy.data.objects['resident_opencode']
for local_direction in [Vector((0, 0, -1)), Vector((0, 0, 1)), Vector((.2, 0, -1)).normalized()]:
    direction = opencode.matrix_world.to_3x3() @ local_direction
    center = opencode.matrix_world @ Vector((0, 0, 0))
    if nearest_hit(opencode, center - direction, direction) is not None:
        raise RuntimeError('OpenCode center must remain a true front/back/oblique through-hole')
rim = opencode.matrix_world @ Vector((.3, 0, 1))
direction = opencode.matrix_world.to_3x3() @ Vector((0, 0, -1))
if nearest_hit(opencode, rim, direction) is None:
    raise RuntimeError('OpenCode outer frame disappeared while opening the center')
print('VERIFIED_OPENCODE_THROUGH_HOLE front back oblique with opaque rim')
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/terrarium/3d-residents.blend'))
for o in scene.objects:
    if o.name.startswith('resident_'):o.location.x=0
for o in scene.objects:o.select_set(True)
bpy.ops.wm.usd_export(filepath=str(ROOT/'apple/AgentDeck/Resources/Aquarium/3d-residents.usdz'),selected_objects_only=True,
    export_animation=False,triangulate_meshes=True,generate_preview_surface=True,convert_orientation=True,
    export_global_forward_selection='NEGATIVE_Z',export_global_up_selection='Y')
print('Exported canonical characters with restrained depth and original anatomy')
