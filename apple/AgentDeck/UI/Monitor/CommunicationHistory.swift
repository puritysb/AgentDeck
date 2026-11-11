import Foundation

struct CommunicationSnapshot: Decodable, Sendable {
    let schema: String
    let capturedAt: Double
    let since: Double
    let truncated: Bool
    let events: [CommunicationObservation]
}

struct CommunicationObservation: Decodable, Sendable, Identifiable, Equatable {
    let id: String
    let sessionId: String
    let ts: Double
    let relation: String
    let direction: String
    let peerSessionId: String?
    let peerIdentity: String?
    let peerName: String?
    let evidence: String?
    let detail: String?
    let messageIntent: String?
    let messageFingerprint: String?
}

/// A message observation, with its sender-side record when the receiver and
/// sender independently identified the same delivery.
struct CommunicationMessage: Identifiable, Equatable {
    let observation: CommunicationObservation
    let sent: CommunicationObservation?
    let sender: String
    let recipient: String

    var id: String { observation.id }
    var detail: String? { observation.detail ?? sent?.detail }
    var received: Bool { observation.direction == "in" }

    func belongsToTask(sessionID: String, relations: [CollaborationRelation]) -> Bool {
        guard received, observation.evidence == "cross_session_message" else { return false }
        let owner = ObservedAgentRules.rawSessionId(sessionID)
        return relations.contains { relation in
            guard relation.relation == "messaged", let peerID = relation.peerSessionId else { return false }
            let peer = ObservedAgentRules.rawSessionId(peerID)
            if relation.direction == "in" {
                return owner == recipient && peer == sender && relation.observedAt == observation.ts
            }
            return owner == sender && peer == recipient && relation.observedAt == sent?.ts
        }
    }
}

/// Identified peer messages in one bounded history read. Work detail draws
/// receipt-confirmed task handoffs from it; nothing else is presented.
struct CommunicationHistory: Equatable {
    /// Newest first. A delivery recorded by both endpoints appears once.
    let messages: [CommunicationMessage]
    /// Raw session id → display name for the sessions in `messages`.
    let names: [String: String]

    func name(_ id: String) -> String { names[id] ?? id }

    private struct DeliveryKey: Hashable {
        let sender: String
        let recipient: String
        let fingerprint: String
    }

    /// Older daemons lack the PID evidence field. Two separately recorded
    /// endpoints can still corroborate a delivery, without using names.
    private static func pairedDeliveries(_ events: [CommunicationObservation]) -> [String: CommunicationObservation] {
        var sent: [DeliveryKey: [CommunicationObservation]] = [:]
        var received: [DeliveryKey: [CommunicationObservation]] = [:]
        for event in events {
            guard event.peerIdentity == nil || event.peerIdentity == "pid", let peerID = event.peerSessionId,
                  let fingerprint = event.messageFingerprint, !fingerprint.isEmpty else { continue }
            let owner = ObservedAgentRules.rawSessionId(event.sessionId)
            let peer = ObservedAgentRules.rawSessionId(peerID)
            guard !owner.isEmpty, !peer.isEmpty, owner != peer else { continue }
            if event.direction == "out", event.evidence == "send_message_tool" {
                sent[DeliveryKey(sender: owner, recipient: peer, fingerprint: fingerprint), default: []].append(event)
            } else if event.direction == "in", event.evidence == "cross_session_message" {
                received[DeliveryKey(sender: peer, recipient: owner, fingerprint: fingerprint), default: []].append(event)
            }
        }
        let window = Double(CollaborationPresentation.networkSimultaneousWindowMs)
        var pairs: [String: CommunicationObservation] = [:]
        for (key, outgoing) in sent {
            guard let incoming = received[key] else { continue }
            for send in outgoing {
                let matches = incoming.filter { abs($0.ts - send.ts) <= window }
                guard matches.count == 1, let receipt = matches.first,
                      outgoing.filter({ abs($0.ts - receipt.ts) <= window }).count == 1 else { continue }
                pairs[send.id] = receipt
                pairs[receipt.id] = send
            }
        }
        return pairs
    }

    static func project(snapshot: CommunicationSnapshot?, roster: [SessionInfo]) -> Self {
        guard let snapshot else { return Self(messages: [], names: [:]) }
        let events = snapshot.events.filter {
            $0.relation == "messaged" && ["in", "out"].contains($0.direction) &&
            !$0.sessionId.isEmpty && $0.ts.isFinite && $0.ts > 0 &&
            $0.ts >= snapshot.since && $0.ts <= snapshot.capturedAt
        }.sorted { $0.ts == $1.ts ? $0.id < $1.id : $0.ts < $1.ts }
        let pairs = pairedDeliveries(events)
        var live: [String: SessionInfo] = [:]
        for session in roster { live[ObservedAgentRules.rawSessionId(session.id)] = session }
        var names: [String: String] = [:]
        var history: [CommunicationMessage] = []

        func name(_ id: String, _ given: String?) -> String {
            given ?? live[id]?.projectName ?? String(id.prefix(8))
        }
        for event in events {
            let owner = ObservedAgentRules.rawSessionId(event.sessionId)
            // A peer name alone never identifies a session.
            guard event.peerIdentity == "pid" || pairs[event.id] != nil,
                  let recorded = event.peerSessionId else { continue }
            let peer = ObservedAgentRules.rawSessionId(recorded)
            guard !peer.isEmpty, peer != owner else { continue }
            if names[owner] == nil { names[owner] = name(owner, nil) }
            if names[peer] == nil || event.peerName != nil { names[peer] = name(peer, event.peerName) }
            if event.direction == "in" || pairs[event.id] == nil {
                history.append(CommunicationMessage(observation: event, sent: pairs[event.id],
                    sender: event.direction == "out" ? owner : peer,
                    recipient: event.direction == "out" ? peer : owner))
            }
        }
        return Self(messages: Array(history.reversed()), names: names)
    }
}
