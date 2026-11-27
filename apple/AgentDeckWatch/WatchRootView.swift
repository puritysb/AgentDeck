import SwiftUI

/// Vertical pages: the glance, then sessions, then allowance. Freshness is
/// re-evaluated every 15 s without a fetch, so an old observation turns
/// historical (and later disappears) while the screen stays open.
struct WatchRootView: View {
    @ObservedObject var model: WatchObservationModel
    @State private var page = WatchRootView.initialPage

    enum Page: Hashable { case glance, sessions, usage }

    private static var initialPage: Page {
        #if DEBUG
        // Capture pin: `-AgentDeckWatchPage sessions|usage`.
        switch UserDefaults.standard.string(forKey: "AgentDeckWatchPage") {
        case "sessions": return .sessions
        case "usage": return .usage
        default: break
        }
        #endif
        return .glance
    }

    var body: some View {
        #if DEBUG
        // Capture pin: the attention long look, rendered with this snapshot.
        switch UserDefaults.standard.string(forKey: "AgentDeckWatchPage") {
        case "notification":
            AttentionNotificationView(glance: WatchGlance.make(model.snapshot, at: .now))
        case "complications":
            ComplicationGallery()
        default:
            content
        }
        #else
        content
        #endif
    }

    private var content: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            let glance = WatchGlance.make(model.snapshot, at: context.date)
            NavigationStack {
                TabView(selection: $page) {
                    GlancePage(glance: glance, model: model)
                        .containerBackground(WatchTheme.background(for: glance.mode), for: .tabView)
                        .tag(Page.glance)
                    if !glance.sessions.isEmpty {
                        SessionsPage(glance: glance, model: model, now: context.date)
                            .containerBackground(WatchTheme.background(for: glance.mode), for: .tabView)
                            .tag(Page.sessions)
                    }
                    if !glance.usage.isEmpty {
                        UsagePage(glance: glance, model: model, now: context.date)
                            .containerBackground(WatchTheme.background(for: glance.mode), for: .tabView)
                            .tag(Page.usage)
                    }
                }
                .tabViewStyle(.verticalPage)
                .onChange(of: glance.sessions.isEmpty) { _, isEmpty in
                    if isEmpty && page == .sessions { page = .glance }
                }
                .onChange(of: glance.usage.isEmpty) { _, isEmpty in
                    if isEmpty && page == .usage { page = .glance }
                }
                .onOpenURL { url in
                    handleDeepLink(url, glance: glance)
                }
            }
        }
        #if DEBUG
        .task { await playDemoIfPinned() }
        #endif
    }

    private func handleDeepLink(_ url: URL, glance: WatchGlance) {
        guard url.scheme == "agentdeckwatch" else { return }
        switch url.host {
        case "sessions" where !glance.sessions.isEmpty:
            page = .sessions
        case "usage" where !glance.usage.isEmpty:
            page = .usage
        default:
            page = .glance
        }
    }

    #if DEBUG
    /// Demo capture pin: `-AgentDeckWatchDemo 1` with `-AgentDeckWatchFixture working`
    /// steps work → a wait arrives → roster → allowance → back, for a screen recording.
    private func playDemoIfPinned() async {
        guard UserDefaults.standard.bool(forKey: "AgentDeckWatchDemo") else { return }
        let steps: [(Double, () -> Void)] = [
            (2.5, { withAnimation(.spring(duration: 0.6)) { model.pinFixture("busy") } }),
            (3.5, { withAnimation { page = .sessions } }),
            (3.5, { withAnimation { page = .usage } }),
            (3.0, { withAnimation { page = .glance } }),
        ]
        for (delay, step) in steps {
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            step()
        }
    }
    #endif
}

private struct RefreshToolbarItem: ToolbarContent {
    @ObservedObject var model: WatchObservationModel

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button { Task { await model.refresh() } } label: {
                if model.busy { ProgressView() } else { Image(systemName: "arrow.clockwise") }
            }
            .disabled(model.busy)
            .accessibilityLabel("Refresh")
        }
    }
}

private struct GlancePage: View {
    let glance: WatchGlance
    @ObservedObject var model: WatchObservationModel

    var body: some View {
        GeometryReader { geo in
            let ringSize = max(96, min(geo.size.width * 0.66, geo.size.height * 0.64, 122))
            let lineWidth = max(8, ringSize * 0.088)
            VStack(spacing: 5) {
                ZStack {
                    AttentionRing(glance: glance, lineWidth: lineWidth, pulse: glance.mode == .needsYou && !glance.historical)
                    center(ringSize: ringSize)
                }
                .frame(width: ringSize, height: ringSize)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("watch.headline")
                if glance.hasCounts {
                    HStack(spacing: 4) {
                        FreshnessChip(glance: glance)
                        if glance.mode == .needsYou, !glance.waitingAgents.isEmpty, let working = glance.working, working > 0 {
                            Text("+\(working) working")
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(glance.historical ? WatchTheme.offline : WatchTheme.working)
                                .lineLimit(1)
                        }
                    }
                }
                if let status = model.status ?? emptyHint {
                    Text(status)
                        .font(.caption2).multilineTextAlignment(.center)
                        .foregroundStyle(WatchTheme.subtext)
                        .lineLimit(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 6)
                        .accessibilityIdentifier("watch.status")
                }
            }
            .padding(.top, 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .toolbar { RefreshToolbarItem(model: model) }
        .navigationTitle("AgentDeck")
    }

    private var emptyHint: String? {
        switch glance.mode {
        case .unavailable: return String(localized: "Turn on Remote observation in AgentDeck on your Mac.")
        case .sourceUnavailable: return String(localized: "Your Mac can't see its sessions right now.")
        case .sharingStopped: return String(localized: "Sharing is turned off on your Mac.")
        default:
            if glance.detailsSharingLikelyOff {
                return String(localized: "Turn on detailed sharing on your Mac for sessions and allowance.")
            }
            return nil
        }
    }

    @ViewBuilder
    private func center(ringSize: CGFloat) -> some View {
        let tint = WatchTheme.tint(glance)
        let numberSize = ringSize * 0.34
        switch glance.mode {
        case .needsYou, .working:
            VStack(spacing: 0) {
                Text("\(glance.mode == .needsYou ? glance.waiting ?? 0 : glance.working ?? 0)")
                    .font(.system(size: numberSize, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(tint)
                    .contentTransition(.numericText())
                Text(glance.glanceStatusLabel)
                    .font(.footnote.weight(.semibold)).foregroundStyle(tint)
                    .minimumScaleFactor(0.8).lineLimit(1)
                if glance.mode == .needsYou, !glance.waitingAgents.isEmpty {
                    HStack(spacing: -4) {
                        ForEach(Array(glance.waitingAgents.prefix(3).enumerated()), id: \.offset) { _, agent in
                            AgentBadge(agent: agent, size: 18)
                        }
                    }
                    .padding(.top, 2)
                } else if glance.mode == .needsYou, let working = glance.working, working > 0 {
                    Text("+\(working) working").font(.caption2).foregroundStyle(WatchTheme.working)
                }
            }
        case .allClear:
            VStack(spacing: 2) {
                Image(systemName: "checkmark.seal.fill").font(.system(size: ringSize * 0.27)).foregroundStyle(DesignTokens.UI.ok)
                Text("All clear").font(.headline).foregroundStyle(WatchTheme.text)
            }
        case .sharingStopped:
            Image(systemName: "pause.circle").font(.system(size: ringSize * 0.31)).foregroundStyle(tint)
        case .sourceUnavailable:
            Image(systemName: "desktopcomputer.trianglebadge.exclamationmark").font(.system(size: ringSize * 0.27)).foregroundStyle(tint)
        case .unavailable:
            Image(systemName: "icloud.slash").font(.system(size: ringSize * 0.27)).foregroundStyle(tint)
        }
    }
}

private struct SessionsPage: View {
    let glance: WatchGlance
    @ObservedObject var model: WatchObservationModel
    let now: Date

    var body: some View {
        List {
            if let status = model.status {
                Text(status)
                    .font(.caption2)
                    .foregroundStyle(WatchTheme.subtext)
                    .listRowBackground(Color.clear)
            }
            ForEach(Array(glance.orderedSessions.enumerated()), id: \.offset) { _, row in
                SessionRow(row: row, now: now, historical: glance.historical)
                    .listRowBackground(RoundedRectangle(cornerRadius: 14).fill(row.phase.color.opacity(row.phase == .response ? 0.18 : 0.08)))
            }
            if let total = glance.total, total > glance.sessions.count {
                Text("+\(total - glance.sessions.count) more on your Mac").font(.caption2).foregroundStyle(WatchTheme.subtext)
                    .listRowBackground(Color.clear)
            }
        }
        .toolbar { RefreshToolbarItem(model: model) }
        .navigationTitle("Sessions")
    }
}

private struct SessionRow: View {
    let row: RemoteSessionDetail
    let now: Date
    let historical: Bool

    var body: some View {
        HStack(spacing: 8) {
            AgentBadge(agent: row.agent, size: 30, ring: row.phase == .response ? WatchTheme.waiting : nil)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.agent.displayName).font(.footnote.weight(.semibold)).foregroundStyle(WatchTheme.text)
                    .lineLimit(1).minimumScaleFactor(0.8)
                // The state always reads in full; elapsed time drops first when narrow.
                ViewThatFits(in: .horizontal) {
                    phaseLine(elapsed: Duration.compact(since: row.startedAt, now: now))
                    phaseLine(elapsed: nil)
                }
                .font(.caption2)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 1) {
                if let subagents = row.activeSubagents, subagents > 0 {
                    Label("\(subagents)", systemImage: "person.2.fill").accessibilityLabel("\(subagents) subagents")
                }
                if let jobs = row.backgroundJobs, jobs > 0 {
                    Label("\(jobs)", systemImage: "gearshape.2.fill").accessibilityLabel("\(jobs) background jobs")
                }
            }
            .labelStyle(CompactLabelStyle())
            .font(.caption2).foregroundStyle(WatchTheme.subtext)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private func phaseLine(elapsed: String?) -> some View {
        HStack(spacing: 4) {
            Circle().fill(historical ? WatchTheme.offline : row.phase.color).frame(width: 6, height: 6)
            Text(row.phase.label).foregroundStyle(historical ? WatchTheme.offline : row.phase.color)
            if let elapsed { Text(elapsed).foregroundStyle(WatchTheme.subtext) }
        }
        .lineLimit(1).fixedSize()
    }
}

private struct CompactLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 2) { configuration.icon.imageScale(.small); configuration.title }
    }
}

private struct UsagePage: View {
    let glance: WatchGlance
    @ObservedObject var model: WatchObservationModel
    let now: Date

    var body: some View {
        ScrollView {
            VStack(spacing: 8) {
                if let status = model.status {
                    Text(status)
                        .font(.caption2)
                        .foregroundStyle(WatchTheme.subtext)
                        .multilineTextAlignment(.center)
                }
                ForEach(Array(stride(from: 0, to: glance.usage.count, by: 2)), id: \.self) { start in
                    HStack(alignment: .top, spacing: 6) {
                        ForEach(start..<min(start + 2, glance.usage.count), id: \.self) { index in
                            UsageCell(window: glance.usage[index], now: now).frame(maxWidth: .infinity)
                        }
                    }
                }
                Text("Allowance left, as last read by your Mac.").font(.system(size: 10)).foregroundStyle(WatchTheme.faint)
                    .multilineTextAlignment(.center)
                    .padding(.top, 2)
                    .padding(.bottom, 12)
            }
            .padding(.horizontal, 2)
        }
        .toolbar { RefreshToolbarItem(model: model) }
        .navigationTitle("Allowance")
    }
}

private struct UsageCell: View {
    let window: RemoteUsageWindow
    let now: Date

    var body: some View {
        let agedLabel = window.agedLabel(at: now)
        VStack(spacing: 2) {
            UsageDial(window: window, now: now, size: 50)
            HStack(spacing: 3) {
                AgentBrandIcon(agentType: window.providerWire, tint: SessionBrand.color(for: window.providerWire), size: 11)
                Text(window.quantity == .mcp ? "\(window.providerName) MCP" : window.providerName)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(agedLabel == nil ? WatchTheme.text : WatchTheme.subtext)
                    .lineLimit(1).minimumScaleFactor(0.8)
            }
            if let agedLabel {
                HStack(spacing: 2) {
                    Image(systemName: "clock")
                    Text(agedLabel)
                }
                .font(.system(size: 10)).foregroundStyle(WatchTheme.offline).lineLimit(1)
                .accessibilityLabel("Last read \(agedLabel)")
            } else {
                HStack(spacing: 2) {
                    Image(systemName: "arrow.counterclockwise")
                    Text(window.resetsAt, format: .relative(presentation: .numeric, unitsStyle: .narrow))
                }
                .font(.system(size: 10)).foregroundStyle(WatchTheme.subtext).lineLimit(1)
                .accessibilityLabel("Resets")
            }
        }
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
import WidgetKit

/// QA pin: the complication views at their face sizes for three fixtures.
/// Rendered outside WidgetKit, so the corner gauge label and accented tinting
/// are absent; a real face is the acceptance surface.
private struct ComplicationGallery: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(["busy", "working", "clear", "stopped"], id: \.self) { name in
                    let glance = WatchGlance.make(WatchFixture.named(name), at: .now)
                    Text(name).font(.caption2).foregroundStyle(WatchTheme.faint)
                    HStack(spacing: 8) {
                        GlanceComplicationView(glance: glance, familyOverride: .accessoryCircular)
                            .frame(width: 50, height: 50)
                        GlanceComplicationView(glance: glance, familyOverride: .accessoryCorner)
                            .frame(width: 40, height: 40)
                    }
                    GlanceComplicationView(glance: glance, familyOverride: .accessoryRectangular)
                        .frame(width: 180, height: 56, alignment: .leading)
                    GlanceComplicationView(glance: glance, familyOverride: .accessoryInline)
                        .font(.caption)
                }
            }
            .padding(.horizontal, 6)
        }
        .background(.black)
    }
}
#endif
