#if os(macOS)
// TimeboxModule.swift — Divoom Timebox Mini (BLE variant) 11×11 LED display support.
//
// Native CoreBluetooth replacement for the Node CLI's Python `timebox/sync_ble.py`, so
// the App Store macOS build can drive a BLE Timebox with no subprocess (App Review 2.5.2).
// Mirrors IDotMatrixModule's lifecycle/Shadow/circuit-breaker/offline-frame patterns; the
// transport is TimeboxBLE (ISSC transparent-UART GATT) and the wire format is the Divoom
// static-image packet (TimeboxDivoomPacket), NOT iDotMatrix's PNG chunks.
//
// Timebox Mini is BLE-only: `timeboxDevices` entries carry a BLE `address`. This module
// drives the first entry that has an `address`. (The legacy Bluetooth Classic SPP variant
// was removed — poor macOS compatibility and no App Store path.)
//
// Frames come from the same in-process PixooRenderer as Pixoo/iDotMatrix, but via the
// dedicated `renderMicro` layout — bold hand-authored native 11×11 creature glyphs
// (MicroGlyphs) on a status field, so the 11×11 panel stays legible. The glyph colors
// are device-tuned (WYSIWYG); prepareFrame applies only the software brightness dim
// before TimeboxDivoomPacket nibble-encodes the frame.

import Foundation
import AppKit
@preconcurrency import CoreBluetooth

struct TimeboxBLEDevice: Codable, Equatable {
    let address: String   // CBPeripheral.identifier UUID string (macOS-stable)
    var name: String?
    var brightness: Int?
}

private final class TimeboxSettingsDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func set(_ d: Data?) { lock.lock(); data = d; lock.unlock() }
    func get() -> Data? { lock.lock(); defer { lock.unlock() }; return data }
}

actor TimeboxModule: DeviceModule {
    /// Lock-protected mirror for sync cross-actor status reads (DaemonServer health).
    private final class Shadow: @unchecked Sendable {
        private let lock = NSLock()
        private var snapshot: [String: Any] = [
            "configuredDeviceCount": 0,
            "connected": false,
            "deviceName": NSNull(),
            "lastError": NSNull(),
            "displayDimmed": false,
            "hasFrame": false,
            "lastPushAtMs": NSNull(),
        ]
        func write(_ s: [String: Any]) { lock.lock(); snapshot = s; lock.unlock() }
        func read() -> [String: Any] { lock.lock(); defer { lock.unlock() }; return snapshot }
    }

    nonisolated let name = "timebox"
    private nonisolated let shadow = Shadow()

    private var devices: [TimeboxBLEDevice] = []
    private var ble: TimeboxBLE?
    private var connected = false
    private var lastError: String?

    private var consecutiveFailures = 0
    private var backoffUntil: Date?
    private let backoffInitialSec: TimeInterval = 5
    private let backoffMaxSec: TimeInterval = 120

    private var renderTask: Task<Void, Never>?
    private var settingsReloadTask: Task<Void, Never>?
    private let renderIntervalSec: TimeInterval = 1.0
    private let settingsReloadIntervalSec: TimeInterval = 5
    private var isPushing = false

    private var onStateChanged: (@Sendable () -> Void)?
    private var lastBroadcastDigest: String?

    private let renderer = PixooRenderer()
    private var lastPushedRGB: [UInt8]?
    private var lastPushAtMs: Int64?

    // Timebox has no hardware brightness command — brightness is applied in software
    // during encode. Dimming therefore lowers the effective encode brightness (or
    // blacks the panel for dim mode "off").
    private var displayDimmed = false
    private var dimBrightnessOverride: Int?
    private var lastDimSignature = ""

    func setOnStateChanged(_ handler: @escaping @Sendable () -> Void) {
        self.onStateChanged = handler
    }

    // MARK: - Lifecycle

    func start() async {
        await reloadDevicesFromSettings(reason: "startup", force: true)
        let renderInterval = renderIntervalSec
        let settingsInterval = settingsReloadIntervalSec

        renderTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(renderInterval))
                await self?.tick()
            }
        }
        settingsReloadTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(settingsInterval))
                await self?.reloadDevicesFromSettings(reason: "settings reload")
            }
        }
        refreshShadow()
    }

    func stop() async {
        renderTask?.cancel(); await renderTask?.value; renderTask = nil
        settingsReloadTask?.cancel(); await settingsReloadTask?.value; settingsReloadTask = nil

        // Graceful teardown: blank the panel (11×11 black) then drop the BLE link.
        if connected, let ble {
            let n = TimeboxDivoomPacket.width
            try? await ble.uploadFrame(rgb11x11: [UInt8](repeating: 0, count: n * n * 3))
        }
        await ble?.disconnect()
        connected = false
        refreshShadow()
    }

    func handleWake() async {
        await reloadDevicesFromSettings(reason: "wake")
        await ble?.disconnect()
        connected = false
        consecutiveFailures = 0
        backoffUntil = nil
        lastPushedRGB = nil
        refreshShadow()
    }

    nonisolated func statusSnapshot() -> [String: Any] { shadow.read() }

    // MARK: - Settings

    private static let settingsFile = AuthManager.agentDeckDir.appendingPathComponent("settings.json")
    private static let settingsReadQueue = DispatchQueue(label: "dev.agentdeck.timebox.settings-read", qos: .userInteractive)
    private static let settingsReadTimeout: DispatchTimeInterval = .milliseconds(700)

    func reloadFromSettingsExternal() async {
        await reloadDevicesFromSettings(reason: "ui-trigger", force: true)
    }

    private func reloadDevicesFromSettings(reason: String, force: Bool = false) async {
        let latest = Self.loadDevices()
        guard force || latest != devices else { return }

        let previousActive = devices.first?.address
        devices = latest
        let newActive = devices.first?.address

        if devices.count > 1 {
            DaemonLogger.shared.info("Timebox: \(devices.count) BLE devices configured — driving first only (\(newActive ?? "?"))")
        }

        if previousActive != newActive {
            await ble?.disconnect()
            connected = false
            consecutiveFailures = 0
            backoffUntil = nil
            lastPushedRGB = nil
            if newActive == nil {
                DaemonLogger.shared.debug("Timebox", "No BLE devices configured; watching settings.json")
            } else {
                DaemonLogger.shared.info("Timebox \(reason): driving \(newActive!)")
            }
        } else {
            // Same device — brightness change applies on the next render (software).
            lastPushedRGB = nil
        }
        refreshShadow()
    }

    /// Load configured Timebox devices (those with a BLE `address`).
    static func loadDevices() -> [TimeboxBLEDevice] {
        let box = TimeboxSettingsDataBox()
        let semaphore = DispatchSemaphore(value: 0)
        settingsReadQueue.async {
            box.set(try? Data(contentsOf: settingsFile))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + settingsReadTimeout) == .success else { return [] }
        guard let data = box.get(),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = json["timeboxDevices"] as? [[String: Any]] else { return [] }
        return arr.compactMap { d in
            guard let raw = d["address"] as? String else { return nil }   // BLE-only
            let addr = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !addr.isEmpty else { return nil }
            return TimeboxBLEDevice(address: addr, name: d["name"] as? String, brightness: d["brightness"] as? Int)
        }
    }

    // MARK: - Render / push loop

    private func tick() async {
        guard let device = devices.first else { return }
        guard !isPushing else { return }
        isPushing = true
        defer { isPushing = false }

        if let until = backoffUntil, Date() < until { return }

        if !connected {
            guard await ensureConnected(device) else { return }
        }

        // renderMicro returns the native 11×11 glyph frame (idle status field when
        // nothing is active), so no separate disconnected placeholder is needed.
        let state = currentDashboardState()
        let rgb11Data = renderer.renderMicro(dashboardState: state)

        // Software brightness: device brightness, or the dim override while the host
        // display is asleep (0 = panel goes black for dim mode "off").
        let brightness = displayDimmed ? (dimBrightnessOverride ?? 0) : (device.brightness ?? 80)
        let rgb11 = Self.prepareFrame(rgb11Data, brightness: brightness)
        if rgb11 == lastPushedRGB { return }

        guard let ble else { return }
        do {
            try await ble.uploadFrame(rgb11x11: rgb11)
            lastPushedRGB = rgb11
            lastPushAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            recordSuccess()
        } catch {
            recordFailure("upload: \(error)")
            await dropConnection()
        }
        refreshShadow()
    }

    private func ensureConnected(_ device: TimeboxBLEDevice) async -> Bool {
        if ble == nil { ble = TimeboxBLE() }
        guard let ble else { return false }
        do {
            try await ble.connect(uuidString: device.address)
            // Settle before the first write (the panel drops writes that land too
            // early after the GATT link comes up — write-without-response has no ACK).
            try? await Task.sleep(for: .milliseconds(300))
            connected = true
            lastError = nil
            consecutiveFailures = 0
            backoffUntil = nil
            DaemonLogger.shared.info("Timebox connected: \(device.name ?? device.address)")
            refreshShadow()
            return true
        } catch {
            recordFailure("connect: \(error)")
            await dropConnection()
            return false
        }
    }

    private func dropConnection() async {
        connected = false
        lastPushedRGB = nil
        await ble?.disconnect()
        refreshShadow()
    }

    private func recordSuccess() {
        consecutiveFailures = 0
        backoffUntil = nil
        lastError = nil
    }

    private func recordFailure(_ reason: String) {
        consecutiveFailures += 1
        lastError = reason
        let delay = min(backoffInitialSec * pow(2.0, Double(consecutiveFailures - 1)), backoffMaxSec)
        backoffUntil = Date().addingTimeInterval(delay)
        if consecutiveFailures == 1 || consecutiveFailures % 5 == 0 {
            DaemonLogger.shared.error("Timebox failure [\(consecutiveFailures)]: \(reason) — backing off \(Int(delay))s")
        }
    }

    // MARK: - Broadcast events (cache for next render) — mirrors IDotMatrixModule

    private var cachedState = "disconnected"
    private var cachedProject: String?
    private var cachedModel: String?
    private var cachedTool: String?
    private var cachedAgentType: String?
    private var cachedSessions: [[String: Any]] = []
    private var cached5h: Double?
    private var cached7d: Double?
    private var cached5hResetsAt: String?
    private var cached7dResetsAt: String?
    private var cachedGatewayAvailable = false
    private var cachedGatewayConnected = false
    private var cachedGatewayHasError = false

    func handleEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "state_update":
            let eventAgentType = event["agentType"] as? String
            let creatureAgents: Set<String> = ["claude-code", "codex-cli", "codex-app", "opencode"]
            if let at = eventAgentType, creatureAgents.contains(at) {
                cachedState = event["state"] as? String ?? "disconnected"
                cachedProject = event["projectName"] as? String
                cachedModel = event["modelName"] as? String
                cachedTool = event["currentTool"] as? String
                cachedAgentType = eventAgentType
            } else if cachedAgentType == nil {
                cachedState = event["state"] as? String ?? "disconnected"
                cachedAgentType = eventAgentType
            }
            cachedGatewayAvailable = event["gatewayAvailable"] as? Bool ?? cachedGatewayAvailable
            cachedGatewayConnected = event["gatewayConnected"] as? Bool ?? cachedGatewayConnected
            cachedGatewayHasError = event["gatewayHasError"] as? Bool ?? cachedGatewayHasError
        case "usage_update":
            cached5h = event["fiveHourPercent"] as? Double
            cached7d = event["sevenDayPercent"] as? Double
            cached5hResetsAt = event["fiveHourResetsAt"] as? String
            cached7dResetsAt = event["sevenDayResetsAt"] as? String
        case "sessions_list":
            cachedSessions = event["sessions"] as? [[String: Any]] ?? []
        case "display_state":
            let displayOn = event["displayOn"] as? Bool ?? true
            let dim = event["dim"] as? [String: Any]
            let dimEnabled = dim?["enabled"] as? Bool ?? true
            let dimMode = (dim?["mode"] as? String) == "min" ? "min" : "off"
            let dimLevel = max(0, min(100, dim?["level"] as? Int ?? 10))
            let signature = "\(displayOn)|\(dimEnabled)|\(dimMode)|\(dimLevel)"
            if signature != lastDimSignature {
                if !displayOn && dimEnabled {
                    displayDimmed = true
                    dimBrightnessOverride = dimMode == "off" ? 0 : dimLevel
                } else {
                    displayDimmed = false
                    dimBrightnessOverride = nil
                }
                lastPushedRGB = nil   // force a re-render at the new effective brightness
                lastDimSignature = signature
                refreshShadow()
            }
        default: break
        }
    }

    // MARK: - DashboardState assembly (mirrors IDotMatrixModule)

    private func currentDashboardState() -> DashboardState {
        var state = DashboardState()
        state.bridgeConnected = cachedState != "disconnected"
        state.sessionId = firstAliveSession(in: cachedSessions)?["id"] as? String
        state.state = AgentConnectionState(rawValue: cachedState) ?? .idle
        state.agentType = cachedAgentType ?? firstAliveSession(in: cachedSessions)?["agentType"] as? String
        state.projectName = cachedProject ?? firstAliveSession(in: cachedSessions)?["projectName"] as? String
        state.modelName = cachedModel
        state.currentTool = cachedTool
        state.fiveHourPercent = cached5h
        state.sevenDayPercent = cached7d
        state.fiveHourResetsAt = cached5hResetsAt
        state.sevenDayResetsAt = cached7dResetsAt
        state.gatewayAvailable = cachedGatewayAvailable
        state.gatewayConnected = cachedGatewayConnected
        state.gatewayHasError = cachedGatewayHasError
        state.siblingSessions = cachedSessions.compactMap(Self.makeSessionInfo)
        return state
    }

    private func firstAliveSession(in sessions: [[String: Any]]) -> [String: Any]? {
        sessions.first { ($0["alive"] as? Bool) ?? true }
    }

    private static func makeSessionInfo(from raw: [String: Any]) -> SessionInfo? {
        guard let id = raw["id"] as? String else { return nil }
        let port: Int
        if let p = raw["port"] as? Int { port = p }
        else if let n = raw["port"] as? NSNumber { port = n.intValue }
        else { port = 0 }
        return SessionInfo(
            id: id, port: port,
            projectName: raw["projectName"] as? String,
            agentType: raw["agentType"] as? String,
            alive: (raw["alive"] as? Bool) ?? true,
            state: raw["state"] as? String
        )
    }

    // MARK: - Shadow / broadcast

    /// Human-readable reason the device isn't streaming, so `/health` can tell
    /// "device off", "paused while host display asleep", and "never attempted"
    /// apart instead of an ambiguous `connected:false, lastError:null`.
    private func currentStatusReason() -> String {
        if devices.isEmpty { return "no device configured" }
        if connected { return "connected" }
        if displayDimmed { return "paused: host display asleep" }
        if let lastError { return lastError }
        if let until = backoffUntil, Date() < until { return "retrying (backed off)" }
        return "connecting…"
    }

    private func refreshShadow() {
        let statusReason = currentStatusReason()
        let snapshot: [String: Any] = [
            "configuredDeviceCount": devices.count,
            "connected": connected,
            "deviceName": devices.first?.name ?? devices.first?.address ?? NSNull(),
            "lastError": lastError as Any,
            "statusReason": statusReason,
            "displayDimmed": displayDimmed,
            "hasFrame": lastPushedRGB != nil,
            "lastPushAtMs": lastPushAtMs as Any,
        ]
        shadow.write(snapshot)
        let digest = "count=\(devices.count)|conn=\(connected)|dim=\(displayDimmed)|reason=\(statusReason)|err=\(lastError ?? "")"
        if digest != lastBroadcastDigest {
            lastBroadcastDigest = digest
            onStateChanged?()
        }
    }

    // MARK: - Frame conversion (native 11×11 micro frame → device payload)

    /// Apply the software brightness dim to the native 11×11 micro frame. The glyph
    /// colors are already device-tuned (WYSIWYG, matching sync_ble.py's identity
    /// pipeline), so the only transform is the 0-100 brightness scale; the packet
    /// builder handles 4-bit quantization. brightness 0 → black panel.
    static func prepareFrame(_ rgb11: Data, brightness: Int) -> [UInt8] {
        let n = TimeboxDivoomPacket.width
        let expected = n * n * 3
        if brightness <= 0 { return [UInt8](repeating: 0, count: expected) }
        var rgb = [UInt8](rgb11)
        guard rgb.count == expected else { return [UInt8](repeating: 0, count: expected) }
        if brightness != 100 {
            let f = Double(brightness) / 100.0
            rgb = rgb.map { UInt8(max(0, min(255, (Double($0) * f).rounded()))) }
        }
        return rgb
    }
}
#endif
