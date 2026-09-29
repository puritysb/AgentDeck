#if os(macOS)
// SerialModule.swift — ESP32 serial device module
// Ported from bridge/src/modules/serial-module.ts

import Foundation

final class SerialModule: DeviceModule, @unchecked Sendable {
    let name = "serial"
    let serial = ESP32Serial()

    /// - Parameter daemonPort: this daemon's HTTP port. The serial bridge
    ///   refuses to open a board while a sibling daemon on a LOWER port is
    ///   alive (#327: a fallback-port hub must not double-open USB ports the
    ///   incumbent holds) and exposes suspend/resume over HTTP in Node parity.
    private let daemonPort: Int

    init(daemonPort: Int) {
        self.daemonPort = daemonPort
    }

    func start() async {
        // Applied before the first poll cycle so no ungated cycle can race
        // the ownership guard.
        await serial.setOwnDaemonPort(daemonPort)
        let devFiles = (try? FileManager.default.contentsOfDirectory(atPath: "/dev")) ?? []
        let hasSerial = devFiles.contains { $0.hasPrefix("cu.usbserial") || $0.hasPrefix("cu.wchusbserial") || $0.hasPrefix("cu.usbmodem") }
        guard hasSerial else {
            DaemonLogger.shared.debug("Serial", "No USB serial devices found, skipping")
            return
        }

        await serial.start()
        DaemonLogger.shared.info("Serial module started")
    }

    func stop() async {
        await serial.stop()
    }

    /// Close every held port now and keep serial closed for `seconds`
    /// (clamped 1…900, Node parity). Returns the effective lease expiry and
    /// how many ports were released.
    func suspend(seconds: Int, reason: String) async -> (until: Date, released: Int) {
        await serial.suspendSerial(seconds: seconds, reason: reason)
    }

    /// End an in-force suspension early. Idempotent.
    func resume() async -> Bool {
        await serial.resumeSerial()
    }

    func handleWake() async {
        await serial.handleWake()
    }

    /// Wire broadcast hook — relay events to ESP32 devices
    func wireBroadcast(_ event: [String: Any]) {
        let box = SendableDict(event)
        Task { await serial.broadcast(box.value) }
    }

    func getConnectionCount() async -> Int {
        await serial.connectionCount
    }

    func statusSnapshot() async -> sending [String: Any] {
        serial.cachedStatusSnapshot()
    }
}
#endif
