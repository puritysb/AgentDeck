import Foundation
#if canImport(WatchConnectivity) && (os(iOS) || os(watchOS))
import WatchConnectivity
#endif

/// Lightweight iPhone → Watch auxiliary channel carrying the already-fetched
/// `RemoteObservationSnapshot` via `WCSession.updateApplicationContext`.
///
/// CloudKit remains the authoritative source and the Watch still verifies that
/// the payload belongs to the same iCloud account before displaying or caching
/// it. Forwarding simply reduces cold-start lag and long-look cache misses when
/// the paired iPhone already has the latest observation.
final class WatchCompanionBridge: NSObject, @unchecked Sendable {
    static let shared = WatchCompanionBridge()

    private let lock = NSLock()
    private var receiver: (@Sendable (Data, String) -> Void)?

    private enum Key {
        static let version = "version"
        static let account = "account"
        static let payload = "payload"
    }

    private override init() {
        super.init()
    }

    /// Activates `WCSession` if supported on this device.
    func activate(onReceive: (@Sendable (Data, String) -> Void)? = nil) {
        if let onReceive {
            lock.lock()
            receiver = onReceive
            lock.unlock()
        }
        #if canImport(WatchConnectivity) && (os(iOS) || os(watchOS))
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.delegate == nil {
            session.delegate = self
        }
        if session.activationState != .activated {
            session.activate()
        } else {
            deliverContextIfPresent(session.receivedApplicationContext)
        }
        #endif
    }

    #if os(iOS)
    /// Pushes the latest validated snapshot from iPhone to the paired Watch.
    func push(snapshot: RemoteObservationSnapshot, account: String) {
        #if canImport(WatchConnectivity)
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        if session.delegate == nil {
            session.delegate = self
            session.activate()
        }
        guard session.activationState == .activated, session.isPaired, session.isWatchAppInstalled else { return }
        guard let data = try? RemoteObservationContract.encode(snapshot) else { return }
        try? session.updateApplicationContext([
            Key.version: RemoteObservationContract.version,
            Key.account: account,
            Key.payload: data,
        ])
        #endif
    }
    #endif

    private func deliverContextIfPresent(_ context: [String: Any]) {
        guard let version = context[Key.version] as? Int,
              version == RemoteObservationContract.version,
              let account = context[Key.account] as? String,
              let data = context[Key.payload] as? Data else { return }
        lock.lock()
        let handler = receiver
        lock.unlock()
        handler?(data, account)
    }
}

#if canImport(WatchConnectivity) && (os(iOS) || os(watchOS))
extension WatchCompanionBridge: WCSessionDelegate {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        if activationState == .activated {
            deliverContextIfPresent(session.receivedApplicationContext)
        }
    }

    #if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
    #endif

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        deliverContextIfPresent(applicationContext)
    }
}
#endif
