# AgentDeck

Stream Deck+ controller for AI coding agents — a bidirectional local control system.

## Monorepo

One line per package; full architecture in [docs/architecture.md](docs/architecture.md).

- **bridge/** — Node.js Daemon hub + Session Bridge (PTY, hook HTTP, state machine). `src/apme/` = eval module; canonical `SessionSample` (`shared/src/sample.ts` + `sample_events`) is the SSOT both timeline and eval derive from; eval results stay OFF the device timeline (WS `apme_eval` + scorecard). See [docs/apme.md](docs/apme.md).
- **plugin/** (Stream Deck SDK v2) · **plugin-ulanzi/** (D200H Deck Dock, shares `buildSessionDeck`) · **shared/** (TS types/utils: protocol, states, timeline, adapters, session-utils).
- **hooks/** — installers for Claude Code (`~/.claude/settings.json`), Codex (`~/.codex/config.toml`), OpenCode observer plugin. **config/** + **setup/** (`npx @agentdeck/setup`).
- **android/** (Jetpack Compose launcher — CremaS/Onyx/Kobo/tablets, [docs/android.md](docs/android.md)) · **apple/** (SwiftUI iOS/iPadOS/macOS; macOS bundles an in-process Swift daemon, no Node.js dep) · **esp32/** (PlatformIO firmware — LVGL, WS2812B, InkDeck e-ink, in dev; [docs/esp32.md](docs/esp32.md)).

## Build

```bash
pnpm install
pnpm build                     # shared MUST build before bridge/plugin
pnpm generate-icons            # SVG → PNG icons (first build or after icon changes)
pnpm generate-protocol         # protocol.ts → JSON Schema → Swift/Kotlin types (also: generate-creature-glyphs, generate-micro-glyphs)
```

## Android Build

Requires JDK 17+ (`brew install openjdk@17`; script auto-detects Homebrew JDK).

```bash
bash scripts/build-android-release.sh   # local → dist/agentdeck-v{VERSION}.apk
```

- **Signing**: `android/signing.properties` (gitignored). CI uses GitHub Secrets (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`, `ANDROID_STORE_PASSWORD`).
- **Release**: `git tag android-v{VERSION} && git push origin android-v{VERSION}` → Actions builds + Release.

## Setup & Distribution

```bash
npx @agentdeck/setup       # npm one-command install (Claude or Codex CLI)
pnpm setup                 # dev install from source (deps, build, icons, hooks, link)
pnpm package               # dist/*.streamDeckPlugin   ·   bash scripts/uninstall.sh
```

### Apple Release (TestFlight)

```bash
bash scripts/build-apple-release.sh --ios|--macos|--all   # --all also uploads to TestFlight
git tag apple-v0.1.0 && git push origin apple-v0.1.0       # CI → TestFlight
```

- **Apple Bundle ID**: `bound.serendipity.agent.deck`. The old `bound.serendipity.agentdeck.*` tree is retired (immovable ASC build floor). The Stream Deck **plugin UUID** `bound.serendipity.agentdeck` is a SEPARATE, immutable identifier — unrelated to the app bundle ID.
- **Secrets**: `APPLE_CERTIFICATE_BASE64`/`_PASSWORD`, `ASC_API_KEY_ID`/`_ISSUER_ID`/`_KEY_BASE64`. **Versioning**: all tracks at 0.1.x since 2026-06-26; per-track tags `apple-v*`/`android-v*`/`esp32-v*`/`npm-v*`; policy [RELEASING.md](RELEASING.md).

## Development

```bash
pnpm -r --parallel dev   # watch mode, all packages
pnpm test                # vitest
pnpm vitest run --coverage
pnpm test:report         # unified (vitest + Android + Apple + Robot)
cd plugin && streamdeck link
```

- **Multi-agent surface**: this repo is built by switching between Claude Code, Codex, OpenCode, Antigravity. `AGENTS.md` is the convention entry file (requires `CLAUDE.md` first). Canonical skills live in `.agents/skills/<name>/SKILL.md`; `.claude/skills/*.md` are thin POINTERS — never put procedure there, edit the `.agents/` copy so the two can't drift. Full map: [docs/agent-harness.md](docs/agent-harness.md).
- **Test infra**: Vitest (bridge/plugin/shared/hooks; coverage thresholds enforced ~17%), JUnit+Robolectric (Android), XCTest (Apple), Robot Framework (ESP32). Details: [docs/testing.md](docs/testing.md).
- **Apple/Xcode debug**: don't ask the user for console paste first — capture `bash scripts/capture-apple-diagnostics.sh --tail 1000 --last 15m`, then read `diagnostics/apple-xcode/latest/`. Workflow: `.agents/workflows/apple-xcode-debug.md`. Developer tooling only — never add subprocess/terminal prompts to the App Store UI.
- **Windows**: Node bridge + hook installer + plugin run on Windows 11 (native Apple/Android/ESP32 out of scope). Prereqs + intentional differences (ConPTY, Scheduled Task daemon, not a Service): [README → Windows](README.md#windows-bridge--plugin).

## CLI

`agentdeck` (`bridge/src/cli.ts`).

```bash
agentdeck claude|codex|opencode   # agent session (PTY + bridge); --local = no device modules
agentdeck monitor                 # hook-only bridge (run the agent separately)
agentdeck daemon start|stop|status|install|uninstall
agentdeck status | stop [-a|-p PORT]
agentdeck dashboard               # TUI monitor + terrarium (alias: dash)
agentdeck devices | qr | diag
agentdeck pixoo|timebox {scan|add|list|remove|test}
agentdeck wifi-setup              # ESP32 WiFi provisioning
agentdeck esp32-ota <target> [--build|--firmware <path>]
```

**Module flags**: `--local` (all off), `--no-mdns`, `--no-adb`, `--no-serial`, `--no-pixoo`. ESP32 OTA scope + external/forked-client wire contract: [docs/esp32-client-contract.md](docs/esp32-client-contract.md).

## Key Conventions

- **Hook format (CRITICAL)**: Claude Code v2.1+ needs 3-level nesting `{ matcher: "", hooks: [{ type: "command", command: "..." }] }`. Old flat format silently fails; bridge auto-migrates via `migrateHooksIfNeeded()`. Codex uses lifecycle hooks in `~/.codex/config.toml`. Hook scripts use bounded `curl` + `|| true` so they never block when the bridge is down.
- **Plugin UUID**: `bound.serendipity.agentdeck` — immutable post-distribution.
- **User data dir** depends on distribution — never hand-write either path; route through `apple/AgentDeck/App/AgentDeckPaths.swift`. Node CLI / dev builds → `~/.agentdeck/`. App Store macOS → `~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/`.
- **Daemon hub**: port 9120, sole entry for all dashboard clients; session bridges serve internal hook HTTP only (9121-9139). See [docs/daemon.md](docs/daemon.md).
- **Action ID pattern**: SD actions store string IDs + `getActionById()` — never action object references.
- **Shift+Tab** (`\x1b[Z`) for Claude Code mode switching (100ms debounce).
- **Version compatibility** check on `agentdeck claude` startup never blocks startup.
- **External peer async I/O**: force a timeout on every RPC/WS/HTTP `await` — treat peer silence as a first-class signal (synthetic error + UI status + retry/fallback). Timeout guards come before race guards. Ref: `OpenClawAdapter.swift`.

## Design System

Aquarium-tide ([DESIGN.md](DESIGN.md)). Token SSOT `design/tokens.css` has four mirrors (`design/tokens.js`, `shared/src/design-tokens.ts`, Swift + Kotlin `DesignTokens`) — update all four in one commit, verify `python3 design/verify-tokens-sync.py`. Rules (`bash design/lint.sh`): no raw hex, no `#fff`/`#000`, two faces only (IBM Plex Sans + JetBrains Mono), semantic status colors (only amber-awaiting animates), brand marks upstream — don't redraw.

## App Store build invariants

macOS ships through the App Store and must stay self-contained (Guidelines 2.5.2 / 4.2.3). Enforced in code + CI + docs — preserve on every change:

- `AGENTDECK_APP_STORE` flag on the macOS target; the macOS source tree contains NO `Process()`, `/bin/sh`, `osascript`, script writers, or external-CLI probes (removed 2026-04-19). Never reintroduce subprocess paths under any guard — route through entitlement-backed APIs or gate on `DaemonService.isUsingExternalDaemon`.
- No companion-install prompts and no session-launch UI in the App Store build: reachable UI must not tell the user to install/launch a companion binary (4.2.3), and sessions appear automatically once hooks pick up an agent the user started. Setup-card copy is identical regardless of CLI presence.
- **CI verifier** `apple/scripts/verify-appstore-archive.sh` fails the build on any forbidden subprocess string or bundled executable — run locally before release.
- Progressive enhancement on `isUsingExternalDaemon`: daemon-dependent UI is HIDDEN when false (never a "sandbox limitation" notice).
- `docs/appstore-feature-matrix.md` (feature split) and `apple/APP_REVIEW_NOTES.md` (reviewer-facing claims) are canonical — keep both factually in sync with code.

## Documentation Index

Most docs are pointed to inline above. Not yet linked elsewhere: [docs/plugin-conventions.md](docs/plugin-conventions.md) (encoder LCD, wide canvas, OC timeline, D200H, sleep/wake), [docs/v4-layout.md](docs/v4-layout.md) + [docs/streamdeck-layout.md](docs/streamdeck-layout.md) (button/encoder layout), [docs/tui-dashboard.md](docs/tui-dashboard.md), [docs/protocol.md](docs/protocol.md) + [docs/gateway-protocol.md](docs/gateway-protocol.md) (WS protocols).

## References

**Elgato SDK**: https://docs.elgato.com/streamdeck/sdk (Actions, Keys, Dials & Touch Strip, Manifest, WebSocket API) · **Plugin Samples**: https://github.com/elgatosf/streamdeck-plugin-samples

---

Last reviewed: 2026-07-09
