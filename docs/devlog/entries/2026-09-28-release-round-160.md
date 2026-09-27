# 2026-09-28 — Release round 1.6.0: two publish steps that failed after succeeding

Every channel shipped at 1.6.0 (Android at 1.6.1). Two workflows reported
failure after their real work had finished, and both were completed by hand
rather than re-run, because a re-run would repeat an irreversible or duplicating
step.

- **ESP32:** `softprops/action-gh-release` uploaded all 61 assets to a draft,
  then lost its connection ("other side closed") before publishing it. A re-run
  risks a second draft for the same tag. The draft's 59 checksummed files were
  verified against its own `manifest.json` (no mismatch, every asset
  `uploaded`, one release for the tag, on the merge commit) and published with
  `gh release edit --draft=false`. Note that `GET /releases/tags/<tag>` answers
  404 for a draft — list releases to see it.
- **npm:** all four packages published (`+ @agentdeck/<name>@1.6.0`), but only
  `hooks` was visible within the script's 60-second check; `shared`, `bridge`
  and `setup` appeared about five minutes later. The check failed the job, so
  verification, release notes and the GitHub Release were skipped; they were run
  by hand with the workflow's own commands. `waitForRegistryVersion` now waits
  up to ten minutes.
