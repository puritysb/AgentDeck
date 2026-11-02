# App Preview capture record

The files in `previews/<platform>/` are **2.0 development candidates prepared locally**.
They have not been uploaded or approved for a Store release. The older September
1.5.0 captures and their delivery record remain in git history and
[the 1.5.0 record](macos-1.5.0.md).

## November 2, 2026 platform overviews

Frozen app source `4100e0ca` passed the complete local integration gate before
capture; app code is unchanged at the media base `2a1ab86a`. The
[media manifest](../../docs/media/current/manifest.json) owns binary/raw/output
hashes, exact cuts, streams and evidence boundaries.

| Platform | Duration | Native overview before the control journey |
| --- | ---: | --- |
| iPhone | 28.43s | Multiple sessions, then System with reported usage windows |
| iPad | 28.33s | Landscape dashboard with roster, activity timeline and usage |
| macOS | 28.00s | Native dashboard, session context, observed Collaboration Beta and expanded graph |

The mobile previews end with their own real native question → original choice → one-time
permission → resumed result. These are original-speed editorial cuts of full
native frames, aspect-fit to the platform canvas. The earlier complete control
takes remain the feature-detail evidence rather than the whole product introduction.
Native simulator footage is not physical-device verification.

Overview sessions, messages and quota are fictional presentation samples. The
`Local Demo` control workspace and loopback model produce an original OpenCode
question; native UI input selects `Local demo`, reviews `bash: node --test`, and
permits that command once. The real standalone OpenCode SDK executes the harmless
test and returns one passing `demo total` result. No replacement UI or accelerated
playback is used.

This shows a compatible connected controller path. It does not establish that the
Mac app's observation-only OpenCode installer can answer questions, and must not
advertise a Swift-only reply path. Check the eventual submitted build's host/control
combination against the [feature matrix](../../docs/appstore-feature-matrix.md).
The sample quota is not a live account measurement. No CloudKit PoC, remote
approval or guaranteed Watch delivery is shown. Debug capture connections do not
ship in Release builds.

The broader Pages/README introduction is a separate **2 min 24 sec product tour**.
Its fourteen chapters cover sessions/CI, collaboration, usage, real responses,
controller/voice/native settings, evaluation/evidence, e-ink, compact/LED devices
and the terminal. Historical photographs and production-renderer frames are
explicitly labeled there; they are not included in the native-only Store cuts.

Rebuild candidates with `node scripts/assemble-store-product-previews.mjs
<new-capture-diagnostics> <original-control-capture-root>`. The native-only input
list and original-speed cuts are retained in the media manifest. Keep raw takes
outside git under `diagnostics/media-2.0/product-tour-4100e0ca/`.

## Encoding and review

- Original speed, full native frames aspect-fit on each platform's accepted canvas.
- H.264 High Profile Level 4.0, progressive, 30 fps, CBR HRD at 11 Mbps.
- Silent stereo AAC-LC, 44.1 kHz, encoder setting 256 kbps.
- iPhone 886 × 1920; iPad 1600 × 1200; macOS 1920 × 1080; 15–30 seconds.
- Validate actual streams with `apple/scripts/validate-appstore-submission.sh`.
- Choose a poster showing the original choices, then inspect it after Store processing.
- Recheck current Apple requirements, accessibility, localized metadata and submitted
  build parity during release preparation. Local encoding validation is not Store acceptance.

Pages leads with the whole-product tour and retains a labeled phone close-up
as a feature detail, with full phone and Mac control views linked. Store candidate files retain full app
frames. Historical photos and older public recordings remain intact.
