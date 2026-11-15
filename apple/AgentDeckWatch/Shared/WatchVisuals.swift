import SwiftUI

/// Visual vocabulary for the Watch app, its complications and its notification:
/// one meaning per colour (DESIGN.md §2.7), official agent marks, and an
/// aquarium-depth background. Only the waiting state may pulse.
enum WatchTheme {
    static let waiting = DesignTokens.Session.awaiting
    static let working = DesignTokens.Session.working
    static let idle = DesignTokens.Session.idle
    static let offline = DesignTokens.Session.offline
    static let text = DesignTokens.UI.hudText
    static let subtext = DesignTokens.UI.hudSubtext
    static let faint = DesignTokens.UI.hudFaint

    static func background(for mode: WatchGlance.Mode) -> LinearGradient {
        let glow: Color = switch mode {
        case .needsYou: waiting.opacity(0.22)
        case .working: working.opacity(0.16)
        default: DesignTokens.UI.waterShallow.opacity(0.5)
        }
        return LinearGradient(colors: [glow, DesignTokens.UI.waterMid, DesignTokens.UI.waterDeep],
                              startPoint: .top, endPoint: .bottom)
    }

    static func tint(_ glance: WatchGlance) -> Color {
        if glance.historical { return offline }
        switch glance.mode {
        case .needsYou: return waiting
        case .working: return working
        case .allClear: return idle
        case .sourceUnavailable, .sharingStopped, .unavailable: return offline
        }
    }
}

extension RemoteSessionDetail.Agent {
    /// The wire agent type, which also keys brand colour and mark.
    var wire: String? { self == .unknown ? nil : rawValue }

    var displayName: String {
        switch self {
        case .claude: return "Claude Code"
        case .codexCLI: return "Codex"
        case .codexApp: return "Codex App"
        case .openCode: return "OpenCode"
        case .openClaw: return "OpenClaw"
        case .antigravity: return "Antigravity"
        case .hermes: return "Hermes"
        case .kiroCLI: return "Kiro CLI"
        case .kiroIDE: return "Kiro IDE"
        case .unknown: return String(localized: "Agent")
        }
    }

    var brand: Color { SessionBrand.color(for: wire) }
}

extension RemoteSessionDetail.Phase {
    var color: Color {
        switch self {
        case .response: return WatchTheme.waiting
        case .working: return WatchTheme.working
        case .awaiting: return WatchTheme.waiting.opacity(0.7)
        case .idle, .unknown: return WatchTheme.idle
        }
    }

    var label: String {
        switch self {
        case .response: return String(localized: "Needs you")
        case .working: return String(localized: "Working")
        case .awaiting: return String(localized: "Waiting")
        case .idle: return String(localized: "Idle")
        case .unknown: return String(localized: "Unknown")
        }
    }
}

extension RemoteUsageWindow {
    var providerName: String { provider == .codex ? "Codex" : "z.ai" }
    var providerWire: String { provider == .codex ? "codex-cli" : "zai" }

    var windowLabel: String {
        if durationMinutes % 10_080 == 0 { return "\(durationMinutes / 10_080)w" }
        if durationMinutes % 1_440 == 0 { return "\(durationMinutes / 1_440)d" }
        if durationMinutes % 60 == 0 { return "\(durationMinutes / 60)h" }
        return "\(durationMinutes)m"
    }

    /// Remaining allowance colour: plenty reads calm, scarce reads as attention.
    var color: Color {
        remainingPercent <= 15 ? DesignTokens.Session.error
            : (remainingPercent <= 40 ? WatchTheme.waiting : DesignTokens.UI.ok)
    }
}

/// An official agent mark on a brand-tinted disc.
struct AgentBadge: View {
    let agent: RemoteSessionDetail.Agent
    var size: CGFloat = 26
    var ring: Color? = nil

    var body: some View {
        ZStack {
            Circle().fill(agent.brand.opacity(0.22))
            AgentBrandIcon(agentType: agent.wire ?? "", tint: agent.brand, size: size, contentInset: size * 0.2)
            if agent == .unknown {
                Image(systemName: "sparkle").font(.system(size: size * 0.45, weight: .semibold)).foregroundStyle(WatchTheme.subtext)
            }
        }
        .frame(width: size, height: size)
        .overlay { if let ring { Circle().strokeBorder(ring, lineWidth: max(1.5, size * 0.08)) } }
        .accessibilityLabel(agent.displayName)
    }
}

/// The session roster as arcs: waiting, working, then everything else.
/// With no observed counts the ring is a faint dashed outline, never a zero.
struct AttentionRing: View {
    let glance: WatchGlance
    var lineWidth: CGFloat = 10
    var pulse = false

    var body: some View {
        let waiting = Double(glance.waiting ?? 0)
        let working = Double(glance.working ?? 0)
        let total = max(Double(glance.total ?? 0), waiting + working, 1)
        let gap = total > 1 ? 0.012 : 0
        ZStack {
            Circle().stroke(WatchTheme.faint.opacity(0.35),
                            style: StrokeStyle(lineWidth: lineWidth, dash: glance.hasCounts ? [] : [2, 5]))
            if glance.hasCounts {
                arc(from: 0, to: waiting / total, gap: gap, color: glance.historical ? WatchTheme.offline : WatchTheme.waiting)
                arc(from: waiting / total, to: (waiting + working) / total, gap: gap,
                    color: glance.historical ? WatchTheme.offline.opacity(0.7) : WatchTheme.working)
                arc(from: (waiting + working) / total, to: 1, gap: gap, color: WatchTheme.idle.opacity(0.45))
            }
        }
        .rotationEffect(.degrees(-90))
        .phaseAnimator(pulse ? [false, true] : [false]) { view, lit in
            view.shadow(color: WatchTheme.waiting.opacity(lit ? 0.75 : 0.15), radius: lit ? lineWidth : lineWidth * 0.3)
        } animation: { _ in .easeInOut(duration: 1.1) }
    }

    @ViewBuilder
    private func arc(from start: Double, to end: Double, gap: Double, color: Color) -> some View {
        if end - start > gap * 2 || (end > start && gap == 0) {
            Circle().trim(from: start + gap, to: end - gap)
                .stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
        }
    }
}

/// "How old is this" as a coloured capsule — recent is a live dot, historical is a clock.
struct FreshnessChip: View {
    let glance: WatchGlance

    var body: some View {
        if let observedAt = glance.observedAt {
            HStack(spacing: 4) {
                Image(systemName: glance.historical ? "clock.arrow.circlepath" : "circle.fill")
                    .font(.system(size: glance.historical ? 10 : 6))
                    .foregroundStyle(glance.historical ? WatchTheme.offline : DesignTokens.UI.ok)
                if glance.historical {
                    Text("Last seen \(observedAt, style: .time)")
                } else {
                    Text(observedAt, format: .relative(presentation: .numeric, unitsStyle: .abbreviated))
                }
            }
            .font(.caption2.weight(.medium))
            .foregroundStyle(WatchTheme.subtext)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(.white.opacity(0.08), in: Capsule())
            .accessibilityElement(children: .combine)
        }
    }
}

/// A remaining-allowance ring with the provider mark inside.
struct UsageDial: View {
    let window: RemoteUsageWindow
    var size: CGFloat = 52

    var body: some View {
        ZStack {
            Circle().stroke(WatchTheme.faint.opacity(0.35), lineWidth: size * 0.11)
            Circle().trim(from: 0, to: window.remainingPercent / 100)
                .stroke(window.color, style: StrokeStyle(lineWidth: size * 0.11, lineCap: .round))
                .rotationEffect(.degrees(-90))
            VStack(spacing: 0) {
                Text("\(Int(window.remainingPercent.rounded()))")
                    .font(.system(size: size * 0.3, weight: .bold, design: .rounded)).monospacedDigit()
                    .foregroundStyle(WatchTheme.text)
                Text(window.windowLabel).font(.system(size: size * 0.17, weight: .semibold)).foregroundStyle(WatchTheme.subtext)
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(window.providerName) \(window.windowLabel) \(Int(window.remainingPercent.rounded())) percent left")
    }
}

extension Duration {
    /// "42m", "3h 5m" — compact elapsed time for a row.
    static func compact(since start: Date?, now: Date) -> String? {
        guard let start, start <= now else { return nil }
        let minutes = Int(now.timeIntervalSince(start) / 60)
        if minutes < 1 { return String(localized: "now") }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        return hours < 24 ? (minutes % 60 == 0 ? "\(hours)h" : "\(hours)h \(minutes % 60)m") : "\(hours / 24)d"
    }
}
