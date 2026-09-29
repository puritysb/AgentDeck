# 2026-09-19 — Session-order pins: Swift daemon parity (#273)

The Node increment earlier today left the Swift daemon unable to serve the
new session-order pins: while the in-process Swift daemon owned port 9120,
`agentdeck order` hit a 404 and the documented advice was "take the port back
with the Node daemon". That made the replacement daemon-first only in the
narrow sense — a Mac-app user would have had to evict their own daemon to pin
a tab.

Parity is now a deliberate near-transliteration, the pairing-knock precedent
("a rule restated in different words is a rule that can drift").
`apple/AgentDeck/Daemon/Session/SessionOrderStore.swift` reads and writes the
SAME `session-order.json` (unsandboxed dev builds resolve
`AgentDeckPaths.baseDirectory` to `~/.agentdeck`, the exact file Node uses;
the App Store sandbox writes a container-local copy, the same asymmetry its
`daemon.json`/`timeline.json` already carry), keys pins on the bare id via
`ObservedAgentRules.rawSessionId`, and implements the identical precedence —
observed rows without their own weight only, weight 0 is a clear.
`DaemonServer` overlays pins in `refreshSessions` before fold+sort and in
`upsertIntoCachedSessions` so a hook-minted observed row carries its pin
immediately, and serves `GET/POST /sessions/order` with byte-compatible
response shapes (the route handlers box payloads in `SendableDict` to cross
the `@DaemonActor` boundary under Swift 6).

The TTL (30 days unseen) and the pin cap (256) were Node-local constants
before this; they are now a cross-daemon file contract single-sourced in
`shared/src/session-utils.ts` (`SESSION_ORDER_TTL_MS` /
`MAX_SESSION_ORDER_PINS`) and emitted to Swift/Kotlin by the existing
`pnpm generate-session-weight-rules` generator, whose drift test now pins
them — a pin must not live 30 days under one daemon and 7 under the other.
The SSOT catalogue in docs/architecture.md gained the previously missing row.

Validation: 15 new XCTest cases in `SessionOrderStoreTests.swift` mirror the
TS suite (both id forms, 0-clears, clamping, restart round-trip, the
cross-daemon JSON shape asserted structurally, corrupt-file tolerance, TTL
GC, cap eviction, noteSeen throttling, overlay precedence, prefix resolution,
weight validation) — AgentDeckTests_macOS fully green, iOS target builds
(the store is `#if os(macOS)` like its sibling SessionRegistry.swift), and
the Node suite re-run green after the SSOT move. The live cross-daemon
handover (pin under Node → Swift serves it, and back) is exercised
structurally here; the real-user tab-to-deck scenario remains the open #273
gate and must run on a merged build, not a worktree daemon.
