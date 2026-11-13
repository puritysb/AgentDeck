import Foundation

/// Mirrors shared/src/device-security.ts. Replicas require fresh owner custody.
enum DeviceSecurityRules {
    static let version = 1
    static let file = "device-security.json"
    static let maxBytes = 131072
    static let maxIdentityBytes = 32768
    static let maxCertificateBytes = 8192
    static let subscriptionId = "device-security/v1"
    static let ackTimeoutMs = 3000
    static let bindTimeoutMs = 20000
    static let bindRetryMs = 250
    enum Role: String, Codable, Sendable { case owner, replica }
    struct Configuration: Codable, Sendable, Equatable {
        var version: Int
        var role: Role
        var hostname: String
        var port: Int
        var pfx: String
        var password: String
        var caDER: String
    }
    struct Transfer: Codable, Sendable {
        var version = DeviceSecurityRules.version
        var nonce: String
        var configuration: Configuration
        var credentials: DeviceCredentialRules.State?
        enum CodingKeys: String, CodingKey { case version, nonce, configuration, credentials }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(version, forKey: .version); try c.encode(nonce, forKey: .nonce)
            try c.encode(configuration, forKey: .configuration)
            if let credentials { try c.encode(credentials, forKey: .credentials) } else { try c.encodeNil(forKey: .credentials) }
        }
    }
    enum Failure: Error { case invalidConfiguration, invalidTransfer, unavailable, alreadyConfigured, notOwner, missingCustody, changedCustody }
    static func configuration(_ data: Data) throws -> Configuration {
        guard data.count <= maxBytes else { throw Failure.invalidConfiguration }
        let value = try JSONDecoder().decode(Configuration.self, from: data)
        guard value.version == version, !value.hostname.isEmpty, value.hostname.utf8.count <= 253,
              value.hostname.split(separator: ".", omittingEmptySubsequences: false).allSatisfy({ label in
                  guard !label.isEmpty, label.utf8.count <= 63, label.first != "-", label.last != "-" else { return false }
                  return label.utf8.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
              }), value.port >= 1024, value.port <= 65535, !(9120...9139).contains(value.port),
              !value.password.isEmpty, value.password.utf8.count <= 256,
              !value.password.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
              let pfx = Data(base64Encoded: value.pfx), !pfx.isEmpty, pfx.count <= maxIdentityBytes,
              let ca = Data(base64Encoded: value.caDER), !ca.isEmpty, ca.count <= maxCertificateBytes else { throw Failure.invalidConfiguration }
        return value
    }
    static func transfer(_ data: Data, nonce: String) throws -> Transfer {
        guard data.count <= maxBytes + DeviceCredentialRules.maxBytes, DeviceCredentialRules.hex(nonce, count: 32) else { throw Failure.invalidTransfer }
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any], object.keys.contains("credentials") else { throw Failure.invalidTransfer }
        let value = try JSONDecoder().decode(Transfer.self, from: data)
        guard value.version == version, value.nonce == nonce, value.configuration.role == .owner else { throw Failure.invalidTransfer }
        _ = try configuration(JSONEncoder().encode(value.configuration))
        if let credentials = value.credentials { _ = try DeviceCredentialRules.decode(JSONEncoder().encode(credentials)) }
        return value
    }
}
