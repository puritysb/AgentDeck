// A read-only projection of the canonical task sample. No inferred team edges.
import Foundation

struct CollaborationTaskPage: Decodable, Sendable {
    let tasks: [CollaborationTask]
}

struct CollaborationTask: Decodable, Sendable, Identifiable {
    let id: String
    let sessionId: String
    let title: String?
    let summary: String?
    let endedAt: Double?

    var displayTitle: String { summary ?? title ?? "작업 제목이 아직 관측되지 않았습니다" }
}

struct CollaborationDetail: Decodable, Sendable {
    let sample: CollaborationSample?
}

struct CollaborationSample: Decodable, Sendable {
    let id: String
    let sessionId: String
    let endedAt: Double?
    let events: [CollaborationEvent]
}

/// Unknown event kinds/fields are intentionally harmless. Tool payloads are
/// not decoded or retained: this view needs lifecycle evidence, not a log dump.
struct CollaborationEvent: Decodable, Sendable {
    let kind: String
    let ts: Double
    let id: String?
    let name: String?
    let phase: String?
    let summary: String?
}

struct CollaborationChild: Identifiable, Equatable, Sendable {
    let id: String
    var name: String
    var phase: String
    var summary: String?
    var observedAt: Double
}

enum CollaborationProjection {
    /// Only typed child evidence attributed to THIS task/session can create a
    /// branch. A historical start is not proof a child is still running.
    static func children(sample: CollaborationSample?, sessionId: String, taskId: String) -> [CollaborationChild] {
        guard let sample, sample.sessionId == sessionId, sample.id == taskId else { return [] }
        var byID: [String: CollaborationChild] = [:]
        for event in sample.events {
            guard event.kind == "subagent", let id = event.id, !id.isEmpty,
                  let name = event.name, !name.isEmpty,
                  let phase = event.phase, phase == "started" || phase == "completed" else { continue }
            // Ignore out-of-order older events. A completion wins a same-time
            // tie; an orphan completion stays a completion, never a fake start.
            if let old = byID[id], old.observedAt > event.ts ||
                (old.observedAt == event.ts && old.phase == "completed") { continue }
            byID[id] = CollaborationChild(id: id, name: name, phase: phase,
                summary: event.summary, observedAt: event.ts)
        }
        // Identity order, not activity order: branches do not jump on completion.
        return byID.values.sorted { $0.id < $1.id }
    }
}
