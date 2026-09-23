# App Preview capture record

Upload-ready App Previews are in `previews/<platform>/`. The videos use only actual AgentDeck UI and deterministic sample data.

## Delivered storyboards

| Platform | Time | Visual |
|---|---:|---|
| macOS | 0–13.2s | Current 3D aquarium, original agent characters and reactive schools of fish |
| macOS | 13.2–26s | Collaboration: current task, then an earlier task and its summary |
| macOS | 26–28.7s | Dashboard settings and the optional 3D layout choice |
| iPhone / iPad | 0–8.5s | 3D aquarium; Claude, Codex, OpenCode and related sample sessions appear |
| iPhone / iPad | 8.5–19s | OpenClaw joins; Claude enters the amber attention state |
| iPhone / iPad | 19–25s | Completed tasks, settled characters and the accumulated timeline |

The mobile videos were recaptured on 2026-09-23 from a fresh Debug Simulator build at
`6ba970438` (the Apple UI is unchanged from the submitted build's `4c8a5d2c`).
Both portrait devices record their actual native layout, using the deterministic
`scripts/appstore-demo-orchestrator.mjs` feed through the Debug-only
`-AgentDeckScreenshotURL` argument. The 25-second cuts start three seconds into
its 30-second cycle. The macOS cut retains the actual-app aquarium,
Collaboration and settings recordings prepared earlier that day.

No production sessions, desktop chrome or private workspace details are recorded.
The capture helpers do not ship in Release builds. English UI footage is reused
across English, Korean and Japanese storefronts, alongside localized screenshots
and metadata. Portal delivery status is recorded in [Apple 1.5.0](macos-1.5.0.md).

## Capture rules

- Duration: 15–30 seconds.
- H.264 High Profile Level 4.0, progressive, 30 fps, 11 Mbps.
- Maximum file size: 500 MB.
- Accepted containers: `.mov`, `.m4v`, or `.mp4` for H.264.
- macOS preview must be landscape.
- Set a deliberate poster frame near 5 seconds.
- The delivered videos are silent and depend only on visible in-app labels; no narration is required.
- Use an anonymized demo workspace such as `agentdeck-demo`; never show a real project, terminal, token, IP address, home path, USB path, or notification containing private text.
- Record separate iPhone/iPad variants only if they add product value. Do not stretch or crop a macOS recording into portrait.

## Poster frames

- macOS: use a frame around 5 seconds showing the 3D aquarium.
- iPhone: use a frame around 5 seconds with the growing sample-session roster visible.
- iPad: use a frame around 5 seconds with the full aquarium and timeline visible.

App Store Connect defaults to a poster frame near 5 seconds; verify it after processing rather than relying on the default blindly.

## Verified encodes (2026-09-23)

All three final files passed `apple/scripts/validate-appstore-submission.sh`.

| Platform | Duration | Video bitrate | SHA-256 |
|---|---:|---:|---|
| macOS | 28.7 s | 10,935,065 bps | `f63db43319c80548d2c3ef3101ee304c9af49bc8a24dfacd9430dcf06db40032` |
| iPhone | 25 s | 10,703,674 bps | `8d738b7e5ac2caf3c4798fcd1cde4a9f82238a93ab05f68510c563274843b958` |
| iPad | 25 s | 10,674,280 bps | `3bbac1f2b07869a16cf941cd5c2e3794527f8770ac45c07f1304f297e7c10738` |

Mobile encodes use x264 CBR HRD at 11 Mbps with a 22 Mb buffer to keep low-motion
scenes inside the store's bitrate target. A nominal bitrate alone is insufficient;
verify the resulting stream. Representative frames at 0, 5, 10, 17 and 24 seconds
were checked for current 3D graphics, attention states and capture privacy.
