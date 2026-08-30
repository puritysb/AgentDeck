# @agentdeck/bridge

The `agentdeck` CLI and daemon for **[AgentDeck](https://github.com/puritysb/AgentDeck)** — a bidirectional local control system that puts AI coding agent sessions (Claude Code, Codex, OpenCode) on physical control surfaces and a terminal dashboard.

Most users should install through the setup wizard instead of this package directly:

```bash
npx @agentdeck/setup
```

Direct install:

```bash
npm install -g @agentdeck/bridge
```

## Usage

```bash
agentdeck daemon install  # install hooks and start the daemon on login
claude                    # or: codex / opencode
agentdeck dashboard       # terminal dashboard
agentdeck daemon start    # start the daemon hub manually (port 9120)
agentdeck devices         # list connected display devices
agentdeck qr              # pairing QR for the iOS/Android companion apps
agentdeck --help          # full command reference
```

The daemon is the hub every dashboard client talks to. Normal agent commands
report through lifecycle hooks or native event channels and can be steered where
the observed session exposes a real delivery path.

The legacy `agentdeck claude|codex|opencode|monitor` per-session bridges remain
functional compatibility paths with no removal date. Prefer daemon-first for
ordinary local sessions, but keep managed-only workflows working while
[Discussion #278](https://github.com/puritysb/AgentDeck/discussions/278) and
[#273](https://github.com/puritysb/AgentDeck/issues/273) define and validate
replacements.

Full CLI reference: https://github.com/puritysb/AgentDeck/blob/master/docs/cli.md

## Platform notes

- **Node.js 22+** on macOS, Windows 11, or Linux. Native modules install from prebuilt binaries; a compiler is only needed when a prebuild is missing.
- **The published package is identical on every platform** — it carries no machine-built binaries. On macOS 26+, the voice/judge helper (`agentdeck-fm-helper`, Apple Foundation Models + on-device speech) compiles itself on first use into `~/.agentdeck/fm-helper/`; this requires Xcode Command Line Tools (`xcode-select --install`). Without them, voice features report exactly what is missing and everything else keeps working.
- Windows specifics (ConPTY, Scheduled Task autostart): https://github.com/puritysb/AgentDeck/blob/master/docs/windows.md
- Linux specifics (systemd user unit, no Stream Deck app): https://github.com/puritysb/AgentDeck/blob/master/docs/linux.md

## Links

- Project website: https://puritysb.github.io/AgentDeck/
- Repository & docs: https://github.com/puritysb/AgentDeck
- Issues: https://github.com/puritysb/AgentDeck/issues

## License

MIT
