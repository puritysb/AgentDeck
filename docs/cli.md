# CLI Reference

Every `agentdeck` command, plus how a session is started and stopped.
For the one-command install see [README → Start here](../README.md#start-here).

## Usage

## Start

```bash
agentdeck claude   # or: agentdeck codex
```

This spawns Claude Code or Codex CLI inside a PTY and starts a session bridge on a dynamic port (HTTP + hooks). Your terminal works exactly as before — the Stream Deck adds a parallel control channel. The **daemon** (port 9120, `0.0.0.0`) aggregates all sessions for external clients.

> **Security:** The daemon binds to `0.0.0.0` for LAN access (multi-surface monitoring). Local connections bypass authentication. Remote connections require the auth token from the AgentDeck data directory (`~/.agentdeck/auth-token` on Node CLI builds, `~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/auth-token` on Mac App Store).

## CLI Reference

The CLI command is `agentdeck`.

### Sessions

| Command | Description |
|---------|-------------|
| `agentdeck claude` | Start Claude Code session (PTY + bridge) |
| `agentdeck codex` | Start Codex CLI session (PTY + bridge) |
| `agentdeck opencode` | Start OpenCode session (PTY + SSE bridge) |
| `agentdeck monitor` | Hook-only bridge (no PTY — run `claude` separately) |

**Flags:** `-p <port>`, `-c <command>`, `-d` (debug), `--no-update-check`, `--weight <n>`
**Module flags:** `--local` (all device modules off), `--no-adb` (skip ADB reverse). Hardware modules (mDNS/serial/Pixoo/Timebox) are daemon-only — session bridges never activate them, so there are no per-session `--no-mdns`/`--no-serial`/`--no-pixoo` flags.

The `-c` flag sets the full command AgentDeck spawns inside the session PTY, so any arguments you add are forwarded straight to the underlying agent. For example, to resume an earlier Claude Code session (the interactive picker appears when no id is given):

```bash
agentdeck claude -c "claude --resume"
```

The same pattern passes through any other flag the agent accepts — for instance `-c "claude --remote-control"`.

#### Pinning session order with --weight

By default sessions sort by agent type → project name → start time, which keeps
positions stable but not necessarily aligned with your terminal tabs. Pass
`--weight <n>` (integer between `-9999` and `9999`, default `0`) to pin a
session's slot: sessions sort by **weight ascending first** (negatives, then
unweighted/`0`, then positives), and only fall back to the default ordering
*within* the same weight. Nothing changes when no session sets a weight.

So if you run five tabs on one project in Windows Terminal (or iTerm), give each
tab a weight matching its tab number and the Stream Deck — plus every other
surface (macOS/iOS/Android dashboards and the TUI) — mirrors that tab order:

```bash
agentdeck claude --weight 1   # tab 1 → deck slot 1
agentdeck claude --weight 2   # tab 2 → deck slot 2
agentdeck claude --weight 3   # …and so on
```

Negative weights sort ahead of unweighted sessions (e.g. `--weight -5` to always
float a session to the top). The value is a pure sort key — it never changes how
a session behaves.

### Daemon

| Command | Description |
|---------|-------------|
| `agentdeck daemon start` | Start monitoring daemon |
| `agentdeck daemon stop` | Stop daemon |
| `agentdeck daemon restart` | Restart daemon |
| `agentdeck daemon status` | Show daemon status |
| `agentdeck daemon install` | Register auto-start (macOS LaunchAgent / Windows Scheduled Task) |
| `agentdeck daemon uninstall` | Remove auto-start (LaunchAgent / Scheduled Task) |

### Session Management

| Command | Description |
|---------|-------------|
| `agentdeck status` | All sessions + daemon status |
| `agentdeck stop` | Stop a session (`-a` for all, `-p` for specific port) |

### Monitoring

| Command | Description |
|---------|-------------|
| `agentdeck dashboard` | TUI monitoring dashboard (alias: `dash`) |
| `agentdeck devices` | Connected devices (WS, ESP32, Pixoo, Timebox, ADB) |
| `agentdeck qr` | Pairing QR code + URL |
| `agentdeck diag` | Diagnostic dump (`-a` for AI analysis) |

### Evaluation (APME)

| Command | Description |
|---------|-------------|
| `agentdeck apme runs` | List recent runs (filter by `--agent`, `--model`, `--limit`) |
| `agentdeck apme run <id>` | Detailed run view — steps, turns, per-turn evals, vibe |
| `agentdeck apme judge` | Evaluate pending runs manually (no daemon required) |
| `agentdeck apme scorecard` | Model scorecard by category and overall |
| `agentdeck apme tune` | Trigger rubric auto-tuner (OPRO loop) |
| `agentdeck apme vibe <runId> <verdict>` | Label a run (`approve`/`reject`/`neutral`) |
| `agentdeck apme tag <runId> <category>` | Manually set task category |
| `agentdeck apme reclassify` | Re-run classifier on unclassified runs |
| `agentdeck apme rubric` | Inspect current rubrics |
| `agentdeck apme export` | Export dataset to JSON |

### Device Setup

| Command | Description |
|---------|-------------|
| `agentdeck pixoo scan` | Discover Pixoo devices on LAN |
| `agentdeck pixoo add <ip>` | Add a Pixoo device |
| `agentdeck pixoo list` | List configured devices |
| `agentdeck pixoo remove <ip>` | Remove a device |
| `agentdeck pixoo test [ip]` | Send test pattern |
| `agentdeck timebox scan` | Discover BLE `TimeBox-mini-light` peripherals |
| `agentdeck timebox add <address>` | Add a Timebox Mini by BLE address |
| `agentdeck timebox list` | List configured Timebox devices |
| `agentdeck timebox remove <address>` | Remove a Timebox device |
| `agentdeck timebox test [target]` | Send one frame (BLE) |
| `agentdeck timebox sync [target]` | Run foreground Timebox frame sync (BLE) |
| `agentdeck wifi-setup` | ESP32 WiFi provisioning (serial) |
| `agentdeck esp32-ota <target>` | Push ESP32 firmware over WiFi OTA (`--build` or `--firmware <path>`) |

---
