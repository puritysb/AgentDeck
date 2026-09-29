# 2026-09-23 — Mobile native aquarium and pre-release branch audit

## Implemented

- Android imports six original resident models from the approved Blender source,
  with closed backs, articulated working/attention poses, reactive fish and a
  smaller wandering snail. Export and asset tests prevent other Blender scenes
  from leaking a default cube into the model.
- Shared generated native foreground budget: eight residents, selected and
  awaiting sessions first, with every session retained in the full roster.
  This does not infer parent/child relationships from matching project names.
- Apple reserves scene space for attention panels; native viewing
  hides the timeline. Labels gain unlit backing, and wide viewports adjust the
  camera. The existing dashboard preference and default remain unchanged.
- Android limits the native render surface and shadow map, removes expensive
  optional effects and samples power/thermal state every two seconds. Dashboard
  text remains at display resolution; the separate e-ink path is preserved.

## Measured validation

- Lenovo tablet, thermal status 3 in both samples: native SurfaceFlinger cadence
  8.380 → 29.836 fps; main UI 13.211 → 58.522 fps; render-engine average about
  76 → 11.135 ms. The user confirmed movement was clearly smoother. These are
  device measurements, not a universal or normal-temperature 60 fps guarantee.
- Full TypeScript build/typecheck and Vitest: 4,671 passed, two skipped.
  Protocol regeneration left no tracked drift.
- Android: 409 unit tests and final release APK/AAB build passed. iOS development
  build passed; Apple targeted native tests: 36 passed. Documentation, catalog,
  devlog and token synchronization gates passed. Design lint reports the same
  92 working-checkout findings (89 tracked baseline plus three generated-output
  findings), with no newly introduced finding. Final visual/archive release
  gates remain; development compilation is not App Store validation.

## Local branch audit before Apple delivery

- Fetched/pruned origin and inspected every local branch and both worktrees.
  The shared root was clean and its master behind origin; it was not switched
  or reset. The release branch includes all of origin/master with 23 additional
  commits before this mobile commit, including two not yet pushed.
- Removed ten inactive local branches only after proving ancestry or exact
  patch equivalence against origin/master. A verified Git bundle of all local
  branches/tags, a binary working diff, untracked-file archive and branch SHA
  inventory were retained outside the repository before removal.
- Retained the unmerged commercialization research branch. Its dated findings
  were not adopted as current release policy. No stash or abandoned worktree
  needed cleanup.
- Preserved the modified dark-garden Blender source and its backup separately
  from the release staging set. Object names, transforms, mesh topology and
  material assignments matched the committed scene in a 511-object comparison;
  this is not proof of equality of every Blender property. Android assets were
  exported from the committed source, not the unreviewed local binary.
- Open PR #363 is an independent Node Claude-recovery fix. A later review audit
  found change requests despite green CI; credential rotation and executable-path
  fixes were pushed to its contributor branch and the prior review was approved. All six CI checks passed and PR #363 was
  squash-merged as `18708c28`.
  It is not a prerequisite for the native Apple apps. PR #362 remains the current device/dashboard work.

## Delivery state

Android 1.5.0 (20) was uploaded to a saved Play release draft, but was **not
submitted**. The user then reported gray Antigravity, detached OpenClaw claws and
lower Android visual fidelity. Apple archive workflows were canceled and store
submission remains on hold while those defects are fixed. Android versionCode
advances to 21 because Play already accepted 20. macOS has an unsubmitted 1.5.0
version record; no final 1.5.0 Apple build has been selected. Existing 1.4.0
versions remain live. No new ESP32/deck release follows from these native fixes.

## Graphics correction after device review

- Antigravity's uniform gray material came from using a monochrome brand token
  in the 3D builder. An initial reuse of the 2D palette still differed
  from the official image, as the user pointed out. Replaced that approximation
  with Google's official full-color press PNG, sharing it through the original
  SVG geometry's UV mapping in Apple USDZ and Android glTF.
- OpenClaw's canonical source and glTF round-trip geometry had attached claws.
  Android cached Filament TransformManager instance indices across habitat
  animation transactions, which reorder component storage. Store entity IDs
  and resolve indices at use for joints, fish and snail. The installed correction
  shows both claws attached; churn and activity-state validation follows.
- Matched Android water to the Apple deep-sea palette with correct linear input,
  reduced ambient washout, added readable two-line labels, grounded the bottom
  residents using imported geometry bounds and separated bottom/water slots.
  The native camera field of view now comes from the existing generated rules.
- Android unit tests, including exact official-PNG hash and color checks, pass.
  Apple native resident/geometry tests passed 29/29, including shared shelf
  contact. Repository build/typecheck and 4,671 Vitest tests passed (two skipped).
  Protocol, token, docs and catalog gates passed; lint retains the 92 existing
  working-checkout findings.
- Android native rendering measured 30.142 fps at the increased 1200-pixel
  thermal budget versus 30.161 at 960 pixels (thermal status 3). Idle/working
  six-resident and 41-session churn captures exercise the corrected transforms.
  iPad was installed and launched after the user unlocked it.
  Release archive/store submission gates remain.

## macOS composition parity

The user preferred the still-installed macOS composition. Comparing its source
and live screen exposed a regression in the newer mobile candidate: reserving
the lower timeline fraction shortened the native scene, and the underwater
wash/depth gradient had been removed. Restored a continuous full-canvas habitat
behind the timeline on both native surfaces, retaining attention clearance.
Water tint and depth-fade stops now share generated rules. Android system bars
use light icons on its dark LCD dashboard; e-ink behavior is unchanged.
Both corrected apps were installed and launched, and native screenshots confirm
the continuous bottom composition, official color mark and attached claws.
The same shared model/camera still passes 29 Apple geometry tests; Android
unit tests and 4,671 Vitest tests pass. Android floor labels were moved above
their residents to stay clear of the timeline fade.

## Immersive viewing transition

Restored the tap-to-enlarge behavior as an explicit camera transition rather
than a side effect of resizing the timeline viewport. The native camera moves
to 82% of its normal distance with a shared 0.18-second exponential response;
roughly half a second brings it close to the new framing. A second background
tap returns to the dashboard framing. Viewing hides resident labels and fades
out the lower readability gradient. Reduced-motion settings apply the camera
change immediately. Android draws the depth wash in its existing label layer
and keeps the 960-pixel thermal limit for the larger full-canvas scene.

The user confirmed the iPad zoom amount feels natural. During a concurrent
native-build verification run, the unrelated Tier 3 SSE timing test missed its
short event window; its focused rerun passed all 16 tests. The preceding full
suite passed 4,671 tests. Final Android native frame cadence after restoring the
full canvas and reusing its label layer measured 27.098 fps under thermal
status 3 (not the earlier cropped-canvas 30.142 fps result).
Android release APK installation and both background-tap directions were
verified on the connected Lenovo tablet; labels and timeline return with the
original framing. Android unit tests and 29 Apple resident tests passed.
The iPad remains on the synthetic six-resident preview for user review; Android
is back on its normal daemon connection. Store submission is still pending.
