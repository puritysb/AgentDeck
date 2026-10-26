#if os(macOS)
import XCTest
@testable import AgentDeck

/// Drive the real service through its scheduled retry. The health continuation
/// deliberately ignores cancellation, like a late network callback can.
final class ExternalAttachRetryTests: XCTestCase {
    @MainActor
    func testStopRejectsAnAlreadyRunningRetryHealthResponse() async {
        let probe = DelayedExternalHealth()
        let service = probe.makeService()
        let unexpectedReady = expectation(description: "stopped service must not become ready")
        unexpectedReady.isInverted = true
        service.onReady = { _ in unexpectedReady.fulfill() }
        await service.connectToExternalDaemon(port: probe.oldPort)
        await fulfillment(of: [probe.retryHealthStarted], timeout: 2)

        await service.stop()
        probe.finish(succeeded: true)
        await fulfillment(of: [unexpectedReady], timeout: 0.2)
        XCTAssertFalse(service.isRunning)
        XCTAssertFalse(service.isUsingExternalDaemon)
        XCTAssertEqual(service.port, 0)
        await service.stop()
    }

    @MainActor
    func testStoppedRetryCannotProbeOrScheduleAgainAfterDelayedFailure() async {
        let probe = DelayedExternalHealth()
        let service = probe.makeService()
        await service.connectToExternalDaemon(port: probe.oldPort)
        await fulfillment(of: [probe.retryHealthStarted], timeout: 2)
        let portProbes = probe.portProbes
        let retryDelays = probe.retryDelays

        await service.stop()
        probe.finish(succeeded: false)
        // Give the resumed task an actor turn; a stale nil result must not even
        // enter the TCP liveness/retry branch.
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(probe.portProbes, portProbes)
        XCTAssertEqual(probe.retryDelays, retryDelays)
        XCTAssertEqual(service.port, 0)
        await service.stop()
    }

    @MainActor
    func testNewPortIntentSurvivesADelayedOldPortRetry() async {
        let probe = DelayedExternalHealth()
        let service = probe.makeService()
        var ready: [String] = []
        service.onReady = { ready.append($0) }
        await service.connectToExternalDaemon(port: probe.oldPort)
        await fulfillment(of: [probe.retryHealthStarted], timeout: 2)

        // A new endpoint also supersedes a probe without a stop or a change to
        // the in-process daemon epoch.
        let newPort = AppPreferences.shared.daemonPort
        await service.connectToExternalDaemon(port: newPort)
        XCTAssertEqual(ready, ["ws://127.0.0.1:\(newPort)"])
        probe.finish(succeeded: true)
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(ready, ["ws://127.0.0.1:\(newPort)"])
        XCTAssertEqual(service.port, UInt16(newPort))
        XCTAssertTrue(service.isUsingExternalDaemon)
        await service.stop()
    }
}

@MainActor
private final class DelayedExternalHealth {
    let oldPort = 49_151
    let retryHealthStarted = XCTestExpectation(description: "retry is suspended inside health probe")
    private var continuation: CheckedContinuation<Bool, Never>?
    private(set) var retryDelays = 0
    private(set) var portProbes = 0
    static var healthy: [String: Any] { ["mode": "daemon", "isSwift": false] }

    func makeService() -> DaemonService {
        DaemonService(automaticallyStart: false, externalAttach: dependencies,
            healthMonitor: .init(probeHealth: { _, _ in nil }, portStatus: { _ in .unknown }))
    }

    var dependencies: DaemonService.ExternalAttachDependencies {
        .init(registeredPort: { nil }, probeHealth: { [self] port in
            guard port == oldPort else { return Self.healthy }
            guard retryDelays > 0 else { return nil }
            let succeeded = await withCheckedContinuation {
                continuation = $0
                retryHealthStarted.fulfill()
            }
            return succeeded ? Self.healthy : nil
        }, portStatus: { [self] _ in
            portProbes += 1
            return .listening
        }, retryDelay: { [self] in
            retryDelays += 1
            // A buggy post-stop retry cannot spin indefinitely in the fixture.
            if retryDelays > 1 { try await Task.sleep(for: .seconds(60)) }
        })
    }

    func finish(succeeded: Bool) {
        let pending = continuation
        continuation = nil
        pending?.resume(returning: succeeded)
    }
}
#endif
