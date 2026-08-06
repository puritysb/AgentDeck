// MonitorScreen.swift — Single screen: terrarium + HUD + timeline + settings gear

import SwiftUI

/// Shared Monitor overlay layout metrics. The timeline strip is sized to
/// cover the terrarium sand bed, so this derives from the terrarium SSOT
/// (TerrariumLayout.sandHeightFraction; Android mirror: TerrariumConfig.kt
/// SAND_HEIGHT_FRACTION).
enum MonitorLayout {
    static let sandFraction = CGFloat(TerrariumLayout.sandHeightFraction)
}

struct MonitorScreen: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    #if os(macOS)
    @EnvironmentObject private var daemonService: DaemonService
    @Environment(\.openWindow) private var openWindow
    #endif

    @State private var terrariumState = TerrariumState()
    #if os(iOS)
    @State private var showSettingsSheet = false
    #endif
    /// "Aquarium viewing" mode — when on, SessionListPanel + TopologyRail
    /// fade out so the user can watch the terrarium uninterrupted. Toggled
    /// by tapping empty water. Shared by macOS and iOS so the core
    /// Dashboard interaction stays consistent even though macOS has extra
    /// windows and host-side controls.
    @State private var hudHidden = false
    @State private var previousAgentState: AgentConnectionState = .disconnected
    @StateObject private var toastManager = ToastManager()

    /// Content-based key for fields that affect `DashboardState.toTerrariumState`
    /// outside the top-level connection state. The terrarium keeps its own
    /// derived state so it can animate asking-exit bursts; this key makes the
    /// derived copy move in lockstep with the left session list when focus or
    /// session metadata changes without a state/count change.
    private var terrariumProjectionKey: String {
        let primary = [
            stateHolder.state.sessionId ?? "",
            stateHolder.state.focusedSessionId ?? "",
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
            rows.append([
                session.id,
                session.agentType ?? "",
                session.state ?? "",
                session.projectName ?? "",
                session.modelName ?? "",
                "\(session.alive)",
            ].joined(separator: "|"))
        }
        rows.sort()
        return "\(primary)::\(rows.joined(separator: ","))::timeline:\(stateHolder.timelineVersion)"
    }

    var body: some View {
        mainContent
            #if os(iOS)
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
            .modifier(KeyboardShortcutsModifier(stateHolder: stateHolder))
            #endif
    }

    // MARK: - Main Content

    private var mainContent: some View {
        GeometryReader { geo in
            ZStack {
                terrariumLayer

                hudLayer(geo: geo, disconnected: !stateHolder.state.bridgeConnected)

                if !stateHolder.state.bridgeConnected {
                    ConnectionOverlay()
                }

                attentionTheaterLayer(geo: geo)

                setupNeededLayer(geo: geo)

                settingsLayer

                toastLayer(geo: geo)

                if shouldShowEmptyGuide {
                    MonitorEmptyGuideOverlay(
                        onPreviewDevices: emptyGuidePreviewAction,
                        onDismiss: { preferences.hasSeenMonitorEmptyGuide = true }
                    )
                    .transition(.opacity)
                }
            }
        }
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

    private var terrariumLayer: some View {
        TerrariumView(
            terrariumState: terrariumState,
            onCreatureTapped: handleCreatureTap,
            onBackgroundTapped: backgroundTapHandler
        )
        .ignoresSafeArea()
    }

    /// Tap handler for empty terrarium water. When the AttentionTheater
    /// card is up the user is mid-answer, so we disable the toggle to
    /// avoid an off-target tap collapsing the HUD behind the question card.
    private var backgroundTapHandler: (() -> Void)? {
        guard featuredAwaitingSession == nil else { return nil }
        return {
            withAnimation(.easeInOut(duration: 0.25)) { hudHidden.toggle() }
        }
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
    private func hudLayer(geo: GeometryProxy, disconnected: Bool) -> some View {
        MonitorHUD()
            .opacity(hudHidden || disconnected ? 0 : 1)
            .allowsHitTesting(!hudHidden && !disconnected)
            .animation(.easeInOut(duration: 0.25), value: hudHidden)

        if preferences.showTimeline {
            VStack {
                Spacer()
                TimelineStripView()
                    .frame(height: geo.size.height * MonitorLayout.sandFraction)
            }
            .opacity(disconnected ? 0 : 1)
            .allowsHitTesting(!disconnected)
        }
    }

    /// Floating attention theater — mirrors the menubar's Option D hero card
    /// but in terrarium palette. When any session awaits input we pin it to
    /// top-center of the canvas (landscape) / top (portrait) so the user can
    /// answer without opening the menubar or digging through the session
    /// list. Respects the bridge-disconnected case: if the overlay is
    /// showing we suppress it (ConnectionOverlay owns the screen).
    @ViewBuilder
    private func attentionTheaterLayer(geo: GeometryProxy) -> some View {
        if stateHolder.state.bridgeConnected,
           let featured = featuredAwaitingSession {
            let awaiting = attentionSessions
            let queued = max(0, awaiting.count - 1)
            let landscape = geo.size.width > geo.size.height
            let isFeaturedFocused = featured.id == effectiveFocusedSessionId
            VStack {
                AttentionTheaterHUD(
                    session: featured,
                    question: questionFor(featured),
                    queuedCount: queued,
                    options: attentionOptions(for: featured, isFocused: isFeaturedFocused),
                    promptType: featured.promptType
                        ?? (isFeaturedFocused ? stateHolder.state.promptType : nil),
                    cursorIndex: isFeaturedFocused ? stateHolder.state.cursorIndex : 0,
                    navigable: featured.controlMode == "observed"
                        ? false
                        : (isFeaturedFocused ? stateHolder.state.navigable : false),
                    respond: { index in respondToAwaiting(index, session: featured) },
                    onFocus: { stateHolder.sendCommand(.focusSession(sessionId: featured.id)) }
                )
                .frame(maxWidth: landscape ? 460 : .infinity)
                .padding(.horizontal, landscape ? 0 : 12)
                .padding(.top, landscape ? 14 : 10)
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
                VStack {
                    Spacer()
                    HStack {
                        setupCard(items: items)
                            .padding(.leading, 14)
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

    /// Which awaiting session to feature: prefer the currently-focused one
    /// (so the user's active context wins), then fall back to sort order.
    private var featuredAwaitingSession: SessionInfo? {
        if let focusedId = effectiveFocusedSessionId,
           let focused = attentionSessions.first(where: { $0.id == focusedId }) {
            return focused
        }
        return attentionSessions.first
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
        stateHolder.sendCommand(.focusSession(sessionId: session.id))
        stateHolder.sendCommand(.selectOption(
            index: index, sessionId: session.id, question: questionFor(session)))
    }

    @ViewBuilder
    private var settingsLayer: some View {
        #if os(iOS)
        VStack {
            Spacer()
            HStack {
                Spacer()
                rotationButton
                if preferences.showSettingsButton {
                    settingsGearButton
                }
            }
        }
        #else
        if preferences.showSettingsButton {
            VStack {
                Spacer()
                HStack {
                    Spacer()
                    settingsGearButton
                }
            }
        }
        #endif
    }

    /// Gear icon that opens Settings. Routes through `openWindow(id:)`
    /// on macOS — Settings is now a regular `Window` scene so the
    /// NavigationSplitView sidebar-toggle lands in the titlebar instead
    /// of drifting into the sidebar header (Settings-scene limitation).
    /// iOS keeps the sheet path.
    @ViewBuilder
    private var settingsGearButton: some View {
        Button {
            openSettings()
        } label: {
            gearLabel
        }
        .buttonStyle(.plain)
    }

    private var gearLabel: some View {
        Image(systemName: "gearshape")
            .font(.title2)
            .foregroundStyle(.white.opacity(0.6))
            .padding(.vertical, 16)
            .padding(.trailing, 24)
    }

    #if os(iOS)
    private var rotationButton: some View {
        Button {
            guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene else { return }
            let prefs: UIWindowScene.GeometryPreferences.iOS
            if scene.interfaceOrientation.isLandscape {
                prefs = UIWindowScene.GeometryPreferences.iOS(interfaceOrientations: .portrait)
            } else {
                prefs = UIWindowScene.GeometryPreferences.iOS(interfaceOrientations: .landscapeRight)
            }
            scene.requestGeometryUpdate(prefs)
        } label: {
            Image(systemName: "rectangle.portrait.rotate")
                .font(.title3)
                .foregroundStyle(.white.opacity(0.35))
                .padding(.vertical, 16)
                .padding(.trailing, 4)
        }
        .buttonStyle(.plain)
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
        if stateHolder.state.focusedSessionId == focusSessionId {
            stateHolder.sendCommand(.clearSessionFocus)
        } else {
            stateHolder.sendCommand(.focusSession(sessionId: focusSessionId))
        }
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
        terrariumState = stateHolder.state.toTerrariumState(
            previous: terrariumState,
            subagentActivityBySession: stateHolder.timelineStore.subagentActivityBySession()
        )
    }
}

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
        case .return:
            stateHolder.sendCommand(.respond(value: "go on"))
            return .handled
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
