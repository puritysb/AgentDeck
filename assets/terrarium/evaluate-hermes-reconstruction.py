"""Render imported TripoSR geometry, not its concept image.

Blender --background --python this-file -- --directory <inference-output>
TripoSR's unusual GLB axes are corrected for this review only.
"""
import argparse
import math
from pathlib import Path
import sys

import bpy
from mathutils import Matrix

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--directory', type=Path, required=True)
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
output = args.directory.resolve()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.import_scene.gltf(filepath=str(output / 'candidate.glb'))
for obj in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
    obj.matrix_world = Matrix.Rotation(-math.pi / 2, 4, 'X') @ obj.matrix_world
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    for material in obj.data.materials:
        if not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                node.inputs['Roughness'].default_value = .8
                node.inputs['Metallic'].default_value = 0

scene = bpy.context.scene
scene.world = bpy.data.worlds.new('Neutral evaluation')
scene.world.use_nodes = True
# Fixed neutral radiometric illumination, not a product palette token.
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (.035, .055, .07, 1)
for position, power, size in [((3, -3, 4), 350, 4), ((-3, 1, 2), 200, 3)]:
    bpy.ops.object.light_add(type='AREA', location=position)
    light = bpy.context.object
    light.data.energy = power
    light.data.size = size
    light.rotation_euler = (-light.location).to_track_quat('-Z', 'Y').to_euler()
bpy.ops.object.camera_add(location=(4, 0, .05))
camera = bpy.context.object
camera.rotation_euler = (-camera.location).to_track_quat('-Z', 'Y').to_euler()
camera.data.type = 'ORTHO'
camera.data.ortho_scale = 1.35
scene.camera = camera
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.view_settings.view_transform = 'Standard'
scene.render.resolution_percentage = 100
scene.render.resolution_x = scene.render.resolution_y = 640
scene.render.filepath = str(output / 'input-640.png')
bpy.ops.wm.save_as_mainfile(filepath=str(output / 'candidate-review.blend'))
for name, degrees in [('input', 0), ('quarter', 45), ('side', 90), ('back', 180)]:
    angle = math.radians(degrees)
    camera.location = (4 * math.cos(angle), 4 * math.sin(angle), .05)
    camera.rotation_euler = (-camera.location).to_track_quat('-Z', 'Y').to_euler()
    for size in (640, 96):
        scene.render.resolution_x = scene.render.resolution_y = size
        scene.render.filepath = str(output / f'{name}-{size}.png')
        bpy.ops.render.render(write_still=True)
