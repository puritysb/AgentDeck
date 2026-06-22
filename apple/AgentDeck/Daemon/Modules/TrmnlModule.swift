#if os(macOS)
// TrmnlModule.swift — TRMNL BYOS e-ink device module for the App Store daemon.
//
// Mirrors bridge/src/trmnl/{byos-server,frame-cache,trmnl-settings,trmnl-telemetry}.ts.
// A WiFi e-ink panel pointed at the daemon's HTTP port auto-enrolls (regardless
// of MAC), polls /api/display on its own schedule, and pulls a server-rendered
// 1-bit PNG sized to the resolution it reports. All App-Store-safe: no subprocess,
// no bundled binaries — rendering is CoreGraphics (TrmnlImageRenderer), transport
// is the existing in-process HTTPServer.
//
// Enrollment + telemetry are in-memory only (no settings.json writes from the
// daemon); on restart a panel simply re-enrolls on its next poll, which is safe
// because auth is soft (MAC is the identity, api_key is advisory).

import Foundation
import CryptoKit

/// A BYOS HTTP reply (pre-serialized JSON body + the HTTP status to send).
struct TrmnlByosResponse: Sendable {
    let status: Int
    let body: Data
}

/// Status snapshot surfaced via the daemon /status route.
struct TrmnlStatus: Sendable {
    let enabled: Bool
    let autoRegister: Bool
    let refreshRate: Int
    /// Cadence currently being served given live session activity.
    let currentRefreshRate: Int
    let deviceCount: Int
    /// Panels that haven't polled within 2× the current cadence (stuck/offline).
    let staleDeviceCount: Int
    let activeResolutions: [String]
    let frameCount: Int
}

actor TrmnlModule: DeviceModule {
    nonisolated let name = "trmnl"

    private struct Device { let apiKey: String; let friendlyId: String }
    private struct Telemetry {
        var fwVersion: String
        var battery: Double?
        var rssi: Double?
        var width: Int?
        var height: Int?
        var refreshRate: Int?
        var userAgent: String
        var lastSeen: Date
    }

    private var cfg = TrmnlConfig()
    private var devices: [String: Device] = [:]        // key = normalized MAC
    private var telemetry: [String: Telemetry] = [:]
    private var frames: [String: (png: Data, hash: String)] = [:]  // key = "<W>x<H>"
    private var frameOrder: [String] = []              // insertion order = LRU recency
    private var lastHashByKey: [String: String] = [:]
    private var lastState = TrmnlDashState()

    private let maxFrames = 8
    private let minDim = 120
    private let maxDim = 4000

    // MARK: - DeviceModule lifecycle

    func start() async { cfg = TrmnlSettings.load() }
    func stop() async {}

    /// Re-read the enable gate / cadence / auto-register policy from settings.
    func reload() { cfg = TrmnlSettings.load() }

    // MARK: - Broadcast ingestion (called from DaemonServer.onBroadcast)

    func handleEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "state_update", "usage_update":
            applyUsage(event)
            refreshAll()
        case "sessions_list":
            let sessions = event["sessions"] as? [[String: Any]] ?? []
            lastState.sessions = sessions.compactMap { s in
                if let alive = s["alive"] as? Bool, alive == false { return nil }
                let elapsed = (s["elapsedSec"] as? Int) ?? Int((s["elapsedSec"] as? Double) ?? 0)
                return TrmnlSession(
                    agentType: s["agentType"] as? String ?? "",
                    projectName: s["projectName"] as? String ?? "",
                    modelName: s["modelName"] as? String ?? "",
                    state: s["state"] as? String ?? "idle",
                    currentTool: s["currentTool"] as? String ?? "",
                    currentTask: s["currentTask"] as? String ?? "",
                    goal: s["goal"] as? String ?? "",
                    elapsedSec: elapsed)
            }
            refreshAll()
        default:
            break
        }
    }

    private func applyUsage(_ e: [String: Any]) {
        // A real percent means the hub actually has subscription quota — only then
        // are the gauges meaningful (otherwise the renderer shows "—", not 0%).
        if let v = e["fiveHourPercent"] as? Double { lastState.fiveHourPercent = v; lastState.usageKnown = true }
        if let v = e["sevenDayPercent"] as? Double { lastState.sevenDayPercent = v; lastState.usageKnown = true }
        if let v = e["fiveHourResetsAt"] as? String { lastState.fiveHourResetsAt = v }
        if let v = e["sevenDayResetsAt"] as? String { lastState.sevenDayResetsAt = v }
        if let subs = e["subscriptions"] as? [[String: Any]] {
            lastState.subscriptions = subs.compactMap { s in
                guard let name = s["name"] as? String, !name.isEmpty else { return nil }
                return TrmnlSubscription(name: name, until: s["until"] as? String)
            }
        }
        if let v = e["totalTokens"] as? Int { lastState.totalTokens = v }
        else if let v = e["totalTokens"] as? Double { lastState.totalTokens = Int(v) }
        else if let i = e["inputTokens"] as? Int, let o = e["outputTokens"] as? Int { lastState.totalTokens = i + o }
        if let v = e["totalCost"] as? Double { lastState.totalCost = v }
        else if let v = e["estimatedCostUsd"] as? Double { lastState.totalCost = v }
    }

    /// AWAITING/WORKING counts from the last known sessions — drives cadence.
    private func activity() -> (awaiting: Int, working: Int) {
        var awaiting = 0
        var working = 0
        for s in lastState.sessions {
            let st = s.state.lowercased()
            if st.hasPrefix("awaiting") { awaiting += 1 }
            else if st == "processing" { working += 1 }
        }
        return (awaiting, working)
    }

    /// Re-render every cached resolution whose visual state changed. If nothing is
    /// cached yet, only prime the default when force-enabled (a real poll renders
    /// the device's exact size on demand otherwise).
    private func refreshAll() {
        let hash = stateHash()
        if frames.isEmpty {
            if cfg.enabled { _ = render(key: "800x480") }
            return
        }
        for key in frameOrder where lastHashByKey[key] != hash {
            _ = render(key: key)
        }
    }

    // MARK: - BYOS endpoints

    /// GET /api/setup — enroll (by MAC) and hand back an api_key. HTTP status
    /// varies (200/400/404) like the Node handler.
    func setup(headers raw: [String: String], base: String) -> TrmnlByosResponse {
        let h = parse(raw)
        guard !h.mac.isEmpty else {
            return json(status: 400, ["status": 400, "message": "Missing ID (MAC) header"])
        }
        record(h)
        let device: Device
        if cfg.autoRegister {
            device = enroll(h.mac)
        } else if let d = devices[TrmnlSettings.normalizeMac(h.mac)] {
            device = d
        } else {
            return json(status: 404, ["status": 404, "message": "Device not enrolled."])
        }
        let size = renderSize(h)
        let frame = frame(w: size.0, h: size.1)
        return json(["status": 200,
                     "api_key": device.apiKey,
                     "friendly_id": device.friendlyId,
                     "image_url": imageUrl(base, size, frame.hash),
                     "filename": frame.hash,
                     "message": "Welcome to AgentDeck"])
    }

    /// GET /api/display — next image + cadence. Always HTTP 200; the BYOS `status`
    /// field (0 = show, 202 = needs setup) is the real signal, because stock
    /// firmware treats a non-200 HTTP status as an error and sleeps without
    /// rendering. Soft auth: MAC is identity, any Access-Token is accepted.
    func display(headers raw: [String: String], base: String) -> TrmnlByosResponse {
        let h = parse(raw)
        let size = renderSize(h)
        if !h.mac.isEmpty { record(h) }
        var device = h.mac.isEmpty ? nil : devices[TrmnlSettings.normalizeMac(h.mac)]
        if device == nil {
            if !h.mac.isEmpty && cfg.autoRegister {
                device = enroll(h.mac)
            }
            if device == nil {
                // Unenrolled + autoRegister off: still serve a real, correctly-sized
                // frame (not a bogus setup.png the image route can't match) so the
                // panel shows the dashboard rather than a firmware error.
                let setupFrame = frame(w: size.0, h: size.1)
                return json(["status": 202,
                             "image_url": imageUrl(base, size, setupFrame.hash),
                             "filename": setupFrame.hash,
                             "refresh_rate": cfg.refreshRate,
                             "image_url_timeout": cfg.imageUrlTimeout,
                             "special_function": "sleep",
                             "reset_firmware": false,
                             "update_firmware": false,
                             "firmware_url": NSNull()])
            }
        }
        let frame = frame(w: size.0, h: size.1)
        // Adaptive cadence: only AWAITING speeds the loop up (battery e-ink).
        let act = activity()
        let refresh = cfg.effectiveRefresh(awaiting: act.awaiting, working: act.working)
        return json(["status": 0,
                     "image_url": imageUrl(base, size, frame.hash),
                     "filename": frame.hash,
                     "refresh_rate": refresh,
                     "image_url_timeout": cfg.imageUrlTimeout,
                     "special_function": "sleep",
                     "reset_firmware": false,
                     "update_firmware": false,
                     "firmware_url": NSNull()])
    }

    /// GET /trmnl/image/<W>x<H>-<hash>.png — PNG for a resolution key.
    func image(key: String) -> Data? {
        if let f = frames[key] { return f.png }
        let (w, h) = parseKey(key)
        return render(key: "\(w)x\(h)").png
    }

    func snapshot() -> TrmnlStatus {
        let act = activity()
        let current = cfg.effectiveRefresh(awaiting: act.awaiting, working: act.working)
        let staleAfter = Double(max(30, current) * 2)
        let now = Date()
        let stale = telemetry.values.filter { now.timeIntervalSince($0.lastSeen) > staleAfter }.count
        return TrmnlStatus(enabled: cfg.enabled, autoRegister: cfg.autoRegister, refreshRate: cfg.refreshRate,
                           currentRefreshRate: current, deviceCount: devices.count, staleDeviceCount: stale,
                           activeResolutions: frameOrder, frameCount: frameOrder.count)
    }

    // MARK: - Frame cache

    @discardableResult
    private func render(key: String) -> (png: Data, hash: String) {
        let (w, h) = parseKey(key)
        var st = lastState
        st.nowText = hhmm()
        let png = TrmnlImageRenderer.renderPng(st, width: w, height: h)
        let frame = (png: png, hash: sha16(png))
        frames[key] = frame
        lastHashByKey[key] = stateHash()
        frameOrder.removeAll { $0 == key }
        frameOrder.append(key)
        while frameOrder.count > maxFrames {
            let evict = frameOrder.removeFirst()
            frames[evict] = nil
            lastHashByKey[evict] = nil
        }
        return frame
    }

    private func frame(w: Int, h: Int) -> (png: Data, hash: String) {
        let key = "\(w)x\(h)"
        if let f = frames[key] { return f }
        return render(key: key)
    }

    /// Visual fingerprint. NO wall-clock component: a real TRMNL caches by
    /// `filename` and skips the (battery + flaky-WiFi) re-download when it's
    /// unchanged, so the hash must change only on real visual change. Reset
    /// timestamps roll over rarely and are included so a rollover re-renders.
    private func stateHash() -> String {
        let s = lastState.sessions
            .map { "\($0.agentType):\($0.state):\($0.projectName):\($0.modelName):\($0.goal)" }
            .joined(separator: "|")
        let usage = lastState.usageKnown
            ? "\(Int(lastState.fiveHourPercent.rounded()))~\(Int(lastState.sevenDayPercent.rounded()))"
            : "na~na"
        let subs = lastState.subscriptions.map { "\($0.name):\($0.until ?? "")" }.joined(separator: ",")
        return "\(usage)~\(lastState.fiveHourResetsAt ?? "")~\(lastState.sevenDayResetsAt ?? "")~\(subs)~\(s)"
    }

    // MARK: - Enrollment + telemetry

    private func enroll(_ mac: String) -> Device {
        let key = TrmnlSettings.normalizeMac(mac)
        if let d = devices[key] { return d }
        let d = Device(apiKey: randomHex(16), friendlyId: friendlyId())
        devices[key] = d
        return d
    }

    private func record(_ h: TrmnlHeaders) {
        let key = TrmnlSettings.normalizeMac(h.mac)
        guard !key.isEmpty else { return }
        telemetry[key] = Telemetry(fwVersion: h.fwVersion, battery: h.batteryVoltage, rssi: h.rssi,
                                   width: h.width, height: h.height, refreshRate: h.refreshRate,
                                   userAgent: h.userAgent, lastSeen: Date())
    }

    // MARK: - Helpers

    private func parse(_ raw: [String: String]) -> TrmnlHeaders {
        func num(_ k: String) -> Double? {
            guard let v = raw[k]?.trimmingCharacters(in: .whitespaces), !v.isEmpty else { return nil }
            return Double(v)
        }
        func dim(_ k: String) -> Int? {
            guard let v = num(k) else { return nil }
            let i = Int(v.rounded())
            return (i >= minDim && i <= maxDim) ? i : nil
        }
        return TrmnlHeaders(
            mac: raw["id"] ?? "",
            accessToken: raw["access-token"] ?? "",
            fwVersion: raw["fw-version"] ?? "",
            batteryVoltage: num("battery-voltage"),
            rssi: num("rssi"),
            refreshRate: num("refresh-rate").map { Int($0.rounded()) },
            width: dim("width"),
            height: dim("height"),
            userAgent: raw["user-agent"] ?? "")
    }

    private func renderSize(_ h: TrmnlHeaders) -> (Int, Int) {
        (h.width ?? 800, h.height ?? 480)
    }

    private func imageUrl(_ base: String, _ size: (Int, Int), _ hash: String) -> String {
        "\(base)/trmnl/image/\(size.0)x\(size.1)-\(hash).png"
    }

    private func json(status: Int = 200, _ obj: [String: Any]) -> TrmnlByosResponse {
        let data = (try? JSONSerialization.data(withJSONObject: obj)) ?? Data("{}".utf8)
        return TrmnlByosResponse(status: status, body: data)
    }

    private func parseKey(_ key: String) -> (Int, Int) {
        let parts = key.split(separator: "x")
        if parts.count == 2, let w = Int(parts[0]), let h = Int(parts[1]), w > 0, h > 0 { return (w, h) }
        return (800, 480)
    }

    private func hhmm() -> String {
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: Date())
    }

    private func randomHex(_ bytes: Int) -> String {
        (0..<bytes).map { _ in String(format: "%02x", Int.random(in: 0...255)) }.joined()
    }

    private func friendlyId() -> String {
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        return String((0..<6).map { _ in alphabet[Int.random(in: 0..<alphabet.count)] })
    }

    private func sha16(_ data: Data) -> String {
        let hex = Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(16))
    }
}
#endif
