#if os(macOS)
import XCTest
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
