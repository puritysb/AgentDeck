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
    /// before we judge the socket dead.
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

    /// A **bounded foreground attempt** is in flight. This is the only signal the
    /// connection overlay may render as a progress indicator — never
    /// `BridgeDiscovery.isSearching`, which stays true for the long-lived Bonjour
    /// browser and caused the App Review 2.1(a) rejection of build 3901.
    ///
    /// Every path that ends an attempt must clear it, so the setter is funnelled
    /// through `beginForegroundSearch()` / `endForegroundSearch()` and backed by
    /// `foregroundSearchDeadline` — see those for the invariant.
    @Published private(set) var isAutoConnecting = false

    /// False until the first foreground attempt has been *started*. Without it the
    /// overlay renders one frame of the "nothing found" terminal state before
    /// `ContentView.onAppear` kicks the waterfall off. iOS is the only platform
    /// that starts the waterfall from a view appearance; macOS drives its own
    /// in-process daemon through `setPreferredLocalBridge`, so it must start out
    /// `true` or the overlay would report a search that never begins.
    #if os(iOS)
    @Published private(set) var hasStartedForegroundSearch = false
    #else
    @Published private(set) var hasStartedForegroundSearch = true
    #endif

    private var waterfallStage: WaterfallStage = .idle
    private var preferredLocalBridgeUrl: String?

    /// Hard ceiling on the user-visible foreground attempt, independent of which
    /// waterfall stage is in flight.
    ///
    /// The waterfall has several exits (mDNS hit, 4s saved-URL fallback, the
    /// reconnect ladder, an explicit user stop) and each used to own its own
    /// termination. Any path that forgot left the indicator spinning forever —
    /// the rejected symptom. Rather than auditing every future exit, this deadline
    /// makes boundedness structural: it fires once per run and clears the
    /// indicator no matter what. It deliberately does **not** tear down the
    /// socket; a connect still in flight keeps its own `.connecting` phase and can
    /// still succeed. Sits just above the 10s auto-connect poll so the poll stays
    /// the normal reporter and this is only ever the backstop.
    private let foregroundSearchDeadlineSec: TimeInterval
    private var foregroundSearchDeadline: DispatchWorkItem?

    /// Set when the user explicitly stops connecting (Stop Reconnecting, Settings
    /// → Disconnect). Suppresses late-discovery auto-connect so the app does not
    /// immediately undo a deliberate disconnect. Cleared by any new connect intent.
    private var userStoppedConnecting = false

    #if DEBUG
    /// True when `-AgentDeckScreenshotURL` pinned the bridge at launch. The pin
    /// must outrank later `setPreferredLocalBridge` calls: on macOS the
    /// in-process daemon's `onReady` fires ~0.5s after launch and would
    /// otherwise repoint the app at its own :9120, silently discarding the pin
    /// and putting real workspace data on camera.
    private var hasLaunchArgumentBridgePin = false

    /// True when this process was launched pinned to a capture feed. UI that
    /// reflects *local machine* state rather than the pinned feed (the Setup
    /// card's integration gaps, for one) hides itself in this mode, so a
    /// launch recording shows the product instead of the operator's setup.
    var isCaptureFeedPinned: Bool { hasLaunchArgumentBridgePin }
    #endif

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

    /// - Parameter foregroundSearchDeadlineSec: ceiling on the visible search
    ///   indicator. Injectable so tests can assert the bound in milliseconds
    ///   instead of waiting out the production value.
    init(foregroundSearchDeadlineSec: TimeInterval = 12) {
        self.foregroundSearchDeadlineSec = foregroundSearchDeadlineSec
        #if DEBUG
        // App Store/launch capture only: pin a Debug app directly to the
        // deterministic local mock before mDNS can discover a developer daemon.
        // This supports Simulator captures and privacy-safe macOS rehearsals.
        // Release/App Store builds do not compile this path.
        let arguments = ProcessInfo.processInfo.arguments
        if let index = arguments.firstIndex(of: "-AgentDeckScreenshotURL"),
           arguments.indices.contains(index + 1) {
            preferredLocalBridgeUrl = arguments[index + 1]
            hasLaunchArgumentBridgePin = true
        }
        #endif

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
                // An explicit stop must stick. Without this the next mDNS tick
                // silently undoes "Stop Reconnecting" / Settings → Disconnect.
                guard !self.userStoppedConnecting else { return }

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
        connection.onReconnectExhausted = { [weak self] failedUrl in
            guard let self else { return }
            guard !self.isTerminating else { return }
            // Blacklist the failed bridge so we skip it in auto-connect. The URL
            // arrives as a parameter because `connection.url` is cleared in the
            // same block that invokes this callback.
            if let url = failedUrl,
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
        endForegroundSearch()
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
        hasStartedForegroundSearch = true
        userStoppedConnecting = false
        if let preferredLocalBridgeUrl {
            endForegroundSearch()
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
        beginForegroundSearch()
        print("[Waterfall] starting waterfall")

        // Always mDNS first — savedUrl can be stale after DHCP/network changes.
        // savedUrl is tried as fallback after 4s if no mDNS results.
        startMdnsDiscovery()
    }

    /// User-initiated retry from the "No AgentDeck found" state.
    ///
    /// Unlike `startConnectionWaterfall()` this never no-ops on the stage guard:
    /// a button the user can see must always do something. A stage left behind by
    /// an abandoned attempt is reset rather than respected — respecting it is how
    /// "Search Again" became a dead button that could only be cleared by
    /// relaunching the app.
    func retryConnectionWaterfall() {
        guard !isTerminating else { return }
        autoConnectTimer?.invalidate()
        autoConnectTimer = nil
        endForegroundSearch()
        waterfallStage = .idle
        failedBridgeIds.removeAll()
        connection.resetReconnectCount()
        startConnectionWaterfall()
    }

    /// Abandon the current attempt and settle on a stable, recoverable state.
    ///
    /// `BridgeConnection.disconnect()` only tears down the socket — it knows
    /// nothing about the waterfall, so calling it alone left `isAutoConnecting`
    /// true and the stage non-idle: a spinning indicator with no work behind it
    /// and no way back. Every user-facing stop goes through here instead.
    func stopConnectionAttempts() {
        guard !isTerminating else { return }
        autoConnectTimer?.invalidate()
        autoConnectTimer = nil
        endForegroundSearch()
        waterfallStage = .idle
        userStoppedConnecting = true
        connection.disconnect()
    }

    // MARK: - Foreground search indicator

    /// Start the bounded attempt and arm its deadline.
    private func beginForegroundSearch() {
        isAutoConnecting = true
        foregroundSearchDeadline?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.isTerminating, self.isAutoConnecting else { return }
            print("[Waterfall] foreground search deadline reached — clearing indicator")
            self.endForegroundSearch()
        }
        foregroundSearchDeadline = work
        DispatchQueue.main.asyncAfter(deadline: .now() + foregroundSearchDeadlineSec, execute: work)
    }

    /// End the bounded attempt. Idempotent; safe to call from any exit path.
    private func endForegroundSearch() {
        foregroundSearchDeadline?.cancel()
        foregroundSearchDeadline = nil
        isAutoConnecting = false
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
                self.endForegroundSearch()
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
            #if os(macOS)
            // Post/clear the "needs your response" system notification for
            // sessions entering/leaving an awaiting state. App-layer so it
            // covers both tiers (in-process Swift daemon + external Node
            // daemon client mode) with one implementation.
            let sessions = e.sessions
            Task { @MainActor in AttentionNotifier.sync(sessions: sessions) }
            #endif
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
            // Authoritative snapshot: replace, don't merge — the daemon
            // re-stamps ts on reconnect replay, and a ts-only merge stacked
            // ghost OpenClaw rows across reconnects. Mirrors Android
            // replace-on-connect. See TimelineStore.replaceSnapshot.
            timelineStore.replaceSnapshot(e.entries)
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
        // Build the update on a local copy and assign once at the end: `state`
        // is @Published, so field-by-field writes fired ~40 objectWillChange
        // publishes (each a full SwiftUI invalidation) per state_update.
        var s = state
        // Null-coalescing: only update fields that are present
        s.state = AgentConnectionState(rawValue: e.state) ?? s.state
        if let pm = e.permissionMode { s.permissionMode = PermissionMode(rawValue: pm) ?? s.permissionMode }
        s.agentType = e.agentType ?? s.agentType
        if let sid = e.sessionId { s.sessionId = sid }
        if let focusedSessionId = e.focusedSessionId {
            s.focusedSessionId = focusedSessionId.isEmpty ? nil : focusedSessionId
        }
        s.agentCapabilities = e.agentCapabilities ?? s.agentCapabilities
        s.currentTool = e.currentTool ?? s.currentTool
        s.toolInput = e.toolInput ?? s.toolInput
        s.toolProgress = e.toolProgress ?? s.toolProgress
        s.projectName = e.projectName ?? s.projectName
        s.modelName = e.modelName ?? s.modelName
        s.effortLevel = e.effortLevel ?? s.effortLevel
        if let bt = e.billingType { s.billingType = BillingType(rawValue: bt) ?? s.billingType }
        // A prompt's question and its options are one unit. Retaining options
        // while letting the question change is how a press could aim an index
        // at the previous question's list — the exact failure a multi-question
        // AskUserQuestion produces, since it advances between questions without
        // ever passing through a non-awaiting state. So a changed question
        // replaces the options outright (with an empty list if none came),
        // while a repeat of the same question may still retain them.
        let questionChanged = e.question != nil && e.question != s.question
        if let opts = e.options {
            s.options = opts
        } else if questionChanged {
            s.options = []
        }
        if let pt = e.promptType {
            s.promptType = PromptType(rawValue: pt)
        } else if questionChanged {
            s.promptType = nil
        }
        s.question = e.question ?? s.question
        s.navigable = e.navigable ?? s.navigable
        s.cursorIndex = e.cursorIndex ?? s.cursorIndex
        s.suggestedPrompt = e.suggestedPrompt ?? s.suggestedPrompt
        if let mc = e.modelCatalog { s.modelCatalog = mc }
        s.sessionStatus = e.sessionStatus ?? s.sessionStatus
        s.remoteUrl = e.remoteUrl ?? s.remoteUrl
        s.pairingUrl = e.pairingUrl ?? s.pairingUrl
        s.workerSessionCount = e.workerSessionCount ?? s.workerSessionCount
        if let os = e.ollamaStatus { s.ollamaStatus = os }
        s.mlxModels = e.mlxModels ?? s.mlxModels
        if let subscriptions = e.subscriptions {
            s.subscriptions = subscriptions
        }
        let sawCodexAuthField = e.codexAuthMode != nil
            || e.codexWebAuthConnected != nil
            || e.codexPlanType != nil
            || e.codexAccountId != nil
            || e.codexSubscriptionActiveUntil != nil
            || e.codexLastRefreshAt != nil
        s.codexAuthMode = e.codexAuthMode ?? s.codexAuthMode
        s.codexWebAuthConnected = e.codexWebAuthConnected ?? s.codexWebAuthConnected
        s.codexPlanType = e.codexPlanType ?? s.codexPlanType
        s.codexAccountId = e.codexAccountId ?? s.codexAccountId
        s.codexSubscriptionActiveUntil = e.codexSubscriptionActiveUntil ?? s.codexSubscriptionActiveUntil
        s.codexLastRefreshAt = e.codexLastRefreshAt ?? s.codexLastRefreshAt
        if e.subscriptions == nil {
            reconcileCodexSubscriptionFallback(clearWhenUnavailable: sawCodexAuthField, state: &s)
        }
        s.antigravityStatus = e.antigravityStatus ?? s.antigravityStatus
        s.gatewayAvailable = e.gatewayAvailable ?? s.gatewayAvailable
        s.gatewayConnected = e.gatewayConnected ?? s.gatewayConnected
        s.gatewayHasError = e.gatewayHasError ?? s.gatewayHasError
        if let gatewayAuthStatus = e.gatewayAuthStatus {
            s.gatewayAuthStatus = gatewayAuthStatus
            s.gatewayAuthRequestId = e.gatewayAuthRequestId
            s.gatewayAuthMessage = e.gatewayAuthMessage
        }
        s.gatewayDeviceId = e.gatewayDeviceId ?? s.gatewayDeviceId
        s.daemonPort = e.daemonPort ?? s.daemonPort
        s.mlxModelCatalog = e.mlxModelCatalog ?? s.mlxModelCatalog
        s.voiceAssistantState = e.voiceAssistantState ?? s.voiceAssistantState
        s.voiceAssistantText = e.voiceAssistantText  // null when idle, no fallback
        s.voiceAssistantResponseText = e.voiceAssistantResponseText  // null when idle
        if let mh = e.moduleHealth { s.moduleHealth = mh }

        // OpenClaw Gateway provides its own rich timeline entries via timeline_event.
        // Suppress the StateTimelineGenerator fallback ("Prompt sent" etc.) as soon
        // as the gateway is confirmed connected so the generator doesn't race ahead
        // of the first timeline_event from the adapter.
        if s.gatewayConnected == true {
            timelineGenerator.receivingBridgeTimeline = true
        }

        // Local timeline generation (when bridge doesn't provide rich timeline)
        timelineGenerator.onStateUpdate(
            newState: s.state,
            agentType: e.agentType,
            currentTool: e.currentTool,
            toolInput: e.toolInput,
            question: e.question,
            projectName: e.projectName,
            sessionId: e.sessionId
        )
        timelineVersion += 1

        // Clear tool info on idle
        if s.state == .idle {
            s.currentTool = nil
            s.toolInput = nil
            s.toolProgress = nil
        }

        // Clear options when not awaiting
        if !s.state.isAwaiting {
            s.options = []
            s.question = nil
            s.promptType = nil
        }

        state = s
    }

    // MARK: - Usage Update

    /// Merge an incoming staleness flag over the retained one.
    ///
    /// Usage fields merge retain-on-absent, which turns `usageStale` into a
    /// ONE-WAY LATCH against any producer that omits the key when fresh. The
    /// Node daemon's first frame on client connect is built from a cold usage
    /// cache (`sendInitialState` runs synchronously, before the async fetch
    /// lands) and correctly carries `usageStale: true` — but a producer that
    /// then omits the key can never retract it. Percentages recovered, the
    /// badge did not (macOS Dashboard, 2026-07-25).
    ///
    /// Precedence, strictest first:
    ///   1. An explicit flag always wins. `true` WITH percentages is a real,
    ///      load-bearing state ("had data, now stale") that `handleUsageUpdate`
    ///      relies on to scrub the displayed values — never override it.
    ///   2. No flag but live quota numbers on the frame → data presence IS the
    ///      negative signal. Same inference `d200h-layout.ts` uses for
    ///      `usageKnown`.
    ///   3. Neither flag nor numbers → retain. A partial frame must not
    ///      silently declare freshness.
    static func mergedUsageStale(incoming: Bool?, frameHasQuota: Bool, previous: Bool?) -> Bool? {
        if let incoming { return incoming }
        if frameHasQuota { return false }
        return previous
    }

    private func handleUsageUpdate(_ e: UsageEvent) {
        // Local copy + single assignment — same @Published fan-out rationale as
        // handleStateUpdate.
        var s = state
        s.sessionDurationSec = e.sessionDurationSec ?? s.sessionDurationSec
        s.inputTokens = e.inputTokens ?? s.inputTokens
        s.outputTokens = e.outputTokens ?? s.outputTokens
        s.toolCalls = e.toolCalls ?? s.toolCalls
        s.estimatedCostUsd = e.estimatedCostUsd ?? s.estimatedCostUsd
        s.sessionPercent = e.sessionPercent ?? s.sessionPercent
        s.costSpent = e.costSpent ?? s.costSpent
        s.costLimit = e.costLimit ?? s.costLimit
        s.resetTime = e.resetTime ?? s.resetTime
        s.resetDate = e.resetDate ?? s.resetDate
        // Save previous values for trend indicators before overwriting
        if e.fiveHourPercent != nil { s.previousFiveHourPercent = s.fiveHourPercent }
        if e.sevenDayPercent != nil { s.previousSevenDayPercent = s.sevenDayPercent }
        // When upstream signals stale (no live source could produce a fresh
        // number) clear the displayed values entirely instead of retaining
        // the last-seen ones — a stale number in the UI is the worst of both
        // worlds (looks authoritative, but isn't). Downstream surfaces then
        // naturally collapse their usage regions on nil.
        if e.usageStale == true {
            s.fiveHourPercent = nil
            s.sevenDayPercent = nil
            s.fiveHourResetsAt = nil
            s.sevenDayResetsAt = nil
            s.scopedLimits = nil
        } else {
            s.fiveHourPercent = e.fiveHourPercent ?? s.fiveHourPercent
            s.sevenDayPercent = e.sevenDayPercent ?? s.sevenDayPercent
            s.fiveHourResetsAt = e.fiveHourResetsAt ?? s.fiveHourResetsAt
            s.sevenDayResetsAt = e.sevenDayResetsAt ?? s.sevenDayResetsAt
            // Overwrite (not retain-on-absent): the daemon emits the full scoped
            // set each frame, so an omitted key means "none now" — retaining would
            // latch a phantom cap (CLAUDE.md wire-flag rule).
            s.scopedLimits = e.scopedLimits
        }
        s.extraUsageEnabled = e.extraUsageEnabled ?? s.extraUsageEnabled
        s.extraUsageMonthlyLimit = e.extraUsageMonthlyLimit ?? s.extraUsageMonthlyLimit
        s.extraUsageUsedCredits = e.extraUsageUsedCredits ?? s.extraUsageUsedCredits
        s.extraUsageUtilization = e.extraUsageUtilization ?? s.extraUsageUtilization
        s.oauthConnected = e.oauthConnected ?? s.oauthConnected
        if let os = e.ollamaStatus { s.ollamaStatus = os }
        s.usageStale = Self.mergedUsageStale(
            incoming: e.usageStale,
            frameHasQuota: e.fiveHourPercent != nil || e.sevenDayPercent != nil,
            previous: s.usageStale
        )
        let sawCodexAuthField = e.codexAuthMode != nil
            || e.codexWebAuthConnected != nil
            || e.codexPlanType != nil
            || e.codexAccountId != nil
            || e.codexSubscriptionActiveUntil != nil
            || e.codexLastRefreshAt != nil
        s.codexAuthMode = e.codexAuthMode ?? s.codexAuthMode
        s.codexWebAuthConnected = e.codexWebAuthConnected ?? s.codexWebAuthConnected
        s.codexPlanType = e.codexPlanType ?? s.codexPlanType
        s.codexAccountId = e.codexAccountId ?? s.codexAccountId
        s.codexSubscriptionActiveUntil = e.codexSubscriptionActiveUntil ?? s.codexSubscriptionActiveUntil
        s.codexLastRefreshAt = e.codexLastRefreshAt ?? s.codexLastRefreshAt
        s.codexRateLimits = e.codexRateLimits ?? s.codexRateLimits
        s.modelCatalog = e.modelCatalog ?? s.modelCatalog
        s.mlxModels = e.mlxModels ?? s.mlxModels
        s.mlxModelCatalog = e.mlxModelCatalog ?? s.mlxModelCatalog
        if let subscriptions = e.subscriptions {
            s.subscriptions = subscriptions
        } else {
            reconcileCodexSubscriptionFallback(clearWhenUnavailable: sawCodexAuthField, state: &s)
        }
        s.antigravityStatus = e.antigravityStatus ?? s.antigravityStatus

        s.adminApiKeyPresent = e.adminApiKeyPresent ?? s.adminApiKeyPresent
        s.adminApiTodayInputTokens = e.adminApiTodayInputTokens ?? s.adminApiTodayInputTokens
        s.adminApiTodayOutputTokens = e.adminApiTodayOutputTokens ?? s.adminApiTodayOutputTokens
        s.adminApiTodayCacheReadTokens = e.adminApiTodayCacheReadTokens ?? s.adminApiTodayCacheReadTokens
        s.adminApiTodayCacheCreationTokens = e.adminApiTodayCacheCreationTokens ?? s.adminApiTodayCacheCreationTokens
        s.adminApiMonthInputTokens = e.adminApiMonthInputTokens ?? s.adminApiMonthInputTokens
        s.adminApiMonthOutputTokens = e.adminApiMonthOutputTokens ?? s.adminApiMonthOutputTokens
        s.adminApiMonthCacheReadTokens = e.adminApiMonthCacheReadTokens ?? s.adminApiMonthCacheReadTokens
        s.adminApiMonthCacheCreationTokens = e.adminApiMonthCacheCreationTokens ?? s.adminApiMonthCacheCreationTokens
        s.adminApiTopModels = e.adminApiTopModels ?? s.adminApiTopModels
        s.adminApiFetchedAt = e.adminApiFetchedAt ?? s.adminApiFetchedAt
        s.adminApiStale = e.adminApiStale ?? s.adminApiStale
        state = s
    }

    /// Operates on the caller's local working copy (`inout`) so the batched
    /// single-assignment in handleStateUpdate/handleUsageUpdate stays intact.
    private func reconcileCodexSubscriptionFallback(clearWhenUnavailable: Bool, state s: inout DashboardState) {
        let nonChatGptSubscriptions = s.subscriptions.filter {
            !$0.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("chatgpt")
        }
        guard let name = Self.chatGptSubscriptionName(
            planType: s.codexPlanType,
            authMode: s.codexAuthMode,
            webAuthConnected: s.codexWebAuthConnected,
            until: s.codexSubscriptionActiveUntil
        ) else {
            if clearWhenUnavailable {
                s.subscriptions = nonChatGptSubscriptions
            }
            return
        }

        var subscriptions = nonChatGptSubscriptions
        subscriptions.insert(SubscriptionInfo(name: name, until: s.codexSubscriptionActiveUntil), at: 0)
        s.subscriptions = subscriptions
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
            endForegroundSearch()
            waterfallStage = .idle
            userStoppedConnecting = false

            // Save successful URL for next launch
            if let url = connection.url {
                // Daemon switch (roaming to a different host / different
                // daemon): usage and subscription rows relayed by the old
                // daemon are that host's numbers — purge them so the new
                // daemon's first usage tick repopulates from scratch instead
                // of the UI carrying foreign quota across. Same-URL
                // reconnects (transient blips) keep data to avoid flicker,
                // matching the clearRelayedUsageState() doc contract.
                if let previous = savedUrl, previous != url {
                    clearRelayedUsageState()
                }
                savedUrl = url
            }
        case "disconnected":
            resetToDisconnected()
        default:
            break
        }
    }

    /// Purge Node-daemon-relayed usage/subscription cache. Called on the
    /// external→owner promotion edge so features the sandboxed self-daemon
    /// cannot produce (Claude 5h/7d quota, ChatGPT/Google subscription rows)
    /// stop lingering as a stale trace once this app becomes its own daemon.
    ///
    /// Codex local limits + Antigravity plan name are cleared too, but the
    /// self-daemon RE-EMITS them within one 5s usage tick whenever it has local
    /// file access (a user-granted security-scoped bookmark) — so
    /// self-producible data reappears while only genuinely-Node-only data stays
    /// hidden. Deliberately NOT part of `resetToDisconnected`: that fires on
    /// transient external-daemon blips and would flicker legitimate data.
    func clearRelayedUsageState() {
        state.fiveHourPercent = nil
        state.fiveHourResetsAt = nil
        state.sevenDayPercent = nil
        state.sevenDayResetsAt = nil
        state.usageStale = nil
        state.codexAuthMode = nil
        state.codexPlanType = nil
        state.codexRateLimits = nil
        state.subscriptions = []
        state.antigravityStatus = nil
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

    /// Any connect is fresh intent, so it lifts the suppression an explicit stop
    /// installed — otherwise tapping a discovered bridge after "Stop Reconnecting"
    /// would connect once and then never auto-recover.
    func connectTo(_ bridge: DiscoveredBridge) {
        guard !isTerminating else { return }
        userStoppedConnecting = false
        connection.connect(to: bridge.wsUrl)
    }

    func connectTo(url: String) {
        guard !isTerminating else { return }
        userStoppedConnecting = false
        connection.connect(to: url)
    }

    func setPreferredLocalBridge(url: String?) {
        guard !isTerminating else { return }
        #if DEBUG
        // A launch-argument pin is deliberate and wins over daemon discovery.
        guard !hasLaunchArgumentBridgePin else { return }
        #endif
        preferredLocalBridgeUrl = url
        if let url {
            autoConnectTimer?.invalidate()
            autoConnectTimer = nil
            endForegroundSearch()
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
        // Route through stopConnectionAttempts so the visible indicator, the
        // auto-connect timer, and the late-discovery sink all honour the stop —
        // tearing down only the socket left the overlay claiming a search.
        stopConnectionAttempts()
        resetToDisconnected()
        savedUrl = nil  // Clear saved URL on explicit disconnect
        preferredLocalBridgeUrl = nil  // Prevent auto-reconnect from onDisconnect handler
    }
}
