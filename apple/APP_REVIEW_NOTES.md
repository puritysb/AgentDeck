---
id: policy.app-review
title: App Review Notes
description: Review-facing rationale and sandbox invariants for the shipped Apple apps.
category: Engineering
locale: en
canonical: true
status: required
owner: Apple release maintainers
reviewed: 2026-08-06
revision: 2026-08-06
source_of_truth: apple/APP_REVIEW_NOTES.md
validators: [bash apple/scripts/verify-appstore-archive.sh]
---

# AgentDeck Dashboard — App Review Notes

**Release status** (verified in App Store Connect, 2026-08-06): both platforms are approved and live at [AgentDeck Dashboard](https://apps.apple.com/app/id6784822497). macOS has been on the Mac App Store since 2026-07-21 and is at **1.0.3 (4101)**, approved 2026-08-05. The first iPhone/iPad submission, 1.0.2 (3901), was rejected on 2026-08-04 under Guideline 2.1(a) because the disconnected screen kept showing an activity indicator after discovery had completed; **1.0.2 (4002)** carried the fix plus an offline Device Preview entry point, was approved, and **released on 2026-08-06** as the companion's first public version.

_Paste the relevant sections into App Store Connect's "Notes" field when submitting `apple-v<version>`._

## What AgentDeck does

AgentDeck Dashboard is a real-time monitoring and evaluation app for AI coding agents (Claude Code, opt-in Codex lifecycle hooks, opt-in OpenCode local-server monitoring, and OpenClaw Gateway sessions). The submitted macOS app's built-in Swift daemon owns the dashboard server, hook ingestion, session state, local-network pairing, APME Layer 2 evaluation, and native hardware modules. It shows live status, tool activity, and quality scores on Mac and on the paired iOS companion. When an agent genuinely waits for a decision, AgentDeck posts a local display-only notification; the user answers in their own agent interface.

**Works standalone on Mac.** The review scope is a clean Mac running only the submitted Swift app. Dashboard, APME reports, the 17-target Device Preview, opt-in Claude/Codex observation, opt-in OpenCode/OpenClaw monitoring, and iOS pairing work without another AgentDeck executable. Users start their chosen agent independently and AgentDeck receives only the integrations they enable.

**Optional hardware extensions** render the same state on Stream Deck+ (Elgato plugin), Ulanzi D200H (Ulanzi Studio plugin), supported ESP32 status displays (native serial/network), Divoom Pixoo (network), and iDotMatrix / Divoom Timebox Mini (native CoreBluetooth). Hardware is not required.

The product page and screenshots describe only this standalone Swift-daemon experience. Features that are not implemented by the submitted Swift app are not claimed and are not part of the review flow.

The app is sandboxed. Entitlements below support local monitoring and user-selected integrations. There is no analytics or advertising SDK. The optional remote evaluation backends (Anthropic API, any user-configured OpenAI-compatible endpoint, MLX) are off by default and are disclosed in App Privacy; the default Foundation Models backend stays on-device.

## Network server rationale (port 9120+)

> An automated App Review analysis (2026-07-20) flagged this entitlement as having no matching functionality. The section below is the canonical **Resolution Center reply**. Answering the message is not sufficient on its own — the App Review Information → Notes field must also carry the rationale, or the same automated rejection recurs on the next build. Use the condensed block at the end of this document for that field.

AgentDeck Dashboard requires `com.apple.security.network.server`. The app is not only an outbound client — it listens for and responds to incoming connections on the local network.

**What listens.** The app runs an in-process local dashboard hub implemented with Apple's Network.framework. Two `NWListener` instances are created at launch — HTTP (`apple/AgentDeck/Daemon/Server/HTTPServer.swift`) and WebSocket (`apple/AgentDeck/Daemon/Server/WebSocketServer.swift`) — on port 9120 by default (user-configurable in Settings → Port, range 1024–65535; falls back within 9120–9139 when the default is occupied). The service is advertised on the local network via Bonjour as `_agentdeck._tcp`, as described by `NSLocalNetworkUsageDescription` in Info.plist.

**Who connects in** (all incoming, none of which the app can initiate itself):

1. **The AgentDeck Dashboard iOS companion app** (same bundle family, `bound.serendipity.agent.deck`). The user's own iPhone/iPad discovers the Mac over Bonjour on the same Wi-Fi network and opens a WebSocket connection to the Mac to receive live session events. The Mac cannot reach the iOS device as a client — the iOS app is a pure client with no server entitlement, so this data path only exists if the Mac accepts inbound connections.
2. **AI coding-agent lifecycle hooks.** When the user opts in, Claude Code / Codex (the user's own separately-installed CLIs, running in their own terminal under their own process tree) POST session events to `http://127.0.0.1:<port>/hooks/...`. AgentDeck is the HTTP server receiving those POSTs.
3. **Optional hardware plugins** on the same machine or LAN — the Elgato Stream Deck plugin and the Ulanzi Studio plugin connect inbound over WebSocket to render session state on the user's deck hardware.

**Scope and safety.**

- Binding is limited to loopback and the local network interfaces. The app opens no firewall rules, performs no port mapping/UPnP, and accepts no traffic from the public internet.
- Endpoints are read-only dashboard reads plus the local hook POST endpoint.
- Connections from outside the machine must be paired (the iOS companion pairs via a QR code / auth token shown on the Mac).

**How to verify during review.** Launch the app, then open Settings → Port to see the active listening port (9120 by default), and use "Pair iPad" in the menu bar to display the pairing QR code the iOS companion scans to connect inbound. With the app running, `lsof -nP -iTCP -sTCP:LISTEN | grep AgentDeck` shows the AgentDeck process listening on it.

Without `com.apple.security.network.server` the iOS companion, the agent hooks, and the hardware plugins all lose their only data path, which removes the central feature of the product.

## Bonjour (`_agentdeck._tcp`)

Used so the iOS companion can discover the Mac dashboard on the same LAN without asking the user for an IP address. `NSLocalNetworkUsageDescription` in Info.plist explains this to the user at the system prompt.

## Sandbox Data Container

AgentDeck stores daemon state (session registry, auth token, cached usage metrics, APME evaluation SQLite database) inside the app's own sandbox container at `Application Support/AgentDeck`. The build does not request the optional App Groups entitlement because the submitted app has no helper, extension, or login item. Data stays local unless the user explicitly selects a disclosed network integration such as Anthropic API evaluation.

## Hook installation (Claude Code settings file)

AgentDeck can optionally register hooks in `~/.claude/settings.json` so Claude Code sessions report state to the dashboard. This is entirely opt-in:

1. On first launch the dashboard does **not** touch that file.
2. The user navigates to Settings → Claude Code Hooks → "Enable Claude Code Hooks…".
3. An `NSAlert` explains what keys will be written.
4. On acceptance, an `NSOpenPanel` requires the user to explicitly pick `~/.claude/settings.json`. Only then do we acquire a security-scoped bookmark and write the hook entries.
5. Writes are scoped to this single user-selected file; the app reads no other files in `~/.claude/`.

The UI also offers a "Remove" button that deletes our hook entries and revokes the bookmark.

When Claude Code uses child agents or agent teams, the same opt-in integration
receives lifecycle-only `SubagentStart`, `SubagentStop`, `TaskCompleted`, and
`TeammateIdle` events. AgentDeck collapses those signals into concise Timeline
start/completion summaries inside the parent session. It does not create
controllable child sessions, send messages or approvals to children, or read
or modify Claude Code's team configuration. The Terrarium may derive a
non-interactive ring, wire, and satellite accent around that same parent from
the summarized Timeline rows. These accents are decorative, have no hit target,
and do not expose child-agent controls.

## Local notifications

AgentDeck posts a local `UNUserNotification` when a monitored session genuinely waits for the user's response (e.g. Claude Code shows a permission prompt in the user's terminal), and clears it the moment the session moves on. Authorization is requested through an explanatory in-app prompt on first launch (the user can decline; a "Request Again" affordance lives in Settings). No push notifications, no remote notification service — everything is local.

## Bluetooth entitlement (`com.apple.security.device.bluetooth`)

> This section is also the canonical reply to the Guideline 2.4.5(i) question "describe how and where the app uses `com.apple.security.device.bluetooth`".

Used to drive the optional iDotMatrix and Divoom Timebox Mini LED pixel displays over Bluetooth Low Energy, using Apple's first-party CoreBluetooth framework (no subprocess, no bundled interpreter). AgentDeck acts only as a BLE *central*: it scans for the user's own display, connects, and writes display frames over a GATT characteristic. `NSBluetoothAlwaysUsageDescription` in Info.plist explains the purpose at the system prompt.

**Where in the app.** Both devices are paired from Settings → ESP32 & Pixoo, each with its own sheet:

- **iDotMatrix LED display → "Pair…"** (`UI/Settings/IDotMatrixSheet.swift`). Tapping **Scan** runs a CoreBluetooth scan for peripherals advertising the iDotMatrix service UUID `000000fa-…` or a known panel name family (`IDM-`, `iPixel-`); the user picks one and taps **Pair**. The selected `CBPeripheral.identifier` is stored and `IDotMatrixModule` drives the panel over BLE.
- **Divoom Timebox Mini → "Pair…"** (`UI/Settings/TimeboxSheet.swift`). Same flow against the `TimeBox-mini-light` advertised name, driven by `TimeboxModule`.

Each sheet also exposes a brightness slider that writes to the connected panel live, and a trash button that unpairs — on unpair AgentDeck sends a farewell frame (black for Timebox, OFFLINE for iDotMatrix) so the hardware does not keep displaying stale state, then drops the GATT link.

Note that these are BLE peripherals reached directly through CoreBluetooth, so they never appear in macOS System Settings → Bluetooth; the in-app sheets above are the only pairing UI. A reviewer without either display sees an empty "No device yet" list and a Scan button that finds nothing — the feature is inert, and nothing else in the app depends on it.

## Audio input + serial entitlements

- Microphone (`com.apple.security.device.audio-input`) drives the optional voice-command input for AI sessions. Usage description in Info.plist explains the purpose at the system prompt.
- Serial (`com.apple.security.device.serial`) is only used by optional ESP32-based status displays over USB-serial. Inert unless the user connects such hardware.

## Subprocess execution

**The App Store build of AgentDeck does not spawn any subprocess or create shell scripts for Terminal.** The macOS source tree contains no `Process()` invocation, no `.command` script writer, no AppleScript paths, and no probes for external binaries (`security`, `sqlite3`, `bin/sh`, `/usr/bin/env`, `openclaw`, `whisper-cli`, `networksetup`, `node`, `adb`). The `AGENTDECK_APP_STORE` Swift compile condition is retained as a defense-in-depth gate, and a CI script (`apple/scripts/verify-appstore-archive.sh`) runs after archive to fail the pipeline if any forbidden path string ever reappears in the shipped `.app`'s main Mach-O, or if any bundled executable besides the signed AgentDeck binary is present.

### What about the Claude Code hook commands?

Claude Code hooks run `python3` / `curl` at the user's shell prompt, in their own terminal session, under Claude Code's process tree — not AgentDeck's. The hook *string* is data AgentDeck writes (with the user's explicit consent via `NSOpenPanel` + security-scoped bookmark) into `~/.claude/settings.json`. Claude Code's own runtime is what eventually executes that string when the user runs Claude Code. AgentDeck itself only receives HTTP POSTs from those hooks on `localhost:9120`.

### Bundled helpers

The App Store archive contains no `Contents/Helpers/`, no `Contents/Resources/node`, no `Contents/Resources/agentdeck-runtime`, and no `Contents/Resources/bridge/cli.js`. The sole binary is `Contents/MacOS/AgentDeck`; every feature claimed on the product page is implemented by that Swift app and its sandbox-approved frameworks.

### OpenClaw Gateway integration

Unlike the other advanced integrations, OpenClaw **is** first-class in the App Store build — entirely through the local network and (optionally) explicit user-selected file scope, never through subprocess or unsolicited file I/O:

- AgentDeck connects to the user's local OpenClaw Gateway over WebSocket (`ws://127.0.0.1:18789`). The Gateway itself is the user's own program, started independently. AgentDeck never spawns the `openclaw` CLI and never enumerates the contents of `~/.openclaw/`. The only programmatic touch of that path is a single `FileManager.fileExists` existence check used to decide where the Import-token open-panel should *start* navigation (see step 2): if `~/.openclaw/` exists, the panel's `directoryURL` is set there so the (non-hidden) `openclaw.json` is immediately visible; otherwise it falls back to the user's real home directory. `directoryURL` is only a Powerbox navigation hint and grants no read access by itself. No file under that directory is read unless the user explicitly selects it in step 2.
- On first launch AgentDeck generates its own Ed25519 keypair (stored in the macOS Keychain, accessible-after-first-unlock / this-device-only). The public key's SHA-256 hex becomes the `deviceId` sent to the Gateway during the v3 pairing handshake. A short-lived `deviceToken` issued by the Gateway is used for subsequent reconnects.
- The user must approve the new device in OpenClaw's Web UI — AgentDeck only displays the pairing state; it never writes to OpenClaw's own config.
- **Optional shared-token mode.** If the user's Gateway is configured to require a shared token in addition to (or instead of) device pairing, the user can provide it in two ways:
  1. Paste the value into Settings → Integrations → OpenClaw → Advanced ("Shared Gateway token") and tap "Save".
  2. Tap "Import token" in the OpenClaw troubleshoot row. AgentDeck presents an `NSOpenPanel`. The panel's title and message text mention `~/.openclaw/openclaw.json` as the *typical* OpenClaw config location — this is human-readable hint text only. `directoryURL` is set to `~/.openclaw/` when that folder exists (so the non-hidden `openclaw.json` is immediately visible), otherwise to the user's real home directory (resolved via `getpwuid(getuid()).pw_dir`, since `NSHomeDirectory()` inside the sandbox returns the app's container path which is not where OpenClaw lives). The only programmatic file-system call before the user selects anything is a single `FileManager.fileExists` check to choose that starting folder — no directory enumeration. The panel itself runs in Powerbox outside the sandbox and is allowed to present that path as a navigation starting point; the hint grants no read permission by itself — only what the user explicitly selects in the panel is readable. The panel does **not** preselect any specific file, the user is free to navigate elsewhere or cancel, and AgentDeck never opens, traverses, or enumerates any path under the user's real home outside the file the user picks here. The selected file's bytes are read into memory (`Data(contentsOf:)`) and parsed via `JSONSerialization`; from the resulting object **only the gateway token string is used** — it is written to the macOS Keychain via `OpenClawGatewayTokenStore`, and every other parsed value goes out of scope and is freed when the import method returns. The read is performed inside a `startAccessingSecurityScopedResource()` / `defer stop` pair under the existing `com.apple.security.files.user-selected.read-write` entitlement. AgentDeck additionally stores an app-scoped security-scoped bookmark to **the single file the user picked** (under `com.apple.security.files.bookmarks.app-scope`, the same mechanism used for the Claude/Codex/Antigravity file integrations) so that a later rotated token can be re-read from that same file on reconnect — never any other path. The bookmark is revoked when the user taps "Clear" on the token.
- Reviewers without OpenClaw installed will see "Not configured" and can skip this integration entirely. The "Import token" button is also fully optional — reviewers can validate the panel without selecting any file.

### OpenCode (opt-in local server monitoring)

OpenCode session monitoring in the App Store build is an **opt-in, read-only local network client** to a server the user runs themselves — the same posture as the OpenClaw Gateway integration:

- The feature is **off by default**. While off, AgentDeck makes zero OpenCode-related network probes. The user enables it from Settings → Integrations → OpenCode ("Monitor OpenCode server").
- When enabled, AgentDeck connects (plain `URLSession`, `com.apple.security.network.client`) to an OpenCode HTTP server that the user started independently in their own terminal (`opencode serve`). Discovery is limited to exactly three inputs: (1) the URL the user typed into Settings (default `http://127.0.0.1:4096`), (2) a health check of OpenCode's fixed default port 4096 (the same shape as the OpenClaw fixed-port probe on 18789), and (3) macOS process metadata (`sysctl KERN_PROC_ALL` / `KERN_PROCARGS2` — the same first-party API already used for Codex Desktop detection) to notice an `opencode` process the user launched with an explicit `--port N` argument. AgentDeck does **not** port-scan, does not install OpenCode plugins, and never spawns `opencode`.
- The connection consumes OpenCode's own read-only event stream (`GET /global/event`, Server-Sent Events) and renders session rows (project, working/idle, current tool). When OpenCode reports a permission request, AgentDeck shows a display-only "needs attention" state — the user responds in their own OpenCode terminal; AgentDeck sends no commands to the server.
- Reviewers without OpenCode installed see "Not configured" with the toggle off; the integration is fully inert. No OpenCode-related copy in the App Store app prompts the user to install or launch anything.

### Antigravity (usage only in the App Store build)

Antigravity coding-session monitoring is intentionally **not** claimed by the submitted app. Its only App Store feature is a user-approved local status integration: the user explicitly selects the Antigravity `state.vscdb` file through an `NSOpenPanel`, AgentDeck stores a security-scoped bookmark to that one file, and the dashboard displays plan/credit information only when parseable. AgentDeck does not install Antigravity hooks, spawn another app, enumerate the user's real home directory, or scan processes.

### Codex observation path

Codex (OpenAI's CLI) is observed through a fully opt-in path that mirrors the Claude Code hook flow:

1. The user enables it from Settings → Integrations → "Enable Codex Observation…".
2. An `NSAlert` explains that AgentDeck will write Codex lifecycle hook entries into `~/.codex/config.toml`, with optional `notify` and `[otel]` fallback entries when the user has not already configured those channels.
3. On acceptance, an `NSOpenPanel` requires the user to explicitly pick `~/.codex/config.toml`. Only then do we acquire a security-scoped bookmark and write the entries.
4. AgentDeck only edits inside its own fenced TOML block (`# >>> AgentDeck managed (do not edit) <<<` / `# <<<` markers) — user keys (`model`, profiles, MCP servers) are preserved verbatim. If the user already wrote `[features]` or `[hooks]`, AgentDeck aborts instead of unsafe-merging lifecycle hooks. If the user already wrote a top-level `notify` or `[otel]`, AgentDeck still installs lifecycle hooks but omits that optional fallback/exporter to avoid duplicate keys.
5. The values written enable `[features] hooks = true` and inline `[[hooks.*]]` command hooks. Those commands resolve AgentDeck's local-only HTTP port and POST Codex hook JSON to `http://127.0.0.1:$PORT/hooks/codex_session_start`, `/hooks/codex_user_prompt_submit`, `/hooks/codex_tool_start`, `/hooks/codex_tool_end`, `/hooks/codex_stop`, `/hooks/codex_subagent_start`, and `/hooks/codex_subagent_stop`. The two subagent endpoints produce read-only parent-Timeline summaries and never return control or approval decisions. Optional fallback entries POST notify JSON to `/hooks/codex_turn_complete` and OTel JSON traces to `/otel/v1/traces` (`protocol = "json"`). All endpoints listen on `127.0.0.1` only. The OTel `endpoint` is rewritten on every daemon startup so it always reflects the actual port the daemon is bound to.
6. At runtime, Codex (the user's separately-installed CLI) is what eventually executes that snippet under its own process tree — not AgentDeck. AgentDeck itself only receives HTTP POSTs.

The Settings panel offers a "Remove" button that strips AgentDeck's fenced block and revokes the bookmark; it leaves all user-authored TOML keys untouched. Reviewers without Codex installed see "Not configured"; the panel remains inert.

Separately, the Codex Integrations row offers an optional **usage display** that mirrors the Antigravity `state.vscdb` pattern exactly: the user explicitly picks their `~/.codex` folder through an `NSOpenPanel` (`canChooseDirectories`, starting at `~/.codex` resolved via `getpwuid(getuid()).pw_dir`, no preselection, no enumeration before selection), AgentDeck stores an app-scoped security-scoped bookmark to that one folder, and reads are performed inside a `startAccessingSecurityScopedResource()` / `defer stop` pair under the existing `com.apple.security.files.user-selected.read-write` entitlement. From that folder AgentDeck reads only `auth.json` (ChatGPT plan + subscription expiry) and the trailing bytes of the newest `sessions/.../rollout-*.jsonl` file (the `rate_limits` snapshot Codex itself writes — a 5h/7d-style usage gauge). No OpenAI/ChatGPT network endpoint is contacted for this; it is the user's own local files, parsed with `JSONSerialization`. There is no home-relative-path entitlement and no subprocess; when the user has not granted the folder the row simply shows the plan/usage region collapsed. A "Remove access" button revokes the bookmark.

AgentDeck observes Codex and OpenCode only through the opt-in Swift paths described above; users start their chosen agent independently.

## APME evaluation module

AgentDeck can evaluate finished agent turns against configurable rubrics (and, on demand, run an independent "REVIEW" risk check). In the App Store build:
- Default backend is **Apple Intelligence (Foundation Models)** — on-device, zero-cost, no network.
- Alternatives are opt-in and clearly labeled in Settings, and all use only already-declared entitlements — **no subprocess, no bundled interpreter, no install nudge**:
  - **OpenAI-compatible** (`com.apple.security.network.client`): a single outbound-HTTP adapter that talks to any OpenAI-compatible chat server the user *already runs or subscribes to* — a local Ollama (`127.0.0.1:11434`), LM Studio (`127.0.0.1:1234`), vLLM/llama.cpp, or a cloud endpoint like OpenRouter (with the user's own API key). The user types the endpoint (and key, if the endpoint is remote) into Settings. AgentDeck never installs, prompts to install, or spawns any of these — it only sends `POST /v1/chat/completions`.
  - **Anthropic API** — the user's own key, disclosed as paid.
  - **MLX local server** — outbound HTTP to a server the user started.
- **Local-server detection is loopback HTTP only.** Settings offers a "Detect local servers" button (and the REVIEW setup panel offers the same) that issues HTTP GETs to the standard loopback ports (`127.0.0.1:11434/api/tags`, `:1234/v1/models`, `:8800/v1/models`) to notice a server the user already runs. This is a network read, **not** a subprocess — there is no `ollama list` / CLI invocation anywhere. If nothing is running, the probe returns an empty list within ~1.2s and nothing changes.
- The copy never tells the user to install anything: it says "point AgentDeck at a server you already run." REVIEW itself is opt-in and the on-device default works with zero setup, so the app is never broken without an external provider.
- Layer 1 deterministic checks (git/pnpm introspection) are **disabled** in the App Store build because they require subprocess access outside the sandbox. The UI surfaces this explicitly — users still get Layer 2 LLM-based scoring.

## Timeline summary backend

The dashboard timeline shows a one-line topic under each completed turn (the `chat_end` row). To produce that label, the App Store build calls a chain of cost-free local backends:
- **Apple Intelligence (FoundationModels)** — on-device, zero-cost, no network. Used first when available (macOS 26+, Apple Silicon, Apple Intelligence enabled). Same framework call shape as APME.
- **MLX local server** — outbound HTTP to `127.0.0.1:8800`, only attempted when the user has independently started a local MLX server. AgentDeck does not install, prompt for, or spawn MLX; if the server isn't running, the call returns nil within ~2s and the chain falls through.
- **Heuristic** — pure-Swift first-line extractor. Always available; runs as the chain's floor.

No subprocess, no bundled interpreter, no third-party network call, no install nudge. Users can pick a specific backend (or stick with the default `Auto`) from Settings → Timeline summary. The same `verify-appstore-archive.sh` CI gate that covers APME also covers this path because both share `TimelineSummarizer.swift` / `ApmeJudgeFoundationModels.swift` and only use entitlements already declared (`com.apple.security.network.client` for outbound localhost).

## Stream Deck+ dependency

AgentDeck's Stream Deck+ integration renders session state on Stream Deck+ keys via Elgato's Stream Deck plugin SDK. This optional hardware path requires Elgato's Stream Deck software. If a user plugs in a Stream Deck+ without Elgato's software, AgentDeck shows that the integration is unavailable and links to Elgato's setup information. Reviewers testing without Elgato hardware can skip this integration entirely — the rest of the app does not depend on it.

## iOS companion

The iOS app (same bundle family `bound.serendipity.agent.deck`) is a read-only remote dashboard that auto-discovers a paired Mac via Bonjour. On first launch it runs a 4-pane onboarding walking the user through the product, Mac-side agents and integrations, and finding their Mac on Wi-Fi. Fallback pairing via QR code (Mac shows → iPad scans) handles cases where Bonjour is unavailable. No network-server entitlement is needed on iOS — it is a pure client.

When no Mac is present, foreground discovery ends after approximately 10 seconds, and a hard deadline stops the activity indicator regardless of which discovery step is in flight. The screen then shows the stable terminal state **“No AgentDeck found on this network”** with no activity indicator and offers **Search Again**, **Enter URL Manually**, and **Explore without a Mac**. Stopping a connection attempt always lands on that same recoverable state. Bonjour remains active in the background, so a Mac that comes online later is discovered and connected automatically. “Explore without a Mac” opens the built-in synthetic Device Preview; it uses only local Swift rendering and requires no account, network server, agent session, or hardware.

## Review instructions — macOS

No account required. To see the app's features:

1. Launch the app. A first-run onboarding sheet walks the user through the value prop, available AI agents, and iPad pairing. Dismissing it opens the empty dashboard with a prompt to "Preview Devices".
2. Click "Preview Devices" from the menu bar to see how AgentDeck renders sessions on the built-in preview targets — no real hardware required.
3. After hooks are enabled, sessions the user starts independently appear automatically in the dashboard. AgentDeck never launches Terminal scripts or command-line tools itself.
4. Click "Pair iPad" to show a QR code the iOS companion app can scan.
5. Open Settings → Hardware Setup to see the in-app flows for ESP32 and Pixoo provisioning (no subprocess calls; writes serial config directly).

## Review instructions — iPhone/iPad

No account or paired Mac is required to verify the submitted app's fixed launch path:

1. Install the new build as a clean install and complete the four onboarding panes.
2. Allow Local Network access when requested.
3. If no AgentDeck Mac is present on the review Wi-Fi, wait approximately 10 seconds. The activity indicator stops and the screen shows “No AgentDeck found on this network.”
4. Tap **Explore without a Mac**. The local Device Preview opens immediately. Use the Device, Agent, State, and Sessions controls to inspect the synthetic dashboard surfaces, then tap Done.
5. Tap **Search Again** to run another bounded search; it also stops on its own and returns to the same screen.
6. Manual WebSocket URL entry remains available. If a Mac running AgentDeck is on the same Wi-Fi — including one powered on after the search finished — Bonjour connects automatically; QR pairing remains available from the Mac and iOS Settings.

## Standalone macOS review scope

Review on a clean Mac with only AgentDeck installed. The app starts its own Swift dashboard server and exposes the complete App Store experience described above. No external AgentDeck process, developer bridge, or terminal setup is part of the review instructions. The CI script `apple/scripts/verify-appstore-archive.sh` fails the build if the shipped app contains a subprocess spawn path, bundled helper executable, or home-relative-path entitlement.

## Resolution Center — Guideline 2.1(a) launch indicator reply

**Sent 2026-08-05 03:18 KST against iOS 1.0.2, build 4002** — the text below is that message as it actually went out, not a draft. This section previously staged the reply around build 4101 / version 1.0.3 on the assumption that both platforms would ship together under the next version; that is not what happened. iOS was answered as a `1.0.2` resubmission (a rejected version keeps its `MARKETING_VERSION`, and 4002 was already on TestFlight carrying the fix), while macOS went out separately as `1.0.3` / 4101. A stored reply naming a build the reviewer will not see is the exact failure this file exists to prevent, so it is kept in sync with the send:

```text
Thank you for identifying this issue. We reproduced the behavior shown in your
screenshot and found the cause.

Bonjour discovery is intentionally kept active in the background so the app can
notice a Mac that comes online later. Build 3901 incorrectly used that long-lived
browser state to drive the foreground activity indicator. The bounded connection
attempt had already finished after 10 seconds, but the screen continued to say
“Searching for AgentDeck…” and continued animating. This was a UI state bug, not
a stalled network request.

We corrected the issue in build 4002:
• The activity indicator is now tied only to the bounded foreground search or an
  active connection attempt.
• After approximately 10 seconds with no Mac found, the indicator stops and the
  app shows the stable “No AgentDeck found on this network” state. A deadline
  enforces this regardless of which discovery step is in flight, and cancelling a
  connection attempt lands on the same recoverable screen.
• Search Again, manual URL pairing, and QR pairing remain available, and a Mac
  that comes online after the search has finished is still connected
  automatically.
• “Explore without a Mac” now opens the built-in local Device Preview, so the app
  can be inspected on the review iPad without a paired Mac, account, or hardware.
• We added regression coverage for the searching, connecting, permission-denied,
  reconnecting, and completed-empty-search states, plus tests that drive the real
  connection state machine and assert the indicator always stops and always
  leaves the user an action. We verified the corrected no-Mac paths on an iPad Air
  11-inch (M4) simulator running iPadOS 26.5. Build 4002 was also installed and
  connected successfully on a physical iPad Air 11-inch (M2) running iPadOS 26.5.2.

To verify on a clean iPad: complete onboarding, allow Local Network access, and
wait approximately 10 seconds without an AgentDeck Mac on the same Wi-Fi. The
indicator stops. Tap “Explore without a Mac” to open the local preview and use
the Device, Agent, State, and Sessions controls.

We apologize for the incomplete empty-network behavior in the previous build and
appreciate the clear screenshot.
```

## Resolution Center — Guideline 2.4.5(i) entitlement reply

Sent 2026-07-20 in response to the review of 1.0.0 (3501), which asked where the app uses
`com.apple.security.device.bluetooth` and `com.apple.security.network.server`. Fill in the two demo
video links before sending. Guideline 5 (China) was resolved by deselecting the China mainland
storefront in Availability rather than stripping Codex/OpenAI functionality.

```text
Thank you for the review. Both entitlements are used by shipping functionality;
below is where each one is exercised in the app, plus demo videos showing it.

Demo videos (Guideline 2.1):
• Bluetooth / hardware pairing: <PASTE LINK>
• iPad companion pairing (network.server): <PASTE LINK>

--------------------------------------------------------------------------
com.apple.security.device.bluetooth
--------------------------------------------------------------------------
AgentDeck renders live coding-session status on optional Bluetooth LE pixel
displays, acting only as a BLE central via Apple's CoreBluetooth framework.

Where in the app — Settings → ESP32 & Pixoo, two separate pairing sheets:

1. "iDotMatrix LED display" → Pair…
   Tapping Scan runs a CoreBluetooth scan for peripherals advertising the
   iDotMatrix service UUID 000000fa-... or a known panel name family ("IDM-",
   "iPixel-"). The user selects one and taps Pair. AgentDeck stores the
   CBPeripheral.identifier and then writes 32x32 display frames over a GATT
   characteristic.

2. "Divoom Timebox Mini" → Pair…
   The same flow against the "TimeBox-mini-light" advertised name, writing
   11x11 frames.

Each sheet also has a brightness slider that changes the connected panel's
output live, and an unpair button that sends a farewell frame before dropping
the GATT link. The demo video shows the full sequence on real hardware: the
panel dark before pairing, Scan discovering the device, Pair, the panel
rendering session state, and the brightness slider changing it.

Please note these are BLE peripherals connected directly through CoreBluetooth
— they never appear in macOS System Settings → Bluetooth, so the in-app sheets
above are the only pairing UI. A reviewer without either display sees "No
device yet" and a Scan that finds nothing; the feature is inert and nothing
else in the app depends on it.

--------------------------------------------------------------------------
com.apple.security.network.server
--------------------------------------------------------------------------
The app runs a local-only HTTP + WebSocket dashboard hub built on
Network.framework NWListener (port 9120 by default, user-configurable in
Settings → Port). It must be a server because it accepts inbound connections
from three sources it cannot reach as a client:

1. The AgentDeck Dashboard iOS companion app (same bundle family). The user's
   own iPhone/iPad discovers the Mac over Bonjour (_agentdeck._tcp) on their
   Wi-Fi and opens a WebSocket connection TO the Mac to receive live session
   events. The iOS app is a pure client with no server entitlement, so this
   data path only exists if the Mac accepts inbound connections. The second
   demo video shows this: the iPad goes from "Disconnected" to "Connected" on
   ws://192.168.68.100:9120 after scanning the pairing QR shown on the Mac.

2. AI coding-agent lifecycle hooks. When the user opts in, Claude Code / Codex
   (their own separately-installed CLIs, running in their own terminal under
   their own process tree) POST session events to 127.0.0.1. AgentDeck is the
   HTTP server receiving those POSTs.

3. The optional Elgato Stream Deck and Ulanzi Studio plugins, which connect
   inbound over WebSocket to render session state on deck hardware.

Binding is limited to loopback and the local network interfaces. The app opens
no firewall rules, performs no port mapping or UPnP, and accepts no traffic
from the public internet. Endpoints are read-only dashboard reads plus the
local hook POST endpoint, and connections from outside the machine must be
paired via the QR/token flow shown in the video.

To verify in the app: Settings → Port shows the active listening port, and
"Pair iPad" in the menu bar shows the inbound pairing QR.

Without these two entitlements the BLE displays, the iOS companion, the agent
hooks, and the deck plugins all lose their only data path.
```

## App Store Connect — App Review Information → Notes

The Notes field is capped at 4,000 characters and persists across every submission, so it carries a
condensed version rather than this document in full. Paste the platform-specific block below; the
long-form sections above are for the Resolution Center reply, where length is not constrained.

### iOS / iPadOS Notes field

<!-- ios-notes-field:begin -->

```text
NO ACCOUNT REQUIRED. A paired Mac is optional for review of this build.

BUILD 3901 ISSUE AND FIX
The previous build kept its Bonjour browser active so it could discover a Mac
that appeared later, but incorrectly used that long-lived browser state to drive
the foreground activity indicator. The 10-second connection attempt had ended,
yet the spinner and “Searching” text remained. The replacement build separates
passive Bonjour browsing from foreground progress.

VERIFY ON A CLEAN IPAD
1. Complete the four onboarding panes and allow Local Network access.
2. With no AgentDeck Mac on the review Wi-Fi, wait approximately 10 seconds.
3. The spinner stops and the stable text reads “No AgentDeck found on this
   network.” Search Again and Enter URL Manually remain available.
4. Tap “Explore without a Mac.” A local synthetic Device Preview opens without
   an account, server, agent session, or hardware. The Device, Agent, State, and
   Sessions controls all update the rendered preview. Tap Done to return.
5. Tap “Search Again.” The bounded search runs once more and returns to the same
   screen on its own.

LIVE COMPANION PATH (OPTIONAL)
When AgentDeck is running on a Mac on the same Wi-Fi, the iOS app discovers it
through Bonjour (_agentdeck._tcp) and opens a read-only WebSocket dashboard —
including a Mac powered on after the initial search has finished. The Mac can
also show a QR pairing URL. The iOS app is a client only and requests Local
Network access for this pairing path.

The app contains no analytics or advertising SDK and requires no sign-in.
Contact: admin@foundby.kr
```

<!-- ios-notes-field:end -->

### macOS Notes field

<!-- notes-field:begin (3,552 chars — recount with `wc -m` after any edit) -->

```text
NO ACCOUNT REQUIRED. Review on a clean Mac with only AgentDeck installed — no external process or terminal setup is part of these instructions.

WHAT IT DOES
AgentDeck Dashboard monitors and evaluates AI coding-agent sessions (Claude Code, opt-in Codex hooks, opt-in OpenCode events, OpenClaw Gateway). Its built-in sandboxed Swift daemon owns the dashboard server, hook ingestion, session state, local-network pairing, and evaluation. Users start their agent independently; AgentDeck receives only the integrations they explicitly enable.

HOW TO SEE THE FEATURES WITHOUT ANY AGENT INSTALLED
1. Launch the app; dismiss the first-run onboarding sheet to reach the dashboard.
2. Click "Preview Devices" in the menu bar — it renders sessions on the built-in preview targets, no hardware or agent required. Fastest way to review the UI.
3. Click "Pair iPad" to show the QR the iOS companion scans.

NO SUBPROCESS (Guideline 2.5.2)
The build spawns no subprocess and writes no shell scripts: no Process(), no .command writer, no AppleScript, no external-binary probes. The sole bundled executable is Contents/MacOS/AgentDeck. Our CI (apple/scripts/verify-appstore-archive.sh) fails the build if a forbidden path string reappears in the shipped Mach-O, if an extra bundled executable is present, or if a home-relative-path entitlement is requested.

ENTITLEMENT RATIONALE
• network.server — the app runs a local-only HTTP+WebSocket dashboard hub on Network.framework NWListener (port 9120, user-configurable in Settings → Port). It must be a server because it accepts inbound connections from three sources it cannot reach as a client: (1) the same user's iPhone/iPad running our AgentDeck companion, which finds the Mac via Bonjour over Wi-Fi; (2) AI-agent lifecycle hooks that POST session events to 127.0.0.1 from the user's own terminal; (3) the optional Elgato Stream Deck and Ulanzi plugins. Binding is loopback + local interfaces only — no firewall rules, no port mapping, no public-internet traffic — and endpoints are read-only dashboard reads plus that hook POST. To verify: Settings → Port shows the listening port, and "Pair iPad" shows the QR the companion scans to connect inbound.
• Bonjour (_agentdeck._tcp) — lets the companion find the Mac without typing an IP. Explained via NSLocalNetworkUsageDescription.
• device.bluetooth — optional iDotMatrix and Divoom Timebox Mini LED displays via CoreBluetooth, BLE central only. Inert unless the user pairs one.
• device.audio-input — optional voice input. device.serial — optional ESP32 USB-serial displays; inert without such hardware.
• files.user-selected.read-write + bookmarks.app-scope — hook installation is fully opt-in: an NSAlert explains it, then an NSOpenPanel requires the user to pick ~/.claude/settings.json themselves. Only then do we take a security-scoped bookmark and write. A Remove button reverts it.

PRIVACY / EVALUATION BACKENDS
Evaluation defaults to on-device Apple Intelligence Foundation Models — no network. Remote backends are opt-in alternatives the user configures with their own endpoint and key (Anthropic API, any OpenAI-compatible server, or a local MLX server). Only when one is selected does turn content leave the device, to the endpoint the user chose. Disclosed in App Privacy and our privacy policy. No analytics or advertising SDK, and we operate no cloud backend.

All hardware integrations are optional (Stream Deck+ also needs Elgato's software); reviewers can skip them and the rest of the app is unaffected.

Contact: admin@foundby.kr
```

<!-- notes-field:end -->

## Contact

For anything unclear: `admin@foundby.kr`.
