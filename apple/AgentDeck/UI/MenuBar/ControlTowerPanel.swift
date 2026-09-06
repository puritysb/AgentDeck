// ControlTowerPanel.swift — Rich MenuBarExtra panel for macOS
// Replaces the simple .menu style with a window-style control tower

#if os(macOS)
import SwiftUI
import IOKit
import IOKit.hid
import AppKit

struct ControlTowerPanel: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var daemonService: DaemonService
    @EnvironmentObject private var preferences: AppPreferences
    @Environment(\.openWindow) private var openWindow

    /// Cached Stream Deck detection result. Refreshed on view appear and via
    /// a lightweight 5s timer while the panel is visible. We never want to
    /// run IOHIDManager enumeration inside a SwiftUI view body (it is not
    /// cheap enough to do on every state tick), so a cached @State holds
    /// the previous verdict until the timer fires.
    @State private var streamDeckDetection: StreamDeckDetection = StreamDeckDetection(
        elgatoAppInstalled: false,
        streamDeckPlusConnected: false,
        pluginInstalled: false
    )
    @State private var streamDeckDetectionLastRun: Date? = nil

    /// Whether the Dashboard window is currently visible. Drives the
    /// pill's filled/outline visual state so the menubar reads as the
    /// canonical visibility switch. Updated by the 5s timer + immediate
    /// NotificationCenter observers below.
    @State private var dashboardVisible: Bool = false

    /// Room the popup window actually has, measured from its own top edge down
    /// to the bottom of *its* screen's usable area. 0 until the hosting window
    /// exists, which falls `availablePanelHeight` back to the screen estimate.
    @State private var measuredAvailableHeight: CGFloat = 0

    /// Compact, already-deduplicated Swift/CLI activity projection shown in
    /// the right-hand glance pane. It is fetched only while this popup exists
    /// and no more than once per 30 seconds; a transient failure leaves the
    /// last good snapshot visible instead of flashing the panel empty.
    @State private var activitySnapshot: ApmeActivityHistory.Snapshot? = nil
    @State private var activityRefreshInFlight = false
    @State private var activityRefreshAttempted = false
    @State private var activityLastRefresh: Date? = nil
    @State private var idleSessionsExpanded = false
    @State private var fullTopologyExpanded = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 0) {
                primaryPanel
                    .frame(width: MenuBarDensityPolicy.sessionColumnWidth)

                Divider()
                    .overlay(DesignTokens.Tide.s50.opacity(0.08))

                overviewPanel
                    .frame(width: MenuBarDensityPolicy.overviewColumnWidth)
            }
            .frame(maxHeight: .infinity)

            bottomActionArea
        }
        .frame(
            width: MenuBarDensityPolicy.sessionColumnWidth
                + MenuBarDensityPolicy.overviewColumnWidth + 1,
            height: adaptivePanelHeight,
            alignment: .topLeading
        )
        .background(PanelAvailableHeightReader { height in
            // Ignore sub-point jitter: this feeds the ScrollView cap, which
            // resizes the window, and a 0.5pt oscillation would relayout forever.
            if abs(height - measuredAvailableHeight) > 1 { measuredAvailableHeight = height }
        })
        // Dark ocean theme matching Dashboard / Monitor HUD.
        // `deepSea` → `midWater` gives the popup a subtle gradient so the
        // top edge reads as shallower water and the bottom reads as the
        // deck floor, echoing the rest of the app's aquarium metaphor.
        .background(
            LinearGradient(
                colors: [TerrariumColors.deepSea, TerrariumColors.midWater],
                startPoint: .top,
                endPoint: .bottom
            )
        )
        .foregroundColor(TerrariumHUD.text)
        .onAppear {
            refreshStreamDeckDetectionIfStale()
            dashboardVisible = evaluateDashboardVisibility()
            refreshActivitySummaryIfStale(force: true)
        }
        .onReceive(
            Timer.publish(every: 5, on: .main, in: .common).autoconnect()
        ) { _ in
            refreshStreamDeckDetectionIfStale()
            dashboardVisible = evaluateDashboardVisibility()
            refreshActivitySummaryIfStale()
        }
        // NSWindow notifications give us immediate response to user gestures
        // (⌘W, traffic-light close, miniaturize) without waiting for the 5s
        // timer tick. willClose fires while the window is still listed as
        // visible, so re-evaluate on the next runloop iteration.
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            dashboardVisible = evaluateDashboardVisibility()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.willCloseNotification)) { _ in
            DispatchQueue.main.async { dashboardVisible = evaluateDashboardVisibility() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didMiniaturizeNotification)) { _ in
            dashboardVisible = evaluateDashboardVisibility()
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didDeminiaturizeNotification)) { _ in
            dashboardVisible = evaluateDashboardVisibility()
        }
    }

    private var primaryPanel: some View {
        VStack(spacing: 0) {
            // Header: Attention Theater when any session awaits input,
            // otherwise a quiet "all calm" strip with the AgentDeck mark.
            Group {
                if let awaiting = featuredAwaitingSession {
                    let isFocused = awaiting.id == effectiveFocusedSessionId
                    AttentionTheaterView(
                        session: awaiting,
                        question: questionFor(awaiting),
                        options: attentionOptions(for: awaiting, isFocused: isFocused),
                        promptType: isFocused ? stateHolder.state.promptType : nil,
                        cursorIndex: isFocused ? stateHolder.state.cursorIndex : 0,
                        navigable: isFocused ? stateHolder.state.navigable : false,
                        respond: { index in respondToAwaiting(index, session: awaiting) }
                    )
                } else {
                    CalmHeaderView(
                        sessionCount: sortedSessions.count,
                        processingCount: activeSessions.count,
                        daemonPort: daemonService.port,
                        bridgeConnected: daemonService.isRunning || daemonService.isUsingExternalDaemon
                    )
                }
            }

            sessionsPane
                .frame(maxHeight: .infinity)
        }
    }

    private var overviewPanel: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                activitySummaryPanel

                Divider()
                    .overlay(DesignTokens.Tide.s50.opacity(0.08))

                compactUsageSummary
                    .padding(14)

                Divider()
                    .overlay(DesignTokens.Tide.s50.opacity(0.08))

                adaptiveTopologySummary
                    .padding(14)
            }
        }
        .background(DesignTokens.UI.popupBgDeep.opacity(0.18))
    }

    /// True when a window with the dashboard scene id is on screen and not
    /// minimized. Cheap enough to call on every tick — `NSApp.windows` is a
    /// single Array lookup, no IPC.
    private func evaluateDashboardVisibility() -> Bool {
        NSApp.windows.contains {
            $0.identifier?.rawValue == "dashboard"
                && $0.isVisible
                && !$0.isMiniaturized
        }
    }

    /// The session the attention theater should feature. Prefers the
    /// currently-focused session if it's awaiting; otherwise picks the
    /// first awaiting session in sort order.
    private var featuredAwaitingSession: SessionInfo? {
        if let focusedId = effectiveFocusedSessionId,
           let focused = sortedSessions.first(where: { $0.id == focusedId }),
           sessionState(focused).isAwaiting {
            return focused
        }
        return attentionSessions.first
    }

    /// Prompt question text tied to a session. Observed sessions carry their own
    /// question on the roster row; managed ones only have the live aggregate
    /// prompt, which belongs to the focused session, so anything else shows a
    /// generic "needs input" tag.
    private func questionFor(_ session: SessionInfo) -> String? {
        if let own = session.question, !own.isEmpty { return own }
        if session.id == effectiveFocusedSessionId {
            return stateHolder.state.question
        }
        return nil
    }

    private var effectiveFocusedSessionId: String? {
        stateHolder.state.focusedSessionId ?? stateHolder.state.sessionId
    }

    /// Options to render in the menubar theater. Observed (hook-only) sessions
    /// carry their own per-session copy; managed PTY sessions mirror the
    /// focused live options ONLY when they genuinely belong to that session.
    /// Mirrors `MonitorScreen.attentionOptions`. Whether the rendered options
    /// are pressable is a separate question the HUD answers from
    /// `liveAnswerable` — showing them is never the same as claiming they work.
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

    private func respondToAwaiting(_ optionIndex: Int, session: SessionInfo) {
        // `selectOption` is the canonical path (same as D200H + Cmd+Y/N/A).
        // Focus keeps the UI in step, but the answer addresses the session by
        // id rather than depending on the relay landing first; the question
        // echo lets the daemon drop a press aimed at a superseded question.
        stateHolder.sendCommand(.focusSession(sessionId: session.id))
        stateHolder.sendCommand(.selectOption(
            index: optionIndex, sessionId: session.id, question: questionFor(session)))
    }

    /// Recompute Stream Deck app/hardware detection if the cached verdict is
    /// older than 5 seconds (or we've never run it). IOHIDManager enumeration
    /// is cheap but non-free — don't spin it every SwiftUI tick.
    private func refreshStreamDeckDetectionIfStale() {
        if let last = streamDeckDetectionLastRun,
           Date().timeIntervalSince(last) < 5.0 {
            return
        }
        streamDeckDetection = StreamDeckDetection.detect()
        streamDeckDetectionLastRun = Date()
    }

    // MARK: - Activity glance

    private var activitySummaryPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("ACTIVITY")
                        .font(.system(size: 10, weight: .bold))
                        .kerning(0.6)
                        .foregroundStyle(TerrariumHUD.subtext)
                    Text("Agent work at a glance")
                        .font(.system(size: 13, weight: .semibold))
                }

                Spacer(minLength: 6)

                Button(action: openApmeDashboard) {
                    HStack(spacing: 4) {
                        Text("Full report")
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 9, weight: .bold))
                    }
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(daemonService.port > 0 ? TerrariumColors.tetraNeon : TerrariumHUD.subtext)
                }
                .buttonStyle(.plain)
                .disabled(daemonService.port == 0)
                .help("Open the complete Activity and Evaluation report")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            Divider()
                .overlay(Color.white.opacity(0.08))

            activitySummaryContent
                .padding(14)
        }
        .background(Color.black.opacity(0.14))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Agent activity summary")
    }

    @ViewBuilder
    private var activitySummaryContent: some View {
        if daemonService.port == 0 {
            activityEmptyState(
                icon: "bolt.slash",
                title: "Daemon offline",
                detail: "Start the daemon to load activity."
            )
        } else if let snapshot = activitySnapshot, !snapshot.rows.isEmpty {
            let glance = MenuBarActivityGlance.make(from: snapshot)
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("\(glance.completedCount) completed")
                            .font(.system(size: 23, weight: .semibold, design: .rounded))
                            .foregroundStyle(TerrariumHUD.text)
                        Text(activityScopeLabel(glance))
                            .font(.system(size: 10))
                            .foregroundStyle(TerrariumHUD.subtext)
                    }
                    Spacer()
                    Text(activityFreshnessLabel(snapshot))
                        .font(.system(size: 9.5, weight: .medium))
                        .foregroundStyle(activityFreshnessColor(snapshot))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 3)
                        .background(Capsule().fill(Color.white.opacity(0.07)))
                }

                if glance.agents.isEmpty {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("No completed work in the last 24h")
                            .font(.system(size: 10.5, weight: .medium))
                        if let lastCompletedAt = glance.lastCompletedAt {
                            Text("Last completion \(relativeActivityTime(lastCompletedAt))")
                                .font(.system(size: 9.5))
                                .foregroundStyle(TerrariumHUD.subtext)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 7)
                            .fill(Color.white.opacity(0.045))
                    )
                } else {
                    VStack(spacing: 5) {
                        ForEach(glance.agents) { agent in
                            activityAgentRow(agent)
                        }
                    }
                }

                if !glance.recentRows.isEmpty {
                    Divider()
                        .overlay(Color.white.opacity(0.08))

                    VStack(alignment: .leading, spacing: 7) {
                        Text(glance.completedRowCount > glance.recentRows.count
                            ? "RECENTLY COMPLETED · LATEST \(glance.recentRows.count)"
                            : "RECENTLY COMPLETED")
                            .font(.system(size: 9.5, weight: .bold))
                            .kerning(0.45)
                            .foregroundStyle(TerrariumHUD.subtext)

                        ForEach(glance.recentRows, id: \.originKey) { row in
                            activityTaskRow(row)
                        }
                    }
                }
            }
        } else if activityRefreshInFlight && !activityRefreshAttempted {
            VStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading activity…")
                    .font(.system(size: 10.5))
                    .foregroundStyle(TerrariumHUD.subtext)
            }
            .frame(maxWidth: .infinity, minHeight: 112)
        } else if activityRefreshAttempted, activitySnapshot == nil {
            activityEmptyState(
                icon: "exclamationmark.arrow.triangle.2.circlepath",
                title: "Summary unavailable",
                detail: "Try again when the daemon is ready."
            )
        } else {
            activityEmptyState(
                icon: "clock.arrow.circlepath",
                title: "No activity yet",
                detail: "Completed agent work appears here automatically."
            )
        }
    }

    private func activityAgentRow(_ agent: MenuBarActivityAgent) -> some View {
        HStack(spacing: 7) {
            SessionCreatureIcon(
                agentType: agent.agentType,
                tint: SessionBrand.color(for: agent.agentType),
                size: 14,
                contentInset: 1
            )
            Text(displayAgentLabel(agent.agentType))
                .font(.system(size: 10.5, weight: .medium))
                .lineLimit(1)
            Spacer(minLength: 5)
            VStack(alignment: .trailing, spacing: 1) {
                Text("\(agent.completedCount) completed")
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                Text(relativeActivityTime(agent.lastCompletedAt))
                    .font(.system(size: 9))
                    .foregroundStyle(TerrariumHUD.subtext)
            }
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(Color.white.opacity(0.055))
        )
    }

    private func activityTaskRow(_ row: ApmeActivityHistory.Row) -> some View {
        HStack(alignment: .top, spacing: 7) {
            SessionCreatureIcon(
                agentType: row.agentType,
                tint: SessionBrand.color(for: row.agentType),
                size: 15,
                contentInset: 1
            )
            .padding(.top, 1)

            VStack(alignment: .leading, spacing: 2) {
                Text(row.task)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(TerrariumHUD.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text(activityTaskMetadata(row))
                    .font(.system(size: 9.5))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func activityEmptyState(icon: String, title: String, detail: String) -> some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 17))
                .foregroundStyle(TerrariumHUD.subtext)
            Text(title)
                .font(.system(size: 11, weight: .semibold))
            Text(detail)
                .font(.system(size: 10))
                .foregroundStyle(TerrariumHUD.subtext)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 112)
    }

    private func relativeActivityTime(_ milliseconds: Int) -> String {
        let seconds = max(0, Int(Date().timeIntervalSince1970) - milliseconds / 1_000)
        if seconds < 60 { return "now" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h ago" }
        return "\(hours / 24)d ago"
    }

    private func activityScopeLabel(_ glance: MenuBarActivityGlance) -> String {
        var parts = ["last 24h"]
        if !glance.agents.isEmpty {
            parts.append("\(glance.agents.count) \(glance.agents.count == 1 ? "agent" : "agents")")
        }
        if glance.projectCount > 0 {
            parts.append("\(glance.projectCount) \(glance.projectCount == 1 ? "project" : "projects")")
        }
        return parts.joined(separator: " · ")
    }

    private func activityTaskMetadata(_ row: ApmeActivityHistory.Row) -> String {
        var parts = [displayAgentLabel(row.agentType)]
        if let project = row.projectName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !project.isEmpty {
            parts.append(project)
        }
        if let endedAt = row.endedAt {
            parts.append(relativeActivityTime(endedAt))
        }
        return parts.joined(separator: " · ")
    }

    private func activityFreshnessLabel(_ snapshot: ApmeActivityHistory.Snapshot) -> String {
        let ageSeconds = max(0, Int(Date().timeIntervalSince1970) - snapshot.capturedAt / 1_000)
        if ageSeconds < 60 { return "Updated now" }
        if ageSeconds < 3_600 { return "Updated \(ageSeconds / 60)m ago" }
        return "Data \(ageSeconds / 3_600)h old"
    }

    private func activityFreshnessColor(_ snapshot: ApmeActivityHistory.Snapshot) -> Color {
        let ageSeconds = max(0, Int(Date().timeIntervalSince1970) - snapshot.capturedAt / 1_000)
        return ageSeconds < 3_600 ? TerrariumHUD.subtext : DesignTokens.UI.attn
    }

    private func refreshActivitySummaryIfStale(force: Bool = false) {
        guard daemonService.port > 0, !activityRefreshInFlight else { return }
        if !force, let last = activityLastRefresh,
           Date().timeIntervalSince(last) < 30 {
            return
        }

        let port = Int(daemonService.port)
        let token = AuthManager.shared.token
        activityRefreshInFlight = true
        Task { @MainActor in
            let snapshot = await ApmeActivityHistory.fetchSnapshot(port: port, token: token)
            if Int(daemonService.port) == port, let snapshot {
                activitySnapshot = snapshot
            }
            activityRefreshAttempted = true
            activityLastRefresh = Date()
            activityRefreshInFlight = false
        }
    }

    // MARK: - Layout sizing

    /// Vertical room the popup has to lay itself out in.
    ///
    /// Measured from the hosting window's own top edge, NOT from a screen
    /// height. `NSScreen.main` is the screen holding the *key window*, which on
    /// a multi-display desk is routinely not the screen the menubar popup opened
    /// on — sizing the body against a taller neighbouring display is what pushed
    /// the footer's "Start at Login / Quit" row off the bottom edge. Measuring
    /// the window also folds in the menu-bar gap and the popup's own top inset,
    /// neither of which a screen height accounts for.
    ///
    /// Falls back to the screen estimate only for the first frame, before the
    /// hosting window exists.
    private var availablePanelHeight: CGFloat {
        if measuredAvailableHeight > 0 { return measuredAvailableHeight }
        return NSScreen.main?.visibleFrame.height ?? 900
    }

    /// The popup is a bounded command glance, not a miniature Dashboard.
    /// Its height therefore follows the screen budget but never the number of
    /// sessions or connected surfaces. Both columns scroll internally if a
    /// pathological attention prompt consumes more than its normal share.
    private var adaptivePanelHeight: CGFloat {
        MenuBarDensityPolicy.panelHeight(availableHeight: availablePanelHeight)
    }

    // MARK: - Session Classification

    private var sortedSessions: [SessionInfo] {
        stateHolder.state.siblingSessions
            .filter { $0.alive }
            .sorted { lhs, rhs in
                let lr = sessionRank(lhs)
                let rr = sessionRank(rhs)
                if lr != rr { return lr < rr }
                let projectCompare = DashboardDataRules.naturalLabelCompare(lhs.projectName ?? "", rhs.projectName ?? "")
                if projectCompare != .orderedSame { return projectCompare == .orderedAscending }
                return DashboardDataRules.naturalLabelCompare(lhs.id, rhs.id) == .orderedAscending
            }
    }

    private var attentionSessions: [SessionInfo] {
        sortedSessions.filter { sessionState($0).isAwaiting }
    }

    private var activeSessions: [SessionInfo] {
        sortedSessions.filter { sessionState($0) == .processing }
    }

    private var idleSessions: [SessionInfo] {
        sortedSessions.filter {
            let s = sessionState($0)
            return s == .idle || s == .disconnected
        }
    }

    private func sessionState(_ session: SessionInfo) -> AgentConnectionState {
        AgentConnectionState(rawValue: session.state ?? "idle") ?? .idle
    }

    private func sessionRank(_ session: SessionInfo) -> Int {
        switch sessionState(session) {
        case .processing: return 0
        case .awaitingPermission, .awaitingOption, .awaitingDiff: return 1
        case .idle: return 2
        case .disconnected: return 3
        }
    }

    // MARK: - Sessions list

    private var remainingAttentionSessions: [SessionInfo] {
        guard let featured = featuredAwaitingSession else { return attentionSessions }
        return attentionSessions.filter { $0.id != featured.id }
    }

    private var sessionsPane: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 7) {
                Text("SESSIONS")
                    .font(.system(size: 10, weight: .bold))
                    .kerning(0.5)
                    .foregroundStyle(TerrariumHUD.subtext)
                Spacer(minLength: 6)
                sessionCountChip(activeSessions.count, label: "working", color: DesignTokens.UI.cyan)
                sessionCountChip(attentionSessions.count, label: "waiting", color: DesignTokens.UI.attn)
                sessionCountChip(idleSessions.count, label: "idle", color: DesignTokens.UI.idle)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)

            Divider()
                .overlay(DesignTokens.Tide.s50.opacity(0.08))

            if sortedSessions.isEmpty {
                VStack(spacing: 6) {
                    Text("No active sessions")
                        .font(.system(size: 11, weight: .medium))
                    Text("Sessions appear automatically when AgentDeck observes one.")
                        .font(.system(size: 10))
                        .foregroundStyle(TerrariumHUD.subtext)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(18)
            } else {
                ScrollView(.vertical, showsIndicators: true) {
                    VStack(alignment: .leading, spacing: 13) {
                        if !remainingAttentionSessions.isEmpty {
                            sessionGroup(
                                title: featuredAwaitingSession == nil ? "NEEDS YOU" : "ALSO NEEDS YOU",
                                sessions: remainingAttentionSessions,
                                color: DesignTokens.UI.attn
                            )
                        }
                        if !activeSessions.isEmpty {
                            sessionGroup(
                                title: "WORKING",
                                sessions: activeSessions,
                                color: DesignTokens.UI.cyan
                            )
                        }
                        idleSessionsSection
                        if remainingAttentionSessions.isEmpty,
                           activeSessions.isEmpty,
                           idleSessions.isEmpty,
                           featuredAwaitingSession != nil {
                            Text("The session needing input is shown above.")
                                .font(.system(size: 10))
                                .foregroundStyle(TerrariumHUD.subtext)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.vertical, 12)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                }
            }
        }
    }

    private func sessionCountChip(_ count: Int, label: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 5, height: 5)
            Text("\(count) \(label)")
                .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                .foregroundStyle(count > 0 ? TerrariumHUD.text : TerrariumHUD.subtext)
        }
        .accessibilityElement(children: .combine)
    }

    private func sessionGroup(title: String, sessions: [SessionInfo], color: Color) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 5) {
                Circle().fill(color).frame(width: 5, height: 5)
                Text(title)
                    .font(.system(size: 9.5, weight: .bold))
                    .kerning(0.45)
                    .foregroundStyle(TerrariumHUD.subtext)
                Text("\(sessions.count)")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
            }

            VStack(spacing: 4) {
                ForEach(sessions) { session in
                    SessionJumpRow(
                        session: session,
                        tool: currentToolFor(session),
                        onFocus: {
                            stateHolder.sendCommand(.focusSession(sessionId: session.id))
                        }
                    )
                }
            }
        }
    }

    @ViewBuilder
    private var idleSessionsSection: some View {
        if !idleSessions.isEmpty {
            let inlineCount = MenuBarDensityPolicy.inlineIdleSessionCount(
                totalSessionCount: sortedSessions.count,
                idleSessionCount: idleSessions.count
            )
            let visibleIdle = idleSessionsExpanded ? idleSessions : Array(idleSessions.prefix(inlineCount))
            let hiddenCount = idleSessions.count - visibleIdle.count

            if !visibleIdle.isEmpty {
                sessionGroup(title: "IDLE", sessions: visibleIdle, color: DesignTokens.UI.idle)
            }

            if hiddenCount > 0 {
                idleDisclosureButton(
                    title: inlineCount == 0
                        ? "Idle sessions \(idleSessions.count)"
                        : "\(hiddenCount) idle \(hiddenCount == 1 ? "session" : "sessions") hidden",
                    actionLabel: "Show all",
                    systemImage: "chevron.down"
                ) {
                    idleSessionsExpanded = true
                }
            } else if idleSessionsExpanded && inlineCount < idleSessions.count {
                idleDisclosureButton(
                    title: "All \(idleSessions.count) idle sessions shown",
                    actionLabel: "Collapse",
                    systemImage: "chevron.up"
                ) {
                    idleSessionsExpanded = false
                }
            }
        }
    }

    private func idleDisclosureButton(
        title: String,
        actionLabel: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Circle()
                    .fill(DesignTokens.UI.idle)
                    .frame(width: 5, height: 5)
                Text(title)
                    .font(.system(size: 9.5, weight: .medium))
                Spacer()
                Text(actionLabel)
                Image(systemName: systemImage)
                    .font(.system(size: 8, weight: .bold))
            }
            .foregroundStyle(TerrariumHUD.subtext)
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                    .fill(DesignTokens.Tide.s50.opacity(0.045))
            )
            .overlay(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                    .stroke(DesignTokens.Tide.s50.opacity(0.10), lineWidth: 0.5)
            )
        }
        .buttonStyle(.plain)
    }

    /// Secondary text-link row below the topology. Preserves access to
    /// device preview + iPad pairing now that we removed the full devices
    /// section (the unified graph shows the ring; these actions needed a
    /// new home).
    private var utilityLinksRow: some View {
        HStack(spacing: 12) {
            Button { openDevicePreview() } label: {
                Label("Preview devices", systemImage: "rectangle.on.rectangle")
                    .font(.system(size: 10.5, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)

            Button {
                DockVisibilityController.shared.prepareToShowWindow()
                openWindow(id: "pairing-qr")
            } label: {
                Label("Pair Device", systemImage: "qrcode")
                    .font(.system(size: 10.5, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.accentColor)
            .disabled(daemonService.port == 0)
            .daemonOfflineAffordance(isOffline: daemonService.port == 0)

            Spacer()
            streamDeckPromptCompact
        }
    }

    /// Inline Stream Deck nudge — only renders when hardware is detected AND
    /// something still needs to be set up. Three cases:
    ///   • Elgato app missing  → "Stream Deck+ setup"  (opens downloads page)
    ///   • Elgato app present, plugin missing → "Install SD plugin" (opens bundled plugin / README)
    ///   • Everything present → no nudge (button hidden; nothing to do)
    @ViewBuilder
    private var streamDeckPromptCompact: some View {
        if streamDeckDetection.streamDeckPlusConnected {
            if !streamDeckDetection.elgatoAppInstalled {
                Button {
                    openStreamDeckDownloadPage()
                } label: {
                    HStack(spacing: 4) {
                        Circle().fill(Color.orange).frame(width: 5, height: 5)
                        Text("Stream Deck+ setup")
                            .font(.system(size: 10, weight: .medium))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.orange)
            } else if !streamDeckDetection.pluginInstalled {
                Button {
                    openStreamDeckPluginInstaller()
                } label: {
                    HStack(spacing: 4) {
                        Circle().fill(Color.orange).frame(width: 5, height: 5)
                        Text("Install SD plugin")
                            .font(.system(size: 10, weight: .medium))
                    }
                }
                .buttonStyle(.plain)
                .foregroundStyle(.orange)
            }
        }
    }

    // MARK: - Topology (Unified Graph)

    private var topologySection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("TOPOLOGY")
                .font(.system(size: 10, weight: .bold))
                .kerning(0.5)
                .foregroundColor(TerrariumHUD.subtext)

            MenuBarTopologyList()
        }
    }

    // MARK: - Compact rate limits

    /// Bounded quota glance for the overview column. It deliberately renders
    /// only the two canonical windows per provider; model-scoped limits and
    /// organization usage remain available in Dashboard. Their count is kept
    /// visible so compression never looks like missing data.
    @ViewBuilder
    private var compactUsageSummary: some View {
        let isApi = stateHolder.state.costLimit.map { $0 > 0 } ?? false
        let codex = stateHolder.state.codexRateLimits
        let hasClaude = stateHolder.state.fiveHourPercent != nil
            || (!isApi && stateHolder.state.sevenDayPercent != nil)
        let hasCodex = codex?.primary?.usedPercent != nil
            || codex?.secondary?.usedPercent != nil
            || codex?.credits != nil

        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Text("USAGE")
                    .font(.system(size: 9.5, weight: .bold))
                    .kerning(0.5)
                    .foregroundStyle(TerrariumHUD.subtext)
                if stateHolder.state.usageStale == true {
                    Text(stateHolder.state.claudeUsageIssue ?? "stale")
                        .font(.system(size: 9))
                        .foregroundStyle(DesignTokens.UI.attn)
                }
                Spacer()
            }

            if hasClaude {
                usageProviderHeader(agentType: "claude-code", title: "Claude")
                if let pct5h = stateHolder.state.fiveHourPercent {
                    compactGauge(
                        label: isApi ? "API" : "5h",
                        percent: pct5h,
                        resetTime: isApi ? nil : stateHolder.state.fiveHourResetsAt,
                        customSuffix: isApi
                            ? String(
                                format: "$%.2f/$%.0f",
                                stateHolder.state.costSpent ?? 0,
                                stateHolder.state.costLimit ?? 0
                            )
                            : nil
                    )
                }
                if !isApi, let pct7d = stateHolder.state.sevenDayPercent {
                    compactGauge(label: "7d", percent: pct7d, resetTime: stateHolder.state.sevenDayResetsAt)
                }
            }

            if hasCodex {
                usageProviderHeader(agentType: "codex-cli", title: "Codex")
                if let primary = codex?.primary, let percent = primary.usedPercent {
                    compactGauge(
                        label: TopologyRail.windowLabel(primary.windowMinutes),
                        percent: percent,
                        resetTime: primary.resetsAt,
                        stale: primary.stale == true,
                        footnote: CodexUsageFreshness.footnote(window: primary, capturedAt: codex?.capturedAt)
                    )
                }
                if let secondary = codex?.secondary, let percent = secondary.usedPercent {
                    compactGauge(
                        label: TopologyRail.windowLabel(secondary.windowMinutes),
                        percent: percent,
                        resetTime: secondary.resetsAt,
                        stale: secondary.stale == true,
                        footnote: CodexUsageFreshness.footnote(window: secondary, capturedAt: codex?.capturedAt)
                    )
                }
                if codex?.primary == nil, codex?.secondary == nil, let credits = codex?.credits {
                    HStack {
                        Text((codex?.limitId ?? "Credits").capitalized)
                        Spacer()
                        Text(credits.unlimited == true ? "∞ credits" : "\(credits.balance ?? "—") credits")
                            .font(.system(size: 10, weight: .medium, design: .monospaced))
                    }
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext)
                }
            }
            if let scopes = stateHolder.state.scopedLimits, !scopes.isEmpty {
                Text("Model limits · \(scopes.count) · View in Dashboard")
                    .font(.system(size: 9.5))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            if !hasClaude && !hasCodex {
                Text("Quota data appears when a provider reports it.")
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext)
            }
        }
    }

    private func usageProviderHeader(agentType: String, title: String) -> some View {
        HStack(spacing: 6) {
            SessionCreatureIcon(
                agentType: agentType,
                tint: SessionBrand.color(for: agentType),
                size: 14,
                contentInset: 1
            )
            Text(title)
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(TerrariumHUD.text)
            Spacer(minLength: 0)
        }
        .padding(.top, 2)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var adaptiveTopologySummary: some View {
        let rollup = MenuBarSurfaceRollup.make(from: stateHolder.state.moduleHealth)
        let density = MenuBarDensityPolicy.collectionDensity(count: rollup.total)

        VStack(alignment: .leading, spacing: 9) {
            if density == .detailed || fullTopologyExpanded {
                MenuBarTopologyList()
                if density != .detailed {
                    topologyDisclosureButton(
                        title: "All \(rollup.total) surface details shown",
                        actionLabel: "Collapse",
                        systemImage: "chevron.up"
                    ) {
                        fullTopologyExpanded = false
                    }
                }
            } else {
                MenuBarSurfaceSummary()
                topologyDisclosureButton(
                    title: "\(rollup.total) surface details",
                    actionLabel: "Show all",
                    systemImage: "chevron.down"
                ) {
                    fullTopologyExpanded = true
                }
            }
        }
    }

    private func topologyDisclosureButton(
        title: String,
        actionLabel: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                Spacer(minLength: 4)
                Text(actionLabel)
                Image(systemName: systemImage)
                    .font(.system(size: 8, weight: .bold))
            }
            .font(.system(size: 9.5, weight: .medium))
            .foregroundStyle(DesignTokens.UI.cyan)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                    .fill(DesignTokens.Tide.s50.opacity(0.045))
            )
        }
        .buttonStyle(.plain)
    }

    /// Claude's subscription rate limits depend on Claude Code's OAuth token,
    /// which is structurally unreachable from the App Store sandbox, so those
    /// gauges surface only when an external CLI daemon relays them. Codex
    /// limits, by contrast, are read locally from ~/.codex by the Swift daemon
    /// and arrive as gauge data directly (`codexRateLimits`). We surface this
    /// section whenever any gauge data has arrived, or an external daemon is
    /// active; otherwise it's hidden so the standalone app reads as
    /// feature-complete instead of broken.
    @ViewBuilder
    private var rateLimitsSection: some View {
        // Presence of the Codex block is NOT gauge data: the daemon also emits a
        // windowless one carrying only the account tier (a free ChatGPT plan has
        // no rolling windows, and the block still has to ride the wire so clients
        // can retract a retired plan's gauge). Gating on `!= nil` drew an empty
        // "RATE LIMITS" header for every free-tier account — most visibly on a
        // standalone App Store daemon, where Codex is the only quota path there is.
        let codexHasGauge = stateHolder.state.codexRateLimits.map {
            $0.primary != nil || $0.secondary != nil || $0.credits != nil || $0.limitId != nil
        } ?? false
        let hasGauges = stateHolder.state.fiveHourPercent != nil
            || stateHolder.state.sevenDayPercent != nil
            || (stateHolder.state.costLimit != nil && stateHolder.state.costLimit! > 0)
            || codexHasGauge
        let externalDaemonActive = daemonService.isUsingExternalDaemon
        if hasGauges || externalDaemonActive {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("RATE LIMITS")
                        .font(.system(size: 10, weight: .bold))
                        .kerning(0.5)
                        .foregroundColor(TerrariumHUD.subtext)
                    if stateHolder.state.usageStale == true {
                        Text(stateHolder.state.claudeUsageIssue ?? "stale")
                            .font(.system(size: 9))
                            .foregroundStyle(.orange)
                    }
                    Spacer()
                }
                let isApi = stateHolder.state.costLimit != nil && stateHolder.state.costLimit! > 0
                if let pct5h = stateHolder.state.fiveHourPercent {
                    let costSpent = stateHolder.state.costSpent ?? 0
                    let costLimit = stateHolder.state.costLimit ?? 0
                    let customSuffix = isApi ? String(format: "$%.2f/$%.0f", costSpent, costLimit) : nil
                    compactGauge(
                        label: isApi ? "API" : "5h",
                        percent: pct5h,
                        resetTime: isApi ? nil : stateHolder.state.fiveHourResetsAt,
                        customSuffix: customSuffix
                    )
                }
                if !isApi, let pct7d = stateHolder.state.sevenDayPercent {
                    compactGauge(
                        label: "7d",
                        percent: pct7d,
                        resetTime: stateHolder.state.sevenDayResetsAt
                    )
                }
                // Per-model scoped weekly caps (e.g. "Fable") — distinct from 5h/7d.
                // Inactive caps render muted (neutral), never the critical ramp.
                if !isApi {
                    ForEach(stateHolder.state.scopedLimits ?? [], id: \.label) { s in
                        compactGauge(
                            label: s.compactLabel(6),
                            percent: s.percent,
                            resetTime: s.resetsAt,
                            muted: s.active != true
                        )
                    }
                }
                // Codex (ChatGPT) usage limits, when the daemon surfaced them
                // from the local rollout files. Own sub-header so the 5h/7d
                // labels don't read as Claude's. Hidden when absent. Credit-based
                // plans (null windows, e.g. limit_id "premium") show a balance row.
                if let codex = stateHolder.state.codexRateLimits,
                   codex.primary != nil || codex.secondary != nil
                    || codex.credits != nil || codex.limitId != nil {
                    Text("CODEX")
                        .font(.system(size: 9, weight: .bold))
                        .kerning(0.5)
                        .foregroundColor(TerrariumHUD.subtext.opacity(0.8))
                        .padding(.top, 2)
                    if let p = codex.primary, let pct = p.usedPercent {
                        compactGauge(
                            label: TopologyRail.windowLabel(p.windowMinutes),
                            percent: pct,
                            resetTime: p.resetsAt,
                            stale: p.stale == true,
                            footnote: CodexUsageFreshness.footnote(window: p, capturedAt: codex.capturedAt)
                        )
                    }
                    if let s = codex.secondary, let pct = s.usedPercent {
                        compactGauge(
                            label: TopologyRail.windowLabel(s.windowMinutes),
                            percent: pct,
                            resetTime: s.resetsAt,
                            stale: s.stale == true,
                            footnote: CodexUsageFreshness.footnote(window: s, capturedAt: codex.capturedAt)
                        )
                    }
                    if codex.primary == nil, codex.secondary == nil,
                       codex.credits != nil || codex.limitId != nil {
                        let tier = (codex.limitId ?? "credits").capitalized
                        let bal = (codex.credits?.unlimited == true) ? "∞" : (codex.credits?.balance ?? "—")
                        HStack(spacing: 4) {
                            Text(tier)
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(TerrariumHUD.text)
                            Spacer(minLength: 4)
                            Text("\(bal) credits")
                                .font(.system(size: 10, weight: .medium, design: .monospaced))
                                .foregroundColor(TerrariumHUD.subtext)
                        }
                    }
                }
                if !hasGauges {
                    rateLimitsEmptyState
                }
                if preferences.hooksInstalled == false {
                    hookConsentHint
                }
            }
        } else if preferences.hooksInstalled == false {
            hookConsentHint
        }
    }

    /// Replacement for the old silent "No data" string. App Store sandbox
    /// can't read `~/.claude/.credentials.json` or the Claude keychain
    /// entry (Apple 2.5.2 blocks `security` subprocess + Anthropic doesn't
    /// publish a shared Keychain Access Group), so quota polling is
    /// structurally impossible in that build. Users need to know that —
    /// and to know the alternative — rather than staring at "No data".
    @ViewBuilder
    private var rateLimitsEmptyState: some View {
        let connected = stateHolder.state.oauthConnected ?? false
        VStack(alignment: .leading, spacing: 4) {
            Text(rateLimitsEmptyMessage)
                .font(.system(size: 10))
                .foregroundColor(connected ? TerrariumHUD.subtext : .orange)
                .fixedSize(horizontal: false, vertical: true)
            if !connected {
                Button {
                    DockVisibilityController.shared.prepareToShowWindow()
                    NSApp.activate(ignoringOtherApps: true)
                    openWindow(id: "settings")
                } label: {
                    Text("Open Settings →")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(TerrariumColors.tetraNeon)
                }
                .buttonStyle(.plain)
            }
        }
    }

    /// Empty-state copy only renders when an external daemon is feeding
    /// the section — otherwise `rateLimitsSection` collapses entirely.
    private var rateLimitsEmptyMessage: String {
        if (stateHolder.state.oauthConnected ?? false) == false {
            return "External daemon connected — waiting for Claude Code to sign in."
        }
        return "Waiting for Anthropic to return your quota…"
    }

    /// Secondary hint row. Hooks are opt-in (Apple 2.5.2 forbids silent
    /// writes to `~/.claude/settings.local.json`) and without them the
    /// live per-turn token/input/output counters stay zero — which reads
    /// as broken to users who don't know the hook consent gate exists.
    @ViewBuilder
    private var hookConsentHint: some View {
        HStack(spacing: 4) {
            Image(systemName: "bolt.slash")
                .font(.system(size: 9))
                .foregroundColor(TerrariumHUD.subtext)
            Text("Live session tokens need hook consent — enable in Settings.")
                .font(.system(size: 10))
                .foregroundColor(TerrariumHUD.subtext)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 2)
    }

    // MARK: - Anthropic API usage (org-wide, via Admin API key)

    /// Compact org-wide API usage section. Only rendered when the user
    /// has pasted an Anthropic Console Admin API key in Settings —
    /// subscription users see nothing here; the RATE LIMITS empty state
    /// explains the sandbox limitation and the hook-based monitoring path.
    /// Fetches are daemon-driven at 10 min cadence so this view just
    /// reflects whatever is currently cached.
    @ViewBuilder
    private var anthropicApiUsageSection: some View {
        if stateHolder.state.adminApiKeyPresent == true {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("ANTHROPIC API")
                        .font(.system(size: 10, weight: .bold))
                        .kerning(0.5)
                        .foregroundColor(TerrariumHUD.subtext)
                    if stateHolder.state.adminApiStale == true {
                        Text("stale")
                            .font(.system(size: 9))
                            .foregroundStyle(.orange)
                    }
                    Spacer()
                }
                let todayIn = stateHolder.state.adminApiTodayInputTokens ?? 0
                let todayOut = stateHolder.state.adminApiTodayOutputTokens ?? 0
                let todayCache = (stateHolder.state.adminApiTodayCacheReadTokens ?? 0)
                    + (stateHolder.state.adminApiTodayCacheCreationTokens ?? 0)
                let monthIn = stateHolder.state.adminApiMonthInputTokens ?? 0
                let monthOut = stateHolder.state.adminApiMonthOutputTokens ?? 0
                let monthCache = (stateHolder.state.adminApiMonthCacheReadTokens ?? 0)
                    + (stateHolder.state.adminApiMonthCacheCreationTokens ?? 0)
                if todayIn + todayOut + todayCache + monthIn + monthOut + monthCache == 0 {
                    Text("Awaiting first fetch (~5 min Anthropic data delay)…")
                        .font(.system(size: 10))
                        .foregroundColor(TerrariumHUD.subtext)
                } else {
                    apiUsageRow(label: "Today", input: todayIn, output: todayOut, cache: todayCache)
                    apiUsageRow(label: "30d", input: monthIn, output: monthOut, cache: monthCache)
                }
                let topModels = stateHolder.state.adminApiTopModels.prefix(2)
                if !topModels.isEmpty {
                    Text("Top: " + topModels.map { shortModelLabel($0.model) }.joined(separator: " · "))
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(TerrariumHUD.subtext.opacity(0.8))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
        }
    }

    private func apiUsageRow(label: String, input: Int, output: Int, cache: Int) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(TerrariumHUD.subtext)
                .frame(width: 36, alignment: .leading)
            Text("in \(formatApiTokenCount(input))")
                .font(.system(size: 10, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
            Text("out \(formatApiTokenCount(output))")
                .font(.system(size: 10, design: .monospaced))
                .frame(maxWidth: .infinity, alignment: .leading)
            if cache > 0 {
                Text("cache \(formatApiTokenCount(cache))")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(TerrariumHUD.subtext)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func formatApiTokenCount(_ n: Int) -> String {
        if n >= 1_000_000 {
            return String(format: "%.1fM", Double(n) / 1_000_000)
        } else if n >= 1_000 {
            return String(format: "%.1fK", Double(n) / 1_000)
        }
        return "\(n)"
    }

    private func shortModelLabel(_ model: String) -> String {
        var s = model
        for prefix in ["claude-", "claude_"] {
            if s.hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
        }
        if let range = s.range(of: #"-\d{8}$"#, options: .regularExpression) {
            s = String(s[s.startIndex..<range.lowerBound])
        }
        return s
    }

    private func compactGauge(label: String, percent: Double, resetTime: String?, customSuffix: String? = nil, stale: Bool = false, muted: Bool = false, footnote: String? = nil) -> some View {
        // Expired Codex window: desaturate the fill and show a "stale" marker
        // instead of a (misleading) reset countdown. The % stays last-known.
        // `muted` = a non-binding per-model scoped cap: neutral, never the critical
        // ramp regardless of percent (issue #99).
        // `footnote` = Codex freshness note ("stale" / "3h ago"), which also dims:
        // an aged snapshot of a still-live window is not current either, and its
        // reset countdown says nothing about when the number was measured.
        let dim = stale || (footnote?.isEmpty == false)
        let color = (dim || muted) ? TerrariumHUD.subtext : gaugeColor(percent)
        return HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(TerrariumHUD.subtext)
                // Same bound as the topology rail: a scoped cap's label is a
                // model name, and at 22pt "Fable" wrapped onto a second line and
                // dragged the gauge out of alignment. lineLimit makes that
                // impossible; the width keeps the label readable.
                .lineLimit(1)
                .frame(width: 38, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.white.opacity(0.10))
                    RoundedRectangle(cornerRadius: 3)
                        .fill(color)
                        .opacity(dim ? 0.5 : 1)
                        .frame(width: max(0, min(1, percent / 100.0)) * geo.size.width)
                }
            }
            .frame(height: 6)
            Text(customSuffix ?? "\(Int(percent))%")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(color)
                .frame(width: customSuffix != nil ? 75 : 36, alignment: .trailing)
            if customSuffix == nil {
                if let note = footnote, !note.isEmpty {
                    Text(note)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.orange)
                        .frame(width: 48, alignment: .trailing)
                } else if stale {
                    Text("stale")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(.orange)
                        .frame(width: 48, alignment: .trailing)
                } else if let reset = resetTime, let formatted = formatResetTime(reset) {
                    Text(formatted)
                        .font(.system(size: 10, weight: percent >= 70 ? .semibold : .regular))
                        .foregroundColor(percent >= 70 ? .orange : TerrariumHUD.subtext)
                        .frame(width: 48, alignment: .trailing)
                }
            }
        }
    }

    // MARK: - Compact services

    // MARK: - Pill-style action bar (from Option D design)

    private var pillActionsBar: some View {
        HStack(spacing: 6) {
            dashboardTogglePill
            pillButton(label: "Report") { openApmeDashboard() }
                .disabled(daemonService.port == 0)
                .daemonOfflineAffordance(isOffline: daemonService.port == 0)
            devicesPillMenu
            Spacer()
            settingsPillButton
        }
    }

    private var bottomActionArea: some View {
        VStack(spacing: 0) {
            if showDaemonOfflineBanner {
                daemonOfflineBanner
            }
            pillActionsBar
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
        }
        .background(DesignTokens.UI.popupBgDeep.opacity(0.72))
        .overlay(
            Rectangle()
                .fill(DesignTokens.Tide.s50.opacity(0.08))
                .frame(height: 0.5),
            alignment: .top
        )
    }

    private var devicesPillMenu: some View {
        Menu {
            Button("Preview Devices", action: openDevicePreview)
            Button("Pair Device") {
                DockVisibilityController.shared.prepareToShowWindow()
                openWindow(id: "pairing-qr")
            }
            .disabled(daemonService.port == 0)
            if streamDeckDetection.streamDeckPlusConnected {
                Divider()
                if !streamDeckDetection.elgatoAppInstalled {
                    Button("Stream Deck+ Setup", action: openStreamDeckDownloadPage)
                } else if !streamDeckDetection.pluginInstalled {
                    Button("Install SD Plugin", action: openStreamDeckPluginInstaller)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text("Devices")
                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .bold))
            }
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(TerrariumHUD.text)
            .padding(.horizontal, 11)
            .padding(.vertical, 5)
            .background(Capsule().fill(DesignTokens.Tide.s50.opacity(0.08)))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    /// Dashboard pill with active/inactive visual state. The pill reflects
    /// whether the Dashboard window is currently visible: filled (primary)
    /// when open, outlined when hidden. Click toggles between open and
    /// close so the menubar acts as the canonical visibility switch.
    private var dashboardTogglePill: some View {
        pillButton(
            label: dashboardVisible ? "Dashboard ●" : "Dashboard",
            primary: dashboardVisible
        ) {
            if dashboardVisible {
                closeDashboard()
            } else {
                openDashboard()
            }
        }
    }

    // MARK: - Daemon offline banner

    /// True when the daemon has no bound port AND we aren't in a transient
    /// "starting up" window. We only surface the banner when the user's
    /// actions are actually blocked, not during the ~1s window between
    /// app launch and the in-process daemon completing its bind.
    private var showDaemonOfflineBanner: Bool {
        daemonService.port == 0
            && !daemonService.isRunning
            && !daemonService.isUsingExternalDaemon
    }

    private var daemonOfflineBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "bolt.slash.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 1) {
                Text("Daemon offline")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(TerrariumHUD.text)
                Text("Report · Pair iPad · Preview require the daemon to be running.")
                    .font(.system(size: 10))
                    .foregroundColor(TerrariumHUD.subtext)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            Button {
                Task { await daemonService.restart() }
            } label: {
                Text("Restart")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(
                        Capsule().fill(Color.orange)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(Color.orange.opacity(0.18))
        .overlay(
            Rectangle()
                .fill(Color.orange.opacity(0.45))
                .frame(height: 0.5),
            alignment: .bottom
        )
    }

    private func pillButton(
        label: String,
        primary: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(primary ? TerrariumColors.deepSea : TerrariumHUD.text)
                .padding(.horizontal, 11)
                .padding(.vertical, 5)
                .background(
                    Capsule()
                        .fill(primary ? TerrariumColors.tetraNeon : Color.white.opacity(0.08))
                )
        }
        .buttonStyle(.plain)
    }

    private var settingsPillButton: some View {
        Menu {
            Button("Open Settings") {
                DockVisibilityController.shared.prepareToShowWindow()
                NSApp.activate(ignoringOtherApps: true)
                openWindow(id: "settings")
            }
            Toggle("Start at Login", isOn: Binding(
                get: { daemonService.isLoginItemEnabled },
                set: { enabled in
                    if enabled { daemonService.registerLoginItem() }
                    else { daemonService.unregisterLoginItem() }
                }
            ))
            Divider()
            Button("Quit AgentDeck") {
                stateHolder.prepareForTermination()
                NSApplication.shared.terminate(nil)
            }
        } label: {
            Image(systemName: "gearshape")
                .font(.system(size: 14, weight: .regular))
                .foregroundColor(TerrariumHUD.text)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Capsule().fill(DesignTokens.Tide.s50.opacity(0.08)))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Open Settings")
    }

    private func stateColor(_ state: AgentConnectionState) -> Color {
        switch state {
        case .processing: .cyan
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .orange
        case .idle: .green
        case .disconnected: .gray
        }
    }

    private func rateLimitGauge(label: String, percent: Double, previousPercent: Double?, resetTime: String?) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(TerrariumHUD.subtext)
                .frame(width: 20, alignment: .trailing)
            Text(gaugeString(percent))
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(gaugeColor(percent))
            // Trend arrow
            let arrow = trendArrow(percent, previousPercent)
            if !arrow.isEmpty {
                Text(arrow)
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(arrow == "↑" ? .red : .green)
            }
            if let reset = resetTime, let formatted = formatResetTime(reset) {
                Text(formatted)
                    .font(.system(size: 10, weight: percent >= 70 ? .semibold : .regular))
                    .foregroundColor(percent >= 70 ? .orange : TerrariumHUD.subtext)
            }
        }
    }


    /// Send the user to Elgato's downloads landing page. We intentionally pick
    /// the top-level /downloads URL instead of a versioned .dmg link so the
    /// page keeps working when Elgato ships new versions.
    private func openStreamDeckDownloadPage() {
        if let url = URL(string: "https://www.elgato.com/downloads") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Prefer a bundled `.streamDeckPlugin` bundle (when we start shipping it
    /// inside AgentDeck.app/Contents/Resources/plugin). Fall back to the
    /// GitHub releases landing page so the button is never a dead end on
    /// builds that don't bundle the plugin yet.
    private func openStreamDeckPluginInstaller() {
        if let bundled = Bundle.main.url(
            forResource: "bound.serendipity.agentdeck",
            withExtension: "streamDeckPlugin",
            subdirectory: "plugin"
        ) {
            NSWorkspace.shared.open(bundled)
            return
        }
        if let url = URL(string: "https://github.com/puritysb/AgentDeck/releases/latest") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: - Helpers

    private func agentTypeLabel(_ type: String) -> String {
        displayAgentLabel(type)
    }

    private func shortModelName(_ name: String) -> String {
        displayShortModelName(name)
    }

    /// Get current tool name for a session (only available for primary session)
    private func currentToolFor(_ session: SessionInfo) -> String? {
        if session.id == effectiveFocusedSessionId {
            return stateHolder.state.currentTool
        }
        return nil
    }

    private func relativeTimeString(from isoString: String?) -> String? {
        displayRelativeTime(isoString)
    }

    private func openDashboard() {
        // Promote out of "menu bar only" BEFORE the window exists — promoting
        // afterwards makes AppKit drop key focus and the window lands behind
        // whatever the user was in.
        DockVisibilityController.shared.prepareToShowWindow()
        // SwiftUI's openWindow brings an existing window of this scene to front
        // if one exists, otherwise creates it. Avoids fragile title string matching.
        openWindow(id: "dashboard")
        NSApplication.shared.activate(ignoringOtherApps: true)
        // Update local toggle state immediately — the NotificationCenter
        // observer would otherwise lag by one runloop tick.
        dashboardVisible = true
    }

    /// Close the Dashboard window. We close rather than orderOut so SwiftUI
    /// reclaims the scene cleanly; the next openDashboard() call will
    /// recreate it via the standard scene flow.
    private func closeDashboard() {
        NSApp.windows.first {
            $0.identifier?.rawValue == "dashboard"
        }?.close()
        dashboardVisible = false
    }

    /// Open the in-app APME dashboard window (WKWebView pointing at the
    /// rich SPA served by the local daemon at /apme). One click → full
    /// APME UI with run history, category scorecard, timeline, and eval
    /// axes breakdown — no more digging through sqlite, no browser
    /// roundtrip, no token in address bar history.
    private func openApmeDashboard() {
        guard daemonService.port > 0 else { return }
        DockVisibilityController.shared.prepareToShowWindow()
        openWindow(id: "apme-dashboard")
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    /// Open the Device Preview window. Safe to call whether or not any
    /// hardware is connected — this is the whole point of the window.
    private func openDevicePreview() {
        DockVisibilityController.shared.prepareToShowWindow()
        openWindow(id: "device-preview")
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    // MARK: - Gauge Helpers

    private func gaugeString(_ percent: Double) -> String {
        let filled = Int((percent / 100.0) * 10)
        let clamped = max(0, min(10, filled))
        let bar = String(repeating: "\u{2588}", count: clamped)
            + String(repeating: "\u{2591}", count: 10 - clamped)
        return "\(bar) \(Int(percent))%"
    }

    private func gaugeColor(_ percent: Double) -> Color {
        if percent >= 90 { return .red }
        if percent >= 70 { return .orange }
        return .green
    }

    /// Returns "↑" if usage increased, "↓" if decreased, "" if no significant change
    private func trendArrow(_ current: Double?, _ previous: Double?) -> String {
        guard let current, let previous else { return "" }
        let diff = current - previous
        if diff > 1 { return "↑" }
        if diff < -1 { return "↓" }
        return ""
    }

    /// Format subscription renewal date — accepts ISO 8601 or passthrough.
    /// Produces compact "Apr 19" style output; falls back to input when
    /// parsing fails (some backends return short-form strings already).
    private func formatSubscriptionDate(_ input: String) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let parsed = iso.date(from: input) ?? ISO8601DateFormatter().date(from: input)
        guard let date = parsed else { return input }
        let fmt = DateFormatter()
        fmt.dateFormat = "MMM d"
        return fmt.string(from: date)
    }

}

// `SessionBrand` and `SessionCreatureIcon` live in `UI/Common/SessionBrand.swift`
// so the cross-platform dashboard HUD can reuse them.

/// Lightweight detection struct for Stream Deck companion status.
///
/// `elgatoAppInstalled` — the Stream Deck desktop app (bundle id
/// `com.elgato.StreamDeck`) is present in /Applications or ~/Applications.
/// `streamDeckPlusConnected` — any Elgato HID device (VID `0x0FD9`) is
/// currently attached. We don't care which model since the companion prompt
/// is identical regardless.
/// `pluginInstalled` — our `.sdPlugin` directory exists in Elgato's plugin
/// folder. Used to suppress the "Install SD plugin" nudge once the plugin is
/// already there. Returns `false` under App Sandbox when the real user home
/// isn't reachable — that's fine: the nudge is always a hint, never a gate.
///
/// None of these probes opens the HID device (no `IOHIDManagerOpen`), so USB
/// entitlement state doesn't affect detection. Returns `false` on any
/// failure — the Control Tower treats this as a hint, never a hard gate.
struct StreamDeckDetection {
    let elgatoAppInstalled: Bool
    let streamDeckPlusConnected: Bool
    let pluginInstalled: Bool

    static func detect() -> StreamDeckDetection {
        let appInstalled = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: "com.elgato.StreamDeck"
        ) != nil
        return StreamDeckDetection(
            elgatoAppInstalled: appInstalled,
            streamDeckPlusConnected: detectElgatoHardware(),
            pluginInstalled: detectPluginInstalled()
        )
    }

    /// Check whether `bound.serendipity.agentdeck.sdPlugin` is present in the
    /// Elgato Plugins folder. Uses `getpwuid` to resolve the real user home
    /// since the App Sandbox-mapped home is useless here. When the sandbox
    /// blocks the read we get a silent `false` — acceptable because the nudge
    /// is only a hint; worst case a user sees "Install SD plugin" once more.
    private static func detectPluginInstalled() -> Bool {
        guard let pw = getpwuid(getuid()), let home = pw.pointee.pw_dir else {
            return false
        }
        let homeStr = String(cString: home)
        let path = "\(homeStr)/Library/Application Support/com.elgato.StreamDeck/Plugins/bound.serendipity.agentdeck.sdPlugin/manifest.json"
        return FileManager.default.fileExists(atPath: path)
    }

    /// Enumerate HID devices matching Elgato VID without opening the manager.
    /// `IOHIDManagerCopyDevices` fills a set even under App Sandbox when the
    /// manager isn't opened — matching dictionaries are probed by the kernel,
    /// not the app.
    private static func detectElgatoHardware() -> Bool {
        let manager = IOHIDManagerCreate(kCFAllocatorDefault, IOOptionBits(kIOHIDOptionsTypeNone))
        let matching: [String: Any] = [kIOHIDVendorIDKey: 0x0FD9]
        IOHIDManagerSetDeviceMatching(manager, matching as CFDictionary)
        guard let set = IOHIDManagerCopyDevices(manager) as? Set<IOHIDDevice> else {
            return false
        }
        return !set.isEmpty
    }
}

/// Reports how much vertical room the hosting popup window actually has:
/// from its own top edge down to the bottom of its screen's usable area.
///
/// The menubar popup is anchored under the menu bar, so `frame.maxY` is stable
/// as the content resizes — no feedback loop with the height it feeds. Reading
/// `window.screen` (rather than `NSScreen.main`) is the point: it is the screen
/// the popup actually opened on.
private struct PanelAvailableHeightReader: NSViewRepresentable {
    let onChange: (CGFloat) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        // The window is not attached yet during makeNSView.
        DispatchQueue.main.async { report(from: view) }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { report(from: nsView) }
    }

    private func report(from view: NSView) {
        guard let window = view.window, let screen = window.screen else { return }
        let available = window.frame.maxY - screen.visibleFrame.minY
        guard available > 0 else { return }
        onChange(available)
    }
}
#endif
