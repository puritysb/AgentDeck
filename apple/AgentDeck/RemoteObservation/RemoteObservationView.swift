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
            Text("Removes its summary, attention events and notification subscriptions from iCloud. If offline, deletion stays pending until this Mac reconnects with the original account. Already delivered alerts may remain on your devices.")
        }
    }

    private var content: some View {
            VStack(alignment: .leading, spacing: 20) {
                Label("Remote monitoring", systemImage: "icloud")
                    .font(.title2.bold())
                #if os(macOS)
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
                Text("Uses your private iCloud storage. Both devices use the same Apple Account. This Mac must be running and online to publish new observations. Apple controls notification timing and eligible Watch forwarding.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(24)
            .frame(maxWidth: 640, alignment: .leading)
            .frame(maxWidth: .infinity)
    }

    #if os(macOS)
    private var publisher: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Share work status from this Mac").font(.headline)
            Text("Shares only encrypted counts, observation times and random attention IDs. Prompts, questions, project names, paths, transcripts and credentials stay on this Mac.")
            if model.writer?.enabled == true {
                Label("Sharing enabled", systemImage: "checkmark.icloud")
                    .foregroundStyle(DesignTokens.Status.processing)
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
    private var reader: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Work status from your Mac").font(.headline)
            Text("Turn on sharing in AgentDeck on your Mac. This view works away from your local network and only reads the shared observation.")
            if model.reader.receiving {
                HStack {
                    Button("Refresh") { Task { await model.refresh(force: true) } }.disabled(model.busy)
                    Button("Stop receiving") { Task { await model.stopReceiving() } }
                }
                Button(model.reader.notifications ? "Check notification setup" : "Enable notifications") {
                    Task { await model.enableNotifications() }
                }.disabled(model.busy)
            } else {
                Button("Enable remote monitoring") { Task { await model.enableReceiving() } }
                    .disabled(model.busy || model.reader.unsubscribePending)
            }
            if model.reader.unsubscribePending {
                Text("Notification subscription cleanup is pending for the original account.")
                Button("Retry subscription cleanup") { Task { await model.refresh(force: true) } }.disabled(model.busy)
            }
            TimelineView(.periodic(from: .now, by: 15)) { context in
                observation(at: context.date)
            }
        }
    }

    @ViewBuilder
    private func observation(at date: Date) -> some View {
        if let snapshot = model.snapshot {
            VStack(alignment: .leading, spacing: 12) {
                if snapshot.sourceState == .disabled {
                    Label("Sharing stopped on the Mac", systemImage: "icloud.slash")
                } else if snapshot.sourceState == .unavailable {
                    Label("Mac session status is unconfirmed", systemImage: "questionmark.circle")
                    Text("The publisher reported that its local source was unavailable. This does not mean the work finished.")
                } else {
                    switch snapshot.freshness(at: date) {
                    case .recent, .historical:
                        Text(model.usingCache || snapshot.freshness(at: date) == .historical ? "Last saved observation" : "Last observed on the Mac")
                            .foregroundStyle(.secondary)
                        HStack(spacing: 24) {
                            count(snapshot.workingCount, title: "Working", color: DesignTokens.Session.working)
                            count(snapshot.waitingCount, title: "Waiting for response", color: DesignTokens.Session.awaiting)
                        }
                        if snapshot.freshness(at: date) == .historical {
                            Text("Historical · no recent source confirmation").foregroundStyle(.secondary)
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
                    Text("Opened attention update").font(.headline)
                    Text(eventText(event.presentation(snapshot: model.usingCache ? nil : snapshot, at: date)))
                        .accessibilityIdentifier("remote-observation.event-state")
                    Text(event.occurredAt, format: .dateTime.month().day().hour().minute().second()).font(.caption)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private func count(_ count: Int?, title: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(count.map(String.init) ?? "Unknown").font(.largeTitle.monospacedDigit()).foregroundStyle(color)
            Text(title).font(.caption)
        }
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
            .tabItem { Label("Local", systemImage: "desktopcomputer") }.tag(RemoteObservationController.CompanionTab.local)
            RemoteObservationView()
                .tabItem { Label("Remote", systemImage: "icloud") }.tag(RemoteObservationController.CompanionTab.remote)
        }
    }
}
#endif
