#if os(macOS)
import XCTest
import Network
import Combine
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
    func testDelayedStandDownAttachesAndHealthMonitorPromotesOnTheNextPeerExit() async {
        let old = await StartupRuntime(name: "old", port: 49_150, suspendShutdown: true)
        let next = await StartupRuntime(name: "next", port: 49_150)
        let fixture = LocalStartupFixture(daemons: [old, next], expectedReadyCount: 3)
        fixture.teardownTimeout = 0.05
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startReturned], timeout: 2)

        service.standDownForTakeover()
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)
        assertStopped(service)
        XCTAssertEqual(fixture.externalProbes, 0, "attachment must wait for actual shutdown")
        XCTAssertEqual(fixture.requests.count, 1)

        await old.finishShutdown()
        await waitForClient(service)
        XCTAssertEqual(service.port, 49_150)
        XCTAssertNil(service.errorMessage)
        XCTAssertEqual(fixture.readyURLs.count, 2)

        // Drive the real monitor, not a direct call to start(). Its three
        // health misses and refused TCP probe must perform the next promotion.
        fixture.monitorPortStatus = .notListening
        await fulfillment(of: [fixture.ready], timeout: 2)
        assertOwned(service, port: next.port)
        XCTAssertGreaterThanOrEqual(fixture.monitorHealthProbes, 3)
        XCTAssertEqual(fixture.requests.count, 2)
        let oldCounts = await old.counts
        let nextCounts = await next.counts
        XCTAssertEqual(oldCounts.shutdowns, 1)
        XCTAssertEqual(nextCounts.starts, 1)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testStopCancelsDelayedStandDownWithoutAttachingAfterShutdown() async {
        let old = await StartupRuntime(name: "old", port: 49_150, suspendShutdown: true)
        let fixture = LocalStartupFixture(daemons: [old])
        fixture.teardownTimeout = 0.05
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startReturned], timeout: 2)
        service.standDownForTakeover()
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)

        await stopWithDeadline(service)
        await old.finishShutdown()
        await settleCallbacks()
        assertStopped(service)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49150"])
        XCTAssertEqual(fixture.externalProbes, 0)
        XCTAssertEqual(fixture.requests.count, 1)
        let counts = await old.counts
        XCTAssertEqual(counts.shutdowns, 1)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testTimedOutSettingsRestartCancelsThePendingAutomaticHandover() async {
        let old = await StartupRuntime(name: "old", port: 49_150, suspendShutdown: true)
        let next = await StartupRuntime(name: "next", port: 49_151)
        let fixture = LocalStartupFixture(daemons: [old, next])
        fixture.teardownTimeout = 0.05
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startReturned], timeout: 2)
        service.standDownForTakeover()
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)

        fixture.configuredPort = 49_151
        await restartWithDeadline(service)
        await old.finishShutdown()
        await settleCallbacks()
        assertStopped(service)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49150"])
        XCTAssertEqual(fixture.externalProbes, 0, "the superseded automatic handover must not attach")
        XCTAssertEqual(fixture.requests.count, 1, "a timed-out Settings restart still requires an explicit retry")
        let nextCounts = await next.counts
        XCTAssertEqual(nextCounts.starts, 0)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testNewEndpointSupersedesDelayedStandDownAndResumesOnlyTheLatestAttachment() async {
        let old = await StartupRuntime(name: "old", port: 49_150, suspendShutdown: true)
        let fixture = LocalStartupFixture(daemons: [old], expectedReadyCount: 2)
        fixture.teardownTimeout = 0.05
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startReturned], timeout: 2)
        service.standDownForTakeover()
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)

        // This changes the attach generation without starting a new local
        // daemon. Its own bounded wait must preserve the newer endpoint too.
        await service.connectToExternalDaemon(port: 49_151)
        assertStopped(service)
        await old.finishShutdown()
        await fulfillment(of: [fixture.ready], timeout: 2)
        await settleCallbacks()
        XCTAssertTrue(service.isUsingExternalDaemon)
        XCTAssertEqual(service.port, 49_151)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49150", "ws://127.0.0.1:49151"])
        XCTAssertEqual(fixture.externalProbePorts, [49_151, 49_151], "only the latest endpoint may be revalidated")
        XCTAssertEqual(fixture.requests.count, 1)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testShutdownCallbackResumesAttachmentAfterDelayedCleanup() async {
        let old = await StartupRuntime(name: "old", port: 49_150, suspendShutdown: true)
        let fixture = LocalStartupFixture(daemons: [old], expectedReadyCount: 2)
        fixture.teardownTimeout = 0.05
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startReturned], timeout: 2)
        await old.emitRetiredShutdown()
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)
        XCTAssertEqual(fixture.externalProbes, 0)

        await old.finishShutdown()
        await fulfillment(of: [fixture.ready], timeout: 2)
        XCTAssertTrue(service.isUsingExternalDaemon)
        XCTAssertGreaterThan(service.port, 0)
        XCTAssertEqual(fixture.externalProbes, 1)
        XCTAssertEqual(fixture.requests.count, 1)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testCanonicalPortReclaimResumesOnlyAfterDelayedShutdown() async {
        let old = await StartupRuntime(name: "fallback", port: 49_151, suspendShutdown: true)
        let next = await StartupRuntime(name: "canonical", port: 49_150)
        let fixture = LocalStartupFixture(daemons: [old, next], expectedReadyCount: 2)
        fixture.teardownTimeout = 0.05
        fixture.monitorPortStatus = .notListening
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)
        assertStopped(service)
        XCTAssertEqual(fixture.requests.count, 1, "the timed-out wait cannot license overlapping modules")

        await old.finishShutdown()
        await fulfillment(of: [fixture.ready], timeout: 2)
        assertOwned(service, port: next.port)
        XCTAssertFalse(service.isOnFallbackPort)
        XCTAssertEqual(fixture.requests.count, 2)
        XCTAssertEqual(fixture.externalProbes, 0)
        let oldCounts = await old.counts
        XCTAssertEqual(oldCounts.shutdowns, 1)
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
    func testStopDuringListenerBackoffJoinsCleanupAndCannotRestart() async {
        let retry = await PausedListenerRecovery()
        let daemon = await StartupRuntime(name: "retry", port: 49_150, listenerRecovery: retry)
        let fixture = LocalStartupFixture(daemons: [daemon])
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [retry.pauseEntered], timeout: 2)
        let stopped = expectation(description: "stop joins cancelled listener retry")
        Task { @MainActor in await service.stop(); stopped.fulfill() }
        await settleCallbacks()
        assertStopped(service)
        await retry.resumePause()
        await fulfillment(of: [stopped], timeout: 2)
        let attempts = await retry.attempts
        let counts = await daemon.counts
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(counts.shutdowns, 1)
        XCTAssertEqual(fixture.readyURLs, [])
        XCTAssertEqual(fixture.requests.count, 1)
        XCTAssertEqual(fixture.externalProbes, 0)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testNewPortIntentCancelsOldListenerBackoffBeforeReplacement() async {
        let retry = await PausedListenerRecovery()
        let old = await StartupRuntime(name: "retry", port: 49_150, listenerRecovery: retry)
        let latest = await StartupRuntime(name: "new", port: 49_151)
        let fixture = LocalStartupFixture(daemons: [old, latest])
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [retry.pauseEntered], timeout: 2)
        fixture.configuredPort = 49_151
        let restarted = expectation(description: "new intent waits for retired listener retry")
        Task { @MainActor in await service.restart(); restarted.fulfill() }
        await settleCallbacks()
        XCTAssertEqual(fixture.requests.count, 1)
        await retry.resumePause()
        await fulfillment(of: [restarted, fixture.ready], timeout: 2)
        let attempts = await retry.attempts
        let oldCounts = await old.counts
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(oldCounts.shutdowns, 1)
        assertOwned(service, port: latest.port)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49151"])
        XCTAssertEqual(fixture.externalProbes, 0)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testPeerArrivingDuringListenerBackoffAttachesWithoutAnotherBind() async {
        let retry = await PausedListenerRecovery(peerArrives: true)
        let daemon = await StartupRuntime(name: "retry", port: 49_150, listenerRecovery: retry)
        let fixture = LocalStartupFixture(daemons: [daemon])
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [retry.pauseEntered], timeout: 2)
        await retry.resumePause()
        await fulfillment(of: [fixture.ready], timeout: 2)
        let attempts = await retry.attempts
        let counts = await daemon.counts
        XCTAssertEqual(attempts, 1)
        XCTAssertEqual(counts.shutdowns, 1, "failed startup must clean up before peer attachment")
        XCTAssertEqual(fixture.requests.count, 1)
        XCTAssertTrue(service.isUsingExternalDaemon)
        XCTAssertFalse(service.isRunning)
        XCTAssertEqual(service.port, 49_150)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49150"])
        XCTAssertEqual(fixture.externalProbes, 2, "failure routing and attach both recheck peer health")
        await fixture.cleanUp(service)
    }

    @MainActor
    func testStartupFailureResumesPeerAttachmentAfterDelayedCleanup() async {
        let old = await StartupRuntime(name: "failed-start", port: 49_150,
                                       suspendStart: true, suspendShutdown: true)
        let fixture = LocalStartupFixture(daemons: [old])
        fixture.teardownTimeout = 0.05
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startEntered], timeout: 2)
        await old.finishStart(throwing: NWError.posix(.EADDRINUSE))
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)
        assertStopped(service)
        XCTAssertEqual(fixture.externalProbes, 0, "failed startup must finish cleanup before probing a peer")

        await old.finishShutdown()
        await fulfillment(of: [fixture.ready], timeout: 2)
        XCTAssertTrue(service.isUsingExternalDaemon)
        XCTAssertEqual(service.port, 49_150)
        XCTAssertEqual(fixture.externalProbePorts, [49_150, 49_150], "retry and attach both retain the failed port")
        XCTAssertEqual(fixture.requests.count, 1)
        let counts = await old.counts
        XCTAssertEqual(counts.shutdowns, 1)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testRunningListenerFailureResumesPeerAttachmentAfterDelayedCleanup() async {
        let old = await StartupRuntime(name: "failed-listener", port: 49_150, suspendShutdown: true)
        let fixture = LocalStartupFixture(daemons: [old], expectedReadyCount: 2)
        fixture.teardownTimeout = 0.05
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startReturned], timeout: 2)
        await old.emitListenerFailure()
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)
        assertStopped(service)
        XCTAssertEqual(fixture.externalProbes, 0)

        await old.finishShutdown()
        await fulfillment(of: [fixture.ready], timeout: 2)
        XCTAssertTrue(service.isUsingExternalDaemon)
        XCTAssertEqual(service.port, 49_150)
        XCTAssertEqual(fixture.externalProbePorts, [49_150, 49_150])
        XCTAssertEqual(fixture.requests.count, 1)
        let counts = await old.counts
        XCTAssertEqual(counts.shutdowns, 1)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testStopCancelsDelayedStartupFailureRecovery() async {
        let old = await StartupRuntime(name: "failed-start", port: 49_150,
                                       suspendStart: true, suspendShutdown: true)
        let fixture = LocalStartupFixture(daemons: [old])
        fixture.teardownTimeout = 0.05
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startEntered], timeout: 2)
        await old.finishStart(throwing: NWError.posix(.EADDRINUSE))
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)

        await stopWithDeadline(service)
        await old.finishShutdown()
        await settleCallbacks()
        assertStopped(service)
        XCTAssertEqual(fixture.externalProbes, 0)
        XCTAssertTrue(fixture.readyURLs.isEmpty)
        XCTAssertEqual(fixture.requests.count, 1)
        await fixture.cleanUp(service)
    }

    @MainActor
    func testNewEndpointRejectsAResumedFailureRecoveryProbe() async {
        let old = await StartupRuntime(name: "failed-listener", port: 49_150, suspendShutdown: true)
        let fixture = LocalStartupFixture(daemons: [old], expectedReadyCount: 2)
        fixture.teardownTimeout = 0.05
        fixture.externalHealth = ["mode": "daemon", "isSwift": false]
        let service = fixture.makeService()
        service.start()
        await fulfillment(of: [old.startReturned], timeout: 2)
        await old.emitListenerFailure()
        await fulfillment(of: [old.shutdownEntered], timeout: 2)
        await waitForTeardownTimeout(service)

        // The continuation has resumed and cleared its task handle. A new
        // endpoint must still invalidate the failure retry's suspended probe.
        fixture.suspendNextExternalProbe = true
        await old.finishShutdown()
        await fulfillment(of: [fixture.externalProbeEntered], timeout: 2)
        await service.connectToExternalDaemon(port: 49_151)
        await fulfillment(of: [fixture.ready], timeout: 2)
        fixture.finishExternalProbe()
        await settleCallbacks()

        XCTAssertTrue(service.isUsingExternalDaemon)
        XCTAssertEqual(service.port, 49_151)
        XCTAssertEqual(fixture.readyURLs, ["ws://127.0.0.1:49150", "ws://127.0.0.1:49151"])
        XCTAssertEqual(fixture.externalProbePorts, [49_150, 49_151], "late recovery must not reattach to the old endpoint")
        XCTAssertEqual(fixture.requests.count, 1)
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

    @MainActor
    private func waitForTeardownTimeout(_ service: DaemonService) async {
        let timedOut = expectation(description: "bounded teardown returns with recoverable status")
        let observation = service.$errorMessage.first(where: { $0 != nil }).sink { _ in timedOut.fulfill() }
        await fulfillment(of: [timedOut], timeout: 2)
        observation.cancel()
    }

    @MainActor
    private func waitForClient(_ service: DaemonService) async {
        let attached = expectation(description: "service becomes an external daemon client")
        let observation = service.$isUsingExternalDaemon.first(where: { $0 }).sink { _ in attached.fulfill() }
        await fulfillment(of: [attached], timeout: 2)
        observation.cancel()
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
    var externalHealth: [String: Any]?
    var suspendNextExternalProbe = false
    let externalProbeEntered = XCTestExpectation(description: "failure recovery peer probe entered")
    var monitorPortStatus: LocalPortProbe.Status = .unknown
    let factoryEntered: [XCTestExpectation]
    let factoryReturned: [XCTestExpectation]
    let ready = XCTestExpectation(description: "current daemon publishes dashboard readiness")
    private(set) var requests: [Request] = []
    private(set) var readyURLs: [String] = []
    private(set) var externalProbes = 0
    private(set) var externalProbePorts: [Int] = []
    private(set) var monitorHealthProbes = 0
    private let daemons: [StartupRuntime]
    private let delayedFactories: Set<Int>
    private var pendingFactories: [Int: CheckedContinuation<Void, Never>] = [:]
    private var pendingExternalProbe: CheckedContinuation<Void, Never>?

    init(daemons: [StartupRuntime], delayedFactories: Set<Int> = [], expectedReadyCount: Int = 1) {
        self.daemons = daemons
        self.delayedFactories = delayedFactories
        factoryEntered = daemons.indices.map { XCTestExpectation(description: "factory \($0) entered") }
        factoryReturned = daemons.indices.map { XCTestExpectation(description: "factory \($0) returned") }
        ready.expectedFulfillmentCount = expectedReadyCount
    }

    func makeService() -> DaemonService {
        let service = DaemonService(automaticallyStart: false, externalAttach: .init(
            registeredPort: { nil },
            probeHealth: { [self] port in
                externalProbes += 1
                externalProbePorts.append(port)
                if suspendNextExternalProbe {
                    suspendNextExternalProbe = false
                    await withCheckedContinuation {
                        pendingExternalProbe = $0
                        externalProbeEntered.fulfill()
                    }
                }
                return externalHealth
            },
            portStatus: { [self] _ in externalProbes += 1; return .unknown },
            retryDelay: { throw CancellationError() }
        ), localStartup: .init(teardownTimeout: teardownTimeout, configuration: { [self] in
            .init(port: configuredPort, posture: posture)
        }, makeDaemon: { [self] port, posture, preferredPort in
            XCTAssertEqual(preferredPort, configuredPort)
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
        }), healthMonitor: .init(pause: { try await Task.sleep(for: .milliseconds(10)) },
            probeHealth: { [self] _, patient in
                if patient { monitorHealthProbes += 1 }
                return nil
            }, portStatus: { [self] _ in monitorPortStatus }))
        service.onReady = { [self] url in
            readyURLs.append(url)
            ready.fulfill()
        }
        return service
    }

    func finishFactory(_ index: Int) {
        pendingFactories.removeValue(forKey: index)?.resume()
    }

    func finishExternalProbe() {
        let pending = pendingExternalProbe
        pendingExternalProbe = nil
        pending?.resume()
    }

    func cleanUp(_ service: DaemonService) async {
        if pendingExternalProbe != nil {
            await service.stop()
            finishExternalProbe()
        }
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
    private let listenerRecovery: PausedListenerRecovery?
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
         journal: StartupJournal? = nil, listenerRecovery: PausedListenerRecovery? = nil) {
        self.name = name
        self.port = port
        self.suspendStart = suspendStart
        self.suspendShutdown = suspendShutdown
        self.journal = journal
        self.listenerRecovery = listenerRecovery
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
        try await listenerRecovery?.run()
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
    func emitListenerFailure() { retiredListenerFailureHandler?(StartupTestError.lateFailure) }
    func emitRetiredListenerFailure() { emitListenerFailure() }
    func reconnectGatewayAdapter() {}
    func refreshZaiUsage(configurationChanged: Bool) async -> Bool { false }
    func deviceStatusSnapshots() async -> DaemonServer.DeviceStatusSnapshots {
        .init(d200h: nil, pixoo: nil, serial: nil, adb: nil)
    }
}

/// Suspension deliberately ignores cancellation to exercise the service's
/// generation guard after a late callback. No sockets or device state exist.
@DaemonActor
private final class PausedListenerRecovery {
    nonisolated let pauseEntered = XCTestExpectation(description: "listener retry backoff entered")
    private var pause: CheckedContinuation<Void, Never>?
    private let peerArrives: Bool
    private var portChecks = 0
    private(set) var attempts = 0

    init(peerArrives: Bool = false) { self.peerArrives = peerArrives }

    func run() async throws {
        try await ListenerStartupRecovery.start(port: 49_150, preferredPort: 49_150,
            dependencies: .init(now: { 0 }, pause: { _ in
                await withCheckedContinuation {
                    self.pause = $0
                    self.pauseEntered.fulfill()
                }
            }, portStatus: { _, _ in
                self.portChecks += 1
                return self.peerArrives && self.portChecks > 1 ? .listening : .notListening
            }), validate: {}, bind: { _ in
                self.attempts += 1
                if self.attempts == 1 { throw NWError.posix(.EADDRINUSE) }
            })
    }

    func resumePause() {
        let pending = pause
        pause = nil
        pending?.resume()
    }
}
#endif
