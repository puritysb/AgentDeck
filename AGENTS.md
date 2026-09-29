# AgentDeck

Stream Deck+ controller for AI coding agents — a bidirectional local control system.

## How this file is organised

This is the repository's only root instruction file; there is no `CLAUDE.md`. Claude Code (2.1.277+) loads
`AGENTS.md` whenever no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or
any directory above it — never add one of those here, it would silently replace this file. Codex injects the
root→cwd `AGENTS.md` chain and stops adding files once the combined size reaches `project_doc_max_bytes`
(32 KiB default), so this file plus `esp32/AGENTS.md` must stay under that together (`pnpm docs:check` gates both the
budget and any shadowing `CLAUDE.md`); OpenCode and Antigravity
read it by convention. It is the **map**; **the rule bodies live in `.claude/rules/*.md` (tracked in git).** Each rule file
declares `paths:` globs; Claude Code loads it automatically when a file matching those globs is touched. Codex,
OpenCode and Antigravity have no path-conditional loading and must read the matching file **before the first edit**
in that area (`.codex/rules` is exec policy, not instructions). Measurements behind a rule are in the topic doc it
links; incidents are in `DEVELOPMENT_LOG.md` (grep it, never load it whole).

| Rule file | Loads when touching | Covers |
|---|---|---|
| [apme-eval](.claude/rules/apme-eval.md) | `bridge/src/apme/**`, `shared/src/sample.ts`, Swift `Daemon/Apme/**` | SessionSample SSOT, task/turn segmentation, `end_source`, judge chain `mlx → foundationModels`, transport gate, JSON parser, backlog drain, task titles, per-turn cost |
| [openclaw-gateway](.claude/rules/openclaw-gateway.md) | `bridge/src/openclaw*`, `shared/src/gateway-*`, Swift `Daemon/Gateway/**` | `sessions.subscribe`, per-key runs, transcript feed, link instability, three-answer health frames |
| [observed-sessions](.claude/rules/observed-sessions.md) | `bridge/src/hook-*`, `kiro-*`, `codex-*`, `claude-*`, `hooks/**`, Swift `Daemon/Session/**` | Hook format + installers, per-agent observation, PERM sources and the Claude hold predictor, subagent census, three identity axes, two id forms |
| [usage-quota](.claude/rules/usage-quota.md) | `bridge/src/usage-*`, `codex-rate-limits*`, Swift `UsageAPIClient`/`UsageRelayFreshness` | Codex window axes (stale / aged / plan / limit family), cache TTL vs poll, Claude quota recovery |
| [esp32-flash](.claude/rules/esp32-flash.md) | `esp32/**`, `tools/web-flasher/**`, `bridge/src/esp32*`, `shared/src/esp32-boards.ts` | Board map, merged factory image, preflight refusal, post-write reset, serial-suspend lease, serial teardown |
| [daemon-lifecycle](.claude/rules/daemon-lifecycle.md) | `bridge/src/daemon*`, `auth.ts`, `pairing-*`, `network-posture.ts`, Swift `DaemonService`/`Server/**` | Timeline persistence, network posture, LAN default-deny, pairing, token custody, ownership, mDNS name, supervisor routing, port intent, build identity, restart verification, wake detector |
| [swift-daemon](.claude/rules/swift-daemon.md) | `apple/**` | `@DaemonActor`, `NSApp.windows`, scheduled self-restart, epoch-guarded teardown, `DaemonOwnershipChange`, ObjC exceptions, bounded awaits, progress indicators |
| [devices-and-wire](.claude/rules/devices-and-wire.md) | `shared/**`, `plugin*/**`, `android/**`, `bridge/src/pixoo/**`, `modules/**`, Swift `Daemon/Modules/**` | Surface boundary, weather cache, wire semantics, unknown agentType, back-dated dedup, device-keyed work, baked animation loops, dot-matrix masks, Ulanzi WASM packaging, BLE worker breaker |
| [managed-sessions](.claude/rules/managed-sessions.md) | `bridge/src/cli.ts`, `pty-manager.ts`, `adapters/**` | `--weight`, `AGENTDECK_*_ARGS`, node-pty helper repair |
| [design-system](.claude/rules/design-system.md) | `design/**`, `docs/**`, UI dirs, `*.css`, `*.html` | Seven design rules, token mirrors, coverage and Markdown gates |
| [apple-release](.claude/rules/apple-release.md) | `apple/**`, `RELEASING.md`, `.github/workflows/**` | App Store invariants, five release states, CHANGELOG-rendered release bodies |

Two constraints on editing this layout: a rule that more than one domain needs stays in this file, and a rule body
is moved, never paraphrased — the headline sentence is the rule, the rest is the evidence. `esp32/AGENTS.md` is the
nested instruction file for work under `esp32/`: Claude Code loads it when it first reads a file there, Codex when
its working directory is under `esp32/`.

## Monorepo

- **bridge/** — Node.js server: Daemon hub + Session Bridge (PTY, hook HTTP, state machine). `src/apme/` — APME eval module (SQLite store, collector, deterministic+LLM judge runner, category-aware rubrics, turn-level mid-session eval, Pareto recommender, daemon HTTP API). Invariants: [.claude/rules/apme-eval.md](.claude/rules/apme-eval.md); full detail and the measurements behind each rule in [docs/apme.md](docs/apme.md).
- **plugin/** — Stream Deck SDK v2 plugin for macOS and Windows. Six actions: two keypad (`session-slot`, plus the opt-in Claude-limit gauge `limit-key`) + four SD+ encoders — E1 Volume (`utility-dial`), E2 Claude Usage (`option-dial`), E3 Codex Usage (`iterm-dial`), E4 Launcher (`launcher`). UUIDs are immutable post-distribution; the mapping, the per-platform host-control backends (`plugin/src/system/`) and the SDK/DRM constraints are in [docs/streamdeck-layout.md](docs/streamdeck-layout.md). `SDKVersion: 3` is mandatory (Maker Console rejects 2, and DRM follows from the SDK version) — verify the DRM-processed build's encoders through the review loop before publishing
- **plugin-ulanzi/** — Ulanzi Studio plugin for the D200H Deck Dock and D200X LCD keys (official UlanziDeckPlugin-SDK): one dynamic keypad action sharing the `@agentdeck/shared` `buildSessionDeck` layout engine, and the **sole** Ulanzi deck driver (direct-HID paths are gone; D200X encoders are a separate, unshipped UX and keypad support must not imply them). Health identity (`d200h`, from `ulanzi-plugin` WS presence) and the packaging rule (WASM resvg, no native binary, fonts load-bearing): [.claude/rules/devices-and-wire.md](.claude/rules/devices-and-wire.md#ulanzi-plugin-packaging); verify procedure [plugin-ulanzi/VERIFY.md](plugin-ulanzi/VERIFY.md)
- **shared/** — TypeScript types/utils shared between bridge & plugin (protocol, states, timeline, adapter interfaces, session-utils)
- **hooks/** — installers for the Claude Code hooks (user-global `~/.claude/settings.json`; `settings.local.json` is dead at user scope and only cleaned up), the Codex lifecycle hooks (`~/.codex/config.toml`) and the OpenCode observer plugin (`~/.config/opencode/plugins/agentdeck.js`, POSTs `opencode_*` hooks to the daemon, self-disables in managed PTYs via `AGENTDECK_PORT`). Rules: [.claude/rules/observed-sessions.md](.claude/rules/observed-sessions.md)
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package (`npx @agentdeck/setup`)
- **android/** — Jetpack Compose launcher app (CremaS, Onyx, Kobo, tablets)
- **apple/** — SwiftUI Multiplatform app (iOS/iPadOS/macOS). macOS includes **in-process Swift daemon** (`apple/AgentDeck/Daemon/`, no Node.js dependency) — mDNS, device modules (ADB/Serial/Pixoo/Timebox/iDotMatrix), Gateway proxy, HTTP+WS server
- **esp32/** — PlatformIO Arduino firmware (LVGL touch displays + WS2812B matrix + **TRMNL 7.5"** e-ink — a Seeed OG DIY Kit reflashed with custom AgentDeck firmware, env `trmnl_75`, WiFi/WS to the daemon like other boards). Board map, flash safety and the e-ink geometry SSOT: [.claude/rules/esp32-flash.md](.claude/rules/esp32-flash.md), [esp32/AGENTS.md](esp32/AGENTS.md), [docs/devices.md](docs/devices.md#trmnl-75-e-ink-custom-firmware)

See [docs/architecture.md](docs/architecture.md) for full architecture details (BridgeCore, PtyAdapter hierarchy, device modules, AgentAdapter abstraction, Gateway protocol, plugin connection model).

**Managed-session compatibility:** `agentdeck claude`/`codex`/`opencode`/`monitor` remain functional with no removal date; managed-only remote attach, `--weight`, `AGENTDECK_<AGENT>_ARGS` and terminal controls are product contracts until validated replacements exist ([#278](https://github.com/puritysb/AgentDeck/discussions/278) collects workflows, [#273](https://github.com/puritysb/AgentDeck/issues/273) owns gates; policy text in [docs/cli.md](docs/cli.md)). Do not add new PTY parser or per-session bridge dependencies unless #273 first records why daemon-first cannot own the capability, and do not delete a managed dependency while a tracked workflow still relies on it.

## Build

**Node runtime support:** the maintained, prebuild-verified even lines **22, 24, and 26** only — Node 20 is EOL and odd-numbered releases are not product targets. `pnpm-workspace.yaml`'s `engineStrict` makes the `package.json` range fatal, and `agentdeck diag native` proves the native ABI under the exact executable that will run the daemon; rerun `npx @agentdeck/setup --yes` after changing Node installations. Detail: [docs/install.md § Node runtime support](docs/install.md#node-runtime-support).

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

**Signing**: `android/signing.properties` (gitignored) locally, GitHub Secrets in CI. **Release**: `git tag android-v{VERSION} && git push origin android-v{VERSION}` → GitHub Actions builds + creates Release with APK. Keys and secrets: [docs/android.md](docs/android.md).

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
- **Versioning**: root `VERSION` is the compatibility-major anchor (`1.0.2`), not a minor/patch ceiling — `X.Y.Z` versions are mutually compatible exactly when `X` matches (major = protocol-breaking or exceptionally large coordinated migrations; minor = substantial backward-compatible features; patch = small backward-compatible fixes), minor/patch advance independently per target, and `pnpm verify-version` enforces it. Tags stay channel-prefixed (`apple-v*`, `android-v*`, `esp32-v*`, `npm-v*`, `streamdeck-v*`, `ulanzi-v*`); policy: [RELEASING.md](RELEASING.md).

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

This repo is built by switching between Claude Code, Codex, OpenCode, and Antigravity. **[docs/agent-harness.md](docs/agent-harness.md)** is the canonical map of how each agent enters the repo, what it reads, and what it auto-discovers.

- **Repo instructions**: this file is the entry point for every agent (see above). **`DEVELOPMENT_LOG.md` and `docs/devlog/YYYY-MM.md` are generated** from one file per entry in `docs/devlog/entries/` (`pnpm devlog:build`; `pnpm devlog:check` gates CI) — add an entry as a new file (first line `# YYYY-MM-DD — title`, links relative to the repo root) and rebuild; a merge conflict in an aggregate is resolved by rebuilding, never by picking a side.
- **Repo skills (SSOT)**: canonical skills live in `.agents/skills/<name>/SKILL.md` — the only copy. Codex discovers that directory natively; Claude Code discovers `.claude/skills/<name>`, which is a tracked **symlink** to the same directory. Add a skill under `.agents/skills/` and add the symlink; never write a pointer or a second copy.
- **Workflow originals** live in `.agents/workflows/` (OpenCode has no skill auto-discovery — point it there explicitly). **Session handoff**: run the `session-end` skill before `/clear`, `/new`, or handing work to another session.
- **Domain rules (SSOT)**: `.claude/rules/<domain>.md` are tracked in git and are the canonical text of every domain invariant (table above). Claude Code loads them by `paths:`; other agents read the matching file before editing in that area. Add a rule to the domain file, not to this map; a genuinely cross-cutting rule goes under Key Conventions here.

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

Vitest (bridge/plugin/shared/hooks), JUnit + Robolectric (Android), XCTest (Apple), Robot Framework (ESP32, `perf` needs hardware) and Vitest E2E against a real `agentdeck daemon start` process (`tests/e2e/`, `pnpm test:e2e` after `pnpm build`). Framework matrix and configs: [docs/testing.md](docs/testing.md).

Coverage thresholds are a regression guard ~3 points under measured coverage, enforced by `vitest.config.ts`. CI runs `npx vitest run --coverage` once, then `pnpm test:e2e`. **What each gate proves and does not prove is catalogued in `scripts/verification-catalog.json`** and published on the Pages report's "What we verify" tab; add a gate, workflow or test area there in the same commit (`scripts/__tests__/verification-catalog.test.ts` fails otherwise). Before an agent-driven macOS device run, `bash scripts/macos-preflight.sh` checks the privacy grants and stops with the System Settings path instead of hanging on a dialog.

### GitHub Pages and Build Health

Site surfaces, the CI report generator, the sync gates (`sync-pages-nav`, `sync-hardware-spec-cards`, `check-surface-mirrors`, `check-preview-mirror-sync`), and the device photography pipeline are documented in **[docs/pages-site.md](docs/pages-site.md)**. Read it before touching anything under `scripts/`, `docs/hardware/`, or `tools/creature-simulator/`.

### Apple/Xcode Debug Diagnostics

When debugging a macOS/iOS issue reproduced from Xcode, do **not** ask the user to paste Xcode console output first — capture the repository-side diagnostic bundle; `.agents/workflows/apple-xcode-debug.md` is the canonical workflow. That path is developer tooling only (`scripts/`, `.agents/workflows/`, gitignored `diagnostics/`) and must not add subprocesses, shell commands, terminal instructions, or external-tool prompts to the App Store app UI.

## Windows and Linux dev setup

The Node.js bridge, hook installer, and Stream Deck plugin run on Windows 11 (Apple/Android/ESP32 native builds are out of scope); prereqs and the intentional differences (ConPTY, data dir, file-based PowerShell hook script, daemon autostart via the per-user Scheduled Task `AgentDeckDaemon` in `bridge/src/windows-service.ts` — NOT a session-0 Windows Service, device-module gating, darwin-only sampler) live in **[docs/windows.md](docs/windows.md)**. When debugging Windows issues, run commands directly in PowerShell so output appears in the conversation — the Apple/Xcode diagnostic bundle is macOS-only.

The Node.js bridge + daemon run on Linux; the **Stream Deck desktop app is unavailable**, so the plugin host and its setup/CLI steps are skipped. Autostart is a per-user **systemd `--user` unit** `agentdeck-daemon.service` (`bridge/src/linux-service.ts`). Prereqs and the intentional differences (mDNS, hooks, `node-pty` toolchain, setup checks): **[docs/linux.md](docs/linux.md)**.

## CLI

The CLI command is `agentdeck` (`bridge/src/cli.ts`).

Full command list: `agentdeck --help`, or [docs/cli.md](docs/cli.md) for the annotated reference.

**Module flags**: `--local` (all device modules off), `--no-adb` (skip ADB reverse). There are no per-session `--no-mdns`/`--no-serial`/`--no-pixoo` flags — hardware modules are daemon-only and session bridges never activate them

**Session sort weight** (`--weight <n>`, -9999..9999), **env-var default args** (`AGENTDECK_COMMANDER_ARGS`, `AGENTDECK_<AGENT>_ARGS`, `--no-env-args`) and the **node-pty macOS helper-mode repair** are specified in [.claude/rules/managed-sessions.md](.claude/rules/managed-sessions.md) and [docs/cli.md](docs/cli.md).

ESP32 provisioning, WiFi OTA scope, the external-client wire contract, and Autonomous Pocket are documented in [esp32/AGENTS.md](esp32/AGENTS.md) (loads when working under `esp32/`) and [docs/esp32.md](docs/esp32.md).

## Key Conventions

Cross-cutting rules that more than one domain needs; domain invariants are in the rule files indexed at the top.

- **Hook format (CRITICAL)**: Claude Code v2.1+ requires 3-level nesting: `{ matcher: "", hooks: [{ type: "command", command: "..." }] }` — the old flat format silently fails. Every installer targets the user-global `~/.claude/settings.json`, and the snippet is mirrored byte-identically in `hooks/src/install.ts`, `setup/src/setup.ts` and `HookInstaller.swift` — change all three together. Timeouts, the `X-AgentDeck-Pid` header, Codex/Kiro installers, migrations and the full rationale: [.claude/rules/observed-sessions.md](.claude/rules/observed-sessions.md#hook-format-and-installers).
- **Plugin UUID**: `bound.serendipity.agentdeck` (immutable post-distribution)
- **Package scope**: `@agentdeck/*` (shared, bridge, plugin, hooks, setup)
- **Cross-platform rules are SSOT-first**: any numeric rule, coordinate, clamp, or contract that more than one surface (TS/Swift/Kotlin/C++) must agree on is defined in its canonical source first, then generated/mirrored outward behind a drift gate — never introduced as a per-platform literal. **The full source → generator → gate index and the four rules that govern every row are in [docs/architecture.md § Cross-platform SSOT catalogue](docs/architecture.md)**; add a row there in the same commit as a new SSOT.
- **User data dir**: `daemon.json`, `sessions.json`, `auth-token`, `settings.json`, `timeline.json`, `wifi-config.json`, `compatibility.json`, `pocket-autonomy.json`, `apme.sqlite`. Path depends on distribution: **Node.js CLI + unsigned dev builds** → `~/.agentdeck/`. **App Store macOS** → `~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/` (App Sandbox container — the app requests no home-relative-path entitlement and no App Groups capability; a Sandbox/entitlement consequence, not Guideline 2.5.2). Swift code routes every access through `apple/AgentDeck/App/AgentDeckPaths.swift`; never hand-write either path
- **Timeline persistence is daemon-owned**: only the bound daemon writes `timeline.json` (tmp+rename, after the startup rehydrate); session bridges and the plugin never do, and the format is bidirectional between Node and Swift. Detail: [.claude/rules/daemon-lifecycle.md](.claude/rules/daemon-lifecycle.md#persistence-and-hub).
- **Daemon hub**: Port 9120 is the sole entry point for all dashboard clients; session bridges serve internal hook HTTP only (9121-9139) and push state up the internal WS (`daemon-ws-client.ts`, `/health` polling when push is stale). Opt-in cross-machine attach (`--remote-daemon`) is driven back **down that same socket** — the only reverse path, the daemon never dials back — and needs `sameSocketControl` in `/health` (Node CLI daemon only). See [docs/daemon.md](docs/daemon.md)
- **LAN surface is default-deny** (issue #145): the daemon binds `0.0.0.0` on purpose, so the security boundary is the pairing token enforced at one chokepoint per daemon (`bridge/src/http-auth-gate.ts` / `DaemonServer.httpAccessResponse`); an unauthenticated LAN peer reaches only a minimal `GET /health`. Never add a standing unauthenticated route or put the token in a discovery payload. Posture flags, pairing window/approval, token custody and ownership: [.claude/rules/daemon-lifecycle.md](.claude/rules/daemon-lifecycle.md).
- **Swift daemon isolation**: the macOS in-process daemon runs on **`@DaemonActor`** (`apple/AgentDeck/Daemon/Core/DaemonActor.swift`), NOT `@MainActor` — a busy render loop starved it on the shared main executor. A type holding daemon state is `@DaemonActor`; UI types stay `@MainActor` and are reached with `await`. **Never write a `@convention(c)` callback inline inside an isolated method** — it inherits that isolation statically and the compiled executor assertion traps at runtime; declare such callbacks at file scope. See [docs/architecture.md § Swift daemon isolation](docs/architecture.md) and [.claude/rules/swift-daemon.md](.claude/rules/swift-daemon.md)
- **Action ID pattern**: SD actions store string IDs + `getActionById()` — never action object references
- **Shift+Tab** (`\x1b[Z`) for Claude Code mode switching (100ms debounce)
- **Wire booleans carry both signals; an epoch-ms stamp is an integer; an unknown `agentType` renders as nothing, never as another agent.** Omitted keys mean "no information" in a retain-on-absent protocol, so emit the explicit `false`; agent buckets are allow-lists. Evidence and gates: [.claude/rules/devices-and-wire.md](.claude/rules/devices-and-wire.md#wire-semantics).
- **A probe has three answers, not two.** Unreadable flash id, failed `lsof`, a health frame with no `ok`, a `kill(pid,0)` EPERM, a missing `capturedAt`: each is "I could not look", and it must neither launder into "free/healthy" nor into "broken". Keep `unknown` as its own value and let the caller retain, refuse, or stay permissive by explicit rule. Instances: [esp32-flash](.claude/rules/esp32-flash.md), [daemon-lifecycle](.claude/rules/daemon-lifecycle.md), [openclaw-gateway](.claude/rules/openclaw-gateway.md), [usage-quota](.claude/rules/usage-quota.md).
- **External peer async I/O**: every RPC/WS/HTTP `await` against a peer carries a timeout — peer silence is a first-class signal (synthetic error + UI status + retry/fallback), and the race-condition guard is secondary. Reference implementation and the bounded-teardown rule: [.claude/rules/swift-daemon.md](.claude/rules/swift-daemon.md#foundation-and-async-traps).

## Design System

Aquarium-tide design system. Spec: [DESIGN.md](DESIGN.md); token SSOT [design/tokens.css](design/tokens.css); resource map [design/RESOURCES.md](design/RESOURCES.md). Seven rules enforced by `bash design/lint.sh` (no raw hex, two type faces, semantic status colours, marketing never touches `--ui-*`, upstream brand SVGs, real assets over drawn ones). Token mirrors (JS/TS/Swift/Kotlin + three non-binding copies) are checked by `python3 design/verify-tokens-sync.py`. **Adding a file under `docs/` requires a catalog entry or a stated exclusion in the same commit** (`pnpm design-system:check`), and `pnpm docs:check` validates Markdown links. Full rules, mirrors and gates: [.claude/rules/design-system.md](.claude/rules/design-system.md).

## App Store build invariants

The macOS app ships through the App Store and must stay **self-contained** (Guidelines 2.5.2 / 4.2.3): no subprocess paths in the macOS tree under any guard, no companion-install prompts, no session-launch UI, external-daemon-gated features hidden (never a limitation notice), and `apple/scripts/verify-appstore-archive.sh` must pass on the Release archive. New features land in [docs/appstore-feature-matrix.md](docs/appstore-feature-matrix.md) before implementation. Five release states and CHANGELOG-rendered release bodies: [.claude/rules/apple-release.md](.claude/rules/apple-release.md).

## Documentation Index

Topic docs live in [docs/](docs/) — the filenames are the index, and the canonical ones are linked inline from the sections above. Stream Deck SDK and sample links: [docs/streamdeck-layout.md § References](docs/streamdeck-layout.md#references).

## Worktree 자동 정리 (workmux)

현재 작업 경로(`pwd`)가 `__worktrees` 를 포함하면 workmux worktree 안에서 작업 중인 것이다.
이 경우 **작업이 완전히 끝났을 때 (모든 서브에이전트/teammate 완료 포함)** 다음을 실행한다:

    workmux remove --keep-branch

- `--keep-branch`: worktree/session/pane만 정리하고 **브랜치는 살림** (나중에 `workmux merge` 로 머지 가능)
- 이 지시는 메인 repo(`__worktrees` 경로 아님)에서는 무시한다
- 진행 중에는 절대 실행 금지 — 완료 확인 후에만
