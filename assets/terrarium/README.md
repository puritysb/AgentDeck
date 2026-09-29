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
