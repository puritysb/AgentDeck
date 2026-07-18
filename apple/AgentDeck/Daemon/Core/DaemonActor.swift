#if os(macOS)
// DaemonActor.swift — the executor the in-process daemon runs on.
//
// The daemon used to be `@MainActor`, which meant SwiftUI rendering and daemon
// service shared one executor: a saturated main runloop starved the daemon
// (measured 2026-07-18 — `/health` unanswered for 5s, log stalled 24 minutes,
// process alive the whole time).
//
// This is a *global* actor rather than making `DaemonServer` an `actor`
// because the daemon is not one object. `StateMachine`, `ModuleManager`,
// `ApmeCollector` and friends hold daemon state too, and their callers use
// synchronous value-returning methods (`transition() -> Bool`,
// `activeTaskId`) and pass non-Sendable dictionaries. Making each an
// independent `actor` would force `await` across ~105 call sites and put a
// Sendable boundary where none is wanted; leaving them as plain classes leaves
// them with no isolation to inherit, so `Task {}` inside their methods becomes
// a concurrent context (this is exactly what broke `resetStuckTimer`).
//
// A shared global actor gives all of them one nameable isolation: calls
// between them stay synchronous, `Task {}` inside their methods inherits the
// daemon's executor just as it used to inherit the main actor's, and the
// compiler still enforces that nothing leaks across the boundary.
//
// The rule: anything that holds daemon state is `@DaemonActor`. UI-facing
// types stay `@MainActor` and are reached with `await`.
@globalActor
actor DaemonActor {
    static let shared = DaemonActor()

    /// Mirror of `MainActor.run` for the daemon's executor: run a body on
    /// `DaemonActor` from a nonisolated context (HTTP route handlers, module
    /// callbacks) and hand the result back. The daemon's `MainActor.run` sites
    /// became these — same shape, different executor.
    @DaemonActor
    static func run<T>(
        resultType: T.Type = T.self,
        body: @DaemonActor () throws -> T
    ) async rethrows -> T {
        try body()
    }
}
#endif
