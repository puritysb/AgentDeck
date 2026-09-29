#if os(macOS)
// ListenerLeakTests.swift — a listener must not survive the thing that owns it.
//
// #306: a client-mode app held `*:9121 (LISTEN)` with six `CLOSE_WAIT` sockets,
// on a port inside the session-bridge range 9121-9139. It accepted connections
// and answered none of them, because a started `NWListener` is retained by
// Network.framework until it is cancelled while its `newConnectionHandler`
// holds the server weakly — so the orphan outlives its owner and then reaches a
// nil `self` for every socket it accepts.
//
// From the app's own log, 2026-09-09 22:52 (the promotion cycle #305's fix let
// run to completion, which is how this became visible):
//
//   22:52:22  Server listening on port 9121                           ← A ready
//   22:52:22  External daemon on port 9120 is stale — starting local…  ← A clobbered
//   22:52:22  Daemon running on port 9121 — all modules wired         ← A finishes wiring
//   22:52:25  Server listener failed: Address already in use          ← B lands on A's port
//
// `connectToExternalDaemon` had been suspended in a patient health probe while
// `start()` completed a bind and assigned `self.server`; it then wrote the state
// of a daemon that no longer existed and dropped A with `server = nil`.
// `server = nil` is not a teardown — only `shutdown()` cancels the listener.
import XCTest
import Network
@testable import AgentDeck

final class ListenerLeakTests: XCTestCase {

    /// Is anything listening on `port`? A raw connect, so it sees the socket
    /// rather than whether a daemon answers on it — an orphaned listener
    /// accepts and never replies, which is exactly the state this asks about.
    private func isListening(_ port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { return false }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        return rc == 0
    }

    /// `NWListener.cancel()` is asynchronous — it returns before the socket is
    /// gone. Poll rather than assert immediately, or the test measures the
    /// scheduler instead of the fix.
    private func waitUntilNotListening(_ port: UInt16, seconds: Double = 3) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if !isListening(port) { return true }
            try? await Task.sleep(for: .milliseconds(25))
        }
        return !isListening(port)
    }

    /// Two ports nothing is using, well clear of 9120-9139.
    private func freePorts() throws -> (UInt16, UInt16) {
        for base in stride(from: UInt16(19_240), to: UInt16(19_400), by: 2) {
            if !isListening(base) && !isListening(base + 1) { return (base, base + 1) }
        }
        throw XCTSkip("no free port pair for the test")
    }

    func testStartingASecondTimeReleasesTheFirstListener() async throws {
        let (first, second) = try freePorts()
        let server = WebSocketServer()

        try await server.start(port: first)
        XCTAssertTrue(isListening(first), "the first listener must actually be bound")

        // The shape that leaked: the same server told to listen again. `stop()`
        // only ever cancels the CURRENT listener, so without a release at the
        // assignment the first one stays bound with no reference to it.
        try await server.start(port: second)
        XCTAssertTrue(isListening(second), "the second listener must be bound")
        let released = await waitUntilNotListening(first)
        XCTAssertTrue(released, "the replaced listener must have been cancelled, not orphaned")

        await server.stop()
        let stopped = await waitUntilNotListening(second)
        XCTAssertTrue(stopped, "stop() must release the current listener")
    }

    func testAFailedStartLeavesNothingBoundAndNothingAssigned() async throws {
        let (port, _) = try freePorts()
        let holder = WebSocketServer()
        try await holder.start(port: port)
        defer { Task { await holder.stop() } }

        // A second server losing the bind must not leave a listener behind for
        // nobody to cancel: `stop()` is never called on a server that never
        // started.
        let loser = WebSocketServer()
        do {
            try await loser.start(port: port)
            XCTFail("binding an occupied port must throw")
        } catch {
            // expected
        }
        await loser.stop()   // must be a no-op, not a cancel of someone else's listener
        XCTAssertTrue(isListening(port), "the holder's listener must be untouched")
    }
}

/// The decision `connectToExternalDaemon` makes at each of its exits.
///
/// This is a decision test, not a substitute for driving the sequence:
/// `DaemonService.init()` calls `start()` and binds a port, so the service has
/// no test seam and the interleaving above cannot be replayed here. Splitting
/// that initializer is the recorded prerequisite (AGENTS.md).
final class ExternalTransitionStalenessTests: XCTestCase {

    func testATransitionIsStaleOnceANewerDaemonTookOwnership() {
        // `start()` bumps the epoch when it assigns `self.server`. Anything
        // captured before that is describing a daemon that has been replaced.
        XCTAssertTrue(DaemonService.externalTransitionIsStale(entryEpoch: 4, currentEpoch: 5))
        XCTAssertTrue(DaemonService.externalTransitionIsStale(entryEpoch: 0, currentEpoch: 1))
    }

    func testTheOrdinaryTransitionIsNotStale() {
        // Every caller stands its server down before calling, so the epoch does
        // not move: a stand-down, a shutdown handover and a bind failure must
        // all still reach their exits.
        XCTAssertFalse(DaemonService.externalTransitionIsStale(entryEpoch: 0, currentEpoch: 0))
        XCTAssertFalse(DaemonService.externalTransitionIsStale(entryEpoch: 7, currentEpoch: 7))
    }
}
#endif
