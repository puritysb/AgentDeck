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

    var displayTitle: String {
        [title, summary].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? "No task title observed yet"
    }
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
    let relationId: String?
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
    var isLaunchObservation: Bool { evidence == "bash_claude_p" }
}

enum CollaborationProjection {
    /// Navigation uses confirmed peer identity, never project-name similarity.
    /// Historical relations establish a link; the roster supplies current state.
    static func relatedSessions(_ relations: [CollaborationRelation], roster: [SessionInfo], excluding sessionId: String) -> [SessionInfo] {
        let peers = Set(relations.filter { !$0.isLaunchObservation }.compactMap(\.peerSessionId)
            .map { ObservedAgentRules.rawSessionId($0) }.filter { !$0.isEmpty })
        let selected = ObservedAgentRules.rawSessionId(sessionId)
        return prioritizedSessions(roster.filter {
            let raw = ObservedAgentRules.rawSessionId($0.id)
            return raw != selected && peers.contains(raw)
        })
    }

    static func prioritizedSessions(_ sessions: [SessionInfo]) -> [SessionInfo] {
        func priority(_ s: SessionInfo) -> Int {
            if s.state?.hasPrefix("awaiting") == true { return 0 }
            if s.state == "processing" { return 1 }
            if (s.subagents?.active ?? 0) > 0 || (s.coordination?.spawnedActive ?? 0) > 0 || (s.coordination?.backgroundJobs ?? 0) > 0 { return 2 }
            return 3
        }
        return sessions.sorted {
            let a = priority($0), b = priority($1)
            return a == b ? $0.id < $1.id : a < b
        }
    }

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

    /// Fold only producer identities (or a known peer session). Legacy job
    /// records without identity stay separate observations: a shared label
    /// cannot establish that a close belongs to a particular open.
    /// Launch observations remain separate until there is an explicit link to
    /// a child; one resolved child says nothing about other launch requests.
    static func relations(sample: CollaborationSample?, sessionId: String, taskId: String) -> [CollaborationRelation] {
        guard let sample, sample.sessionId == sessionId, sample.id == taskId else { return [] }
        var byID: [String: CollaborationRelation] = [:]
        var order: [String] = []
        for (index, event) in sample.events.enumerated() {
            guard event.kind == "relation",
                  let relation = event.relation, ["spawned", "messaged", "waiting_on"].contains(relation),
                  let direction = event.direction, direction == "in" || direction == "out",
                  let phase = event.phase, phase == "open" || phase == "closed" else { continue }
            let evidence = event.evidence ?? "unknown"
            let key: String
            if let identity = event.relationId, !identity.isEmpty {
                key = "\(relation):\(direction):\(identity)"
            } else if relation == "spawned", let peer = event.peerSessionId, !peer.isEmpty {
                key = "spawned:\(direction):\(peer)"
            } else {
                key = "\(relation):\(direction):observation:\(event.ts):\(index)"
            }
            if let old = byID[key], old.observedAt > event.ts ||
                (old.observedAt == event.ts && old.phase == "closed") { continue }
            let row = CollaborationRelation(
                id: key, relation: relation, direction: direction, phase: phase,
                peerSessionId: event.peerSessionId, peerName: event.peerName,
                evidence: evidence, detail: event.detail ?? byID[key]?.detail, observedAt: event.ts)
            if byID[key] == nil { order.append(key) }
            byID[key] = row
        }
        return order.compactMap { byID[$0] }
    }
}
