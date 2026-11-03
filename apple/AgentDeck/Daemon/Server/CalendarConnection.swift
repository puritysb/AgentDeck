#if os(macOS)
import Foundation
import Security
import LocalAuthentication

struct CalendarConfiguration: Codable, Sendable, Equatable {
    var urls: [String]
    var timeZone: String?
    var normalized: Self? {
        let sources = urls.compactMap(Self.normalizeURL)
        guard !sources.isEmpty, sources.count == urls.count, sources.count <= CalendarPolicy.maxSources,
              timeZone == nil || TimeZone(identifier: timeZone!) != nil else { return nil }
        return .init(urls: sources, timeZone: timeZone)
    }
    var valid: Bool { !urls.isEmpty && urls.count <= CalendarPolicy.maxSources && urls.allSatisfy(Self.validURL) && (timeZone == nil || TimeZone(identifier: timeZone!) != nil) }
    static func validURL(_ raw: String) -> Bool {
        normalizeURL(raw) != nil
    }
    static func normalizeURL(_ input: String) -> String? {
        let raw = input.hasPrefix(CalendarPolicy.subscriptionScheme)
            ? CalendarPolicy.subscriptionTransport + input.dropFirst(CalendarPolicy.subscriptionScheme.count) : input
        guard raw.utf8.count <= CalendarPolicy.maxUrlBytes, !raw.isEmpty,
              !raw.contains("\\"), !raw.contains("#"), raw.range(of: #"%(?![0-9a-fA-F]{2})"#, options: .regularExpression) == nil,
              !raw.unicodeScalars.contains(where: { $0.value <= 32 || $0.value == 127 || CharacterSet.whitespacesAndNewlines.contains($0) }),
              let c = URLComponents(string: raw), let host = c.host, !host.isEmpty, c.user == nil, c.password == nil,
              c.url != nil else { return nil }
        return c.scheme == "https" || (c.scheme == "http" && ["127.0.0.1","localhost","[::1]","::1"].contains(host)) ? raw : nil
    }
}
struct CalendarSecretStorage: Sendable {
    var load: @Sendable () throws -> Data?
    var save: @Sendable (Data) throws -> Void
    var remove: @Sendable () throws -> Void
    var consent: @Sendable () -> Bool
    var setConsent: @Sendable (Bool) -> Void
    static func keychain(service: String = (Bundle.main.bundleIdentifier ?? "bound.serendipity.agent.deck") + ".calendar") -> Self {
        let base: @Sendable () -> [String: Any] = {
            [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"ics-sources",
             kSecAttrSynchronizable as String:false,kSecUseDataProtectionKeychain as String:true]
        }
        let query: @Sendable () -> [String: Any] = {
            let context = LAContext(); context.interactionNotAllowed = true
            var q = base(); q[kSecUseAuthenticationContext as String] = context; return q
        }
        @Sendable func check(_ status: OSStatus) throws { if status != errSecSuccess { throw CalendarICS.Failure.invalid } }
        let key = service + ".consent"
        return .init(load: {
            var q = query(); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
            var value: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &value)
            if status == errSecItemNotFound { return nil }; try check(status)
            guard let data = value as? Data else { throw CalendarICS.Failure.invalid }; return data
        }, save: { data in
            let status = SecItemUpdate(query() as CFDictionary, [kSecValueData as String:data] as CFDictionary)
            if status == errSecItemNotFound {
                var q = base(); q[kSecValueData as String] = data; q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                try check(SecItemAdd(q as CFDictionary, nil))
            } else { try check(status) }
        }, remove: {
            let status = SecItemDelete(query() as CFDictionary); if status != errSecItemNotFound { try check(status) }
        }, consent: { UserDefaults.standard.bool(forKey: key) }, setConsent: { UserDefaults.standard.set($0, forKey: key) })
    }
}
final class CalendarGrant: @unchecked Sendable {
    private let lock = NSLock()
    private var revision = 0, enabled = false
    private var callbacks: [UUID: @Sendable () -> Void] = [:]
    var value: Int { lock.withLock { revision } }
    func accepts(_ expected: Int) -> Bool { lock.withLock { enabled && revision == expected } }
    func advance(enabled: Bool, before: @Sendable () -> Void = {}) {
        let pending = lock.withLock { before(); self.revision += 1; self.enabled = enabled; let all = Array(callbacks.values); callbacks.removeAll(); return all }
        for callback in pending { callback() }
    }
    func activate(_ expected: Int, before: @Sendable () -> Void = {}) -> Bool {
        let pending: [@Sendable () -> Void]? = lock.withLock {
            guard revision == expected else { return nil }
            before(); revision += 1; enabled = true
            let all = Array(callbacks.values); callbacks.removeAll(); return all
        }
        guard let pending else { return false }
        for callback in pending { callback() }; return true
    }
    func observe(_ expected: Int, callback: @escaping @Sendable () -> Void) -> UUID? {
        let id = UUID()
        let ok = lock.withLock { if !enabled || revision != expected { return false }; callbacks[id] = callback; return true }
        if !ok { callback(); return nil }; return id
    }
    func remove(_ id: UUID?) { if let id { lock.withLock { _ = callbacks.removeValue(forKey: id) } } }
}
actor CalendarConnection {
    static let shared = CalendarConnection()
    nonisolated let grant = CalendarGrant()
    private nonisolated let storage: CalendarSecretStorage
    private var loaded = false
    private var config: CalendarConfiguration?
    init(storage: CalendarSecretStorage = .keychain()) { self.storage = storage }
    func snapshot() throws -> (Int, CalendarConfiguration?) {
        if !loaded {
            let expected = grant.value
            if storage.consent() {
                guard let data = try storage.load() else { throw CalendarICS.Failure.invalid }
                let decoded = try JSONDecoder().decode(CalendarConfiguration.self, from: data)
                guard let record = decoded.normalized else { throw CalendarICS.Failure.invalid }
                guard grant.activate(expected) else { loaded = true; config = nil; return (grant.value, nil) }
                config = record
            }
            loaded = true
        }
        if config != nil, !grant.accepts(grant.value) { config = nil }
        return (grant.value, config)
    }
    func connect(urls: [String], consent: Bool, expectedRevision: Int? = nil) throws {
        let expected = expectedRevision ?? grant.value
        guard expected == grant.value else { throw CancellationError() }
        guard consent else { throw CalendarICS.Failure.invalid }
        guard let record = CalendarConfiguration(urls: urls).normalized else { throw CalendarICS.Failure.invalid }
        try storage.save(JSONEncoder().encode(record))
        guard grant.activate(expected, before: { [storage] in storage.setConsent(true) }) else { throw CancellationError() }
        config = record; loaded = true
    }
    nonisolated func revoke() { grant.advance(enabled: false, before: { [storage] in storage.setConsent(false) }) }
    func disconnect() throws {
        revoke(); config = nil; loaded = true
        try storage.remove()
    }
    func summary() throws -> String { let (_, cfg) = try snapshot(); return cfg.map { "Configured · \($0.urls.count) calendar sources" } ?? "Not connected" }
}
#endif
