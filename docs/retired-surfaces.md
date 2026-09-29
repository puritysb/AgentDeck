---
id: reference.retired
title: Retired and Experimental Surfaces
description: What was built, shipped or prototyped, and then removed — with the reason, the date, and whatever residue it left behind.
category: Engineering
locale: en
canonical: true
status: stable
owner: Repository maintainers
reviewed: 2026-07-21
revision: 2026-07-21
source_of_truth: docs/retired-surfaces.md
validators: [pnpm design-system:check]
---
# Retired and Experimental Surfaces

Things AgentDeck tried and stopped doing. Each entry records what it was, why it
went, when, and — the part that actually matters later — **what residue it left
in the shipping product**: an immutable UUID, a dormant stub, a filename that no
longer describes its contents.

This is not a changelog. A changelog says what changed in a release; this says
why something is absent, so the next person does not rebuild it, and so an
oddity in the current code has a traceable cause.

**What belongs here:** a capability that reached the product or a working
prototype and was then removed. **What does not:** ideas never built (that is
the roadmap), routine refactors, and per-release notes (that is
[CHANGELOG.md](../CHANGELOG.md)). Detailed narratives stay in the monthly devlog
archives under [docs/devlog/](devlog/README.md) — link to them rather than
copying them here.

## A note on version names

The Stream Deck layout was described as **v3** and then **v4** in earlier docs.
Those numbers were meant to track the product minor version — the original
headings read `v3 Layout (0.3.0)` and `v4 Layout (0.4.0)` — but the product was
`0.2.0` at both points, so they never matched a release that existed. Since
2026-07-11 the repository has a single product version SSOT (`VERSION`, now
`1.0.0`), and carrying a second, unrelated numbering alongside it only invited
the question "v4 of what?".

The numbering is therefore retired. The current layout is
[Stream Deck+ Layout](streamdeck-layout.md); the model it replaced is described
below as the **mode-dial layout**. Older devlog entries and commit messages
still say v3/v4 — they are historical records and were left as written.

## Stream Deck+

### Mode-dial keypad layout (the former "v3")

Eight keys with fixed roles — MODE, SESSION, USAGE in slots 0-2 and quick
actions in 3-7 — driven by six separate manifest actions (`mode-button`,
`session-button`, `usage-button`, `response-button`, `stop-button`,
`expanded-actions`). One Stream Deck showed one session.

Replaced by session-per-button: every key is a `session-slot`, so the deck shows
every session at once and a press opens that session's detail view. The old
per-state key tables (IDLE/PROCESSING/PERMISSION rows) and the intent-based
button colouring (green Approve / red Deny / blue Permanent, matched on labels
like *Always* or *Don't ask again*) went with it — no equivalent classifier
exists in the current code.

### Voice dial (E4)

Push-to-talk with local whisper transcription and a voice-text takeover canvas.
Removed for the Marketplace submission on 2026-07-19: it borrowed iTerm2's
microphone grant through AppleScript and required Homebrew `sox` plus a locally
downloaded whisper model. On a clean machine — a reviewer's, or a typical
user's — it failed silently. E4 is now the Launcher.

### Multi-mode Utility dial (E1)

E1 cycled through mic / media / timer / diag / apme / tower modes. The modes
drove `System Events` synthetic key codes, which fail silently without the
Accessibility grant. Removed 2026-07-19; E1 is volume-only.

The LCD touch handler went at the same time: touch-tap cycled those modes, which
was undiscoverable and did nothing at the default single-mode setting. **No
encoder handles LCD touch today.**

### iTerm session manager dial (E3)

E3 once managed iTerm sessions. **Residue:** the action UUID is still
`iterm-dial`, because UUIDs are immutable after distribution — E3 is now the
Codex usage gauge. The same applies to `utility-dial` (now Volume) and
`option-dial` (now Claude Usage). The mapping is in
[Stream Deck+ Layout](streamdeck-layout.md).

### Encoder takeover wide canvas

Option, permission, and diff selection took over the encoders: E1 as a context
panel, E2-E4 merged into a 600px wide canvas. Retired when selection moved to
the keypad detail view; `option-renderer.ts` and `renderWideOptionList()` were
deleted. The `takeoverGeneration` race guard in `plugin.ts` survives and is
still needed for the remaining transitions.

### OpenClaw timeline panel

Entering an OpenClaw detail view merged E2+E3 into a 400px canvas rendering an
event timeline — fisheye type scaling, 60-second duplicate grouping, a push-to-
toggle detail mode. The plugin-side renderers (`timeline-store.ts`,
`timeline-renderer.ts`) were deleted; E2/E3 are usage gauges only.

Two rendering details went with it: `typeColor()` event-type colour coding
(green/blue/amber/red/cyan/purple) with a 2px activity-density bar, and the
Usage button's `oc-usage` page, which polled `openclaw status --usage --json`
every 60 seconds.

**Residue, and the reason this one matters:** the plugin used to be the *only*
writer of timeline persistence, so anyone without a Stream Deck had none at all.
Persistence now belongs to the daemon — see
[Plugin Conventions](plugin-conventions.md) for the current contract.

### QR code display

The Usage button had a `qr` page rendering a pairing QR as SVG paths, with
URL priority `--remote` → OpenClaw Gateway LAN address, and push-to-copy via
`pbcopy`. Retired with the mode-dial Usage button; `qr-renderer.ts` and the
`qrcode` dependency are gone. Pairing QR now comes from `agentdeck qr` and the
app.

### Button label intelligence

Three-tier label shortening: pixel-aware wrapping, then heuristic abbreviation,
then a `claude -p --model haiku` call — with `label-summarizer.ts` also able to
POST to a local MLX server. Deleted along with the keypad button renderer that
called it; every path had become unreachable. Key tiles are drawn by the shared
session-slot renderer, which handles its own shortening.

### Prompt-template cycling

An encoder rotated through labelled prompts from `config/prompt-templates.json`,
sending `send_prompt` with a `__template:<index>` payload. The encoder went with
the multi-mode dials.

**Residue:** the file and the bridge-side handler in `bridge/src/index.ts` both
still exist, but no shipped UI emits `__template:` — editing the file has no
visible effect. See [Configuration](configuration.md).

### Project picker

Launched terminals via `tell application "Terminal" to do script`. Removed
2026-07-19 — it had no caller and carried the riskiest AppleScript surface in
the plugin.

## Ulanzi D200H

### Direct-HID control

Two independent direct-HID drivers were built and removed: the Node
implementation on 2026-07-08, then the dormant Swift `D200hHidModule` — with its
stand-down arbitration, USB entitlement, and direct-device diagnostics — plus
the `zkswe/` protocol research tree on 2026-07-14.

The Ulanzi Studio plugin is the sole driver. **Residue:** both daemons derive
D200H connectivity from `ulanzi-plugin` WebSocket presence, which is why a
physically connected D200H reads as disconnected when the plugin is not running.

## Devices

### TRMNL commercial BYOS e-ink

The 7.5" e-ink panel was first driven as a commercial TRMNL device over its
BYOS HTTP pull protocol. That integration was removed (Node commit `c71044bd`)
in favour of custom AgentDeck firmware on the same hardware, which gave a push
WebSocket path like every other board. The device is now
[TRMNL 7.5"](esp32.md); only the panel is shared with its origin.

## macOS app

### Subprocess and external-CLI paths

`Process()`, `/bin/sh`, `osascript`, the `.command` script writer, and probes
for `security` / `sqlite3` / `adb` / `openclaw` / `whisper-cli` were removed
from the macOS source tree on 2026-04-19 for App Review 2.5.2.

**Residue:** the `AGENTDECK_APP_STORE` compile flag remains as a defense-in-depth
gate even though the macOS target is always the App Store build, and
`apple/scripts/verify-appstore-archive.sh` fails the build if any of those
strings reappear in the shipped binary. See
[App Store and CLI Product Tiers](appstore-feature-matrix.md).

### Launch Session UI

A "Launch Session" entry point in the menubar, the dashboard empty state, and
the app's Window scenes. Removed 2026-05-10 — App Store builds never spawn
terminals or child processes. Sessions now appear on their own once the user
starts an agent in their own workspace and the hooks report it.
`SessionLauncher.swift::showAppStoreLaunchInfo` remains as an NSAlert-only path
with no callers in shipped UI.

### Non-App-Store macOS GUI build

No longer maintained. macOS means the App Store build.

### `bound.serendipity.agentdeck.*` bundle tree

Retired: the former `.dashboard` app record carries an immovable App Store
Connect build floor at 1.0.6 / build 8. The shipping app uses
`bound.serendipity.agent.deck`. **Residue:** the Stream Deck *plugin* UUID
`bound.serendipity.agentdeck` is a separate, immutable identifier that looks
like the retired tree but is unrelated to it.

## Design

The hand-built HTML style guides (`docs/design/Design System.html`,
`Design Audit.html`, the Tide Bento exploration) and the React explorations in
`docs/design-mockups/` are frozen design provenance, not shipped surfaces. They
are indexed as reference cards in the design-system viewer's Asset library; see
[Design Resource Map](../design/RESOURCES.md).
