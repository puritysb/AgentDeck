#if os(macOS)
import Foundation

struct DotPresentation: Equatable, Sendable {
    enum Phase: String, Sendable { case offline, unlinked, idle, waiting, working, attention, completed, failed, stale }
    var phase: Phase
    var label: String
    static func resolve(hosting: Bool, connected: Bool, request: DotBriefing?, now: Int) -> Self {
        guard hosting else { return .init(phase: .offline, label: "Hosting stopped · last report retained") }
        guard connected else { return .init(phase: .unlinked, label: "Awaiting a connection") }
        guard let request else { return .init(phase: .idle, label: "Connected · no work reported") }
        if let report = request.report {
            guard report.receivedAt <= now else { return .init(phase: .stale, label: "Report time is in the future · activity unknown") }
            if report.state == "completed" {
                return .init(phase: now >= report.receivedAt && now - report.receivedAt < DotLimits.completionReactionMs ? .completed : .idle, label: "Last request completed")
            }
            if report.state == "failed" { return .init(phase: .failed, label: "Last request reported failure") }
            guard request.expiresAt > now, report.receivedAt <= now, now - report.receivedAt < DotLimits.reportFreshMs else {
                return .init(phase: .stale, label: "Report is old · current activity unknown")
            }
            if report.state == "working" { return .init(phase: .working, label: "Working · reported by Dot") }
            if report.state == "needs_attention" { return .init(phase: .attention, label: "Dot reported an issue") }
            return .init(phase: .stale, label: "Activity unknown")
        }
        guard request.expiresAt > now else { return .init(phase: .stale, label: "Request expired · activity unknown") }
        if ["failed", "cancelled", "expired"].contains(request.delivery) { return .init(phase: .failed, label: "Delivery \(request.delivery) · no report") }
        return .init(phase: .waiting, label: "Waiting for a report")
    }
}

extension DotPresentation {
    static func resultCards(_ requests: [DotBriefing], now: Int) -> [[String: Any]] {
        requests.filter { ($0.report != nil || !($0.interactions ?? []).isEmpty) && $0.createdAt + DotLimits.retentionMs > now }
            .sorted { max($0.report?.receivedAt ?? 0, $0.interactions?.last?.receivedAt ?? 0) > max($1.report?.receivedAt ?? 0, $1.interactions?.last?.receivedAt ?? 0) }.prefix(DotLimits.feedReports).map { request in
                let report = request.report
                func clean(_ value: String, bytes: Int) -> String {
                    let text = String(String.UnicodeScalarView(value.unicodeScalars.filter { $0.properties.generalCategory != .control && $0.properties.generalCategory != .format }))
                    var result = ""
                    for scalar in text.unicodeScalars { if result.utf8.count + scalar.utf8.count > bytes { break }; result.unicodeScalars.append(scalar) }
                    return result
                }
                let edge = request.interactions?.last
                let question = edge?.label ?? report?.summary ?? "No report"
                let stamp = edge?.receivedAt ?? report?.receivedAt ?? request.createdAt
                let context = edge.map { [clean($0.summary, bytes: 96), ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(stamp) / 1000)), "Dot report; target unverified"] }
                    ?? ["Last report: \(report?.state ?? "unknown")", ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(stamp) / 1000)), "Profile: \(clean(request.profile, bytes: 80))"]
                return ["cardId": "module:dot:\(request.id)", "actionClass": "info", "module": [
                    "module": "dot", "title": "DOT", "question": clean(question, bytes: 160),
                    "context": context
                ]]
            }
    }
}
@DaemonActor
extension DotHost {
    func resultCards(now: Int) -> [[String: Any]] { DotPresentation.resultCards(snapshot().reports, now: now) }
}
#endif
