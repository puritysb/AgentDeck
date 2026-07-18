// HTTPServerMainThreadStallTests.swift — regression for the daemon going
// unreachable while the app's main thread is busy.
//
// Bug context: the Swift daemon is hosted inside the GUI app, so the main
// queue also drives SwiftUI rendering. `HTTPServer` started its NWListener
// and every per-connection NWConnection with `queue: .main` (present since
// the daemon's first commit, never revisited). A saturated main runloop —
// observed in a Debug build whose Terrarium animation ran under Metal API
// Validation + Xcode queue debugging — therefore stopped the server from
// *accepting* at all: `/health` returned nothing for 5s straight while the
// process was still alive and WebSocket traffic (on its own `ioQueue`) kept
// flowing. Fix was to give HTTPServer its own `dev.agentdeck.http.io` queue,
// mirroring WebSocketServer.
//
// This test blocks the main thread outright and asserts a request issued
// during the block is answered before the block ends. Against the old
// `queue: .main` code the connection cannot be accepted until the main
// thread frees up, so the elapsed time collapses onto the block duration
// and the assertion fails.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class HTTPServerMainThreadStallTests: XCTestCase {
    /// Long enough that a main-queue-bound listener is unambiguously stalled,
    /// short enough to keep the suite fast.
    private let mainThreadBlockSeconds: TimeInterval = 3.0
    /// Delay before firing the request, so it lands while main is already spinning.
    private let requestDelaySeconds: TimeInterval = 0.25

    func testHealthIsServedWhileMainThreadIsBlocked() throws {
        let port: UInt16 = 19137
        let server = HTTPServer()

        // --- start the server (main blocks only until it is listening) ---
        let ready = DispatchSemaphore(value: 0)
        let startFailure = UncheckedBox<Error?>(nil)
        Task {
            await server.get("/health") { _ in
                HTTPServer.HTTPResponse.json(["ok": true])
            }
            do {
                try await server.start(port: port)
            } catch {
                startFailure.value = error
            }
            ready.signal()
        }
        XCTAssertEqual(ready.wait(timeout: .now() + 10), .success, "HTTPServer did not finish starting")
        if let error = startFailure.value {
            throw XCTSkip("port \(port) unavailable on this machine: \(error)")
        }
        defer { Task { await server.stop() } }

        // --- issue the request off-main while main is pinned ---
        let done = DispatchSemaphore(value: 0)
        let status = UncheckedBox<Int>(-1)
        let elapsed = UncheckedBox<TimeInterval>(-1)

        DispatchQueue.global(qos: .userInitiated).async { [requestDelaySeconds] in
            Thread.sleep(forTimeInterval: requestDelaySeconds)
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
            request.timeoutInterval = 10
            let started = Date()
            let inner = DispatchSemaphore(value: 0)
            URLSession.shared.dataTask(with: request) { _, response, _ in
                status.value = (response as? HTTPURLResponse)?.statusCode ?? -1
                elapsed.value = Date().timeIntervalSince(started)
                inner.signal()
            }.resume()
            _ = inner.wait(timeout: .now() + 15)
            done.signal()
        }

        // --- saturate the main thread: spin without servicing the runloop ---
        let blockUntil = Date().addingTimeInterval(mainThreadBlockSeconds)
        while Date() < blockUntil {
            // Busy-wait on purpose. Anything pinned to the main queue is stuck
            // here for the whole window, exactly as under the render loop.
        }

        XCTAssertEqual(done.wait(timeout: .now() + 15), .success, "request never completed")
        XCTAssertEqual(status.value, 200, "expected HTTP 200 from /health")

        // The decisive assertion: served *during* the block, not after it.
        // Old behaviour parks at ~mainThreadBlockSeconds - requestDelaySeconds.
        let budget = mainThreadBlockSeconds - requestDelaySeconds
        XCTAssertLessThan(
            elapsed.value, budget,
            "/health took \(elapsed.value)s — it waited for the main thread instead of being served on the HTTP I/O queue"
        )
    }
}

/// Minimal mutable cell for passing results out of escaping closures. Access is
/// ordered by the semaphores above, so no additional synchronisation is needed.
private final class UncheckedBox<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
#endif
