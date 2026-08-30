<p align="center">
  <img src="docs/media/agentdeck-icon.png" width="160" alt="AgentDeck icon — aquarium dome with octopus and crayfish on a Stream Deck control surface">
</p>

# AgentDeck

<p align="center">
  <a href="https://apps.apple.com/app/id6784822497"><img src="https://img.shields.io/badge/App%20Store-Mac%20%C2%B7%20iPhone%20%C2%B7%20iPad-1f6157.svg?logo=apple" alt="App Store — Mac, iPhone, and iPad"></a>
  <a href="https://play.google.com/store/apps/details?id=dev.agentdeck"><img src="https://img.shields.io/badge/Google%20Play-Android-1f6157.svg?logo=googleplay" alt="Google Play — Android"></a>
  <a href="https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464"><img src="https://img.shields.io/badge/Elgato%20Marketplace-Stream%20Deck%20plugin-1f6157.svg" alt="Elgato Marketplace"></a>
  <a href="https://ugc.ulanzistudio.com/contentView/1141"><img src="https://img.shields.io/badge/Ulanzi%20Marketplace-Studio%20plugin-1f6157.svg" alt="Ulanzi Marketplace"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="https://www.npmjs.com/package/@agentdeck/setup"><img src="https://img.shields.io/npm/v/@agentdeck/setup.svg" alt="npm version"></a>
  <a href="https://github.com/puritysb/AgentDeck/actions/workflows/ci.yml"><img src="https://github.com/puritysb/AgentDeck/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://puritysb.github.io/AgentDeck/"><img src="https://img.shields.io/badge/website-puritysb.github.io%2FAgentDeck-1f6157.svg" alt="Website"></a>
</p>

**Stop Chatting. Start Steering.**

AgentDeck puts your AI coding agents on a physical control surface. Every key is a
session: it shows which agent is running, in which project, and whether it is
working, waiting on you, or idle — and it repaints itself as that changes. Press a
key to jump in.

It started on an Elgato Stream Deck+ and now drives **29 surfaces** at once —
decks, tablets, e-ink readers, ESP32 panels, LED matrices, and your terminal.

<p align="center">
  <img src="docs/media/setup-full.jpg" width="820" alt="A desk running AgentDeck across many surfaces at once — Stream Deck+, Ulanzi D200H, tablets, e-ink, ESP32 panels, and LED matrices">
</p>

<p align="center">
  <a href="https://youtu.be/s-f8ICBcC4o"><strong>▶ Watch the demo</strong></a>
  &nbsp;·&nbsp;
  <a href="https://puritysb.github.io/AgentDeck/"><strong>🌊 Project website</strong></a>
  &nbsp;·&nbsp;
  <a href="https://puritysb.github.io/AgentDeck/hardware/">Devices</a>
  &nbsp;·&nbsp;
  <a href="https://puritysb.github.io/AgentDeck/demo/">Live preview</a>
  &nbsp;·&nbsp;
  <a href="https://puritysb.github.io/AgentDeck/design-system/">Design system</a>
</p>

---

## Start here

**You do not need a Stream Deck to try AgentDeck.** The daemon is the product; the
decks are one way to look at it. If you have a terminal, you can see it working in
about a minute.

### 1. Install

For the standalone native dashboard, [download AgentDeck Dashboard from the App Store](https://apps.apple.com/app/id6784822497) — macOS, with an iPhone/iPad companion on the same listing. The Mac app carries its own Swift daemon and needs no Node.js.

For the CLI daemon, terminal dashboard, and external integrations:

```bash
npx @agentdeck/setup
```

This installs the `agentdeck` CLI and the local daemon, and registers the lifecycle
hooks for whichever agent CLI you already have. Nothing else is required — the
Stream Deck app, Stream Deck hardware, and Xcode tools are checked and reported,
but never block the install.

**The two installs compose.** Each is complete on its own: the Mac app is a
fully standalone dashboard, and the npm CLI is a fully standalone daemon +
terminal dashboard. Install both on the same Mac and the app automatically
attaches to the CLI daemon, adding the CLI-tier capabilities on top — Claude
subscription quota gauges and ADB-driven Android/e-ink surfaces. The legacy
managed-terminal tier also retains PTY session launching and cross-machine
remote attach while daemon-first replacements are designed and validated. The
exact split is documented in
[docs/appstore-feature-matrix.md](docs/appstore-feature-matrix.md).

**The CLI path needs:** macOS 15+, Windows 11 ([guide](docs/windows.md)), or Linux
([guide](docs/linux.md)); Node.js 22+; and at least one supported agent. The native
App Store dashboard instead requires macOS 26+ and needs no Node.js. iPhone/iPad
companions require iOS/iPadOS 17+.

### 2. Look at it — no hardware required

```bash
agentdeck dashboard
```

A full terminal dashboard: your live sessions, a braille-rendered terrarium, usage
gauges, and the timeline. This is the zero-hardware way to see whether AgentDeck is
useful to you.

<p align="center">
  <img src="docs/media/tui-dashboard.png" width="720" alt="AgentDeck TUI dashboard in a terminal — sessions, braille terrarium, rate-limit gauges, and timeline">
</p>

### 3. Start observation, then run your agent normally

```bash
agentdeck daemon install   # installs/refreshes hooks and starts the daemon
claude                     # or: codex · opencode · kiro-cli
```

AgentDeck observes normal agent commands through lifecycle hooks and native event
channels.

Check the installed agent versions and the hook compatibility baselines without
launching a managed terminal:

```bash
agentdeck diag agents
```

> [!IMPORTANT]
> `agentdeck claude`, `agentdeck codex`, `agentdeck opencode`, and
> `agentdeck monitor` are legacy compatibility commands. They remain functional,
> and no removal date is set. For ordinary local sessions, prefer
> `agentdeck daemon install`, then run the agent normally. Managed-only features
> such as remote attach, `--weight`, `AGENTDECK_<AGENT>_ARGS`, terminal UI
> steering, and terminal telemetry do not yet have daemon-first equivalents.
> Share workflows and help design replacements in
> [Discussion #278](https://github.com/puritysb/AgentDeck/discussions/278);
> implementation and release work remain tracked in
> [#273](https://github.com/puritysb/AgentDeck/issues/273).

Kiro has no managed form at all — see [Agents](#agents) for why, and for what its
sessions do and do not report.

The legacy managed compatibility path can attach agents on **several machines** to
one deck on a main node. `--remote-daemon` is the opt-in switch — without it
nothing leaves the machine and the default stays local-only:

```bash
agentdeck claude --remote-daemon --daemon-host mainnode.lan   # explicit host (recommended)
agentdeck claude --remote-daemon                              # or auto-discover via mDNS on the LAN
```

Reverse control rides the worker's own outbound socket (the daemon never dials
back), so a worker only needs to reach the main node's port `9120` — for
SSH-only workers, `ssh -L 9120:localhost:9120 mainnode` then
`agentdeck claude --remote-daemon`. The main node must run the **Node CLI
daemon** (the macOS-app Swift daemon does not support remote attach and is
never auto-selected). See
[docs/daemon.md § Remote attach](docs/daemon.md#remote-attach-cross-machine-sessions).

### Official AgentDeck products and integrations

These products are maintained and released by the AgentDeck project. They attach
to the same daemon and can be added in any order:

| Official product / integration | How to attach |
|---|---|
| **macOS AgentDeck Dashboard** | [Download on the App Store](https://apps.apple.com/app/id6784822497) — the SwiftUI dashboard carries its own daemon, so it needs no Node.js |
| **iOS / Android AgentDeck Companion** | iPhone/iPad use the same [App Store listing](https://apps.apple.com/app/id6784822497); Android installs from [Google Play](https://play.google.com/store/apps/details?id=dev.agentdeck). Both pair with a daemon over the LAN. |
| **AgentDeck ESP32 Dashboard Firmware** | Flash panels and InkDeck from [**puritysb.github.io/AgentDeck/flash/**](https://puritysb.github.io/AgentDeck/flash/) or run `agentdeck esp32 flash <board>`. After the first USB flash, supported boards update over Wi-Fi OTA. |
| **Official Stream Deck integration** | Install for Stream Deck / Mini / XL / Plus / + XL from the [Elgato Marketplace](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464). |
| **Official Ulanzi integration** | Install from the [Ulanzi Studio Marketplace](https://ugc.ulanzistudio.com/contentView/1141). Version 1.0.3 is live for D200H; 1.0.4 is under review and adds D200X LCD-key support. D200X encoders remain unsupported. See the [listing/review status](marketplace/ulanzi/LISTING.md) or [build it yourself](plugin-ulanzi/VERIFY.md). |
| **Official device integrations** | Pixoo64, TC001, Timebox, and iDotMatrix are driven by the daemon — see [docs/devices.md](docs/devices.md). |

> **Android, Stream Deck, and Ulanzi are companion surfaces.** They talk to the
> AgentDeck daemon the way an OBS plugin talks to OBS, and never embed it. Keep the
> daemon running on the same computer/network; without it these surfaces show an
> offline or searching state.

### Compatible Companion Projects

Independent projects keep their own product identity, repository, releases, and
support tracker. They integrate through an allow-listed
[AgentDeck Surface Protocol v1](docs/surface-protocol.md) profile rather than making
the daemon's entire internal WebSocket API a public contract.

| Project | Level | Surface profile | What it does |
|---|---|---|---|
| [Pocket Daily Reader](https://github.com/puritysb/pocket-daily-reader) | Community | `portable-reader/v1` | Independent offline-first e-reader. Pulls bounded cards, Glance, and licensed SD learning-pack updates, records choices offline, and keeps AgentDeck as an invisible sync source. Published manifest remains `community` / `untested`. |
| [companion-module-agentdeck](https://github.com/houtacheng/companion-module-agentdeck) | Community | `companion-control/v1` | Independent Bitfocus Companion module for session tiles, approval controls, usage gauges, and status creatures (by [@houtacheng](https://github.com/houtacheng)). |

Pocket Daily's Feed/Outbox/telemetry/resumable-OTA runtime works with both the Node
CLI daemon and the macOS app's standalone Swift daemon. Node additionally provides
adaptive personal card modules and daemon-rendered Glance Frame pixels; see the
[runtime status](docs/surface-protocol.md#rollout-status).

Compatibility levels are **Community**, **Verified Compatible**, and **Official**.
Verified Compatible means a named release passed the published manifest and
conformance suite; it does not transfer maintenance or imply endorsement. Official
means AgentDeck-maintained. Definitions, version negotiation, capability policy, OTA
isolation, and the integration manifest schema are in the
[Surface Protocol](docs/surface-protocol.md).

Full build-from-source and manual steps: **[docs/install.md](docs/install.md)**.

---

## What it looks like on real hardware

<table>
<tr>
<td width="50%"><img src="docs/media/streamdeck-plus.jpg" alt="Stream Deck+ — eight session keys showing agent state, with the encoder LCD strip beneath"></td>
<td width="50%"><img src="docs/media/d200h.jpg" alt="Ulanzi D200H Deck Dock running AgentDeck session keys and quota gauges"></td>
</tr>
<tr>
<td><b>Stream Deck+</b> — one key per session, plus encoders for volume, quota, and launch</td>
<td><b>Ulanzi D200H</b> — 14 keys and a 960×540 LCD, driven by the official Ulanzi Studio plugin</td>
</tr>
<tr>
<td><img src="docs/media/inkdeck.jpg" alt="InkDeck 7.5-inch e-ink panel showing the AgentDeck session board"></td>
<td><img src="docs/media/android-eink.jpg" alt="Android e-ink reader showing the AgentDeck session list with partial refresh"></td>
</tr>
<tr>
<td><b>InkDeck e-ink</b> — 7.5" 800×480, custom firmware, updates over Wi-Fi OTA</td>
<td><b>Android e-ink</b> — reader-specific layouts with partial refresh</td>
</tr>
<tr>
<td><img src="docs/media/ipad.jpg" alt="iPad running the SwiftUI AgentDeck dashboard with the aquarium terrarium"></td>
<td><img src="docs/media/pixoo64.jpg" alt="Pixoo64 64x64 LED matrix showing pixel-art agent creatures"></td>
</tr>
<tr>
<td><b>Apple</b> — SwiftUI on macOS, iPhone, and iPad</td>
<td><b>Pixoo64</b> — 64×64 pixel-art terrarium and usage HUD</td>
</tr>
</table>

<p align="center">
  <strong><a href="https://puritysb.github.io/AgentDeck/hardware/">→ Browse all 29 surfaces, with live renderer previews</a></strong>
</p>

---

## What it does

- **Session per key** — agent, project, and state on every key, repainting live
- **Distinct attention state** — see at a glance which agent is waiting on *you*
- **Answer without switching windows** — YES / NO / ALWAYS with semantic colors
- **Interrupt** — STOP sends Ctrl+C to a runaway agent
- **Switch modes** — cycle Plan / Accept Edits / Default
- **Quick actions** — GO ON / REVIEW / COMMIT / CLEAR, plus custom prompt templates
- **Usage gauges** — subscription quota with reset countdowns
- **Weather context** — optional Apple Weather conditions on the macOS Dashboard; attributed seven-day Glance and offline cues for portable readers
- **Subagent count** — how many children a session has running, beside its own state
- **Voice** — push-to-talk and wake word, on-device via Apple SFSpeech, no model download
- **Display sync** — host sleep dims every surface; wake restores them

### Agents

| Agent | Status | How its state is read |
|---|---|---|
| **Claude Code** | Supported (primary) | Lifecycle hooks |
| **Codex CLI** | Supported | Lifecycle hooks + rollout JSONL |
| **Codex Desktop** | Observed (macOS; Windows verification pending) | Lifecycle hooks + rollout JSONL |
| **OpenCode** | Supported | Observer plugin (SSE) |
| **Kiro CLI / IDE** | Observed | Kiro's own transcript, polled |
| **Antigravity** | Observed (CLI daemon) | Passive process/session observation |
| **OpenClaw** | Experimental | Gateway |

State comes from agent-native lifecycle and event channels — hooks for Claude Code
and Codex, OpenCode SSE, the OpenClaw Gateway, Kiro transcript polling, and passive
Antigravity process/session observation — rather than terminal-screen scraping.
Deprecated CLI-managed sessions retain an optional terminal UI observer only for
real mode/diff/option affordances that those lifecycle payloads do not expose.

**Kiro is observed, never managed.** Run `kiro-cli` or the Kiro IDE exactly as
usual; there is no `agentdeck kiro` command, because Kiro's hook surface does not
fire for a CLI chat turn — its global standalone hooks load and then produce
nothing for a real turn. AgentDeck reads Kiro's own transcript instead, which
sets two honest expectations: a Kiro session shows up seconds late rather than
instantly, and it reads `idle` rather than `processing`, because a transcript
only gains its assistant record once the reply has landed. On the sandboxed
macOS app it needs a one-time folder grant in Settings → Integrations → Kiro CLI;
without one it observes nothing rather than guessing.

**Whose model answered is a separate question from which agent it is.** A Claude
Code session pointed at a third-party endpoint is still Claude Code — same
binary, same hooks — so it keeps its agent identity and the surfaces mark the
provider separately, only when the harness and the endpoint are both known and
disagree.

### How it fits together

```
                              ┌── Daemon (port 9120, sole hub) ──┐
Stream Deck Plugin ◄── WS ──►│                                   │
Ulanzi Studio keys ◄── WS ──►│                                   │
Android Dashboard  ◄── WS ──►│  WS Server + mDNS + Device Mods   │
Apple Dashboard    ◄── WS ──►│  Gateway Proxy + Usage Relay      │
TUI Dashboard      ◄── WS ──►│  Pixoo + ESP32 + Timebox + SSE    │
ESP32 Display      ◄ Serial ►│                                   │
Pixoo64 LED        ◄ HTTP ──►└───────────────┬───────────────────┘
                                             │ aggregates
                              ┌── Session Bridge (port 9121+) ──┐
User's Terminal ◄─ stdio ───►│  PTY Manager → agent CLI          │
Agent Hooks     ─── HTTP ───►│  Hook Server → State Machine      │
                              └──────────────────────────────────┘
```

One daemon aggregates every session and broadcasts to every surface. Interactive
surfaces (Stream Deck, Ulanzi D200H/D200X keys, Android, Apple) can steer when a
managed session supplies real options, or when an observed session advertises a
real answer-delivery path (`liveAnswerable`) through an ask-gate or terminal
injection. Otherwise the prompt is display-only. On macOS the SwiftUI app ships a
**standalone in-process Swift dashboard daemon** with no Node.js. The PTY Session
Bridge remains available as a CLI compatibility feature until its managed-only
workflows have validated daemon-first replacements.

Details: **[docs/architecture.md](docs/architecture.md)**.

---

## Documentation

**Start with the website** — [puritysb.github.io/AgentDeck](https://puritysb.github.io/AgentDeck/)
carries the rendered device catalog, live renderer previews, the design system, and
build health.

| | |
|---|---|
| **Using it** | [CLI reference](docs/cli.md) · [Configuration](docs/configuration.md) · [Troubleshooting](docs/troubleshooting.md) · [Windows](docs/windows.md) · [Linux](docs/linux.md) |
| **Surfaces** | [Hardware matrix](docs/hardware-compatibility.md) · [Stream Deck layout](docs/streamdeck-layout.md) · [Devices](docs/devices.md) · [ESP32](docs/esp32.md) · [Android](docs/android.md) · [Apple](docs/apple-app.md) · [TUI](docs/tui-dashboard.md) |
| **Internals** | [Architecture](docs/architecture.md) · [Surface protocol](docs/surface-protocol.md) · [Internal bridge protocol](docs/protocol.md) · [Daemon](docs/daemon.md) · [Gateway protocol](docs/gateway-protocol.md) · [Testing](docs/testing.md) |
| **Evaluation** | [Why APME](docs/why-apme.md) · [APME](docs/apme.md) · [Pipeline](docs/apme-pipeline.md) |
| **Design** | [DESIGN.md](DESIGN.md) · [Tokens](design/tokens.css) · [Resource map](design/RESOURCES.md) |
| **Project** | [Roadmap](docs/roadmap.md) · [Releasing](RELEASING.md) · [Changelog](CHANGELOG.md) · [Agent harness](docs/agent-harness.md) · [AI-assisted maintenance](docs/ai-assisted-maintenance.md) |

---

## Community

Bug reports, hardware verification, documentation fixes, and focused pull requests
are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), use the private process
in [SECURITY.md](SECURITY.md) for vulnerabilities, and follow the
[Code of Conduct](CODE_OF_CONDUCT.md) in project spaces. Maintainer use of coding
agents is human-owned and documented in
[AI-assisted maintenance](docs/ai-assisted-maintenance.md).

Independent integration submissions are welcome. Start with the
[Surface Protocol](docs/surface-protocol.md), publish an integration manifest in
your own repository, and keep support links pointed at the project that owns the
code. Listing an integration does not make AgentDeck its maintainer.

---

## Releases

One compatibility major across every artifact; target minor/patch versions and
delivery tags advance independently. A minor adds substantial backward-compatible
features, while a patch carries small fixes. Root [`VERSION`](VERSION) anchors
the compatibility major but is not a minor/patch ceiling — policy in [RELEASING.md](RELEASING.md),
builds on [Releases](https://github.com/puritysb/AgentDeck/releases).

| Channel | Tag | Status |
|---|---|---|
| **npm** — `@agentdeck/setup` | `npm-v*` | [1.1.0](https://github.com/puritysb/AgentDeck/releases/tag/npm-v1.1.0) live on the registry — all four packages (`shared`, `hooks`, `bridge`, `setup`) report exact version and `dist-tags.latest = 1.1.0`, read from the registry itself on 2026-08-26. This is the first minor under the compatibility-major policy |
| **Apple App Store** — macOS + iPhone/iPad | `apple-v*` | [1.0.8 live on both platforms](https://apps.apple.com/app/id6784822497) — build 5301, iPhone/iPad released 2026-08-22T18:41Z and macOS within the same window, each read from the store's own record rather than the approval mail. Submitted 2026-08-22; **each platform is its own submission draft in App Store Connect**, so one click per platform, not one for the app |
| **Elgato Marketplace** — Stream Deck plugin | `streamdeck-v*` | [1.0.6 live](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464) — published 2026-08-18, `status: published` on the product page's own payload |
| **Ulanzi Marketplace** — D200H / D200X plugin | `ulanzi-v*` | [1.0.3 live](https://ugc.ulanzistudio.com/contentView/1141) — submitted 2026-08-07, published on or before 2026-08-24, and carried in the public Plugins listing. **1.0.4 submitted 2026-08-24 and under review** (D200X keypad, Kiro/Antigravity marks, answerable OpenClaw prompts, de/es/pt locales); the portal's new *Create review version* flow leaves 1.0.3 serving while it is reviewed ([details](marketplace/ulanzi/LISTING.md)) |
| **GitHub Release** — Android APK | `android-v*` | [1.0.10](https://github.com/puritysb/AgentDeck/releases/tag/android-v1.0.10) |
| **GitHub Release** — ESP32 firmware | `esp32-v*` | [1.0.8](https://github.com/puritysb/AgentDeck/releases/tag/esp32-v1.0.8) — 52 assets published 2026-08-26: for each of the 10 boards in `shared/src/esp32-boards.ts` a merged factory image written at `0x0` plus the four loose parts, and a `manifest.json` + `SHA256SUMS.txt` whose sizes and hashes are computed from the artifacts |
| **Google Play** — Android AAB | `android-v*` | [1.0.10 live](https://play.google.com/store/apps/details?id=dev.agentdeck) (versionCode 12, published 2026-08-19 at 100% across 177 countries), superseding 1.0.9. Listing copy, assets and the console runbook are in [marketplace/play/](marketplace/play/LISTING.md) |

---

## Development

```bash
pnpm install && pnpm build     # shared must build before bridge/plugin
pnpm -r --parallel dev         # watch mode
pnpm test                      # Vitest (bridge, plugin, shared, hooks)
pnpm test:report               # unified: Vitest + Android + Apple + Robot
```

Four test frameworks cover the tree — Vitest for the Node/TS packages, JUnit +
Robolectric for Android, XCTest for Apple, and Robot Framework for ESP32 hardware.
Default CI runs Vitest, with path-scoped PR checks compiling Android (Gradle) and the
ESP32 render trees (host sim); the rest go through `scripts/test-report.sh`. Current
results are published at [/reports/](https://puritysb.github.io/AgentDeck/reports/).

Working on AgentDeck with a coding agent? Start at **[CLAUDE.md](CLAUDE.md)** and
**[docs/agent-harness.md](docs/agent-harness.md)** — they map how each agent enters
the repo and which skills it should use.

Full guide: **[docs/testing.md](docs/testing.md)** · Build from source:
**[docs/install.md](docs/install.md)**.

---

## License & attribution

MIT — see [LICENSE](LICENSE).

Independent project. Not affiliated with Anthropic, OpenAI, Google, Elgato, DIVOOM,
or any other third party referenced here. All trademarks belong to their respective
owners. Full notices in [ATTRIBUTION.md](ATTRIBUTION.md).
