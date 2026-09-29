# 2026-09-19 — #327 phase 1: adb sync probes measured off the loop, /health telemetry

The 2026-09-13 incident (load 600–800, /health unanswered 5–15 s, Apple app
promoting a fallback daemon on 9121 and double-opening serial ports) demanded
attribution before runtime changes. Attribution is now measured, not assumed:
a harness driving the real `getConnectedAdbDevices()` with
`monitorEventLoopDelay` plus a 50 ms heartbeat shows the synchronous
`execSync('adb devices')` blocked the event loop for the call's entire wall
time — 19 ms idle, 169 ms at load 10, 125 ms at load 30 on a 10-core host —
while the async control never blocked (max heartbeat gap ≈ timer granularity).
At the incident's 60–80× oversubscription the same spawn stretches into the
recorded 5–15 s window, and THREE recurring call sites ran it: the 30 s
adb-module poll (`adb devices` + per-device `reverse --list` chains), the
/devices route, and — the direct self-starvation — module health embedded in
/health itself (`hasAdb()` + `getConnectedAdbDevices()` on every health poll,
which is exactly what the Apple app hammers before deciding the daemon is
gone).

adb-reverse.ts is now fully async (`execFile`), the poll tick is serialized
against a stalled call, and /status, /devices and /health serve a cached
device list the poll keeps warm — zero adb spawns on any request path.
`parseAdbDeviceLines` is exported pure for the offline/unauthorized/network-
transport cases, and a source gate (comments blanked, windows-child-window
style) keeps `execSync`/`spawnSync`/`execFileSync` out of adb-reverse.ts and
adb-module.ts permanently. /health additionally reports `eventLoopDelayMs`
(p50/p99/max/mean, rolling window reset per read) via
`bridge/src/event-loop-telemetry.ts`, so "loop blocked" versus "process gone"
is answerable from the route whose latency decides it; live on the dev desk
it reads p99 ≈ 40 ms steady state and immediately surfaced a 2 s startup
block that predates this change. Live restart: /health 1–2 ms after module
init, adb cache warm with the connected Lenovo, ESP32 fleet reconnected.

Remaining #327 scope, unchanged: Swift-fallback-during-Node-lease protection,
USB preflight when a suspend call fails, and post-write reset/readback under
load. Validation: full vitest 4,553 passed, `pnpm -r tsc --noEmit` clean.
