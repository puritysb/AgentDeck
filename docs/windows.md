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
- **PTY** — ConPTY through `cmd.exe` with `/d /s /c` (POSIX uses `/bin/zsh -l -c`). `node-pty`'s Windows prebuild is used as-is, so no Visual Studio Build Tools are required.
- **Hooks** — Claude Code hook entries run a `powershell -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "…"` one-liner that reads `daemon.json`, probes `/health`, and POSTs the payload. `PreToolUse` and `Stop` are request-response like their POSIX counterparts: they use `Invoke-WebRequest` (not `Invoke-RestMethod`, which deserializes the JSON body and cannot round-trip it) and echo the daemon's answer with `[Console]::Out.Write`, which is what delivers device permission approval and the turn-end directive queue. Every other event stays fire-and-forget through `Invoke-RestMethod | Out-Null`.
- **`-WindowStyle Hidden` is load-bearing** — hooks fire on every tool call, so an unhidden console flashes a window continuously through a working session. For the same reason all bridge child processes go through `bridge/src/proc.ts`, which defaults `windowsHide: true`; import that instead of `child_process` anywhere in the bridge.
- **`agentdeck daemon install` / `uninstall`** — registers a per-user **Scheduled Task** `AgentDeckDaemon` with a logon trigger (built-in `schtasks.exe`, no admin elevation), the Windows analog of the macOS LaunchAgent. `install` registers + starts it now and installs Codex hooks; `uninstall` stops the daemon and removes the task. A real Windows Service is intentionally **not** used — it runs in session 0 with no desktop/device access, breaking USB-HID (D200H), audio (wake-word), and the Stream Deck app. See [daemon.md → Autostart](daemon.md#autostart-loginlogon).
- **Device modules** — `adb` is probed cross-platform; the `/dev/tty.*` USB-serial scan is skipped on Windows (COM-port enumeration not implemented). mDNS and `better-sqlite3` (APME) support Windows; D200H is driven by the Ulanzi Studio plugin over daemon WebSocket.
- **APME hardware sampler** is darwin-only — it returns a minimal snapshot on Windows and the recommender treats that as "neutral".
- **macOS-only plugin utility actions** (brightness / volume / dark-mode via `osascript`) gracefully no-op on Windows.

---
