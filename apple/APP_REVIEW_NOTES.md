# AgentDeck Dashboard — App Review Notes

_Paste the relevant sections into App Store Connect's "Notes" field when submitting `apple-v<version>`._

## What AgentDeck does

AgentDeck Dashboard is a real-time monitoring and evaluation app for AI coding agents (Claude Code, opt-in Codex CLI lifecycle hooks, and OpenClaw Gateway sessions). It shows live session status, tool activity, and quality scores on the Mac, and — via the free iOS companion app — on an iPad or iPhone used as a secondary display. OpenCode monitoring is intentionally outside the App Store build and is available only through the optional developer bridge described below.

**Works standalone on Mac.** All core features (dashboard, APME evaluation reports, Device Preview, Claude Code hook integration, and iOS pairing) work without any additional hardware or AgentDeck companion executable. Users run their AI agent in their own terminal; AgentDeck receives opt-in hook events.

**Optional hardware extensions** let power users drive the same state on Stream Deck+ keys, Ulanzi D200H Deck Docks (USB HID), ESP32 status displays (Wi-Fi), Divoom Pixoo matrix displays (Wi-Fi), and iDotMatrix / Divoom Timebox Mini LED displays (Bluetooth LE). Each integration is configurable from an in-app sheet — the user is never forced to open Terminal.

**Advanced developer integrations** — Android device bridging via ADB, PTY-level launch for Codex/OpenCode, and APME Layer 1 deterministic scoring (git/pnpm introspection) — are not bundled in AgentDeck, and the App Store app never installs, downloads, runs, or prompts the user to obtain them. The UI panels that visualize these integrations are **conditional, read-only views** of data broadcast by a separately-distributed Node.js CLI daemon that a developer may independently install via npm. AgentDeck detects that daemon by attempting to bind `127.0.0.1:9120` at launch: if the port is free, AgentDeck itself becomes the server and those panels never appear; if the port is already held by the user-run daemon, AgentDeck connects as a WebSocket client and renders additional panels purely from the data received. No installer flow, App Store-visible link, or copy in AgentDeck asks the user to obtain the external daemon. `docs/appstore-feature-matrix.md` in the public repository is the source of truth for what ships in this binary vs. what is only reachable via the optional developer toolchain.

The app is sandboxed. All non-trivial entitlements below are used for local-network monitoring of agents the user is running themselves — no remote services, no third-party data collection.

## Network server rationale (port 9120+)

`com.apple.security.network.server` is used to run a local-only HTTP + WebSocket dashboard hub on `127.0.0.1:9120`. The reason this must be a server (and not an outbound client) is that AgentDeck is a companion to **the same user's own iPad/iPhone running the AgentDeck Dashboard iOS app**, which connects over the local Wi-Fi network and renders the same data. Without `network.server`, the iOS companion cannot receive live session events.

- Port 9120 is the default; the user can override via Settings when another process holds it.
- Binding is `127.0.0.1` + the local-network interface. We do not open firewall rules or bind externally. No inbound traffic from the public internet.
- The server exposes only read-only dashboard endpoints + a hook POST endpoint that the Claude Code CLI (running in the user's own terminal) uses to report session events.

## Bonjour (`_agentdeck._tcp`)

Used so the iOS companion can discover the Mac dashboard on the same LAN without asking the user for an IP address. `NSLocalNetworkUsageDescription` in Info.plist explains this to the user at the system prompt.

## Sandbox Data Container

AgentDeck stores daemon state (session registry, auth token, cached usage metrics, APME evaluation SQLite database) inside the app's own sandbox container at `Application Support/AgentDeck`. The build does not request the optional App Groups entitlement because the submitted app has no helper, extension, or login item that needs shared container access. No user-identifiable data leaves the device.

## Hook installation (Claude Code settings file)

AgentDeck can optionally register hooks in `~/.claude/settings.local.json` so Claude Code sessions report state to the dashboard. This is entirely opt-in:

1. On first launch the dashboard does **not** touch that file.
2. The user navigates to Settings → Claude Code Hooks → "Enable Claude Code Hooks…".
3. An `NSAlert` explains what keys will be written.
4. On acceptance, an `NSOpenPanel` requires the user to explicitly pick `~/.claude/settings.local.json`. Only then do we acquire a security-scoped bookmark and write the hook entries.
5. Writes are scoped to this single user-selected file; the app reads no other files in `~/.claude/`.

The UI also offers a "Remove" button that deletes our hook entries and revokes the bookmark.

## USB HID entitlement (`com.apple.security.device.usb`)

Used to communicate with the optional Ulanzi D200H Deck Dock (USB HID class, VID `0x2207` / PID `0x0019`). The user opts in by plugging in their own hardware. If the device is absent, the feature is inert.

## Bluetooth entitlement (`com.apple.security.device.bluetooth`)

Used to communicate with the optional iDotMatrix and Divoom Timebox Mini LED pixel displays over Bluetooth Low Energy, using Apple's first-party CoreBluetooth framework (no subprocess, no bundled interpreter). AgentDeck acts only as a BLE *central*: it scans for the user's own display (iDotMatrix advertised name prefix `IDM-`; Timebox Mini advertised name `TimeBox-mini-light`), connects, and writes display frames over a GATT characteristic. The user opts in by pairing their own hardware from an in-app Settings sheet; the `NSBluetoothAlwaysUsageDescription` string explains the purpose at the system prompt. If no such display is present (or the user never pairs one), the feature is inert.

## Audio input + serial entitlements

- Microphone (`com.apple.security.device.audio-input`) drives the optional voice-command input for AI sessions. Usage description in Info.plist explains the purpose at the system prompt.
- Serial (`com.apple.security.device.serial`) is only used by optional ESP32-based status displays over USB-serial. Inert unless the user connects such hardware.

## Subprocess execution

**The App Store build of AgentDeck does not spawn any subprocess or create shell scripts for Terminal.** The macOS source tree contains no `Process()` invocation, no `.command` script writer, no AppleScript paths, and no probes for external binaries (`security`, `sqlite3`, `bin/sh`, `/usr/bin/env`, `openclaw`, `whisper-cli`, `networksetup`, `node`, `adb`). The `AGENTDECK_APP_STORE` Swift compile condition is retained as a defense-in-depth gate, and a CI script (`apple/scripts/verify-appstore-archive.sh`) runs after archive to fail the pipeline if any forbidden path string ever reappears in the shipped `.app`'s main Mach-O, or if any bundled executable besides the signed AgentDeck binary is present.

### What about the Claude Code hook commands?

Claude Code hooks run `python3` / `curl` at the user's shell prompt, in their own terminal session, under Claude Code's process tree — not AgentDeck's. The hook *string* is data AgentDeck writes (with the user's explicit consent via `NSOpenPanel` + security-scoped bookmark) into `~/.claude/settings.local.json`. Claude Code's own runtime is what eventually executes that string when the user runs Claude Code. AgentDeck itself only receives HTTP POSTs from those hooks on `localhost:9120`.

### Bundled helpers

The App Store archive contains no `Contents/Helpers/`, no `Contents/Resources/node`, no `Contents/Resources/agentdeck-runtime`, and no `Contents/Resources/bridge/cli.js`. The sole binary is `Contents/MacOS/AgentDeck`. Android ADB bridging, APME Layer 1 deterministic git/pnpm scoring, and PTY-level agent parsing are outside the reviewed app and are not required for the App Store experience.

### OpenClaw Gateway integration

Unlike the other advanced integrations, OpenClaw **is** first-class in the App Store build — entirely through the local network and (optionally) explicit user-selected file scope, never through subprocess or unsolicited file I/O:

- AgentDeck connects to the user's local OpenClaw Gateway over WebSocket (`ws://127.0.0.1:18789`). The Gateway itself is the user's own program, started independently. AgentDeck never spawns the `openclaw` CLI and never enumerates the contents of `~/.openclaw/`. The only programmatic touch of that path is a single `FileManager.fileExists` existence check used to decide where the Import-token open-panel should *start* navigation (see step 2): if `~/.openclaw/` exists, the panel's `directoryURL` is set there so the (non-hidden) `openclaw.json` is immediately visible; otherwise it falls back to the user's real home directory. `directoryURL` is only a Powerbox navigation hint and grants no read access by itself. No file under that directory is read unless the user explicitly selects it in step 2.
- On first launch AgentDeck generates its own Ed25519 keypair (stored in the macOS Keychain, accessible-after-first-unlock / this-device-only). The public key's SHA-256 hex becomes the `deviceId` sent to the Gateway during the v3 pairing handshake. A short-lived `deviceToken` issued by the Gateway is used for subsequent reconnects.
- The user must approve the new device in OpenClaw's Web UI — AgentDeck only displays the pairing state; it never writes to OpenClaw's own config.
- **Optional shared-token mode.** If the user's Gateway is configured to require a shared token in addition to (or instead of) device pairing, the user can provide it in two ways:
  1. Paste the value into Settings → Integrations → OpenClaw → Advanced ("Shared Gateway token") and tap "Save".
  2. Tap "Import token" in the OpenClaw troubleshoot row. AgentDeck presents an `NSOpenPanel`. The panel's title and message text mention `~/.openclaw/openclaw.json` as the *typical* OpenClaw config location — this is human-readable hint text only. `directoryURL` is set to `~/.openclaw/` when that folder exists (so the non-hidden `openclaw.json` is immediately visible), otherwise to the user's real home directory (resolved via `getpwuid(getuid()).pw_dir`, since `NSHomeDirectory()` inside the sandbox returns the app's container path which is not where OpenClaw lives). The only programmatic file-system call before the user selects anything is a single `FileManager.fileExists` check to choose that starting folder — no directory enumeration. The panel itself runs in Powerbox outside the sandbox and is allowed to present that path as a navigation starting point; the hint grants no read permission by itself — only what the user explicitly selects in the panel is readable. The panel does **not** preselect any specific file, the user is free to navigate elsewhere or cancel, and AgentDeck never opens, traverses, or enumerates any path under the user's real home outside the file the user picks here. The selected file's bytes are read into memory (`Data(contentsOf:)`) and parsed via `JSONSerialization`; from the resulting object **only the gateway token string is used** — it is written to the macOS Keychain via `OpenClawGatewayTokenStore`, and every other parsed value goes out of scope and is freed when the import method returns. The read is performed inside a `startAccessingSecurityScopedResource()` / `defer stop` pair under the existing `com.apple.security.files.user-selected.read-write` entitlement. AgentDeck additionally stores an app-scoped security-scoped bookmark to **the single file the user picked** (under `com.apple.security.files.bookmarks.app-scope`, the same mechanism used for the Claude/Codex/Antigravity file integrations) so that a later rotated token can be re-read from that same file on reconnect — never any other path. The bookmark is revoked when the user taps "Clear" on the token.
- Reviewers without OpenClaw installed will see "Not configured" and can skip this integration entirely. The "Import token" button is also fully optional — reviewers can validate the panel without selecting any file.

### OpenCode (not in the App Store build)

OpenCode session monitoring is intentionally **not** part of the App Store build. Unlike Claude Code and Codex — which AgentDeck observes purely by receiving HTTP POSTs from hooks the user's own CLI executes — OpenCode ships no hook configuration mechanism, and its structured-event server binds to a random TCP port with no lock-file or other discoverable marker. Observing it would require either spawning the `opencode` process (forbidden in the sandbox) or open-ended local port scanning. The App Store build therefore does neither. OpenCode is supported only through the optional, separately-distributed Node.js developer bridge described at the top of these notes. No OpenCode-related copy in the App Store app prompts the user to install or launch anything.

### Codex observation path

Codex (OpenAI's CLI) is observed through a fully opt-in path that mirrors the Claude Code hook flow:

1. The user enables it from Settings → Integrations → "Enable Codex Observation…".
2. An `NSAlert` explains that AgentDeck will write Codex lifecycle hook entries into `~/.codex/config.toml`, with optional `notify` and `[otel]` fallback entries when the user has not already configured those channels.
3. On acceptance, an `NSOpenPanel` requires the user to explicitly pick `~/.codex/config.toml`. Only then do we acquire a security-scoped bookmark and write the entries.
4. AgentDeck only edits inside its own fenced TOML block (`# >>> AgentDeck managed (do not edit) <<<` / `# <<<` markers) — user keys (`model`, profiles, MCP servers) are preserved verbatim. If the user already wrote `[features]` or `[hooks]`, AgentDeck aborts instead of unsafe-merging lifecycle hooks. If the user already wrote a top-level `notify` or `[otel]`, AgentDeck still installs lifecycle hooks but omits that optional fallback/exporter to avoid duplicate keys.
5. The values written enable `[features] hooks = true` and inline `[[hooks.*]]` command hooks. Those commands resolve AgentDeck's local-only HTTP port and POST Codex hook JSON to `http://127.0.0.1:$PORT/hooks/codex_session_start`, `/hooks/codex_user_prompt_submit`, `/hooks/codex_tool_start`, `/hooks/codex_tool_end`, and `/hooks/codex_stop`. Optional fallback entries POST notify JSON to `/hooks/codex_turn_complete` and OTel JSON traces to `/otel/v1/traces` (`protocol = "json"`). All endpoints listen on `127.0.0.1` only. The OTel `endpoint` is rewritten on every daemon startup so it always reflects the actual port the daemon is bound to.
6. At runtime, Codex (the user's separately-installed CLI) is what eventually executes that snippet under its own process tree — not AgentDeck. AgentDeck itself only receives HTTP POSTs.

The Settings panel offers a "Remove" button that strips AgentDeck's fenced block and revokes the bookmark; it leaves all user-authored TOML keys untouched. Reviewers without Codex installed see "Not configured"; the panel remains inert.

Codex and OpenCode session execution from inside AgentDeck (PTY launch) is out of scope for the App Store build — users start their CLI themselves.

## APME evaluation module

AgentDeck can evaluate finished agent turns against configurable rubrics. In the App Store build:
- Default backend is **Apple Intelligence (Foundation Models)** — on-device, zero-cost, no network.
- Alternatives (MLX local server, Anthropic API) are opt-in and clearly labeled in Settings.
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

The iOS app (same bundle family `bound.serendipity.agent.deck`) is a read-only remote dashboard that auto-discovers a paired Mac via Bonjour. On first launch it runs a 3-pane onboarding walking the user through installing an agent on their Mac and finding their Mac on Wi-Fi. Fallback pairing via QR code (Mac shows → iPad scans) handles cases where Local Network permission is denied or the two devices are on different routable networks. No network-server entitlement is needed on iOS — it's a pure client.

## Review demo account

No account required. To see the app's features:

1. Launch the app. A first-run onboarding sheet walks the user through the value prop, available AI agents, and iPad pairing. Dismissing it opens the empty dashboard with a prompt to "Preview Devices".
2. Click "Preview Devices" from the menu bar to see how AgentDeck renders sessions on 12 built-in preview targets — no real hardware required.
3. After hooks are enabled, sessions the user starts independently appear automatically in the dashboard. AgentDeck never launches Terminal scripts or command-line tools itself.
4. Click "Pair iPad" to show a QR code the iOS companion app can scan.
5. Open Settings → Hardware Setup to see the in-app flows for ESP32 and Pixoo provisioning (no subprocess calls; writes serial config directly).

## Reviewing the conditional UI (optional)

The "Advanced developer integrations" panels described above do **not** appear during a normal review. Reviewers testing on a clean macOS install see only the standalone product — Device Preview shows the 12 built-in targets (Stream Deck, D200H, Apple Watch/iPad, ESP32, Pixoo, and terminal preview); the menu bar shows no Claude-subscription quota gauge. This is the intended out-of-the-box experience and is fully functional.

If a reviewer wishes to independently verify that those conditional panels are purely read-only WebSocket visualizations and not subprocess/file-I/O paths hiding in the shipped app, the optional reproduction path is:

1. Clone the public AgentDeck repository (link in the App Store description).
2. Follow the README's developer-install instructions to run `agentdeck daemon start` in a separate Terminal. This step is entirely outside the App Store app — it is the reviewer's own shell spawning a Node.js process.
3. Launch the App Store build of AgentDeck Dashboard. The Device Preview screen now lists additional rows (e.g. "Android e-ink", "Ulanzi TC001"); the menu bar surfaces the Claude subscription quota gauge.

At no point does AgentDeck itself install, download, or launch anything. The reviewer starts the external daemon in their own shell and observes the App Store app render the data that daemon broadcasts over `ws://127.0.0.1:9120`. The CI script `apple/scripts/verify-appstore-archive.sh` fails the build if the shipped Mach-O ever reintroduces a subprocess spawn path, a bundled Node.js/adb binary, a Contents/Helpers directory, or a home-relative-path entitlement.

## Contact

For anything unclear: `puritysb@gmail.com`.
