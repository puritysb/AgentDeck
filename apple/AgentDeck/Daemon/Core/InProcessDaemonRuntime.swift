#if os(macOS)
import Foundation
import Network

/// The lifecycle surface owned by DaemonService. Tests can suspend individual
/// stages without opening a listener, touching credentials or starting devices.
@DaemonActor
protocol InProcessDaemonRuntime: AnyObject, Sendable {
    nonisolated var port: UInt16 { get }
    func setShutdownHandler(_ handler: (@Sendable () -> Void)?)
    func setStandDownRequestedHandler(_ handler: (@Sendable () -> Void)?)
    func setListenerFailedHandler(_ handler: @escaping @Sendable (Error) -> Void) async
    func startServices(onDashboardReady: (@Sendable () async -> Void)?) async throws
    func shutdown() async
    func reconnectGatewayAdapter()
    func refreshZaiUsage(configurationChanged: Bool) async -> Bool
    func deviceStatusSnapshots() async -> DaemonServer.DeviceStatusSnapshots
}

extension DaemonServer: InProcessDaemonRuntime {}

/// One server's App Nap protection, held across startup and normal service.
/// Startup may suspend before its listener or device modules are ready. Taking
/// the activity only after that work finishes leaves the handover itself
/// eligible for App Nap when the dashboard is hidden or the screen is locked.
@DaemonActor
final class DaemonProcessActivity {
    struct Dependencies {
        var begin: () -> NSObjectProtocol = {
            ProcessInfo.processInfo.beginActivity(
                options: .userInitiatedAllowingIdleSystemSleep,
                reason: "Serving local dashboard devices (HTTP/WS)")
        }
        var end: (NSObjectProtocol) -> Void = { ProcessInfo.processInfo.endActivity($0) }
    }

    private let dependencies: Dependencies
    private var activity: NSObjectProtocol?
    private var hasStarted = false

    init(dependencies: Dependencies = .init()) {
        self.dependencies = dependencies
    }

    func start(_ operation: @DaemonActor () async throws -> Void) async throws {
        try Task.checkCancellation()
        // A DaemonServer is started once. A retired server must not acquire a
        // new activity if shutdown ran before startup or during an await.
        guard !hasStarted else { throw CancellationError() }
        hasStarted = true
        activity = dependencies.begin()
        do {
            try await operation()
            try Task.checkCancellation()
            guard activity != nil else { throw CancellationError() }
        } catch {
            stop()
            throw error
        }
    }

    func stop() {
        hasStarted = true
        guard let activity else { return }
        self.activity = nil
        dependencies.end(activity)
    }
}

/// Retry the real preferred-port listener before creating a fallback hub. A
/// refused TCP connection cannot prove NWListener can bind (NECP may retain a
/// reservation), but it licenses a bounded attempt while no working listener
/// is being torn down. The successful listener is retained, never probe/cancelled.
@DaemonActor
enum ListenerStartupRecovery {
    struct Dependencies {
        var now: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
        var pause: (TimeInterval) async throws -> Void = { try await Task.sleep(for: .seconds($0)) }
        var portStatus: (Int, TimeInterval) async -> LocalPortProbe.Status = {
            await LocalPortProbe.status(port: $0, timeout: $1)
        }
    }

    static let retryBudget: TimeInterval = 30
    static let attemptTimeout: TimeInterval = 10

    static func start(
        port: Int, preferredPort: Int,
        dependencies: Dependencies = .init(),
        validate: () throws -> Void,
        bind: (TimeInterval) async throws -> Void
    ) async throws {
        let deadline = dependencies.now() + retryBudget
        var lastFailure: Error = WebSocketServerError.listenerTimedOut
        var delay: TimeInterval = 2
        while true {
            try Task.checkCancellation()
            try validate()
            let remaining = deadline - dependencies.now()
            guard remaining > 0 else { throw lastFailure }
            do {
                try await bind(min(attemptTimeout, remaining))
                try Task.checkCancellation()
                try validate()
                return
            } catch {
                try Task.checkCancellation()
                try validate()
                guard port == preferredPort, isAddressInUse(error) else { throw error }
                lastFailure = error
                guard dependencies.now() < deadline else { throw error }
                let status = await dependencies.portStatus(port, min(2, deadline - dependencies.now()))
                try Task.checkCancellation()
                try validate()
                guard status == .notListening else { throw error }
                let wait = min(delay, deadline - dependencies.now())
                guard wait > 0 else { throw error }
                DaemonLogger.shared.info("Preferred port \(port) refused TCP after listener bind failure — retrying actual listener in \(wait)s within startup budget")
                try await dependencies.pause(wait)
                try Task.checkCancellation()
                try validate()
                guard dependencies.now() < deadline else { throw error }
                // A peer may arrive during backoff. Unknown is not permission
                // to bind; the existing service failure path probes/attaches.
                let latestStatus = await dependencies.portStatus(port, min(2, deadline - dependencies.now()))
                try Task.checkCancellation()
                try validate()
                guard latestStatus == .notListening, dependencies.now() < deadline else { throw error }
                delay = min(delay * 2, 8)
            }
        }
    }

    private static func isAddressInUse(_ error: Error) -> Bool {
        if let error = error as? NWError, case .posix(.EADDRINUSE) = error { return true }
        return (error as? POSIXError)?.code == .EADDRINUSE
    }
}
#endif
