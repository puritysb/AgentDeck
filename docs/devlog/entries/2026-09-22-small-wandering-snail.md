# 2026-09-22 — Small wandering ground snail

- Reduced the native snail to 60% of authored size. Extract one runtime copy while hiding the source in the animated habitat, avoiding duplicate snails and conflicting baked movement.
- Replaced the short rock orbit with a six-minute smooth closed route across both sides of the ground, foreground and rear planting. Uses the authored bowl/sand height and movement-tangent heading/pitch. Rocks/plants may occlude it naturally; no forced visibility, fades or teleporting.
- The route is a bounded presentation path around the fixed habitat, not general mesh navigation. It shares the existing native scene update/pause behavior. The Blender asset's short loop remains a modeling preview.
- Added coverage for reduced size, one runtime copy, forward movement, front/rear/left/right coverage, bounded ground positions and loop continuity. 35 focused native tests and macOS/iOS builds pass. Workspace build/typecheck and 4,671 tests pass (2 skipped). macOS installed for review; no physical iOS, Android/e-ink or store deployment.
