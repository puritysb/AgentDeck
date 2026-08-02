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

    /// Cumulative height of the popup's chrome (header + banner+pill bar +
    /// footer), measured via `ChromeHeightKey` PreferenceKey. Replaces the
    /// previous fixed 140pt reserve so `scrollContentMaxHeight` reflects
    /// the actual chrome footprint — chrome shrinks (CalmHeader, no banner)
    /// → scroll budget grows; chrome grows (AttentionTheater + offline
    /// banner) → scroll budget shrinks to match.
    @State private var measuredChromeHeight: CGFloat = 0

    /// Natural height of the body ScrollView's content, measured via
    /// `ContentHeightKey`. Used to bind the ScrollView's frame to
    /// `min(scrollContentMaxHeight, contentHeight)` so the ScrollView
    /// shrinks to fit when content is shorter than the cap — SwiftUI's
    /// ScrollView is otherwise greedy and claims the full proposed
    /// maxHeight, which surfaces a scrollbar even when content fits.
    @State private var measuredContentHeight: CGFloat = 0

    var body: some View {
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
            .measureChromeHeight()

            Group {
                if measuredContentHeight > scrollContentMaxHeight {
                    ScrollView(.vertical, showsIndicators: true) {
                        innerContentVStack
                    }
                    .frame(height: scrollContentMaxHeight)
                } else {
                    innerContentVStack
                }
            }
            .onPreferenceChange(ContentHeightKey.self) { measuredContentHeight = $0 }

            VStack(spacing: 0) {
                if showDaemonOfflineBanner {
                    daemonOfflineBanner
                }
                pillActionsBar
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
            }
            .background(Color.black.opacity(0.35))
            .overlay(
                Rectangle()
                    .fill(Color.white.opacity(0.08))
                    .frame(height: 0.5),
                alignment: .top
            )
            .measureChromeHeight()

            footerSection
                .measureChromeHeight()
        }
        .frame(minWidth: 380, idealWidth: 420, maxWidth: 460)
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
        .onPreferenceChange(ChromeHeightKey.self) { measuredChromeHeight = $0 }
        .onAppear {
            refreshStreamDeckDetectionIfStale()
            dashboardVisible = evaluateDashboardVisibility()
        }
        .onReceive(
            Timer.publish(every: 5, on: .main, in: .common).autoconnect()
        ) { _ in
            refreshStreamDeckDetectionIfStale()
            dashboardVisible = evaluateDashboardVisibility()
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

    /// Prompt question text tied to a session. We only have the live
    /// prompt for the focused session (the bridge only streams one at a
    /// time), so non-focused sessions show a generic "needs input" tag.
    private func questionFor(_ session: SessionInfo) -> String? {
        if session.id == effectiveFocusedSessionId {
            return stateHolder.state.question
        }
        return nil
    }

    private var effectiveFocusedSessionId: String? {
        stateHolder.state.focusedSessionId ?? stateHolder.state.sessionId
    }

    /// Options to render in the menubar theater. Only PTY-managed sessions expose
    /// Claude's real choices; mirror the focused session's live options ONLY when
    /// they genuinely belong to it. Observed (hook-only) sessions render [] →
    /// "respond in terminal". Mirrors `MonitorScreen`.
    private func attentionOptions(for session: SessionInfo, isFocused: Bool) -> [PromptOption] {
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
        // Route via the daemon focus relay, then send the selection — `selectOption`
        // is the canonical path (same as D200H + Cmd+Y/N/A).
        stateHolder.sendCommand(.focusSession(sessionId: session.id))
        stateHolder.sendCommand(.selectOption(index: optionIndex))
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

    // MARK: - Layout sizing

    /// Cap on the inner ScrollView height so the popover never overruns
    /// the screen when the user has many devices wired up. The cap is
    /// computed against `visibleFrame` (already excludes menu bar + Dock)
    /// minus the *measured* chrome (header + banner+pill bar + footer)
    /// rather than a fixed reserve — so AttentionTheater + offline banner
    /// don't crowd content, and CalmHeader doesn't waste headroom. Below
    /// the cap, the ScrollView reports its content's natural height (via
    /// `fixedSize(vertical: true)`) so the panel shrinks to fit when
    /// devices are sparse.
    private var scrollContentMaxHeight: CGFloat {
        let screenHeight = NSScreen.main?.visibleFrame.height ?? 900
        // First frame may render before PreferenceKey lands — fall back to
        // the legacy 140pt reserve so the popup never starts overflowing.
        let chrome = max(140, measuredChromeHeight)
        // Visual cushion against the visibleFrame edge (Dock auto-hide,
        // multi-display chrome).
        let safety: CGFloat = 24
        // Low floor (80pt ≈ one session row visible). When chrome is huge
        // — AttentionTheater with many options + DaemonOfflineBanner —
        // the body shrinks and scrolls internally instead of pushing the
        // popup past the screen edge. The previous 360pt floor stacked
        // with the AttentionTheater options cap to exceed visibleFrame.
        return max(80, screenHeight - chrome - safety)
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

    /// Sessions displayed in the main list. When the attention theater is
    /// showing a featured session at the top, we exclude it here so it
    /// isn't duplicated — matches `option-d.jsx`'s `remaining` filter.
    private var remainingSessions: [SessionInfo] {
        guard let featured = featuredAwaitingSession else { return sortedSessions }
        return sortedSessions.filter { $0.id != featured.id }
    }

    private var innerContentVStack: some View {
        VStack(alignment: .leading, spacing: 14) {
            sessionsListSection
            topologySection
            utilityLinksRow
            rateLimitsSection
            anthropicApiUsageSection
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ContentHeightKey.self,
                    value: proxy.size.height
                )
            }
        )
    }

    private var sessionsListSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("SESSIONS")
                .font(.system(size: 10, weight: .bold))
                .kerning(0.5)
                .foregroundColor(TerrariumHUD.subtext)

            if sortedSessions.isEmpty {
                VStack(spacing: 6) {
                    Text("No active sessions")
                        .font(.system(size: 11))
                        .foregroundColor(TerrariumHUD.subtext)
                    Text("Sessions appear here automatically once the bridge picks one up.")
                        .font(.system(size: 10))
                        .foregroundColor(TerrariumHUD.subtext.opacity(0.85))
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            } else {
                VStack(spacing: 4) {
                    ForEach(remainingSessions) { session in
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

            Button { openWindow(id: "pairing-qr") } label: {
                Label("Pair iPad", systemImage: "qrcode")
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
        let hasGauges = stateHolder.state.fiveHourPercent != nil
            || stateHolder.state.sevenDayPercent != nil
            || (stateHolder.state.costLimit != nil && stateHolder.state.costLimit! > 0)
            || stateHolder.state.codexRateLimits != nil
        let externalDaemonActive = daemonService.isUsingExternalDaemon
        if hasGauges || externalDaemonActive {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("RATE LIMITS")
                        .font(.system(size: 10, weight: .bold))
                        .kerning(0.5)
                        .foregroundColor(TerrariumHUD.subtext)
                    if stateHolder.state.usageStale == true {
                        Text("stale")
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
                            stale: p.stale == true
                        )
                    }
                    if let s = codex.secondary, let pct = s.usedPercent {
                        compactGauge(
                            label: TopologyRail.windowLabel(s.windowMinutes),
                            percent: pct,
                            resetTime: s.resetsAt,
                            stale: s.stale == true
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

    private func compactGauge(label: String, percent: Double, resetTime: String?, customSuffix: String? = nil, stale: Bool = false, muted: Bool = false) -> some View {
        // Expired Codex window: desaturate the fill and show a "stale" marker
        // instead of a (misleading) reset countdown. The % stays last-known.
        // `muted` = a non-binding per-model scoped cap: neutral, never the critical
        // ramp regardless of percent (issue #99).
        let color = (stale || muted) ? TerrariumHUD.subtext : gaugeColor(percent)
        return HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(TerrariumHUD.subtext)
                .frame(width: 22, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.white.opacity(0.10))
                    RoundedRectangle(cornerRadius: 3)
                        .fill(color)
                        .opacity(stale ? 0.5 : 1)
                        .frame(width: max(0, min(1, percent / 100.0)) * geo.size.width)
                }
            }
            .frame(height: 6)
            Text(customSuffix ?? "\(Int(percent))%")
                .font(.system(size: 10, design: .monospaced))
                .foregroundColor(color)
                .frame(width: customSuffix != nil ? 75 : 36, alignment: .trailing)
            if customSuffix == nil {
                if stale {
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
            pillButton(label: "Evaluation") { openApmeDashboard() }
                .disabled(daemonService.port == 0)
                .daemonOfflineAffordance(isOffline: daemonService.port == 0)
            Spacer()
            settingsPillButton
        }
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
                Text("Evaluation · Pair iPad · Preview require the daemon to be running.")
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
        Button {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "settings")
        } label: {
            Image(systemName: "gearshape")
                .font(.system(size: 14, weight: .regular))
                .foregroundColor(TerrariumHUD.text)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .background(Capsule().fill(Color.white.opacity(0.08)))
        }
        .buttonStyle(.plain)
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

    // MARK: - Footer

    private var footerSection: some View {
        HStack {
            Toggle("Start at Login", isOn: Binding(
                get: { daemonService.isLoginItemEnabled },
                set: { enabled in
                    if enabled { daemonService.registerLoginItem() }
                    else { daemonService.unregisterLoginItem() }
                }
            ))
            .toggleStyle(.checkbox)
            .font(.system(size: 11))

            Spacer()

            Button("Quit") {
                stateHolder.prepareForTermination()
                NSApplication.shared.terminate(nil)
            }
            .font(.system(size: 11))
            .buttonStyle(.plain)
            .foregroundColor(TerrariumHUD.subtext)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
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
        openWindow(id: "apme-dashboard")
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    /// Open the Device Preview window. Safe to call whether or not any
    /// hardware is connected — this is the whole point of the window.
    private func openDevicePreview() {
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

// MARK: - Chrome height measurement

/// Sums the measured heights of every chrome region in the popup. The root
/// `ControlTowerPanel` reads the total via `onPreferenceChange` to compute
/// its inner ScrollView's max height against the *actual* chrome footprint
/// instead of a fixed 140pt reserve.
private struct ChromeHeightKey: PreferenceKey {
    // `let` keeps Swift 6 strict-concurrency happy — PreferenceKey only
    // uses defaultValue as an initial accumulator, never mutates it.
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value += nextValue()
    }
}

/// Carries the body ScrollView content's natural height so the parent
/// can shrink the ScrollView's frame to fit. Unlike `ChromeHeightKey`,
/// this is a single-source measurement (one GeometryReader on the
/// content VStack), so reduce just adopts the latest value.
private struct ContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private extension View {
    /// Adds this view's measured height to the cumulative `ChromeHeightKey`
    /// total carried up the SwiftUI tree.
    func measureChromeHeight() -> some View {
        background(
            GeometryReader { proxy in
                Color.clear.preference(
                    key: ChromeHeightKey.self,
                    value: proxy.size.height
                )
            }
        )
    }
}
#endif
