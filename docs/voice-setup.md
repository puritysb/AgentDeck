# Voice Setup

AgentDeck's voice assistant uses Apple's **on-device `SFSpeechRecognizer`** (the Speech framework). **Nothing to install** — no whisper.cpp, no model download. macOS and iOS manage the dictation model themselves; AgentDeck piggybacks on whatever the user already granted for system dictation.

**Both daemons use the same engine.** The Swift daemon calls the framework directly; the Node (CLI) daemon reaches it through the bundled Swift helper (`bridge/fm-helper/AgentDeckFMHelper.swift`) that already serves Foundation Models for the APME judge — `{"type":"transcribe","wav":…}` in, `{"text":…}` out, plus `{"type":"record"}` for host push-to-talk capture and `{"type":"speak"}` for replies. The helper ships prebuilt in the npm package and self-compiles with `xcrun swiftc` if it is missing, so there is still nothing for a user to install. Host-microphone capture goes through the same helper (the old `sox` + borrowed-terminal-grant path is gone); device-sourced audio from an ESP32 board needs no capture at all.

The flow:

1. Press the voice button (menu bar or dashboard).
2. Speak your command — up to 15 seconds per turn.
3. Apple's on-device speech recognizer returns the transcript.
4. AgentDeck sends the text to your active agent as a prompt.
5. The agent's response is spoken back via `AVSpeechSynthesisVoice`.

All audio stays on the device. We set `requiresOnDeviceRecognition = true` on every recognition request, so the captured WAV — which often contains project names, file paths, or code snippets — never leaves the machine.

---

## Permissions the app asks for

Two TCC prompts fire the first time you use voice. Both are backed by Info.plist usage strings so macOS / iOS present a real explanation:

| Prompt | Usage string | Purpose |
|---|---|---|
| **Microphone access** | "AgentDeck needs microphone access for voice commands to your AI coding agent." | `AVAudioEngine` capture |
| **Speech Recognition access** | "AgentDeck transcribes your voice commands locally using Apple's on-device speech recognition so your audio never leaves this device." | `SFSpeechRecognizer` transcription |

Grant both on first use. You can change the decision later under **System Settings → Privacy & Security → Microphone** and **→ Speech Recognition** (macOS 13+).

**The CLI daemon prompts as its own helper, not as a terminal.** The Node daemon's capture and transcription happen inside `agentdeck-fm-helper`, a single-file binary with no app bundle — so its usage strings are linked into an `__info_plist` section (`bridge/fm-helper/Info.plist`) and the binary is ad-hoc signed with a fixed identifier by `bridge/scripts/build-fm-helper.mjs`. Both are load-bearing: **TCC aborts the process (SIGABRT) instead of returning an error when it needs to prompt for a service the requesting code has no usage description for**, so a plist-less helper does not degrade — it dies, mid-turn, and the deck's VOICE key reports a timeout. The prompts are for **agentdeck-fm-helper**, and that is the name to look for under Microphone and Speech Recognition; grant them there.

**The helper re-executes itself to make that true** (#542). TCC charges a privacy request to the process it holds *responsible*, and a plain spawn inherits that from the parent — so before this, the grant belonged to whatever launched the daemon. Measured on macOS 27.0 through TCC's `AUTHREQ_ATTRIBUTION` log: under the LaunchAgent that `agentdeck daemon install` creates, the request was charged to `responsible=node` (the prompt named node, the grant then covered every node script on the Mac and lapsed on the next node upgrade); in `daemon start --foreground` it was charged to the terminal app. A report of the LaunchAgent case failing with no prompt at all is consistent with an earlier denial recorded against node. On startup the helper now re-executes in place (same pid, same pipes) with `responsibility_spawnattrs_setdisclaim`, after which the same launchd → node → helper chain logs the helper as its own requester, however the daemon was started. If that call is unavailable, the helper logs `responsibility disclaim unavailable` to the daemon's debug log and keeps the old behaviour, and a refusal names the launcher as the entry to enable. A grant you gave `node` or your terminal for this purpose is no longer used and can be removed from **Microphone** and **Speech Recognition**.

**The npm package ships no prebuilt helper** (since 1.0.14 — the tarball is identical regardless of which machine published it). The daemon compiles the helper on first use into `~/.agentdeck/fm-helper/agentdeck-fm-helper`, which needs Xcode Command Line Tools (`xcode-select --install`) on macOS 26+. Resolution order: `AGENTDECK_FM_HELPER` env override → a dev-tree `assets/fm-helper` build → the `~/.agentdeck` cache → on-demand compile. Every candidate is arch-checked, so a binary built on the other CPU (say, a home directory migrated from an Intel Mac) is rebuilt instead of spawned into `EBADARCH`.

Because an ad-hoc signature pins the grant to that identifier plus the binary's cdhash, **rebuilding the helper re-prompts** (the same TCC pinning that makes a rebuilt app re-ask for Bluetooth). If a rebuilt helper starts failing instead of asking, clear the stale entries: `tccutil reset Microphone` and `tccutil reset SpeechRecognition`, then press VOICE again.

---

## First-launch dictation model download

Apple's on-device speech models are downloaded the first time you enable dictation for a given language. If AgentDeck returns an empty transcript immediately after you grant permission, that's usually the OS finishing the one-time download in the background.

**Force the download manually:**

1. Open **System Settings → General → Keyboard**.
2. Enable **Dictation** (or disable and re-enable if already on).
3. When prompted, choose **On-Device Dictation** (also called "Dictation without an internet connection" in older releases).
4. Wait for the language pack to finish — a progress bar shows in System Settings.

AgentDeck picks the recognition language in this order: `voice.locale` from `settings.json`, then your Mac's preferred languages in order, then the current locale, then `en-US`. Make sure the language you speak is in your Dictation language list. English is always available as a fallback.

**Speaking a language that is not your Mac's first preferred language?** Set it explicitly. With macOS languages `en-JP, ja-JP`, Japanese speech is otherwise recognized as English (reported in #541):

```json
{ "voice": { "locale": "ja-JP" } }
```

The Node CLI daemon reads this from `~/.agentdeck/settings.json`, and the macOS app reads the same key from its own settings file. Both read it on every recording, so no restart is needed.

---

## Recording duration and silence timeout

- Maximum single-turn recording: **15 seconds** (`DaemonVoiceAssistant.maxRecordingDuration`).
- Auto-stop after **1.5 seconds of silence** below the threshold (`silenceTimeout` + `silenceThreshold = 0.01`).
- Very quiet recordings (< 1 KB WAV) are discarded as likely silence.

For longer dictation, press the voice button again for a fresh turn. AgentDeck doesn't chunk audio server-side because Apple's 1-minute per-recognition-request limit suits per-turn agent prompts naturally.

---

## Wake word (optional, ESP32-side)

Hands-free "Hey AgentDeck" wake word detection runs on ESP32 hardware via microWakeWord (tflite, ~62 KB model). The ESP32 sends a `wake_word` HTTP POST to the daemon; the daemon then triggers the same `SFSpeechRecognizer` pipeline on the Mac or iOS host.

- Porcupine runs on macOS for local-only wake detection if you prefer.
- See [docs/wake-word.md](wake-word.md) for the full wake-word pipeline.

The wake word system is **independent of the SFSpeech transcription path** — wake detection just triggers a voice-button press; transcription still goes through Apple's on-device engine.

---

## Delivering to Claude Code in any terminal

Since 2.1 the CLI daemon (npm, macOS and Linux) delivers a dictated prompt to an
observed Claude Code session through Claude's own **peer inbox**. No terminal
scripting is involved, so the session can run in Ghostty, WezTerm, kitty, an SSH
session or an editor terminal, as well as iTerm2, Terminal.app, tmux or cmux. The
standalone macOS app and Windows keep terminal delivery.

Two things have to be current:

- **Hooks.** The inbox is advertised by the AgentDeck hooks. After upgrading, run
  `agentdeck daemon install` (or `npx @agentdeck/setup`) once. A plain `claude`
  session does not refresh them on its own. Sessions started before the refresh,
  or Claude Code versions without a peer inbox, use the terminal path below.
- **Deck plugin.** The VOICE tile wording comes from the Stream Deck or Ulanzi
  plugin, so update it to 2.1 as well.

The message arrives as a peer message, subject to the receiving session's own
controls. It is not typed input and never answers a permission dialog. The
selected VOICE tile reports what happened:

| VOICE tile | Meaning |
|---|---|
| received by Claude | The session confirmed the message |
| receipt pending | Written, but no confirmation yet. AgentDeck never retries through the terminal on its own |
| approve in Claude | Claude is holding it until you approve it in that session |
| Claude refused | Claude declined the message |
| approval declined / approval expired | The approval was declined, or it timed out |
| message dropped | Claude discarded the message |
| inbox unavailable | The session's inbox could not be reached |

To use the terminal path for Claude anyway, set `voice.claudeDelivery: "terminal"`.
Protocol details are in [daemon.md § Claude inbox dictation](daemon.md#claude-inbox-dictation).

## Terminal host checks

Other agents, Claude sessions without an inbox and the standalone macOS app use
the terminal path. For observed terminal sessions on that path, the CLI daemon tries tmux and cmux first. Before using iTerm2 or Terminal.app, it reads the agent process's executable ancestry with a bounded `ps` query and only sends AppleScript to the identified host. This applies to both dictated prompts and device answers. An unsupported host such as Ghostty reports `terminal host not supported (Ghostty)` without requesting Automation access to unrelated apps. A missing PID or unreadable ancestry reports `terminal host unknown (…)` and skips AppleScript as well.

On the terminal path, Ghostty, WezTerm, kitty, Alacritty and editor terminals can receive input through tmux; direct typing into those hosts is not supported. Claude Code sessions there use the peer inbox instead (above). Granting control over Terminal.app does not enable delivery to another terminal.

## Delivering to a session in cmux

The CLI daemon types a dictated prompt into a session running in [cmux](https://cmux.com) through the `cmux` CLI (#541). The macOS app cannot, because it never spawns subprocesses. The daemon finds the surface from `CMUX_SURFACE_ID` in the agent process's own environment, so no hook or setup change is needed. It never forces delivery: if the prompt already holds text you are typing, or a question or permission dialog is open, cmux refuses and the prompt is left as it was.

**Set cmux's Socket Control Mode to Automation mode.** The default, "cmux processes only", accepts only processes started inside cmux. A daemon started by the LaunchAgent is not one of them, so every delivery fails with a log line such as:

```
voice: "…" -> observed:claude:… delivered=false (cmux socket refused (ERROR: Access denied - only processes started inside cmux can connect); set Socket Control Mode to Automation mode in cmux Settings)
```

Automation mode also accepts other apps running as the same Mac user, which is the boundary the daemon already works within. Change it in **cmux Settings**: `defaults write` does not reach a running cmux. We do not recommend "Full open access" (`allowAll`). It lets any local process drive your terminals, and the daemon does not need it.

A daemon started with `agentdeck daemon start --foreground` inside a cmux terminal is a cmux process, so it can connect under the default mode as well.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Transcript always empty, no error | Speech Recognition permission denied | System Settings → Privacy & Security → Speech Recognition → enable AgentDeck |
| Transcript empty on first attempt, works second time | OS is downloading on-device dictation model | Wait 30-60s after granting permission, or force download under Settings → General → Keyboard → Dictation |
| "Recognizer unavailable" in logs | Dictation model not yet installed for your locale | Enable Dictation under System Settings → General → Keyboard for the current locale or English |
| Deck VOICE key fails with `unauthorized: microphone access denied for agentdeck-fm-helper` (or `speech recognition denied for …`) | The helper's microphone entry was turned off, or a prompt was answered Don't Allow | Enable **agentdeck-fm-helper** under System Settings → Privacy & Security → Microphone (or Speech Recognition), or run `tccutil reset Microphone` / `tccutil reset SpeechRecognition` to be asked again |
| Microphone level stays at zero | Microphone permission denied, or a different app holds the input | Check System Settings → Privacy & Security → Microphone; quit other apps using the mic (Zoom, Discord…) |
| Wrong language detected | Your first preferred language is not the one you speak, or its model is missing | Set `voice.locale` (see above), and enable Dictation for that language |
| Voice cut off at 15 seconds | Hit `maxRecordingDuration` | Press the voice button again for a new turn. Voice commands are designed to be short |
| Transcript correct but agent doesn't receive | Daemon/bridge not connected | Check the menu bar dashboard — Connection status must be "Connected" before voice sends work |
| VOICE says `terminal host not supported (Ghostty)` for a Claude Code session | The session has no advertised inbox: hooks were not refreshed after upgrading, or the session started before the refresh | Run `agentdeck daemon install`, then start a new `claude` session |
| VOICE stays on `receipt pending` or shows `approve in Claude` | The receiving Claude session has not confirmed the message, or is holding it for approval | Check that session; AgentDeck does not resend through the terminal |
| Daemon logs `delivered=false (cmux socket refused …)` | cmux's Socket Control Mode is "cmux processes only", which rejects a LaunchAgent daemon | Switch it to Automation mode in cmux Settings (see [Delivering to a session in cmux](#delivering-to-a-session-in-cmux)) |
| Daemon logs `delivered=false (cmux: … holds text someone is typing …)` or `… waiting on a question or dialog …` | cmux refused to type over your draft or into an open dialog | Clear the prompt or answer the dialog, then dictate again. This refusal is deliberate |
| Deck VOICE key does nothing; daemon logs `voice: host PTT failed: … request timed out` or `helper exited (SIGABRT)` | The CLI daemon's `agentdeck-fm-helper` was built without the embedded usage descriptions, so TCC killed it instead of prompting | Rebuild it: `cd bridge && node scripts/build-fm-helper.mjs` (verify with `codesign -dv assets/fm-helper/agentdeck-fm-helper` → `Info.plist entries=4`), restart the daemon, then grant the two **agentdeck-fm-helper** prompts |

**Logs**: `DaemonVoiceAssistant` writes to the standard AgentDeck log. Search for `[Voice]` entries:

```bash
# App Store macOS build
log stream --predicate 'subsystem == "dev.agentdeck.daemon"' --info --debug | grep Voice

# CLI / Homebrew build
tail -f ~/.agentdeck/swift-daemon.log | grep Voice
```

---

## Why we removed whisper.cpp

Earlier releases relied on `whisper.cpp` + a local HTTP server (port 9100) + `sox` for audio capture. That pipeline required:

- arm64 Homebrew installed at `/opt/homebrew/` (not Rosetta)
- `brew install sox whisper-cpp`
- A ~1.5 GB model download (`ggml-large-v3-turbo.bin`)
- Keeping `whisper-server` running alongside the daemon
- Matching node-pty / node.js ABI for the bridge

That was fine for power users but meaningful setup friction for everyone else — three of the four reviewer-flagged risks at launch time were traceable to it. Apple's `SFSpeechRecognizer` provides equivalent on-device transcription for the 15-second-per-turn commands AgentDeck actually cares about, for free, with zero install, and without privacy compromise (`requiresOnDeviceRecognition = true`). Removing whisper reduced the install surface and made the App Store build simpler to audit against Apple Review Guideline 2.5.2.

The Node daemon kept a whisper.cpp path (binary discovery, model tiering, a `whisper-server` on port 9100) after the Apple side dropped it. That asymmetry ended on 2026-07-26: `voice.ts` now transcribes through the bundled Swift helper, and `whisper-server-manager.ts` plus the `WHISPER_*` / `MODELS_*` path constants were deleted. One engine, both daemons.

If you need whisper.cpp's accuracy on longer recordings or specialized jargon (medical, legal, etc.), that use case is out of scope for AgentDeck's short-command voice UX. Build a separate recording tool.
