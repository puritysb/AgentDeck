# design-sync notes — AgentDeck

AgentDeck is **not** a React component library: it's a CSS-class + design-token
system (no Storybook, no compiled component `dist/`). This sync is therefore
**off-script** — the converter (`shape: "package"`, synth-entry mode) is fed two
generated, gitignored inputs under `_ds_gen/`. Project: `AgentDeck`
(`aea179ab-9fe5-4275-82dc-3d2455563f65`).

## How it's wired

- **`scripts/design-sync-gen.mjs`** (committed) generates `_ds_gen/icons.tsx`
  (mechanical transform of `design/icons.jsx` → ES module: `import React`, shared
  `IconProps`, named `export`s; SVG bodies verbatim) and `_ds_gen/agentdeck.css`
  (Google-Fonts `@import` + `design/{tokens,patterns,components}.css` concatenated).
  It also writes `_ds_gen/icon-names.json`.
- **`scripts/design-sync-previews.mjs`** (committed) generates the 31 authored
  preview cards in `.design-sync/previews/<Icon>.tsx` (uniform template: a `Sizes`
  sweep + a `Palette` token sweep, wrapped in `.ad-body`). **These are template-
  generated — re-running the script overwrites any hand-edits.** If you hand-tune a
  preview, stop regenerating it (or remove it from the loop).
- **`cfg.cssEntry`** = `_ds_gen/agentdeck.css` → copied verbatim to `_ds_bundle.css`
  → `@import`ed by `styles.css`. The CSS is **inlined** (concatenated), not
  `@import`-linked, because the converter copies cssEntry verbatim and `@import`
  targets (`design/*.css`) would not ship to rendered designs.
- **`cfg.componentSrcMap` + `cfg.dtsPropsFor`** pin all 31 `Icon*` to
  `_ds_gen/icons.tsx`. The dtsPropsFor bodies are required (see gotchas).
- **`cfg.guidelinesGlob`** = `["DESIGN.md"]` — the default glob otherwise grabs ~24
  engineering docs under `docs/` and ships them as "design guidelines."

## Build / re-sync commands

```sh
node scripts/design-sync-gen.mjs        # regenerate _ds_gen/ (icons + css)
node scripts/design-sync-previews.mjs   # regenerate .design-sync/previews/
node .ds-sync/resync.mjs --config .design-sync/config.json \
  --node-modules ./.ds-sync/node_modules --entry ./_ds_gen/icons.tsx \
  --out ./ds-bundle --remote .design-sync/.cache/remote-sync.json
```

`--node-modules ./.ds-sync/node_modules` (not the repo root): the converter's
`react`/`react-dom`/`@types/react` live there (installed via `npm i` in `.ds-sync`).
`--entry ./_ds_gen/icons.tsx` sets PKG_DIR to the repo root (walk-up finds the root
`package.json`), which is what lets `cssEntry`/`guidelinesGlob` reach `design/*.css`
and `DESIGN.md`.

## Gotchas

- **dtsPropsFor is load-bearing.** The ts-morph `.d.ts` parse runs against the repo
  root's `node_modules`, where `@types/react` isn't hoisted (pnpm) → `[DTS_REACT]`,
  and `IconProps` falls back to `{ [key: string]: unknown }`. `cfg.dtsPropsFor`
  pins the real props for every icon. Don't remove it.
- **`[FONT_REMOTE]` is expected, not a problem.** Fonts load via the Google-Fonts
  CDN `@import` at the top of `_ds_bundle.css` (faithful to how the repo's mockups
  load fonts). validate prints `[FONT_REMOTE]` (informational).
- **The `[DTS] parsed 254 .d.ts` line** is the converter scanning the whole monorepo
  from the repo-root PKG_DIR. Harmless, just slow-ish.

## Known render warns

None — all 31 cards render clean (0 bad / 0 thin / 0 variants-identical).

## Re-sync risks (watch-list)

- **Icon set drift.** `.design-sync/config.json` hard-codes the 31 icon names in
  `componentSrcMap` **and** `dtsPropsFor`. If `design/icons.jsx` adds/removes icons,
  re-run `design-sync-gen.mjs`, then **regenerate the config** (the session used a
  node snippet reading `_ds_gen/icon-names.json` to rebuild both maps + preserve
  `projectId`/`readmeHeader`/`cssEntry`/`srcDir`/`guidelinesGlob`), then re-run
  `design-sync-previews.mjs`. Without this, new icons get no card and removed icons
  leave stale config entries.
- **Generated previews.** `.design-sync/previews/` is committed but produced by
  `design-sync-previews.mjs`. A re-sync that regenerates them silently discards
  hand-edits.
- **Remote fonts.** Rendered designs need network for the Google-Fonts CDN. For
  offline/self-contained fonts, wire the repo's local TTFs (`bridge/assets/fonts/`,
  Regular/Bold only — **no KR/JP weights** exist locally) via `cfg.extraFonts` +
  `@font-face`.
- **Deferred surface.** Brand marks (`design/brand/*.svg`) and creature marks
  (`docs/design/creatures.jsx`) are **not** synced — a candidate future wave (ship as
  components or `guidelines/`).
