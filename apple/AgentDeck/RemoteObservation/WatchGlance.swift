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
}
