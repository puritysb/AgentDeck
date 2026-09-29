# 2026-09-22 — Android e-ink motion and layout review

## Changes

- Reviewed Lenovo TB-J606F in monochrome e-ink override, using baseline and iterative screen recordings. Physical EPD refresh/ghosting remains unverified on Pantone/Crema.
- Extracted `EinkFishSchool`: bounded separation acceleration, simultaneous neighbour snapshots, fixed 50ms simulation steps and gradual heading changes. HOVERING keeps the same fish positions instead of switching to an unrelated analytic orbit. Initial spacing and school separation were adjusted after the first installed review exposed clustering.
- Replaced the limits card's whole-line ASCII gauge with a flexible drawn bar between measured label and percentage. This fixes the observed `4…` clipping while retaining GLM/MCP and stale markers. Added provider usage, scoped limits and subscriptions to the e-ink refresh key.
- Multiple Codex creatures retain their horizontal layout slots instead of wandering into one another. Session overflow is reachable by scrolling with a direction hint; duplicate name suffixes are independent of recomposition.

## Validation

- Android: 400 unit tests pass, including equal trajectories at 100ms/400ms display cadence, bounded turns, continuous HOVERING transitions and long-run bounds. Signed sideload APK built for the existing 1.4.1 candidate.
- Workspace build/typecheck pass; 304 test files, 4671 tests pass (2 skipped). Initial live-loopback port test failed transiently; isolated retry and full retry passed.
- Protocol generation has no tracked drift; token sync and documentation/catalog checks pass. Design lint reports 89 existing source findings plus 3 generated, ignored Ulanzi JavaScript findings after workspace build; no changed file is reported.
- Three installed review iterations completed. Final portrait/landscape and 130% system-text checks confirmed readable 41%/GLM 1%/MCP 100% gauges and scrolling to the last session; system text restored to 100%, tablet left in landscape e-ink override. Local recordings are kept outside tracked documentation.
- No store/public release is implied by this local UI review. See [Android UI](docs/android-ui.md) for the resulting behavior.
