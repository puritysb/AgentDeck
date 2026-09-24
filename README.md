<p align="center">
  <img src="docs/media/agentdeck-icon.png" width="96" alt="AgentDeck icon — aquarium dome with octopus and crayfish on a Stream Deck control surface">
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

**Your AI agents, at a glance. Across your desk.**

AgentDeck brings your AI agents into one local dashboard. See which are working, waiting for you, or finished—across
projects and tools. Watch them in a living aquarium, follow the timeline, and
keep usage limits in view. Use your Mac or terminal on its own, or add a tablet,
Stream Deck, e-ink reader, or small desk display.

<p align="center">
  <a href="docs/media/setup-full.jpg"><img src="docs/media/setup-full.jpg" width="900" alt="AgentDeck running across a real desk: terminal and desktop dashboards, tablets, Stream Deck and Ulanzi controls, e-ink readers, ESP32 panels, and LED matrices"></a>
</p>

**Start with what you already have. No extra hardware required.**
Use your Mac or terminal on its own, then add the displays that fit your desk.

[**Get started →**](#start-here) · [**Choose your view ↓**](#choose-your-view) ·
[Watch the hardware desk tour](https://youtu.be/s-f8ICBcC4o)

<p align="center">
  <a href="https://puritysb.github.io/AgentDeck/#aquarium"><strong>▶ Watch the aquarium demo</strong></a>
  &nbsp;·&nbsp;
  <a href="https://puritysb.github.io/AgentDeck/"><strong>🌊 Project website</strong></a>
  &nbsp;·&nbsp;
  <a href="https://puritysb.github.io/AgentDeck/hardware/">Devices</a>
  &nbsp;·&nbsp;
  <a href="https://puritysb.github.io/AgentDeck/demo/">Live preview</a>
  &nbsp;·&nbsp;
  <a href="https://puritysb.github.io/AgentDeck/design-system/">Design system</a>
</p>

## Choose your view

One local daemon connects your sessions to these screens and controls.
Pick one or use several together. Click any image to see it at full size.

### Screens and controls

<table>
<tr>
<td width="50%" valign="top">
<a href="docs/media/streamdeck-plus.jpg"><img src="docs/media/streamdeck-plus.jpg" width="440" alt="Stream Deck+ running AgentDeck — Live session keys and physical controls at your fingertips."></a><br>
<b>Stream Deck+</b><br>
Live session keys and physical controls at your fingertips.<br>
<a href="docs/streamdeck-layout.md">Setup guide →</a>
</td>
<td width="50%" valign="top">
<a href="docs/media/tui-dashboard.png"><img src="docs/media/tui-dashboard.png" width="440" alt="Terminal / TUI running AgentDeck — Sessions, a braille aquarium, usage, and timeline. No extra hardware."></a><br>
<b>Terminal / TUI</b><br>
Sessions, a braille aquarium, usage, and timeline. No extra hardware.<br>
<a href="docs/tui-dashboard.md">Setup guide →</a>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/media/ipad.jpg"><img src="docs/media/ipad.jpg" width="440" alt="iPad running AgentDeck — A native companion dashboard on your tablet. Also available on iPhone."></a><br>
<b>iPad</b><br>
A native companion dashboard on your tablet. Also available on iPhone.<br>
<a href="docs/apple-app.md">Setup guide →</a>
</td>
<td width="50%" valign="top">
<a href="docs/media/android-tablet.jpg"><img src="docs/media/android-tablet.jpg" width="440" alt="Android tablet running AgentDeck — Give a tablet a place on your desk as a dedicated dashboard."></a><br>
<b>Android tablet</b><br>
Give a tablet a place on your desk as a dedicated dashboard.<br>
<a href="docs/android.md">Setup guide →</a>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/media/d200h.jpg"><img src="docs/media/d200h.jpg" width="440" alt="Ulanzi D200H running AgentDeck — Physical session keys. D200X LCD keys are also supported."></a><br>
<b>Ulanzi D200H</b><br>
Physical session keys. D200X LCD keys are also supported.<br>
<a href="docs/devices.md">Setup guide →</a>
</td>
<td width="50%" valign="top">
<a href="docs/media/android-eink.jpg"><img src="docs/media/android-eink.jpg" width="440" alt="Android e-ink reader running AgentDeck — A quiet view of your sessions beside your work."></a><br>
<b>Android e-ink reader</b><br>
A quiet view of your sessions beside your work.<br>
<a href="docs/android.md">Setup guide →</a>
</td>
</tr>
</table>

### Small displays, different shapes

<table>
<tr>
<td width="50%" valign="top">
<a href="docs/media/round-amoled.jpg"><img src="docs/media/round-amoled.jpg" width="440" alt="Round AMOLED running AgentDeck — A circular ESP32 display with an aquarium and usage gauges."></a><br>
<b>Round AMOLED</b><br>
A circular ESP32 display with an aquarium and usage gauges.<br>
<a href="docs/esp32.md">Setup guide →</a>
</td>
<td width="50%" valign="top">
<a href="docs/media/trmnl_75.jpg"><img src="docs/media/trmnl_75.jpg" width="440" alt="TRMNL 7.5-inch running AgentDeck — A large e-ink status board running AgentDeck firmware."></a><br>
<b>TRMNL 7.5-inch</b><br>
A large e-ink status board running AgentDeck firmware.<br>
<a href="docs/esp32.md">Setup guide →</a>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/media/t-embed.jpg"><img src="docs/media/t-embed.jpg" width="440" alt="LilyGo T-Embed running AgentDeck — A compact session display with a rotary dial."></a><br>
<b>LilyGo T-Embed</b><br>
A compact session display with a rotary dial.<br>
<a href="docs/esp32.md">Setup guide →</a>
</td>
<td width="50%" valign="top">
<a href="docs/media/t-display-pro.jpg"><img src="docs/media/t-display-pro.jpg" width="440" alt="LilyGo T-Display-S3-Pro running AgentDeck — A small touch display for sessions and usage."></a><br>
<b>LilyGo T-Display-S3-Pro</b><br>
A small touch display for sessions and usage.<br>
<a href="docs/esp32.md">Setup guide →</a>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/media/epd47.jpg"><img src="docs/media/epd47.jpg" width="440" alt="LilyGo EPD47 running AgentDeck — A grayscale e-ink panel showing your session queue."></a><br>
<b>LilyGo EPD47</b><br>
A grayscale e-ink panel showing your session queue.<br>
<a href="docs/esp32.md">Setup guide →</a>
</td>
<td width="50%" valign="top">
<a href="docs/media/ips35.jpg"><img src="docs/media/ips35.jpg" width="440" alt="ESP32 IPS 3.5-inch running AgentDeck — A portrait aquarium for a narrow space on your desk."></a><br>
<b>ESP32 IPS 3.5-inch</b><br>
A portrait aquarium for a narrow space on your desk.<br>
<a href="docs/esp32.md">Setup guide →</a>
</td>
</tr>
</table>

### Pixel displays

<table>
<tr>
<td width="50%" valign="top">
<a href="docs/media/pixoo64.jpg"><img src="docs/media/pixoo64.jpg" width="440" alt="Divoom Pixoo64 running AgentDeck — A 64 × 64 pixel-art aquarium."></a><br>
<b>Divoom Pixoo64</b><br>
A 64 × 64 pixel-art aquarium.<br>
<a href="docs/devices.md">Setup guide →</a>
</td>
<td width="50%" valign="top">
<a href="docs/media/tc001.jpg"><img src="docs/media/tc001.jpg" width="440" alt="Ulanzi TC001 running AgentDeck — Agent creatures across a wide LED clock display."></a><br>
<b>Ulanzi TC001</b><br>
Agent creatures across a wide LED clock display.<br>
<a href="docs/devices.md">Setup guide →</a>
</td>
</tr>
<tr>
<td width="50%" valign="top">
<a href="docs/media/timebox.jpg"><img src="docs/media/timebox.jpg" width="440" alt="Divoom Timebox Mini running AgentDeck — Agent status on a tiny 11 × 11 pixel display."></a><br>
<b>Divoom Timebox Mini</b><br>
Agent status on a tiny 11 × 11 pixel display.<br>
<a href="docs/devices.md">Setup guide →</a>
</td>
<td width="50%" valign="top">
<a href="docs/media/idotmatrix.jpg"><img src="docs/media/idotmatrix.jpg" width="440" alt="iDotMatrix running AgentDeck — A 32 × 32 LED view of your agents."></a><br>
<b>iDotMatrix</b><br>
A 32 × 32 LED view of your agents.<br>
<a href="docs/devices.md">Setup guide →</a>
</td>
</tr>
</table>

**[Explore all supported devices and live previews →](https://puritysb.github.io/AgentDeck/hardware/)**

Mobile apps and hardware connect to a daemon on your computer. Controls are
available when the session exposes a supported control path; other surfaces
show status. See the [hardware compatibility matrix](docs/hardware-compatibility.md)
for model-specific capabilities, including D200X encoder limitations.

## A dashboard that feels alive

**On your Mac, no extra hardware required.** Watch the native app in action below.

<p align="center">
  <a href="https://puritysb.github.io/AgentDeck/#aquarium"><img src="docs/media/aquarium-preview.gif" width="720" alt="Native 3D aquarium in motion — agent creatures and schooling fish; click to watch the full video"></a>
</p>

Choose the familiar dashboard or the **native 3D aquarium** on Mac, iPhone/iPad,
and Android LCD devices. Each session becomes a creature; its activity changes
its movement, and nearby fish react. On mobile, tap empty water to hide the
panels and move closer. Tap again to return. Existing preferences are preserved.

The demo follows a fictional coding task in the real native app: agents join,
edit code, run tests, wait for permission, and finish. No private workspace data
is shown. [Watch the high-resolution story](https://puritysb.github.io/AgentDeck/#aquarium)
or take the [hardware desk tour](https://youtu.be/s-f8ICBcC4o).

## What it does

- **Follow parallel work.** Session names, current tools, and a shared timeline
  explain what each agent is doing. Collaboration shows reported subagents,
  task relationships, and recent task history.
- **Notice when you are needed.** Permission and input requests stand out.
  Answer or interrupt from supported surfaces when the session provides a real
  control path; otherwise prompts are display-only.
- **Keep usage visible.** Claude, Codex, and z.ai/GLM gauges appear where the
  connected provider supplies usage data. Agent identity and model provider
  remain separate.
- **Choose your display.** The 3D scene keeps up to eight foreground residents
  readable while the roster retains every session. E-ink uses a static rendered
  backdrop and restrained motion; compact panels keep their focused layouts.

## Start here

**No extra hardware required.** Choose a native dashboard or the terminal path.

### Mac, iPhone, and iPad

[Install from the App Store](https://apps.apple.com/app/id6784822497).
The Mac app includes its own daemon and needs no Node.js. Enable your agent
integrations in Settings, then run your agents normally. iPhone/iPad pair with
an AgentDeck daemon on your network.

Requires macOS 26+ or iOS/iPadOS 17+. See the [Apple guide](docs/apple-app.md).

### Terminal, Windows, Linux, and external integrations

Requires Node.js **22, 24, or 26** and a supported agent on macOS 15+,
[Windows 11](docs/windows.md), or [Linux](docs/linux.md).

```bash
npx @agentdeck/setup
agentdeck daemon install   # refresh hooks and start observation
claude                     # or: codex · opencode · kiro-cli
```

In another terminal:

```bash
agentdeck dashboard        # live sessions, aquarium, usage, and timeline
```

The Mac app can also attach to the CLI daemon for additional integrations,
including Claude subscription gauges and ADB device support.
[Compare capabilities](docs/appstore-feature-matrix.md).
For setup problems, run `agentdeck diag agents` or see
[installation](docs/install.md) and [troubleshooting](docs/troubleshooting.md).

<details>
<summary>Existing managed sessions and remote attach</summary>

`agentdeck claude`, `agentdeck codex`, `agentdeck opencode`, and
`agentdeck monitor` remain functional, with no removal date. Ordinary local
sessions should use the daemon with normal agent commands. Managed-only remote
attach, `--weight`, agent argument overrides, and terminal steering remain
available until replacements are validated. See the
[CLI reference](docs/cli.md),
[remote attach guide](docs/daemon.md#remote-attach-cross-machine-sessions), and
[migration discussion](https://github.com/puritysb/AgentDeck/discussions/278).

</details>

## Agents

AgentDeck is growing beyond coding workflows. **Hermes Agent integration is
planned**; it is not available yet. The table below lists current integrations
and how each is observed.

| Agent | Observation |
|---|---|
| **Claude Code** | Lifecycle hooks; primary supported integration |
| **Codex CLI** | Lifecycle hooks and rollout logs |
| **Codex Desktop** | Observed on macOS; Windows verification pending |
| **OpenCode** | Observer plugin and native events |
| **Kiro CLI / IDE** | Transcript observation; delayed, idle-only activity |
| **Antigravity** | Passive observation through the CLI daemon |
| **OpenClaw** | Experimental Gateway integration |

Run agents normally; AgentDeck reads their native events rather than scraping
terminal screens. Kiro has no managed launcher, and the sandboxed Mac app needs
a one-time folder grant for its transcripts. Detailed setup and limitations:
[configuration](docs/configuration.md), [Apple guide](docs/apple-app.md), and
[Gateway guide](docs/gateway-protocol.md).

## Releases

### Compatibility and delivery channels

Use the channel for your device. Components with the same major version work
together: a 1.0 device can connect to a 1.5 daemon. Minor and patch versions
advance independently; you do not need to update every device together.

| Product | Install / update | Release tag |
|---|---|---|
| Mac · iPhone · iPad | [App Store](https://apps.apple.com/app/id6784822497) | `apple-v*` |
| Android tablets and e-ink | [Google Play](https://play.google.com/store/apps/details?id=dev.agentdeck) · [signed GitHub APK](https://github.com/puritysb/AgentDeck/releases?q=android-v&expanded=true) | `android-v1.5.0` |
| CLI + daemon | [`npx @agentdeck/setup`](https://www.npmjs.com/package/@agentdeck/setup) | `npm-v1.4.2` |
| Stream Deck / Mini / XL / Plus / + XL | [Elgato Marketplace](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464) | `streamdeck-v*` |
| Ulanzi D200H / D200X LCD keys | [Ulanzi Marketplace](https://ugc.ulanzistudio.com/contentView/1141); D200X encoders are not supported | `ulanzi-v*` |
| ESP32 panels and TRMNL 7.5" | [Browser flasher](https://puritysb.github.io/AgentDeck/flash/) · [firmware releases](https://github.com/puritysb/AgentDeck/releases?q=esp32-v&expanded=true) | `esp32-v*` |

**Store status, 2026-09-24:** iOS 1.5.0 is released and macOS 1.5.0 remains
under review (owner report). Google Play 1.5.0 (21) is live in production,
confirmed in Play Console. Elgato 1.4 is ready to publish but remains held for
processed-package encoder verification. Ulanzi 1.4.0 remains under review.
See [delivery tracking](https://github.com/puritysb/AgentDeck/issues/314)
for remaining publication and verification work.

Mobile apps and hardware are companion surfaces: keep a daemon running on your
computer. Supported ESP32 boards offer Wi-Fi OTA after the first USB flash;
GitHub Android APKs offer wireless updates from Settings. Pixoo, TC001, Timebox,
and iDotMatrix setup is covered in the [device guide](docs/devices.md).

[Changelog](CHANGELOG.md) · [All releases](https://github.com/puritysb/AgentDeck/releases)
· [Release policy](RELEASING.md)

## Compatible Companion Projects

Independent integrations have their own releases and support. Both projects
below are **Community** integrations; listing does not imply verified compatibility.

- [Pocket Daily Reader](https://github.com/puritysb/pocket-daily-reader): an
  offline-first reader using the `portable-reader/v1` profile.
- [Bitfocus Companion module](https://github.com/houtacheng/companion-module-agentdeck)
  by [@houtacheng](https://github.com/houtacheng): session tiles, controls, and usage
  through `companion-control/v1`.

See the [Surface Protocol](docs/surface-protocol.md) for capabilities, runtime
status, integration manifests, and conformance levels.

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

## Development

```bash
pnpm install && pnpm build
pnpm -r --parallel dev
pnpm test
```

[Build from source](docs/install.md) · [Testing](docs/testing.md) ·
[Build health](https://puritysb.github.io/AgentDeck/reports/).
Coding agents should start at [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md).

## Community

Bug reports, hardware verification, documentation fixes, and focused pull
requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md), use
[SECURITY.md](SECURITY.md) for private vulnerability reports, and follow the
[Code of Conduct](CODE_OF_CONDUCT.md). See
[AI-assisted maintenance](docs/ai-assisted-maintenance.md) for how maintainers
review agent-assisted work.

## License & attribution

MIT — see [LICENSE](LICENSE).

Independent project. Not affiliated with Anthropic, OpenAI, Google, Elgato, DIVOOM,
or any other third party referenced here. All trademarks belong to their respective
owners. Full notices in [ATTRIBUTION.md](ATTRIBUTION.md).
