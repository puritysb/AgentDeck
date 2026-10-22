#if os(macOS)
import XCTest
@testable import AgentDeck

/// Exercise DaemonService itself with operations that deliberately ignore task
/// cancellation. No real server, listener, registry or preferences are changed.
final class LocalDaemonStartupTests: XCTestCase {
    @MainActor
    func testStopWhileFactoryIsSuspendedDiscardsTheLateUnstartedDaemon() async {
        let daemon = await StartupRuntime(name: "old", port: 49_150)
        let fixture = LocalStartupFixture(daemons: [daemon], delayedFactories: [0])
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [fixture.factoryEntered[0]], timeout: 2)

        await stopWithDeadline(service)
        fixture.finishFactory(0)
        await fulfillment(of: [fixture.factoryReturned[0]], timeout: 2)
        await settleCallbacks()

        let counts = await daemon.counts
        XCTAssertEqual(counts.starts, 0)
        // Construction has no service resources: shutting down a daemon that
        // was never owned could itself disturb the next daemon's shared state.
        XCTAssertEqual(counts.shutdowns, 0)
        XCTAssertEqual(fixture.readyURLs, [])
        assertStopped(service)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testRestartDuringFactoryUsesLatestConfigurationAndRetainsNewStartGuard() async {
        let old = await StartupRuntime(name: "old", port: 49_150)
        let latest = await StartupRuntime(name: "latest", port: 49_151)
        let fixture = LocalStartupFixture(daemons: [old, latest], delayedFactories: [0, 1])
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [fixture.factoryEntered[0]], timeout: 2)

        fixture.configuredPort = 49_151
        fixture.posture = .init(loopbackOnly: true, noDeviceModules: true)
        await restartWithDeadline(service)
        await fulfillment(of: [fixture.factoryEntered[1]], timeout: 2)

        // The obsolete task reaches its defer while its replacement is still
        // awaiting construction. It must not clear the replacement's guard.
        fixture.finishFactory(0)
        await fulfillment(of: [fixture.factoryReturned[0]], timeout: 2)
        await settleCallbacks()
        service.start()
        await settleCallbacks()
        XCTAssertEqual(fixture.requests.count, 2)
        XCTAssertEqual(fixture.requests.last?.port, 49_151)
        XCTAssertEqual(fixture.requests.last?.posture, fixture.posture)

        fixture.finishFactory(1)
        await fulfillment(of: [fixture.ready], timeout: 2)
        assertOwned(service, port: latest.port)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49151"])
        let oldCounts = await old.counts
        let latestCounts = await latest.counts
        XCTAssertEqual(oldCounts.starts, 0)
        XCTAssertEqual(oldCounts.shutdowns, 0)
        XCTAssertEqual(latestCounts.starts, 1)
        XCTAssertEqual(latestCounts.shutdowns, 0)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testStopDuringServicesRejectsLateReadinessAndSuccessfulCompletion() async {
        let daemon = await StartupRuntime(name: "old", port: 49_150, suspendStart: true)
        let fixture = LocalStartupFixture(daemons: [daemon])
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [daemon.startEntered], timeout: 2)

        let stopped = expectation(description: "stop joins services and shutdown")
        var didStop = false
        Task { @MainActor in
            await service.stop()
            didStop = true
            stopped.fulfill()
        }
        await settleCallbacks()
        assertStopped(service)
        XCTAssertFalse(didStop, "stop must await the still-running services task")
        await daemon.emitReady()
        await daemon.finishStart()
        await fulfillment(of: [daemon.startReturned, stopped], timeout: 2)
        await settleCallbacks()

        let counts = await daemon.counts
        XCTAssertEqual(counts.starts, 1)
        XCTAssertEqual(counts.shutdowns, 1)
        XCTAssertEqual(fixture.readyURLs, [])
        XCTAssertEqual(fixture.externalProbes, 0)
        assertStopped(service)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testRestartWaitsForOldShutdownAndIgnoresLateReadyAndStartupError() async {
        let journal = await StartupJournal()
        let old = await StartupRuntime(name: "old", port: 49_150,
                                       suspendStart: true, suspendShutdown: true, journal: journal)
        let latest = await StartupRuntime(name: "latest", port: 49_151, journal: journal)
        let fixture = LocalStartupFixture(daemons: [old, latest])
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startEntered], timeout: 2)

        fixture.configuredPort = 49_151
        let restarted = expectation(description: "restart finishes after old shutdown")
        Task { @MainActor in
            await service.restart()
            restarted.fulfill()
        }
        await settleCallbacks()
        assertStopped(service)
        XCTAssertEqual(fixture.requests.count, 1, "replacement must wait for teardown")
        let pendingCounts = await latest.counts
        XCTAssertEqual(pendingCounts.starts, 0)
        let oldPendingCounts = await old.counts
        XCTAssertEqual(oldPendingCounts.shutdowns, 0, "shutdown must wait for startup to leave its suspension")

        await old.emitReady()
        await old.finishStart(throwing: StartupTestError.lateFailure)
        await fulfillment(of: [old.startReturned, old.shutdownEntered], timeout: 2)
        XCTAssertEqual(fixture.requests.count, 1, "replacement must also wait for shutdown completion")
        XCTAssertEqual(fixture.readyURLs, [])

        await old.finishShutdown()
        await fulfillment(of: [restarted, fixture.ready], timeout: 2)
        await settleCallbacks()

        assertOwned(service, port: latest.port)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49151"])
        XCTAssertEqual(fixture.requests.count, 2)
        XCTAssertEqual(fixture.externalProbes, 0)
        XCTAssertNil(service.errorMessage)
        let events = await journal.events
        let oldShutdown = events.firstIndex(of: "old:shutdown-finished")
        let newStart = events.firstIndex(of: "latest:start")
        XCTAssertNotNil(oldShutdown)
        XCTAssertNotNil(newStart)
        if let oldShutdown, let newStart { XCTAssertLessThan(oldShutdown, newStart) }
        let oldCounts = await old.counts
        let latestCounts = await latest.counts
        XCTAssertEqual(oldCounts.shutdowns, 1, "late failure must not repeat old teardown")
        XCTAssertEqual(latestCounts.shutdowns, 0, "late failure must not release the replacement")
        await fixture.cleanUp(service)
    }

    @MainActor
    func testStopSupersedesARestartWaitingForOldStartupAndShutdown() async {
        let old = await StartupRuntime(name: "old", port: 49_150,
                                       suspendStart: true, suspendShutdown: true)
        let latest = await StartupRuntime(name: "latest", port: 49_151)
        let fixture = LocalStartupFixture(daemons: [old, latest])
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startEntered], timeout: 2)

        fixture.configuredPort = 49_151
        let restarted = expectation(description: "superseded restart finishes without starting")
        Task { @MainActor in
            await service.restart()
            restarted.fulfill()
        }
        await settleCallbacks()
        let stopped = expectation(description: "newer stop joins the existing teardown")
        var didStop = false
        Task { @MainActor in
            await service.stop()
            didStop = true
            stopped.fulfill()
        }
        await settleCallbacks()
        assertStopped(service)
        XCTAssertFalse(didStop, "a second stop must join the existing teardown")
        XCTAssertEqual(fixture.requests.count, 1)

        await old.emitReady()
        await old.finishStart()
        await fulfillment(of: [old.startReturned, old.shutdownEntered], timeout: 2)
        XCTAssertEqual(fixture.requests.count, 1)
        await old.finishShutdown()
        await fulfillment(of: [restarted, stopped], timeout: 2)
        await settleCallbacks()

        assertStopped(service)
        XCTAssertEqual(fixture.requests.count, 1, "an old restart must not override the latest stop")
        XCTAssertEqual(fixture.readyURLs, [])
        XCTAssertEqual(fixture.externalProbes, 0)
        let oldCounts = await old.counts
        let latestCounts = await latest.counts
        XCTAssertEqual(oldCounts.shutdowns, 1, "overlapping callers must share the teardown")
        XCTAssertEqual(latestCounts.starts, 0)
        XCTAssertEqual(latestCounts.shutdowns, 0)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testTeardownTimeoutBlocksReplacementUntilOldServicesAndShutdownActuallyFinish() async {
        let old = await StartupRuntime(name: "old", port: 49_150,
                                       suspendStart: true, suspendShutdown: true)
        let latest = await StartupRuntime(name: "latest", port: 49_151)
        let fixture = LocalStartupFixture(daemons: [old, latest])
        fixture.teardownTimeout = 0.05
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startEntered], timeout: 2)

        fixture.configuredPort = 49_151
        await restartWithDeadline(service)
        assertStopped(service)
        XCTAssertNotNil(service.errorMessage, "a timed-out teardown must remain visible and recoverable")
        XCTAssertEqual(fixture.requests.count, 1, "timeout must not authorize overlapping services")
        XCTAssertEqual(fixture.readyURLs, [])
        let pendingCounts = await latest.counts
        XCTAssertEqual(pendingCounts.starts, 0)

        await old.emitReady()
        await old.finishStart()
        await fulfillment(of: [old.startReturned, old.shutdownEntered], timeout: 2)
        XCTAssertEqual(fixture.requests.count, 1, "startup completion alone does not complete teardown")
        await old.finishShutdown()
        await settleCallbacks()
        assertStopped(service)
        XCTAssertEqual(fixture.requests.count, 1, "late teardown must not silently revive the timed-out restart")

        service.start()
        await fulfillment(of: [fixture.ready], timeout: 2)
        assertOwned(service, port: latest.port)
        XCTAssertEqual(fixture.requests.count, 2)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49151"])
        XCTAssertEqual(fixture.externalProbes, 0)
        XCTAssertNil(service.errorMessage)
        let oldCounts = await old.counts
        let latestCounts = await latest.counts
        XCTAssertEqual(oldCounts.shutdowns, 1)
        XCTAssertEqual(latestCounts.starts, 1)
        XCTAssertEqual(latestCounts.shutdowns, 0)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testReplacedDaemonCallbacksCannotChangeTheCurrentOwner() async {
        let old = await StartupRuntime(name: "old", port: 49_150)
        let latest = await StartupRuntime(name: "latest", port: 49_151)
        let fixture = LocalStartupFixture(daemons: [old, latest], expectedReadyCount: 2)
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startReturned], timeout: 2)

        fixture.configuredPort = 49_151
        await restartWithDeadline(service)
        await fulfillment(of: [fixture.ready], timeout: 2)
        // The fake retains the originally installed closures even when stop
        // detaches them, modeling callbacks already enqueued by the old server.
        await old.emitRetiredShutdown()
        await settleCallbacks()
        assertOwned(service, port: latest.port)
        await old.emitRetiredListenerFailure()
        await settleCallbacks()
        assertOwned(service, port: latest.port)
        await old.emitRetiredStandDown()
        await old.emitReady()
        await settleCallbacks()

        assertOwned(service, port: latest.port)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49150", "ws://127.0.0.1:49151"])
        XCTAssertEqual(fixture.requests.count, 2)
        XCTAssertEqual(fixture.externalProbes, 0)
        XCTAssertNil(service.errorMessage)
        let oldCounts = await old.counts
        let latestCounts = await latest.counts
        XCTAssertEqual(oldCounts.shutdowns, 1)
        XCTAssertEqual(latestCounts.shutdowns, 0)
        await fixture.cleanUp(service)
    }

    @MainActor
    private func assertStopped(_ service: DaemonService, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(service.ownership, .none, file: file, line: line)
        XCTAssertFalse(service.isRunning, file: file, line: line)
        XCTAssertFalse(service.isUsingExternalDaemon, file: file, line: line)
        XCTAssertEqual(service.port, 0, file: file, line: line)
    }

    @MainActor
    private func assertOwned(_ service: DaemonService, port: UInt16,
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(service.ownership, .selfOwned, file: file, line: line)
        XCTAssertTrue(service.isSelfDaemon, file: file, line: line)
        XCTAssertFalse(service.isUsingExternalDaemon, file: file, line: line)
        XCTAssertEqual(service.port, port, file: file, line: line)
    }

    @MainActor
    private func stopWithDeadline(_ service: DaemonService) async {
        let stopped = expectation(description: "stop completes despite suspended startup")
        Task { @MainActor in
            await service.stop()
            stopped.fulfill()
        }
        await fulfillment(of: [stopped], timeout: 2)
    }

    @MainActor
    private func restartWithDeadline(_ service: DaemonService) async {
        let restarted = expectation(description: "restart supersedes suspended startup")
        Task { @MainActor in
            await service.restart()
            restarted.fulfill()
        }
        await fulfillment(of: [restarted], timeout: 2)
    }

    /// Positive milestones use bounded expectations. This short quiet window
    /// allows callbacks that must do nothing to reach the main actor.
    @MainActor
    private func settleCallbacks() async {
        try? await Task.sleep(for: .milliseconds(50))
    }
}

@MainActor
private final class LocalStartupFixture {
    struct Request {
        let port: Int?
        let posture: DaemonPosture
    }

    var configuredPort = 49_150
    var posture = DaemonPosture.open
    var teardownTimeout: TimeInterval = 8
    let factoryEntered: [XCTestExpectation]
    let factoryReturned: [XCTestExpectation]
    let ready = XCTestExpectation(description: "current daemon publishes dashboard readiness")
    private(set) var requests: [Request] = []
    private(set) var readyURLs: [String] = []
    private(set) var externalProbes = 0
    private let daemons: [StartupRuntime]
    private let delayedFactories: Set<Int>
    private var pendingFactories: [Int: CheckedContinuation<Void, Never>] = [:]

    init(daemons: [StartupRuntime], delayedFactories: Set<Int> = [], expectedReadyCount: Int = 1) {
        self.daemons = daemons
        self.delayedFactories = delayedFactories
        factoryEntered = daemons.indices.map { XCTestExpectation(description: "factory \($0) entered") }
        factoryReturned = daemons.indices.map { XCTestExpectation(description: "factory \($0) returned") }
        ready.expectedFulfillmentCount = expectedReadyCount
    }

    func makeService() -> DaemonService {
        let service = DaemonService(automaticallyStart: false, externalAttach: .init(
            probeHealth: { [self] _ in externalProbes += 1; return nil },
            portStatus: { [self] _ in externalProbes += 1; return .unknown },
            retryDelay: { throw CancellationError() }
        ), localStartup: .init(teardownTimeout: teardownTimeout, configuration: { [self] in
            .init(port: configuredPort, posture: posture)
        }, makeDaemon: { [self] port, posture in
            let index = requests.count
            requests.append(.init(port: port, posture: posture))
            guard daemons.indices.contains(index) else {
                XCTFail("unexpected duplicate daemon construction")
                throw StartupTestError.unexpectedFactory
            }
            if delayedFactories.contains(index) {
                await withCheckedContinuation {
                    pendingFactories[index] = $0
                    factoryEntered[index].fulfill()
                }
            } else {
                factoryEntered[index].fulfill()
            }
            factoryReturned[index].fulfill()
            return daemons[index]
        }))
        service.onReady = { [self] url in
            readyURLs.append(url)
            ready.fulfill()
        }
        return service
    }

    func finishFactory(_ index: Int) {
        pendingFactories.removeValue(forKey: index)?.resume()
    }

    func cleanUp(_ service: DaemonService) async {
        for index in Array(pendingFactories.keys) { finishFactory(index) }
        for daemon in daemons {
            await daemon.finishStart()
            await daemon.finishShutdown()
        }
        await service.stop()
    }
}

private enum StartupTestError: Error {
    case lateFailure, unexpectedFactory
}

@DaemonActor
private final class StartupJournal {
    var events: [String] = []
}

@DaemonActor
private final class StartupRuntime: InProcessDaemonRuntime {
    struct Counts: Sendable {
        let starts: Int
        let shutdowns: Int
    }

    nonisolated let port: UInt16
    nonisolated let startEntered = XCTestExpectation(description: "services entered")
    nonisolated let startReturned = XCTestExpectation(description: "services returned")
    nonisolated let shutdownEntered = XCTestExpectation(description: "shutdown entered")
    var counts: Counts { .init(starts: startCount, shutdowns: shutdownCount) }
    private let name: String
    private let journal: StartupJournal?
    private var suspendStart: Bool
    private var suspendShutdown: Bool
    private var startCount = 0
    private var shutdownCount = 0
    private var pendingStart: CheckedContinuation<Void, any Error>?
    private var pendingShutdown: [CheckedContinuation<Void, Never>] = []
    private var readyHandler: (@Sendable () async -> Void)?
    private var retiredShutdownHandler: (@Sendable () -> Void)?
    private var retiredStandDownHandler: (@Sendable () -> Void)?
    private var retiredListenerFailureHandler: (@Sendable (Error) -> Void)?

    init(name: String, port: UInt16, suspendStart: Bool = false, suspendShutdown: Bool = false,
         journal: StartupJournal? = nil) {
        self.name = name
        self.port = port
        self.suspendStart = suspendStart
        self.suspendShutdown = suspendShutdown
        self.journal = journal
    }

    func setShutdownHandler(_ handler: (@Sendable () -> Void)?) {
        if let handler { retiredShutdownHandler = handler }
    }

    func setStandDownRequestedHandler(_ handler: (@Sendable () -> Void)?) {
        if let handler { retiredStandDownHandler = handler }
    }

    func setListenerFailedHandler(_ handler: @escaping @Sendable (Error) -> Void) async {
        retiredListenerFailureHandler = handler
    }

    func startServices(onDashboardReady: (@Sendable () async -> Void)?) async throws {
        startCount += 1
        journal?.events.append("\(name):start")
        readyHandler = onDashboardReady
        defer { startReturned.fulfill() }
        if suspendStart {
            try await withCheckedThrowingContinuation {
                pendingStart = $0
                startEntered.fulfill()
            }
        } else {
            startEntered.fulfill()
        }
        await onDashboardReady?()
    }

    func shutdown() async {
        shutdownCount += 1
        journal?.events.append("\(name):shutdown-started")
        if suspendShutdown {
            await withCheckedContinuation {
                pendingShutdown.append($0)
                if shutdownCount == 1 { shutdownEntered.fulfill() }
            }
        } else if shutdownCount == 1 {
            shutdownEntered.fulfill()
        }
        journal?.events.append("\(name):shutdown-finished")
    }

    func finishStart(throwing error: (any Error)? = nil) {
        suspendStart = false
        let pending = pendingStart
        pendingStart = nil
        if let error { pending?.resume(throwing: error) }
        else { pending?.resume() }
    }

    func finishShutdown() {
        suspendShutdown = false
        let pending = pendingShutdown
        pendingShutdown.removeAll()
        pending.forEach { $0.resume() }
    }

    func emitReady() async { await readyHandler?() }
    func emitRetiredShutdown() { retiredShutdownHandler?() }
    func emitRetiredStandDown() { retiredStandDownHandler?() }
    func emitRetiredListenerFailure() { retiredListenerFailureHandler?(StartupTestError.lateFailure) }
    func reconnectGatewayAdapter() {}
    func refreshZaiUsage(configurationChanged: Bool) async -> Bool { false }
    func deviceStatusSnapshots() async -> DaemonServer.DeviceStatusSnapshots {
        .init(d200h: nil, pixoo: nil, serial: nil, adb: nil)
    }
}
#endif
