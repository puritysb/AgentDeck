// AgentStateHolder.swift — Main @Observable state store
// Ported from android AgentState.kt (AgentStateHolder)

import Foundation
import Combine
#if os(macOS)
import AppKit
import IOKit
import IOKit.ps

// IOKit power-management constant (the real symbol is private in the Swift import).
private let kIOMessageSystemHasPoweredOn_AgentStateHolder: UInt32 = 0xe0000300
#endif

final class AgentStateHolder: ObservableObject, @unchecked Sendable {
    // MARK: - State

    @Published private(set) var state = DashboardState()
    @Published private(set) var lastDataReceivedAt: Date?
    private var lastKnownState: DashboardState?

    // MARK: - Dependencies

    let connection = BridgeConnection()
    let discovery = BridgeDiscovery()
    let timelineStore = TimelineStore()
    let displaySync = DisplaySyncService()
    private(set) var timelineGenerator: StateTimelineGenerator!

    /// Bump to trigger SwiftUI re-render for nested timelineStore changes
    @Published private(set) var timelineVersion: Int = 0

    // MARK: - URL Persistence

    private static let lastBridgeUrlKey = "lastBridgeUrl"

    private var savedUrl: String? {
        get { UserDefaults.standard.string(forKey: Self.lastBridgeUrlKey) }
        set {
            if let newValue {
                UserDefaults.standard.set(newValue, forKey: Self.lastBridgeUrlKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.lastBridgeUrlKey)
            }
        }
    }

    // MARK: - Lifecycle

    private var backgroundEnteredAt: Date?
    private var isTerminating = false
    #if os(macOS)
    private var staleDataMonitor: Timer?
    private static let staleDataThresholdSec: TimeInterval = 20
    /// Ignore stale watchdog for this long after a wake so in-process daemon
    /// recovery (ESP32 2s serial reopen, mDNS/Bonjour republish) can complete
    /// before we judge the socket dead. D200H HID recovery used to need a 10s
    /// window because its 5s IOHIDManager restart blocked the main thread;
    /// now that HID callbacks run on `HIDRunLoopThread` (see D200hHidModule),
    /// 3s is enough for the lighter remaining work.
    private static let wakeGracePeriodSec: TimeInterval = 3
    /// Debounce threshold for handleSystemWake — IOKit SystemHasPoweredOn +
    /// NSWorkspace.screensDidWake both fire on S3→wake.
    private static let wakeDebounceSec: TimeInterval = 1
    private var wakeNotificationPort: IONotificationPortRef?
    private var wakeNotifier: io_object_t = 0
    private var wakeRootDomain: io_object_t = 0
    private var displayWakeObserver: NSObjectProtocol?
    private var lastWakeHandledAt: Date?
    #endif

    // MARK: - Connection Waterfall State

    @Published private(set) var isAutoConnecting = false
    private var waterfallStage: WaterfallStage = .idle
    private var preferredLocalBridgeUrl: String?

    /// Bridges that failed to connect — skip them until browseResults refresh
    private var failedBridgeIds: Set<String> = []
    /// Track last browseResults count to detect mDNS refresh and clear blacklist
    private var lastBrowseCount: Int = 0
    private var cancellables = Set<AnyCancellable>()

    private enum WaterfallStage {
        case idle
        case savedUrl        // trying last known URL
        case mdns            // mDNS discovery
    }

    // MARK: - Init

    init() {
        connection.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        discovery.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        timelineStore.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)
        displaySync.objectWillChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &cancellables)

        // iOS: react to mDNS bridge changes even after autoConnect timer expires.
        // Without this, if daemon restarts after the 10s polling window, iOS never reconnects.
        discovery.$bridges
            .receive(on: DispatchQueue.main)
            .sink { [weak self] bridges in
                guard let self else { return }
                guard !self.isTerminating else { return }
                guard self.preferredLocalBridgeUrl == nil else { return }
                guard !self.state.bridgeConnected,
                      self.connection.status == .disconnected else { return }
                guard self.autoConnectTimer == nil else { return }

                let candidates = bridges.filter { !self.failedBridgeIds.contains($0.id) }
                let bridge = candidates.first(where: { $0.agentType == "daemon" })
                    ?? candidates.first(where: { $0.agentType != nil })
                if let bridge {
                    print("[AutoReconnect] new bridge appeared while disconnected: \(bridge.wsUrl)")
                    self.failedBridgeIds.removeAll()
                    self.connectTo(bridge)
                }
            }
            .store(in: &cancellables)

        timelineGenerator = StateTimelineGenerator(store: timelineStore)
        connection.onEvent = { [weak self] event in
            guard let self, !self.isTerminating else { return }
            self.handleEvent(event)
        }
        connection.onDisconnect = { [weak self] in
            guard let self else { return }
            guard !self.isTerminating else { return }
            if self.state.bridgeConnected {
                self.resetToDisconnected()
            }
            // macOS local daemon mode should reconnect directly instead of discovering itself via mDNS
            if let preferredLocalBridgeUrl = self.preferredLocalBridgeUrl {
                self.connectTo(url: preferredLocalBridgeUrl)
            } else {
                // Start mDNS discovery during reconnect so we can find new bridges
                self.discovery.startSearching()
            }
        }
        connection.onReconnectExhausted = { [weak self] in
            guard let self else { return }
            guard !self.isTerminating else { return }
            // Blacklist the failed bridge so we skip it in auto-connect
            if let url = self.connection.url,
               let bridge = self.discovery.bridges.first(where: { $0.wsUrl == url }) {
                self.failedBridgeIds.insert(bridge.id)
                print("[Waterfall] blacklisted bridge \(bridge.id) after reconnect exhausted")
            }
            self.savedUrl = nil
            self.waterfallStage = .idle
            self.startConnectionWaterfall()
        }

        // On each reconnect attempt, check for available bridges.
        // If found, abort stale-URL reconnect and connect to the new bridge.
        connection.onReconnectAttempt = { [weak self] in
            guard let self else { return false }
            guard !self.isTerminating else { return true }

            // Check mDNS discovered bridges (skip blacklisted, prefer daemon)
            let candidates = self.discovery.bridges.filter { !self.failedBridgeIds.contains($0.id) }
            let bridge = candidates.first(where: { $0.agentType == "daemon" })
                ?? candidates.first
            if let bridge, bridge.wsUrl != self.connection.url {
                DispatchQueue.main.async {
                    self.savedUrl = nil
                    self.waterfallStage = .idle
                    self.connectTo(bridge)
                }
                return true  // abort reconnect
            }

            return false
        }

        #if os(macOS)
        startStaleDataMonitor()
        startSystemWakeListener()
        #endif
    }

    #if os(macOS)
    deinit {
        stopSystemWakeListener()
    }
    #endif

    #if os(macOS)
    private func startSystemWakeListener() {
        guard wakeNotificationPort == nil else { return }
        guard let port = IONotificationPortCreate(kIOMainPortDefault) else {
            print("[Lifecycle] failed to create IONotificationPort for wake listener")
            return
        }
        IONotificationPortSetDispatchQueue(port, DispatchQueue.main)
        let rootDomain = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOPMrootDomain"))
        guard rootDomain != 0 else {
            print("[Lifecycle] failed to match IOPMrootDomain")
            IONotificationPortDestroy(port)
            return
        }
        var notifier: io_object_t = 0
        let callback: IOServiceInterestCallback = { (refcon, _, messageType, _) in
            guard messageType == kIOMessageSystemHasPoweredOn_AgentStateHolder else { return }
            guard let refcon else { return }
            let holder = Unmanaged<AgentStateHolder>.fromOpaque(refcon).takeUnretainedValue()
            holder.handleSystemWake()
        }
        let result = IOServiceAddInterestNotification(
            port,
            rootDomain,
            kIOGeneralInterest,
            callback,
            Unmanaged.passUnretained(self).toOpaque(),
            &notifier
        )
        if result != KERN_SUCCESS {
            print("[Lifecycle] IOServiceAddInterestNotification failed: \(result)")
            IOObjectRelease(rootDomain)
            IONotificationPortDestroy(port)
            return
        }
        self.wakeNotificationPort = port
        self.wakeNotifier = notifier
        self.wakeRootDomain = rootDomain

        // Display wake (monitor on) — separate from system wake
        displayWakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.screensDidWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.handleSystemWake()
        }

        print("[Lifecycle] system + display wake listener installed")
    }

    private func stopSystemWakeListener() {
        if let obs = displayWakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(obs)
            displayWakeObserver = nil
        }
        if wakeNotifier != 0 {
            IOObjectRelease(wakeNotifier)
            wakeNotifier = 0
        }
        if wakeRootDomain != 0 {
            IOObjectRelease(wakeRootDomain)
            wakeRootDomain = 0
        }
        if let port = wakeNotificationPort {
            IONotificationPortDestroy(port)
            wakeNotificationPort = nil
        }
    }

    private func handleSystemWake() {
        guard !isTerminating else { return }
        let now = Date()
        if let last = lastWakeHandledAt, now.timeIntervalSince(last) < Self.wakeDebounceSec {
            return
        }
        lastWakeHandledAt = now
        // Give the stale-data watchdog a fresh reference point so it doesn't
        // fire mid-reconnect using the pre-sleep timestamp.
        lastDataReceivedAt = now
        print("[Lifecycle] system wake — force reconnect")
        connection.forceDisconnectAndRestart()
        if let preferredLocalBridgeUrl {
            connectTo(url: preferredLocalBridgeUrl)
        } else {
            restartWaterfall()
        }
    }

    private func startStaleDataMonitor() {
        staleDataMonitor?.invalidate()
        staleDataMonitor = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in
            self?.checkForStaleBridgeData()
        }
        if let staleDataMonitor {
            RunLoop.main.add(staleDataMonitor, forMode: .common)
        }
    }

    private func checkForStaleBridgeData() {
        guard !isTerminating else { return }
        guard state.bridgeConnected,
              connection.status == .connected,
              !connection.isReconnecting,
              let preferredLocalBridgeUrl,
              let lastDataReceivedAt else { return }

        if let wakeAt = lastWakeHandledAt,
           Date().timeIntervalSince(wakeAt) < Self.wakeGracePeriodSec {
            return
        }

        let age = Date().timeIntervalSince(lastDataReceivedAt)
        guard age > Self.staleDataThresholdSec else { return }

        print("[Lifecycle] bridge data stale (\(Int(age))s) — reconnecting preferred local bridge")
        connection.forceDisconnectAndRestart()
        connectTo(url: preferredLocalBridgeUrl)
    }
    #endif

    // MARK: - Lifecycle Handlers

    func prepareForTermination() {
        guard !isTerminating else { return }
        isTerminating = true

        backgroundEnteredAt = nil
        preferredLocalBridgeUrl = nil
        isAutoConnecting = false
        waterfallStage = .idle
        autoConnectTimer?.invalidate()
        autoConnectTimer = nil

        #if os(macOS)
        staleDataMonitor?.invalidate()
        staleDataMonitor = nil
        stopSystemWakeListener()
        #endif

        discovery.prepareForTermination()
        connection.prepareForTermination()
    }

    func handleBackgroundEntry() {
        guard !isTerminating else { return }
        backgroundEnteredAt = Date()
        connection.stopPingTimer()
        print("[Lifecycle] entered background")
    }

    func handleForegroundReturn() {
        guard !isTerminating else { return }
        let suspendDuration: TimeInterval
        if let enteredAt = backgroundEnteredAt {
            suspendDuration = Date().timeIntervalSince(enteredAt)
        } else {
            suspendDuration = 0
        }
        backgroundEnteredAt = nil
        print("[Lifecycle] foreground return, suspend=\(String(format: "%.1f", suspendDuration))s, connected=\(state.bridgeConnected)")

        // Sync display brightness on foreground return
        #if os(iOS)
        displaySync.handleForegroundReturn(hostDisplayOn: state.hostDisplayOn)
        #endif

        #if os(macOS)
        if !state.bridgeConnected {
            if let preferredLocalBridgeUrl {
                print("[Lifecycle] macOS forcing reconnect directly to preferred local bridge")
                connection.forceDisconnectAndRestart()
                connectTo(url: preferredLocalBridgeUrl)
            } else {
                print("[Lifecycle] macOS restarting waterfall on foreground return")
                restartWaterfall()
            }
            return
        }

        if suspendDuration > 15 {
            print("[Lifecycle] long suspend (\(Int(suspendDuration))s) — socket dead, reconnect preferred local bridge")
            connection.forceDisconnectAndRestart()
            if let preferredLocalBridgeUrl {
                connectTo(url: preferredLocalBridgeUrl)
            }
        } else if suspendDuration > 5 {
            print("[Lifecycle] medium suspend (\(Int(suspendDuration))s) — health check")
            connection.forceHealthCheck { [weak self] alive in
                guard let self else { return }
                guard !self.isTerminating else { return }
                if !alive {
                    print("[Lifecycle] health check failed — reconnecting preferred local bridge")
                    self.connection.forceDisconnectAndRestart()
                    if let preferredLocalBridgeUrl = self.preferredLocalBridgeUrl {
                        self.connectTo(url: preferredLocalBridgeUrl)
                    }
                } else {
                    print("[Lifecycle] health check passed")
                    self.connection.startPingTimer()
                }
            }
            return
        } else {
            connection.startPingTimer()
        }
#else
        if !state.bridgeConnected {
            // Not connected — restart discovery
            restartWaterfall()
        } else if suspendDuration > 15 {
            // Server terminates after ~15s without pong — socket is dead
            print("[Lifecycle] long suspend (\(Int(suspendDuration))s) — socket dead, force reconnect")
            connection.forceDisconnectAndRestart()
            restartWaterfall()
        } else if suspendDuration > 5 {
            // 5-15s: might still be alive — health check
            print("[Lifecycle] medium suspend (\(Int(suspendDuration))s) — health check")
            connection.forceHealthCheck { [weak self] alive in
                guard let self else { return }
                guard !self.isTerminating else { return }
                if !alive {
                    print("[Lifecycle] health check failed — reconnecting")
                    self.connection.forceDisconnectAndRestart()
                    self.restartWaterfall()
                } else {
                    print("[Lifecycle] health check passed")
                    self.connection.startPingTimer()
                }
            }
            return  // Don't restart ping timer yet — health check callback will
        } else {
            // Short suspend — just restart ping timer
            connection.startPingTimer()
        }
#endif
    }

    private func restartWaterfall() {
        guard !isTerminating else { return }
        // Force reset waterfall stage so startConnectionWaterfall() can enter
        waterfallStage = .idle
        connection.resetReconnectCount()
        startConnectionWaterfall()
    }

    // MARK: - Connection Waterfall

    func startConnectionWaterfall() {
        guard !isTerminating else { return }
        if let preferredLocalBridgeUrl {
            isAutoConnecting = false
            waterfallStage = .idle
            if connection.url != preferredLocalBridgeUrl || connection.status == .disconnected {
                connectTo(url: preferredLocalBridgeUrl)
            }
            return
        }
        guard waterfallStage == .idle else {
            print("[Waterfall] already in stage \(waterfallStage), skipping")
            return
        }
        isAutoConnecting = true
        print("[Waterfall] starting waterfall")

        // Always mDNS first — savedUrl can be stale after DHCP/network changes.
        // savedUrl is tried as fallback after 4s if no mDNS results.
        startMdnsDiscovery()
    }

    private func trySavedUrl() {
        guard !isTerminating else { return }
        if let url = savedUrl {
            print("[Waterfall] trying saved URL: \(url)")
            waterfallStage = .savedUrl
            connectTo(url: url)

            // Timeout: if not connected within 5 seconds, fall through to mDNS
            // (iOS WiFi init can take 2-4s after app launch)
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                guard let self, self.waterfallStage == .savedUrl else { return }
                guard !self.isTerminating else { return }
                if !self.state.bridgeConnected {
                    print("[Waterfall] saved URL timeout, falling through to mDNS")
                    self.connection.disconnect(reconnect: false)
                    self.startMdnsDiscovery()
                }
            }
        } else {
            print("[Waterfall] no saved URL, going to mDNS")
            startMdnsDiscovery()
        }
    }

    private func startMdnsDiscovery() {
        guard !isTerminating else { return }
        print("[Waterfall] starting mDNS discovery")
        waterfallStage = .mdns
        discovery.startSearching()

        // Poll for discovered bridges and auto-connect to the first one
        startAutoConnectPolling()
    }

    private var autoConnectTimer: Timer?
    private var autoConnectPollCount = 0

    private func startAutoConnectPolling() {
        guard !isTerminating else { return }
        autoConnectPollCount = 0
        autoConnectTimer?.invalidate()
        autoConnectTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            guard !self.isTerminating else {
                timer.invalidate()
                self.autoConnectTimer = nil
                return
            }
            guard self.waterfallStage == .mdns else {
                print("[AutoConnect] timer stopped: stage=\(self.waterfallStage)")
                timer.invalidate()
                self.autoConnectTimer = nil
                return
            }
            guard !self.state.bridgeConnected else {
                print("[AutoConnect] timer stopped: already connected")
                timer.invalidate()
                self.autoConnectTimer = nil
                return
            }

            // Skip if already trying to connect
            if self.connection.status != .disconnected {
                print("[AutoConnect] skipping: connection status=\(self.connection.status)")
                return
            }

            // Clear blacklist when browseResults change (stale mDNS entries removed)
            let currentBrowseCount = self.discovery.bridges.count
            if currentBrowseCount != self.lastBrowseCount {
                if !self.failedBridgeIds.isEmpty {
                    print("[AutoConnect] browseResults changed (\(self.lastBrowseCount)→\(currentBrowseCount)), clearing \(self.failedBridgeIds.count) failed bridges")
                    self.failedBridgeIds.removeAll()
                }
                self.lastBrowseCount = currentBrowseCount
            }

            print("[AutoConnect] poll: bridges=\(self.discovery.bridges.count), failed=\(self.failedBridgeIds.count), searching=\(self.discovery.isSearching)")

            // After 4s with no mDNS results, try savedUrl as fallback
            if self.autoConnectPollCount == 8, self.discovery.bridges.isEmpty, let url = self.savedUrl {
                print("[AutoConnect] no mDNS after 4s, trying saved URL: \(url)")
                timer.invalidate()
                self.autoConnectTimer = nil
                self.waterfallStage = .savedUrl
                self.connectTo(url: url)
                return
            }

            // Filter out bridges that previously failed to connect (ghost mDNS entries)
            let candidates = self.discovery.bridges.filter { !self.failedBridgeIds.contains($0.id) }

            // Prefer daemon bridge for consistent state (daemon aggregates all sessions)
            let daemon = candidates.first(where: { $0.agentType == "daemon" })
            if let daemon {
                print("[AutoConnect] connecting to daemon: \(daemon.wsUrl)")
                timer.invalidate()
                self.autoConnectTimer = nil
                self.connectTo(daemon)
            } else if !candidates.isEmpty {
                // If some bridges have nil agentType (health not yet resolved), wait up to 4s
                // for /health responses before falling back to any bridge
                let hasUnresolved = candidates.contains(where: { $0.agentType == nil })
                if hasUnresolved && self.autoConnectPollCount < 8 {
                    print("[AutoConnect] waiting for health info (\(candidates.count) bridges, some unresolved)")
                } else {
                    guard let bridge = candidates.first else { return }
                    print("[AutoConnect] connecting to bridge: \(bridge.wsUrl) (agent=\(bridge.agentType ?? "?"))")
                    timer.invalidate()
                    self.autoConnectTimer = nil
                    self.connectTo(bridge)
                }
            }

            // After 10 seconds with no mDNS results, stop polling
            // (user can still manually enter URL via ConnectionOverlay)
            self.autoConnectPollCount += 1
            if self.autoConnectPollCount >= 20 {  // 20 × 0.5s = 10s
                print("[AutoConnect] giving up after 10s with no bridges found")
                timer.invalidate()
                self.autoConnectTimer = nil
                self.isAutoConnecting = false
                self.waterfallStage = .idle
            }
        }
    }

    // MARK: - Event Handler

    func handleEvent(_ event: BridgeEvent) {
        guard !isTerminating else { return }
        switch event {
        case .stateUpdate(let e):
            handleStateUpdate(e)
        case .usageUpdate(let e):
            handleUsageUpdate(e)
        case .connection(let e):
            handleConnection(e)
        case .voiceState(let e):
            state.voiceState = e.state
            state.voiceText = e.text
            state.voiceError = e.error
        case .displayState(let e):
            state.hostDisplayOn = e.displayOn
            displaySync.handleDisplayState(displayOn: e.displayOn, dim: e.dim)
        case .sessionsList(let e):
            state.siblingSessions = e.sessions
        case .promptOptions(let e):
            state.options = e.options
            state.promptType = PromptType(rawValue: e.promptType)
            state.question = e.question
        case .buttonState:
            break  // Deck UI removed
        case .encoderState:
            break  // Deck UI removed
        case .deckSlotMap:
            break  // Deck UI removed
        case .userPrompt:
            break  // handled by voice/deck UI
        case .timelineEvent(let e):
            timelineGenerator.receivingBridgeTimeline = true
            timelineStore.addEntry(e.entry, upsert: e.upsert ?? false)
            timelineVersion += 1
        case .timelineHistory(let e):
            timelineGenerator.receivingBridgeTimeline = true
            timelineStore.mergeHistory(e.entries)
            timelineVersion += 1
        }

        // Track last data received time for stale indicator
        switch event {
        case .stateUpdate, .usageUpdate, .sessionsList, .timelineEvent, .timelineHistory:
            lastDataReceivedAt = Date()
        default:
            break
        }

        // Cache state for offline display
        if case .stateUpdate = event { lastKnownState = state }
        if case .usageUpdate = event { lastKnownState = state }
    }

    // MARK: - State Update

    private func handleStateUpdate(_ e: StateUpdateEvent) {
        // Null-coalescing: only update fields that are present
        state.state = AgentConnectionState(rawValue: e.state) ?? state.state
        if let pm = e.permissionMode { state.permissionMode = PermissionMode(rawValue: pm) ?? state.permissionMode }
        state.agentType = e.agentType ?? state.agentType
        if let sid = e.sessionId { state.sessionId = sid }
        if let focusedSessionId = e.focusedSessionId {
            state.focusedSessionId = focusedSessionId.isEmpty ? nil : focusedSessionId
        }
        state.agentCapabilities = e.agentCapabilities ?? state.agentCapabilities
        state.currentTool = e.currentTool ?? state.currentTool
        state.toolInput = e.toolInput ?? state.toolInput
        state.toolProgress = e.toolProgress ?? state.toolProgress
        state.projectName = e.projectName ?? state.projectName
        state.modelName = e.modelName ?? state.modelName
        state.effortLevel = e.effortLevel ?? state.effortLevel
        if let bt = e.billingType { state.billingType = BillingType(rawValue: bt) ?? state.billingType }
        if let opts = e.options { state.options = opts }
        if let pt = e.promptType { state.promptType = PromptType(rawValue: pt) }
        state.question = e.question ?? state.question
        state.navigable = e.navigable ?? state.navigable
        state.cursorIndex = e.cursorIndex ?? state.cursorIndex
        state.suggestedPrompt = e.suggestedPrompt ?? state.suggestedPrompt
        if let mc = e.modelCatalog { state.modelCatalog = mc }
        state.sessionStatus = e.sessionStatus ?? state.sessionStatus
        state.remoteUrl = e.remoteUrl ?? state.remoteUrl
        state.pairingUrl = e.pairingUrl ?? state.pairingUrl
        state.workerSessionCount = e.workerSessionCount ?? state.workerSessionCount
        if let os = e.ollamaStatus { state.ollamaStatus = os }
        state.mlxModels = e.mlxModels ?? state.mlxModels
        if let subscriptions = e.subscriptions {
            state.subscriptions = subscriptions
        }
        let sawCodexAuthField = e.codexAuthMode != nil
            || e.codexWebAuthConnected != nil
            || e.codexPlanType != nil
            || e.codexAccountId != nil
            || e.codexSubscriptionActiveUntil != nil
            || e.codexLastRefreshAt != nil
        state.codexAuthMode = e.codexAuthMode ?? state.codexAuthMode
        state.codexWebAuthConnected = e.codexWebAuthConnected ?? state.codexWebAuthConnected
        state.codexPlanType = e.codexPlanType ?? state.codexPlanType
        state.codexAccountId = e.codexAccountId ?? state.codexAccountId
        state.codexSubscriptionActiveUntil = e.codexSubscriptionActiveUntil ?? state.codexSubscriptionActiveUntil
        state.codexLastRefreshAt = e.codexLastRefreshAt ?? state.codexLastRefreshAt
        if e.subscriptions == nil {
            reconcileCodexSubscriptionFallback(clearWhenUnavailable: sawCodexAuthField)
        }
        state.antigravityStatus = e.antigravityStatus ?? state.antigravityStatus
        state.gatewayAvailable = e.gatewayAvailable ?? state.gatewayAvailable
        state.gatewayConnected = e.gatewayConnected ?? state.gatewayConnected
        state.gatewayHasError = e.gatewayHasError ?? state.gatewayHasError
        if let gatewayAuthStatus = e.gatewayAuthStatus {
            state.gatewayAuthStatus = gatewayAuthStatus
            state.gatewayAuthRequestId = e.gatewayAuthRequestId
            state.gatewayAuthMessage = e.gatewayAuthMessage
        }
        state.gatewayDeviceId = e.gatewayDeviceId ?? state.gatewayDeviceId
        state.daemonPort = e.daemonPort ?? state.daemonPort
        state.mlxModelCatalog = e.mlxModelCatalog ?? state.mlxModelCatalog
        state.voiceAssistantState = e.voiceAssistantState ?? state.voiceAssistantState
        state.voiceAssistantText = e.voiceAssistantText  // null when idle, no fallback
        state.voiceAssistantResponseText = e.voiceAssistantResponseText  // null when idle
        if let mh = e.moduleHealth { state.moduleHealth = mh }

        // OpenClaw Gateway provides its own rich timeline entries via timeline_event.
        // Suppress the StateTimelineGenerator fallback ("Prompt sent" etc.) as soon
        // as the gateway is confirmed connected so the generator doesn't race ahead
        // of the first timeline_event from the adapter.
        if state.gatewayConnected == true {
            timelineGenerator.receivingBridgeTimeline = true
        }

        // Local timeline generation (when bridge doesn't provide rich timeline)
        timelineGenerator.onStateUpdate(
            newState: state.state,
            agentType: e.agentType,
            currentTool: e.currentTool,
            toolInput: e.toolInput,
            question: e.question,
            projectName: e.projectName,
            sessionId: e.sessionId
        )
        timelineVersion += 1

        // Clear tool info on idle
        if state.state == .idle {
            state.currentTool = nil
            state.toolInput = nil
            state.toolProgress = nil
        }

        // Clear options when not awaiting
        if !state.state.isAwaiting {
            state.options = []
            state.question = nil
            state.promptType = nil
        }
    }

    // MARK: - Usage Update

    private func handleUsageUpdate(_ e: UsageEvent) {
        state.sessionDurationSec = e.sessionDurationSec ?? state.sessionDurationSec
        state.inputTokens = e.inputTokens ?? state.inputTokens
        state.outputTokens = e.outputTokens ?? state.outputTokens
        state.toolCalls = e.toolCalls ?? state.toolCalls
        state.estimatedCostUsd = e.estimatedCostUsd ?? state.estimatedCostUsd
        state.sessionPercent = e.sessionPercent ?? state.sessionPercent
        state.costSpent = e.costSpent ?? state.costSpent
        state.costLimit = e.costLimit ?? state.costLimit
        state.resetTime = e.resetTime ?? state.resetTime
        state.resetDate = e.resetDate ?? state.resetDate
        // Save previous values for trend indicators before overwriting
        if e.fiveHourPercent != nil { state.previousFiveHourPercent = state.fiveHourPercent }
        if e.sevenDayPercent != nil { state.previousSevenDayPercent = state.sevenDayPercent }
        // When upstream signals stale (no live source could produce a fresh
        // number) clear the displayed values entirely instead of retaining
        // the last-seen ones — a stale number in the UI is the worst of both
        // worlds (looks authoritative, but isn't). Downstream surfaces then
        // naturally collapse their usage regions on nil.
        if e.usageStale == true {
            state.fiveHourPercent = nil
            state.sevenDayPercent = nil
            state.fiveHourResetsAt = nil
            state.sevenDayResetsAt = nil
        } else {
            state.fiveHourPercent = e.fiveHourPercent ?? state.fiveHourPercent
            state.sevenDayPercent = e.sevenDayPercent ?? state.sevenDayPercent
            state.fiveHourResetsAt = e.fiveHourResetsAt ?? state.fiveHourResetsAt
            state.sevenDayResetsAt = e.sevenDayResetsAt ?? state.sevenDayResetsAt
        }
        state.extraUsageEnabled = e.extraUsageEnabled ?? state.extraUsageEnabled
        state.extraUsageMonthlyLimit = e.extraUsageMonthlyLimit ?? state.extraUsageMonthlyLimit
        state.extraUsageUsedCredits = e.extraUsageUsedCredits ?? state.extraUsageUsedCredits
        state.extraUsageUtilization = e.extraUsageUtilization ?? state.extraUsageUtilization
        state.oauthConnected = e.oauthConnected ?? state.oauthConnected
        if let os = e.ollamaStatus { state.ollamaStatus = os }
        state.usageStale = e.usageStale ?? state.usageStale
        let sawCodexAuthField = e.codexAuthMode != nil
            || e.codexWebAuthConnected != nil
            || e.codexPlanType != nil
            || e.codexAccountId != nil
            || e.codexSubscriptionActiveUntil != nil
            || e.codexLastRefreshAt != nil
        state.codexAuthMode = e.codexAuthMode ?? state.codexAuthMode
        state.codexWebAuthConnected = e.codexWebAuthConnected ?? state.codexWebAuthConnected
        state.codexPlanType = e.codexPlanType ?? state.codexPlanType
        state.codexAccountId = e.codexAccountId ?? state.codexAccountId
        state.codexSubscriptionActiveUntil = e.codexSubscriptionActiveUntil ?? state.codexSubscriptionActiveUntil
        state.codexLastRefreshAt = e.codexLastRefreshAt ?? state.codexLastRefreshAt
        state.modelCatalog = e.modelCatalog ?? state.modelCatalog
        state.mlxModels = e.mlxModels ?? state.mlxModels
        state.mlxModelCatalog = e.mlxModelCatalog ?? state.mlxModelCatalog
        if let subscriptions = e.subscriptions {
            state.subscriptions = subscriptions
        } else {
            reconcileCodexSubscriptionFallback(clearWhenUnavailable: sawCodexAuthField)
        }
        state.antigravityStatus = e.antigravityStatus ?? state.antigravityStatus

        state.adminApiKeyPresent = e.adminApiKeyPresent ?? state.adminApiKeyPresent
        state.adminApiTodayInputTokens = e.adminApiTodayInputTokens ?? state.adminApiTodayInputTokens
        state.adminApiTodayOutputTokens = e.adminApiTodayOutputTokens ?? state.adminApiTodayOutputTokens
        state.adminApiTodayCacheReadTokens = e.adminApiTodayCacheReadTokens ?? state.adminApiTodayCacheReadTokens
        state.adminApiTodayCacheCreationTokens = e.adminApiTodayCacheCreationTokens ?? state.adminApiTodayCacheCreationTokens
        state.adminApiMonthInputTokens = e.adminApiMonthInputTokens ?? state.adminApiMonthInputTokens
        state.adminApiMonthOutputTokens = e.adminApiMonthOutputTokens ?? state.adminApiMonthOutputTokens
        state.adminApiMonthCacheReadTokens = e.adminApiMonthCacheReadTokens ?? state.adminApiMonthCacheReadTokens
        state.adminApiMonthCacheCreationTokens = e.adminApiMonthCacheCreationTokens ?? state.adminApiMonthCacheCreationTokens
        state.adminApiTopModels = e.adminApiTopModels ?? state.adminApiTopModels
        state.adminApiFetchedAt = e.adminApiFetchedAt ?? state.adminApiFetchedAt
        state.adminApiStale = e.adminApiStale ?? state.adminApiStale
    }

    private func reconcileCodexSubscriptionFallback(clearWhenUnavailable: Bool) {
        let nonChatGptSubscriptions = state.subscriptions.filter {
            !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("chatgpt")
        }
        guard let name = Self.chatGptSubscriptionName(
            planType: state.codexPlanType,
            authMode: state.codexAuthMode,
            webAuthConnected: state.codexWebAuthConnected,
            until: state.codexSubscriptionActiveUntil
        ) else {
            if clearWhenUnavailable {
                state.subscriptions = nonChatGptSubscriptions
            }
            return
        }

        var subscriptions = nonChatGptSubscriptions
        subscriptions.insert(SubscriptionInfo(name: name, until: state.codexSubscriptionActiveUntil), at: 0)
        state.subscriptions = subscriptions
    }

    private static func chatGptSubscriptionName(
        planType: String?,
        authMode: String?,
        webAuthConnected: Bool?,
        until: String?
    ) -> String? {
        if let plan = planType?.trimmingCharacters(in: .whitespacesAndNewlines), !plan.isEmpty {
            switch plan.lowercased() {
            case "plus": return "ChatGPT Plus"
            case "pro": return "ChatGPT Pro"
            case "team": return "ChatGPT Team"
            case "enterprise": return "ChatGPT Enterprise"
            default: return "ChatGPT \(plan)"
            }
        }
        let normalizedMode = authMode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let hasUntil = until.map { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? false
        if webAuthConnected == true || normalizedMode == "chatgpt" || hasUntil {
            return "ChatGPT"
        }
        return nil
    }

    // MARK: - Connection

    private func handleConnection(_ e: ConnectionEvent) {
        switch e.status {
        case "connected":
            state.bridgeConnected = true
            state.sessionId = e.sessionId
            state.focusedSessionId = nil
            isAutoConnecting = false
            waterfallStage = .idle

            // Save successful URL for next launch
            if let url = connection.url {
                savedUrl = url
            }
        case "disconnected":
            resetToDisconnected()
        default:
            break
        }
    }

    private func resetToDisconnected() {
        timelineGenerator.onDisconnected()
        timelineVersion += 1
        // Preserve lastKnownState for offline display
        state.bridgeConnected = false
        state.state = .disconnected
        state.sessionId = nil
        state.focusedSessionId = nil
        state.hostDisplayOn = true
        #if os(iOS)
        displaySync.restoreOnDisconnect()
        #endif
        state.currentTool = nil
        state.toolInput = nil
        state.toolProgress = nil
        state.options = []
        state.question = nil
    }

    // MARK: - Commands

    func sendCommand(_ command: PluginCommand) {
        guard !isTerminating else { return }
        connection.send(command)
    }

    // MARK: - Connection Management

    func connectTo(_ bridge: DiscoveredBridge) {
        guard !isTerminating else { return }
        connection.connect(to: bridge.wsUrl)
    }

    func connectTo(url: String) {
        guard !isTerminating else { return }
        connection.connect(to: url)
    }

    func setPreferredLocalBridge(url: String?) {
        guard !isTerminating else { return }
        preferredLocalBridgeUrl = url
        if let url {
            autoConnectTimer?.invalidate()
            autoConnectTimer = nil
            isAutoConnecting = false
            waterfallStage = .idle
            discovery.stopSearching()
            failedBridgeIds.removeAll()
            if connection.url != url {
                // Force-disconnect any in-progress reconnect loop on the old URL
                // before switching to the new one (e.g. daemon restarted on a different port).
                connection.disconnect()
                connectTo(url: url)
            } else if connection.status == .disconnected {
                connectTo(url: url)
            }
        }
    }

    func disconnectBridge() {
        guard !isTerminating else { return }
        connection.disconnect()
        resetToDisconnected()
        savedUrl = nil  // Clear saved URL on explicit disconnect
        preferredLocalBridgeUrl = nil  // Prevent auto-reconnect from onDisconnect handler
        waterfallStage = .idle
    }
}
