# TestFlight QA Checklist — AgentDeck Dashboard

Hand this checklist to internal testers (you + 2-3 trusted reviewers) before submitting to App Review. The goal is to catch the categories of issues that cause App Store rejections or one-star reviews on day one.

**Estimated time**: 45–60 minutes per tester for full pass. Skip sections for hardware you don't own.

---

## Tester setup

- Clean Apple ID or a test account (optional but ideal — a first-time install reveals onboarding gaps).
- macOS 26+ on Apple Silicon or Intel; or iOS 17+ on iPhone/iPad.
- Claude Code CLI installed: `npm install -g @anthropic-ai/claude-code`.
- Internet connection (for initial Claude Code install + any remote agents).
- Microphone (any built-in Mac mic or iPad mic works).

Before starting, note your macOS version, device model, and any non-default accessibility / language settings in the bug report template at the end.

---

## Section A — First-run experience (macOS)

> Goal: Confirm the app doesn't feel broken before the user has set anything up.

- [ ] **A1**. Install the TestFlight build. On first launch, the **3-pane onboarding sheet** opens automatically over the dashboard. Tagline reads "Stop Chatting. Start Steering."
- [ ] **A2**. Pane 2 asks "Are you already using an AI coding agent?" with two equally-weighted buttons. Clicking "Help me install one" reveals three agent cards (Claude Code, Codex, OpenCode). Each "Open Guide" button opens the correct official docs URL in a browser:
  - Claude Code → `docs.claude.com/en/docs/claude-code/quickstart`
  - Codex → `github.com/openai/codex`
  - OpenCode → `opencode.ai/docs`
- [ ] **A3**. Pane 3 mentions iOS companion + the word "Preview Devices". Clicking "Get Started" closes the sheet; `hasSeenOnboarding` flips to true.
- [ ] **A4**. Onboarding **does not reappear** on subsequent launches.
- [ ] **A5**. After onboarding closes, the **notification permission NSAlert** fires within ~1 second (not during onboarding). Message: "Enable AgentDeck notifications?" Grant or decline — either way, dialog does not reappear.
- [ ] **A6**. Dashboard renders with an empty terrarium. An overlay card says "Start your first session." with a "Preview Devices" button and a "Got it" dismiss. The body text reads "Sessions appear automatically once the bridge picks one up — each one shows up here as a creature in the terrarium." (no Launch button, no terminal-launch prompt).
- [ ] **A7**. Clicking "Preview Devices" opens a 1100×760 window with 17 standalone device previews in the sidebar. Changing agent/state/session-count picker updates all device previews live. No hardware required.

---

## Section B — First-run experience (iOS)

- [ ] **B1**. Install via TestFlight. First launch shows full-screen 3-pane onboarding ("Stop Chatting" → agent info → "Find your Mac").
- [ ] **B2**. Local Network permission prompt appears the first time onboarding reaches pane 3 (or when you tap Get Started). Allow it.
- [ ] **B3**. Pane 3 has a **Scan QR from Mac** button that opens a camera view. Camera permission prompt appears on first tap.
- [ ] **B4**. After Get Started, if a Mac is running AgentDeck on the same Wi-Fi, Bonjour auto-discovers it within 10 seconds and the dashboard mirrors state.
- [ ] **B5**. Terrarium renders at a smooth framerate; creatures match the sessions on the Mac.

---

## Section C — Session monitoring (Claude Code)

> Goal: Confirm the core value proposition — monitoring a live session — actually works.

- [ ] **C1**. Menu bar pill bar contains **Dashboard** and **Evaluation** only — no "Launch Session" entry. The Dashboard pill toggles the dashboard window's visibility (filled when open, outlined when closed).
- [ ] **C2**. Confirm no Terminal window, `.command` file, AppleScript prompt, or child process is created by AgentDeck during normal use.
- [ ] **C3**. Open Settings → Claude Code Hooks. Click **Enable Claude Code Hooks…**
- [ ] **C4**. An NSAlert explains what will be written. Click Continue.
- [ ] **C5**. An NSOpenPanel opens at `~/.claude/`. Select `settings.json`. AgentDeck writes hooks and Settings shows a green "Hooks installed" status.
- [ ] **C6**. Type a simple prompt in Claude Code ("explain this file"). Within 2-3 seconds the dashboard terrarium shows an active creature, tools are listed in the tank panel, and the timeline strip scrolls.
- [ ] **C7**. Finish the Claude Code session. The creature state transitions to idle.
- [ ] **C8**. Settings → Claude Code Hooks → **Remove**. Settings shows "Not configured" again. Verify `~/.claude/settings.json` no longer contains AgentDeck hook entries (e.g., `cat` it in Terminal).

---

## Section D — OpenClaw Gateway pairing (if OpenClaw installed)

Skip if you don't have OpenClaw 2026.4.14+ installed.

- [ ] **D1**. Start OpenClaw Gateway: `openclaw start` (or your regular launch command). It should listen on `ws://127.0.0.1:18789`.
- [ ] **D2**. Open Settings → Services. The OpenClaw Gateway row shows **Pairing required** state with instructions.
- [ ] **D3**. Run `openclaw devices list` in a terminal. A new device with id matching `sha256(pubkey)` hex (shown in AgentDeck logs) appears as "pending".
- [ ] **D4**. Approve the pending AgentDeck device in OpenClaw Web UI.
- [ ] **D5**. Within 10 seconds, Settings flips to **Connected**. Model catalog populates in the tank panel.
- [ ] **D6**. Force-quit AgentDeck, relaunch. AgentDeck reconnects using the stored `deviceToken` — no re-approval needed. Settings shows **Connected** within 5 seconds of launch.

---

## Section E — iPad companion pairing

- [ ] **E1**. With the Mac dashboard active, open AgentDeck on iPad (same Wi-Fi). Onboarding → Get Started → auto-discovery pairs within 10 seconds.
- [ ] **E2**. Dashboard on iPad shows the same session list, terrarium, and tank status as the Mac.
- [ ] **E3**. Disconnect iPad from Wi-Fi. Dashboard shows a "Last updated Ns ago" banner but does not crash; terrarium continues animating with stale data.
- [ ] **E4**. Reconnect to Wi-Fi. Data resumes within 2 seconds.
- [ ] **E5**. Menu bar on Mac → **Pair iPad**. QR window appears with the ws:// URL. On iPad → Settings → Scan QR → point camera at Mac screen.
- [ ] **E6**. iPad connects via the scanned URL (even if you temporarily disable Local Network permission on iPad to force the QR path).

---

## Section F — Voice input

- [ ] **F1**. Press the voice button (menu bar or dashboard). On first use, macOS prompts for **Microphone access** and then **Speech Recognition access**. Grant both.
- [ ] **F2**. Speak a short command: "list the files in this directory". Within 2-3 seconds, the transcript appears and is sent to the active Claude Code session.
- [ ] **F3**. If you deny Speech Recognition, subsequent voice attempts fail silently (no crash). Re-grant under System Settings → Privacy & Security → Speech Recognition and verify F2 works again.
- [ ] **F4**. Recording auto-stops after 1.5s of silence, or at 15s max. Neither cutoff crashes the app.
- [ ] **F5**. First transcription after enabling dictation for a new language may take 30-60s while the on-device model downloads. Confirm this doesn't surface as an error — just an empty transcript with a clear log entry.

---

## Section G — APME Reports

- [ ] **G1**. Menu bar → **Reports**. APME Dashboard window opens.
- [ ] **G2**. If no sessions have finished yet, the dashboard shows a clear "No APME reports yet" empty state with a 3-step Quick Start (not a black hole).
- [ ] **G3**. Run a Claude Code session to completion. Within 5-10 seconds of completion, a new row appears in the Runs table.
- [ ] **G4**. Click a row. Right side shows transcript + judge scores. Category tag (coding/debug/docs/etc.) is sensible.
- [ ] **G5**. Open Settings → APME. Default backend is **Foundation Models (on-device, free)**. No network traffic should be generated when a session completes. (Verify with Little Snitch / Activity Monitor's Network tab if available.)

---

## Section H — Hardware integrations (skip what you don't own)

### Stream Deck+ (requires Elgato Stream Deck software)

- [ ] **H1**. Plug in Stream Deck+. Menu bar dashboard shows a "Stream Deck+ detected" prompt. If Elgato software is missing, a Download button opens elgato.com/downloads.
- [ ] **H2**. After installing Elgato software, the prompt updates to "Install Stream Deck+ plugin". Clicking it opens the bundled plugin (or falls back to GitHub releases).
- [ ] **H3**. Plugin appears in Stream Deck app. Drop an AgentDeck session action onto a key. Key renders the session slot.

### Ulanzi D200H Deck Dock

- [ ] **H4**. Plug in D200H. Dashboard menu bar shows the D200H in the devices section within 5 seconds. Native keys display session tiles.
- [ ] **H5**. Press a D200H key. The corresponding session is focused in the dashboard.

### ESP32 display (e.g., 86Box, IPS 3.5", Round AMOLED)

- [ ] **H6**. Plug ESP32 into USB. Open Settings → Hardware Setup → **Set up ESP32…**
- [ ] **H7**. Sheet detects the USB port. Type SSID + password. Click Send. Within 10 seconds ESP32 joins Wi-Fi and the dashboard timeline shows the new device connected.

### Divoom Pixoo matrix

- [ ] **H8**. Open Settings → Hardware Setup → **Pixoo matrix displays → Manage…**
- [ ] **H9**. Enter your Pixoo's IP. Click **Test Connection**. Success toast shows the detected device name.
- [ ] **H10**. Click **Add**. Restart AgentDeck (daemon reads pixooDevices at startup). Pixoo renders the terrarium creature.

---

## Section I — Privacy and sandbox compliance (for App Review)

> Goal: Prove we haven't regressed the 2.5.2 compliance work.

- [ ] **I1**. Open Activity Monitor → find the AgentDeck process. Under the **Open Files and Ports** tab, confirm no subprocess children are spawned during normal use (no `bash`, `node`, `adb`, `whisper-cli`, `openclaw`).
- [ ] **I2**. Confirm the menu bar contains no "Launch Session" affordance and no other UI text directs the user to install or launch a companion CLI in Terminal.
- [ ] **I3**. Verify data is in the App Sandbox data container:
  ```bash
  ls ~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application\ Support/AgentDeck/
  # Should show: daemon.json, sessions.json, auth-token, settings.json, apme.sqlite, …
  ```
- [ ] **I4**. Verify `~/.agentdeck/` is NOT created (App Store build never writes there):
  ```bash
  ls -la ~/.agentdeck/ 2>/dev/null && echo "REGRESSION" || echo "OK (doesn't exist)"
  ```
  If a pre-existing `~/.agentdeck/` exists from CLI usage, the App Store build must not write to it. Current 1.0 builds keep App Store state in the sandbox container and leave CLI state untouched.
- [ ] **I5**. Run `apple/scripts/verify-appstore-archive.sh /Applications/AgentDeck.app` — should print `✓ ... passes App Store archive verification`.
- [ ] **I6**. Speak a voice command. Open Network Utility / Little Snitch. Confirm no traffic to `*.apple.com` or any speech-related endpoint — audio must stay on-device.
- [ ] **I7**. Generate an APME judge score (finish a Claude Code session). Confirm no outbound HTTPS traffic to `api.anthropic.com` (default backend is Foundation Models, on-device).

---

## Section J — Crash / stability

- [ ] **J1**. Let the dashboard run for 30+ minutes with 2-3 active sessions. No memory leaks (Activity Monitor Memory should plateau within reasonable range < 500 MB).
- [ ] **J2**. Sleep the Mac for 5 minutes, wake. Dashboard reconnects automatically. No "daemon stopped" dead state.
- [ ] **J3**. Force-quit AgentDeck while a session is running. Relaunch. App comes up cleanly; stale daemon.json is purged by SingletonGuard; session reconnects via hooks.
- [ ] **J4**. Toggle Wi-Fi off then on. iPad companion reconnects within ~10 seconds. macOS daemon continues serving local-only clients during offline window.
- [ ] **J5**. Launch 2 AgentDeck instances (drag .app to another location to force a second copy). Second instance should activate the first and exit — no double-daemon race.

---

## Section K — Unity / polish bugs to watch for

- [ ] **K1**. Dashboard text doesn't truncate awkwardly on the smallest supported window size (1280×840).
- [ ] **K2**. Dark Mode + Light Mode both render without color contrast failures. Toggle macOS appearance once during testing.
- [ ] **K3**. No placeholder strings ("TODO", "Lorem ipsum", "FIXME", "Unknown") appear in any user-facing label.
- [ ] **K4**. Dashboard localizes to Korean correctly if macOS is set to Korean (or falls back to English cleanly if not). No mixed-language rows.
- [ ] **K5**. iPad rotation (portrait ↔ landscape) does not break the terrarium canvas.

---

## Bug report template

For each failure above, capture:

```
## Test ID (e.g. C6)
Title: <brief symptom>

Environment:
- Device: <model>
- OS: <macOS / iOS version>
- Build: <TestFlight build number, e.g. 0.2.3 (2)>
- Attached session: <claude-code / codex / opencode / openclaw — if relevant>

Steps to reproduce:
1. …
2. …

Expected:
…

Actual:
…

Logs:
```
<log tail if available; for macOS:
 log show --predicate 'subsystem == "dev.agentdeck.daemon"' --info --last 5m
>
```

Screenshots/video: <attachments>
```

Send to `puritysb@gmail.com` or file as a GitHub issue.

---

## What "pass" looks like before App Review submission

- **All Section A–C checkboxes green** — first-run experience is not embarrassing.
- **Section D green if OpenClaw installed, skipped otherwise** — the advanced integration doesn't regress when present.
- **All Section E boxes green on at least one iOS device + one Mac** — the companion story works.
- **All Section F boxes green** — voice is the most reviewer-visible "is this thing pretending to work" feature.
- **All Section I boxes green** — sandbox compliance is auditable.
- **Section J + K zero regressions**.
- **Sections G, H optional** — nice to have; not blockers unless you're shipping a hardware-first marketing push.

When the above looks clean across 2-3 testers, tag `apple-v0.2.3` and submit.
