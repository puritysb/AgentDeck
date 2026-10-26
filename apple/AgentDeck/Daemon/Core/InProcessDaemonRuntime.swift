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
