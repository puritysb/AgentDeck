import SwiftUI

struct WatchSummaryView: View {
    @ObservedObject var model: WatchObservationModel

    var body: some View {
        // Re-evaluates freshness without a fetch, so a stale count turns
        // historical (and later disappears) while the screen stays open.
        TimelineView(.periodic(from: .now, by: 15)) { context in
            let glance = RemoteGlance.make(model.summary, at: context.date)
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    headline(glance)
                    detail(glance)
                    if let status = model.status {
                        Text(status)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("watch.status")
                    }
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        if model.busy { ProgressView() } else { Label("Refresh", systemImage: "arrow.clockwise") }
                    }
                    .disabled(model.busy)
                    .padding(.top, 4)
                    Text("Read-only. Answer on your Mac or a device on its network.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle("AgentDeck")
        }
    }

    @ViewBuilder
    private func headline(_ glance: RemoteGlance) -> some View {
        if let count = glance.count, glance.headline != .allClear {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("\(count)")
                    .font(.system(size: 48, weight: .bold, design: .rounded))
                    .monospacedDigit()
                Text(glance.title).font(.headline)
            }
            .foregroundStyle(glance.tint)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("watch.headline")
        } else {
            Text(glance.title)
                .font(.title2.weight(.semibold))
                .foregroundStyle(glance.tint)
                .accessibilityIdentifier("watch.headline")
        }
    }

    @ViewBuilder
    private func detail(_ glance: RemoteGlance) -> some View {
        if case .needsYou = glance.headline, let working = glance.workingCount, working > 0 {
            Text("\(working) working").font(.subheadline).foregroundStyle(DesignTokens.Session.working)
        }
        if let observedAt = glance.observedAt {
            if glance.historical {
                Text("Last observed \(observedAt, style: .time) — may be out of date")
                    .font(.footnote).foregroundStyle(.secondary)
            } else {
                Text("Observed \(observedAt, style: .relative) ago")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        } else if model.status == nil {
            Text("Turn on summary sharing in AgentDeck on your Mac (same Apple Account).")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}
