#if os(macOS)
// ZaiUsageClient.swift — z.ai GLM Coding Plan quota polling (#348).
//
// The Swift daemon's half of the z.ai provider account: a direct read-only GET
// against the provider's monitor endpoint with the user-pasted coding-plan key
// (Keychain, same pattern as the Anthropic Admin API key). No subprocess, so
// the App Store build keeps its self-containment; the plan serves Claude Code,
// Codex and other CLIs from one quota, and this reading is independent of all
// of them.
//
// The endpoint is undocumented (same status as Codex's account endpoint):
// redirects are refused, credentials and responses are never logged, and the
// cache stores numbers + a fetch instant only. Window/plan/schema
// classification is the generated ZaiQuotaRules mirror (SSOT
// shared/src/zai-quota.ts, vectors replayed by ZaiQuotaRulesVectorsTests).

import Foundation

enum ZaiUsageApiKeyStore {
    private static let service = "bound.serendipity.agent.deck.zai.coding-plan-key"
    private static let account = "default"

    static func loadKey() -> String? {
        var query = keychainQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nonEmpty
    }

    static func saveKey(_ key: String) throws {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            try deleteKey()
            return
        }
        let data = Data(trimmed.utf8)
        let query = keychainQuery()
        let updateStatus = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(updateStatus), userInfo: nil)
        }
        var attributes = query
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(addStatus), userInfo: nil)
        }
    }

    static func deleteKey() throws {
        let status = SecItemDelete(keychainQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status), userInfo: nil)
        }
    }

    private static func keychainQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}

/// A z.ai quota reading plus whether it is a LIVE one — freshness is never
/// folded into the data (same contract as the Node client's
/// `ZaiUsageFetchResult`).
struct ZaiUsageResult: Sendable {
    /// nil only when no key is configured and nothing is cached. A windowless
    /// value (`{limitId: "payg"}` or a retirement block) is a legitimate
    /// reading with no gauges.
    var data: ZaiRateLimits?
    var fresh: Bool
}

/// Lock-guarded client state. Sync accessors only — the lock must never be
/// held across a suspension point, so every method is synchronous and small
/// (the `UsageCacheDataBox` pattern from UsageAPIClient.swift).
final class ZaiUsageState: @unchecked Sendable {
    private let lock = NSLock()
    private var key: String?
    private var generation = 0
    private var reading: ZaiRateLimits?
    private var fetchedAt: Date = .distantPast
    private var failures = 0
    private var lastAttemptAt: Date = .distantPast
    private var fetching = false

    func revision() -> Int {
        lock.lock(); defer { lock.unlock() }
        return generation
    }

    /// A settings edit invalidates pending responses before the next key read.
    func invalidate() {
        lock.lock(); defer { lock.unlock() }
        reset()
        key = nil
    }

    private func reset() {
        generation += 1
        reading = ZaiRateLimits()
        fetchedAt = .distantPast
        failures = 0
        lastAttemptAt = .distantPast
        fetching = false
    }

    func prepare(key newKey: String?, expectedRevision: Int) -> Int? {
        lock.lock(); defer { lock.unlock() }
        guard generation == expectedRevision else { return nil }
        if key != newKey {
            reset()
            key = newKey
        }
        return generation
    }

    func cached() -> (data: ZaiRateLimits, fetchedAt: Date)? {
        lock.lock(); defer { lock.unlock() }
        return reading.map { ($0, fetchedAt) }
    }

    @discardableResult
    func store(_ data: ZaiRateLimits, at date: Date, revision: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard generation == revision else { return false }
        reading = data
        fetchedAt = date
        failures = 0
        return true
    }

    func cacheFresh(now: Date, ttl: TimeInterval, slack: TimeInterval) -> Bool {
        lock.lock(); defer { lock.unlock() }
        let age = now.timeIntervalSince(fetchedAt)
        return age >= 0 && age < ttl - slack
    }

    func beginAttempt(now: Date, backoffs: [TimeInterval], revision: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard generation == revision, !fetching else { return false }
        if failures > 0 && now.timeIntervalSince(lastAttemptAt) < backoffs[min(failures - 1, backoffs.count - 1)] {
            return false
        }
        fetching = true
        lastAttemptAt = now
        return true
    }

    func endAttempt(revision: Int) {
        lock.lock(); defer { lock.unlock() }
        if generation == revision { fetching = false }
    }

    func noteFailure(revision: Int) -> Int {
        lock.lock(); defer { lock.unlock() }
        guard generation == revision else { return 0 }
        failures += 1
        return failures
    }
}

/// Never forward a provider credential through a redirect.
private final class ZaiNoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Fetches the GLM Coding Plan quota from the z.ai monitor endpoint.
/// Mirrors the Node client (bridge/src/zai-usage.ts): raw-token
/// Authorization header, TTL/slack cache, failure backoff.
final class ZaiUsageClient: @unchecked Sendable {
    static let shared = ZaiUsageClient()

    private static let quotaURL = URL(string: "https://api.z.ai/api/monitor/usage/quota/limit")!
    /// Set together with the 60s daemon poll that reads it; the slack keeps a
    /// poll interval dividing the TTL from doubling the effective refresh.
    private static let cacheTTL: TimeInterval = 120
    private static let cacheSlack: TimeInterval = 15
    private static let backoffIntervals: [TimeInterval] = [45, 90, 180, 300]

    private let state = ZaiUsageState()
    private let keyLoader: @Sendable () -> String?
    private let session: URLSession

    init(keyLoader: @escaping @Sendable () -> String? = { ZaiUsageApiKeyStore.loadKey() },
         session: URLSession? = nil) {
        self.keyLoader = keyLoader
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 10
        configuration.timeoutIntervalForResource = 10
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        self.session = session ?? URLSession(configuration: configuration, delegate: ZaiNoRedirectDelegate(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func invalidate() { state.invalidate() }

    /// The cached reading and when it was fetched, if any.
    func cached() -> (data: ZaiRateLimits, fetchedAt: Date)? {
        state.cached()
    }

    /// Fetch the quota. Returns a not-fresh cached reading on failure, and
    /// `{data: nil, fresh: false}` only when no key is configured. The key
    /// read happens in a detached task so a Keychain prompt cannot block the daemon actor.
    func fetch() async -> ZaiUsageResult {
        let expectedRevision = state.revision()
        let keyLoader = self.keyLoader
        let key = await Task.detached(priority: .userInitiated) { keyLoader() }.value
        guard let revision = state.prepare(key: key, expectedRevision: expectedRevision) else { return failResult() }
        guard let key else {
            return ZaiUsageResult(data: nil, fresh: false)
        }
        if state.cacheFresh(now: Date(), ttl: Self.cacheTTL, slack: Self.cacheSlack) {
            // A within-TTL entry was written by a real network fetch.
            return ZaiUsageResult(data: state.cached()?.data, fresh: true)
        }
        if ZaiQuotaRules.keyLooksPayAsYouGo(key) {
            // Not a subscription — an explicit windowless block, so any prior
            // plan gauges clear instead of freezing (retain-on-absent).
            let payg = ZaiRateLimits(
                primary: nil, secondary: nil, planType: nil, limitId: "payg", capturedAt: nil
            )
            state.store(payg, at: Date(), revision: revision)
            return ZaiUsageResult(data: payg, fresh: true)
        }

        guard state.beginAttempt(now: Date(), backoffs: Self.backoffIntervals, revision: revision) else {
            return ZaiUsageResult(data: state.cached()?.data, fresh: false)
        }
        defer { state.endAttempt(revision: revision) }

        var request = URLRequest(url: Self.quotaURL)
        request.httpMethod = "GET"
        // Raw token, no Bearer prefix — the provider's canonical spelling; the
        // prefixed form is also accepted upstream.
        request.setValue(key, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 10
        request.httpShouldHandleCookies = false

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else {
                noteFailure("no HTTP response", revision: revision)
                return failResult()
            }
            guard http.statusCode == 200 else {
                noteFailure("HTTP \(http.statusCode)", revision: revision)
                return failResult()
            }
            guard let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let envelope = body["data"] as? [String: Any],
                  (body["code"] as? NSNumber)?.intValue == 200, body["success"] as? Bool == true
            else {
                // The envelope answers 200 with {code:500} for a moved path —
                // an HTTP-200 failure is still a failure.
                noteFailure("error envelope", revision: revision)
                return failResult()
            }

            let windows = ZaiQuotaRules.quotaFromLimits(
                envelope["limits"],
                level: envelope["level"] as? String
            )
            let reading = ZaiRateLimits(
                primary: wireWindow(windows.primary),
                secondary: wireWindow(windows.secondary),
                planType: windows.planType,
                limitId: windows.limitId,
                capturedAt: ISO8601DateFormatter().string(from: Date())
            )
            guard state.store(reading, at: Date(), revision: revision) else { return failResult() }
            return ZaiUsageResult(data: reading, fresh: true)
        } catch {
            noteFailure("network request failed", revision: revision)
            return failResult()
        }
    }

    /// Map a classified window onto the wire window shape (stale marking is
    /// the payload layer's job, same as Codex).
    private func wireWindow(_ window: ZaiQuotaRules.Window?) -> ZaiWindow? {
        guard let window else { return nil }
        return ZaiWindow(
            usedPercent: Double(window.usedPercent),
            windowMinutes: window.windowMinutes,
            resetsAt: window.resetsAtIso,
            stale: nil,
            quantity: window.quantity
        )
    }

    private func failResult() -> ZaiUsageResult {
        ZaiUsageResult(data: state.cached()?.data, fresh: false)
    }

    private func noteFailure(_ reason: String, revision: Int) {
        // First failure and every fifth after it — the key and the response
        // body never appear in a log line.
        let count = state.noteFailure(revision: revision)
        if count == 1 || (count > 0 && count % 5 == 0) {
            DaemonLogger.shared.debug("ZaiUsage", "fetch failed (\(count)x): \(reason)")
        }
    }
}
#endif
