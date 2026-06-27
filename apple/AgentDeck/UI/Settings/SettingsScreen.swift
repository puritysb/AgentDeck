// SettingsScreen.swift — Settings dialog (matches Android TabletSettingsDialog.kt)

import SwiftUI

struct SettingsScreen: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    #if os(macOS)
    @EnvironmentObject private var daemonService: DaemonService
    #endif
    @Environment(\.dismiss) private var dismiss
    @State private var manualUrl = ""
    @State private var showRemoveAntigravityConfirm = false
    @State private var openClawGatewayTokenInput: String = ""
    @State private var openClawGatewayTokenSaved: Bool = false
    @State private var openClawGatewayTokenError: String?
    @State private var openClawIdentityResetMessage: String?
    @State private var openClawIdentityResetSucceeded: Bool = false
    @State private var anthropicAdminApiKeyInput: String = ""
    @State private var anthropicAdminApiKeySaved: Bool = false
    @State private var anthropicAdminApiKeyError: String?
    #if os(macOS)
    @State private var portInput: String = ""
    /// Which section is visible in the macOS NavigationSplitView detail.
    /// Default lands on Integrations so first-run users see the actions
    /// that actually unblock quota / OpenClaw / hooks, not an "Advanced"
    /// section that's mostly informational.
    @State private var selectedSection: SettingsSection = .integrations
    /// Whether the Advanced group in the sidebar is expanded. Collapsed
    /// by default so the first read is only 4 rows (Integrations, Dashboard,
    /// About, Advanced ►).
    @State private var advancedExpanded: Bool = true
    /// Live slider value for the display-sleep dim level. Committed to
    /// `preferences.displaySleepDimLevel` only when the drag ends so we don't
    /// rewrite settings.json + re-broadcast a brightness command on every tick.
    @State private var dimLevelDraft: Double = 10
    #endif
    #if os(iOS)
    /// iOS QR pairing scanner modal presentation flag.
    @State private var showQRScanner: Bool = false
    /// User-facing error message shown below the Scan QR button when a
    /// scanned payload isn't a valid AgentDeck pairing URL.
    @State private var scanError: String?
    #endif

    var body: some View {
        #if os(macOS)
        macOSSettings
        #else
        iOSSettings
        #endif
    }

    // MARK: - iOS (matches Android TabletSettingsDialog)

    private var iOSSettings: some View {
        ZStack {
            // Semi-transparent background
            Color.black.opacity(0.4)
                .ignoresSafeArea()
                .onTapGesture { dismiss() }

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Title
                    Text("Settings")
                        .font(.title2.bold())
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, alignment: .center)

                    // ─────── Essentials ───────
                    // Card order is tuned for the iOS client mental model:
                    // pairing/connection comes first because nothing else
                    // works until this device finds the Mac. Mac-side
                    // integrations and display panels follow.
                    settingsCard(
                        title: "Connection",
                        subtitle: "How this device pairs with your Mac. mDNS auto-discovery + manual URL + QR scan."
                    ) {
                        connectionContent
                    }

                    // Mac-side integrations are read-only on iOS — surface
                    // them so the user sees what's wired up on their Mac,
                    // but the in-card banner makes it clear that changes
                    // need to happen in AgentDeck on the Mac.
                    settingsCard(
                        title: "Mac integrations",
                        subtitle: "Status only. Set these up in AgentDeck on your Mac."
                    ) {
                        VStack(alignment: .leading, spacing: 12) {
                            macIntegrationsReadOnlyBanner
                            servicesContent
                        }
                    }

                    settingsCard(
                        title: "Display panels",
                        subtitle: "Choose which sections of the dashboard appear."
                    ) {
                        dashboardContent
                    }

                    settingsCard(title: "About") {
                        aboutContent
                    }

                    // ─────── Advanced (collapsed by default) ───────
                    // Display sleep sync is the only knob users rarely
                    // touch after first setup. Pairing/discovery moved
                    // into Connection above.
                    DisclosureGroup("Advanced") {
                        VStack(alignment: .leading, spacing: 16) {
                            settingsCard(
                                title: "Display & sleep",
                                subtitle: "Sync this device's brightness with the host Mac display."
                            ) {
                                displayContent
                            }
                        }
                        .padding(.top, 8)
                    }
                    .foregroundStyle(.white)
                    .tint(.white)
                    .padding(.horizontal, 4)

                    // Close button (matches Android)
                    Button {
                        dismiss()
                    } label: {
                        Text("Close")
                            .font(.body.bold())
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 12)
                            .background(
                                Color(red: 0.278, green: 0.318, blue: 0.373), // #475569
                                in: RoundedRectangle(cornerRadius: 8)
                            )
                    }
                }
                .padding(24)
            }
            .frame(maxWidth: 500)
            .background(
                Color(red: 0.118, green: 0.161, blue: 0.231).opacity(0.9), // #1E293B
                in: RoundedRectangle(cornerRadius: 16)
            )
            .padding(.vertical, 40)
        }
        .presentationBackground(.clear)
    }

    // MARK: - Mac integrations banner (iOS read-only framing)

    /// Header for the "Mac integrations" card on iOS. The card surfaces
    /// `servicesContent` (claude/codex/openclaw/antigravity status rows),
    /// but every editor inside that view is gated `#if os(macOS) && AGENTDECK_APP_STORE`.
    /// This banner sets reader expectations up front so the rows are
    /// understood as a status mirror, not as something tappable.
    private var macIntegrationsReadOnlyBanner: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)
                .padding(.top, 1)
            Text("These integrations are configured in AgentDeck on your Mac. The list below mirrors what your Mac reports.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 4)
    }

    // MARK: - macOS

    #if os(macOS)
    /// Navigable sections in the macOS Settings scene. Grouped into
    /// "Essentials" (shown first, relevant to every user) and "Advanced"
    /// (collapsed by default, network/hardware/developer concerns).
    /// Labels are rewritten from the original GroupBox titles to avoid
    /// jargon like "Daemon" / "Discovery" — first-run users shouldn't
    /// have to know what those mean to find the right setting.
    enum SettingsSection: Hashable, Identifiable {
        case integrations
        case dashboard
        case about
        case connection
        case daemon
        case pairing
        case display
        case hardware
        case evaluation
        case timelineSummary

        var id: Self { self }

        var title: String {
            switch self {
            case .integrations:    "Integrations"
            case .dashboard:       "Dashboard"
            case .about:           "About"
            case .connection:      "Connection"
            case .daemon:          "Local server"
            case .pairing:         "iPad / iPhone pairing"
            case .display:         "Display & sleep"
            case .hardware:        "ESP32 & Pixoo"
            case .evaluation:      "Agent evaluation (APME)"
            case .timelineSummary: "Timeline summary"
            }
        }

        var icon: String {
            switch self {
            case .integrations:    "link"
            case .dashboard:       "macwindow"
            case .about:           "info.circle"
            case .connection:      "network"
            case .daemon:          "server.rack"
            case .pairing:         "ipad.and.iphone"
            case .display:         "display"
            case .hardware:        "cpu"
            case .evaluation:      "chart.bar.doc.horizontal"
            case .timelineSummary: "text.bubble"
            }
        }

        /// One-line subtitle shown under the section title in the detail
        /// pane. Written as "what this section does" so the user can tell
        /// at a glance whether they're in the right place without
        /// reading every control. Avoids terms that require AgentDeck
        /// internals knowledge (daemon, mDNS, hook JSON, etc.).
        var subtitle: String {
            switch self {
            case .integrations:
                "Wire up Claude Code, OpenClaw, and Anthropic API — everything AgentDeck talks to."
            case .dashboard:
                "What shows up on the terrarium and in the menu bar."
            case .about:
                "Version, attributions, and support links."
            case .connection:
                "How this Mac/iPad finds the AgentDeck server and handles reconnects."
            case .daemon:
                "Port the local server listens on. Leave at 9120 unless something else already uses it."
            case .pairing:
                "How iPad or iPhone discovers this Mac. Usually automatic over Wi-Fi."
            case .display:
                "Sleep and wake behaviour for the Mac display."
            case .hardware:
                "Optional ESP32 boards and Pixoo LED matrix displays."
            case .evaluation:
                "APME scores agent turns. Pick a judge backend — local MLX is free."
            case .timelineSummary:
                "Pick which model writes the one-line topic on each turn's chat_end row. Apple Intelligence is on-device and free."
            }
        }
    }

    private static let essentialSections: [SettingsSection] = [.integrations, .dashboard, .about]
    private static let advancedSections: [SettingsSection] = [.connection, .daemon, .pairing, .display, .hardware, .evaluation, .timelineSummary]

    private var macOSSettings: some View {
        NavigationSplitView {
            macOSSidebar
                .navigationSplitViewColumnWidth(min: 200, ideal: 220, max: 260)
        } detail: {
            macOSDetail
        }
        .frame(minWidth: 720, minHeight: 520)
        .aquariumSurface()
    }

    private var macOSSidebar: some View {
        List(selection: $selectedSection) {
            Section("Essentials") {
                ForEach(Self.essentialSections) { section in
                    Label(section.title, systemImage: section.icon)
                        .tag(section)
                        .listRowBackground(Color.clear)
                }
            }
            Section(isExpanded: $advancedExpanded) {
                ForEach(Self.advancedSections) { section in
                    Label(section.title, systemImage: section.icon)
                        .tag(section)
                        .listRowBackground(Color.clear)
                }
            } header: {
                Text("Advanced")
            }
        }
        .listStyle(.sidebar)
        // Hide the List's default opaque material fill so the aquarium
        // gradient underneath is visible. Without this the sidebar
        // renders as an opaque light-vibrancy panel that clashes with
        // the dark detail area.
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private var macOSDetail: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(selectedSection.title)
                        .font(.title2.bold())
                    Text(selectedSection.subtitle)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                sectionContent(for: selectedSection)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Renders the content view for the selected section. Integrations
    /// is a composite (Claude Code hooks + every third-party service
    /// row in one place) so first-run users don't have to visit two
    /// sections to wire up Claude + OpenClaw + Admin API.
    @ViewBuilder
    private func sectionContent(for section: SettingsSection) -> some View {
        switch section {
        case .integrations:
            VStack(alignment: .leading, spacing: 14) {
                claudeHooksContent
                Divider()
                codexObservationContent
                Divider()
                servicesContent
            }
        case .dashboard:
            dashboardContent
        case .about:
            aboutContent
        case .connection:
            connectionContent
        case .daemon:
            daemonContent
        case .pairing:
            discoveryContent
        case .display:
            displayContent
        case .hardware:
            hardwareContent
        case .evaluation:
            apmeContent
        case .timelineSummary:
            timelineSummaryContent
        }
    }
    #endif

    // MARK: - Settings Card (Android Card style)

    private func settingsCard(
        title: String,
        subtitle: String? = nil,
        @ViewBuilder content: () -> some View
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(TerrariumHUD.subtext)

            if let subtitle {
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 4)
            }

            VStack(alignment: .leading, spacing: 10) {
                content()
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color(red: 0.2, green: 0.255, blue: 0.333), // #334155
                in: RoundedRectangle(cornerRadius: 12)
            )
        }
    }

    // MARK: - Connection Content

    private var connectionContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Status badge
            HStack(spacing: 6) {
                Circle()
                    .fill(stateHolder.connection.status == .connected
                          ? TerrariumHUD.ledGreen : TerrariumHUD.ledRed.opacity(0.6))
                    .frame(width: 8, height: 8)
                Text(stateHolder.connection.status == .connected ? "Connected" : "Disconnected")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white)
            }

            if stateHolder.connection.status == .connected {
                if let url = stateHolder.connection.url {
                    Text(url)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)
                }

                Button("Disconnect") {
                    stateHolder.disconnectBridge()
                }
                .buttonStyle(.bordered)
                .tint(.red)
            } else {
                // Manual URL input
                HStack {
                    TextField("ws://192.168.1.x:9120", text: $manualUrl)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, design: .monospaced))
                        #if os(iOS)
                        .autocapitalization(.none)
                        .keyboardType(.URL)
                        #endif

                    Button("Connect") {
                        guard !manualUrl.isEmpty else { return }
                        stateHolder.connectTo(url: manualUrl)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Color(red: 0.231, green: 0.51, blue: 0.965))
                    .disabled(manualUrl.isEmpty)
                }

                if stateHolder.connection.isReconnecting {
                    HStack(spacing: 6) {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.orange)
                        Text("Reconnecting (attempt \(stateHolder.connection.reconnectAttempt))...")
                            .font(.system(size: 11))
                            .foregroundStyle(.orange)
                    }
                }

                if let error = stateHolder.connection.lastError {
                    Text(error)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.ledRed)
                }

                #if os(iOS)
                // QR scan pairing — secondary path when mDNS can't find the
                // Mac (different Wi-Fi networks, Local Network permission
                // denied, etc.). Shows a camera view that decodes the URL
                // printed by `QRPairingWindow` on the Mac side.
                Button {
                    showQRScanner = true
                } label: {
                    Label("Scan QR to Pair", systemImage: "qrcode.viewfinder")
                        .font(.system(size: 13, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color(red: 0.231, green: 0.51, blue: 0.965))
                .padding(.top, 4)

                if let scanError {
                    Text(scanError)
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                }

                // mDNS auto-discovery is the primary pairing path on iOS —
                // promote it inline under Connection rather than burying it
                // in an Advanced section. Only shown while disconnected so
                // the card stays clean once paired.
                Divider()
                    .padding(.vertical, 4)
                discoveryContent
                #endif
            }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $showQRScanner) {
            QRScannerView(
                onScan: { payload in
                    showQRScanner = false
                    handleQRScan(payload)
                },
                onCancel: {
                    showQRScanner = false
                }
            )
        }
        #endif
    }

    #if os(iOS)
    /// Validate the QR payload and feed it to the connection state holder.
    /// Expected format: `ws://<host>:<port>?token=<token>` (produced by
    /// `QRPairingWindow` on the Mac). Reject anything else so a malformed
    /// or random QR never silently hijacks the connection.
    private func handleQRScan(_ payload: String) {
        let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              url.host != nil
        else {
            scanError = "That QR doesn't look like an AgentDeck pairing link."
            return
        }
        scanError = nil
        stateHolder.connectTo(url: trimmed)
    }
    #endif

    // MARK: - Daemon Content (macOS)

    #if os(macOS)
    private var daemonContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(daemonService.isRunning
                          ? TerrariumHUD.ledGreen
                          : (daemonService.bindFailureReason != nil
                             ? TerrariumHUD.ledRed
                             : TerrariumHUD.ledRed.opacity(0.6)))
                    .frame(width: 8, height: 8)
                Text(daemonStatusText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white)
            }

            HStack(spacing: 8) {
                Text("Port")
                    .font(.system(size: 12))
                    .foregroundStyle(TerrariumHUD.subtext)
                TextField("9120", text: $portInput)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                    .frame(width: 80)
                    .onSubmit(commitPortChange)
                Button("Apply & Restart") {
                    commitPortChange()
                }
                .buttonStyle(.borderedProminent)
                .disabled(!isPortInputDirty || !isPortInputValid)
            }

            Text("Default 9120. Range 1024–65535. Plugin/TUI discover via mDNS so any port works.")
                .font(.system(size: 10))
                .foregroundStyle(TerrariumHUD.subtext)

            if let reason = daemonService.bindFailureReason {
                Text(reason)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.ledRed)
                    .fixedSize(horizontal: false, vertical: true)

                if !daemonService.blockingProcesses.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Blocking Processes")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white)
                        ForEach(daemonService.blockingProcesses) { proc in
                            HStack(spacing: 6) {
                                Circle()
                                    .fill(proc.isAlive ? (proc.isZombie ? .orange : .red) : .gray)
                                    .frame(width: 6, height: 6)
                                Text("PID \(proc.id)")
                                    .font(.system(size: 10, design: .monospaced))
                                Text(proc.name)
                                    .font(.system(size: 10))
                                if let project = proc.project {
                                    Text("(\(project))")
                                        .font(.system(size: 10))
                                        .foregroundStyle(TerrariumHUD.subtext)
                                }
                                Text(verbatim: ":\(portString(proc.port))")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(TerrariumHUD.subtext)
                                Spacer()
                                Text(proc.statusLabel)
                                    .font(.system(size: 9))
                                    .foregroundStyle(TerrariumHUD.subtext)
                            }
                        }
                    }
                    .padding(8)
                    .background(Color.white.opacity(0.05))
                    .cornerRadius(6)

                    HStack(spacing: 8) {
                        Button("Clean Up & Retry") {
                            let result = PortDiagnostics.cleanup()
                            if result.killed > 0 || result.pruned > 0 {
                                daemonService.start()
                            }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                }
            } else if let error = daemonService.errorMessage {
                Text(error)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Toggle(isOn: $preferences.d200hBakeSessionText) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Bake Stream Deck-style session text")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white)
                        Text("Experimental. Draw project, model, and state inside the session PNG instead of relying on the native D200H label.")
                            .font(.system(size: 10))
                            .foregroundStyle(TerrariumHUD.subtext)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                Toggle(isOn: $preferences.d200hHideNativeSessionLabels) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Hide native labels in session mode")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.white)
                        Text("When enabled, AgentDeck sends `ShowTitle: 0` only for the session grid and switches labels back on in option mode.")
                            .font(.system(size: 10))
                            .foregroundStyle(TerrariumHUD.subtext)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .disabled(!preferences.d200hBakeSessionText)

            }
        }
        .onAppear {
            if portInput.isEmpty {
                portInput = String(preferences.daemonPort)
            }
        }
    }

    private var daemonStatusText: String {
        if daemonService.isRunning {
            return "Local daemon on port \(portString(daemonService.port))"
        }
        if daemonService.isUsingExternalDaemon {
            return "External daemon on port \(portString(daemonService.port))"
        }
        if daemonService.bindFailureReason != nil {
            return "Daemon bind failed"
        }
        return "Daemon starting…"
    }

    private var parsedPortInput: Int? {
        Int(portInput.trimmingCharacters(in: .whitespaces))
    }

    private var isPortInputValid: Bool {
        guard let p = parsedPortInput else { return false }
        return p >= 1024 && p <= 65535
    }

    private var isPortInputDirty: Bool {
        parsedPortInput != preferences.daemonPort
    }

    private func commitPortChange() {
        guard isPortInputValid, let newPort = parsedPortInput else { return }
        guard newPort != preferences.daemonPort else { return }
        preferences.daemonPort = newPort
        Task { await daemonService.restart() }
    }
    #endif

    // MARK: - Discovery Content

    private var discoveryContent: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("mDNS Auto-Discovery")
                    .font(.system(size: 13))
                    .foregroundStyle(.white)
                Spacer()
                if stateHolder.discovery.isSearching {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if stateHolder.discovery.bridges.isEmpty {
                Text("Searching for bridges...")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
            } else {
                ForEach(stateHolder.discovery.bridges) { bridge in
                    Button {
                        stateHolder.connectTo(bridge)
                    } label: {
                        HStack {
                            Text(bridge.project ?? bridge.name)
                                .foregroundStyle(.white)
                            Spacer()
                            Text(verbatim: "\(bridge.host):\(bridge.port)")
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(TerrariumHUD.subtext)
                        }
                        .padding(.vertical, 6)
                        .padding(.horizontal, 10)
                        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }

            // Local sessions removed — sandbox prevents reading ~/.agentdeck/sessions.json
            // mDNS discovery with daemon preference is used instead
        }
    }

    // MARK: - Display Content

    private var displayContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            #if os(iOS)
            Toggle(isOn: Binding(
                get: { stateHolder.displaySync.enabled },
                set: { stateHolder.displaySync.enabled = $0 }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sync Display Sleep")
                        .font(.system(size: 13))
                        .foregroundStyle(.white)
                    Text("Dim screen when host Mac display sleeps")
                        .font(.system(size: 11))
                        .foregroundStyle(TerrariumHUD.subtext)
                }
            }
            .tint(Color(red: 0.231, green: 0.51, blue: 0.965))
            #else
            Toggle(isOn: $preferences.displaySleepDimEnabled) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Dim devices when display sleeps")
                        .font(.system(size: 13))
                        .foregroundStyle(.white)
                    Text("Pixoo, Stream Dock, and ESP32 boards dim when this Mac's screen turns off or locks")
                        .font(.system(size: 11))
                        .foregroundStyle(TerrariumHUD.subtext)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .tint(Color(red: 0.231, green: 0.51, blue: 0.965))

            if preferences.displaySleepDimEnabled {
                Picker("When asleep", selection: $preferences.displaySleepDimMode) {
                    Text("Turn off").tag("off")
                    Text("Minimum brightness").tag("min")
                }
                .pickerStyle(.segmented)
                .labelsHidden()

                if preferences.displaySleepDimMode == "min" {
                    HStack(spacing: 8) {
                        Text("Brightness")
                            .font(.system(size: 11))
                            .foregroundStyle(TerrariumHUD.subtext)
                        Slider(
                            value: $dimLevelDraft,
                            in: 1...100,
                            step: 1,
                            onEditingChanged: { editing in
                                if !editing {
                                    preferences.displaySleepDimLevel = Int(dimLevelDraft.rounded())
                                }
                            }
                        )
                        Text("\(Int(dimLevelDraft.rounded()))%")
                            .font(.system(size: 11).monospacedDigit())
                            .foregroundStyle(TerrariumHUD.subtext)
                            .frame(width: 34, alignment: .trailing)
                    }
                    .onAppear { dimLevelDraft = Double(preferences.displaySleepDimLevel) }
                }
            }
            #endif

            // Status indicator
            HStack(spacing: 6) {
                Circle()
                    .fill(stateHolder.state.hostDisplayOn
                          ? Color.green : Color.orange)
                    .frame(width: 6, height: 6)
                Text(stateHolder.state.hostDisplayOn ? "Host display on" : "Host display off")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
            }
        }
    }

    // MARK: - About Content

    private var aboutContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Stop Chatting. Start Steering.")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.primary)

            Text("AgentDeck gives you real-time monitoring and evaluation for Claude Code, Codex, OpenCode, and OpenClaw sessions. See what your agents are doing across every device — Stream Deck+, Apple Watch, E-ink readers, ESP32 boards, matrix displays, and more. Stop context-switching between chat windows. Start steering.")
                .font(.system(size: 12))
                .foregroundStyle(TerrariumHUD.subtext)
                .fixedSize(horizontal: false, vertical: true)

            Divider()

            VStack(spacing: 4) {
                infoRow("App", "AgentDeck")
                infoRow("Version", "1.0.0")
                infoRow("Bundle", "bound.serendipity.agent.deck")
            }

            Divider()

            VStack(alignment: .leading, spacing: 6) {
                Text("Independent project. Not affiliated with Anthropic, OpenAI, Google, Elgato, DIVOOM, or other third parties referenced. All trademarks are property of their respective owners.")
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .fixedSize(horizontal: false, vertical: true)
                if let url = URL(string: "https://github.com/puritysb/AgentDeck/blob/master/ATTRIBUTION.md") {
                    Link("Third-party attributions & licenses →", destination: url)
                        .font(.system(size: 11, weight: .semibold))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var dashboardContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            // App-launch + menu-bar prefs are macOS-only — iOS has no
            // separate dashboard window to auto-open and no menu bar.
            // `openDashboardOnLaunch` is read in AgentDeckApp.swift's macOS
            // scene; `menuBarIconStyle` is read by the macOS MenuBarExtra.
            #if os(macOS)
            Toggle("Open dashboard on launch", isOn: $preferences.openDashboardOnLaunch)

            Picker("Menu bar icon", selection: $preferences.menuBarIconStyle) {
                ForEach(AppPreferences.MenuBarIconStyle.allCases) { style in
                    Text(style.title).tag(style)
                }
            }

            Divider()
            #endif

            Text("Visible Panels")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(TerrariumHUD.subtext)

            Toggle("Session list", isOn: $preferences.showSessionList)
            Toggle("Tank status", isOn: $preferences.showTankStatus)
            Toggle("Device diagnostic", isOn: $preferences.showDeviceDiagnostic)
            Toggle("Timeline strip", isOn: $preferences.showTimeline)
            Toggle("Settings button", isOn: $preferences.showSettingsButton)

            // Tank Status Sections subgroup is macOS-only for now: nothing
            // currently reads these preferences (separate cleanup pending),
            // so hiding on iOS prevents dead toggles from polluting the
            // client-only Settings sheet.
            #if os(macOS)
            Divider()

            Text("Tank Status Sections")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(TerrariumHUD.subtext)

            Toggle("OpenClaw", isOn: $preferences.showOpenClawSection)
            Toggle("MLX", isOn: $preferences.showMLXSection)
            Toggle("OLLAMA", isOn: $preferences.showOllamaSection)
            Toggle("Subscriptions", isOn: $preferences.showSubscriptionsSection)
            Toggle("Antigravity", isOn: $preferences.showAntigravitySection)
                .disabled(!preferences.antigravityAccessEnabled)

            if !preferences.antigravityAccessEnabled {
                Text("Antigravity is hidden until you explicitly grant access below.")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
            }
            #endif
        }
    }

    // MARK: - APME section

    /// APME judge backend picker + inline status for each option.
    /// Writes the selection to both `UserDefaults` (fast local access)
    /// and `~/.agentdeck/settings.json` (shared with the Node bridge).
    ///
    /// Availability semantics:
    ///   - foundationModels: requires macOS 26 + Apple Intelligence on Apple
    ///     Silicon. Status line shows availability from SystemLanguageModel.
    ///   - mlx: requires user-run local MLX server. Status is "server
    ///     required — check /apme in the dashboard after starting it".
    ///   - api: requires ANTHROPIC_API_KEY in env or settings.json.
    ///     Paid, opt-in, highlighted so users don't pick it accidentally.
    private var apmeContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Judge Backend")
                .font(.system(size: 13, weight: .semibold))

            Text("Which model scores your agent turns. Changes apply immediately and the next eval uses the new backend.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)

            Picker("Backend", selection: $preferences.apmeJudgeBackend) {
                Text("Foundation Models (on-device, free)").tag("foundationModels")
                Text("MLX (local server, free)").tag("mlx")
                Text("Anthropic API (paid)").tag("api")
            }
#if os(macOS)
            .pickerStyle(.radioGroup)
#else
            .pickerStyle(.inline)
#endif
            .labelsHidden()

            // Inline availability hint for the current selection.
            Group {
                switch preferences.apmeJudgeBackend {
                case "foundationModels":
#if os(macOS)
                    let ready = ApmeJudgeFoundationModels.isAvailable
                    Label(
                        ready ? "Apple Intelligence ready" : ApmeJudgeFoundationModels.unavailableReason,
                        systemImage: ready ? "checkmark.circle.fill" : "exclamationmark.triangle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(ready ? .green : .orange)
#else
                    Label(
                        "Apple Intelligence judge runs on the macOS daemon.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
#endif
                case "mlx":
                    Label(
                        "Requires a local MLX server at http://127.0.0.1:8800. Start it before scoring runs.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
                case "api":
#if os(macOS)
                    let configured = ApmeJudgeApi.isConfigured
                    Label(
                        configured
                            ? "ANTHROPIC_API_KEY detected. Calls cost Anthropic credits."
                            : "Set ANTHROPIC_API_KEY in environment or AgentDeck settings. Paid backend — opt-in only.",
                        systemImage: configured ? "dollarsign.circle.fill" : "key.slash"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(configured ? .yellow : .orange)
#else
                    Label(
                        "Anthropic API judge runs on the macOS daemon.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
#endif
                default:
                    EmptyView()
                }
            }
            .fixedSize(horizontal: false, vertical: true)

            Divider()

            Text("APME data is stored locally on this device. The dashboard is accessible from the menu bar APME button.")
                .font(.system(size: 10))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Timeline summary section

    /// Backend picker for the per-turn `chat_end` topic line.
    /// Mirrors the APME judge picker so the same review-safe pattern
    /// applies (no install nudge, all-cost-free defaults, FoundationModels-
    /// first chain). Selection writes to UserDefaults + settings.json
    /// `timeline.summary.provider`.
    private var timelineSummaryContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Summary backend")
                .font(.system(size: 13, weight: .semibold))

            Text("AgentDeck writes a one-line topic under each completed turn. Pick which model produces that line — all options below run locally and are free.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)

            Picker("Backend", selection: $preferences.timelineSummaryProvider) {
                Text("Auto (recommended)").tag("auto")
                Text("Apple Intelligence (on-device, free)").tag("appleIntelligence")
                Text("MLX (local server, free)").tag("mlx")
                Text("Heuristic only (no LLM)").tag("heuristic")
            }
#if os(macOS)
            .pickerStyle(.radioGroup)
#else
            .pickerStyle(.inline)
#endif
            .labelsHidden()

            Group {
                switch preferences.timelineSummaryProvider {
                case "auto":
                    Label(
                        "Tries Apple Intelligence first, then MLX, then a heuristic — whichever is available right now.",
                        systemImage: "sparkles"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
                case "appleIntelligence":
#if os(macOS)
                    let ready = ApmeJudgeFoundationModels.isAvailable
                    Label(
                        ready ? "Apple Intelligence ready" : ApmeJudgeFoundationModels.unavailableReason,
                        systemImage: ready ? "checkmark.circle.fill" : "exclamationmark.triangle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(ready ? .green : .orange)
#else
                    Label(
                        "Apple Intelligence summarization runs on the macOS daemon.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
#endif
                case "mlx":
                    Label(
                        "Requires a local MLX server at http://127.0.0.1:8800. AgentDeck silently falls back to the heuristic when the server isn't running.",
                        systemImage: "info.circle"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
                case "heuristic":
                    Label(
                        "No LLM call. Picks a short line from the start of the response. Fastest and lowest-fidelity option.",
                        systemImage: "scissors"
                    )
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext)
                default:
                    EmptyView()
                }
            }
            .fixedSize(horizontal: false, vertical: true)

            Divider()

            Text("The summary becomes the topic suffix on each chat_end row in the Dashboard timeline strip (e.g. \"Completed · 3s · 코드 리팩토링 완료\"). Changes apply to the next completed turn — earlier rows keep whatever backend produced them.")
                .font(.system(size: 10))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - OpenClaw shared-token editor (Advanced disclosure)

    @ViewBuilder
    private var openClawGatewayTokenEditor: some View {
        #if os(macOS) && AGENTDECK_APP_STORE
        VStack(alignment: .leading, spacing: 6) {
            SecureField(
                openClawGatewayTokenSaved
                    ? "Shared Gateway token saved — paste to replace"
                    : "Shared Gateway token (OPENCLAW_GATEWAY_TOKEN)",
                text: $openClawGatewayTokenInput
            )
            .textFieldStyle(.roundedBorder)
            HStack(spacing: 8) {
                Button("Save token") {
                    saveOpenClawGatewayToken()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(openClawGatewayTokenInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Clear") {
                    clearOpenClawGatewayToken()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!openClawGatewayTokenSaved && openClawGatewayTokenInput.isEmpty)

                if openClawGatewayTokenSaved {
                    Text("Saved in Keychain")
                        .font(.system(size: 10))
                        .foregroundStyle(.green)
                }
            }
            if let openClawGatewayTokenError {
                Text(openClawGatewayTokenError)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("Paste your OpenClaw gateway token. Saved to Keychain; only the gateway adapter reconnects.")
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        #else
        EmptyView()
        #endif
    }

    private func loadOpenClawGatewayTokenState() {
        #if os(macOS) && AGENTDECK_APP_STORE
        openClawGatewayTokenSaved = OpenClawGatewayTokenStore.loadToken() != nil
        openClawGatewayTokenError = nil
        #endif
    }

    private func saveOpenClawGatewayToken() {
        #if os(macOS) && AGENTDECK_APP_STORE
        do {
            try OpenClawGatewayTokenStore.saveToken(openClawGatewayTokenInput)
            openClawGatewayTokenInput = ""
            openClawGatewayTokenSaved = true
            openClawGatewayTokenError = nil
            Task { await daemonService.reconnectGatewayAdapter() }
        } catch {
            openClawGatewayTokenError = "Could not save token: \(error.localizedDescription)"
        }
        #endif
    }

    private func clearOpenClawGatewayToken() {
        #if os(macOS) && AGENTDECK_APP_STORE
        do {
            try OpenClawGatewayTokenStore.deleteToken()
            // Also revoke the imported-config bookmark so a stale rotated token
            // isn't silently re-read back in on the next reconnect.
            AppPreferences.shared.clearOpenClawConfigAccess()
            openClawGatewayTokenInput = ""
            openClawGatewayTokenSaved = false
            openClawGatewayTokenError = nil
            Task { await daemonService.reconnectGatewayAdapter() }
        } catch {
            openClawGatewayTokenError = "Could not clear token: \(error.localizedDescription)"
        }
        #endif
    }

    private func reconnectOpenClawGatewayAdapter() {
        #if os(macOS) && AGENTDECK_APP_STORE
        openClawIdentityResetSucceeded = true
        openClawIdentityResetMessage = "Reconnecting the gateway adapter — your other sessions are unaffected."
        Task { await daemonService.reconnectGatewayAdapter() }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(6))
            openClawIdentityResetMessage = nil
            openClawIdentityResetSucceeded = false
        }
        #endif
    }

    private var shouldShowOpenClawTroubleshootInline: Bool {
        let status = stateHolder.state.gatewayAuthStatus ?? ""
        guard stateHolder.state.gatewayAvailable else { return false }
        if !stateHolder.state.gatewayConnected { return true }
        return [
            "approval_pending",
            "pairing_required",
            "gateway_token_missing",
            "token_mismatch",
            "device_auth_invalid",
            "auth_failed",
            "unsupported_protocol",
            "connect_timeout",
        ].contains(status)
    }

    private var openClawTroubleshootHint: String {
        switch stateHolder.state.gatewayAuthStatus {
        case "gateway_token_missing":
            return "Import the current Gateway token, then reconnect."
        case "token_mismatch":
            return "Re-import the current Gateway token."
        case "connect_timeout":
            return "Import the current token and reconnect. Reset identity only if pairing is still rejected."
        case "device_auth_invalid", "auth_failed":
            return "Open the Web UI to approve this Mac. Reset identity only if the approved entry is stale."
        case "approval_pending", "pairing_required":
            return "Open the Web UI to approve this Mac."
        case "unsupported_protocol":
            return "This Gateway build is not compatible with AgentDeck."
        default:
            return "Use these controls only when pairing or token refresh is stuck."
        }
    }

    // MARK: - OpenClaw repair controls

    /// Inline only while OpenClaw needs attention. The same controls remain
    /// available behind Advanced for maintenance, but the normal connected state
    /// should stay quiet: "Connected / Paired through Gateway" is enough.
    @ViewBuilder
    private var openClawTroubleshootRow: some View {
        #if os(macOS) && AGENTDECK_APP_STORE
        VStack(alignment: .leading, spacing: 6) {
            Text("Troubleshoot")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(TerrariumHUD.subtext)
            openClawRepairButtons(prominentImport: true)
            if let openClawIdentityResetMessage {
                Text(openClawIdentityResetMessage)
                    .font(.system(size: 10))
                    .foregroundStyle(openClawIdentityResetSucceeded ? .green : .red)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(openClawTroubleshootHint)
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        #else
        EmptyView()
        #endif
    }

    @ViewBuilder
    private func openClawRepairButtons(prominentImport: Bool) -> some View {
        #if os(macOS) && AGENTDECK_APP_STORE
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                openClawImportButton(prominent: prominentImport)

                Button {
                    reconnectOpenClawGatewayAdapter()
                } label: {
                    Label("Reconnect adapter", systemImage: "arrow.triangle.2.circlepath")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(Text(verbatim: "Restart only AgentDeck's OpenClaw Gateway client."))
            }

            HStack(spacing: 8) {
                Button {
                    if let url = URL(string: "http://localhost:18789") {
                        NSWorkspace.shared.open(url)
                    }
                } label: {
                    Label("Open Web UI", systemImage: "safari")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(Text(verbatim: "Open the local OpenClaw Gateway UI."))

                Button(role: .destructive) {
                    resetOpenClawDeviceIdentity()
                } label: {
                    Label("Reset identity", systemImage: "arrow.counterclockwise.circle")
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .help(Text(verbatim: "Clear this Mac's stored OpenClaw pairing key."))
            }
        }
        #else
        EmptyView()
        #endif
    }

    @ViewBuilder
    private func openClawImportButton(prominent: Bool) -> some View {
        #if os(macOS) && AGENTDECK_APP_STORE
        let label = Label("Import token", systemImage: "square.and.arrow.down")
        if prominent {
            Button {
                importOpenClawTokenFromConfig()
            } label: {
                label
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .help(Text(verbatim: "Save the Gateway token from a selected JSON file to Keychain."))
        } else {
            Button {
                importOpenClawTokenFromConfig()
            } label: {
                label
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help(Text(verbatim: "Save the Gateway token from a selected JSON file to Keychain."))
        }
        #else
        EmptyView()
        #endif
    }

    /// Walks the JSON looking for the gateway token. OpenClaw's own
    /// `openclaw gateway run` writes it to `gateway.auth.token`; some hand-
    /// rolled exports put it at the top-level `auth.token`; a flat
    /// `gateway.token` is a defensive third try. Returns the first non-empty
    /// trimmed string found, or nil.
    ///
    /// `nonisolated` so XCTest (and any other off-main caller) can pass a
    /// non-Sendable `[String: Any]` literal without Swift 6 strict-concurrency
    /// flagging the call. The function is a pure dictionary walk — no UI
    /// state, no shared mutable state.
    nonisolated static func extractGatewayToken(from json: [String: Any]) -> String? {
        // Delegates to the SSOT parser so the Settings UI, the daemon adapter's
        // bookmark auto-refresh, and the XCTest suite all share one
        // implementation. This symbol is retained because
        // OpenClawTokenExtractTests references it directly.
        OpenClawGatewayTokenParser.extractToken(from: json)
    }

    /// Lets the user pick `openclaw.json` via NSOpenPanel and pulls the
    /// gateway token out of it. The token can sit at any of three paths
    /// depending on how OpenClaw was set up — `extractGatewayToken` walks
    /// them in canonical-first order. The picker grants this app a one-shot
    /// user-selected file scope, which is App Store sandbox-safe: the
    /// existing `com.apple.security.files.user-selected.read-write`
    /// entitlement covers it, no subprocess is spawned, and no path outside
    /// the user's explicit selection is touched. The token is written to
    /// Keychain via the existing `OpenClawGatewayTokenStore` and the gateway
    /// adapter is bounced — Claude Code / Codex sessions keep running.
    ///
    /// Notes for App Store review:
    /// - `panel.directoryURL` is only a Powerbox navigation hint. The app still
    ///   receives access solely to the JSON file the user explicitly selects.
    /// - `startAccessingSecurityScopedResource()` is paired with `defer` so
    ///   the scope is released even if JSON parsing throws.
    private func importOpenClawTokenFromConfig() {
        #if os(macOS) && AGENTDECK_APP_STORE
        let panel = NSOpenPanel()
        panel.title = "Import OpenClaw Gateway Token"
        panel.message = "Choose your OpenClaw config file (typically `~/.openclaw/openclaw.json`). AgentDeck will save the gateway token from it to your Keychain."
        panel.prompt = "Import token"
        panel.allowedContentTypes = [.json]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.nameFieldStringValue = "openclaw.json"
        panel.showsHiddenFiles = true
        // Open the panel directly inside `~/.openclaw/` so the (non-hidden)
        // `openclaw.json` is visible immediately — relying on the user to
        // toggle hidden files and drill into the dotfolder themselves was the
        // root cause of "the file isn't there" reports (Powerbox doesn't
        // reliably honour `showsHiddenFiles` for the in-process panel object).
        //
        // Inside App Sandbox `NSHomeDirectory()` returns the app's container
        // path, which is *not* where OpenClaw lives. `getpwuid` returns the
        // user's real `/Users/<name>/`; we append `.openclaw` when it exists
        // and fall back to the real home otherwise. `directoryURL` is only a
        // Powerbox navigation hint — it grants no read access; only the file
        // the user explicitly selects becomes readable. This mirrors the
        // already-shipping Antigravity picker, which points `directoryURL` at
        // a deep app-support folder the same way.
        if let pw = getpwuid(getuid()), let realHome = pw.pointee.pw_dir.flatMap({ String(cString: $0) }) {
            let home = URL(fileURLWithPath: realHome)
            let openclawDir = home.appendingPathComponent(".openclaw", isDirectory: true)
            panel.directoryURL = FileManager.default.fileExists(atPath: openclawDir.path) ? openclawDir : home
        }

        guard panel.runModal() == .OK, let url = panel.url else { return }

        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        do {
            let data = try Data(contentsOf: url)
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                openClawGatewayTokenError = "That file isn't a JSON object. Pick `~/.openclaw/openclaw.json` or paste the token manually below."
                return
            }
            guard let token = Self.extractGatewayToken(from: json) else {
                openClawGatewayTokenError = "Couldn't find a gateway token in that file. Looked at `gateway.auth.token`, `auth.token`, `gateway.token`. Pick a different file or paste the token below."
                return
            }
            try OpenClawGatewayTokenStore.saveToken(token)
            // Persist a security-scoped bookmark to the picked file so a later
            // rotated `gateway.auth.token` is re-read automatically on the next
            // gateway (re)connect — the user grants file access once.
            AppPreferences.shared.storeOpenClawConfigBookmark(for: url)
            openClawGatewayTokenInput = ""
            openClawGatewayTokenSaved = true
            openClawGatewayTokenError = nil
            openClawIdentityResetSucceeded = true
            openClawIdentityResetMessage = "Token imported. Reconnecting the gateway adapter — your other sessions are unaffected."
            Task { await daemonService.reconnectGatewayAdapter() }
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(6))
                openClawIdentityResetMessage = nil
                openClawIdentityResetSucceeded = false
            }
        } catch {
            openClawGatewayTokenError = "Could not read the file: \(error.localizedDescription)"
        }
        #endif
    }

    private func resetOpenClawDeviceIdentity() {
        #if os(macOS) && AGENTDECK_APP_STORE
        do {
            try OpenClawDeviceIdentityStore.deleteIdentity()
            openClawIdentityResetSucceeded = true
            openClawIdentityResetMessage = "Pairing identity cleared. Reconnecting OpenClaw — a fresh device key will be generated. Claude Code / Codex sessions are unaffected."
            Task { await daemonService.reconnectGatewayAdapter() }
            // Clear the inline message after a few seconds so the row returns
            // to its general guidance text.
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(6))
                openClawIdentityResetMessage = nil
                openClawIdentityResetSucceeded = false
            }
        } catch {
            openClawIdentityResetSucceeded = false
            openClawIdentityResetMessage = "Could not reset pairing identity: \(error.localizedDescription)"
        }
        #endif
    }

    // MARK: - Anthropic Admin API key editor (Optional API keys group slot)

    @ViewBuilder
    private var anthropicAdminApiEditor: some View {
        #if os(macOS) && AGENTDECK_APP_STORE
        VStack(alignment: .leading, spacing: 6) {
            SecureField(
                anthropicAdminApiKeySaved
                    ? "Admin API key saved — paste to replace"
                    : "sk-ant-admin01-… (Console Admin API key)",
                text: $anthropicAdminApiKeyInput
            )
            .textFieldStyle(.roundedBorder)
            HStack(spacing: 8) {
                Button("Save key") {
                    saveAnthropicAdminApiKey()
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .disabled(anthropicAdminApiKeyInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button("Clear") {
                    clearAnthropicAdminApiKey()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!anthropicAdminApiKeySaved && anthropicAdminApiKeyInput.isEmpty)

                if anthropicAdminApiKeySaved {
                    Text("Saved in Keychain")
                        .font(.system(size: 10))
                        .foregroundStyle(.green)
                }
            }
            if let anthropicAdminApiKeyError {
                Text(anthropicAdminApiKeyError)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        #else
        EmptyView()
        #endif
    }

    private func loadAnthropicAdminApiKeyState() {
        #if os(macOS) && AGENTDECK_APP_STORE
        anthropicAdminApiKeySaved = AnthropicAdminApiKeyStore.loadKey() != nil
        anthropicAdminApiKeyError = nil
        #endif
    }

    private func saveAnthropicAdminApiKey() {
        #if os(macOS) && AGENTDECK_APP_STORE
        do {
            try AnthropicAdminApiKeyStore.saveKey(anthropicAdminApiKeyInput)
            anthropicAdminApiKeyInput = ""
            anthropicAdminApiKeySaved = true
            anthropicAdminApiKeyError = nil
            Task { await daemonService.restart() }
        } catch {
            anthropicAdminApiKeyError = "Could not save key: \(error.localizedDescription)"
        }
        #endif
    }

    private func clearAnthropicAdminApiKey() {
        #if os(macOS) && AGENTDECK_APP_STORE
        do {
            try AnthropicAdminApiKeyStore.deleteKey()
            anthropicAdminApiKeyInput = ""
            anthropicAdminApiKeySaved = false
            anthropicAdminApiKeyError = nil
            Task { await daemonService.restart() }
        } catch {
            anthropicAdminApiKeyError = "Could not clear key: \(error.localizedDescription)"
        }
        #endif
    }

    #if os(macOS)
    @State private var showESP32Sheet: Bool = false
    @State private var showPixooSheet: Bool = false
    @State private var showIDotMatrixSheet: Bool = false
    #endif

    /// Hardware integrations that ship with in-app setup UI. D200H is plug
    /// and play (no setup sheet needed), ESP32 needs Wi-Fi credentials, and
    /// Pixoo needs an IP. We colocate the entry points so users don't have
    /// to hunt through the app for "how do I add my device?".
    #if os(macOS)
    private var hardwareContent: some View {
        VStack(alignment: .leading, spacing: 10) {
            hardwareRow(
                icon: "antenna.radiowaves.left.and.right",
                title: "ESP32 boards",
                subtitle: "Send Wi-Fi credentials over USB. Works with 86Box, IPS 3.5\" and round AMOLED displays.",
                buttonLabel: "Set up…",
                action: { showESP32Sheet = true }
            )
            Divider()
            hardwareRow(
                icon: "square.grid.3x3.fill",
                title: "Pixoo matrix displays",
                subtitle: "Add Divoom Pixoo devices by IP. AgentDeck picks up changes automatically.",
                buttonLabel: "Manage…",
                action: { showPixooSheet = true }
            )
            Divider()
            hardwareRow(
                icon: "dot.radiowaves.left.and.right",
                title: "iDotMatrix LED display",
                subtitle: "Pair a 32×32 iDotMatrix over Bluetooth. AgentDeck renders session state on it.",
                buttonLabel: "Pair…",
                action: { showIDotMatrixSheet = true }
            )
            Divider()
            Text("Ulanzi D200H Deck Dock connects over USB automatically — no setup required. Plug it in and it appears in the session list.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)
        }
        .sheet(isPresented: $showESP32Sheet) {
            ESP32ProvisionSheet()
        }
        .sheet(isPresented: $showPixooSheet) {
            PixooSheet()
        }
        .sheet(isPresented: $showIDotMatrixSheet) {
            IDotMatrixSheet()
        }
    }

    private func hardwareRow(
        icon: String,
        title: String,
        subtitle: String,
        buttonLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 13))
                .foregroundStyle(TerrariumHUD.subtext)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold))
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Button(buttonLabel, action: action)
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
    }
    #endif

    /// Two-group integrations panel. Per-row inline editors live in the
    /// builder slots below so this code path doesn't grow new state-driven
    /// branches every time we add an integration.
    private var servicesContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            IntegrationsView(
                anthropicKeySaved: anthropicAdminApiKeySaved,
                accountSlot: { descriptor in
                    accountIntegrationSlot(descriptor)
                },
                apiKeySlot: { descriptor in
                    apiKeyIntegrationSlot(descriptor)
                }
            )
            // Keychain reads (`OpenClawGatewayTokenStore.loadToken`,
            // `AnthropicAdminApiKeyStore.loadKey`) block on `mach_msg2_trap`
            // when the system has to prompt for ACL approval — and SwiftUI
            // evaluates `onAppear` synchronously on the main actor, so the
            // whole UI (and the daemon's `startServices` step that runs
            // after the first scene flush) hangs until the user dismisses
            // the prompt. Move the reads off the main thread; await the
            // result and assign back on the main actor. The prompt still
            // appears, but it doesn't gate the rest of launch.
            .task {
                #if os(macOS) && AGENTDECK_APP_STORE
                async let openClawSaved = Task.detached(priority: .userInitiated) {
                    OpenClawGatewayTokenStore.loadToken() != nil
                }.value
                async let anthropicSaved = Task.detached(priority: .userInitiated) {
                    AnthropicAdminApiKeyStore.loadKey() != nil
                }.value
                let (oc, an) = await (openClawSaved, anthropicSaved)
                openClawGatewayTokenSaved = oc
                openClawGatewayTokenError = nil
                anthropicAdminApiKeySaved = an
                anthropicAdminApiKeyError = nil
                #endif
            }
        }
    }

    /// Per-row footer for account-linked integrations: OpenClaw advanced
    /// token disclosure (App Store only), Antigravity database picker.
    @ViewBuilder
    private func accountIntegrationSlot(_ descriptor: IntegrationDescriptor) -> some View {
        switch descriptor.id {
        case "openclaw":
            #if os(macOS) && AGENTDECK_APP_STORE
            VStack(alignment: .leading, spacing: 8) {
                if shouldShowOpenClawTroubleshootInline {
                    openClawTroubleshootRow
                }
                DisclosureGroup("Advanced") {
                    VStack(alignment: .leading, spacing: 8) {
                        if !shouldShowOpenClawTroubleshootInline {
                            Text("Token refresh and repair tools.")
                                .font(.system(size: 10))
                                .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
                                .fixedSize(horizontal: false, vertical: true)
                            openClawRepairButtons(prominentImport: false)
                            Divider().opacity(0.4)
                        }
                        openClawGatewayTokenEditor
                    }
                    .padding(.top, 6)
                }
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)
            }
            #else
            EmptyView()
            #endif
        case "antigravity":
            antigravityDatabaseSlot
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private func apiKeyIntegrationSlot(_ descriptor: IntegrationDescriptor) -> some View {
        switch descriptor.id {
        case "anthropic-admin":
            #if os(macOS) && AGENTDECK_APP_STORE
            anthropicAdminApiEditor
            #else
            Text("Configure on macOS to add an Admin API key.")
                .font(.system(size: 10))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
            #endif
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var antigravityDatabaseSlot: some View {
        #if os(macOS)
        VStack(alignment: .leading, spacing: 6) {
            if let path = preferences.antigravitySelectedPath, preferences.antigravityAccessEnabled {
                Text(path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            HStack(spacing: 8) {
                Button(preferences.antigravityAccessEnabled ? "Re-pick database" : "Choose state.vscdb") {
                    _ = preferences.chooseAntigravityDatabase()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                if preferences.antigravityAccessEnabled {
                    Button("Remove access") {
                        showRemoveAntigravityConfirm = true
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .confirmationDialog(
                        "Remove Antigravity access?",
                        isPresented: $showRemoveAntigravityConfirm,
                        titleVisibility: .visible
                    ) {
                        Button("Remove", role: .destructive) {
                            preferences.clearAntigravityAccess()
                        }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text("This will revoke file access to the Antigravity database. You can re-enable it later.")
                    }
                }
            }
        }
        #else
        EmptyView()
        #endif
    }

    // MARK: - Claude Code Hooks (macOS)

    #if os(macOS)
    /// Explicit opt-in surface for `~/.claude/settings.json` hook
    /// registration. Replaces the old auto-install behaviour — App Store
    /// review 2.5.2 requires user consent before we touch files outside
    /// the sandbox.
    private var claudeHooksContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(preferences.hooksInstalled
                          ? TerrariumHUD.ledGreen
                          : TerrariumHUD.ledRed.opacity(0.6))
                    .frame(width: 8, height: 8)
                Text(hookStatusText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white)
            }

            Text("AgentDeck can register hooks in ~/.claude/settings.json so Claude Code sessions report state to the dashboard. You'll be asked to grant access to that file before any write happens.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)
                .fixedSize(horizontal: false, vertical: true)

            if let path = UserDefaults.standard.string(forKey: "prefs.claudeSettingsPath") {
                Text(path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            HStack(spacing: 8) {
                Button("Enable Claude Code Hooks…") {
                    _ = HookInstaller.promptAndInstall()
                }
                .buttonStyle(.borderedProminent)
                .disabled(preferences.hookInstallConsent == .accepted && preferences.hooksInstalled)

                Button("Remove") {
                    HookInstaller.uninstallAndRevoke()
                }
                .buttonStyle(.bordered)
                .disabled(!preferences.hooksInstalled)
            }
        }
    }

    private var hookStatusText: String {
        if preferences.hooksInstalled {
            return "Hooks installed"
        }
        switch preferences.hookInstallConsent {
        case .unknown: return "Not configured"
        case .declined: return "Declined — click Enable to revisit"
        case .accepted: return "Consent granted, not yet written"
        }
    }

    /// Codex equivalent of `claudeHooksContent`. Drives the
    /// `~/.codex/config.toml` notify + OTel block via NSAlert + NSOpenPanel.
    /// Only writes inside AgentDeck's fenced TOML block — user keys
    /// (model, profiles, MCP servers) are left untouched.
    private var codexObservationContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Circle()
                    .fill(preferences.codexConfigInstalled
                          ? TerrariumHUD.ledGreen
                          : TerrariumHUD.ledRed.opacity(0.6))
                    .frame(width: 8, height: 8)
                Text(codexObservationStatusText)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white)
            }

            Text("AgentDeck can register a notify hook and OTel exporter in ~/.codex/config.toml so Codex turns and tool calls report state to the dashboard. Skip this if you don't use Codex — your model, profiles, and MCP server keys are preserved.")
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext)
                .fixedSize(horizontal: false, vertical: true)

            if let path = UserDefaults.standard.string(forKey: "prefs.codexConfigPath") {
                Text(path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            HStack(spacing: 8) {
                Button("Enable Codex Observation…") {
                    _ = CodexConfigInstaller.promptAndInstall()
                }
                .buttonStyle(.borderedProminent)
                .disabled(preferences.codexConfigConsent == .accepted && preferences.codexConfigInstalled)

                Button("Remove") {
                    CodexConfigInstaller.uninstallAndRevoke()
                }
                .buttonStyle(.bordered)
                .disabled(!preferences.codexConfigInstalled)
            }
        }
    }

    private var codexObservationStatusText: String {
        if preferences.codexConfigInstalled {
            return "Observation installed"
        }
        switch preferences.codexConfigConsent {
        case .unknown: return "Not configured"
        case .declined: return "Declined — click Enable to revisit"
        case .accepted: return "Consent granted, not yet written"
        }
    }
    #endif

    private func infoRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(TerrariumHUD.subtext)
            Spacer()
            Text(value)
                .font(.system(size: 12, design: .monospaced))
                .foregroundStyle(.white)
        }
    }
}
