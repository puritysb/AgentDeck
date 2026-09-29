---
paths:
  - "apple/**"
  - "RELEASING.md"
  - "CHANGELOG.md"
  - ".github/workflows/**"
  - ".github/release-notes/**"
  - "scripts/release-notes.mjs"
  - "scripts/verify-release-version.mjs"
  - "docs/appstore-*.md"
  - "docs/testflight-qa-checklist.md"
---
# App Store build invariants and releases
<!-- Moved verbatim from the root map (then CLAUDE.md, 2026-09-10; AGENTS.md since 2026-09-29). Rule bodies are the SSOT for their domain; the root map keeps only the index. -->
The macOS app ships through the App Store and must stay self-contained (Guidelines 2.5.2 / 4.2.3). Release
procedure: [RELEASING.md](../../RELEASING.md). Feature matrix:
[docs/appstore-feature-matrix.md](../../docs/appstore-feature-matrix.md). Reviewer text:
[apple/APP_REVIEW_NOTES.md](../../apple/APP_REVIEW_NOTES.md).

## App Store build invariants

The macOS app ships through the App Store and must stay **self-contained** under App Review Guidelines 2.5.2 (no bundled interpreters) and 4.2.3 (no routing users to outside installs). The guardrails below are enforced in code, CI, and docs — preserve them on every change.

- **`AGENTDECK_APP_STORE` compile flag** is set on the macOS target in `apple/project.yml`. macOS == App Store; the legacy non-App-Store macOS GUI build is no longer maintained. The flag is retained as a defense-in-depth gate, but the macOS source tree itself contains no `Process()`, `/bin/sh`, `osascript`, `.command` script writer, or external-CLI probe (`security`, `sqlite3`, `adb`, `openclaw`, `whisper-cli`) — those code paths are gone. Do not reintroduce subprocess paths under any guard; route new functionality through entitlement-backed APIs or surface it as a "requires desktop bridge" capability gated on `DaemonService.isUsingExternalDaemon`.
- **No companion-install prompts.** App-Store-reachable UI (Setup card, Settings, menubar, alerts) must not tell the user to install, register, or launch a companion binary. Setup card copy is identical regardless of whether an `agentdeck` CLI exists on disk — differentiating based on external state is an App Review 4.2.3 red flag. See [apple/AgentDeck/UI/Monitor/SetupNeededCard.swift](../../apple/AgentDeck/UI/Monitor/SetupNeededCard.swift) for the canonical copy.
- **No session-launch UI in the App Store build.** The `Launch Session` entry point is gone from the menubar, dashboard empty-state and AgentDeckApp Window scenes — App Store builds never spawn Terminal windows, `.command` files, AppleScript prompts, or child processes. Sessions appear automatically once the user starts Claude Code / Codex / OpenCode in their own workspace and the AgentDeck hooks pick them up. `apple/AgentDeck/Daemon/Core/SessionLauncher.swift::showAppStoreLaunchInfo` remains as defense-in-depth (NSAlert-only path, no callers in shipped UI).
- **CI verifier**: `apple/scripts/verify-appstore-archive.sh` runs after the macOS archive step and fails the build if the shipped `.app` Mach-O contains any forbidden subprocess path string or any bundled executable besides the signed AgentDeck binary itself. Run it locally before releasing: `bash apple/scripts/verify-appstore-archive.sh $PATH_TO_APP`.
- **Feature matrix is canonical**: [docs/appstore-feature-matrix.md](../../docs/appstore-feature-matrix.md) is the one place that records which features are in the App Store build vs. only the terminal-managed daemon. New features land in the table before any implementation touches the App Store target.
- **Progressive enhancement on `isUsingExternalDaemon`**: capabilities that depend on the separately-installed Node.js daemon (Claude subscription quota gauges, ADB-tier device previews, Android/TC001 topology rows) render only when `DaemonService.isUsingExternalDaemon` is true. When false, the relevant UI sections are hidden — never replaced with a "sandbox limitation" notice — so the standalone app reads as feature-complete instead of broken.
- **Review notes**: [apple/APP_REVIEW_NOTES.md](../../apple/APP_REVIEW_NOTES.md) is the text that ships to the reviewer — its claims ("does not spawn any subprocess", "no home-relative-path entitlement", "local WebSocket only accepts same-machine + paired iOS companion") must stay factually correct. Update both the code and this doc when touching anything in that surface area.

## Release states and notes

- **A release step marked "manual" is an interactive portal, not a user-only task, and CI green is not "released."** Store submission has no API, so RELEASING.md calls it manual — that describes the missing API, not a missing capability: portals take a signed-in browser and browser automation is available here (the tools are often **deferred**, so `ToolSearch` for `mcp__claude-in-chrome__*` before concluding they are absent). Read portal state freely (Play review status, ASC builds and submission readiness, Maker/Ulanzi status); ask before pressing anything that changes external state. And keep the five states apart — CI succeeded / artifact exists / uploaded / submitted / live — reporting one you did not measure is how a build sitting in a portal gets called a release (2026-08-09). See [RELEASING.md § A release has five states](../../RELEASING.md)
- **A GitHub Release body is rendered from `CHANGELOG.md`, never hand-written into a workflow.** All six release workflows used to hardcode a static `body:` — the same install blurb every version — so `npm-v1.0.21` published 18 lines that never said what changed, and the round that shipped Kiro observation across five channels announced it nowhere a user could read. `scripts/release-notes.mjs` resolves a delivery tag to its CHANGELOG section and appends the channel's install text from `.github/release-notes/<channel>.md` (ESP32 passes its artifact-rendered board table via `--template`, since a table built from what actually compiled cannot be a checked-in file). Heading format is `## <YYYY-MM-DD> — <Channel> <version>`, and one heading names every channel when a round is cut across several. **There is deliberately no bare-version fallback**: the channels stopped sharing a patch number, so `## 1.0.7` was npm's on 2026-08-06 while Apple reached 1.0.7 on 2026-08-18 with unrelated content, and publishing one channel's notes under another's tag is worse than publishing none. `verify-release-version.mjs` fails on a missing entry as the **first** step of every release workflow, before anything is built, published or tagged — the procedure text alone had been in RELEASING.md the whole time and was skipped without consequence. Backfilling history is out of scope by rule: versions that shipped without notes are listed as *Known gaps* rather than reconstructed, because a plausible sentence derived from a commit log is a release note nobody measured. Gate: `scripts/__tests__/release-notes.test.ts`
