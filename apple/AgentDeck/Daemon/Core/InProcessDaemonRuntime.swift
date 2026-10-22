#if os(macOS)
import Foundation

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
#endif
