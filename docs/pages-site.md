# GitHub Pages and Build Health

Runbook for the published site surfaces and the CI report generator. Moved out of `CLAUDE.md` so it loads only when working on the site.

- **URL**: `https://puritysb.github.io/AgentDeck/` (overview) / `/hardware/` (**Devices**) / `/flash/` (**Flash** — browser ESP32 flasher) / `/demo/` (**Live Preview**) / `/design-system/` (**Design System** viewer) / `/reports/` (**Build Health**). `/docs/` redirects to the viewer; `/gallery/` redirects to `/hardware/`. Do not restore either route as a duplicate catalog.
- **Workflow**: `.github/workflows/test-report.yml` — push to master → Vitest + Android JUnit + demo build + design-system build → HTML report → GitHub Pages deploy. Robot Framework is intentionally excluded from GitHub-hosted runs: its meaningful `hw`/`protocol`/`perf` suites require connected boards, while the former `no-hw` subset only duplicated PlatformIO compilation. The assembly step publishes overview, devices, the flasher, live preview, design-system viewer, build health, and compatibility redirects.
- **Live Preview fidelity**: `/demo` panels use canonical renderer output only — Node renderers via `scripts/render-creature-simulator.mjs` (sim-data.js) and **pixel-exact ESP32 firmware frames via `scripts/render-esp32-sim-frames.mjs`** (esp32/sim `demo:<agent>:<state>` scenes → `sim-frames/`, needs `pio`; missing frames show the hatch placeholder, never hand-drawn ESP32/e-ink/TC001). Hand-maintained Swift Device Preview mirrors carry `SYNC-HASH` origin pins enforced by `node scripts/check-preview-mirror-sync.mjs` (CI)
- **Build Health generator**: `scripts/generate-html-report.py` — tab-based SPA quality dashboard. Robot tab: suite→scenario→BDD steps→board matrix→per-test elapsed time→performance table. `[PERF]` log messages auto-extracted from output.xml
- **Scenario matrix**: `scripts/scenario-matrix.json` — 10 user scenarios mapped to test files + gap analysis
- **Site surfaces (all aquarium-tide)**: `scripts/pages-index.html` (overview) · `docs/hardware/index.html` (Devices; detailed SSOT remains `docs/hardware-compatibility.md`) · `tools/web-flasher/` (Flash — a **Vite app**, like the simulator, because esptool-js is an npm package with runtime deps and the CDN ban means something must bundle it) · `tools/creature-simulator/index.html` (Live Preview) · `agentdeck-design-system/viewer/` + generated manifest (Design System) · generated `/reports/` (Build Health) · `docs/site/index.html` and `docs/gallery/index.html` (redirects only). The viewer consumes `design/tokens.css` directly; generated content under `dist/` is never hand-edited.
- **Site-wide language selection (en/ko/ja)**: overview, Devices, and Live Preview each embed an inline `data-i18n` dictionary + nav `<select id="lang">`; the design-system viewer and Build Health carry the same control. All share the `agentdeck-design-locale` localStorage key so one choice follows the visitor across routes. English stays canonical in the DOM (ko/ja override per key); Build Health's generated body stays English (CI evidence, not authored copy) — its selector only persists the site-wide choice. Public surface counts (landing headline, stat tile, and chip grid) mirror the `docs/hardware-compatibility.md` surface matrix ("Counted surfaces" line) — update the matrix row first, then the mirrors. `node scripts/check-surface-mirrors.mjs` (`pnpm check-surface-mirrors`, gated in `design-system.yml`) fails when the counts disagree: a matrix row is one line while its chip lives in another file, which is how the landing page came to advertise 26 surfaces over 22 chips (T-Embed, T-Display-S3-Pro, Stream Deck XL, + XL all counted but unlisted).
- **Devices page spec cards are generated** — the `## ESP32 board specification sheet` table in `docs/hardware-compatibility.md` is the SSOT; `node scripts/sync-hardware-spec-cards.mjs` renders it into `docs/hardware/index.html` between `SPEC-CARDS:BEGIN/END` markers as responsive cards (3/2/1 columns), and `design-system.yml` runs `--check`. The gate fails on edits to either side. **Edit the Markdown table, run the sync — never hand-edit the card block.** Rows carry a status (`Shipping` / `Community fork` / `Evaluation`); only Shipping and Community fork are counted surfaces, so adding an Evaluation row must not change the "Counted surfaces" line.
- **★GNB is single-sourced** — `scripts/pages-nav.html` is the canonical partial. `node scripts/sync-pages-nav.mjs` renders it into the five committed surfaces between `GNB:BEGIN/END` markers (pages-index, hardware, web-flasher, creature-simulator, design-system viewer — the flasher and the viewer keep their CSS in a linked stylesheet, so their two markers live in different files), and `scripts/generate-html-report.py` renders the same partial at generation time, so Build Health cannot drift. CI gate: `design-system.yml` runs `sync-pages-nav.mjs --check`. **Edit the partial, run the sync — never hand-edit a nav block.** All six surfaces expose the same seven links + GitHub chip + `select#lang`; wrapper classes are normalized to `.nav/.nav-in/.brand/.nav-links`. Build Health's `:root` now declares canonical token names (local aliases `--bg`/`--surface`/`--text` resolve via `var()`) and is gated by `verify-tokens-sync.py` as the **seventh mirror**; its chart/badge hex in the body remains legacy (tracked by the design-lint baseline, excluded from the sync gate).
- **`/flash/` serves firmware from this origin, and that is the whole reason it exists here.** GitHub Release assets carry **no CORS headers** — measured with `curl -I -H 'Origin: …'` against both the 302 and the 200 — so a browser cannot read them, and a flasher that cannot read firmware is a page with a button that does nothing. Pages deploys from a workflow, so the images are fetched at deploy time instead: `scripts/fetch-flash-firmware.mjs` resolves the tag (`--tag` → `esp32/src/config.h` `FIRMWARE_VERSION` if that release exists → newest `esp32-v*`, **printing which rule it used**), downloads only the `webFlash` boards' merged images (~6 MB, not ~26 MB), and **re-verifies every sha256 against the release manifest, cache hits included** — a bit-rotted image is a bricked board, and a cache key proves provenance, not integrity. Paths are tag-addressed (`/flash/fw/<tag>/…`) with one stable `fw/index.json`, so a stale browser cache can at worst point at a previous release's directory and never serve last release's bits under this release's name. A release with **no** `manifest.json` (everything up to `esp32-v1.0.6`) is a stated skip, not a failure: the page deploys and says "no firmware deployed" in the visitor's language rather than taking the whole site down. A manifest that IS published and does not match its files fails the deploy. `actions/cache` is keyed on the tag.
- **The flasher is inside `design/lint.sh` scope.** `lint.sh` prunes `./tools/creature-simulator` but **not** `./tools/web-flasher`, so the app must stay token-clean — no raw hex, no `#fff`/`#000`, IBM Plex and JetBrains Mono only. Written clean rather than added to the prune list. Its `THIRD-PARTY.txt` is generated at build time by `scripts/generate-flash-third-party.mjs` from the installed packages' own LICENSE/NOTICE files: esptool-js is Apache-2.0 and a bundled `.js` is a redistribution, so the notice has to travel with it. Reading `node_modules` rather than checking a copy in keeps it honest about what actually shipped. The bridge npm package has no such obligation — it *declares* esptool-js as a dependency and bundles nothing.
- **Device photography pipeline**: `scripts/crop-hardware-images.mjs` crops the hardware photos into the catalog card frames (STANDARD 1.75:1 = the 349x200 card, WIDE 3.73:1, HERO 3:2). **Sources are committed** in `assets/hardware-photos/` — the captures actually used, with the EXIF rotation baked in (so the crop table's coordinates are plain display-space pixels) and re-encoded at quality 78, halving 36 MB to 15 MB. The script defaults to that directory, so the repo regenerates its own published crops with no external files; pass a path to crop from raw camera originals instead. **`.rotate()` must be called with no argument** — that applies the EXIF orientation tag; passing an explicit angle skips it and crops from an unrotated buffer (many iPhone captures are orientation 6: stored 4032x3024, actually 3024x4032). Frame the device body with margin, not just its screen, and verify each crop in a browser before shipping.

## Public aquarium media

The README uses `docs/media/aquarium-preview.gif` as a linked motion preview;
the overview plays `docs/media/aquarium-demo.mp4` with native controls and
`preload="none"`. It does not autoplay. The poster is `aquarium-dashboard.jpg`;
`aquarium-ipad.jpg` illustrates the Apple guide. The Pages assembly copies these
assets explicitly (JPEGs use the existing photo copy step).

The hero was re-recorded on 2026-09-23 in the native iPad app (1.5.0 UI,
source `6ba97043`; the app sources are unchanged at `cea760b6`). It uses five
fictional sessions: implement session search, write regression tests, check
accessibility, document the feature, and reproduce an empty-result report.
Sessions arrive one at a time; an unfocused timeline interleaves edits, tests,
permission waiting, and completion. Approval is simulated in the source terminal,
not presented as an action performed by the dashboard.

Reproduce the feed with
`node scripts/appstore-demo-orchestrator.mjs serve --story --port 9231`.
[`scripts/aquarium-demo-story.mjs`](../scripts/aquarium-demo-story.mjs) owns the
46-second cycle. The existing 30-second App Store scenario remains the default.
Use a Debug simulator build with `-AgentDeckScreenshotURL ws://127.0.0.1:9231`
and `-prefs.dashboardType aquarium3d`, in landscape. Capture with
`xcrun simctl io <device-id> recordVideo --codec=h264 <output.mov>` and stop with
SIGINT. Keep the fixture loopback-only and out of production daemons.

The published MP4 is **2752 × 2000, 30 fps, 42.8 seconds**, H.264 CRF 18,
`yuv420p`, with fast-start metadata (about 20 MB). The source display is
2752 × 2064; only the 64-pixel system bar was cropped. There is no upscaling,
motion interpolation, retouching, or composited app UI. The cut begins after the
first session arrives and ends with all five idle. The eight-second GIF excerpt
starts three seconds into the MP4, runs at native speed and 8 fps, and is scaled
to 720 pixels wide. The poster is extracted at 21 seconds. The Apple guide's
separate `aquarium-ipad.jpg` remains the earlier capture.

English captions are on by default; Korean and Japanese tracks are selectable
in the native player. The three `aquarium-story.*.vtt` files describe the story
without audio. The overview retains controls, full screen, and `preload="none"`;
it does not fetch the 20 MB video until requested. README uses the lightweight
GIF linked to this player because inline MP4 playback is not portable across
GitHub Markdown surfaces.

Keep public copy in English, with optional Korean/Japanese translations. Store
links stay evergreen; measured submission receipts belong in release records,
not temporary review-status copy in installation instructions.

See [testing.md](testing.md) for the full testing reference.
