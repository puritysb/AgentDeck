# AgentDeck — Elgato Marketplace listing

> **Published 2026-07-28.** Version `1.0.2` was approved and is live at
> <https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464>.
> This file stays the source of the listing copy and asset inventory for future revisions.

Submission target: **https://maker.elgato.com** (Maker Console → Publish).

> Maker Console Draft description synced to this file on 2026-07-21 (the "Getting
> set up" copy now leads with the live Mac App Store app). The submitted
> "Pending review" version is a separate snapshot and was left untouched.

## Store asset requirements

Per [Product Guidelines](https://docs.elgato.com/guidelines/products/), checked
against our files on 2026-07-20.

| Slot | Spec | Our file | ✓ |
|---|---|---|---|
| App icon | 288×288 PNG | `marketplace/elgato/1.0.2/app-icon-288.png` | 288×288 |
| Thumbnail | 1920×960 PNG | `marketplace/elgato/1.0.2/thumbnail-1920x960.png` | 1920×960 |
| Gallery | 1920×960 PNG, **min 3**, max 10 | `gallery-01-overview.png` · `gallery-02-session-keys.png` · `gallery-03-dials.png` (real hardware) | 3 × 1920×960 |
| Gallery video (optional) | 1920×1080 MP4, <250 MB | `agentdeck-elgato-review-demo.mp4` (or `apple/.../agentdeck-preview.mp4`) | 1920×1080, 33s, 5.2 MB |
| Product name | ≤30 chars | `AgentDeck` | 9 |
| Description | 250–1,500 per guidelines; console field allows 4000 | below | see check |

Plugin package: `dist/bound.serendipity.agentdeck.streamDeckPlugin` — rebuild with
`pnpm package`, which runs Elgato's `streamdeck validate` before packing.

## Version

`1.0.2.0` (product version `1.0.2`) — Stream Deck requires the 4-part form;
`scripts/verify-version-sync.mjs` pins it to `<VERSION>.0`. `1.0.2.0` is the
**published** build (approved 2026-07-28). Same-version resubmission was only
available while the plugin sat in pre-publication review; from here the
Marketplace's monotonic-version rule applies, so the next revision must carry a
higher version.

## Platform

**macOS 26.0+ only.** The Windows entry was dropped for 1.0.0 (`f20af561`):
the Volume and Launcher dials are `osascript` / `open -a`, so a Windows build
would have shipped two dead dials. The Node.js bridge itself does run on
Windows — this is a plugin-surface decision, not a bridge limitation.

## Description

```
AgentDeck turns Stream Deck and Stream Deck + into a live control surface for AI coding agents.

Session keys show Claude Code, Codex, OpenCode, and OpenClaw sessions at a glance — which one is running, which one is waiting on you, what tool it just called. Press a key to focus a session, pick a prompt option, toggle its mode, or stop it. Dials cover Claude and Codex usage with reset countdowns, system volume, and a launcher for your agent apps.

Profiles for Stream Deck, Stream Deck Mini, and Stream Deck + are bundled and install automatically.

Getting set up
AgentDeck is a thin client — it needs the free AgentDeck daemon running on the same Mac. Get it either from the free AgentDeck app on the Mac App Store (no terminal needed), or from a terminal:

    npx @agentdeck/setup

Either way, start Claude Code, Codex, or OpenCode as you normally would and your sessions appear on the keys.

The plugin does not embed a daemon, collect analytics, or modify your shell configuration.

AgentDeck is an independent project and is not affiliated with or endorsed by Elgato, Anthropic, OpenAI, or any other third party mentioned. All trademarks belong to their owners.
```

## Release notes

```
First public release.

• Session keys for Claude Code, Codex, OpenCode, and OpenClaw with distinct running / waiting states
• Prompt steering, mode toggle, and stop from the key
• Stream Deck + dials: Claude usage, Codex usage, volume, launcher
• Bundled profiles for Stream Deck, Stream Deck Mini, and Stream Deck +
• Automatic reconnect with an explicit OFFLINE state when no daemon is running
```

## Links

- Product: https://puritysb.github.io/AgentDeck/
- Support: https://github.com/puritysb/AgentDeck/issues
- Privacy: https://puritysb.github.io/AgentDeck/#privacy

## Submission files (revision — 2026-07-25)

- Plugin: `dist/bound.serendipity.agentdeck.streamDeckPlugin` (v1.0.2.0, white category icon)
- App icon: `marketplace/elgato/1.0.2/app-icon-288.png`
- Thumbnail: `marketplace/elgato/1.0.2/thumbnail-1920x960.png`
- Gallery: the three `marketplace/elgato/1.0.2/gallery-*.png` files
- Demo video for `maker@elgato.com`: `agentdeck-elgato-review-demo.mp4` (1920×1080, 33 s, 5.2 MB) — kept out of the repo; source in the editing folder
- Optional gallery video slot: same demo, or `apple/appstore-submission/previews/macOS/agentdeck-preview.mp4`

## Review response (2026-07-25)

Elgato's first review asked for three things. This revision addresses them:

1. **White in-app icons.** The category icon was resized from the full-colour
   brand PNG, so it showed the colour aquarium mark. It is now generated as the
   white AgentDeck mark, matching the (already white) action icons —
   `scripts/generate-icons.mjs`, commit `480a00b3`. The plugin/Marketplace icon
   stays full colour.
2. **Product-page media.** The gallery is rebuilt from real Stream Deck hardware
   shots (below) instead of the earlier renders/raw photo.
3. **Demo video.** A 33-second demo is emailed to `maker@elgato.com` so the
   reviewer can verify functionality before re-review.

## Gallery sources (2026-07-25 revision)

The gallery leads with a brand overview slide, then real Stream Deck hardware
running the plugin, on the aquarium-tide canvas. Sources are the edited captures
re-encoded losslessly (compressionLevel 9) into `marketplace/elgato/1.0.2/`:

| File | Content |
|---|---|
| `gallery-01-overview.png` | Brand title slide — "AgentDeck · Live control for AI coding agents" (same art as the thumbnail) |
| `gallery-02-session-keys.png` | Real Stream Deck 15-key running session keys — "Sessions at a glance" |
| `gallery-03-dials.png` | Real Stream Deck + keys, touch strip, and dials — "Four dials, four jobs" |

**Do not reuse `docs/media/hardware-d200h-tc001-closeup.png` for Stream Deck
imagery.** Its touch strip reads VOL / PROMPT / USAGE / VOICE, and the Voice and
Prompt dials were removed in `f20af561` — it advertises features that no longer
ship. The same applies to any capture predating that commit.
