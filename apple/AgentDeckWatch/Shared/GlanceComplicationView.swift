import SwiftUI
import WidgetKit

/// Complication faces for `AgentDeckComplication`. Shared with the app so the
/// Debug gallery can render the same views.
struct GlanceComplicationView: View {
    @Environment(\.widgetFamily) private var environmentFamily
    @Environment(\.widgetRenderingMode) private var renderingMode
    let glance: WatchGlance
    /// Debug gallery only: WidgetKit's family is not settable outside a widget.
    var familyOverride: WidgetFamily? = nil

    private var family: WidgetFamily { familyOverride ?? environmentFamily }

    var body: some View {
        switch family {
        case .accessoryInline: inline(glance)
        case .accessoryRectangular: rectangular(glance)
        case .accessoryCorner: corner(glance)
        default: circular(glance)
        }
    }

    private func headlineNumber(_ glance: WatchGlance) -> String {
        switch glance.mode {
        case .needsYou: return "\(glance.waiting ?? 0)"
        case .working: return "\(glance.working ?? 0)"
        case .allClear: return "0"
        default: return "—"
        }
    }

    private func headlineText(_ glance: WatchGlance) -> String {
        switch glance.mode {
        case .needsYou: return (glance.waiting ?? 0) == 1 ? String(localized: "1 needs you") : String(localized: "\(glance.waiting ?? 0) need you")
        case .working: return String(localized: "\(glance.working ?? 0) working")
        case .allClear: return String(localized: "All clear")
        case .sharingStopped: return String(localized: "Sharing off")
        case .sourceUnavailable: return String(localized: "Mac can't see sessions")
        case .unavailable: return String(localized: "No summary")
        }
    }

    private func inline(_ glance: WatchGlance) -> some View {
        let symbol = glance.mode == .needsYou ? "hand.raised.fill" : (glance.mode == .working ? "waveform" : "checkmark.circle")
        let text = headlineText(glance)
        return Label(glance.historical ? String(localized: "Last: \(text)") : text, systemImage: symbol)
    }

    private func circular(_ glance: WatchGlance) -> some View {
        ZStack {
            AccessoryWidgetBackground()
            AttentionRing(glance: glance, lineWidth: 5).padding(3).widgetAccentable()
            VStack(spacing: -2) {
                Text(headlineNumber(glance))
                    .font(.system(size: 20, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(WatchTheme.tint(glance))
                Image(systemName: glance.mode == .needsYou ? "hand.raised.fill" : (glance.mode == .working ? "waveform" : "checkmark"))
                    .font(.system(size: 9, weight: .bold)).foregroundStyle(WatchTheme.tint(glance))
            }
        }
        .accessibilityLabel(headlineText(glance))
    }

    private func rectangular(_ glance: WatchGlance) -> some View {
        HStack(spacing: 8) {
            ZStack {
                AttentionRing(glance: glance, lineWidth: 4).widgetAccentable()
                Text(headlineNumber(glance))
                    .font(.system(size: 17, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(WatchTheme.tint(glance))
            }
            .frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(headlineText(glance)).font(.headline).foregroundStyle(WatchTheme.tint(glance))
                    .lineLimit(1).minimumScaleFactor(0.7).widgetAccentable()
                if !glance.sessions.isEmpty, renderingMode == .fullColor {
                    HStack(spacing: 2) {
                        ForEach(Array(glance.orderedSessions.prefix(5).enumerated()), id: \.offset) { _, row in
                            AgentBadge(agent: row.agent, size: 14, ring: row.phase == .response ? WatchTheme.waiting : nil)
                        }
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
        let number = Text(headlineNumber(glance))
            .font(.system(size: 22, weight: .bold, design: .rounded)).monospacedDigit()
            .foregroundStyle(WatchTheme.tint(glance))
        if let usage = glance.lowestUsage {
            number.widgetLabel {
                Gauge(value: usage.remainingPercent, in: 0...100) { Text(usage.windowLabel) }
                    currentValueLabel: { Text("\(Int(usage.remainingPercent.rounded()))%") }
                    .tint(usage.color)
            }
        } else {
            number.widgetLabel { Text(headlineText(glance)) }
        }
    }
}
