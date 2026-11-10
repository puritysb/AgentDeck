// MonitorScreen.swift — Single screen: terrarium + HUD + timeline + settings gear

import SwiftUI

/// Shared Monitor overlay layout metrics. The timeline strip is sized to
/// cover the terrarium sand bed, so this derives from the terrarium SSOT
/// (TerrariumLayout.sandHeightFraction; Android mirror: TerrariumConfig.kt
/// SAND_HEIGHT_FRACTION).
enum MonitorLayout {
    static let sandFraction = CGFloat(TerrariumLayout.sandHeightFraction)
}

/// Dashboard inspection chooses the visible question without changing the
/// daemon's control focus or borrowing another session's live prompt options.
enum MonitorAttentionSelection {
    static func featuredSession(
        in awaitingSessions: [SessionInfo],
        inspectedSessionID: String?,
        controlFocusedSessionID: String?
    ) -> SessionInfo? {
        if let inspectedSessionID {
            for session in awaitingSessions where session.id == inspectedSessionID {
                return session
            }
            // A Codex group's representative can change while the Dashboard
            // keeps inspecting one of its explicitly declared members.
            for session in awaitingSessions where (session.foldedSessionIds ?? []).contains(inspectedSessionID) {
                return session
            }
        }
        if let controlFocusedSessionID {
            // Control focus never follows a display alias: aggregate prompt
            // options and cursor state belong to this exact session only.
            for session in awaitingSessions where session.id == controlFocusedSessionID {
                return session
            }
        }
        return awaitingSessions.first
    }
}

struct MonitorScreen: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    #if os(macOS)
    @EnvironmentObject private var daemonService: DaemonService
    @Environment(\.openWindow) private var openWindow
    @StateObject private var communications = CommunicationFeed()
    @State private var showsMessages = false
    @State private var showsUsage = false
    @State private var showsSessions = false
    @State private var showsWork = false
    @ObservedObject private var attentionAccess = AttentionSessionAccess.shared
    @State private var sessionOpenError: String?
    @State private var aquariumRenderingEnabled = true
    #endif

    @StateObject private var inspection = DashboardInspection()
    @State private var terrariumState = TerrariumState()
    #if os(macOS) && AGENTDECK_DOT_PREVIEW
    #endif
    #if os(iOS)
    @State private var showSettingsSheet = false
    #endif
    /// "Aquarium viewing" mode — when on, SessionListPanel + TopologyRail
    /// fade out so the user can watch the terrarium uninterrupted. Toggled
    /// by tapping empty water. Shared by macOS and iOS so the core
    /// Dashboard interaction stays consistent even though macOS has extra
    /// windows and host-side controls.
    @State private var hudHidden = false
    @State private var attentionHeight: CGFloat = 0
    @State private var previousAgentState: AgentConnectionState = .disconnected
    @StateObject private var toastManager = ToastManager()

    /// Content-based key for fields that affect `DashboardState.toTerrariumState`
    /// outside the top-level connection state. The terrarium keeps its own
    /// derived state so it can animate asking-exit bursts; this key makes the
    /// derived copy move in lockstep with the left session list when focus or
    /// session metadata changes without a state/count change.
    private var terrariumProjectionKey: String {
        let primary = [
            String(stateHolder.state.bridgeConnected),
            stateHolder.state.sessionId ?? "",
            inspection.sessionId ?? "",
            stateHolder.state.agentType ?? "",
            stateHolder.state.projectName ?? "",
            stateHolder.state.modelName ?? "",
        ].joined(separator: "|")
        // Built with a plain loop and a comparator-free `sort()` on purpose.
        // `sorted(by:)`/`map` hand a caller-supplied closure to nonisolated
        // stdlib generics; that closure statically inherits this view's
        // @MainActor isolation, and Debug builds compile an executor assertion
        // into its prologue — the same shape that trapped in the IOKit power
        // callback. Nothing here needs a closure, so don't pay for one.
        // Ordering only has to be deterministic (this is a change-detection
        // key, not display order), and sorting the composed rows is: the id is
        // the leading field and ids are unique.
        var rows: [String] = []
        rows.reserveCapacity(stateHolder.state.siblingSessions.count)
        for session in stateHolder.state.siblingSessions {
            var fields: [String] = [session.id]
            fields.append(session.agentType ?? "")
            fields.append(session.state ?? "")
            fields.append(session.projectName ?? "")
            fields.append(session.modelName ?? "")
            fields.append(session.waitingOn?.phase ?? "")
            fields.append(session.activity ?? "")
            fields.append(session.backgroundTaskCount.map(String.init) ?? "")
            fields.append(String(session.alive))
            rows.append(fields.joined(separator: "|"))
        }
        rows.sort()
        return "\(primary)::\(rows.joined(separator: ","))::timeline:\(stateHolder.timelineVersion)"
    }

    var body: some View {
        mainContent
            .environmentObject(inspection)
            #if os(iOS)
            .safeAreaInset(edge: .top, spacing: 0) {
                directControls
            }
            .sheet(isPresented: $showSettingsSheet) {
                SettingsScreen()
                    .environmentObject(stateHolder)
                    .environmentObject(preferences)
            }
            #endif
            .onAppear {
                previousAgentState = stateHolder.state.state
                updateTerrariumState()
            }
            .modifier(StateChangeModifier(
                stateHolder: stateHolder,
                terrariumProjectionKey: terrariumProjectionKey,
                previousAgentState: $previousAgentState,
                toastManager: toastManager,
                updateTerrariumState: updateTerrariumState
            ))
            #if os(macOS)
            .onChange(of: attentionAccess.presentation?.id, initial: true) { _, requestID in
                guard let requestID,
                      let destination = attentionAccess.consumePresentation(id: requestID) else { return }
                hudHidden = false
                switch destination {
                case .session(let id):
                    sessionOpenError = nil
                    showsWork = true
                    inspection.select(id, state: stateHolder.state)
                case .failure(let message):
                    inspection.select(nil, state: stateHolder.state)
                    sessionOpenError = message
                }
            }
            .alert("Unable to open session", isPresented: Binding(
                get: { sessionOpenError != nil },
                set: { if !$0 { sessionOpenError = nil } }
            )) {
                Button("OK") { sessionOpenError = nil }
            } message: {
                Text(sessionOpenError ?? "")
            }
            .sheet(isPresented: $showsMessages) {
                DashboardMessageHistory(feed: communications, roster: stateHolder.state.siblingSessions,
                                        selectedID: inspection.sessionId,
                                        inspect: { inspection.select($0, state: stateHolder.state) })
            }
            .onChange(of: inspection.sessionId) { _, id in
                showsSessions = false
                if id != nil {
                    hudHidden = false
                    showsWork = true
                }
            }
            .background {
                AquariumWindowActivityReader(renderingEnabled: $aquariumRenderingEnabled)
                    .allowsHitTesting(false)
            }
            .task(id: "\(communicationPort)|\(stateHolder.state.bridgeConnected)|\(communications.refreshID)|\(readsCommunications)") {
                guard readsCommunications else { return }
                await communications.observe(port: communicationPort, connected: stateHolder.state.bridgeConnected)
            }
            .modifier(KeyboardShortcutsModifier(stateHolder: stateHolder))
            #endif
    }

    private var shellHomePresent:Bool {
        #if AGENTDECK_DOT_PREVIEW
        return !terrariumState.hermesCreatures.isEmpty || stateHolder.state.dot?.configured == true
        #else
        return !terrariumState.hermesCreatures.isEmpty
        #endif
    }
    private var shellHomeOccupied:Bool {
        let hermes=terrariumState.hermesCreatures.contains { $0.activity == .working || $0.activity == .waiting }
        #if AGENTDECK_DOT_PREVIEW
        return hermes || stateHolder.state.dot?.inhabitsHabitat(at:Int(Date().timeIntervalSince1970*1000)) == true
        #else
        return hermes
        #endif
    }

    // MARK: - Main Content

    private var mainContent: some View {
        GeometryReader { geo in
            let disconnected = !stateHolder.state.bridgeConnected
            let compactTimelineControls = usesCompactTimelineControls(width: geo.size.width, disconnected: disconnected)
            ZStack {
                terrariumLayer
                if preferences.effectiveDashboardType != .aquarium3D && shellHomePresent {
                    Canvas { context,size in
                        ShellHome2D.draw(context:&context,cx:size.width*CGFloat(TerrariumRules.hermesHomeCanvasX),cy:size.height*CGFloat(TerrariumRules.hermesHomeCanvasY),
                            radius:min(size.width,size.height)*CGFloat(TerrariumRules.hermesHomeCanvasRadius),opening:shellHomeOccupied ? 1 : 0)
                    }.allowsHitTesting(false)
                }

                dashboardContent(geo: geo, disconnected: disconnected, compactTimelineControls: compactTimelineControls)

                #if os(macOS)
                if showsWork {
                    workScreen
                }
                if !hudHidden {
                    VStack(alignment: .leading, spacing: 2) {
                        dashboardHeader(width: geo.size.width)
                        dashboardBrand.padding(.leading, DashboardHUDLayout.edgePadding)
                        Spacer(minLength: 0)
                    }
                }
                #endif

                toastLayer(geo: geo)

                if dashboardIsVisible && shouldShowEmptyGuide {
                    MonitorEmptyGuideOverlay(
                        onPreviewDevices: emptyGuidePreviewAction,
                        onDismiss: { preferences.hasSeenMonitorEmptyGuide = true }
                    )
                    .transition(.opacity)
                }
            }
        }
        #if os(macOS)
        // Put the compact controls in the transparent title-bar space.
        .ignoresSafeArea(.container, edges: .top)
        #endif
    }

    private var dashboardIsVisible: Bool {
        #if os(macOS)
        !showsWork
        #else
        true
        #endif
    }

    private func dashboardContent(geo: GeometryProxy, disconnected: Bool, compactTimelineControls: Bool) -> some View {
        ZStack {
            hudLayer(geo: geo, disconnected: disconnected, compactTimelineControls: compactTimelineControls)
            #if AGENTDECK_DOT_PREVIEW
            if preferences.effectiveDashboardType != .aquarium3D && stateHolder.state.bridgeConnected,
               let dot = stateHolder.state.dot {
                DotHabitatView(snapshot: dot, labelsVisible: !hudHidden)
            }
            #endif
            if disconnected && showsConnectionOverlay {
                ConnectionOverlay()
            }
            attentionTheaterLayer(geo: geo)
            setupNeededLayer(geo: geo)
            #if os(macOS)
            if !compactTimelineControls {
                settingsLayer
            }
            #endif
        }
        .opacity(dashboardIsVisible ? 1 : 0)
        .allowsHitTesting(dashboardIsVisible)
        .accessibilityHidden(!dashboardIsVisible)
    }

    /// Show the first-run Monitor guide only when the bridge is connected
    /// (so we don't stack on top of `ConnectionOverlay`), the user has
    /// no live sessions yet, and they haven't dismissed the card before.
    private var shouldShowEmptyGuide: Bool {
        stateHolder.state.bridgeConnected
            && stateHolder.state.siblingSessions.isEmpty
            && !preferences.hasSeenMonitorEmptyGuide
    }

    // MARK: - Sub-views

    #if os(macOS)
    private var communicationPort: Int {
        #if DEBUG
        if let pinned = stateHolder.captureFeedPort { return pinned }
        #endif
        return Int(daemonService.port)
    }
    #endif

    #if os(macOS)
    private var readsCommunications: Bool { showsMessages || (showsWork && inspection.sessionId != nil) }

    private var workScreen: some View {
        ZStack(alignment: .top) {
            LinearGradient(
                colors: [DesignTokens.UI.popupBgDeep.opacity(0.72), DesignTokens.UI.popupBgDeep.opacity(0.48)],
                startPoint: .top, endPoint: .bottom
            )
            CollaborationPanel(port: communicationPort, communications: communications,
                               attention: { session in AnyView(attentionCard(for: session)) })
                .frame(maxWidth: CollaborationPanel.maximumWidth, maxHeight: CollaborationPanel.maximumHeight)
                .padding(.horizontal, 20)
                .padding(.top, DashboardHUDLayout.headerHeight + 43)
                .padding(.bottom, 16)
        }
    }

    private var dashboardBrand: some View {
        HStack(spacing: 7) {
            AgentDeckLogo(size: 32, color: DesignTokens.UI.cyan).accessibilityHidden(true)
            Text("AgentDeck").font(.system(size: 17, weight: .semibold))
                .foregroundStyle(DesignTokens.Tide.s50)
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("dashboard-brand")
    }

    private func dashboardHeader(width: CGFloat) -> some View {
        let compact = width < 560
        let pending = stateHolder.state.bridgeConnected
            ? stateHolder.state.siblingSessions.filter(CollaborationProjection.needsInput).count : 0
        return HStack(spacing: compact ? 7 : 12) {
            HStack(spacing: 3) {
                Button {
                    showsUsage = false
                    showsWork = false
                } label: {
                    Label("Dashboard", systemImage: "square.grid.2x2")
                        .modifier(DashboardHeaderLabel(compact: compact))
                        .padding(.horizontal, 7).padding(.vertical, 5)
                        .background(DesignTokens.Ink.s700.opacity(showsWork ? 0 : 0.75), in: .rect(cornerRadius: 6))
                }
                .help("Dashboard")
                .accessibilityAddTraits(showsWork ? [] : .isSelected)
                .accessibilityIdentifier("dashboard-home")

                Button {
                    showsSessions = false
                    showsUsage = false
                    showsWork = true
                } label: {
                    HStack(spacing: 5) {
                        Label("Work", systemImage: "list.bullet.rectangle")
                            .modifier(DashboardHeaderLabel(compact: compact))
                        if pending > 0 {
                            Text(pending.formatted())
                                .monospacedDigit()
                                .foregroundStyle(DesignTokens.UI.attn)
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(DesignTokens.UI.attn.opacity(0.13), in: Capsule())
                        }
                    }
                    .padding(.horizontal, 7).padding(.vertical, 5)
                    .background(DesignTokens.Ink.s700.opacity(showsWork ? 0.75 : 0), in: .rect(cornerRadius: 6))
                }
                .help("Work")
                .accessibilityLabel("Work")
                .accessibilityValue(pending > 0 ? "\(pending) need input" : "")
                .accessibilityAddTraits(showsWork ? .isSelected : [])
                .accessibilityIdentifier("dashboard-work-home")
            }
            Color.clear
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .gesture(WindowDragGesture())
                .accessibilityHidden(true)
            Button { showsMessages = true } label: {
                Label("Messages", systemImage: "bubble.left.and.bubble.right")
                    .modifier(DashboardHeaderLabel(compact: width < 560))
            }
            .accessibilityIdentifier("dashboard-messages")
            if !showsWork && preferences.showSessionList && !DashboardHUDLayout.showsDashboardRails(availableWidth: width) {
                Button { showsSessions.toggle() } label: {
                    Label("Sessions", systemImage: "list.bullet").labelStyle(.iconOnly)
                }
                .help("Sessions")
                .popover(isPresented: $showsSessions) {
                    SessionListPanel(maxHeight: 400).frame(width: 275).padding(8)
                }
            }
            if showsWork || !DashboardHUDLayout.showsDashboardRails(availableWidth: width)
                || !(preferences.showTankStatus || preferences.showDeviceDiagnostic) {
                Button { showsUsage.toggle() } label: {
                    Label("Usage & Services", systemImage: "chart.bar").labelStyle(.iconOnly)
                }
                .help("Usage & Services")
                .accessibilityIdentifier("dashboard-usage")
                .popover(isPresented: $showsUsage) {
                    TopologyRail(maxHeight: 420).frame(width: 300).padding(8)
                }
            }
        }
        .buttonStyle(.plain)
        .font(.caption.weight(.medium))
        .foregroundStyle(DesignTokens.Tide.s50)
        .padding(.leading, 82)
        .padding(.trailing, DashboardHUDLayout.edgePadding)
        .frame(height: DashboardHUDLayout.headerHeight)
    }
    #endif

    @available(iOS 18.0, macOS 15.0, *)
    private func livingAquariumScene() -> LivingAquariumScene {
        var scene = LivingAquariumScene(viewingMode: hudHidden, terrariumState: terrariumState,
                                        onCreatureTapped: handleCreatureTap, onBackgroundTapped: backgroundTapHandler)
        #if os(macOS)
        scene.renderingEnabled = aquariumRenderingEnabled
        scene.showsResidentLabels = dashboardIsVisible
        #endif
        #if AGENTDECK_DOT_PREVIEW
        scene.dotSnapshot = stateHolder.state.dot
        #endif
        return scene
    }

    @ViewBuilder
    private var terrariumLayer: some View {
        if preferences.effectiveDashboardType == .aquarium3D {
            if #available(iOS 18.0, macOS 15.0, *) {
                GeometryReader { geometry in
                    let top = hudHidden || !showsFloatingAttention || featuredAwaitingSession == nil ? 0 : attentionHeight + 24
                    ZStack(alignment: .top) {
                        TerrariumColors.deepSea
                        livingAquariumScene()
                            .frame(height: max(1, geometry.size.height - top))
                            .padding(.top, top)
                        // Keep the habitat continuous behind the timeline, as on macOS.
                        TerrariumColors.deepSea.opacity(Double(TerrariumRules.nativeWaterTint))
                            .allowsHitTesting(false)
                        LinearGradient(stops: [
                            .init(color: TerrariumColors.deepSea.opacity(Double(TerrariumRules.nativeWaterTint)), location: 0),
                            .init(color: .clear, location: CGFloat(TerrariumRules.nativeDepthFadeStart)),
                            .init(color: TerrariumColors.deepSea.opacity(Double(TerrariumRules.nativeDepthFadeShoulderOpacity)), location: CGFloat(TerrariumRules.nativeDepthFadeShoulder)),
                            .init(color: TerrariumColors.deepSea.opacity(Double(TerrariumRules.nativeDepthFadeEndOpacity)), location: 1),
                        ], startPoint: .top, endPoint: .bottom)
                        .opacity(hudHidden ? 0 : 1)
                        .animation(.easeInOut(duration: Double(TerrariumRules.nativeViewingResponseSeconds * 3)), value: hudHidden)
                        .allowsHitTesting(false)
                    }
                }
                .ignoresSafeArea()
            }
        } else {
            GeometryReader { _ in
                TerrariumView(
                    terrariumState: terrariumState,
                    showsResidentLabels: dashboardIsVisible,
                    onCreatureTapped: handleCreatureTap,
                    onBackgroundTapped: backgroundTapHandler
                )
            }.ignoresSafeArea()
        }
    }

    /// Attention is non-modal: empty water still toggles the viewing mode.
    /// Hiding the HUD never answers or dismisses the underlying request.
    private var backgroundTapHandler: (() -> Void)? {
        toggleViewingMode
    }

    /// `disconnected` hides the HUD without unmounting it. Swapping this whole
    /// layer out for ConnectionOverlay destroys the subtree, and with it every
    /// @State inside — the timeline's scroll offset, sticky-bottom mode, and
    /// expand state. Bridge drops here are routinely transient (~5s while the
    /// daemon stands down to reclaim the canonical port from a fallback), so a
    /// blip the user barely sees was silently throwing them back to the bottom
    /// of the timeline. Hidden-but-mounted keeps ConnectionOverlay's look (it
    /// draws its own scrim on top) while the state survives the round trip.
    @ViewBuilder
    private func hudLayer(geo: GeometryProxy, disconnected: Bool, compactTimelineControls: Bool) -> some View {
        MonitorHUD()
            .opacity(hudHidden || disconnected ? 0 : 1)
            .allowsHitTesting(!hudHidden && !disconnected)
            .animation(.easeInOut(duration: 0.25), value: hudHidden)

        if preferences.showTimeline {
            VStack {
                Spacer()
                TimelineStripView(
                    usesMetalHabitat: preferences.effectiveDashboardType == .aquarium3D,
                    availableWidth: geo.size.width,
                    headerControls: compactTimelineControls ? AnyView(compactTimelineActions) : nil
                )
                    .frame(height: geo.size.height * MonitorLayout.sandFraction)
            }
            .opacity(disconnected || (preferences.effectiveDashboardType == .aquarium3D && hudHidden) ? 0 : 1)
            .allowsHitTesting(!disconnected && !(preferences.effectiveDashboardType == .aquarium3D && hudHidden))
        }
    }

    private func usesCompactTimelineControls(width: CGFloat, disconnected: Bool) -> Bool {
        #if os(macOS)
        preferences.showTimeline && !disconnected
            && (preferences.effectiveDashboardType != .aquarium3D || !hudHidden)
            && TimelineLayoutMode.forDashboard(width: width) == .compact
        #else
        false
        #endif
    }

    private var compactTimelineActions: some View {
        HStack(spacing: 8) {
            Button(action: toggleViewingMode) {
                Image(systemName: hudHidden ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
            }
            .accessibilityLabel(hudHidden ? "Show dashboard" : "View aquarium")
            .accessibilityIdentifier("dashboard-viewing-mode")
            .help(hudHidden ? "Show dashboard" : "View aquarium")
            if showsSettingsGear {
                Button(action: openSettings) { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
                    .help("Settings")
            }
        }
        .font(.callout)
        .foregroundStyle(TerrariumHUD.subtext)
        .buttonStyle(.borderless)
    }

    /// Floating attention theater — mirrors the menubar's Option D hero card
    /// but in terrarium palette. When any session awaits input we pin it to
    /// top-center of the canvas (landscape) / top (portrait) so the user can
    /// answer without opening the menubar or digging through the session
    /// list. Respects the bridge-disconnected case: if the overlay is
    /// showing we suppress it (ConnectionOverlay owns the screen).
    private var showsFloatingAttention: Bool {
        #if os(macOS)
        return false
        #else
        return true
        #endif
    }

    private func attentionCard(for session: SessionInfo) -> some View {
        let isFocused = session.id == effectiveFocusedSessionId
        return AttentionTheaterHUD(
            session: session, question: questionFor(session), queuedCount: max(0, attentionSessions.count - 1),
            options: attentionOptions(for: session, isFocused: isFocused),
            promptType: session.promptType ?? (isFocused ? stateHolder.state.promptType : nil),
            cursorIndex: isFocused ? stateHolder.state.cursorIndex : 0,
            navigable: session.controlMode == "observed" ? false
                : (isFocused ? stateHolder.state.navigable : false),
            respond: { index in respondToAwaiting(index, session: session) },
            onFocus: { stateHolder.sendCommand(.focusSession(sessionId: session.id)) }
        )
    }

    @ViewBuilder
    private func attentionTheaterLayer(geo: GeometryProxy) -> some View {
        if showsFloatingAttention, !hudHidden, stateHolder.state.bridgeConnected,
           let featured = featuredAwaitingSession {
            let landscape = geo.size.width > geo.size.height
            VStack {
                attentionCard(for: featured)
                    .frame(maxWidth: landscape ? 460 : .infinity)
                .background(GeometryReader { size in
                    Color.clear
                        .onAppear { attentionHeight = size.size.height }
                        .onChange(of: size.size.height) { _, height in attentionHeight = height }
                })
                .padding(.horizontal, landscape ? 0 : 12)
                #if os(macOS)
                .padding(.top, DashboardHUDLayout.headerHeight + 6)
                #else
                .padding(.top, landscape ? 14 : 10)
                #endif
                Spacer()
            }
            .transition(.move(edge: .top).combined(with: .opacity))
            .animation(.easeInOut(duration: 0.25), value: featured.id)
            .allowsHitTesting(true)
        }
    }

    /// Surface a compact "needs setup" card at the bottom-leading of the
    /// monitor when one of the optional integrations (Claude quota, OpenClaw
    /// Gateway auth, hook consent) isn't wired up. The card gives the user
    /// a single tap into Settings instead of leaving them to infer from
    /// creature behavior that something is wrong. Suppressed when the
    /// bridge itself is disconnected (ConnectionOverlay owns the screen)
    /// and when nothing needs setup (steady state stays clean).
    /// Always false outside Debug — the capture pin does not exist in shipped
    /// builds, so the Setup card behaves exactly as before for real users.
    private var isCaptureFeedPinned: Bool {
        #if DEBUG
        stateHolder.isCaptureFeedPinned
        #else
        false
        #endif
    }

    @ViewBuilder
    private func setupNeededLayer(geo: GeometryProxy) -> some View {
        if stateHolder.state.bridgeConnected {
            #if os(macOS)
            let items = stateHolder.setupNeededItems(
                preferences: preferences,
                daemonService: daemonService
            )
            #else
            let items = stateHolder.setupNeededItems(preferences: preferences)
            #endif
            if !items.isEmpty, !isCaptureFeedPinned {
                let setupLeadingInset = DashboardHUDLayout.setupCardLeadingInset(
                    availableWidth: geo.size.width,
                    isLandscape: geo.size.width > geo.size.height,
                    showsSessionList: preferences.showSessionList
                )
                VStack {
                    Spacer()
                    HStack {
                        setupCard(items: items)
                            .padding(.leading, setupLeadingInset)
                            .padding(.bottom, preferences.showTimeline
                                     ? geo.size.height * MonitorLayout.sandFraction + 14
                                     : 18)
                        Spacer()
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .bottom)))
                .animation(.easeInOut(duration: 0.25), value: items.count)
            }
        }
    }

    /// Build the Setup card, handing the macOS variant the `daemonService` it
    /// needs to perform an inline OpenClaw token import + adapter reconnect. iOS
    /// has no import affordance (it routes users to the Mac), so it constructs
    /// the card without it.
    @ViewBuilder
    private func setupCard(items: [SetupItem]) -> some View {
        #if os(macOS)
        SetupNeededCard(items: items, daemonService: daemonService)
        #else
        SetupNeededCard(items: items)
        #endif
    }

    /// Sessions currently waiting for user input, sorted by `sessionRank`.
    private var attentionSessions: [SessionInfo] {
        DashboardDataRules.sortSessions(
            stateHolder.state.siblingSessions
                .filter { $0.alive }
                .filter {
                let s = AgentConnectionState(rawValue: $0.state ?? "idle") ?? .idle
                return s.isAwaiting
            }
        )
    }

    /// Local navigation wins for the visible question. Control focus remains
    /// separate so inspecting a session cannot retarget connected hardware.
    private var featuredAwaitingSession: SessionInfo? {
        MonitorAttentionSelection.featuredSession(
            in: attentionSessions,
            inspectedSessionID: inspection.sessionId,
            controlFocusedSessionID: effectiveFocusedSessionId)
    }

    private var effectiveFocusedSessionId: String? {
        stateHolder.state.focusedSessionId ?? stateHolder.state.sessionId
    }

    /// Question text for the featured session. Only the focused session has
    /// a live prompt (bridge streams one at a time), so for non-focused
    /// awaiting sessions we return nil and the card just shows the
    /// "needs attention" label without a specific question.
    private func questionFor(_ session: SessionInfo) -> String? {
        // Per-session question (observed gated PreToolUse / Notification message)
        // wins — it's attached to the SessionInfo, not the aggregate state.
        if let q = session.question, !q.isEmpty { return q }
        if session.id == effectiveFocusedSessionId {
            return stateHolder.state.question
        }
        return nil
    }

    /// Options to render in the attention HUD. Hook-observed AskUserQuestion
    /// sessions carry a per-session display-only copy; managed PTY sessions
    /// continue to use the focused aggregate state.
    private func attentionOptions(for session: SessionInfo, isFocused: Bool) -> [PromptOption] {
        if session.controlMode == "observed" {
            return session.options ?? []
        }
        // Borrow the aggregate live options only when the latest awaiting
        // state_update is attributed to THIS session (a managed PTY session).
        // Showing leftover options from another session would render dead,
        // mismatched buttons — return [] and let the HUD show "respond in terminal".
        guard isFocused,
              stateHolder.state.sessionId == session.id,
              stateHolder.state.state.isAwaiting,
              !stateHolder.state.options.isEmpty else {
            return []
        }
        return stateHolder.state.options
    }

    /// Dispatch a response to the featured session via the canonical
    /// `select_option` path. `focusSession` keeps the UI's notion of focus in
    /// step, but the answer addresses the session by id rather than relying on
    /// that relay landing first. The question echo lets the daemon drop a press
    /// that answers a question the prompt has already moved past.
    private func respondToAwaiting(_ index: Int, session: SessionInfo) {
        if let requestId = session.requestId, requestId.hasPrefix("ocperm:") {
            if let choice = ObservedAgentRules.openCodePermissionChoices.first(where: { $0.index == index }) {
                stateHolder.sendCommand(.permissionDecision(requestId: requestId, decision: choice.decision))
            }
            return
        }
        stateHolder.sendCommand(.focusSession(sessionId: session.id))
        stateHolder.sendCommand(.selectOption(
            index: index, sessionId: session.id, question: questionFor(session)))
    }

    #if os(iOS)
    private var directControls: some View {
        HStack(spacing: 4) {
            Spacer(minLength: 0)
            if hudHidden {
                viewingModeButton
            }
            Menu {
                Button("Rotate screen", systemImage: "rectangle.portrait.rotate", action: rotateScreen)
                if !hudHidden {
                    Button("View aquarium only", systemImage: "arrow.up.left.and.arrow.down.right",
                           action: toggleViewingMode)
                }
                if !showsSettingsGear {
                    Button("Settings", systemImage: "gearshape", action: openSettings)
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .font(.title2)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(TerrariumHUD.subtext)
            .accessibilityLabel("Direct display options")

            if showsSettingsGear {
                settingsGearButton
            }
        }
        .padding(.horizontal, 12)
    }
    #else
    private var settingsLayer: some View {
        VStack {
            Spacer()
            HStack {
                Spacer()
                viewingModeButton
                if showsSettingsGear {
                    settingsGearButton
                }
            }
        }
    }
    #endif

    private var showsSettingsGear: Bool {
        preferences.showSettingsButton || preferences.effectiveDashboardType == .aquarium3D
    }

    private var showsConnectionOverlay: Bool {
        #if os(iOS)
        !hudHidden
        #else
        true
        #endif
    }

    private func toggleViewingMode() {
        withAnimation(.easeInOut(duration: 0.25)) { hudHidden.toggle() }
    }

    private var viewingModeButton: some View {
        Button(action: toggleViewingMode) {
            Label(hudHidden ? "Show dashboard" : "View aquarium",
                  systemImage: hudHidden ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
                .foregroundStyle(TerrariumHUD.subtext)
                #if os(iOS)
                .font(.callout.weight(.semibold))
                .padding(.horizontal, 6)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                #else
                .labelStyle(.iconOnly)
                .font(.title2)
                .padding(16)
                #endif
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("dashboard-viewing-mode")
        .help(hudHidden ? "Show dashboard" : "View aquarium")
    }

    /// Gear icon that opens Settings. Routes through `openWindow(id:)`
    /// on macOS — Settings is now a regular `Window` scene so the
    /// NavigationSplitView sidebar-toggle lands in the titlebar instead
    /// of drifting into the sidebar header (Settings-scene limitation).
    /// iOS keeps the sheet path.
    private var settingsGearButton: some View {
        Button {
            openSettings()
        } label: {
            gearLabel
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Settings")
    }

    private var gearLabel: some View {
        Image(systemName: "gearshape")
            .font(.title2)
            #if os(iOS)
            .foregroundStyle(TerrariumHUD.subtext)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
            #else
            .foregroundStyle(.white.opacity(0.6))
            .padding(.vertical, 16)
            .padding(.trailing, 24)
            #endif
    }

    #if os(iOS)
    private func rotateScreen() {
        guard let scene = UIApplication.shared.connectedScenes.first(where: {
            $0.activationState == .foregroundActive && $0 is UIWindowScene
        }) as? UIWindowScene else { return }
        let orientation: UIInterfaceOrientationMask = scene.interfaceOrientation.isLandscape
            ? .portrait : .landscapeRight
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientation))
    }
    #endif

    @ViewBuilder
    private func toastLayer(geo: GeometryProxy) -> some View {
        if let toast = toastManager.currentToast {
            VStack {
                Spacer()
                ToastOverlay(message: toast.message, icon: toast.icon)
                    .padding(.bottom, geo.size.height * MonitorLayout.sandFraction + 8)
            }
            .animation(.easeInOut(duration: 0.3), value: toast.message)
        }
    }

    // MARK: - Actions

    private func openSettings() {
        #if os(macOS)
        NSApp.activate(ignoringOtherApps: true)
        openWindow(id: "settings")
        #else
        showSettingsSheet = true
        #endif
    }

    private func handleCreatureTap(_ sessionId: String) {
        guard let focusSessionId = focusSessionId(forCreatureHit: sessionId) else { return }
        inspection.toggle(focusSessionId, state: stateHolder.state)
    }

    private func focusSessionId(forCreatureHit sessionId: String) -> String? {
        if sessionId == "crayfish" {
            return openClawGatewaySessionId
        }
        return sessionId
    }

    private var openClawGatewaySessionId: String? {
        // Presence-driven SSOT: resolve to the emitted OpenClaw session only.
        // No raw-flag fallback — a reachable-but-unauthenticated Gateway must
        // not synthesize a phantom "openclaw-gateway" id (that was a "trace"
        // source). The daemon emits the session iff the Gateway is authenticated.
        stateHolder.state.siblingSessions.first(where: { $0.agentType == "openclaw" })?.id
    }

    private var emptyGuidePreviewAction: (() -> Void)? {
        #if os(macOS)
        return { openWindow(id: "device-preview") }
        #else
        return nil
        #endif
    }

    private func updateTerrariumState() {
        var displayState = stateHolder.state
        displayState.focusedSessionId = inspection.sessionId
        terrariumState = displayState.toTerrariumState(
            previous: terrariumState,
            subagentActivityBySession: subagentActivityForTerrarium(),
            activityAvailable: stateHolder.state.bridgeConnected
        )
    }

    /// Child activity for the creature decoration, wire census first.
    ///
    /// Two fixes live here. The census now rides `SessionInfo.subagents`, which
    /// the daemon counts from the hooks themselves — the timeline-derived
    /// fallback reads near zero in a real fan-out, because dispatch rows fold
    /// and the bounded buffer evicts. And the two sources are keyed
    /// differently: timeline rows carry the BARE uuid while `sibling.id` is
    /// `observed:<agent>:<uuid>`, so the derived map never matched an observed
    /// session at all and every such creature rendered childless. Publish both
    /// id forms so the lookup cannot miss on spelling.
    private func subagentActivityForTerrarium() -> [String: SubagentVisualActivity] {
        var merged: [String: SubagentVisualActivity] = [:]
        for (sessionId, activity) in stateHolder.timelineStore.subagentActivityBySession() {
            merged[sessionId] = activity
        }
        for sibling in stateHolder.state.siblingSessions {
            guard let census = sibling.subagents else { continue }
            let activity = SubagentVisualActivity(
                activeCount: census.active,
                lastCompletedAt: census.lastCompletedAt
            )
            merged[sibling.id] = activity
            merged[ObservedAgentRules.rawSessionId(sibling.id)] = activity
        }
        // A bare-uuid key from the fallback still has to reach a row addressed
        // by its prefixed id.
        for sibling in stateHolder.state.siblingSessions where merged[sibling.id] == nil {
            if let byRaw = merged[ObservedAgentRules.rawSessionId(sibling.id)] {
                merged[sibling.id] = byRaw
            }
        }
        return merged
    }
}

#if os(macOS)
private struct DashboardHeaderLabel: ViewModifier {
    let compact: Bool

    func body(content: Content) -> some View {
        if compact { content.labelStyle(.iconOnly) }
        else { content.labelStyle(.titleAndIcon) }
    }
}
#endif

// MARK: - State Change Modifier

/// Extracts onChange handlers to reduce body complexity for the Swift type-checker.
private struct StateChangeModifier: ViewModifier {
    @ObservedObject var stateHolder: AgentStateHolder
    let terrariumProjectionKey: String
    @Binding var previousAgentState: AgentConnectionState
    let toastManager: ToastManager
    let updateTerrariumState: () -> Void

    func body(content: Content) -> some View {
        content
            .onChange(of: stateHolder.state.state) {
                let newState = stateHolder.state.state
                handleStateTransition(from: previousAgentState, to: newState)
                previousAgentState = newState
                updateTerrariumState()
            }
            .onChange(of: terrariumProjectionKey) {
                updateTerrariumState()
            }
            .onChange(of: stateHolder.state.gatewayConnected) {
                updateTerrariumState()
            }
            .onChange(of: stateHolder.state.gatewayHasError) {
                updateTerrariumState()
            }
    }

    private func handleStateTransition(from oldState: AgentConnectionState, to newState: AgentConnectionState) {
        guard oldState != newState else { return }

        if oldState == .processing && newState.isAwaiting {
            toastManager.show(message: "Attention needed", icon: "exclamationmark.triangle")
        } else if oldState == .processing && newState == .idle {
            toastManager.show(message: "Task complete", icon: "checkmark.circle")
        } else if oldState == .idle && newState == .processing {
            toastManager.show(message: "Working...", icon: "bolt.fill")
        }
    }
}

// MARK: - Keyboard Shortcuts (macOS only)

#if os(macOS)
private struct KeyboardShortcutsModifier: ViewModifier {
    @ObservedObject var stateHolder: AgentStateHolder

    func body(content: Content) -> some View {
        content
            .focusable()
            // The focusable spans the whole window; without this macOS
            // draws a window-sized accent focus ring whose layer ghosts
            // at the old edge during live resize.
            .focusEffectDisabled()
            .onKeyPress(phases: .down) { keyPress in
                guard keyPress.modifiers.contains(.command) else { return .ignored }
                return handleCommandKey(keyPress.key)
            }
    }

    private func handleCommandKey(_ key: KeyEquivalent) -> KeyPress.Result {
        // Non-awaiting shortcuts: always live regardless of prompt state.
        switch key {
        case KeyEquivalent("."):
            stateHolder.sendCommand(.interrupt)
            return .handled
        default:
            break
        }

        // Awaiting-only shortcuts: dispatch against the actual options the
        // bridge is surfacing. Matches by explicit `option.shortcut` first
        // (e.g. "y"/"n"/"a"/"v"/"d" parsed from labels), then falls back
        // to index positions 1..9 so long multi-select lists stay
        // keyboard-drivable even without per-option shortcuts.
        guard stateHolder.state.state.isAwaiting else { return .ignored }
        let options = stateHolder.state.options
        guard !options.isEmpty else {
            // Defensive legacy fallback — Yes/No only when parser produced
            // no options (so the old ⌘Y/⌘N muscle memory keeps working).
            if key == KeyEquivalent("y") {
                stateHolder.sendCommand(.selectOption(index: 0))
                return .handled
            }
            if key == KeyEquivalent("n") {
                stateHolder.sendCommand(.selectOption(index: 1))
                return .handled
            }
            return .ignored
        }

        // Match by declared shortcut (case-insensitive single char).
        let keyChar = String(key.character).lowercased()
        if keyChar.count == 1 {
            if let hit = options.first(where: { ($0.shortcut ?? "").lowercased() == keyChar }) {
                stateHolder.sendCommand(.selectOption(index: hit.index))
                return .handled
            }
            // Match by index digit ⌘1..⌘9.
            if let digit = Int(keyChar), digit >= 1 && digit <= 9 {
                let target = digit - 1
                if options.contains(where: { $0.index == target }) {
                    stateHolder.sendCommand(.selectOption(index: target))
                    return .handled
                }
            }
        }
        return .ignored
    }
}
#endif

// MARK: - Monitor Empty-State Onboarding Overlay

/// First-run guidance card that surfaces when the Monitor has no live
/// sessions. On macOS it routes the user into the menubar's "Launch
/// Session" window or the "Device Preview" gallery so the terrarium
/// never reads as broken on day one. On iOS/iPadOS the corresponding
/// entry points don't exist (can't spawn local Claude sessions, no
/// device-preview window), so the card collapses to a single explanatory
/// line + Got-it dismiss. Dismiss flips
/// `AppPreferences.hasSeenMonitorEmptyGuide` so returning users aren't
/// re-nudged.
private struct MonitorEmptyGuideOverlay: View {
    var onPreviewDevices: (() -> Void)?
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 8) {
                Text("Start your first session.")
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(TerrariumHUD.text)
                    .multilineTextAlignment(.center)

                bodyText
                    .font(.system(size: 13))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let onPreviewDevices {
                Button {
                    onPreviewDevices()
                } label: {
                    Label("Preview Devices", systemImage: "rectangle.on.rectangle")
                        .font(.system(size: 12, weight: .medium))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.regular)
            }

            Button {
                onDismiss()
            } label: {
                Text("Got it")
                    .font(.system(size: 12))
                    .foregroundStyle(TerrariumHUD.subtext)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 22)
        .frame(maxWidth: 420)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(TerrariumHUD.bg)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(TerrariumHUD.tetraNeon.opacity(0.35), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.4), radius: 18, y: 6)
    }

    private var bodyText: Text {
        Text("Sessions appear automatically once the bridge picks one up — each one shows up here as a creature in the terrarium.")
    }
}
