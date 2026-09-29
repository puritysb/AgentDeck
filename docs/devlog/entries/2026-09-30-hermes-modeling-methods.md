# 2026-09-30 — Hermes production modeling research and rejected reconstruction studies

Researched Blender deformation topology, relative facial shapes, export limits,
CC0 base meshes and image-to-3D tooling. The required production sequence now
starts with a faithful neutral head sculpt before body rigging and motion.
Detailed evidence and constraints are consolidated in `docs/hermes-agent.md`;
[#428](https://github.com/puritysb/AgentDeck/issues/428) tracks acceptance.

A CC0 topology experiment was rejected for generic facial identity, folded band,
jagged material boundaries and collapsing forearms. A separate local TripoSR
run produced actual 37,036-vertex / 73,960-triangle geometry on Apple M4 MPS:
24.69 seconds initially and 16.46 seconds in the pinned reproduction. Four mesh
views at 640 and 96 px fail face/accessory fidelity and surface quality. It is
unrigged, has no expression shapes and is not watertight. Neither experiment
replaces the app's USDZ or GLB, nor is either presented as visually approved.

The repo retains a single-character reconstruction input, its exact built-in
image-generation prompts, a pinned inference wrapper and a Blender mesh-view
renderer. Generated geometry, comparison pages and isolated dependencies stay
in ignored diagnostics. Hunyuan3D was not executed because its license excludes
South Korea. Meshy/Tripo cloud generation was not invoked. No native runtime
changes, deployment or merge; #427 remains Draft pending visual acceptance.
