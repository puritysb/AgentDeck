# Changelog

All delivery channels share one `major.minor` compatibility line. Patch versions
and prefixed release tags (`apple-v*`, `streamdeck-v*`, `ulanzi-v*`, `npm-v*`,
`android-v*`, `esp32-v*`) advance independently by target. Root `VERSION` is the
repository baseline, not a patch ceiling: any numeric `A.B.C` and `A.B.D` are
mutually compatible. `pnpm verify-version` gates the shared `A.B` line and
target-internal version consistency. See [RELEASING.md](RELEASING.md).

## 1.0.5

### CLI and daemon — npm

- Validate the daemon port before a hook constructs a loopback URL, so a
  malformed or hostile port value cannot steer the request
  ([#105](https://github.com/puritysb/AgentDeck/pull/105))
- Discover iDotMatrix-protocol panels by advertised service UUID and known name
  families rather than the `IDM-` vendor prefix, so a rebranded but
  protocol-identical display (iPixel) is found by a scan instead of needing a
  hand-written address; `idotmatrixNamePrefixes` in `settings.json` widens the
  name fallback without a release
  ([#115](https://github.com/puritysb/AgentDeck/issues/115))
- Surface Claude per-model scoped usage limits, and date the Codex snapshot so a
  frozen percentage can no longer read as live
  ([#99](https://github.com/puritysb/AgentDeck/pull/99),
  [#121](https://github.com/puritysb/AgentDeck/pull/121))
- Resolve Claude usage OAuth credentials on Windows and Linux instead of only
  macOS ([#98](https://github.com/puritysb/AgentDeck/pull/98))
- Observe Codex Desktop sessions through OpenTelemetry and lifecycle hooks, and
  discover top-level Desktop rollouts without blocking scans
  ([#109](https://github.com/puritysb/AgentDeck/pull/109),
  [#111](https://github.com/puritysb/AgentDeck/pull/111))
- Track the interactive-prompt lifecycle through concurrent spinner redraws, so
  a queued prompt no longer leaves a session stuck awaiting
  ([#108](https://github.com/puritysb/AgentDeck/pull/108))
- Add an adaptive offline card feed with calendar events and an offline-reader
  projection, plus daemon-rendered glance frames for pull clients
  ([#110](https://github.com/puritysb/AgentDeck/pull/110),
  [#112](https://github.com/puritysb/AgentDeck/pull/112))
- Carry host push-to-talk from the deck through the daemon's voice ingest and
  egress path, including device audio replies
- Add `--weight` as an explicit deck/tab sort override, and
  `AGENTDECK_COMMANDER_ARGS` / `AGENTDECK_<AGENT>_ARGS` as env-var default
  session arguments ([#62](https://github.com/puritysb/AgentDeck/pull/62),
  [#93](https://github.com/puritysb/AgentDeck/pull/93))
- Add opt-in cross-machine session attach over the existing daemon socket
  ([#53](https://github.com/puritysb/AgentDeck/pull/53)) and a Linux systemd
  `--user` daemon unit ([#54](https://github.com/puritysb/AgentDeck/pull/54))
- Stage ESP32 firmware for pull OTA
  ([#113](https://github.com/puritysb/AgentDeck/pull/113))
- Show subagent work as activity rather than as separate sessions

## 1.0.4

### CLI and daemon

- Ship the iDotMatrix and Timebox Mini Python BLE clients in
  `@agentdeck/bridge` instead of resolving files that only exist in a source
  checkout
- Prepare optional BLE dependencies lazily under
  `~/.agentdeck/python-ble`, preserving npm installs as PyPI-free and keeping
  the environment across global package upgrades
- Report missing or unprepared BLE support with `agentdeck ble status` /
  `agentdeck ble setup` guidance instead of crashing on a missing Python
  executable or silently disabling daemon sync

## 1.0.3

### Stream Deck plugin

- Restore Windows Marketplace installation instead of disabling an existing
  locally linked plugin when the macOS-only store manifest is applied
- Make Volume functional on Windows through built-in media keys and make
  Launcher/offline help open Start-menu apps or browser fallbacks, while
  preserving richer macOS volume readback and existing-tab focus

### CLI and daemon

- Stop the Node Bonjour publisher from claiming the Mac's own `.local` hostname
  and triggering macOS collision handling that renamed the computer on every
  daemon start
- Use a process-scoped service host that remains stable across sleep/wake and
  network recovery re-publication without mutating the system LocalHostName

### Android dashboard

- Preserve observed AskUserQuestion activity so attention prompts remain visible
  instead of being folded into low-signal tool noise
- Show Claude and Codex subagent work as decorative orbiting activity around the
  parent creature without creating extra sessions or control targets
- Pair subagent start/completion rows per parent session and expire orphaned
  activity so stale satellites do not remain on the dashboard

## 1.0.2

### ESP32 firmware

- Ship firmware for **every board marked Shipping** — T-Embed CC1101,
  T-Display-S3-Pro and the Waveshare C6-LCD-1.47 had no downloadable binary in
  `1.0.1` because the release matrix listed seven boards while ten were
  supported
- Name each asset by the board's canonical id (`agentdeck-ips_10.bin`), the same
  string `agentdeck esp32-ota <target>` takes, so a downloaded file is directly
  the update target; add `SHA256SUMS.txt` and the Wi-Fi OTA instructions
- Restore linking on the ESP32-classic boards: the per-session option list had
  grown `g_state` past TTGO's DRAM segment, so TTGO and TC001 now cap that array
  at two entries — neither surface can render an option list
- Voice: push-to-talk on the IPS10 touch panel and the T-Embed encoder, with the
  reply spoken back through the board's own speaker where one exists
- Restore JC8012P4A1C touch: the vendor-derived clear sequence wrote `0x88`,
  while `0x80` is the Silead touch-count register that actually starts the
  panel's scan core
- InkDeck and XTeink glance rendering, camera show-and-tell on the Focus Strip,
  and a Pocket phone-style UI for the camera strip

### Daemon and timeline

- Keep the Node daemon discovery registry healthy while the process is running,
  restoring a missing, malformed, or stale `daemon.json` every ten seconds
- Preserve hook timeline ingestion when the daemon binds a fallback port instead
  of silently sending Claude Code and Codex lifecycle events to an empty port
- Avoid overwriting another live daemon's discovery record during self-repair

### macOS and Android timeline

- Keep a focused observed Claude, Codex, OpenCode, Antigravity, or Codex App
  session visible when session-list IDs carry an `observed:<provider>:` prefix
  but timeline events use the agent's raw session ID
- Mirror the same session-ID canonicalization in macOS, Android, and the Node
  per-session history query to prevent client-specific timeline gaps

### Stream Deck plugin

- **Published on the Elgato Marketplace** (approved 2026-07-28) — the plugin now
  installs in one click from
  [its Marketplace listing](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464)
  instead of requiring a checkout and `streamdeck link`
- Remove MODEL key tiles entirely from passively observed Claude, Codex, and
  OpenCode sessions; model information without a deliverable selection action
  no longer occupies a button-shaped surface in idle, processing, or awaiting
  states

## 1.0.1

Maintenance release across independently delivered channels — reliability fixes
that landed after the 1.0.0 build (03ed5a94) went to the App Store. Channels ship
on their own schedules; the iOS companion carries its fix on a later train while
1.0.0 finishes review.

### macOS app — App Store

- Fix the dashboard failing to attach to its own in-process daemon (WS connect
  handler was being clobbered and ports were mis-probed)
- Remove an actor-isolated closure that could trap at runtime
- Display-sleep correctness: re-sync `display_state` to clients, disarm two dim
  traps, and make iDotMatrix "off" render actually dark
- Recover a wedged ESP32 serial port by backing off instead of resetting the board
- Stop dropping whole tail windows on a split UTF-8 character (restores the Codex
  usage gauge)

### Stream Deck plugin — Elgato Marketplace

- Keep observed-agent processing details capability-aware on every keypad size:
  show the current model once as an inert readout instead of filling every unused
  key with duplicate `MODEL` tiles
- Preserve the notify-only Codex contract: processing details expose no steering
  action that the observed session cannot deliver

### Ulanzi plugin — D200H

- Publish the current self-contained 1.0.1 bundle for every declared macOS and
  Windows architecture
- Keep D200H rendering dark while the host display sleeps instead of allowing a
  later session repaint to wake the keys

### iOS companion (ships after 1.0.0 review completes)

- Hold the screen awake while the paired Mac's display is on

## 1.0.0

First public release. Previous 0.x versions were development and TestFlight-only builds.

### macOS / iOS app — App Store

The macOS app is **standalone**: it embeds an in-process Swift daemon and needs no
Node.js, no CLI, and no companion install. The iOS/iPadOS app is a read-only
companion that pairs with a Mac on the same network.

- Live session dashboard for Claude Code, Codex, OpenCode, and OpenClaw — state,
  tool calls, timeline, and token/usage gauges
- APME evaluation — per-turn scoring, cost accounting, and a Pareto-frontier model
  recommender
- Device Preview gallery — 17 hardware surfaces rendered without owning any hardware
- Local-network pairing over Bonjour with QR-code enrollment
- Voice input via on-device speech recognition
- Opt-in Claude Code hook installer

Sandboxed with no subprocess execution, no home-relative-path entitlement, and no
App Groups; the local WebSocket accepts same-machine and paired-companion clients only.

### Stream Deck plugin — Elgato Marketplace

- Session-per-button keypad layout with encoder dials and a live touch-strip timeline
- Renders an explicit OFFLINE state when no daemon is present
- Requires the Stream Deck app 6.9+

### Ulanzi plugin — Ulanzi Marketplace

- D200H Deck Dock support through a single dynamic action whose keys reflow by agent
  state (sessions, options, mode, stop, usage)
- Ships `@resvg/resvg-js` native binaries for every declared macOS/Windows target
- Requires Ulanzi Studio 2.1.4+

### CLI and daemon — npm (optional)

`npx @agentdeck/setup` installs the `agentdeck` CLI, daemon hub, and lifecycle hooks
for Claude Code, Codex, and OpenCode. This unlocks the Tier-2 surfaces the sandboxed
app cannot reach — ADB-bridged Android devices, serial/BLE matrix displays, and
ESP32 WiFi OTA. Everything in the App Store app works without it.

### Android app — GitHub Release (APK)

E-ink-first dashboard for CremaS, Onyx, Kobo, and tablets. Not distributed through
Google Play.

### ESP32 firmware — GitHub Release

Prebuilt firmware for 86 Box, IPS 3.5", Round AMOLED, IPS 10.1", InkDeck (7.5"
e-ink), and TTGO T-Display. Flash over USB, then update over WiFi with
`agentdeck esp32-ota <target>`.
