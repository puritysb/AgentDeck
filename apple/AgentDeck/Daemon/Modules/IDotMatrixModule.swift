#if os(macOS)
// IDotMatrixModule.swift — iDotMatrix 32×32 BLE LED display support.
//
// Native CoreBluetooth replacement for the Node CLI's Python `idotmatrix/sync.py`,
// so the App Store macOS build can drive an iDotMatrix with no subprocess. Mirrors
// PixooModule's lifecycle/Shadow/circuit-breaker/offline-frame patterns; the transport
// is IDotMatrixBLE (GATT) instead of HTTP. Frames come from the same in-process
// PixooRenderer (64×64 RGB), box-downscaled to 32×32 and PNG-encoded for the device.
//
// Coexistence: unlike Pixoo/D200H/ESP32 (which the Node CLI daemon drives natively, so
// the Swift app must not double-drive them), no external daemon can drive iDotMatrix's
// BLE transport natively — the Node path needs a separate `agentdeck idotmatrix sync`
// Python client. So this module runs in BOTH hub mode (owned by DaemonServer, fed by
// wsServer.onBroadcast) AND client mode (an external daemon owns port 9120; owned by
// DaemonService.clientModeIDotMatrix, fed by BridgeConnection.onRawMessage →
// ingestExternalBroadcast). The two owners are mutually exclusive — hub mode has a live
// DaemonServer, client mode has none — so only one instance is ever live.
// The remaining overlap is a standalone `agentdeck idotmatrix sync` running alongside the
// Swift app: BLE allows a single central connection, so whichever process holds it drives
// the display and the other's connect simply fails. The circuit breaker below backs off on
// that failure instead of thrashing — run only one of the two.
//
// Only the first configured device is driven (matching the Node sync client, which uses
// devices[0]); additional entries are persisted but logged as not-yet-driven.

import Foundation
import AppKit
@preconcurrency import CoreBluetooth

struct IDotMatrixDevice: Codable, Equatable {
    let address: String   // CBPeripheral.identifier UUID string (macOS-stable)
    var name: String?
    var brightness: Int?
}

private final class IDMSettingsDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    func set(_ d: Data?) { lock.lock(); data = d; lock.unlock() }
    func get() -> Data? { lock.lock(); defer { lock.unlock() }; return data }
}

actor IDotMatrixModule: DeviceModule {
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

    nonisolated let name = "idotmatrix"
    private nonisolated let shadow = Shadow()

    private var devices: [IDotMatrixDevice] = []
    private var ble: IDotMatrixBLE?
    private var connected = false
    private var lastError: String?

    // Circuit breaker (mirrors PixooModule)
    private var consecutiveFailures = 0
    private var backoffUntil: Date?
    private let backoffInitialSec: TimeInterval = 5
    private let backoffMaxSec: TimeInterval = 120

    private var renderTask: Task<Void, Never>?
    private var settingsReloadTask: Task<Void, Never>?
    // Fast tick for smooth animation. Frames are deduped on pixels, so identical
    // frames cost nothing (no BLE write) — polling this fast just lets us track
    // the daemon's animation as closely as the BLE link allows. Effective frame
    // rate is therefore BLE-bound, not interval-bound, which is the real ceiling
    // for these panels (same limit the user sees on Pixoo).
    private let renderIntervalSec: TimeInterval = 0.5
    private let settingsReloadIntervalSec: TimeInterval = 5
    private var isPushing = false

    private var onStateChanged: (@Sendable () -> Void)?
    private var lastBroadcastDigest: String?

    private let renderer = PixooRenderer()
    private var lastPushedRGB: [UInt8]?
    private var lastPushAtMs: Int64?

    private var displayDimmed = false
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

        // Graceful teardown: paint OFFLINE then drop the BLE link.
        if connected, let ble, let png = Self.renderPNG(renderer.renderDisconnectedFrame()) {
            try? await ble.uploadImage(pngData: png)
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
    private static let settingsReadQueue = DispatchQueue(label: "dev.agentdeck.idotmatrix.settings-read", qos: .userInteractive)
    private static let settingsReadTimeout: DispatchTimeInterval = .milliseconds(700)

    func reloadFromSettingsExternal() async {
        await reloadDevicesFromSettings(reason: "ui-trigger", force: true)
    }

    private func reloadDevicesFromSettings(reason: String, force: Bool = false) async {
        let latest = Self.loadDevices()
        guard force || latest != devices else { return }

        let previousActive = devices.first?.address
        let previousBrightness = devices.first?.brightness
        devices = latest
        let newActive = devices.first?.address

        if devices.count > 1 {
            DaemonLogger.shared.info("iDotMatrix: \(devices.count) devices configured — driving first only (\(newActive ?? "?"))")
        }

        // If the active device changed/was removed, drop the current link.
        if previousActive != newActive {
            await ble?.disconnect()
            connected = false
            consecutiveFailures = 0
            backoffUntil = nil
            lastPushedRGB = nil
            if newActive == nil {
                DaemonLogger.shared.debug("iDotMatrix", "No devices configured; watching settings.json")
            } else {
                DaemonLogger.shared.info("iDotMatrix \(reason): driving \(newActive!)")
            }
        } else if connected, let newBrightness = devices.first?.brightness, newBrightness != previousBrightness {
            // Same device, brightness changed live (slider) — apply without reconnecting.
            await setBrightness(newBrightness)
        }
        refreshShadow()
    }

    static func loadDevices() -> [IDotMatrixDevice] {
        let box = IDMSettingsDataBox()
        let semaphore = DispatchSemaphore(value: 0)
        settingsReadQueue.async {
            box.set(try? Data(contentsOf: settingsFile))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + settingsReadTimeout) == .success else { return [] }
        guard let data = box.get(),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let arr = json["idotmatrixDevices"] as? [[String: Any]] else { return [] }
        return arr.compactMap { d in
            guard let raw = d["address"] as? String else { return nil }
            let addr = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !addr.isEmpty else { return nil }
            return IDotMatrixDevice(address: addr, name: d["name"] as? String, brightness: d["brightness"] as? Int)
        }
    }

    // MARK: - Render / push loop

    private func tick() async {
        guard let device = devices.first, !displayDimmed else { return }
        guard !isPushing else { return }
        isPushing = true
        defer { isPushing = false }

        // Honor circuit breaker.
        if let until = backoffUntil, Date() < until { return }

        // Ensure connected (lazy-creates the central → triggers the BT permission
        // prompt only for users who actually configured an iDotMatrix).
        if !connected {
            guard await ensureConnected(device) else { return }
        }

        // Render the 64×64 scene locally and box-downscale to 32×32 (this is the
        // standalone/hub path — when a CLI daemon is present IT drives iDotMatrix
        // via its Python sync client and this module isn't started). Render EVERY
        // tick: PixooRenderer's creature animation is wall-clock driven (Date()),
        // so re-rendering advances it; we dedup on pixels below so a static frame
        // costs no BLE write.
        let state = currentDashboardState()
        let isDisconnectedPlaceholder = state.state == .disconnected && cachedAgentType == nil && cachedSessions.isEmpty
        let rgb64 = isDisconnectedPlaceholder ? renderer.renderDisconnectedFrame() : renderer.render(dashboardState: state)
        var rgb32 = Self.downscale64to32([UInt8](rgb64))
        // Software brightness/contrast boost (mirrors the reference sync client's
        // ImageEnhance.Brightness → Contrast); without it the panel reads dim.
        // Canonical brightness = 1.6 — keep in sync: idotmatrix-daemon-sync.ts
        // (--boost), sync.py (run_sync boost default), IDotMatrixModule.swift.
        rgb32 = Self.boostBrightnessContrast(rgb32, brightness: 1.6, contrast: 1.2)
        if rgb32 == lastPushedRGB { return }
        guard let png = Self.rgb32ToPNG(rgb32) else { return }

        guard let ble else { return }
        do {
            try await ble.uploadImage(pngData: png)
            lastPushedRGB = rgb32
            lastPushAtMs = Int64(Date().timeIntervalSince1970 * 1000)
            recordSuccess()
        } catch {
            recordFailure("upload: \(error)")
            await dropConnection()
        }
        refreshShadow()
    }

    private func ensureConnected(_ device: IDotMatrixDevice) async -> Bool {
        if ble == nil { ble = IDotMatrixBLE() }
        guard let ble else { return false }
        do {
            try await ble.connect(uuidString: device.address)
            // The panel needs a beat after the GATT link comes up before it will
            // accept control commands. The reference Python client gets this for
            // free (BleakClient.connect latency + an HTTP frame fetch between
            // setMode and the first image); without it our first writes land too
            // early, the device silently drops them (write-without-response — no
            // ACK), and the panel stays on its built-in clock. Match the proven
            // client's order too: brightness FIRST, then enter DIY mode.
            try? await Task.sleep(for: .milliseconds(300))
            try await ble.setBrightness(device.brightness ?? 100)
            try await ble.setMode(1)                                  // enter DIY drawing mode
            try? await Task.sleep(for: .milliseconds(50))             // settle before first image
            connected = true
            lastError = nil
            consecutiveFailures = 0
            backoffUntil = nil
            DaemonLogger.shared.info("iDotMatrix connected: \(device.name ?? device.address)")
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
            DaemonLogger.shared.error("iDotMatrix failure [\(consecutiveFailures)]: \(reason) — backing off \(Int(delay))s")
        }
    }

    // MARK: - Brightness / dim

    func setBrightness(_ level: Int) async {
        guard connected, let ble else { return }
        do { try await ble.setBrightness(level) } catch { recordFailure("brightness: \(error)"); await dropConnection() }
    }

    // MARK: - Broadcast events (cache for next render) — mirrors PixooModule

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
            let dimLevel = max(5, min(100, dim?["level"] as? Int ?? 10))
            let signature = "\(dimEnabled)|\(dimMode)|\(dimLevel)"
            if !displayOn {
                if !dimEnabled {
                    if displayDimmed { displayDimmed = false; Task { await restoreBrightness() } }
                } else if !displayDimmed || signature != lastDimSignature {
                    displayDimmed = true
                    // No screen-off command wired; minimum brightness is the dim floor.
                    let target = dimMode == "off" ? 5 : dimLevel
                    Task { await setBrightness(target) }
                }
            } else if displayDimmed {
                displayDimmed = false
                Task { await restoreBrightness() }
            }
            lastDimSignature = signature
            refreshShadow()
        default: break
        }
    }

    private func restoreBrightness() async {
        await setBrightness(devices.first?.brightness ?? 100)
    }

    // MARK: - DashboardState assembly (mirrors PixooModule)

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

    // MARK: - Frame conversion (64×64 RGB → 32×32 PNG)

    /// Downscale a 64×64×3 RGB buffer to 32×32×3 by picking, per 2×2 block, the
    /// single pixel with the highest luminance (its RGB is copied verbatim).
    ///
    /// The creatures are pixel art drawn on a dark background; a 2×2 box-AVERAGE
    /// blends each bright feature pixel with up to three dark neighbours, which
    /// quarters its brightness and smears edges — the panel then reads soft and
    /// dim ("뭉개짐"). Max-luminance selection keeps the salient foreground pixel
    /// crisp and at full intensity, matching the sharpness of the reference 32px
    /// frames. No channel blending, so colours stay coherent.
    static func downscale64to32(_ src: [UInt8]) -> [UInt8] {
        guard src.count >= 64 * 64 * 3 else { return [UInt8](repeating: 0, count: 32 * 32 * 3) }
        var out = [UInt8](repeating: 0, count: 32 * 32 * 3)
        for y in 0..<32 {
            for x in 0..<32 {
                var bestLuma = -1.0
                var br: UInt8 = 0, bg: UInt8 = 0, bb: UInt8 = 0
                for dy in 0..<2 {
                    for dx in 0..<2 {
                        let sx = x * 2 + dx, sy = y * 2 + dy
                        let i = (sy * 64 + sx) * 3
                        let r = src[i], g = src[i + 1], b = src[i + 2]
                        let luma = 0.299 * Double(r) + 0.587 * Double(g) + 0.114 * Double(b)
                        if luma > bestLuma { bestLuma = luma; br = r; bg = g; bb = b }
                    }
                }
                let o = (y * 32 + x) * 3
                out[o] = br; out[o + 1] = bg; out[o + 2] = bb
            }
        }
        return out
    }

    /// Software brightness + contrast boost, replicating the reference iDotMatrix
    /// sync client (sync.py → PIL `ImageEnhance.Brightness` then `Contrast`). The
    /// panel's hardware brightness alone reads dim/washed-out at 32×32, so the
    /// Python path boosts in software before upload; we mirror it for parity.
    /// Order matters: brightness first, then contrast about the image's luminance
    /// mean (PIL's Contrast degenerate is the mean grayscale level).
    static func boostBrightnessContrast(_ rgb: [UInt8], brightness: Double, contrast: Double) -> [UInt8] {
        guard rgb.count % 3 == 0 else { return rgb }
        func clamp(_ v: Double) -> UInt8 { UInt8(max(0, min(255, v.rounded()))) }

        // 1) Brightness: scale each channel.
        var out = rgb.map { clamp(Double($0) * brightness) }

        // 2) Contrast about the luminance mean (matches PIL ImageEnhance.Contrast).
        let pixelCount = out.count / 3
        guard pixelCount > 0 else { return out }
        var sumL = 0.0
        for p in 0..<pixelCount {
            let r = Double(out[3 * p]), g = Double(out[3 * p + 1]), b = Double(out[3 * p + 2])
            sumL += 0.299 * r + 0.587 * g + 0.114 * b
        }
        let meanL = (sumL / Double(pixelCount)).rounded()
        for i in 0..<out.count {
            out[i] = clamp((Double(out[i]) - meanL) * contrast + meanL)
        }
        return out
    }

    /// Encode a 32×32×3 RGB buffer as PNG.
    static func rgb32ToPNG(_ rgb: [UInt8]) -> Data? {
        let w = 32, h = 32
        guard rgb.count == w * h * 3,
              let provider = CGDataProvider(data: Data(rgb) as CFData),
              let cg = CGImage(
                width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 24, bytesPerRow: w * 3,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
        else { return nil }
        let rep = NSBitmapImageRep(cgImage: cg)
        return rep.representation(using: .png, properties: [:])
    }

    /// Convenience: 64×64 RGB Data → 32×32 PNG.
    static func renderPNG(_ rgb64: Data) -> Data? {
        rgb32ToPNG(downscale64to32([UInt8](rgb64)))
    }
}
#endif
