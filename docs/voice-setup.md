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

**The CLI daemon prompts as its own helper, not as a terminal.** The Node daemon's capture and transcription happen inside `agentdeck-fm-helper`, a single-file binary with no app bundle — so its usage strings are linked into an `__info_plist` section (`bridge/fm-helper/Info.plist`) and the binary is ad-hoc signed with a fixed identifier by `bridge/scripts/build-fm-helper.mjs`. Both are load-bearing: **TCC aborts the process (SIGABRT) instead of returning an error when it needs to prompt for a service the requesting code has no usage description for**, so a plist-less helper does not degrade — it dies, mid-turn, and the deck's VOICE key reports a timeout. The prompts read **AgentDeck Voice Helper**; grant them there.

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

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Transcript always empty, no error | Speech Recognition permission denied | System Settings → Privacy & Security → Speech Recognition → enable AgentDeck |
| Transcript empty on first attempt, works second time | OS is downloading on-device dictation model | Wait 30-60s after granting permission, or force download under Settings → General → Keyboard → Dictation |
| "Recognizer unavailable" in logs | Dictation model not yet installed for your locale | Enable Dictation under System Settings → General → Keyboard for the current locale or English |
| Deck VOICE key fails with `unauthorized: microphone access denied for "AgentDeck Voice Helper"` | The helper's microphone entry was turned off, or a prompt was answered Don't Allow | Enable **agentdeck-fm-helper** under System Settings → Privacy & Security → Microphone, or run `tccutil reset Microphone` to be asked again |
| Microphone level stays at zero | Microphone permission denied, or a different app holds the input | Check System Settings → Privacy & Security → Microphone; quit other apps using the mic (Zoom, Discord…) |
| Wrong language detected | Your first preferred language is not the one you speak, or its model is missing | Set `voice.locale` (see above), and enable Dictation for that language |
| Voice cut off at 15 seconds | Hit `maxRecordingDuration` | Press the voice button again for a new turn. Voice commands are designed to be short |
| Transcript correct but agent doesn't receive | Daemon/bridge not connected | Check the menu bar dashboard — Connection status must be "Connected" before voice sends work |
| Deck VOICE key does nothing; daemon logs `voice: host PTT failed: … request timed out` or `helper exited (SIGABRT)` | The CLI daemon's `agentdeck-fm-helper` was built without the embedded usage descriptions, so TCC killed it instead of prompting | Rebuild it: `cd bridge && node scripts/build-fm-helper.mjs` (verify with `codesign -dv assets/fm-helper/agentdeck-fm-helper` → `Info.plist entries=4`), restart the daemon, then grant the two **AgentDeck Voice Helper** prompts |

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
