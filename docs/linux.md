# Linux (Bridge + Daemon)

Canonical Linux setup reference. The Node.js **bridge** and **daemon** run on
Linux — the daemon hub, session bridge (`agentdeck claude` / `codex` /
`opencode`), mDNS advertisement, and hook HTTP. The **Stream Deck desktop app is
not available on Linux**, so the plugin host and its setup steps are skipped;
device control is via the daemon and the Apple/Android companion apps over the
LAN.

## Prerequisites (Linux)

| Item | Required | Notes |
|------|----------|-------|
| **Node.js** ≥ 22 + **pnpm** | Yes | via your distro / `nvm`, then `npm install -g pnpm` |
| **Build toolchain** (`cc`/`gcc`, `make`, `python3`) | Yes | `node-pty` builds from source. Debian/Ubuntu: `sudo apt install build-essential python3`; Fedora: `sudo dnf install gcc-c++ make python3`; Arch: `sudo pacman -S base-devel python` |
| **Claude Code CLI** on `PATH` | Yes | `npm install -g @anthropic-ai/claude-code` |
| **systemd** (user manager) | For autostart | Only needed for `agentdeck daemon install`; the bridge runs fine without it |

## Install & Run

```bash
git clone https://github.com/puritysb/AgentDeck.git
cd AgentDeck
pnpm install && pnpm build
node hooks/dist/install.js          # register Claude Code hooks (POSIX curl one-liner)
cd bridge && pnpm link --global && cd ..

agentdeck daemon start              # daemon on 9120, writes ~/.agentdeck/daemon.json
agentdeck claude                    # spawns Claude Code via PTY ($SHELL -l -c)
```

`npx @agentdeck/setup` also works on Linux — it checks for the build toolchain
instead of Xcode CLT and skips the Stream Deck app/CLI steps.

## Linux differences (intentional)

- **`agentdeck daemon install` / `uninstall`** — registers a per-user **systemd `--user` unit** `agentdeck-daemon.service` (`~/.config/systemd/user/`), the Linux analog of the macOS LaunchAgent. `install` writes + enables + starts it and installs Codex/OpenCode hooks; `uninstall` gracefully shuts down the daemon then `disable --now` + removes the unit. Without systemd it degrades to a "run `agentdeck daemon start` manually" hint. For boot-without-login on a headless host, run `loginctl enable-linger $USER` once. See [docs/daemon.md → Autostart](daemon.md#autostart-loginlogon).
- **PTY** — `$SHELL -l -c` (fallback `/bin/bash`); `node-pty` is built from source (needs the toolchain above).
- **Device modules** — `adb` and Pixoo (LAN) work as-is; USB-serial scans `/dev/ttyUSB*` / `/dev/ttyACM*` (add your user to the `dialout` group for access). BLE (Timebox/iDotMatrix) needs a `bleak` venv + BlueZ and is not wired up by default.
- **Graceful no-ops** — voice/TTS, wifi/usage/Foundation-Models helpers, the APME hardware sampler, and the macOS `osascript` plugin actions are darwin-only and simply do nothing on Linux (no errors).
