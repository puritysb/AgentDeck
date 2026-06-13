#if os(macOS)
// PixooModule.swift — Pixoo64 LED matrix device support
// Ported from bridge/src/modules/pixoo-module.ts + pixoo-bridge.ts (core)

import Foundation

struct PixooDevice: Codable, Equatable {
    let ip: String
    var name: String?
    var brightness: Int?
}

private final class PixooSettingsDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func set(_ data: Data?) {
        lock.lock()
        self.data = data
        lock.unlock()
    }

    func get() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

actor PixooModule: DeviceModule {
    private struct DeviceLogState: Sendable {
        var successCount = 0
        var consecutiveFailures = 0
        var lastSuccessLogAt: Date?
        var lastFailureMessage: String?
        var backoffUntil: Date?
    }

    /// Lock-protected mirror of fields that sync cross-actor callers need
    /// (e.g. @MainActor `DaemonServer.buildModuleHealthSync()` and the
    /// `/pixoo.bmp` HTTP handler). Actor-isolated methods call
    /// `refreshShadow()` after each mutation so `statusSnapshot()` can
    /// stay `nonisolated` — actor isolation protects the real storage
    /// (`deviceLogStates` etc.) from the torn-read race that crashed the
    /// daemon on 2026-04-19, while sync callers keep their sync API.
    private final class Shadow: @unchecked Sendable {
        private let lock = NSLock()
        private var snapshot: [String: Any] = [
            "configuredDeviceCount": 0,
            "deviceIps": [String](),
            "hasFrame": false,
            "displayDimmed": false,
            "lastPushAtMs": NSNull(),
            "lastPushError": NSNull(),
            "devices": [[String: Any]](),
        ]
        private var frame: Data?

        func writeSnapshot(_ s: [String: Any]) {
            lock.lock(); defer { lock.unlock() }
            snapshot = s
        }
        func readSnapshot() -> [String: Any] {
            lock.lock(); defer { lock.unlock() }
            return snapshot
        }
        func writeFrame(_ f: Data?) {
            lock.lock(); defer { lock.unlock() }
            frame = f
        }
        func readFrame() -> Data? {
            lock.lock(); defer { lock.unlock() }
            return frame
        }
    }

    nonisolated let name = "pixoo"
    private nonisolated let shadow = Shadow()

    private var devices: [PixooDevice] = []
    private var renderTask: Task<Void, Never>?
    private var probeTask: Task<Void, Never>?
    private var reassertTask: Task<Void, Never>?
    private var settingsReloadTask: Task<Void, Never>?
    /// Fires when refreshShadow detects a user-visible field change
    /// (configuredDeviceCount, per-device online/failures/backedOff,
    /// displayDimmed). DaemonServer wires this to broadcastStateUpdate().
    private var onStateChanged: (@Sendable () -> Void)?
    private var lastBroadcastDigest: String?

    func setOnStateChanged(_ handler: @escaping @Sendable () -> Void) {
        self.onStateChanged = handler
    }

    // Circuit breaker — matches Node.js bridge (pixoo-client.ts)
    private let backoffThreshold = 1
    private let backoffInitialSec: TimeInterval = 30
    private let backoffMaxSec: TimeInterval = 300
    private let probeIntervalSec: TimeInterval = 15
    private let settingsReloadIntervalSec: TimeInterval = 5
    // Mirrors Node bridge's CHANNEL_REASSERT_MS — re-issues Channel/SetIndex
    // periodically so a Pixoo that drifted out of "Custom" channel mode
    // (brownout, firmware glitch) recovers without waiting for the 80s PicID
    // overflow cycle.
    private let channelReassertIntervalSec: TimeInterval = 300
    private let minimumPushIntervalSec: TimeInterval = 12
    private let forceRefreshIntervalSec: TimeInterval = 60
    private let pushTimeout: TimeInterval = 3
    private let activeAnimationFrameCount = 2
    // Probe failures past this point indicate the daemon's outbound HTTP path
    // (URLSession + macOS NW stack) is stuck in a way local mitigation can't
    // unblock — escalate with one ERROR log so the user knows to restart.
    private let deepHangProbeFailures = 6
    private var lastPushError: String?
    private var lastPushAt: Date?
    private var devicePicIds: [String: Int] = [:]
    private var deviceLogStates: [String: DeviceLogState] = [:]
    private var lastPushedFrames: [String: Data] = [:]
    private var deviceLastPushTime: [String: Date] = [:]
    private var animatedSequenceDisabledIPs: Set<String> = []
    private var lastStateDigest: String?
    private var lastSequencePushTime: Date?
    private var isPushing = false
    private let renderer = PixooRenderer()
    private let urlSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 3
        config.timeoutIntervalForResource = 3
        config.httpMaximumConnectionsPerHost = 1
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()
    private let frameWidth = 64
    private let frameHeight = 64
    private let requestTimeout: TimeInterval = 2
    private let picIdResyncThreshold = 250
    private let successLogInterval = 30
    private let successLogMinInterval: TimeInterval = 30
    private static let gammaLUT: [UInt8] = (0..<256).map {
        UInt8(max(0, min(255, Int(round(pow(Double($0) / 255.0, 0.7) * 255.0)))))
    }

    func start() async {
        await reloadDevicesFromSettings(reason: "startup", force: true)

        // Capture immutable intervals into Tasks so the unstructured closures
        // don't need to hop back onto the actor just to read a let.
        let probeInterval = probeIntervalSec
        let settingsReloadInterval = settingsReloadIntervalSec
        let reassertInterval = channelReassertIntervalSec

        // Start render loop — check for state changes and push sequences
        renderTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(500))
                await self?.checkAndPush()
            }
        }

        // Probe loop — check backed-off devices periodically for recovery
        probeTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(probeInterval))
                await self?.probeBackedOffDevices()
            }
        }

        // Channel reassert loop — Node bridge does this every 30s to nudge
        // Pixoo firmware back into Custom channel after brownouts. Skipped for
        // backed-off devices (probe path handles those).
        reassertTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(reassertInterval))
                await self?.reassertChannels()
            }
        }

        // Settings can be edited from the dashboard while the daemon is
        // already running. Keep Pixoo alive even when startup had zero
        // configured devices, otherwise the UI reports a ghost offline device
        // until a manual restart.
        settingsReloadTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(settingsReloadInterval))
                await self?.reloadDevicesFromSettings(reason: "settings reload")
            }
        }

        refreshShadow()
    }

    func stop() async {
        // Cancel the render loop and wait for the in-flight iteration to finish
        // its current URLSession request. Without the await, stop() returns
        // immediately while pushFrame() is still blocked on a 2s HTTP timeout to
        // an unreachable Pixoo — the orphaned URL requests stretch shutdown past
        // the 10s semaphore and leave the process in `?E` state at exit.
        probeTask?.cancel()
        await probeTask?.value
        probeTask = nil
        reassertTask?.cancel()
        await reassertTask?.value
        reassertTask = nil
        settingsReloadTask?.cancel()
        await settingsReloadTask?.value
        settingsReloadTask = nil
        renderTask?.cancel()
        await renderTask?.value
        renderTask = nil

        // Replace the last rendered frame with an OFFLINE placeholder before
        // tearing down, so the Pixoo hardware doesn't stay frozen on a stale
        // creature scene after the daemon goes away. Matches Node's
        // stopPixooBridge() behavior.
        await pushOfflineFrame()
    }

    private func pushOfflineFrame() async {
        let targets = devices.filter { !isBackedOff($0.ip) }
        guard !targets.isEmpty else { return }
        let frame = renderer.renderDisconnectedFrame()
        shadow.writeFrame(frame)

        let pushes = Task { [weak self] in
            guard let self else { return }
            await withTaskGroup(of: Void.self) { group in
                for device in targets {
                    group.addTask { await self.pushSequenceToDevice(device, frames: [frame]) }
                }
            }
        }
        let deadline = Task {
            try? await Task.sleep(for: .seconds(2))
            pushes.cancel()
        }
        await pushes.value
        deadline.cancel()
        refreshShadow()
    }

    func handleWake() async {
        await reloadDevicesFromSettings(reason: "wake")
        DaemonLogger.shared.info("Pixoo wake recovery — clearing PicID cache for \(devices.count) device(s)")
        devicePicIds.removeAll()
        deviceLogStates.removeAll()
        lastPushedFrames.removeAll()
        deviceLastPushTime.removeAll()
        animatedSequenceDisabledIPs.removeAll()
        lastPushError = nil
        // Re-sync PicID from each device (may have rebooted during sleep)
        for device in devices {
            await prepareDevice(device)
        }
        refreshShadow()
    }

    nonisolated func statusSnapshot() -> [String: Any] {
        shadow.readSnapshot()
    }

    nonisolated func currentFrame() -> Data? {
        shadow.readFrame()
    }

    /// Rebuilds the shadow and broadcasts when the digest of user-visible
    /// fields changes. `lastPushAtMs` is excluded (333ms render tick).
    private func refreshShadow() {
        let snapshot = buildSnapshot()
        shadow.writeSnapshot(snapshot)
        let digest = broadcastDigest(snapshot: snapshot)
        if digest != lastBroadcastDigest {
            lastBroadcastDigest = digest
            onStateChanged?()
        }
    }

    private func broadcastDigest(snapshot: [String: Any]) -> String {
        var parts: [String] = []
        parts.append("count=\(snapshot["configuredDeviceCount"] as? Int ?? 0)")
        parts.append("dimmed=\((snapshot["displayDimmed"] as? Bool) ?? false)")
        parts.append("frame=\((snapshot["hasFrame"] as? Bool) ?? false)")
        if let devs = snapshot["devices"] as? [[String: Any]] {
            for d in devs {
                let ip = d["ip"] as? String ?? ""
                let online = (d["online"] as? Bool) ?? false
                let failures = (d["failures"] as? Int) ?? 0
                let backedOff = (d["backedOff"] as? Bool) ?? false
                parts.append("\(ip):o=\(online),f=\(failures),b=\(backedOff)")
            }
        }
        return parts.joined(separator: "|")
    }

    private func buildSnapshot() -> [String: Any] {
        [
            "configuredDeviceCount": devices.count,
            "deviceIps": devices.map(\.ip),
            "hasFrame": shadow.readFrame() != nil,
            "displayDimmed": displayDimmed,
            "lastPushAtMs": lastPushAt.map { Int($0.timeIntervalSince1970 * 1000) } as Any,
            "lastPushError": lastPushError as Any,
            "devices": devices.map { d -> [String: Any] in
                let logState = deviceLogStates[d.ip]
                return [
                    "ip": d.ip,
                    "name": d.name ?? "",
                    "online": !(logState.map { $0.consecutiveFailures >= backoffThreshold } ?? false),
                    "failures": logState?.consecutiveFailures ?? 0,
                    "backedOff": isBackedOff(d.ip),
                ]
            },
        ]
    }

    // Cached state for rendering (actor-isolated; consumed by pushFrame's render)
    private var cachedState: String = "disconnected"
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

    private var displayDimmed = false
    /// Last applied dim instruction signature ("enabled|mode|level"). Lets us
    /// re-apply a changed dim level while the display stays asleep (displayOn
    /// unchanged) instead of being swallowed by the `displayDimmed` guard.
    private var lastDimSignature = ""

    /// Handle broadcast events — update cached state for next render
    func handleEvent(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        switch type {
        case "state_update":
            let eventAgentType = event["agentType"] as? String
            // Only update primary state from creature agents — daemon/openclaw
            // events would otherwise overwrite the coding agent's PROCESSING state
            let creatureAgents: Set<String> = ["claude-code", "codex-cli", "codex-app", "opencode"]
            if let at = eventAgentType, creatureAgents.contains(at) {
                cachedState = event["state"] as? String ?? "disconnected"
                cachedProject = event["projectName"] as? String
                cachedModel = event["modelName"] as? String
                cachedTool = event["currentTool"] as? String
                cachedAgentType = eventAgentType
            } else if cachedAgentType == nil {
                // No creature agent seen yet — accept any state to avoid blank screen
                cachedState = event["state"] as? String ?? "disconnected"
                cachedAgentType = eventAgentType
            }
            // Gateway fields are always updated regardless of agent type
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
            // Resolve the dim instruction (absent ⇒ legacy enabled/full-off).
            let dim = event["dim"] as? [String: Any]
            let dimEnabled = dim?["enabled"] as? Bool ?? true
            let dimMode = (dim?["mode"] as? String) == "min" ? "min" : "off"
            let dimLevel = max(1, min(100, dim?["level"] as? Int ?? 10))
            let signature = "\(dimEnabled)|\(dimMode)|\(dimLevel)"

            if !displayOn {
                if !dimEnabled {
                    // Dimming disabled — leave the screen lit. If we were dimmed
                    // (user just disabled while asleep), restore brightness.
                    if displayDimmed {
                        displayDimmed = false
                        Task { await restorePixoo() }
                    }
                } else if !displayDimmed || signature != lastDimSignature {
                    // Apply on first sleep OR when the dim instruction changed
                    // live (e.g. user moved the slider while already asleep).
                    displayDimmed = true
                    let target = dimMode == "off" ? 0 : dimLevel
                    Task { await dimPixoo(level: target) }
                }
            } else if displayDimmed {
                displayDimmed = false
                Task { await restorePixoo() }
            }
            lastDimSignature = signature
            refreshShadow()
            return // Don't re-render on display_state
        default: break
        }
    }

    // MARK: - Circuit Breaker

    private func isBackedOff(_ ip: String) -> Bool {
        guard let state = deviceLogStates[ip] else { return false }
        return state.consecutiveFailures >= backoffThreshold
    }

    private func isProbeDue(_ ip: String) -> Bool {
        guard let state = deviceLogStates[ip],
              state.consecutiveFailures >= backoffThreshold else { return false }
        guard let until = state.backoffUntil else { return true }
        return Date() >= until
    }

    private func probeBackedOffDevices() async {
        for device in devices {
            guard isProbeDue(device.ip) else { continue }
            let payload: [String: Any] = ["Command": "Channel/GetAllConf"]
            if await postCommand(device.ip, payload: payload, logFailures: false) != nil {
                DaemonLogger.shared.info("[Pixoo] \(device.ip) recovered — waiting for 2s stabilization grace period before re-seeding custom frame")
                devicePicIds.removeValue(forKey: device.ip)
                lastPushedFrames.removeValue(forKey: device.ip)
                deviceLastPushTime.removeValue(forKey: device.ip)

                // Keep the device untouched during the grace period. Sending
                // Channel/SetIndex too early can expose the Pixoo firmware's
                // built-in Custom/default screen until the next SendHttpGif.
                try? await Task.sleep(for: .seconds(2))

                if devices.contains(where: { $0.ip == device.ip }) {
                    await prepareDevice(device)
                    await seedCurrentFrame(device, reason: "recovery")

                    var state = deviceLogStates[device.ip] ?? DeviceLogState()
                    state.consecutiveFailures = 0
                    state.backoffUntil = nil
                    state.lastFailureMessage = nil
                    deviceLogStates[device.ip] = state
                    DaemonLogger.shared.info("[Pixoo] \(device.ip) stabilization grace period complete — custom frame re-seeded, resuming frame pushes")
                }
            } else {
                lastPushError = "probe failed for \(device.ip)"
                recordPushFailure(ip: device.ip, reason: "probe failed")
                // Deep hang surfacing: when push-fail (6) + probe-fail (6)
                // accumulate without recovery, the daemon's outbound HTTP path
                // is likely stuck NW-stack-deep — local circuit breaker can't
                // unstick it. Log once at the boundary so the user knows the
                // app needs a restart, and try a best-effort PicID re-sync.
                if let state = deviceLogStates[device.ip],
                   state.consecutiveFailures == backoffThreshold + deepHangProbeFailures {
                    DaemonLogger.shared.error("[Pixoo] \(device.ip) deep hang — \(state.consecutiveFailures) total failures (push+probe). Outbound HTTP may be stuck NW-stack-deep; restart AgentDeck if push doesn't resume within 30s.")
                    devicePicIds.removeValue(forKey: device.ip)
                    await prepareDevice(device)
                }
            }
        }
        refreshShadow()
    }

    /// Re-issues `Channel/SetIndex` on each healthy device every 30s. Mirrors
    /// the Node bridge's CHANNEL_REASSERT_MS so a Pixoo that drifted out of
    /// Custom channel mode (brownout, firmware hiccup) recovers in 30s instead
    /// of waiting for the 80s PicID overflow cycle.
    ///
    /// Honors the same `displayDimmed` guard as `pushFrame` — when the user's
    /// monitor is asleep we have already dropped Pixoo brightness to 0, and
    /// some firmware versions reset brightness on `Channel/SetIndex`, which
    /// would un-dim the matrix on a sleeping desk every 30 seconds.
    private func reassertChannels() async {
        guard !displayDimmed else { return }
        guard !isPushing else { return }
        isPushing = true
        defer { isPushing = false }

        for device in devices where !isBackedOff(device.ip) {
            _ = await postCommand(device.ip, payload: [
                "Command": "Channel/SetIndex",
                "SelectIndex": 3,
            ], logFailures: false)
            await seedCurrentFrame(device, reason: "channel reassert")
        }
    }

    private func buildStateDigest(state: DashboardState) -> String {
        let stateStr = state.state.rawValue
        let gatewayConnected = state.gatewayConnected
        let gatewayHasError = state.gatewayHasError

        let r5 = renderer.formatResetDetailed(state.fiveHourResetsAt)
        let r7 = renderer.formatResetDetailed(state.sevenDayResetsAt)
        let u5 = state.fiveHourPercent != nil ? Int(floor(state.fiveHourPercent!)) : -1
        let u7 = state.sevenDayPercent != nil ? Int(floor(state.sevenDayPercent!)) : -1

        let sessionInfo = state.siblingSessions.map { "\($0.id):\($0.agentType ?? ""):\($0.state ?? "")" }.joined(separator: ",")

        return "\(stateStr)|\(gatewayConnected)|\(gatewayHasError)|\(r5)|\(r7)|\(u5)|\(u7)|\(sessionInfo)|\(displayDimmed)"
    }

    private func checkAndPush() async {
        guard !devices.isEmpty, !displayDimmed else { return }
        guard !isPushing else { return }
        isPushing = true
        defer { isPushing = false }

        let state = currentDashboardState()
        let isDisconnectedPlaceholder = state.state == .disconnected && cachedAgentType == nil && cachedSessions.isEmpty

        let currentDigest: String
        if isDisconnectedPlaceholder {
            currentDigest = "offline|\(displayDimmed)"
        } else {
            currentDigest = buildStateDigest(state: state)
        }

        let timeSinceLastPush = lastSequencePushTime.map { Date().timeIntervalSince($0) } ?? 99999.0
        let stateChanged = currentDigest != lastStateDigest

        if stateChanged && timeSinceLastPush < minimumPushIntervalSec {
            return
        }
        if !stateChanged && timeSinceLastPush < forceRefreshIntervalSec {
            return
        }

        lastStateDigest = currentDigest
        lastSequencePushTime = Date()

        let frames: [Data]
        if isDisconnectedPlaceholder {
            frames = [renderer.renderDisconnectedFrame()]
        } else {
            frames = renderer.renderSequence(
                dashboardState: state,
                frameCount: frameCountForNextPush(state: state, stateChanged: stateChanged)
            )
        }

        if let firstFrame = frames.first {
            shadow.writeFrame(firstFrame)
        }

        for device in devices where !isBackedOff(device.ip) {
            await pushSequenceToDevice(device, frames: frames)
        }
        refreshShadow()
    }

    private func frameCountForNextPush(state: DashboardState, stateChanged: Bool) -> Int {
        guard stateChanged else { return 1 }
        guard activeAnimationFrameCount > 1 else { return 1 }
        switch state.state {
        case .processing, .awaitingPermission, .awaitingOption, .awaitingDiff:
            return activeAnimationFrameCount
        default:
            let hasActiveSession = state.siblingSessions.contains {
                guard $0.alive else { return false }
                return $0.state == "processing" || ($0.state?.hasPrefix("awaiting") ?? false)
            }
            return hasActiveSession ? activeAnimationFrameCount : 1
        }
    }

    private func seedCurrentFrame(_ device: PixooDevice, reason: String) async {
        let state = currentDashboardState()
        let frames: [Data]
        if state.state == .disconnected && cachedAgentType == nil && cachedSessions.isEmpty {
            frames = [renderer.renderDisconnectedFrame()]
        } else {
            frames = renderer.renderSequence(dashboardState: state, frameCount: 1)
        }

        if let firstFrame = frames.first {
            shadow.writeFrame(firstFrame)
        }

        await pushSequenceToDevice(device, frames: frames, force: true, reason: reason)
    }

    private func pushSequenceToDevice(
        _ device: PixooDevice,
        frames: [Data],
        force: Bool = false,
        reason: String = "scheduled"
    ) async {
        let ip = device.ip
        let now = Date()
        let effectiveFrames: [Data]
        if frames.count > 1, animatedSequenceDisabledIPs.contains(ip), let first = frames.first {
            effectiveFrames = [first]
        } else {
            effectiveFrames = frames
        }

        if !force,
           effectiveFrames.count == 1,
           let lastFrame = lastPushedFrames[ip],
           lastFrame == effectiveFrames[0],
           let lastPush = deviceLastPushTime[ip],
           now.timeIntervalSince(lastPush) < minimumPushIntervalSec {
            return
        }

        guard let picId = await nextPicId(for: device.ip) else {
            recordPushFailure(ip: device.ip, reason: "failed to acquire PicID")
            lastPushError = "failed to acquire PicID for \(device.ip)"
            return
        }

        var combinedData = Data()
        for frame in effectiveFrames {
            let boosted = Data(frame.enumerated().map { Self.gammaLUT[Int($0.element)] })
            combinedData.append(boosted)
        }

        let payload: [String: Any] = [
            "Command": "Draw/SendHttpGif",
            "PicNum": effectiveFrames.count,
            "PicWidth": frameWidth,
            "PicOffset": 0,
            "PicID": picId,
            "PicSpeed": effectiveFrames.count > 1 ? 180 : 1000,
            "PicData": combinedData.base64EncodedString(),
        ]

        if let response = await postCommand(device.ip, payload: payload, timeout: pushTimeout, logFailures: false),
           Self.isPixooSuccess(response) {
            lastPushError = nil
            lastPushAt = Date()
            recordPushSuccess(ip: device.ip, picId: picId, response: response)
            if effectiveFrames.count == 1 {
                lastPushedFrames[ip] = effectiveFrames[0]
            } else {
                lastPushedFrames.removeValue(forKey: ip)
            }
            deviceLastPushTime[ip] = now
        } else {
            lastPushError = "push failed for \(device.ip)"
            if effectiveFrames.count > 1 {
                animatedSequenceDisabledIPs.insert(ip)
                DaemonLogger.shared.info("[Pixoo] \(ip) animated sequence push failed — falling back to single-frame mode for this run")
            }
            devicePicIds.removeValue(forKey: device.ip)
            lastPushedFrames.removeValue(forKey: device.ip)
            deviceLastPushTime.removeValue(forKey: device.ip)
            recordPushFailure(ip: device.ip, reason: "push failed (picId=\(picId), count=\(effectiveFrames.count), reason=\(reason))")
        }
    }

    private static func isPixooSuccess(_ response: [String: Any]) -> Bool {
        if let code = response["error_code"] as? Int { return code == 0 }
        if let code = response["errorCode"] as? Int { return code == 0 }
        if let code = response["error_code"] as? NSNumber { return code.intValue == 0 }
        if let code = response["errorCode"] as? NSNumber { return code.intValue == 0 }
        return true
    }

    /// Set brightness for all devices
    func setBrightness(_ level: Int) async {
        for device in devices {
            let payload: [String: Any] = [
                "Command": "Channel/SetBrightness",
                "Brightness": max(0, min(100, level)),
            ]
            if await postCommand(device.ip, payload: payload) != nil {
                lastPushError = nil
            } else {
                lastPushError = "brightness failed for \(device.ip)"
            }
        }
        refreshShadow()
    }

    // MARK: - Display Sleep

    private func dimPixoo(level: Int = 0) async {
        await setBrightness(level)
        DaemonLogger.shared.debug("Pixoo", "Display sleep → brightness \(level)")
    }

    private func restorePixoo() async {
        // Restore default brightness (or device-configured)
        let level = devices.first?.brightness ?? 80
        await setBrightness(level)
        DaemonLogger.shared.debug("Pixoo", "Display wake → brightness \(level)")
    }

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
        // Gateway flags come straight from the daemon broadcast — no OR
        // fallback on "siblingSessions contains openclaw". DaemonServer only
        // injects the virtual openclaw session when `cachedGatewayConnected`
        // is already true, so the old OR was redundant and made the code
        // read as "any openclaw session implies authenticated" which is the
        // opposite of the intended gate for crayfish rendering.
        state.gatewayAvailable = cachedGatewayAvailable
        state.gatewayConnected = cachedGatewayConnected
        state.gatewayHasError = cachedGatewayHasError
        state.siblingSessions = cachedSessions.compactMap(Self.makeSessionInfo)
        return state
    }

    private func firstAliveSession(in sessions: [[String: Any]]) -> [String: Any]? {
        sessions.first { ($0["alive"] as? Bool) ?? true }
    }

    // MARK: - Settings

    private static let settingsFile = AuthManager.agentDeckDir.appendingPathComponent("settings.json")
    // .userInteractive: PixooModule.start() runs reloadDevicesFromSettings on
    // the main actor and sync-waits via DispatchSemaphore. Anything below
    // User-interactive (incl. .userInitiated) leaves a one-step priority
    // inversion that Thread Performance Checker still flags. The work is a
    // single Data(contentsOf:) capped at 700 ms, so the elevated QoS is
    // bounded and aligned with the main-actor critical path.
    private static let settingsReadQueue = DispatchQueue(label: "dev.agentdeck.pixoo.settings-read", qos: .userInteractive)
    private static let settingsReadTimeout: DispatchTimeInterval = .milliseconds(700)

    /// UI-triggered reload that bypasses the 5s polling cadence. `force` skips
    /// the equality guard for non-IP field changes (e.g. brightness).
    func reloadFromSettingsExternal() async {
        await reloadDevicesFromSettings(reason: "ui-trigger", force: true)
    }

    private func reloadDevicesFromSettings(reason: String, force: Bool = false) async {
        let latest = Self.loadDevices()
        guard force || latest != devices else { return }

        var previousByIP: [String: PixooDevice] = [:]
        for device in devices {
            previousByIP[device.ip] = device
        }
        let previousIPs = Set(devices.map(\.ip))
        let latestIPs = Set(latest.map(\.ip))

        devices = latest
        lastPushError = nil

        for removedIP in previousIPs.subtracting(latestIPs) {
            devicePicIds.removeValue(forKey: removedIP)
            deviceLogStates.removeValue(forKey: removedIP)
            lastPushedFrames.removeValue(forKey: removedIP)
            deviceLastPushTime.removeValue(forKey: removedIP)
            animatedSequenceDisabledIPs.remove(removedIP)
        }

        if devices.isEmpty {
            shadow.writeFrame(nil)
            DaemonLogger.shared.debug("Pixoo", "No devices configured; watching settings.json for changes")
            refreshShadow()
            return
        }

        let ipList = devices.map(\.ip).joined(separator: ", ")
        DaemonLogger.shared.info("Pixoo \(reason): \(devices.count) configured device(s) [\(ipList)]")
        refreshShadow()

        for device in devices where force || previousByIP[device.ip] != device {
            await prepareDevice(device)
        }
        refreshShadow()
    }

    static func loadDevices() -> [PixooDevice] {
        let box = PixooSettingsDataBox()
        let semaphore = DispatchSemaphore(value: 0)
        settingsReadQueue.async {
            box.set(try? Data(contentsOf: settingsFile))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + settingsReadTimeout) == .success else {
            DaemonLogger.shared.debug("Pixoo", "Settings read timed out; treating as no configured devices")
            return []
        }

        guard let data = box.get(),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pixooArray = json["pixooDevices"] as? [[String: Any]] else { return [] }

        return pixooArray.compactMap { d in
            guard let rawIP = d["ip"] as? String else { return nil }
            let ip = rawIP.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !ip.isEmpty else { return nil }
            return PixooDevice(ip: ip, name: d["name"] as? String, brightness: d["brightness"] as? Int)
        }
    }

    private func prepareDevice(_ device: PixooDevice) async {
        _ = await postCommand(device.ip, payload: [
            "Command": "Channel/SetIndex",
            "SelectIndex": 3,
        ])
        _ = await postCommand(device.ip, payload: [
            "Command": "Channel/SetBrightness",
            "Brightness": max(0, min(100, device.brightness ?? 100)),
        ])
        if let picId = await getHttpGifId(device.ip) {
            devicePicIds[device.ip] = picId
            DaemonLogger.shared.debug("Pixoo", "Synced PicID for \(device.ip): \(picId)")
        }
    }

    private func nextPicId(for ip: String) async -> Int? {
        var picId = devicePicIds[ip]
        if picId == nil {
            guard let synced = await getHttpGifId(ip) else {
                return nil
            }
            picId = synced
        }
        guard var next = picId else { return nil }
        next += 1
        if next >= picIdResyncThreshold {
            DaemonLogger.shared.info("[Pixoo] PicID \(next) near threshold for \(ip), resetting GIF ID and sleeping 2s for stabilization")
            _ = await postCommand(ip, payload: ["Command": "Draw/ResetHttpGifId"])
            try? await Task.sleep(for: .seconds(2))
            next = 1
        }
        devicePicIds[ip] = next
        return next
    }

    private func getHttpGifId(_ ip: String) async -> Int? {
        guard let response = await postCommand(ip, payload: ["Command": "Draw/GetHttpGifId"]) else {
            return nil
        }
        if let picId = response["PicId"] as? Int { return picId }
        if let picId = response["PicID"] as? Int { return picId }
        if let number = response["PicId"] as? NSNumber { return number.intValue }
        if let number = response["PicID"] as? NSNumber { return number.intValue }
        return 0
    }

    private func postCommand(_ ip: String, payload: [String: Any], timeout: TimeInterval? = nil, logFailures: Bool = true) async -> [String: Any]? {
        guard let url = URL(string: "http://\(ip):80/post") else { return nil }
        let currentTimeout = timeout ?? requestTimeout
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("close", forHTTPHeaderField: "Connection")
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
        request.timeoutInterval = currentTimeout

        do {
            let (data, response) = try await urlSession.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                if logFailures {
                    DaemonLogger.shared.debug("Pixoo", "No HTTP response from \(ip)")
                }
                return nil
            }
            guard (200..<300).contains(http.statusCode) else {
                let body = String(data: data, encoding: .utf8) ?? ""
                if logFailures {
                    DaemonLogger.shared.debug("Pixoo", "HTTP \(http.statusCode) from \(ip): \(body)")
                }
                return nil
            }
            if data.isEmpty { return [:] }
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return json
            }
            return [:]
        } catch {
            if logFailures {
                DaemonLogger.shared.debug("Pixoo", "Request failed to \(ip): \(error.localizedDescription)")
            }
            return nil
        }
    }

    private func recordPushSuccess(ip: String, picId: Int, response: [String: Any]) {
        var state = deviceLogStates[ip] ?? DeviceLogState()
        let now = Date()
        let recoveredFromFailures = state.consecutiveFailures > 0
        let failedCount = state.consecutiveFailures
        state.consecutiveFailures = 0
        state.lastFailureMessage = nil
        state.backoffUntil = nil
        state.successCount += 1

        let shouldLogPeriodicSuccess: Bool
        if state.successCount == 1 {
            shouldLogPeriodicSuccess = true
        } else if state.successCount % successLogInterval == 0 {
            let enoughTimePassed = state.lastSuccessLogAt.map { now.timeIntervalSince($0) >= successLogMinInterval } ?? true
            shouldLogPeriodicSuccess = enoughTimePassed
        } else {
            shouldLogPeriodicSuccess = false
        }

        if recoveredFromFailures {
            DaemonLogger.shared.info("Pixoo recovered on \(ip) after \(failedCount) failed push(es); picId=\(picId)")
            state.lastSuccessLogAt = now
        } else if shouldLogPeriodicSuccess {
            let errorCode = (response["error_code"] as? Int) ?? (response["errorCode"] as? Int)
            if let errorCode {
                DaemonLogger.shared.debug("Pixoo", "Healthy → \(ip) pushes=\(state.successCount) picId=\(picId) error_code=\(errorCode)")
            } else {
                DaemonLogger.shared.debug("Pixoo", "Healthy → \(ip) pushes=\(state.successCount) picId=\(picId)")
            }
            state.lastSuccessLogAt = now
        }

        deviceLogStates[ip] = state
    }

    private func recordPushFailure(ip: String, reason: String) {
        var state = deviceLogStates[ip] ?? DeviceLogState()
        state.consecutiveFailures += 1
        let changedReason = state.lastFailureMessage != reason
        state.lastFailureMessage = reason

        // Circuit breaker: exponential backoff after threshold
        if state.consecutiveFailures >= backoffThreshold {
            let power = state.consecutiveFailures - backoffThreshold
            let delay = min(backoffInitialSec * pow(2.0, Double(power)), backoffMaxSec)
            state.backoffUntil = Date().addingTimeInterval(delay)

            if state.consecutiveFailures == backoffThreshold {
                DaemonLogger.shared.error("[Pixoo] \(ip) offline — \(backoffThreshold) consecutive failures. Pausing frame pushes and probing with exponential backoff. Power-cycle the device if it doesn't recover.")
            }
        }

        if state.consecutiveFailures == 1 || state.consecutiveFailures == 5 || state.consecutiveFailures % 20 == 0 || changedReason {
            DaemonLogger.shared.error("Pixoo failure on \(ip): \(reason) [count=\(state.consecutiveFailures)]")
        }

        deviceLogStates[ip] = state
    }

    private static func makeSessionInfo(from raw: [String: Any]) -> SessionInfo? {
        guard let id = raw["id"] as? String else { return nil }

        let port: Int
        if let portValue = raw["port"] as? Int {
            port = portValue
        } else if let number = raw["port"] as? NSNumber {
            port = number.intValue
        } else {
            port = 0
        }

        return SessionInfo(
            id: id,
            port: port,
            projectName: raw["projectName"] as? String,
            agentType: raw["agentType"] as? String,
            alive: (raw["alive"] as? Bool) ?? true,
            state: raw["state"] as? String
        )
    }
}
#endif
