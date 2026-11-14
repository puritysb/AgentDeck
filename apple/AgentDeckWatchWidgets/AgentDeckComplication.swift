import SwiftUI
import WidgetKit

struct GlanceEntry: TimelineEntry {
    let date: Date
    let summary: RemoteRosterSummary?
    var glance: RemoteGlance { RemoteGlance.make(summary, at: date) }
}

/// Fetches the shared summary itself (the extension has its own container and
/// no App Group). Entries at the summary's freshness boundaries let the face
/// go historical, then blank, without another fetch; a failed fetch shows no
/// count rather than a guessed one.
struct GlanceProvider: TimelineProvider {
    func placeholder(in context: Context) -> GlanceEntry {
        GlanceEntry(date: .now, summary: RemoteRosterSummary(schemaVersion: 1, observedAt: .now, workingCount: 2, waitingCount: 1))
    }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        if context.isPreview { completion(placeholder(in: context)); return }
        let done = CompletionBox(completion)
        Task { done.call(GlanceEntry(date: .now, summary: await Self.fetch())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        let done = CompletionBox(completion)
        Task {
            let now = Date()
            let summary = await Self.fetch()
            let entries = ([now] + RemoteGlance.transitions(for: summary, after: now))
                .map { GlanceEntry(date: $0, summary: summary) }
            done.call(Timeline(entries: entries, policy: .after(now.addingTimeInterval(15 * 60))))
        }
    }

    static func fetch() async -> RemoteRosterSummary? {
        try? await CloudKitProbeStore().fetchRoster()
    }
}

/// WidgetKit's completion handlers are not `Sendable`; the box carries one
/// across the fetch's suspension point, where it is called exactly once.
private struct CompletionBox<T>: @unchecked Sendable {
    let call: (T) -> Void
    init(_ call: @escaping (T) -> Void) { self.call = call }
}

struct GlanceComplicationView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        let glance = entry.glance
        switch family {
        case .accessoryInline:
            Text(glance.inline)
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("AgentDeck").font(.headline).widgetAccentable()
                Text(glance.count.map { glance.headline == .allClear ? glance.title : "\($0) \(glance.title)" } ?? glance.title)
                    .foregroundStyle(glance.tint)
                if let observedAt = glance.observedAt {
                    Text(glance.historical ? "Last \(observedAt, style: .time)" : "\(observedAt, style: .relative) ago")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        case .accessoryCorner:
            Text(glance.count.map(String.init) ?? "—")
                .font(.title3.weight(.bold))
                .foregroundStyle(glance.tint)
                .widgetLabel { Text(glance.inline) }
        default:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text(glance.count.map(String.init) ?? "—")
                        .font(.title2.weight(.bold)).monospacedDigit()
                    Image(systemName: glance.headline == .unavailable ? "icloud.slash" : "person.wave.2")
                        .font(.caption2)
                }
                .foregroundStyle(glance.tint)
            }
        }
    }
}

@main
struct AgentDeckComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "AgentDeckGlance", provider: GlanceProvider()) { entry in
            GlanceComplicationView(entry: entry)
                .containerBackground(.clear, for: .widget)
        }
        .configurationDisplayName("AgentDeck")
        .description("Sessions waiting for you and working, as last shared by your Mac.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}
