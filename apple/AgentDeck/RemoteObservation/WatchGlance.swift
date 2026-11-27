import Foundation

/// What a wrist-sized reader may claim from a Remote V1 snapshot. Shared by the
/// Watch app, its complications and its notification view; the iOS tests drive
/// the same rules.
///
/// Counts and rows are shown only while the snapshot is `observed` and its
/// original observation is inside the reader lifetime. Missing, expired or
/// future-dated evidence is `unavailable`, never a synthetic zero: "all clear"
/// needs an observed roster with no work.
struct WatchGlance: Equatable, Sendable {
    enum Mode: Equatable, Sendable {
        case needsYou
        case working
        case allClear
        /// The Mac is sharing but cannot currently see its sessions.
        case sourceUnavailable
        /// The Mac explicitly stopped sharing.
        case sharingStopped
        /// Nothing readable: no snapshot, expired, or unknown freshness.
        case unavailable
    }

    let mode: Mode
    let waiting: Int?
    let working: Int?
    /// All observed sessions on the Mac (may exceed the rows carried).
    let total: Int?
    let historical: Bool
    /// The original source observation time, unchanged by any fetch.
    let observedAt: Date?
    let sessions: [RemoteSessionDetail]
    let usage: [RemoteUsageWindow]

    static let unavailable = WatchGlance(mode: .unavailable, waiting: nil, working: nil, total: nil,
                                         historical: false, observedAt: nil, sessions: [], usage: [])

    var hasCounts: Bool { waiting != nil }

    /// True when the Mac published counts-only without the optional `details` block.
    var detailsSharingLikelyOff: Bool {
        hasCounts && total == nil && sessions.isEmpty && usage.isEmpty
    }

    static func make(_ snapshot: RemoteObservationSnapshot?, at now: Date) -> WatchGlance {
        guard let snapshot, now < snapshot.expiresAt else { return .unavailable }
        switch snapshot.sourceState {
        case .disabled:
            return WatchGlance(mode: .sharingStopped, waiting: nil, working: nil, total: nil,
                               historical: false, observedAt: nil, sessions: [], usage: [])
        case .unavailable:
            return WatchGlance(mode: .sourceUnavailable, waiting: nil, working: nil, total: nil,
                               historical: false, observedAt: nil, sessions: [], usage: [])
        case .observed:
            break
        }
        let freshness = snapshot.freshness(at: now)
        guard freshness == .recent || freshness == .historical,
              let waiting = snapshot.waitingCount, let working = snapshot.workingCount else { return .unavailable }
        let mode: Mode = waiting > 0 ? .needsYou : (working > 0 ? .working : .allClear)
        let details = snapshot.details
        // Allowance windows keep their own validity clocks; an ended window disappears, never reads as full.
        let usage = (details?.usage ?? []).filter { $0.isVisible(at: now) }
        return WatchGlance(mode: mode, waiting: waiting, working: working,
                           total: details?.sessionCount, historical: freshness == .historical,
                           observedAt: snapshot.observedAt, sessions: details?.sessions ?? [], usage: usage)
    }

    /// Instants at which the same snapshot must be presented differently, so a
    /// complication timeline ages without another fetch.
    static func transitions(for snapshot: RemoteObservationSnapshot?, after now: Date) -> [Date] {
        guard let snapshot else { return [] }
        var points = [snapshot.expiresAt]
        if let observedAt = snapshot.observedAt {
            points.append(observedAt.addingTimeInterval(RemoteObservationPolicy.historicalAfter))
        }
        for window in snapshot.details?.usage ?? [] {
            points.append(min(window.resetsAt, window.validUntil ?? window.resetsAt))
            if window.provider == .codex {
                points.append(window.observedAt.addingTimeInterval(CodexUsageFreshness.snapshotStaleInterval))
            }
        }
        return Array(Set(points.filter { $0 > now })).sorted()
    }

    /// Sessions ordered for a small screen: those needing a response first.
    var orderedSessions: [RemoteSessionDetail] {
        sessions.enumerated().sorted { lhs, rhs in
            lhs.element.phase.rawValue != rhs.element.phase.rawValue
                ? lhs.element.phase.rawValue < rhs.element.phase.rawValue : lhs.offset < rhs.offset
        }.map(\.element)
    }

    /// Distinct agents currently waiting for a response, for compact faces.
    var waitingAgents: [RemoteSessionDetail.Agent] {
        var seen: [RemoteSessionDetail.Agent] = []
        for row in orderedSessions where row.phase == .response && !seen.contains(row.agent) { seen.append(row.agent) }
        return seen
    }

    /// The tightest allowance window, which is the one worth a glance.
    var lowestUsage: RemoteUsageWindow? {
        usage.filter { $0.quantity == .allowance }.min { $0.remainingPercent < $1.remainingPercent }
    }

    /// Number of non-zero ring segments (waiting, working, idle). A single-segment
    /// ring (e.g. All clear with multiple idle sessions) must draw without a seam gap.
    var activeArcCount: Int {
        guard hasCounts else { return 0 }
        let waitingCount = max(0, waiting ?? 0)
        let workingCount = max(0, working ?? 0)
        let totalCount = max(total ?? 0, waitingCount + workingCount, 1)
        let idleCount = max(0, totalCount - waitingCount - workingCount)
        return (waitingCount > 0 ? 1 : 0) + (workingCount > 0 ? 1 : 0) + (idleCount > 0 ? 1 : 0)
    }

    var headlineNumber: String {
        switch mode {
        case .needsYou: return "\(waiting ?? 0)"
        case .working: return "\(working ?? 0)"
        case .allClear: return "0"
        case .sourceUnavailable, .sharingStopped, .unavailable: return "—"
        }
    }

    var headlineText: String {
        switch mode {
        case .needsYou:
            let count = waiting ?? 0
            return count == 1 ? String(localized: "1 needs you") : String(localized: "\(count) need you")
        case .working: return String(localized: "\(working ?? 0) working")
        case .allClear: return String(localized: "All clear")
        case .sharingStopped: return String(localized: "Sharing off")
        case .sourceUnavailable: return String(localized: "Mac can't see sessions")
        case .unavailable: return String(localized: "No summary")
        }
    }

    /// Short caption beneath the large number on the main Glance dial.
    var glanceStatusLabel: String {
        switch mode {
        case .needsYou:
            return (waiting ?? 0) == 1 ? String(localized: "needs you") : String(localized: "need you")
        case .working:
            return String(localized: "working")
        default:
            return ""
        }
    }

    /// SF Symbol for inline complications (distinct for every non-clear mode).
    var inlineSymbol: String {
        switch mode {
        case .needsYou: return "hand.raised.fill"
        case .working: return "waveform"
        case .allClear: return "checkmark.circle"
        case .sharingStopped: return "pause.circle"
        case .sourceUnavailable: return "exclamationmark.triangle"
        case .unavailable: return "icloud.slash"
        }
    }

    /// SF Symbol for compact circular complications (never shows checkmark when unavailable).
    var compactSymbol: String {
        switch mode {
        case .needsYou: return "hand.raised.fill"
        case .working: return "waveform"
        case .allClear: return "checkmark"
        case .sharingStopped: return "pause.fill"
        case .sourceUnavailable: return "exclamationmark.triangle.fill"
        case .unavailable: return "icloud.slash"
        }
    }

    /// Relative Smart Stack priority: active waits surface automatically.
    var smartStackRelevanceScore: Float {
        guard !historical else { return 5 }
        switch mode {
        case .needsYou: return 100
        case .working: return 50
        case .allClear: return 20
        case .sourceUnavailable, .sharingStopped, .unavailable: return 5
        }
    }

    /// Target page when tapping a complication (`agentdeckwatch://<path>`).
    func deepLinkURL(preferUsage: Bool = false) -> URL {
        let host: String
        if preferUsage, !usage.isEmpty {
            host = "usage"
        } else if mode == .needsYou, !sessions.isEmpty {
            host = "sessions"
        } else {
            host = "glance"
        }
        return URL(string: "agentdeckwatch://\(host)")!
    }
}

extension RemoteUsageWindow {
    /// True when a passive Codex reading is older than the shared freshness threshold.
    func isAged(at now: Date) -> Bool {
        provider == .codex && now.timeIntervalSince(observedAt) > CodexUsageFreshness.snapshotStaleInterval
    }

    /// Compact age label ("34m ago", "3h ago") when aged; nil when live.
    func agedLabel(at now: Date) -> String? {
        guard isAged(at: now) else { return nil }
        let minutes = max(0, Int(now.timeIntervalSince(observedAt) / 60))
        if minutes < 1 { return String(localized: "now") }
        if minutes < 60 { return "\(minutes)m ago" }
        let hours = minutes / 60
        return hours < 24 ? "\(hours)h ago" : "\(hours / 24)d ago"
    }

    /// Consumed-percent input for `UsageSeverity` SSOT (`-1` when aged → neutral).
    func severityUsedPercent(at now: Date) -> Double {
        isAged(at: now) ? -1 : max(0, min(100, 100 - remainingPercent))
    }

    /// Compact duration label (`5h`, `1w`, `30d`).
    var compactDurationLabel: String {
        if durationMinutes % 10_080 == 0 { return "\(durationMinutes / 10_080)w" }
        if durationMinutes % 1_440 == 0 { return "\(durationMinutes / 1_440)d" }
        if durationMinutes % 60 == 0 { return "\(durationMinutes / 60)h" }
        return "\(durationMinutes)m"
    }

    /// Quantity-aware label matching iOS (`MCP · 5h` vs `5h`).
    var quantityDurationLabel: String {
        quantity == .mcp ? "MCP · \(compactDurationLabel)" : compactDurationLabel
    }
}
