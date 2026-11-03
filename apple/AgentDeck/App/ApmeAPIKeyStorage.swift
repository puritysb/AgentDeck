import Foundation
import Security
import LocalAuthentication
import Darwin

/// Noninteractive, device-local credential storage. An empty item is a tombstone:
/// clearing a key must never reactivate a stale plaintext copy after a restart.
struct ApmeAPIKeyStorage: Sendable {
    var load: @Sendable () throws -> String?
    var save: @Sendable (String) throws -> Void

    static var current: Self? {
        guard !AgentDeckApp.isHostedTest(environment: ProcessInfo.processInfo.environment) else { return nil }
        #if os(macOS)
        guard AgentDeckRuntime.isSandboxed else { return nil }
        #endif
        return keychain()
    }

    static func keychain() -> Self {
        let service = (Bundle.main.bundleIdentifier ?? "bound.serendipity.agent.deck") + ".apme-judge"
        let query: @Sendable () -> [String: Any] = {
            let context = LAContext()
            context.interactionNotAllowed = true
            return [kSecClass as String: kSecClassGenericPassword,
                    kSecAttrService as String: service, kSecAttrAccount as String: "api-key",
                    kSecAttrSynchronizable as String: false, kSecUseDataProtectionKeychain as String: true,
                    kSecUseAuthenticationContext as String: context]
        }
        @Sendable func check(_ status: OSStatus) throws {
            guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        }
        return Self(load: {
            var q = query()
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            let status = SecItemCopyMatching(q as CFDictionary, &item)
            if status == errSecItemNotFound { return nil }
            try check(status)
            guard let data = item as? Data, let key = String(data: data, encoding: .utf8) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            return key
        }, save: { key in
            let data = Data(key.utf8)
            let status = SecItemUpdate(query() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                var q = query()
                q[kSecValueData as String] = data
                q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                try check(SecItemAdd(q as CFDictionary, nil))
            } else { try check(status) }
        })
    }

    /// A secure store never falls back to a plaintext config, even when empty or
    /// temporarily unavailable. CLI/development profiles retain their file contract.
    static func resolve(configured: String?, storage: Self? = current) throws -> String? {
        let key: String?
        if let storage { key = try storage.load() } else { key = configured }
        return key.flatMap { $0.isEmpty ? nil : $0 }
    }
}

/// Transaction order is credential acknowledgement, then legacy-copy removal.
/// Inject both storage and profile URL in tests; hosted XCTest never touches the
/// user's Keychain or AgentDeck profile through the default initializer.
final class ApmeCredentialProfile {
    static let legacyKey = "prefs.apmeJudgeApiKey"
    let storage: ApmeAPIKeyStorage?
    let url: URL?
    private let defaults: UserDefaults
    private var acknowledged = false

    static var currentURL: URL? {
        guard !AgentDeckApp.isHostedTest(environment: ProcessInfo.processInfo.environment) else { return nil }
        #if os(macOS)
        return AgentDeckPaths.settingsJson
        #else
        return nil
        #endif
    }

    init(defaults: UserDefaults, storage: ApmeAPIKeyStorage?, url: URL?) {
        self.defaults = defaults
        self.storage = storage
        self.url = url
    }

    private func read() throws -> [String: Any] {
        guard let url else { return [:] }
        guard FileManager.default.fileExists(atPath: url.path) else { return [:] }
        guard let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return root
    }

    private func write(_ root: [String: Any]) throws {
        guard let url else { return }
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let temp = directory.appendingPathComponent(".apme-" + UUID().uuidString)
        let fd = open(temp.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
        guard fd >= 0 else { throw CocoaError(.fileWriteUnknown) }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close(); try? FileManager.default.removeItem(at: temp) }
        try handle.write(contentsOf: JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys]))
        try handle.synchronize()
        guard rename(temp.path, url.path) == 0 else { throw CocoaError(.fileWriteUnknown) }
    }

    func migrate() throws -> String {
        var root = try read()
        var apme = root["apme"] as? [String: Any] ?? [:]
        var judge = apme["judge"] as? [String: Any] ?? [:]
        let legacy = defaults.string(forKey: Self.legacyKey) ?? (judge["apiKey"] as? String) ?? ""
        let key: String
        if let storage {
            if let existing = try storage.load() { key = existing }
            else { try storage.save(legacy); key = legacy }
            // Do not scrub the only copy until a secure write has succeeded.
            acknowledged = true
            if judge.removeValue(forKey: "apiKey") != nil {
                apme["judge"] = judge; root["apme"] = apme
                try write(root)
            }
        } else {
            key = legacy
            // Unsandboxed developer builds share the explicit CLI profile, with
            // private file permissions, rather than duplicating keys in defaults.
            if url != nil, defaults.object(forKey: Self.legacyKey) != nil {
                if key.isEmpty { judge.removeValue(forKey: "apiKey") } else { judge["apiKey"] = key }
                apme["judge"] = judge; root["apme"] = apme
                try write(root)
            }
            acknowledged = true
        }
        if storage != nil || url != nil { defaults.removeObject(forKey: Self.legacyKey) }
        return key
    }

    func save(_ key: String, backend: String, endpoint: String, model: String) throws {
        if let storage { try storage.save(key) }
        acknowledged = true
        try writeConfiguration(key: key, backend: backend, endpoint: endpoint, model: model)
        if storage != nil || url != nil { defaults.removeObject(forKey: Self.legacyKey) }
    }

    func writeConfiguration(key: String, backend: String, endpoint: String, model: String) throws {
        guard acknowledged else { return }
        var root = try read()
        var apme = root["apme"] as? [String: Any] ?? [:]
        var judge = apme["judge"] as? [String: Any] ?? [:]
        judge["backend"] = backend
        for (name, value) in [("endpoint", endpoint), ("model", model)] {
            let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if clean.isEmpty { judge.removeValue(forKey: name) } else { judge[name] = clean }
        }
        if storage != nil || key.isEmpty { judge.removeValue(forKey: "apiKey") }
        else { judge["apiKey"] = key }
        apme["judge"] = judge; root["apme"] = apme
        try write(root)
    }
}
