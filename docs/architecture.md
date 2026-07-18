# Architecture

Core bridge architecture, adapter hierarchy, and module system. See [daemon.md](daemon.md) for the daemon hub design and [plugin-conventions.md](plugin-conventions.md) for plugin internals.

## Monorepo layout

- **bridge/** — Node.js server: Daemon (sole hub for all clients, mDNS, device modules) + Session Bridge (PTY, hook HTTP, state machine). BridgeCore (shared infra), PtyAdapter hierarchy, output parser, WebSocket server, voice (whisper.cpp), usage API client, auth token, SSE broadcast, TUI dashboard (`tui/`)
- **plugin/** — Stream Deck SDK v2 plugin: actions for buttons/encoders, bridge WebSocket client
- **shared/** — TypeScript types and utilities shared between bridge and plugin (protocol, states, timeline, adapter interfaces, `format-utils` time/count/bytes formatters, `timeline-summarizer` extractTopicHint/cleanLLMOutput, `deduplicateEntry` pipeline, `session-utils` stateRank/sortSessions/assignDisplayNames — 세션 정렬/번호 공통 유틸리티, 6곳에서 import)
- **hooks/** — Claude Code CLI hook installer for `~/.claude/settings.local.json` (the App Store opt-in UI writes the user-selected `settings.json`), Codex lifecycle hook installer for `~/.codex/config.toml`, and OpenCode observer plugin installer for `~/.config/opencode/plugins/agentdeck.js`
- **config/** — Default settings and prompt templates
- **setup/** — npm setup package: `npx @agentdeck/setup` one-command installer
- **android/** — Jetpack Compose launcher app: e-ink monitoring + interactive Deck control (CremaS, Onyx, Kobo, tablets)
- **apple/** — SwiftUI Multiplatform app: iPhone/iPad/macOS dashboard + Deck control (App Store distribution). macOS includes an **in-process Swift daemon** (`AgentDeck/Daemon/`) with HTTP/WS, mDNS, native Serial/Pixoo/Timebox/iDotMatrix modules, WiFi ESP32 presence, Gateway proxy, and timeline/APME support. It has no Node.js dependency and never launches sessions; Claude hooks are installed only through the explicit user-consent file picker. D200H is driven only by the external Ulanzi Studio plugin; no direct-HID implementation or USB entitlement remains in the app. External Node-daemon-only capabilities are shown through progressive enhancement when `DaemonService.isUsingExternalDaemon` is true. The previous **Launch Session** entry point was removed on 2026-05-10; App Store builds never create Terminal windows, scripts, AppleScript prompts, or child processes. See [appstore-feature-matrix.md](appstore-feature-matrix.md) for the canonical tier split.
- **esp32/** — PlatformIO Arduino firmware: LVGL touch displays (ESP32-S3: 86Box 480×480, IPS 3.5" 480×320 landscape / 320×480 portrait, Round AMOLED 360×360) + WS2812B LED matrix (ESP32 classic: Ulanzi TC001 8×32). Board-specific `#ifdef`, per-board partition tables, FastLED matrix renderer bypasses LVGL entirely. IPS 3.5" supports runtime portrait↔landscape switching via `set_orientation` protocol command or Settings toggle (NVS persistent, `g_screenW`/`g_screenH` runtime globals)

## Language/tooling

- **pnpm workspaces** for monorepo management
- **ES modules** throughout (type: "module")
- **Node16 module resolution** in TypeScript

## BridgeCore

`bridge/src/bridge-core.ts` — Shared infrastructure class used by both `startSession()` (index.ts) and `startDaemon()` (daemon-server.ts). Contains StateMachine, WsServer, UsageTracker, DisplayMonitor, OllamaProbe, state caches, and common event wiring. Eliminates ~600 lines of duplication.

## PtyAdapter hierarchy

`bridge/src/adapters/pty-adapter.ts` — Abstract base class for PTY-based agents. Subclasses implement `getDefaultCommand()`, `wireOutputParser()`, `feedParser()`, `handleAgentCommand()`.

- `ClaudeCodeAdapter` extends PtyAdapter with OutputParser + Shift+Tab mode switching
- `CodexCliAdapter` extends PtyAdapter with CodexOutputParser plus Codex lifecycle hooks installed in `~/.codex/config.toml`; hooks are authoritative and rollout-tail parsing supplies response text where needed
- `OpenCodeAdapter` extends PtyAdapter + SSE overlay (spawns `opencode --port XXXX` TUI, connects to embedded HTTP server for structured events — no TUI parsing needed)
- `MonitorAdapter` is hook-only (no PTY)

## Device module system

`bridge/src/modules/` — Pluggable `DeviceModule` interface with auto-detect. Modules include mDNS, serial, Pixoo, Timebox, and ADB. Timebox Mini Light is BLE (ISSC transparent-UART): the CLI daemon spawns `sync_ble.py`, while the App Store Swift daemon drives it natively through CoreBluetooth. D200H direct-HID was removed from both daemons; the **sole supported driver is `plugin-ulanzi/` running inside Ulanzi Studio**, with daemon connectivity derived from its WS presence. Session bridges never activate hardware modules — dashboard devices connect through the daemon. Session CLI flags are `--local` (all device modules off) and `--no-adb` only.

## Swift daemon isolation (`@DaemonActor`)

The macOS in-process daemon runs on its own global actor, **`DaemonActor`** (`apple/AgentDeck/Daemon/Core/DaemonActor.swift`) — **not** `@MainActor`. It is hosted inside the GUI app, so sharing the main executor meant SwiftUI rendering starved daemon service: a saturated main runloop left `/health` unanswered for 5s and stalled the daemon log for 24 minutes while the process stayed alive (2026-07-18).

The asymmetry in that incident — HTTP dead, WebSocket alive — is worth remembering, because it points at the wrong file if you read it too quickly. `WebSocketServer` owns the daemon's **only** listener and runs it on its own `ioQueue`, so accept and frame I/O kept working. Plain HTTP arrives on that same listener and is delegated to `HTTPServer.handle(request:on:)`, whose route handlers dispatch into `DaemonServer` — which was `@MainActor`. Requests were accepted and then starved. `HTTPServer.start(port:)` and its `NWListener` exist but are called only from tests; they were not involved. Debug listener behaviour in `WebSocketServer`, and handler starvation here.

**Rule for new code**: a type that holds daemon state is `@DaemonActor`. UI-facing types stay `@MainActor` and are reached with `await`. Today `DaemonServer`, `StateMachine`, `ModuleManager`, `ApmeCollector`, `OpenCodeObserver` and `ESP32WifiOtaManager` are `@DaemonActor`; `DaemonVoiceAssistant` (AVAudioEngine / SFSpeechRecognizer / AVSpeechSynthesizer), `ReviewPanelPresenter` and `DaemonService` (`@Published`) stay `@MainActor`.

A *global* actor rather than making `DaemonServer` an `actor`: the daemon is not one object, and its collaborators expose synchronous value-returning methods (`transition() -> Bool`, `activeTaskId`) taking non-Sendable `[String: Any]`. Independent actors would force `await` across ~105 call sites; plain classes have no isolation for `Task {}` to inherit. One shared global actor keeps calls between them synchronous and preserves isolation inheritance exactly as it behaved under `@MainActor`.

**Trap — C callbacks.** A `@convention(c)` callback written *inline* inside an isolated method statically inherits that method's isolation. A function pointer cannot carry isolation, so Swift compiles an executor assertion into its entry; when the callback fires on some other queue the process aborts with `Incorrect actor executor assumption`. The IOKit power notification hit exactly this. Declare such callbacks at **file scope** (see `daemonWakeCallback` in `DaemonServer.swift`) and hop with `Task { @DaemonActor in … }`. Swift 6 mode verifies data-race safety but cannot see this — it is a runtime-only failure.

Regression tests: `HTTPServerMainThreadStallTests` (transport must accept while main is blocked) and `DaemonActorIndependenceTests` (daemon work must progress while main is blocked).

## Terrarium rules SSOT (cross-platform behavior invariants)

`shared/src/terrarium-rules.ts` is the single source of truth for terrarium **rules** — numeric invariants every rendering surface must agree on regardless of its own world model: the OpenClaw crayfish's unified dashboard home (0.78, 0.64), the idle floor-rester clear anchor (`clearMaxX` 0.62), the dashboard floor-rest strip, and the Antigravity idle-hover strip. Surface-specific *tuning* (per-board Y offsets, swim lanes, sprite sizes, TUI/Pixoo local homes) stays local to each platform.

`pnpm generate-terrarium-rules` emits three mirrors — `apple/AgentDeck/Terrarium/TerrariumRules.generated.swift`, `android/.../terrarium/TerrariumRules.generated.kt`, `esp32/src/ui/terrarium/terrarium_rules_generated.h` — and TypeScript surfaces (TUI, Pixoo) import `TERRARIUM_RULES` from `@agentdeck/shared` directly. A vitest gate (`shared/src/__tests__/terrarium-rules.test.ts`) re-emits from source and diffs against the files on disk, so hand edits or a skipped regeneration fail `pnpm test`; the same file asserts the clearance invariant itself (`clearMaxX + widest-rester/2 < crayfish claw left edge`, the 610fe15c bug class).

**Rule for new features**: when a coordinate, clamp, or exclusion zone must hold on more than one surface, add it to `terrarium-rules.ts` first, regenerate, and reference the generated constant from platform code — never introduce the literal per-platform. This is the same codegen-SSOT pattern as creature glyphs and the protocol types, applied to behavior constants. (The multi-session band layout in `shared/src/creature-layout.ts` remains a 3-way hand mirror with test parity — a candidate for future migration into this pipeline.)

## AgentAdapter abstraction (Phase 1-2 complete)

- `shared/src/adapter.ts` — `AgentAdapter` interface, `AgentCapabilities`, `AdapterEvent` types, and the canonical `AgentType` union (`claude-code`, `openclaw`, `codex-cli`, `codex-app`, `opencode`, `antigravity`, `monitor`)
- `bridge/src/adapters/pty-adapter.ts` — `PtyAdapter` abstract base (PtyManager + HookServer + common start/command handling)
- `bridge/src/adapters/claude-code.ts` — `ClaudeCodeAdapter extends PtyAdapter` (OutputParser + Shift+Tab mode switch). ~100줄 (was 227)
- `bridge/src/adapters/monitor.ts` — `MonitorAdapter` (hook-only, no PTY, `isAlive()` always true)
- `bridge/src/adapters/openclaw.ts` — `OpenClawAdapter` connecting to Gateway WebSocket
- `bridge/src/adapters/index.ts` — `createAdapter(type, gatewayUrl?)` factory (`'monitor'` → MonitorAdapter)
- Bridge `cli.ts` handles `--agent` + `--gateway` CLI flags; `index.ts` exports `startSession()`
- `StateUpdateEvent` includes `agentType` + `agentCapabilities` for plugin capability gating
- Adapter emits unified `AdapterEvent` (hook/parser/metadata/activity/connection)
- **Command routing split**: ClaudeCode defers `select_option`/`navigate_option`/`send_prompt` to bridge (PTY); OpenClaw handles all commands via RPC. Bridge updates StateMachine for adapter-handled commands.
- **OpenClaw capabilities**: `hasTerminal=false`, `hasModeSwitching=false`, `hasDiffReview=false`, `hasOptionLists=true`, `hasNavigablePrompts=false`, `hasSuggestedPrompts=false`, `hasApiUsage=false`

### OpenClaw Gateway protocol (v2 + v3, verified against OpenClaw 2026.4.14)

- Custom framing: `{ type: "req"/"res"/"event", ... }` (NOT JSON-RPC)
- Ed25519 device auth handshake: `connect.challenge` → `connect`
  - **v2 (Node CLI bridge)**: signed with `~/.openclaw/identity/` keypair (file-based)
  - **v3 (App Store macOS)**: self-generated Ed25519 keypair (no file I/O; private key in Keychain). `deviceId = sha256(raw pubkey)`, `token` issued by Gateway in `hello-ok.auth.deviceToken` on first pairing and reused on reconnect. Pairing requires manual approval via `openclaw devices approve <requestId>` or OpenClaw Web UI.
- Methods: `connect`, `health`, `models.list`, `logs.tail`, `sessions.list`, `sessions.subscribe`, `sessions.messages.subscribe`, `chat.send`, `chat.abort`, `exec.approval.resolve`, `system-presence`
- Events: `connect.challenge`, `health`, `sessions.changed`, `session.message`, `session.tool`, `chat` (delta/final/aborted/error), `exec.approval.requested/resolved`, `presence`, `tick`, `shutdown`
- Session tracking via `sessionKey` from `sessions.list` / `chat` events
- Default port 18789, auto-reconnect with exponential backoff; auth failures (`pairing_required`/`token_mismatch`/`device_auth_invalid`) surface to UI instead of looping. See [docs/gateway-protocol.md](gateway-protocol.md) for wire format.

## Plugin connection (daemon-only single path)

- `plugin/src/connection-manager.ts` — Bridge-only, no direct Gateway connection. `switchToOpenClaw()`/`switchToClaude()` send `switch_agent` WS command to daemon
- `plugin/src/agent-link.ts` — `AgentLink` interface (send/isConnected/getCapabilities/disconnect)
- Plugin connects to daemon or session bridge via BridgeClient only. All OpenClaw interaction proxied through daemon
- **Removed**: `gateway-client.ts`, `log-stream.ts`, `timeline-summarizer.ts` (plugin no longer connects to Gateway directly — daemon is sole Gateway connection point)

## Plugin capability gating (Phase 5 complete)

- `iterm-dial.ts`, `option-dial.ts` → `!hasTerminal`/`!hasSuggestedPrompts`
- `response-button.ts` → `!hasDiffReview`
- `plugin.ts` → 8곳 `caps` 전달

## node-pty optional

`optionalDependencies` + dynamic `await import('node-pty')` in PtyManager. Daemon/monitor modes never load the native module. Setup forces source build (`npm_config_build_from_source=true`) to avoid prebuilt ABI mismatch across Node versions. PtyManager catches `posix_spawnp` errors with rebuild guidance.
