# Install & Build from Source

Prerequisites, manual build steps, and uninstall. Most people want the
one-command path in [README → Start here](../README.md#start-here) instead.

## Prerequisites

| Item | Required | Install |
|------|----------|---------|
| **macOS 26+** | Yes (App Store dashboard) | Primary Swift dashboard platform. Foundation Models integration requires Apple Intelligence availability at runtime. |
| **macOS 15+** (Sequoia) | Yes (Node bridge) | CLI daemon / deck-plugin host. Windows 11 and Linux are also supported; see [Windows](windows.md) and [Linux](linux.md). |
| **Xcode Command Line Tools** | Only if the prebuilt fails | `xcode-select --install`. `npx @agentdeck/setup` installs node-pty's prebuilt binary and falls back to a source build — which is the only step needing a compiler |
| **Node.js** >= 22 | Yes | `brew install node` |
| **pnpm** >= 9 | Yes | `npm install -g pnpm` |
| **Python 3** | Yes | `brew install python` (display sleep detection) |
| **Elgato Stream Deck app** >= 6.9 | For Stream Deck only | [Elgato Downloads](https://www.elgato.com/downloads). The daemon runs headless — Ulanzi D200H/D200X, the macOS app, `agentdeck dashboard`, and ESP32 boards need none of it. |
| **Elgato Stream Deck hardware** | For Stream Deck only | Stream Deck, Mini, XL, Plus, or + XL |
| **Ulanzi Studio** | For D200H/D200X only | [Ulanzi Download Center](https://www.ulanzi.com/pages/downloads). Install AgentDeck from the separate [Ulanzi Studio Marketplace](https://ugc.ulanzistudio.com/contentView/1141). |
| **iTerm2** | For PTY session management | Terminal management, voice paste, session switching |
| **Supported coding agent** | For live sessions | Claude Code, Codex, OpenCode, Kiro CLI/IDE, OpenClaw, or Antigravity; observation depth differs by agent. |
| **JDK 17+** | For Android | `brew install openjdk@17` |
| **Stream Deck CLI** | Auto | Installed by `pnpm setup` if missing |
| **Microphone + Speech Recognition** | For voice | Grant on first use (macOS Settings → Privacy). No sox, whisper, or model download — Apple SFSpeech on-device |
| **Chrome or Edge, desktop** | For browser flashing only | Nothing to install: [puritysb.github.io/AgentDeck/flash/](https://puritysb.github.io/AgentDeck/flash/) writes ESP32 firmware over Web Serial. Safari, Firefox, and every mobile browser do not implement Web Serial — use `agentdeck esp32 flash <board>` there |

> **Putting firmware on an ESP32 board needs none of the above.** Open
> [puritysb.github.io/AgentDeck/flash/](https://puritysb.github.io/AgentDeck/flash/)
> in desktop Chrome or Edge — no checkout, no PlatformIO, no toolchain. From a
> terminal, `agentdeck esp32 flash <board>` does the same thing and additionally
> stands the daemon down and verifies the board booted. See
> [docs/esp32.md § Flash over USB](esp32.md#flash-over-usb).

---

## Manual Build & Install

## Build

```bash
cd AgentDeck
pnpm install
pnpm build            # shared → bridge, plugin, hooks
pnpm generate-icons   # SVG → PNG (required on first build)
```

## 1. Install Claude Code Hooks

**Node CLI install (dev + Homebrew distribution):**

```bash
node hooks/dist/install.js
```

Registers 8 hooks in `~/.claude/settings.json`: `SessionStart`, `SessionEnd`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `Notification`, `UserPromptSubmit`. Each hook POSTs JSON to the bridge. Remove with `node hooks/dist/install.js uninstall`.

Installs made before 2026-07-26 targeted `~/.claude/settings.local.json`, which Claude Code resolves against the git root / cwd and therefore never reads at user scope. Re-running the installer (or starting a Claude session through the bridge, which runs the migration) moves those entries to `settings.json` and clears the stale ones.

**Mac App Store install:** [download AgentDeck Dashboard](https://apps.apple.com/app/id6784822497) for the standalone macOS app. Hooks are **opt-in** — the app shows a Settings → Claude Code Hooks pane with an "Enable Claude Code Hooks…" button that presents an NSAlert explaining what will be written, then an NSOpenPanel so the user explicitly selects `~/.claude/settings.json` (the same user-global file the CLI installer above writes). Only after that consent does AgentDeck write the hook entries (via a security-scoped bookmark). "Remove" in the same pane cleanly unregisters and revokes the bookmark. No command line required.

## 2. Install the Stream Deck Plugin

**Marketplace install (recommended):** open [AgentDeck on the Elgato Marketplace](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464) and install it into the Stream Deck app. This is the released, DRM-processed build — nothing else on this page is required for it, though the plugin only shows sessions once the daemon is running (step 1 above, or the Mac App Store app).

**From a checkout (development):**

```bash
cd plugin && streamdeck link bound.serendipity.agentdeck.sdPlugin
```

Creates a symlink in `~/Library/Application Support/com.elgato.StreamDeck/Plugins/`. **Restart the Stream Deck app** to load. Unlink before installing the Marketplace build — two copies of the same UUID conflict.

## 3. Install the Ulanzi Studio Plugin

Install [AgentDeck from the Ulanzi Studio Marketplace](https://ugc.ulanzistudio.com/contentView/1141). The plugin supports D200H keys and D200X LCD keys. D200X encoders are not supported. Ulanzi Studio is a separate host from Elgato Stream Deck, so Stream Deck plugins cannot be installed onto a D200H or D200X.

For a development checkout or manual package verification, follow
[plugin-ulanzi/VERIFY.md](../plugin-ulanzi/VERIFY.md) instead of hand-building the
Marketplace archive.

## 4. Link `agentdeck` CLI

```bash
cd bridge && pnpm link --global
```

> `pnpm link --global` is undocumented on pnpm 11 — `pnpm link --help` lists only
> `pnpm link <dir>` — and at least one user's pnpm rejects it outright with
> `unexpected argument '--global'` ([#303](https://github.com/puritysb/AgentDeck/issues/303),
> [#304](https://github.com/puritysb/AgentDeck/pull/304)). If it fails, nothing else here
> depends on it: every `agentdeck <args>` below also works as
> `node bridge/dist/cli.js <args>`, and a normal (non-checkout) install is
> `npx @agentdeck/setup`.

## 5. Voice Setup (Zero install)

Voice input uses Apple's on-device `SFSpeechRecognizer` (Speech framework). **No sox, no whisper.cpp, no model downloads** — the OS manages the dictation model via Settings → General → Keyboard → Dictation, which AgentDeck piggybacks on. The only user action is granting Microphone + Speech Recognition permission the first time the voice button is pressed (macOS shows the standard TCC prompts backed by `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription`).

All audio stays on-device (`requiresOnDeviceRecognition = true`), so the captured WAV — which may contain project/code names — never leaves the machine. See [Voice Setup Guide](voice-setup.md) for permission troubleshooting and wake-word details.

---

## Uninstall

```bash
bash scripts/uninstall.sh
```

Removes the Claude Code hooks, the AgentDeck block in `~/.codex/config.toml` (settings Codex or you added inside it are kept; a config it cannot edit safely is left unchanged and reported), the OpenCode and Kiro hook files, unlinks the `agentdeck` CLI, and removes the Stream Deck plugin symlink. **Restart the Stream Deck app** afterward.

---
