import Foundation

/// Keep elapsed labels legible around nodes and other labels in both the graph
/// and habitat. The candidate search is bounded, deterministic and screen-local.
enum CommunicationLabelLayout {
    static func place(preferred: CGPoint, size: CGSize, bounds: CGRect, avoiding occupied: [CGRect]) -> CGRect {
        let dx = size.width + 8, dy = size.height + 6
        var offsets: [CGPoint] = [.zero]
        for ring in 1...4 {
            let r = CGFloat(ring)
            offsets += [CGPoint(x: 0, y: -dy*r), CGPoint(x: 0, y: dy*r),
                        CGPoint(x: -dx*r, y: 0), CGPoint(x: dx*r, y: 0),
                        CGPoint(x: -dx*r, y: -dy*r), CGPoint(x: dx*r, y: -dy*r),
                        CGPoint(x: -dx*r, y: dy*r), CGPoint(x: dx*r, y: dy*r)]
        }
        var best = CGRect.zero, leastOverlap = CGFloat.infinity
        for offset in offsets {
            let rect = CGRect(x: min(max(bounds.minX, preferred.x+offset.x-size.width/2), max(bounds.minX, bounds.maxX-size.width)),
                              y: min(max(bounds.minY, preferred.y+offset.y-size.height/2), max(bounds.minY, bounds.maxY-size.height)),
                              width: size.width, height: size.height)
            let overlap = occupied.reduce(CGFloat.zero) { total, other in
                let intersection = rect.intersection(other.insetBy(dx: -3, dy: -3))
                return total + (intersection.isNull ? 0 : intersection.width * intersection.height)
            }
            if overlap == 0 { return rect }
            if overlap < leastOverlap { best = rect; leastOverlap = overlap }
        }
        return best
    }
}

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

struct CommunicationNode: Identifiable, Equatable {
    let id: String
    var name: String
    var project: String?
    var rosterID: String?
    var state: String?
}

struct CommunicationLink: Identifiable, Equatable {
    let id: String
    let latestSender: String
    let latestRecipient: String
    let lastObservedAt: Double
    let detail: String?
    let messageIntent: String?
    let crossed: Bool

    var status: String {
        switch messageIntent {
        case "request": return "Reply request observed"
        case "response": return "Reply wording observed"
        case "notification": return "Notification observed"
        default: return "Message observed"
        }
    }
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

struct CommunicationNetwork: Equatable {
    let nodes: [CommunicationNode]
    let links: [CommunicationLink]
    let unidentified: [CommunicationObservation]
    var messages: [CommunicationMessage] = []

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
        guard let snapshot else { return Self(nodes: [], links: [], unidentified: []) }
        let events = snapshot.events.filter {
            $0.relation == "messaged" && ["in", "out"].contains($0.direction) &&
            !$0.sessionId.isEmpty && $0.ts.isFinite && $0.ts > 0 &&
            $0.ts >= snapshot.since && $0.ts <= snapshot.capturedAt
        }.sorted { $0.ts == $1.ts ? $0.id < $1.id : $0.ts < $1.ts }
        let pairs = pairedDeliveries(events)
        var live: [String: SessionInfo] = [:]
        for session in roster { live[ObservedAgentRules.rawSessionId(session.id)] = session }
        var nodes: [String: CommunicationNode] = [:]
        var unidentified: [CommunicationObservation] = []
        var history: [CommunicationMessage] = []
        var observations: [String: [(sender: String, recipient: String, event: CommunicationObservation)]] = [:]

        func node(_ id: String, name: String?) -> CommunicationNode {
            let session = live[id]
            return CommunicationNode(id: id, name: name ?? session?.projectName ?? String(id.prefix(8)),
                project: session?.projectName, rosterID: session?.id, state: session?.state)
        }
        for event in events {
            let owner = ObservedAgentRules.rawSessionId(event.sessionId)
            guard event.peerIdentity == "pid" || pairs[event.id] != nil,
                  let recorded = event.peerSessionId else {
                unidentified.append(event)
                continue
            }
            let peer = ObservedAgentRules.rawSessionId(recorded)
            guard !peer.isEmpty, peer != owner else {
                unidentified.append(event)
                continue
            }
            if nodes[owner] == nil { nodes[owner] = node(owner, name: nil) }
            if nodes[peer] == nil || event.peerName != nil { nodes[peer] = node(peer, name: event.peerName) }
            let sender = event.direction == "out" ? owner : peer
            let recipient = event.direction == "out" ? peer : owner
            if event.direction == "in" || pairs[event.id] == nil {
                history.append(CommunicationMessage(observation: event, sent: pairs[event.id],
                                                    sender: sender, recipient: recipient))
            }
            let key = [sender, recipient].sorted().joined(separator: "|")
            observations[key, default: []].append((sender, recipient, event))
        }
        let links = observations.compactMap { key, messages -> CommunicationLink? in
            guard let latest = messages.last else { return nil }
            let opposite = messages.last { $0.sender != latest.sender }
            let crossed = opposite.map {
                latest.event.ts - $0.event.ts <= Double(CollaborationPresentation.networkSimultaneousWindowMs)
            } ?? false
            let excerpt = latest.event.detail ?? latest.event.messageFingerprint.flatMap { fingerprint in
                messages.last {
                    $0.sender == latest.sender && $0.event.detail != nil
                        && $0.event.messageFingerprint == fingerprint
                        && latest.event.ts - $0.event.ts <= Double(CollaborationPresentation.networkSimultaneousWindowMs)
                }?.event.detail
            }
            return CommunicationLink(id: key, latestSender: latest.sender, latestRecipient: latest.recipient,
                lastObservedAt: latest.event.ts, detail: excerpt, messageIntent: latest.event.messageIntent,
                crossed: crossed)
        }.sorted {
            $0.lastObservedAt == $1.lastObservedAt ? $0.id < $1.id : $0.lastObservedAt > $1.lastObservedAt
        }
        return Self(nodes: nodes.values.sorted { $0.id < $1.id }, links: links,
                    unidentified: Array(unidentified.reversed()), messages: Array(history.reversed()))
    }
}
