---
id: design.resources
title: Design Resource Map
description: Where every design asset lives, which copy is canonical, and which gate stops drift.
category: Design
locale: en
canonical: true
status: stable
owner: Design system maintainers
reviewed: 2026-08-15
revision: 2026-08-15
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
| Real photography / captures | `assets/` (sources: `assets/hardware-photos/`) | `scripts/crop-hardware-images.mjs` crop table |
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

**Every** mark in `design/brand/` comes from one upstream package —
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
| Kiro ghost | `icons/kiro.svg` | Amazon.com, Inc. or its affiliates |
| opencode | `icons/opencode.svg` | the opencode project |
| OpenClaw | `icons/openclaw.svg` | the OpenClaw project |

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

## Rules of thumb

1. New numeric/visual truth starts in a canonical file above, then mirrors
   outward behind a gate — never as a per-surface literal (CLAUDE.md
   "Cross-platform rules are SSOT-first").
2. New design documentation gets YAML frontmatter and a `catalog.json` entry so
   the viewer publishes it; `docs/design/` HTML is frozen.
3. Anything under a "Derived" row is disposable output: fixes go to its source.
