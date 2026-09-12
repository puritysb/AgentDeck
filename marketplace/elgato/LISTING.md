# AgentDeck — Elgato Marketplace listing

> **Live since 2026-07-28.** The product page is at
> <https://marketplace.elgato.com/product/agentdeck-dce3806b-176e-40f2-be7d-e029bec0f464>,
> and the current published version is `1.2` (2026-09-02T21:39Z, measured from
> the product page's own payload), after `1.0.6`
> (2026-08-18), `1.0.5` (2026-08-10), `1.0.4` (2026-08-05), `1.0.3` (2026-07-31)
> and `1.0.2` (2026-07-28).
> This file stays the source of the listing copy and asset inventory for future revisions.

## 1.3.0 submission (2026-09-12, pending review)

Submitted the official artifact from GitHub Actions run `34679062629`.
Maker Console verified version `1.3.0.0`, SDK 3, DRM enabled, macOS 26+ and
Windows 10+, then displayed `Pending review · 1.3`. Automatically publish after
approval is **off**. The description below was saved in General before
submitting this version.

**Owner follow-up on 2026-09-12:** publication after approval is authorized
without waiting for a separate DRM encoder check. This overrides the earlier
pre-publication gate for this release. Opening the `1.3` version cell exposes
Edit version; `Download version` is now available there. The automatic-publish
switch can be toggled locally, but `Submit for review` remains disabled, there
is no Save/Update action, and reopening the dialog resets the switch to off.
The setting change therefore did **not** persist. Keep the submitted review;
once approval exposes `Release`, publication is authorized without another
permission prompt. Do not describe this as automatic publication being enabled.
See [delivery tracking](https://github.com/puritysb/AgentDeck/issues/314).

```
AgentDeck 1.3.0 improves session and agent identity across the dashboard, adds OpenClaw plugin approval requests alongside tool approvals, and makes collaboration and connection recovery more consistent. Usage windows now reflect only the quota data actually reported by each provider. Bundled profiles cover Stream Deck, Mini, XL, +, and + XL. Requires the free AgentDeck daemon on the same computer.
```

## 1.2.0 submission (2026-09-02, uploaded · approved 2026-09-02T09:31Z · **published 2026-09-03**)

Released from Maker Console → Versions → `Release` on 2026-09-03 KST; the row reads *Published* and the product-page payload stamps `publish_date: 2026-09-02T21:39:41Z`. The DRM encoder loop below was skipped for this release on the owner's call.

Manifest version `1.2.0.0`, artifact `bound.serendipity.agentdeck.streamDeckPlugin`
from the `streamdeck-v1.2.0` GitHub Release (same bytes as `pnpm package`).
Upload with "publish after review" unselected and verify the DRM-processed
build's four encoders through the review loop before going live
(docs/streamdeck-layout.md). Version-notes copy for the console:

```
1.2.0 — Codex usage dial follows the windows the account actually exposes: Plus shows 5h and 7d, Pro shows 7d alone, and a lone window fills the vacant half with the subscription name instead of a dim placeholder. Approval keys now summarize the question so the object of a shell command survives truncation, and show the reason approval was demanded.
```

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

`1.0.4.0` (product version `1.0.4`) — **published 2026-08-05**. It adds
Stream Deck XL and Stream Deck + XL as their own device models, brings the
Windows host controls to parity with macOS, and adapts the Codex usage encoder
to a single live rate-limit window. It follows `1.0.3` (published 2026-07-31),
which corrected Windows compatibility after the 1.0.2 manifest (public since
2026-07-28) incorrectly restricted installation to macOS. Stream Deck requires
the 4-part form; `scripts/verify-version-sync.mjs` pins it to
`<plugin package version>.0`. Marketplace versions are monotonic once
published, so the next submission must carry a version above 1.0.4.

## Platform

**macOS 26.0+ and Windows 10+.** Session keys and usage dials are
platform-neutral. Volume and Launcher now use host-specific implementations:
`osascript` / `open` on macOS, and built-in Windows PowerShell media keys plus
Start Apps/browser launch on Windows. AgentDeck's tested CLI/bridge baseline is
Windows 11.

## Description

```
AgentDeck turns Stream Deck and Stream Deck + into a live control surface for AI coding agents.

Session keys show Claude Code, Codex, OpenCode, OpenClaw, Kiro, and Antigravity activity: who is working, who needs your attention, and the latest tool or prompt. Select a session, answer supported approval requests, change its mode, or stop it.

Usage dials follow the windows Claude and Codex actually report, with reset countdowns. The other dials control system volume and launch your agent apps. Session keys and usage work on macOS and Windows; browser-tab focusing is available on macOS.

Profiles for Stream Deck, Stream Deck Mini, Stream Deck XL, Stream Deck +, and Stream Deck + XL are bundled and install automatically. The + XL uses four assigned dials; its two extra dials remain unassigned.

Getting set up
AgentDeck is a thin client and needs the free AgentDeck daemon on the same computer. On macOS, use the free AgentDeck app from the Mac App Store. On macOS or Windows, you can instead run:

npx @agentdeck/setup

Enable the integrations you use, then launch your coding agents normally. Some observed sessions provide monitoring only; controls appear when the integration supports them.

The plugin bundles no daemon and collects no analytics.

AgentDeck is independent and is not affiliated with or endorsed by Elgato, Anthropic, OpenAI, or other third parties mentioned. All trademarks belong to their owners.
```

## Release notes

As submitted and published for `1.0.4`:

```
Stream Deck XL and Stream Deck + XL are now first-class: both are recognized as their own device models, and the bundled profiles install for them the way they already did for Stream Deck, Mini, and Stream Deck +.

Windows now reaches parity with macOS for the host controls: the volume encoder uses the system media keys, and the launcher opens Start-menu apps with a browser fallback.

The Codex usage encoder adapts when only one rate-limit window is live: the remaining window keeps a proper slot with its own countdown instead of a dead placeholder.

Fixed: a session's detail view could show the model name belonging to the previously focused session, and the hold-to-talk VOICE key now completes the round trip to the host microphone.
```

The `1.0.3` notes, for reference:

```
Restores Windows Marketplace support, including Windows volume/mute controls and Launcher app/URL handling. macOS behavior is unchanged.
```

## Links

- Product: https://puritysb.github.io/AgentDeck/
- Support: https://github.com/puritysb/AgentDeck/issues
- Privacy: https://puritysb.github.io/AgentDeck/#privacy

## Submission files (XL + Windows parity revision — 2026-08-05)

- Plugin: `dist/bound.serendipity.agentdeck.streamDeckPlugin` (v1.0.4.0, macOS + Windows)
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
