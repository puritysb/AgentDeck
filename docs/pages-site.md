# GitHub Pages and Build Health

Runbook for the published site surfaces and the CI report generator. Moved out of `AGENTS.md` so it loads only when working on the site.

- **URL**: `https://puritysb.github.io/AgentDeck/` (overview) / `/hardware/` (**Devices**) / `/flash/` (**Flash** — browser ESP32 flasher) / `/demo/` (**Live Preview**) / `/design-system/` (**Design System** viewer) / `/reports/` (**Build Health**). `/docs/` redirects to the viewer; `/gallery/` redirects to `/hardware/`. Do not restore either route as a duplicate catalog.
- **Workflow**: `.github/workflows/test-report.yml` — push to master → Vitest + daemon E2E + Android JUnit + demo build + design-system build → HTML report → GitHub Pages deploy. Robot Framework is intentionally excluded from GitHub-hosted runs: its meaningful `hw`/`protocol`/`perf` suites require connected boards, while the former `no-hw` subset only duplicated PlatformIO compilation. The assembly step publishes overview, devices, the flasher, live preview, design-system viewer, build health, and compatibility redirects.
- **Live Preview fidelity**: `/demo` panels use canonical renderer output only — Node renderers via `scripts/render-creature-simulator.mjs` (sim-data.js) and **pixel-exact ESP32 firmware frames via `scripts/render-esp32-sim-frames.mjs`** (esp32/sim `demo:<agent>:<state>` scenes → `sim-frames/`, needs `pio`; missing frames show the hatch placeholder, never hand-drawn ESP32/e-ink/TC001). Hand-maintained Swift Device Preview mirrors carry `SYNC-HASH` origin pins enforced by `node scripts/check-preview-mirror-sync.mjs` (CI)
- **Build Health generator**: `scripts/generate-html-report.py` — one page in the same grammar as Devices (hero, jump bar, `.section-head` sections, bordered `--tide-100` cards): Latest run (with every skipped case and the CI runner that executes it) · Verification tiers (the changed / quick / pre-release step matrix from the catalog's `tiers` and `steps`, plus the newest committed receipt under `verification/receipts/`) · What we verify (from `scripts/verification-catalog.json`; each gate card names its local tiers and its workflow's latest hosted run, fetched by `scripts/fetch-workflow-status.mjs`, fail-soft) · Test domains · Platforms (Android / Apple / ESP32 Robot with its board × metric performance table; `[PERF]` log messages auto-extracted from output.xml) · Scenarios · Coverage (floors read from `vitest.config.ts`) · History. Status hues follow DESIGN.md §2.7: kelp passing, coral failing, ink-300 not run; a suite that did not run here is never shown as passing; a result from another workflow or an attested lab gate gets an outlined badge ("Passed in CI", "Attested pass") and never enters this page's totals. **The page is generated, so `design/lint.sh` never sees it** — `scripts/__tests__/build-health-report.test.ts` renders it from fixtures and lints the output (hex only in `:root`, two faces, radius scale, no animation, canonical GNB), and `verify-tokens-sync.py` sweeps the generator's body for stray hex.
- **Scenario matrix**: `scripts/scenario-matrix.json` — 10 user scenarios mapped to test files + gap analysis. `verification-catalog.test.ts` fails when a mapped file is gone or a name pattern no longer appears in its test file (which would render as "not found")
- **Site surfaces (all aquarium-tide)**: `scripts/pages-index.html` (overview) · `docs/hardware/index.html` (Devices; detailed SSOT remains `docs/hardware-compatibility.md`) · `tools/web-flasher/` (Flash — a **Vite app**, like the simulator, because esptool-js is an npm package with runtime deps and the CDN ban means something must bundle it) · `tools/creature-simulator/index.html` (Live Preview) · `agentdeck-design-system/viewer/` + generated manifest (Design System) · generated `/reports/` (Build Health) · `docs/site/index.html` and `docs/gallery/index.html` (redirects only). The viewer consumes `design/tokens.css` directly; generated content under `dist/` is never hand-edited.
- **Site-wide language selection (en/ko/ja)**: overview, Devices, and Live Preview each embed an inline `data-i18n` dictionary + nav `<select id="lang">`; the design-system viewer and Build Health carry the same control. All share the `agentdeck-design-locale` localStorage key so one choice follows the visitor across routes. English stays canonical in the DOM (ko/ja override per key); Build Health translates authored navigation, status, explanations, catalog and scenario copy into Korean using `scripts/report-locales/ko.json`, inlined with `scripts/report-locale.js` by the generator. Test names, commands, paths, failure logs and receipt details retain their original evidence. English is the fallback for untranslated copy (including Japanese); the document language follows the displayed body. The decision summary uses parsed case outcomes for HTML, summary.json and history; skipped cases are excluded from execution. A narrow run is partial verification, metadata-only success is no case evidence, and suite setup/coverage failure remains a failure. Hosted runs and attested receipts retain their own commit/date and never fill missing cases here. The manual QA section provides test-selection rationale and a reproducible public example. The locale tests gate catalog/scenario/QA translation coverage and reversible switching, including disabled localStorage. Public surface counts (landing headline, stat tile, and chip grid) mirror the `docs/hardware-compatibility.md` surface matrix ("Counted surfaces" line) — update the matrix row first, then the mirrors. `node scripts/check-surface-mirrors.mjs` (`pnpm check-surface-mirrors`, gated in `design-system.yml`) fails when the counts disagree: a matrix row is one line while its chip lives in another file, which is how the landing page came to advertise 26 surfaces over 22 chips (T-Embed, T-Display-S3-Pro, Stream Deck XL, + XL all counted but unlisted).
- **Devices page spec cards are generated** — the `## ESP32 board specification sheet` table in `docs/hardware-compatibility.md` is the SSOT; `node scripts/sync-hardware-spec-cards.mjs` renders it into `docs/hardware/index.html` between `SPEC-CARDS:BEGIN/END` markers as responsive cards (3/2/1 columns), and `design-system.yml` runs `--check`. The gate fails on edits to either side. **Edit the Markdown table, run the sync — never hand-edit the card block.** Rows carry a status (`Shipping` / `Community fork` / `Evaluation`); only Shipping and Community fork are counted surfaces, so adding an Evaluation row must not change the "Counted surfaces" line.
- **★GNB is single-sourced** — `scripts/pages-nav.html` is the canonical partial. `node scripts/sync-pages-nav.mjs` renders it into the five committed surfaces between `GNB:BEGIN/END` markers (pages-index, hardware, web-flasher, creature-simulator, design-system viewer — the flasher and the viewer keep their CSS in a linked stylesheet, so their two markers live in different files), and `scripts/generate-html-report.py` renders the same partial at generation time, so Build Health cannot drift. CI gate: `design-system.yml` runs `sync-pages-nav.mjs --check`. **Edit the partial, run the sync — never hand-edit a nav block.** All six surfaces expose the same seven links + GitHub chip + `select#lang`; wrapper classes are normalized to `.nav/.nav-in/.brand/.nav-links`. Build Health's `:root` declares canonical token names only and is gated by `verify-tokens-sync.py` as the **seventh mirror**, body sweep included — the legacy chart/badge hex was removed when the page was rebuilt on tokens (2026-09-28).
- **`/flash/` serves firmware from this origin, and that is the whole reason it exists here.** GitHub Release assets carry **no CORS headers** — measured with `curl -I -H 'Origin: …'` against both the 302 and the 200 — so a browser cannot read them, and a flasher that cannot read firmware is a page with a button that does nothing. Pages deploys from a workflow, so the images are fetched at deploy time instead: `scripts/fetch-flash-firmware.mjs` resolves the tag (`--tag` → `esp32/src/config.h` `FIRMWARE_VERSION` if that release exists → newest `esp32-v*`, **printing which rule it used**), downloads only the `webFlash` boards' merged images (~6 MB, not ~26 MB), and **re-verifies every sha256 against the release manifest, cache hits included** — a bit-rotted image is a bricked board, and a cache key proves provenance, not integrity. Paths are tag-addressed (`/flash/fw/<tag>/…`) with one stable `fw/index.json`, so a stale browser cache can at worst point at a previous release's directory and never serve last release's bits under this release's name. A release with **no** `manifest.json` (everything up to `esp32-v1.0.6`) is a stated skip, not a failure: the page deploys and says "no firmware deployed" in the visitor's language rather than taking the whole site down. A manifest that IS published and does not match its files fails the deploy. `actions/cache` is keyed on the tag.
- **The flasher is inside `design/lint.sh` scope.** `lint.sh` prunes `./tools/creature-simulator` but **not** `./tools/web-flasher`, so the app must stay token-clean — no raw hex, no `#fff`/`#000`, IBM Plex and JetBrains Mono only. Written clean rather than added to the prune list. Its `THIRD-PARTY.txt` is generated at build time by `scripts/generate-flash-third-party.mjs` from the installed packages' own LICENSE/NOTICE files: esptool-js is Apache-2.0 and a bundled `.js` is a redistribution, so the notice has to travel with it. Reading `node_modules` rather than checking a copy in keeps it honest about what actually shipped. The bridge npm package has no such obligation — it *declares* esptool-js as a dependency and bundles nothing.
- **Device photography pipeline**: `scripts/crop-hardware-images.mjs` crops the hardware photos into the catalog card frames (STANDARD 1.75:1 = the 349x200 card, WIDE 3.73:1, HERO 3:2). **Sources are committed** in `assets/hardware-photos/` — the captures actually used, with the EXIF rotation baked in (so the crop table's coordinates are plain display-space pixels) and re-encoded at quality 78, halving 36 MB to 15 MB. The script defaults to that directory, so the repo regenerates its own published crops with no external files; pass a path to crop from raw camera originals instead. **`.rotate()` must be called with no argument** — that applies the EXIF orientation tag; passing an explicit angle skips it and crops from an unrotated buffer (many iPhone captures are orientation 6: stored 4032x3024, actually 3024x4032). Frame the device body with margin, not just its screen, and verify each crop in a browser before shipping.

## Public aquarium media

The README uses `docs/media/aquarium-preview.gif` as a linked motion preview to
the overview's `#current-habitat` recording. Since 2026-11-06 the overview no
longer embeds `docs/media/aquarium-demo.mp4` or the 1.8.0 supplement below. Both
remain published at their `media/` URLs for existing links and store records, and
the Pages assembly still copies them. When it was embedded, the player used native
controls and `preload="none"` and did not autoplay. The poster is `aquarium-dashboard.jpg`;
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

### 1.8.0 scenario supplement

Archived from the overview and README on 2026-11-06; the files stay published.
The overview's former `#showcase-180` section and README added `aquarium-180-showcase.mp4` plus three
native screenshots: `aquarium-180-overview.jpg`, `aquarium-180-ci.jpg`, and
`aquarium-180-complete.jpg`. This is a native iPad **simulator** recording with
fictional sessions, not footage of a physical device or a live private workspace.

Reproduce the isolated 38-second fixture with
`node scripts/appstore-demo-orchestrator.mjs serve --showcase --port 9231`.
Use a Debug iPad simulator build from the 1.8.0 candidate with
`-AgentDeckScreenshotURL ws://127.0.0.1:9231` and
`-prefs.dashboardType aquarium3d`. The optional showcase leaves the original
`--story` and default App Store scenario unchanged. Keep the feed loopback-only
and separate from the production daemon.

The video is 36 seconds, 1920 × 1334 at 30 fps (H.264, `yuv420p`, about
5.5 MB). Full-frame JPEGs retain the native 2360 × 1640 resolution. There is
no UI compositing, retouching, upscaling, or speed change. The 38-second fixture
is cut from 1.5 to 37.5 seconds, opening on the first working session and ending
before the next cycle. Caption times subtract 1.5 seconds from the story clock.

The supplement follows Hermes Agent alongside Claude, Codex, OpenCode, and
OpenClaw, a GitHub CI companion attached to its waiting session, and the return
to completed work. Gateway residents remain singular. Approval and CI waiting
are separate states; the dashboard does not approve a request in this story.
English, Korean, and Japanese captions use `aquarium-180.{en,ko,ja}.vtt`.
The player keeps controls, no autoplay, and `preload="none"`; stills load lazily.
The Pages assembly copies the new MP4 and captions explicitly and the JPEGs via
the existing photo copy step. Do not replace older dated footage with a new
version label. Preserve the historical hardware photos unchanged. A user-requested
composite belongs in a separate, clearly labeled derivative file with its original
photograph and native screen input recorded; it is not physical-device evidence.

## Current habitat media (November 2026)

The shared navigation uses a styled language menu with full native names,
localized helper text, a selected check, warm hover/focus states, and a native
select only as its no-JavaScript fallback. The 44px trigger remains visible
while links move to a separate scroll row on narrow screens. The menu is a
viewport-clamped portal with keyboard navigation, Escape/Tab/outside dismissal,
and focus restoration. Edit only `pages-nav.html` / `pages-nav.css`, then run
`node scripts/sync-pages-nav.mjs`. Menu rows come from the one locale option
list; navigation translations and accessible names are shared too. The design
viewer clones the closed control and open list as a static specimen.

Check all six public surfaces and every locale at 320–1440 CSS pixels, including
opened-menu bounds, keyboard/touch selection, long labels and section anchors.
The actual navigation height drives fragment clearance. Language options must
match the design catalog; expansion requires translation/fallback and layout
coverage. Detailed menu geometry and states live in `DESIGN.md` §1.5.

`docs/media/current/` contains the November 1 native desktop/reader stills,
November 2 connected-tablet validation captures, and source-identified ESP32 host
frames. `manifest.json` records each asset's evidence type, source revision, fixture, dimensions, SHA-256, and
transformation. The overview and Devices catalog distinguish app captures,
firmware host renders, and the AI-assisted 86 Box composite. Store release
availability is not implied. Original photographs and the two earlier video
stories remain intact.

`shared-home.mp4` is the connected Lenovo tablet's approximately 135-second, silent
native screen recording, transcoded to 720×1280 H.264/yuv420p at 30 fps without a
speed change or UI retouching. It shows OpenClaw's first emergence, persistent idle
berth and final gateway departure, plus Hermes/Dot's front-lip return.
`shared-home-preview.gif` is an 8-second return excerpt (72–80 seconds),
360 pixels wide at 10 fps; the full recording remains the evidence. Captions in
English, Korean and Japanese identify the fixture, swimming, and return. Tablet
captures retain their original PNG bytes; earlier app captures and firmware frames
are losslessly recompressed. Do not use a host frame as proof of e-ink refresh, ghosting, or physical panel image quality.

The AI composite is a new derivative of `box86.jpg`, using the actual 480×480
firmware render as a screen reference. Its exact image-generation prompt and
input hashes are recorded in the manifest. It is a visual presentation sample;
compare it with the unmodified render, and retain the original photo.

Live Preview offers seven agent kinds plus the separate Dot report resident.
Dot uses a `DotDeckSnapshot`, never a fake session; states map to awaiting
activity, working, needs-you and host-stopped. Firmware capture uses the actual
TTGO terrarium page, real knob navigation for Dot, and the IPS10 project pager
to expose the selected agent. Browser layout studies are not native 3D previews.

See [testing.md](testing.md) for the full testing reference.

## Report metrics

Latest run, history test counts and pass-rate charts use **executed = passed + failed**; skipped cases remain separate in the machine-readable summary and history. Older history entries are normalized at display time. Pass-rate curves plot percentages for each run, not raw passing-test counts. Cumulative test time sums file durations; it is not workflow elapsed time. The overall result includes suite execution failures (for example a coverage-floor failure without a failed assertion). Android JUnit `error` and `skipped` cases retain those states in the detailed list.

## 2.0 capture checkpoint

The [2.0 integration and media plan](../RELEASING.md#200-integration-target-2026-11-02)
records the frozen candidate `4100e0ca` and its complete local verification receipt.
The primary introduction is now the [whole-product tour](https://puritysb.github.io/AgentDeck/#product-tour),
**2 minutes 24 seconds**, with separate chapters for sessions/CI, tablet monitoring,
collaboration, usage, real choices/approval, controller layouts, voice/native controls,
task evaluation/evidence, e-ink, compact displays, LED glance devices and the terminal.
The native control take is retained as a feature detail rather than the product introduction.

The new native Mac/iPad captures reuse the accepted `4100e0ca` binaries: app code
is unchanged at the media base `2a1ab86a`. `scripts/product-tour-fixture.mjs` binds
only loopback on an isolated port, uses fictional activity and never executes
controls. Its task/judge and quota data are visual samples, not measurements of
an actual account or an evaluation run. The control chapter retains the real
OpenCode SDK execution from the earlier take; renderer frames and historical
physical photographs carry their own on-screen evidence labels. CloudKit/Watch
is a separate development experiment and is not advertised as released remote control.

To reproduce the visual feed and assembly:

```bash
node scripts/product-tour-fixture.mjs 19570
# Launch a Debug native app with -AgentDeckScreenshotURL ws://127.0.0.1:19570.
# Capture overview, focus and Collaboration's expanded graph into diagnostics/tour-raw/.
node --import tsx scripts/render-product-tour-keys.mts diagnostics/tour-raw
node scripts/assemble-product-tour.mjs diagnostics/tour-raw
```

The [chapter source](../scripts/product-tour-story.json) owns feature coverage,
frame placement, transformations and EN/KO/JA captions. The generated
`agentdeck-200-product-tour-cuts.json` records native cuts and input digests.
Do not shorten the primary film into a single feature demonstration. Review every
chapter at normal speed, check the UI close-ups, and verify caption/seek alignment.
The README links a lightweight excerpt to the controlled Pages player; no autoplay
or up-front video download is introduced.

`agentdeck-200-workflow.mp4` remains the original-speed close-up of the native phone
recording, with its full phone and Mac views linked. The real local OpenCode
question, choice, one-time permission and `node --test` result do not prove provider
discovery, account quota or CloudKit delivery. Raw/binary/harness digests and Store
candidate metadata remain indexed in `docs/media/current/manifest.json`.
Store candidates are local preparation files, not uploaded previews or release approval.
The longer aquarium recording stays a development detail, and dated 1.x footage
remains intact.
