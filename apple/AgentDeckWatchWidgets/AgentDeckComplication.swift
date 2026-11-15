import SwiftUI
import WidgetKit

struct GlanceEntry: TimelineEntry {
    let date: Date
    let snapshot: RemoteObservationSnapshot?
    var glance: WatchGlance { WatchGlance.make(snapshot, at: date) }
}

/// Fetches the Remote V1 snapshot itself (the extension has its own container
/// and no App Group). Entries at the snapshot's freshness and allowance
/// boundaries let the face age without another fetch; a failed fetch shows no
/// count rather than a guessed one.
struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry {
        GlanceEntry(date: .now, snapshot: Self.sample)
    }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)); return }
        let done = CompletionBox(completion)
        Task { done.call(GlanceEntry(date: .now, snapshot: await Self.fetch())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        let done = CompletionBox(completion)
        Task {
            let snapshot = await Self.fetch()
            let now = Date()
            let entries = ([now] + WatchGlance.transitions(for: snapshot, after: now))
                .map { GlanceEntry(date: $0, snapshot: snapshot) }
            done.call(Timeline(entries: entries, policy: .after(now.addingTimeInterval(15 * 60))))
        }
    }

    static func fetch() async -> RemoteObservationSnapshot? {
        #if DEBUG
        if let pinned = WatchFixture.fromLaunchArguments() { return pinned }
        #endif
        let store = RemoteObservationCloudStore()
        guard let account = try? await store.account() else { return nil }
        return try? await store.snapshot(account: account)
    }

    /// Gallery preview only; never shown as a live reading.
    static var sample: RemoteObservationSnapshot? {
        let now = Date()
        let rows = [RemoteSessionDetail(agent: .claude, phase: .response, startedAt: now, activeSubagents: nil, backgroundJobs: nil),
                    RemoteSessionDetail(agent: .codexCLI, phase: .working, startedAt: now, activeSubagents: nil, backgroundJobs: nil),
                    RemoteSessionDetail(agent: .openCode, phase: .working, startedAt: now, activeSubagents: nil, backgroundJobs: nil)]
        return RemoteObservationSnapshot(installationID: UUID(), revision: 1, sourceState: .observed, observedAt: now,
            publishedAt: now, expiresAt: now.addingTimeInterval(3_600), workingCount: 2, waitingCount: 1, activeEventIDs: [],
            details: RemoteObservationDetails(sessions: rows, sessionCount: 3, usage: []))
    }
}

/// WidgetKit's completion handlers are not `Sendable`; the box carries one
/// across the fetch's suspension point, where it is called exactly once.
private struct CompletionBox<T>: @unchecked Sendable {
    let call: (T) -> Void
    init(_ call: @escaping (T) -> Void) { self.call = call }
}

@main
struct AgentDeckComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AgentDeckGlance", provider: GlanceProvider()) { entry in
            GlanceComplicationView(glance: entry.glance)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("AgentDeck")
        .description("Agents waiting for you and working, plus your tightest allowance, as last shared by your Mac.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}
