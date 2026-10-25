# Android e-ink device verification — 2026-10-25

This evidence covers the shared work/usage dashboard and separate animated Frame
on **Pantone 6 and Crema S**, installed with the same signed 1.10.1/code 28 APK.
The installed base APK matched SHA-256
`0c74fde56dc3d2106125a92ce37c46cda3c67ec65ecc7775af28e3a315553b9e` on both readers.
The verified implementation is commit `dad93e6ce3da4295c354a9aaebbd8b310e3edb11`.

## Device matrix

Every row passed four Frame conditions: eight working residents, mixed work/wait/rest,
stop/rest/restart transitions, and 32 sessions with eight visible residents plus the
population count. Each row also passed the work/usage return test: both panes stay
visible, and work row 32, expanded scope 10 and the final provider are reachable.

| Device | Orientation | Framebuffer | Frame video | Work/usage start | Both pane ends |
| --- | --- | --- | --- | --- | --- |
| Pantone 6 | portrait | 1072 × 1448 | [50 s recording](pantone-facing-portrait-transition.mp4) | [Screenshot](pantone-after-frame32-portrait-top.png) | [Screenshot](pantone-after-frame32-portrait-both-end.png) |
| Pantone 6 | landscape | 1448 × 1072 | [50 s recording](pantone-facing-landscape-transition.mp4) | [Screenshot](pantone-after-frame32-landscape-top.png) | [Screenshot](pantone-after-frame32-landscape-both-end.png) |
| Crema S | portrait | 1072 × 1448 | [50 s recording](crema-facing-portrait-transition.mp4) | [Screenshot](crema-after-frame32-portrait-top.png) | [Screenshot](crema-after-frame32-portrait-both-end.png) |
| Crema S | landscape | 1448 × 1072 | [50 s recording](crema-facing-landscape-transition.mp4) | [Screenshot](crema-after-frame32-landscape-top.png) | [Screenshot](crema-after-frame32-landscape-both-end.png) |

## What the recordings show

The four published MP4s are unchanged native `screenrecord` files. They run at
real time, with no retouching, composited UI, cropping, scaling or interpolation.
Each begins with four working residents; the fixture changes to waiting at 5 s,
resting at 18 s and working again at 31 s. Recorded dispatch times differed by at most 0.01 s,
and the final 19 s retain the resumed movement. Caption checks and measured
video dimensions/durations are retained in [results.json](results.json).

The complete local matrix has 16 recordings, totalling 513 seconds. Review sampled
whole working scenes at 1 fps and selected turns, braking and restarts at 10 fps.
This checks directional gaze/body yaw, planted feet, tail/wake settling, continuous
position, readable names and the unmirrored Codex `>_` prompt. The matrix uses
fictional sessions and usage from a separate loopback WebSocket feed.

These are **installed-device framebuffer recordings**, not camera footage of the
physical panels. E-ink ghosting, refresh flashes, panel response and ambient-light
readability were not measured. The earlier 44-second transition attempts delayed
the restart while taking screenshots; they were replaced by these independent-timer
50-second recordings and are not presented as final evidence.

## Automated verification and restoration

- Android: **544 tests passed**, zero failures, errors or skips.
- Focused motion, canvas and animation timing tests: **36 passed**.
- Vitest: **6,805 passed**, 17 skipped.
- `pnpm verify:quick` and `pnpm verify:changed`: passed.
- [`pnpm verify:full --record --allow-dirty`](../../receipts/2026-10-25-51cd810.json):
  passed, with 24 passing gates, two skips and three manual gates. The macOS
  Keychain-dependent daemon E2E and Windows runtime were skipped;
  `esp32-robot` and `swift-codex-live` remain manual and were not exercised by
  this Android review.
- The full receipt leaves `device-deploy` manual; the separately recorded
  [device-deploy attestation](device-deploy-attestation.json) confirms the scoped
  two-reader run. Its reference to `diagnostics/` identifies the original local
  evidence, summarized and published here.

The automated receipts identify the dirty `51cd810` checkout used before the
implementation commit; they are not represented as a fresh run on a later Git
commit. Committing that verified source did not change executable files.
Neither app process reported an animation-loop exception or runtime crash.
Both readers retained the verified APK and returned to their real host and
original font/rotation settings: Pantone in portrait Frame, Crema in landscape
Work. The isolated fixture had zero clients and exited cleanly.
