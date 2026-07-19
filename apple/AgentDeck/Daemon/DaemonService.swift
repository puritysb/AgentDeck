#if os(macOS)
// DaemonService.swift — In-process daemon lifecycle manager
//
// AgentDeck runs in a hybrid architecture:
//
//  - The **terminal-managed daemon** (npm/Homebrew) owns developer-only
//    runtime paths: spawning `claude`/`codex`/`opencode` as PTY children,
//    session registry, file-system integrations (ADB, serial). It cannot be
//    sandboxed, because Apple 2.5.2 forbids that subprocess path for App
//    Store builds.
//
//  - The **Swift app** owns device I/O + message brokering inside the
//    sandbox: Pixoo HTTP streaming, ESP32 serial, iPad/Web pairing WS server,
//    mDNS advertisement, local daemon state cache. D200H is driven solely by
//    the external Ulanzi Studio plugin over WebSocket.
//
// Port 9120 coordination: both processes can listen on 9120. When the CLI
// gets there first, this `DaemonService` catches `alreadyRunning` below and
// switches into `isUsingExternalDaemon = true` — the Swift app becomes a WS
// client of the CLI daemon. When the CLI isn't running, the Swift app binds 9120 itself and
// serves pairing/device I/O with session-count zero (which is the right
// answer: no PTY means no sessions).
//
// That's why the app is useful on its own: it's still a valid pairing
// target for iPads and a device controller for hardware. It just can't
// monitor live Claude Code sessions until the user enables hooks and runs
// Claude Code in their own terminal.
//
// See `docs/daemon.md` for the full role-split table.
import Foundation
import ServiceManagement
import Combine
import IOKit

/// Manages the daemon lifecycle within the main app process.
/// On macOS, starts WS server, mDNS, hook server, etc. as part of the app.
@MainActor
final class DaemonService: ObservableObject {
    @Published private(set) var isRunning = false
    @Published private(set) var isUsingExternalDaemon = false {
        didSet {
            // Promotion edge: was an external-daemon client, now not (becoming
            // owner). Purge Node-relayed usage/subscription cache so features
            // the self-daemon can't produce stop showing as a stale trace. A
            // false→true flip (connecting to a returning external daemon)
            // re-populates naturally, so only true→false clears.
            if oldValue && !isUsingExternalDaemon { onPromotedToOwner?() }
        }
    }

    /// Fired on the external→owner promotion edge (see `isUsingExternalDaemon`
    /// didSet). Wired at the app root to `AgentStateHolder.clearRelayedUsageState()`.
    var onPromotedToOwner: (() -> Void)?

    /// `true` when the in-process Swift daemon is the one bound to port
    /// 9120 (not an external Node daemon). Drives Setup Card messaging —
    /// sandbox quota guidance differs when this Mac app is the active
    /// daemon; if an external terminal-managed daemon is already
    /// running, quota still missing means the daemon-side keychain
    /// read failed, which is a different problem to surface.
    ///
    /// Note: an earlier revision also probed for an `agentdeck` binary
    /// on disk (`cliInstalled`) to differentiate Setup-card copy. That
    /// property was removed because App Review 4.2.3 disallows UI that
    /// varies based on whether a companion executable is installed —
    /// App Store copy stays identical regardless of external state.
    var isSelfDaemon: Bool { isRunning && !isUsingExternalDaemon }
    @Published private(set) var port: UInt16 = 0
    @Published private(set) var connectedClients = 0
    @Published private(set) var errorMessage: String?
    @Published private(set) var deviceSummary = DeviceSummary()

    /// Called when daemon starts — provides ws://localhost:PORT URL for dashboard connection
    var onReady: ((String) -> Void)? {
        didSet {
            if let readyUrl, let onReady {
                onReady(readyUrl)
            }
        }
    }

    private var server: DaemonServer?

    private var isStarting = false
    private var readyUrl: String?
    private var healthMonitorTask: Task<Void, Never>?
    private var externalFailureCount = 0
    private var localFailureCount = 0
    /// Re-entrancy guard for reclaimCanonicalPortIfNeeded — a patient probe
    /// (up to 5s) can outlive one 5s health tick.
    private var isReclaimingPort = false
    /// Takeover-yield deadline. While set and in the future, promotion is
    /// suppressed so an incoming CLI (Node) daemon that asked us to stand down
    /// (POST /stand-down) can bind the canonical port without us racing it back.
    private var yieldUntil: Date?
    private static let takeoverYieldSeconds: TimeInterval = 15
    private var signalSource: DispatchSourceSignal?
    private var sigintSource: DispatchSourceSignal?
    private var listenerFailureRetries = 0
    private var squatterCleanupAttempted = false
    private var fallbackAttempted = false
    private var sessionOverridePort: Int?
    /// Ports that NWListener has observed to fail `.failed(EADDRINUSE)` this
    /// launch. These may still look bindable via raw BSD sockets (NECP is a
    /// higher-level check), so we exclude them explicitly from findAvailablePort.
    private var failedBindPorts: Set<Int> = []
    private static let maxListenerFailureRetries = 3

    /// Human-readable explanation for the last bind failure, shown in Settings.
    /// Set when bind retries are exhausted; cleared on successful start.
    @Published private(set) var bindFailureReason: String?

    /// Processes that may be blocking the daemon port. Populated on bind failure.
    @Published private(set) var blockingProcesses: [BlockingProcess] = []

    /// True while the daemon is running on a fallback port (user's configured
    /// port was held by something we can't terminate). Surface this in the UI.
    @Published private(set) var isOnFallbackPort = false

    /// The port the daemon is attempting to bind. A session-scoped override
    /// (set by auto-fallback when the configured port is stuck) takes
    /// precedence; otherwise falls back to user's Settings value.
    private var effectivePort: Int {
        sessionOverridePort ?? AppPreferences.shared.daemonPort
    }

    nonisolated static func promotionTargetPort(currentPort: UInt16, effectivePort: Int) -> Int {
        let activePort = Int(currentPort)
        return activePort > 0 ? activePort : effectivePort
    }

    nonisolated static func resolvedSessionOverridePort(configuredPort: Int, actualPort: Int) -> Int? {
        actualPort == configuredPort ? nil : actualPort
    }

    /// Whether we should consider ourselves "already moved off the configured
    /// port". Must stay paired with `sessionOverridePort` — see
    /// `syncResolvedPortState`.
    nonisolated static func resolvedFallbackAttempted(configuredPort: Int, actualPort: Int) -> Bool {
        resolvedSessionOverridePort(configuredPort: configuredPort, actualPort: actualPort) != nil
    }

    /// Next port to attempt after a bind failure, or nil to retry the same one.
    ///
    /// Advancing requires knowing we are off the configured port. That used to
    /// be read from `fallbackAttempted` alone, which is only set when *this*
    /// retry path chose a fallback — so a session override recorded by
    /// `syncResolvedPortState` (a previous successful bind or external-daemon
    /// connect on a non-configured port) left the flag false and gated the
    /// branch off. Combined with `onDefault` also being false in that state,
    /// both escape hatches closed and the daemon retried a dead port to
    /// exhaustion while a free one was already known. Deriving it from the
    /// override too closes that hole.
    nonisolated static func advancedFallbackPort(
        attemptedPort: Int,
        sessionOverridePort: Int?,
        fallbackAttempted: Bool,
        availablePort: Int?
    ) -> Int? {
        let offConfiguredPort = fallbackAttempted || (sessionOverridePort != nil)
        guard offConfiguredPort, let next = availablePort, next != attemptedPort else { return nil }
        return next
    }

    init() {
        start()
        setupSignalHandler()
    }

    /// Start daemon in-process
    func start() {
        guard !isRunning, !isUsingExternalDaemon, !isStarting else { return }
        isStarting = true
        errorMessage = nil
        bindFailureReason = nil; blockingProcesses = []

        let port = effectivePort
        Task {
            defer { self.isStarting = false }
            do {
                // Pass nil only when we're binding the default and the user
                // didn't force an override; that preserves the singleton-guard
                // path (health probe + stale registry cleanup). Otherwise we
                // pass an explicit port and skip that path.
                let usingDefault = (port == AppPreferences.defaultDaemonPort && sessionOverridePort == nil)
                let portArg: Int? = usingDefault ? nil : port
                let daemon = try await DaemonServer(port: portArg, debug: false)
                await daemon.setShutdownHandler { [weak self] in
                    Task { @MainActor [weak self] in
                        guard let self else { return }
                        DaemonLogger.shared.info("In-process daemon shutdown completed, transitioning to external daemon...")
                        self.server = nil
                        self.isRunning = false
                        self.port = 0
                        self.readyUrl = nil
                        await self.connectToExternalDaemon()
                    }
                }
                await daemon.setStandDownRequestedHandler { [weak self] in
                    Task { @MainActor in self?.standDownForTakeover() }
                }
                self.server = daemon
                self.port = daemon.port
                self.isRunning = true
                self.isUsingExternalDaemon = false
                self.localFailureCount = 0
                self.externalFailureCount = 0
                self.errorMessage = nil

                // Wire listener-failed callback BEFORE starting — catches POST-bind
                // listener failures (network changes, system-sleep edge cases).
                // Pre-bind/EADDRINUSE now surfaces as a throw from startServices().
                await daemon.setListenerFailedHandler { [weak self] error in
                    Task { @MainActor [weak self] in
                        await self?.handleListenerFailure(error: error)
                    }
                }

                // Run daemon (awaits NWListener `.ready`; throws on bind failure).
                do {
                    try await daemon.startServices()
                } catch {
                    // Bind failed — tear down partial state and route to startup-failure handler.
                    await daemon.shutdown()
                    self.server = nil
                    self.isRunning = false
                    self.port = 0
                    self.readyUrl = nil
                    await self.handleStartupBindFailure(error: error, attemptedPort: Int(daemon.port))
                    return
                }
                self.startHealthMonitor()

                // Notify dashboard to connect to local daemon (listener is actually bound now).
                let wsUrl = "ws://127.0.0.1:\(daemon.port)"
                self.readyUrl = wsUrl
                self.listenerFailureRetries = 0  // reset backoff on success
                self.squatterCleanupAttempted = false
                self.syncResolvedPortState(actualPort: Int(daemon.port))
                DaemonLogger.shared.info("Daemon ready — dashboard can connect to \(wsUrl)")
                self.onReady?(wsUrl)
            } catch DaemonError.alreadyRunning(let port) {
                // Another daemon (e.g. Node.js) is running — connect as client instead
                await self.connectToExternalDaemon(port: port)
            } catch {
                self.server = nil
                self.isRunning = false
                self.isUsingExternalDaemon = false
                self.port = 0
                self.readyUrl = nil
                self.errorMessage = "Daemon failed: \(error.localizedDescription)"
                DaemonLogger.shared.error(self.errorMessage!)
            }
        }
    }

    /// Bounce only the OpenClaw Gateway adapter — leaves the daemon, session
    /// bridges, device modules, and WS server untouched. Use after OpenClaw
    /// Settings changes (token save/clear, pairing identity reset) so Claude
    /// Code / Codex sessions don't briefly disconnect from the daemon.
    func reconnectGatewayAdapter() async {
        guard let server else { return }
        await server.reconnectGatewayAdapter()
    }

    /// Tear down the current daemon (local or external) and start fresh. Used
    /// after the user changes the daemon port in Settings. Clears any
    /// session-scoped fallback so the new user choice is honored exactly.
    func restart() async {
        await stop()
        listenerFailureRetries = 0
        squatterCleanupAttempted = false
        fallbackAttempted = false
        sessionOverridePort = nil
        failedBindPorts.removeAll()
        isOnFallbackPort = false
        bindFailureReason = nil; blockingProcesses = []
        errorMessage = nil
        start()
    }

    /// Stop daemon
    func stop() async {
        healthMonitorTask?.cancel()
        healthMonitorTask = nil
        await server?.shutdown()
        server = nil
        isRunning = false
        isUsingExternalDaemon = false
        port = 0
        readyUrl = nil
    }

    private func connectToExternalDaemon(port knownPort: Int? = nil) async {
        let registry = SessionRegistry.shared
        let resolvedPort = knownPort
            ?? registry.findDaemonPort()
            ?? registry.readDaemonInfo()?.port
            ?? registry.findExistingDaemon()?.port

        guard let resolvedPort else {
            self.server = nil
            self.isRunning = false
            self.isUsingExternalDaemon = false
            self.port = 0
            self.readyUrl = nil
            self.errorMessage = "External daemon detected, but port lookup failed"
            DaemonLogger.shared.error(self.errorMessage!)
            return
        }

        let maxAttempts = knownPort != nil ? 12 : 3
        var health: [String: Any]?
        for attempt in 0..<maxAttempts {
            health = await registry.probeDaemonHealth(port: resolvedPort)
            if health?["mode"] as? String == "daemon" {
                break
            }
            if attempt < maxAttempts - 1 {
                try? await Task.sleep(for: .milliseconds(knownPort != nil ? 300 : 200))
            }
        }

        guard let health, health["mode"] as? String == "daemon" else {
            // External daemon never responded — stale registry. Clean up and start our own.
            DaemonLogger.shared.info("External daemon on port \(resolvedPort) is stale — starting local daemon instead")
            self.server = nil
            self.isRunning = false
            self.isUsingExternalDaemon = false
            self.port = 0
            self.readyUrl = nil
            self.errorMessage = nil
            // Wait briefly for TIME_WAIT clearance then try starting local daemon
            try? await Task.sleep(for: .seconds(1))
            start()
            return
        }

        let wsUrl = "ws://127.0.0.1:\(resolvedPort)"
        self.server = nil
        self.port = UInt16(resolvedPort)
        self.isRunning = false
        self.isUsingExternalDaemon = true
        self.localFailureCount = 0
        self.externalFailureCount = 0
        self.errorMessage = nil
        self.readyUrl = wsUrl
        self.syncResolvedPortState(actualPort: resolvedPort)
        self.startHealthMonitor()
        DaemonLogger.shared.info("External daemon detected on port \(resolvedPort) — connecting as client")
        self.onReady?(wsUrl)
    }

    private func syncResolvedPortState(actualPort: Int) {
        let configuredPort = AppPreferences.shared.daemonPort
        sessionOverridePort = Self.resolvedSessionOverridePort(
            configuredPort: configuredPort,
            actualPort: actualPort
        )
        // Pair the flag with the override. Leaving it false here is what let
        // the retry path stall on a dead fallback port (see
        // `advancedFallbackPort`).
        fallbackAttempted = Self.resolvedFallbackAttempted(
            configuredPort: configuredPort,
            actualPort: actualPort
        )
        isOnFallbackPort = (sessionOverridePort != nil)
        if isOnFallbackPort {
            bindFailureReason = "Daemon moved to fallback port \(actualPort) because \(configuredPort) was held by another process. Clients will rediscover via mDNS."
            if blockingProcesses.isEmpty {
                blockingProcesses = PortDiagnostics.collectBlockers(port: configuredPort)
            }
        } else {
            bindFailureReason = nil; blockingProcesses = []
        }
    }

    /// Called when a running daemon's NWListener enters `.failed` state post-bind
    /// (e.g. network loss after successful bind). Tears down and retries.
    private func handleListenerFailure(error: Error) async {
        guard isRunning else { return }
        // NECP path update failures (error 22) are transient kernel-level noise
        // that occur when NWListener is created/destroyed rapidly (port fallback).
        // They don't affect actual network functionality — ignore them.
        let desc = "\(error)"
        if desc.contains("NECP") || desc.contains("necp") || desc.contains("error 22") {
            DaemonLogger.shared.info("Listener NECP error ignored (non-fatal): \(error)")
            return
        }
        DaemonLogger.shared.error("Listener failure detected — tearing down and retrying: \(error)")
        let attemptedPort = Int(port)
        await server?.shutdown()
        server = nil
        isRunning = false
        isUsingExternalDaemon = false
        port = 0
        readyUrl = nil
        await retryOrFallback(error: error, attemptedPort: attemptedPort)
    }

    /// Called when startup-time NWListener bind fails (e.g. EADDRINUSE). Before
    /// retrying we probe the contested port — if a healthy external daemon owns
    /// it, we transition to client mode instead of spin-retrying forever.
    private func handleStartupBindFailure(error: Error, attemptedPort: Int) async {
        DaemonLogger.shared.error("Daemon listener bind failed: \(error)")
        await retryOrFallback(error: error, attemptedPort: attemptedPort)
    }

    /// Shared failure path: probe for external daemon → connect as client, else
    /// exponential backoff retry (1s/2s/4s, max 3). On retry exhaustion, clear
    /// daemon.json so stale entries don't leak to plugin/TUI clients.
    private func retryOrFallback(error: Error, attemptedPort: Int) async {
        let registry = SessionRegistry.shared
        let probePort = attemptedPort > 0 ? attemptedPort : AppPreferences.shared.daemonPort
        if attemptedPort > 0 { failedBindPorts.insert(attemptedPort) }
        if let health = await registry.probeDaemonHealth(port: probePort),
           health["mode"] as? String == "daemon" {
            DaemonLogger.shared.info("Port \(probePort) held by healthy external daemon — switching to client mode")
            listenerFailureRetries = 0
            squatterCleanupAttempted = false
            await connectToExternalDaemon(port: probePort)
            return
        }

        // Before spending retry budget on the same failing bind, try the one
        // App-Store-safe cleanup we're allowed: forceTerminate same-bundle-ID
        // zombies (crashed/suspended prior instances of this app).
        var squatterCleanupFoundNothing = false
        if !squatterCleanupAttempted {
            squatterCleanupAttempted = true
            let killed = SquatterCleaner.forceTerminateOwnBundleSiblings()
            if killed > 0 {
                DaemonLogger.shared.info("Squatter cleanup terminated \(killed) sibling instance(s); retrying immediately")
                // Short settle so the kernel releases the sockets before rebinding.
                // Scheduling via Task lets the current start()'s Task complete
                // (defer → isStarting=false) before we re-enter.
                Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(500))
                    self?.start()
                }
                return
            }
            squatterCleanupFoundNothing = true
        }

        let userExplicitPort = AppPreferences.shared.daemonPort
        let onDefault = (userExplicitPort == AppPreferences.defaultDaemonPort) && (sessionOverridePort == nil)
        let alt = await registry.findAvailablePort(excluding: failedBindPorts)
        DaemonLogger.shared.info("retryOrFallback diag: userExplicitPort=\(userExplicitPort) onDefault=\(onDefault) fallbackAttempted=\(fallbackAttempted) squatterNothing=\(squatterCleanupFoundNothing) findAvailable=\(alt.map(String.init) ?? "nil") attemptedPort=\(attemptedPort)")

        // If squatter cleanup found no owned siblings AND we're on the default
        // port, the squatter is an external process we can't touch. Retries
        // won't free the port, so jump straight to the fallback port now.
        if onDefault, !fallbackAttempted, squatterCleanupFoundNothing,
           let altPort = alt, altPort != userExplicitPort {
            fallbackAttempted = true
            sessionOverridePort = altPort
            listenerFailureRetries = 0
            squatterCleanupAttempted = false
            DaemonLogger.shared.info("Port \(userExplicitPort) held by external process — falling back to \(altPort) immediately")
            // Show diagnostic panel so user can clean up the squatter.
            blockingProcesses = PortDiagnostics.collectBlockers(port: userExplicitPort)
            bindFailureReason = "Port \(userExplicitPort) is held by another process. Daemon started on fallback port \(altPort). Clean up the blocking process to restore port \(userExplicitPort)."
            isOnFallbackPort = true
            Task { @MainActor [weak self] in self?.start() }
            return
        }

        // If the attempted port also failed, try the next available port
        // before burning a retry. Without this, retries repeatedly hit the
        // same blocked port (e.g., 9122 held by zombie node) instead of
        // advancing to 9123, 9124, etc.
        if let nextPort = Self.advancedFallbackPort(
            attemptedPort: attemptedPort,
            sessionOverridePort: sessionOverridePort,
            fallbackAttempted: fallbackAttempted,
            availablePort: alt
        ) {
            sessionOverridePort = nextPort
            fallbackAttempted = true
            DaemonLogger.shared.info("Advancing fallback port \(attemptedPort) → \(nextPort)")
        }

        listenerFailureRetries += 1
        guard listenerFailureRetries <= Self.maxListenerFailureRetries else {
            // Retry budget exhausted. Try fallback port one more time (handles
            // the case where user-configured port or retry-loop scenarios
            // didn't match the fast-path above).
            if onDefault, !fallbackAttempted,
               let alt = await registry.findAvailablePort(excluding: failedBindPorts), alt != userExplicitPort {
                fallbackAttempted = true
                sessionOverridePort = alt
                listenerFailureRetries = 0
                squatterCleanupAttempted = false
                DaemonLogger.shared.info("Port \(userExplicitPort) stuck after retries — falling back to \(alt)")
                Task { @MainActor [weak self] in self?.start() }
                return
            }

            let stuckPort = probePort
            let reason: String
            if fallbackAttempted || !onDefault {
                reason = "Port \(stuckPort) is held by another process. " +
                    "Use Clean Up & Retry for stale AgentDeck windows, quit " +
                    "the listed external process from its owning app, or " +
                    "change the daemon port in Settings."
            } else {
                reason = "All ports in range are busy. Close other agentdeck " +
                    "instances or change the port in Settings."
            }
            errorMessage = "Daemon failed to bind: \(error.localizedDescription)"
            bindFailureReason = reason
            blockingProcesses = PortDiagnostics.collectBlockers(port: stuckPort)
            DaemonLogger.shared.error("\(errorMessage!) — \(reason)")
            listenerFailureRetries = 0
            squatterCleanupAttempted = false
            // Don't leave a stale daemon.json pointing at a port we never actually owned.
            registry.removeDaemonInfo()
            return
        }

        // Exponential backoff: 1s, 2s, 4s — lets kernel release stale TCP sockets
        let backoffSec = UInt64(1 << (listenerFailureRetries - 1))
        DaemonLogger.shared.info("Retrying daemon start in \(backoffSec)s (attempt \(listenerFailureRetries)/\(Self.maxListenerFailureRetries))")
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(backoffSec))
            self?.start()
        }
    }

    private func startHealthMonitor() {
        healthMonitorTask?.cancel()
        healthMonitorTask = Task { [weak self] in
            guard let self else { return }
            // Populate the menu bar devices section before the first 5s tick —
            // avoids a "flash of empty state" when the user opens the dropdown
            // immediately after app launch.
            await self.refreshDeviceSummary()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                await self.checkDaemonHealth()
                await self.refreshDeviceSummary()
            }
        }
    }

    private func checkDaemonHealth() async {
        let currentPort = Int(port)
        guard currentPort > 0 else { return }

        let registry = SessionRegistry.shared

        if isUsingExternalDaemon {
            // Patient probe + 3-miss threshold: the Node daemon can stall its
            // single-threaded event loop past 2s under load (sync SQLite, hook
            // bursts) and a plain dev restart takes a few seconds — neither
            // should promote a rival hub. A false promotion is expensive: every
            // hub flip flaps serial/Pixoo ownership. Worst-case failover for a
            // genuinely dead daemon is ~30s, fine for a passive fallback.
            let health = await registry.probeDaemonHealth(port: currentPort, patient: true)
            let daemonAlive = (health?["mode"] as? String) == "daemon"
            if daemonAlive {
                externalFailureCount = 0
                return
            }

            externalFailureCount += 1
            guard externalFailureCount >= 3, !isStarting else { return }
            // Takeover-yield window: a CLI daemon asked us to stand down and is
            // about to bind the canonical port. Don't promote back into the gap.
            if let yieldUntil, Date() < yieldUntil {
                DaemonLogger.shared.info("In takeover-yield window — deferring promotion to let the CLI daemon bind")
                return
            }
            // Promotion guard for the `daemon restart` (stop→start) window. A
            // missed health probe does NOT prove the port is free — during a
            // restart the successor rebinds within a beat, so the port stays
            // held by SOMEONE the whole time. Promoting into that window makes
            // us bind a FALLBACK port (9121), rewrite daemon.json to it, then
            // immediately reclaim/demote once 9120 answers again — a thrash
            // that (a) clobbers daemon.json out from under other clients and
            // (b) leaves this app's own client connection stuck reconnecting.
            // If the canonical port is still held, the owner is almost
            // certainly just restarting: stay in client mode and keep probing
            // so we reattach cleanly the moment it answers. Only a genuinely
            // dead daemon frees the port → isPortBindable → real promotion.
            let canonical = AppPreferences.shared.daemonPort
            if currentPort == canonical, !(await registry.isPortBindable(canonical)) {
                DaemonLogger.shared.info("External daemon on \(currentPort) missed probe but port still held — owner likely restarting; staying in client mode")
                return
            }
            DaemonLogger.shared.error("External daemon on port \(currentPort) disappeared — promoting this app to own the daemon")
            server = nil
            isRunning = false
            isUsingExternalDaemon = false
            port = 0
            readyUrl = nil
            errorMessage = nil
            externalFailureCount = 0
            start()
            return
        }

        // In-process daemon: trust in-memory state. Self-HTTP probing created a
        // restart loop when URLSession got bogged down by dead sibling relays or
        // slow Pixoo pushes — a transient 2-second self-probe timeout was killing
        // a perfectly healthy server. If we hold a live `server` reference and
        // `isRunning`, the listener is up; no probe is needed for liveness.
        guard isRunning, server != nil else { return }
        localFailureCount = 0
        await reclaimCanonicalPortIfNeeded()
    }

    /// While this hub runs on a fallback port, watch the canonical (configured)
    /// port every health tick. A hub stranded on 9121 is invisible to clients
    /// that resolve the canonical port, and running there next to a returning
    /// sibling daemon flaps serial/Pixoo ownership. Two exits:
    ///   - a healthy daemon owns the canonical port again → stand down to
    ///     client mode (no rival hub, no eviction round-trip needed)
    ///   - the canonical port became free → rebind onto it immediately
    private func reclaimCanonicalPortIfNeeded() async {
        guard isOnFallbackPort, !isStarting, !isReclaimingPort,
              isRunning, let current = server else { return }
        let canonical = AppPreferences.shared.daemonPort
        guard Int(port) != canonical else { return }
        isReclaimingPort = true
        defer { isReclaimingPort = false }

        let registry = SessionRegistry.shared
        if let health = await registry.probeDaemonHealth(port: canonical, patient: true),
           (health["mode"] as? String) == "daemon" {
            DaemonLogger.shared.info("Healthy daemon reappeared on canonical port \(canonical) — standing down fallback-port hub (\(port)) to client mode")
            await standDownServer(current)
            await connectToExternalDaemon(port: canonical)
            return
        }
        guard await registry.isPortBindable(canonical) else { return }
        DaemonLogger.shared.info("Canonical port \(canonical) is free — reclaiming it from fallback port \(port)")
        await standDownServer(current)
        start()
    }

    /// Yield the canonical port to an incoming CLI (Node) daemon that requested
    /// takeover via `POST /stand-down`. Completes the two-tier upgrade path in
    /// the reverse startup order (app-first, then `agentdeck daemon start`):
    /// without this the Node daemon sees our `/health` (`mode: daemon`) and
    /// exits "already running", so the user never gets the full CLI feature set.
    ///
    /// Sets a yield window (suppresses promotion so we don't re-grab the port in
    /// the gap), tears down the in-process server, then connects as a client to
    /// the canonical port — the patient probe in `connectToExternalDaemon` waits
    /// for the CLI to bind. If the CLI never appears (crash), normal promotion
    /// resumes after the window: we won't be left daemonless.
    func standDownForTakeover() {
        guard isSelfDaemon, let current = server else {
            DaemonLogger.shared.info("Stand-down requested but this app is not the in-process daemon owner — ignoring")
            return
        }
        let canonical = AppPreferences.shared.daemonPort
        DaemonLogger.shared.info("Stand-down requested by CLI daemon — yielding port \(port), becoming a client of \(canonical)")
        yieldUntil = Date().addingTimeInterval(Self.takeoverYieldSeconds)
        Task { @MainActor in
            await standDownServer(current)
            await connectToExternalDaemon(port: canonical)
        }
    }

    /// Tear down the in-process server for a deliberate state transition,
    /// clearing the fallback-port bookkeeping so the next start()/client
    /// connect targets the canonical port. Suppresses the server's onShutdown
    /// callback — that path auto-transitions to external-daemon mode, and the
    /// caller here chooses the next state itself.
    private func standDownServer(_ current: DaemonServer) async {
        await current.setShutdownHandler(nil)
        server = nil
        isRunning = false
        port = 0
        readyUrl = nil
        sessionOverridePort = nil
        fallbackAttempted = false
        failedBindPorts.removeAll()
        isOnFallbackPort = false
        bindFailureReason = nil
        blockingProcesses = []
        await current.shutdown()
    }

    // MARK: - Signal Handling

    private func setupSignalHandler() {
        // Ignore default SIGTERM/SIGINT behavior so DispatchSource handles them
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)

        let termSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        termSource.setEventHandler { [weak self] in
            Self.handleTerminationSignal(name: "SIGTERM", service: self)
        }
        termSource.resume()
        self.signalSource = termSource

        let intSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        intSource.setEventHandler { [weak self] in
            Self.handleTerminationSignal(name: "SIGINT", service: self)
        }
        intSource.resume()
        self.sigintSource = intSource
    }

    private static func handleTerminationSignal(name: String, service: DaemonService?) {
        DaemonLogger.shared.info("\(name) received — initiating clean shutdown")
        // Remove daemon.json immediately so next launch isn't blocked by stale guard
        let daemonFile = AgentDeckPaths.daemonJson
        try? FileManager.default.removeItem(at: daemonFile)
        let crashLog = AgentDeckPaths.daemonCrashLog
        let entry = "[\(ISO8601DateFormatter().string(from: Date()))] \(name) — clean shutdown initiated\n"
        if let data = entry.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: crashLog.path) {
                if let handle = try? FileHandle(forWritingTo: crashLog) {
                    handle.seekToEndOfFile()
                    handle.write(data)
                    handle.closeFile()
                }
            } else {
                try? data.write(to: crashLog)
            }
        }
        // Bounded shutdown: exit after 5s even if cleanup hangs
        DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
            NSLog("[AgentDeck] Signal shutdown timeout — forcing exit")
            Darwin.exit(0)
        }
        Task { @MainActor in
            await service?.stop()
            Darwin.exit(0)
        }
    }

    // MARK: - Login Item (auto-start at login)

    func registerLoginItem() {
        if #available(macOS 13.0, *) {
            let service = SMAppService.mainApp
            do {
                try service.register()
                DaemonLogger.shared.info("Registered as login item")
            } catch {
                DaemonLogger.shared.error("Failed to register login item: \(error)")
            }
        }
    }

    func unregisterLoginItem() {
        if #available(macOS 13.0, *) {
            let service = SMAppService.mainApp
            do {
                try service.unregister()
            } catch {
                DaemonLogger.shared.error("Failed to unregister login item: \(error)")
            }
        }
    }

    var isLoginItemEnabled: Bool {
        if #available(macOS 13.0, *) {
            return SMAppService.mainApp.status == .enabled
        }
        return false
    }

    // MARK: - Device Summary Refresh

    /// Refresh the published `deviceSummary` from the running daemon's
    /// in-process module snapshots. Called on each health-monitor tick.
    /// Zero network — snapshots come straight from the module actors.
    func refreshDeviceSummary() async {
        guard let server else {
            if isUsingExternalDaemon, port > 0,
               let health = await SessionRegistry.shared.probeDaemonHealth(port: Int(port)),
               let modules = health["modules"] as? [String: Any] {
                let summary = DeviceSummary.make(fromModuleHealth: modules)
                if summary != deviceSummary {
                    deviceSummary = summary
                }
                return
            }
            if !deviceSummary.isEmpty { deviceSummary = DeviceSummary() }
            return
        }
        var summary = DeviceSummary()

        // D200H (Ulanzi Studio plugin presence)
        // One hop to the daemon's executor for all four — see
        // DaemonServer.deviceStatusSnapshots().
        let snapshots = await server.deviceStatusSnapshots()

        if let d200h = snapshots.d200h {
            summary.d200h = DeviceSummary.makeD200hEntry(from: d200h)
        }

        // Pixoo (LED panels over HTTP)
        if let pixoo = snapshots.pixoo {
            summary.pixoo = DeviceSummary.makePixooEntries(from: pixoo)
        }

        // ESP32 serial boards
        if let serial = snapshots.serial {
            summary.serial = DeviceSummary.makeSerialEntries(from: serial)
        }

        // ADB (Android devices)
        if let adb = snapshots.adb {
            summary.adb = DeviceSummary.makeAdbEntries(from: adb)
        }

        if summary != deviceSummary {
            deviceSummary = summary
        }
    }
}

// MARK: - DeviceSummary

struct DeviceSummary: Equatable {
    var d200h: DeviceEntry?
    var pixoo: [DeviceEntry] = []
    var serial: [DeviceEntry] = []
    var adb: [DeviceEntry] = []

    var isEmpty: Bool {
        d200h == nil && pixoo.isEmpty && serial.isEmpty && adb.isEmpty
    }

    var allEntries: [DeviceEntry] {
        var out: [DeviceEntry] = []
        if let d200h { out.append(d200h) }
        out.append(contentsOf: pixoo)
        out.append(contentsOf: serial)
        out.append(contentsOf: adb)
        return out
    }

    static func make(fromModuleHealth modules: [String: Any]) -> DeviceSummary {
        var summary = DeviceSummary()
        if let d200h = modules["d200h"] as? [String: Any] {
            summary.d200h = makeD200hEntry(from: d200h)
        }
        if let pixoo = modules["pixoo"] as? [String: Any] {
            summary.pixoo = makePixooEntries(from: pixoo)
        }
        if let serial = modules["serial"] as? [String: Any] {
            summary.serial = makeSerialEntries(from: serial)
        }
        if let adb = modules["adb"] as? [String: Any] {
            summary.adb = makeAdbEntries(from: adb)
        }
        return summary
    }

    // MARK: Builders (each converts the `[String: Any]` module snapshot
    // into a typed DeviceEntry for the menu bar). Filters out modules that
    // aren't actually attached (e.g. zero-Pixoo installs) so empty hardware
    // pools don't show up as ghost rows.

    static func makeD200hEntry(from d: [String: Any]) -> DeviceEntry {
        let connected = d["connected"] as? Bool ?? false

        let status: DeviceStatus
        var subtitle: String?
        if connected {
            status = .connected
            subtitle = "via Ulanzi Studio"
        } else {
            // Defensive only: both daemons omit the `d200h` key entirely while
            // the plugin is disconnected, so this entry is never built.
            status = .idle
            subtitle = "plugin disconnected"
        }
        return DeviceEntry(
            id: "d200h",
            kind: .d200h,
            title: "D200H",
            subtitle: subtitle,
            status: status
        )
    }

    static func makePixooEntries(from d: [String: Any]) -> [DeviceEntry] {
        let ips = d["deviceIps"] as? [String] ?? []
        let hasFrame = d["hasFrame"] as? Bool ?? false
        let dimmed = d["displayDimmed"] as? Bool ?? false
        let lastError = d["lastPushError"] as? String
        let deviceRows = d["devices"] as? [[String: Any]] ?? []
        return ips.enumerated().map { idx, ip in
            let row = deviceRows.first { $0["ip"] as? String == ip }
            let failures = row?["failures"] as? Int ?? 0
            let backedOff = row?["backedOff"] as? Bool ?? false
            let online = row?["online"] as? Bool ?? true
            let status: DeviceStatus
            let subtitle: String
            if backedOff || !online {
                status = .error("backed off")
                subtitle = "\(ip) · retry paused"
            } else if let lastError, !lastError.isEmpty {
                status = .reconnecting
                subtitle = failures > 0 ? "\(ip) · retrying (\(failures))" : "\(ip) · retrying"
            } else if hasFrame {
                status = .connected
                subtitle = dimmed ? "\(ip) · dimmed" : "streaming · \(ip)"
            } else {
                status = .reconnecting
                subtitle = "\(ip) · warming up"
            }
            return DeviceEntry(
                id: "pixoo-\(ip)",
                kind: .pixoo,
                title: "Pixoo \(idx + 1)",
                subtitle: subtitle,
                status: status
            )
        }
    }

    static func makeSerialEntries(from d: [String: Any]) -> [DeviceEntry] {
        let conns = d["connections"] as? [[String: Any]] ?? []
        let globalOpenErr = (d["lastOpenError"] as? String) ?? (d["lastError"] as? String)
        return conns.compactMap { conn in
            let port = conn["port"] as? String ?? "?"
            let connected = conn["connected"] as? Bool ?? false
            let info = conn["deviceInfo"] as? [String: Any]
            let board = info?["board"] as? String
            let version = info?["version"] as? String
            let wifiConnected = info?["wifiConnected"] as? Bool ?? false

            let title = board.map { "ESP32 \($0)" } ?? "ESP32 (\(port))"
            var subtitleBits: [String] = []
            if let version { subtitleBits.append("v\(version)") }
            subtitleBits.append(wifiConnected ? "wifi" : "no-wifi")
            subtitleBits.append(port)

            let status: DeviceStatus
            if connected {
                status = .connected
            } else if let globalOpenErr, !globalOpenErr.isEmpty {
                status = .error(globalOpenErr)
            } else {
                status = .reconnecting
            }
            return DeviceEntry(
                id: "serial-\(port)",
                kind: .serial,
                title: title,
                subtitle: subtitleBits.joined(separator: " · "),
                status: status
            )
        }
    }

    static func makeAdbEntries(from d: [String: Any]) -> [DeviceEntry] {
        let available = d["available"] as? Bool ?? false
        let devices = d["devices"] as? [String] ?? []
        let readyCount = d["reverseReadyCount"] as? Int ?? 0
        let lastError = d["lastError"] as? String
        if !available || devices.isEmpty { return [] }
        return devices.enumerated().map { idx, serial in
            let reverseReady = idx < readyCount
            let status: DeviceStatus
            if reverseReady {
                status = .connected
            } else if let lastError, !lastError.isEmpty {
                status = .error(lastError)
            } else {
                status = .reconnecting
            }
            return DeviceEntry(
                id: "adb-\(serial)",
                kind: .adb,
                title: "Android",
                subtitle: serial,
                status: status
            )
        }
    }
}

struct DeviceEntry: Identifiable, Equatable {
    let id: String
    let kind: DeviceKind
    let title: String
    let subtitle: String?
    let status: DeviceStatus
}

enum DeviceKind: Equatable {
    case d200h
    case pixoo
    case serial
    case adb

    var symbolName: String {
        switch self {
        case .d200h:  return "keyboard"
        case .pixoo:  return "square.grid.3x3.fill"
        case .serial: return "cpu"
        case .adb:    return "iphone"
        }
    }
}

enum DeviceStatus: Equatable {
    case connected
    case reconnecting
    case idle
    case error(String)

    var dotColor: String {  // keyed name; resolved to SwiftUI Color at render time
        switch self {
        case .connected:    return "green"
        case .reconnecting: return "orange"
        case .idle:         return "gray"
        case .error:        return "red"
        }
    }

    var shortLabel: String {
        switch self {
        case .connected:      return "connected"
        case .reconnecting:   return "reconnecting"
        case .idle:           return "idle"
        case .error(let msg): return msg
        }
    }
}
#endif
