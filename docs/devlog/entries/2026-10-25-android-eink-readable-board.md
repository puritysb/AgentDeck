# 2026-10-25 — Six-inch e-ink needs a shared work-and-usage viewport

The first clipping fix proved scroll reachability but failed the owner's visual
review. Reserving 36% of portrait for a larger aquarium stopped its disappearance,
yet captures still showed only two or three sessions while the landscape tank
occupied more than half the display. The next candidate split Overview, Sessions,
Usage and Frame into destinations with Previous/Next navigation. That preserved
access to data but hid useful information behind buttons and gave usage an entire
screen it did not need. Both candidates were installed for review, not released.

The accepted dashboard keeps work and usage visible together: stacked in portrait,
side by side in landscape, with independently scrollable panes and persistent
scroll indicators. The portrait usage height follows its content until a bounded
ceiling; a ceiling is not a reserved blank block. Provider-specific scopes expand
inline. Hidden scope labels must not participate in the primary 5h/7d column
measurement: a first capture showed that they created an empty label column even
when those rows were collapsed. The last three finished items follow the complete
work roster, and quiet sessions retain readable full rows.

The next Frame review rejected eight enlarged marks fixed in a regular grid.
Bigger icons alone do not make a terrarium observable. That candidate used separate
habitat homes and state-driven poses and travel, with stationary plants/substrate
providing spatial context. Shared native activity constants and the canonical
resident priority remain authoritative. Merely removing the fixed-slot flag was
rejected because the old renderer placed idle and waiting residents in the same
floor band, overlapping the enlarged creatures. Layout must reserve movement and
caption room as well as the mark's static silhouette.

Version decision: continue the same local 1.10.1/code 28 sideload candidate for
this authorized device review; no version bump, public tag or store upload.
Build and installation follow
[the Android workflow](.agents/workflows/build-android.md) and
[agentdeck-deploy](.agents/skills/agentdeck-deploy/SKILL.md).
The canonical behavior is in [Android UI](docs/android-ui.md) and
[Paper Board](DESIGN.md#514-paper-board-every-e-ink-surface).

The previous signed candidate installed on Pantone 6 (`AA007422R24C1300039`) and
Crema S (`CREMAA21W09235`) with APK SHA-256
`aa89bb6c79cfef182a74397acb43578d52ec7c82fca2b5e2c5adf5da3ef2374f`, verified
against each installed base APK. Their framebuffers are 1072×1448 portrait and
1448×1072 landscape at 300 dpi. Android regression validation completed 525
tests with no failures, errors or skips, including the actual Compose panes,
180% text, saved reading positions and rotation, session-ID history isolation,
resident bounds, work/rest motion and phase continuity, and CI clearance.

Device review uses a separate loopback WebSocket feed on port 9347 and ADB
reverse for only these two devices. Synthetic sessions are not written into the
shared daemon. The review harness must seek the inline collapse control before
tapping it: with expanded scopes in portrait, it is below the first viewport.
It also checks the framebuffer orientation against Pantone's system rotation
setting until both settle, and rejects a case if any later capture changes
orientation. Captures made before the current installed candidate are not reused.

The dashboard matrix passed all 16 cases (both devices, both orientations,
and four conditions): 24 sessions, live growth to 32 sessions with ten scoped
limits, 130% system text, and 130% text with an attention panel. Each case captured
the initial shared viewport, the last work row, the last expanded scope with its
value/reset, and the last usage provider while the last work row remained visible.
The scope value 101% is clamped to 100% by the existing usage contract. Evidence is
in the ignored `diagnostics/eink-dashboard-review/matrix-results.json` and its
PNG/UI-tree companions; these are actual installed-app framebuffers, not physical
panel photography or a measurement of e-ink ghosting.

Frame review then used all seven supported species in an eight-resident scene,
first all working, then three working/two waiting/three resting (including one
CI wait), then all resting. Portrait and landscape captures on both devices show
complete silhouettes, the full generated Hermes tail, distinct question/CI cues,
and captions matching the rendered states. Consecutive frames show worker travel
and body pose changes while quiet grounded residents retain their resting places.
Six-second Android screen recordings preserve the mixed-state observation.
OpenClaw remains the canonical aggregated gateway resident, rather than a named
per-session row; its renderer intentionally has no per-session name tag.

`verify:quick` passed. The complete recorded deployment verification ran all
available gates: Android, Apple build/test variants, ESP32 host/simulator/TTGO,
packaged npm acceptance and the documentation/protocol gates passed. Its first
coverage run hit a 10-second timeout in the unchanged learning-pack byte-equality
test while another independent full build was active on the host. Re-running
only the whole Vitest coverage gate passed 440 files / 6,805 tests (17 skipped)
in 83 seconds without source changes. Preserve the original failed full receipt
and the separate successful retry rather than rewriting that first result.
The macOS Keychain-dependent daemon E2E remains opt-in and was skipped; Windows
runtime and unrelated hardware lab gates were not exercised by this Android task.

The previous 32-session Frame cases also passed in both orientations on both devices:
eight resident silhouettes remain visible with an explicit `8 of 32` badge.
`frame-results.json` records all 16 Frame device cases and four mixed-state videos
at the native framebuffer dimensions (approximately 6.1 seconds each). Those geometry checks passed, but the owner subsequently rejected its motion as
large icons wobbling. Passing bounds and screenshot checks did not establish that
the creatures appeared to inhabit the scene.

Both devices were returned to Work, the real host, their original orientation
(Pantone portrait / Crema landscape), font scales and system rotation settings.
Installed base-APK hashes still match the signed candidate. The isolated feed had
zero remaining clients before shutdown; the shared daemon was not restarted.
Restoration evidence is in `restoration.json` and `*-restored-real-host` captures.


The follow-up replaces home-relative oscillation with a persistent per-resident
locomotion simulation. Workers steer to destinations, stop to work, and move on;
idle residents alternate slower exploration with pauses, while waiting residents
brake where they are and sleepers hold still. Static scenery now provides an
observable reference for substantial travel. Claude's original feet and hands,
OpenClaw's original claws, and Hermes's original tail articulate independently
of their anchored face/body; walking phase follows distance, and work gestures
use a separate phase. Name tags have no card backgrounds. This preserves upstream
silhouettes without making the whole mark the only animated part.

Review found two cases ordinary motion tests missed: reducing eight waiting
residents to two enlarged their stationary bodies into one another, and rotating
an all-sleeping scene gave no animation tick to recover collisions. Held residents
now retain their size after shrink; explicit viewport/roster changes settle
geometry on the first frame without advancing the gait. Nine layout regressions
and five native-canvas articulation tests pass, including frozen rotation and
population reduction. Canvas tests compare body/face pixels while limbs move,
so replacing articulation with whole-icon rocking would fail them.


The roaming candidate was installed on both readers with verified base-APK
SHA-256 `2933a2ec4412f9686a5683de04aa63a5931203a8478a4a89f09ec33c34089168`.
All 534 Android tests passed with no failures, errors or skips; whole-suite
Vitest coverage passed 6,805 tests (17 skipped). The new fixture and evidence
live separately in ignored `diagnostics/eink-roaming-review/`, so the rejected
candidate's captures cannot be mistaken for this result. Sixteen device cases
cover both orientations and working, mixed, resting and 32-Claude states. Each
case has five timed PNG samples and a 16- or 26-second native screen recording.
Independent review of those sequences found broad travel, fixed waiting centers,
quiet Hermes staying in place, and intact bodies/captions/CI/question cues. The
32-session case keeps eight readable residents plus the explicit population count.


Four additional device cases return from Frame to Work, then reach work row 32,
the tenth scoped allowance and the final provider in both orientations. All pass;
app-process logs contain no animation-loop exception or runtime crash. Both
readers are back on the real host in Work with their original orientation/font
settings, and their installed hashes still match the roaming APK. The isolated
feed has zero clients after restoration. `evidence.json` joins these receipts,
the 16 videos (377 seconds total) and Android results. This is framebuffer/video
verification; physical panel ghosting and color reproduction were not measured.


The roaming candidate's `verify:full --record --allow-dirty` completed successfully
on the first run, including every available native and packaged acceptance gate.
The recorded receipt identifies the dirty isolated checkout rather than claiming
an immutable release commit. The prior failed receipt remains separately in
`diagnostics/eink-roaming-review/previous-full-receipt.json`. The two-reader deploy
smoke has its own successful, explicitly Android-scoped `device-deploy` attestation.
Keychain-dependent daemon E2E, Windows runtime and unrelated hardware/live lab
checks retain their documented skip or manual status; no broader physical-device
claim is made. Runtime log URL credentials were redacted before retaining the log.


A further review requested direction-aware facing and continuous walk/swim/stop
transitions. The implementation keeps world heading separate from left/right
body yaw: using the heading cosine directly would leave vertical swimmers
permanently thin. A vertical deadband preserves their previous side, while a
reversal brakes, turns through a bounded narrow silhouette, and accelerates.
Kiro and Hermes turn the original silhouette; Claude/OpenClaw shift the original
feature layers inside a body whose old feature cutouts have been filled with
those same generated paths. Codex keeps its terminal prompt unmirrored.

An initial sign-based silhouette reflection was rejected during review because
it still popped at the midpoint. The bounded turn now blends the two canonical
reflections only around the narrow middle. A separate speed envelope settles
feet/tail movement, and work gestures start after braking and finish before
departure. Pixel tests cover gaze, readable terminal marks, handedness and the
mid-turn crossing; motion tests cover heading limits, vertical facing, and
start/stop/work timing. The focused 36 tests and full Android suite of 544 tests
passed with no failures, errors or skips.


The facing candidate is installed on both readers with verified base-APK SHA-256
`0c74fde56dc3d2106125a92ce37c46cda3c67ec65ecc7775af28e3a315553b9e`. Fresh
evidence is isolated under ignored `diagnostics/eink-facing-review/`: sixteen
Frame cases across both orientations (working, mixed, stop/rest/restart and
32-session scenes), with 513 seconds of native screen recording. Independent
review samples whole working scenes at 1 fps and selected turns/stops/restarts
at 10 fps; `visual-review.json` records the exact clips and approximate times.
It found continuous narrow turns, unmirrored terminal marks, planted feet after
braking, and head/tail/wake acceleration after a resting swimmer turns to leave.

The first transition harness coupled event dispatch to ADB capture calls.
On Pantone, those calls delayed the nominal 25-second restart to 43.24 seconds
in a 44-second clip. Its captions passed but its restart duration was inadequate.
Those captures are retained under `superseded-transition/`; replacement 50-second
recordings dispatch state changes on a separate timer at 5, 18 and 31 seconds
(actual error at most 0.01 seconds), leaving 19 seconds to observe resumed work.
A video-duration check alone would not have caught that evidence gap.

All four post-Frame dashboard cases reach work row 32, scope 10 and the last
provider with work and usage visible together. Neither app process logged an
EinkAnim or AndroidRuntime error. Both installed hashes still match after
restoring the real host, original font scales and orientations: Pantone portrait
Frame and Crema landscape Work. The isolated feed had zero clients and exited
cleanly. This proves installed framebuffer behavior; it does not measure physical
e-ink ghosting, refresh flashes or panel response.
