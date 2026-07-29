---
id: policy.product-tiers
title: App Store and CLI Product Tiers
description: Canonical capability boundary between the standalone App Store app and the external CLI daemon.
category: Engineering
locale: en
canonical: true
status: required
owner: Apple product maintainers
reviewed: 2026-07-27
revision: 2026-07-27
source_of_truth: docs/appstore-feature-matrix.md
validators: [bash apple/scripts/verify-appstore-archive.sh]
---

# App Store and CLI Product Tiers

**Distribution status:** macOS `1.0.0` has been live since 2026-07-21 at [AgentDeck Dashboard on the Mac App Store](https://apps.apple.com/app/id6784822497). The iPhone/iPad companion remains in review. The repository's unified source version may advance independently between channel releases.

This matrix defines which capabilities belong to the standalone App Store product and which require the external `agentdeck` CLI. Add or move a row here **before** implementing a capability.

## Product contract

| Tier | Contract |
|---|---|
| Tier 1 — App Store | Complete sandboxed dashboard. No PTY, subprocess, bundled interpreter, helper executable, or install prompt. |
| Tier 2 — CLI | Optional Node daemon that owns PTYs and integrations requiring external tools or unrestricted process discovery. |

The submitted macOS app must not contain `Process()`, `/bin/sh`, AppleScript, generated `.command` files, or bundled Node/Python/sqlite binaries. Native serial, BLE, local-network, and user-selected-file access remain valid when implemented with Apple frameworks and declared entitlements.

The upgrade story exists in README, web, and developer documentation only. App Store UI must not tell users to install or launch a companion executable. CLI-only sections appear as progressive enhancement when an independently running external daemon is detected.

## Steering invariant

All surfaces follow the same rule:

1. Render steering controls only from real `options[]` supplied by a PTY-managed session.
2. An observed session never emits `requestId`.
3. Display-only attention shows the question and “Respond in the terminal”; it does not invent Allow/Deny choices.
4. Permission attention is keyed by `notification_type: permission_prompt`; free-text matching is legacy fallback only.

## Core dashboard

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| macOS dashboard and in-process daemon | Yes | — | Standalone Tier 1 product |
| iOS / iPadOS companion | Yes | Yes | Bonjour + same-LAN WS |
| Stream Deck family | Yes | Yes | Requires Elgato Stream Deck host software |
| Claude Code hook installation | Yes | Yes | Explicit `NSOpenPanel` file consent |
| Codex lifecycle observation | Yes | Yes | Explicit `NSOpenPanel`; managed TOML block only |
| Voice input | Yes | Yes | Apple on-device speech in both tiers — Tier 1 calls the framework, Tier 2 the bundled Swift helper. macOS-only; no whisper/model install |
| Device Preview catalog | Yes | Yes | CLI-only targets appear only with external daemon |
| APME Layer 2 LLM evaluation | Yes | Yes | Apple Intelligence default; opt-in HTTP alternatives |
| APME Layer 1 deterministic evaluation | No | Yes | Requires `git` / package-manager subprocesses |
| Timeline completion summary | Yes | Yes | Foundation Models → optional MLX HTTP → heuristic |

## Usage and cost

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| Claude subscription 5h / 7d usage | Relay only | Yes | Tier 1 relays only what an external daemon supplies — no standalone Tier-1 path exists. Anthropic ToS prohibits third-party Claude.ai login / routing through subscription credentials (enforced 2026-04-04 vs OpenClaw/OpenCode/NanoClaw); the only documented Usage API is org-admin-only and returns token/USD, not consumer %; the true 5h/7d % lives only in Claude Code's undocumented `/api/oauth/usage`. Shipped competitors (LimitWatch, Usage for Claude) use the same broker→iCloud→display architecture — LimitWatch ships its Mac broker as a non-App-Store direct download because the sandbox blocks reading AI-tool config files. |
| Codex rate limits | Yes | Yes | User grants a security-scoped bookmark to `~/.codex` |
| Anthropic Admin API usage | Yes | Yes | User supplies the API key |
| PTY token and cost stream | Hook-only | Yes | PTY parsing belongs to Tier 2 |

## Hardware

| Device / operation | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| Ulanzi D200H | Yes | Yes | Ulanzi Studio plugin is the only driver; no direct HID |
| Pixoo64 | Yes | Yes | Native LAN HTTP |
| Timebox Mini | Yes | Yes | Tier 1 CoreBluetooth; Tier 2 BLE helper path |
| iDotMatrix | Yes | Yes | Tier 1 CoreBluetooth; one BLE display connection at a time |
| ESP32 state display and Wi-Fi provisioning | Yes | Yes | Native serial and network frameworks |
| ESP32 serial firmware flash | No | Yes | Requires `esptool.py` |
| ESP32 Wi-Fi OTA push | Yes | Yes | Firmware bytes pushed over existing WS; firmware build remains CLI-only |
| Ulanzi TC001 | Pending | Yes | Swift `led8x32` hardware verification gap, not sandbox restriction |
| InkDeck | Experimental | Experimental | Registration exists; physical render/refresh release validation incomplete |
| XTeink X3 / X4 | Yes | Yes | Community CrossPoint firmware; registers with both daemons over Wi-Fi (SD-card flash distribution) |
| Android e-ink / tablet presence | Partial | Yes | Same-LAN self-registration is safe; ADB preview/tunnel requires CLI |

## Agent sessions

| Capability | App Store | CLI | Boundary |
|---|:---:|:---:|---|
| Claude Code hook monitoring | Yes | Yes | Local HTTP hook ingestion |
| Codex lifecycle/notify/OTel monitoring | Yes | Yes | Opt-in managed config |
| Existing terminal-session discovery | Limited | Yes | General `ps` / `lsof` / transcript discovery is CLI-only |
| Display-only permission attention | Yes | Yes | Real permission notification; no fabricated options |
| Session order pinning (`--weight` sort override) | Limited | Yes | Weight is CLI-set at session launch and reaches the Swift daemon via `session_push_register`; the App Store app displays the resulting order (no in-app weight editor, and observed-hook sessions never carry weight) |
| PTY option steering | No | Yes | Real parsed options and key injection |
| Observed-session answer injection (device tap → host UI) | No | Yes | tmux / iTerm2 / Terminal.app by tty, GUI apps by AX button or key events. Needs `ps` tty discovery + tmux/osascript subprocesses — both CLI-only; sandbox has neither |
| OpenCode monitoring | Opt-in read-only | Yes | Tier 1 connects only to a configured/fixed local server; no port scan |
| Antigravity session monitoring | No | Yes | Tier 1 may display user-approved usage data only |
| Launch Claude / Codex / OpenCode session | No | Yes | App Store has no launch-session entry point |
| OpenClaw Gateway WebSocket pairing | Yes | Yes | Local WS, Keychain identity, optional user-selected token file |
| OpenClaw CLI pairing | No | Yes | Requires external `openclaw` process |

## Infrastructure

| Component | App Store | CLI |
|---|---|---|
| Minimum macOS | macOS 26+ | macOS 15+ for Node; macOS 26+ for Swift/Foundation Models paths |
| Minimum iOS / iPadOS | iOS 17 | — |
| Daemon | In-process Swift | Node.js 22+ |
| Data directory | App sandbox Application Support | `~/.agentdeck/` |
| Executable payload | Signed AgentDeck binary only | Node packages and external tool integrations |

The Node daemon deliberately excludes the App Store container from settings discovery. A non-sandboxed process reading that container can trigger TCC hangs; coexisting Tier 2 settings must live in the daemon’s own data directory.

## Parity intent (decided 2026-07-26)

The tier split is a sandbox consequence, not a product goal. Two standing
decisions follow from that:

1. **The Swift daemon tracks the Node daemon as closely as the sandbox
   allows.** When a capability lands on Node, port it to Swift unless an
   entitlement or the no-subprocess contract makes it impossible — and when it
   is impossible, say so where the user can see it (a log line or hidden UI),
   never a silent no-op.
2. **App-hosted agent surfaces are pursued, not written off.** Claude.app and
   ChatGPT.app sessions are first-class targets for steering; where their
   accessibility trees are opaque, use the focus-free key path and keep the
   button path for hosts that do expose controls.

## Required change order

1. Add or change the capability row in this matrix.
2. For Tier 1, prove a subprocess-free implementation path.
3. Keep App Store copy self-contained; never add a CLI install or Terminal launch nudge.
4. Update `apple/APP_REVIEW_NOTES.md` and App Store metadata when behavior or disclosure changes.
5. Extend `apple/scripts/verify-appstore-archive.sh` if a new forbidden path needs detection.
6. Build a signed Release archive and run the archive verifier. An unsigned Debug build is not submission evidence.

## Rejected patterns

- `Process()`, AppleScript, shell scripts, or external CLI calls in the macOS source tree.
- App Store copy such as “Install AgentDeck CLI” or “Open Terminal and…”.
- Buttons that imply an external daemon or helper will be launched.
- Treating Gateway availability as authenticated connection; use the authenticated state.
- Showing sandbox limitations as broken empty sections; hide unavailable progressive enhancements.
- Rendering steering buttons without real session options.
