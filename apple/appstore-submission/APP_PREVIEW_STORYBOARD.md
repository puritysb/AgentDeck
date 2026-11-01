# App Preview capture record

The files in `previews/<platform>/` are **2.0 development candidates prepared locally**.
They have not been uploaded or approved for a Store release. The older September
1.5.0 captures and their delivery record remain in git history and
[the 1.5.0 record](macos-1.5.0.md).

## November 2, 2026 native workflow captures

Frozen source `4100e0ca` passed the complete local integration gate before these
captures. The [media manifest](../../docs/media/current/manifest.json) owns exact
binary/raw/output hashes, dimensions, cuts, encodes and evidence boundaries.

| Platform | Duration | Original choice visible | One-time permission visible | Resumed/idle observed |
| --- | ---: | ---: | ---: | ---: |
| iPhone | 25.03s | 4.50s | 13.26s | 19.95s |
| iPad | 24.40s | 4.50s | 12.44s | 19.33s |
| macOS | 21.43s | 4.50s | 11.93s | 16.37s |

Each platform records a separate real native app view. iPhone uses the standard
portrait dashboard; iPad and Mac use the 2D aquarium. A fictional
`Local Demo` workspace and loopback model produce an original OpenCode question.
Native UI input selects `Local demo`, reads `bash: node --test`, and permits the
command once. The real standalone OpenCode SDK executes the harmless test and
returns one passing `demo total` result. No replacement UI or accelerated playback
is used. Simulator footage is not physical-device verification.

This shows a compatible connected controller path. It does not establish that the
Mac app's observation-only OpenCode installer can answer questions, and it must
not be used to advertise a Swift-only reply path. Check the eventual submitted
build's supported host/control combination against the
[feature matrix](../../docs/appstore-feature-matrix.md) before upload. No CloudKit
PoC, remote approval, provider subscription data or guaranteed Watch delivery is
shown. The Debug-only capture connection does not ship in Release builds.

## Encoding and review

- Original speed, full native frames aspect-fit on each platform's accepted canvas.
- H.264 High Profile Level 4.0, progressive, 30 fps, CBR HRD at 11 Mbps.
- Silent stereo AAC-LC, 44.1 kHz, encoder setting 256 kbps.
- iPhone 886 × 1920; iPad 1200 × 1600; macOS 1920 × 1080; 15–30 seconds.
- Validate actual streams with `apple/scripts/validate-appstore-submission.sh`.
- Choose a poster showing the original choices, then inspect it after Store processing.
- Recheck current Apple requirements, accessibility, localized metadata and submitted
  build parity during release preparation. Local encoding validation is not Store acceptance.

Pages uses an explicitly labeled crop of the phone take for readable controls,
with the full phone and Mac views linked. Store candidate files retain full app
frames. Historical photos and older public recordings remain intact.
