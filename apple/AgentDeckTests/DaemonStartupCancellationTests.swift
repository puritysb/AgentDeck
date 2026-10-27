#if os(macOS)
import XCTest
import Network
@testable import AgentDeck

/// Exercises cancellation inside the real startup helpers without constructing
/// a DaemonServer, touching live credentials, or opening a listening socket.
final class DaemonStartupCancellationTests: XCTestCase {
    func testRetiredInstanceCannotDeleteTheReplacementRegistry() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let registry = SessionRegistry(dataDirectory: directory)
        // Same PID, port and second: only the instance receipt distinguishes
        // a rapid replacement within the same app process.
        let old = DaemonInfo(port: 19_999, pid: Int(ProcessInfo.processInfo.processIdentifier),
                             startedAt: ISO8601DateFormatter().string(from: Date()),
                             httpPort: nil, instanceId: "old")
        let replacement = DaemonInfo(port: old.port, pid: old.pid, startedAt: old.startedAt,
                                     httpPort: nil, instanceId: "replacement")
        registry.writeDaemonInfo(old)
        registry.writeDaemonInfo(replacement)
        registry.removeDaemonInfo(ifMatching: old)
        // Reads use the same serial queue, so this also verifies queued write /
        // late-delete ordering rather than only comparing two values in memory.
        XCTAssertEqual(registry.readDaemonInfo()?.instanceId, "replacement")

        registry.removeDaemonInfo(ifMatching: replacement)
        XCTAssertNil(registry.readDaemonInfo())
    }

    func testCancelledModuleStartupDoesNotStartTheNextModule() async {
        let firstStarted = expectation(description: "first module is suspended")
        let first = SuspendedStartupModule(name: "first", started: firstStarted)
        let second = SuspendedStartupModule(name: "second")
        let manager = await ModuleManager()
        await manager.register(first)
        await manager.register(second)
        let startup = Task { await manager.startAll() }
        await fulfillment(of: [firstStarted], timeout: 2)

        startup.cancel()
        await first.resume()
        await startup.value

        let secondStarts = await second.startCount
        XCTAssertEqual(secondStarts, 0)
    }

    func testShutdownGateStopsTheNextModuleWithoutTaskCancellation() async {
        let firstStarted = expectation(description: "first module is suspended")
        let first = SuspendedStartupModule(name: "first", started: firstStarted)
        let second = SuspendedStartupModule(name: "second")
        let manager = await ModuleManager()
        let gate = await StartupPermission()
        await manager.register(first)
        await manager.register(second)
        let startup = Task { @DaemonActor in
            await manager.startAll { gate.allowed }
        }
        await fulfillment(of: [firstStarted], timeout: 2)

        await gate.stop()
        await first.resume()
        await startup.value

        let secondStarts = await second.startCount
        XCTAssertEqual(secondStarts, 0)
    }

    func testCancelledListenerStartupStopsBeforeCreatingAListener() async {
        let server = WebSocketServer()
        let startup = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                // Never name the shared daemon port, even if cancellation
                // regresses and this attempt reaches listener validation.
                try await server.start(port: 0, loopbackOnly: true)
                return false
            } catch is CancellationError {
                return true
            } catch {
                return false
            }
        }
        let cancelled = await startup.value
        XCTAssertTrue(cancelled, "cancellation must precede listener creation and validation")
    }
}

/// The real startup activity owner with fake process activities. No app,
/// listener, preference or OS power assertion is created by these tests.
final class DaemonProcessActivityTests: XCTestCase {
    @DaemonActor
    func testActivityIsHeldDuringSuspendedStartupAndUntilShutdown() async throws {
        let fixture = ProcessActivityFixture()
        let activity = fixture.makeActivity()
        let entered = expectation(description: "startup suspended")
        let startup = Task { @DaemonActor in
            try await activity.start {
                XCTAssertEqual(fixture.activeCount, 1, "the first startup operation must already be protected")
                await fixture.suspend(entered)
            }
        }
        await fulfillment(of: [entered], timeout: 2)
        XCTAssertEqual(fixture.beginCount, 1)
        XCTAssertEqual(fixture.endCount, 0)

        fixture.resume()
        try await startup.value
        XCTAssertEqual(fixture.activeCount, 1, "successful startup retains protection while serving")
        activity.stop()
        activity.stop()
        XCTAssertEqual(fixture.activeCount, 0)
        XCTAssertEqual(fixture.endCount, 1)
    }

    @DaemonActor
    func testStartupFailureReleasesActivityWithoutOuterCleanup() async {
        let fixture = ProcessActivityFixture()
        let activity = fixture.makeActivity()
        do {
            try await activity.start { throw NWError.posix(.EADDRINUSE) }
            XCTFail("failed startup must propagate its error")
        } catch {
            XCTAssertEqual(error as? NWError, .posix(.EADDRINUSE))
        }
        XCTAssertEqual(fixture.activeCount, 0)
        XCTAssertEqual(fixture.endCount, 1)
        activity.stop()
        XCTAssertEqual(fixture.endCount, 1, "later service cleanup must not end the activity twice")
    }

    @DaemonActor
    func testCancellationAfterAnIgnoringStartupOperationReleasesActivity() async {
        let fixture = ProcessActivityFixture()
        let activity = fixture.makeActivity()
        let entered = expectation(description: "startup suspended")
        let startup = Task { @DaemonActor in
            do {
                try await activity.start { await fixture.suspend(entered) }
                return false
            } catch is CancellationError { return true }
            catch { return false }
        }
        await fulfillment(of: [entered], timeout: 2)
        startup.cancel()
        fixture.resume() // Deliberately completes without checking cancellation.
        let cancelled = await startup.value
        XCTAssertTrue(cancelled)
        XCTAssertEqual(fixture.activeCount, 0)
        XCTAssertEqual(fixture.endCount, 1)
    }

    @DaemonActor
    func testShutdownDuringSuspendedStartupRejectsLateSuccess() async {
        let fixture = ProcessActivityFixture()
        let activity = fixture.makeActivity()
        let entered = expectation(description: "startup suspended")
        let startup = Task { @DaemonActor in
            do {
                try await activity.start { await fixture.suspend(entered) }
                return false
            } catch is CancellationError { return true }
            catch { return false }
        }
        await fulfillment(of: [entered], timeout: 2)
        activity.stop()
        fixture.resume()
        let cancelled = await startup.value
        XCTAssertTrue(cancelled)
        XCTAssertEqual(fixture.beginCount, 1)
        XCTAssertEqual(fixture.endCount, 1)
    }

    @DaemonActor
    func testAlreadyCancelledStartupNeverAcquiresActivity() async {
        let fixture = ProcessActivityFixture()
        let activity = fixture.makeActivity()
        let cancelled = await Task { @DaemonActor in
            withUnsafeCurrentTask { $0?.cancel() }
            do {
                try await activity.start { XCTFail("cancelled startup must not run") }
                return false
            } catch is CancellationError { return true }
            catch { return false }
        }.value
        XCTAssertTrue(cancelled)
        XCTAssertEqual(fixture.beginCount, 0)
        XCTAssertEqual(fixture.endCount, 0)
    }

    @DaemonActor
    func testShutdownBeforeStartupPreventsLaterAcquisition() async {
        let fixture = ProcessActivityFixture()
        let activity = fixture.makeActivity()
        activity.stop()
        do {
            try await activity.start { XCTFail("retired startup must not run") }
            XCTFail("retired startup must throw")
        } catch is CancellationError {}
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(fixture.beginCount, 0)
    }

    @DaemonActor
    func testLateFailureCannotEndTheReplacementServersActivity() async throws {
        let fixture = ProcessActivityFixture()
        let old = fixture.makeActivity()
        let replacement = fixture.makeActivity()
        let entered = expectation(description: "old startup suspended")
        let startup = Task { @DaemonActor in
            do {
                try await old.start {
                    await fixture.suspend(entered)
                    throw NWError.posix(.EADDRINUSE)
                }
                return false
            } catch { return true }
        }
        await fulfillment(of: [entered], timeout: 2)
        old.stop()
        try await replacement.start {}
        fixture.resume()
        let failed = await startup.value
        XCTAssertTrue(failed)
        XCTAssertEqual(fixture.beginCount, 2)
        XCTAssertEqual(fixture.endCount, 1)
        XCTAssertEqual(fixture.activeCount, 1)
        replacement.stop()
        XCTAssertEqual(fixture.endCount, 2)
        XCTAssertEqual(fixture.activeCount, 0)
    }
}

@DaemonActor
private final class ProcessActivityFixture {
    private var active: Set<ObjectIdentifier> = []
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var beginCount = 0
    private(set) var endCount = 0
    var activeCount: Int { active.count }

    func makeActivity() -> DaemonProcessActivity {
        DaemonProcessActivity(dependencies: .init(begin: {
            let token = NSObject()
            self.active.insert(ObjectIdentifier(token))
            self.beginCount += 1
            return token
        }, end: { token in
            XCTAssertNotNil(self.active.remove(ObjectIdentifier(token)))
            self.endCount += 1
        }))
    }

    func suspend(_ entered: XCTestExpectation) async {
        await withCheckedContinuation {
            continuation = $0
            entered.fulfill()
        }
    }

    func resume() {
        let pending = continuation
        continuation = nil
        pending?.resume()
    }
}

/// The production retry loop with a monotonic fake clock and bounded probes.
/// Every bind is the attempted real operation; there is no successful bind
/// probe that would be cancelled before the actual listener takes ownership.
final class ListenerStartupRecoveryTests: XCTestCase {
    @DaemonActor
    func testTransientFailureKeepsTheSuccessfulAttemptWithoutFallback() async throws {
        let fixture = ListenerRecoveryFixture(failures: 3)
        try await fixture.run()
        XCTAssertEqual(fixture.binds, 4)
        XCTAssertEqual(fixture.waits, [2, 4, 8])
        XCTAssertEqual(fixture.now, 14)
        XCTAssertTrue(fixture.bound)
    }

    @DaemonActor
    func testPersistentFailureStopsAtTheWholeStartupBudget() async {
        let fixture = ListenerRecoveryFixture(failures: 100)
        await assertFailure(fixture)
        XCTAssertEqual(fixture.now, 30)
        XCTAssertEqual(fixture.binds, 5)
        XCTAssertEqual(fixture.bindTimeouts, [10, 10, 10, 10, 8])
        XCTAssertFalse(fixture.bound)
    }

    @DaemonActor
    func testProbeAndBindTimeConsumeTheSameBudgetAsBackoff() async {
        let fixture = ListenerRecoveryFixture(failures: 100)
        fixture.bindDuration = 1
        fixture.probeDuration = 1
        await assertFailure(fixture)
        XCTAssertEqual(fixture.now, 30)
        XCTAssertEqual(fixture.binds, 4, "I/O time must not extend the backoff budget")
    }

    @DaemonActor
    func testFinalProbeReceivesOnlyTheRemainingBudget() async {
        let fixture = ListenerRecoveryFixture(failures: 100)
        // Simulate a slow result from an injected operation. The next operation
        // must receive only the remaining second, not start a fresh two seconds.
        fixture.bindDuration = 29
        fixture.probeDuration = 2
        await assertFailure(fixture)
        XCTAssertEqual(fixture.probeTimeouts, [1])
        XCTAssertEqual(fixture.now, 30)
        XCTAssertEqual(fixture.binds, 1)
    }

    @DaemonActor
    func testOccupiedOrUnknownPortDoesNotLicenseAnotherBind() async {
        for status in [LocalPortProbe.Status.listening, .unknown] {
            let fixture = ListenerRecoveryFixture(failures: 100)
            fixture.statuses = [status]
            await assertFailure(fixture)
            XCTAssertEqual(fixture.binds, 1)
            XCTAssertTrue(fixture.waits.isEmpty)
        }
    }

    @DaemonActor
    func testPeerArrivingDuringBackoffStopsRetry() async {
        let fixture = ListenerRecoveryFixture(failures: 100)
        fixture.statuses = [.notListening, .listening]
        await assertFailure(fixture)
        XCTAssertEqual(fixture.binds, 1)
        XCTAssertEqual(fixture.waits, [2])
    }

    @DaemonActor
    func testUnknownAfterBackoffAlsoStopsRetry() async {
        let fixture = ListenerRecoveryFixture(failures: 100)
        fixture.statuses = [.notListening, .unknown]
        await assertFailure(fixture)
        XCTAssertEqual(fixture.binds, 1)
    }

    @DaemonActor
    func testFallbackPortAndNonContentionErrorAreNotRetried() async {
        let fallback = ListenerRecoveryFixture(failures: 100)
        fallback.preferredPort = 49_151
        await assertFailure(fallback)
        XCTAssertTrue(fallback.probeTimeouts.isEmpty)
        let denied = ListenerRecoveryFixture(failures: 100)
        denied.error = NWError.posix(.EACCES)
        await assertFailure(denied)
        XCTAssertTrue(denied.probeTimeouts.isEmpty)
    }

    @DaemonActor
    func testCancellationDuringBackoffRejectsTheNextBind() async {
        let fixture = ListenerRecoveryFixture(failures: 100)
        fixture.cancelDuringPause = true
        // Keep cancellation inside a child so it cannot cancel the XCTest task.
        let cancelled = await Task { @DaemonActor in
            do { try await fixture.run(); return false }
            catch is CancellationError { return true }
            catch { return false }
        }.value
        XCTAssertTrue(cancelled)
        XCTAssertEqual(fixture.binds, 1)
    }

    @DaemonActor
    func testRetiredGenerationAfterProbeRejectsTheNextBind() async {
        let fixture = ListenerRecoveryFixture(failures: 100)
        fixture.invalidateDuringProbe = true
        do { try await fixture.run(); XCTFail("retired startup must throw") }
        catch is CancellationError {}
        catch { XCTFail("unexpected error: \(error)") }
        XCTAssertEqual(fixture.binds, 1)
        XCTAssertTrue(fixture.waits.isEmpty)
    }

    @DaemonActor
    private func assertFailure(_ fixture: ListenerRecoveryFixture) async {
        do { try await fixture.run(); XCTFail("expected original bind failure") }
        catch { XCTAssertEqual((error as? NWError), fixture.error) }
    }
}

@DaemonActor
private final class ListenerRecoveryFixture {
    var now: TimeInterval = 0
    var preferredPort = 49_150
    var error = NWError.posix(.EADDRINUSE)
    var statuses: [LocalPortProbe.Status] = []
    var bindDuration: TimeInterval = 0
    var probeDuration: TimeInterval = 0
    var cancelDuringPause = false
    var invalidateDuringProbe = false
    private var active = true
    private var failures: Int
    private(set) var binds = 0
    private(set) var bound = false
    private(set) var waits: [TimeInterval] = []
    private(set) var bindTimeouts: [TimeInterval] = []
    private(set) var probeTimeouts: [TimeInterval] = []

    init(failures: Int) { self.failures = failures }

    func run() async throws {
        try await ListenerStartupRecovery.start(port: 49_150, preferredPort: preferredPort,
            dependencies: .init(now: { self.now }, pause: { delay in
                self.waits.append(delay)
                self.now += delay
                if self.cancelDuringPause { withUnsafeCurrentTask { $0?.cancel() } }
            }, portStatus: { _, timeout in
                self.probeTimeouts.append(timeout)
                self.now += min(self.probeDuration, timeout)
                if self.invalidateDuringProbe { self.active = false }
                return self.statuses.isEmpty ? .notListening : self.statuses.removeFirst()
            }), validate: {
                if !self.active { throw CancellationError() }
            }, bind: { timeout in
                self.binds += 1
                self.bindTimeouts.append(timeout)
                self.now += self.bindDuration
                if self.failures > 0 { self.failures -= 1; throw self.error }
                self.bound = true
            })
    }
}

private actor SuspendedStartupModule: DeviceModule {
    nonisolated let name: String
    private let started: XCTestExpectation?
    private var continuation: CheckedContinuation<Void, Never>?
    private(set) var startCount = 0

    init(name: String, started: XCTestExpectation? = nil) {
        self.name = name
        self.started = started
    }

    func start() async {
        startCount += 1
        guard let started else { return }
        await withCheckedContinuation {
            continuation = $0
            started.fulfill()
        }
    }

    func resume() {
        let pending = continuation
        continuation = nil
        pending?.resume()
    }

    func stop() async {}
}

@DaemonActor
private final class StartupPermission {
    private(set) var allowed = true
    func stop() { allowed = false }
}
#endif
