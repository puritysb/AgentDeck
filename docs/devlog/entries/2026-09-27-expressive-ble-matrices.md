# 2026-09-27 — One expressive BLE policy for Node and Swift

The user assigned distinct roles: Timebox Mini is the agents' collective robot
face; iDotMatrix describes what is happening across their world. They explicitly
kept information more important than decoration and rejected a timed creature
carousel. Counts are retained and strengthened, rather than replaced by logos.

Timebox now has broad 11×11 eyes: working gaze/blink, raised waiting brows,
worried error eyes, smiling result eyes, quiet idle, unknown and a brief greeting.
Only amber attention changes status brightness; eye poses can move in other
states. The pixel shapes survive the device's 4-bit color quantization.

iDotMatrix normally shows four simultaneous numeric rows: WAIT, WORK, RSLT and
LIVE (ERR replaces LIVE when any live session is in error). Zero rows are dim;
values over 99 show 99+. RSLT counts explicit response/task-end events within
90 seconds, not task attempts or a claim that all work has completed. Tool-event bursts cannot evict the result window. Only a
newly observed live session or an actual recent response earns a six-second
creature scene. Waiting/errors preempt scenes. Initial/reconnected rosters are
baselines; repeated snapshots and render requests cannot restart entrances.
The recently seen id cache is bounded to 1,024 entries, and bursts coalesce to
one entrance instead of building an animation backlog. Unknown identities stay
neutral rather than impersonating Claude.

`shared/src/matrix-expression.ts` owns policy; `bridge/src/pixoo/matrix-art.ts`
owns artwork, including canonical official masks for event creatures.
`pnpm generate-matrix-expressions` generates Swift constants and RLE pixel frames.
The Node matrix subscription is daemon-owned, so BLE rendering no longer depends
on a configured Pixoo64 or enabled Pixoo discovery. Both native BLE modules are
seeded from the current roster and restored timeline before their first frame,
then ingest broadcasts directly; their old
unused DashboardState assembly is removed. Existing transport, dimming, shutdown
badges and Pixoo64 stay in place. The native app needs no external interpreter.

Validation: build, typecheck and full Vitest suite passed (4,909 passed, two
skipped). Thirteen focused tests include a compiled Swift executable fed the
same event sequences as Node, comparing state/counts and every RGB pixel.
macOS Debug build passed; protocol generation left no drift; docs/catalog/token
checks passed. Clean-source design lint is unchanged at 89 pre-existing
violations (the built tree additionally scans copied app resources). Actual production-renderer contact sheets and an animated HTML
preview are reproducible with `pnpm exec tsx scripts/render-matrix-expressions.mts`
and live under ignored `diagnostics/matrix`. These are renderer evidence, not
observations of physical panels. This task does not install or restart a daemon.
