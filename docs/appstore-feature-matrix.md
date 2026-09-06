---
id: policy.product-tiers
title: App Store and CLI Product Tiers
description: Canonical capability boundary between the standalone App Store app and the external CLI daemon.
category: Engineering
locale: en
canonical: true
status: required
owner: Apple product maintainers
reviewed: 2026-08-28
revision: 2026-08-28
source_of_truth: docs/appstore-feature-matrix.md
validators: [bash apple/scripts/verify-appstore-archive.sh]
---

# App Store and CLI Product Tiers

**Distribution status:** both platforms are live at [AgentDeck Dashboard](https://apps.apple.com/app/id6784822497) — macOS since 2026-07-21, the iPhone/iPad companion since 2026-08-07 (its first attempt was rejected on 2026-08-04 under Guideline 2.1(a) — an unbounded discovery spinner; the rule that came out of it is "a progress indicator binds to bounded work" in [CLAUDE.md](../CLAUDE.md) § Key Conventions). **Live version numbers are deliberately not repeated here** — this document owns the tier boundary, not release tracking, and the two drifted apart before. [RELEASING.md § Apple](../RELEASING.md) carries the per-platform version/build/state table and the login-free checks for each. The repository's source version advances independently of any channel release.

This matrix defines which capabilities belong to the standalone App Store product and which require the external `agentdeck` CLI. Add or move a row here **before** implementing a capability.

## Product contract

| Tier | Contract |
|---|---|
| Tier 1 — App Store | Complete sandboxed dashboard. No PTY, subprocess, bundled interpreter, helper executable, or install prompt. |
| Tier 2 — CLI | Optional Node daemon that owns integrations requiring external tools or unrestricted process discovery. Its legacy managed-PTY launcher remains functional as a replacement-gated compatibility path but is not the default session path. |

> **Managed-session compatibility:** `agentdeck claude`, `agentdeck codex`,
> `agentdeck opencode`, and `agentdeck monitor` remain functional with no
> removal date. Install the daemon, then run the agent normally for the default
> path. [Discussion #278](https://github.com/puritysb/AgentDeck/discussions/278)
> collects workflows for managed-only capabilities; implementation and release
> gates live in [#273](https://github.com/puritysb/AgentDeck/issues/273).

The submitted macOS app must not contain `Process()`, `/bin/sh`, AppleScript, generated `.command` files, or bundled Node/Python/sqlite binaries. Native serial, BLE, local-network, and user-selected-file access remain valid when implemented with Apple frameworks and declared entitlements.

The upgrade story exists in README, web, and developer documentation only. App Store UI must not tell users to install or launch a companion executable. CLI-only sections appear as progressive enhancement when an independently running external daemon is detected.

## Steering invariant

All surfaces follow the same rule:

1. Render steering controls only from real `options[]` the agent itself supplied — never invented ones. A PTY-managed session's options are always pressable; an observed session's are pressable only when the daemon reports `liveAnswerable`, meaning it has a way to deliver the answer (typing into that terminal, or holding the question's hook open to resolve it).
2. An observed session emits `requestId` only while the daemon is holding a real
   PreToolUse decision open for that session. Display-only notifications and
   non-held AskUserQuestion overlays never expose a request id.
3. Display-only attention shows the question and “Respond in the terminal”; it does not invent Allow/Deny choices.
4. Permission attention is keyed by `notification_type: permission_prompt`; free-text matching is legacy fallback only.

## Core dashboard

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| macOS dashboard and in-process daemon | Yes | — | Standalone Tier 1 product |
| Enterprise network posture (loopback-only / no device modules) | Yes | Yes | Same two axes both tiers. Tier 2: `daemon start --loopback/--local`, baked into autostart via `daemon install --enterprise`. Tier 1: Settings → Local server toggles (`AppPreferences.daemonLoopbackOnly` / `daemonNoDeviceModules` → `DaemonPosture`), applied by daemon restart; the sandboxed app cannot read env vars meaningfully, so a preference is the switch |
| iOS / iPadOS companion | Yes | Yes | Bonjour + same-LAN WS |
| Stream Deck family | Yes | Yes | Requires Elgato Stream Deck host software |
| Claude Code hook installation | Yes | Yes | Explicit `NSOpenPanel` file consent |
| Codex lifecycle observation | Yes | Yes | Explicit `NSOpenPanel`; managed TOML block only. Both installers include `PermissionRequest` and `Interrupt` (≤3s); new hooks require Codex trust review. Live-verified CLI 0.149.0 omits Interrupt, 0.151.0 supports it |
| Voice input | Yes | Yes | Apple on-device speech in both tiers — Tier 1 calls the framework, Tier 2 the bundled Swift helper. macOS-only; no whisper/model install |
| Deck voice key (Stream Deck hold-to-talk / D200H tap-toggle) | Yes | Yes | Deck key = trigger only; host mic/STT/TTS do the work. Tier 1: native AVFoundation+Speech (`DaemonPttVoice`), observed-Claude delivery is the queued-directive ladder (live typing needs the CLI daemon). Tier 2: bundled helper `record`, observed delivery via terminal injection |
| Device Preview catalog | Yes | Yes | macOS exposes the full catalog window; iOS/iPadOS exposes the same synthetic previews from the no-Mac connection state so the app remains inspectable without a paired host. CLI-only targets appear only with external daemon |
| APME Layer 2 LLM evaluation | Yes | Yes | Apple Intelligence default; opt-in HTTP alternatives. Both daemons apply the generated task-gradeability contract before judging: no captured agent work, client-abort-only tasks, and trivial exchanges are retained as explicitly not graded rather than scored against silence |
| Explicit OpenAI-compatible judge reasoning effort | No | Yes | Optional `apme.judge.reasoningEffort` in the Node daemon; `none` disables Ollama thinking for bounded JSON verdicts. Omission preserves provider defaults. This setting is not yet consumed by the standalone Swift judge. |
| APME Layer 1 deterministic evaluation | No | Yes | Requires `git` / package-manager subprocesses |
| APME Work board session drill-down | Yes | Yes | The generated dashboard and both daemon task-list routes support an exact native-session filter. A task-row session chip or a run detail opens all work from that session in one view; this is a read-only projection over the same local APME store and adds no subprocess or companion dependency |
| APME graph exploration | Yes | Yes | Both daemons derive the same read-only run/task/turn and session/project/model/agent/tool/subagent/file graph from local APME rows. Child lifecycle evidence remains observation-only and links only to an active parent task; it never creates a steerable child session or invokes an external process |
| Unified agent activity history (Swift/CLI dedup + merge) | Yes | Yes | Each daemon keeps its own APME database. Tier 1 collects supported hook/transcript events without subprocesses; when the same user's daemon ownership changes, the two tiers exchange only an authenticated, content-minimized activity snapshot over loopback HTTP. The dashboard and macOS menu-bar glance pane render that same merged projection by deterministic source identity and completeness precedence; neither opens the other tier's database, rewrites source rows, reads the App Store container from Node, or treats prompt text alone as identity. Historical rows without a strong identity remain separate rather than being destructively guessed together. |
| Timeline completion summary | Yes | Yes | Foundation Models → optional MLX HTTP → heuristic |
| Native App Store rating request and review link | Yes | — | StoreKit system prompt is attempted only after every live session is idle on three distinct days, with a 180-day local cooldown; processing and awaiting states never qualify. Settings keeps a user-initiated review link. Engagement dates and the last attempt stay in `UserDefaults` and are never uploaded. |
| Weather context and offline forecast cues | Yes | Yes | Tier 1 uses native WeatherKit only for the local Dashboard (in-memory refresh cache, Apple mark + legal link). Tier 1's public portable feed and Tier 2 both use keyless MET Norway, persist that provider cache, preserve attribution, and emit up to seven days plus absolute-time display/notification cues for intermittently connected readers. Location is explicit user configuration (or one-time OS location consent), never IP-derived. No subprocess or companion executable is involved. |
| Surface Protocol portable Feed negotiation | Yes | Yes | Both tiers validate the eight-field identity and implement conditional Feed, Outbox replay, pull telemetry, product-scoped persistent OTA staging, bounded resume/206, and install acknowledgement. Tier 1 stores staged bytes inside its App Container and enforces negotiated WS event/command boundaries natively. Tier 2 additionally owns adaptive Pocket content and Glance Frame pixels. Neither grants Inbox. No subprocess or companion-install prompt is involved. |
| Surface Protocol licensed learning-pack delivery | Yes | Yes | Both daemons advertise a bundled, integrity-checked offline learning pack in full and unchanged portable Feed responses and serve it through authenticated `GET /learning/pack`. Delivery is gated by `learning.pack.read` / `learning.pack.update`, the registered Pocket Daily product identity, exact pack id/version, and the pack's SPDX licence metadata. The App Store path reads a signed bundle resource only; it launches no process and accesses no external path. |
| Surface Protocol automatic font-pack delivery | Yes | Yes | Both daemons advertise the bundled OFL PocketSansWorld pack in full and unchanged portable Feed responses and serve it through authenticated `GET /fonts/pack`. Delivery is gated by `font.pack.read` / `font.pack.update`, exact Pocket Daily identity and id/version, plus size, MD5, SHA-256, cpfont-format, source-ledger, and licence validation. The App Store path reads signed bundle resources only. |
| App Store Connect engagement reports | Yes | — | Maintainer tooling creates ONGOING reports plus an optional ONE_TIME_SNAPSHOT for existing history, then downloads Apple's opt-in, privacy-thresholded aggregate analytics through the App Store Connect API. Creating requests requires Admin access; existing reports can be downloaded with Admin, Finance, or Sales and Reports access. No analytics SDK, device identifier, event upload, or AgentDeck-operated analytics backend is added to the app. |

## Usage and cost

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| Claude subscription 5h / 7d usage | Relay only | Yes | Tier 1 relays only what an external daemon supplies — no standalone Tier-1 path exists. Anthropic ToS prohibits third-party Claude.ai login / routing through subscription credentials (enforced 2026-04-04 vs OpenClaw/OpenCode/NanoClaw); the only documented Usage API is org-admin-only and returns token/USD, not consumer %; the true 5h/7d % lives only in Claude Code's undocumented `/api/oauth/usage`. Shipped competitors (LimitWatch, Usage for Claude) use the same broker→iCloud→display architecture — LimitWatch ships its Mac broker as a non-App-Store direct download because the sandbox blocks reading AI-tool config files. |
| Claude usage authorization recovery | Status relay only | Yes | The Node daemon can ask the user's Claude CLI to renew expired credentials with a bounded, tool-free Haiku turn (may consume a small amount of quota). Hooks, MCP, session persistence and workspace customization are disabled. Retries are throttled across restarts; AgentDeck never rotates or writes Claude refresh tokens. Custom macOS credential namespaces are skipped because the usage reader targets the default Keychain service. The app displays the relayed failure reason and automatically clears it on recovery; no subprocess or installation prompt is added to Swift. |
| Claude per-model scoped caps (weekly) | Relay only | Yes | The `/api/oauth/usage` `limits[]` array's per-model `weekly_scoped` caps (e.g. a "Fable" cap that binds while 5h/7d read low). **Direct OAuth acquisition stays in the Node daemon**; the Swift/App Store path consumes `scopedLimits` only through the generated protocol + daemon relay (`DaemonServer.parseRelayedUsage` / the shared usage cache the Node daemon writes) — it never parses `limits[]` itself. Renders when `isUsingExternalDaemon` is true, exactly like the 5h/7d row. |
| Codex rate limits (passive rollout read) | Yes | Yes | User grants a security-scoped bookmark to `~/.codex`. Both tiers reconcile the snapshot against the live account tier in `auth.json` and **void** one minted under a plan the account no longer holds — neither freshness axis can retire it, since a lapsed plan's weekly window stays future-dated (`codexSnapshotMatchesAccountPlan`, mirrored to Swift as the generated `CodexPlanRules`). Voiding rides the wire as a windowless block, so Tier 1's own daemon retracts the gauge rather than leaving a client to guess |
| Codex rate limits (live `app-server` query) | No | Yes | The rollout `rate_limits` block is a byproduct of a **successful turn**, so the reading freezes exactly when the quota is exhausted (no turn can complete) and never sees usage spent on Codex Cloud or another machine. Tier 2 backs it with a throttled `codex app-server` → `account/rateLimits/read` JSON-RPC query against the user's own CLI (`bridge/src/codex-rate-limits-live.ts`); the fresher of the two snapshots wins by `capturedAt`. Tier 1 cannot follow — the App Store daemon spawns no subprocess — so it keeps the passive read and its age footnote. This is also why plan reconciliation matters most on Tier 1: with no live query to overwrite it, a retired plan's snapshot is the *only* thing Tier 1 would ever read, and Codex is its only quota gauge (Claude's needs the relay). |
| Anthropic Admin API usage | Yes | Yes | User supplies the API key |
| Terminal status-line token and cost telemetry | Hook-only | Yes (compatibility) | Legacy CLI-managed UI telemetry; no daemon-first replacement. Lifecycle correctness comes from hooks/events, never terminal scraping. Tracked in #273 |

## Hardware

| Device / operation | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| Ulanzi D200H | Yes | Yes | Ulanzi Studio plugin is the only driver; no direct HID |
| Ulanzi D200X LCD keys | Partial | Partial | Same 14-key Ulanzi Studio action as D200H; SDK/simulator contract is covered, but real-hardware verification is pending and the three encoders are not supported |
| Pixoo64 | Yes | Yes | Native LAN HTTP |
| Timebox Mini | Yes | Yes | Tier 1 CoreBluetooth; Tier 2 BLE helper path |
| iDotMatrix | Yes | Yes | Tier 1 CoreBluetooth; one BLE display connection at a time |
| ESP32 state display and Wi-Fi provisioning | Yes | Yes | Native serial and network frameworks |
| ESP32 serial firmware flash | No | Yes | `agentdeck esp32 flash` bundles esptool-js and drives the port through the optional native `serialport` module — no user-installed `esptool.py`. Also available with no install at all from the browser flasher (Chrome/Edge desktop, Web Serial). **The App Store target is unchanged and stays No**: the sandbox is not the obstacle (`com.apple.security.device.serial` is already granted and the app already does raw POSIX serial writes) — the no-subprocess contract is, and clearing it would mean reimplementing the ESP32 ROM loader in Swift. Not planned. |
| ESP32 Wi-Fi OTA push | Yes | Yes | Firmware bytes pushed over existing WS; firmware build remains CLI-only |
| Ulanzi TC001 | Pending | Yes | Swift `led8x32` hardware verification gap, not sandbox restriction |
| InkDeck | Experimental | Experimental | Registration exists; physical render/refresh release validation incomplete |
| XTeink X3 / X4 | Yes | Yes | Independent Pocket Daily Reader firmware; registers with both daemons over Wi-Fi and retains its own product identity/releases (SD-card flash distribution) |
| Android e-ink / tablet presence | Partial | Yes | Same-LAN self-registration is safe; ADB preview/tunnel requires CLI |

## Agent sessions

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| Claude Code hook monitoring | Yes | Yes | Local HTTP hook ingestion |
| Codex lifecycle/notify/OTel monitoring | Yes | Yes | Opt-in managed config |
| Existing terminal-session discovery | Limited | Yes | General `ps` / `lsof` / transcript discovery is CLI-only |
| Display-only permission attention | Yes | Yes | Real signals only, per agent: Claude `Notification` (`permission_prompt`), Codex `PermissionRequest` (fires only when Codex is about to ask; `Interrupt` closes the turn), OpenCode `permission.asked` (answerable requestId in both tiers), OpenClaw `exec.approval.requested`. Kiro/Antigravity have no permission source and never show PERM. No fabricated options |
| Observed Claude PreToolUse hold (device Allow/Deny) | Yes, when `~/.claude` is readable | Yes | The one predicted PERM: held only when the generated `ClaudePermissionRules` predictor (shared SSOT, vector-pinned) says Claude would genuinely prompt — mode gate, allow/deny/ask rules in the documented wildcard grammar, built-in read-only set, `acceptEdits` filesystem commands. Sandboxed builds that cannot list `~/.claude` hold nothing |
| Session order pinning (`--weight` sort override) | Limited | Yes (compatibility) | Weight is CLI-set only by the managed launcher and reaches the Swift daemon via `session_push_register`; observed-hook sessions never carry it. A daemon-persisted replacement must be validated before this path can be removed; tracked in Discussion #278 and issue #273 |
| Adaptive high-volume menu bar overview | Yes | Yes | The popup keeps a bounded height at every session/device count: actionable sessions stay visible, idle sessions and repeated surface families collapse into counted summaries, and Activity shows completed work from a named recent window instead of unbounded duration totals. The Dashboard retains the complete roster, topology, and report. This is presentation-only and uses the same daemon state in both tiers |
| Adaptive high-volume Dashboard session panel | Yes | Yes | The left HUD reserves the Timeline region, widens within a fixed landscape cap, switches to compact rows for larger rosters, and scrolls the complete session collection inside its own bounded card instead of painting over Timeline. Adjacent setup guidance shifts beside the roster rather than covering it. Presentation-only; focus and session data remain identical in both tiers |
| Form-factor-readable Dashboard HUD | Yes | Yes | iPhone/compact-phone portrait presents one full-width readable HUD rail at a time with an explicit Sessions/System switch; phone landscape, iPad/tablet, and macOS retain the dual-rail terrarium composition with bounded Timeline-safe heights. Android e-ink keeps its static high-contrast, no-scroll projection while typography and spacing scale by reader size. Presentation-only; all tiers consume the same session, topology, and timeline state |
| Managed terminal UI steering | No | Yes (compatibility) | The legacy compatibility observer reads only real mode/diff/option UI and injects keys; lifecycle state, timeline, and APME remain hook/event-owned. Direct-launch steering uses ask-gates/injection and is not fully equivalent. Tracked in #273 |
| Observed AskUserQuestion — device answer (ask-gate) | Yes | Yes | The daemon holds the question's PreToolUse hook open and resolves it with the option the user picked, stated as the decision reason. Pure HTTP hold, no subprocess, so it works sandboxed. Engaged only when injection is unavailable (always so in Tier 1); an unanswered hold releases empty, and Claude's own picker appears in the terminal as usual. Multi-question calls are answered one question at a time |
| Observed-session answer injection (device tap → host UI) | No | Yes | tmux / iTerm2 / Terminal.app by tty, GUI apps by AX button or key events. Needs `ps` tty discovery + tmux/osascript subprocesses — both CLI-only; sandbox has neither. Preferred over the ask-gate when available: it answers the live picker with no added latency for whoever is at that terminal |
| OpenCode monitoring | Opt-in read-only | Yes | Tier 1 connects only to a configured/fixed local server; no port scan. Both tiers build per-session rows from the observer plugin's `opencode_*` hooks (turn state, running tool, permission); the CLI's process scan adds PID rows only for sessions no hook has claimed |
| Antigravity session monitoring | No | Yes | Tier 1 may display user-approved usage data only |
| Kiro CLI / IDE session monitoring | Yes, after granting `~/.kiro` | Yes | Both tiers read Kiro's own store, because Kiro reports nothing on its own: its standalone lifecycle hooks load but CLI chat fires none of them (measured 2026-08-17, kiro-cli 2.18.1 — each hook instrumented with a marker, a live turn produced zero markers while a hand-POSTed hook produced a row normally). The App Store build reaches `~/.kiro` only through a **user-granted security-scoped bookmark** (Settings → Integrations → Kiro CLI), the same shape as `~/.codex`; with no grant it observes nothing rather than guessing. Sessions and their chat rows come from the transcript, so an observed Kiro session is always reported `idle` — passive reading cannot see a turn in flight. Process discovery stays CLI-only; the App Store path keys on the transcript instead |
| Subagent activity summaries + parent-linked orbit visuals | Yes | Yes | Read-only lifecycle hooks collapse each child to concise start/completion rows using existing Timeline types. Terrarium surfaces may derive non-interactive wire/ring/satellite accents around the owning parent; they never become selectable sessions. No subagent commands, approvals, team configuration, or process discovery |
| Managed launch argument profiles (`AGENTDECK_COMMANDER_ARGS`, `AGENTDECK_*_ARGS`, `-c`) | No | Yes (compatibility) | The managed launcher composes persistent and one-off arguments, including resume commands, with platform-specific quoting and override rules. No daemon-first equivalent exists; Discussion #278 and issue #273 gate replacement/removal |
| Launch Claude / Codex / OpenCode session | No | Yes (compatibility) | `agentdeck <agent>` remains functional with no removal date. The supported default for ordinary local sessions is `agentdeck daemon install`, then a normal agent command. Tracked in #273 |
| OpenClaw Gateway WebSocket pairing | Yes | Yes | Local WS, Keychain identity, optional user-selected token file |
| OpenClaw CLI pairing | No | Yes | Requires external `openclaw` process |

## Infrastructure

| Component | App Store | CLI |
|---|---|---|
| Minimum macOS | macOS 26+ | macOS 15+ for Node; macOS 26+ for Swift/Foundation Models paths |
| Minimum iOS / iPadOS | iOS 17 | — |
| Daemon | In-process Swift | Node.js 22+ |
| Data directory | App sandbox Application Support | `~/.agentdeck/` |
| Executable payload | Signed AgentDeck binary only | Node packages and external tool integrations |

The Node daemon deliberately excludes the App Store container from settings discovery. A non-sandboxed process reading that container can trigger TCC hangs; coexisting Tier 2 settings must live in the daemon’s own data directory.

## Parity intent (decided 2026-07-26)

The tier split is a sandbox consequence, not a product goal. Two standing
decisions follow from that:

1. **The Swift daemon tracks the Node daemon as closely as the sandbox
   allows.** When a capability lands on Node, port it to Swift unless an
   entitlement or the no-subprocess contract makes it impossible — and when it
   is impossible, say so where the user can see it (a log line or hidden UI),
   never a silent no-op.
2. **App-hosted agent surfaces are pursued, not written off.** Claude.app and
   ChatGPT.app sessions are first-class targets for steering; where their
   accessibility trees are opaque, use the focus-free key path and keep the
   button path for hosts that do expose controls.

## Required change order

1. Add or change the capability row in this matrix.
2. For Tier 1, prove a subprocess-free implementation path.
3. Keep App Store copy self-contained; never add a CLI install or Terminal launch nudge.
4. Update `apple/APP_REVIEW_NOTES.md` and App Store metadata when behavior or disclosure changes.
5. Extend `apple/scripts/verify-appstore-archive.sh` if a new forbidden path needs detection.
6. Build a signed Release archive and run the archive verifier. An unsigned Debug build is not submission evidence.

## Rejected patterns

- `Process()`, AppleScript, shell scripts, or external CLI calls in the macOS source tree.
- App Store copy such as “Install AgentDeck CLI” or “Open Terminal and…”.
- Buttons that imply an external daemon or helper will be launched.
- Treating Gateway availability as authenticated connection; use the authenticated state.
- Showing sandbox limitations as broken empty sections; hide unavailable progressive enhancements.
- Rendering steering buttons without real session options.
