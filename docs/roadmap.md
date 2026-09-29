# Roadmap & Milestones

Where AgentDeck is going. Shipped history lives in
[CHANGELOG.md](../CHANGELOG.md); release mechanics in [RELEASING.md](../RELEASING.md).

## Next Milestones — Current Focus

The current focus is dashboard clarity, natural aquarium motion, useful
collaboration summaries, and personalized agent evaluation.

## 1. Apps and distribution

Install the computer hub and optional companions from their official channels:
[Mac, iPhone, and iPad](https://apps.apple.com/app/id6784822497),
[Android](https://play.google.com/store/apps/details?id=dev.agentdeck),
[Stream Deck](https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464),
and [Ulanzi Studio](https://ugc.ulanzistudio.com/contentView/1141).
The [README delivery table](../README.md#compatibility-and-delivery-channels)
also links the CLI, signed Android APK, and ESP32 firmware.

The Mac app includes a self-contained Swift daemon. iPhone, iPad, and Android
connect to a hub on the local network. Channel-specific release records belong
in [RELEASING.md](../RELEASING.md) and the development log, rather than this roadmap.

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
- [x] Mac App Store distribution with a self-contained Swift daemon
- [x] ESP32 compact displays (Round AMOLED 1.8", IPS LCD 3.5", B86 Box 4", TTGO T-Display 1.14", IPS 10.1", Ulanzi TC001)
- [x] TRMNL 7.5" e-ink panel (Seeed TRMNL 7.5" OG DIY Kit, custom ESP32 firmware, WiFi/WS partial refresh, WiFi OTA updates)
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
- [x] iPhone/iPad companion distribution through the App Store
- [x] **Windows daemon autostart** — `agentdeck daemon install` registers a per-user Scheduled Task (`AgentDeckDaemon`, logon trigger) so the daemon auto-starts in the interactive session, the Windows analog of the macOS LaunchAgent. See [daemon.md → Autostart](daemon.md#autostart-loginlogon).
- [x] Android distribution through Google Play and signed GitHub APKs
- [x] Stream Deck plugin distribution through the Elgato Marketplace

- [x] Selectable native 3D aquarium on Apple and Android LCD devices, with preserved preferences
- [x] Mobile viewing mode with camera zoom, state-driven creatures, and responsive fish
- [x] Bounded foreground residents with the full session roster retained
- [x] Collaboration task history and reported subagent activity
- [x] z.ai/GLM usage layouts across supported display classes
- [x] Wireless signed-APK updates on Android tablets and e-ink readers

## In Progress

- [ ] APME vibe-labeling accumulation → Stage 4 OPRO rubric auto-tuner activation (needs ≥30 disagreement samples)

## Planned

Further dashboard work is guided by device feedback and measured rendering
performance. New display types should preserve existing preferences and keep
status information readable before adding visual detail.

---

<p align="center">
<strong>AgentDeck</strong> — Physical Control Surface for AI Coding Agents
</p>
