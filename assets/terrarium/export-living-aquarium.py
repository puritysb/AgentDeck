"""Blender 5.2: export one authored scene to native Android/Apple model formats."""
from pathlib import Path
import bpy
import argparse, sys

parser = argparse.ArgumentParser()
parser.add_argument("--source", default="living-aquarium.blend")
parser.add_argument("--target", choices=["all", "apple", "android"], default="all")
args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else [])

ROOT = Path(__file__).resolve().parents[2]
bpy.ops.wm.open_mainfile(filepath=str(ROOT / 'assets/terrarium' / args.source))
scene = bpy.data.scenes['AgentDeck Living Aquarium']
bpy.context.window.scene = scene
for obj in scene.objects:
    obj.select_set(obj.type in {'MESH', 'EMPTY', 'CURVE'} and not obj.hide_render)
scene.frame_start = 1
scene.frame_end = 721  # endpoint equals frame 1; 24 seconds at 30 Hz
if args.target != "apple":
    bpy.ops.export_scene.gltf(
        filepath=str(ROOT / 'android/app/src/main/assets/living-aquarium.glb'),
        export_format='GLB', use_active_scene=True, use_selection=True,
        export_animations=True, export_animation_mode='SCENE',
        export_anim_scene_split_object=False, export_frame_range=True,
        export_force_sampling=True, export_frame_step=2,
        export_cameras=False, export_lights=False,
    )
# Apple uses transform animation, including the garden's rooted leaf sway.
# GLB retains morphs; USDZ deformation needs a separate compatibility review.
# Triangulation is required to avoid malformed ribbon polygons in RealityKit.
if args.target != "android":
    scene.frame_set(1)
    for obj in scene.objects:
        if obj.type == 'MESH' and obj.data.shape_keys:
            obj.shape_key_clear()
    bpy.ops.wm.usd_export(
        filepath=str(ROOT / 'apple/AgentDeck/Resources/Aquarium/living-aquarium.usdz'),
        selected_objects_only=True, export_animation=True,
        triangulate_meshes=True, export_subdivision="TESSELLATE", export_shapekeys=False,
        export_lights=False, export_cameras=False, export_curves=True,
        generate_preview_surface=True, convert_orientation=True,
        export_global_forward_selection='NEGATIVE_Z', export_global_up_selection='Y',
    )
