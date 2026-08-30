# CLI Reference

Every `agentdeck` command, plus how a session is started and stopped.
For the one-command install see [README → Start here](../README.md#start-here).

## Usage

## Start

```bash
agentdeck daemon install
claude             # or: codex · opencode
```

The daemon installs or refreshes the lifecycle integrations and observes agents
started through their normal commands. The **daemon** (port 9120, `0.0.0.0` by
default) aggregates all sessions for external clients.

> **Legacy compatibility notice:** `agentdeck claude`, `agentdeck codex`,
> `agentdeck opencode`, and `agentdeck monitor` still work, and no removal date
> is set. The daemon-first default is `agentdeck daemon install` followed by a
> normal agent launch. Remote attach, `--weight`, `AGENTDECK_<AGENT>_ARGS`,
> terminal steering, and terminal telemetry do not have daemon-first
> equivalents yet. Replacement design is discussed in
> [Discussion #278](https://github.com/puritysb/AgentDeck/discussions/278) and
> implementation remains tracked in
> [#273](https://github.com/puritysb/AgentDeck/issues/273).

Lifecycle compatibility: Claude Code `>=2.1.50` and Codex CLI `>=0.141.0` are
the supported hook baselines. All same-major AgentDeck clients remain wire-compatible;
older agent CLIs can still run in the managed terminal, but their lifecycle
monitoring is not guaranteed.

> **Security:** The daemon binds to `0.0.0.0` for LAN access (multi-surface monitoring). Local connections bypass authentication. Remote connections require the auth token from the AgentDeck data directory (`~/.agentdeck/auth-token` on Node CLI builds, `~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/auth-token` on Mac App Store).

## CLI Reference

The CLI command is `agentdeck`.

### Sessions

| Command | Description |
|---------|-------------|
| `agentdeck claude` | **Legacy compatibility:** start Claude Code in the managed PTY session bridge |
| `agentdeck codex` | **Legacy compatibility:** start Codex in the managed PTY session bridge |
| `agentdeck opencode` | **Legacy compatibility:** start OpenCode in the managed PTY/SSE session bridge |
| `agentdeck monitor` | **Legacy compatibility:** start the managed hook-only per-session bridge |

The following flags document the managed compatibility path. New ordinary local
sessions should use the normal agent commands; keep this path when one of these
capabilities is required.

**Flags:** `-p <port>`, `-c <command>`, `-d` (debug), `--no-update-check`, `--weight <n>`
**Remote attach flags:** `--remote-daemon`, `--daemon-host <host[:port]>`, `--daemon-token <token>` (pairing token of the remote hub — from `~/.agentdeck/auth-token` there, or `agentdeck token show`; env `AGENTDECK_DAEMON_TOKEN`). Required for a current hub: since issue #145 daemons no longer hand their token to unauthenticated LAN peers.
**Module flags:** `--local` (all device modules off — derived from the module registry, so it covers every module including ones added later), `--no-adb` (skip ADB reverse). Hardware modules (mDNS/serial/Pixoo/Timebox/iDotMatrix) are daemon-only — session bridges never activate them, so there are no per-session `--no-mdns`/`--no-serial`/`--no-pixoo` flags.

**Port window (`--port-window <lo-hi>` / `AGENTDECK_PORT_WINDOW`).** The daemon's singleton guard sweeps the documented 9120–9139 window and concedes to any live daemon it finds, which is why an isolated daemon could not be started beside the real one — neither a separate `AGENTDECK_DATA_DIR` nor an explicit `-p` moved the sweep. Override the window to run a throwaway daemon for testing (`daemon start -p 9200 --port-window 9200-9209 --loopback --local`). A daemon outside the default window is invisible to clients that scan it, so `daemon start` prints the window whenever it is not the default, and an unparseable value falls back to the default rather than disabling the guard.

**Running the current build (`--no-build`, `--no-upgrade`).** `/health` carries a `build` field: a digest of the JavaScript the answering daemon *started with*. It exists because on a source checkout `agentdeck` is a shim onto `bridge/dist/cli.js`, which is overwritten in place — a daemon started before a rebuild reports the same pid, port and version as one started after it, so "already running" used to be indistinguishable from "still running the code you replaced".

- `daemon start` and `daemon restart` on a checkout rebuild stale workspace packages first, then **re-execute** so one process cannot mix an old `cli.js` with a new `daemon-server.js`. The rebuild only happens with a terminal attached (never on the autostart path, where a failed build would loop against `KeepAlive`) and only re-executes when the build digest actually changed — a rebase or a `touch` that moves an mtime without changing a byte compiles to nothing. `--no-build` skips it; `--build` forces it without a terminal.
- `daemon start` against a daemon of yours whose `build` differs from the one on disk stops it and takes the port, rather than exiting "already running". Both digests must be **known** to differ: a daemon predating the field reports none, and evicting on no information would make every start a restart. `--no-upgrade` leaves it alone.
- `daemon status` says which build is serving and which is on disk when they differ.

**Preferred daemon port (`agentdeck daemon port`).** The daemon resolves the port it *intends* to serve from `-p/--port` › `AGENTDECK_DAEMON_PORT` › `settings.json` `daemonPort` › 9120, and records where it actually landed in `daemon.json`. Only the user writes the persisted value (`agentdeck daemon port 9200`, `--clear` to forget it); nothing in the startup path does, because persisting the *outcome* would turn a 14-second kernel hold on 9120 into a permanent move to 9121. When the preferred port is held but nothing answers `/health` there, the daemon waits up to 20s for it rather than conceding — see [docs/daemon.md § Preferred port vs actual port](daemon.md#preferred-port-vs-actual-port).

On the managed compatibility path, the `-c` flag sets the full command AgentDeck
spawns inside the session PTY, so any arguments you add are forwarded straight
to the underlying agent. For example, to resume an earlier Claude Code session
(the interactive picker appears when no id is given):

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
| `agentdeck daemon start` | Start monitoring daemon (`--local`, `--loopback`, `--port-window`, `--no-build`, `--no-upgrade` — see below) |
| `agentdeck daemon stop` | Stop daemon |
| `agentdeck daemon restart` | Restart daemon — reads posture from the port it is actually on, restarts on its preferred port |
| `agentdeck daemon status` | Show daemon status (says so when it is serving a fallback port) |
| `agentdeck daemon port [n]` | Show or persist the preferred daemon port (`--clear` to forget it) |
| `agentdeck daemon install` | Register auto-start (macOS LaunchAgent / Windows Scheduled Task / systemd unit); `--enterprise` bakes the loopback posture into it |
| `agentdeck daemon uninstall` | Remove auto-start (LaunchAgent / Scheduled Task) |

**Network posture on a shared or corporate network.** `--local` turns every
device module off (the daemon still binds all interfaces, so a paired companion
app keeps working). `--loopback` — equivalently `AGENTDECK_LOOPBACK_ONLY=1` —
binds `127.0.0.1` and emits nothing onto the LAN: no mDNS advertisement, no UDP
discovery beacon, no Pixoo subnet sweep, no BLE scans. The USB channels survive
`--loopback` — serial, because a board on a cable is not a network peer, and ADB
reverse, because the tunnel rides the USB cable into the host's own loopback.
Use `agentdeck daemon install --enterprise` (or `npx @agentdeck/setup
--enterprise`) so the posture lands in the autostart unit rather than only
applying when the flag is typed by hand. Full table: [docs/daemon.md §
Enterprise and shared-network posture](daemon.md#enterprise-and-shared-network-posture).

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
| `agentdeck diag` | Daemon diagnostic dump (`-a` for AI analysis) |
| `agentdeck diag agents [--json]` | Privacy-safe installed-version and compatibility report for normal Claude/Codex/OpenCode launches; no daemon required |
| `agentdeck diag kiro [--json]` | Privacy-safe Kiro passive-observation diagnostic; no daemon required |
| `agentdeck inject-test` | Exercise observed-answer injection against one host, for tuning (`--tty <ttysNNN>` or `--app <Name>`; `--label <text>`, `-i <n>`, `--text <text>`) |

### Weather context

| Command | Description |
|---------|-------------|
| `agentdeck weather set --lat <n> --lon <n> [--place <label>] [--timezone <iana>]` | Save an explicit coarse forecast location for Dashboard and portable-reader Glance |
| `agentdeck weather show` | Show the saved location, time zone, and portable provider without printing a custom API key |
| `agentdeck weather clear` | Remove the location and persisted Node forecast cache |

The default portable provider is the keyless MET Norway Locationforecast service;
there is no account screen, API key, or IP-location lookup. Coordinates are rounded
to two decimals before they are written (roughly a 1 km privacy boundary), and the
host time zone is used when `--timezone` is omitted. The daemon reads the setting on
the next feed pull, so none of these commands require a restart.

```bash
agentdeck weather set --lat 37.5665 --lon 126.9780 --place Seoul --timezone Asia/Seoul
agentdeck weather show
```

An intermittently connected `portable-reader/v1` client receives a provider-attributed
outlook of up to seven days plus bounded absolute-time display/notification cues. It
persists those with the Card Feed and must stop using them after `validUntil`; the
daemon never asks the reader to fetch a weather service directly.

`agentdeck diag kiro` is designed to be attached to an issue. It reports whether
native Kiro CLI/IDE processes, conversation stores, schema markers, and
process-to-session correlation are visible. It never includes prompt or response
text, tool inputs, command lines, session titles, model names, or TTY names; cwd
paths and session IDs become report-scoped salted keys. Use `--json` when a
machine-readable attachment is more useful.

Kiro CLI v2 is observed from its native process and read-only conversation
store. Kiro v3 additionally supports AgentDeck's global lifecycle hook, so a
normal `kiro-cli --v3` launch reports exact prompt/tool/stop boundaries without
an `agentdeck kiro` wrapper.

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

An ESP32 has no keyboard, so it cannot type a code. Name its address instead —
copy it from the daemon's `Rejected <ip> (esp32)` line — and the credential is
pushed down the socket the board opens next, no cable involved:

```bash
agentdeck pair --adopt 192.168.68.54 192.168.68.76
```

See [daemon.md § Re-arming an ESP32 without a cable](daemon.md) for the
authorization model and the firmware floor this needs.

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
| `agentdeck apme stop-health` | Stop-hook delivery rate — how turns actually closed (`--since 7d`, `--agent`) |
| `agentdeck apme tune` | Trigger rubric auto-tuner (OPRO loop) |
| `agentdeck apme vibe <runId> <verdict>` | Label a run (`approve`/`reject`/`neutral`) |
| `agentdeck apme tag <runId> <category>` | Manually set task category |
| `agentdeck apme reclassify` | Re-run classifier on unclassified runs |
| `agentdeck apme rubric` | Inspect current rubrics |
| `agentdeck apme export` | Export dataset to JSON |

### Device Setup

Pixoo **auto**-discovery is off by default — the daemon no longer sweeps the LAN
or calls the Divoom cloud on its own. Run `agentdeck pixoo scan` once, or set
`"pixooAutoDiscover": true` in `~/.agentdeck/settings.json` to opt back in. In the
macOS app (which has no CLI) the equivalent is **Settings → Pixoo → Scan LAN**.
A configured panel that changes IP is still recovered automatically — that path
is not gated on the discovery setting, because re-locating a device you added is
not the same act as finding one you never asked for.

| Command | Description |
|---------|-------------|
| `agentdeck pixoo scan` | Discover Pixoo devices on LAN (`--no-cloud` skips the Divoom cloud lookup and sweeps the local subnet only) |
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
| `agentdeck esp32-ota <target>` | Push ESP32 firmware over WiFi OTA (`--build` or `--firmware <path>`). Pull staging uses `--stage`; X3/X4 additionally require `--manifest <agentdeck-surface.json>` or both `--product-id` and `--update-channel`. |

---
