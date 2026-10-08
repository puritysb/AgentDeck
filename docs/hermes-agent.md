# Hermes Agent integration study and observer preview

Tracked in [#423](https://github.com/puritysb/AgentDeck/issues/423). Research pinned
to `NousResearch/hermes-agent@16c59d0e7876383de7377f12bf0708f08246d063` on
2026-09-30. This is an opt-in Node/deck preview, not whole-product support.

## What actually identifies Hermes

| Symbol | Evidence and current use | AgentDeck decision |
|---|---|---|
| Nous girl, monochrome face | [Official icon generator](https://github.com/NousResearch/hermes-agent/blob/16c59d0e7876383de7377f12bf0708f08246d063/scripts/generate_icons.py) declares `assets/nous-girl-{black,white}.svg` as the source; the current [desktop BrandMark](https://github.com/NousResearch/hermes-agent/blob/16c59d0e7876383de7377f12bf0708f08246d063/apps/desktop/src/components/brand-mark.tsx) uses it. App icons and website favicons derive from it. | Use the existing Lobe Icons package's normalized Hermes mark unchanged for shared deck identity. |
| Caduceus, ☤ | [Official default skin](https://hermes-agent.nousresearch.com/docs/user-guide/features/skins/) uses a gold caduceus banner and response label; `hermes_cli/banner.py::HERMES_CADUCEUS` contains the actual art. | Authentic CLI symbol; a candidate for tiny displays after readability review, not a newly invented animal. |
| Winged-helmet messenger carrying a caduceus | [Original `hermes.png`](https://github.com/NousResearch/hermes-agent/blob/16c59d0e7876383de7377f12bf0708f08246d063/apps/desktop/public/hermes.png), [eight-pose sprite](https://github.com/NousResearch/hermes-agent/blob/16c59d0e7876383de7377f12bf0708f08246d063/apps/desktop/public/hermes-sprite.png), and `hermes-frames/` exist in the upstream repository, introduced by desktop PR #20059 on 2026-05-31. Current desktop source does not reference these filenames. | A real upstream character reference, **not the current default app mascot**. Its presence alone does not establish any current in-app use. |
| User-selected Petdex pet | [Official pet documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/pets/) says floating pets are off by default and appear only after a user installs and selects one. | A user's optional pet choice does not define Hermes's brand; Hermes has no default floating pet. |

The Nous girl SVG normalization is from `@lobehub/icons-static-svg@1.94.0`, the
same pinned MIT package used by the existing agent marks. The original path
geometry is preserved in [hermes.svg](../design/brand/hermes.svg); provenance is
in [the resource map](../design/RESOURCES.md). It is a third-party identity mark,
not an AgentDeck mascot or a claim of endorsement. Invented shell/crab/animal
characters are explicitly excluded by the user's direction.

The Apple aquarium creature implements the user's requested mermaid
derived from the Nous girl portrait: preserve her dark bob, bangs, pale face,
and recognizable silhouette while adding an underwater body and motion. This
is an AgentDeck-original adaptation, not an official Hermes mascot. The
winged messenger remains a separate upstream illustration reference, not the
chosen aquarium creature. The compact brand mark in this preview remains the
unaltered Nous girl geometry.

## Native aquarium motion

**Figure adaptation of the official mark (2026-09-30).** The identity source is
the official Hermes Agent mark (`design/brand/hermes.svg`, the Nous girl). The
generated concept sheets are **not** the source: they drifted to a round chibi
face and low-poly facets that the mark never had, and a faceted chibi rebuild
from them was rejected for exactly that face shape. The model adapts the mark
the way figure lines (Nendoroid-style) adapt a mature character. The head and
eyes grow and the lower face shortens, but every trait that identifies her in
the mark is kept:

| Trait in the mark | Model |
|---|---|
| Oval face tapering to a soft point | Analytic face with a chin taper and receding jaw (`face_z`); never a round face |
| Long almond eyes, heavy upper lid covering the iris top, bold lash line with an outward tail, lid crease, thin lower line | Decal eye at a ~1.6:1 opening. The iris is clipped under the lid. Crease and lower line are separate strokes |
| Small hooked nose stroke; small, dark, defined lips | Soft stroke; dark upper lip with a cupid's-bow dip, lighter lower lip |
| Heavy blunt fringe to the lashes; side locks framing the cheeks; one stray strand over the cheek | Fringe sheet with a few splits; outer locks drop along the cheeks; `stray_strand` |
| Jagged gloss band across the crown and fringe; small crescent sheen at the side | Real reflections on glossy hair with shallow strand grooves (not decals) |
| Long bob whose ends flip outward in C-curls | Shell ends roll out and up; the `hermes_hair_*` curls sway |
| White headset band with its yoke | Band over the crown sinking into the hair, a yoke at each side; earcups under the hair |
| Ink on cream, smooth (no facets) | `ink-900` / `tide-50` tokens, smooth shading |

**Reading the mark correctly (2026-09-30).** The mark's white arc is a
**headset**, not a headband: the small shape where it meets the hair is the
yoke, and the earcups are hidden under the hair. Its white strokes on the hair
and the line of the face contour are **light**, not drawn lines. An experiment
that copied them literally (ink outlines, cream gloss decals, unlit materials)
read as a print sticker and was rejected in favour of the lit model. The
model therefore has:

- A headset band over the crown that sinks into the hair at both sides, with a
  rounded yoke at each entry point. The earcups are omitted because they are
  covered by the hair.
- Satin black hair (roughness .52): one smooth mass with shallow, irregular
  strand grooves, so the highlight breaks into the jagged band the mark draws.
  It comes from real reflection, not a decal. A lacquer finish (roughness .30)
  read as plastic. The only separate pieces are the two swaying ends, short
  flips at the hem. Longer clumps stood off the shell as panels beside the ear.
- The band stops at its yokes (±1.40 rad) and tucks into the hair there. Run
  further, it showed as a white strip beside the cheek in profile.
- The face follows the mark's calm expression rather than a wide-eyed chibi
  one. It is an oval narrowing to a gently pointed chin. The almond eyes have
  a heavy lid over the top of the iris, and the iris rests on the lower lid.
  The lips are small and full. Tilting the lid line toward the nose read as
  anger, so the tilt stays small.
- Feature details are read off the mark itself. The mark hides the brows under
  the fringe, but on the figure their absence read as a different person. Fine,
  softly arched brows sit just under the hem (`BROW_Y`); there is no lid
  crease. The
  upper lashes are one heavy mass ending in three spiky outer lashes, with
  small spikes on the lower lash line. The iris is solid ink with its highlight
  at the upper outer side. The nose is a single hooked nostril stroke. The lips
  are a dark M-shaped upper lip over a fuller lower lip, placed about 60% of
  the way from eye to chin.
- The hair falls in a few broad, uneven locks, not fine equal ridges. The ends
  flip out and up; a wide flare read as a bell.
- The bangs are the front of the hair shell itself (`FRINGE_K`), ending in one
  continuous blunt hem. A separate fringe sheet showed as a seam across the
  crown or a boxy visor, and notched splits read as bangs broken in the middle.
- The body and tail are smooth. Diamond facets made the figure read as if it
  were made of pieces.
- Torso, arms and hands are **one fused surface**: voxel remesh plus smooth,
  with torso rings resampled by Catmull-Rom (straight segments showed as
  bands). Separate tubes and balls met the torso in visible steps. Skin
  weights are computed per vertex. A vertex belongs to the arm only if the
  arm's source surface is nearer than the torso's (`TORSO_BVH`); proximity
  alone let hip skin follow a waving arm and stretch into spikes. Arm
  ownership blends in across the shoulder. The skin/teal neckline is snapped
  onto its curve after remeshing.
- **Low-poly hair after the user's chosen concept crop (2026-10-01).** The bob is
  larger and rounder (`RX .272`), collapse-decimated to about 3.5% and
  flat-shaded, in near-black. The ends are shaped into the shell as broad
  pointed locks that flick out and up (`tooth` in `column()`). Separate flick
  clumps read as boxy flaps or sticks, and sharper teeth read as horns from the
  front. The bangs carry a few pointed splits in the hem, not separate strand
  pieces, and have no strand ridges, which read as slats. The headset band sits
  forward, just behind the bangs, and is wider. Its clasp is a round white end
  with a black dot and a small hook, after the concept. The swaying locks are
  now rig joints only, at the longest side locks.
- The iris sits high under the heavy lid, as in the mark. The jaw is a long,
  nearly straight line to a small soft chin. Below the crown the hair falls in
  a gentle wave: each lock swings side to side and in and out, with a phase
  that drifts around the head.
- No ink outline. The silhouette comes from lighting, as in any lit figure.

**The face is designed in 2D first.** `assets/terrarium/hermes_face.py` is the
single source for the face: outline, eyes (almond, heavy lid, bold liner with a
thin wing, crease, lower lash, near-black iris), nose shadow and lips, all in
head units. `python3 assets/terrarium/hermes_face.py <dir>` writes the review
sheet. The user approved that sheet before any mesh was built. The Blender
builder imports the same functions: the head's front width follows the sheet's
outline, and every feature decal is a sheet shape projected onto the face. What
is approved on the sheet is what lands on the model.

Earlier face variants were tuned as numbers inside the 3D builder and never
matched an approved face. They kept reading as a mannequin or a Mii, so they
were discarded. The design tokens' ink family is green-tinted, so the sheet
keeps each token's lightness and drops its hue. Otherwise the eyes and lips
read teal.

Construction rules, each learned from a rejected render:

- **The head is built from silhouettes, not a warped ellipsoid.** A cube-sphere
  is mapped onto three curves: front width, front profile and back profile.
  Each horizontal section is a superellipse, flatter at the front. The curves
  give a cranium over a face plane, cheeks that hold below the eyes, and a jaw
  converging to a small chin. An ellipsoid tapered toward the chin read as a
  mannequin egg in every variant.
- **The head is fitted to the sheet**, with a small nose bridge added so the
  three-quarter view has a profile.
- **No custom split normals on the face.** Bending face normals toward a sphere
  is the usual anime trick, but after Blender's USD export it renders as a
  dotted speckle in RealityKit (verified against a no-normals control).
- Face artwork is decals projected onto the face mesh (BVH). Each triangle is
  oriented against the surface actually under it, because RealityKit culls back
  faces and Blender does not. The builder asserts that none points into the
  head.
- **Hair is a collapse-decimated shell with the mark's silhouette, plus a few
  clumps.** The large irregular planes match the concept's faceted bob. A fully
  smooth shell read as a helmet; thirty-odd separate clumps read as messy
  curtain stripes. Clumps are reserved for the flipped ends (one per side is
  the swaying `hermes_hair_*` lock) and a few pointed bang tips.
- Skin is warm `tide-100`; the arms reach the hips, with a mitten hand and thumb.
- Side curtains wrap the face at eye level and fall back only below the cheek.
  Pushing them back higher exposes the face edge.

The schema-2 contract (13 bones, face/hair controls, `mouth_open` and
`closed_lid_*`) is unchanged, so `HermesMermaid.swift`/`HermesSwim.swift` need
no edits. All 9 `HermesAquariumTests` pass on macOS against the installed USDZ.
`render-hermes-character.swift` mirrors the rig's initial hiding and takes
`blink` to show the closed lid. On 2026-10-03, the Debug iOS app rendered the bundled model in the
actual aquarium on an iPad Air M2 simulator (iPadOS 18.6), pinned to a
loopback synthetic capture feed. The face, working cue, session roster and
timeline rendered together; the local evidence is
`diagnostics/release-acceptance/hermes-ipad-simulator.png`. This is simulator
rendering evidence, not physical-device acceptance. The physical iPad was
unavailable, and the user's visual acceptance of the 3D face remains open.
Passing tests is not visual acceptance.

The Blender source is `assets/terrarium/hermes-mermaid.blend`, reproducibly
built by `build-hermes-mermaid.py`. Apple bundles its USDZ; the builder also
writes a portable GLB for the later Android renderer. That GLB is a build
output and is not committed (`.gitignore`): rerun the builder to regenerate it. The model has
13 deformation bones across spine, continuous tail, split fins, shoulders,
elbows and wrists, plus independent head, gaze, lid, brow, lip and hair controls.
Seven source meshes are skinned; RealityKit imports them as one skeleton.
Rest-relative poses prevent accumulation and shared-instance mutation. Closed
lids and mouth geometry must be exported visibly, then hidden by the controller;
Blender omits render-hidden meshes from USD export. The app's `HermesSwim` controller
owns bounded three-dimensional travel, damped velocity, banking, delayed tail
and fin strokes, blinking, neighbour greetings and state transitions. Nearby
idle residents can turn or wave back; these are cosmetic social behaviours,
not evidence of collaboration. Work only accelerates from observed processing;
waiting raises a hand, and working-to-idle triggers one short settling gesture.
Actual active-child counts remain explicitly labelled. No peer task assignment
is invented from proximity, project names or model providers.

The same observed Hermes identity is rendered in Apple's Canvas fallback,
with selection and name tags. Reduced Motion stops swimming and articulation;
state labels still update. Meshes and rig handles are cached per resident and
removed with the session. `preview-hermes-motion.swift` samples the real motion
controller; `render-hermes-preview.py` renders that trajectory with Blender for
visual review (outputs under ignored `diagnostics/hermes-mermaid/`).

### Production modeling research and replacement gate

Tracked separately in [#428](https://github.com/puritysb/AgentDeck/issues/428).
The target is a convincing stylized 3D Nous girl mermaid: preserve the original
face/accessory while making anatomy, surface volume and deformation credible.
Photographic human skin is not an accepted change in art direction.

The replacement sequence is **reference alignment → head sculpt → deformation
topology → body/arm sculpt → rig and corrective shapes → export/reimport →
actual aquarium review**. Finish and compare the neutral head before adding more
animation. A dense mesh, named bones, a beautiful generated illustration or a
successful export does not establish visual quality.

| Primary source / tool | What it contributes | Decision for this character |
|---|---|---|
| [Blender Human Base Meshes](https://www.blender.org/download/demo-files/) (v1.4.1, CC0) | Connected stylized head, eye and body topology; suitable sculpt starting point | Tested locally. Generic anatomy does not preserve Nous girl's identity without deliberate sculpting. |
| [Blender retopology](https://docs.blender.org/manual/id/4.0/modeling/meshes/retopology.html), [shape keys](https://docs.blender.org/manual/id/dev/animation/shape_keys/introduction.html) | Deliberate deformation edge flow; relative vertex shapes for expressions/corrections | Author eye/mouth loops and joint deformation, then validate combined expressions. Automatic quad conversion alone is insufficient. |
| [Blender USD export](https://docs.blender.org/manual/id/5.2/files/import_export/usd.html) | Armatures and relative shape keys; approximate preview materials | Skinned export does not apply arbitrary modifiers. Bake applicable surface work before shape keys, and prove skin/blendshape behavior in RealityKit. Blender's Preserve Volume preview is not portable runtime evidence. |
| [Meshy multi-image API](https://docs.meshy.ai/en/api/multi-image-to-3d), [rigging API](https://docs.meshy.ai/en/api/rigging) | Image-conditioned sculpt starting point; standard humanoid skeleton service | Account/API access is not configured in this session. Its documented biped restriction means mermaid tail/facial rigging remains custom work. No paid generation requested. |
| [TripoSG](https://github.com/VAST-AI-Research/TripoSG) | Image-conditioned shape generation | Official installation requires CUDA GPU with at least 8 GB VRAM; this Mac has Apple M4 / 16 GB unified memory. Not run. |
| [Stable Fast 3D](https://github.com/Stability-AI/stable-fast-3d) | UV/material reconstruction; experimental MPS support | Gated model access required. Official guidance recommends CPU below 32 GB unified memory. Not run. |
| [Hunyuan3D 2.0 license](https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/LICENSE) | Local shape/texturing pipeline | License explicitly excludes South Korea; not adopted or executed. No model weights downloaded. |
| [TripoSR](https://github.com/VAST-AI-Research/TripoSR) | MIT image-to-mesh baseline | Actually run on this Mac, with neural inference on MPS and marching cubes on CPU. Useful method comparison, rejected as production geometry. |

Two local experiments were evaluated rather than promoted:

- **CC0 topology + procedural sculpt:** actual connected face and 13-bone body,
  five relative facial shapes, and editable Blender source. Rejected: generic
  doll face, folded headband, jagged neckline and collapsing forearms. Explicit
  zero-valued, independent shape keys fixed an accidental combined-expression
  default, but did not solve identity or deformation. Preserved under ignored
  `diagnostics/hermes-mermaid/sculpt-source/`, not bundled in either app.
- **TripoSR reconstruction:** 37,036 vertices / 73,960 triangles; 24.69 seconds
  in the initial measured run on M4 MPS. Actual imported GLB views at 0/45/90/180
  degrees and 640/96 px show a closer overall silhouette but blurred facial
  features, an accessory fused into hair, lumpy hair surfaces and weak hands.
  The mesh is not watertight and has no skeleton or facial shapes. These are
  measured/observed limitations, not a quantitative aesthetic score. Rejected.

The source image `hermes-mermaid-reconstruction-v5.png` is a generated, neutral
arm-pose input derived from v4, not a new approved design or a mesh render. Its
alpha cutout is normalized by the upstream model preprocessing; image pixels are
not substituted for geometry during evaluation. Its head remains subordinate to
the official portrait. The local comparison is
`diagnostics/hermes-mermaid/modeling-method-review.html`.

#### Reproduce the image-to-mesh comparison

Use an isolated Python 3.11 environment with the pinned TripoSR checkout
`107cefdc244c39106fa830359024f6a2f1c78871`. The tested environment uses PyTorch
2.10.0, NumPy 1.26.4, Transformers 4.35.0, OmegaConf 2.3.0, Einops 0.7.0,
Trimesh 4.0.5, Pillow, rembg/onnxruntime, imageio, huggingface-hub 0.17.3,
and torchmcubes `879926d0ef58e6ce0ac2630fdecb5e53af7ed3ff` compiled for CPU.
The runner pins the TripoSR model snapshot, retains prior outputs, and writes
input hash, mesh counts, runtime, coordinate convention and absent rig features.
Model weights and isolated environments stay outside tracked assets.

```sh
PYTORCH_ENABLE_MPS_FALLBACK=1 <isolated-python> assets/terrarium/reconstruct-hermes.py --source <TripoSR-checkout>
blender --background --python assets/terrarium/evaluate-hermes-reconstruction.py -- --directory diagnostics/hermes-mermaid/reconstruction
```

The renderer corrects TripoSR's Z-up coordinates for Blender review only. Its
GLB is not a normalized, rigged runtime replacement. The existing app resource
is unchanged. Next production work starts with the original-matching neutral
head and separate head accessory; neither rejected experiment closes #428.

### Connected character candidate v6 (not bundled)

`assets/terrarium/hermes-character.blend` is a new, editable candidate, exported
alongside USDZ and GLB by `build-hermes-character.py`. These outputs are not
committed; regenerate them or download the reviewed copies from the
[`assets-hermes-character-candidate`](https://github.com/puritysb/AgentDeck/releases/tag/assets-hermes-character-candidate) prerelease. Its neutral face still fails the original Nous girl
likeness gate. It is **not** the app resource `hermes-mermaid.usdz`; the existing
app and its earlier 39 native tests continue to use that earlier model.

The candidate uses the credited CC0 Blender Studio head/body topology in
`sources/blender-studio-base.blend`. The crown accessory is separate from a
continuous bob. Neck proportions, curved tail cross-sections, fitted neckline
and shoulder/elbow/wrist bind positions were rebuilt. Hand weights are assigned
from source anatomy, never inferred from tail height. Tail rings use monotonic
arc-length ordering; the builder rejects reversed spans and hands bound to tail
joints. These guards cover defects observed in actual renders.

There are 13 deformation bones and 11 relative shape names: bilateral lid
closure, two intermediate lid corrections, smile, concern, jaw, brow lift/frown
and two lower-hair sways. Lids cover the actual eye surface without deforming
the forehead/nose. For blink fraction `t`, use closure weight `t` and the matching
middle correction `4*t*(1-t)`. All expressions and hair shapes start at zero.
The rig manifest is `hermes-character-rig.json`. This candidate has a different
face contract from the currently bundled rigid-control rig; copying its USDZ
into the app alone is not a valid integration.

`validate-hermes-character.swift` imports the actual USDZ using RealityKit and
checks required bones/shapes, neutral defaults, independent clone weights,
repeated application and Y-up bounds. `render-hermes-character.swift` captures
the imported mesh directly through RealityKit in an isolated review view,
without launching AgentDeck or its daemon. Blender and native images are kept
separate: Cycles lighting is not evidence of aquarium appearance.

| Candidate criterion | Current finding |
|---|---|
| Anatomy and tail topology | Sampled bent arms retain volume; hands no longer follow tail joints; the long folded tail seam is removed. All-angle extreme poses and finger articulation remain unverified. |
| Head accessory | Narrow crown band with one asymmetric hooked end; the visible floating/folded strip was corrected. |
| Original facial identity | **Incomplete.** Nose/lips, eye character and overall proportions still read as a generic stylized doll. |
| Hair silhouette | **Incomplete.** Continuous topology and smooth crown improve seams, but the bob and side locks remain too thick and helmet-like. |
| Expressions and finish | Native lid closure works without pulling down the whole forehead. Lid margins, garment/neck joins and expression combinations still need visual refinement; shader and small-scale readability are not accepted. |
| Aquarium motion | Not integrated. The builder's working/waiting images are authored pose exercises, not samples of the shipped Swift controller or evidence of live interactions. |

Reproduction commands and filenames are in `assets/terrarium/README.md`.
The local inspection page is `diagnostics/hermes-mermaid/character-review.html`.
Geometry and import checks are technical gates, not an aesthetic score. #428
and Draft #427 remain open; no perfection, approval or completed replacement is
claimed.

### Visual evaluation, 2026-09-30

`evaluate-hermes-model.py` renders the actual saved Blender model from fixed
front, three-quarter and profile cameras at 640 px and 96 px. The local review
compares the official Nous girl, the selected concept and actual before/after
renders. Baseline and revised **front** views share camera, scale and light;
the revised portrait/profile views face the source portrait's direction.
There is no automated aesthetic score or claim of user approval.

The latest user constraint is stricter than the initial cute concept: preserve
the original head accessory, bob/fringe, expression and facial proportions as
closely as possible. `hermes-mermaid-identity-v3.png` corrects the concept in two
image-generation passes, including removing a wrongly forked accessory tip.
The original portrait remains authoritative; this new reference is not yet
faithfully implemented in the USDZ or approved by the user.
The subsequent `hermes-mermaid-arms-v4.png` corrects the concept's paddle-like
arms with connected shoulders, bent elbows, wrists and asymmetric hand poses.
This is an anatomy reference only; its detailed fingers should be simplified
for the small runtime character. No corresponding USDZ update is claimed.

| Criterion | Observed result | Status |
|---|---|---|
| Original face | Eye scale, dark iris, liner and nose contour improved; the overall face still reads as a doll rather than the composed original portrait | Fail |
| Bob, fringe and band | Band width increased and fringe brought closer to scalp; large helmet-like masses, seams and lock tips remain | Fail |
| Mermaid silhouette | Torso shortened and tail swept back with matching bind joint positions; side-on fin volume still weak | Fail |
| Small appearance | Band and tail read at 96 px; expression differences remain weak | Fail |
| Waiting gesture | Initial raised hand was hidden behind the head; forward shoulder placement and yaw now bring it beside the cheek in the sampled close-up. All-angle clearance remains unverified | Partial |

The Blender preview sampler covers 33 seconds using the same numeric poses as Swift (idle, work,
waiting, error and transitions). Close-up travel is scaled to 20% and yaw to
65% for framing; it is not an app recording or an exact world-space trajectory.
Actual simulator composition must be assessed separately. Keep #427 Draft;
#425 remains open for visual redesign as well as device/native intake work.

## OpenClaw and Hermes have different observation contracts

| Dimension | Existing OpenClaw integration | Hermes observer preview |
|---|---|---|
| Live source | Authenticated Gateway WebSocket RPC plus complementary transcript tool rows | Python plugin callbacks inside the common agent core, across CLI and gateway |
| Visible identity | One virtual gateway row; session keys still scope timeline/APME | One observed conversation row, identified by a hash of profile home + native session ID |
| End of work | Gateway final-response event | `on_session_end` ends one run/turn; **only finalize/reset ends a conversation identity** |
| Response ownership | Gateway final response outranks message projections | Cache `post_llm_call.assistant_response`, emit one Stop on `on_session_end` with its actual outcome |
| Control | Gateway supports prompt/abort/approval RPCs | Observation only; no device approvals, prompt injection, terminal steering, or voice targeting |
| Memory and skills | Existing agent-specific telemetry | Report observed tool names; do not infer learning, intelligence, or growth from time/tokens |
| Model | Separate from harness identity | Always `agentType: hermes`; preserve supplied model name, do not relabel it as Claude/Codex |

Primary contract: [observer hooks](https://hermes-agent.nousresearch.com/docs/developer-guide/observer-hooks/)
and [plugin API](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/).
Gateway filesystem `HOOK.yaml` handlers are a separate gateway-only extension;
OpenClaw's gateway protocol cannot be reused simply because both products call a
component “gateway”.

Persistent memory is [profile-scoped and injected as a session-start snapshot](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/).
A `memory` tool call alone is not proof that a write succeeded. This preview
exports tool names only, so it deliberately makes no “learned a skill” claim.

## Try the preview

Requires an AgentDeck receiver advertising `hermesObserver: 1` in local health.
The default registry supports Node and unsandboxed Swift receivers; the App
Store sandbox/profile-discovery restriction is described below.
This branch does not restart an existing daemon or modify a Hermes profile.
Install explicitly into the intended profile:

```bash
agentdeck hermes-observer --home /path/to/hermes-profile
# In that same Hermes profile:
hermes plugins enable agentdeck-observer
```

Restart Hermes after enabling. Hermes owns enablement in its configuration;
AgentDeck never rewrites that configuration or enables the plugin implicitly.
Without `--home`, the installer uses `HERMES_HOME`, then `~/.hermes`.
An existing unowned plugin directory is refused. Disable with
`hermes plugins disable agentdeck-observer`, or set `AGENTDECK_NO_HERMES_HOOKS=1`
in the Hermes process environment.

The observer exports bounded prompt/final-response text (8,192 characters each),
model, platform, CLI working directory, tool name and its own process id to the
local daemon. It
never exports full conversation history, tool arguments/results, profile memory,
credentials, or provider request bodies. Profile paths/native IDs are hashed
for identity; CLI cwd is intentionally visible as project context.

One daemon worker serializes sends, with a 128-item queue, a five-second queue
age limit and bounded HTTP timeouts. Proxy settings and redirects are disabled.
Discovery reads `AGENTDECK_DATA_DIR/daemon.json` when explicitly configured,
otherwise the user's `.agentdeck/daemon.json`; it does not scan ports or
fallback to an old/native receiver that would misclassify Hermes hooks. Callback
failures are ignored; callbacks always return `None`. CLI exit allows up to one
second for queued events to drain. Transport is best effort, without retries or
persistent event storage. Losing events can leave incomplete timeline evidence;
30 minutes of silence retires a row without claiming task success.

A conversation also ends with the Hermes process that hosts it. One-shot mode
(`hermes -z`) runs `run_oneshot` and hard-exits through `os._exit`: it never
calls `finalize_session`, and the `atexit` chain is skipped by design. Measured
2026-10-02 on Hermes main `0a374d167`: the turn's Stop arrived
(`end_source=stop`), no finalize followed, and the row stayed idle with its APME
run open until the silence TTL. `hermes chat -q … --oneshot` does finalize. The
observer therefore reports its pid, and the Node daemon probes it on its
five-second coordination tick. When the process no longer exists (`ESRCH`), it
closes the conversation as a finalize would: the row leaves, a late callback
cannot reopen it, and the APME run closes. A refused or failed probe is
`unknown` and never closes anything. A row without a pid (an older observer)
keeps the silence TTL. One gateway process hosting several conversations is
probed once, and all of them close with it.

Child sessions with explicit parent IDs or observed `subagent_start` identities
are suppressed from the top-level deck. Parent census and subagent timeline
projection remain a rollout gate. Session/child caches are bounded.

## Validation and remaining rollout gates

- Shared packages, bridge and both deck plugins build via the repo workflow.
- Python tests drive real callbacks and loopback HTTP delivery, including
  receiver capability gating, interrupted turns, reset identity, child
  suppression, privacy bounds and queue saturation.
- Node tests cover session lifetime, mid-turn recovery, malformed callbacks,
  isolated conversations, stale cleanup and bounded retention.
- Brand tests compare all rendered paths to the pinned SVG, including
  monochrome negative space; generated protocol/prefix mirrors include Hermes.
- Local Hermes source at `6d42313deee63b13dbf2f262d9a31cf603d3f1bc` was inspected
  at `agent/turn_context.py` and `agent/turn_finalizer.py`. Its real Plugin Doctor
  loaded this plugin with all nine hooks and no findings, and confirmed identity separation using Hermes’s real
  context-local profile overrides. Doctor runs under a temporary home
  with sockets blocked during registration. This is runtime registration
  evidence, not a completed live model conversation.

A real CLI single-query run against that same installed commit used the
configured `zai` / `glm-5.3` provider in a temporary profile and empty workspace.
Its real plugin exported start, prompt, two terminal start/end pairs, one
successful Stop and finalization through loopback HTTP to an isolated Node
daemon. Hermes's approval policy declined `python3 -c`; it retried using shell
arithmetic and returned `323 OBSERVER_OK`. The daemon published the processing
row and removed it on finalization; APME stored the response, two tool calls,
`provider=zai`, `model_id=glm-5.3`, and `end_source=stop`. The scrubbed hook
sequence is checked in as
`bridge/src/__tests__/fixtures/hermes-cli-observer.json` and replayed by tests.
This proves one CLI turn, not multi-turn/reset/cancel or gateway coverage.
The isolated run disabled Hermes lazy installs after the first launch tried
automatic source completion; that automatic build was stopped. No tracked
upstream source or user profile configuration was changed.

On 2026-10-03, the installed managed Hermes runtime was exercised with the
real classic CLI (`--cli`) and real Gateway API server in temporary homes.
The checkout was `0a374d167424cdc730ce9761368b62255b551e58`; the managed
snapshot's CLI entry point, TUI input implementation, Gateway runner and API
adapter byte-matched that checkout. The configured `zai` / `glm-5.3` provider
served the successful turns. Lazy dependency installs were disabled.

| Live case | Observed result |
|---|---|
| Gateway, two turns in one API conversation | One start, two prompts and exactly two successful Stops; the conversation stayed idle between turns |
| Interactive CLI, two turns, `/new`, another turn, Ctrl-C mid-turn, `/exit` | Old identity finalized at `/new`; new identity began on its next prompt; cancellation carried `interrupted=true`; exit finalized |
| Gateway `/v1/runs/{id}/stop` | API settled as `cancelled`; observer emitted one interrupted Stop |
| Second profile home, terminal tool, SIGTERM mid-turn | One terminal start/end pair; successful reply, then an interrupted Stop on shutdown; process sweep closed the remaining run |
| CLI with a deliberately invalid model | Exit 1; start → prompt → finalize, with no Stop emitted upstream; no successful response was invented |

The scrubbed ordered capture is
`bridge/src/__tests__/fixtures/hermes-live-lifecycle.json`. It contains only
synthetic prompts and replies; session IDs, PIDs and workspace paths are
replaced. Callback timestamps were not collected. A real Node daemon received
the unmodified callbacks through `/hooks`, published `sessions_list` and
`timeline_history`, and stored separate APME turns with `stop` or
`interrupted` end sources. Successful turns retained `glm-5.3` / `zai`.
The Gateway's API usage payload is not exported by observer v1, so token/cost
fields remain unknown rather than inferred from it.

This run exposed a Node timeline bug: empty interrupted responses were labelled
`Completed` even though APME correctly stored `interrupted`. The close-row label
now respects the callback outcome. Gateway tool callbacks also omit `platform`;
the observer used to fill in `CLI`, briefly relabelling a Gateway conversation
and exporting its host cwd. A bounded per-conversation context now retains the
explicit platform; an orphan callback omits unknown fields. The original
capture deliberately preserves the pre-fix payload as evidence.
A repeat of the real Gateway tool/shutdown case after reinstalling the observer
kept `api_server`, `Hermes (api_server)` and an empty cwd on every callback.
After 30 minutes of real Gateway silence, the original Node APME run was still
open even though its roster TTL had elapsed. TTL retirement now releases the
APME run in both daemons; Swift also closes an open Hermes chat anchor as
interrupted. The Node registry tests assert retirement is delivered exactly
once, including when a delayed Stop arrives after expiry.
The daemon E2E suite replays this real capture
through HTTP and checks normal replies and interrupted timeline rows; Swift
replays the same capture through admission and APME boundary normalization.
This does not turn unit coverage of dropped callbacks or queue bounds into
live evidence. The corrected TTL closure initially had regression coverage
only; its subsequent live confirmation is recorded below. Gateway reset through
a messaging platform remains unmeasured.

On 2026-10-05 (KST), the same managed classic CLI executed a real
`delegate_task` child against a deterministic loopback OpenAI-compatible
provider in a temporary profile. The CLI entry point and delegation tool
byte-matched the pinned checkout above. The copied observer recorded
allow-listed callback fields before its unchanged processing. Upstream sent
`subagent_start`, followed by the child's start, prompt, response and end;
the observer exported only six parent hooks, with one successful Stop and
one finalization. The child did not become a separate observed session.
The sanitized raw callbacks and exported hooks are preserved in
`bridge/src/__tests__/fixtures/hermes-live-child.json`. Python replays the raw
callbacks through the observer; Node unit/E2E tests replay the export through
the registry and real HTTP/WS daemon; Swift replays the same export through
admission and APME boundary normalization. The initial capture receiver was
a loopback HTTP stub, so daemon replay is separate evidence. This verifies
callback identity and lifecycle, not external-provider quality or messaging
transport. Native component tests do not prove physical-device appearance.

CI wait observer acceptance for 1.8 was measured on 2026-10-05 against the
same installed upstream revision `0a374d167424cdc730ce9761368b62255b551e58`.
Hermes's actual classic CLI `--oneshot` used a deterministic loopback provider
and invoked its real `terminal` tool with a local `gh`-named watcher fixture.
Plugin Doctor registered all nine hooks with no findings. Observer HTTP reached
an isolated Node daemon: start → prompt → tool start/end → one successful Stop
→ finalize. `sessions_list` opened `waitingOn` with `runId=4242`, then emitted
explicit null on that invocation's tool end and removed the finalized row.
APME stored one closed Hermes run and one `end_source=stop` turn, with one tool
call, model `agentdeck-ci-fixture`, 2,141 ms wall time, 1,638 ms foreground CI
wait and 503 ms active time. The custom fixture provider remains unknown in
APME; no provider identity or usage is invented. The sanitized capture is
[`hermes-live-ci.json`](../bridge/src/__tests__/fixtures/hermes-live-ci.json).
This is a real agent/callback receipt with a fixture watcher, not a GitHub
conclusion or messaging-platform Gateway receipt.

CI evidence is content-minimized at the observer. It sends a session-scoped
hash of the upstream `tool_call_id`, explicit background/error booleans, and an
allow-listed `ci_wait_intent` object; arbitrary arguments, raw commands,
environment, tool results and error text are never exported. Bounds and watch
option grammar come from generated `ci-wait-rules.json`, which is installed
with the plugin. The observer currently accepts a single explicit `gh run
watch` or `gh pr checks --watch` command. Shell chains, substitutions, wrappers,
redirections and polling loops emit ordinary tool hooks with no CI intent.
Both daemons validate the normalized object, match exact invocation ends,
retain background watches across Stop and clear on conversation retirement.
Foreground time accounting consumes the same bounded tracker.

Further runtime checks on 2026-10-05 used the same pinned Hermes runtime and
deterministic loopback provider:

| Case | Measured result | Limit |
|---|---|---|
| Post-fix real Gateway silence, with Gateway process alive | One previously open APME run closed after 1,819.485 seconds since the last exported callback (30 min 19.5 s) | No accelerated clock/TTL; the isolated API Gateway's optional Unix tick socket reported a long temporary path warning, while HTTP turns and the Gateway process remained functional |
| Real Gateway stays alive while an isolated Node daemon restarts | First and third prompts reached timeline/APME, both with `end_source=stop`; the middle prompt sent during downtime was absent after restart | Missing callbacks are lost, not durably restored; no messaging adapter was exercised |
| Classic CLI, 90 actual `terminal` calls against a slow receiver | 184 callback posts, queue peak 128, maximum callback enqueue time 0.508 ms, CLI exit 0; only nine HTTP requests reached the receiver and no final Stop did | Request receipt is not acknowledgement; this verifies bounded/nonblocking loss under congestion, not reliable delivery or post-exit queue drain |
| Real CLI exit with a congested queue, instrumented around the unchanged flush function | Flush returned in 1.005 seconds; pending events fell from 55 to 30 before process exit | Bounded best effort, not a full drain; callbacks still pending at process exit are lost |
| Installed CLI observer installer and real Hermes enable/disable/enable commands in a temporary profile | Installer and update preserved Hermes configuration; explicit Hermes commands retained an unrelated configuration marker | Only the tested revision/profile flow is accepted |
| Public `@agentdeck/hooks@1.7.0` tarball | `__init__.py` and `plugin.yaml` byte-matched current source | This does not verify a future package version |
| Running Swift QA app receives a real delegated CLI turn | Actual HTTP/WS reply once; one Hermes APME run closed, one turn with `end_source=stop` | Development-signed isolated QA bundle, empty entitlements; not App Store sandbox/profile discovery |
| Installed macOS TestFlight 1.7.0 (7701), Node relay | Real CLI Hermes row displayed its mark, model and WORKING state in the dashboard/terrarium alongside other sessions | Supported sandbox relay path; no direct sandbox profile discovery or replacement-model approval |
| Lenovo Tab, official Android 1.7.0 APK, version code 24 | In-place upgrade from 1.6.1; real CLI row displayed Hermes name/mark, fixture model and WORKING state; finalized row left the roster and retained its reply in timeline | UI/routing receipt, not replacement-model visual approval or other-device acceptance |

The 24 px canonical mark, renderer-sampled 16 px mark and actual generated
9/8 px masks were inspected as a local contact sheet. The smaller masks retain
the head/hair silhouette but lose facial detail; this is source raster review,
not a physical matrix-panel acceptance. Android captures remain local because
the dashboard also contains unrelated sessions. Development executables must
be launched as app bundles through Launch Services for this runtime check;
directly executing the locally signed QA binary was terminated by the host.
No production daemon restart, user Hermes profile edit or paid model call was
needed for these isolated runtime checks. The Android visual turn used the
existing production receiver and only synthetic fixture content.

Follow-up tickets: [native/device coverage #425](https://github.com/puritysb/AgentDeck/issues/425)
and [live compatibility verification #426](https://github.com/puritysb/AgentDeck/issues/426).

Native Swift ingestion, Android terrarium renderers and ESP32/matrix glyphs
are implemented. Physical-device visual review remains open in #425. Hermes
continues to be observation-only: approval and steering capabilities are not
advertised. The Node photo path has no Hermes terminal identity and refuses
delivery instead of typing into another terminal; default focus remains a
display selection, not permission to steer it. Older firmware can select a
project named Hermes as a voice target;
the Node preview has no terminal/command route, so delivery fails visibly.
No native App Store subprocess or companion-install UI is added.
Messaging-platform Gateway reset, remaining native/device acceptance and
replacement-model approval must still be completed before claiming full rollout
acceptance. The completed runtime receipts do not waive those gates.
