#if os(macOS)
import SwiftUI

/// Reported edges do not attach to real agent creatures until independently correlated.
struct DotInteractionView: View {
    let events: [DotInteractionEvent]
    var now: Int
    private var relations: [(id: String, history: [DotInteractionEvent])] {
        Dictionary(grouping: events, by: \.relationId).map { (id: $0.key, history: $0.value) }
            .sorted { ($0.history.last?.receivedAt ?? 0) > ($1.history.last?.receivedAt ?? 0) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(relations, id: \.id) { relation in
                if let event = relation.history.last {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .top, spacing: 8) {
                            if event.direction == "dot_to_agent" { Text("Dot").bold(); Image(systemName: "arrow.right"); target(event) }
                            else { target(event); Image(systemName: "arrow.right"); Text("Dot").bold() }
                        }.font(.callout)
                        Text("\(event.kind) · \(event.stage) · Dot report").font(.caption)
                        if event.receivedAt > now || now - event.receivedAt >= DotLimits.reportFreshMs {
                            Text("Historical report · current interaction unknown").font(.caption).foregroundStyle(.secondary)
                        }
                        Text(verbatim: DotSettingsView.displayText(event.summary)).font(.callout)
                        DisclosureGroup("History · \(relation.history.count) reports") {
                            ForEach(Array(relation.history.enumerated()), id: \.offset) { _, item in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("#\(item.sequence) · \(item.stage) · \(Date(timeIntervalSince1970: Double(item.receivedAt) / 1000).formatted())").font(.caption)
                                    Text(verbatim: DotSettingsView.displayText(item.summary)).font(.caption).foregroundStyle(.secondary)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }.font(.caption)
                    }.padding(10).background(DesignTokens.Ink.s800.opacity(0.25), in: RoundedRectangle(cornerRadius: DesignTokens.Radius.md))
                }
            }
        }
    }
    private func target(_ event: DotInteractionEvent) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: DotSettingsView.displayText(event.targetRef ?? "Unknown target")).lineLimit(2)
            Text("Identity and acknowledgement unverified").font(.caption2).foregroundStyle(.secondary)
        }
    }
}
#endif
