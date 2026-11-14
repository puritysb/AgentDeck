import Foundation
import CoreFoundation

/// Mirrors shared/src/device-credentials.ts. Shared vectors and the constant drift gate are required.
enum DeviceCredentialRules {
    static let version = 1
    static let prefix = "addev1."
    static let file = "device-credentials.json"
    static let maxDevices = 256
    static let maxBytes = 131_072
    static let maxNameBytes = 160
    static let scopes = ["sessions.read", "usage.read"]
    struct Device: Codable, Sendable, Equatable {
        var id: String
        var name: String
        var verifier: String
        var scopes: [String]
        var createdAt: Int64
        var revokedAt: Int64?
        enum CodingKeys: String, CodingKey { case id, name, verifier, scopes, createdAt, revokedAt }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(id, forKey: .id); try c.encode(name, forKey: .name)
            try c.encode(verifier, forKey: .verifier); try c.encode(scopes, forKey: .scopes)
            try c.encode(createdAt, forKey: .createdAt)
            if let revokedAt { try c.encode(revokedAt, forKey: .revokedAt) }
            else { try c.encodeNil(forKey: .revokedAt) }
        }
    }
    struct State: Codable, Sendable, Equatable {
        var version = DeviceCredentialRules.version
        var authority: String
        var revision: Int64
        var devices: [Device]
    }
    enum Failure: Error { case invalidState, conflictingAuthority, conflictingCredential, stateLimit }
    static func hex(_ value: String, count: Int) -> Bool {
        value.utf8.count == count && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }
    static func reserved(_ token: String) -> Bool { token.hasPrefix(prefix) }
    static func id(_ token: String) -> String? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[0] == "addev1", hex(String(parts[1]), count: 32), hex(String(parts[2]), count: 64) else { return nil }
        return String(parts[1])
    }
    private static func integer(_ value: Any?) -> Int64? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue >= 0, n.doubleValue <= 9_007_199_254_740_991,
              n.doubleValue.rounded(.towardZero) == n.doubleValue else { return nil }
        return n.int64Value
    }
    static func decode(_ data: Data) throws -> State {
        guard data.count <= maxBytes, let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              integer(raw["version"]) == 1, let authority = raw["authority"] as? String, hex(authority, count: 32),
              let revision = integer(raw["revision"]), let rows = raw["devices"] as? [[String: Any]], rows.count <= maxDevices else { throw Failure.invalidState }
        var devices: [Device] = [], ids = Set<String>()
        for row in rows {
            guard let id = row["id"] as? String, hex(id, count: 32), ids.insert(id).inserted,
                  let name = row["name"] as? String, !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  name.utf8.count <= maxNameBytes, !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
                  let verifier = row["verifier"] as? String, hex(verifier, count: 64),
                  let grants = row["scopes"] as? [String], !grants.isEmpty, Set(grants).count == grants.count,
                  grants.allSatisfy({ scopes.contains($0) }), let createdAt = integer(row["createdAt"]),
                  row.keys.contains("revokedAt") else { throw Failure.invalidState }
            let revokedAt = row["revokedAt"] is NSNull ? nil : integer(row["revokedAt"])
            guard row["revokedAt"] is NSNull || (revokedAt != nil && revokedAt! >= createdAt) else { throw Failure.invalidState }
            devices.append(.init(id: id, name: name, verifier: verifier, scopes: grants.sorted(), createdAt: createdAt, revokedAt: revokedAt))
        }
        return .init(authority: authority, revision: revision, devices: devices.sorted { $0.id < $1.id })
    }
    static func merge(_ local: State, _ peer: State) throws -> State {
        let a = try decode(JSONEncoder().encode(local)), b = try decode(JSONEncoder().encode(peer))
        guard a.authority == b.authority else {
            guard a.devices.isEmpty else { throw Failure.conflictingAuthority }
            return b
        }
        var rows = Dictionary(uniqueKeysWithValues: a.devices.map { ($0.id, $0) })
        for incoming in b.devices {
            guard var existing = rows[incoming.id] else { rows[incoming.id] = incoming; continue }
            guard existing.verifier == incoming.verifier, existing.name == incoming.name,
                  existing.scopes == incoming.scopes, existing.createdAt == incoming.createdAt else { throw Failure.conflictingCredential }
            if let revoked = incoming.revokedAt { existing.revokedAt = max(existing.revokedAt ?? revoked, revoked) }
            rows[incoming.id] = existing
        }
        let merged = State(authority: a.authority, revision: max(a.revision, b.revision) + 1, devices: Array(rows.values))
        return try decode(JSONEncoder().encode(merged))
    }
    static func httpAllowed(method: String, target: String) -> Bool { method == "GET" && target == "/device/snapshot" }
    static func messageAllowed(_ value: [String: Any]) -> Bool {
        guard value["type"] as? String == "client_register", value["clientType"] as? String == "companion",
              let surface = value["surface"] as? [String: Any], integer(surface["protocol"]) == 1,
              let profiles = surface["profiles"] as? [[String: Any]], profiles.count == 1,
              profiles[0]["id"] as? String == "display-only/v1", let grants = profiles[0]["capabilities"] as? [String] else { return false }
        return grants.allSatisfy { scopes.contains($0) }
    }
}
