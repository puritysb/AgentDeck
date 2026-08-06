# Windows (Bridge + Plugin)

Canonical Windows setup reference. The Node bridge, hook installer, and Stream
Deck plugin run on Windows 11; Apple/Android/ESP32 native builds are out of scope.

The Node.js **bridge**, the Claude Code **hook installer**, and the **Stream Deck plugin** run on Windows 11. The Apple, Android, and ESP32 native builds are macOS/Linux-only and are out of scope on Windows — but the core "steer Claude Code from a Stream Deck+" experience works.

## Prerequisites (Windows 11)

| Item | Required | Notes |
|------|----------|-------|
| **Node.js** ≥ 22 + **pnpm** | Yes | `winget install OpenJS.NodeJS`, then `npm install -g pnpm` |
| **Stream Deck app** (Elgato) | For hardware | Setup also probes `%PROGRAMFILES%\Elgato\StreamDeck\` and `%LOCALAPPDATA%\Programs\Elgato\StreamDeck\` |
| **Claude Code CLI** on `PATH` | Yes | `npm install -g @anthropic-ai/claude-code` |
| **Git Bash or WSL** on `PATH` | For source scripts | Only the bash scripts under `scripts/` (`install.sh`, `uninstall.sh`, `package-plugin.sh`, …) need it. `pnpm install`/`build`/`test` are pure Node |

**Line endings**: the repo's `.gitattributes` checks everything out LF (bash scripts, vitest-imported generators, and byte-compared generated mirrors all break under CRLF), overriding any local `core.autocrlf`. A clone from before it existed keeps its CRLF working tree until files are rewritten — convert in place by deleting the tracked files and running `git restore .`, or just re-clone.

## Install

```powershell
git clone https://github.com/puritysb/AgentDeck.git
cd AgentDeck
pnpm install            # postinstall (scripts/postinstall.mjs) is a no-op on Windows
pnpm build              # shared → bridge, plugin, hooks
pnpm test               # optional: run the Vitest suite

# Register Claude Code hooks (writes a PowerShell one-liner hook command)
node hooks/dist/install.js

# Link the CLI + Stream Deck plugin
cd bridge; pnpm link --global; cd ..
cd plugin; streamdeck link bound.serendipity.agentdeck.sdPlugin; cd ..   # then restart the Stream Deck app
```

## Run

```powershell
agentdeck daemon start  # daemon on 9120, writes %USERPROFILE%\.agentdeck\daemon.json
# In another terminal:
agentdeck claude        # spawns Claude Code via Windows ConPTY (cmd.exe /d /s /c)
```

## Windows differences (intentional)

- **Data dir** — `%USERPROFILE%\.agentdeck\` (same layout as macOS `~/.agentdeck/`). `AGENTDECK_DATA_DIR` override still works.
- **Env-var default args** — `AGENTDECK_COMMANDER_ARGS` works identically (tokenized in pure JS, no shell). For `AGENTDECK_CLAUDE_ARGS`/`AGENTDECK_CODEX_ARGS`/`AGENTDECK_OPENCODE_ARGS` the appended string is re-parsed by `cmd.exe`, which does not treat single quotes as quoting — use double quotes for values containing spaces. See [cli.md → Environment-variable defaults](cli.md).
- **PTY** — ConPTY through `cmd.exe` with `/d /s /c` (POSIX uses `/bin/zsh -l -c`). `node-pty`'s Windows prebuild is used as-is, so no Visual Studio Build Tools are required.
- **Hooks** — Claude Code hook entries run a `powershell -NoProfile -ExecutionPolicy Bypass -Command "…"` one-liner that reads `daemon.json`, probes `/health`, and POSTs the payload via `Invoke-RestMethod`.
- **`agentdeck daemon install` / `uninstall`** — registers a per-user **Scheduled Task** `AgentDeckDaemon` with a logon trigger (built-in `schtasks.exe`, no admin elevation), the Windows analog of the macOS LaunchAgent. `install` registers + starts it now and installs Codex hooks; `uninstall` stops the daemon and removes the task. A real Windows Service is intentionally **not** used — it runs in session 0 with no desktop/device access, breaking USB-HID (D200H), audio (wake-word), and the Stream Deck app. See [daemon.md → Autostart](daemon.md#autostart-loginlogon).
- **Device modules** — `adb` is probed cross-platform; the `/dev/tty.*` USB-serial scan is skipped on Windows (COM-port enumeration not implemented). mDNS and `better-sqlite3` (APME) support Windows; D200H is driven by the Ulanzi Studio plugin over daemon WebSocket.
- **APME hardware sampler** is darwin-only — it returns a minimal snapshot on Windows and the recommender treats that as "neutral".
- **Passive session observation** scans native processes through `Get-CimInstance Win32_Process` (POSIX uses `ps`; git-bash `ps.exe` only sees MSYS processes, so it was never a real backend). Standalone Claude Code sessions are expected to surface from that scan plus `%USERPROFILE%\.claude\sessions\` (Windows verification pending). Codex/ChatGPT-app sessions are **not yet observed on Windows**: the pid→rollout mapping needs `lsof`/procfs, which Windows lacks — tracked in [#143](https://github.com/puritysb/AgentDeck/issues/143).
- **Plugin E1 Volume dial works on Windows** — a persistent PowerShell coprocess drives CoreAudio (`IAudioEndpointVolume`); if PowerShell `Add-Type` is blocked (Constrained Language Mode / WDAC) the dial shows an N/A face. E4 Launcher URLs use `rundll32`; app targets use exact `Get-StartApps` resolution and fall through to their configured URL when absent. macOS keeps its richer existing-tab focus behavior.

---
