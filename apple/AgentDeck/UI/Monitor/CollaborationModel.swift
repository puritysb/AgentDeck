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

    var displayTitle: String { summary ?? title ?? "No task title observed yet" }
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
    // `relation` events (shared RelationEvent): how this session coordinates
    // with OTHER sessions or processes without a SubagentStart.
    let relation: String?
    let direction: String?
    let peerSessionId: String?
    let peerName: String?
    let evidence: String?
    let detail: String?
}

struct CollaborationChild: Identifiable, Equatable, Sendable {
    let id: String
    var name: String
    var phase: String
    var summary: String?
    var observedAt: Double
}

/// One observed cross-session relation, folded to its latest phase.
struct CollaborationRelation: Identifiable, Equatable, Sendable {
    let id: String
    /// `spawned` / `messaged` / `waiting_on`.
    let relation: String
    /// `out`: this session did it; `in`: it was done to this session.
    let direction: String
    /// `open` while the peer/process still runs; `closed` after, or for a message.
    var phase: String
    var peerSessionId: String?
    var peerName: String?
    var evidence: String
    var detail: String?
    var observedAt: Double

    var isOpen: Bool { phase == "open" }
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

    /// Typed `relation` evidence attributed to THIS task/session, folded to the
    /// latest phase per identity:
    ///
    ///   - a spawned peer folds on its session id (open → closed as it exits);
    ///     a spawn INTENT (`bash_claude_p`, no peer yet) is shown only while no
    ///     ancestry-resolved spawn exists, since the tracker folds it into the
    ///     child once observed;
    ///   - a background job folds on its label (the process pid never rides
    ///     the sample);
    ///   - every message is its own row — a message has no phase to fold.
    ///
    /// Same-project membership never appears here: there is no such row.
    static func relations(sample: CollaborationSample?, sessionId: String, taskId: String) -> [CollaborationRelation] {
        guard let sample, sample.sessionId == sessionId, sample.id == taskId else { return [] }
        var byID: [String: CollaborationRelation] = [:]
        var order: [String] = []
        var sawResolvedSpawn = false
        for event in sample.events {
            guard event.kind == "relation",
                  let relation = event.relation, ["spawned", "messaged", "waiting_on"].contains(relation),
                  let direction = event.direction, direction == "in" || direction == "out",
                  let phase = event.phase, phase == "open" || phase == "closed" else { continue }
            let evidence = event.evidence ?? "unknown"
            let key: String
            switch relation {
            case "spawned":
                if let peer = event.peerSessionId, !peer.isEmpty {
                    key = "spawned:\(direction):\(peer)"
                    sawResolvedSpawn = sawResolvedSpawn || direction == "out"
                } else {
                    key = "spawned:intent:\(event.ts)"
                }
            case "waiting_on":
                key = "waiting_on:\(event.peerName ?? event.detail ?? "job")"
            default:
                key = "messaged:\(direction):\(event.ts):\(event.peerName ?? event.peerSessionId ?? "")"
            }
            if let old = byID[key], old.observedAt > event.ts { continue }
            let row = CollaborationRelation(
                id: key, relation: relation, direction: direction, phase: phase,
                peerSessionId: event.peerSessionId, peerName: event.peerName,
                evidence: evidence, detail: event.detail ?? old(byID[key])?.detail, observedAt: event.ts)
            if byID[key] == nil { order.append(key) }
            byID[key] = row
        }
        return order.compactMap { byID[$0] }.filter { row in
            !(row.relation == "spawned" && row.evidence == "bash_claude_p" && sawResolvedSpawn)
        }
    }

    private static func old(_ row: CollaborationRelation?) -> CollaborationRelation? { row }
}
