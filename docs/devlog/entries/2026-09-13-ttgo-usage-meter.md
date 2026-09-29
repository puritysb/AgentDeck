# 2026-09-13 — TTGO usage meter and small-display role review

TTGO T-Display now starts in usage-only mode. GPIO0 toggles Usage / Terrarium;
GPIO35 retains rotation. Screen rebuilds preserve the current mode; a reboot
returns to Usage. The meter renders only available Claude/Codex quota windows,
including real zero, with reset countdowns. Stale Claude data does not suppress
Codex. It pauses terrarium rendering and activity switching while selected.

Four fixed cards and static text buffers avoid per-frame text allocation on the
no-PSRAM board. IBM Plex Sans KR ASCII subsets at 12 px and 28 px are generated
with lv_font_conv 1.5.3 from the repository fonts, included only for TTGO.

Verification: TTGO firmware build; four host C++ suites; actual-renderer PNGs in
portrait/landscape, four-window, secondary-only, zero, absent and stale-Claude
scenes; twelve mode toggles/screen rebuilds. Common build, typecheck and 4,482
unit tests pass (one skipped). Protocol generation has no drift; token sync and
docs/catalog checks pass. Clean-source design lint retains the 89 baseline
findings. A host render is not a physical button/optical check.

[docs/esp32-companion-concepts.md](docs/esp32-companion-concepts.md) records
proposed refinements, not implemented redesigns: stable selected-work monitoring
on the camera-less S3-Pro, and an explicit waiting-question queue on T-Embed.
Existing pager focus, voice, history and observed-session command filtering are
already present and are not presented as new features.

Build environment: the default PlatformIO Python ran as x86_64 against an arm64
littlefs extension. Running the existing interpreter with `arch -arm64` fixed
the build without changing shared dependencies. Native C6 simulation has no
registered environment; the shared aquarium guard is checked by its actual
firmware build instead.

Deployment: the connected TTGO completed live WiFi OTA (2,740,528 bytes, 2,677
chunks). Fresh serial readback reports build `6e0158db`, epoch `1789291118`,
uptime 63 seconds, six sessions, Codex 7d 62%, absent 5h and absent Claude.
Free heap is 112 KB, minimum 71 KB, largest block 33 KB. USB serial is the
active data path and WiFi is parked. The daemon and other devices were not
restarted or reflashed. Image SHA-256:
`e0823be47fe90e0202736d794e6f9f7ee84b9f02be0b349bca4a2fd8ac15b4ab`.
Public firmware version remains 1.2.3; this is a local feature build, not a
published release. Physical button presses and panel optics remain unverified.
The simulator's cold empty scene now initializes absent quota to -1, matching
firmware instead of inventing four 0% windows after a zeroed fixture.
