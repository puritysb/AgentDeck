---
id: policy.product-tiers
title: App Store and CLI Product Tiers
description: Canonical capability boundary between the standalone App Store app and the external CLI daemon.
category: Engineering
locale: en
canonical: true
status: required
owner: Apple product maintainers
reviewed: 2026-10-31
revision: 2026-10-31
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
| CI wait observation (#433) | Hook evidence; optional native GitHub HTTPS status | Hook evidence; optional GitHub status | Both daemons track explicitly identified CI watch tools independently of agent turn state, clear matching foreground tools and session boundaries, and emit explicit null on close. Background watches survive Stop. Hook intent has unknown CI phase until provider evidence arrives; it never proves success or failure. Native access requires explicit consent and a repository allow-list; its optional fine-grained PAT stays in app-owned Keychain. Stale/unavailable evidence clears the verdict. The App Store app never spawns `gh`. No credentials or raw command reach the wire. |
| Guided first use | Yes | — | Choose an available 2D/3D appearance, explicitly enable Claude/Codex observation through the existing consent flow, and enter with observed/ready/not-set-up status. Hardware discovery is optional, with an existing Stream Deck path and offline Device Preview. iOS offers appearance then bounded Mac discovery/QR pairing. Setup can be reopened; notifications are requested only on an explicit action. |
| Hermes mermaid aquarium resident | Yes | Yes | Bundled Blender-authored Nous girl-inspired mermaid; observed Hermes sessions drive working/waiting poses. A fixed shell seat for idle rest, bounded lift-off for active work, skinned body/tail/fin and arm joints, independently controlled gaze/lids/brows/mouth, and cosmetic neighbour greetings; no inferred delegation or new controls. Both daemons ingest Hermes observer events. Explicit receiver selection supports direct Swift delivery; observer installation and enablement remain external setup (see Agent sessions). Reduced Motion freezes movement. |
| Optional native 3D aquarium | Yes | Yes | Device-local dashboard type; bundled Blender-authored habitat and canonical extruded agent meshes. RealityKit live session reconciliation, status labels and existing focus commands; standard dashboard retained. No runtime Blender or external model download. |
| Multi-daemon companion pairing (#493) | Yes | Compatible host | Explicit host selection, endpoint-scoped credential retention, and host-specific approval recovery. Discovery carries no credentials; approval remains operator-controlled. |
| macOS dashboard and in-process daemon | Yes | — | Standalone Tier 1 product |
| macOS attention shortcuts and notification navigation | Yes | Compatible host | Native Shortcuts list live sessions awaiting a response and open a specific session in the Dashboard. Notification clicks use the same endpoint-scoped, local inspection route. Roster freshness is tracked separately from usage and timeline traffic; unavailable state is never reported as an empty queue. Opening a session does not answer a prompt, launch a session, or change hardware control focus. Cold-start waits are bounded. No new entitlement, helper or extension is required. |
| Experimental macOS collaboration lens | Yes | Yes | Opt-in Dashboard right rail with an expandable graph of all roster sessions and observed message links. Habitat shows these relationships as quiet cyan currents between visible creatures in both 2D and 3D; recent messages carry directional bubbles, reduced motion keeps them still. Selection filters currents to that creature. Both daemons expose bounded, authenticated relation-only history, without tool payloads or subprocesses. Only an explicit reply request in the complete observed message starts a timer; notifications, replies and unknown/legacy intent never start one. Notifications cannot settle an outstanding request. An explicitly worded reply can settle a single outstanding request; multiple requests or crossed messages remain unconfirmed because Claude supplies no reply correlation. Both directions retain their own waits independently of the latest message arrow. Unknown peers, absent sessions, stale reads and truncated history remain explicit. Graph selection uses dashboard inspection without changing agent control. Selected-session task history, subagent census and existing controls remain available. |
| Cross-session coordination evidence (`RelationEvent` + `SessionInfo.coordination`) | Yes, evidence-bounded | Yes | Work divided WITHOUT a SubagentStart: `claude -p` workers spawned from a background Bash (`spawned`, process ancestry), peer messages over SendMessage (`messaged`, the sender's tool input and the receiver's `<cross-session-message>` envelope), and background jobs a session is waiting on (`waiting_on`, argv names its scratchpad). Both tiers produce all three plus the live `coordination` census on `sessions_list` (`bridge/src/coordination-evidence.ts`; Swift `CoordinationTracker` is a transliteration, both replay `shared/coordination-evidence-vectors.json`). The session→process link is the hook header `X-AgentDeck-Pid: $PPID` on both tiers; Tier 2 additionally reads `~/.claude/sessions/<pid>.json`. The process table is `sysctl` on Tier 1 (`ProcessEnumerator.processTable`, no entitlement, no subprocess) and `ps` on Tier 2. IPS10 cards receive `coordination {backgroundJobs, spawnedActive}` and a bounded rotating roster (`stableCardRoster`, up to three attention sessions pinned, remaining sessions rotate every 60 seconds, id order within each page, `total` and `rosterRotating` metadata) from either daemon. Observed only — never inferred from shared project membership. A `TaskCompleted` checklist item is an `info` annotation on both tiers, never a child agent. |
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
| Surface Protocol portable Feed negotiation | Yes | Yes | Both tiers validate the eight-field identity and implement conditional Feed, Outbox replay, pull telemetry, product-scoped persistent OTA staging, bounded resume/206, and install acknowledgement. Tier 1 stores staged bytes inside its App Container and enforces negotiated WS event/command boundaries natively. Adaptive Pocket content and Glance Frame pixels are native in both daemons. Neither grants Inbox. No subprocess or companion-install prompt is involved. |
| Pocket adaptive PULSE / NUDGE / QUEST content | Yes, macOS; companion-device integration separate | Yes | Native selection and aggregate learning reuse Feed/Outbox. Shared policy and cross-daemon vectors cover selection, opaque fingerprints, first-answer-wins feedback, ignored exposures and persistence; no personal card copy is persisted. Signed-app HTTP/relaunch acceptance passed; X4 physical round-trip was explicitly deferred to future companion-app integration after its firmware direction changed. Glance rendering has its own acceptance below; Node ICS calendar ingestion stays separate. See [acceptance](#native-pocket-content-acceptance-2026-10-30). |
| Glance Frame pixel rendering | Yes, macOS; physical-device integration separate | Yes | Exact 1bpp parity uses a common, pinned resvg engine and bundled fonts. Signed Release-app HTTP acceptance covers binary/PNG, conditional responses, Surface identity, authentication and content changes. X4 physical verification is deferred to companion-app integration. See [acceptance](#native-glance-frame-acceptance-2026-10-30). |
| Surface Protocol licensed learning-pack delivery | Yes | Yes | Both daemons advertise a bundled, integrity-checked offline learning pack in full and unchanged portable Feed responses and serve it through authenticated `GET /learning/pack`. Delivery is gated by `learning.pack.read` / `learning.pack.update`, the registered Pocket Daily product identity, exact pack id/version, and the pack's SPDX licence metadata. The App Store path reads a signed bundle resource only; it launches no process and accesses no external path. |
| Surface Protocol automatic font-pack delivery | Yes | Yes | Both daemons advertise the bundled OFL PocketSansWorld pack in full and unchanged portable Feed responses and serve it through authenticated `GET /fonts/pack`. Delivery is gated by `font.pack.read` / `font.pack.update`, exact Pocket Daily identity and id/version, plus size, MD5, SHA-256, cpfont-format, source-ledger, and licence validation. The App Store path reads signed bundle resources only. |
| App Store Connect engagement reports | Yes | — | Maintainer tooling creates ONGOING reports plus an optional ONE_TIME_SNAPSHOT for existing history, then downloads Apple's opt-in, privacy-thresholded aggregate analytics through the App Store Connect API. Creating requests requires Admin access; existing reports can be downloaded with Admin, Finance, or Sales and Reports access. No analytics SDK, device identifier, event upload, or AgentDeck-operated analytics backend is added to the app. |

## Ordinary-session setup and evidence

| Agent / path | Initial setup | Reliable evidence and limits |
|---|---|---|
| Claude Code local | CLI daemon setup, or app file consent | Hook lifecycle; permission and held-decision paths remain distinct. |
| Codex CLI / local Desktop | CLI setup, or app config/folder consent; Codex hook trust remains user-owned | New SessionStart is idle; prompt/tool events prove work. Written TOML alone does not prove trust or event delivery. Existing hooks=false is preserved. Later Codex settings inside the managed fence are retained; an extended features table becomes user-owned, including its hooks flag. |
| OpenCode ordinary TUI / finite run | App folder consent + Install / Update, or CLI observer setup | Native setup preserves existing configuration and unrelated plugins. Hooks work without a persistent OpenCode server or Node daemon; native installation is observation-only. OpenCode 1.18.35 finite-run completion was verified through Swift to idle and response history. Permission and question IDs remain separate; questions are answered in OpenCode. See [setup acceptance](#opencode-observer-setup-acceptance-2026-10-29) and [finite shutdown acceptance](#finite-opencode-shutdown-acceptance-2026-10-30). |
| Hermes ordinary CLI | Already-installed/enabled Hermes observer + app folder consent | App retains the receiver folder and follows the ready local port. One long-lived Hermes process delivered completed turns after app relaunch and listener-port change, without Hermes restart or manual receiver updates. No downtime replay; observer installation/enablement remains external. See [continuity acceptance](hermes-agent.md#long-lived-hermes-process-acceptance-2026-10-29). |
| OpenCode optional SSE server monitor | Enable monitoring and provide a reachable server | Discovery uses the configured URL, default port or a readable explicit `--port N` argument. SSE is read-only. A bare TUI's random port is not automatically discoverable. Pending requests are seeded per directory after SSE attaches; connection loss is not completion. Reconnect prioritizes remembered event directories, then the latest 200 global session records, with a cap of 32 directories plus the server default and four concurrent directory reads. Older/unavailable global inventory falls back to remembered locations and the default. |
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
| Pixoo64 | Yes, single-frame and Tide | Yes, also baked aquarium loop | Native LAN HTTP and multi-frame Tide upload already exist; `animation: "loop"` still falls back to single-frame in Swift. Baked aquarium frame generation remains a native-port candidate. |
| Timebox Mini | Yes | Yes | Expressive robot face with gaze, listening nods, speaking mouth shapes, greeting winks and token-based eye highlights / warm cheeks; shared Node/Swift state rules and generated animation frames; native CoreBluetooth / CLI BLE helper |
| iDotMatrix | Yes | Yes | Permanent creature with live WORK/JOBS/WAIT counts, separate CI/child-agent states, bounded 6 s conversation/arrival scenes and explicit partial totals; shared Node/Swift frames; one BLE display connection at a time |
| ESP32 state display and Wi-Fi provisioning | Yes | Yes | Native serial and network frameworks. Wi-Fi credentials go to whichever daemon holds the port through loopback `POST /esp32/wifi` (pairing token required), and that daemon saves them and writes them to its serial boards; the macOS sheet never opens a serial port. `agentdeck wifi-setup` uses the same route |
| ESP32 serial firmware flash | No | Yes | `agentdeck esp32 flash` bundles esptool-js and drives the port through the optional native `serialport` module — no user-installed `esptool.py`. Also available with no install at all from the browser flasher (Chrome/Edge desktop, Web Serial). **The App Store target is unchanged and stays No**: the sandbox is not the obstacle (`com.apple.security.device.serial` is already granted and the app already does raw POSIX serial writes) — the no-subprocess contract is, and clearing it would mean reimplementing the ESP32 ROM loader in Swift. Not planned. |
| ESP32 Wi-Fi OTA push | Yes | Yes | Firmware bytes pushed over existing WS; firmware build remains CLI-only |
| Ulanzi TC001 | Pending | Yes | Swift `led8x32` hardware verification gap, not sandbox restriction |
| TRMNL 7.5" | Experimental | Experimental | Registration exists; physical render/refresh release validation incomplete |
| XTeink X3 / X4 | Feed/Outbox and Glance software support; device integration deferred | Feed/Outbox and Glance software support; device integration deferred | The current X4 firmware direction changed. Physical feed/feedback and pixel acceptance belong to future companion-app integration; previous independent Pocket firmware transport is not evidence of current-device compatibility. |
| Android e-ink / tablet presence | Partial | Yes | Same-LAN self-registration is safe; ADB preview/tunnel requires CLI |

## Agent sessions

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| OpenCode observer file setup | Yes, macOS; explicit folder consent | Yes | Native picker grants an existing OpenCode plugins directory. The app installs/updates/removes only its owned observer and receiver sidecar, preserves other files and refuses modified/symlinked files. Bundled source is generated from the canonical hooks template; OpenCode executes it, the app never does. Native installation is observation-only, uses the ready local receiver port, and adds no subprocess, interpreter or companion-install prompt. Settings distinguish a saved installation from received events. Local signed-app acceptance passed install/update/remove, user-file preservation and real event receipt; observer v7 also drained finite CLI shutdown to Swift idle/response in three real runs. See [acceptance](#opencode-observer-setup-acceptance-2026-10-29) and [shutdown correction](#finite-opencode-shutdown-acceptance-2026-10-30). |
| Hermes receiver settings | Yes, macOS | Explicit `--port` | Opt-in folder picker for an already-installed observer, security-scoped bookmark, local ready-port synchronization across restart/handover, and retry/stop-sync controls. Writes only `connection.json`; preserves other JSON fields and refuses invalid/unowned folders. No observer installation, enablement, execution, or port scanning. Saved configuration is not evidence of event receipt. Folder selection, bookmark restoration on relaunch and automatic receiver updates were validated in a signed app; the same long-lived Hermes process completed turns after both relaunch and port change. See [continuity acceptance](hermes-agent.md#long-lived-hermes-process-acceptance-2026-10-29). Stop syncing revokes folder access and leaves the last explicit receiver selection intact. |
| Hermes observer monitoring (preview) | Yes, with explicit receiver selection | Yes | Both daemons ingest `hermes_*` hooks and advertise `hermesObserver: 1`. The externally installed observer uses its profile-local `connection.json` loopback port when selected with `agentdeck hermes-observer --port`; this supports the sandboxed Swift receiver without reading its container or keeping a Node daemon running. Otherwise discovery uses the Node registry, which the App Store daemon does not write. macOS Settings can retain a user-selected existing observer folder and atomically update its connection file when the local receiver becomes ready on a new port. Only the bound/attached local port is written, never a preferred port before startup; invalid explicit selection never falls back. Installation and Hermes enablement remain outside the app. Rows are observation-only, with no approvals, prompt injection or voice target. Direct delivery, opt-out, invalid selection and port reconfiguration were exercised against signed Store 1.9.2 / 9401 on 2026-10-29; this is not current-source release acceptance. See [the receipt](hermes-agent.md#direct-store-swift-receiver-acceptance-2026-10-29). |
| Claude Code hook monitoring | Yes | Yes | Local HTTP hook ingestion |
| Codex lifecycle/notify/OTel monitoring | Yes | Yes | Opt-in managed config |
| Existing terminal-session discovery | Limited | Yes | Broad process/TTY discovery remains CLI-owned. Swift already uses native `sysctl` process evidence and user-granted transcript readers for specific integrations; native process enumeration itself is not Node-only |
| Display-only permission attention | Yes | Yes | Real signals only, per agent: Claude `PermissionRequest` (immediate, display-only) with `Notification` (`permission_prompt`, about six seconds later) as the fallback, Codex `PermissionRequest` (fires only when Codex is about to ask; `Interrupt` closes the turn; answerable only with the opt-in hold below), OpenCode `permission.asked` (native file-installed observer is display-only; actionable IDs require an answer-capable integration), OpenClaw `exec.approval.requested`. Kiro/Antigravity have no permission source and never show PERM. No fabricated options |
| Observed Claude PreToolUse hold (device Allow/Deny) | Yes, when `~/.claude` is readable | Yes | The one predicted PERM: held only when the generated `ClaudePermissionRules` predictor (shared SSOT, vector-pinned) says Claude would genuinely prompt — mode gate, allow/deny/ask rules in the documented wildcard grammar, built-in read-only set, `acceptEdits` filesystem commands. Sandboxed builds that cannot list `~/.claude` hold nothing |
| Codex device approvals (opt-in `PermissionRequest` hold) | Yes | Yes | Off by default. Turned on from the Codex block under Settings → Integrations, or `agentdeck daemon install --codex-approvals`; both installers add one second handler to AgentDeck's own `PermissionRequest` group, and Codex shows its hook review once. Nothing is predicted — the hook fires only when Codex is about to ask — so Tier 1 needs no folder access beyond the existing config grant. Held only with a connected device, a visible session and no other hold on it, for at most the observed-approval hold (25 s); the end of the turn releases it. While held, the terminal shows "Running hook" instead of the prompt; an undecided release prints nothing and Codex's own prompt appears. Pure HTTP hold, no subprocess. A decision taking effect in real Codex awaits a user-trusted handler run |
| Session order pinning (`--weight` sort override) | Yes | Yes | Observed sessions are pinned daemon-first: BOTH daemons persist weight pins (`session-order.json`, `agentdeck order`, `POST /sessions/order`) and overlay them on observed rows before fold+sort, riding the existing `SessionInfo.weight` wire field. Cross-daemon single-sourced TTL/cap (`pnpm generate-session-weight-rules`). The managed launcher's launch-time `--weight` remains the compatibility path; the real-user tab-to-deck scenario was validated on 2026-09-19 (#273) |
| Daemon relay (worker daemon publishes observed sessions to a hub daemon) | Native hub and opt-in worker (experimental) | Yes (experimental) | [Mixed v1 contract](#mixed-nodeswift-daemon-relay-contract): authenticated same-socket control, local ownership precedence, bounded reconnect/dedup and stale expiry. Native Settings stores explicit target consent/token in app-owned Keychain; Node retains `relay.json`. Swift workers publish only explicitly observed rows, support Claude hook controls/native held Codex approvals and refuse terminal-only or stale/unsupported commands. Neither hub dials a worker, and received rows are never republished. |
| Adaptive high-volume menu bar overview | Yes | Yes | The popup keeps a bounded height at every session/device count: actionable sessions stay visible, idle sessions and repeated surface families collapse into counted summaries, and Activity shows completed work from a named recent window instead of unbounded duration totals. The Dashboard retains the complete roster, topology, and report. This is presentation-only and uses the same daemon state in both tiers |
| Dashboard inspection selection | Yes | Yes | Creature and session-list inspection is local to each dashboard. It filters that screen’s timeline and highlights its creature without changing daemon control focus or another device. Explicit hardware/control commands retain their target. Folded Codex rows include only their declared member session IDs. |
| Adaptive high-volume Dashboard session panel | Yes | Yes | The left HUD reserves the Timeline region, widens within a fixed landscape cap, switches to compact rows for larger rosters, and scrolls the complete session collection inside its own bounded card instead of painting over Timeline. Adjacent setup guidance shifts beside the roster rather than covering it. Presentation-only; focus and session data remain identical in both tiers |
| Guided first use and setup recovery | Yes | No app UI | macOS offers appearance, agent consent, and optional device setup; iOS offers appearance, host discovery/pairing and offline previews. Settings can reopen setup without resetting saved preferences. iOS guidance and connection choices share one scroll surface above persistent navigation, and the QR scanner refreshes authorization after returning from Settings. Completing orientation is not evidence of a connected host or live session. |
| Form-factor-readable Dashboard HUD | Yes | Yes | iPhone/compact-phone portrait presents one full-width readable HUD rail at a time with an explicit Sessions/System switch; phone landscape, iPad/tablet, and macOS retain the dual-rail terrarium composition with bounded Timeline-safe heights. Android e-ink keeps its static high-contrast, no-scroll projection while typography and spacing scale by reader size. Presentation-only; all tiers consume the same session, topology, and timeline state |
| Managed terminal UI steering | No | Yes (compatibility) | The legacy compatibility observer reads only real mode/diff/option UI and injects keys; lifecycle state, timeline, and APME remain hook/event-owned. Direct-launch steering uses ask-gates/injection and is not fully equivalent. Tracked in #273 |
| Observed AskUserQuestion — device answer (ask-gate) | Yes | Yes | The daemon holds the question's PreToolUse hook open and resolves it with the option the user picked, stated as the decision reason. Pure HTTP hold, no subprocess, so it works sandboxed. Engaged only when injection is unavailable (always so in Tier 1); an unanswered hold releases empty, and Claude's own picker appears in the terminal as usual. Multi-question calls are answered one question at a time |
| Observed-session answer injection (device tap → host UI) | No | Yes | tmux / iTerm2 / Terminal.app by tty, cmux by the surface the agent process was started in (read from its environment), GUI apps by AX button or key events. Needs `ps` tty discovery + tmux/cmux/osascript subprocesses — all CLI-only; sandbox has none of them. Preferred over the ask-gate when available: it answers the live picker with no added latency for whoever is at that terminal |
| OpenCode monitoring | Yes; native observer setup, optional read-only SSE | Yes | The app installs the observation-only observer through explicit plugins-folder consent; hooks supply session/turn/tool/attention evidence without server discovery. Native hooks do not expose actionable permission request IDs or a command poller. Observer v7 drains pending handlers and POSTs through bounded disposal, including finite runs. Optional SSE still discovers configured/default endpoints or readable explicit `--port N`, never a random-port scan. Hooks own their state over SSE; disconnect is not completion. The CLI adds process rows only for sessions no hook has claimed. |
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

## Swift parity priorities — source assessment 2026-10-31

This source audit uses `d81b77bf`, including the native P2 implementations,
ATS correction in `099da989`, and recorded acceptance of the installed signed
Release app. The four original P2 ports are implemented. Their remaining
provider/device acceptance is listed separately from new implementation work.
Local development signing and installation do not establish Store distribution
acceptance. The order below is a proposal, not release approval; capability
rows change only when the corresponding implementation and gates pass.

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

### Completed P1: Hermes and OpenCode

| Completed scope | Verified evidence | Boundary still retained |
|---|---|---|
| Hermes direct receiver and settings continuity | [Signed setup](hermes-agent.md#signed-local-release-setup-acceptance-2026-10-29): folder selection, bookmark restoration after app relaunch, preserved connection fields, automatic ready-port update. [Same-process acceptance](hermes-agent.md#long-lived-hermes-process-acceptance-2026-10-29): one real Hermes process retained its identity and completed turns after app relaunch and port change, without observer reinstall or manual receiver override. | Existing observer installation/enablement remains external. Observation-only; no terminal steering, approval answering or downtime replay. Final Store artifact acceptance is a release task. |
| OpenCode native observer setup and finite-run completion | [Setup acceptance](#opencode-observer-setup-acceptance-2026-10-29): install, owned-version update, refusal of edits/symlinks, removal, reinstallation and user-file preservation. [Shutdown acceptance](#finite-opencode-shutdown-acceptance-2026-10-30): canonical v7 installed by the signed Sandbox app; three real, unattached OpenCode 1.18.35 runs exited 0 and reached Swift idle plus response history, with SSE monitoring off. | OpenCode executes the plugin; the app only writes verified owned files through scoped access. Native observer has no command polling or actionable permission IDs. Forced exit/unavailable receiver is not guaranteed delivery. Final Store artifact acceptance is a release task. |

These two P1 implementation/acceptance items are closed. Packaging them into a
release is separate from the remaining native-port backlog; Claude quota source
research below remains open.

### Completed original P2 implementations

All four originally prioritized increments now run natively without a Node
daemon. This closes their implementation backlog, while preserving the specific
acceptance limitations in each row.

| Order | Candidate and current gap | First bounded Swift increment | Completion gate / dependency |
|---|---|---|---|
| 1 — implemented | Pocket adaptive content selection | [Shared policy](../shared/src/pocket-policy.ts) generates native constants; [Swift engine](../apple/AgentDeck/Daemon/Server/PocketAutonomy.swift) implements selection, aggregate learning and existing Feed/Outbox routing. | [Software acceptance](#native-pocket-content-acceptance-2026-10-30) covers Node/Swift vectors and signed-app HTTP/relaunch. The user deferred physical X4 verification to future companion-app integration; no legacy firmware acceptance is claimed. |
| 2 — implemented | Glance Frame pixels | [Swift layout/rendering](../apple/AgentDeck/Daemon/Server/GlanceFrame.swift) uses a statically linked, pinned resvg engine with the same bundled fonts as [Node](../bridge/src/glance-frame.ts). Shared policy generates geometry, layout units, icons and Bayer thresholds. | [Software acceptance](#native-glance-frame-acceptance-2026-10-30) covers exact SVG/1bpp/PNG vectors, native routes and the signed Release app. X4 physical verification is deferred to future companion-app integration. Node also moves from sharp SVG rendering to the common resvg baseline; sharp remains the Node PNG encoder. |
| 3 — implemented | CI provider status enrichment | [Native GitHub client](../apple/AgentDeck/Daemon/Session/GitHubCIClient.swift) and Settings connection implement the [credential/identity contract](#native-github-ci-provider-contract) with bounded HTTPS, independent of Node's `gh api` probe. | [Software acceptance](#native-github-ci-provider-acceptance-2026-10-30) covers phase parity, account replacement/revocation, stale/unknown and real public GitHub reads with signed Settings/Keychain relaunch. Authenticated private-repository live acceptance remains pending a user-configured connection. |
| 4 — implemented | Daemon relay hub/worker | Native [hub/rules](../apple/AgentDeck/Daemon/Relay/DaemonRelay.swift), [outbound worker](../apple/AgentDeck/Daemon/Relay/DaemonRelayUplink.swift) and explicit Settings connection follow the [mixed v1 contract](#mixed-nodeswift-daemon-relay-contract). | [Local acceptance](#native-daemon-relay-acceptance-2026-10-30) covers real sockets, token/origin refusal, reconnect/dedup, timeout, stale/fallback and control guards; all five native configurations pass. [Two-Mac signed-app acceptance](#signed-daemon-relay-two-mac-acceptance-2026-10-31) adds real Keychain save/relaunch/disable and Node↔Swift control round trips while preserving the shared daemon/devices. [Installed Release acceptance](#installed-signed-release-relay-acceptance-2026-10-31) additionally verifies numeric Tailscale address connection, relaunch restoration and disconnect in the actual installation after the ATS correction. Full terminal control and Store distribution are not implied. |

### Remaining native increments — proposed next order

These are source-confirmed gaps, not evidence that Swift cannot implement them.
The ranking favors app-owned data and observation before new control contracts.
No production database is pruned, credential imported or device changed by this
assessment.

| Priority | Current Node-only increment and source evidence | First bounded Swift increment | Completion gate / dependency |
|---|---|---|---|
| P2.1 — next default | APME retention and storage management: Node [payload policy](../bridge/src/apme/payload-prune.ts) and [store preview/apply/vacuum](../bridge/src/apme/store.ts). Native [store](../apple/AgentDeck/Daemon/Apme/ApmeStore.swift) reads prune markers but has no equivalent retention operation. | App-owned database size/status and retention preview first, then an explicit manual apply. Use `AgentDeckPaths`; never modify a sibling Node store. Generate/mirror the shared policy before implementing native SQL. | Node/Swift fixtures must preserve every row and all runs/tasks/turns/evals; replace only eligible old `steps.payload` and tool-kind `sample_events.payload` with the canonical marker. Preserve other event kinds, exclude unknown timestamps and already-pruned payloads, bound batches and apply atomically. Test WAL/busy/interruption and preview/apply consistency. VACUUM is separate, explicitly requested, with free-space/unknown handling; payload reduction alone does not promise a smaller file. |
| P2.2 — evidence milestone first | Antigravity session observation: Node [collector](../bridge/src/passive-observer.ts) and [JSONL parser](../bridge/src/apme/antigravity-transcript.ts) already provide a concrete source shape. Native usage/account support is not a session observer. | User-selected transcript folder, scoped bookmark restoration and read-only conversation parsing in a signed sandbox. Prove stable conversation/turn identity before promoting to full observation implementation. | Fixtures plus live signed-app access: latest-step RUNNING/DONE, incomplete tails, rotation, disappearance, relaunch and stale/unknown. Historical RUNNING records and process presence must not create a permanent WORKING state; usage data must not fabricate PERM. No control or APME import is implied. |
| P2.3 | ICS calendar ingestion for Glance: Node [CalendarProvider](../bridge/src/calendar.ts) feeds schedule events; native Pocket calendar context currently means local date/time, not external ICS ingestion. | Explicit calendar-source consent, secret URL custody in Keychain, bounded fetch/cache and native event expansion. Preserve aggregate-only Pocket learning; never persist event copy as learned content or expose secret URLs in wire/logs. | Shared parser/policy vectors for Node's supported ICS subset, recurrence exceptions, timezone/DST, all-day events, cache/stale and fetch limits. Any correction to Node's timezone assumptions must be a shared contract change. Software Feed/Glance verification can precede the deferred X4 companion integration. |
| P2.4 | Pixoo baked aquarium `animation: "loop"`: Node [bridge](../bridge/src/pixoo/pixoo-bridge.ts) supports it; native [module](../apple/AgentDeck/Daemon/Modules/PixooModule.swift) supports single-frame and Tide but falls back for this mode. | Port baked aquarium frame generation using canonical artwork/layout and existing native multi-frame upload. This is a rendering increment, not a missing Pixoo transport. | Frame/layout parity, bounded cache/upload work, loop seam, frame IDs, rate/backoff, dim/wake and physical Pixoo acceptance. Existing native Tide reduces urgency. |
| P2.5 — separate control proposal | OpenCode server API answers/messages: Node [client](../bridge/src/opencode-client.ts) has `respondPermission`, `replyQuestion`, `rejectQuestion` and `sendMessage`; native [SSE client](../apple/AgentDeck/Daemon/Session/OpenCodeSSEClient.swift) deliberately implements the read-only subset. | First specify explicit user-run server selection, credential custody and opt-in control consent. Then bind directory/session and actionable permission/question IDs to bounded HTTP requests. HTTP makes this technically portable; observation alone is not authorization. | Actual server API contract and CLI version fixtures, pending/stale ID refusal, directory isolation, reconnect and delivery acknowledgement. Preserve the installed observer plugin's observation-only contract; no terminal-injection fallback. Relay v1 unsupported-control refusal stays intact unless deliberately versioned. |

The next default implementation is **P2.1 APME retention**, beginning with the
read-only preview and preservation fixtures. Antigravity starts with access and
identity evidence rather than a promise of immediate observation parity.

### Conditional research and acceptance, outside the default port queue

| Item | Promotion condition / remaining work | Classification |
|---|---|---|
| Kiro v2 SQLite reader | Demonstrate active v2 use or a representative fixture. Node [reader](../bridge/src/kiro-session.ts) supports `conversations_v2`; native flat/nested JSONL observation already exists. Require user-granted read-only access including WAL/SHM, schema/snapshot tests, stable identity and unknown-state parity; never fabricate PERM. | Portable reader, demand-gated. Can move ahead of the new default queue if active legacy usage is established. |
| Claude account quota | Establish a trustworthy source with account identity and observation time; see research contract below. | Source-contract research, not a routine HTTP port. |
| X4 Pocket/Glance | Physical feed/feedback and pixel acceptance at future companion-app integration, as explicitly deferred by the user. | Deferred device integration, not an incomplete native selector/renderer port. |
| GitHub private repository | Live authenticated reads using a user-configured connection; public reads, Keychain and software failure handling already verified. | Provider acceptance, not a missing native GitHub client. |
| TC001 / TRMNL / D200X | Complete the respective native physical/rendering or release checks. D200X keypad support does not imply shipped encoder support. | Hardware acceptance; do not label an existing transport Node-only. |
| Dot | Continue its own DotPreview/distribution decision and acceptance. | Separate product/distribution track, not default Store parity work. |

### Retain an external execution environment

This table describes the current product/runtime contract, not an assertion that
these algorithms require JavaScript. The CLI remains a supported compatibility
path; the native app does not replace every host platform or vendor plugin.

| Capability | Structural boundary under the current Store contract | Swift role |
|---|---|---|
| Managed PTY launcher, agent lifecycle and managed remote attach | Runs Claude/Codex/OpenCode and owns subprocesses/PTYs. The managed `sameSocketControl` channel is distinct from the now-native daemon relay v1. | Observe ordinary sessions and consume external results; keep long-term managed CLI compatibility. Do not add native process launching. |
| Terminal/UI answer injection | Current implementation needs TTY discovery and tmux/cmux/osascript or host automation; those paths are outside the sandbox contract. | Retain native held-hook approvals, AskUserQuestion answers and supported queued delivery. Explicit server HTTP controls can be reviewed separately; these are not full terminal control. |
| APME Layer 1 lint/build/test execution | Runs arbitrary repository/package-manager commands. | Keep native LLM evaluation and task review. Reading an existing result bundle would be a separate partial capability, not execution parity. |
| APME CLI reference judge | [Current implementation](../bridge/src/apme/reference-judge.ts) explicitly invokes `codex exec` using the user's CLI login, only on request. | Existing native judges remain available. A direct hosted-model reference judge would need a new credential, content-sharing and calibration contract; it is not reuse of CLI login. |
| Claude credential recovery | Asks the user's Claude CLI to perform a bounded renewal turn. | Consume explicit external status; never rotate Claude refresh tokens or spawn the CLI. |
| ADB executable integration | Current USB reverse/discovery/control path invokes `adb`; [Swift module](../apple/AgentDeck/Daemon/Modules/AdbModule.swift) is intentionally disabled. | Support same-LAN Android clients. A native ADB implementation would require a separate feasibility/security/product decision, not merely a port of the module. |
| OpenClaw CLI pairing | Executes the external OpenClaw command. | Use the existing native Gateway WebSocket pairing/model-selection path. |
| Firmware build and current USB ROM flashing tools | Builds require external toolchains; current flashing relies on external CLI/browser tooling. Native serial ROM flashing is technically possible but unplanned because chip/image validation and recovery require a separate project. | Retain native supported OTA delivery. CLI/browser flashing remains supported; do not conflate OTA with ROM flashing or firmware compilation. |
| Windows/Linux service, PTY and host-control backends | These are external host runtimes; the macOS App Store app is not their platform replacement. | Preserve cross-platform Node support; a separate native host implementation is outside this migration queue. |
| Elgato/Ulanzi plugin hosts | Vendor SDK plugin execution remains in the vendor application/runtime. | Both already connect to the Swift daemon. A JavaScript plugin runtime does not imply a Node daemon dependency. |

Cross-session coordination is also **not** a remaining Node-only feature: native
`startCoordinationTick` uses `ProcessEnumerator.processTable()` and
`CoordinationTracker`. An older Node-only process-evidence comment in
[DaemonServer](../apple/AgentDeck/Daemon/Server/DaemonServer.swift) is stale; the
executable native path and shared evidence vectors establish the boundary.
Broad terminal discovery/steering remains separate.

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

Pocket selection, Glance pixels, GitHub CI enrichment and daemon relay have
completed their original native implementation queue. The next proposed native
increment is APME retention/storage management, followed by evidence-gated
Antigravity observation, ICS ingestion, Pixoo baked loops and a separately
consented OpenCode control proposal. Physical/private-provider acceptance remains
separate. The installed signed Release relay acceptance is recorded; future Store
artifact and distribution acceptance remain release work. Investigate the Claude
quota source in parallel without promising a quota release before evidence exists.

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


## Native Pocket content acceptance 2026-10-30

The native `PocketAutonomy` engine implements the existing Node PULSE/NUDGE/QUEST
selection and feedback behavior over the existing Swift Feed/Outbox routes.
`shared/src/pocket-policy.ts` owns numeric policy, byte budgets and the opaque
card-ID grammar; `pnpm generate-pocket-policy` emits native constants.
`pnpm generate-pocket-vectors` rebuilds the reference goldens from the real Node
engine. Both Node and native XCTest replay the shared vectors; a macOS Vitest
case also compiles and executes the actual Swift engine directly.

The 16 vectors (92 operations) cover cold start, all candidate kinds, score/config bounds,
UTF-16 hashing and UTF-8 truncation, local calendar/day/hour buckets including a
DST crossing, positive/negative/neutral choices, ignored and expired exposures,
first-answer-wins retries, persistence/reload and mixed malformed state fields.
Rain with unknown probability remains unknown, without an invented percentage.
Invalid/nonopaque identifiers and unknown choice text are discarded at the
persistence boundary in both engines. Existing valid v1 state remains readable.

Content input parity means the **same supplied snapshot** produces the same
cards, outcomes and aggregate state. The app uses already available Swift
session/weather context. This work does not implement Node's ICS calendar
provider or a new quota source; absent context is not fabricated. Glance Frame
rendering has separate acceptance and retains the same supplied-snapshot boundary. Existing THREAD cards, protocol identity and
capability negotiation, weather/pack adverts, authentication and OTA envelopes
are retained. New adaptive cards add at most the configured selection bound.

Actual native route tests cover Feed → conditional unchanged → Outbox → new
Feed, retry identity despite changed `ageSec`, persistent first-answer-wins after
server recreation, and the real HTTP listener's cross-origin rejection. An
OTA-first response and an unchanged response never count as new exposures.
Shutdown flushes learning before teardown awaits; late Feed/Outbox calls return
503 without mutating the saved learning state or acknowledging queued choices.
Learning state stores only category counters, hour affinity, bounded pending
metadata, opaque card fingerprints and answer identifiers. It never stores card
copy, project names, prompt text, event titles or weather locations.

A Development-signed Sandbox app on isolated port **9138** served PULSE/QUEST
alongside the existing THREAD. An actual HTTP fixture verified unchanged pulls
without additional exposure, aged Outbox choices, retries, conflicting second
answers and neutral Later. The final-source app quit/relaunch (**PID 79775 → 86084**)
verified that aggregate learning and first-answer-wins were restored from its container file;
answered cards stayed suppressed. The test receiver was stopped and its previous
preferences restored. This task did not restart the shared Swift daemon on 9120.

**Physical device verification was deferred by the user:** X4 firmware direction
has changed, so the old direct-firmware Feed/Outbox path is not the acceptance
target. Feed/feedback on actual X4 hardware will be tested through the future
companion-app integration. No physical-device pass or current-firmware
compatibility claim is made by these software and signed-app protocol checks.
Local evidence: `diagnostics/pocket-swift-20261030/` (gitignored), including
`final-guard/results.json`, synthetic-protocol receipts and verification logs. Native
macOS Debug and DotPreview XCTest suites completed with zero failures (1,397
cases including 3 skipped; 1,415 including 8 skipped), and macOS Release plus
both iOS Release configurations built successfully. This is local
Development-signature evidence, not Store distribution acceptance.


## Native Glance Frame acceptance 2026-10-30

The Swift macOS daemon now serves authenticated `GET /glance-frame` in-process.
Node's SVG rasterization also moves from sharp/librsvg to pinned resvg-js 2.6.2;
Swift statically links that package's resvg fork at `3495d870`, with a locked
font-layout dependency graph. Both use the exact bundled IBM Plex Sans/KR/JP and
JetBrains Mono files, with system-font discovery disabled. This establishes a
new shared pixel baseline; it does not promise the previous librsvg glyph edges.
No Node runtime, renderer executable, interpreter or runtime download is added
to the app. Rust is a build prerequisite only. Notices/source locations are
included in the app bundle.

[Shared policy](../shared/glance-frame-policy.json) generates board geometry,
layout units, WMO icon rules, icon paths, fonts and Bayer thresholds. The
[Swift renderer](../apple/AgentDeck/Daemon/Server/GlanceFrame.swift) mirrors the
canonical Node SVG layout. A macOS gate executes both implementations against
29 vectors: empty and rich context on all five presets, weather icons,
Korean/Japanese, Unicode truncation/escaping, odd-width rows and clock changes.
SVG, every packed 1bpp byte, physical geometry and content signatures match;
PNG previews decode to the same packed pixels. Four supplied-snapshot vectors
also match provider gauges, stable attention ordering, overflow, UTF-8 limits
and ECMAScript whitespace (including BOM and non-whitespace U+0085).

The FNV content signature hashes the SVG with the clock blanked. Renderer,
font, policy and rotation identities participate, preventing stale conditional
frames when the rasterizer or policy changes. The clock alone does not change
the signature. X3 is rotated before Bayer packing; unused row-tail bits stay zero.
PNG container encodings may differ, but the decoded pixels do not.

A locally Apple-Development-signed **Release** app ran on isolated port 9138,
with its own bundle id/data directory and device modules disabled. Its real
HTTP replies matched Node for these frame sizes:

| Board | Physical response | Packed bytes |
|---|---|---:|
| X3 | 792×528 | 52,272 |
| X4 | 800×480 | 48,000 |
| TRMNL 7.5 | 800×480 | 48,000 |
| NM-EPD-420 | 400×300 | 15,000 |
| LilyGo ePaper 4.7 | 960×540 | 64,800 |

That app passed PNG/payload equality, unchanged `304`, odd custom stride,
radix/decimal dimension parsing, invalid-size fallback, legacy board alias,
identity `200`/`409`, missing capability `403`, incomplete identity `400`,
DNS-rebinding Host and unsafe cross-origin request `401`, and unchanged Pocket
learning state during Glance requests. A synthetic hook then changed the real
session context: echoing the old signature returned `200` and the new packed
frame again matched Node. The app exited normally; the temporary app was
removed, test preferences restored, and shared daemon PID 56289 on 9120 remained
unchanged. Local evidence: `diagnostics/glance-swift-20261030/results.json`.

The Release payload has no extra executable, forbidden subprocess path or Dot
payload. The distribution archive verifier correctly rejects its local Apple
Development identity; this is not a Store archive or release receipt. iOS
normal/DotPreview builds remain valid and do not link the macOS-only library.
Intel and arm64 static libraries build; runtime pixel acceptance was on arm64.

Final source checks passed: `pnpm verify:quick` (7,020 tests passed, 17 skipped),
macOS Debug XCTest (1,398 cases including 3 skipped), macOS DotPreview optimized
XCTest (1,416 cases including 8 skipped), universal macOS Release, normal and
DotPreview iOS simulator builds, generated-mirror/catalog checks and the changed
documentation gates. The final signed-app probe used the completed Release
artifact after the Unicode compatibility correction.

Actual X4 firmware/display acceptance is **deferred to future companion-app
integration** at the user's direction. No physical-device result is inferred
from the HTTP/PNG checks. Native Glance reuses available Swift session, quota
and weather context; it does not add Node's ICS provider or a new quota source.
Existing Feed/Outbox behavior is preserved.


## Native GitHub CI provider contract

Implemented in macOS Settings. Connection is disabled by default. Settings explicitly
asks permission to send the listed `owner/repo` and watch/run identities to
`api.github.com`. Public repository reads may be anonymous; private reads use a
user-pasted fine-grained PAT scoped to selected repositories. No `gh` credential,
Keychain item belonging to another tool, environment token or CLI is consulted.

Only read access is needed: Actions for a run; Pull requests for PR head
resolution; Contents for branch/commit resolution; Checks and Commit statuses
for a head's complete CI verdict. A verified `/user` id/login binds an entered
PAT to its account. A public connection makes no authenticated-account claim.
The token, account identity and repository allow-list are stored atomically in
an app-owned, non-synchronizing, device-local Keychain item. Only an opt-in bit
is stored in preferences. Disconnect disables that bit before deleting the item,
so a Keychain removal error cannot silently re-enable polling after relaunch.

A probe requires an explicit repository plus run id, PR number or ref from the
existing hook classifier; cwd and shared project names never infer identity.
GitHub.com is the only host. Run id/repository/head SHA/attempt must match the
request. PR/ref reads bind to a resolved SHA and recheck the head after reading
all check/status pages; changed heads, duplicate/incomplete pagination, empty
or malformed evidence and cancelled/skipped/neutral conclusions stay unknown.
Links are constructed from validated identity, never followed from response data.

HTTPS GETs use ephemeral sessions, no cookies/cache, denied redirects, bounded
request/body/page/probe limits and provider-directed rate-limit backoff. Tokens
never appear in logs, URLs, wire state, diagnostics or application data files.
Account replacement, disconnect, session closure, daemon stop and changed wait
identity discard late replies. Reads are scoped to the current credential
revision and wait token. Failure/expiry clears cached verdicts and counts rather
than retaining green/red; hook intent remains a separate unknown CI wait.
No GitHub write, rerun, approval or workflow control is added.

Sources: [workflow runs](https://docs.github.com/en/rest/actions/workflow-runs),
[check runs](https://docs.github.com/en/rest/checks/runs),
[commit statuses](https://docs.github.com/en/rest/commits/statuses),
[authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user).

## Native GitHub CI provider acceptance 2026-10-30

The Swift client reads GitHub directly without Node, `gh`, subprocesses or another
tool's credentials. Generated policy fixes 30-second polling, 90-second freshness,
four concurrent probes, an 8-second request/20-second probe budget, a 256-KiB
response limit and at most ten 100-item pages. Provider backoff applies across
all waits. Credential revisions and wait tokens reject late responses; expired,
revoked, malformed or unavailable evidence projects unknown with old counts and
links removed. Completed passed/failed waits retain the existing 30-second result
display interval before closing.

Software checks compare Swift with Node on 63 individual phase and six aggregate
vectors. Twelve native tests exercise run/repository/SHA/attempt identity, PR/ref
head changes, pagination, partial/empty evidence, auth/permission/rate limits,
bounded transport, consent persistence, disconnect/account replacement races,
stale projection, terminal closure and concurrency. Unsigned XCTest cannot access
the Data Protection Keychain and skips that one real-storage test; a correctly
Development-signed helper separately passed actual save/load/delete with a
synthetic credential in a temporary app-owned service.

A Development-signed Settings host compiled the actual Settings, connection,
provider and client source. Explicit consent connected the public repository
`actions/checkout`; Swift directly read [run 40929612276](https://github.com/actions/checkout/actions/runs/40929612276)
as passed. Quitting and reopening restored the repository and connection from
the real Data Protection Keychain and obtained passed again. Disconnect cleared
the verdict to unknown, and a second relaunch stayed disconnected. This is signed
component/runtime acceptance, not deployment or end-to-end acceptance of a newly
installed full app. The shared daemon and device settings were preserved; the
temporary hosts, synthetic Keychain records and test consent were removed.

Final source verification passed: `pnpm verify:quick` (7,022 tests passed,
17 skipped), macOS Debug XCTest (1,410 cases including 4 skipped), macOS
DotPreview optimized XCTest (1,428 cases including 9 skipped), universal macOS
Release, normal/DotPreview iOS simulator builds and changed-documentation gates.
The Keychain test described above accounts for one skip in each macOS suite.

Authenticated `/user`, permission failures, token replacement and private-repo
responses use controlled transport fixtures. **No real personal token or private
repository was used in live acceptance**; that final check belongs to a user
connecting their own selected-repository token in Settings. No token should be
provided through chat or committed diagnostics.


## Mixed Node/Swift daemon relay contract

The macOS transport policy permits explicit relay targets in the RFC 6598
`100.64.0.0/10` shared-address range through a CIDR-scoped ATS HTTP exception,
in addition to existing local-network access. This supports numeric Tailscale
IPv4 endpoints without enabling arbitrary loads or public DNS exceptions.
The range is not proof of Tailscale identity: explicit consent, pairing-token
authentication and the trusted-network/tunnel boundary still apply. The iOS
transport policy is unchanged.

Implemented locally. Both hubs speak the existing v1 `relay_hello` →
`relay_ack` → `relay_sessions` protocol. `relay_command_down` travels only back
down the authenticated worker socket; the hub never dials a worker. The public
minimal health payload advertises only `daemonRelay`, never pairing credentials
or inventory. Existing HTTP/WS pairing and browser-origin gates remain in force.
Non-loopback workers require the hub token. No ambient discovery or CLI
credential/configuration import enables a Swift worker. Native Settings requires
explicit endpoint/data-sharing consent and keeps its target/token in app-owned,
device-local Keychain; disabling consent precedes deletion and drops the uplink.

Observed rows only leave the worker: exclude managed, Gateway and all received
relay rows. The hub applies the canonical typed field allow-list, bounds and
forced observed/port-zero identity. Local sessions and request ids take
precedence. One worker instance supersedes its older socket; duplicates collapse
by row id. Identical snapshots refresh liveness without repeated broadcasts.
Unchanged snapshots heartbeat every 15 seconds, rows expire after 45 seconds,
and disconnect removes them immediately. Expiry is checked on reads as well as
a sweep; old sockets cannot remove their replacements.

Native networking bounds health, hello acknowledgement, sends and pong waits.
Reconnect uses capped exponential delay, slower after authentication/capability
refusal. Configuration/connection generations discard late callbacks and stop
cancels pending work. Relay publication strips volatile elapsed time, retains
explicit null/false and never republishes received rows.

Workers authorize every command against both the latest published ids and their
current local rows/held requests. Node retains its supported observed controls.
Swift supports Claude hook soft stop, queued directives and held-gate answers,
plus native Codex approvals while the actual hold remains current;
it refuses terminal injection, unsupported agents, stale request ids, global
settings/voice/launch commands and commands targeting another session. A Swift
worker sends additive `relay_command_refused` feedback; older v1 peers can ignore
it. Receipt of a command never implies delivery to an external terminal. No new
managed-session dependency or subprocess is added.


## Native daemon relay acceptance 2026-10-30

`daemon-relay-sync.test.ts` compiles the production Swift rules/hub and compares
malformed/duplicate/bounded rows, Unicode, null/false, weight, publication
exclusion and all canonical Node relay command-routing types. Shared policy
generation is drift-gated; native display rows reconstruct elapsed seconds from
plain/fractional ISO timestamps without making heartbeat snapshots change.

`daemon-relay-native.test.ts` compiles production native relay, WebSocket, HTTP
and authentication components into a test-only executable with isolated data
directories and synthetic credentials. A real Swift worker publishes to a Node
hub, receives supported control, explicitly refuses unsupported control and
reconnects without duplicate workers/rows. A real Node worker publishes to the
native hub and receives same-socket control. Native upgrade requests carrying a
browser Origin get 401 with missing/wrong tokens and succeed with the fixture
token. Wrong-version ACK is refused; a hub that never acknowledges hello is
closed within its 10-second budget. No shared daemon, app installation or hardware
is used by these fixtures.

Nine native tests cover typed row bounds, observed-only publication (including
legacy managed rows with no `controlMode`), superseded sockets, on-read/swept
stale expiry, local session/request precedence, elapsed projection and stale
remote focus. They also cover explicit endpoint consent, target/token persistence,
failed deletion remaining disabled, unsupported/terminal/global controls, live
held-request checks, actual native socket reconnect and stop. The relay-specific
suites plus verification-catalog checks pass 49 Vitest cases.

These source suites are local process/socket and storage-fixture checks. Physical
two-machine and signed Settings acceptance are recorded separately below; Store
distribution is not claimed.
The existing app-owned Keychain adapter is reused; no Node file or foreign
credential store is read. Session metadata still travels over v1 `ws://` to the
explicitly trusted endpoint; the existing [network boundary](daemon.md#daemon-relay-worker-daemon-to-hub)
and its trusted-network/tunnel guidance apply.

Final source verification passes all five required native configurations:
macOS Debug XCTest (**1,419 cases including 4 skipped**), macOS DotPreview
optimized XCTest (**1,437 cases including 9 skipped**), universal macOS Release,
and normal/DotPreview iOS simulator builds. The full `pnpm verify:quick` gate
passes with **7,029 tests passed and 17 skipped**. The completed relay components
and catalog pass **49 Vitest cases**, including actual native publication refusing
untagged legacy managed rows and received relay rows. Expanded routing parity
covers every canonical Node relay command type.

The earlier host file-descriptor blocker cleared after an unrelated long-running
read-only search had exited and handle pressure fell. The unchanged ESP32 listener
probe also timed out after five seconds during that pressure, then passed all
seven focused cases after recovery. No unrelated process was signalled and no
global system limit or repository build setting was changed. Native verification used
per-invocation single-job/single-batch scheduling with parallel WMO disabled;
optimization and Store/Dot feature boundaries remained enabled. The new test
catalog entries are included in CI. Local build/test acceptance does not itself
imply signed-app or Store distribution acceptance.

## Signed daemon relay two-Mac acceptance 2026-10-31

Validation ran across the owner's Mac Studio and MacBook Pro, spanning October
30–31. The existing Release artifact was development-signed with the app's
matching provisioning profile and real sandbox/network entitlements. The full
app ran on port 19436 with every device module disabled. A signed Settings host
using unchanged production Settings, Keychain and uplink sources supplied a
separate storage check; it was not substituted for full-app acceptance.

- The full app's Settings → Integrations → Daemon relay saved a synthetic hub
  credential to the app-owned Data Protection Keychain. After normal quit and
  relaunch, its host/port and authenticated connection returned without token
  re-entry; the secure field stayed empty. Disable removed the worker remotely,
  and another relaunch stayed at **Relay off**. The component host independently
  confirmed the Keychain record was present after save and absent after disable.
- The full Swift worker connected to a Node hub on the MacBook's private LAN
  address. A synthetic Claude hook session entered the full app's real HTTP
  receiver and appeared once at the remote hub. A hub-issued `interrupt` returned
  through that worker socket and produced the actual next `PreToolUse` soft-stop
  `deny` response. Injected unsupported `voice` commands were explicitly refused.
- A Node worker on the MacBook published to the full Swift hub through an
  explicit SSH loopback forward and received `interrupt` back on the same
  socket. An additional production-component Swift hub/Node worker pair also
  passed direct LAN publication and control. These are transport/control tests
  with synthetic sessions, not execution in a real remote coding-agent terminal.
- Dropping worker sockets restored one copy of the full app's synthetic row,
  with one registration per distinct worker. The signed component host also
  recovered after the remote Node hub process was restarted.

The shared Node daemon on 9120 retained PID, build and network posture throughout.
Its serial ports, Wi-Fi board identities, Stream Deck, D200H, Pixoo and Android
connections remained present. Only the GUI was temporarily quit; its original
installation and settings were restored afterward. Temporary listeners, SSH
forwards, synthetic Keychain data and signed test apps were removed. No release,
upload or Store installation was performed.

There is a measured endpoint limitation: the signed component host rejected the
Tailscale CGNAT numeric address with `NSURLErrorDomain -1022` under the production
App Transport Security policy. Private LAN IPv4 and the explicit SSH forward
passed. This describes the original test before the scoped exception below;
no transport-security exception was added during that original run. See the
[isolation notes](devlog/entries/2026-10-31-signed-relay-two-mac.md).

## Numeric Tailscale ATS correction 2026-10-31

The old policy's `NSAllowsLocalNetworking` did not permit the tested RFC 6598
CGNAT address. The signed before/after probe used the same URLSession code,
signing identity and MacBook endpoint: the existing policy returned `-1022`, while
adding only `100.64.0.0/10` to `NSExceptionDomains` with
`NSExceptionAllowsInsecureHTTPLoads` returned HTTP 200. Boundary probes just
outside that CIDR still returned `-1022`. An HTTPS peer in the allowed range
with an untrusted self-signed certificate still returned `-1202`; no custom
trust handling was added.

[Apple documents IP/CIDR ATS exceptions](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains)
on supported macOS versions; [Tailscale documents its default shared-address
range](https://tailscale.com/docs/reference/reserved-ip-addresses). The change
is macOS-only and app-wide for this CIDR, rather than a per-relay authorization
or proof of VPN encryption. Existing local-network access stays intact; iOS,
global arbitrary-load flags, TLS minimums and server-trust callbacks are unchanged.
The App Review notes explain why the existing user-selected HTTP/WS protocol
needs this bounded exception. Custom Tailscale IP pools outside the CIDR are
not enabled by it.

The native regression test inspects the built app host's processed Info.plist
and requires exactly the local-network key and this one HTTP exception. It
rejects extra exception domains, arbitrary-load flags and TLS-policy additions.

Two-Mac acceptance used the current built Debug app, signed with the matching
development profile and production sandbox/network entitlements. The XCTest
injection bundle was removed only from the temporary signed copy. Its native
daemon used an actual verified temporary data directory, port 19446 and no
device modules; the original development installation was not replaced.
The full app connected to the MacBook's numeric Tailscale IPv4 hub, first
refused a wrong token, then authenticated with the synthetic token. The reverse
Node worker connected directly to the full Swift hub's numeric Tailscale IPv4,
without SSH forwarding. A wrong-token native upgrade returned 401.

Synthetic observed sessions and same-socket `interrupt` completed both ways;
Node-to-Swift control produced the actual next `PreToolUse` soft-stop `deny`.
The full worker refused `voice` and did not republish the received remote row.
Normal quit/relaunch restored the numeric target and authenticated connection
without token re-entry; Disable removed the remote worker, and a subsequent
relaunch remained off. The original GUI and its selected endpoint/posture were
restored, all test listeners/apps/data and the synthetic TLS certificate were
removed, and shared 9120 retained its PID/build/posture and hardware identities
(including all 11 serial ports). These are development-signed transport/control
results with synthetic hook events, not Store distribution or a real remote
agent terminal execution.

All five native configurations pass: macOS Debug XCTest (1,420 cases including
4 skipped), optimized DotPreview macOS XCTest (1,438 including 9 skipped),
universal standard Release, and normal/DotPreview iOS simulator builds. App Store
submission-material validation also passes. The first Debug run's test host
exited during the existing 125-second socket-lifetime case; a full Debug rerun
after temporary signed-app activity ended passed with no source changes, as did
the optimized lifetime case. This was not an ATS assertion failure.
The full quick gate passes (7,029 Vitest tests passed, 17 skipped), including
protocol drift, type/lint and documentation gates. The separate login-Keychain
daemon E2E remains opt-in and was not run by that quick invocation.

## Installed signed Release relay acceptance 2026-10-31

The owner explicitly requested updating the actual development installation after
the scoped ATS correction. The installed app is now the universal standard
Release configuration from source commit `099da989`, version 1.9.4/build 5, signed
with the same development identity and app identifier as the previous install.
Its actual executable path, SHA-256 and strict code signature were checked; it
contains the single Release executable, with no Debug dylib or injected XCTest
bundle. The previous installation is retained as a local rollback backup.

Acceptance ran from the installed path, not a temporary Settings host or copied
app. Typed own-app preferences selected port 19456, loopback-only and no device
modules; actual health and a temporary container registry confirmed that
isolation. Settings connected to the MacBook's numeric Tailscale IPv4 hub with
an explicit consent and synthetic pairing token. The remote hub received one
authenticated worker and one synthetic observed hook session. Normal quit and
relaunch restored the endpoint and connection without token re-entry. Disable
removed the remote worker/rows, and another relaunch remained Relay off.

After acceptance, the original endpoint/posture preferences were restored and
the updated installed Release app was relaunched normally against shared 9120.
The shared Node daemon retained PID 6505, build and posture; all 11 serial
transports remained open, and Wi-Fi board, Stream Deck, D200H, Pixoo and Android
identities matched the baseline. Temporary app copies, helper, data and remote
hub were removed. The updated installation remains in place.

This is a local development-signed Release installation. The Store archive
verifier reported only its expected development-certificate refusal; no other
archive boundary violation was reported. The same signing team was preserved
for Keychain custody rather than changing identity to obtain a Store signature.
No public version, Store submission or upload was performed.

The deployment full check completed on source commit `099da989` with no failed
automated steps. The [recorded receipt](../verification/receipts/2026-10-30-099da98.json)
uses its UTC completion date. Coverage, Android, all five Apple configurations,
submission-material checks, ESP32 host/simulator/TTGO builds and isolated npm
package acceptance passed. Windows, the separate login-Keychain E2E and broad
lab attestations were not run; the installed macOS acceptance above has its own
local runtime receipt.
