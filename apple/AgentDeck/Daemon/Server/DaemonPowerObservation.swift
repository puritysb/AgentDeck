#if os(macOS)
import Foundation
import IOKit
import IOKit.pwr_mgt

private let kIOMessageSystemHasPoweredOn: UInt32 = 0xe0000300

private final class DaemonPowerContext: @unchecked Sendable {
    let wake: @Sendable () -> Void
    init(_ wake: @escaping @Sendable () -> Void) { self.wake = wake }
}

// File scope: a C callback must never inherit a global actor's executor.
private let daemonPowerCallback: IOServiceInterestCallback = { refcon, _, message, _ in
    guard message == UInt32(kIOMessageSystemHasPoweredOn), let refcon else { return }
    let context = Unmanaged<DaemonPowerContext>.fromOpaque(refcon).takeUnretainedValue()
    context.wake()
}

/// Registration and destruction share the callback's main queue. The refcon
/// owns a closure with a weak server, rather than a dangling unretained server.
@MainActor
final class DaemonPowerObservation {
    private var port: IONotificationPortRef?
    private var notifier: io_object_t = 0
    private var context: DaemonPowerContext?
    var isRegistered: Bool { notifier != 0 }

    init(wake: @escaping @Sendable () -> Void) {
        guard let port = IONotificationPortCreate(kIOMainPortDefault) else { return }
        let root = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard root != 0 else { IONotificationPortDestroy(port); return }
        defer { IOObjectRelease(root) }
        let context = DaemonPowerContext(wake)
        IONotificationPortSetDispatchQueue(port, .main)
        let result = IOServiceAddInterestNotification(port, root, kIOGeneralInterest,
            daemonPowerCallback, Unmanaged.passUnretained(context).toOpaque(), &notifier)
        guard result == KERN_SUCCESS else { IONotificationPortDestroy(port); notifier = 0; return }
        self.context = context; self.port = port
    }

    func stop() {
        if notifier != 0 { IOObjectRelease(notifier); notifier = 0 }
        if let port { IONotificationPortDestroy(port); self.port = nil }
        context = nil
    }
}
#endif
