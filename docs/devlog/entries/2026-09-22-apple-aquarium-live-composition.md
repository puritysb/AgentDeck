# 2026-09-22 — Restore live creatures and HUD contrast in the Apple 3D dashboard

The selected 3D dashboard replaced the entire TerrariumView with a RealityView.
That removed live session creatures and their tap targets, while pale imported
scene materials washed out text intended for the dark standard habitat.

- Split habitat drawing from live creature drawing; the standard path retains
  its existing layers. The 3D path composites canonical 2D session creatures,
  labels, focus and interaction over the native scene.
- Bound the creature stage to the center and darkened the scene behind the HUD,
  with a stronger lower gradient for timeline/chat readability.
- Added a rendered-pixel regression asserting both transparent background and
  visible live creature pixels when habitat drawing is disabled.

Validation: signed macOS/iOS builds and seven focused native tests passed; workspace
build/typecheck and 4,671 tests passed (two skipped). Protocol generation left
no drift; token mirrors passed. Design lint remains the existing 92 findings in
this built checkout (89 tracked baseline plus three generated-output findings).
Installed the signed app in /Applications and inspected the actual dashboard:
five live session creatures visible, readable timeline/chat, and central staging
clear of weather and side panels. The existing external daemon stayed running.

This remains a preview with a 3D habitat and 2D live agents. It is not a claim
that native 3D agent models or sustained performance qualification are complete.
