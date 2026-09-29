# 2026-09-22 — Dark garden art pass for the Apple aquarium preview

Authored a new garden through Blender MCP, retaining the original study as a
separate source. The reproducible script adds broad-leaf clusters, asymmetrical
stones, branching wood and a winding sand ribbon. Rooted leaf rotation animation
uses a closed 24-second loop supported by the existing native transform player.
The Apple USDZ shrank from about 2.9 MB to 2.2 MB; Android and EPD assets did not
change.

Actual macOS review exposed a bright water enclosure and a horizon seam absent
from the intended composition. Extended the enclosure and used a token-bound
unlit water material, reduced directional light and relaxed the global scrim.
The native dashboard now has a dark backdrop and lit foliage/rocks while keeping
its live session and timeline layers. Claude's canonical path receives soft
shading; Codex drift now respects neighboring home spacing. A 60-second simulated
three-session regression checks that processing marks remain separated.

Signed macOS/iOS builds passed. The macOS app was installed and its actual live
screen inspected after both lighting iterations; the external Node daemon stayed
running. Focused native tests: 23 passed. Workspace build/typecheck passed; the
first full test run raced an explicit protocol generation and failed its generated
Swift comparison. After generation completed, the complete suite passed 4,671
with two skipped. Protocol has no tracked drift; tokens pass and lint remains at
92 findings in the built checkout (89 tracked plus three ignored outputs).

This is still 3D scenery with live 2D agents, not a completed 3D agent replacement.
Apple fish body morph deformation, arbitrary-density label packing and sustained
frame-time/thermal qualification remain unverified. Leaf sway uses transform
animation to avoid relying on unsupported deformation claims. No store release.
