---
id: policy.product-tiers
title: App Store and CLI Product Tiers
description: Capability, evidence and lifecycle boundaries for Swift-only, Node-only and concurrent operation.
category: Engineering
locale: en
canonical: true
status: required
owner: Apple product maintainers
reviewed: 2026-11-02
revision: 2026-11-02
source_of_truth: docs/appstore-feature-matrix.md
validators: [bash apple/scripts/verify-appstore-archive.sh]
---

# App Store and CLI Product Tiers

**Distribution status:** both platforms are live at [AgentDeck Dashboard](https://apps.apple.com/app/id6784822497) — macOS since 2026-07-21, the iPhone/iPad companion since 2026-08-07 (its first attempt was rejected on 2026-08-04 under Guideline 2.1(a) — an unbounded discovery spinner; the rule that came out of it is "a progress indicator binds to bounded work" in [.claude/rules/swift-daemon.md](../.claude/rules/swift-daemon.md)). **Live version numbers are deliberately not repeated here** — this document owns the tier boundary, not release tracking, and the two drifted apart before. [RELEASING.md](../RELEASING.md) carries the current per-platform version, build and state in its dated checkpoints; its § Apple keeps the login-free checks for each platform. The repository's source version advances independently of any channel release.

This matrix defines the supported Swift-only, Node-only and concurrent configurations, their retained product boundaries, and their implementation and acceptance gaps. Add or move a row here **before** implementing a capability. The App Store/CLI columns below describe implementation availability; a Yes does not certify all three configurations or their ownership transitions.

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

1. Render actual agent `options[]` or the explicit one-time Allow/Deny semantics of a native held tool request. Display-only notifications do not create decisions. Observed questions require `liveAnswerable`; OpenCode native requests also require fresh observer polling. Default device controls do not send canned Review/Commit/Go on/Clear or suggested tasks. Evaluations remain a separate workflow.
2. An observed session emits `requestId` only while the daemon is holding a real
   decision open for that session (a Claude PreToolUse or an opted-in Codex
   `PermissionRequest`). Display-only notifications and non-held
   AskUserQuestion overlays never expose a request id.
3. Display-only attention shows the question and “Respond in the terminal”; it does not invent Allow/Deny choices.
4. Claude permission attention comes from the `PermissionRequest` hook, which runs as Claude is about to draw its dialog, and falls back to the Notification keyed by `notification_type: permission_prompt`. Free-text matching is legacy fallback only.

## Core dashboard

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| Pairing-token rotation and retirement | Source implemented; unreleased | Source implemented; unreleased | Active-owner rotation with explicit global-revocation-incomplete status; persisted retirement revision shared by Node/Swift. Offline or older owners may still accept old tokens. Peers that observed retirement refuse stale handover. Tracked in #673. |
| CloudKit remote observation and forwarded Watch notifications | Development-only PoC; single route verified | No standalone publisher planned for the PoC | [Design and transport-spike status](apple-remote-observation.md). Opt-in running Mac app publishes minimal observations to the same Apple Account's private CloudKit database; iPhone reads and receives visible subscription alerts. The app-layer publisher can observe either local daemon tier. No public relay, uploaded provider credentials, remote approvals or Watch app. Mac offline means historical state. One user-assisted iPhone read/alert and Watch forwarding route is verified; real-wait alert delivery, real-summary manual sharing and offline aging are also verified. Account-generation guards, cancellable mutations and a reader-clear/subscription-disable action are implemented; their new device UI still needs acceptance. Development PoC automatic publishing and account-scoped durable reader/outbox are implemented behind explicit opt-in and covered by deterministic persistence/transport tests; quota integration, disruption trials and Production remain incomplete. |
| Remote observation phone/Watch widgets | Deferred | — | iPhone WidgetKit reader follows CloudKit transport and offline acceptance; a Watch target/complication is a separate follow-up. No current widget or independent Watch delivery claim. |
| CI wait observation (#433) | Hook evidence; optional native GitHub HTTPS status | Hook evidence; optional GitHub status | Both daemons track explicitly identified CI watch tools independently of agent turn state, clear matching foreground tools and session boundaries, and emit explicit null on close. Background watches survive Stop. Hook intent has unknown CI phase until provider evidence arrives; it never proves success or failure. Native access requires explicit consent and a repository allow-list; its optional fine-grained PAT stays in app-owned Keychain. Stale/unavailable evidence clears the verdict. The App Store app never spawns `gh`. No credentials or raw command reach the wire. |
| Guided first use | Yes | — | Choose an available 2D/3D appearance, explicitly enable Claude/Codex observation through the existing consent flow, and enter with observed/ready/not-set-up status. Hardware discovery is optional, with an existing Stream Deck path and offline Device Preview. iOS offers appearance then bounded Mac discovery/QR pairing. Setup can be reopened; notifications are requested only on an explicit action. |
| Hermes mermaid aquarium resident | Yes | Yes | Bundled Blender-authored Nous girl-inspired mermaid; observed Hermes sessions drive working/waiting poses. A shared shell seat for idle rest, front-lip entry with planted-foot compaction, bounded lift-off for active work, skinned body/tail/fin and arm joints, independently controlled gaze/lids/brows/mouth, and cosmetic neighbour greetings; no inferred delegation or new controls. Both daemons ingest Hermes observer events; direct Swift delivery follows explicit receiver-folder consent. Reduced Motion resolves the live pose without travel. OpenClaw shares this entrance for first arrival and final gateway departure, keeping its original mesh and side rock while idle or routing. |
| Optional native 3D aquarium | Yes | Yes | Device-local dashboard type; bundled Blender-authored habitat and canonical extruded agent meshes. RealityKit live session reconciliation, status labels and existing focus commands; standard dashboard retained. No runtime Blender or external model download. |
| Multi-daemon companion pairing (#493) | Yes | Compatible host | Explicit host selection, endpoint-scoped credential retention, and host-specific approval recovery. Discovery carries no credentials; approval remains operator-controlled. |
| macOS dashboard and in-process daemon | Yes | — | Standalone Tier 1 product |
| macOS attention shortcuts and notification navigation | Yes | Compatible host | Native Shortcuts list live sessions awaiting a response and open a specific session in the Dashboard. Notification clicks use the same endpoint-scoped, local inspection route. Roster freshness is tracked separately from usage and timeline traffic; unavailable state is never reported as an empty queue. Opening a session does not answer a prompt, launch a session, or change hardware control focus. Cold-start waits are bounded. No new entitlement, helper or extension is required. |
| macOS Dashboard work | Yes | Yes | The Dashboard keeps its session list and Usage & Services rails. Work opens in the same window from the header or a session selection and prioritizes work awaiting operator input. Compact windows navigate from the list to detail. Wider windows show them side by side and preserve the selection during resize. Usage & Services opens from the Work header, and the compact Dashboard opens its utility rails from the header. Selecting a work item shows task history, typed delegates, reported and observed background work, and task-linked message deliveries confirmed by receipt evidence. There is no separate message history, graph or aquarium message current; a message appears only as a confirmed delivery inside the task it belongs to. Both daemons use the existing bounded authenticated feeds. Inspection leaves the agent control target in place. |
| Cross-session coordination evidence (`RelationEvent` + `SessionInfo.coordination`) | Yes, evidence-bounded | Yes | Work divided WITHOUT a SubagentStart: `claude -p` workers spawned from a background Bash (`spawned`, process ancestry), peer messages over SendMessage (`messaged`, the sender's tool input and the receiver's `<cross-session-message>` envelope), and background jobs a session is waiting on (`waiting_on`, argv names its scratchpad). Both tiers produce all three plus the live `coordination` census on `sessions_list` (`bridge/src/coordination-evidence.ts`; Swift `CoordinationTracker` is a transliteration, both replay `shared/coordination-evidence-vectors.json`). The session→process link is the hook header `X-AgentDeck-Pid: $PPID` on both tiers; Tier 2 additionally reads `~/.claude/sessions/<pid>.json`. The process table is `sysctl` on Tier 1 (`ProcessEnumerator.processTable`, no entitlement, no subprocess) and `ps` on Tier 2. IPS10 cards receive `coordination {backgroundJobs, spawnedActive}` and a bounded rotating roster (`stableCardRoster`, up to three attention sessions pinned, remaining sessions rotate every 60 seconds, id order within each page, `total` and `rosterRotating` metadata) from either daemon. Observed only — never inferred from shared project membership. A `TaskCompleted` checklist item is an `info` annotation on both tiers, never a child agent. |
| Enterprise network posture (loopback-only / no device modules) | Yes | Yes | Same two axes both tiers. Tier 2: `daemon start --loopback/--local`, baked into autostart via `daemon install --enterprise`. Tier 1: Settings → Local server toggles (`AppPreferences.daemonLoopbackOnly` / `daemonNoDeviceModules` → `DaemonPosture`), applied by daemon restart; the sandboxed app cannot read env vars meaningfully, so a preference is the switch |
| iOS / iPadOS companion | Yes | Yes | Bonjour + same-LAN WS |
| Stream Deck family | Yes | Yes | Requires Elgato Stream Deck host software |
| Claude Code hook installation | Yes | Yes | Explicit `NSOpenPanel` file consent |
| Codex lifecycle observation | Yes | Yes | Explicit `NSOpenPanel`; managed TOML block only. Both installers include `PermissionRequest` and `Interrupt` (≤3s); new hooks require Codex trust review. Live-verified CLI 0.149.0 omits Interrupt, 0.151.0 supports it |
| Voice input | Yes | Yes | Apple on-device speech in both tiers — Tier 1 calls the framework, Tier 2 the bundled Swift helper. macOS-only; no whisper/model install |
| Deck voice key (Stream Deck hold-to-talk / D200H tap-toggle) | Yes | Yes | Deck key = trigger only; host mic/STT/TTS do the work. Tier 1: native AVFoundation+Speech (`DaemonPttVoice`), observed-Claude delivery is the queued-directive ladder (live typing needs the CLI daemon). Tier 2: bundled helper `record`, observed delivery via terminal injection |
| Claude peer inbox dictation | Standalone delivery remains the native queued-directive path | Node on macOS/Linux; terminal fallback for older/unavailable inboxes | Hook-advertised private socket, no exported token forwarding. Messages retain peer semantics and Claude inbound approval/refusal. Delivery requires a correlated receiver receipt or recipient transcript UUID; an attempted write never earns an automatic terminal retry. Held and unconfirmed outcomes remain visible. |
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
| APME storage and retention | Yes, macOS in-process daemon | Yes, CLI | Native Full report → Storage provides file/page capacity, preview, explicitly confirmed payload-only pruning and separate space-gated compaction. Shared policy and actual Node/Swift SQLite vectors preserve rows/history and non-tool sample content. Validation uses disposable stores only; no actual user data is pruned. See [contract and verification](apme.md#swift-보존용량-관리-2026-10-31). |
| Pocket adaptive PULSE / NUDGE / QUEST content | Yes, macOS; companion-device integration separate | Yes | Native selection and aggregate learning reuse Feed/Outbox. Shared policy and cross-daemon vectors cover selection, opaque fingerprints, first-answer-wins feedback, ignored exposures and persistence; no personal card copy is persisted. Signed-app HTTP/relaunch acceptance passed; X4 physical round-trip was explicitly deferred to future companion-app integration after its firmware direction changed. Glance rendering has its own acceptance below; ICS source consent stays separate; the native provider now supplies schedule context. See [acceptance](#native-pocket-content-acceptance-2026-10-30). |
| Glance Frame pixel rendering | Yes, macOS; physical-device integration separate | Yes | Exact 1bpp parity uses a common, pinned resvg engine and bundled fonts. Signed Release-app HTTP acceptance covers binary/PNG, conditional responses, Surface identity, authentication and content changes. X4 physical verification is deferred to companion-app integration. See [acceptance](#native-glance-frame-acceptance-2026-10-30). |
| Surface Protocol licensed learning-pack delivery | Yes | Yes | Both daemons advertise a bundled, integrity-checked offline learning pack in full and unchanged portable Feed responses and serve it through authenticated `GET /learning/pack`. Delivery is gated by `learning.pack.read` / `learning.pack.update`, the registered Pocket Daily product identity, exact pack id/version, and the pack's SPDX licence metadata. The App Store path reads a signed bundle resource only; it launches no process and accesses no external path. |
| Surface Protocol automatic font-pack delivery | Yes | Yes | Both daemons advertise the bundled OFL PocketSansWorld pack in full and unchanged portable Feed responses and serve it through authenticated `GET /fonts/pack`. Delivery is gated by `font.pack.read` / `font.pack.update`, exact Pocket Daily identity and id/version, plus size, MD5, SHA-256, cpfont-format, source-ledger, and licence validation. The App Store path reads signed bundle resources only. |
| ICS calendar schedule | Yes, macOS; explicit source/share consent | Yes; same parser/cache contract | Private source URLs stay in app-owned Keychain. Read-only HTTPS fetch (including webcal subscriptions normalized to HTTPS) and memory-only recurrence expansion feed Glance and Pocket agenda cards. Shared timezone/DST and cache vectors execute both implementations; no event copy enters Pocket learning. Signed Settings consent/save/relaunch/disconnect acceptance also passed. See [contract acceptance](#native-ics-calendar-acceptance-2026-10-31) and [signed UI acceptance](#signed-ics-settings-acceptance-2026-10-31). |
| App Store Connect engagement reports | Yes | — | Maintainer tooling creates ONGOING reports plus an optional ONE_TIME_SNAPSHOT for existing history, then downloads Apple's opt-in, privacy-thresholded aggregate analytics through the App Store Connect API. Creating requests requires Admin access; existing reports can be downloaded with Admin, Finance, or Sales and Reports access. No analytics SDK, device identifier, event upload, or AgentDeck-operated analytics backend is added to the app. |

## Ordinary-session setup and evidence

| Agent / path | Initial setup | Reliable evidence and limits |
|---|---|---|
| Claude Code local | CLI daemon setup, or app file consent | Hook lifecycle; permission and held-decision paths remain distinct. |
| Codex CLI / local Desktop | CLI setup, or app config/folder consent; Codex hook trust remains user-owned | New SessionStart is idle; prompt/tool events prove work. Written TOML alone does not prove trust or event delivery. Existing hooks=false is preserved. Later Codex settings inside the managed fence are retained; an extended features table becomes user-owned, including its hooks flag. |
| OpenCode ordinary TUI / finite run | App folder consent + Install / Update, or CLI observer setup | Native setup preserves existing configuration and unrelated plugins. Hooks work without a persistent OpenCode server or Node daemon; native installation is observation-only. OpenCode 1.18.35 finite-run completion was verified through Swift to idle and response history. Native installation stays observation-only. CLI-installed observers additionally answer supported single-question, single-choice prompts through the active native SDK channel; permission and question IDs stay separate. See [setup acceptance](#opencode-observer-setup-acceptance-2026-10-29) and [finite shutdown acceptance](#finite-opencode-shutdown-acceptance-2026-10-30). |
| Hermes ordinary CLI | Already-installed/enabled Hermes observer + app folder consent | App retains the receiver folder and follows the ready local port. One long-lived Hermes process delivered completed turns after app relaunch and listener-port change, without Hermes restart or manual receiver updates. No downtime replay; observer installation/enablement remains external. See [continuity acceptance](hermes-agent.md#long-lived-hermes-process-acceptance-2026-10-29). |
| OpenCode optional SSE server monitor | Enable monitoring and provide a reachable server | Discovery uses the configured URL, default port or a readable explicit `--port N` argument. SSE is read-only. A bare TUI's random port is not automatically discoverable. Pending requests are seeded per directory after SSE attaches; connection loss is not completion. Reconnect prioritizes remembered event directories, then the latest 200 global session records, with a cap of 32 directories plus the server default and four concurrent directory reads. Older/unavailable global inventory falls back to remembered locations and the default. |
| Kiro CLI | Node store access, or explicit app folder consent | Passive polling; Swift supports flat and nested JSONL, Node additionally supports v2 SQLite. No permission signal. |
| Antigravity | Native scoped JSONL/SQLite observer or Node passive observer | User-selected root supplies JSONL conversation/turn identity and explicit SQLite activity. RUNNING/GENERATING → WORKING, DONE → IDLE with bounded freshness and unknown refusal. Account/plan access is a separate grant. |
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
| Pixoo64 | Yes, single-frame, Tide and opt-in baked aquarium loop | Yes; same baked pixel core | Native LAN HTTP uploads the shared fixed aquarium frames. All RGB bytes, palindrome ordering, bounded cache and upload policy have software parity; actual Pixoo loop/dim/wake and Tide restoration are verified below. See [baked loop acceptance](#native-pixoo-baked-loop-acceptance-2026-10-31). |
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
| Session order pinning (`--weight` sort override) | Yes, owner-local persistence | Yes, owner-local persistence | Both daemons implement `session-order.json`, `agentdeck order`, `POST /sessions/order` and the shared TTL/cap. The active owner overlays pins before fold/sort. Unsandboxed builds may share a file; a signed sandbox app and Node have separate stores with no pin-transfer path identified in this audit. Same-owner restart persistence does not prove signed cross-owner continuity; that is an actual gap below. The managed launcher's `--weight` remains compatible; the 2026-09-19 tab-to-deck acceptance does not close this transfer gap. |
| Daemon relay (worker daemon publishes observed sessions to a hub daemon) | Native hub and opt-in worker (experimental) | Yes (experimental) | [Mixed v1 contract](#mixed-nodeswift-daemon-relay-contract): authenticated same-socket control, local ownership precedence, bounded reconnect/dedup and stale expiry. Native Settings stores explicit target consent/token in app-owned Keychain; Node retains `relay.json`. Swift workers publish only explicitly observed rows, support Claude hook controls/native held Codex approvals and refuse terminal-only or stale/unsupported commands. Neither hub dials a worker, and received rows are never republished. |
| Adaptive high-volume menu bar overview | Yes | Yes | The popup keeps a bounded height at every session/device count: actionable sessions stay visible, idle sessions and repeated surface families collapse into counted summaries, and Activity shows completed work from a named recent window instead of unbounded duration totals. The Dashboard retains the complete roster, topology, and report. This is presentation-only and uses the same daemon state in both tiers |
| Dashboard inspection selection | Yes | Yes | Creature and session-list inspection is local to each dashboard. It filters that screen’s timeline and highlights its creature without changing daemon control focus or another device. Explicit hardware/control commands retain their target. Folded Codex rows include only their declared member session IDs. |
| Adaptive high-volume Dashboard session panel | Yes | Yes | The left HUD reserves the Timeline region, widens within a fixed landscape cap, switches to compact rows for larger rosters, and scrolls the complete session collection inside its own bounded card instead of painting over Timeline. Adjacent setup guidance shifts beside the roster rather than covering it. Presentation-only; focus and session data remain identical in both tiers |
| Guided first use and setup recovery | Yes | No app UI | macOS offers appearance, agent consent, and optional device setup; iOS offers appearance, host discovery/pairing and offline previews. Settings can reopen setup without resetting saved preferences. iOS guidance and connection choices share one scroll surface above persistent navigation, and the QR scanner refreshes authorization after returning from Settings. Completing orientation is not evidence of a connected host or live session. |
| Form-factor-readable Dashboard HUD | Yes | Yes | iPhone/compact-phone portrait presents one full-width readable HUD rail at a time with an explicit Sessions/System switch; phone landscape, iPad/tablet, and macOS retain the dual-rail terrarium composition with bounded Timeline-safe heights. Android e-ink keeps its static high-contrast, no-scroll projection while typography and spacing scale by reader size. Presentation-only; all tiers consume the same session, topology, and timeline state |
| Managed terminal UI steering | No | Yes (compatibility) | The legacy compatibility observer reads only real mode/diff/option UI and injects keys; lifecycle state, timeline, and APME remain hook/event-owned. Direct-launch steering uses ask-gates/injection and is not fully equivalent. Tracked in #273 |
| Observed AskUserQuestion — device answer (ask-gate) | Yes | Yes | The daemon holds the question's PreToolUse hook open and resolves it with the option the user picked, stated as the decision reason. Pure HTTP hold, no subprocess, so it works sandboxed. Engaged only when injection is unavailable (always so in Tier 1); an unanswered hold releases empty, and Claude's own picker appears in the terminal as usual. Multi-question calls are answered one question at a time |
| OpenCode question — device answer | Yes, with an already installed compatible observer | Yes | Single-question, single-choice prompts expose actual labels and descriptions. A recent observer poll and native SDK transport are required. The daemon checks the question echo and index; the observer checks the live request ID and exact label. Sending is pending until upstream resolution; transport errors re-arm with an unconfirmed status. Multi-question, multi-select and custom text remain display-only. This uses local hooks only; CloudKit never carries decisions. |
| Observed-session answer injection (device tap → host UI) | No | Yes | tmux / iTerm2 / Terminal.app by tty, cmux by the surface the agent process was started in (read from its environment), GUI apps by AX button or key events. Needs `ps` tty discovery + tmux/cmux/osascript subprocesses — all CLI-only; sandbox has none of them. Preferred over the ask-gate when available: it answers the live picker with no added latency for whoever is at that terminal |
| OpenCode monitoring | Yes; native observer setup, optional read-only SSE | Yes | The app installs the observation-only observer through explicit plugins-folder consent; hooks supply session/turn/tool/attention evidence without server discovery. Native hooks do not expose actionable permission request IDs or a command poller. CLI-installed observers retain structured choice and native permission response support. Observer v7 drains pending handlers and POSTs through bounded disposal, including finite runs. Optional SSE still discovers configured/default endpoints or readable explicit `--port N`, never a random-port scan. Hooks own their state over SSE; disconnect is not completion. The CLI adds process rows only for sessions no hook has claimed. |
| Antigravity session monitoring | Yes; direct read-only observation | Yes; shared source contract | User-granted JSONL identity plus SQLite activity with scoped bookmark restoration. Explicit RUNNING/GENERATING supplies WORKING and DONE supplies IDLE; stale, unknown and mismatched activity withdraw the row. Native one-second polling needs no subprocess or Node service. Account/plan access stays separate. No PERM, steering, task-completion inference or APME import. |
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


## Three-configuration parity audit (2026-10-31)

**Standing objective:** Swift-only, Node-only and concurrent operation must each
provide the fullest equivalent experience within the retained boundaries below.
A completed port closes an implementation item; it does not close configuration,
state-continuity, installed-artifact or lifecycle acceptance. Concurrent operation
uses one serving owner per local endpoint/fleet. With a healthy same-user Node
owner, the app attaches as a client and retires its local server/modules. Starting
Node after Swift negotiates stand-down; Node disappearance can promote Swift.
Two independent device writers are not the concurrent-mode contract.

| Configuration | Required behavior | Audited state |
|---|---|---|
| Swift only | The signed app owns HTTP/WS, observation, supported controls and devices; restores its granted access and owner-local state after relaunch. | Most portable implementations exist. OpenCode server controls and the continuity issues below remain open. Signed component acceptance is feature-specific. |
| Node only | The CLI owner serves the same wire and supported device behavior without a running Swift app; vendor plugin hosts and ordinary agent tools retain their own runtimes. | Existing daemon implementation plus isolated real-process startup/restart E2E. macOS/iOS UI, StoreKit and native appearance choices belong to their client surfaces, not a missing CLI GUI. |
| Both running | Node owns the shared local endpoint when healthy; the app follows the actual ready endpoint. One set of collectors/device writers, converged pairing credentials, honest stale state and safe recovery. | Ownership, bounded teardown, token adoption and retry paths exist. Full current signed-app/Node feature-and-hardware acceptance across both startup orders and owner changes is incomplete. |

### Evidence scope and observed runtime

Source inspection in this checkout is pinned to `3a5c9394`, including the native
P1/P2 ports. It covers the referenced implementations and tests, not every change
in the separately running installation. At audit start, read-only `/health`
identified Node PID `71702`, build `8fe2909f2930`, port `9120`. The installed
`/Applications/AgentDeck.app` metadata was 1.9.5/build 5 and did not contain this
port's required `pixoo-baked.generated.js` resource. That establishes a delivery
mismatch for this common-core artifact; no installed Pixoo behavior was exercised.
These observations supersede neither earlier dated receipts nor release records.
They do not certify this source revision as installed or running. Start/end
health observations retained the same Node PID/build/port and all baseline device
identities; no lifecycle or hardware command was issued.

Evidence terms used below:

- **Implementation:** executable source is present, with its consent/access requirements.
- **Software:** shared vectors, mocked transports, native component tests or isolated sockets.
- **Signed / installed / hardware:** only the specific dated scenario and artifact in the linked receipt.
- **Gap:** either an identified absent implementation or an unperformed acceptance scenario, explicitly distinguished.

This audit inspects source and recorded evidence and observes the existing owner
read-only. It does not stop either runtime, change a credential or setting, start
an additional hub, reconnect hardware or claim a new three-mode live acceptance.
The earlier quick/native suite results remain dated evidence. This documentation
pass passed the workspace build, 60 related service/document-contract tests and
changed-document/mirror/catalog gates. It did not rerun native acceptance or the
macOS login-Keychain E2E.

### Capability status in all three configurations

The following rows supplement the detailed capability tables rather than treating
all of their Yes cells as an end-to-end acceptance claim. Equivalent behavior
assumes the same explicitly authorized sources, identities and supported controls;
configuration drift must not masquerade as a completed port or an agreed exception.

| Capability | Swift only | Node only | Both running / remaining gap |
|---|---|---|---|
| Ordinary Claude/Codex/Hermes/OpenCode observation and native Kiro JSONL | Implemented within scoped access; signed Hermes/OpenCode and finite-run evidence recorded below. | Implemented through hooks/observers and CLI setup. | Active owner receives hooks. Receiver ready-port synchronization exists; both startup orders and owner switches during a long-lived agent turn still need current integrated acceptance. |
| Antigravity JSONL/SQLite activity | Implemented; signed real CLI WORKING→IDLE acceptance recorded. | Same parser/activity contract implemented. | Port handover must not duplicate a turn or retain an old verdict. Existing standalone/component parity is not that test. |
| Held Claude/Codex decisions and queued delivery | Supported hook paths only; Codex real trusted-handler decision acceptance is still pending as recorded in its row. | Supported hooks plus external terminal paths. | Retire old holds and reject stale request IDs across ownership changes; no terminal fallback in Swift. Signed in-flight approval retirement/stale-ID acceptance is recorded below; arbitrary queued control delivery remains P1.3. |
| OpenCode server permission/question replies and messages | **Native primitives and integration missing** from the read-only SSE path. | Client-library methods exist; production answer/message wiring was not found. The adapter uses health, discovery, SSE and abort. | **Shared integration gap**, formerly P2.5. Method presence does not establish Node-only or concurrent end-to-end HTTP control. Node managed/terminal control is a distinct external path; keep the installed observer observation-only. |
| Codex/z.ai/Admin usage and CI status | Native clients exist; native GitHub signed public reads/Keychain acceptance recorded. Claude account quota has a separate boundary below. | Existing provider clients use their own authorized configuration. | z.ai already has an active-owner configuration route. Other account/repository selections and credential revisions need owner-change acceptance; private GitHub live authentication is unverified. |
| Pocket selection, Glance pixels and ICS | Native implementations, exact renderer/parser/selection vectors and signed component/HTTP/Settings evidence. X4 acceptance deferred. | Corresponding Feed/Outbox, renderer and calendar implementations. | Current-owner aggregates/opaque receipts have a local checkpoint path and an opt-in cold-recovery store, with inactive profiles preserved. Calendar consent/configuration remains separate P1.2 work; see the in-flight and cold-recovery acceptance below. |
| Settings for hardware, GitHub, ICS and relay | App-owned device settings; native Keychain and scoped consent. | Owner's `settings.json`, `relay.json` and provider setup. | **Configuration routing gap:** GitHub/ICS/relay editors are hidden while external; Pixoo edits now target the active local owner with revisions; the other editors retain the routing gap. Consistent owner-aware configuration and explicit consent must be implemented/verified. |
| Session order pins | Persisted in `AgentDeckPaths` store. | Persisted in Node data dir. | Live local-peer transfer and opt-in committed cold recovery are implemented, including clear/removal and explicit managed/remote weight precedence. Signed external-folder selection/relaunch and explicit divergent-profile choices passed in the isolated acceptance below. |
| Timeline and APME activity continuity | Timeline handover cache and rebuildable activity projection exist. | Authenticated peer snapshot capture before Swift stand-down exists. | Verify both transfer directions at current revision, including failed/empty capture and strong-identity dedup. Activity projection is not full APME database/correction migration. |
| APME review, native judges and storage management | Implemented; disposable-store parity and rollback tests. | Corresponding review/storage/judges; external execution has retained exceptions. | Private source DBs stay separate. No equivalence claim for editing another owner's original rows; provenance and report navigation across the merged projection require integrated acceptance. |
| Relay hub/worker | Native sockets, explicit Keychain target and supported-control refusal. | Node hub/worker. | Two-Mac Node↔Swift relay and installed ATS acceptance exist. This is a cross-machine transport test, not a test of same-Mac daemon ownership transfer or automatic relay-target migration. |
| Serial/Wi-Fi ESP32, Stream Deck/Ulanzi hosts and same-LAN Android | Supported native transports; device-specific gaps below. | Existing modules and the same vendor plugin clients. | Owner must release serial/BLE and stop sending before its successor starts. Current full-fleet takeover, bounded reconnect, dedup and wake acceptance are incomplete. ADB is separately external. |
| Pixoo single/Tide/baked and Timebox/iDotMatrix | Native implementations; baked RGB parity and Debug-module physical loop/dim/wake/Tide restoration accepted. | Corresponding render/upload paths; common baked core. | Current signed installed Pixoo port is not accepted/delivered by this audit. Cross-owner settings, upload cancellation and exclusive BLE/HTTP production remain open. |
| Surface Feed/Outbox, OTA and bundled packs | Native routes and owner-local staging/persistence. | Corresponding Surface routes. | Pairing-token and local Feed receipt continuity are implemented. In-flight acceptance below covers synthetic push cancellation and identical pre-staged pull ranges; it does not distribute staged images, migrate source grants or certify X4 hardware. |

Source anchors for the identified gaps: [app-owned paths](../apple/AgentDeck/App/AgentDeckPaths.swift),
[Settings owner gates](../apple/AgentDeck/UI/Settings/SettingsScreen.swift),
[Pixoo local save](../apple/AgentDeck/UI/Settings/PixooSheet.swift),
[native pin store](../apple/AgentDeck/Daemon/Session/SessionOrderStore.swift),
[Node pin store](../bridge/src/session-order-store.ts),
[native Pocket persistence](../apple/AgentDeck/Daemon/Server/PocketAutonomy.swift),
[Node Pocket persistence](../bridge/src/pocket-autonomy.ts),
[native calendar credentials](../apple/AgentDeck/Daemon/Server/CalendarConnection.swift),
[Node calendar configuration](../bridge/src/calendar.ts),
[Node OpenCode controls](../bridge/src/opencode-client.ts) and
[native read-only OpenCode client](../apple/AgentDeck/Daemon/Session/OpenCodeSSEClient.swift).
The [Node adapter](../bridge/src/adapters/opencode-adapter.ts) uses the client for
observation and abort; the answer/message methods were found in the library/tests
but not a production caller in this revision. Do not promote those methods to a
completed Node control feature without route-level evidence.
These are absent transfer/routing paths in the inspected source, not newly
reproduced data-loss incidents. Do not copy secrets or read another container to
close them; define the authorized owner/configuration and minimized state contract.

### Retained boundaries, explicit deferrals and unfinished work

| Classification | Scope | Effect on parity work |
|---|---|---|
| Existing self-contained product boundary | Managed PTY/session launch, arbitrary lint/build/test execution, CLI reference judge and terminal injection; current ADB, OpenClaw CLI and firmware toolchain integration. | Keep the external execution paths described below. HTTP control, native process evidence and native OTA are separate portable capabilities; do not mark those external merely because the current implementation is Node. |
| Vendor/platform boundary | Elgato/Ulanzi hosts; macOS/iOS UI versus Windows/Linux host services; development-only Dot distribution. | Preserve the applicable hosts and distribution gates. Vendor JavaScript does not require a Node daemon. |
| Credential/source safeguard | Independent source grants, private APME stores, Claude account-quota accuracy/authorization policy. | Never export credentials or fabricate quota for parity. Claude quota remains source-contract research, not a completed native feature or proof of structural Node necessity. Independent storage does not waive the user-visible continuity gaps above. |
| Explicit user deferral | Current X4 feed/feedback/pixel hardware acceptance, until companion-app integration. | The implementations remain required and implemented; the physical scenario alone is deferred. |
| Conditional demand | Kiro v2 SQLite schema/reader acceptance. | Confirm active use or a representative fixture. Conditional status does not establish an agreed permanent functional exception. |
| Unfinished acceptance, not exceptions | Private GitHub reads, trusted Codex hold decisions, TC001/TRMNL/D200X hardware/release checks, installed Pixoo and the remaining cross-feature/device lifecycle checks below. | Keep open with artifact/device-specific evidence. D200X encoders are unshipped scope, not implied by keypad support. |
| Actual implementation gaps, not exceptions | OpenCode native HTTP primitives and shared control integration, active-owner settings routing, signed cross-store pin continuity and the missing state/configuration-transfer contracts. | Prioritize as parity work; existing observation-only consent does not authorize new control or credential sharing. |

### Startup, shutdown, restart and handover evidence

The in-flight contract distinguishes transferable data from process-owned waits.
Held approvals end undecided when their owner stops; an old request ID must never
answer a replacement gate. Push OTA is aborted on owner loss and requires a new
transfer ID, while pull OTA resumes only against the same product/channel and
content digest already staged on the new owner. Staged-image distribution is a
configuration-continuity concern, not permission to resume against different
bytes. Feed continuity transfers only the active owner's aggregate Pocket state
and opaque bounded receipt hashes, never card copy, queued prompt text or source
credentials. A different existing local profile is preserved before adoption;
unrelated historical aggregates are not blindly added together. Checkpoint
generation/sequence and durable acknowledgement fence replay and late delivery.
Actual machine sleep requires a dedicated second Mac. The user deferred full
sleep/wake acceptance after the first sleep request; no actual wake/restoration
pass is claimed. Suspending the shared host remains outside this verification.

Display-only sleep is separately accepted (2026-11-01). After initial wire-only
checks, a current 1.9.5 Dot Preview Release derivative, signed with Developer ID
and Sandbox enabled, served real Pantone and Lenovo clients on private ports.
Only those clients' USB reverse tunnels were temporarily redirected; the shared
daemon continued serving the other devices. Independent CG timestamps measured
these observed off/on delays in milliseconds:

| Isolated configuration | Pantone LED power off/on | Lenovo brightness off/on |
| --- | ---: | ---: |
| Swift only | 440 / 847 | 245 / 663 |
| Node only | 239 / 841 | 237 / 848 |
| Node owner + Swift client | 398 / 1,001 | 241 / 1,055 |

Swift now observes workspace display notifications, with a 2s repair poll;
Node samples CG every 250ms and briefly rechecks independently observed presence
after wake. Observed locks remain authoritative; slow power probes do not block
completed presence observations. The 15s wire repair remains. Initial sampling
follows callback registration, retired helper output is fenced, and display wake
does not reset live transports. Actual system resume still owns device recovery.

The actual development installation was then updated, preserving its current
1.9.5 Dot Preview UI, signing identity and entitlements. One supported shared
restart applied Node build `2e74dc230e94`. In that installed combined environment,
Pantone off/on measured 314/1,466ms, Lenovo brightness 379/1,486ms and Pixoo
brightness 547/1,514ms. Settings, token, all 11 serial connections, original
lighting presets, USB mappings and all 200 captured timeline rows were preserved.
See [runtime acceptance](devlog/entries/2026-11-01-display-wake-runtime-acceptance.md).
This receipt concerns the display fix, not delivery of every unmerged audit
capability. Full machine sleep, physical producer handover and optical LCD
power-off are not established by these display-only/readback measurements.
The earlier ten-second observation lacked a paired Mac transition timestamp and
was not reproduced; it is not attributed to the 15s repair cadence.

[DaemonService](../apple/AgentDeck/Daemon/DaemonService.swift) implements attach,
yield, bounded teardown and promotion; [Node takeover](../bridge/src/daemon-takeover.ts)
adopts the same-user token before asking Swift to stand down.
[Timeline handover](daemon.md#timeline-handover) and APME activity capture are
explicit transport paths, not shared-directory assumptions.

| Scenario | Current real-process acceptance | Remaining acceptance scope |
|---|---|---|
| Swift cold start; quit; relaunch with Node absent | Signed alternate app, own sandbox data, private ready endpoint; token and synthetic prompt/completion history retained. | Actual source grants, all feature stores and hardware shutdown. |
| Node cold start; stop; restart with app absent | Actual CLI foreground process, scoped stop/start and CLI restart; token and synthetic history retained. | Installed supervisor, configured providers and real hardware. |
| Node first, then app; quit/relaunch client app | App attaches without a TCP listener; quitting/relaunching it leaves the same Node owner running. | Full roster/control/settings coverage and physical module writers. |
| Swift first, then Node; later stop Node while app stays | Same app PID yields, Node takes over, and Swift recovers after scoped Node stop; token/history survive both directions. | Source/configuration continuity, receiver selection and real device writers remain separate; adaptive feedback and OTA handover now have the signed acceptance below. |
| Node restarts or crashes during concurrent use | Real CLI restart returns the app to client mode; SIGKILL of the owner permits bounded Swift recovery. | Live relayed providers, network loss and device write deduplication. |
| Both start together; client app crashes | Converges on Node ownership; client app SIGKILL/relaunch leaves the owner intact and does not create a second listener. | More scheduling/platform variants and hardware contention. |
| Incoming Node dies after Swift stands down | Real negotiating Node killed in the no-listener interval; same Swift app recovers after the shared yield lease, without an indefinite wait. | Real resource-hang conditions; late callbacks remain covered by injected epoch/cancellation tests. |
| Ownership changes during agent turn, approval, Feed feedback or OTA | Signed Release lab: approvals end undecided, old IDs and stale Outbox answers expire; aggregate feedback/receipts survive both directions and relaunch; push OTA retires IDs and pull bytes match when identically pre-staged. | Arbitrary queued control execution, provider/source context and physical install acknowledgement are not implied. See P1.2/P1.3 and deferred X4 acceptance. |
| Port change, sleep/wake, LAN/Tailscale loss while both are open | 12-second SIGSTOP/SIGCONT keeps the occupied Node listener authoritative; retry converges after explicit unknown/503. Additional SIGKILL during a held approval restores Swift ownership and the confirmed Feed receipt. Existing Hermes/Pixoo/ATS receipts remain valid. | Actual full wake was deferred by the user; LAN/Tailscale partitions, receiver port changes across every feature, physical single-writer and brightness/provider recovery remain separate acceptance. |

The opt-in [real-process runner](../scripts/verify-daemon-lifecycle.mjs) and
[preparation procedure](testing.md#signed-swiftnode-lifecycle-acceptance) use
19450–19459, separate Swift-container and Node HOME/data stores, loopback-only,
no-device posture and Gateway opt-out. The complete current app is copied to an
alternate bundle identifier and Developer-ID signed with App Sandbox; the copied
provisioning profile/WeatherKit entitlement is excluded for that local identity.
This is not a replacement of the installed app or Store approval. Normal app quit
uses the AppKit termination path; deliberate crashes use SIGKILL. The runner
rejects an installed app path and verifies PID/executable/data scope before
signalling, inspects client listeners and shared-window sockets, and fails if its
private ports cannot be cleaned up. Pairing token values are never in receipts.

**2026-10-31 signed Release receipt:** all six runner scenarios passed with Node
v26.5.0/build `8ce6a06f7af9` and the branch's macOS Release 1.9.4/build 5 derivative
(executable SHA-256 prefix `907b7d0ebcee`). Swift-only quit/relaunch: 2.362s;
Node-only stop/start/restart: 2.412s; Node-first/restart/crash recovery: 44.497s;
Swift-first/takeover/return: 40.982s; concurrent start/client crash: 2.827s;
failed incoming takeover: 182.082s. These are **whole-scenario durations**, not
individual failover latency guarantees. The last case retains the production
147s yield lease plus normal monitoring/recovery; it is bounded, not instant.
The signed derivative also passed the App Store bundle invariant checker, without
claiming Store delivery. Local raw evidence is under
`diagnostics/lifecycle-integration/run-release-4/` (`artifact.json`, `owners.json`,
`results.json`); successful exit includes private-port cleanup. The runner keeps
one WS client per owner to respect the existing reconnect-flap policy. It checks
the existing Hermes completion shapes (Node response / Swift turn-end summary)
without rewriting their types during handover. Failure injection observes both
owned processes with no TCP listener; HTTP silence alone is not treated as
stand-down. The Quick suite passed 7,138 tests; the normally opted-out macOS Node
E2E was separately run with the Keychain-denying shim (30 tests passed).
All five changed-area Apple configurations passed: macOS Debug (1,458 tests,
5 skipped), macOS Release, iOS simulator Release, macOS DotPreviewRelease
(1,476 tests, 10 skipped), and iOS simulator DotPreviewRelease. The normal Debug
suite was rerun after the final timeline fix; both macOS suites pass its captured
precision regression. Skipped capability-dependent cases remain skipped evidence.
The shared daemon retained PID 71702/build `8fe2909f2930`; all eight reported
module connection sets, including 11 serial ports, were preserved. This verifies
non-interference, not physical-device handover. The temporary signed apps and
synthetic test stores were removed after process/port cleanup; diagnostic
receipts and filtered synthetic histories remain. The installed app, production
stores, permissions and Rust toolchain were retained.

**Defect exposed by the live repetition:** a returning Node wire snapshot could
duplicate Swift's own prompt/completion rows. Swift persisted fractional
milliseconds but its wire encoder rounded them; the `(ts,type,raw)` rehydrate key
then treated the returning integer timestamp as another event. Swift storage now
uses the existing wire timestamp normalization before insertion and merging,
including legacy fractional rows. A captured-precision
[regression](../apple/AgentDeckTests/TimelineCrossDaemonFormatTests.swift) covers
both rounding directions; the live runner requires exactly one prompt and one
completion through handover. Isolation fixes also give Swift the same generated
port-window policy as Node and honor the Gateway opt-out without one final probe
after cancelled sleep. Normal default discovery remains 9120–9139.

[DaemonTopologyTests](../apple/AgentDeckTests/DaemonTopologyTests.swift) and the
injected startup/attach/cancellation suites still cover sequences and epoch
edges that a real-process run cannot force deterministically. A separate test
fleet is required for exclusive-device and in-flight scenarios; do not repurpose
shared 9120 or reset permissions to complete them. Timeline/token continuity alone does not close session pins, consent or settings
transfer. Pocket aggregates and receipts now have the narrower local checkpoint
contract above; an absent receiver and inactive-history reconciliation remain
explicit configuration/recovery work.

### In-flight handover acceptance (2026-10-31)

The opt-in `--inflight` lab uses a Developer-ID-signed, sandboxed Release
derivative, private 19450–19459 listeners and synthetic sessions/firmware. It
never flashes a board or substitutes the installed app. The native/Node
checkpoint tests share receipt/authority vectors and preserve corrupt files
instead of resetting them. See the [contract](daemon.md#aggregate-feed-and-in-flight-handover)
and [repeatable lab procedure](testing.md#signed-swiftnode-lifecycle-acceptance).

The integrated scenarios cover an unconfirmed replica (503, local durable state
retained), response-loss retry without a second feedback increment, prepare-lease
expiry, both approval/Feed owner directions, a silent but occupied Node listener,
retired OTA push IDs and reconstruction of identical pre-staged pull bytes.
Temporary 503 during reconnect is an explicit unknown, followed by bounded retry;
it is not a successful receipt until the native replica confirms storage.
These Feed receipts cover adaptive feedback and replay outcomes. Portable control
dispatch still means accepted for delivery, not cross-owner exactly-once execution;
queued command transfer and end-to-end execution acknowledgement remain P1.3.
This acceptance must not be used as proof that arbitrary queued prompts survive.

**Verification:** the final signed Release derivative passed six integrated
scenarios; an additional selected replay SIGKILLed Node with an approval held and
recovered the confirmed feedback/receipt in Swift. Stale Outbox approval replies
returned `expired`. Quick passed 7,149 tests (17 skipped); the current default
macOS suite completed 1,467 tests (5 skipped, zero failures); real Node CLI E2E
also passed all 30 tests with a test-only Keychain substitute. macOS Release,
iOS, optimized Dot
macOS and Dot iOS artifact/build gates passed, as did the signed App Store
artifact check. Checkpoint/aggregate files were separately inspected for forbidden
raw fields. Raw receipts stay local under `diagnostics/lifecycle-inflight/`. The shared Node
PID/build, eight module sets, eleven USB serial connections and D200H connection
matched the baseline. Local temporary apps/build/data were removed (at least
1.67 GiB); the existing Rust toolchain and installed app were retained.

A cold restart without a current peer starts a new authority lineage, retaining
its local data. This prevents a peer that advanced while it was absent from
permanently refusing a legitimate new owner. It does not merge conflicting old
profiles. The strict HTTP replay also exposed and fixed duplicate Content-Length
and Connection headers in Swift's pull-OTA route.

Actual sleep/full-wake restoration was **deferred by the user** after a software
sleep request on SBMacBookPro. No full-wake or physical restoration pass is
claimed. Its private runner releases its temporary process after the elapsed
fixture deadline when that Mac next wakes; remote file cleanup is not confirmed
while it remains unreachable. Power policy and the installed app were not changed.
X4 remains deferred to companion-app integration; exclusive physical writers,
network partitions and provider/configuration continuity retain separate gates.



### Same-project deck names (#544)

`SessionInfo.displayName` is a presentation hint, never an identity, folding or
command target. Node reads Claude registry names (explicit user name, then a
matching transcript custom title, then other registry names), then a file-only
Git branch fallback. Swift standalone has no Claude-folder grant and emits an
explicit empty hint; its existing short-ID label remains valid. When attached
to Node, the app consumes Node's hint unchanged. No subprocess or new home access
is added to the Store app. Both deck engines show hints only for same-project,
same-agent collisions and retain the short ID even for unique friendly names,
so narrow or duplicate titles cannot hide the recipient's identity. This is a
source-access difference, not a structural Node dependency; a future explicit
read-only folder grant could supply the same field without a wire change.

The contract, measured sources and acceptance are recorded in
[the daemon contract](daemon.md#same-project-display-names).

Verification: Quick passed 7,159 tests (17 skipped). The default macOS suite
completed 1,468 tests (5 skipped, zero failures); optimized Dot macOS completed
1,486 (10 skipped, zero failures). Unsigned macOS Release, iOS Release and Dot
iOS builds and the native artifact boundaries passed. Shared renderer inspection
also fixed the INFO corner pill covering a tagged title. These are source/build
and synthetic-render receipts, not installed-app or physical D200X acceptance.
The shared daemon retained PID 71702/build 8fe2909f2930, eight module sets,
eleven USB serial connections and the D200H link. Isolated Claude probe files
were removed; the existing Rust toolchain and installed app were retained.


### Session-pin and Pixoo ownership continuity (P1.2)

The bounded implementation carries only normalized session-order pins and Pixoo
IP/name/brightness/animation/explicit discovery preference through the admitted
same-machine checkpoint. Settings editors target the active local daemon with
revision checks; inactive files are not a second writer. Preserve unrelated
settings and archive the inactive supported configuration before peer adoption.
Credentials, source grants and unknown settings keys never enter the checkpoint.
Opt-in cold recovery has the separate contract below. Calendar/provider/relay
consent and staged-image distribution remain separate P1.2 work.

Signed Release sandbox acceptance (2026-11-01) uses a separate bundle ID,
synthetic settings and loopback ports 19450–19459 with hardware modules disabled:

| Configuration | Verified result |
|---|---|
| Swift only | Pin set/change/clear reaches the actual roster; Pixoo edits and pins survive app relaunch. Real CLI add/remove reaches Swift without changing the inactive Node file. |
| Node only | Pins and Pixoo edits survive restart. Cross-origin writes and an older subscribed replica are refused without changing settings. |
| Node first, then Swift client | Client relaunch retains the owner view; Node shutdown promotes Swift with the latest settings. Explicit device removal/unpin remains cleared after native relaunch. |
| Swift first, then Node | Repeated Swift→Node→Swift→Node handover retains edits, followed by a Node-only restart. Missing handover capability and stale revisions are refused. |

All four isolated scenarios pass. Local extra fields and unrelated root settings
remain local; corrupt existing settings/pin records refuse export or overwrite.
Shared validation/revision vectors and native editor HTTP round trips pass.
Quick verification and all five native configurations pass; macOS XCTest reports
1,472 cases (5 skipped), DotPreview 1,490 (10 skipped), with no failures. The
signed fixture passes the App Store artifact verifier; this is local acceptance,
not distribution approval. Actual settings-window clicks remain unverified after
the computer-use service timed out. The installed app and shared daemon/devices
remain in place; no physical Pixoo settings were changed by these fixtures.

### Opt-in cold recovery (P1.2)

The user selected the explicitly authorized local-folder design on 2026-11-01.
The native app retains a security-scoped bookmark; a later ordinary Node launch
finds the explicit consent marker at the known location. A shared,
transactional checkpoint stores the existing minimized settings, Pocket aggregates
and opaque receipts. It excludes credentials, grants, prompts and original records.
Recovery uses a committed revision rather than wall-clock timestamps; unavailable
storage and divergent offline edits must preserve both sides and refuse overwrite.
Implementation and failure boundaries are documented in the
[cold-recovery contract](daemon.md#explicit-local-cold-recovery). The initial UI
uses the known local `Library/Application Support/AgentDeck Recovery` child so a
later ordinary Node launch can discover explicit consent even when Node was absent
during selection. Explicit data profiles have no implicit default discovery.
An older normal-profile disconnect does not override a later app grant.

Signed Release acceptance on 2026-11-01 passes all three isolated scenarios:

| Scenario | Verified result |
|---|---|
| Node client setup, then Swift absent | Setup waits for the new checkpoint writer's durable native ACK. After quitting the app, Node edits/feedback survive its shutdown and restore in Swift, despite the old client inbox. Synthetic feedback replay does not increment the count again. |
| Swift→absent Node→absent Swift | Native configuration accepts the existing scoped grant. Pins/Pixoo edits restore in Node; explicit device removal/unpin restores back in Swift. The same opaque feedback receipt remains deduplicated. |
| Disconnect and native permission boundary | An ungranted path returns 403. Disconnect keeps the SQLite backup byte-identical, and later Node edits do not write the disconnected store. |

The fixture uses an alternate signed Sandbox bundle, synthetic profiles and
loopback ports 19450–19459 with device modules disabled. The final universal
Release and artifact verifier pass. Final recovery/startup/ownership XCTest
selection passes 62 cases; Quick passes 7,185 Vitest cases (17 skipped; the
macOS Keychain-dependent E2E remains opt-in). The five native build/test
configurations also passed during implementation; the final startup-order fix
was rechecked by the 62-case selection, Release and these signed scenarios.
The installed app and shared daemon/devices were retained.

Follow-up signed Release acceptance on 2026-11-01 closes the external-folder and
interactive conflict gates. The alternate Sandbox app used a genuine system-picker
grant to a disposable local folder outside its container; no helper seeded that
bookmark. Ordinary profiles retain known-folder discovery; explicit data profiles
can select a custom local folder configured on both runtimes.

| Scenario | Verified result |
|---|---|
| External selection, cancel and relaunch | Actual system picker creates only the dedicated child; the UI confirms authorization. Cancel preserves the selection. Relaunch without preference/bookmark injection restores access and a ready configuration API. The original external sentinel is unchanged. |
| Node conflict and saved-profile choice | Real Node recovery/checkpoint producers publish a divergent synthetic profile. The signed UI displays it without private-directory access. An outdated preview is refused with no DB change. A refreshed **Use saved Node profile** choice shows pending until producer reconnection; the -9 pin is adopted and its original file backup is byte-exact. |
| Swift conflict and recovery choice | A changed synthetic private pin refuses native recovery and appears in Settings. **Use recovery profile** restores weight 12 instead of -21, ACKs the choice and removes the conflict. The original -21 file is backed up byte-exact; both snapshots remain in history. |
| Disconnect | Actual UI clears the grant and relaunch stays disconnected. SQLite stays byte-identical, with both completed decisions and external original file retained. |

Schema v2 preserves the v1 head and consent during migration. Shared choices are
transactional and producer content checks prevent stale approval replay; neither
history is added to the other. Node/shared focused tests pass 18 cases; native
recovery/configuration tests pass five. Final Quick passes 7,187 tests (17 skipped).
All five native configurations pass, as does the final universal Release and its
signed derivative's App Store artifact check. This is isolated signed-app
acceptance; the installed app and shared daemon/devices were preserved.

### Revised parity priorities

| Priority | Kind | Next bounded result / completion gate |
|---|---|---|
| P1.1 | Baseline and in-flight software acceptance passed; deferrals explicit | Signed isolated approval/Feed/OTA handover, initial-replica failure, prepare expiry, paused-owner recovery and approval/Feed SIGKILL recovery are verified. Actual machine wake is deferred by user request; network partitions and exclusive physical writers still need a separate fleet. Do not block P1.2 on a deferred gate or label it passed. |
| P1.2 | Remaining consent/configuration and recovery acceptance | Live-peer Pocket aggregate/receipt, session-pin and Pixoo handover and opt-in committed cold recovery are implemented. Signed external-folder grant/relaunch and explicit divergent-profile reconciliation are now verified. Next: remaining calendar/provider/relay grants and staged-image distribution. Keep consent scope explicit; never silently copy secrets or add unrelated aggregate histories. |
| P1.3 (formerly P2.5) | Portable control primitives and shared integration | First trace and specify the actual Node/Swift product control routes, server selection, explicit consent and credential custody. Complete permission/question replies and messages with session/directory identity, stale-ID refusal, timeout and delivery acknowledgement. Node client methods alone are not an integrated feature. Keep the observer plugin observation-only. |
| P2 acceptance | Artifact/provider/hardware | Match the tested source to a signed installed Pixoo app and verify settings/relaunch/physical behavior. Retain #544 friendly-name D200X key/INFO/VOICE recipient acceptance, private-GitHub, trusted Codex approvals and TC001/TRMNL/D200X gates; these are not closed by algorithm parity. |
| Conditional / deferred | Source or device dependency | Claude quota source-contract research; Kiro v2 when demanded; X4 only at companion-app integration; Dot remains its own distribution track. |

The original P1/P2 implementation receipts below remain valid within their stated
scope. This ranking supersedes the earlier suggestion to start a new optional
OpenCode control proposal immediately after Pixoo; it does not reopen successful
component checks or authorize disruptive verification on the shared fleet.

## Swift parity priorities — source assessment 2026-10-31

The current source/evidence audit is pinned to `3a5c9394`; the
[three-configuration audit and revised priorities](#three-configuration-parity-audit-2026-10-31)
above supersede the earlier `d81b77bf` assessment. The original P2 implementations,
ATS correction in `099da989` and dated installed relay acceptance remain recorded
below. Completed implementation, software parity, signed components, installed
artifacts and full lifecycle acceptance are separate states. No Yes or implemented
label below closes the new continuity/configuration or live-acceptance gaps.

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

### Original P2 increments — implementation receipts

These historical identifiers retain the scope of each completed implementation.
The [revised priorities](#revised-parity-priorities) now distinguish missing
implementation and continuity from unperformed three-configuration acceptance.
No production database, credential, daemon or device is changed by this assessment.

| Priority | Capability and source evidence | Native increment | Completion gate / dependency |
|---|---|---|---|
| P2.1 — implemented | APME retention and storage management: [shared policy](../shared/apme-retention-policy.json) generates [Node](../bridge/src/apme/retention-policy.generated.ts) and [Swift](../apple/AgentDeck/Daemon/Apme/ApmeRetentionPolicy.generated.swift) constants and SQL predicates. | Native Full report → Storage implements file/page capacity, read-only preview, confirmed payload-only cleanup and separate compaction against the app-owned database. | Actual Node/Swift SQLite fixtures match preview values, UTF-16 marker bytes and all final rows. Native store/API/UI tests cover retained history/corrections, stale preview refusal, explicit local-only confirmation, both-table rollback, multiple batches, WAL, busy/deadline behavior and compaction. A forced slow cleanup rolls back while an incoming record survives. Only disposable stores are pruned; large operations may be refused by the native time budget. |
| P2.2 — implemented | Antigravity JSONL observation now uses a [shared policy](../shared/antigravity-observation-policy.json), [Node reader](../bridge/src/antigravity-observation.ts) and [Swift reader](../apple/AgentDeck/Daemon/Session/AntigravitySourceReader.swift). | Native Session Observation selects a read-only transcript root, restores its scoped bookmark after relaunch, and identifies conversations and explicit USER_INPUT steps. The account/plan database grant is preserved separately. | Actual Swift/Node parser and filesystem parity, native consent/renewal/revocation tests and a development-signed sandbox app with an external disposable transcript folder. Live WebSocket evidence covers RUNNING/DONE, new turns, rotation, malformed tail, disappearance, stale and relaunch/removal. Live CLI verification exposed DONE-only JSONL; direct read-only SQLite activity now supplies explicit WORKING/IDLE, with shared schema/identity/freshness guards. See the signed live acceptance below. No PERM, control, Stop/APME import or process-liveness claim. |
| P2.3 — implemented | ICS calendar ingestion now uses [shared policy](../shared/calendar-policy.json), [Node provider](../bridge/src/calendar.ts) and [native provider](../apple/AgentDeck/Daemon/Server/CalendarProvider.swift). | Native source/share consent, non-synchronizing device-only Keychain URLs, bounded HTTPS and in-memory recurrence expansion supply Feed/Glance and agenda cards. | Actual Node/Swift parser, URL and cache vectors match, including timezone/DST and exceptions. A signed sandbox fixture verifies real Keychain and HTTP/cache/failure parity; [signed Release Settings acceptance](#signed-ics-settings-acceptance-2026-10-31) also verifies consent, save, relaunch restore and disconnect through the UI. Pocket remains aggregate-only. X4 physical acceptance stays deferred. |
| P2.4 — implemented | Pixoo baked aquarium `animation: "loop"` uses [shared bounds](../shared/pixoo-loop-policy.json), the canonical art/layout renderer and generated fixed code in Node and system JavaScriptCore. | Native scheduling, one-pack cache, frame-by-frame LAN upload, failed-loop cooldown and dim/wake handling. The animation picker preserves other device settings. | Actual Swift/Node RGB parity and module/HTTP regressions cover layout, palindrome playback, packing, cadence, cancellation and unknown/error refusal. The owner confirmed real Pixoo motion and dim/wake restoration. See [acceptance](#native-pixoo-baked-loop-acceptance-2026-10-31). |
| P2.5 — open; reprioritized P1.3 | OpenCode server API answers/messages: Node [client](../bridge/src/opencode-client.ts) has `respondPermission`, `replyQuestion`, `rejectQuestion` and `sendMessage`, but this audit found no production answer/message caller. Native [SSE client](../apple/AgentDeck/Daemon/Session/OpenCodeSSEClient.swift) implements the read-only subset. End-to-end HTTP controls remain an integration gap, not proven Node behavior. | First specify explicit user-run server selection, credential custody and opt-in control consent. Then bind directory/session and actionable permission/question IDs to bounded HTTP requests. HTTP makes this technically portable; observation alone is not authorization. | Actual server API contract and CLI version fixtures, pending/stale ID refusal, directory isolation, reconnect and delivery acknowledgement. Preserve the installed observer plugin's observation-only contract; no terminal-injection fallback. Relay v1 unsupported-control refusal stays intact unless deliberately versioned. |

P2.1 APME retention is implemented; [its contract and disposable-store verification](apme.md#swift-보존용량-관리-2026-10-31)
cover size/status, read-only preview, manual prune and separate compaction. Actual
user databases were not pruned. P2.2 Antigravity now has native read-only observation;
[the source contract](architecture.md#antigravity-transcript-observation) defines its
evidence limits. P2.3 ICS ingestion and P2.4 Pixoo baked loops are also implemented; OpenCode controls remain an implementation gap, now **P1.3** behind the lifecycle and continuity work above. Explicit control consent is still required.

### Antigravity signed-app acceptance (2026-10-31)

A separate development-signed standard Release app used bundle ID
`bound.serendipity.agent.deck.antigravity-observation-audit`, loopback port 56435
and disabled device modules. Its system folder picker granted read-only access to
an external disposable real-shape JSONL root. Relaunch restored the scoped bookmark
without another selection and retained conversation/turn IDs, millisecond start
time and display metadata. The actual WebSocket roster and content-free diagnostic
matched Node's file projection for RUNNING, DONE, malformed tail and stale evidence.
New USER_INPUT and reused-index rotation changed turn identity while preserving the
conversation identity. Missing files withdrew the row. Stop observing removed the
grant and roster; the earlier signed Debug check also confirmed it stayed off after
relaunch. The Release source hash stayed unchanged during reads; anonymous diagnostic
requests were refused, while token and bearer requests succeeded.

This is signed sandbox fixture acceptance, not a fresh live Antigravity CLI turn or
Store distribution acceptance. At that earlier fixture checkpoint, local CLI/IDE transcripts were historical.
The local signing copy retained Sandbox/bookmark entitlements and omitted WeatherKit;
no WeatherKit verification is claimed. The installed app was preserved. The shared
Node daemon retained its PID/build and existing device connections; the temporary
app's observation grant was removed and its process stopped after verification.

### Antigravity live CLI acceptance (2026-10-31)

This subsection records the JSONL-only baseline before the direct SQLite activity
reader described in the next subsection.

The installed `agy` CLI ran two successful print-mode invocations in a disposable
workspace with `gpt-oss-120b-medium`, sandbox restrictions and no permission bypass.
The first read one test file and returned a numbered response; the second resumed
the same conversation and returned another response without tools. A separate
sandboxed, development-signed standard Release app read the actual CLI root through
its system folder picker. The installed app and shared Node daemon were preserved.
Comparison used the checkout's Node reader against the same actual files, not an
updated installation of the shared daemon.

| Check | Actual result |
|---|---|
| Conversation identity | Both CLI results reported the same conversation; Swift and Node kept the same `observed:antigravity:<id>` session. |
| Turn identity | USER_INPUT indices 0 and 4 produced distinct timestamped turn IDs; both appeared in the signed app's observation snapshots. |
| Display and exit | The signed dashboard showed the real project/model. After both CLI processes exited successfully, Swift's actual WebSocket roster and diagnostics matched Node's idle state, goal/model/project metadata and timestamps. |
| Unknown | After CLI exit, temporary read denial on only the newly created test transcript produced unknown and an empty test-session roster in both implementations. Restoring access restored the same session and turn. |
| Stale | Moving only that file's mtime two hours into the past triggered the existing history lease in the signed app and Node, withdrawing the test session. This was accelerated metadata expiry, not a two-hour wait. |
| Restoration | The transcript's SHA-256, original mode and nanosecond mtime were restored; neither old conversations nor transcript contents were changed for fault injection. |
| Live WORKING | **Not verified successfully.** The CLI emitted ACTIVE stream updates, but all seven persisted steps across both turns were DONE. Both file observers reported idle during the live response. File parity therefore does not prove live execution-state accuracy. |

The RUNNING fixtures above still verify that supported RUNNING records produce
processing. They do not establish that this installed CLI actually writes such
records. Its stream-only ACTIVE signal cannot be reconstructed from process
presence, a recent mtime or a prior DONE step. Live activity observation
was subsequently implemented from the CLI conversation SQLite step status, read directly
under the existing folder grant. ACTIVE stream events were observed alongside
`GENERATING(8)` in `steps.status`; the final step became `DONE(3)`. The reader must
bind the DB conversation/user-step timestamp to JSONL identity, handle WAL and
refuse unreadable, stale or mismatched evidence. This is explicit DB state polling,
not a subprocess or a heuristic based on process/file recency.
The implementation preserves the app's self-contained/no-subprocess boundary. No APME Stop,
permission attention or task-completion event is inferred from this test.

### Direct Antigravity SQLite activity (2026-10-31)

The native and Node readers now combine JSONL conversation/turn identity with
explicit activity in `conversations/<id>.db`. The actual CLI's ACTIVE stream was
observed alongside stored GENERATING(8). Both readers also accept explicit Cortex
RUNNING(2); DONE(3) supplies idle. No CLI child
process, stdout relay, Node service, hook installation, cloud Remote Control or
additional credential is used by the app. The existing read-only folder bookmark
covers the source. This is bounded direct state polling rather than an event socket.

The shared policy generates read SQL, status values and limits for both readers.
Read-only snapshot transactions include WAL, reject mismatched conversation/user
identity or user creation time, and inspect only status/identity and bounded step
metadata. They do not query, decode or expose DB prompt/response columns. A closed WAL store
without frames/journal is read without creating sidecars: Swift uses a per-connection
immutable URI and Node a bounded private RAM image. Both check stable source
fingerprints and refuse stores above 64 MiB on this cold path. Busy, unsupported or
unreadable activity stores are unknown and never fall back to a prior DONE as idle.
A ten-minute ACTIVE lease uses original source time and DB/nonempty-WAL mtime; SHM and poll
time cannot renew it. Native query work is bounded and does not run on the main or
daemon executor. A separate one-second native task prevents the ten-second registry
refresh from delaying or overwriting live activity.

Software acceptance covers real Node/Swift SQLite reads, read-only byte preservation,
WAL with an open writer, busy/locked stores, status changes, malformed metadata,
unknown status, wrong/embedded-NUL conversation IDs, mismatched user timestamps,
future time, stale activity, cold JSONL revival only from fresh explicit DB evidence,
symlink refusal, schema refusal and the bounded user-step search. Native tests also
exercise permission restoration/revocation and authoritative-row precedence.
Development-signed Debug and final standard Release acceptance both showed actual
CLI processing→idle across the slow registry-refresh boundary. The final Release
used the separate audit bundle above, port 56435, disabled device modules and its
system folder picker for the real CLI root. The CLI resumed the disposable test
conversation, used sandbox restrictions and returned 350 numbered lines without
tools, then exited successfully. Comparison ran the checkout's Node reader against
the same sources; the shared Node installation was not updated.

| Final signed Release check | Result |
|---|---|
| Live WORKING | ACTIVE stream → actual WebSocket WORKING in 268 ms in this run; 15.532 seconds until IDLE. The dashboard visibly changed WORKING→IDLE. |
| Exit and parity | CLI result → WebSocket IDLE in 109 ms. Thirty-nine paired samples reported processing in both readers; WORKING and IDLE wire projections matched session ID, project, model, goal, start time and observed-control metadata. These are measurements, not latency guarantees. |
| Read-only cold WAL | An actual ACTIVE SQLite backup retained its WAL header but had no WAL/SHM files. With DB mode 0444 and directory 0555, the signed app read it first, before Node; it reported processing without creating sidecars or changing the DB hash. |
| Unknown and recovery | Read denial on only that disposable DB produced unknown in both readers and withdrew its WebSocket row. Restoring read permission restored WORKING with unchanged turn identity and source timestamp. |
| Relaunch | The same signed app restored the read-only bookmark, turn identity, source timestamp and WORKING without another folder picker. |

The same unchanged ACTIVE backup was observed through its real ten-minute lease.
Both readers reported stale (`unconfirmed_work`) 124 ms after the source deadline;
the signed app withdrew its WebSocket row after 685 ms. No clock/source timestamp
was changed, the DB hash stayed identical and no sidecars appeared. Stop observing
removed the grant and stayed disabled after another relaunch. The temporary app,
owned diagnostic clients and source copies were then removed.

The local signing copy retained Sandbox/bookmark entitlements and omitted WeatherKit;
this does not claim Store distribution or WeatherKit acceptance. The installed app
and actual user records were preserved. The shared Node daemon kept PID 74712 and
build `9135833a2ad5`; its ADB, serial, Android, Stream Deck, ESP32 Wi-Fi, BLE and
D200H connections were retained.

### Native ICS calendar acceptance (2026-10-31)

[The source contract](architecture.md#ics-calendar-context) owns the supported
recurrence subset, consent, URL custody and freshness rules. Native Settings now
requires explicit source/share consent and keeps private URLs only in a
non-synchronizing, device-only Data Protection Keychain record. Nothing is imported
from Node plaintext settings. Disconnect revokes access before Keychain deletion,
invalidates cached/late projections and stays disabled when deletion fails. A queued
save intent cannot undo a newer revocation. An instance-ownership regression test
also checks that retired daemon teardown and projections cannot invalidate a
replacement instance's calendar context.

Software parity executes both actual parsers/providers on 42 recurrence/timezone
vectors, 19 URL cases and four cache sequences. Cases cover IANA/UTC/floating forms,
DST gaps/overlaps, weekly intervals, month-day/ordinal rules, leap dates, inclusive
UNTIL, exact EXDATE/RECURRENCE-ID, moved/cancelled instances, all-day exclusive ends,
UTF-8 and unsupported/malformed input. Cache vectors compare request counts as well
as events, status and original fetchedAt: current-clock filtering, 30-minute refresh,
one-minute failure backoff, last-good stale data for less than six hours, clock
rollback, source changes and disablement. Node's former literal-TZID and date-only
exception behavior was corrected in the shared contract.

A separate signed sandbox executable linked the production Calendar connection,
transport, parser and provider classes. It used the existing registered development
profile and only UUID-owned test Keychain/consent keys; it did not replace, launch or
reconfigure the installed app. A loopback server supplied synthetic events only.

| Actual signed/native and Node check | Result |
|---|---|
| Consent and custody | Before consent the native provider was disabled and made no request. After consent the URL was saved to real Data Protection Keychain, with no plaintext URL in UserDefaults. |
| New-process restore | A second signed process restored the URL from Keychain and fetched the same event. Each process fetched once; a second call used its memory cache. Node returned the identical event projection. No feed copy was persisted across processes. |
| Revoke and remove | Disconnect withdrew the saved projection, disabled access and deleted the test Keychain item. All test consent keys were removed. |
| Redirect | Both actual clients refused the redirect; the destination received zero requests. |
| Size and silence | Both rejected a body over 1 MiB. The silent source returned unknown after about 8.006 s in Swift and 8.003 s in Node; these are measurements, not latency guarantees. |
| Ambient credentials | The source received no Cookie or Authorization header. Error reporting contains no source URL or underlying secret-bearing error text. |
| Pocket | Native calendar-derived agenda cards entered the existing producer and delivery path; their learning file contained neither event title, UID, URL nor raw feed. Existing Feed/Outbox and conditional/OTA-first tests remain in place. |

The unsigned XCTest host cannot use the Data Protection Keychain and explicitly
skips that OS-custody test on `errSecMissingEntitlement`; the signed acceptance above
covers it. This initial checkpoint built/tested the UI and native integration, but
did not exercise Settings interactively or deploy the product. The subsequent
[signed UI acceptance](#signed-ics-settings-acceptance-2026-10-31) closes the Settings gap. No new profile, App Group,
ATS arbitrary-load exception or external helper was added to the app. Custom
VTIMEZONE rules and unsupported recurrence modifiers are omitted; this is a bounded
subset, not a full iCalendar engine. X4 physical acceptance remains deferred to its
companion-app integration. Local evidence: `diagnostics/ics-calendar/` (gitignored).

The complete Node suite passed with bounded concurrency: 7,091 tests passed and
17 were skipped. The preceding default-concurrency Quick run had three unrelated
failures in serial-probe timing, APME history-worker deadlines and an OpenCode
observer assertion; all three files passed in isolation and the subsequent complete
suite passed. The other Quick gates and the final document gates passed. All five Apple gates
also passed: macOS Debug/XCTest, standard macOS Release with Dot exclusion, iOS
Release, macOS DotPreviewRelease/XCTest and iOS DotPreviewRelease with their artifact
boundaries. The shared port-9120 daemon retained PID 13956 and build `12fa71c8e515`; all 11 serial ports,
ADB/dashboard/Stream Deck/Wi-Fi device lists and connected modules were unchanged.
The synthetic-source server and temporary signed probe bundle were removed.


### Signed ICS Settings acceptance (2026-10-31)

Source commit `ca6af8d1` was exercised as a complete universal **Release** app with
Development signing and App Sandbox enabled. This used the actual Settings view,
Calendar connection/provider and authenticated Feed route, not the earlier linked
class fixture. The app was copied to a temporary path with a separate audit bundle
identifier, preferences, data container and calendar Keychain service. The existing
registered development profile/app identifier was retained for real Data Protection
Keychain access; no profile, keychain access group or broader security permission
was created. WeatherKit was omitted for local signing. This is local signed-app
acceptance, not a Store distribution artifact or an installed-app update.

The Swift daemon ran on a temporary loopback port with device modules disabled.
Only a loopback synthetic ICS source was configured; no personal calendar was read.
Native UI automation observed and operated the actual controls:

| Step | Observed result |
|---|---|
| Consent off | Typing the source URL left **Save calendars** disabled. An authenticated Feed read had no events or agenda card and made zero requests to the source. |
| Consent and save | Checking the source/share checkbox enabled Save. Clicking it displayed **Configured · 1 calendar sources** and cleared the secure input. The actual Keychain query found the item; the Sandbox preferences held the consent boolean and no plaintext URL. |
| Live ingestion | The authenticated Feed contained the synthetic event and a Pocket agenda card; Settings updated to **fresh**. |
| Quit and restore | The first app PID exited. A newly launched process displayed the configured source without retyping or rechecking consent. Its Feed fetched the event once; a second pull used the memory cache. The checkbox is consent for a new save, so its unchecked initial view does not revoke the saved connection. |
| Disconnect | Clicking **Disconnect calendars** displayed **Not connected**. The consent boolean became false, Keychain returned `errSecItemNotFound`, and Feed events and agenda cards disappeared. |
| Relaunch after disconnect | A third app process remained **Not connected** with no events or agenda card. Total source requests stayed at two: one after save and one after restored launch. |
| Pocket privacy | The actual learning file contained no synthetic title, UID, source token or raw VEVENT. Only the existing aggregate learning format was used. |

The shared Node daemon retained PID `17785`, build `12fa71c8e515`, all 11 serial
ports, ADB/dashboard/Stream Deck/Wi-Fi device identities and connected modules.
The existing installed dashboard remained connected to port 9120. Neither the
installed app nor the shared daemon was replaced or restarted. The audit app,
metadata-only Keychain probe, source server, test preferences and daemon data were
removed after verification; the test calendar Keychain item was already deleted
by the UI. Local results, executable hash and before/after responses are under
`diagnostics/ics-ui/` (gitignored). X4 physical acceptance remains deferred to
companion-app integration.

Isolation detail: host `defaults` and Sandbox-container preferences are distinct.
The initial audit launch attached as a client to the shared daemon because the
host-only port preference was not visible inside Sandbox. Only the audit app was
quit; its own Sandbox preferences were then configured and its actual temporary
port/posture verified before the calendar UI sequence. No shared runtime change
was used to obtain a standalone Swift daemon.

### Native Pixoo baked loop acceptance (2026-10-31)

[The source contract](architecture.md#pixoo-baked-aquarium-loops) owns the rendering,
cache and upload rules. Swift runs the app-bundled fixed pixel code through the
system JavaScriptCore framework; no Node process, interpreter payload, remote script
or native host bridge is added. The generated resource and Node source are drift
gated against the canonical artwork/layout renderer and shared policy. Default
single-frame and Tide remain separate; aquarium loops stay explicit opt-in.

Software acceptance executes 36 scenarios with the actual Node and Swift runtimes,
comparing every raw RGB byte (14 frames per loop, one for idle/fallback). Cases
include all agent families, unknown types, busy/idle/attention states, multiple
residents, usage rails, Unicode CI identities and background/subagent activity.
The common core matches a freshly seeded original Node renderer and isolates its
simulation from preview calls while preserving motion between uploads. Palindrome
order and copied cache results protect the seam and cached pixels. Input/count/size
bounds and generator drift are tested. Real module fixtures and a local HTTP server
verify one frame per request, shared IDs/counts, sequential offsets, first-failure
abort, ID resync, unknown-counter refusal, cancellation, cooldown, cadence and
settings preservation. Upload failures and missing acknowledgements now fail in
both daemons; a missing PicID no longer becomes zero. The gamma table is shared too.

Local quick verification passed with 7,136 Vitest cases and 17 conditionally
skipped cases. The macOS Debug suite passed 1,456 XCTest cases with five skipped,
including ten new native Pixoo tests and the existing Tide suite. The optimized
macOS Dot Preview suite passed 1,474 cases with ten skipped; the Store Release
macOS and iOS simulator builds passed their Dot-exclusion checks. The iOS Dot
Preview simulator build and its artifact boundary also passed. All five native
verification gates completed successfully.

The physical Pixoo at the previously configured LAN address was verified without
starting another hub or any other device module. The existing Debug app objects
were linked into a developer-only acceptance executable with the actual
`PixooModule`, renderer and production URLSession transport. Its data directory was
isolated. It exercised these steps:

| Physical check | Result |
|---|---|
| Aquarium upload | The actual module sent the 14-frame loop successfully. The owner confirmed that creatures/water moved and repeated naturally. |
| Dim | The panel reported brightness 7. After ten seconds with the dim guard active, its PicID remained unchanged, proving no intervening frame upload. |
| Wake | The module restored the original brightness 100 and successfully uploaded a fresh loop. |
| Restore | The driver stopped its synthetic scene and sent the original Tide mode using a read-only shared-daemon session/usage snapshot. The panel reported brightness 100, no module error and a successful Tide upload. The owner confirmed both the brightness change and the restored screen. |

XCTest hosts on this Mac were denied local-network access before any device write;
signing a host did not turn that into evidence of a broken Pixoo. A sandboxed XCTest
host also could not communicate with the IDE. No system network/privacy reset,
firewall relaxation or new Sandbox exception was applied. The independent developer
executable linked the same built module objects and reached the panel normally.
This physical result is distinct from signed Release-app UI or Store distribution
acceptance. The protocol's failure/cooldown paths are exercised with disposable
transports; malformed uploads were not intentionally sent to the physical panel.

The final built-module rerun passed the same loop/dim/wake/restoration checks.
The shared Node daemon retained PID `17785`, build `12fa71c8e515`, all 11 serial
ports and all baseline ADB, Android, Stream Deck, Wi-Fi, BLE and D200H identities.
An additional Crema dashboard was present in the final snapshot; no baseline
connection was lost.
No installed app, shared daemon settings, Pixoo device row, version, signing profile
or distribution state is changed. Local byte/parity, transport and physical evidence
is under `diagnostics/pixoo-loop/` (gitignored). X4 acceptance remains deferred to its
companion-app integration.

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
completed their original native implementation queue. APME retention/storage management
now also has a native implementation and disposable-store verification. Antigravity
read-only observation includes direct SQLite activity alongside JSONL identity;
the original DONE-only JSONL limitation is resolved without subprocesses.
ICS ingestion and Pixoo baked loops are now native too. Follow-up work uses the
revised lifecycle/configuration/control priorities above. Physical/private-provider acceptance remains
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
session/weather context. At this checkpoint, the Pocket port did not implement Node's ICS calendar
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
and weather context. At that checkpoint it did not add ICS or a new quota source;
[ICS was added subsequently](#native-ics-calendar-acceptance-2026-10-31).
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
