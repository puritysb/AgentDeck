# AgentDeck

Stream Deck+ controller for AI coding agents — a bidirectional local control system.

## Monorepo

- **bridge/** — Node.js server: Daemon hub + Session Bridge (PTY, hook HTTP, state machine). `src/apme/` — APME eval module (SQLite store, collector, deterministic+LLM judge runner, category-aware rubrics, turn-level mid-session eval, Pareto recommender, daemon HTTP API). **Canonical `SessionSample`** (`shared/src/sample.ts` + `sample_events` table) is the SSOT: a bounded unit with a typed trajectory (user/assistant/model/tool/state) that both the timeline and the eval derive from. Per-unit cost via `shared/src/pricing.ts` (override-loadable), Pareto-frontier recommender (`apme/pareto.ts`) surfaced via the dashboard **Recommend** tab, trajectory scorers (`apme/scorers/`). **Eval results are off the device timeline** (timeline = activity log only) — they flow via the `apme_eval` WS event + scorecard/SQLite. **Tasks segment on explicit boundaries** (`/task close`, `/clear`) or `session_end`; TodoWrite-all-completed is a non-segmenting soft hint. Env `AGENTDECK_TIMELINE_PROJECTION=1` (default off) flips the device timeline to the sample projection (suppresses adapters' direct chat/tool rows). See [docs/apme.md](docs/apme.md)
- **plugin/** — Stream Deck SDK v2 plugin
- **plugin-ulanzi/** — Ulanzi Studio plugin for the D200H Deck Dock (official UlanziDeckPlugin-SDK). One dynamic action + session-centric two-level UX, shares the `@agentdeck/shared` `buildSessionDeck` layout engine. Connects to the daemon over WS like the SD plugin; it is the **sole** D200H driver — Node direct-HID was deleted (2026-07-08), Swift direct-HID stays dormant. Daemon reports D200H connectivity from `ulanzi-plugin` WS presence. See [plugin-ulanzi/VERIFY.md](plugin-ulanzi/VERIFY.md)
- **shared/** — TypeScript types/utils shared between bridge & plugin (protocol, states, timeline, adapter interfaces, session-utils)
- **hooks/** — Claude Code hook installer for `~/.claude/settings.json`, Codex lifecycle hook installer for `~/.codex/config.toml`, and OpenCode observer plugin installer for `~/.config/opencode/plugins/agentdeck.js` (standalone `opencode` sessions POST `opencode_*` lifecycle hooks to the daemon; self-disables in managed PTYs via `AGENTDECK_PORT`)
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package (`npx @agentdeck/setup`)
- **android/** — Jetpack Compose launcher app (CremaS, Onyx, Kobo, tablets)
- **apple/** — SwiftUI Multiplatform app (iOS/iPadOS/macOS). macOS includes **in-process Swift daemon** (`apple/AgentDeck/Daemon/`, ~63 files, no Node.js dependency) — mDNS, device modules (ADB/Serial/Pixoo/Timebox/iDotMatrix), Gateway proxy, HTTP+WS server
- **esp32/** — PlatformIO Arduino firmware (LVGL touch displays + WS2812B matrix + **InkDeck** e-ink). **InkDeck** is a Seeed TRMNL 7.5" OG DIY Kit (XIAO ESP32-S3 Plus + 800×480 UC8179 e-ink), always USB-powered, driven by custom AgentDeck firmware (PlatformIO env `inkdeck`, WiFi/WS to the daemon like other ESP32 boards). Firmware is **in development**. Formerly the "TRMNL" commercial BYOS e-ink device — that HTTP pull integration was removed (Node commit c71044bd). See [docs/devices.md](docs/devices.md#inkdeck-e-ink-custom-firmware)

See [docs/architecture.md](docs/architecture.md) for full architecture details (BridgeCore, PtyAdapter hierarchy, device modules, AgentAdapter abstraction, Gateway protocol, plugin connection model).

## Build

```bash
pnpm install
pnpm build                  # shared must build before bridge/plugin
pnpm generate-icons         # SVG → PNG icons (first build or after icon changes)
pnpm generate-creature-glyphs  # canonical creature SVG → ESP32 alpha-mask C header (esp32/.../creature_glyphs_generated.h)
pnpm generate-micro-glyphs  # Timebox Mini 11×11 glyph SSOT (bridge/src/pixoo/micro-glyphs.ts) → Swift mirror (apple/.../MicroGlyphs.generated.swift)
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
git tag apple-v0.2.3 && git push origin apple-v0.2.3  # CI → TestFlight
```

- **Apple Bundle ID**: `bound.serendipity.agent.deck` (App Store Connect 앱명: "AgentDeck Dashboard")
- **Team**: 조직 `QF36NDHYHD` (Serendipity Bound) — 2026-07-10 개인 팀(R22679GY5Z)에서 이관. 서명은 **cloud signing** (`CODE_SIGN_STYLE=Automatic` + ASC API key `-allowProvisioningUpdates`); 수동 p12/프로파일 시크릿 불필요
- **CI**: `.github/workflows/apple-release.yml` — `apple-v*` 태그 → macOS-15 runner → archive → TestFlight 업로드
- **Secrets**: `ASC_API_KEY_ID`, `ASC_ISSUER_ID`, `ASC_API_KEY_BASE64` (조직 팀 App Manager+ 역할 키)
- **Note**: the `bound.serendipity.agentdeck.*` tree is retired (the former `.dashboard` app record carries an immovable ASC build floor at 1.0.6/build 8). The fresh App Store app uses the `bound.serendipity.agent.*` tree → `bound.serendipity.agent.deck`. The Stream Deck **plugin UUID** `bound.serendipity.agentdeck` (no suffix) is a separate, immutable identifier and is unrelated to the app bundle ID.
- **Versioning**: root `VERSION` is the unified product-version SSOT (`0.2.3`); all package/platform manifests mirror it and CI enforces `pnpm verify-version`. Apple build number and Android versionCode advance independently. Delivery tags remain channel-prefixed (`apple-v*`, `android-v*`, `esp32-v*`, `npm-v*`, `streamdeck-v*`, `ulanzi-v*`). Policy + commands: [RELEASING.md](RELEASING.md)

## Development

```bash
pnpm -r --parallel dev   # watch mode for all packages
pnpm test                # run unit tests (vitest)
pnpm vitest run --coverage  # coverage report + threshold check
pnpm test:report         # unified report (vitest + Android + Apple + Robot)
pnpm test:android        # Android JUnit tests only
cd plugin && streamdeck link   # link plugin to Stream Deck app
```

### Multi-Agent Development Surface

This repo is built by switching between Claude Code, Codex, OpenCode, and Antigravity. **[docs/agent-harness.md](docs/agent-harness.md)** is the canonical map of how each agent enters the repo, what it reads, and what it auto-discovers — read it when onboarding a new agent or wondering why a skill/workflow isn't picked up.

- **Repo instructions**: `AGENTS.md` is the entry file Codex/OpenCode/Antigravity discover by convention. It requires `CLAUDE.md` first, then targeted `DEVELOPMENT_LOG.md` lookup instead of loading the full log. The active log keeps only the most recent ~2 months; older entries are archived by month under [`docs/devlog/`](docs/devlog/README.md) — grep a specific month file when you need history, never load all archives at once.
- **Repo skills (SSOT)**: canonical skills live in `.agents/skills/<name>/SKILL.md` (discovered by Codex; Claude reaches them via the pointers in `.claude/skills/`). Use them before hand-rolling commands. **`.claude/skills/*.md` are thin pointers — never put procedure content there; edit the `.agents/skills/` copy so the two agents can't drift.**
- **Workflow originals**: `.agents/workflows/` remains the canonical human-readable procedure directory; skills may route into these files. OpenCode has no skill auto-discovery — point it at these workflow files explicitly.
- **Session handoff**: use the `session-end` repo skill before `/clear`, `/new`, or handing work to another session. It summarizes current state and updates durable docs only when the change is project-significant.
- **Codex observation**: `agentdeck codex` installs AgentDeck-managed Codex lifecycle hooks in `~/.codex/config.toml` before launching the PTY bridge. `agentdeck daemon install` also installs/migrates those hooks for daemon-first setups.
- **OpenCode observation**: `agentdeck opencode` / `agentdeck daemon install` install the AgentDeck observer plugin (`~/.config/opencode/plugins/agentdeck.js`) so standalone `opencode` runs report `opencode_*` lifecycle hooks to the daemon — same observed-session timeline pipeline as direct `claude`/`codex` (`classifyObservedHookEvent` in `bridge/src/daemon-server.ts`). The Swift daemon ignores `opencode_*` (timeline parity there is a follow-up); observed Codex response text comes from the rollout tail (`bridge/src/codex-rollout-response.ts`).

### Test Infrastructure

| Framework | Scope | Config |
|-----------|-------|--------|
| **Vitest** | bridge/plugin/shared/hooks | `vitest.config.ts` — coverage thresholds enforced |
| **JUnit + Robolectric** | Android (`android/app/src/test/`) | `build.gradle.kts` — `testDebugUnitTest` |
| **XCTest** | Apple (`apple/AgentDeckTests/`) | Xcode scheme |
| **Robot Framework** | ESP32 (`esp32/robot/`) | `run.sh {build\|hw\|protocol\|perf\|all}` — `perf` requires hardware |

Coverage thresholds (regression guard): lines ≥17%, functions ≥15%, branches ≥14%, statements ≥16%. CI runs `coverage check` step after tests.

### Test Report (GitHub Pages)

- **URL**: `https://puritysb.github.io/AgentDeck/` (landing) / `/hardware/` (hardware+OS spec sheet) / `/gallery/` (device photo gallery) / `/docs/` (documentation hub) / `/demo/` (creature-simulator) / `/reports/` (test report)
- **Workflow**: `.github/workflows/test-report.yml` — push to master → Vitest + Android JUnit + Robot Framework (no-hw) + `pnpm run demo:build` → HTML report → GitHub Pages deploy. The "Assemble Pages site" step copies each surface into `_site/` (landing/hardware/gallery/docs/demo/reports)
- **Report generator**: `scripts/generate-html-report.py` — tab-based SPA dashboard. Robot tab: suite→scenario→BDD steps→board matrix→per-test elapsed time→performance table. `[PERF]` log messages auto-extracted from output.xml
- **Scenario matrix**: `scripts/scenario-matrix.json` — 10 user scenarios mapped to test files + gap analysis
- **Site surfaces (all aquarium-tide, self-contained, token-defining in `design/lint.sh`)**: `scripts/pages-index.html` (landing) · `docs/hardware/index.html` (spec sheet) · `docs/gallery/index.html` (photo gallery — drop `docs/gallery/photos/<slug>.jpg`) · `docs/site/index.html` (docs hub)

See [docs/testing.md](docs/testing.md) for full testing reference.

### Apple/Xcode Debug Diagnostics

When debugging a macOS/iOS issue that was reproduced from Xcode, do **not** ask the user to paste Xcode console output first. Capture the repository-side diagnostic bundle:

```bash
bash scripts/capture-apple-diagnostics.sh --tail 1000 --last 15m
```

Then inspect `diagnostics/apple-xcode/latest/README.md`, `diag.json`, `status.json`, `oslog-AgentDeck.log`, and `log-files/*swift-daemon.log` before editing code. Use `.agents/workflows/apple-xcode-debug.md` as the canonical workflow for Xcode-run app debugging, startup hangs, Swift daemon issues, OpenClaw pairing, WebSocket state, and hardware module state.

This diagnostic path is developer tooling only: it lives in `scripts/` and `.agents/workflows/`, writes local gitignored artifacts under `diagnostics/`, and must not add subprocesses, shell commands, terminal instructions, or external-tool prompts to the App Store app UI.

## Windows dev setup

The Node.js bridge, hook installer, and Stream Deck plugin run on Windows 11 (Apple/Android/ESP32 native builds are out of scope). Full prereqs, install/run steps, and the intentional Windows differences (ConPTY, data dir, PowerShell hook one-liner, daemon autostart via per-user Scheduled Task `AgentDeckDaemon` — `bridge/src/windows-service.ts`, NOT a session-0 Windows Service, device-module gating, darwin-only sampler) live in **[README → Windows (Bridge + Plugin)](README.md#windows-bridge--plugin)**. Code refs: `bridge/src/pty-manager.ts`, `hooks/src/install.ts`, `bridge/src/cli.ts`, `bridge/src/windows-service.ts`.

Dev-only note: when debugging Windows issues, run commands directly in PowerShell so output appears in the conversation — the Apple/Xcode diagnostic bundle is macOS-only.

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
agentdeck timebox {scan|add|list|remove|test|sync}   # Divoom Timebox Mini (BLE)
agentdeck wifi-setup         # ESP32 WiFi provisioning (--ssid, --password)
agentdeck esp32-ota <target> [--build|--firmware <path>]   # WiFi OTA push to a provisioned ESP32 board
```

**Module flags**: `--local` (all off), `--no-mdns`, `--no-adb`, `--no-serial`, `--no-pixoo`

ESP32 WiFi provisioning + disconnect recovery details: see [docs/esp32.md](docs/esp32.md). WiFi OTA v1 (device_info capability flags, `esp32_ota_begin/chunk/end/abort` over the board's WiFi WS socket, `POST /esp32/ota`) targets directly flashed AgentDeck ESP32 boards with WiFi connectivity and dual-OTA partition tables: `inkdeck`, `ulanzi_tc001`, `ttgo`, `ips35`, `round_amoled`, `86box`, `ips10`. `86box` and `ips10` require a one-time USB full flash to migrate existing factory/NO_OTA layouts to their 16MB dual-OTA partition tables before subsequent WiFi OTA works; the current lab units were migrated and daemon-verified on 2026-07-05 (`86box` OTA 7.8MB, `ips_10` OTA 6.0MB). Non-AgentDeck or non-direct-flashed devices are out of OTA scope.

**ESP32 client contract (external/forked clients)**: the AgentDeck wire contract a display-only client must honour (inbound events, `device_info`/command frames) is documented in [docs/esp32-client-contract.md](docs/esp32-client-contract.md). It has no C/C++ codegen (quicktype emits Swift/Kotlin only; unusable on no-PSRAM ArduinoJson targets), so drift is managed by discipline: when `DISPLAY_FORWARDED_EVENTS`/`SERIAL_FORWARDED_EVENTS` in `shared/src/protocol.ts` or the `device_info` field list change, re-port the **XTeink X3** fork's hand-ported client (`crosspoint-agentdeck` `src/agentdeck/protocol.*`). See [docs/esp32.md § Downstream client port sync](docs/esp32.md).

## Key Conventions

- **Hook format (CRITICAL)**: Claude Code v2.1+ requires 3-level nesting: `{ matcher: "", hooks: [{ type: "command", command: "..." }] }`. Old flat format silently fails. Bridge auto-migrates via `migrateHooksIfNeeded()` from `@agentdeck/hooks`. Codex uses lifecycle hooks in `~/.codex/config.toml` (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`) installed by `installCodexHooksIfNeeded()`. Scripts use bounded `curl` and `|| true` to avoid blocking when bridge is down
- **Plugin UUID**: `bound.serendipity.agentdeck` (immutable post-distribution)
- **Package scope**: `@agentdeck/*` (shared, bridge, plugin, hooks, setup)
- **User data dir**: `daemon.json`, `sessions.json`, `auth-token`, `settings.json`, `timeline.json`, `wifi-config.json`, `compatibility.json`, `apme.sqlite`. Path depends on distribution: **Node.js CLI + unsigned dev builds** → `~/.agentdeck/`. **App Store macOS** → `~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/` (Apple 2.5.2 — no home-relative-path entitlement, no optional App Groups capability). Swift code routes every access through `apple/AgentDeck/App/AgentDeckPaths.swift`; never hand-write either path
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
6. **Brand marks are upstream — do not redraw.** `design/brand/{claudecode,codex,openclaw,opencode,antigravity}.svg` are the canonical agent marks. Brand colors (#C07058 / #6166E0 / #FF4D4D / #3a3a3a / #5F6368) are the only saturated reds/blues allowed
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
| [RELEASING.md](RELEASING.md) | Versioning & release policy — per-track tags (apple-v/android-v/npm-v/esp32-v), monotonic-version constraints, bundle-ID change steps |
| [DESIGN.md](DESIGN.md) | Design system spec — aquarium-tide tokens, type, components, marketing↔product palette split, hardware surfaces |
| [docs/why-apme.md](docs/why-apme.md) | **WHY** APME — 감 기반 라우팅 문제, 카테고리별 평가 전략, composite score, vibe labeling 우선 원칙 |
| [docs/apme.md](docs/apme.md) | APME eval module — schema, collector, deterministic+LLM judge, scorecard/recommender, daemon API, settings |
| [docs/apme-pipeline.md](docs/apme-pipeline.md) | APME 8-layer pipeline — ingestion (hook/timeline/PTY), collector→store, classifier, runner, tuner, HTTP/WS, device rendering |
| [docs/agent-harness.md](docs/agent-harness.md) | Cross-agent developer harness — how Claude Code / Codex / OpenCode / Antigravity each enter the repo, read instructions, and discover skills/workflows; skill SSOT rules |
| [docs/architecture.md](docs/architecture.md) | Monorepo layout, BridgeCore, PtyAdapter, AgentAdapter, Gateway protocol, plugin connection |
| [docs/daemon.md](docs/daemon.md) | Daemon hub, singleton guard, mDNS recovery, usage relay, Gateway isolation, multi-surface monitoring |
| [docs/plugin-conventions.md](docs/plugin-conventions.md) | Encoder LCD, wide canvas, button label, OC Timeline pipeline, D200H (Ulanzi Studio plugin), display sleep/wake |
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
| [docs/hardware-compatibility.md](docs/hardware-compatibility.md) | 지원 dashboard 하드웨어/OS 종합 사양 매트릭스 — 16 surface(ESP32 보드·LED·HID 데크·InkDeck e-ink·Apple/Android·TUI)의 SoC·해상도·Flash·SDK·deployment target. 시각화 뷰 [docs/hardware/index.html](docs/hardware/index.html) |
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
