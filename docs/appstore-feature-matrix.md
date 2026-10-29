---
id: policy.product-tiers
title: App Store and CLI Product Tiers
description: Canonical capability boundary between the standalone App Store app and the external CLI daemon.
category: Engineering
locale: en
canonical: true
status: required
owner: Apple product maintainers
reviewed: 2026-10-29
revision: 2026-10-29
source_of_truth: docs/appstore-feature-matrix.md
validators: [bash apple/scripts/verify-appstore-archive.sh]
---

# App Store and CLI Product Tiers

**Distribution status:** both platforms are live at [AgentDeck Dashboard](https://apps.apple.com/app/id6784822497) — macOS since 2026-07-21, the iPhone/iPad companion since 2026-08-07 (its first attempt was rejected on 2026-08-04 under Guideline 2.1(a) — an unbounded discovery spinner; the rule that came out of it is "a progress indicator binds to bounded work" in [.claude/rules/swift-daemon.md](../.claude/rules/swift-daemon.md)). **Live version numbers are deliberately not repeated here** — this document owns the tier boundary, not release tracking, and the two drifted apart before. [RELEASING.md](../RELEASING.md) carries the current per-platform version, build and state in its dated checkpoints; its § Apple keeps the login-free checks for each platform. The repository's source version advances independently of any channel release.

This matrix defines which capabilities belong to the standalone App Store product and which require the external `agentdeck` CLI. Add or move a row here **before** implementing a capability.

## Product contract

APME task review is available in both tiers: task-level human corrections are
stored separately from AI estimates, with judge provenance, recorded evidence,
and explicit evaluation-attempt status. The macOS activity panel can open the
corresponding task directly in the embedded local report. No subprocess or
external service is required for review or correction.

| Tier | Contract |
|---|---|
| Tier 1 — App Store | Complete sandboxed dashboard. No PTY, subprocess, bundled interpreter, helper executable, or install prompt. |
| Tier 2 — CLI | Optional Node daemon that owns integrations requiring external tools or unrestricted process discovery. Its legacy managed-PTY launcher is a long-term compatibility path with no removal planned (#273) but is not the default session path. |

> **Managed-session compatibility:** `agentdeck claude`, `agentdeck codex`,
> `agentdeck opencode`, and `agentdeck monitor` are a long-term compatibility path with no removal planned ([#273](https://github.com/puritysb/AgentDeck/issues/273)). Install the daemon,
> then run the agent normally for the default path.

The submitted macOS app must not contain `Process()`, `/bin/sh`, AppleScript, generated `.command` files, or bundled Node/Python/sqlite binaries. Native serial, BLE, local-network, and user-selected-file access remain valid when implemented with Apple frameworks and declared entitlements.

The upgrade story exists in README, web, and developer documentation only. App Store UI must not tell users to install or launch a companion executable. CLI-only sections appear as progressive enhancement when an independently running external daemon is detected.

## Steering invariant

All surfaces follow the same rule:

1. Render steering controls only from real `options[]` the agent itself supplied — never invented ones. A PTY-managed session's options are always pressable; an observed session's are pressable only when the daemon reports `liveAnswerable`, meaning it has a way to deliver the answer (typing into that terminal, or holding the question's hook open to resolve it).
2. An observed session emits `requestId` only while the daemon is holding a real
   decision open for that session (a Claude PreToolUse or an opted-in Codex
   `PermissionRequest`). Display-only notifications and non-held
   AskUserQuestion overlays never expose a request id.
3. Display-only attention shows the question and “Respond in the terminal”; it does not invent Allow/Deny choices.
4. Claude permission attention comes from the `PermissionRequest` hook, which runs as Claude is about to draw its dialog, and falls back to the Notification keyed by `notification_type: permission_prompt`. Free-text matching is legacy fallback only.

## Core dashboard

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| CI wait observation (#433) | Hook evidence | Hook evidence; optional GitHub status | Both daemons track explicitly identified CI watch tools independently of agent turn state, clear matching foreground tools and session boundaries, and emit explicit null on close. Background watches survive Stop. Hook intent has unknown CI phase until provider evidence arrives; it never proves success or failure. The App Store app must not spawn `gh`. No credentials or raw command reach the wire. |
| Guided first use | Yes | — | Choose an available 2D/3D appearance, explicitly enable Claude/Codex observation through the existing consent flow, and enter with observed/ready/not-set-up status. Hardware discovery is optional, with an existing Stream Deck path and offline Device Preview. iOS offers appearance then bounded Mac discovery/QR pairing. Setup can be reopened; notifications are requested only on an explicit action. |
| Hermes mermaid aquarium resident | Yes | Yes | Bundled Blender-authored Nous girl-inspired mermaid; observed Hermes sessions drive working/waiting poses. A fixed shell seat for idle rest, bounded lift-off for active work, skinned body/tail/fin and arm joints, independently controlled gaze/lids/brows/mouth, and cosmetic neighbour greetings; no inferred delegation or new controls. Both daemons ingest Hermes observer events. Explicit receiver selection supports direct Swift delivery; observer installation and enablement remain external setup (see Agent sessions). Reduced Motion freezes movement. |
| Optional native 3D aquarium | Yes | Yes | Device-local dashboard type; bundled Blender-authored habitat and canonical extruded agent meshes. RealityKit live session reconciliation, status labels and existing focus commands; standard dashboard retained. No runtime Blender or external model download. |
| Multi-daemon companion pairing (#493) | Yes | Compatible host | Explicit host selection, endpoint-scoped credential retention, and host-specific approval recovery. Discovery carries no credentials; approval remains operator-controlled. |
| macOS dashboard and in-process daemon | Yes | — | Standalone Tier 1 product |
| macOS attention shortcuts and notification navigation | Yes | Compatible host | Native Shortcuts list live sessions awaiting a response and open a specific session in the Dashboard. Notification clicks use the same endpoint-scoped, local inspection route. Roster freshness is tracked separately from usage and timeline traffic; unavailable state is never reported as an empty queue. Opening a session does not answer a prompt, launch a session, or change hardware control focus. Cold-start waits are bounded. No new entitlement, helper or extension is required. |
| Experimental macOS collaboration lens | Yes | Yes | Opt-in Dashboard right rail with an expandable graph of all roster sessions and observed message links. Habitat shows these relationships as quiet cyan currents between visible creatures in both 2D and 3D; recent messages carry directional bubbles, reduced motion keeps them still. Selection filters currents to that creature. Both daemons expose bounded, authenticated relation-only history, without tool payloads or subprocesses. Only an explicit reply request in the complete observed message starts a timer; notifications, replies and unknown/legacy intent never start one. Notifications cannot settle an outstanding request. An explicitly worded reply can settle a single outstanding request; multiple requests or crossed messages remain unconfirmed because Claude supplies no reply correlation. Both directions retain their own waits independently of the latest message arrow. Unknown peers, absent sessions, stale reads and truncated history remain explicit. Graph selection uses dashboard inspection without changing agent control. Selected-session task history, subagent census and existing controls remain available. |
| Cross-session coordination evidence (`RelationEvent` + `SessionInfo.coordination`) | Partial | Yes | Work divided WITHOUT a SubagentStart: `claude -p` workers spawned from a background Bash (`spawned`, process ancestry), peer messages over SendMessage (`messaged`, the sender's tool input and the receiver's `<cross-session-message>` envelope), and background jobs a session is waiting on (`waiting_on`, argv names its scratchpad). Both tiers produce all three plus the live `coordination` census on `sessions_list` (`bridge/src/coordination-evidence.ts`; Swift `CoordinationTracker` is a transliteration, both replay `shared/coordination-evidence-vectors.json`). The session→process link is the hook header `X-AgentDeck-Pid: $PPID` on both tiers; Tier 2 additionally reads `~/.claude/sessions/<pid>.json`. The process table is `sysctl` on Tier 1 (`ProcessEnumerator.processTable`, no entitlement, no subprocess) and `ps` on Tier 2. IPS10 cards receive `coordination {backgroundJobs, spawnedActive}` and a bounded rotating roster (`stableCardRoster`, up to three attention sessions pinned, remaining sessions rotate every 60 seconds, id order within each page, `total` and `rosterRotating` metadata) from either daemon. Observed only — never inferred from shared project membership. A `TaskCompleted` checklist item is an `info` annotation on both tiers, never a child agent. |
| Enterprise network posture (loopback-only / no device modules) | Yes | Yes | Same two axes both tiers. Tier 2: `daemon start --loopback/--local`, baked into autostart via `daemon install --enterprise`. Tier 1: Settings → Local server toggles (`AppPreferences.daemonLoopbackOnly` / `daemonNoDeviceModules` → `DaemonPosture`), applied by daemon restart; the sandboxed app cannot read env vars meaningfully, so a preference is the switch |
| iOS / iPadOS companion | Yes | Yes | Bonjour + same-LAN WS |
| Stream Deck family | Yes | Yes | Requires Elgato Stream Deck host software |
| Claude Code hook installation | Yes | Yes | Explicit `NSOpenPanel` file consent |
| Codex lifecycle observation | Yes | Yes | Explicit `NSOpenPanel`; managed TOML block only. Both installers include `PermissionRequest` and `Interrupt` (≤3s); new hooks require Codex trust review. Live-verified CLI 0.149.0 omits Interrupt, 0.151.0 supports it |
| Voice input | Yes | Yes | Apple on-device speech in both tiers — Tier 1 calls the framework, Tier 2 the bundled Swift helper. macOS-only; no whisper/model install |
| Deck voice key (Stream Deck hold-to-talk / D200H tap-toggle) | Yes | Yes | Deck key = trigger only; host mic/STT/TTS do the work. Tier 1: native AVFoundation+Speech (`DaemonPttVoice`), observed-Claude delivery is the queued-directive ladder (live typing needs the CLI daemon). Tier 2: bundled helper `record`, observed delivery via terminal injection |
| Device Preview catalog | Yes | Yes | macOS exposes the full catalog window; iOS/iPadOS exposes the same synthetic previews from the no-Mac connection state so the app remains inspectable without a paired host. CLI-only targets appear only with external daemon |
| APME Layer 2 LLM evaluation | Yes | Yes | Apple Intelligence default; opt-in HTTP alternatives. Both daemons apply the generated task-gradeability contract before judging: no captured agent work, client-abort-only tasks, and trivial exchanges are retained as explicitly not graded rather than scored against silence |
| Explicit OpenAI-compatible judge reasoning effort | Yes | Yes | Both daemons consume optional `apme.judge.reasoningEffort` and send `reasoning_effort` to the configured OpenAI-compatible endpoint. Swift validates the setting in `ApmeSettings` and emits it in `ApmeJudgeOpenAI`; omission preserves provider defaults. Whether a value is honored depends on the endpoint. |
| Reject incomplete judge responses (`finish_reason=length`) | Yes | Yes | MLX and OpenAI-compatible adapters reject output-limit responses before parsing or storing a verdict; shared response vectors cover both daemons. |
| APME Layer 1 deterministic evaluation | No | Yes | Requires `git` / package-manager subprocesses |
| APME Work board session drill-down | Yes | Yes | The generated dashboard and both daemon task-list routes support an exact native-session filter. A task-row session chip or a run detail opens all work from that session in one view; this is a read-only projection over the same local APME store and adds no subprocess or companion dependency |
| APME graph exploration | Yes | Yes | Both daemons derive the same read-only run/task/turn and session/project/model/agent/tool/subagent/file graph from local APME rows. Child lifecycle evidence remains observation-only and links only to an active parent task; it never creates a steerable child session or invokes an external process |
| Stable dashboard provider display | Yes | Yes | Authenticated `/dashboard/providers` stores the explicit provider list in daemon-owned settings. Apple and Android share it; visibility does not disable session observation. No subprocess, external file grant, or companion-install prompt is added. |
| Unified agent activity history (Swift/CLI dedup + merge) | Yes | Yes | Each daemon keeps its own APME database. Tier 1 collects supported hook/transcript events without subprocesses; when the same user's daemon ownership changes, the two tiers exchange only an authenticated, content-minimized activity snapshot over loopback HTTP. The dashboard and macOS menu-bar glance pane render that same merged projection by deterministic source identity and completeness precedence; neither opens the other tier's database, rewrites source rows, reads the App Store container from Node, or treats prompt text alone as identity. Historical rows without a strong identity remain separate rather than being destructively guessed together. |
| Timeline completion summary | Yes | Yes | Foundation Models → optional MLX HTTP → heuristic; ordinary tool activity and the final response stay under the originating prompt, with expandable bounded tool evidence |
| Native App Store rating request and review link | Yes | — | StoreKit system prompt is attempted only after every live session is idle on three distinct days, with a 180-day local cooldown; processing and awaiting states never qualify. Settings keeps a user-initiated review link. Engagement dates and the last attempt stay in `UserDefaults` and are never uploaded. |
| Weather context and offline forecast cues | Yes | Yes | Tier 1 uses native WeatherKit only for the local Dashboard (in-memory refresh cache, Apple mark + legal link). Tier 1's public portable feed and Tier 2 both use keyless MET Norway, persist that provider cache, preserve attribution, and emit up to seven days plus absolute-time display/notification cues for intermittently connected readers. Location is explicit user configuration (or one-time OS location consent), never IP-derived. No subprocess or companion executable is involved. |
| Surface Protocol portable Feed negotiation | Yes | Yes | Both tiers validate the eight-field identity and implement conditional Feed, Outbox replay, pull telemetry, product-scoped persistent OTA staging, bounded resume/206, and install acknowledgement. Tier 1 stores staged bytes inside its App Container and enforces negotiated WS event/command boundaries natively. Tier 2 additionally owns adaptive Pocket content and Glance Frame pixels. Neither grants Inbox. No subprocess or companion-install prompt is involved. |
| Surface Protocol licensed learning-pack delivery | Yes | Yes | Both daemons advertise a bundled, integrity-checked offline learning pack in full and unchanged portable Feed responses and serve it through authenticated `GET /learning/pack`. Delivery is gated by `learning.pack.read` / `learning.pack.update`, the registered Pocket Daily product identity, exact pack id/version, and the pack's SPDX licence metadata. The App Store path reads a signed bundle resource only; it launches no process and accesses no external path. |
| Surface Protocol automatic font-pack delivery | Yes | Yes | Both daemons advertise the bundled OFL PocketSansWorld pack in full and unchanged portable Feed responses and serve it through authenticated `GET /fonts/pack`. Delivery is gated by `font.pack.read` / `font.pack.update`, exact Pocket Daily identity and id/version, plus size, MD5, SHA-256, cpfont-format, source-ledger, and licence validation. The App Store path reads signed bundle resources only. |
| App Store Connect engagement reports | Yes | — | Maintainer tooling creates ONGOING reports plus an optional ONE_TIME_SNAPSHOT for existing history, then downloads Apple's opt-in, privacy-thresholded aggregate analytics through the App Store Connect API. Creating requests requires Admin access; existing reports can be downloaded with Admin, Finance, or Sales and Reports access. No analytics SDK, device identifier, event upload, or AgentDeck-operated analytics backend is added to the app. |

## Ordinary-session setup and evidence

| Agent / path | Initial setup | Reliable evidence and limits |
|---|---|---|
| Claude Code local | CLI daemon setup, or app file consent | Hook lifecycle; permission and held-decision paths remain distinct. |
| Codex CLI / local Desktop | CLI setup, or app config/folder consent; Codex hook trust remains user-owned | New SessionStart is idle; prompt/tool events prove work. Written TOML alone does not prove trust or event delivery. Existing hooks=false is preserved. Later Codex settings inside the managed fence are retained; an extended features table becomes user-owned, including its hooks flag. |
| OpenCode ordinary TUI | CLI setup installs observer plugin | Current permission IDs and question IDs are tracked separately; questions are answered in OpenCode. No special launch command after setup. |
| OpenCode standalone app path | Enable monitoring and provide a reachable server | Discovery uses the configured URL, default port or a readable explicit `--port N` argument. SSE is read-only. A bare TUI's random port is not automatically discoverable. Pending requests are seeded per directory after SSE attaches; connection loss is not completion. Reconnect prioritizes remembered event directories, then the latest 200 global session records, with a cap of 32 directories plus the server default and four concurrent directory reads. Older/unavailable global inventory falls back to remembered locations and the default. |
| Kiro CLI | Node store access, or explicit app folder consent | Passive polling; Swift supports flat and nested JSONL, Node additionally supports v2 SQLite. No permission signal. |
| Antigravity | Node passive observer | App-only session observation remains unavailable; usage display is a separate capability. |
| OpenClaw | Existing experimental Gateway pairing | Gateway lifecycle and approvals; pairing is required. |
| Claude App cloud Code | Not supported | Deferred; no local transcript/hook evidence or cloud relay added. |

`agentdeck diag agents` separates registration-file evidence from unverified
activation and unchecked event reception. It reads configuration and invokes
only version commands, never starts a paid agent turn or automatically trusts
hooks. An absent event during inactivity is not evidence of broken integration.

## Usage and cost

The revised standalone Claude boundary below is part of the
[macOS 1.9.2 accuracy reassessment](../RELEASING.md#macos-192-claude-accuracy-reassessment-2026-10-23).
That release record tracks the withdrawal of 9201 and the replacement
candidate; an older artifact's successful upload does not validate this policy.

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| Claude subscription 5h / 7d usage | External relay only | Yes | **Replacement macOS 1.9.2 policy, 2026-10-23:** the standalone Swift daemon does not promote status-line documents into account quota, gauges or a Claude subscription row. A documented session snapshot does not establish the current account's usage, even when the document has just arrived. Missing or unverified quota stays absent, never zero. Existing external-daemon relay behavior and the Node daemon's quota policy are unchanged; the user's provider-display preference and [quota retirement policy](../.claude/rules/usage-quota.md) still apply. Swift direct OAuth acquisition remains disabled. Node retains its separate undocumented `/api/oauth/usage` path and bounded account rechecks. Anthropic's [authentication and credential-use guidance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) restricts third-party Claude.ai login and collection or intermediation of Claude.ai credentials/session tokens. The documented status-line interface does not establish current-account accuracy or compliance of Node's separate OAuth path. |
| Claude status-line observation | Diagnostics only | Yes | Claude Code may POST its [documented status-line document](https://code.claude.com/docs/en/statusline#rate-limit-usage) to `/claude/statusline` over same-machine HTTP. Swift retains diagnostic receipt/observation metadata without turning the session's numeric windows into account usage or subscription display. Hook-based session observation remains available. Installation requires explicit settings-file consent and preserves the user's existing command. With no status line configured, Settings → Claude Code → Always is opt-in because a configured status line hides Claude Code's footer hints; Off restores the original. No OAuth credential acquisition or subprocess is added to Swift. The external Node daemon's interpretation of status-line documents is unchanged by this macOS correction. |
| Claude usage authorization recovery | Status relay only | Yes | The Node daemon can ask the user's Claude CLI to renew expired credentials with a bounded, tool-free Haiku turn (may consume a small amount of quota). Hooks, MCP, session persistence and workspace customization are disabled. Retries are throttled across restarts; AgentDeck never rotates or writes Claude refresh tokens. Custom macOS credential namespaces are skipped because the usage reader targets the default Keychain service. The app surfaces only an explicitly relayed `tokenStatus: expired` and clears it as soon as fresh external readings arrive; `unknown` / `missing` stay silent. Standalone Swift does not acquire Claude OAuth credentials or present status-line observations as verified account quota; absence of quota alone is not an authorization failure. No subprocess or installation prompt is added to Swift. |
| Claude per-model scoped caps (weekly) | Relay only | Yes | The `/api/oauth/usage` `limits[]` array's per-model `weekly_scoped` caps (e.g. a "Fable" cap that binds while 5h/7d read low). **Direct OAuth acquisition stays in the Node daemon**; the Swift/App Store path consumes `scopedLimits` only through the generated protocol + daemon relay (`DaemonServer.parseRelayedUsage` / the shared usage cache the Node daemon writes) — it never parses `limits[]` itself. These caps require external OAuth-family data; standalone status-line observations do not supply them. |
| Codex rate limits (passive rollout read) | Yes | Yes | User grants a security-scoped bookmark to `~/.codex`. Both tiers reconcile the snapshot against the live account tier in `auth.json` and **void** one minted under a plan the account no longer holds — neither freshness axis can retire it, since a lapsed plan's weekly window stays future-dated (`codexSnapshotMatchesAccountPlan`, mirrored to Swift as the generated `CodexPlanRules`). Voiding rides the wire as a windowless block, so Tier 1's own daemon retracts the gauge rather than leaving a client to guess |
| Codex account usage (live) | Yes | Yes | Swift uses a bounded native HTTPS GET of Codex's account usage endpoint, with credentials from the user-granted Codex folder. It polls every 30 seconds independently of rollout activity, so coupon resets do not wait for a new turn. No subprocess or token refresh is performed. Node retains its existing throttled app-server reader. |
| z.ai GLM Coding Plan usage | Yes | Yes | Provider-account quota via bounded native HTTPS; credit and MCP tool-call windows remain distinct. Standalone macOS stores an optional key in Keychain and refreshes only this provider after edits. Node uses its own provider configuration; same-Mac external-daemon mode edits that active daemon through an authenticated loopback-only endpoint. Remote companions consume readings and edit credentials on the hosting Mac. Authentication rejection is separate from unavailable readings. Keys are never returned by the endpoint; automatic cross-daemon key sharing and sibling usage relay are not implemented. |
| Anthropic Admin API usage | Yes | Yes | User supplies the API key |
| Terminal status-line token and cost telemetry | Hook-only | Yes (compatibility) | Corrected 2026-09-12: the daemon-first gap is narrower than "no replacement". Tokens and context percent are derived from the transcript by `passive-observer` and already reach the wire and the deck on both tiers; `/usage` quota has first-class daemon clients. Terminal-only: turn **duration** (one feed, the status-line parse) and the status-line text itself. Lifecycle correctness still comes from hooks/events, never terminal scraping. Measured in [managed-replacement-inventory.md](managed-replacement-inventory.md) §2.3; tracked in #273 |

## Hardware

| Device / operation | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| Ulanzi D200H | Yes | Yes | Ulanzi Studio plugin is the only driver; no direct HID |
| Ulanzi D200X LCD keys | Partial | Partial | Same 14-key Ulanzi Studio action as D200H; SDK/simulator contract is covered, but real-hardware verification is pending and the three encoders are not supported |
| Pixoo64 | Yes | Yes | Native LAN HTTP |
| Timebox Mini | Yes | Yes | Expressive robot face with gaze, listening nods, speaking mouth shapes, greeting winks and token-based eye highlights / warm cheeks; shared Node/Swift state rules and generated animation frames; native CoreBluetooth / CLI BLE helper |
| iDotMatrix | Yes | Yes | Permanent creature with live WORK/JOBS/WAIT counts, separate CI/child-agent states, bounded 6 s conversation/arrival scenes and explicit partial totals; shared Node/Swift frames; one BLE display connection at a time |
| ESP32 state display and Wi-Fi provisioning | Yes | Yes | Native serial and network frameworks. Wi-Fi credentials go to whichever daemon holds the port through loopback `POST /esp32/wifi` (pairing token required), and that daemon saves them and writes them to its serial boards; the macOS sheet never opens a serial port. `agentdeck wifi-setup` uses the same route |
| ESP32 serial firmware flash | No | Yes | `agentdeck esp32 flash` bundles esptool-js and drives the port through the optional native `serialport` module — no user-installed `esptool.py`. Also available with no install at all from the browser flasher (Chrome/Edge desktop, Web Serial). **The App Store target is unchanged and stays No**: the sandbox is not the obstacle (`com.apple.security.device.serial` is already granted and the app already does raw POSIX serial writes) — the no-subprocess contract is, and clearing it would mean reimplementing the ESP32 ROM loader in Swift. Not planned. |
| ESP32 Wi-Fi OTA push | Yes | Yes | Firmware bytes pushed over existing WS; firmware build remains CLI-only |
| Ulanzi TC001 | Pending | Yes | Swift `led8x32` hardware verification gap, not sandbox restriction |
| TRMNL 7.5" | Experimental | Experimental | Registration exists; physical render/refresh release validation incomplete |
| XTeink X3 / X4 | Yes | Yes | Independent Pocket Daily Reader firmware; registers with both daemons over Wi-Fi and retains its own product identity/releases (SD-card flash distribution) |
| Android e-ink / tablet presence | Partial | Yes | Same-LAN self-registration is safe; ADB preview/tunnel requires CLI |

## Agent sessions

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| OpenCode observer file setup | Yes, macOS; explicit folder consent | Yes | Native picker grants an existing OpenCode plugins directory. The app installs/updates/removes only its owned observer and receiver sidecar, preserves other files and refuses modified/symlinked files. Bundled source is generated from the canonical hooks template; OpenCode executes it, the app never does. Native installation is observation-only, uses the ready local receiver port, and adds no subprocess, interpreter or companion-install prompt. Settings distinguish a saved installation from received events. |
| Hermes receiver settings | Yes, macOS | Explicit `--port` | Opt-in folder picker for an already-installed observer, security-scoped bookmark, local ready-port synchronization across restart/handover, and retry/stop-sync controls. Writes only `connection.json`; preserves other JSON fields and refuses invalid/unowned folders. No observer installation, enablement, execution, or port scanning. Saved configuration is not evidence of event receipt. Stop syncing revokes folder access and leaves the last explicit receiver selection intact. |
| Hermes observer monitoring (preview) | Yes, with explicit receiver selection | Yes | Both daemons ingest `hermes_*` hooks and advertise `hermesObserver: 1`. The externally installed observer uses its profile-local `connection.json` loopback port when selected with `agentdeck hermes-observer --port`; this supports the sandboxed Swift receiver without reading its container or keeping a Node daemon running. Otherwise discovery uses the Node registry, which the App Store daemon does not write. macOS Settings can retain a user-selected existing observer folder and atomically update its connection file when the local receiver becomes ready on a new port. Only the bound/attached local port is written, never a preferred port before startup; invalid explicit selection never falls back. Installation and Hermes enablement remain outside the app. Rows are observation-only, with no approvals, prompt injection or voice target. Direct delivery, opt-out, invalid selection and port reconfiguration were exercised against signed Store 1.9.2 / 9401 on 2026-10-29; this is not current-source release acceptance. See [the receipt](hermes-agent.md#direct-store-swift-receiver-acceptance-2026-10-29). |
| Claude Code hook monitoring | Yes | Yes | Local HTTP hook ingestion |
| Codex lifecycle/notify/OTel monitoring | Yes | Yes | Opt-in managed config |
| Existing terminal-session discovery | Limited | Yes | Broad process/TTY discovery remains CLI-owned. Swift already uses native `sysctl` process evidence and user-granted transcript readers for specific integrations; native process enumeration itself is not Node-only |
| Display-only permission attention | Yes | Yes | Real signals only, per agent: Claude `PermissionRequest` (immediate, display-only) with `Notification` (`permission_prompt`, about six seconds later) as the fallback, Codex `PermissionRequest` (fires only when Codex is about to ask; `Interrupt` closes the turn; answerable only with the opt-in hold below), OpenCode `permission.asked` (answerable requestId in both tiers), OpenClaw `exec.approval.requested`. Kiro/Antigravity have no permission source and never show PERM. No fabricated options |
| Observed Claude PreToolUse hold (device Allow/Deny) | Yes, when `~/.claude` is readable | Yes | The one predicted PERM: held only when the generated `ClaudePermissionRules` predictor (shared SSOT, vector-pinned) says Claude would genuinely prompt — mode gate, allow/deny/ask rules in the documented wildcard grammar, built-in read-only set, `acceptEdits` filesystem commands. Sandboxed builds that cannot list `~/.claude` hold nothing |
| Codex device approvals (opt-in `PermissionRequest` hold) | Yes | Yes | Off by default. Turned on from the Codex block under Settings → Integrations, or `agentdeck daemon install --codex-approvals`; both installers add one second handler to AgentDeck's own `PermissionRequest` group, and Codex shows its hook review once. Nothing is predicted — the hook fires only when Codex is about to ask — so Tier 1 needs no folder access beyond the existing config grant. Held only with a connected device, a visible session and no other hold on it, for at most the observed-approval hold (25 s); the end of the turn releases it. While held, the terminal shows "Running hook" instead of the prompt; an undecided release prints nothing and Codex's own prompt appears. Pure HTTP hold, no subprocess. A decision taking effect in real Codex awaits a user-trusted handler run |
| Session order pinning (`--weight` sort override) | Yes | Yes | Observed sessions are pinned daemon-first: BOTH daemons persist weight pins (`session-order.json`, `agentdeck order`, `POST /sessions/order`) and overlay them on observed rows before fold+sort, riding the existing `SessionInfo.weight` wire field. Cross-daemon single-sourced TTL/cap (`pnpm generate-session-weight-rules`). The managed launcher's launch-time `--weight` remains the compatibility path; the real-user tab-to-deck scenario was validated on 2026-09-19 (#273) |
| Daemon relay (worker daemon publishes observed sessions to a hub daemon) | No | Yes (experimental) | Daemon-first counterpart of managed `--remote-daemon` attach (#273, Discussion #278), additive to it. Opt-in per worker via `agentdeck relay set <host[:port]>` (`relay.json`, 0600, read at daemon start). The worker dials out; the hub steers back down the same socket and never dials a worker. Only observed rows are relayed, and the worker accepts only observed steering (approve/deny, AskUserQuestion answer, turn-end prompt, soft stop, platform terminal injection) for sessions it is relaying. The hub must be a Node CLI daemon advertising `daemonRelay`; the Swift daemon neither hosts nor publishes a relay, so nothing here is reachable in the App Store build. |
| Adaptive high-volume menu bar overview | Yes | Yes | The popup keeps a bounded height at every session/device count: actionable sessions stay visible, idle sessions and repeated surface families collapse into counted summaries, and Activity shows completed work from a named recent window instead of unbounded duration totals. The Dashboard retains the complete roster, topology, and report. This is presentation-only and uses the same daemon state in both tiers |
| Dashboard inspection selection | Yes | Yes | Creature and session-list inspection is local to each dashboard. It filters that screen’s timeline and highlights its creature without changing daemon control focus or another device. Explicit hardware/control commands retain their target. Folded Codex rows include only their declared member session IDs. |
| Adaptive high-volume Dashboard session panel | Yes | Yes | The left HUD reserves the Timeline region, widens within a fixed landscape cap, switches to compact rows for larger rosters, and scrolls the complete session collection inside its own bounded card instead of painting over Timeline. Adjacent setup guidance shifts beside the roster rather than covering it. Presentation-only; focus and session data remain identical in both tiers |
| Guided first use and setup recovery | Yes | No app UI | macOS offers appearance, agent consent, and optional device setup; iOS offers appearance, host discovery/pairing and offline previews. Settings can reopen setup without resetting saved preferences. iOS guidance and connection choices share one scroll surface above persistent navigation, and the QR scanner refreshes authorization after returning from Settings. Completing orientation is not evidence of a connected host or live session. |
| Form-factor-readable Dashboard HUD | Yes | Yes | iPhone/compact-phone portrait presents one full-width readable HUD rail at a time with an explicit Sessions/System switch; phone landscape, iPad/tablet, and macOS retain the dual-rail terrarium composition with bounded Timeline-safe heights. Android e-ink keeps its static high-contrast, no-scroll projection while typography and spacing scale by reader size. Presentation-only; all tiers consume the same session, topology, and timeline state |
| Managed terminal UI steering | No | Yes (compatibility) | The legacy compatibility observer reads only real mode/diff/option UI and injects keys; lifecycle state, timeline, and APME remain hook/event-owned. Direct-launch steering uses ask-gates/injection and is not fully equivalent. Tracked in #273 |
| Observed AskUserQuestion — device answer (ask-gate) | Yes | Yes | The daemon holds the question's PreToolUse hook open and resolves it with the option the user picked, stated as the decision reason. Pure HTTP hold, no subprocess, so it works sandboxed. Engaged only when injection is unavailable (always so in Tier 1); an unanswered hold releases empty, and Claude's own picker appears in the terminal as usual. Multi-question calls are answered one question at a time |
| Observed-session answer injection (device tap → host UI) | No | Yes | tmux / iTerm2 / Terminal.app by tty, cmux by the surface the agent process was started in (read from its environment), GUI apps by AX button or key events. Needs `ps` tty discovery + tmux/cmux/osascript subprocesses — all CLI-only; sandbox has none of them. Preferred over the ask-gate when available: it answers the live picker with no added latency for whoever is at that terminal |
| OpenCode monitoring | Opt-in read-only | Yes | Tier 1 discovers a configured URL, the fixed default port, or an explicit `opencode --port N` visible through native process arguments; no port scan. A bare TUI's random port remains undiscoverable. Both tiers build per-session rows from an already installed observer plugin's `opencode_*` hooks (turn state, running tool, permission, display-only questions); Tier 1 does not install this plugin. Hooks take ownership over optional SSE, so SSE disconnect/keepalive cannot erase or prolong their approvals; the CLI's process scan adds PID rows only for sessions no hook has claimed |
| Antigravity session monitoring | No | Yes | Tier 1 may display user-approved usage data only |
| Kiro CLI / IDE session monitoring | Yes, after granting `~/.kiro` | Yes | Both tiers read Kiro's own store, because Kiro reports nothing on its own: its standalone lifecycle hooks load but CLI chat fires none of them (measured 2026-08-17, kiro-cli 2.18.1 — each hook instrumented with a marker, a live turn produced zero markers while a hand-POSTed hook produced a row normally). The App Store build reaches `~/.kiro` only through a **user-granted security-scoped bookmark** (Settings → Integrations → Kiro CLI), the same shape as `~/.codex`; with no grant it observes nothing rather than guessing. Both flat legacy JSONL and nested v3 `session.json` + `messages.jsonl` stores supply chat rows. Explicit v3 turn boundaries supply processing/idle; Swift legacy records without those boundaries remain idle. Node also retains its v2 SQLite observer, which Swift does not implement. Process discovery stays CLI-only; the App Store path keys on the transcript instead |
| Subagent activity summaries + parent-linked orbit visuals | Yes | Yes | Read-only lifecycle hooks collapse each child to concise start/completion rows using existing Timeline types. Terrarium surfaces may derive non-interactive wire/ring/satellite accents around the owning parent; they never become selectable sessions. No subagent commands, approvals, team configuration, or process discovery |
| Background task creature accents | Yes | Yes | Device expansion: compact serial frames preserve explicit background counts for firmware; matrix panels expose background work separately from child agents, and quota labels distinguish window length from reset countdowns.  Claude hook snapshots carry a separate background-task count. Apple 2D/3D dashboards show the tasks as jar buddies for any creature kind whose session reports a count: up to three small clay jars with fins and a face orbit their creature like moons on one gently tilted ring at a constant speed, passing in front of it and behind it; tasks beyond the three jars ride the same orbit as tiny pearl moonlets strung through the gaps between the jars (warm sand-and-coral beads, one per task, up to nine; hidden on canvases too small to read them), and a task-count label sized with its creature carries the exact count, clear of the name tag and the sand; while a task runs its lid jiggles and bubbles rise from its mouth, and a finished task pops its lid, sparkles and shrinks away where it was. Only an explicitly lower count (including the idle zero when the last task ends) plays a finish, the last pearl first with a small sparkle and jars only once no pearl remains; an unknown count retains the buddies, approval attention hides them without finishing, and Reduce Motion parks the buddies still on the near side with no finish animation. The count comes from one agent-agnostic tracker (`shared/src/background-work.ts`, generated Swift mirror): Claude hook snapshots, Codex background terminals read from the rollout (Tier 1 through the `~/.codex` folder grant), OpenCode background subagents and Hermes background processes reported by their observer plugins. Kiro, Antigravity and OpenClaw expose no background-work signal and produce none. Tasks never become child-agent census entries or selectable residents. |
| Managed launch argument profiles (`AGENTDECK_COMMANDER_ARGS`, `AGENTDECK_*_ARGS`, `-c`) | No | Yes (compatibility) | The managed launcher composes persistent and one-off arguments, including resume commands, with platform-specific quoting and override rules. For local launches, `agentdeck run` composes the same arguments without a PTY (#386). The managed launcher remains the path for launches that need managed flags, and is kept long-term (#273) |
| Launch Claude / Codex / OpenCode session | No | Yes (compatibility) | `agentdeck <agent>` is a long-term compatibility path with no removal planned (#273). The supported default for ordinary local sessions is `agentdeck daemon install`, then a normal agent command |
| Dot direct HTTPS MCP (earlier experiment) | Excluded from Store builds; available in DotPreview only | Integrated daemon + operator CLI | Reported Dot–agent relationships with provenance and unverified-target labels implemented. A sanitized Dot deck snapshot supports read-only fixed first-key display on Stream Deck/Ulanzi; no synthetic session or key-triggered command. Native 2D/3D companions share a state resolver; app presence is separate. Dedicated TLS listener, local OAuth consent, bounded shared context and inert reports. No relay service, helper process, global Dot status or remote approval. The [current distribution decision](dot-distribution-decision.md) supersedes public-domain/certificate onboarding. Real Dot acceptance remains unverified; public reachability is a gate only for this earlier transport. |
| Dot local MCP pairing (private preview) | Excluded from Store builds. DotPreview: native loopback listener, public OAuth clients + PKCE (pre-registered, bounded loopback registration, or a client metadata document fetched over HTTPS from `chatgpt.com` only), native consent naming the client and Keychain storage; no helper process | Equivalent loopback host and operator approval; `dot init-local` refuses to overwrite configuration | Local requests work without Events; the loopback host neither advertises nor grants Events subscription to registered or metadata clients. A stock client needs no configured client ID (Codex CLI 0.160.1 measured); registration never grants access. The [release plan](dot-store-release-plan.md) tests documented desktop Add server + OAuth separately from public local-plugin distribution. The Add server GUI itself, actual Dot local-executor tool access and signed Swift-only acceptance remain gates. No public server or certificate is needed for the local endpoint. |
| Dot private MCP through official tunnel (experiment) | Excluded from Store builds. No bundled tunnel client or companion-install prompt; app-only transport not verified | Operator-managed official client, own runtime key and Node stdio adapter; real Dot request/report and Mac creature transitions verified | Private acceptance is recorded in [the distribution decision](dot-distribution-decision.md#real-account-validation); rendered Pixoo preview is not physical-device acceptance. Not public plugin distribution or default onboarding. Current adapter has no MCP Events subscription surface. Login does not grant tunnel rights; no publisher key is distributed. |
| OpenClaw Gateway WebSocket pairing | Yes | Yes | Local WS, Keychain identity, optional user-selected token file |
| OpenClaw CLI pairing | No | Yes | Requires external `openclaw` process |
| Deck model / thinking picker (OpenClaw) | Yes | Yes | #463. `sessions.list` + `models.list` + `sessions.patch` over the paired Gateway WebSocket; values, labels and defaults are the Gateway's own. No subprocess |
| Deck model · effort · mode readout (Claude / Codex) | Yes | Yes | #463. Claude hook `model` / `effort.level` / `permission_mode`; Codex hook `model` + rollout `turn_context` through the `~/.codex` bookmark. Readout only — neither agent offers a running-session switch. Tier 1 keeps Claude's SessionStart model (no transcript bookmark) |

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

## Swift parity priorities — source assessment 2026-10-29

This assessment compares the source at `ab8a8ada`, not the installed app or a
Store release. Priorities below are proposed implementation order, not release
approval. The capability rows above describe what exists today; the candidates
below do not change a No into a Yes.

**Node is the current external runtime, not a language requirement.** A bounded
HTTP/WebSocket client, SQLite reader, renderer or state machine can often be
implemented natively. Launching an agent, running project commands or driving
external terminal tools still requires an execution environment outside the
current self-contained App Store contract. An HTTP rewrite does not by itself
establish credential authorization, trustworthy source data or sandbox access.

### Already implemented; documentation corrected

- OpenAI-compatible judge effort is parsed by [ApmeSettings](../apple/AgentDeck/Daemon/Apme/ApmeSettings.swift)
  and sent by [ApmeJudgeOpenAI](../apple/AgentDeck/Daemon/Apme/ApmeJudgeOpenAI.swift).
- Hermes can deliver directly to Swift with an explicit receiver port. The
  [observer](../hooks/hermes-agentdeck/__init__.py) implements selection precedence;
  [setup instructions](hermes-agent.md#check-setup-when-hermes-activity-is-missing)
  distinguish installation, enablement and receipt. This removes a continuous
  Node-daemon dependency, not external observer setup or acceptance testing.
- [OpenCodeObserver](../apple/AgentDeck/Daemon/Session/OpenCodeObserver.swift)
  already discovers readable explicit port arguments in addition to configured
  and default endpoints. Broad TTY discovery and random-port scanning are not
  implied by this support.

### Native candidates, ordered by expected value and scope

P1 is the next bounded parity work; P2 requires broader protocol or evidence
work; P3 is low-return or currently not planned. None requires starting an
external process inside the app.

| Priority | Candidate | Why native is plausible | Completion evidence / remaining dependency |
|---|---|---|---|
| P1, local signed acceptance passed | Hermes direct-receiver setup continuity | Native folder consent, persistent bookmark, ready local port synchronization, retry and stop-sync controls; observer enablement stays user-owned | [Setup and limits](hermes-agent.md#keep-the-macos-receiver-selected-across-port-changes). Native regression tests cover ready-port changes and revocation. [Local signed Release acceptance](hermes-agent.md#signed-local-release-setup-acceptance-2026-10-29) passed folder selection, relaunch restoration and automatic port change; a final Store artifact remains a separate release gate. The [9401 receipt](hermes-agent.md#direct-store-swift-receiver-acceptance-2026-10-29) proves direct delivery only |
| P1, implemented and locally validated | OpenCode observer setup through explicit file consent | Scoped native installer with canonical bundled source; OpenCode executes the plugin | [Local acceptance](#opencode-observer-setup-acceptance-2026-10-29) passed install, seeded prior-version update, edited-file refusal, removal, reinstallation and real OpenCode turn receipt. A final Store artifact remains a release gate |
| P2 | Kiro v2 SQLite observation | Swift already supports granted Kiro JSONL stores; native SQLite can replace Node's reader | First establish remaining v2 usage. Read-only bookmark access including WAL, schema fixtures, session/turn identity and unknown-state parity; no fabricated PERM |
| P2 | Daemon relay hub/worker | Existing authenticated HTTP/WS and native session state provide the transport building blocks | Port the [relay contract](../bridge/src/daemon-relay.ts), bounded teardown, reconnect/dedup and per-session authorization. Advertise only steering the Swift worker can execute; remote terminal injection still needs an external worker |
| P2 | Pocket adaptive content and Glance Frame rendering | [Adaptive selection](../bridge/src/pocket-autonomy.ts) is state/data logic; [frame generation](../bridge/src/glance-frame.ts) can use native rendering | Move shared decisions into an SSOT with cross-language vectors; preserve aggregate-only persistence, feed/outbox behavior and geometry. Verify reader output on hardware. Basic portable transport already exists in Swift |
| P2 | CI provider status enrichment | Native authenticated HTTPS can replace the CLI's optional GitHub status query | Define explicit credential custody and repository/run identity; bounded polling, stale/unknown semantics and provider fixtures. Hook intent alone remains unknown CI status |
| P2 research | Antigravity session evidence | A user-granted native transcript reader may replace part of the [passive observer](../bridge/src/passive-observer.ts) | First prove readable source format, account/session identity and trustworthy turn boundaries in the signed sandbox. Process presence or plan data alone is insufficient; full parity is not yet established |
| P3 | TC001 native acceptance | Existing serial/WS path; the current gap is hardware verification | Named firmware/app build, physical display and reconnect/wake checks. This is validation work, not proof of a Node requirement |
| P3, not planned | ESP32 USB ROM flashing | A native ROM loader could use existing serial entitlement | Full chip/image/offset safety and hardware recovery coverage would be required. Keep CLI/browser flasher as the current path; Wi-Fi OTA already works natively |

### Retain an external execution environment

| Capability | Structural boundary under the current Store contract | Swift role |
|---|---|---|
| Managed PTY launcher and agent lifecycle | Runs Claude/Codex/OpenCode and owns subprocesses/PTYs | Observe ordinary sessions and consume external results |
| Terminal/UI answer injection | Current implementation needs TTY discovery and tmux/cmux/osascript or host automation; those paths are outside the sandbox contract | Retain native held-hook approvals, AskUserQuestion answers and supported queued delivery; these are not full terminal control |
| APME Layer 1 lint/build/test execution | Runs arbitrary repository/package-manager commands | Keep native LLM evaluation and task review. Reading an existing result bundle would be a separate partial capability, not execution parity |
| Claude credential recovery | Asks the user's Claude CLI to perform a bounded renewal turn | Consume explicit external status; never rotate Claude refresh tokens or spawn the CLI |
| ADB executable integration | Current USB reverse/discovery/control path invokes `adb`; [Swift module](../apple/AgentDeck/Daemon/Modules/AdbModule.swift) is intentionally disabled | Support same-LAN Android clients. A native ADB implementation would require a separate feasibility/security/product decision, not merely a port of the module |
| OpenClaw CLI pairing | Executes the external OpenClaw command | Use the existing native Gateway WebSocket pairing path |

### Claude quota: source-contract dependency, not a routine native port

Treat a trustworthy supported Claude quota source as **P1 research**, blocked on
the source contract rather than on Swift networking. Direct Swift OAuth remains
disabled; Node's undocumented OAuth path is not an approved migration recipe.
The current status-line payload cannot establish account identity or quota
observation time. A future account gauge needs those guarantees plus restart,
resume, account-switch, expiry and retirement tests and a source-to-display
comparison. A session-scoped last-reported value with explicitly unknown age is
a different product/wire contract and must be reviewed as such. See the
[accuracy reassessment](../RELEASING.md#macos-192-claude-accuracy-reassessment-2026-10-23).

Suggested delivery order: carry the accepted Hermes setup into the release
artifact together with the accepted OpenCode observer setup, then prioritize Kiro legacy
support or Pocket content using actual user/device demand. Relay follows a dedicated transport/control design.
Investigate the Claude source in parallel with this roadmap; do not promise a
native quota release before that evidence exists. Dot remains a separate
DotPreview/distribution track, not a Node-to-Store parity commitment.

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

Dashboard subscription presentation: plan names and reported subscription dates appear once in the owning upstream row. The full reported list remains available in Dashboard settings, including hidden providers.

### Dot character and portable companion (DotPreview only)

The standard macOS and iOS Debug/Release builds exclude all Dot support at build time, including hosting, authentication, settings, renderers, incoming Dot snapshots and the MCP contract resource. The rows below describe the explicit DotPreview development configurations only. Node and other non-Apple surfaces retain their existing support. Cloudflare integration is future work under the same boundary; no hosted service is implemented by this split. See [Apple build configurations](../RELEASING.md#dot-development-and-store-builds).

| Capability | Native DotPreview build | Node daemon | Boundary |
|---|---|---|---|
| Dot connection discovery | Always-visible macOS Settings → Dot and a dashboard setup entry before a configured snapshot. Native-owner setup retains built-in HTTPS/OAuth controls; external-host dashboards show read-only connection context without installation prompts | Operator-managed host configuration | Setup entry is not a connected creature or cloud-activity signal; external-host configuration editing from the Mac app remains unimplemented |
| Manual Dot character image | User-selected static PNG/WebP/JPEG, bounded ImageIO conversion and container persistence | Explicit local CLI import/reset, bounded sharp conversion | No OpenAI avatar API or automatic synchronization; no image URL fetching or executable model import |
| Portable Dot companion | Authenticated normal/compact snapshots with independent status, appearance and latest report relation | Same additive snapshot; portraits stripped from compact transport | Separate from sessions/counts, no execution or approval authority |
| Remote Apple/Android display | Read-only decoded companion; user image becomes a billboard in the Apple 3D scene | Host-authored snapshot | A 2D image does not become a volumetric character; report labels remain visible |

## OpenCode observer setup acceptance 2026-10-29

In macOS Settings → Integrations → OpenCode, choose the existing `plugins`
directory for the OpenCode configuration you use, then choose **Install / Update**.
This works for a global or project plugins directory. OpenCode loads these local
files on startup ([official plugin documentation](https://opencode.ai/docs/plugins/)).
The app writes only `agentdeck.js` and `agentdeck-connection.json`; it never
rewrites `opencode.json`, JSONC comments, package manifests or unrelated plugins.
The system picker grants access to that directory, retained by a security-scoped
bookmark. Source, ownership and filenames come from the canonical hooks template
through `pnpm generate-opencode-observer`; byte drift is tested.

Updates and removal require an exact recognized source or a digest matching the
record of a previous native installation. The exact current CLI template can be
migrated by explicit Install / Update. Other older or modified files require user
review and are refused, including symlinks. CLI setup recognizes native ownership
and preserves it; CLI removal likewise refuses edited native files. **Remove
observer** deletes the verified owned files and revokes access. **Remove folder
access** only revokes access and leaves installed files in place. Loaded native
plugins reread the receiver file on delivery, so removal stops delivery without
silently switching to the Node registry. No downtime replay is added.

The native variant is observation-only: no device command polling, prompt
injection or permission answering. Both daemon consumers suppress actionable
request IDs for its `observer_only` hooks. Activity can be received independently
of the separate, opt-in read-only SSE server monitor. Saved-file messages never
claim the plugin is loaded or events have arrived.

Local acceptance used a Development-signed Sandbox Debug app, a dedicated bundle
ID `bound.serendipity.agent.deck.opencode-setup-audit`, a temporary XDG OpenCode
configuration and a deterministic loopback model. WeatherKit was omitted from
the local signing entitlements. The app's receiver was **63787**; OpenCode 1.18.35
ran separately on loopback **63800**. SSE monitoring stayed off throughout.

- The real system picker selected a plugins folder containing an unrelated user
  plugin; its sibling JSONC configuration contained comments and custom settings.
  Both remained byte-identical through all installer operations.
- Install wrote the canonical observer and its owned receiver. An actual OpenCode
  turn completed with `OPENCODE_SWIFT_OBSERVER_OK`, observed by Swift as
  `idle → processing → idle`.
- A seeded previous-owned-version fixture was updated to exact bundled bytes;
  unknown receiver keys were retained. Adding a user edit then caused both update
  and removal to refuse, retaining the edit and all other files.
- Removing the verified installation deleted only its two owned files. A new
  turn on the still-running OpenCode server completed normally but produced no
  new Swift session/event. Reinstallation restored actual turn delivery, and the
  final UI reported Connected from received activity while SSE remained off.
- CLI setup against that native installation returned managed-by-macOS without
  changing the plugin hash. A separate synthetic permission hook through Swift's
  real HTTP route retained attention without an answerable request ID.

The first finite `opencode run` trial received prompt activity but exited before
its final Stop was captured. It is not counted as a successful completed-turn
receipt; the 2026-10-29 completion evidence uses a persistent OpenCode server.
The finite-run correction and its separate acceptance are recorded below.
No production OpenCode configuration or installed AgentDeck app was replaced.
Test-only servers and the signed app were stopped after acceptance.

Evidence is local and gitignored: `diagnostics/opencode-swift-setup-20261029/`,
including wire captures, CLI logs, file hashes, edit-refusal/coexistence receipts,
signature metadata and `results.json`. This proves local development behavior;
it is not a Store upload or final distribution-artifact acceptance.

### Finite OpenCode shutdown acceptance 2026-10-30

OpenCode 1.18.35 invokes plugin `event` callbacks without awaiting their promises,
but awaits plugin `dispose` during instance cleanup
([upstream implementation](https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/plugin/index.ts)).
Tracing confirmed that `session.idle` reached the old observer and started
`opencode_stop`, while its receiver lookup/health probe was still pending at
shutdown. With a 100 ms health response delay (inside the existing 300 ms limit),
the old observer delivered start/prompt but lost Stop; the updated observer
delivered all three under the same conditions. This is an exit race, not a
missing OpenCode idle event or a Swift state timeout.

Observer v7 keeps event handling and HTTP delivery nonblocking during a turn.
Its `dispose` hook closes event admission, cancels pending prompt timers, waits
for admitted handlers and then their POSTs, with a 3 s total deadline. Existing
filesystem/HTTP deadlines remain. Both the CLI template and Swift's generated
bundle use the same correction. Tests cover delayed parent lookup, health and
Stop response, late event admission, and a peer that never settles.

The Development-signed Sandbox app installed the exact generated observer through
Settings, with SSE monitoring off and its Swift receiver on port **63787**.
Three independent, unattached `opencode run --format json --model fixture/fixture`
processes each exited **0**, returned `OPENCODE_SWIFT_OBSERVER_OK`, and produced
`idle → processing → idle` plus one matching `chat_response` in Swift's actual
WebSocket stream. The Dashboard showed IDLE and successful response entries;
Integrations showed Connected. These were finite processes, with no persistent
OpenCode server. The sibling JSONC file and unrelated plugin stayed byte-identical.

The isolated CLI harness also sets `PWD` to its subprocess working directory:
OpenCode resolves request directories from `PWD`, while its initial instance
uses `process.cwd()`. Leaving the inherited repository `PWD` created a second
instance whose observer was not the one being disposed; that probe was excluded
from the corrected before/after comparison. No upstream lifecycle change is
claimed for that separate condition.

Local evidence remains in the same gitignored diagnostics directory:
`exit-baseline-delayed-cli.log`, `exit-fixed-delayed-cli.log`,
`exit-swift-final-{1,2,3}-{cli.log,wire.json}` and `exit-results.json`. This validates
normal cleanup on OpenCode 1.18.35, not delivery after forced process termination
or to an unavailable receiver. It remains local Development-signature evidence,
not Store distribution acceptance.
