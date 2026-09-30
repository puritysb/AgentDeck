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

**Visual review remains open:** the user rejected the current USDZ after the
iPad Simulator app capture. New concept references under
`assets/terrarium/references/` move the face closer to the original Nous girl.
The runtime mesh now has a skinned body and independent face controls, but
fixed-view comparison still fails visual acceptance. The concept sheet is not
a screenshot of the implemented model; passing tests is not visual acceptance.


The Blender source is `assets/terrarium/hermes-mermaid.blend`, reproducibly
built by `build-hermes-mermaid.py`. Apple bundles its USDZ; a portable GLB is
kept beside the authoring source for the later Android renderer. The model has
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
alongside USDZ and GLB. Its neutral face still fails the original Nous girl
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

Requires a rebuilt Node daemon advertising `hermesObserver: 1` in local health.
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
model, platform, CLI working directory and tool name to the local daemon. It
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

Follow-up tickets: [native/device coverage #425](https://github.com/puritysb/AgentDeck/issues/425)
and [live compatibility verification #426](https://github.com/puritysb/AgentDeck/issues/426).

Before whole-product support: native Swift ingestion, Android terrarium
renderers, ESP32/matrix glyphs, profile/channel labels, approval observation and
explicit capability checks across voice/control surfaces need implementation
and review. Older firmware can select a project named Hermes as a voice target;
the Node preview has no terminal/command route, so delivery fails visibly.
No native App Store subprocess or companion-install UI is added.
A real CLI and gateway conversation capture, including reset, interruption and
shutdown, must verify end-to-end behavior before release. None of these gates
is waived by the preview tests or the existence of an upstream sprite.
