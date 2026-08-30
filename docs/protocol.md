---
id: arch.protocol
title: Bridge Protocol
description: The bridge-to-client WebSocket protocol — event catalog, state machine, and the generated Swift/Kotlin type mirrors.
category: Specs
locale: en
canonical: true
status: stable
owner: Bridge maintainers
reviewed: 2026-08-19
revision: 2026-08-19
source_of_truth: docs/protocol.md
validators: [pnpm generate-protocol, pnpm test]
---
# Protocol & Architecture Reference

Internal reference for the AgentDeck state machine, WebSocket protocol, and project structure.

This is the **implementation wire**, not an external promise that every event and
command is public. Independent dashboards, readers, panels, and control integrations
must target an allow-listed [AgentDeck Surface Protocol v1](surface-protocol.md)
profile. First-party AgentDeck products may continue to use the complete internal
union.

This document describes **what** the daemon and its clients say to each other. Before changing any of it, read the [Wire Compatibility Contract](wire-compatibility.md) — most consumers are software we cannot update (App Store apps, marketplace plugins, flashed firmware), and it sets out which changes are safe, which look additive but break the fleet, and how to introduce one that genuinely isn't.

---

## Architecture Diagram

```
                                        ┌─────────────────────────────────────────┐
                                        │          Daemon (port 9120)             │
┌──────────────────────┐  WebSocket     │  ┌──────────────┐  ┌──────────────┐    │
│  Stream Deck Plugin  │◄──────────────►│  │ WS Server    │  │ mDNS         │    │
│  Android Dashboard   │◄──────────────►│  │ (all clients)│  │ (daemon only)│    │
│  Apple Dashboard     │◄──────────────►│  └──────────────┘  └──────────────┘    │
│  TUI Dashboard       │◄──────────────►│  ┌──────────────┐  ┌──────────────┐    │
│  ESP32               │◄──Serial──────►│  │ Device Mods  │  │ Gateway      │    │
│  Pixoo64             │◄──HTTP────────►│  │ serial+ble   │  │ Proxy        │    │
│  Timebox Mini Light  │◄──BLE GATT────►│  └──────────────┘  └──────────────┘    │
└──────────────────────┘                │                                         │
                                        └────────────┬────────────────────────────┘
                                                     │ internal WS (future)
                                        ┌────────────▼────────────────────────────┐
                                        │      Session Bridge (port 9121+)        │
┌──────────────────────┐                │  ┌──────────────┐  ┌──────────────┐    │
│  User's Terminal     │◄──stdio───────►│  │ PTY Manager  │  │ Hook Server  │    │
│  (iTerm2)            │                │  │ (node-pty)   │  │ (HTTP POST)  │    │
└──────────────────────┘                │  └──────┬───────┘  └──────────────┘    │
                                        │         │                               │
┌──────────────────────┐  HTTP POST     │  ┌──────▼───────┐  ┌──────────────┐    │
│  Claude Code Hooks   │───────────────►│  │ Output       │  │ Voice        │    │
│  (settings.json)     │                │  │ Parser → SM  │  │ fm-helper    │    │
└──────────────────────┘                │  └──────────────┘  └──────────────┘    │
                                        └─────────────────────────────────────────┘
```

**Daemon hub architecture**
- The daemon is the **sole hub** for all dashboard clients. Session bridges handle PTY + hooks only and do not serve external devices.
- Daemon listens on `0.0.0.0:9120` (fallback to 9121+ if port occupied by non-daemon). `~/.agentdeck/daemon.json` records the actual port for local client discovery. Remote clients discover via mDNS (`_agentdeck._tcp`, daemon only advertises).
- Local clients are auto-trusted; LAN clients must present the auth token (`~/.agentdeck/auth-token`). Pair via `agentdeck qr`.
- Daemon computes encoder state and relays the Stream Deck slot map. If the plugin is absent, Android falls back to the v3 default layout while staying fully controllable.
- Voice from Android uploads WAV to `POST /voice/transcribe`; utility actions (volume/brightness/media/timer) go through the Node CLI daemon's macOS `osascript` proxy. The App Store Swift daemon uses native CoreAudio/IOKit code for local utility control and never spawns `osascript`.

**Internal session↔daemon push channel** (`bridge/src/daemon-ws-client.ts` ↔ `daemon-server.ts`)

The socket a session bridge opens to the daemon is **bidirectional**. Upward frames report state; downward frames drive the session for remote (cross-machine) attach — see [daemon.md § Remote attach](daemon.md#remote-attach-cross-machine-sessions).

| Frame | Dir | Payload | Purpose |
|---|---|---|---|
| `session_push_register` | session → daemon | `sessionId, port, agentType?, projectName?, host?, remoteAttach?` | Announce the session. `remoteAttach: true` = explicit cross-machine intent (user opted in via `--remote-daemon` AND the daemon advertises `sameSocketControl`); the daemon trusts it over the socket's source IP so `ssh -L`-forwarded (loopback) workers classify correctly. `host` is display metadata. |
| `session_push_ack` | daemon → session | `sessionId` | Registration ack (sent for local registrations too). |
| `session_push_state` | session → daemon | `sessionId, state, modelName?, effortLevel?` | State update (replaces `/health` polling). When a remote registration exists, the whole update — remote registry AND the shared push-state cache — is accepted only from the session's registered sender socket; sessions with no remote registration keep the plain unguarded local path. |
| `session_focus_down` | daemon → session | `sessionId` | Same-socket reverse path: daemon focused this session; worker starts forwarding events up and emits an initial snapshot. Ignored if `sessionId` isn't the worker's own. |
| `session_unfocus_down` | daemon → session | `sessionId` | Stop forwarding events up. Ignored for foreign `sessionId`. |
| `session_command_down` | daemon → session | `sessionId, command` | A `PluginCommand` to apply — routed through the same handler as the local WS server. Ignored for foreign `sessionId`. |
| `session_event_up` | session → daemon | `sessionId, event` | A relayed `BridgeEvent` (RELAYED_EVENTS only) riding back up while focused. Dropped unless it arrives on the session's registered sender socket. |

Same-socket is the **only** reverse path (no inbound reachability required — works for NAT'd / SSH-only workers; the daemon never dials back). A remote session whose push socket dropped is unreachable until its worker reconnects. Remote attach requires a daemon advertising `sameSocketControl: true` in `/health` (Node CLI daemon; the Swift daemon does not implement these frames).

---

## State Machine

Lifecycle hooks own the 6 states; the legacy managed terminal contributes only
prompt-affordance observations (`terminal_ui` events) that hooks cannot see
yet. The transition table is the SSOT in `shared/src/states.ts`.

```
                    +----------------+
         +---------|  DISCONNECTED  |<---- SessionEnd hook / PTY closed
         |         +----------------+
         | SessionStart hook
         v
    +-----------+  Stop hook (or transcript watchdog)
    |   IDLE    |<----------------------------------+
    +-----+-----+                                   |
          | UserPromptSubmit hook                    |
          v                                         |
    +---------------+  permission prompt observed   |
    |  PROCESSING   |---------------------+         |
    +---+-------+---+                     |         |
        |       |                         v         |
        |       |                +--------------+   |
        |       |                |  AWAITING    |   |
        |       |                |  PERMISSION  |---+ user/device answers,
        |       |                +--------------+     or hooks resume
        |       | diff prompt observed                (tool activity / Stop /
        |       v                                      next prompt)
        |  +--------------+
        |  |  AWAITING    |
        |  |  DIFF        |-----------------------------+ same exits
        |  +--------------+
        | option UI observed
        v
    +--------------+
    |  AWAITING    |
    |  OPTION      |--------------------------------+ same exits
    +--------------+
```

| State | Description | Driven by |
|-------|-------------|-----------|
| `DISCONNECTED` | No session | `SessionEnd` hook, PTY exit |
| `IDLE` | Waiting for prompt | `Stop` hook; missed-Stop transcript watchdog (Claude); notify `codex_turn_complete` (Codex) |
| `PROCESSING` | Agent working | `UserPromptSubmit` hook; tool-activity hooks recover a dropped prompt-submit |
| `AWAITING_PERMISSION` | Yes/No response needed | `terminal_ui` permission-prompt observation (legacy managed sessions) |
| `AWAITING_OPTION` | Selection needed | `terminal_ui` option-prompt observation (legacy managed session; numbered list / navigable cursor) |
| `AWAITING_DIFF` | Diff review | `terminal_ui` diff-prompt observation (legacy managed session) |

`AWAITING_*` exits are hook-driven for Claude/Codex (tool activity after a
short grace, `Stop`, or the next `UserPromptSubmit` — a prompt answered at the
keyboard produces no device action, so the hooks that keep firing are the
dismissal evidence). Adapters that still normalize their native event streams
into parser signals (OpenCode, OpenClaw) additionally exit on
`spinner_start`/`idle_detected`.

---

## WebSocket Protocol

Communication between the daemon (port 9120) and all dashboard clients (Plugin, Android, Apple, TUI, ESP32).

### Bridge -> Plugin / Android

```typescript
// State change (includes tool context, options, cursor, suggested prompt, gateway health)
{ type: 'state_update', state: 'processing', permissionMode: 'default', currentTool: 'Read',
  toolInput: 'src/index.ts', navigable: false, suggestedPrompt: 'fix the bug',
  gatewayAvailable: true, gatewayHasError: false }

// Prompt options (backward-compat). Multi-session clients treat these as
// actionable only when sessionId/focusedSessionId matches the selected session.
{ type: 'prompt_options', sessionId: 'session-123', focusedSessionId: 'session-123',
  promptType: 'yes_no_always', options: [{ index: 0, label: 'Yes' }, ...] }

// Usage stats (session + API-sourced plan usage + ollama status)
{ type: 'usage_update', sessionDurationSec: 120, inputTokens: 5000, outputTokens: 3000, toolCalls: 7,
  fiveHourPercent: 42, sevenDayPercent: 15, extraUsageEnabled: true, oauthConnected: true,
  ollamaStatus: { running: true, models: [{ name: 'qwen2.5:7b', size: '4.5G' }] } }

// Connection status
{ type: 'connection', status: 'connected' }

// Voice recording state
{ type: 'voice_state', state: 'recording' }  // idle | recording | transcribing | error

// User prompt echo (text user typed in terminal)
{ type: 'user_prompt', text: 'fix the login bug' }

// Display sleep (LCD backlight sync)
{ type: 'display_sleep', displayOn: true }

// Active sessions list (multi-session + sibling state)
{ type: 'sessions_list', sessions: [{ id: 'abc', project: 'MyApp', state: 'idle' }] }
```

#### `SessionInfo` — the axes that are easy to conflate

`SessionInfo` is the row every deck, dashboard and board renders. Several of its
fields describe things that look like one fact and are not; the canonical
definitions and their reasoning live in `shared/src/protocol.ts`.

| Field | What it answers | What it is *not* |
|---|---|---|
| `state` | What this session's own turn is doing | Not "is any work happening" — see `subagents` |
| `subagents` | `{ active, peak, completed }` child census | Not derived from timeline rows; those are deduped and evicted, so a derived count reads zero in exactly the fan-out it describes |
| `agentType` | Which CLI/app drives the session (hook set, transcript format, creature) | Not which model, and not whose endpoint served it |
| `modelName` | Which weights answered | Not which company's endpoint they came from |
| `weight` | Explicit deck/tab sort override, `SESSION_WEIGHT_MIN..MAX`, default 0 | Not a priority the daemon computes |
| `liveAnswerable` | Whether the daemon can actually deliver an answer to this session right now | Not "is a question pending" — that is `question` |

Two rules apply to all of them, and both have caused shipped bugs:

- **A parent whose turn closed is genuinely `idle` while its children run.**
  `subagents` is a second axis beside `state`, not a correction to it.
- **An absent key means "no information", never "false" or "zero".** Clients
  merge retain-on-absent, so a field emitted only when non-empty latches one
  way and can never be retracted. `subagents` is therefore emitted with explicit
  zeros once a session has ever had a child.

Whether a session's harness and its endpoint disagree — a Claude Code session
answered by a third party — is derived from `agentType` + `modelName` at the
consumer through `shared/src/model-provider.ts`, and is non-null only when both
sides are known and they differ. Two unknowns must never combine into a claim.

```typescript
// --- Multi-surface events (Android Deck mirroring) ---

// Encoder LCD state (4 encoder panels: utility/action/terminal/voice)
{ type: 'encoder_state', encoders: [...], takeoverActive: false }

// Button state (8 button slots with colors, labels, actions)
{ type: 'button_state', buttons: [{ slot: 0, title: 'MODE', bgColor: '#1e293b', ... }] }

// Stream Deck+ slot map (profile layout for dynamic mirroring)
{ type: 'deck_slot_map', buttons: [...], encoders: [...] }
```

### Plugin / Android -> Bridge

```typescript
{ type: 'respond', value: 'y' }              // Yes/No/Always response (shortcut char)
{ type: 'select_option', index: 2 }          // Option selection (0-based, sends Enter)
{ type: 'navigate_option', direction: 'down' } // Cursor movement for navigable lists
{ type: 'send_prompt', text: 'fix the bug' } // Send prompt text
{ type: 'switch_mode', mode: 'plan' }        // Mode switch (Shift+Tab)
{ type: 'interrupt' }                        // Ctrl+C
{ type: 'escape' }                           // Esc key (cancel prompt/selection)
{ type: 'voice', action: 'start' }           // Voice record start/stop/cancel
{ type: 'query_usage' }                      // Refresh API usage data
{ type: 'utility', mode: 'volume', action: 'set', value: 75 }  // macOS utility proxy
```

---

## Project Structure

```
AgentDeck/
├── shared/                       # Shared type definitions
│   └── src/
│       ├── index.ts              # Re-exports
│       ├── states.ts             # State enum, transitions, StateSnapshot
│       ├── protocol.ts           # WebSocket event/command types, constants
│       └── voice-paths.ts        # Shared binary/model path constants (rec, sox, wake word)
│
├── bridge/                       # Bridge server (PTY + Hook + WS + Voice)
│   └── src/
│       ├── cli.ts                # Unified CLI entry (commander): claude/monitor/daemon/status/...
│       ├── index.ts              # startSession() — session lifecycle (PTY or monitor)
│       ├── bridge-core.ts        # BridgeCore — shared infra (SM, WS, Usage, modules)
│       ├── pty-manager.ts        # node-pty wrapper (dynamic import): spawn, proxy, interrupt
│       ├── output-parser.ts      # ANSI parsing + pattern matching
│       ├── hook-server.ts        # HTTP POST receiver (Claude Code hooks) + SSE + voice endpoint
│       ├── state-machine.ts      # Hook + PTY event → state management
│       ├── ws-server.ts          # WebSocket server (plugin comms + remote auth)
│       ├── session-registry.ts   # Session registry + daemon.json port discovery
│       ├── usage-tracker.ts      # Session usage tracking (tokens, cost)
│       ├── usage-api.ts          # Anthropic API usage fetch (OAuth + Keychain)
│       ├── voice.ts              # sox capture + on-device transcription (bundled helper)
│       ├── mdns.ts               # mDNS advertising (_agentdeck._tcp)
│       ├── auth.ts               # Auth token management (~/.agentdeck/auth-token)
│       ├── utility-proxy.ts      # Node CLI macOS osascript proxy (volume/brightness/media)
│       ├── ollama-probe.ts       # Ollama process status + running models (5s polling)
│       ├── model-catalog.ts      # OAuth model catalog fetch
│       ├── gateway-probe.ts      # OpenClaw Gateway TCP probe + doctor health check
│       ├── daemon.ts             # Legacy daemon entry (backward compat)
│       ├── daemon-server.ts      # startDaemon() — daemon lifecycle (multi-session aggregation)
│       ├── display-monitor.ts    # Display sleep sync (LCD backlight, screen wake)
│       ├── adapters/
│       │   ├── index.ts              # createAdapter() factory
│       │   ├── pty-adapter.ts        # PtyAdapter abstract base (PTY + HookServer common)
│       │   ├── claude-code.ts        # hook lifecycle + terminal UI observer + mode switch
│       │   ├── monitor.ts            # MonitorAdapter (hook-only, no PTY)
│       │   └── openclaw.ts           # OpenClawAdapter (Gateway WebSocket)
│       ├── modules/
│       │   ├── types.ts              # DeviceModule interface, BridgeContext, ModuleConfigs
│       │   ├── index.ts              # Module registry: createDefaultModules, initModules, stopModules
│       │   ├── mdns-module.ts        # mDNS advertisement module
│       │   ├── adb-module.ts         # ADB reverse tunnel module (auto-detect)
│       │   ├── serial-module.ts      # ESP32 serial module (auto-detect)
│       │   ├── pixoo-module.ts       # Pixoo64 LED matrix module (auto-detect)
│       │   └── timebox-module.ts     # Timebox Mini Light BLE sync module
│       ├── check-deps.ts         # Runtime dependency check
│       ├── logger.ts             # Structured logging
│       └── types.ts              # Bridge-local types + shared re-exports
│
├── plugin/                       # Stream Deck SDK v2 plugin
│   ├── src/
│   │   ├── plugin.ts             # SDK entry, action registration, takeover guard
│   │   ├── bridge-client.ts      # WebSocket client (auto-reconnect)
│   │   ├── connection-manager.ts # Bridge > Gateway priority, event forwarding
│   │   ├── gateway-client.ts     # Direct Gateway connection, Ed25519 auth
│   │   ├── agent-link.ts         # AgentLink interface (send/isConnected/getCapabilities)
│   │   ├── timeline-store.ts     # OC event store, grouping, disk persist, NOW marker
│   │   ├── layout-manager.ts     # State-driven button/encoder layout
│   │   ├── encoder-takeover.ts   # Encoder wide-canvas takeover (option/permission)
│   │   ├── encoder-registry.ts   # String ID → action lookup (no stale references)
│   │   ├── expanded-actions.ts   # 5+ option expanded keypad mode
│   │   ├── label-summarizer.ts   # Haiku CLI fallback for long button labels
│   │   ├── voice-local.ts        # Local voice recording (bridge-independent)
│   │   ├── project-scanner.ts    # Project directory scanner
│   │   ├── project-picker.ts     # Project/session picker UI
│   │   ├── log.ts                # Plugin logger
│   │   ├── actions/              # Button and encoder action handlers
│   │   ├── renderers/            # SVG renderers for buttons and encoder LCDs
│   │   └── utility-modes/        # Volume, mic, media, timer, brightness, darkmode
│   ├── .sdPlugin/
│   │   ├── manifest.json         # Stream Deck plugin manifest
│   │   ├── bin/                  # Build output (plugin.js)
│   │   ├── layouts/              # Encoder LCD layouts
│   │   └── static/imgs/         # Icon assets
│   └── rollup.config.mjs        # Bundle config
│
├── hooks/                        # Claude Code hook installer
│   └── src/install.ts            # Register/unregister hooks in ~/.claude/settings.json
│
├── setup/                        # npm setup package (@agentdeck/setup)
│   └── src/setup.ts              # npx @agentdeck/setup entry point
│
├── android/                      # Android dashboard app (Jetpack Compose)
│   ├── app/src/main/kotlin/dev/agentdeck/
│   │   ├── net/                  # WebSocket client, protocol, mDNS
│   │   ├── state/                # AgentStateHolder, SessionMetrics
│   │   ├── service/              # MonitorService (foreground, wake lock)
│   │   ├── terrarium/            # Creature animation engine
│   │   ├── ui/                   # Screen composables, HUD panels, e-ink, deck mirror
│   │   └── voice/                # VoiceRecorder (AudioRecord → WAV → bridge)
│   └── build.gradle.kts          # minSdk 29, CATEGORY_HOME launcher
│
├── config/                       # Prompt templates + default settings
├── scripts/                      # Install, uninstall, package, icon generation
├── package.json                  # pnpm workspaces root
├── CLAUDE.md                     # Developer reference
└── README.md
```
