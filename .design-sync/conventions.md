# AgentDeck — aquarium-tide design system

AgentDeck is a **CSS-class + design-token** system (not a prop-styled component
library). You style with utility/component classes prefixed `ad-` and with CSS
custom-property tokens (`var(--…)`). The bundle ships a set of line icons as real
React components; everything else is classes + tokens. **Read `styles.css` and its
import (`_ds_bundle.css`) before styling — they contain every class and token.**

## Wrapping (do this first)

Wrap each screen/region in **`.ad-body`** — the root that applies the system's
background (`--tide-50` sand), text color (`--ink-900` deep aquarium green), font
(`--font-sans`), and font features. Without it you get browser-default styling and
the design reads off-brand. Use **`.ad-container`** for centered max-width page
gutters, and **`.ad-mono`** anywhere you want the JetBrains Mono face.

## Component classes (`ad-*`)

| Family | Classes |
|---|---|
| Type | `.ad-h1` (hero; `<em>` inside goes kelp italic), `.ad-h2`, `.ad-lede` (intro paragraph), `.ad-kicker` + `--coral` / `--kelp-light` (mono uppercase eyebrow) |
| Buttons | `.ad-btn` base, then one of `--primary` (ink), `--ghost` (outline), `--coral` (developer/build). Inline `.ad-btn-badge` for a mono badge inside a button |
| Tier badges | `.ad-tier` + `--store` / `--store-on-dark` / `--dev` / `--cli` — labels for App Store vs Developer vs CLI tiers |
| Status dot | `.ad-dot` + `--idle` / `--processing` / `--awaiting` / `--error`. **Only `--awaiting` animates** (amber pulse). Pair with `.ad-status` for a mono status row |
| Cards | `.ad-card`, `.ad-card--ink` (on dark), `.ad-card--dev` (coral left rule) |
| Notice | `.ad-notice` + `--ok` / `--awaiting` / `--error` (tinted inline toast) |
| Chip / code | `.ad-chip` (pill with kelp dot), `.ad-code` (mono `$`-prefixed command block) |
| Misc | `.ad-lang` (segmented toggle), `.ad-device` (device tile) |

## Tokens (`var(--…)`)

- **Surfaces / sand**: `--tide-50` `--tide-100` `--tide-200` `--tide-300`
- **Ink (text / dark surfaces)**: `--ink-900` `--ink-800` `--ink-700` `--ink-500` `--ink-300`
- **Kelp (running / OK / App Store)**: `--kelp-700` `--kelp-500` `--kelp-300`
- **Coral (developer / build)**: `--coral-500` `--coral-700`
- **Amber (attention only)**: `--amber-500`
- **Semantic status**: `--status-idle` `--status-processing` `--status-awaiting` `--status-error`
- **Type**: `--font-sans` (IBM Plex Sans), `--font-mono` (JetBrains Mono); scale `--t-hero … --t-kicker`; tracking `--tr-*`
- **Spacing** `--s-1 … --s-30` (4px base), **radius** `--r-sm … --r-pill`, **shadow** `--sh-card` / `--sh-frame`

Brand-mark colors `--brand-claude-code` / `--brand-codex` / `--brand-openclaw` /
`--brand-opencode` are the **only** saturated reds/blues allowed.

## Icons

The bundle exposes 31 line icons on `window.AgentDeck.*` (`IconRunning`,
`IconTerminal`, `IconAgent`, `IconShield`, `IconTablet`, …). Props: `size` (px,
default 24), `color` (default `currentColor` — so an icon inherits its parent's
text color; pass a token like `var(--kelp-500)` to override), `stroke`, `fill`.

## Rules (enforced repo-side)

1. **No raw hex** — always a token. Tokens are the only place hex lives.
2. **No `#fff` / `#000`** — whites lean to `--tide-50`, blacks to `--ink-900`.
3. **Two faces only** — IBM Plex Sans + JetBrains Mono. Never Inter / Roboto / Arial.
4. **Status is semantic, and only amber `awaiting` animates** — never animate kelp or coral.

## Idiomatic snippet

```jsx
<section className="ad-body">
  <div className="ad-container">
    <p className="ad-kicker">Live sessions</p>
    <h2 className="ad-h2">Three agents, one deck</h2>
    <div className="ad-card" style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center' }}>
      <window.AgentDeck.IconTerminal size={20} color="var(--kelp-500)" />
      <span className="ad-status"><span className="ad-dot ad-dot--processing" /> Processing</span>
      <button className="ad-btn ad-btn--primary">Open</button>
    </div>
  </div>
</section>
```
