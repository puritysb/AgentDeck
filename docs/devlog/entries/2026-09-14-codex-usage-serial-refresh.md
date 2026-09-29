# 2026-09-14 — Codex reset visibility and Swift USB usage refresh

The user reported TTGO stuck at 86% while other dashboards showed 100% after
redeeming a Codex usage-reset credit. A read-only Codex account query returned
weekly usedPercent 0. The active hub was the macOS Swift daemon on port 9120,
not the Node daemon. During diagnosis its /usage response also reached 0%
after a new rollout snapshot appeared (capturedAt 2026-09-13T15:57:22.602Z).
This confirms the account reset and subsequent passive refresh; it does not
prove the physical TTGO panel updated.

Swift serial heartbeats still required Claude fiveHourPercent before sending
any usage_update. USB boards therefore missed Codex-only updates and quota
retirement snapshots. Remove that provider-specific gate, and keep the daemon
usage tick updating its serial snapshot even with no WebSocket clients.
Heartbeat composition tests cover 86 → 100 → 0 without Claude, empty retirement,
and preservation of state/session/display snapshots.

The standalone Swift daemon still reads Codex quota from local rollouts. This
fix does not add a live account reader: a coupon reset or usage on another host
can remain invisible until a new local rate_limits record arrives. Do not
fabricate a zero from age, a reconnect, or a reset countdown. The Node daemon's
existing live account query is a distinct capability.

Local evidence: diagnostics/apple-xcode/20260914-005651 in the main checkout.
No firmware changes or device flashes are part of this fix.

Verification: build and typecheck pass; Vitest 4,494 passed, one skipped;
macOS ESP32WifiForwardTests 14 passed. Protocol generation has no drift;
token, docs, catalog and devlog checks pass. Clean-source design lint matches
the base exactly (89 pre-existing findings). The Debug app passes codesign
verification; the distribution archive guard rejects it as expected for a
Debug/development build (preview/debug dylibs and development certificate).
This is not a release archive or a store submission.

Local application: the old /Applications app did not exit on SIGTERM or a
bounded AppleEvent quit, so its confirmed process was terminated and the signed
Debug app launched from the isolated DerivedData directory. PID 70067 serves
9120; all 11 USB connections returned. TTGO reports fresh RX/TX and zero write
backpressure; /usage reports Codex 7d 1% as further sessions run. Physical panel
readback remains unverified. The installed /Applications app is unchanged;
this local run does not make the fix persistent in the store distribution.
