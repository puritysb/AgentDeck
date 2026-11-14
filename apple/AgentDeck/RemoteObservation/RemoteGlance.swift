#if AGENTDECK_CLOUDKIT_POC
import Foundation

/// What a wrist-sized reader may claim from a shared summary. Shared by the
/// Watch app and its complication; the iPhone tests drive the same rules.
///
/// A count is shown only while its original observation is inside the reader
/// lifetime. Missing, expired or future-dated evidence is `unavailable`, never
/// a synthetic zero — "all clear" requires an observed roster with no work.
struct RemoteGlance: Equatable, Sendable {
    enum Headline: Equatable, Sendable {
        case needsYou(Int)
        case working(Int)
        case allClear
        case unavailable
    }

    let headline: Headline
    /// Working sessions alongside a wait; nil when there is no observation.
    let workingCount: Int?
    /// True once the observation is older than the historical threshold.
    let historical: Bool
    /// The original source observation time, unchanged by any fetch.
    let observedAt: Date?

    static let unavailable = RemoteGlance(headline: .unavailable, workingCount: nil, historical: false, observedAt: nil)

    static func make(_ summary: RemoteRosterSummary?, at now: Date) -> RemoteGlance {
        guard let summary else { return .unavailable }
        let freshness = summary.freshness(at: now)
        guard freshness == .recent || freshness == .historical else { return .unavailable }
        let headline: Headline
        if summary.waitingCount > 0 { headline = .needsYou(summary.waitingCount) }
        else if summary.workingCount > 0 { headline = .working(summary.workingCount) }
        else { headline = .allClear }
        return RemoteGlance(headline: headline, workingCount: summary.workingCount,
                            historical: freshness == .historical, observedAt: summary.observedAt)
    }

    /// Instants at which the same summary must be presented differently, so a
    /// complication timeline turns historical/unavailable without a new fetch.
    static func transitions(for summary: RemoteRosterSummary?, after now: Date) -> [Date] {
        guard let summary else { return [] }
        return [summary.observedAt.addingTimeInterval(RemoteObservationPolicy.historicalAfter),
                summary.observedAt.addingTimeInterval(RemoteObservationPolicy.readerLifetime)]
            .filter { $0 > now }
    }
}
#endif
