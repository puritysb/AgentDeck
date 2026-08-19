---
id: design.foundation
title: AgentDeck Design System
description: Visual principles, tokens, components, assets, motion, and copy rules.
category: Design
locale: en
canonical: true
status: stable
owner: Design system maintainers
reviewed: 2026-08-20
revision: 2026-08-20
source_of_truth: DESIGN.md
validators: [python3 design/verify-tokens-sync.py, bash design/lint.sh]
---

# AgentDeck — Design System

> A glanceable command surface for AI coding agents.
> The aesthetic is **"aquarium tide"**: warm sand on deep ink, with kelp greens for the calm signal and coral for the developer's edge.

This document is the source of truth for the AgentDeck visual language. All landing page options, the menubar popup, the iPad/desktop dashboards, the e‑ink screens, and the CLI/print materials should derive from the tokens and patterns described here.

---

## 1. Design principles

### 1.1 Calm by default, urgent on demand
The agent is doing work in the background; the UI should not act like it's the main attraction. Idle states are quiet — warm sand, deep ink, no movement. The amber pulse only appears when an agent is actually waiting on you. Resist adding decoration that competes with the signal.

### 1.2 Two tiers, one surface
AgentDeck serves two audiences: **App Store users** (paid, polished, plug‑and‑play) and **developers** (open‑source, npx, hardware‑hackable). Visually we distinguish them with **kelp / ink** for App Store and **coral / cream** for developer, but they share the same underlying type, spacing, and grid. They are siblings, not estranged cousins.

### 1.3 Hardware respect
The product runs on real, physical surfaces — a 1.91" round AMOLED, a 280×240 e‑ink panel, a Lenovo Tab, a TC001 LED matrix. Treat each one as a constraint to celebrate, not work around. Build for the panel's actual pixel grid; don't pretend it's a generic web canvas.

### 1.4 Type as instrument
Two faces only: **IBM Plex Sans** for everything human, **JetBrains Mono** for everything the machine emits. Mono is also the kicker, the tier badge, the timestamp, the command. Do not introduce a third face.

### 1.5 Asia‑first multilingual
KO/EN/JA all live on the same page; the type stack must render all three at the same optical weight. We use IBM Plex Sans / Plex Sans KR / Plex Sans JP as a unified family. Never set Korean in a Latin‑only face.

### 1.6 Honest placeholders
When an asset (a real screenshot, a hardware shot, an icon) is not ready, ship a **placeholder pattern** — diagonal hatch on warm sand, monospace label inside — rather than a stretched stock photo or a hand‑drawn SVG that pretends to be the real thing.

---

## 2. Color system

All colors are warm‑sided. Whites lean toward sand (`#f5f3ec`), blacks lean toward deep aquarium green (`#0e1f1f`). Pure `#fff` and `#000` are forbidden.

### 2.1 Tide (sand / paper)

| Token       | Hex       | Use                                         |
|-------------|-----------|---------------------------------------------|
| `--tide-50` | `#f5f3ec` | App background, light surfaces              |
| `--tide-100`| `#ebe6d6` | Muted card, hairline section background     |
| `--tide-200`| `#d8cfb6` | Disabled / placeholder fill                 |
| `--tide-300`| `#a8b09a` | Tide on dark inversions                     |

### 2.2 Ink (deep aquarium)

| Token       | Hex       | Use                                         |
|-------------|-----------|---------------------------------------------|
| `--ink-900` | `#0e1f1f` | Primary text, dark hero, primary button     |
| `--ink-800` | `#15302f` | Dark surface variant                        |
| `--ink-700` | `#1f4544` | Body copy on light, secondary text          |
| `--ink-500` | `#426664` | Tertiary text, captions                     |
| `--ink-300` | `#7c9694` | Muted text on dark, dividers                |

### 2.3 Kelp (App Store / running / OK)

| Token         | Hex       | Use                                       |
|---------------|-----------|-------------------------------------------|
| `--kelp-700`  | `#1f6157` | Kicker label, link hover                  |
| `--kelp-500`  | `#2f8a7c` | "Processing" status, App Store badge fill |
| `--kelp-300`  | `#6fb6a8` | Kelp on dark, accent on ink-900           |

### 2.4 Coral (Developer / build / warning‑warm)

| Token          | Hex       | Use                                       |
|----------------|-----------|-------------------------------------------|
| `--coral-500`  | `#c0573a` | Developer tier badge, dev card border     |
| `--coral-700`  | `#8c3a23` | Developer kicker, link on cream           |

### 2.5 Amber (attention only)

| Token          | Hex       | Use                                       |
|----------------|-----------|-------------------------------------------|
| `--amber-500`  | `#c8923a` | "Awaiting" / needs‑attention states       |

> Amber is the **only** color that is allowed to animate (pulse). If you find yourself animating kelp or coral, stop — they are static signals.

### 2.6 Two surfaces, two palettes (deliberate)

The tokens above are the **marketing / editorial** surface — landing pages, docs, print, the Design System guide. They are warm, calm, high‑touch.

Inside the product itself — menubar popup, e‑ink panels, terminal/CLI surface, hardware screens — we run a **brighter signal palette** so status reads at a glance from 16px on a glossy macOS chrome:

| Role            | Marketing token   | Product UI hex  | Why it changes               |
|-----------------|-------------------|-----------------|------------------------------|
| OK / running    | `--kelp-500` `#2f8a7c` | `#52D988`  | Saturated to read at 6px dot |
| Awaiting        | `--amber-500` `#c8923a` | `#FFA93D` | Hotter for menubar pulse     |
| Error           | `--coral-500` `#c0573a` | `#FF6B6B` | Brighter on near‑black       |
| Hub / link      | `--kelp-700` `#1f6157`  | `#3ED6E8` | Electric cyan = product chrome |
| Idle text       | `--ink-300` `#7c9694`   | `#7a8a9c` / `#9a9aa2` | Cooler grey on neutral OS chrome |
| Dark surface    | `--ink-900` `#0e1f1f`   | `#0a1a2a` (popup) / `#0c0d10` (terminal) | Native macOS / TTY feel |
| Light surface   | `--tide-50` `#f5f3ec`   | `#f6f3ee` (popup-light) | Closer to macOS Big Sur cream |

Rule: **product UI may borrow marketing tokens, but marketing surfaces must never use product brights.** A press shot or hero illustration that mixes `#FFA93D` against `#f5f3ec` will look like a different brand.

The product brights are exposed in `design/tokens.css` under the `--ui-*` namespace (e.g. `--ui-ok`, `--ui-attn`, `--ui-cyan`, `--ui-popup-bg`). Use those — never inline the hex.

### 2.7 Status semantics

| State        | Color    | Animation        | Meaning                          |
|--------------|----------|------------------|----------------------------------|
| `idle`       | ink‑300  | none             | Session exists, nothing happening |
| `processing` | kelp‑500 | none (steady)    | Agent is actively working        |
| `awaiting`   | amber‑500 | pulse 1.1s       | Agent needs YES/NO from you      |
| `error`      | coral‑500 | none             | Failed run, attention required   |

---

## 3. Typography

### 3.1 Type stack

```css
/* Sans — everything human */
font-family: "IBM Plex Sans", "IBM Plex Sans KR", "IBM Plex Sans JP",
             -apple-system, BlinkMacSystemFont, system-ui, sans-serif;

/* Mono — everything machine, all kickers, tier badges, timestamps */
font-family: "JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace;
```

### 3.2 Scale (display → caption)

| Role          | Size                | Weight | Tracking | Notes                                |
|---------------|---------------------|--------|----------|--------------------------------------|
| Hero display  | `clamp(54px,7vw,96px)` | 600 | -0.035em | Tight, italic accent for one phrase  |
| Editorial     | `clamp(56px,8vw,112px)` | 600 | -0.04em | Full‑bleed hero variant              |
| H2            | 44px / 1.08         | 600    | -0.02em  | Section heads                        |
| H3 (col / ed) | 26–32px / 1.15      | 600    | -0.02em  | Comparison cols, editorial rows      |
| Pillar / card | 19px                | 600    | -0.01em  | Mid‑density card titles              |
| Body          | 17px / 1.6          | 400    | normal   | Paragraph copy                       |
| Lede          | 18–19px             | 400    | normal   | Section intro paragraph              |
| Small / list  | 14.5px / 1.55       | 400    | normal   | Card body, list rows                 |
| Caption       | 13px                | 400    | normal   | Footnotes, dividers                  |
| **Kicker**    | 12px                | 600    | 0.18em UPPER | **Mono.** Section header tag.   |
| **Mono badge**| 11–12px             | 700    | 0.16em UPPER | **Mono.** Tier badges, command.|

### 3.3 Rules
- Use `font-feature-settings: "ss01", "cv11"` on sans body — Plex's stylistic alternates make Korean and Latin sit at consistent x‑height.
- Use `font-feature-settings: "zero", "ss01"` on mono — slashed zero, single‑story `a`.
- Italics: only on the **one** phrase of the hero that you want emphasized (in `--kelp-700`).
- Never letter‑space sans body. Always letter‑space mono kickers and tier badges.

---

## 4. Spacing & layout

### 4.1 Spacing scale (4px base)

`4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 56 · 64 · 80 · 96 · 120`

Section vertical padding is **96px** desktop, **64px** mobile. Container max‑width is **1240px** with **32px** gutters (20px on small).

### 4.2 Grid
- Hero: `1.05fr 1fr`, 48px gap
- Compare cols: `1fr 1fr`, 24px gap
- Pillars: `repeat(3, 1fr)` with 1px hairline gap (the gap IS the divider)
- Devices: `repeat(7, 1fr)`, 8px gap (collapses to 4/2 cols)

### 4.3 Radii

| Token | Value | Use                          |
|-------|-------|------------------------------|
| sm    | 4px   | Mono badges, tags            |
| md    | 8px   | Brand mark, small chips      |
| lg    | 10px  | Buttons, dev tiles           |
| xl    | 12px  | Buttons primary, dev cards   |
| 2xl   | 14px  | Pillar grid, dev callout     |
| 3xl   | 16–18px | Cards, splash images, cols |
| pill  | 999px | Lang switch, hero kicker chip |

### 4.4 Shadows

```css
--shadow-card:    0 6px 20px -8px rgba(14, 31, 31, 0.45);
--shadow-card-h:  0 10px 28px -8px rgba(14, 31, 31, 0.55);
--shadow-frame:   0 30px 80px -30px rgba(14, 31, 31, 0.4),
                  0 8px  30px -10px rgba(14, 31, 31, 0.18);
--shadow-canvas:  0 30px 80px -20px rgba(0, 0, 0, 0.6);
```

Shadows tilt warm and soft. Avoid pure neutral grey shadows; they look manufactured against the sand backgrounds.

---

## 5. Components

### 5.1 Buttons
- **Primary**: `--ink-900` fill, `--tide-50` text, 12px radius, 13×22 padding, +1px lift on hover.
- **Ghost**: transparent fill, 1px ink border, inverts on hover.
- Primary buttons may carry a small `--kelp-500` **badge** (e.g. `App Store`) — mono, uppercased, 10.5px.

### 5.2 Tier badges
Mono, 11.5px, 0.16em tracking, uppercase, 4×10 padding, 5px radius.
- App Store: `--ink-900` fill on `--tide-50`, OR `--kelp-500` fill on `--ink-900`.
- Developer: `--coral-500` fill, `--tide-50` text. Always solid, never outlined.

### 5.3 Kicker
Mono, 12px, 0.18em tracking, uppercase, `--kelp-700` (or `--coral-700` in dev sections, `--kelp-300` on dark). Sits 14px above the H2.

### 5.4 Hero kicker chip
Pill, `--tide-100` fill, mono 12.5px, 0.08em tracking, with a leading kelp dot (8px, with 4px ring at 18% opacity).

### 5.5 Pillar grid
3 cards, 1px hairline gap on a `--ink-900 @ 10%` background — the gap is the divider. Each pillar: 32×28×36 padding, mono tag at top, H3, body, 220px min-height.

### 5.6 Compare columns (Option B)
Two cards stacked at 18px radius, 36×32 padding. Left card: `--ink-900` fill. Right card: `--tide-100` fill. Each opens with a tier badge, then H3, then a hairline‑separated checklist, then a CTA pinned to the bottom.

### 5.7 Dev callout
On `--tide-50`, 14px radius, 24×28 padding. Two columns: command + GitHub button. Command in mono on `--ink-900` with leading `$` in `--kelp-300`.

### 5.8 Device tile
`--tide-100` background, hairline border, 10px radius, 16×14 padding, 96px min-height. Mono tier badge top‑left (DEV / APP STORE), device name pinned bottom in 13px sans 500.

### 5.9 Status dot
6×6 circle, color from §2.6, 2px ring at the same color × 33% alpha. Awaiting state animates at 1.1s ease‑in‑out.

### 5.10 Placeholder
```css
background:
  linear-gradient(135deg,
    transparent 25%,
    rgba(14,31,31,0.04) 25%,
    rgba(14,31,31,0.04) 50%,
    transparent 50%,
    transparent 75%,
    rgba(14,31,31,0.04) 75%) 0 0 / 12px 12px,
  var(--tide-100);
```
Mono caption inside: 12px, `--ink-500`, 0.04em tracked, e.g. `// menubar popup — sessions list`.

---

## 6. Iconography

### 6.1 Brand marks
**Product mark** — the AgentDeck aquarium icon (`design/brand/agentdeck-icon.png`). A full-color illustration of an aquarium dome over a keyboard base. Used at 1024² for the App Store, 512/256/128 in the Dock and bundle, and as the splash on every hardware surface during pairing. **The aquarium icon IS the logo** — we do not have an abstract wordmark; the icon stands alone.

**Small-size product symbol** — when the full illustration would collapse below roughly 32pt, use the simplified aquarium-deck symbol implemented as `AgentDeckLogo`: dome outline + waterline + keyboard base/buttons. It must preserve the app icon silhouette and must not revert to abstract card-stack, router, hub, or generic deck metaphors. In product UI it is monochrome and inherits the local product chrome color (`DesignTokens.UI.cyan`, label color, or the surface accent).

**Agent marks** — the real upstream brand SVGs of each tool, kept verbatim:
- `claudecode.svg` — Claude Code robot · `#C07058`
- `codex.svg` — OpenAI Codex · `#6166E0`
- `openclaw.svg` — OpenClaw · `#FF4D4D`
- `opencode.svg` — OpenCode · `#3a3a3a`
- `antigravity.svg` — Antigravity · `#5F6368`, rainbow on color, monochrome on e-ink
- `kiro.svg` — Kiro CLI / Kiro IDE · `#7C3AED`. One mark for both ids: they are the same agent seen through two front ends

All six come from one upstream package and stand or fall together — the provenance, the npm integrity hash, and the trademark holder per mark are recorded once in [design/RESOURCES.md § Third-party brand provenance](design/RESOURCES.md#third-party-brand-provenance). Do not attribute one mark here and leave the rest silent: a lopsided record reads as though the named one is the mark with a licensing question.

The six SVGs live **only** in `design/brand/`, which is the canonical source. Runtime path constants and firmware bitmaps are generated or contract-tested mirrors; they are not alternate design sources. Full-vector surfaces preserve the exact path geometry. Pixel-constrained displays may use reviewed raster or hand-tuned reductions that preserve the identifying silhouette and cutouts. Do not substitute provider-company marks (for example the generic OpenAI or Anthropic logo), redraw the vector on capable surfaces, or add a second logo dump elsewhere.

> The earlier abstract logo explorations in `explore/logos.jsx` (Stacked Deck, Hub & Spokes, etc.) are kept for reference only and are not used in production.

### 6.2 Menubar icon
The menu bar uses the small-size aquarium-deck symbol, not the full app icon illustration and not an abstract stacked-card mark. It renders as a native monochrome glyph by default, with a 6px status badge using the product UI status palette from §2.6. The only allowed animation is the awaiting amber pulse. The compact "minimal" preference may show the status dot alone; it must use the same semantic colors.

### 6.3 UI icons
22px stroke icons, 1.6px stroke, square caps. Drawn from a 24px viewbox. Build new icons in this system; never grab from a generic icon font.

### 6.4 Creature marks
Each agent (Claude Code, Codex, OpenClaw, OpenCode, Antigravity) has a creature avatar derived from its canonical mark. Motion and state effects may surround or transform the mark, but must not replace its identifying geometry.

---

## 7. Hardware surfaces

Each panel has its own pixel grid, dynamic range, and refresh rate. Designs MUST respect them.

| Surface              | Resolution   | Constraints                         | Aesthetic                          |
|----------------------|--------------|-------------------------------------|------------------------------------|
| macOS menubar        | 22pt height  | 1px alignment, monochrome glyph     | Native, calm, identical to Apple   |
| macOS popup          | 360×520      | Vibrant blur, dark mode default     | Aquarium-deep, kelp accents        |
| iPad full UI         | 2160×1620    | Touch, 44pt min targets             | Sand background, full color        |
| Lenovo Tab dashboard | 1920×1200    | Always-on, slight burn-in risk      | Dark ink ground, calm motion       |
| E-ink (D200H)        | 280×240      | 1-bit, slow refresh                 | High-contrast, hatch fills, mono   |
| Pixoo64 LED          | 64×64        | LAN HTTP, fragile GIF buffer        | Terrarium + tiny device-side loop  |
| iDotMatrix LED       | 32×32        | BLE, diffuser, constrained detail   | Native compact terrarium           |
| Timebox Mini LED     | 11×11        | 121 LEDs, 4-bit packed color        | Official mark + perimeter status rail |
| TC001 LED            | 32×8         | RGB matrix, blocky                  | Multi-mark status strip            |
| ESP32 round AMOLED   | 466×466      | Round mask, low brightness          | Single creature centered           |

Dot-matrix marks are generated from `design/brand/*.svg`; device code may tune color and surrounding motion, not invent replacement geometry. At 11×11, Timebox uses the dedicated Agent Beacon grammar: the 9×9 identity mark is stable and all motion lives on the one-pixel perimeter. At 32×32, iDotMatrix composes natively instead of reducing a completed 64×64 scene. Pixoo64 keeps HTTP load low by preloading a short loop for device-side playback.

---

## 8. Motion

- **Default ease**: `ease` (CSS native) for sub‑200ms; `cubic-bezier(0.2, 0.6, 0.2, 1)` for 200–500ms transitions.
- **Hover lift**: `transform: translateY(-1px)` over 120ms.
- **Pulse** (`mbPulse`): 1.1s ease‑in‑out infinite — opacity 1→0.55, scale 1→0.85.
- **Wiggle** (`mbWiggle`): 0.7s ease‑in‑out infinite, ±8° rotation, only on the creature when its session is awaiting.
- Page transitions, parallax, scroll‑hijacking: **disallowed**.

---

## 9. Voice & copy

- **Tone**: confident, slightly dry, no exclamation points. Speak like a senior dev who respects your time.
- **Tier labels**: `App Store` (always two words, capitalized) / `Developer` (capitalized) / `CLI` for the install path.
- **CTAs**: imperative, ≤4 words. "Get on App Store", "Run npx setup", "View on GitHub".
- **Korean**: 격식체 안 씁니다 — relaxed but precise. `~합니다` only for legal/footer. `~해요` and noun phrases everywhere else.
- **Japanese**: です/ます 体, but trim particles for kickers.
- **Numbers**: tabular nums in mono runs; never zero‑pad in display copy ("3 sessions", not "03").
- **Connection-state lexicon**: daemon-link status copy is fixed per device class — SSOT + full table in [`shared/src/connection-status.ts`](shared/src/connection-status.ts). Self-connecting clients (Apple/Android apps, ESP32, TUI) name the phase they are actually in: `Searching for AgentDeck...` (compact `Searching...`) / `Connecting...` / `Reconnecting...` / `No WiFi`; retry button `Search Again`. Daemon-rendered passive displays (Stream Deck, D200H, Pixoo, Timebox, iDotMatrix, InkDeck) show only the terminal `OFFLINE` (+ `Open AgentDeck` CTA) — they never claim Connecting/Reconnecting they can't perform. Swift/Kotlin mirrors (`ConnectionLexicon`) must be updated with the TS SSOT in the same commit.

---

## 10. Don'ts

- ❌ Pure `#000` or `#fff`.
- ❌ A third typeface.
- ❌ Drop shadows on text.
- ❌ Gradients as backgrounds. (Radial glow under the hero visual is the lone exception.)
- ❌ Emoji in product UI.
- ❌ Animating kelp or coral. Only amber pulses.
- ❌ Hand-drawn SVG illustrations of hardware. Always use real photography or the placeholder pattern.
- ❌ Centering long-form copy. The lede is left-aligned, max 60ch.
- ❌ Borders on photos. Photos sit in a 16–18px radius frame with a 1px ink-at-10% rule, and that's it.

---

## 11. File map

```
DESIGN.md                                ← this file (spec)
design/
  tokens.css                             ← SSOT: all CSS custom properties
  tokens.js                              ← browser mirror of tokens.css (window.DT)
  components.css                         ← component rules (buttons, badges, kickers, …)
  patterns.css                           ← placeholder, hatch, divider patterns
  icons.jsx                              ← extended icon set
  brand/                                 ← AgentDeck app icon + 5 canonical agent SVGs
  lint.sh                                ← R1–R8 design rule checker
docs/design/
  Design System.html                     ← visual style guide
  Design Audit.html                      ← coverage matrix + parity grid
  data.js, creatures.jsx                 ← demo data for Design System.html
docs/design-mockups/
  Menubar Popup.html, E-ink *.html, …    ← interactive React prototypes
shared/src/design-tokens.ts              ← TS binding (mirror of tokens.css)
apple/AgentDeck/UI/Common/DesignTokens.swift   ← Swift binding
android/app/.../ui/theme/DesignTokens.kt       ← Compose binding
```

`design/tokens.css` is the **single source of truth.** Every other token file
(`tokens.js`, `design-tokens.ts`, `DesignTokens.swift`, `DesignTokens.kt`, plus
the embedded copies in the APME dashboard HTML, the Stream Deck PI
`design-tokens.css`, and the Build Health generator `scripts/generate-html-report.py`)
is a mirror — when CSS values change, all seven mirrors must be updated in the same
commit. Verify with `python3 design/verify-tokens-sync.py`; its footer prints the
count it actually checked, which is the number to trust over this sentence.

When adding a new component:
1. Define its tokens in `design/tokens.css` if you need new ones (rare).
2. Sync the new values into `tokens.js` + `design-tokens.ts` + `DesignTokens.swift` + `DesignTokens.kt` (and the embedded mirrors — `verify-tokens-sync.py` will catch misses).
3. Write the rule in `design/components.css`.
4. Add a specimen to the design-system viewer's Component lab (`agentdeck-design-system/viewer/`) so it renders on `/design-system/` for review. (`docs/design/Design System.html` is the legacy surface — do not extend it.)
5. Update this doc if it changes a principle.
