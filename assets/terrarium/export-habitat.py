"""Run with Blender --background --python assets/terrarium/export-habitat.py."""
from pathlib import Path
import bpy

root = Path(__file__).resolve().parents[2]
bpy.ops.wm.open_mainfile(filepath=str(root / 'assets/terrarium/aquarium-habitat.blend'))
scene = bpy.data.scenes['AgentDeck Aquarium Study']
bpy.context.window.scene = scene
scene.compositing_node_group = None
scene.render.filepath = str(root / 'android/app/src/main/res/drawable-nodpi/aquarium_habitat.png')
bpy.ops.render.render(write_still=True)
