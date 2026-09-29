# Linux (Bridge + Daemon)

Canonical Linux setup reference. The Node.js **bridge** and **daemon** run on
Linux — the daemon hub, mDNS advertisement, hook HTTP, and the legacy
managed session bridge (`agentdeck claude` / `codex` / `opencode`). The
**Stream Deck desktop app is
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

agentdeck daemon install            # hooks + systemd user daemon
claude                              # supported default: normal observed launch
agentdeck claude                    # legacy managed PTY compatibility path
```

`npx @agentdeck/setup` also works on Linux — it checks for the build toolchain
instead of Xcode CLT and skips the Stream Deck app/CLI steps.

> `pnpm link --global` is undocumented on pnpm 11 — `pnpm link --help` lists only
> `pnpm link <dir>` — and at least one user's pnpm rejects it outright with
> `unexpected argument '--global'` ([#303](https://github.com/puritysb/AgentDeck/issues/303),
> [#304](https://github.com/puritysb/AgentDeck/pull/304)). If it fails, nothing else here
> depends on it: every `agentdeck <args>` above also works as
> `node bridge/dist/cli.js <args>`.

## Linux differences (intentional)

- **No Stream Deck host** — the Stream Deck desktop app is unavailable, so the plugin host and its setup/CLI steps are skipped (device control is via the daemon + Apple/Android companions). Normal `claude`/`codex`/`opencode` observation, mDNS (pure-JS `bonjour-service`), and hook HTTP all work; the legacy `agentdeck <agent>` managed path remains functional for compatibility while replacements are validated. `npx @agentdeck/setup` checks for a C toolchain (`node-pty` still builds from source for the managed PTY path) instead of Xcode CLT and skips Stream Deck checks.
- **`agentdeck daemon install` / `uninstall`** — registers a per-user **systemd `--user` unit** `agentdeck-daemon.service` (`~/.config/systemd/user/`), the Linux analog of the macOS LaunchAgent. `install` writes + enables + starts it and installs Codex/OpenCode hooks; `uninstall` gracefully shuts down the daemon then `disable --now` + removes the unit. Without systemd it degrades to a "run `agentdeck daemon start` manually" hint. For boot-without-login on a headless host, run `loginctl enable-linger $USER` once. See [docs/daemon.md → Autostart](daemon.md#autostart-loginlogon).
- **PTY** — `$SHELL -l -c` (fallback `/bin/bash`); `node-pty` is built from source (needs the toolchain above).

The PTY path remains functional with no removal date. Replacement design and
gates live in [Discussion #278](https://github.com/puritysb/AgentDeck/discussions/278)
and [#273](https://github.com/puritysb/AgentDeck/issues/273). New ordinary Linux
workflows should install the daemon and run agents normally.
- **Device modules** — `adb` and Pixoo (LAN) work as-is; USB-serial scans `/dev/ttyUSB*` / `/dev/ttyACM*` (add your user to the `dialout` group for access). BLE (Timebox/iDotMatrix) needs a `bleak` venv + BlueZ and is not wired up by default.
- **Graceful no-ops** — voice/TTS, wifi/usage/Foundation-Models helpers, the APME hardware sampler, and the macOS `osascript` plugin actions are darwin-only and simply do nothing on Linux (no errors).
