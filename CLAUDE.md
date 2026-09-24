# AgentDeck

Stream Deck+ controller for AI coding agents — a bidirectional local control system.

## How this file is organised

Claude Code loads this file automatically; other agents read it through `AGENTS.md`. It holds the **map**: what lives where, how to build, the
cross-cutting conventions, and an index of the domain rule files. **The rule bodies live in `.claude/rules/*.md`
(tracked in git).** Each rule file declares `paths:` globs; Claude Code loads it automatically when a file
matching those globs is touched. Codex, OpenCode and Antigravity read the same files on demand — `AGENTS.md`
says how. Measurements behind a rule are in the topic doc it links; incidents are in `DEVELOPMENT_LOG.md`
(grep it, never load it whole).

| Rule file | Loads when touching | Covers |
|---|---|---|
| [apme-eval](.claude/rules/apme-eval.md) | `bridge/src/apme/**`, `shared/src/sample.ts`, Swift `Daemon/Apme/**` | SessionSample SSOT, task/turn segmentation, `end_source`, judge chain `mlx → foundationModels`, transport gate, JSON parser, backlog drain, task titles, per-turn cost |
| [openclaw-gateway](.claude/rules/openclaw-gateway.md) | `bridge/src/openclaw*`, `shared/src/gateway-*`, Swift `Daemon/Gateway/**` | `sessions.subscribe`, per-key runs, transcript feed, link instability, three-answer health frames |
| [observed-sessions](.claude/rules/observed-sessions.md) | `bridge/src/hook-*`, `kiro-*`, `codex-*`, `claude-*`, `hooks/**`, Swift `Daemon/Session/**` | Hook format + installers, per-agent observation, PERM sources and the Claude hold predictor, subagent census, three identity axes, two id forms |
| [usage-quota](.claude/rules/usage-quota.md) | `bridge/src/usage-*`, `codex-rate-limits*`, Swift `UsageAPIClient`/`UsageRelayFreshness` | Codex window axes (stale / aged / plan / limit family), cache TTL vs poll, Claude quota recovery |
| [esp32-flash](.claude/rules/esp32-flash.md) | `esp32/**`, `tools/web-flasher/**`, `bridge/src/esp32*`, `shared/src/esp32-boards.ts` | Board map, merged factory image, preflight refusal, post-write reset, serial-suspend lease, serial teardown |
| [daemon-lifecycle](.claude/rules/daemon-lifecycle.md) | `bridge/src/daemon*`, `auth.ts`, `pairing-*`, `network-posture.ts`, Swift `DaemonService`/`Server/**` | Timeline persistence, network posture, LAN default-deny, pairing window/approval, token custody, ownership, mDNS name, supervisor routing, port intent, build identity, restart verification, wake detector (clock drift, not tick gap) |
| [swift-daemon](.claude/rules/swift-daemon.md) | `apple/**` | `@DaemonActor`, `NSApp.windows`, scheduled self-restart, epoch-guarded teardown, `DaemonOwnershipChange`, ObjC exceptions, bounded awaits, progress indicators |
| [devices-and-wire](.claude/rules/devices-and-wire.md) | `shared/**`, `plugin*/**`, `android/**`, `bridge/src/pixoo/**`, `modules/**`, Swift `Daemon/Modules/**` | Surface boundary, weather cache, wire booleans, integer stamps, unknown agentType, back-dated dedup, device-keyed work, baked animation loops, dot-matrix masks, Ulanzi WASM packaging, BLE worker breaker |
| [managed-sessions](.claude/rules/managed-sessions.md) | `bridge/src/cli.ts`, `pty-manager.ts`, `adapters/**` | `--weight`, `AGENTDECK_*_ARGS`, node-pty helper repair |
| [design-system](.claude/rules/design-system.md) | `design/**`, `docs/**`, UI dirs, `*.css`, `*.html` | Seven design rules, token mirrors, coverage and Markdown gates |
| [apple-release](.claude/rules/apple-release.md) | `apple/**`, `RELEASING.md`, `.github/workflows/**` | App Store invariants, five release states, CHANGELOG-rendered release bodies |

Two constraints on editing this layout: a rule that more than one domain needs stays in this file, and a rule body
is moved, never paraphrased — the headline sentence is the rule, the rest is the evidence. `esp32/CLAUDE.md` is a
nested instruction file Claude Code loads when working under `esp32/`; Codex reaches it through `AGENTS.md`.

## Monorepo

- **bridge/** — Node.js server: Daemon hub + Session Bridge (PTY, hook HTTP, state machine). `src/apme/` — APME eval module (SQLite store, collector, deterministic+LLM judge runner, category-aware rubrics, turn-level mid-session eval, Pareto recommender, daemon HTTP API). Invariants: [.claude/rules/apme-eval.md](.claude/rules/apme-eval.md); full detail and the measurements behind each rule in [docs/apme.md](docs/apme.md).
- **plugin/** — Stream Deck SDK v2 plugin for macOS and Windows. Six actions: two keypad (`session-slot`, plus the opt-in Claude-limit gauge `limit-key`, which is placeable but in no bundled profile) + four SD+ encoders — E1 Volume (`utility-dial`), E2 Claude Usage (`option-dial`), E3 Codex Usage (`iterm-dial`), E4 Launcher (`launcher`). UUIDs are immutable post-distribution so several no longer match their display name; the mapping is in [docs/streamdeck-layout.md](docs/streamdeck-layout.md). Host controls dispatch per-platform through `plugin/src/system/` (darwin/win32 backends behind one facade): macOS uses `osascript`/`open`, Windows uses a persistent PowerShell CoreAudio coprocess for volume, `rundll32` for URLs, and a safe `Get-StartApps` lookup for desktop apps. `SDKVersion: 3` is mandatory — Maker Console rejects 2 ("Minimum Manifest SDK version must be 3 or later") and DRM follows from the SDK version; verify the DRM-processed build's encoders through the review loop before publishing (see streamdeck-layout)
- **plugin-ulanzi/** — Ulanzi Studio plugin for the D200H Deck Dock and D200X LCD keys (official UlanziDeckPlugin-SDK). One dynamic keypad action + session-centric two-level UX, sharing the `@agentdeck/shared` `buildSessionDeck` layout engine. D200X encoders are a separate, not-yet-shipped action/UX; keypad support must not imply encoder support. Connects to the daemon over WS like the SD plugin and is the **sole** Ulanzi deck driver — the Node/Swift direct-HID paths and the legacy `zkswe/` research tree are gone. The Studio handshake does not identify D200H versus D200X, so the daemon preserves the historical `d200h` health wire identity and reports connectivity from `ulanzi-plugin` WS presence. Packaging rule (WASM resvg, no native binary, fonts load-bearing): [.claude/rules/devices-and-wire.md](.claude/rules/devices-and-wire.md#ulanzi-plugin-packaging); verify procedure [plugin-ulanzi/VERIFY.md](plugin-ulanzi/VERIFY.md)
- **shared/** — TypeScript types/utils shared between bridge & plugin (protocol, states, timeline, adapter interfaces, session-utils)
- **hooks/** — Claude Code CLI hook installer for the user-global `~/.claude/settings.json` (`settings.local.json` is a dead file at user scope and is only cleaned up — see [.claude/rules/observed-sessions.md](.claude/rules/observed-sessions.md)), Codex lifecycle hook installer for `~/.codex/config.toml`, and OpenCode observer plugin installer for `~/.config/opencode/plugins/agentdeck.js` (standalone `opencode` sessions POST `opencode_*` lifecycle hooks to the daemon; self-disables in managed PTYs via `AGENTDECK_PORT`)
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package (`npx @agentdeck/setup`)
- **android/** — Jetpack Compose launcher app (CremaS, Onyx, Kobo, tablets)
- **apple/** — SwiftUI Multiplatform app (iOS/iPadOS/macOS). macOS includes **in-process Swift daemon** (`apple/AgentDeck/Daemon/`, no Node.js dependency) — mDNS, device modules (ADB/Serial/Pixoo/Timebox/iDotMatrix), Gateway proxy, HTTP+WS server
- **esp32/** — PlatformIO Arduino firmware (LVGL touch displays + WS2812B matrix + **TRMNL 7.5"** e-ink). **TRMNL 7.5"** is a Seeed TRMNL 7.5" OG DIY Kit (XIAO ESP32-S3 Plus + 800×480 UC8179 e-ink), always USB-powered, driven by custom AgentDeck firmware (PlatformIO env `trmnl_75`, WiFi/WS to the daemon like other ESP32 boards). Board rules, flash safety and the e-ink geometry SSOT: [.claude/rules/esp32-flash.md](.claude/rules/esp32-flash.md), [esp32/CLAUDE.md](esp32/CLAUDE.md), [docs/devices.md](docs/devices.md#trmnl-75-e-ink-custom-firmware)

See [docs/architecture.md](docs/architecture.md) for full architecture details (BridgeCore, PtyAdapter hierarchy, device modules, AgentAdapter abstraction, Gateway protocol, plugin connection model).

**Managed-session compatibility:** `agentdeck claude`, `agentdeck codex`,
`agentdeck opencode`, and `agentdeck monitor` remain functional with no removal
date. New ordinary-session work targets `agentdeck daemon install` plus normal
agent commands, but managed-only remote attach, `--weight`,
`AGENTDECK_<AGENT>_ARGS`, and terminal controls are product contracts until
validated replacements exist. [Discussion #278](https://github.com/puritysb/AgentDeck/discussions/278)
collects workflows; [#273](https://github.com/puritysb/AgentDeck/issues/273)
owns implementation gates. Do not add new PTY parser or per-session bridge
dependencies unless #273 first records why daemon-first cannot own the
capability; likewise, do not delete a managed dependency while a tracked
workflow still relies on it.

## Build

**Node runtime support:** the Node bridge/tooling supports the maintained,
prebuild-verified even lines **22, 24, and 26**. Node 20 reached EOL in April
2026 and is intentionally unsupported; odd-numbered releases are not product
targets. `package.json` declares the range and `pnpm-workspace.yaml`'s `engineStrict` makes it fatal, while
`agentdeck diag native` opens an in-memory `better-sqlite3` database under the
exact executable/ABI that will run the daemon. Windows daemon autostart pins
that executable, so rerun `npx @agentdeck/setup --yes` after changing Node
installations to reinstall native bindings and re-register the Scheduled Task.

```bash
pnpm install
pnpm build                  # shared must build before bridge/plugin
pnpm generate-icons         # SVG → PNG icons (first build or after icon changes)
pnpm generate-creature-glyphs  # canonical creature SVG → ESP32 alpha-mask C header (esp32/.../creature_glyphs_generated.h)
pnpm generate-micro-glyphs  # Timebox 11×11 TS→Swift mirror + official brand SVG → Pixoo/iDotMatrix/TC001 generated alpha masks
pnpm generate-protocol      # protocol.ts → JSON Schema → Swift/Kotlin types (generated/protocol/)
pnpm generate-terrarium-rules  # terrarium-rules.ts SSOT → Swift/Kotlin/C++ generated mirrors (vitest drift gate)
```

## Android Build

For Compose and e-ink UI changes, read [docs/android-ui.md](docs/android-ui.md) and [docs/android.md](docs/android.md).

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

### Apple Release (App Store / TestFlight)

Release steps, local build commands, identity/signing, CI secrets, and current App Store state live in **[RELEASING.md § Apple](RELEASING.md)**. Two invariants that apply outside a release:

- **Bundle ID** `bound.serendipity.agent.deck`. The retired `bound.serendipity.agentdeck.*` tree carries an immovable ASC build floor (1.0.6/build 8) — never target it. The Stream Deck **plugin UUID** `bound.serendipity.agentdeck` (no suffix) is a separate, immutable identifier, unrelated to the app bundle ID.
- **Versioning**: root `VERSION` is the repository baseline and compatibility-major anchor (`1.0.2`), not a minor/patch ceiling. Numeric `X.Y.Z` versions are mutually compatible exactly when `X` matches: major changes are protocol-breaking or exceptionally large coordinated migrations, minor changes add substantial backward-compatible features, and patch changes are small backward-compatible fixes. Minor and patch values may advance independently by target. Each target's internal mirrors and its own release tag must match exactly, and `pnpm verify-version` enforces repository compatibility. Apple build number and Android versionCode advance only when those targets ship. Delivery tags remain channel-prefixed (`apple-v*`, `android-v*`, `esp32-v*`, `npm-v*`, `streamdeck-v*`, `ulanzi-v*`).

## Development

```bash
pnpm -r --parallel dev   # watch mode for all packages
pnpm test                # run unit tests (vitest)
pnpm vitest run --coverage  # coverage report + threshold check
pnpm test:report         # unified report (vitest + Android + Apple + Robot)
pnpm test:android        # Android JUnit tests only
pnpm plugin:deploy          # macOS: build, link, restart, verify actual plugin runtime
pnpm plugin:check           # verify installed source and running bundle identity
```

### Multi-Agent Development Surface

This repo is built by switching between Claude Code, Codex, OpenCode, and Antigravity. **[docs/agent-harness.md](docs/agent-harness.md)** is the canonical map of how each agent enters the repo, what it reads, and what it auto-discovers — read it when onboarding a new agent or wondering why a skill/workflow isn't picked up.

- **Repo instructions**: `AGENTS.md` is the entry file Codex/OpenCode/Antigravity discover by convention. It requires `CLAUDE.md` first, then targeted `DEVELOPMENT_LOG.md` lookup instead of loading the full log. **`DEVELOPMENT_LOG.md` and `docs/devlog/YYYY-MM.md` are generated** from one file per entry in `docs/devlog/entries/` (`pnpm devlog:build`; `pnpm devlog:check` gates CI) — add an entry as a new file (first line `# YYYY-MM-DD — title`, links relative to the repo root) and rebuild; a merge conflict in an aggregate is resolved by rebuilding, never by picking a side. Grep a specific month file for history, never load all archives at once.
- **Repo skills (SSOT)**: canonical skills live in `.agents/skills/<name>/SKILL.md` — the only copy. Codex discovers that directory natively; Claude Code discovers `.claude/skills/<name>`, which is a tracked **symlink** to the same directory (verified 2026-09-10: all five appear in a `claude -p` skill listing). Add a skill under `.agents/skills/` and add the symlink; never write a pointer or a second copy.
- **Workflow originals**: `.agents/workflows/` remains the canonical human-readable procedure directory; skills may route into these files. OpenCode has no skill auto-discovery — point it at these workflow files explicitly.
- **Session handoff**: use the `session-end` repo skill before `/clear`, `/new`, or handing work to another session. It summarizes current state and updates durable docs only when the change is project-significant.
- **Domain rules (SSOT)**: `.claude/rules/<domain>.md` are tracked in git and are the canonical text of every domain invariant (table above). Claude Code loads them by `paths:`; other agents read the matching file before editing in that area. Add a rule to the domain file, not to this map; a genuinely cross-cutting rule goes under Key Conventions here.
- **Agent observation** (Codex hooks, OpenCode observer plugin, Kiro transcripts, OpenClaw Gateway): [.claude/rules/observed-sessions.md](.claude/rules/observed-sessions.md), [.claude/rules/openclaw-gateway.md](.claude/rules/openclaw-gateway.md).

### Agent working agreements

- **Current task instructions and authorization govern the work.** Within system and execution-policy limits, follow the user's current request over skill guidance or historical memory. Reuse authorization already established in the task. Resolve routine, reversible implementation choices and continue; ask only when missing information materially changes scope or an action needs authorization not already provided. Network, GUI, device access, or a path outside the checkout alone does not create a new approval requirement. If execution policy blocks an action, use an available permitted path or explain the exact blocker; request escalation only when the harness supports it.
- **Required project rules live in tracked documents.** This file owns cross-cutting rules; the indexed domain files own their invariants; skills own procedures. Personal memories and devlog entries are dated evidence and search hints, not additional authorization or permanent gates. Check current source and runtime before reusing old branch, release, device, or approval state. When project documents conflict, use the owning canonical document and correct the duplicate; surface unresolved consequential conflicts instead of guessing.
- **Use a dedicated worktree before a multi-file edit in this shared repository.** Reuse the task's isolated checkout if it already has one. Otherwise inspect `git status` and `git worktree list`, then create a task branch/worktree from the intended base without switching the shared checkout's HEAD. A single-file edit also needs isolation when another session may touch that file. Before committing, inspect the current branch and the complete staged diff. Never clean a shared tree with whole-file restore, stash, reset, or rebase to remove supposed task-owned changes; preserve other sessions' work. Remove a task worktree only after its tracked and untracked work is preserved and it has no active owner.
- **Before commands that affect a daemon or system environment**, read [.claude/rules/daemon-lifecycle.md](.claude/rules/daemon-lifecycle.md) and use the supported `agentdeck daemon …` lifecycle commands. Port 9120 and connected hardware are shared across sessions.
- **Keep verification proportional and report evidence.** Follow Verification scope below, distinguish source changes from installed/runtime state, and stop repeating successful checks unless a new change or unresolved failure warrants it. Report the result and remaining limitation concisely.

### Verification scope

| Change | Required local checks before a commit |
|---|---|
| Markdown, instructions, or memory only; no executable/template/schema changes | `pnpm docs:check`; `pnpm design-system:check` when cataloged docs or catalog metadata change; `pnpm devlog:build` then `pnpm devlog:check` when entries change; validate any changed skills |
| Code, build configuration, executable templates, or schemas | `pnpm build && pnpm typecheck && pnpm test`; `pnpm generate-protocol` must leave no drift; `bash design/lint.sh`; `python3 design/verify-tokens-sync.py`; relevant native/domain checks from the indexed rules/workflows |
| Release or deployment | The applicable release/deploy workflow and domain gates, including the Release archive check for App Store submission |

Run the checks for every applicable row. A docs-only local exception does not waive CI or release gates. For code fixes, add regression coverage when it exercises meaningful changed behavior; do not add tests that only restate low-impact edits. If a required check fails, identify whether it is caused by the change or the base and report it explicitly.

### Test Infrastructure

| Framework | Scope | Config |
|-----------|-------|--------|
| **Vitest** | bridge/plugin/shared/hooks | `vitest.config.ts` — coverage thresholds enforced |
| **JUnit + Robolectric** | Android (`android/app/src/test/`) | `build.gradle.kts` — `testDebugUnitTest` |
| **XCTest** | Apple (`apple/AgentDeckTests/`) | Xcode scheme |
| **Robot Framework** | ESP32 (`esp32/robot/`) | `run.sh {build\|hw\|protocol\|perf\|all}` — `perf` requires hardware |

Coverage thresholds (regression guard, enforced by `vitest.config.ts`): lines ≥17%, functions ≥15%, branches ≥14%, statements ≥16%. CI runs `npx vitest run --coverage`.

### GitHub Pages and Build Health

Site surfaces, the CI report generator, the sync gates (`sync-pages-nav`, `sync-hardware-spec-cards`, `check-surface-mirrors`, `check-preview-mirror-sync`), and the device photography pipeline are documented in **[docs/pages-site.md](docs/pages-site.md)**. Read it before touching anything under `scripts/`, `docs/hardware/`, or `tools/creature-simulator/`.

See [docs/testing.md](docs/testing.md) for full testing reference.

### Apple/Xcode Debug Diagnostics

When debugging a macOS/iOS issue reproduced from Xcode, do **not** ask the user to paste Xcode console output first — capture the repository-side diagnostic bundle. `.agents/workflows/apple-xcode-debug.md` is the canonical workflow (bundle capture, startup hangs, Swift daemon issues, OpenClaw pairing, WebSocket state, hardware module state).

This diagnostic path is developer tooling only: it lives in `scripts/` and `.agents/workflows/`, writes local gitignored artifacts under `diagnostics/`, and must not add subprocesses, shell commands, terminal instructions, or external-tool prompts to the App Store app UI.

## Windows dev setup

The Node.js bridge, hook installer, and Stream Deck plugin run on Windows 11 (Apple/Android/ESP32 native builds are out of scope). Full prereqs, install/run steps, and the intentional Windows differences (ConPTY, data dir, file-based PowerShell hook script, daemon autostart via per-user Scheduled Task `AgentDeckDaemon` — `bridge/src/windows-service.ts`, NOT a session-0 Windows Service, device-module gating, darwin-only sampler) live in **[docs/windows.md](docs/windows.md)**. Code refs: `bridge/src/pty-manager.ts`, `hooks/src/install.ts`, `bridge/src/cli.ts`, `bridge/src/windows-service.ts`.

## Linux dev setup

The Node.js bridge + daemon run on Linux; the **Stream Deck desktop app is unavailable**, so the plugin host and its setup/CLI steps are skipped (device control is via the daemon + Apple/Android companions). Normal `claude`/`codex`/`opencode` observation, mDNS (pure-JS `bonjour-service`), and hook HTTP all work; the legacy `agentdeck <agent>` managed path remains functional for compatibility while replacements are validated. Autostart is a per-user **systemd `--user` unit** `agentdeck-daemon.service` (`bridge/src/linux-service.ts`, analog of the LaunchAgent/Scheduled Task; degrades to a manual-start hint without systemd; `loginctl enable-linger` for headless boot). `npx @agentdeck/setup` checks for a C toolchain (`node-pty` still builds from source for the managed PTY path) instead of Xcode CLT and skips Stream Deck checks. Full prereqs/differences: **[docs/linux.md](docs/linux.md)** (README links it the same way as docs/windows.md). Code refs: `bridge/src/linux-service.ts`, `bridge/src/cli.ts`, `bridge/src/pty-manager.ts`, `setup/src/setup.ts`.

Dev-only note: when debugging Windows issues, run commands directly in PowerShell so output appears in the conversation — the Apple/Xcode diagnostic bundle is macOS-only.

## CLI

The CLI command is `agentdeck` (`bridge/src/cli.ts`).

Full command list: `agentdeck --help`, or [docs/cli.md](docs/cli.md) for the annotated reference.

**Module flags**: `--local` (all device modules off), `--no-adb` (skip ADB reverse). There are no per-session `--no-mdns`/`--no-serial`/`--no-pixoo` flags — hardware modules are daemon-only and session bridges never activate them

**Session sort weight** (`--weight <n>`, -9999..9999), **env-var default args** (`AGENTDECK_COMMANDER_ARGS`, `AGENTDECK_<AGENT>_ARGS`, `--no-env-args`) and the **node-pty macOS helper-mode repair** are specified in [.claude/rules/managed-sessions.md](.claude/rules/managed-sessions.md) and [docs/cli.md](docs/cli.md).

ESP32 provisioning, WiFi OTA scope, the external-client wire contract, and Autonomous Pocket are documented in [esp32/CLAUDE.md](esp32/CLAUDE.md) (loads when working under `esp32/`) and [docs/esp32.md](docs/esp32.md).

## Key Conventions

Cross-cutting rules that more than one domain needs. Domain-specific invariants are in the rule files indexed at the top.

- **Hook format (CRITICAL)**: Claude Code v2.1+ requires 3-level nesting: `{ matcher: "", hooks: [{ type: "command", command: "..." }] }` — the old flat format silently fails. Every installer targets the user-global `~/.claude/settings.json`; fire-and-forget hook curls keep `--connect-timeout 0.2 --max-time 0.8`, only `PreToolUse` (60s) and `Stop` (10s) are request-response, and every Claude hook sends `-H "X-AgentDeck-Pid: $PPID"`. The snippet is mirrored byte-identically in `hooks/src/install.ts`, `setup/src/setup.ts` and `HookInstaller.swift` — change all three together. Codex/Kiro installers, migrations and the full rationale: [.claude/rules/observed-sessions.md](.claude/rules/observed-sessions.md#hook-format-and-installers).
- **Plugin UUID**: `bound.serendipity.agentdeck` (immutable post-distribution)
- **Package scope**: `@agentdeck/*` (shared, bridge, plugin, hooks, setup)
- **Cross-platform rules are SSOT-first**: any numeric rule, coordinate, clamp, or contract that more than one surface (TS/Swift/Kotlin/C++) must agree on is defined in its canonical source first, then generated/mirrored outward behind a drift gate — never introduced as a per-platform literal. **The full source → generator → gate index is [docs/architecture.md § Cross-platform SSOT catalogue](docs/architecture.md)**; add a row there in the same commit as a new SSOT. Four rules govern every row. **A comment-only edit still drifts** — JSDoc is carried into the Swift/Kotlin mirrors, and it also moves a `SYNC-HASH` blob hash, so grep `SYNC-HASH <path>` for every pin before editing any pinned origin. **A generated or derived value is never a merge side**: when a `SYNC-HASH` pin or any generated mirror conflicts during a rebase/cherry-pick, neither branch's value is authoritative — both are stale the moment the pinned origin is resolved. Recompute from the resolved file (`git hash-object <pinned-path>`) and only then stage it; picking `--ours`/`--theirs` lands a pin that matches no file on disk and the gate goes green on a lie only if you are unlucky. **Two SSOTs may split one table only over disjoint column sets bound by one gate**, never as a second copy (`shared/src/esp32-boards.ts` machine columns vs `docs/hardware-compatibility.md` human columns). And **never add a new hand mirror** — the remaining debt is listed in the catalogue.
- **User data dir**: `daemon.json`, `sessions.json`, `auth-token`, `settings.json`, `timeline.json`, `wifi-config.json`, `compatibility.json`, `pocket-autonomy.json`, `apme.sqlite`. Path depends on distribution: **Node.js CLI + unsigned dev builds** → `~/.agentdeck/`. **App Store macOS** → `~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/` (App Sandbox container — the app requests no home-relative-path entitlement and no App Groups capability; a Sandbox/entitlement consequence, not Guideline 2.5.2). Swift code routes every access through `apple/AgentDeck/App/AgentDeckPaths.swift`; never hand-write either path
- **Timeline persistence is daemon-owned**: only the bound daemon writes `timeline.json` (tmp+rename, after the startup rehydrate); session bridges and the plugin never do, and the format is bidirectional between Node and Swift. Detail: [.claude/rules/daemon-lifecycle.md](.claude/rules/daemon-lifecycle.md#persistence-and-hub).
- **Daemon hub**: Port 9120, sole entry point for all dashboard clients. Session bridges serve internal hook HTTP only (9121-9139). Session bridges push state to daemon via internal WS (`daemon-ws-client.ts`); daemon falls back to HTTP `/health` polling when push is stale. That internal WS is **bidirectional**: for opt-in cross-machine attach (`--remote-daemon`, optionally `--daemon-host <host>` — the switch gates both remote paths) the daemon drives a remote session back **down the same socket** (`session_command_down`/`session_event_up` — the only reverse path; no inbound reachability needed, the daemon never dials back). Requires a daemon advertising `sameSocketControl` in `/health` (Node CLI daemon only). See [docs/daemon.md](docs/daemon.md)
- **LAN surface is default-deny** (issue #145): the daemon binds `0.0.0.0` on purpose, so the security boundary is the pairing token enforced at one chokepoint per daemon (`bridge/src/http-auth-gate.ts` / `DaemonServer.httpAccessResponse`). An unauthenticated LAN peer reaches only a minimal `GET /health` with no token, no modules, no state. Never add a standing unauthenticated route or put the token in a discovery payload. Posture flags, pairing window/approval, token custody and ownership: [.claude/rules/daemon-lifecycle.md](.claude/rules/daemon-lifecycle.md).
- **Swift daemon isolation**: the macOS in-process daemon runs on **`@DaemonActor`** (`apple/AgentDeck/Daemon/Core/DaemonActor.swift`), NOT `@MainActor` — it is hosted in the GUI app, and sharing the main executor let a busy render loop starve it. New rule: a type holding daemon state is `@DaemonActor`; UI types stay `@MainActor` and are reached with `await`. **Never write a `@convention(c)` callback inline inside an isolated method** — it inherits that isolation statically, a function pointer cannot carry it, and Swift compiles in an executor assertion that traps at runtime (this killed the app via the IOKit power callback). Declare such callbacks at file scope. Swift 6 mode verifies data races but cannot see this. See [docs/architecture.md § Swift daemon isolation](docs/architecture.md) and [.claude/rules/swift-daemon.md](.claude/rules/swift-daemon.md)
- **Action ID pattern**: SD actions store string IDs + `getActionById()` — never action object references
- **Shift+Tab** (`\x1b[Z`) for Claude Code mode switching (100ms debounce)
- **Wire booleans carry both signals; an epoch-ms stamp is an integer; an unknown `agentType` renders as nothing, never as another agent.** In a retain-on-absent protocol an omitted key means "no information", so emit the explicit `false`; a fractional stamp makes a strict Kotlin client drop the whole frame; agent buckets are allow-lists. Evidence and gates: [.claude/rules/devices-and-wire.md](.claude/rules/devices-and-wire.md#wire-semantics).
- **A probe has three answers, not two.** Unreadable flash id, failed `lsof`, a health frame with no `ok`, a `kill(pid,0)` EPERM, a missing `capturedAt`: each is "I could not look", and it must neither launder into "free/healthy" nor into "broken". Keep `unknown` as its own value and let the caller retain, refuse, or stay permissive by explicit rule. Instances: [esp32-flash](.claude/rules/esp32-flash.md), [daemon-lifecycle](.claude/rules/daemon-lifecycle.md), [openclaw-gateway](.claude/rules/openclaw-gateway.md), [usage-quota](.claude/rules/usage-quota.md).
- **External peer async I/O**: every RPC/WS/HTTP `await` against a peer carries a timeout — peer silence is a first-class signal (synthetic error + UI status + retry/fallback), and the race-condition guard is secondary. Reference implementation and the bounded-teardown rule: [.claude/rules/swift-daemon.md](.claude/rules/swift-daemon.md#foundation-and-async-traps).

## Design System

Aquarium-tide design system. Spec: [DESIGN.md](DESIGN.md); token SSOT [design/tokens.css](design/tokens.css); resource map [design/RESOURCES.md](design/RESOURCES.md). Seven rules enforced by `bash design/lint.sh`: no raw hex, no `#fff`/`#000`, two type faces (IBM Plex Sans + JetBrains Mono), semantic status colours (only amber awaiting animates), marketing never touches `--ui-*`, brand marks are upstream SVGs (never redrawn), real assets over drawn ones. Token mirrors (JS/TS/Swift/Kotlin + three non-binding copies) are checked by `python3 design/verify-tokens-sync.py`. **Adding a file under `docs/` requires a catalog entry or a stated exclusion in the same commit** (`pnpm design-system:check`), and `pnpm docs:check` validates Markdown links. Full rules, mirrors and gates: [.claude/rules/design-system.md](.claude/rules/design-system.md).

## App Store build invariants

The macOS app ships through the App Store and must stay **self-contained** (Guidelines 2.5.2 / 4.2.3): no subprocess paths in the macOS tree under any guard, no companion-install prompts, no session-launch UI, features gated on `DaemonService.isUsingExternalDaemon` are hidden (never replaced with a limitation notice), and `apple/scripts/verify-appstore-archive.sh` must pass on the Release archive. New features land in [docs/appstore-feature-matrix.md](docs/appstore-feature-matrix.md) before implementation. A release has five states (CI green / artifact / uploaded / submitted / live) and GitHub Release bodies render from `CHANGELOG.md`. Full text: [.claude/rules/apple-release.md](.claude/rules/apple-release.md).

## Documentation Index

Topic docs live in [docs/](docs/) — the filenames are the index, and the canonical ones are linked inline from the sections above. The design-system viewer's `catalog.json` binds the subset that is reader-facing.

## References

- **SDK Docs**: https://docs.elgato.com/streamdeck/sdk
  - [Actions](https://docs.elgato.com/streamdeck/sdk/plugin-guides/actions) · [Keys](https://docs.elgato.com/streamdeck/sdk/plugin-guides/keys) · [Dials & Touch Strip](https://docs.elgato.com/streamdeck/sdk/plugin-guides/dials-touch-strip)
  - [Manifest schema](https://docs.elgato.com/streamdeck/sdk/references/manifest) · [Touch Strip Layout](https://docs.elgato.com/streamdeck/sdk/references/touch-strip-layout) · [WebSocket API](https://docs.elgato.com/streamdeck/sdk/references/websocket-api)
- **Plugin Samples**: https://github.com/elgatosf/streamdeck-plugin-samples (layouts, cat-keys, hello-world, data-sources, lights-out)

## Worktree 자동 정리 (workmux)

현재 작업 경로(`pwd`)가 `__worktrees` 를 포함하면 workmux worktree 안에서 작업 중인 것이다.
이 경우 **작업이 완전히 끝났을 때 (모든 서브에이전트/teammate 완료 포함)** 다음을 실행한다:

    workmux remove --keep-branch

- `--keep-branch`: worktree/session/pane만 정리하고 **브랜치는 살림** (나중에 `workmux merge` 로 머지 가능)
- 이 지시는 메인 repo(`__worktrees` 경로 아님)에서는 무시한다
- 진행 중에는 절대 실행 금지 — 완료 확인 후에만
