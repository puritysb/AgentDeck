// GENERATED — DO NOT EDIT. Source: shared/src/pairing-credentials.ts
// Regenerate: node scripts/generate-pairing-credentials.mjs
import Foundation
import CoreFoundation

enum PairingCredentialRules {
    static let rotationScope = "active-owner"
    static let globalRevocation = "incomplete"
    static let version = 1
    static let file = "auth-credentials.json"
    static let lockFile = "auth-credentials.lock.sqlite"
    static let maxAccepted = 4
    static let maxRevision = 2147483647
    static let maxBytes = 8192
    static let timeoutMs = 4000
    struct Retirement: Codable, Sendable, Equatable {
        var version: Int = PairingCredentialRules.version
        var revision: Int
        var eventId: String
        var generation: String? { revision == 0 ? nil : "\(revision):\(eventId)" }
        var json: [String: Any] { ["version": version, "revision": revision, "eventId": eventId] }
    }
    struct State: Codable, Sendable, Equatable {
        var version: Int = PairingCredentialRules.version
        var revision: Int
        var eventId: String
        var token: String
        var accepted: [String]
        var retirement: Retirement { .init(version: version, revision: revision, eventId: eventId) }
    }
    enum Failure: Error { case invalidState, retiredPeer, conflictingRetirement, unavailable }
    static func validToken(_ value: String) -> Bool {
        value.utf8.count >= 32 && value.utf8.count <= 512 && value.utf8.allSatisfy { $0 >= 33 && $0 <= 126 }
    }
    static func valid(_ r: Retirement) -> Bool {
        r.version == version && (0...maxRevision).contains(r.revision) &&
        (r.revision == 0 ? r.eventId.isEmpty : r.eventId.utf8.count == 32 && r.eventId.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) })
    }
    static func valid(_ s: State) -> Bool {
        valid(s.retirement) && validToken(s.token) && s.accepted.count <= maxAccepted &&
        s.accepted.allSatisfy(validToken) && !s.accepted.contains(s.token) && Set(s.accepted).count == s.accepted.count &&
        (s.revision == 0 || s.accepted.isEmpty)
    }
    static func decode(_ data: Data) throws -> State {
        guard data.count <= maxBytes else { throw Failure.invalidState }
        let state = try JSONDecoder().decode(State.self, from: data)
        guard valid(state) else { throw Failure.invalidState }
        return state
    }
    static func revision(_ raw: Any?) -> Int? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              n.doubleValue.isFinite, n.doubleValue.rounded(.towardZero) == n.doubleValue,
              n.doubleValue >= 0, n.doubleValue <= Double(maxRevision) else { return nil }
        return n.intValue
    }
    static func metadata(_ raw: Any?) throws -> Retirement {
        guard let raw else { return .init(revision: 0, eventId: "") }
        guard JSONSerialization.isValidJSONObject(raw) else { throw Failure.invalidState }
        let r = try JSONDecoder().decode(Retirement.self, from: JSONSerialization.data(withJSONObject: raw))
        guard valid(r) else { throw Failure.invalidState }
        return r
    }
    static func adopt(_ local: State, token: String, metadata raw: Any?) throws -> State? {
        guard valid(local), validToken(token) else { throw Failure.invalidState }
        let peer = try metadata(raw)
        guard peer.revision >= local.revision else { throw Failure.retiredPeer }
        if peer.revision == local.revision && peer.revision > 0 && (peer.eventId != local.eventId || token != local.token) { throw Failure.conflictingRetirement }
        if peer.revision == local.revision && token == local.token { return nil }
        let accepted = peer.revision > 0 ? [] : Array(([local.token] + local.accepted.filter { $0 != local.token && $0 != token }).prefix(maxAccepted))
        return .init(revision: peer.revision, eventId: peer.eventId, token: token, accepted: accepted)
    }
    static func rotate(_ local: State, token: String, eventId: String, minimumRevision: Int) throws -> State {
        guard valid(local), minimumRevision >= 0, minimumRevision < maxRevision,
              max(local.revision, minimumRevision) < maxRevision, validToken(token), token != local.token,
              !local.accepted.contains(token), eventId != local.eventId else { throw Failure.invalidState }
        let next = State(revision: max(local.revision, minimumRevision) + 1, eventId: eventId, token: token, accepted: [])
        guard valid(next) else { throw Failure.invalidState }
        return next
    }
}
