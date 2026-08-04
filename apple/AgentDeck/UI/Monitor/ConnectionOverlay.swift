// ConnectionOverlay.swift — Discovery + manual connect UI

import SwiftUI

/// Connection-state lexicon — Swift mirror of shared/src/connection-status.ts.
/// Self-connecting clients (this app, Android, ESP32) surface the phase they
/// are actually in; update the TS SSOT and all mirrors together when copy changes.
enum ConnectionLexicon {
    static let searching = "Searching for AgentDeck..."
    static let connecting = "Connecting..."
    static let reconnecting = "Reconnecting..."
    static let searchAgain = "Search Again"
    static let nothingDiscovered = "No AgentDeck found on this network"
}

/// User-visible phase of the connection overlay.
///
/// `BridgeDiscovery.isSearching` means the long-lived Bonjour browser is ready,
/// not that a bounded foreground search is still in progress. Keeping those two
/// meanings separate prevents a healthy passive browser from rendering as an
/// activity indicator that spins forever when no Mac is present.
enum ConnectionOverlayPhase: Equatable {
    case localNetworkDenied
    case reconnecting
    case connecting
    case searching
    case notFound

    /// - Parameters:
    ///   - hasStartedForegroundSearch: false only in the window between the
    ///     overlay's first render and `ContentView.onAppear` starting the
    ///     waterfall. Without it that frame resolves to `.notFound` and flashes a
    ///     failure state before any search has run. This is safe to render as
    ///     `.searching` because the overlay only exists inside `ContentView`,
    ///     whose `onAppear` starts the waterfall in the same appearance cycle —
    ///     and the state holder defaults it to `true` on platforms that do not
    ///     drive the waterfall from a view appearance.
    ///   - isAutoConnecting: a **bounded** foreground attempt, deadline-backed in
    ///     `AgentStateHolder`. Never pass `BridgeDiscovery.isSearching` here: it
    ///     reports the long-lived Bonjour browser, which by design never stops.
    static func resolve(
        localNetworkDenied: Bool,
        isReconnecting: Bool,
        isConnecting: Bool,
        isAutoConnecting: Bool,
        hasStartedForegroundSearch: Bool = true
    ) -> Self {
        if localNetworkDenied { return .localNetworkDenied }
        if isReconnecting { return .reconnecting }
        if isConnecting { return .connecting }
        if isAutoConnecting { return .searching }
        if !hasStartedForegroundSearch { return .searching }
        return .notFound
    }

    var statusText: String {
        switch self {
        case .localNetworkDenied: return "Local Network access required"
        case .reconnecting:       return ConnectionLexicon.reconnecting
        case .connecting:         return ConnectionLexicon.connecting
        case .searching:          return ConnectionLexicon.searching
        case .notFound:           return ConnectionLexicon.nothingDiscovered
        }
    }

    var showsActivityIndicator: Bool {
        self == .searching || self == .connecting
    }
}

struct ConnectionOverlay: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    @State private var manualUrl = ""
    @State private var showManualEntry = false
    #if os(iOS)
    @State private var showDevicePreview = false
    #endif

    // Explicit slate color matching Android SlateText #94A3B8
    // (.secondary is too dim on dark card backgrounds, especially iPad)
    private let slateText = Color(red: 0.58, green: 0.64, blue: 0.72)

    private var isReconnecting: Bool { stateHolder.connection.isReconnecting }
    private var phase: ConnectionOverlayPhase {
        .resolve(
            localNetworkDenied: stateHolder.discovery.localNetworkDenied,
            isReconnecting: isReconnecting,
            isConnecting: stateHolder.connection.status == .connecting,
            isAutoConnecting: stateHolder.isAutoConnecting,
            hasStartedForegroundSearch: stateHolder.hasStartedForegroundSearch
        )
    }

    var body: some View {
        // Scrim + centered card
        ZStack {
            Color(red: 0.059, green: 0.086, blue: 0.157)
                .opacity(0.8)
                .ignoresSafeArea()

            GeometryReader { geo in
                ScrollView {
                    VStack(spacing: 0) {
                        Spacer(minLength: 0)
                        VStack(spacing: 16) {
                    // Brand icon + title
                    AgentDeckLogo(size: 80, color: TerrariumHUD.tetraNeon)

                    Text("AgentDeck")
                        .font(.title.bold())
                        .foregroundStyle(.white)

                    // Status subtitle — matches Android logic
                    Text(phase.statusText)
                        .font(.subheadline)
                        .foregroundStyle(slateText)

                    // Local Network permission denied — the browser can never find the
                    // daemon until the user enables it, so guide them there directly
                    // instead of spinning on "Searching…" forever.
                    if stateHolder.discovery.localNetworkDenied {
                        localNetworkDeniedCard
                    }

                    // Reconnecting details (stop button only)
                    if isReconnecting {
                        Button {
                            // Not `connection.disconnect()` — that stops the socket
                            // but leaves the waterfall mid-stage, which renders as a
                            // search with no work behind it and no way back.
                            stateHolder.stopConnectionAttempts()
                        } label: {
                            Text("Stop Reconnecting")
                                .font(.subheadline)
                                .foregroundStyle(slateText)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 8)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(slateText.opacity(0.4), lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }

                    // Connection error from the last attempted URL.
                    if let error = stateHolder.connection.lastError,
                       stateHolder.connection.status == .disconnected {
                        Text(error)
                            .font(.caption)
                            .monospaced()
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)

                    }

                    // Connection options (disconnected or reconnecting with WiFi alternatives)
                    if stateHolder.connection.status == .disconnected || isReconnecting {

                        // mDNS discovered bridges — show daemon only
                        // (session bridges don't serve external clients)
                        let daemonBridges = stateHolder.discovery.bridges.filter { $0.agentType == "daemon" }
                        if !daemonBridges.isEmpty {
                            VStack(spacing: 8) {
                                Text(isReconnecting ? "Or connect via WiFi:" : "Discovered")
                                    .font(.caption.bold())
                                    .foregroundStyle(slateText)
                                ForEach(daemonBridges) { bridge in
                                    bridgeRow(bridge, isLocal: false)
                                }
                            }
                        } else if !isReconnecting {
                            // The Bonjour browser intentionally remains alive so a Mac
                            // appearing later can reconnect. Only the bounded foreground
                            // attempt gets a progress indicator.
                            if phase.showsActivityIndicator {
                                ProgressView()
                                    .tint(.cyan)
                            }

                            if phase == .notFound {
                                noMacRecovery
                            }
                        }
                    }

                    // Manual entry — toggle to expand inline TextField
                    if showManualEntry {
                        HStack {
                            TextField("ws://192.168.1.x:9120", text: $manualUrl)
                                .textFieldStyle(.roundedBorder)
                                #if os(iOS)
                                .autocapitalization(.none)
                                .keyboardType(.URL)
                                #endif

                            Button("Connect") {
                                guard !manualUrl.isEmpty else { return }
                                stateHolder.connectTo(url: manualUrl)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(.cyan)
                        }
                    }

                    Button(showManualEntry ? "Hide" : "Enter URL Manually") {
                        showManualEntry.toggle()
                    }
                    .font(.caption)
                    .foregroundStyle(slateText.opacity(0.7))
                }
                .padding(24)
                .frame(maxWidth: 360)
                .background(
                    RoundedRectangle(cornerRadius: 16)
                        .fill(Color(red: 0.118, green: 0.161, blue: 0.231).opacity(0.9))
                )
                        Spacer(minLength: 0)
                    }
                    .frame(maxWidth: .infinity, minHeight: geo.size.height)
                }
                .scrollIndicators(.hidden)
            }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $showDevicePreview) {
            NavigationStack {
                DevicePreviewScreen()
                    .navigationTitle("Explore AgentDeck")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { showDevicePreview = false }
                        }
                    }
            }
            .environmentObject(stateHolder)
            .environmentObject(preferences)
        }
        #endif
    }

    // MARK: - Helpers

    /// Shown when iOS Local Network permission is denied — the #1 reason a fresh
    /// install "won't connect." Points the user straight at the toggle.
    private var localNetworkDeniedCard: some View {
        VStack(spacing: 10) {
            Image(systemName: "wifi.exclamationmark")
                .font(.title2)
                .foregroundStyle(.yellow)
            Text("Local Network access is off")
                .font(.subheadline.bold())
                .foregroundStyle(.white)
            Text("AgentDeck needs Local Network permission to find the daemon on your Wi-Fi. Turn it on, then come back here.")
                .font(.caption)
                .foregroundStyle(slateText)
                .multilineTextAlignment(.center)
            #if os(iOS)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Open Settings")
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(.yellow.opacity(0.25), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(.yellow.opacity(0.6), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
            #else
            Text("Enable it in System Settings → Privacy & Security → Local Network → AgentDeck.")
                .font(.caption2)
                .foregroundStyle(slateText.opacity(0.7))
                .multilineTextAlignment(.center)
            #endif
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 12).fill(.yellow.opacity(0.08)))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(.yellow.opacity(0.3), lineWidth: 1)
        )
    }

    private var noMacRecovery: some View {
        VStack(spacing: 10) {
            Text("Check that your Mac is online and on the same Wi-Fi.")
                .font(.caption)
                .foregroundStyle(slateText.opacity(0.8))
                .multilineTextAlignment(.center)

            Button {
                // `retry` rather than `start`: the plain entry point no-ops when a
                // stage is left over, which turns this into a dead button.
                stateHolder.retryConnectionWaterfall()
            } label: {
                Text(ConnectionLexicon.searchAgain)
                    .font(.subheadline.bold())
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                    .background(.cyan.opacity(0.3), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(.cyan.opacity(0.5), lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)

            #if os(iOS)
            Button {
                showDevicePreview = true
            } label: {
                Label("Explore without a Mac", systemImage: "rectangle.3.group")
                    .font(.subheadline.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.bordered)
            .tint(.cyan)
            #endif
        }
    }

    private func bridgeRow(_ bridge: DiscoveredBridge, isLocal: Bool) -> some View {
        Button {
            stateHolder.connectTo(bridge)
        } label: {
            HStack {
                VStack(alignment: .leading) {
                    Text(bridge.project ?? bridge.name)
                        .font(.headline)
                        .foregroundStyle(.white)
                    Text(verbatim: "\(bridge.host):\(bridge.port)")
                        .font(.caption)
                        .monospaced()
                        .foregroundStyle(slateText)
                }
                Spacer()
                if isLocal {
                    Text("local")
                        .font(.caption2)
                        .foregroundStyle(.green)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.green.opacity(0.2), in: Capsule())
                }
                if let agent = bridge.agentType {
                    Text(agent)
                        .font(.caption2)
                        .foregroundStyle(.cyan)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.blue.opacity(0.2), in: Capsule())
                }
                Image(systemName: "arrow.right.circle.fill")
                    .foregroundStyle(.cyan)
            }
            .padding()
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.white.opacity(0.08))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(slateText.opacity(0.3), lineWidth: 1)
                    )
            )
        }
        .buttonStyle(.plain)
    }
}
