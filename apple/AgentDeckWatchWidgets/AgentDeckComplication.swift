import SwiftUI
import WidgetKit

struct GlanceEntry: TimelineEntry {
    let date: Date
    let snapshot: RemoteObservationSnapshot?
    var glance: WatchGlance { WatchGlance.make(snapshot, at: date) }
    var relevance: TimelineEntryRelevance? {
        TimelineEntryRelevance(score: glance.smartStackRelevanceScore, duration: 15 * 60)
    }
}

/// Fetches the Remote V1 snapshot itself (the extension has its own container
/// and no App Group), keeping a widget-local `WatchSnapshotCache` so transient
/// offline errors retain the last verified observation instead of blanking the
/// watch face. Entries at freshness, expiry and Codex-age boundaries let the
/// face age without another fetch.
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
            // Retry sooner when no snapshot is available (e.g. brief offline); normal cadence is 15 min.
            let refreshInterval: TimeInterval = snapshot == nil ? 5 * 60 : 15 * 60
            done.call(Timeline(entries: entries, policy: .after(now.addingTimeInterval(refreshInterval))))
        }
    }

    static func fetch(
        source: any WatchObservationSource = RemoteObservationCloudStore(),
        cache: WatchSnapshotCache = WatchSnapshotCache(),
        localIdentity: () -> String? = RemoteLocalIdentity.current,
        now: Date = Date()
    ) async -> RemoteObservationSnapshot? {
        #if DEBUG
        if let pinned = WatchFixture.fromLaunchArguments(now: now) { return pinned }
        #endif
        let localID = localIdentity()
        do {
            let account = try await source.account()
            let cached = cache.load(localIdentity: localID, verifiedAccount: account.identity, now: now)
            do {
                guard let live = try await source.snapshot(account: account) else {
                    try? cache.clear()
                    return nil
                }
                try? cache.save(live, account: account.identity, localIdentity: localID)
                return live
            } catch {
                // Transient CloudKit read failure: keep the verified same-account cache.
                return cached
            }
        } catch RemoteObservationError.noAccount, RemoteObservationError.accountChanged {
            try? cache.clear()
            return nil
        } catch {
            // Offline or unverified account check: restore only if local iCloud token matches.
            return cache.load(localIdentity: localID, now: now)
        }
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
            GlanceComplicationView(glance: entry.glance, now: entry.date)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("AgentDeck")
        .description("Agents waiting for you and working, plus your tightest allowance, as last shared by your Mac.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}
