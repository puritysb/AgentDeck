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
**Remote attach flags:** `--remote-daemon`, `--daemon-host <host[:port]>`, `--daemon-token <token>` (pairing token of the remote hub — from `~/.agentdeck/auth-token` there, or `agentdeck token show`; env `AGENTDECK_DAEMON_TOKEN`). Required for a current hub: since issue #145 daemons no longer hand their token to unauthenticated LAN peers.
**Module flags:** `--local` (all device modules off), `--no-adb` (skip ADB reverse). Hardware modules (mDNS/serial/Pixoo/Timebox) are daemon-only — session bridges never activate them, so there are no per-session `--no-mdns`/`--no-serial`/`--no-pixoo` flags.

The `-c` flag sets the full command AgentDeck spawns inside the session PTY, so any arguments you add are forwarded straight to the underlying agent. For example, to resume an earlier Claude Code session (the interactive picker appears when no id is given):

```bash
agentdeck claude -c "claude --resume"
```

The same pattern passes through any other flag the agent accepts — for instance `-c "claude --remote-control"`.

**Environment-variable defaults.** To avoid retyping the same flags, set them once in your shell profile:

- `AGENTDECK_COMMANDER_ARGS` — extra arguments for the `agentdeck` command itself (the arg-parser layer). Applied only when the command (`argv[2]`) is `claude`/`codex`/`opencode`/`monitor`; every other command ignores it, even when a positional value happens to equal a session word (`agentdeck speak board1 claude`).
- `AGENTDECK_CLAUDE_ARGS` / `AGENTDECK_CODEX_ARGS` / `AGENTDECK_OPENCODE_ARGS` — extra arguments appended to the spawned agent command for that agent. These **weave into** an existing `-c` rather than replacing it.

```bash
export AGENTDECK_COMMANDER_ARGS="--no-postit"
export AGENTDECK_CLAUDE_ARGS="--remote-control"

agentdeck claude
# ≡ agentdeck claude --no-postit -c "claude --remote-control"

agentdeck claude -c "claude --resume 0000-0000-0000-0000"
# spawns: claude --resume 0000-0000-0000-0000 --remote-control
```

**Overriding a default for one invocation.** Env tokens are inserted before the flags you type, which gives *scalar* options last-write override semantics — retype `--weight 2` or `--daemon-host other.lan` and the typed value wins. Boolean flags (`--local`, `--no-postit`, `--no-adb`, `--remote-daemon`, hook-skip flags) have no inverse spelling, so retyping cannot undo them; pass **`--no-env-args`** to ignore both env layers for that invocation:

```bash
export AGENTDECK_COMMANDER_ARGS="--local"

agentdeck claude               # device modules off (env default applies)
agentdeck claude --no-env-args # device modules on (both env layers ignored)
```

`--no-env-args` covers only the two `*_ARGS` layers. Remote attach is a separate opt-in that lives outside it: **`AGENTDECK_REMOTE_DAEMON=1`** is the only switch that turns it on (there is no `--no-remote-daemon` inverse) — unset it to disable remote attach. `AGENTDECK_DAEMON_HOST` is not an opt-in; it only names the endpoint and is inert unless `AGENTDECK_REMOTE_DAEMON=1` (or `--remote-daemon`) is also set. Unsetting a `*_ARGS` variable remains the permanent opt-out.

Works identically on Linux, macOS, and Windows: the commander-layer var is parsed in-process (no shell), and the per-agent append rides the same shell path AgentDeck already uses for `-c`. One Windows caveat: the spawned command is re-parsed by `cmd.exe`, which does not treat single quotes as quoting — use double quotes for grouped values in `AGENTDECK_<AGENT>_ARGS` (see [windows.md](windows.md)).

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
| `agentdeck pair` | Pair a device with a one-time code — no camera, no cable (`-t <seconds>`, `-n <devices>`) |
| `agentdeck token [show\|rotate]` | Print the pairing token, or rotate it after a leak (all paired clients then re-pair; restart the daemon afterwards) |
| `agentdeck diag` | Diagnostic dump (`-a` for AI analysis) |
| `agentdeck inject-test` | Exercise observed-answer injection against one host, for tuning (`--tty <ttysNNN>` or `--app <Name>`; `--label <text>`, `-i <n>`, `--text <text>`) |

### Pairing a device with no camera and no cable

`agentdeck qr` assumes a camera and `wifi_provision` assumes USB serial. An
e-ink reader has neither, which left `adb reverse` as its only path — a
developer tunnel that dies on reboot. `agentdeck pair` opens a short window and
prints a six-digit code to type on the device (Settings → Connection → *Pair
with code*):

```bash
agentdeck pair              # 120s, one device
agentdeck pair -n 3         # pair three readers from one window
agentdeck pair -t 300       # a longer walk to the shelf
```

The command then watches the window and reports each device as it pairs — and
each wrong code as it arrives, which is the point of a short window somebody is
standing in front of. The window closes on success, on expiry, or after five
wrong codes. See [daemon.md § Pairing codes](daemon.md) for why this does not
widen the LAN boundary.

`inject-test` reproduces what the daemon does when a device answers an
observed session's prompt: it drives the host's own UI rather than the bridge.
Terminal hosts are addressed by controlling tty (find one with
`ps -eo pid=,tty=,command= | grep -E ' claude| codex'`), GUI hosts by app name,
where `--label` presses the button carrying that text before falling back to
key events. `--text` types and submits a line instead of picking an option,
which is the path dictation uses. Node daemon only — the App Store app spawns
no subprocesses.

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
