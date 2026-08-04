#if os(macOS)
// IDotMatrixBLE.swift — Native CoreBluetooth transport for iDotMatrix 32×32 LED displays.
//
// Reimplements the GATT protocol that the Python `idotmatrix` library (bleak) speaks,
// so the App Store macOS build can drive an iDotMatrix over Bluetooth with NO subprocess
// and NO bundled interpreter (App Review 2.5.2). CoreBluetooth is a first-party Apple
// framework, gated by `com.apple.security.device.bluetooth` + NSBluetoothAlwaysUsageDescription.
//
// Protocol (extracted from idotmatrix lib):
//   • Scan filter: advertised service UUID first, known name families second —
//     `IDotMatrixIdentity` (generated from shared/src/idotmatrix-identity.ts). The
//     same panel ships as "IDM-…" and "iPixel-…", so a vendor prefix is not the filter.
//   • Service 000000fa-…, Write characteristic 0000fa02-… (write WITHOUT response)
//   • setMode(1)  → [0x05,0x00,0x04,0x01,0x01]  (enter DIY drawing mode)
//   • setBrightness(n 5–100) → [0x05,0x00,0x04,0x80,n]
//   • image: 32×32 → PNG → per 4096B PNG chunk:
//       UInt16LE(pngLen + nChunks) + [0x00,0x00, i>0 ? 0x02 : 0x00] + UInt32LE(pngLen) + chunk
//     concatenated, then written in MTU-sized BLE chunks.
//
// All connect/write awaits carry an explicit timeout (CLAUDE.md "External peer async I/O":
// timeout is the first-class signal; a silent BLE drop must not hang the daemon).

import Foundation
@preconcurrency import CoreBluetooth

enum IDotMatrixBLEError: Error, CustomStringConvertible {
    case bluetoothUnavailable(String)   // poweredOff / unauthorized / unsupported
    case connectTimeout
    case writeTimeout
    case notConnected
    case characteristicMissing
    case peripheralNotFound

    var description: String {
        switch self {
        case .bluetoothUnavailable(let s): return "Bluetooth unavailable: \(s)"
        case .connectTimeout: return "BLE connect timed out"
        case .writeTimeout: return "BLE write timed out"
        case .notConnected: return "iDotMatrix not connected"
        case .characteristicMissing: return "iDotMatrix write characteristic not found"
        case .peripheralNotFound: return "iDotMatrix peripheral not found"
        }
    }
}

struct IDotMatrixDiscovered: Sendable, Equatable {
    let id: UUID          // CBPeripheral.identifier (the macOS-stable address)
    let name: String
}

/// CoreBluetooth central confined to a private serial queue. All mutable state is
/// touched only on `queue`, so the type is `@unchecked Sendable`; the IDotMatrixModule
/// actor calls the async API and the continuations resume from delegate callbacks.
final class IDotMatrixBLE: NSObject, @unchecked Sendable {
    // iDotMatrix advertises service 000000fa-..., not 0000fa00-....
    // UUIDs and the name families come from the generated identity mirror.
    static let serviceUUID = CBUUID(string: IDotMatrixIdentity.serviceUUIDString)
    static let writeCharUUID = CBUUID(string: IDotMatrixIdentity.writeCharacteristicUUIDString)

    private let queue = DispatchQueue(label: "dev.agentdeck.idotmatrix.ble")
    private var central: CBCentralManager!

    private var peripheral: CBPeripheral?
    private var writeChar: CBCharacteristic?

    // One-shot continuations (all touched on `queue`). Every continuation here MUST
    // also resume on task cancellation: `withTimeout` runs work + timer in a task
    // group, and the group cannot return — even after the timer child throws — until
    // the work child finishes. A continuation that only a CB delegate callback can
    // resume turns "timeout" into a permanent hang when that callback never arrives
    // (Bluetooth permission undecided, device powered off mid-connect). The
    // *CancelPending flags close the race where onCancel fires before the
    // queue-confined registration block has run.
    private var stateContinuations: [UUID: CheckedContinuation<Void, Error>] = [:]
    private var cancelledStateWaiters: Set<UUID> = []
    private var connectContinuation: CheckedContinuation<Void, Error>?
    private var connectCancelPending = false
    private var connectTimedOut = false
    private var writeReadyContinuation: CheckedContinuation<Void, Error>?
    private var writeReadyCancelPending = false

    // Scan accumulation.
    private var scanResults: [UUID: String] = [:]
    private var scanContinuation: CheckedContinuation<[IDotMatrixDiscovered], Never>?
    /// User-configured name prefixes for this scan (settings.json
    /// `idotmatrixNamePrefixes`), on top of the generated families.
    private var extraNamePrefixes: [String] = []

    private let connectTimeoutSec: TimeInterval = 10
    private let writeTimeoutSec: TimeInterval = 6

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: queue,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: false])
        DaemonLogger.shared.debug("IDotMatrixBLE", "central created — authorization=\(TimeboxBLE.describeAuthorization())")
    }

    // MARK: - Public async API

    /// Resolve once the central is powered on, or throw if BT is unavailable.
    func waitUntilReady(timeout: TimeInterval = 5) async throws {
        try await withTimeout(timeout, onTimeout: { .bluetoothUnavailable("powered-on wait timed out") }) {
            let waiterId = UUID()
            defer { self.queue.async { _ = self.cancelledStateWaiters.remove(waiterId) } }
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                    self.queue.async {
                        if self.cancelledStateWaiters.remove(waiterId) != nil {
                            cont.resume(throwing: CancellationError())
                            return
                        }
                        switch self.central.state {
                        case .poweredOn:
                            cont.resume()
                        case .poweredOff:
                            cont.resume(throwing: IDotMatrixBLEError.bluetoothUnavailable("powered off"))
                        case .unauthorized:
                            cont.resume(throwing: IDotMatrixBLEError.bluetoothUnavailable("unauthorized"))
                        case .unsupported:
                            cont.resume(throwing: IDotMatrixBLEError.bluetoothUnavailable("unsupported"))
                        default:
                            // .unknown / .resetting — wait for the next state callback.
                            self.stateContinuations[waiterId] = cont
                        }
                    }
                }
            } onCancel: {
                self.queue.async {
                    if let cont = self.stateContinuations.removeValue(forKey: waiterId) {
                        cont.resume(throwing: CancellationError())
                    } else {
                        self.cancelledStateWaiters.insert(waiterId)
                    }
                }
            }
        }
    }

    /// Scan for iDotMatrix-protocol panels for `duration` seconds and return what
    /// was seen. `extraNamePrefixes` widens the name fallback with the user's
    /// `idotmatrixNamePrefixes`; the service-UUID match needs no configuration.
    func scan(duration: TimeInterval = 4, extraNamePrefixes: [String] = []) async -> [IDotMatrixDiscovered] {
        try? await waitUntilReady()
        return await withCheckedContinuation { (cont: CheckedContinuation<[IDotMatrixDiscovered], Never>) in
            queue.async {
                self.scanResults.removeAll()
                self.extraNamePrefixes = extraNamePrefixes
                self.scanContinuation = cont
                guard self.central.state == .poweredOn else {
                    self.scanContinuation = nil
                    cont.resume(returning: [])
                    return
                }
                self.central.scanForPeripherals(withServices: nil,
                                                options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
                self.queue.asyncAfter(deadline: .now() + duration) {
                    self.finishScan()
                }
            }
        }
    }

    private func finishScan() {
        guard let cont = scanContinuation else { return }
        scanContinuation = nil
        if central.state == .poweredOn { central.stopScan() }
        let results = scanResults.map { IDotMatrixDiscovered(id: $0.key, name: $0.value) }
            .sorted { $0.name < $1.name }
        cont.resume(returning: results)
    }

    /// Connect to a peripheral by its CBPeripheral.identifier (UUID string in settings),
    /// discover fa00/fa02, and leave the device ready for writes.
    func connect(uuidString: String) async throws {
        guard let uuid = UUID(uuidString: uuidString) else {
            throw IDotMatrixBLEError.peripheralNotFound
        }
        try await waitUntilReady()

        // Resolve the peripheral: prefer a cached/known handle, else a brief scan.
        let target: CBPeripheral = try await resolvePeripheral(uuid: uuid)

        try await withTimeout(connectTimeoutSec, onTimeout: { .connectTimeout }) {
            defer { self.queue.async { self.connectCancelPending = false } }
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                    self.queue.async {
                        if self.connectCancelPending {
                            self.connectCancelPending = false
                            cont.resume(throwing: CancellationError())
                            return
                        }
                        self.peripheral = target
                        target.delegate = self
                        self.writeChar = nil
                        self.connectContinuation = cont
                        self.connectTimedOut = false
                        self.central.connect(target, options: nil)
                    }
                }
            } onCancel: {
                self.queue.async {
                    if let cont = self.connectContinuation {
                        self.connectContinuation = nil
                        // CB connect attempts never expire on their own — cancel the
                        // pending attempt so it can't complete into a stale delegate.
                        self.central.cancelPeripheralConnection(target)
                        cont.resume(throwing: CancellationError())
                    } else {
                        self.connectCancelPending = true
                    }
                }
            }
        }
    }

    private func resolvePeripheral(uuid: UUID) async throws -> CBPeripheral {
        // Fast path: retrieve a known peripheral by identifier (no scan needed once paired).
        if let known: CBPeripheral = await withCheckedContinuation({ (cont: CheckedContinuation<CBPeripheral?, Never>) in
            queue.async {
                cont.resume(returning: self.central.retrievePeripherals(withIdentifiers: [uuid]).first)
            }
        }) {
            return known
        }
        // Slow path: scan briefly until the matching identifier advertises.
        _ = await scan(duration: 5)
        let again: CBPeripheral? = await withCheckedContinuation { (cont: CheckedContinuation<CBPeripheral?, Never>) in
            queue.async {
                cont.resume(returning: self.central.retrievePeripherals(withIdentifiers: [uuid]).first)
            }
        }
        guard let p = again else { throw IDotMatrixBLEError.peripheralNotFound }
        return p
    }

    func disconnect() async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            queue.async {
                if let p = self.peripheral { self.central.cancelPeripheralConnection(p) }
                self.peripheral = nil
                self.writeChar = nil
                cont.resume()
            }
        }
    }

    var isConnected: Bool {
        queue.sync { peripheral?.state == .connected && writeChar != nil }
    }

    // MARK: - Protocol commands

    /// `[0x05,0x00,0x04,0x01,mode]` — enter/exit DIY drawing mode.
    static func modeCommand(_ mode: UInt8) -> Data { Data([0x05, 0x00, 0x04, 0x01, mode]) }
    /// `[0x05,0x00,0x04,0x80,n]` — hardware brightness (clamped 5–100).
    static func brightnessCommand(_ percent: Int) -> Data {
        Data([0x05, 0x00, 0x04, 0x80, UInt8(max(5, min(100, percent)))])
    }

    func setMode(_ mode: UInt8 = 1) async throws {
        try await writeRaw(Self.modeCommand(mode))
    }

    func setBrightness(_ percent: Int) async throws {
        try await writeRaw(Self.brightnessCommand(percent))
    }

    /// Upload a PNG (already 32×32) following the idotmatrix `_createPayloads` framing.
    func uploadImage(pngData: Data) async throws {
        try await writeRaw(Self.buildImagePayloads(pngData: pngData))
    }

    /// Build the concatenated image payload from raw PNG bytes.
    /// Per 4096-byte PNG chunk i:
    ///   UInt16LE(pngLen + nChunks) ++ [0,0, i>0 ? 2 : 0] ++ UInt32LE(pngLen) ++ chunk
    static func buildImagePayloads(pngData: Data, chunkSize: Int = 4096) -> Data {
        var chunks: [Data] = []
        var offset = 0
        while offset < pngData.count {
            let end = min(offset + chunkSize, pngData.count)
            chunks.append(pngData.subdata(in: offset..<end))
            offset = end
        }
        if chunks.isEmpty { chunks = [Data()] }

        let pngLen = UInt32(pngData.count)
        let idk = UInt16(truncatingIfNeeded: pngData.count + chunks.count)

        var out = Data()
        for (i, chunk) in chunks.enumerated() {
            out.append(UInt8(idk & 0xFF))
            out.append(UInt8((idk >> 8) & 0xFF))
            out.append(contentsOf: [0x00, 0x00, i > 0 ? 0x02 : 0x00])
            out.append(UInt8(pngLen & 0xFF))
            out.append(UInt8((pngLen >> 8) & 0xFF))
            out.append(UInt8((pngLen >> 16) & 0xFF))
            out.append(UInt8((pngLen >> 24) & 0xFF))
            out.append(chunk)
        }
        return out
    }

    // MARK: - Raw write with MTU chunking + flow control

    private func writeRaw(_ data: Data) async throws {
        try await withTimeout(writeTimeoutSec, onTimeout: { .writeTimeout }) {
            defer { self.queue.async { self.writeReadyCancelPending = false } }
            // Snapshot the peripheral/char on the queue.
            let (p, ch): (CBPeripheral, CBCharacteristic) = try await withCheckedThrowingContinuation { cont in
                self.queue.async {
                    guard let p = self.peripheral, p.state == .connected else {
                        cont.resume(throwing: IDotMatrixBLEError.notConnected); return
                    }
                    guard let ch = self.writeChar else {
                        cont.resume(throwing: IDotMatrixBLEError.characteristicMissing); return
                    }
                    cont.resume(returning: (p, ch))
                }
            }

            let mtu = max(20, p.maximumWriteValueLength(for: .withoutResponse))
            var offset = 0
            while offset < data.count {
                let end = min(offset + mtu, data.count)
                let slice = data.subdata(in: offset..<end)
                try await self.writeChunk(slice, to: p, characteristic: ch)
                offset = end
            }
            // Mirror the reference idotmatrix client's per-command settle
            // (connectionManager.send → time.sleep(0.01)). The panel needs a
            // beat to consume one command before the next arrives; back-to-back
            // write-without-response bursts (setMode→brightness→image in a few ms)
            // otherwise get dropped and the device ignores the DIY-mode switch.
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    private func writeChunk(_ slice: Data, to p: CBPeripheral, characteristic ch: CBCharacteristic) async throws {
        // Honor write-without-response flow control: if the peripheral's buffer is
        // full, wait for `peripheralIsReady(toSendWriteWithoutResponse:)`.
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                self.queue.async {
                    if self.writeReadyCancelPending {
                        self.writeReadyCancelPending = false
                        cont.resume(throwing: CancellationError())
                        return
                    }
                    if p.canSendWriteWithoutResponse {
                        cont.resume()
                    } else {
                        self.writeReadyContinuation = cont
                    }
                }
            }
        } onCancel: {
            self.queue.async {
                if let cont = self.writeReadyContinuation {
                    self.writeReadyContinuation = nil
                    cont.resume(throwing: CancellationError())
                } else {
                    self.writeReadyCancelPending = true
                }
            }
        }
        queue.async {
            p.writeValue(slice, for: ch, type: .withoutResponse)
        }
    }

    // MARK: - Timeout helper (OpenClawAdapter pattern)

    private func withTimeout<T: Sendable>(
        _ seconds: TimeInterval,
        onTimeout: @escaping @Sendable () -> IDotMatrixBLEError,
        _ work: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                throw onTimeout()
            }
            let result = try await group.next()!
            group.cancelAll()
            return result
        }
    }
}

// MARK: - CBCentralManagerDelegate

extension IDotMatrixBLE: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        DaemonLogger.shared.debug("IDotMatrixBLE", "central state → \(TimeboxBLE.describeState(central.state)) (auth=\(TimeboxBLE.describeAuthorization()))")
        // Resolve everyone waiting on a ready/state transition.
        let waiters = stateContinuations
        stateContinuations.removeAll()
        switch central.state {
        case .poweredOn:
            waiters.values.forEach { $0.resume() }
        case .poweredOff:
            waiters.values.forEach { $0.resume(throwing: IDotMatrixBLEError.bluetoothUnavailable("powered off")) }
        case .unauthorized:
            waiters.values.forEach { $0.resume(throwing: IDotMatrixBLEError.bluetoothUnavailable("unauthorized")) }
        case .unsupported:
            waiters.values.forEach { $0.resume(throwing: IDotMatrixBLEError.bluetoothUnavailable("unsupported")) }
        default:
            // .resetting / .unknown — re-queue and wait for the next transition.
            stateContinuations = waiters
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let advName = (advertisementData[CBAdvertisementDataLocalNameKey] as? String) ?? peripheral.name ?? ""
        // Protocol truth first: a panel advertising the iDotMatrix service is one,
        // whatever the vendor called it. The name families are the fallback for
        // panels that keep the service out of the advertisement packet.
        let advertisedServices = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID]) ?? []
        guard IDotMatrixIdentity.matchesAdvertisement(name: advName,
                                                      serviceUUIDs: advertisedServices.map(\.uuidString),
                                                      extraPrefixes: extraNamePrefixes) else { return }
        scanResults[peripheral.identifier] = advName.isEmpty ? "Unnamed display" : advName
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.delegate = self
        peripheral.discoverServices([Self.serviceUUID])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        failConnect(IDotMatrixBLEError.connectTimeout)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if peripheral.identifier == self.peripheral?.identifier {
            writeChar = nil
            // If a connect was still pending, surface it as a failure.
            failConnect(IDotMatrixBLEError.connectTimeout)
        }
    }

    private func failConnect(_ error: Error) {
        guard let cont = connectContinuation else { return }
        connectContinuation = nil
        cont.resume(throwing: error)
    }

    private func completeConnect() {
        guard let cont = connectContinuation else { return }
        connectContinuation = nil
        cont.resume()
    }
}

// MARK: - CBPeripheralDelegate

extension IDotMatrixBLE: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if error != nil { failConnect(IDotMatrixBLEError.connectTimeout); return }
        guard let svc = peripheral.services?.first(where: { $0.uuid == Self.serviceUUID }) else {
            failConnect(IDotMatrixBLEError.characteristicMissing); return
        }
        peripheral.discoverCharacteristics([Self.writeCharUUID], for: svc)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if error != nil { failConnect(IDotMatrixBLEError.connectTimeout); return }
        guard let ch = service.characteristics?.first(where: { $0.uuid == Self.writeCharUUID }) else {
            failConnect(IDotMatrixBLEError.characteristicMissing); return
        }
        writeChar = ch
        completeConnect()
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        guard let cont = writeReadyContinuation else { return }
        writeReadyContinuation = nil
        cont.resume()
    }
}
#endif
