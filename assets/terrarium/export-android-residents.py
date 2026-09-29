"""Export the approved Apple character source as individual Android glTF templates.

No redesign and no writes to the source blend: preserve the original marks,
closed backs and named anatomical hinges.
"""
from pathlib import Path
import bpy

ROOT = Path(__file__).resolve().parents[2]
bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'assets/terrarium/3d-residents.blend'))
destination = ROOT / 'android/app/src/main/assets/residents'
destination.mkdir(parents=True, exist_ok=True)
for kind in ['claudecode', 'codex', 'openclaw', 'opencode', 'antigravity', 'kiro', 'substrate']:
    root = bpy.data.objects['aquarium_substrate' if kind == 'substrate' else 'resident_' + kind]
    root.location.x = 0
    bpy.ops.object.select_all(action='DESELECT')
    root.select_set(True)
    for child in root.children_recursive:
        child.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=str(destination / (kind + '.glb')), export_format='GLB',
        use_selection=True, use_active_scene=True, export_animations=False, export_cameras=False,
        export_lights=False, export_yup=True,
    )
