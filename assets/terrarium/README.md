# Android aquarium habitat

`aquarium-habitat.blend` is the authored Blender 5.2 source for the static habitat.
It was made locally with Blender MCP; no downloaded models or textures are used.
The retained fish study objects are hidden from rendering: live residents, agent
marks, labels and usage data belong to the Android runtime.

Regenerate the Android image from the repository root:

```sh
blender --background --python assets/terrarium/export-habitat.py
```

The 1280×768 PNG lives in Android `drawable-nodpi`. The e-ink layout on LCD and physical readers uses this cached habitat,
desaturated once for monochrome layout, with lightly shaded canonical creature
paths. Physical monochrome readers lift and quantize the background to fixed
16-level gray once at load time. Runtime edge plants and a small grazing snail
add local motion; bubbles are limited to LCD/color panels.
The full-color Android dashboard and other device dashboards are not changed.

Review exported images at the actual dashboard aspect ratio and creature size.
Do not bake UI labels, user data or animated residents into this background.

## Living aquarium study and TRMNL gallery

`living-aquarium.blend` is a separate Blender MCP-authored native 3D study. It
contains seven fish, a 24-second swimming circuit, tail motion, body deformation,
ribbon plants and branching driftwood. No third-party models or textures are used.

```sh
blender --background --python assets/terrarium/export-living-aquarium.py
blender --background --python assets/terrarium/export-paper-aquarium.py
```

The first command writes Android's bundled GLB and Apple's bundled USDZ. Android
uses Filament in an optional LCD-only preview activity; Apple uses RealityKit in
an optional preview sheet (iOS 18+/macOS 15+) and the selectable dashboard below.
The study fish are decorative, not actual agent sessions. Android keeps morph
channels; Apple currently uses triangulated geometry and the global transform
clip. Do not play the USDZ's overlapping per-node animation libraries together.

The paper export writes `paper-aquarium.png` and a 38,400-byte flash-resident C++
bitmap. It uses a dedicated monochrome material pass and fixed spatial dithering,
not temporal dithering. TRMNL KEY1 selects the gallery; KEY2 returns home. The
image stays fixed while routine footer updates coalesce for 60 seconds. Urgent
attention bypasses that interval; the existing periodic panel cleanup remains.

This is a renderer/composition prototype. Art direction, agent-state integration,
sustained frame-time/power measurements and final device approval remain release
gates. The universal Android APK grows substantially with the native renderer.

## Dashboard selection

Apple and Android now embed the native habitat beneath their existing live HUD
when selected in Settings → Dashboard type. Selection is device-local and
persistent; it does not replace session state, connection controls or usage data.
The standalone preview entry remains a diagnostic compatibility path.

Apple now renders live agent meshes and their labels in the same RealityKit scene
as the habitat. The regular 2D renderer remains the default and a load-failure
fallback; it is no longer composited into the successful 3D path.

Stable preference IDs are `standard` and `aquarium3d`; Android also offers `paper`
on LCD. Android's existing effective panel classification still chooses the
physical-reader path and its waveform policy. Missing, unknown or unsupported
types resolve to the existing default without rewriting the stored choice.
Apple exposes 3D only on iOS 18+/macOS 15+. Settings remains reachable in 3D even
when the optional settings icon preference was previously hidden.

To add another type, extend `DashboardType` in Android `DisplayPreferences.kt`
and Apple `AppPreferences.swift`: add a stable storage ID, title/description,
capability rule and renderer routing. Keep hardware classification independent
from visual style. Preserve shared HUD/control layers, release native renderer
resources when switching, and verify restart/fallback behavior.

## Dark garden (Apple preview)

The Apple dashboard now bundles `dark-garden.blend` through the existing USDZ
resource name. The original study and Android GLB remain available unchanged.
Rebuild this candidate explicitly after exporting the original study:

```sh
blender --background --python assets/terrarium/build-dark-garden.py
blender --background --python assets/terrarium/export-living-aquarium.py -- --source dark-garden.blend --target apple
```

The deterministic authoring script retains the original swimming hierarchy and
creates asymmetrical stones, broad-leaf planting, branching wood and a winding
sand ribbon. Rooted leaf transform tracks close on the same 24-second loop and
survive the Apple export without requiring morph support. Fish body shape-key
animation remains outside the Apple compatibility claim; existing tail/yaw
transform animation remains. Native water uses the dark palette's unlit material
to avoid a reflective backdrop/horizon seam. Lighting and the HUD scrim are tuned
in the actual macOS scene, not inferred from the Blender render.

Claude's canonical silhouette gains restrained top-left shading. Codex horizontal
drift is bounded by the neighboring home spacing, preserving distinct marks for
three simultaneous processing sessions. This does not promise arbitrary-density
label packing. The native-resident section below supersedes this first hybrid composition.
Sustained GPU/power profiling remains future work. Android and physical e-ink assets were not replaced here.

## Native 3D residents (Apple)

**Character identity is an invariant.** Preserve each original character's full
silhouette, face, proportions and brand color. Do not replace it with another
animal or reduce the original to a badge. The aquatic-body experiment was
rejected by the user and is superseded by this restoration.

`build-3d-residents.py` imports the original six SVGs from `design/brand` as the
actual full-size character geometry. It adds restrained extrusion and edge
softening; rear closures follow the original outer contour without convex
casings, bumps or a second body. Facial details stay on the front. No invented
eyes, fins, tentacles, shells or chest badges are added. It writes editable
`3d-residents.blend` and bundled `3d-residents.usdz`:

```sh
blender --background --python assets/terrarium/build-3d-residents.py
```

Claude's original pixel arms and four feet are split at their existing body
junctions, retaining the rest silhouette. OpenClaw's original SVG claw paths
receive pivots. Other characters retain their source shapes with restrained
whole-character motion. The native template loader preserves USD ancestor
axis conversion; SVG point radii are reset after normalization before extrusion.

`AquariumResidents.swift` projects canonical TerrariumState residents, preserving
Codex folding and OpenClaw presence. Original bottom characters retain fixed
substrate contact; there is no vertical bob, roll or whole-body breathing scale
at contact. Water characters retain their original cloud/ghost/mark forms,
without fins or tentacles. Per-session phase and state blending remain continuous.
Dense bottom rows have bounded height/depth. Native picking, label width limits,
accessible SwiftUI roster, Reduce Motion, scene pause and 2D fallback remain.

macOS is installed and visually reviewed. iOS compiles but was not physically
reviewed in this iteration; Android/e-ink retain their previous renderers.

`AquariumShoal.swift` extracts the authored fish geometry and replaces the seven
baked fish routes with fourteen runtime swimmers. Bounded continuous steering,
neighbor separation/alignment, soft water bounds and resident avoidance create
local changes in flow; tail strokes follow integrated phase. Habitat plant
animation remains on the original USD scene clip. Fish remain decorative and
do not imply agent activity. This is a behavioral simulation, not fluid dynamics
or collision against every plant mesh.

Regression coverage checks projection clearance for 1–48 residents in portrait
and landscape, roster-update stability, state-transition continuity, reduced
motion, asset extraction, and two-minute shoal bounds with resident disturbance.
Crowded mixed bottom/water composition, 48-resident readability and frame time
still require visual/device profiling;
the layout test alone does not establish performance at that density.

Contact regression tests verify idle/working feet against the actual generated
substrate surface, fixed support positions, removal and non-bobbing original
cloud motion. Character-identity checks reject replacement anatomy and preserve
Claude’s wide pixel proportions and original four feet.


### Solid fins and quiet freshwater fauna

`build-dark-garden.py` invokes `enhance-garden-fauna.py` before saving. The
caudal membrane is closed with 0.045 Blender-unit thickness and its origin is
rebased to the peduncle; other fins receive the same thin volume. This prevents
back-face loss and body-centered tail orbiting. An edge-on fin may still look
thin naturally; no billboard or always-facing-camera replacement is used.

The native garden includes one rounded spiral-shell snail. The shrimp experiment
was removed following visual feedback; do not restore it when rebuilding. Apple
extracts a single runtime snail from the asset and hides its authored counterpart.
It is rendered at 60% of the authored size. `AquariumShoal` replaces the short
baked rock loop with a six-minute continuous ground circuit, passing in front of
and behind both planted islands. Position follows the authored bowl/sand height;
heading and pitch follow the path tangent. Ordinary depth occlusion can hide it
behind rocks or plants. There is no forced visibility or visibility teleport.
The native controller inherits the resident scene's pause/Reduce Motion behavior.
This is a bounded authored route, not arbitrary-mesh surface navigation. The
Blender rock loop remains an authoring preview, not the native movement source.

The Apple import regression checks actual exported fin volume and hinge position,
fauna counts and animation availability. Blender mesh inspection verifies closed
caudal boundaries. Frame pacing and every possible viewing angle still require
visual evaluation; these structural checks do not establish photorealism.

## Android native residents and performance

`export-android-residents.py` exports the approved `3d-residents.blend` source
into six individual glTF assets under `android/app/src/main/assets/residents/`.
It restricts export to the selected resident in the active scene; other Blender
scenes must not leak a default cube into the template. Asset tests verify this.
The planted Android habitat is exported from the committed `dark-garden.blend`.

Both native clients use the generated foreground budget of eight residents,
prioritizing selection and input requests without removing sessions from the
roster. Android uses a separate Filament surface for the habitat and creatures;
labels and dashboard panels retain display resolution. The surface's long edge
is bounded to 1440 pixels normally and 960 under power/thermal constraints.
A 512-pixel shadow map, disabled MSAA/AO/bloom and FXAA reduce GPU work. Thermal
and power state are sampled every two seconds rather than on every frame.
The e-ink renderer remains separate.

On the connected Lenovo tablet, SurfaceFlinger measured native scene cadence
improving from 8.380 to 29.836 fps with thermal status 3 in both samples;
main UI cadence improved from 13.211 to 58.522 fps. Normal-temperature 60 fps
is a target, not a measured guarantee. The user confirmed visibly smoother
movement after installation.


### Native visual fidelity

Antigravity uses Google's official full-color press PNG, retained byte-for-byte
as `design/brand/antigravity-color.png`. `build-3d-residents.py` fits its occupied
bounds to the unchanged canonical SVG and packs the same image into USDZ and
glTF. This preserves the broad blue base and warm crown instead of approximating
them with a linear rainbow. The gray brand chip remains for monochrome surfaces. Neither the SVG
silhouette nor any other character's anatomy changes.

Android keeps stable entity IDs for anatomical joints, fish and the snail.
Filament transform instances are temporary storage indices: the habitat animation
transaction can reorder them, and removing a resident can move them again.
Resolve an instance immediately before reading or writing it. Caching these
indices detached OpenClaw's claws and could animate an unrelated mesh.

Native vertical field of view is generated from `shared/src/terrarium-rules.ts`.
Android's water uses the existing deep-sea color converted from sRGB to linear
before reaching Filament, with restrained ambient fill. The two-line resident
label uses a readable backing and semantic status colors. Its IBM Plex face is
packaged at build time from the canonical `bridge/assets/fonts/` directory.

Bottom residents rest on the same `aquarium_substrate` mesh authored in the
resident Blender source, exported to USDZ and `residents/substrate.glb`. Imported
foot bounds determine contact height; fixed shelves do not move with work steps.

The cropped-scene color/geometry correction measured 30.142 fps at the 1200-pixel
thermal budget, versus 30.161 fps at 960 pixels on the same tablet (thermal
status 3). The subsequent full-canvas composition uses the 960-pixel thermal limit again
to account for its larger render area.

## Hermes replacement method study

`reconstruct-hermes.py` and `evaluate-hermes-reconstruction.py` reproduce an
image-to-mesh comparison with TripoSR. They write ignored diagnostic outputs,
not app resources. The study was visually rejected; facial/accessory fidelity,
surface quality and animation topology remain open in #428. See
[the Hermes research](../../docs/hermes-agent.md#production-modeling-research-and-replacement-gate)
for pinned dependencies, sources, measured results and the production sequence.
The original Nous girl outranks `references/hermes-mermaid-reconstruction-v5.png`,
which is an experimental input, not an approved replacement design.


## Connected Hermes character candidate (v6)

This candidate does not replace the bundled `hermes-mermaid.usdz`. The original
Nous girl likeness and final surface quality remain incomplete; see the single
assessment in [the Hermes study](../../docs/hermes-agent.md#connected-character-candidate-v6-not-bundled).
`build-hermes-character.py` writes the editable `hermes-character.blend` and its
USDZ/GLB exports; they are build outputs, not committed (`.gitignore`). Rebuild
them with the first command below, or download the reviewed v6 outputs from the
[`assets-hermes-character-candidate`](https://github.com/puritysb/AgentDeck/releases/tag/assets-hermes-character-candidate) prerelease. The rig contract stays in
`hermes-character-rig.json`. `build-hermes-portrait.py` is the head-authoring
module; its separate study `.blend` stays in diagnostics. The normalized CC0
source subset and attribution are retained under `sources/`.

```sh
blender --background --python-exit-code 1 --python assets/terrarium/build-hermes-character.py
blender --background --python-exit-code 1 --python assets/terrarium/evaluate-hermes-character.py
xcrun swiftc -parse-as-library assets/terrarium/validate-hermes-character.swift -o /tmp/hermes-asset-check
/tmp/hermes-asset-check assets/terrarium/hermes-character.usdz
xcrun swiftc -parse-as-library assets/terrarium/render-hermes-character.swift -o /tmp/hermes-native-preview
/tmp/hermes-native-preview assets/terrarium/hermes-character.usdz diagnostics/hermes-mermaid/character-v6/native-neutral.png
/tmp/hermes-native-preview assets/terrarium/hermes-character.usdz diagnostics/hermes-mermaid/character-v6/native-blink.png blink
```

Tested with Blender 5.2.2 and the local macOS RealityKit SDK. The builder creates
neutral front/portrait/profile, working/waiting joint poses and full-blink
renders. The evaluator checks weights and zero expression defaults, records
source/export hashes and topology counts, and renders four 96 px views. Native
import checks include clone isolation and repeated weight application. Neither
these standalone checks nor the authored poses establish app integration,
full deformation coverage, visual acceptance or physical-device performance.

## Hermes: 2D turnaround first, then 3D by measurement

Hermes is designed as a consistent set of 2D views before any mesh work. The
brief for the image generator is `references/hermes-turnaround-brief.md`: it
lists the views, canvas rules and the design decisions the user has already
made. The generated views go under `references/turnaround/`.

`fit-hermes-views.py` measures a built model against those views. For each view
it segments the reference by colour into hair, light (skin, eyes, headset) and
teal. It then renders the model from the matching orthographic camera with the
same flat class colours, normalises both to the same height, and reports IoU
per class plus the hair height/width ratios. Overlays go next to `fit.json`:
red is reference only, cyan is model only, grey is shared.

```sh
blender --background <model.blend> --python assets/terrarium/fit-hermes-views.py -- \
    --views front=<front.png>@0 three-quarter=<tq.png>@45 profile=<side.png>@90 back=<back.png>@180 \
    --out diagnostics/hermes-mermaid/fit
```

These are proportion checks, not an aesthetic score. Against the older
`hermes-mermaid-turnaround.png` (no headset, different face), the v18 model
reports hair IoU 0.54 (front), 0.53 (side) and 0.70 (back). Its hair height is
0.47 against the turnaround's 0.54: the model's hair is short relative to its
body.

## Hermes v19: measured head blockout in the app model

The bundled `hermes-mermaid.usdz` now carries the v19 head, authored in
[`hermes-head/`](hermes-head/NOTES.md). The head is a grey blockout, fitted by
measurement: to the head-study front/profile, and to the master concept at a
fitted camera (yaw 32°, elevation 4°). Its parts:

- a skull/face cage;
- one hair mass with the measured fringe hem;
- flicked locks on her right, the layered side as drawn;
- the headset band and clasp.

Shape changes are addressed vertex moves in `hermes-head/edits.json`, never
retuned seed formulas.

`build-hermes-mermaid.py` keeps the v18 body, rig, export and schema-2 contract;
`hermes-rig.json` is unchanged. It imports the head through
`hermes-head/head_v19.py`:

- **Frame:** 1 blockout unit = 1/8.696 m, bang line → HEM_Y, chin → CHIN_Y.
- **Hair facets:** flat-shaded diamond facets along the designed flow grid
  (`facets.py`). No Decimate.
- **Flick locks:** hung from the existing `hermes_hair_left/right` sway joints.

Face decals use the v18 drawing code with proportions re-measured from the
guide (`hermes-head/face_v2.py`): eyes higher and wider apart, a heavier lid,
a smaller iris set toward the nose, and brows between the liner and the hem.

`decal()` changed in three ways for the round v19 face:
- scanfill triangulation;
- no decal edge left longer than 7 mm;
- a ray that hits the face's side is kept. v18 snapped such vertices to the
  surface nearest (x, y, .2), which threw them onto the front.

The last two removed dark chips above the closed lids that appeared only in
RealityKit.

```sh
sh assets/terrarium/hermes-head/run.sh <review_dir>        # blockout -> hermes-head-blockout.blend
blender --background --python-exit-code 1 --python assets/terrarium/build-hermes-mermaid.py   # installs usdz/glb/blend
```

**Hair topology:** the visible hair is the sculpted cage with designed facets along its flow grid (`hermes-head/facets.py`); no Decimate. Hand-laid lock planes (`build_lock_planes.py`) were tried and dropped: they read as stepped blocks next to the master.

**Face pass:** `hermes-head/face_paint.py` adds the nose form and bakes a measured shading texture (`hermes-head/face_shade.png`, regenerated per build and packed into the USDZ); the nose decal is gone.

**Iteration loop and final review (2026-10-01):** `hermes-head/iterate.sh <dir>` judges the installed model against the master concept (fitted camera, landmark solve, RealityKit renders); see `hermes-head/NOTES.md`.

**Verification (2026-10-01):**
- `HermesAquariumTests` (9 tests) pass on macOS with the bundled asset.
- RealityKit review renders (neutral, three-quarter, side, blink) are in
  `diagnostics/hermes-mermaid/nous-v19/` (ignored).
- Triangles: 148k (v18 142k). USDZ: 7.5 MB (v18 6.8 MB), including the 1024² face shading texture.

**Not established:** physical-device frame time, and the user's visual acceptance.
