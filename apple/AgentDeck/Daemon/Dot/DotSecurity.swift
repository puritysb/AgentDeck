#if os(macOS)
import Foundation
import Security
import CryptoKit

@DaemonActor
enum DotVault {
    static func load(_ account: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "bound.serendipity.agent.deck.dot",
            kSecAttrAccount as String: account, kSecUseDataProtectionKeychain as String: true, kSecReturnData as String: true]
        var result: CFTypeRef?; let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw DotFailure.message("Dot Keychain read failed (\(status)).") }
        return result as? Data
    }
    static func save(_ data: Data, account: String) throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "bound.serendipity.agent.deck.dot",
            kSecAttrAccount as String: account, kSecUseDataProtectionKeychain as String: true]
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query; item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw DotFailure.message("Dot Keychain write failed.") }; return
        }
        guard status == errSecSuccess else { throw DotFailure.message("Dot Keychain write failed (\(status)).") }
    }
}
struct DotCertificateEnvelope: Codable { var bytes: Data; var password: String }
@DaemonActor
enum DotIdentity {
    static func validate(_ envelope: DotCertificateEnvelope, hostname: String) throws -> SecIdentity {
        var items: CFArray?
        let status = SecPKCS12Import(envelope.bytes as CFData,
            [kSecImportExportPassphrase: envelope.password, kSecImportToMemoryOnly: true] as CFDictionary, &items)
        guard status == errSecSuccess, let item = (items as? [[String: Any]])?.first,
              let value = item[kSecImportItemIdentity as String], CFGetTypeID(value as CFTypeRef) == SecIdentityGetTypeID() else {
            throw DotFailure.message("The certificate file or password is invalid.")
        }
        let identity = value as! SecIdentity
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess, let certificate else { throw DotFailure.message("Certificate is missing.") }
        let chain = item[kSecImportItemCertChain as String] as? [SecCertificate] ?? [certificate]
        var trust: SecTrust?
        guard SecTrustCreateWithCertificates(chain as CFArray, SecPolicyCreateSSL(true, hostname as CFString), &trust) == errSecSuccess,
              let trust else { throw DotFailure.message("Certificate validation failed.") }
        SecTrustSetNetworkFetchAllowed(trust, false)
        guard SecTrustEvaluateWithError(trust, nil) else { throw DotFailure.message("Use a currently valid, trusted certificate matching the public hostname, with its full chain.") }
        return identity
    }
}
nonisolated func dotDigest(_ value: String) -> String {
    Data(SHA256.hash(data: Data(value.utf8))).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
nonisolated func dotRandom() throws -> String {
    var bytes = [UInt8](repeating: 0, count: 32)
    guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw DotFailure.message("Secure random generation failed.") }
    return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
nonisolated func dotEqual(_ a: String, _ b: String) -> Bool {
    let aa = Array(a.utf8), bb = Array(b.utf8)
    guard aa.count == bb.count else { return false }
    var difference: UInt8 = 0
    for i in aa.indices { difference |= aa[i] ^ bb[i] }
    return difference == 0
}
#endif
