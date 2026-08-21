# Roadmap & Milestones

Where AgentDeck is going. Shipped history lives in
[CHANGELOG.md](../CHANGELOG.md); release mechanics in [RELEASING.md](../RELEASING.md).

## Next Milestones — Current Focus

Store distribution is complete on every channel that has one. The remaining focus is personalized agent evaluation:

## 1. Store Distribution — shipped

Both app stores now carry AgentDeck, verified 2026-08-21 against the stores themselves rather than against approval mail:

| Store | Live | Measured by |
|---|---|---|
| [Mac App Store](https://apps.apple.com/us/app/agentdeck-dashboard/id6784822497?platform=mac) | **1.0.7** (build 5201), 2026-08-19 | product page with `?platform=mac` |
| [App Store — iPhone / iPad](https://apps.apple.com/us/app/agentdeck-dashboard/id6784822497) | **1.0.7** (build 5201), 2026-08-18 | `itunes.apple.com/lookup?id=6784822497` |
| [Google Play](https://play.google.com/store/apps/details?id=dev.agentdeck) | **1.0.10** (versionCode 12), 2026-08-19, 177 countries | public listing HTML |

One Apple submission does not release two platforms at once — the same build 5201 went live 29 hours apart, so a macOS approval says nothing about iOS or the reverse. The iOS record got there the hard way: the first submission, 1.0.2 (3901), was rejected on 2026-08-04 under Guideline 2.1(a) because the disconnected screen kept an activity indicator running after discovery had finished; the fix bounds that indicator and adds an offline Device Preview entry point. The macOS app ships a standalone in-process Swift daemon — mDNS discovery, native device modules, OpenClaw Gateway WebSocket client, hook ingestion, and HTTP + WebSocket server. App Store compliance is gated by the `AGENTDECK_APP_STORE` compile flag: no bundled Node.js / `adb` / D200H helper, no subprocess spawn, no AppleScript (per Apple Review Guideline 2.5.2). User data lives in `~/Library/Containers/bound.serendipity.agent.deck/Data/Library/Application Support/AgentDeck/` (routed through `AgentDeckPaths.swift`; never hand-write the path). AgentDeck requests no USB HID entitlement — the D200H is driven solely by the Ulanzi Studio plugin. OpenClaw integration uses Gateway-native pairing (self-generated Ed25519 identity in Keychain + Gateway-issued device token) — no file read of `~/.openclaw/identity/`. `apple/scripts/verify-appstore-archive.sh` is wired into CI and asserts these invariants on every archive.

## 2. Personalized Agent Evaluation System (APME)

Building a data-driven answer to "which of my 6+ LLMs should I route this task to?" — replacing gut-feel model selection with measurement on my actual work. All three ingestion paths (Claude Code hooks + transcript JSONL, OpenClaw/OpenCode timeline events, Codex lifecycle hooks + notify + rollout JSONL) converge on a unified `ApmeCollector` → local SQLite. **Category-aware evaluation:**
- **Coding (coding/refactoring/debugging)** — run-level eval after session ends, deterministic layer (lint/build/test) + LLM judge with category-specific rubrics
- **Non-coding (conversation/planning/research/review)** — turn-level mid-session eval, fires immediately after each turn completes, no git diff needed
- **Composite score** — 4-dimensional weighted sum (0.40 outcome + 0.40 judge + 0.15 efficiency + 0.05 vibe) so a single noisy signal can't poison the run

**Judge is local-only** (Apple Intelligence primary in the Swift app, MLX fallback in the CLI, OpenClaw Gateway secondary) so `sampleRate: 1.0` is the default — every session evaluated, zero cost. **Auto-tuning** via OPRO loop picks up disagreement between human vibe labels and judge scores, proposes new rubrics, and shadow-scores them before accepting. The **Model Recommender** reads `v_category_scorecard` to suggest the best model per category + budget.

Eval results broadcast to every device simultaneously (Stream Deck/Apple/Android/ESP32/TUI) via the `★ eval_result` timeline entry — pulling labeling into peripheral vision instead of burying it in a dashboard nobody opens.

**Current bottleneck:** not the infrastructure (complete), but accumulating enough vibe-labeled data to unlock Stage 4 auto-tuning.

---

## Roadmap

## Achieved

- [x] Android tablet + e-ink dashboard (Jetpack Compose)
- [x] Apple iOS/iPad/macOS dashboard (SwiftUI multiplatform)
- [x] macOS in-process Swift daemon (Node.js-free macOS install)
- [x] Apple TestFlight CI pipeline
- [x] Mac App Store distribution — AgentDeck Dashboard 1.0.0 (2026-07-21), currently 1.0.7 (2026-08-19)
- [x] ESP32 compact displays (Round AMOLED 1.8", IPS LCD 3.5", B86 Box 4", TTGO T-Display 1.14", IPS 10.1", Ulanzi TC001)
- [x] InkDeck e-ink panel (Seeed TRMNL 7.5" OG DIY Kit, custom ESP32 firmware, WiFi/WS partial refresh, WiFi OTA updates)
- [x] Ulanzi D200H Deck Dock (14-key HID + 960×540 LCD via official Ulanzi Studio plugin; direct-HID fallback retired)
- [x] TUI terminal dashboard (Unicode Braille + ANSI)
- [x] Pixoo64 LED matrix pixel art
- [x] Codex CLI session support
- [x] OpenCode session support (PTY + SSE hybrid)
- [x] Multi-agent visualization (Claude Code + Codex + OpenCode + OpenClaw creatures)
- [x] Stream Deck+ v4 session-per-button layout
- [x] Daemon mode with multi-session aggregation
- [x] Voice assistant pipeline (wake word → STT → LLM → TTS)
- [x] Display sleep/wake sync across all surfaces
- [x] Color E-ink support (Kaleido 3)
- [x] Creature simulator demo page (GitHub Pages `/demo/`)
- [x] APME — session dataset, 3-path ingestion (hook/timeline/PTY), 10-category classifier, category-aware evaluation (run-level coding + turn-level non-coding), composite score, local-only judge (MLX + OpenClaw), rubric auto-tuner, model recommender, device-wide eval broadcast
- [x] **iPhone/iPad App Store distribution** — [AgentDeck Dashboard](https://apps.apple.com/us/app/agentdeck-dashboard/id6784822497) 1.0.7 (build 5201) went live for iOS on 2026-08-18 and for macOS on 2026-08-19. One submission, one build, two release times 29 hours apart — neither platform implies the other.
- [x] **Windows daemon autostart** — `agentdeck daemon install` registers a per-user Scheduled Task (`AgentDeckDaemon`, logon trigger) so the daemon auto-starts in the interactive session, the Windows analog of the macOS LaunchAgent. See [daemon.md → Autostart](daemon.md#autostart-loginlogon).
- [x] **Play Store distribution** — AgentDeck is live on [Google Play](https://play.google.com/store/apps/details?id=dev.agentdeck): first public build 1.0.6 (versionCode 8) on 2026-08-15, currently **1.0.10 (versionCode 12)** published 2026-08-19 at 100% across 177 countries. The GitHub APK stays as a second channel. Listing copy, assets and the console runbook are in [marketplace/play/](../marketplace/play/LISTING.md).
- [x] **Stream Deck Marketplace registration** — first approved 2026-07-28 (1.0.2), Windows correction 1.0.3 on 2026-07-31, and **1.0.4 published 2026-08-05** at [AgentDeck on the Elgato Marketplace](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464). Listing assets and packages remain under `marketplace/elgato/`.

## In Progress

- [ ] APME vibe-labeling accumulation → Stage 4 OPRO rubric auto-tuner activation (needs ≥30 disagreement samples)

## Planned

Nothing queued beyond the In Progress item above — every previously planned
distribution and autostart item shipped and moved into **Achieved**.

---

<p align="center">
<strong>AgentDeck</strong> — Physical Control Surface for AI Coding Agents
</p>
