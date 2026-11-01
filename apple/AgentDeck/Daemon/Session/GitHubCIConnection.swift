#if os(macOS)
import Foundation
import Security
import LocalAuthentication

struct GitHubCIAccount: Codable, Sendable {
    let id: Int?
    let login: String
    let repositories: [String]
    let token: String?
}

struct GitHubCIStorage: Sendable {
    var load: @Sendable () throws -> Data?
    var save: @Sendable (Data) throws -> Void
    var remove: @Sendable () throws -> Void
    var consent: @Sendable () -> Bool
    var setConsent: @Sendable (Bool) -> Void
    static func keychain(service: String = (Bundle.main.bundleIdentifier ?? "bound.serendipity.agent.deck") + ".github-ci") -> Self {
        let consentKey = service + ".enabled"
        let base: @Sendable () -> [String: Any] = {
            [kSecClass as String:kSecClassGenericPassword, kSecAttrService as String:service,
             kSecAttrAccount as String:"github.com", kSecAttrSynchronizable as String:false,
             kSecUseDataProtectionKeychain as String:true]
        }
        let query: @Sendable () -> [String: Any] = {
            let context = LAContext(); context.interactionNotAllowed = true
            var q = base(); q[kSecUseAuthenticationContext as String] = context; return q
        }
        @Sendable func check(_ status: OSStatus) throws {
            guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        }
        return .init(load: {
            var q = query(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &item)
            if status == errSecItemNotFound { return nil }
            try check(status); guard let data = item as? Data else { throw GitHubCIClient.Failure(reason:"keychain") }; return data
        }, save: { data in
            let status = SecItemUpdate(query() as CFDictionary, [kSecValueData as String:data] as CFDictionary)
            if status == errSecItemNotFound {
                var q = base(); q[kSecValueData as String] = data
                q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                try check(SecItemAdd(q as CFDictionary, nil))
            } else { try check(status) }
        }, remove: {
            let status = SecItemDelete(query() as CFDictionary)
            if status != errSecItemNotFound { try check(status) }
        }, consent: { UserDefaults.standard.bool(forKey: consentKey) },
           setConsent: { UserDefaults.standard.set($0, forKey: consentKey) })
    }
}

/// A separate actor keeps Keychain work off both UI and daemon executors.
/// Non-interactive Keychain APIs serialize writes with consent/revision changes.
final class GitHubCIGeneration: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0
    private var message = ""
    var value: Int { lock.lock(); defer { lock.unlock() }; return stored }
    func set(_ value: Int) { lock.lock(); stored = value; message = ""; lock.unlock() }
    var notice: String { lock.lock(); defer { lock.unlock() }; return message }
    func report(_ text: String, revision: Int) { lock.lock(); defer { lock.unlock() }; if stored == revision { message = text } }
}

actor GitHubCIConnection {
    nonisolated let generation = GitHubCIGeneration()
    static let shared = GitHubCIConnection()
    private let storage: GitHubCIStorage
    private let client: GitHubCIClient
    private var loaded = false
    private var account: GitHubCIAccount?
    private var revision = 0
    private var mutation = 0
    init(storage: GitHubCIStorage = .keychain(), client: GitHubCIClient = .init()) {
        self.storage = storage; self.client = client
    }
    func snapshot() throws -> (revision: Int, account: GitHubCIAccount?) {
        if !loaded {
            if storage.consent(), let data = try storage.load() {
                let record = try JSONDecoder().decode(GitHubCIAccount.self, from: data)
                guard !record.repositories.isEmpty, record.repositories.count <= GitHubCIPolicy.maxRepositories,
                      record.repositories.allSatisfy({ GitHubCIIdentity.repository($0) == $0 }),
                      (record.token == nil && record.id == nil) || (record.token.map(GitHubCIClient.validToken) == true && (record.id ?? 0) > 0)
                else { throw GitHubCIClient.Failure(reason:"invalid_configuration") }
                account = record
            }
            loaded = true
        }
        return (revision, account)
    }
    func connect(repositories: [String], token: String?, consent: Bool) async throws {
        guard consent else { throw GitHubCIClient.Failure(reason:"consent_required") }
        let repos = Array(Set(repositories.compactMap(GitHubCIIdentity.repository))).sorted()
        guard !repos.isEmpty, repos.count <= GitHubCIPolicy.maxRepositories,
              repos.count == Set(repositories.map { $0.lowercased() }).count else { throw GitHubCIClient.Failure(reason:"invalid_repositories") }
        let secret = token?.trimmingCharacters(in: .whitespacesAndNewlines)
        let key = secret?.isEmpty == false ? secret : nil
        guard key == nil || GitHubCIClient.validToken(key!) else { throw GitHubCIClient.Failure(reason:"fine_grained_token_required") }
        mutation += 1; let ticket = mutation
        let identity: (Int, String)?
        if let key { identity = try await client.account(token: key) } else { identity = nil }
        try Task.checkCancellation()
        guard ticket == mutation else { throw CancellationError() }
        let record = GitHubCIAccount(id: identity?.0, login: identity?.1 ?? "Public repositories", repositories: repos, token: key)
        try storage.save(JSONEncoder().encode(record))
        storage.setConsent(true)
        account = record; loaded = true; revision += 1; generation.set(revision)
    }
    func disconnect() throws {
        mutation += 1; revision += 1; generation.set(revision); account = nil; loaded = true
        storage.setConsent(false)
        try storage.remove()
    }
    func repositories() throws -> [String] { try snapshot().account?.repositories ?? [] }
    func summary() throws -> String {
        let value = try snapshot()
        guard let account = value.account else { return "Not connected" }
        return account.login + " · " + String(account.repositories.count) + " repositories" + (generation.notice.isEmpty ? "" : " · " + generation.notice)
    }
}

#endif
