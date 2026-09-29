# 2026-09-22 — Replace the Apple hybrid resident layer with native 3D agents

The hybrid scene kept agent sprites outside the habitat lighting/depth system.
Added six Blender-authored solid mascots from canonical upstream SVG paths and
brand tokens, with bevels, rounded bodies, cloud lobes, feet and claws. Native
RealityKit entities replace the 2D Canvas residents in the selected 3D dashboard;
the regular dashboard and asset-load fallback retain the existing renderer.

The native projection preserves the authoritative roster, Codex folding and
OpenClaw presence. It reconciles departures, carries activity/observed child
counts, renders 3D labels, and uses existing focus commands through native picking.
Empty water toggles the HUD. Movement is bounded with shared scene updates,
Reduce Motion and visibility pause/resume; subscriptions use weak owner captures.

Actual installation review caught two import errors: curve radii retained SVG
unit scaling, inflating bevel/extrusion; and extracting templates lost the USD
ancestor axis conversion, laying the marks flat. Both were corrected and covered
by native asset-bounds/orientation regression checks. Runtime clicking selected
the Codex session and filtered its timeline; clicking again cleared focus, and
background clicks hid/restored the panels. Private timeline screenshots remain
local. The existing Node daemon was not restarted.

This is an Apple-only native 3D scene with stylized mascots, not a claim of
photorealistic anatomy, articulated gait, completed fish morph support, or measured
sustained GPU performance. Other targets retain their current renderers. No store
submission or public release is part of this change.

Validation: final signed macOS/iOS builds passed; 25 focused native tests passed,
including bundled geometry bounds, extracted-template orientation, live removal,
focus identity, presence, child counts and paused transforms. Workspace build and
typecheck passed; 4,671 tests passed with two skipped. Protocol generation leaves
no drift, tokens/docs/catalog pass; design lint remains at 92 built-tree findings
(89 tracked baseline plus three ignored outputs). Final macOS app is installed;
iOS compilation is not a claim of a new iPad installation.
