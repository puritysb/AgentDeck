#if os(macOS)
import Foundation
import Security

/// Imported only through local owner custody, never from a network device.
@DaemonActor
enum DeviceTLSIdentity {
    static func load(pfx: Data, password: String, caDER: Data, hostname: String) throws -> SecIdentity {
        guard pfx.count <= DeviceSecurityRules.maxIdentityBytes, caDER.count <= DeviceSecurityRules.maxCertificateBytes, !hostname.isEmpty else { throw DeviceTLSFailure.message("Invalid TLS identity.") }
        var items: CFArray?
        let status = SecPKCS12Import(pfx as CFData,
            [kSecImportExportPassphrase: password, kSecImportToMemoryOnly: true] as CFDictionary, &items)
        guard status == errSecSuccess, let rows = items as? [[String: Any]], rows.count == 1,
              let value = rows[0][kSecImportItemIdentity as String], CFGetTypeID(value as CFTypeRef) == SecIdentityGetTypeID(),
              let anchor = SecCertificateCreateWithData(nil, caDER as CFData) else { throw DeviceTLSFailure.message("TLS identity import failed.") }
        let identity = value as! SecIdentity
        var leaf: SecCertificate?
        guard SecIdentityCopyCertificate(identity, &leaf) == errSecSuccess, let leaf else { throw DeviceTLSFailure.message("TLS certificate missing.") }
        let chain = rows[0][kSecImportItemCertChain as String] as? [SecCertificate] ?? [leaf]
        var trust: SecTrust?
        guard SecTrustCreateWithCertificates(chain as CFArray, SecPolicyCreateSSL(true, hostname as CFString), &trust) == errSecSuccess,
              let trust else { throw DeviceTLSFailure.message("TLS identity cannot be verified.") }
        var trustError: CFError?
        guard SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
              SecTrustEvaluateWithError(trust, &trustError) else { throw DeviceTLSFailure.message("TLS certificate validation failed: \(trustError.map { CFErrorCopyDescription($0) as String } ?? "unknown")") }
        return identity
    }
}
#endif
