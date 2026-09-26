"""Blender 5.2: bake the IPS10 keycap, preserving the current scene.
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
scene = bpy.data.scenes.new('IPS10 keycap bake')
if bpy.context.window:
    bpy.context.window.scene = scene
scene.render.engine = 'CYCLES'
scene.cycles.samples = 24
scene.cycles.use_denoising = True
scene.render.resolution_x = 128
scene.render.resolution_y = 96
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
    modifier = obj.modifiers.new('Soft key edge', 'BEVEL')
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
    rounded('Key base', (2.05, 2.05, .18), 0, 'ink-900', .17)
    rounded('Raised key', (1.95, 1.95, .32), .18, 'ink-700', .19)
    rounded('Key surface', (1.78, 1.78, .09), .355, 'ink-800', .16)
    camera = bpy.data.objects.new('Keycap camera', bpy.data.cameras.new('Keycap camera'))
    scene.collection.objects.link(camera)
    camera.location = (0, -3.5, 7)
    camera.rotation_euler = (Vector((0, 0, .15)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.type = 'ORTHO'
    camera.data.ortho_scale = 2.9
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
    scene.render.filepath = str(OUT / 'keycap.png')
    bpy.ops.render.render(write_still=True, scene=scene.name)
finally:
    if previous:
        bpy.context.window.scene = previous
