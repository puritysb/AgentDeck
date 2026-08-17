#if os(macOS)
// KiroTimelineFeed.swift — live timeline rows for observed Kiro sessions.
//
// Mirror of `KiroTimelineFeed` in bridge/src/kiro-timeline-feed.ts, and it
// exists for the same reason: the session list is PULLED (something scans and
// reports what it found) while the timeline is PUSHED (each agent's hooks add
// rows as it works). Kiro pushes nothing, so without a producer a Kiro session
// shows up in the HUD beside a timeline that stays empty forever — which is
// exactly what the user saw before this landed on the Node side.
//
// **A first sighting emits nothing.** It only records where the transcript
// currently ends. Without that, every daemon start would replay each Kiro
// session's whole history into a bounded activity log, evicting live rows from
// other agents to re-tell a two-day-old conversation. Hook-driven agents get
// this property for free — their rows exist only from the moment the daemon is
// listening — and this makes Kiro behave the same way.

import Foundation

@DaemonActor
final class KiroTimelineFeed {
    /// sessionId → newest row timestamp already accounted for.
    private var watermark: [String: Double] = [:]

    /// Watermarks kept for at most this many sessions. A daemon that runs for
    /// weeks must not grow a map keyed by every session it ever saw.
    private static let maxTracked = 64

    /// Rows to emit for this tick, oldest-first across all sessions.
    ///
    /// `sessionIds` is the CURRENT set of observed Kiro sessions (prefixed
    /// form); anything absent is forgotten, so a finished session's watermark
    /// does not outlive it.
    @discardableResult
    func pump(_ sessionIds: [String], now: Date = Date()) -> [DaemonTimelineEntry] {
        let live = Set(sessionIds)
        for id in watermark.keys where !live.contains(id) {
            watermark.removeValue(forKey: id)
        }

        let observed = LocalKiroObserver.observe(now: now)
        var byId: [String: LocalKiroObserver.Observed] = [:]
        for item in observed { byId["observed:kiro:\(item.sessionId)"] = item }

        var out: [DaemonTimelineEntry] = []
        for id in sessionIds {
            guard let session = byId[id] else { continue }
            let turns = LocalKiroObserver.readTurns(session.transcript)
            guard let newest = turns.last?.ts else {
                // Seed an empty session at 0 so its first real row is emitted
                // rather than swallowed as "history".
                if watermark[id] == nil { watermark[id] = 0 }
                continue
            }
            guard let since = watermark[id] else {
                watermark[id] = newest          // first sighting: seed, emit nothing
                continue
            }
            watermark[id] = newest
            for turn in turns where turn.ts > since {
                out.append(DaemonTimelineEntry(
                    ts: turn.ts,
                    type: turn.isPrompt ? "chat_start" : "chat_response",
                    raw: Self.firstLine(turn.text),
                    detail: String(turn.text.prefix(4000)),
                    agentType: "kiro-cli",
                    projectName: session.projectName,
                    // The BARE uuid: timeline rows are keyed that way while the
                    // session list uses the prefixed form, and every client
                    // normalizes with ObservedAgentRules.rawSessionId before
                    // comparing the two.
                    sessionId: session.sessionId
                ))
            }
        }

        enforceCeiling()
        return out.sorted { $0.ts < $1.ts }
    }

    /// Tracked session count — for tests and diagnostics.
    var trackedCount: Int { watermark.count }

    private func enforceCeiling() {
        guard watermark.count > Self.maxTracked else { return }
        // Oldest watermark first: the least recently active session is the one
        // least likely to produce the next row.
        let byAge = watermark.sorted { $0.value < $1.value }
        for (id, _) in byAge {
            guard watermark.count > Self.maxTracked else { break }
            watermark.removeValue(forKey: id)
        }
    }

    private static func firstLine(_ text: String, cap: Int = 120) -> String {
        let flat = text.split(whereSeparator: \.isNewline).joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard flat.count > cap else { return flat }
        return String(flat.prefix(cap - 1)) + "…"
    }
}
#endif
