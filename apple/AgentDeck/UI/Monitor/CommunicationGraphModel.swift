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

struct CommunicationNetwork: Equatable {
    let nodes: [CommunicationNode]
    let links: [CommunicationLink]
    let unidentified: [CommunicationObservation]

    static func project(snapshot: CommunicationSnapshot?, roster: [SessionInfo]) -> Self {
        guard let snapshot else { return Self(nodes: [], links: [], unidentified: []) }
        let events = snapshot.events.filter {
            $0.relation == "messaged" && ["in", "out"].contains($0.direction) &&
            !$0.sessionId.isEmpty && $0.ts.isFinite && $0.ts > 0 &&
            $0.ts >= snapshot.since && $0.ts <= snapshot.capturedAt
        }.sorted { $0.ts == $1.ts ? $0.id < $1.id : $0.ts < $1.ts }
        var live: [String: SessionInfo] = [:]
        for session in roster { live[ObservedAgentRules.rawSessionId(session.id)] = session }
        var nodes: [String: CommunicationNode] = [:]
        var unidentified: [CommunicationObservation] = []
        var observations: [String: [(sender: String, recipient: String, event: CommunicationObservation)]] = [:]

        func node(_ id: String, name: String?) -> CommunicationNode {
            let session = live[id]
            return CommunicationNode(id: id, name: name ?? session?.projectName ?? String(id.prefix(8)),
                project: session?.projectName, rosterID: session?.id, state: session?.state)
        }
        for event in events {
            let owner = ObservedAgentRules.rawSessionId(event.sessionId)
            // Legacy IDs may have come from a reused display name. Keep the
            // observation readable without connecting it to a session.
            guard event.peerIdentity == "pid", let recorded = event.peerSessionId else {
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
                    unidentified: Array(unidentified.reversed()))
    }
}
