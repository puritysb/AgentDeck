---
id: design.resources
title: Design Resource Map
description: Where every design asset lives, which copy is canonical, and which gate stops drift.
category: Design
locale: en
canonical: true
status: stable
owner: Design system maintainers
reviewed: 2026-09-23
revision: 2026-09-23
source_of_truth: design/RESOURCES.md
validators: [node scripts/build-design-system-viewer.mjs --check, python3 design/verify-tokens-sync.py]
---

# Design Resource Map

Design material is spread across several top-level directories on purpose —
each has one job — but only one copy of anything is canonical. This map is the
index. If a location or gate changes, update this file in the same commit.

## Canonical sources (SSOT)

| Resource | Canonical location | Enforced by |
|---|---|---|
| Visual language spec | `DESIGN.md` | `design/lint.sh` (R1–R8, CI baseline in `docs/design-lint-baseline.md`) |
| Color/type/spacing tokens | `design/tokens.css` | `design/verify-tokens-sync.py` (7 mirrors) |
| Component & pattern CSS | `design/components.css`, `design/patterns.css` | consumed verbatim by generators |
| Icons | `design/icons.jsx` | `scripts/design-sync-gen.mjs` transform |
| Brand marks (agents) | `design/brand/*.svg` | `pnpm generate-creature-glyphs` / `generate-micro-glyphs` regression tests |
| Brand type (Latin) | `bridge/assets/fonts/` (IBM Plex Sans, JetBrains Mono) | first consumer: bridge renderers |
| Brand type (CJK) | `design/fonts/` (IBM Plex Sans KR/JP, OFL) | `design/fonts/README.md` records origin |
| IPS10 underwater background | `design/ips10/ocean.png` (image generation; prompt in adjacent README) | `python3 design/ips10/encode_ocean.py --check` verifies the RGB565 flash consumer; native IPS10 previews verify live overlays |
| IPS10 creature reliefs | `design/ips10/creatures.py` → three `*-relief.png` images, derived from canonical creature masks | `python3 design/ips10/encode_creatures.py --check`; native geometry and interaction checks |
| Real photography / captures | `assets/` (sources: `assets/hardware-photos/`) | `scripts/crop-hardware-images.mjs` crop table |
| Android LCD aquarium habitat | `assets/terrarium/aquarium-habitat.blend` | `assets/terrarium/export-habitat.py`; manual Blender export and on-device visual review |
| Native 3D aquarium study / TRMNL plate | `assets/terrarium/living-aquarium.blend` | `export-living-aquarium.py` / `export-paper-aquarium.py` in the same directory; native preview and panel review |
| Native 3D agent residents | `assets/terrarium/3d-residents.blend`, built from `design/brand/*.svg` | `build-3d-residents.py` + `export-android-residents.py`; Apple import and Android asset tests |
| Published image crops | `docs/media/` | regenerated from `assets/`, never hand-edited |
| Doc-to-viewer binding | `agentdeck-design-system/catalog.json` | `pnpm design-system:check` |
| Documentation coverage | `catalog.json` → `coverage.scan` / `coverage.exclusions` | `pnpm design-system:check` — a `docs/*.md` that is neither cataloged nor excluded-with-a-reason fails the build |
| Pages global nav (GNB) | `scripts/pages-nav.html` | `scripts/sync-pages-nav.mjs --check` (CI: design-system.yml) |

## Token mirrors (never edit without the CSS)

`design/tokens.js` (browser) · `shared/src/design-tokens.ts` (TS) ·
`apple/AgentDeck/UI/Common/DesignTokens.swift` · Kotlin `DesignTokens.kt` ·
embedded copies in the APME dashboard HTML, the Stream Deck PI CSS, and the
Build Health generator's `:root` (`scripts/generate-html-report.py`).
`python3 design/verify-tokens-sync.py` diffs all seven against `tokens.css`.

## Third-party brand provenance

Agent marks identify compatible third-party tools; they do not imply sponsorship
or endorsement. Preserve the exact upstream geometry and the source record below
when regenerating constrained-device masks.

The original six monochrome SVG marks in `design/brand/` come from one upstream package —
`@lobehub/icons-static-svg@1.94.0` (MIT), npm integrity
`sha512-Inx1TYkjLH6YeHOIHeVW9+OM/xxRnk8TmcQVKquFUDBmE3X9sUuRGt7kALrrDBNNAbrWz7Qq6fAiFj9E9Mmw9Q==`.
This table used to hold Kiro alone, which read as though Kiro were the one mark
with a licensing question; the other five were simply undocumented. They stand
or fall together, and they stand: the path geometry of all six is byte-identical
to upstream (verified 2026-08-16 against the packed tarball; `kiro.svg` differs
only by a trailing newline and `antigravity.svg` only by a self-closing `<path/>`).

The trademark column is a *statement of whose mark it is*, not an open question
per row. Nominative use — naming a tool AgentDeck interoperates with — is the
posture for all of them equally, and none of the holders has granted or been
asked for anything beyond that.

| Mark | Upstream file | Trademark holder |
|---|---|---|
| Claude Code | `icons/claudecode.svg` | Anthropic |
| Codex | `icons/codex.svg` | OpenAI |
| Antigravity | `icons/antigravity.svg` | Google |
| Antigravity full-color texture | [Official press PNG](https://antigravity.google/assets/image/brand/antigravity-icon__full-color.png), captured 2026-09-23; `antigravity-color.png` is byte-identical | Google |
| Kiro ghost | `icons/kiro.svg` | Amazon.com, Inc. or its affiliates |
| opencode | `icons/opencode.svg` | the opencode project |
| OpenClaw | `icons/openclaw.svg` | the OpenClaw project |
| z.ai | `https://z-cdn.chatglm.cn/z-ai/static/logo.svg` (captured 2026-09-20; `zai.svg` stores the Z strokes verbatim, mark without the upstream app-icon plate) | Z.ai / Zhipu AI |

Re-verify a mark against upstream with:

```bash
npm pack @lobehub/icons-static-svg@1.94.0 && tar xzf lobehub-icons-static-svg-1.94.0.tgz
diff package/icons/<name>.svg design/brand/<name>.svg   # path data must match
```

## Derived / consumer surfaces (safe to regenerate, never edit)

| Surface | Built from | By |
|---|---|---|
| GitHub Pages **Design System viewer** | `catalog.json` + bound Markdown + `design/tokens.css` | `pnpm design-system:build` |
| `.design-sync/` + `_ds_gen/` | `design/*.css`, `design/icons.jsx` | `scripts/design-sync-gen.mjs`, `design-sync-previews.mjs` (see `.design-sync/NOTES.md`) |
| App Store screenshots `apple/appstore-submission/screenshots/{en,ko,ja}/` | `screenshots-raw/` captures + captions | `scripts/compose-appstore-screenshots.py` |
| App Store previews | demo feed (`scripts/appstore-demo-orchestrator.mjs`) | `scripts/record-appstore-previews.sh` |
| Marketplace listing assets | app captures | `scripts/generate-elgato-marketplace-assets.mjs` |
| GitHub Pages **`/flash/`** (browser ESP32 flasher) | `tools/web-flasher/` (Vite app) + the release's `manifest.json` and merged images | `pnpm flash:build`, then the Pages workflow's *Fetch firmware for the flasher* step (`scripts/fetch-flash-firmware.mjs`) |
| `dist/flash/THIRD-PARTY.txt` | the installed `esptool-js` / `pako` / `atob-lite` / `tslib` licence + NOTICE files | `scripts/generate-flash-third-party.mjs` |

## Reference-only surfaces (historical, superseded for publication)

`docs/design/Design System.html` and `docs/design/Design Audit.html` are the
original hand-built visual references. They remain linked from `DESIGN.md` as
mockup references, but the **published** design-system surface is the Pages
viewer (`/design-system/`), which renders the cataloged Markdown against the
live tokens. Do not extend the HTML files with new canonical content — bind new
documents through `catalog.json` instead.

## What the viewer indexes automatically

The Asset library page is built from the real files, not from a hand-written list —
so a regenerated mask or a new brand SVG changes the page without anyone editing
it. Eight groups: brand marks, generated dot-matrix masks, creatures, icons, brand
type, product marks and captures, hardware photography, and reference surfaces.

Two rules keep it honest. Images at or under **1 MiB** are copied into the published
build and render inline; anything larger becomes a pointer card that links to the
source, so the Pages artifact never turns into an image host (`assets/` and
`docs/media/` together are ~80 MB). Directories are summarised with a real file
count and byte total read at build time, never a number typed into a doc.

### `/flash/` — gates it is already inside

The flasher is a **Vite app, not a self-contained HTML file**: esptool-js is an
npm package with runtime dependencies, and the CDN ban means something has to
bundle it. `tools/creature-simulator/` is the same shape and the same precedent.

Two consequences worth stating, because both are easy to get wrong:

- **`design/lint.sh` prunes `./tools/creature-simulator` but NOT
  `./tools/web-flasher`.** The flasher is inside the lint scope, so it must stay
  token-clean — no raw hex, no `#fff`/`#000`, IBM Plex and JetBrains Mono only.
  Written clean rather than added to the prune list.
- **Its GNB is generated**, like every other Pages surface: markup markers in
  `tools/web-flasher/index.html`, CSS markers in `tools/web-flasher/style.css`
  (a linked stylesheet, so the two markers live in different files — same split
  as the design-system viewer). `node scripts/sync-pages-nav.mjs --check` gates
  it. Editing either marked region by hand is what the checker exists to catch.

Because the flasher owns nothing under `docs/`, it adds no `catalog.json`
coverage decision. `docs/esp32.md` (already cataloged) carries its documentation.

## Rules of thumb

1. New numeric/visual truth starts in a canonical file above, then mirrors
   outward behind a gate — never as a per-surface literal (CLAUDE.md
   "Cross-platform rules are SSOT-first").
2. New design documentation gets YAML frontmatter and a `catalog.json` entry so
   the viewer publishes it; `docs/design/` HTML is frozen.
3. Anything under a "Derived" row is disposable output: fixes go to its source.
