# 2026-09-19 — #327 phase 2: lowest-port serial ownership + Swift flash lease

The takeover half of the 2026-09-13 incident: while the Node daemon was
latency-silent at load 600–800, the macOS app promoted a fallback daemon on
9121 and opened the same USB boards — two readers on one TTY steal each
other's bytes instead of failing cleanly, and two flashes corrupted. The
Node flash lease could not have stopped it either: the lease is a file under
`~/.agentdeck`, which the sandboxed Swift daemon cannot read (the lease
module's own documented honest gap).

The Swift serial bridge now decides ownership on every 10 s poll cycle,
before touching a port, via a pure truth table
(`ESP32Serial.ownershipDecision`) pinned by
`SerialOwnershipGuardTests`: a live in-memory suspension (the Swift twin of
the Node lease — same clamp 1…900 s, expiry enforced on read, never by a
timer, a second suspension never shortens a live one) keeps every port
closed and releases held ones; otherwise the LOWEST live daemon port in the
window owns serial, so a fallback hub (9121 while a Node daemon answers on
9120) defers to the incumbent and releases ports it grabbed before the
incumbent reappeared; symmetric on both daemons with no handshake, and
self-healing in both directions because it is re-decided every cycle. The
sibling scan reuses `SessionRegistry.scanForDaemonPort` (mode=daemon only,
foreign daemons excluded, own port excluded). The suspension arrives over
Node-parity HTTP: `POST /esp32/serial/suspend` / `/resume` on the Swift
daemon, with `{ok, until, seconds, released}` / `{ok, wasSuspended}` shapes
matching daemon-server.ts, closing held ports immediately — the only channel
a flashing CLI has to stop THIS daemon, which is what makes a phase-3 port
sweep meaningful. `SerialModule` now takes `daemonPort` (applied in `start()`
before the first poll so no ungated cycle races the guard), mirroring
AdbModule.

Live check on the dev desk (Node daemon 9120 holding all eleven serial
ports): a freshly built dev app launched alongside ran client-mode only, no
fallback on 9121, serial holders unchanged, clean exit. Forced promotion was
deliberately NOT exercised live — flapping an eleven-board fleet to prove a
defense against a load-600 rarity is a bad trade; the truth table and actor
semantics (clamp, monotonic lease, idempotent resume) are unit-pinned
instead. Validation: AgentDeck_macOS and AgentDeck_iOS build clean, new
SerialOwnershipGuardTests 6/6, full macOS suite green except
`CollaborationFeedTests.testRenderCollaborationHistoryAtRailWidth`, which
fails identically on stashed master (pre-existing, collaboration-rail
domain, unrelated). Remaining #327 scope: the CLI port-window suspend sweep
(phase 3) and post-write reset/readback under load (phase 4).
