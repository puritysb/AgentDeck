"""Blender 5.2: bake the IPS10 shared workbench, preserving the current scene.
Run via Blender MCP with __file__ set, or blender -b --python this/file.py.
Materials come from design/tokens.css; the PNG is the firmware conversion input.
"""
from pathlib import Path
import re
import bpy
from mathutils import Vector

OUT = Path(__file__).resolve().parent
TOKENS = (OUT.parent / 'tokens.css').read_text()

def color(name):
    value = re.search(r'--' + re.escape(name) + r':\s*#([0-9a-fA-F]{6})', TOKENS).group(1)
    rgb = [int(value[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in rgb) + (1,)

previous = bpy.context.window.scene if bpy.context.window else None
scene = bpy.data.scenes.new('IPS10 room bake')
if bpy.context.window:
    bpy.context.window.scene = scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 448
scene.render.resolution_y = 120
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.view_settings.view_transform = 'Standard'
scene.world = bpy.data.worlds.new('IPS10 studio')
scene.world.use_nodes = True
scene.world.node_tree.nodes['Background'].inputs[0].default_value = (0.3, 0.3, 0.3, 1)
scene.world.node_tree.nodes['Background'].inputs[1].default_value = .45

def rounded(name, dimensions, z, token, bevel):
    bpy.ops.mesh.primitive_cube_add(location=(0, 0, z))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    modifier = obj.modifiers.new('Soft desk edge', 'BEVEL')
    modifier.width = bevel
    modifier.segments = 6
    obj.modifiers.new('Weighted normals', 'WEIGHTED_NORMAL')
    material = bpy.data.materials.new(name + ' token material')
    material.use_nodes = True
    node = material.node_tree.nodes['Principled BSDF']
    node.inputs['Base Color'].default_value = color(token)
    node.inputs['Roughness'].default_value = .35
    node.inputs['Metallic'].default_value = .12
    obj.data.materials.append(material)

try:
    rounded('Shared project platform', (6.6, 1.1, .16), 0, 'ink-700', .14)
    rounded('Working surface', (6.4, .95, .06), .11, 'ink-800', .10)
    # Small shelves at the ends leave the centre for live canonical creatures.
    for x in (-3.05, 3.05):
        rounded('Desk pedestal', (.38, .45, .18), .23, 'ink-500', .06)
        bpy.context.object.location.x = x
        rounded('Desk object', (.24, .20, .26), .42, 'kelp-300', .05)
        bpy.context.object.location.x = x
    for x in (-2.2, -.75, .75, 2.2):
        rounded('Workstation inset', (1.0, .5, .035), .16, 'ink-700', .05)
        bpy.context.object.location.x = x
    camera = bpy.data.objects.new('Workbench camera', bpy.data.cameras.new('Workbench camera'))
    scene.collection.objects.link(camera)
    camera.location = (0, -5, 6)
    camera.rotation_euler = (Vector((0, 0, .15)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 7.2
    scene.camera = camera
    light = bpy.data.objects.new('Softbox', bpy.data.lights.new('Softbox', 'AREA'))
    scene.collection.objects.link(light)
    light.location = (-3, -4, 6)
    light.rotation_euler = (-light.location).to_track_quat('-Z', 'Y').to_euler()
    light.data.energy = 550
    light.data.shape = 'DISK'
    light.data.size = 5
    scene.render.image_settings.file_format = 'PNG'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.filepath = str(OUT / 'room.png')
    bpy.ops.render.render(write_still=True, scene=scene.name)
finally:
    if previous:
        bpy.context.window.scene = previous
