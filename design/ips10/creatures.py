"""Bake exact native character reliefs with their canonical opaque features.
Run blender -b --python design/ips10/creatures.py after build-3d-residents.py.
112px RGBA renders are baked to RGB565+A8 for IPS10; no runtime 3D engine.
"""
from pathlib import Path
import hashlib
import json
import sys
import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

OUT = Path(__file__).resolve().parent
ROOT = OUT.parents[1]
sys.path.insert(0, str(ROOT/'assets/terrarium'))
from brand_materials import linear_rgb
contract = json.loads((ROOT/'design/creatures/brand-features.generated.json').read_text())['agents']
previous = bpy.context.window.scene
scene = bpy.data.scenes.new('IPS10 canonical creature reliefs')
bpy.context.window.scene = scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.render.resolution_x = scene.render.resolution_y = 112
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.view_settings.view_transform = 'Standard'
scene.world = bpy.data.worlds.new('Creature studio')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .65
camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
scene.collection.objects.link(camera)
camera.location = (0, -1.3, 5)
camera.rotation_euler = (.254, 0, 0)
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 2.25
scene.camera = camera
for location, power, size in [((-3, 4, 6), 380, 5), ((3, -1, 4), 120, 4)]:
    light = bpy.data.objects.new('Softbox', bpy.data.lights.new('Softbox', 'AREA'))
    scene.collection.objects.link(light)
    light.location = location
    light.rotation_euler = (-light.location).to_track_quat('-Z', 'Y').to_euler()
    light.data.energy = power
    light.data.size = size

# Reuse the native source geometry/materials, not an alpha-only body mask that
# loses black eyes, white prompt strokes and OpenClaw's original pupil glints.
with bpy.data.libraries.load(str(ROOT/'assets/terrarium/3d-residents.blend'), link=False) as (source, loaded):
    loaded.objects = source.objects
objects = {obj.name: obj for obj in loaded.objects if obj is not None}
def verify_rendered_features(brand, image):
    pixels = list(image.pixels)
    for descriptor in contract[brand]['features']:
        if descriptor['mode'] != 'fill':
            continue
        obj = objects[brand+'_feature_'+descriptor['role']+'_'+str(descriptor['pathIndex'])]
        mesh = obj.data
        mesh.calc_loop_triangles()
        adjacent = {vertex.index: set() for vertex in mesh.vertices}
        for edge in mesh.edges:
            a, b = edge.vertices
            adjacent[a].add(b)
            adjacent[b].add(a)
        remaining = set(adjacent)
        verified = 0
        while remaining:
            component = set()
            pending = [next(iter(remaining))]
            while pending:
                vertex = pending.pop()
                if vertex in component:
                    continue
                component.add(vertex)
                pending.extend(adjacent[vertex]-component)
            remaining -= component
            front = [triangle for triangle in mesh.loop_triangles
                     if triangle.vertices[0] in component and triangle.normal.z > .9]
            if not front:
                continue  # Curve caps and extrusion sides may have split normals.
            triangle = max(front, key=lambda triangle: triangle.area)
            point = sum((mesh.vertices[index].co for index in triangle.vertices), Vector())/3
            projected = world_to_camera_view(scene, camera, obj.matrix_world @ point)
            x, y = int(projected.x*112), int(projected.y*112)
            samples = [pixels[(py*112+px)*4:(py*112+px)*4+4]
                       for py in range(max(0,y-1), min(112,y+2))
                       for px in range(max(0,x-1), min(112,x+2))]
            target = [value/255 for value in descriptor['rgb']]
            assert any(sample[3] > .9 and max(abs(value-wanted) for value,wanted in zip(sample[:3],target)) < .25
                       for sample in samples), brand+': baked feature lost opacity/color '+descriptor['role']
            verified += 1
            print('VERIFIED_RELIEF_FEATURE', brand, descriptor['role'], (x,y), descriptor['rgb'])
        assert verified >= len(descriptor['subpathIndices']), 'Missing opaque front feature'

try:
    for name, brand in [('claude', 'claudecode'), ('codex', 'codex'), ('openclaw', 'openclaw')]:
        entry = contract[brand]
        source = ROOT/entry['sourcePath']
        assert hashlib.sha256(source.read_bytes()).hexdigest() == entry['sourceHash'], 'Canonical SVG feature drift'
        root = objects['resident_'+brand]
        for descriptor in entry['features']:
            if descriptor['mode'] != 'fill':
                continue
            feature = objects[brand+'_feature_'+descriptor['role']+'_'+str(descriptor['pathIndex'])]
            color = feature.data.materials[0].node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value
            assert all(abs(actual-expected) < .00001 for actual, expected in zip(color[:3], linear_rgb(descriptor['rgb']))), 'Relief feature material drift'
        root.location = (0, 0, 0)
        root.rotation_euler = (0, 0, 0)
        root.scale = (1.8, 1.8, 1.8)
        descendants = [root]+list(root.children_recursive)
        for obj in descendants:
            scene.collection.objects.link(obj)
        bpy.context.view_layer.update()
        scene.render.image_settings.file_format = 'PNG'
        scene.render.image_settings.color_mode = 'RGBA'
        scene.render.filepath = str(OUT/(name+'-relief.png'))
        bpy.ops.render.render(write_still=True, scene=scene.name)
        image = bpy.data.images.load(scene.render.filepath, check_existing=False)
        verify_rendered_features(brand, image)
        bpy.data.images.remove(image)
        for obj in descendants:
            scene.collection.objects.unlink(obj)
finally:
    bpy.context.window.scene = previous
