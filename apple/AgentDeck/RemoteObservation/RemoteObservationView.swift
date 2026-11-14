import SwiftUI

struct RemoteObservationView: View {
    var embedded = false
    @ObservedObject private var model = RemoteObservationController.shared
    @Environment(\.scenePhase) private var scenePhase
    @State private var confirmDelete = false

    var body: some View {
        Group {
            if embedded { content }
            else { ScrollView { content } }
        }
        .background(DesignTokens.Ink.s900.opacity(0.04))
        .task { await model.foreground() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await model.foreground() } }
        }
        .confirmationDialog("Delete this Mac's remote data?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Stop sharing and delete remote data", role: .destructive) { Task { await model.stopSharing(delete: true) } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Removes its observations, attention events and notification subscriptions from iCloud. If offline, deletion stays pending until this Mac reconnects with the original account. Already delivered alerts may remain on your devices.")
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 20) {
            #if os(macOS)
            Label("Remote monitoring", systemImage: "icloud")
                .font(.title2.bold())
            publisher
            #else
            reader
            #endif
            Text(model.status).font(.callout).foregroundStyle(.secondary)
                .accessibilityIdentifier("remote-observation.status")
            if !model.attentionStatus.isEmpty {
                Text(model.attentionStatus).font(.callout).foregroundStyle(.secondary)
            }
            if !model.notificationStatus.isEmpty {
                Text(model.notificationStatus).font(.callout).foregroundStyle(.secondary)
            }
            if model.busy { ProgressView("Checking iCloud…") }
            #if os(macOS)
            privacyDetails
            #else
            DisclosureGroup("About remote monitoring") {
                privacyDetails.padding(.top, 8)
            }
            .font(.footnote)
            #endif
        }
        .padding(24)
        .frame(maxWidth: 640, alignment: .leading)
        .frame(maxWidth: .infinity)
    }

    private var privacyDetails: some View {
        Text("Uses your private iCloud storage. Both devices use the same Apple Account. Your Mac must be running and online to publish new observations. Prompts, project names, transcripts and credentials stay local. Apple controls notification timing and eligible Watch forwarding.")
            .font(.footnote).foregroundStyle(.secondary)
    }

    #if os(macOS)
    private var publisher: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Share work status from this Mac").font(.headline)
            Text("Shares encrypted work counts and attention updates with your devices.")
            if model.writer?.enabled == true {
                Label("Sharing enabled", systemImage: "checkmark.icloud")
                    .foregroundStyle(DesignTokens.Status.processing)
                Toggle(isOn: Binding(get: { model.writer?.includeDetails == true }, set: { enabled in
                    Task { await model.setDetailsSharing(enabled) }
                })) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Share session and usage details")
                        Text("Includes agent types, states, start times, child and background activity counts, and available account limits.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .disabled(model.busy)
                Button("Stop sharing") { Task { await model.stopSharing() } }
            } else {
                Button("Enable sharing") { Task { await model.enableSharing() } }
                    .disabled(model.busy || model.writer.map { $0.intent != .none } == true)
            }
            if model.writer.map({ $0.intent != .none }) == true {
                Text("Remote cleanup pending").foregroundStyle(DesignTokens.Status.awaiting)
                Button("Retry pending cleanup") { Task { await model.publishIfNeeded(force: true) } }.disabled(model.busy)
            }
            if model.writer != nil {
                Button("Delete remote data…", role: .destructive) { confirmDelete = true }
            }
        }
    }
    #else
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.colorScheme) private var colorScheme
    @State private var showAllSessions = false

    private var reader: some View {
        VStack(alignment: .leading, spacing: 16) {
            ViewThatFits(in: .horizontal) {
                HStack { readerTitle; Spacer(); if model.reader.receiving { refreshButton } }
                VStack(alignment: .leading, spacing: 8) {
                    readerTitle
                    if model.reader.receiving { refreshButton }
                }
            }
            if model.reader.receiving {
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    observation(at: context.date)
                }
                DisclosureGroup("Remote settings") {
                    VStack(alignment: .leading, spacing: 12) {
                        notificationButton.buttonStyle(.bordered)
                        Button("Stop receiving") { Task { await model.stopReceiving() } }
                    }
                    .padding(.top, 10)
                }
                .font(.subheadline)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Share from your Mac", systemImage: "desktopcomputer")
                        .font(.headline)
                    Text("Turn on sharing in your Mac’s Remote Monitoring settings. Then see its activity here, wherever you are.")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Button {
                        Task { await model.enableReceiving() }
                    } label: {
                        Label("Enable remote monitoring", systemImage: "icloud.and.arrow.down")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.reader.unsubscribePending)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
            if model.reader.unsubscribePending {
                Label("Notification cleanup pending for the original Apple Account", systemImage: "bell.slash")
                    .font(.footnote).foregroundStyle(.secondary)
                Button("Retry subscription cleanup") { Task { await model.refresh(force: true) } }.disabled(model.busy)
            }
        }
    }

    private var readerTitle: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Mac activity").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            Label("iCloud · Read only", systemImage: "eye")
                .font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private var refreshButton: some View {
        Button {
            Task { await model.refresh(force: true) }
        } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
        }
        .labelStyle(.iconOnly)
        .buttonStyle(.bordered)
        .disabled(model.busy)
    }

    private var notificationButton: some View {
        Button {
            Task { await model.enableNotifications() }
        } label: {
            Label(model.reader.notifications ? "Check notification setup" : "Enable notifications",
                  systemImage: model.reader.notifications ? "bell.badge" : "bell")
        }
        .disabled(model.busy || model.snapshot == nil || model.snapshot?.sourceState == .disabled)
    }

    @ViewBuilder
    private func observation(at date: Date) -> some View {
        if let snapshot = model.snapshot {
            VStack(alignment: .leading, spacing: 16) {
                summaryCard(snapshot, at: date)
                if snapshot.sourceState == .observed,
                   [.recent, .historical].contains(snapshot.freshness(at: date)) {
                    if let details = snapshot.details {
                        sessionCard(details)
                        usageCard(details.usage.filter { $0.isVisible(at: date) }, at: date)
                    } else {
                        Label("For sessions and usage, turn on detailed sharing on your Mac.", systemImage: "desktopcomputer")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        } else {
            ContentUnavailableView(
                "Waiting for a Mac",
                systemImage: "desktopcomputer",
                description: Text("Turn on sharing in your Mac’s Remote Monitoring settings.")
            )
        }
    }

    private func summaryCard(_ snapshot: RemoteObservationSnapshot, at date: Date) -> some View {
        dashboardCard {
            if snapshot.sourceState == .disabled {
                Label("Sharing stopped on the Mac", systemImage: "icloud.slash")
            } else if snapshot.sourceState == .unavailable {
                Label("Mac session status is unconfirmed", systemImage: "questionmark.circle")
            } else {
                switch snapshot.freshness(at: date) {
                case .recent, .historical:
                    Text(model.usingCache || snapshot.freshness(at: date) == .historical ? "Last saved observation" : "Last observed on the Mac")
                        .foregroundStyle(.secondary)
                    let layout = dynamicTypeSize.isAccessibilitySize
                        ? AnyLayout(VStackLayout(spacing: 10))
                        : AnyLayout(HStackLayout(alignment: .top, spacing: 10))
                    layout {
                        metric(snapshot.workingCount, title: "Working", symbol: "bolt.horizontal",
                               color: DesignTokens.Session.working)
                        metric(snapshot.waitingCount, title: "Waiting for response", symbol: "exclamationmark.bubble",
                               color: DesignTokens.Session.awaiting)
                    }
                case .expired: Text("The shared observation expired. Refresh to check for a newer one.")
                case .unknown: Text("Observation freshness is unknown. Counts are withheld.")
                }
            }
            if let observedAt = snapshot.observedAt {
                Text("Observed \(observedAt.formatted(date: .abbreviated, time: .standard))")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("remote-observation.source-time")
            }
            if let event = model.attentionEvent {
                Divider()
                Label("Attention update", systemImage: "bell.badge").font(.headline)
                Text(eventText(event.presentation(snapshot: model.usingCache ? nil : snapshot, at: date)))
                    .accessibilityIdentifier("remote-observation.event-state")
                Text(event.occurredAt, format: .dateTime.month().day().hour().minute().second()).font(.caption)
            }
        }
    }

    private func sessionCard(_ details: RemoteObservationDetails) -> some View {
        dashboardCard {
            Label("Sessions (\(details.sessionCount))", systemImage: "rectangle.stack")
                .font(.headline).accessibilityAddTraits(.isHeader)
            if details.sessions.isEmpty {
                Text("No active sessions observed").font(.subheadline).foregroundStyle(.secondary)
            }
            let visible = showAllSessions ? details.sessions[...] : details.sessions.prefix(4)
            ForEach(visible.indices, id: \.self) { index in
                if index > 0 { Divider() }
                sessionRow(visible[index])
            }
            if details.sessions.count > 4 {
                Button(showAllSessions ? "Show fewer sessions" : "Show all shared sessions") {
                    showAllSessions.toggle()
                }
                .font(.subheadline)
            }
            if showAllSessions, details.sessionCount > details.sessions.count {
                Text("Showing \(details.sessions.count) of \(details.sessionCount) sessions")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func sessionRow(_ session: RemoteSessionDetail) -> some View {
        let state: (title: LocalizedStringKey, icon: String, color: Color) = switch session.phase {
        case .response: ("Needs response", "exclamationmark.bubble", DesignTokens.Session.awaiting)
        case .working: ("Working", "bolt.horizontal", DesignTokens.Session.working)
        case .awaiting: ("Waiting", "pause.circle", DesignTokens.Session.awaiting)
        case .idle: ("Idle", "moon", DesignTokens.Session.idle)
        case .unknown: ("Unconfirmed", "questionmark.circle", .secondary)
        }
        return VStack(alignment: .leading, spacing: 4) {
            ViewThatFits(in: .horizontal) {
                HStack { agentName(session); Spacer(); Label(state.title, systemImage: state.icon).foregroundStyle(state.color) }
                VStack(alignment: .leading, spacing: 4) {
                    agentName(session)
                    Label(state.title, systemImage: state.icon).foregroundStyle(state.color)
                }
            }
            .font(.subheadline)
            if let start = session.startedAt {
                Text("Started \(start.formatted(date: .abbreviated, time: .shortened))")
            }
            if let count = session.activeSubagents, count > 0 { Text("Active subagents: \(count)") }
            if let count = session.backgroundJobs, count > 0 { Text("Background jobs: \(count)") }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }

    private func agentName(_ session: RemoteSessionDetail) -> some View {
        Text(displayAgentLabel(session.agent == .unknown ? nil : session.agent.rawValue))
            .fontWeight(.semibold).foregroundStyle(.primary)
    }

    private func usageCard(_ windows: [RemoteUsageWindow], at date: Date) -> some View {
        dashboardCard {
            Label("Usage", systemImage: "gauge.with.dots.needle.50percent")
                .font(.headline).accessibilityAddTraits(.isHeader)
            if windows.isEmpty {
                Text("No account limits available from this Mac").font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(RemoteUsageWindow.Provider.allCases, id: \.self) { provider in
                let group = windows.filter { $0.provider == provider }
                if !group.isEmpty {
                    Divider()
                    Text(providerName(provider)).font(.subheadline.bold())
                    ForEach(group.indices, id: \.self) { usageRow(group[$0], at: date) }
                }
            }
        }
    }

    private func providerName(_ provider: RemoteUsageWindow.Provider) -> LocalizedStringKey {
        switch provider {
        case .codex: "Codex"
        case .zai: "z.ai"
        }
    }

    private func usageRow(_ window: RemoteUsageWindow, at date: Date) -> some View {
        let aged = window.provider == .codex
            && date.timeIntervalSince(window.observedAt) > CodexUsageFreshness.snapshotStaleInterval
        let color = UsageSeverity.color(aged ? -1 : 100 - window.remainingPercent, onPaper: colorScheme == .light)
        let duration = TopologyRail.windowLabel(window.durationMinutes)
        let percentage = (window.remainingPercent / 100).formatted(.percent.precision(.fractionLength(0...1)))
        return VStack(alignment: .leading, spacing: 5) {
            ViewThatFits(in: .horizontal) {
                HStack {
                    usageLabel(window, duration: duration)
                    Spacer()
                    Text("\(percentage) left").fontWeight(.semibold).foregroundStyle(color)
                }
                VStack(alignment: .leading) {
                    usageLabel(window, duration: duration)
                    Text("\(percentage) left").fontWeight(.semibold).foregroundStyle(color)
                }
            }
            .font(.subheadline)
            ProgressView(value: window.remainingPercent, total: 100)
                .tint(color).accessibilityHidden(true)
            Text("Read \(window.observedAt.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
            if !aged {
                Text("Resets \(window.resetsAt.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func usageLabel(_ window: RemoteUsageWindow, duration: String) -> Text {
        window.quantity == .mcp ? Text("MCP · \(duration)") : Text(duration)
    }

    private func dashboardCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12, content: content)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    private func metric(_ count: Int?, title: LocalizedStringKey, symbol: String, color: Color) -> some View {
        let active = (count ?? 0) > 0
        return VStack(alignment: .leading, spacing: 6) {
            Image(systemName: symbol)
                .foregroundStyle(active ? color : .secondary)
                .accessibilityHidden(true)
            Text(count.map(String.init) ?? "Unknown")
                .font(.custom(DesignTokens.Font.mono, size: DesignTokens.FontSize.h3Lg, relativeTo: .largeTitle))
                .foregroundStyle(active ? color : .primary)
            Text(title).font(.caption)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(active ? color.opacity(0.12) : DesignTokens.Ink.s900.opacity(0.06),
                    in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .combine)
    }

    private func eventText(_ status: RemoteAttentionEvent.Presentation) -> String {
        switch status {
        case .waiting: return "The latest observation still shows this response wait."
        case .resolved: return "This response wait was resolved on the Mac."
        case .expired: return "This alert expired. Refresh the summary for the latest work status."
        case .sharingStopped: return "Sharing stopped. The current state of this request is unknown."
        case .unconfirmed: return "The current state of this response wait cannot be confirmed."
        }
    }
    #endif
}

#if os(iOS)
/// Remote monitoring remains reachable while LAN discovery is offline or onboarding is incomplete.
struct CompanionRootView: View {
    @EnvironmentObject private var preferences: AppPreferences
    @ObservedObject private var remote = RemoteObservationController.shared
    var body: some View {
        TabView(selection: $remote.selectedTab) {
            Group {
                if preferences.hasSeenOnboarding { ContentView() }
                else { OnboardingScreen() }
            }
            .tabItem { Label("Direct", systemImage: "desktopcomputer") }.tag(RemoteObservationController.CompanionTab.local)
            RemoteObservationView()
                .tabItem { Label("Remote", systemImage: "icloud") }.tag(RemoteObservationController.CompanionTab.remote)
        }
    }
}
#endif
