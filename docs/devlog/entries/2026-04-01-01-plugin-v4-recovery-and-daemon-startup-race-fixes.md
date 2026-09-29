# 2026-04-01 — Plugin V4 Recovery and Daemon Startup Race Fixes

- Fixed Stream Deck v4 `START` button behavior to stop launching the CLI daemon.
  - The button now tries to open the installed `AgentDeck` macOS app.
  - If the app is not installed, it opens the GitHub repository page instead.
- Restored detail-view usability for interactive prompts with more than four options.
  - Added paging for detail-view option slots using slot 7 as a `NEXT` pager when needed.
  - Option selection now preserves the original prompt option index across pages.
- Hardened model-switch UI recovery in the v4 plugin.
  - Added timeout/state-based cleanup so the `MODEL` preset does not remain stuck in loading forever.
  - `prompt_options` now refreshes detail view state immediately, not only `state_update`.
- Fixed a daemon startup race in the macOS app lifecycle.
  - When `DaemonServer` reports `alreadyRunning(port:)` during local startup, `DaemonService` now retries health probing for a short period before declaring the registry stale.
  - This avoids false-negative external-daemon detection during normal startup overlap.
