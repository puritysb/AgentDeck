---
paths:
  - "design/**"
  - "DESIGN.md"
  - "docs/**"
  - "agentdeck-design-system/**"
  - "assets/**"
  - "apple/AgentDeck/UI/**"
  - "apple/AgentDeck/Rendering/**"
  - "android/**/ui/**"
  - "plugin/**"
  - "plugin-ulanzi/**"
  - "shared/src/svg-renderers/**"
  - "shared/src/design-tokens.ts"
  - "tools/**"
  - "bridge/src/pixoo/**"
  - "bridge/src/tui/**"
  - "bridge/src/apme/dashboard-html.ts"
  - "scripts/generate-html-report.py"
  - "scripts/build-design-system-viewer.mjs"
  - "scripts/check-docs.mjs"
  - "**/*.css"
  - "**/*.html"
---
# Design system and documentation gates
<!-- Moved verbatim from the root map (then CLAUDE.md, 2026-09-10; AGENTS.md since 2026-09-29). Rule bodies are the SSOT for their domain; the root map keeps only the index. -->
Aquarium-tide design system: spec [DESIGN.md](../../DESIGN.md), token SSOT [design/tokens.css](../../design/tokens.css),
resource map [design/RESOURCES.md](../../design/RESOURCES.md). Lint: `bash design/lint.sh`;
token mirrors: `python3 design/verify-tokens-sync.py`; docs: `pnpm docs:check`, `pnpm design-system:check`.

## Design system layer and gates

Aquarium-tide design system. Spec: [DESIGN.md](../../DESIGN.md). Source of truth for color/type/spacing tokens: [design/tokens.css](../../design/tokens.css). **Resource map (which directory is SSOT for what, and which gate stops drift): [design/RESOURCES.md](../../design/RESOURCES.md)** — bound into the Pages viewer via `catalog.json`; update it in the same commit when a design-resource location or gate changes. Visual reference: [docs/design/Design System.html](../../docs/design/Design%20System.html). Coverage matrix + lint rules: [docs/design/Design Audit.html](../../docs/design/Design%20Audit.html).
`agentdeck-design-system/` is the integration and handover layer, and its scope is the **whole designed surface** — visual language, system architecture, hardware and surface specs, product policy, and validation evidence — not just tokens. `catalog.json` binds those canonical Markdown sources to the GitHub Pages viewer (`pnpm design-system:check` prints the current document, token and asset counts — read them there rather than from a number in this file), [`agentdeck-design-system/docs/handover.md`](../../agentdeck-design-system/docs/handover.md) defines ownership and evidence levels, and `locales/{ko,ja}/` contains reader translations. English is always canonical. Every catalog document has YAML frontmatter; translations must match the canonical `source_revision`. Validate with `pnpm design-system:check`, build with `pnpm design-system:build`, and never edit generated `dist/design-system/` content.
**Coverage gate — this is what stops doc fragmentation.** `catalog.json` carries a `coverage` block (`scan` directories + `exclusions` map). Every `docs/*.md` must be either cataloged or excluded *with a stated reason*, and `pnpm design-system:check` fails otherwise. **Adding a doc to `docs/` therefore requires a decision in the same commit**: bind it (frontmatter + catalog entry) or write down why it does not belong. Excluding is legitimate — runbooks, credential setup, exploratory studies, and untranslated rationale essays are excluded today. The Asset library is likewise indexed from the real files (brand marks, generated masks, creatures, icons, brand type, product marks, hardware photography, reference surfaces); images ≤1 MiB ship inline, larger ones become pointer cards.
**Markdown gate:** `pnpm docs:check` validates tracked and newly added Markdown local links and anchors, rejects machine-local Markdown links, and requires exactly one H1 in `README.md` and each `docs/**/*.md` file. `.github/workflows/design-system.yml` runs the same checker directly with Node.

## Token bindings

**Token bindings** (all mirror `design/tokens.css`; CSS stays canonical — update every mirror in the same commit when CSS tokens change). Seven mirrors are gated: the four language bindings below plus three non-binding copies (`apme-dashboard` HTML, Stream Deck PI `design-tokens.css`, and the Build Health generator `scripts/generate-html-report.py`) that `verify-tokens-sync.py` also checks — the verifier's own footer prints the count, so read it there rather than trusting this sentence:
- Browser JS — `design/tokens.js` (IIFE that exposes `window.DT.{Tide,Ink,Kelp,Coral,Amber,Status,UI,Brand}`). Used by `docs/design/data.js` and Design System.html mockups
- TS — `shared/src/design-tokens.ts` (re-exported via `@agentdeck/shared`). Use for plugin renderers, bridge, hooks
- Swift — `apple/AgentDeck/UI/Common/DesignTokens.swift` (`DesignTokens.Tide.s50` etc.). Existing `StateColors` stays as legacy
- Kotlin — `android/app/src/main/kotlin/dev/agentdeck/ui/theme/DesignTokens.kt` (`DesignTokens.Tide.s50` etc.). Existing `AgentDeckColors` stays as legacy
- C++ (ESP32) — `esp32/src/ui/product_palette.generated.h`, **generated** (`pnpm generate-session-state`), never hand-edited; `esp32/src/ui/theme.h` binds its names to it
- Sync verification: `python3 design/verify-tokens-sync.py` — diffs all seven mirrors against tokens.css and exits non-zero on drift

## Session state and native Dashboards

**A session state looks the same on every product surface, and no surface owns a state→colour switch.** The
`--session-*` tokens (DESIGN.md §2.7) are bound by `shared/src/session-state-presentation.ts`, which also owns
the words (`Working`/`WORKING`/`WORK`); `pnpm generate-session-state` emits the Swift, Kotlin and C++ mirrors.
Before this, one working session was green on the Mac Dashboard, blue on the Android tablet, TUI and ESP32, and
teal on a Stream Deck key, because every platform carried its own Tailwind-derived table. One meaning per hue:
green health, cyan activity, amber needs-you (the only pulse), red failure, grey quiet.

**`design/lint.sh` does not read Swift, Kotlin or C++**, so native Dashboard code is ratcheted separately:
`scripts/__tests__/native-palette.test.ts` fails when any native Dashboard file gains a raw colour literal
(baseline `design/native-palette-baseline.json`; lower it with `node scripts/check-native-palette.mjs --write`
after removing literals). Colour belongs in `design/tokens.css`, then a mirror.

## Rules (DESIGN.md §10)

**Rules** (DESIGN.md §10 — enforced by `bash design/lint.sh`):
1. **No raw hex.** Use tokens (`var(--ink-900)`, `DesignTokens.Ink.s900`, etc.). Tokens are the only place hex literals live
2. **No `#fff` / `#000`.** Whites lean toward `--tide-50` sand, blacks toward `--ink-900` aquarium green
3. **Two faces only.** IBM Plex Sans (+ KR/JP) and JetBrains Mono. Never Inter / Roboto / Arial / Fraunces
4. **Status colors are semantic.** `--status-idle` / `--status-processing` / `--status-awaiting` / `--status-error`. Only **amber awaiting** pulses in brightness. The expressive Timebox face and event-driven iDotMatrix scenes may blink or move geometry as specified in DESIGN.md; their motion does not turn other status colors into flashing alarms
5. **Marketing vs product UI palette split.** Marketing surfaces (landing, docs, print) use the warm tokens. Product UI (menubar / e-ink / hardware / TTY) may also use the brighter `--ui-*` set. Marketing must NEVER touch `--ui-*`
6. **Brand marks are upstream — do not redraw.** `design/brand/{claudecode,codex,openclaw,opencode,antigravity,kiro,zai}.svg` are the canonical agent/provider marks. Brand colors (#C07058 / #6166E0 / #FF4D4D / #3a3a3a / #5F6368 / #7C3AED / #1F63EC) are the only saturated reds/blues allowed, and each one is a `--brand-*` token in `design/tokens.css` — a mark whose colour is quoted in this rule but absent from that file is the gap that shipped Kiro and Antigravity to every renderer while the design-system page could not draw either
7. **Real assets > drawn ones.** Hardware shots and brand marks come from `assets/` and `design/brand/`. Never illustrate hardware with hand-drawn SVG; ship the diagonal-hatch placeholder pattern (`.ad-hatch` / `.ad-placeholder`) when real assets aren't ready

## Migration

**Migration**: existing UI uses pre-design-system palettes (`StateColors.Hex.*`, `AgentDeckColors.*`). New code reaches for `DesignTokens.*`; migration is incremental, not a sweep. Read the current count from `docs/design-lint-baseline.md`, and measure with `bash design/lint.sh --json` in a clean checkout — see below.

## The lint count is only meaningful in a clean checkout

**`design/lint.sh` walks the filesystem, not the git index, and its prune list does not cover every gitignored build output — so a built working checkout over-reports and its total cannot be compared against the baseline.** Measured 2026-09-12 at `13a8f53d`: the working checkout reported **658 violations across 6 rules**, a fresh `git worktree` of the same commit reported **89** — 208 files in lint scope versus 93. The extra files are build artifacts such as `plugin-ulanzi/com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin/plugin/app.js`, which CI never sees because `.github/workflows/design-system.yml` runs `pnpm install` and never `pnpm build`.

The gate is `current ≤ Total: **N violations**` parsed from [docs/design-lint-baseline.md](../../docs/design-lint-baseline.md), where `current` comes from `bash design/lint.sh --json`. To decide whether a branch regresses, measure the branch **and its merge base** in clean worktrees, or diff the `--json` `records` by `(file, line, rule)` and inspect only the new ones. A bare run in a built checkout answers a different question and will send you chasing violations that are not in the repository.

R7 accepts only the radius scale `{0, 4, 8, 10, 12, 14, 16, 18, 999}`; `border-radius: 50%` is counted as `50` and therefore violates — spell a circle `999px`.
