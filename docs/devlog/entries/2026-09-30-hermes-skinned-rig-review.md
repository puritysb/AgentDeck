# 2026-09-30 — Hermes skinned rig and explicit visual evaluation

The Hermes Blender model now has 13 deformation bones for spine, continuous
body/tail, independently spreading fins and shoulder/elbow/wrist chains. Head,
pupils, lids, brows, lips and hair have separate rest-relative controls. A single
numeric pose contract drives both the Swift runtime and Blender review: delayed
tail waves, asymmetrical work gestures, occasional double blinks and damped gaze.
The imported RealityKit skeleton is cached per resident; incomplete assets fall
back instead of silently losing animation. Reduce Motion still freezes poses.

A real USDZ regression caught closed-lid meshes omitted by Blender's hidden-mesh
export. They are now exported, then hidden/activated by the native rig. Tests
check real skeleton motion, independent clones, repeated-pose stability, visible
closed lids, gaze bounds, scene pause/resume and session removal. Native targeted
coverage passed: 9 Hermes tests plus 30 existing terrarium tests (39 total).

Visual evaluation is separate and **failed**. Fixed front/portrait/profile views
at 640 px and 96 px are compared against the official Nous girl and selected
concept. Eye proportions, band width, nose contour, torso length and tail rest
curve were adjusted, but hair masses/seams, doll-like expression, side-on fin
volume still need redesign. The initially hidden waiting hand was brought
forward to the cheek; arbitrary-view clearance remains unverified. Generated concepts
are not presented as implemented geometry. `docs/hermes-agent.md` records these
findings; reproducible views come from `evaluate-hermes-model.py`. Local review
images and HTML stay under ignored `diagnostics/hermes-mermaid/`.

The PR remains Draft, not visually approved. Native intake/device integration
and physical-device verification remain open in #425. No real delegation or
successful collaboration is inferred from cosmetic peer interactions.

Latest steering strengthens identity preservation: original head accessory,
bob/fringe, expression and face shape must be retained, with only the mermaid
body extended. A new concept reference was generated and its wrongly forked
accessory tip corrected in a second pass. It is labeled concept-only; source
contour fidelity and mesh implementation remain open. iOS Simulator Debug and
macOS Release builds passed, as did the local ad-hoc-signed Release App Store
invariant check. The final rig was captured for 24 seconds in the actual iPad
Simulator using a deterministic local fixture.

The user then identified the concept's paddle-like arms as unnatural. A focused
built-in image edit (`hermes-mermaid-arms-v4.png`) preserves the head appearance
and adds shoulder connections, elbow bends, wrists and asymmetric hand poses.
The hand detail is an authoring reference to simplify at dashboard scale. This
iteration changes concept references only, not the USDZ or runtime animation.
