// HTTPServerMainThreadStallTests.swift — HTTPServer's listener must not sit on
// the main queue.
//
// Scope note, because the original version of this file claimed more than it
// could: `HTTPServer.start(port:)` is NOT used by the shipping daemon. The
// daemon's only listener is `WebSocketServer`'s, which delegates plain HTTP to
// `HTTPServer.handle(request:on:)`. So this is a unit test of a currently
// test-only code path, kept so the two listeners cannot drift apart, NOT a
// regression test for the 2026-07-18 outage.
//
// That outage — `/health` unanswered for 5s while WebSocket traffic flowed —
// was caused by HTTP *handlers* dispatching into a `@MainActor` DaemonServer.
// `DaemonActorIndependenceTests` is the regression test for it.

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

        // Served *during* the block, not after it.
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
