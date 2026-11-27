import SwiftUI
import WidgetKit

/// Complication faces for `AgentDeckComplication`. Shared with the app so the
/// Debug gallery can render the same views.
struct GlanceComplicationView: View {
    @Environment(\.widgetFamily) private var environmentFamily
    @Environment(\.widgetRenderingMode) private var renderingMode
    let glance: WatchGlance
    var now: Date = .now
    /// Debug gallery only: WidgetKit's family is not settable outside a widget.
    var familyOverride: WidgetFamily? = nil

    private var family: WidgetFamily { familyOverride ?? environmentFamily }

    var body: some View {
        Group {
            switch family {
            case .accessoryInline: inline(glance)
            case .accessoryRectangular: rectangular(glance)
            case .accessoryCorner: corner(glance)
            default: circular(glance)
            }
        }
        .widgetURL(glance.deepLinkURL(preferUsage: family == .accessoryCorner && glance.lowestUsage != nil))
    }

    private func inline(_ glance: WatchGlance) -> some View {
        let text = glance.headlineText
        return Label(glance.historical ? String(localized: "Last: \(text)") : text, systemImage: glance.inlineSymbol)
    }

    private func circular(_ glance: WatchGlance) -> some View {
        ZStack {
            AccessoryWidgetBackground()
            AttentionRing(glance: glance, lineWidth: 5).padding(3).widgetAccentable()
            VStack(spacing: -2) {
                Text(glance.headlineNumber)
                    .font(.system(size: 20, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(WatchTheme.tint(glance))
                Image(systemName: glance.compactSymbol)
                    .font(.system(size: 9, weight: .bold)).foregroundStyle(WatchTheme.tint(glance))
            }
        }
        .accessibilityLabel(glance.headlineText)
    }

    private func rectangular(_ glance: WatchGlance) -> some View {
        HStack(spacing: 8) {
            ZStack {
                AttentionRing(glance: glance, lineWidth: 4).widgetAccentable()
                Text(glance.headlineNumber)
                    .font(.system(size: 17, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(WatchTheme.tint(glance))
            }
            .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(glance.headlineText).font(.headline).foregroundStyle(WatchTheme.tint(glance))
                    .lineLimit(1).minimumScaleFactor(0.7).widgetAccentable()
                if !glance.sessions.isEmpty {
                    if renderingMode == .fullColor {
                        HStack(spacing: 2) {
                            ForEach(Array(glance.orderedSessions.prefix(5).enumerated()), id: \.offset) { _, row in
                                AgentBadge(agent: row.agent, size: 14, ring: row.phase == .response ? WatchTheme.waiting : nil)
                            }
                        }
                    } else {
                        let names = Array(glance.orderedSessions.prefix(3).map(\.agent.displayName)).joined(separator: ", ")
                        Text(names)
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                if let observedAt = glance.observedAt {
                    Group {
                        if glance.historical { Text("Last \(observedAt, style: .time)") }
                        else { Text(observedAt, format: .relative(presentation: .numeric, unitsStyle: .abbreviated)) }
                    }
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func corner(_ glance: WatchGlance) -> some View {
        let number = Text(glance.headlineNumber)
            .font(.system(size: 22, weight: .bold, design: .rounded)).monospacedDigit()
            .foregroundStyle(WatchTheme.tint(glance))
            .widgetAccentable()
        if let usage = glance.lowestUsage {
            let aged = usage.isAged(at: now)
            number.widgetLabel {
                Gauge(value: usage.remainingPercent, in: 0...100) { Text(usage.compactDurationLabel) }
                    currentValueLabel: { Text("\(Int(usage.remainingPercent.rounded()))%") }
                    .tint(aged ? WatchTheme.offline : usage.color(at: now))
            }
        } else {
            number.widgetLabel { Text(glance.headlineText) }
        }
    }
}
