# 2026-09-30 — Hermes connected character candidate and native visual checks

Rebuilt a separate editable Blender candidate from the credited CC0 Blender
Studio topology. Corrected neck flare, irregular tail-ring winding, arm/hand
weight assignment, source-measured joint positions and the fitted garment's
armpit boundary. Added an independent crown accessory, eye-surface lids with
middle-blink corrections and lower-hair deformation. The candidate exports
13 bones and 11 relative shape names with neutral defaults.

Actual Blender and standalone RealityKit renders exposed defects that a
successful export missed, including a floating band edge and a blink that
pulled the forehead into the eye socket. Replaced that facial deformation with
separate upper/lower lid surfaces. Builder/evaluator gates cover monotonic
rings, hand-vs-tail weights, normalized skin weights and zero defaults; a
RealityKit CLI checks import, clone isolation, repeated weights and Y-up bounds.

The original facial likeness, thick bob/side locks, lid margins and surface
joins remain incomplete. Technical checks do not claim aesthetic acceptance.
The candidate and review commands are tracked under assets/terrarium; renders,
geometry counts and native captures remain in ignored diagnostics. The current
app resource and runtime are unchanged, so prior app tests apply to the earlier
rig only. #428 and Draft PR #427 remain open for visual and integration work.
