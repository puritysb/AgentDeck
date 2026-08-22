<p align="center">
  <img src="docs/media/agentdeck-icon.png" width="160" alt="AgentDeck icon — aquarium dome with octopus and crayfish on a Stream Deck control surface">
</p>

# AgentDeck

<p align="center">
  <a href="https://apps.apple.com/app/id6784822497"><img src="https://img.shields.io/badge/App%20Store-Mac%20%C2%B7%20iPhone%20%C2%B7%20iPad-1f6157.svg?logo=apple" alt="App Store — Mac, iPhone, and iPad"></a>
  <a href="https://play.google.com/store/apps/details?id=dev.agentdeck"><img src="https://img.shields.io/badge/Google%20Play-Android-1f6157.svg?logo=googleplay" alt="Google Play — Android"></a>
  <a href="https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464"><img src="https://img.shields.io/badge/Elgato%20Marketplace-Stream%20Deck%20plugin-1f6157.svg" alt="Elgato Marketplace"></a>
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

It started on an Elgato Stream Deck+ and now drives **26 surfaces** at once —
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

For the CLI, terminal dashboard, and PTY steering:

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
subscription quota gauges, ADB-driven Android/e-ink surfaces, PTY session
launching, and cross-machine remote attach. The exact split is documented in
[docs/appstore-feature-matrix.md](docs/appstore-feature-matrix.md).

**You need:** macOS 15+ (or Windows 11 — see [docs/windows.md](docs/windows.md), or
Linux — see [docs/linux.md](docs/linux.md)), Node.js 22+, and at least one agent CLI
(Claude Code, Codex, or OpenCode).

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
channels. `agentdeck claude`, `agentdeck codex`, and `agentdeck opencode` remain
available when you specifically want a managed terminal, session weights, or
cross-machine remote attach; they are not required for ordinary local monitoring.
Kiro has no managed form at all — see [Agents](#agents) for why, and for what its
sessions do and do not report.

Running agents on **several machines** with one deck on a main node? Sessions can
attach to the main node's daemon. `--remote-daemon` is the opt-in switch — without
it nothing leaves the machine and the default stays local-only:

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

### Then add surfaces

Any of these attach to the same daemon, and you can add them in any order:

| Surface | How to attach |
|---|---|
| **Stream Deck / Mini / XL / Plus / + XL** | One click from the [Elgato Marketplace](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464) — or `cd plugin && streamdeck link bound.serendipity.agentdeck.sdPlugin` from a checkout |
| **Ulanzi D200H** | Install the plugin in Ulanzi Studio — see [plugin-ulanzi/VERIFY.md](plugin-ulanzi/VERIFY.md) |
| **macOS app** | [Download on the App Store](https://apps.apple.com/app/id6784822497) — the SwiftUI dashboard carries its own daemon, so it needs no Node.js |
| **iPhone / iPad companion** | Same [App Store listing](https://apps.apple.com/app/id6784822497) — pairs with a daemon on your Mac over the LAN (QR pairing) |
| **Android tablet / e-ink** | [Install from Google Play](https://play.google.com/store/apps/details?id=dev.agentdeck) (recommended), or use the signed APK from [Releases](https://github.com/puritysb/AgentDeck/releases). Android is a companion dashboard: keep the AgentDeck daemon running on a Mac/PC on the same network. See the [3-step setup guide](docs/android.md#quick-start-google-play-or-github-apk). |
| **ESP32 panels · InkDeck e-ink** | Flash firmware, then Wi-Fi OTA — see [docs/esp32.md](docs/esp32.md) |
| **Pixoo64 · TC001 · Timebox · iDotMatrix** | `agentdeck pixoo scan` / `agentdeck timebox scan` — see [docs/devices.md](docs/devices.md) |

> **Android, Stream Deck, and Ulanzi are companion surfaces.** They talk to the
> AgentDeck daemon the way an OBS plugin talks to OBS, and never embed it. Keep the
> daemon running on the same computer/network; without it these surfaces show an
> offline or searching state.

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
  <strong><a href="https://puritysb.github.io/AgentDeck/hardware/">→ Browse all 26 surfaces, with live renderer previews</a></strong>
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
- **Subagent count** — how many children a session has running, beside its own state
- **Voice** — push-to-talk and wake word, on-device via Apple SFSpeech, no model download
- **Display sync** — host sleep dims every surface; wake restores them

### Agents

| Agent | Status | How its state is read |
|---|---|---|
| **Claude Code** | Supported (primary) | Lifecycle hooks |
| **Codex CLI** | Supported | Lifecycle hooks + rollout JSONL |
| **OpenCode** | Supported | Observer plugin (SSE) |
| **Kiro** | Observed | Kiro's own transcript, polled |
| **OpenClaw** | Experimental | Gateway |

State comes from agent-native lifecycle and event channels — hooks for Claude Code
and Codex, OpenCode SSE, and the OpenClaw Gateway — rather than terminal-screen
scraping. CLI-managed sessions retain an optional terminal UI observer only for
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
D200H via Studio  ◄── WS ──►│                                   │
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
surfaces (Stream Deck, D200H, Android, Apple) can steer when a PTY-managed session
supplies real options; observed sessions remain display-only. On macOS the SwiftUI
app ships a **standalone in-process Swift dashboard daemon** with no Node.js. The
PTY Session Bridge remains a CLI feature.

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
| **Internals** | [Architecture](docs/architecture.md) · [Daemon](docs/daemon.md) · [Protocol](docs/protocol.md) · [Gateway protocol](docs/gateway-protocol.md) · [Testing](docs/testing.md) |
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

### Community integrations

Independent projects that drive AgentDeck through the daemon's WebSocket API.
Each is maintained by its own author — report issues on that project's tracker,
not here. The daemon protocol has no stability guarantee for external clients;
changes aim to be additive, but integrations are expected to track
[`shared/src/protocol.ts`](shared/src/protocol.ts) themselves.

| Integration | What it does |
|---|---|
| [companion-module-agentdeck](https://github.com/houtacheng/companion-module-agentdeck) | Unofficial [Bitfocus Companion](https://bitfocus.io/companion) module — session tiles, approval queue, usage gauges, and creatures on any Companion-supported surface (by [@houtacheng](https://github.com/houtacheng)) |

---

## Releases

One `major.minor` compatibility line across every artifact; target patches and
delivery tags advance independently without patch-order constraints. Root [`VERSION`](VERSION) anchors the compatibility line but is not a patch ceiling — policy in [RELEASING.md](RELEASING.md),
builds on [Releases](https://github.com/puritysb/AgentDeck/releases).

| Channel | Tag | Status |
|---|---|---|
| **npm** — `@agentdeck/setup` | `npm-v*` | [1.0.22](https://github.com/puritysb/AgentDeck/releases/tag/npm-v1.0.22) live on the registry |
| **Apple App Store** — macOS + iPhone/iPad | `apple-v*` | [1.0.7 live on both platforms](https://apps.apple.com/app/id6784822497) — build 5201, iPhone/iPad released 2026-08-18 and macOS 2026-08-19 (each verified against the store's own record, not the approval mail). **1.0.8 submitted 2026-08-22 on build 5301, both platforms Waiting for Review** (each platform is its own submission draft in App Store Connect — one click per platform, not one for the app) |
| **Elgato Marketplace** — Stream Deck plugin | `streamdeck-v*` | [1.0.6 live](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464) — published 2026-08-18, `status: published` on the product page's own payload |
| **Ulanzi Marketplace** — D200H plugin | `ulanzi-v*` | [1.0.3 release](https://github.com/puritysb/AgentDeck/releases/tag/ulanzi-v1.0.3); submitted 2026-08-07, **still under review** as of 2026-08-20 and never published. The reviewer confirmed on 2026-08-14 that review had begun with no outstanding issues ([details](marketplace/ulanzi/LISTING.md)) |
| **GitHub Release** — Android APK | `android-v*` | [1.0.10](https://github.com/puritysb/AgentDeck/releases/tag/android-v1.0.10) |
| **GitHub Release** — ESP32 firmware | `esp32-v*` | [1.0.6](https://github.com/puritysb/AgentDeck/releases/tag/esp32-v1.0.6) — one binary per Shipping board. Only `ips_10` differs from 1.0.5 in anything but the version string |
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
