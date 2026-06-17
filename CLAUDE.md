# AgentDeck

Stream Deck+ controller for AI coding agents — a bidirectional local control system.

## Monorepo

- **bridge/** — Node.js server: Daemon hub + Session Bridge (PTY, hook HTTP, state machine). `src/apme/` — APME eval module (SQLite store, collector, deterministic+LLM judge runner, category-aware rubrics, turn-level mid-session eval, rubric auto-tuner, recommender, daemon HTTP API). **Canonical `SessionSample`** (`shared/src/sample.ts` + `sample_events` table) is the SSOT: a bounded unit with a typed trajectory (user/assistant/model/tool/state) that both the timeline and the eval derive from. Per-unit cost via `shared/src/pricing.ts` (override-loadable), Pareto-frontier recommender (`apme/pareto.ts`), trajectory scorers (`apme/scorers/`). Env `AGENTDECK_TIMELINE_PROJECTION=1` (default off) flips the device timeline to the sample projection (suppresses adapters' direct chat/tool rows). See [docs/apme.md](docs/apme.md)
- **plugin/** — Stream Deck SDK v2 plugin
- **plugin-ulanzi/** — Ulanzi Studio plugin for the D200H Deck Dock (official UlanziDeckPlugin-SDK). One dynamic action + session-centric two-level UX, shares the `@agentdeck/shared` `buildSessionDeck` layout engine. Connects to the daemon over WS like the SD plugin; daemon stands down direct-HID when it registers (`ulanzi-plugin`). See [plugin-ulanzi/VERIFY.md](plugin-ulanzi/VERIFY.md)
- **shared/** — TypeScript types/utils shared between bridge & plugin (protocol, states, timeline, adapter interfaces, session-utils)
- **hooks/** — Claude Code hook installer for `~/.claude/settings.json` and Codex lifecycle hook installer for `~/.codex/config.toml`
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package (`npx @agentdeck/setup`)
- **android/** — Jetpack Compose launcher app (CremaS, Onyx, Kobo, tablets)
- **apple/** — SwiftUI Multiplatform app (iOS/iPadOS/macOS). macOS includes **in-process Swift daemon** (30 files ~5500 LOC, no Node.js dependency)
- **esp32/** — PlatformIO Arduino firmware (LVGL touch displays + WS2812B matrix)

See [docs/architecture.md](docs/architecture.md) for full architecture details (BridgeCore, PtyAdapter hierarchy, device modules, AgentAdapter abstraction, Gateway protocol, plugin connection model).

## Build

```bash
pnpm install
pnpm build                  # shared must build before bridge/plugin
pnpm generate-icons         # SVG → PNG icons (first build or after icon changes)
pnpm generate-creature-glyphs  # canonical creature SVG → ESP32 alpha-mask C header (esp32/.../creature_glyphs_generated.h)
pnpm generate-protocol      # protocol.ts → JSON Schema → Swift/Kotlin types (generated/protocol/)
```

## Android Build

Requires JDK 17+ (`brew install openjdk@17`). Build script auto-detects Homebrew JDK.

```bash
bash scripts/build-android-release.sh   # local → dist/agentdeck-v{VERSION}.apk
```

**Signing**: `android/signing.properties` (gitignored) with `storeFile`, `keyAlias`, `keyPassword`, `storePassword`. CI uses env vars from GitHub Secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_STORE_PASSWORD`).

**Release**: `git tag android-v{VERSION} && git push origin android-v{VERSION}` → GitHub Actions builds + creates Release with APK.

## Setup & Distribution

```bash
npx @agentdeck/setup        # npm one-command install (published packages; Claude or Codex CLI supported)
pnpm setup                  # dev install from source (deps, build, icons, hooks, link)
pnpm package                # create dist/bound.serendipity.agentdeck.streamDeckPlugin
bash scripts/uninstall.sh   # remove hooks, unlink CLI and plugin
```

### Apple Release (TestFlight)

```bash
bash scripts/build-apple-release.sh --ios     # local iOS build
bash scripts/build-apple-release.sh --macos   # local macOS build
bash scripts/build-apple-release.sh --all     # both + TestFlight upload
git tag apple-v1.0.0 && git push origin apple-v1.0.0  # CI → TestFlight
```

- **Apple Bundle ID**: `bound.serendipity.agentdeck.dashboard` (App Store Connect 앱명: "AgentDeck Dashboard")
- **CI**: `.github/workflows/apple-release.yml` — `apple-v*` 태그 → macOS-15 runner → archive → TestFlight 업로드
- **Secrets**: `APPLE_CERTIFICATE_BASE64`, `APPLE_CERTIFICATE_PASSWORD`, `ASC_API_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_KEY_BASE64`
- **Note**: `bound.serendipity.agentdeck` (without `.dashboard`) is reserved by Personal Team — cannot use for App Store

## Development

```bash
pnpm -r --parallel dev   # watch mode for all packages
pnpm test                # run unit tests (vitest, 646 tests)
pnpm vitest run --coverage  # coverage report + threshold check
pnpm test:report         # unified report (vitest + Android + Apple + Robot)
pnpm test:android        # Android JUnit tests only (82 tests)
cd plugin && streamdeck link   # link plugin to Stream Deck app
```

### Multi-Agent Development Surface

This repo is built by switching between Claude Code, Codex, OpenCode, and Antigravity. **[docs/agent-harness.md](docs/agent-harness.md)** is the canonical map of how each agent enters the repo, what it reads, and what it auto-discovers — read it when onboarding a new agent or wondering why a skill/workflow isn't picked up.

- **Repo instructions**: `AGENTS.md` is the entry file Codex/OpenCode/Antigravity discover by convention. It requires `CLAUDE.md` first, then targeted `DEVELOPMENT_LOG.md` lookup instead of loading the full log.
- **Repo skills (SSOT)**: canonical skills live in `.agents/skills/<name>/SKILL.md` (discovered by Codex; Claude reaches them via the pointers in `.claude/skills/`). Use them before hand-rolling commands. **`.claude/skills/*.md` are thin pointers — never put procedure content there; edit the `.agents/skills/` copy so the two agents can't drift.**
- **Workflow originals**: `.agents/workflows/` remains the canonical human-readable procedure directory; skills may route into these files. OpenCode has no skill auto-discovery — point it at these workflow files explicitly.
- **Session handoff**: use the `session-end` repo skill before `/clear`, `/new`, or handing work to another session. It summarizes current state and updates durable docs only when the change is project-significant.
- **Codex observation**: `agentdeck codex` installs AgentDeck-managed Codex lifecycle hooks in `~/.codex/config.toml` before launching the PTY bridge. `agentdeck daemon install` also installs/migrates those hooks for daemon-first setups.

### Test Infrastructure

| Framework | Scope | Config |
|-----------|-------|--------|
| **Vitest** | bridge/plugin/shared/hooks | `vitest.config.ts` — coverage thresholds enforced |
| **JUnit + Robolectric** | Android (`android/app/src/test/`) | `build.gradle.kts` — `testDebugUnitTest` |
| **XCTest** | Apple (`apple/AgentDeckTests/`) | Xcode scheme |
| **Robot Framework** | ESP32 (`esp32/robot/`) | `run.sh {build\|hw\|protocol\|perf\|all}` — `perf` requires hardware |

Coverage thresholds (regression guard): lines ≥17%, functions ≥15%, branches ≥14%, statements ≥16%. CI runs `coverage check` step after tests.

### Test Report (GitHub Pages)

- **URL**: `https://puritysb.github.io/AgentDeck/` (landing) / `/reports/` (test report) / `/demo/` (creature-simulator)
- **Workflow**: `.github/workflows/test-report.yml` — push to master → Vitest + Android JUnit + Robot Framework (no-hw) + `pnpm run demo:build` → HTML report → GitHub Pages deploy
- **Report generator**: `scripts/generate-html-report.py` — tab-based SPA dashboard. Robot tab: suite→scenario→BDD steps→board matrix→per-test elapsed time→performance table. `[PERF]` log messages auto-extracted from output.xml
- **Scenario matrix**: `scripts/scenario-matrix.json` — 10 user scenarios mapped to test files + gap analysis
- **Landing page**: `scripts/pages-index.html`

See [docs/testing.md](docs/testing.md) for full testing reference.

### Apple/Xcode Debug Diagnostics

When debugging a macOS/iOS issue that was reproduced from Xcode, do **not** ask the user to paste Xcode console output first. Capture the repository-side diagnostic bundle:

```bash
bash scripts/capture-apple-diagnostics.sh --tail 1000 --last 15m
```

Then inspect `diagnostics/apple-xcode/latest/README.md`, `diag.json`, `status.json`, `oslog-AgentDeck.log`, and `log-files/*swift-daemon.log` before editing code. Use `.agents/workflows/apple-xcode-debug.md` as the canonical workflow for Xcode-run app debugging, startup hangs, Swift daemon issues, OpenClaw pairing, WebSocket state, and hardware module state.

This diagnostic path is developer tooling only: it lives in `scripts/` and `.agents/workflows/`, writes local gitignored artifacts under `diagnostics/`, and must not add subprocesses, shell commands, terminal instructions, or external-tool prompts to the App Store app UI.

## Windows dev setup

The Node.js bridge, hook installer, and Stream Deck plugin run on Windows 11. Apple, Android, and ESP32 native builds are macOS/Linux-only and are out of scope for Windows.

Prereqs (Windows 11):
- **Node.js ≥ 22** + **pnpm**
- **Stream Deck app** (Elgato) — `pnpm` setup also probes `%PROGRAMFILES%\Elgato\StreamDeck\` and `%LOCALAPPDATA%\Programs\Elgato\StreamDeck\`
- **Claude Code CLI** on PATH
- **Git Bash or WSL on PATH** for the bash scripts under `scripts/` (`install.sh`, `uninstall.sh`, `generate-protocol.sh`, `package-plugin.sh`) and `design/lint.sh`. The `postinstall` step is pure Node and runs without bash.

Then:

```powershell
pnpm install            # postinstall runs scripts/postinstall.mjs (no-op on Windows)
pnpm build
pnpm test
agentdeck daemon start  # daemon listens on 9120, writes %USERPROFILE%\.agentdeck\daemon.json
# In another terminal:
agentdeck claude        # spawns Claude Code via Windows ConPTY (cmd.exe /d /s /c)
```

Windows differences (intentional — see `bridge/src/pty-manager.ts`, `hooks/src/install.ts`, `bridge/src/cli.ts`):
- **Data dir**: `%USERPROFILE%\.agentdeck\` (same layout as macOS `~/.agentdeck/`). The `AGENTDECK_DATA_DIR` env override still works.
- **PTY**: ConPTY through `cmd.exe` with `/d /s /c` args (POSIX uses `/bin/zsh -l -c`). `node-pty`'s Windows prebuild is used as-is — no source build, so no Visual Studio Build Tools requirement.
- **Hook command**: Claude Code hook entries on Windows use a `powershell -NoProfile -ExecutionPolicy Bypass -Command "..."` one-liner that reads `%USERPROFILE%\.agentdeck\daemon.json`, probes `/health`, and POSTs the stdin payload via `Invoke-RestMethod`. The macOS App Store sandbox-container fallback paths are intentionally omitted (those directories don't exist on Windows).
- **`agentdeck daemon install/uninstall`**: no-op with a friendly message on Windows. Autostart is out of scope; add a Startup-folder shortcut yourself if you want it. `daemon start/stop/status` work normally.
- **Device-module auto-detection**: `adb` is probed with `adb version` (cross-platform); the `/dev/tty.*` USB-serial scan is gated behind a `process.platform !== 'win32'` check (Windows COM-port enumeration not implemented). `bonjour-service`, `node-hid` (D200H), and `better-sqlite3` (APME) all use Windows-compatible prebuilds.
- **APME hardware sampler** (`bridge/src/apme/hw-sampler.ts`) is darwin-only — it returns a minimal snapshot on Windows and the recommender treats that as "neutral".
- **macOS-only plugin utility actions** (brightness / volume / dark-mode via `osascript`) gracefully no-op on Windows.

When debugging Windows-specific issues, prefer running each command above directly in PowerShell so output appears in the conversation rather than relying on the Apple/Xcode diagnostic bundle, which is macOS-only.

## CLI

The CLI command is `agentdeck` (`bridge/src/cli.ts`).

```bash
# Session commands (agent name = top-level command)
agentdeck claude             # Claude Code session (PTY + bridge)
agentdeck claude --local     # No device modules (WS only)
agentdeck codex              # Codex CLI session (PTY + bridge)
agentdeck opencode           # OpenCode session (PTY + SSE bridge)
agentdeck monitor            # Hook-only bridge (no PTY — run `claude` separately)

# Daemon (singleton infrastructure)
agentdeck daemon start       # Start monitoring daemon (foreground)
agentdeck daemon stop        # Stop daemon
agentdeck daemon status      # Daemon status
agentdeck daemon install     # Register LaunchAgent
agentdeck daemon uninstall   # Remove LaunchAgent

# Session management
agentdeck status             # All sessions + daemon status
agentdeck stop               # Stop a session (-a for all, -p for specific port)

# Monitoring
agentdeck dashboard          # TUI monitoring dashboard with terrarium (alias: dash)

# Utilities
agentdeck devices            # Connected devices
agentdeck qr                 # Pairing QR code
agentdeck diag               # Diagnostic dump
agentdeck pixoo {scan|add|list|remove|test}
agentdeck wifi-setup         # ESP32 WiFi provisioning (--ssid, --password)
```

**Module flags**: `--local` (all off), `--no-mdns`, `--no-adb`, `--no-serial`, `--no-pixoo`

ESP32 WiFi provisioning + disconnect recovery details: see [docs/esp32.md](docs/esp32.md).

## Key Conventions

- **Hook format (CRITICAL)**: Claude Code v2.1+ requires 3-level nesting: `{ matcher: "", hooks: [{ type: "command", command: "..." }] }`. Old flat format silently fails. Bridge auto-migrates via `migrateHooksIfNeeded()` from `@agentdeck/hooks`. Codex uses lifecycle hooks in `~/.codex/config.toml` (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) installed by `installCodexHooksIfNeeded()`. Scripts use bounded `curl` and `|| true` to avoid blocking when bridge is down
- **Plugin UUID**: `bound.serendipity.agentdeck` (immutable post-distribution)
- **Package scope**: `@agentdeck/*` (shared, bridge, plugin, hooks, setup)
- **User data dir**: `daemon.json`, `sessions.json`, `auth-token`, `settings.json`, `timeline.json`, `wifi-config.json`, `compatibility.json`, `apme.sqlite`. Path depends on distribution: **Node.js CLI + unsigned dev builds** → `~/.agentdeck/`. **App Store macOS** → `~/Library/Containers/bound.serendipity.agentdeck.dashboard/Data/Library/Application Support/AgentDeck/` (Apple 2.5.2 — no home-relative-path entitlement, no optional App Groups capability). Swift code routes every access through `apple/AgentDeck/App/AgentDeckPaths.swift`; never hand-write either path
- **Daemon hub**: Port 9120, sole entry point for all dashboard clients. Session bridges serve internal hook HTTP only (9121-9139). Session bridges push state to daemon via internal WS (`daemon-ws-client.ts`); daemon falls back to HTTP `/health` polling when push is stale. See [docs/daemon.md](docs/daemon.md)
- **Action ID pattern**: SD actions store string IDs + `getActionById()` — never action object references
- **Shift+Tab** (`\x1b[Z`) for Claude Code mode switching (100ms debounce)
- **Version compatibility**: `agentdeck claude` checks Claude Code version via npm + GitHub on startup; never blocks startup
- **External peer async I/O**: 모든 RPC/WS/HTTP `await` 에 timeout 강제 — peer silence (silent drop, dead socket, network glitch) 를 first-class signal 로 처리해야 함 (synthetic error code emit + UI status emit + retry/fallback escalation). race condition 가드는 secondary; timeout 이 먼저. Reference 구현: `apple/AgentDeck/Daemon/Gateway/OpenClawAdapter.swift` 의 `connectRPCResponseTimeoutNanoseconds` + `completeRPCTimeout` + `handleConnectTimeout` 패턴

## Design System

Aquarium-tide design system. Spec: [DESIGN.md](DESIGN.md). Source of truth for color/type/spacing tokens: [design/tokens.css](design/tokens.css). Visual reference: [docs/design/Design System.html](docs/design/Design%20System.html). Coverage matrix + lint rules: [docs/design/Design Audit.html](docs/design/Design%20Audit.html).

**Token bindings** (all four mirror `design/tokens.css`; CSS stays canonical — update all four mirrors in the same commit when CSS tokens change):
- Browser JS — `design/tokens.js` (IIFE that exposes `window.DT.{Tide,Ink,Kelp,Coral,Amber,Status,UI,Brand}`). Used by `docs/design/data.js` and Design System.html mockups
- TS — `shared/src/design-tokens.ts` (re-exported via `@agentdeck/shared`). Use for plugin renderers, bridge, hooks
- Swift — `apple/AgentDeck/UI/Common/DesignTokens.swift` (`DesignTokens.Tide.s50` etc.). Existing `StateColors` stays as legacy
- Kotlin — `android/app/src/main/kotlin/dev/agentdeck/ui/theme/DesignTokens.kt` (`DesignTokens.Tide.s50` etc.). Existing `AgentDeckColors` stays as legacy
- Sync verification: `python3 design/verify-tokens-sync.py` — diffs the four mirrors against tokens.css and exits non-zero on drift

**Rules** (DESIGN.md §10 — enforced by `bash design/lint.sh`):
1. **No raw hex.** Use tokens (`var(--ink-900)`, `DesignTokens.Ink.s900`, etc.). Tokens are the only place hex literals live
2. **No `#fff` / `#000`.** Whites lean toward `--tide-50` sand, blacks toward `--ink-900` aquarium green
3. **Two faces only.** IBM Plex Sans (+ KR/JP) and JetBrains Mono. Never Inter / Roboto / Arial / Fraunces
4. **Status colors are semantic.** `--status-idle` / `--status-processing` / `--status-awaiting` / `--status-error`. Only **amber awaiting** animates; never animate kelp or coral
5. **Marketing vs product UI palette split.** Marketing surfaces (landing, docs, print) use the warm tokens. Product UI (menubar / e-ink / hardware / TTY) may also use the brighter `--ui-*` set. Marketing must NEVER touch `--ui-*`
6. **Brand marks are upstream — do not redraw.** `design/brand/{claudecode,codex,openclaw,opencode}.svg` are the canonical agent marks. Brand colors (#C07058 / #6166E0 / #FF4D4D / #3a3a3a) are the only saturated reds/blues allowed
7. **Real assets > drawn ones.** Hardware shots and brand marks come from `assets/` and `design/brand/`. Never illustrate hardware with hand-drawn SVG; ship the diagonal-hatch placeholder pattern (`.ad-hatch` / `.ad-placeholder`) when real assets aren't ready

**Migration**: existing UI uses pre-design-system palettes (`StateColors.Hex.*`, `AgentDeckColors.*`). New code reaches for `DesignTokens.*`; migration is incremental, not a sweep. Run `bash design/lint.sh` for the violation count baseline

## App Store build invariants

The macOS app ships through the App Store and must stay **self-contained** under App Review Guidelines 2.5.2 (no bundled interpreters) and 4.2.3 (no routing users to outside installs). The guardrails below are enforced in code, CI, and docs — preserve them on every change.

- **`AGENTDECK_APP_STORE` compile flag** is set on the macOS target in `apple/project.yml`. macOS == App Store; the legacy non-App-Store macOS GUI build is no longer maintained. The flag is retained as a defense-in-depth gate, but the macOS source tree itself contains no `Process()`, `/bin/sh`, `osascript`, `.command` script writer, or external-CLI probe (`security`, `sqlite3`, `adb`, `openclaw`, `whisper-cli`) — those code paths were removed on 2026-04-19. Do not reintroduce subprocess paths under any guard; route new functionality through entitlement-backed APIs or surface it as a "requires desktop bridge" capability gated on `DaemonService.isUsingExternalDaemon`.
- **No companion-install prompts.** App-Store-reachable UI (Setup card, Settings, menubar, alerts) must not tell the user to install, register, or launch a companion binary. Setup card copy is identical regardless of whether an `agentdeck` CLI exists on disk — differentiating based on external state is an App Review 4.2.3 red flag. See [apple/AgentDeck/UI/Monitor/SetupNeededCard.swift](apple/AgentDeck/UI/Monitor/SetupNeededCard.swift) for the canonical copy.
- **No session-launch UI in the App Store build.** The previous `Launch Session` entry point was removed on 2026-05-10 across the menubar, dashboard empty-state, and AgentDeckApp Window scenes — App Store builds never spawn Terminal windows, `.command` files, AppleScript prompts, or child processes. Sessions appear automatically once the user starts Claude Code / Codex / OpenCode in their own workspace and the AgentDeck hooks pick them up. `apple/AgentDeck/Daemon/Core/SessionLauncher.swift::showAppStoreLaunchInfo` remains as defense-in-depth (NSAlert-only path, no callers in shipped UI).
- **CI verifier**: `apple/scripts/verify-appstore-archive.sh` runs after the macOS archive step and fails the build if the shipped `.app` Mach-O contains any forbidden subprocess path string or any bundled executable besides the signed AgentDeck binary itself. Run it locally before releasing: `bash apple/scripts/verify-appstore-archive.sh $PATH_TO_APP`.
- **Feature matrix is canonical**: [docs/appstore-feature-matrix.md](docs/appstore-feature-matrix.md) is the one place that records which features are in the App Store build vs. only the terminal-managed daemon. New features land in the table before any implementation touches the App Store target.
- **Progressive enhancement on `isUsingExternalDaemon`**: capabilities that depend on the separately-installed Node.js daemon (Claude subscription quota gauges, ADB-tier device previews, Android/TC001 topology rows) render only when `DaemonService.isUsingExternalDaemon` is true. When false, the relevant UI sections are hidden — never replaced with a "sandbox limitation" notice — so the standalone app reads as feature-complete instead of broken.
- **Review notes**: [apple/APP_REVIEW_NOTES.md](apple/APP_REVIEW_NOTES.md) is the text that ships to the reviewer — its claims ("does not spawn any subprocess", "no home-relative-path entitlement", "local WebSocket only accepts same-machine + paired iOS companion") must stay factually correct. Update both the code and this doc when touching anything in that surface area.

## Documentation Index

| Doc | Topic |
|---|---|
| [DESIGN.md](DESIGN.md) | Design system spec — aquarium-tide tokens, type, components, marketing↔product palette split, hardware surfaces |
| [docs/why-apme.md](docs/why-apme.md) | **WHY** APME — 감 기반 라우팅 문제, 카테고리별 평가 전략, composite score, vibe labeling 우선 원칙 |
| [docs/apme.md](docs/apme.md) | APME eval module — schema, collector, deterministic+LLM judge, rubric tuner, daemon API, settings |
| [docs/apme-pipeline.md](docs/apme-pipeline.md) | APME 8-layer pipeline — ingestion (hook/timeline/PTY), collector→store, classifier, runner, tuner, HTTP/WS, device rendering |
| [docs/agent-harness.md](docs/agent-harness.md) | Cross-agent developer harness — how Claude Code / Codex / OpenCode / Antigravity each enter the repo, read instructions, and discover skills/workflows; skill SSOT rules |
| [docs/architecture.md](docs/architecture.md) | Monorepo layout, BridgeCore, PtyAdapter, AgentAdapter, Gateway protocol, plugin connection |
| [docs/daemon.md](docs/daemon.md) | Daemon hub, singleton guard, mDNS recovery, usage relay, Gateway isolation, multi-surface monitoring |
| [docs/plugin-conventions.md](docs/plugin-conventions.md) | Encoder LCD, wide canvas, button label, OC Timeline pipeline, D200H HID, display sleep/wake |
| [docs/v4-layout.md](docs/v4-layout.md) | v4 Session-Per-Button keypad + encoder mapping, v3→v4 changes |
| [docs/tui-dashboard.md](docs/tui-dashboard.md) | `agentdeck dashboard` — terrarium, sprites, adaptive layouts |
| [docs/esp32.md](docs/esp32.md) | Firmware boards, flash safety, WiFi provisioning, disconnect recovery |
| [docs/android.md](docs/android.md) | Android device support matrix, creature rendering |
| [docs/android-ui.md](docs/android-ui.md) | Android UI/UX Vision — e-ink + tablet layouts, creatures, refresh zones |
| [docs/voice-setup.md](docs/voice-setup.md) | Apple SFSpeech permissions + dictation model download troubleshooting |
| [docs/asc-cert-setup.md](docs/asc-cert-setup.md) | Mac Installer Distribution cert + macOS provisioning profile + GitHub Secrets step-by-step |
| [docs/appstore-feature-matrix.md](docs/appstore-feature-matrix.md) | App Store 앱 vs CLI 설치 기능 매트릭스 — downstream 디바이스 분류(ESP32/Pixoo/D200H/ADB/TC001/Android) + session 실행/usage 범위 |
| [docs/appstore-metadata-draft.md](docs/appstore-metadata-draft.md) | App Store Connect metadata draft (ko + en) — title/subtitle/description/keywords/what's-new |
| [docs/testflight-qa-checklist.md](docs/testflight-qa-checklist.md) | Internal tester pre-submission checklist covering onboarding, pairing, voice, sandbox invariants |
| [docs/devices.md](docs/devices.md) | Device-specific details |
| [docs/hardware-compatibility.md](docs/hardware-compatibility.md) | 지원 dashboard 하드웨어/OS 종합 사양 매트릭스 — 14 surface(ESP32 보드·LED·HID 데크·Apple/Android·TUI)의 SoC·해상도·Flash·SDK·deployment target. 시각화 뷰 [docs/hardware/index.html](docs/hardware/index.html) |
| [docs/protocol.md](docs/protocol.md) | Bridge ↔ plugin WebSocket protocol |
| [docs/gateway-protocol.md](docs/gateway-protocol.md) | OpenClaw Gateway WebSocket — frame format, Ed25519 handshake, RPC/event catalog, versioning |
| [docs/testing.md](docs/testing.md) | Test infrastructure reference |
| [docs/wake-word.md](docs/wake-word.md) | Porcupine / microWakeWord |
| [docs/streamdeck-layout.md](docs/streamdeck-layout.md) | Stream Deck layout reference |

## References

- **SDK Docs**: https://docs.elgato.com/streamdeck/sdk
  - [Actions](https://docs.elgato.com/streamdeck/sdk/plugin-guides/actions) · [Keys](https://docs.elgato.com/streamdeck/sdk/plugin-guides/keys) · [Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/plugin-guides/dials-touch-strip)
  - [Manifest schema](https://docs.elgato.com/streamdeck/sdk/references/manifest) · [Touch Strip Layout](https://docs.elgato.com/streamdeck/sdk/references/touch-strip-layout) · [WebSocket API](https://docs.elgato.com/streamdeck/sdk/references/websocket-api)
- **Plugin Samples**: https://github.com/elgatosf/streamdeck-plugin-samples (layouts, cat-keys, hello-world, data-sources, lights-out)
