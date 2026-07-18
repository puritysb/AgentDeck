// DaemonActorIndependenceTests.swift — the point of moving the daemon off
// @MainActor, expressed as an assertion.
//
// The daemon is hosted inside the GUI app. While it was `@MainActor`, SwiftUI
// rendering and daemon service shared one executor, so a saturated main runloop
// starved the daemon: measured 2026-07-18, `/health` went unanswered for 5s and
// the daemon log stalled for 24 minutes while the process stayed alive.
//
// `HTTPServerMainThreadStallTests` covers the transport half (accept must not
// sit on the main queue). This covers the other half: work isolated to
// `DaemonActor` has to make progress while the main thread is completely busy.
// Against the old `@MainActor` daemon this test cannot pass — the body could
// not start until the main thread freed up.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class DaemonActorIndependenceTests: XCTestCase {
    /// Long enough that a main-actor-bound daemon is unambiguously stalled.
    private let mainThreadBlockSeconds: TimeInterval = 3.0
    /// Delay before the daemon work starts, so it lands mid-block.
    private let workDelaySeconds: TimeInterval = 0.25

    func testDaemonActorWorkProceedsWhileMainThreadIsBlocked() throws {
        // `Thread.isMainThread` is unavailable from async contexts; pthread's
        // check is the same question without the isolation annotation.
        let done = DispatchSemaphore(value: 0)
        let elapsed = UncheckedBox<TimeInterval>(-1)
        let ranOffMain = UncheckedBox<Bool>(false)

        // Hoist to locals — capturing `self` would send the test case across
        // the isolation boundary.
        let delayMs = Int(workDelaySeconds * 1000)
        let started = Date()
        Task { @DaemonActor in
            try? await Task.sleep(for: .milliseconds(delayMs))
            // Touch a DaemonActor-isolated declaration so this genuinely
            // requires the daemon's executor rather than any free thread.
            _ = DaemonServer.closeApmeTaskExternal(
                gateway: nil, claude: nil,
                sessionId: nil, boundarySignal: "probe", outcome: nil
            )
            ranOffMain.value = pthread_main_np() == 0
            elapsed.value = Date().timeIntervalSince(started)
            done.signal()
        }

        // Pin the main thread without servicing the runloop, the way a stuck
        // render loop does.
        let blockUntil = Date().addingTimeInterval(mainThreadBlockSeconds)
        while Date() < blockUntil { /* busy-wait on purpose */ }

        XCTAssertEqual(done.wait(timeout: .now() + 10), .success, "daemon work never completed")
        XCTAssertTrue(ranOffMain.value, "daemon work must not run on the main thread")

        // The decisive assertion: it finished *during* the block. A
        // main-actor-isolated daemon parks at ~mainThreadBlockSeconds.
        let budget = mainThreadBlockSeconds - workDelaySeconds
        XCTAssertLessThan(
            elapsed.value, budget,
            "daemon work took \(elapsed.value)s — it waited for the main thread instead of running on DaemonActor"
        )
    }
}

/// Minimal mutable cell for escaping closures; ordering is enforced by the
/// semaphore above.
private final class UncheckedBox<T>: @unchecked Sendable {
    var value: T
    init(_ value: T) { self.value = value }
}
#endif
