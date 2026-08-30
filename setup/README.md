# @agentdeck/setup

One-command installer for **[AgentDeck](https://github.com/puritysb/AgentDeck)** — put your AI coding agents (Claude Code, Codex, OpenCode) on a physical control surface: Stream Deck, tablets, e-ink readers, ESP32 panels, LED matrices, or just your terminal.

## Install

```bash
npx @agentdeck/setup
```

That is the whole install, on every platform. The wizard:

1. Checks prerequisites (Node.js 22+, your agent CLIs, platform build tools)
2. Installs the [`@agentdeck/bridge`](https://www.npmjs.com/package/@agentdeck/bridge) package globally — this provides the `agentdeck` CLI and the local daemon
3. Registers Claude Code lifecycle hooks so sessions report state automatically
4. Seeds the local data directory

Then start the daemon and run your agent normally:

```bash
agentdeck daemon install
claude               # or: codex / opencode
agentdeck dashboard  # optional terminal dashboard
```

The legacy `agentdeck claude`, `agentdeck codex`, `agentdeck opencode`, and
`agentdeck monitor` session bridges remain functional compatibility paths with
no removal date. Workflow design is discussed in
[Discussion #278](https://github.com/puritysb/AgentDeck/discussions/278) and
implementation is tracked in
[#273](https://github.com/puritysb/AgentDeck/issues/273).

No Stream Deck required — the daemon is the product; decks and other devices are optional ways to look at it.

## Platform notes

**Node.js 22 or later** is required everywhere. Native modules (`node-pty`, `sharp`, `better-sqlite3`) install from prebuilt binaries first; a compiler is only needed if a prebuild is missing for your platform.

### macOS

- Nothing else is required to install.
- Xcode Command Line Tools (`xcode-select --install`) are needed only in two cases: a native-module prebuild fails, or you use the voice features — the on-device voice/judge helper compiles on demand (macOS 26+).
- Autostart: `agentdeck daemon install` registers a LaunchAgent.

### Windows 11

- Install Node.js with `winget install OpenJS.NodeJS`, then run `npx @agentdeck/setup` in PowerShell.
- Hooks are written as PowerShell one-liners; no bash required at runtime.
- Autostart: `agentdeck daemon install` registers a per-user Scheduled Task (`AgentDeckDaemon`) — no admin elevation.
- Details: [Windows guide](https://github.com/puritysb/AgentDeck/blob/master/docs/windows.md)

### Linux

- The Elgato Stream Deck desktop app does not exist on Linux, so the Stream Deck plugin is skipped — the daemon, `agentdeck dashboard` terminal dashboard, hardware devices, and the Android/iOS companion apps all work.
- If the prebuilt `node-pty` binary fails: Debian/Ubuntu `sudo apt install build-essential python3`, Fedora `sudo dnf install gcc-c++ make python3`, Arch `sudo pacman -S base-devel python`.
- Autostart: `agentdeck daemon install` registers a systemd `--user` unit; for headless boot run `loginctl enable-linger $USER` once.
- Details: [Linux guide](https://github.com/puritysb/AgentDeck/blob/master/docs/linux.md)

## Links

- Project website: https://puritysb.github.io/AgentDeck/
- Repository & docs: https://github.com/puritysb/AgentDeck
- Mac App Store dashboard (standalone, no Node.js needed): https://apps.apple.com/app/id6784822497
- Issues: https://github.com/puritysb/AgentDeck/issues

## License

MIT
