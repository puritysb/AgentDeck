#if os(macOS)
// UsageAPIClient.swift — OAuth token management + API usage fetch
// Ported from bridge/src/usage-api.ts

import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private final class UsageCacheDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func set(_ data: Data?) {
        lock.lock()
        self.data = data
        lock.unlock()
    }

    func get() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

struct ApiUsageData: Sendable {
    var fiveHourPercent: Double?
    var fiveHourResetsAt: String?
    var sevenDayPercent: Double?
    var sevenDayResetsAt: String?
    /// Per-model scoped caps from the API `limits[]` array, worst-first. Mirrors
    /// the TS `ApiUsageData.scopedLimits`.
    var scopedLimits: [ScopedUsageLimit] = []
    var extraUsageEnabled: Bool = false
    var extraUsageMonthlyLimit: Double?
    var extraUsageUsedCredits: Double?
    var extraUsageUtilization: Double?
    var inferredBillingType: String?  // "subscription" | "api" | nil
    var fetchedAt: Double?
    var stale: Bool = false
}

struct CodexAuthStatus: Sendable {
    var authMode: String?
    var webAuthConnected: Bool = false
    var accessTokenPresent: Bool = false
    var planType: String?
    var accountId: String?
    var subscriptionActiveUntil: String?
    var lastRefreshAt: String?
}

struct AntigravityStatus: Sendable {
    var planName: String?
    var availableCredits: Int?
    var minimumCreditAmountForUsage: Int?
    var subscriptionActiveUntil: String?
}

/// One Codex (ChatGPT) rate-limit window read from local rollout files.
struct CodexRateLimitWindowLocal: Sendable {
    var usedPercent: Double
    var windowMinutes: Int
    var resetsAt: String?
    /// True when this window's snapshot has expired (its `resetsAt` slid into the
    /// past with no fresher Codex activity). Mirrors the TS `stale` flag set in
    /// `buildUsageEvent` — renderers dim the gauge and show a "stale" marker
    /// instead of a misleading "now" countdown.
    var stale: Bool = false
}

/// Codex credit balance — the metering credit-based plans report (e.g.
/// `limit_id: "premium"`) when the 5h/7d windows are null. Mirrors the TS
/// `CodexCredits` so the daemon can map an exhausted balance onto a synthetic
/// usage gauge.
struct CodexCreditsLocal: Sendable {
    var hasCredits: Bool
    var unlimited: Bool
    var balance: String?

    /// Remaining balance parsed as a number, or nil when absent / non-numeric.
    var balanceValue: Double? {
        guard let balance else { return nil }
        return Double(balance)
    }
}

/// Codex usage limits parsed from the user's own local Codex session rollout
/// files (`~/.codex/sessions/.../rollout-*.jsonl`). Same posture as
/// `readRawCodexAuthStatus` reading `~/.codex/auth.json` — local files only,
/// no Codex/OpenAI API is contacted.
struct CodexRateLimitsLocal: Sendable {
    var primary: CodexRateLimitWindowLocal?
    var secondary: CodexRateLimitWindowLocal?
    var planType: String?
    var limitId: String?
    var credits: CodexCreditsLocal?
    /// ISO-8601 instant this snapshot was WRITTEN by Codex — the rate-limit
    /// line's own `timestamp`, falling back to the rollout file's mtime. Mirrors
    /// `capturedAt` in the TS `CodexRateLimits` (bridge/src/codex-rate-limits.ts):
    /// the only field that can distinguish "94% now" from "94% four hours ago",
    /// since a weekly window's `resetsAt` stays in the future for up to 7 days.
    var capturedAt: String?
}

enum TokenStatus: String, Sendable {
    case valid, expired, missing, unknown
}

/// Fetches API usage from Anthropic OAuth endpoint, with caching and backoff.
final class UsageAPIClient: Sendable {
    static let shared = UsageAPIClient()

    private static let usageAPIURL = "https://api.anthropic.com/api/oauth/usage"
    private static let keychainService = "Claude Code-credentials"
    private static let cacheFile = AuthManager.agentDeckDir.appendingPathComponent("usage-cache.json")
    private static let fileCacheTTL: TimeInterval = 120  // seconds
    private static let tokenExpiryMargin: TimeInterval = 600  // 10 minutes
    static let directOAuthUsageSupported = false
    // .userInteractive: fetchUsage()/fetchUsageRelayed() are reachable from
    // main-actor entry points (DaemonServer initial usage task, query_usage
    // command handler) that sync-wait via DispatchSemaphore. Anything below
    // User-interactive (incl. .userInitiated) leaves a one-step priority
    // inversion that TPC flags. The work is a single Data(contentsOf:)
    // bounded by a 700 ms timeout, so the elevated QoS is bounded.
    private static let cacheIOQueue = DispatchQueue(label: "dev.agentdeck.usage.cache-io", qos: .userInteractive)
    private static let cacheReadTimeout: DispatchTimeInterval = .milliseconds(700)

    /// Real home directory, resolved once at process start via the reentrant
    /// `getpwuid_r`. The non-reentrant `getpwuid` returns a pointer into a
    /// thread-shared static buffer, so calling it from multiple threads
    /// (main + ESP32 heartbeat + usage polling) corrupts the result and
    /// crashes during ARC cleanup of the returned struct. `getuid()` is
    /// invariant for the process lifetime, so one-shot resolution is safe.
    private static let resolvedHomeDir: String = {
        var pwd = passwd()
        var result: UnsafeMutablePointer<passwd>?
        var buffer = [CChar](repeating: 0, count: 16 * 1024)
        let rc = getpwuid_r(getuid(), &pwd, &buffer, buffer.count, &result)
        if rc == 0, result != nil {
            return String(cString: pwd.pw_dir)
        }
        return NSHomeDirectory()
    }()

    /// Serializes the Codex auth read path. `readRawCodexAuthStatus` hits
    /// the filesystem and decodes JWTs; under concurrent access the ARC
    /// release of the returned optional race-crashed (`_CFRelease.cold.1`).
    /// A single serial queue is enough — this is a polling path, not hot.
    private let codexAuthQueue = DispatchQueue(
        label: "bound.serendipity.agentdeck.usage.codex-auth"
    )

    /// Short-lived cache for the fully-stabilized Codex auth status so the
    /// hot polling path (ESP32 heartbeat at ~1 Hz) doesn't re-read auth.json
    /// every call.
    nonisolated(unsafe) private var codexAuthCacheEntry: (timestamp: Date, value: CodexAuthStatus?)?
    private static let codexAuthCacheTTL: TimeInterval = 5

    /// Serializes the Codex rate-limit read path (file tail + JSON parse).
    private let codexRateLimitsQueue = DispatchQueue(
        label: "bound.serendipity.agentdeck.usage.codex-ratelimits"
    )
    /// Cache keyed on "<rolloutPath>:<mtime>" so unchanged files are free.
    nonisolated(unsafe) private var codexRateLimitsCache: (key: String, value: CodexRateLimitsLocal?)?

    nonisolated(unsafe) private var consecutiveFailures = 0
    nonisolated(unsafe) private var lastTokenStatus: TokenStatus = .unknown
    nonisolated(unsafe) private var lastBackoffStart: Date = .distantPast
    nonisolated(unsafe) private var lastStableCodexAuthStatus: CodexAuthStatus?

    var tokenStatus: TokenStatus { lastTokenStatus }
    var isDirectOAuthUsageSupported: Bool { Self.directOAuthUsageSupported }
    var codexAuthStatus: CodexAuthStatus? {
        codexAuthQueue.sync {
            if let cached = codexAuthCacheEntry,
               Date().timeIntervalSince(cached.timestamp) < Self.codexAuthCacheTTL {
                return cached.value
            }
            let merged = Self.stabilizeCodexAuthStatus(
                previous: lastStableCodexAuthStatus,
                current: readRawCodexAuthStatusLocked()
            )
            lastStableCodexAuthStatus = merged
            codexAuthCacheEntry = (Date(), merged)
            return merged
        }
    }
    var antigravityStatus: AntigravityStatus? { readAntigravityStatus() }

    /// Latest Codex usage limits from local rollout files. Cached by active
    /// rollout path + mtime so repeated polls don't re-read an unchanged file.
    var codexRateLimits: CodexRateLimitsLocal? {
        codexRateLimitsQueue.sync { readCodexRateLimitsLocked() }
    }

    // MARK: - Fetch

    func fetchUsage() async -> ApiUsageData? {
        // Check file cache first — keep stale data as fallback for network failures
        var staleFallback: ApiUsageData?
        if let cached = readFileCache() {
            let age = Date().timeIntervalSince1970 - cached.fetchedAt
            if age < Self.fileCacheTTL {
                DaemonLogger.shared.debug("UsageAPI", "File cache hit (age \(Int(age))s)")
                var data = cached.data
                data.fetchedAt = cached.fetchedAt
                data.stale = false
                return data
            }
            DaemonLogger.shared.debug("UsageAPI", "File cache stale (age \(Int(age))s)")
            var fallback = cached.data
            fallback.fetchedAt = cached.fetchedAt
            fallback.stale = true
            staleFallback = fallback
        }

        guard Self.directOAuthUsageSupported else {
            DaemonLogger.shared.throttledDebug(
                "UsageAPI",
                key: "direct-oauth-unsupported",
                "Direct OAuth usage fetch unavailable in Swift daemon; using relay/admin/cache paths only",
                minInterval: 300
            )
            return staleFallback
        }

        // Check backoff
        if consecutiveFailures > 0 {
            let backoff = getBackoffSeconds()
            if backoff > 0 {
                DaemonLogger.shared.debug("UsageAPI", "Backoff active (\(consecutiveFailures) failures, \(Int(backoff))s remaining)")
                return staleFallback
            }
        }

        // Get OAuth token from Keychain
        guard let token = getOAuthToken() else {
            lastTokenStatus = .missing
            DaemonLogger.shared.debug("UsageAPI", "OAuth token missing (keychain lookup failed)")
            return staleFallback
        }

        // Check token expiry
        if let creds = getOAuthCredentials(), let expiresAt = creds.expiresAt {
            if Date().timeIntervalSince1970 > (Double(expiresAt) / 1000.0 - Self.tokenExpiryMargin) {
                lastTokenStatus = .expired
                DaemonLogger.shared.debug("UsageAPI", "OAuth token expired")
                return staleFallback
            }
        }

        // Fetch from API
        guard let apiURL = URL(string: Self.usageAPIURL) else { return staleFallback }
        var request = URLRequest(url: apiURL)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 10

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return staleFallback }

            if http.statusCode == 200,
               let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                lastTokenStatus = .valid
                consecutiveFailures = 0

                // Opt-in raw body dump for diagnosing 0% reports. Enable via
                // `AGENTDECK_DEBUG_USAGE_RAW=1` in the app's launch environment.
                if ProcessInfo.processInfo.environment["AGENTDECK_DEBUG_USAGE_RAW"] != nil,
                   let raw = String(data: data, encoding: .utf8) {
                    DaemonLogger.shared.debug("UsageAPI", "raw: \(raw)")
                }

                var usage = parseUsageResponse(json)
                usage.fetchedAt = Date().timeIntervalSince1970
                usage.stale = false
                writeFileCache(usage)
                DaemonLogger.shared.debug("UsageAPI", "API fetch OK: 5h=\(usage.fiveHourPercent ?? -1)% 7d=\(usage.sevenDayPercent ?? -1)%")
                return usage
            } else if http.statusCode == 429 {
                // Rate limited — respect Retry-After header
                consecutiveFailures += 1
                lastBackoffStart = Date()
                if let retryAfter = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After"),
                   let retrySec = Int(retryAfter), retrySec > 0 {
                    // Push file cache fetchedAt forward so TTL covers Retry-After
                    if let cached = readFileCache() {
                        let syntheticCache = CacheFile(
                            data: CacheFile.CodableUsage(
                                fiveHourPercent: cached.data.fiveHourPercent,
                                fiveHourResetsAt: cached.data.fiveHourResetsAt,
                                sevenDayPercent: cached.data.sevenDayPercent,
                                sevenDayResetsAt: cached.data.sevenDayResetsAt,
                                extraUsageEnabled: cached.data.extraUsageEnabled,
                                extraUsageMonthlyLimit: cached.data.extraUsageMonthlyLimit,
                                extraUsageUsedCredits: cached.data.extraUsageUsedCredits,
                                extraUsageUtilization: cached.data.extraUsageUtilization
                            ),
                            fetchedAt: Date().timeIntervalSince1970 + Double(retrySec) - Self.fileCacheTTL
                        )
                        if let cacheData = try? JSONEncoder().encode(syntheticCache) {
                            try? cacheData.write(to: Self.cacheFile)
                        }
                    }
                    DaemonLogger.shared.debug("UsageAPI", "Rate limited (429), Retry-After: \(retrySec)s")
                }
                return staleFallback
            } else {
                consecutiveFailures += 1
                lastBackoffStart = Date()
                if http.statusCode == 401 || http.statusCode == 403 { lastTokenStatus = .expired }
                DaemonLogger.shared.debug("UsageAPI", "API fetch failed: HTTP \(http.statusCode)")
                return staleFallback
            }
        } catch {
            consecutiveFailures += 1
            lastBackoffStart = Date()
            DaemonLogger.shared.debug("UsageAPI", "API fetch error: \(error.localizedDescription)")
            return staleFallback
        }
    }

    func hasOAuthToken() -> Bool {
        guard Self.directOAuthUsageSupported else { return false }
        return getOAuthToken() != nil
    }

    // MARK: - Keychain

    private struct OAuthCredentials {
        let accessToken: String
        var expiresAt: Int?
    }

    private func getOAuthCredentials() -> OAuthCredentials? {
        // Claude Code OAuth credentials live in the user's own keychain and
        // would require a shared Keychain Access Group (which Anthropic does
        // not publish) for SecItemCopyMatching to read them from this app.
        // App Store builds therefore do not attempt direct OAuth usage
        // polling; DaemonServer uses sibling relay, Admin API, or stale cache
        // semantics instead.
        return nil
    }

    private func getOAuthToken() -> String? {
        getOAuthCredentials()?.accessToken
    }

    // MARK: - Codex Web Auth

    /// Run `body` with the Codex base directory (`~/.codex`). Prefers a
    /// user-granted security-scoped bookmark so the sandboxed App Store build
    /// can read Codex's own local files (App Review-safe: user-selected file
    /// access, no `~`-relative entitlement, no subprocess). Falls back to a
    /// direct path for the Node CLI / unsigned dev build with full FS access.
    private func withCodexBase<T>(_ body: (URL) -> T?) -> T? {
        if AppPreferences.shared.hasCodexUsageBookmark {
            return AppPreferences.shared.withCodexDirectoryAccess { dir in body(dir) }
        }
        let direct = URL(fileURLWithPath: Self.resolvedHomeDir).appendingPathComponent(".codex")
        guard FileManager.default.fileExists(atPath: direct.path) else { return nil }
        return body(direct)
    }

    /// Must only be invoked inside `codexAuthQueue.sync { ... }`. Split out
    /// so the serialized `codexAuthStatus` getter has a clearly-locked
    /// version and so tests can exercise the raw read path directly.
    private func readRawCodexAuthStatusLocked() -> CodexAuthStatus? {
        withCodexBase { base in
            let authFile = base.appendingPathComponent("auth.json")
            guard let data = try? Data(contentsOf: authFile),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return nil
            }
            return self.parseCodexAuthJSON(json)
        }
    }

    private func parseCodexAuthJSON(_ json: [String: Any]) -> CodexAuthStatus {
        let tokens = json["tokens"] as? [String: Any]
        let accessTokenPresent = string(tokens, key: "access_token") != nil
        let accessPayload = decodeJWT(string(tokens, key: "access_token"))
        let idPayload = decodeJWT(string(tokens, key: "id_token"))
        let accessAuth = authNamespace(accessPayload)
        let idAuth = authNamespace(idPayload)
        let authMode = string(json, key: "auth_mode")

        let subscriptionActiveUntilRaw = firstString([
            string(json, key: "chatgpt_subscription_active_until"),
            string(accessAuth, key: "chatgpt_subscription_active_until"),
            string(idAuth, key: "chatgpt_subscription_active_until"),
            string(accessPayload, key: "chatgpt_subscription_active_until"),
            string(idPayload, key: "chatgpt_subscription_active_until"),
            string(accessPayload, key: "subscription_active_until"),
            string(idPayload, key: "subscription_active_until"),
        ])
        let subscriptionActiveStart = firstString([
            string(json, key: "chatgpt_subscription_active_start"),
            string(accessAuth, key: "chatgpt_subscription_active_start"),
            string(idAuth, key: "chatgpt_subscription_active_start"),
            string(accessPayload, key: "chatgpt_subscription_active_start"),
            string(idPayload, key: "chatgpt_subscription_active_start"),
            string(accessPayload, key: "subscription_active_start"),
            string(idPayload, key: "subscription_active_start"),
        ])
        // Codex never refreshes the login-time window snapshot, so for an
        // auto-renewing plan the raw `active_until` drifts into the past
        // mid-cycle. Roll it to the next real renewal boundary before it reaches
        // any renderer (macOS/D200H/ESP32) — mirrors the Node SSOT
        // `resolveChatGptRenewalDate` in bridge/src/codex-auth.ts.
        let subscriptionActiveUntil = Self.resolveChatGptRenewalDate(
            activeStart: subscriptionActiveStart,
            activeUntil: subscriptionActiveUntilRaw,
            now: Date()
        )

        return CodexAuthStatus(
            authMode: authMode,
            webAuthConnected: authMode == "chatgpt" && accessTokenPresent,
            accessTokenPresent: accessTokenPresent,
            planType: firstString([
                string(json, key: "chatgpt_plan_type"),
                string(accessAuth, key: "chatgpt_plan_type"),
                string(idAuth, key: "chatgpt_plan_type"),
                string(accessPayload, key: "chatgpt_plan_type"),
                string(idPayload, key: "chatgpt_plan_type"),
                string(accessPayload, key: "plan_type"),
                string(idPayload, key: "plan_type"),
            ]),
            accountId: firstString([
                string(json, key: "chatgpt_account_id"),
                string(accessAuth, key: "chatgpt_account_id"),
                string(idAuth, key: "chatgpt_account_id"),
                string(accessPayload, key: "chatgpt_account_id"),
                string(idPayload, key: "chatgpt_account_id"),
                string(accessAuth, key: "account_id"),
                string(idAuth, key: "account_id"),
                string(accessPayload, key: "account_id"),
                string(idPayload, key: "account_id"),
                string(json, key: "account_id"),
            ]),
            subscriptionActiveUntil: subscriptionActiveUntil,
            lastRefreshAt: string(json, key: "last_refresh")
        )
    }

    static func stabilizeCodexAuthStatus(previous: CodexAuthStatus?, current: CodexAuthStatus?) -> CodexAuthStatus? {
        guard let current else { return previous }
        guard let previous else { return current }

        let normalizedMode = current.authMode?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let stillChatGpt = normalizedMode == "chatgpt" || (normalizedMode == nil && current.accessTokenPresent)
        if normalizedMode != nil, normalizedMode != "chatgpt", !current.accessTokenPresent {
            return current
        }
        if !stillChatGpt {
            return current
        }

        return CodexAuthStatus(
            authMode: current.authMode ?? previous.authMode,
            webAuthConnected: current.webAuthConnected || previous.webAuthConnected,
            accessTokenPresent: current.accessTokenPresent || previous.accessTokenPresent,
            planType: current.planType ?? previous.planType,
            accountId: current.accountId ?? previous.accountId,
            subscriptionActiveUntil: current.subscriptionActiveUntil ?? previous.subscriptionActiveUntil,
            lastRefreshAt: current.lastRefreshAt ?? previous.lastRefreshAt
        )
    }

    private static let codexRenewalDaySeconds: TimeInterval = 86_400

    /// Resolve the ChatGPT subscription's *next* renewal date from the login
    /// snapshot Codex embeds in `auth.json`.
    ///
    /// Codex stamps `chatgpt_subscription_active_until` (and `..._active_start`)
    /// once, at `codex login`, and silent token refreshes carry that same window
    /// forward verbatim — so for an auto-renewing plan the snapshot's end slides
    /// into the past mid-cycle even though the subscription is alive and paid,
    /// which downstream surfaces (macOS/Android dashboard, D200H, ESP32 e-ink)
    /// misread as a false "renewal needed". Given the window `[start, until]`,
    /// roll the end forward by whole billing periods until it is strictly future
    /// — the next real renewal boundary. The raw `until` is returned untouched
    /// when it is already future, unparseable, or the window can't be trusted
    /// (missing start, non-positive period, or a period outside the
    /// monthly/annual 20–400d band) so genuine "malformed"/"unknown" signals
    /// still reach the renderers.
    ///
    /// Hand-ported mirror of `resolveChatGptRenewalDate` in
    /// `bridge/src/codex-auth.ts` — keep the two in lockstep.
    static func resolveChatGptRenewalDate(
        activeStart: String?,
        activeUntil: String?,
        now: Date
    ) -> String? {
        guard let activeUntil else { return activeUntil }
        guard let until = parseCodexRenewalDate(activeUntil) else { return activeUntil }
        if until > now { return activeUntil } // already future — trust the snapshot
        guard let activeStart, let start = parseCodexRenewalDate(activeStart) else {
            return activeUntil // no window to derive a period from
        }
        let period = until.timeIntervalSince(start)
        // Only roll monthly/annual-ish windows; anything shorter (incl. a
        // non-positive/malformed period) or longer is not a trustworthy cadence.
        if period < 20 * codexRenewalDaySeconds || period > 400 * codexRenewalDaySeconds {
            return activeUntil
        }
        let missed = max(1, Int((now.timeIntervalSince(until) / period).rounded(.up)))
        var rolled = until.addingTimeInterval(Double(missed) * period)
        if rolled <= now { rolled = rolled.addingTimeInterval(period) } // guarantee strictly future
        return codexRenewalISOString(rolled)
    }

    private static func parseCodexRenewalDate(_ raw: String) -> Date? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.contains("T") {
            let fractional = ISO8601DateFormatter()
            fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = fractional.date(from: trimmed) { return date }
            let plain = ISO8601DateFormatter()
            plain.formatOptions = [.withInternetDateTime]
            return plain.date(from: trimmed)
        }
        // Bare `YYYY-MM-DD` (Codex sometimes stores a date-only window) — UTC midnight.
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: trimmed)
    }

    private static func codexRenewalISOString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }

    private func decodeJWT(_ token: String?) -> [String: Any]? {
        guard let token else { return nil }
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = payload.count % 4
        if remainder > 0 {
            payload += String(repeating: "=", count: 4 - remainder)
        }
        guard let data = Data(base64Encoded: payload),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return json
    }

    private func authNamespace(_ dict: [String: Any]?) -> [String: Any]? {
        dict?["https://api.openai.com/auth"] as? [String: Any]
    }

    private func string(_ dict: [String: Any]?, key: String) -> String? {
        guard let raw = dict?[key] as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func firstString(_ values: [String?]) -> String? {
        values.first(where: { $0?.isEmpty == false }) ?? nil
    }

    // MARK: - Codex Rate Limits (local rollout files)

    /// Must only be invoked inside `codexRateLimitsQueue.sync { ... }`. The
    /// whole find-newest-file + tail-read runs inside `withCodexBase` so the
    /// security scope (App Store sandbox) stays active during the file read.
    private func readCodexRateLimitsLocked() -> CodexRateLimitsLocal? {
        withCodexBase { base in
            let candidates = Self.codexRolloutCandidates(sessionsDir: base.appendingPathComponent("sessions"))
            guard let newest = candidates.first else { return nil }
            let key = "\(newest.url.path):\(newest.mtime)"
            if let cached = self.codexRateLimitsCache, cached.key == key { return cached.value }

            let parsed = Self.parseFirstUsableCodexRollout(candidates)
            self.codexRateLimitsCache = (key, parsed)
            return parsed
        }
    }

    /// Scan candidates newest-first and return the first that yields a usable
    /// snapshot, falling through past a newer file that carries no `rate_limits`
    /// line (a just-started session). Stamps `capturedAt` from the snapshot line's
    /// own timestamp, falling back to the file mtime. Mirrors `parseFirstUsable`
    /// in bridge/src/codex-rate-limits.ts.
    static func parseFirstUsableCodexRollout(_ candidates: [(url: URL, mtime: TimeInterval)]) -> CodexRateLimitsLocal? {
        for candidate in candidates {
            guard let tail = readCodexRolloutTail(candidate.url),
                  var parsed = parseCodexRateLimits(tail) else { continue }
            if parsed.capturedAt == nil {
                parsed.capturedAt = codexCaptureISOString(Date(timeIntervalSince1970: candidate.mtime))
            }
            return parsed
        }
        return nil
    }

    /// Gather rollout files across the newest few day-directories of the
    /// year/month/day tree, sorted by mtime DESCENDING (capped).
    ///
    /// Selecting by mtime *across* day-dirs — not just within the single newest
    /// one — is what lets a session started yesterday and still appending win over
    /// a fresh-but-empty session that merely created a newer day-directory. Port
    /// of `candidateRolloutFiles` in bridge/src/codex-rate-limits.ts; the previous
    /// single-dir descent here silently reported an older (or no) snapshot than
    /// the Node daemon for the same tree.
    static func codexRolloutCandidates(
        sessionsDir: URL,
        maxDays: Int = 3,
        maxFiles: Int = 6
    ) -> [(url: URL, mtime: TimeInterval)] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: sessionsDir.path) else { return [] }

        func sortedSubdirs(_ dir: URL) -> [URL] {
            guard let entries = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey]) else { return [] }
            return entries
                .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
                .sorted { $0.lastPathComponent.compare($1.lastPathComponent, options: .numeric) == .orderedDescending }
        }

        // Newest `maxDays` day-directories, walking back across month and year
        // boundaries when a level runs short (a session spanning midnight, or the
        // 1st of a month, keeps its rollout in the older dir).
        var dayDirs: [URL] = []
        outer: for year in sortedSubdirs(sessionsDir) {
            for month in sortedSubdirs(year) {
                for day in sortedSubdirs(month) {
                    dayDirs.append(day)
                    if dayDirs.count >= maxDays { break outer }
                }
            }
        }

        var files: [(url: URL, mtime: TimeInterval)] = []
        for dayDir in dayDirs {
            guard let entries = try? fm.contentsOfDirectory(at: dayDir, includingPropertiesForKeys: [.contentModificationDateKey]) else { continue }
            for file in entries where file.lastPathComponent.hasPrefix("rollout-") && file.pathExtension == "jsonl" {
                let mtime = (try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSince1970 ?? 0
                files.append((file, mtime))
            }
        }
        files.sort { $0.mtime > $1.mtime }
        return Array(files.prefix(maxFiles))
    }

    /// Read the trailing bytes of a rollout (these grow to many MB; the newest
    /// rate_limits line is near the end).
    static func readCodexRolloutTail(_ file: URL, maxBytes: Int = 262144) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(maxBytes) ? size - UInt64(maxBytes) : 0
        try? handle.seek(toOffset: start)
        guard let data = try? handle.readToEnd() else { return nil }
        return Self.decodeRolloutTail(data, seekedPastStart: start > 0)
    }

    /// Rollout tails are JSONL read from an arbitrary byte offset; see
    /// `TailDecoder` for why a strict decode silently loses the whole window.
    static func decodeRolloutTail(_ data: Data, seekedPastStart: Bool) -> String? {
        TailDecoder.decode(data, seekedPastStart: seekedPastStart)
    }

    /// Parse the newest token_count `rate_limits` snapshot out of rollout text.
    static func parseCodexRateLimits(_ text: String) -> CodexRateLimitsLocal? {
        for line in text.split(separator: "\n").reversed() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.contains("rate_limits"), let data = trimmed.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let payload = obj["payload"] as? [String: Any],
                  let rl = payload["rate_limits"] as? [String: Any] else { continue }
            let primary = parseCodexWindow(rl["primary"] as? [String: Any])
            let secondary = parseCodexWindow(rl["secondary"] as? [String: Any])
            let limitId = rl["limit_id"] as? String
            let credits = parseCodexCredits(rl["credits"] as? [String: Any])
            // Skip only when nothing is usable. Credit-based plans (limitId
            // "premium") carry null windows + a credits block and must be kept so
            // the daemon can map them onto a synthetic gauge downstream.
            if primary == nil && secondary == nil && limitId == nil && credits == nil { continue }
            return CodexRateLimitsLocal(
                primary: primary,
                secondary: secondary,
                planType: rl["plan_type"] as? String,
                limitId: limitId,
                credits: credits,
                // Prefer the LINE's own timestamp over the file mtime: a rollout
                // keeps growing with lines carrying no `rate_limits` (reasoning,
                // tool output), so mtime drifts forward while the newest usage
                // reading stays put — under-reporting the age of exactly the
                // frozen snapshot this anchor exists to expose.
                capturedAt: normalizeCodexCaptureTimestamp(obj["timestamp"] as? String)
            )
        }
        return nil
    }

    /// ISO-8601 (fractional, UTC) string for a `capturedAt` stamp.
    static func codexCaptureISOString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(identifier: "UTC")
        return formatter.string(from: date)
    }

    /// Normalize a rollout line's `timestamp` to ISO-8601, or nil when the line
    /// carries none / an unparseable one (older rollout formats). Mirrors
    /// `parseRolloutTimestamp` in bridge/src/codex-rate-limits.ts.
    static func normalizeCodexCaptureTimestamp(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return codexCaptureISOString(date) }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        if let date = plain.date(from: raw) { return codexCaptureISOString(date) }
        return nil
    }

    private static func parseCodexCredits(_ raw: [String: Any]?) -> CodexCreditsLocal? {
        guard let raw else { return nil }
        guard raw["has_credits"] != nil || raw["unlimited"] != nil || raw["balance"] != nil else { return nil }
        let hasCredits = boolValue(raw, "has_credits") ?? false
        let unlimited = boolValue(raw, "unlimited") ?? false
        let balance: String? = {
            if let s = raw["balance"] as? String { return s }
            if let n = raw["balance"] as? NSNumber { return n.stringValue }
            return nil
        }()
        return CodexCreditsLocal(hasCredits: hasCredits, unlimited: unlimited, balance: balance)
    }

    private static func boolValue(_ raw: [String: Any], _ key: String) -> Bool? {
        if let b = raw[key] as? Bool { return b }
        if let n = raw[key] as? NSNumber { return n.boolValue }
        return nil
    }

    private static func parseCodexWindow(_ raw: [String: Any]?) -> CodexRateLimitWindowLocal? {
        guard let raw,
              let used = (raw["used_percent"] as? NSNumber)?.doubleValue,
              let window = (raw["window_minutes"] as? NSNumber)?.intValue else { return nil }
        var resetsAt: String?
        if let epoch = (raw["resets_at"] as? NSNumber)?.doubleValue, epoch > 0 {
            resetsAt = ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: epoch))
        }
        return CodexRateLimitWindowLocal(
            usedPercent: min(100, max(0, used)),
            windowMinutes: window,
            resetsAt: resetsAt
        )
    }

    // MARK: - Antigravity Local Status

    private func readAntigravityStatus() -> AntigravityStatus? {
        AppPreferences.shared.withAntigravityDatabaseAccess { dbURL in
            guard FileManager.default.fileExists(atPath: dbURL.path) else { return nil }

            let authStatusText = sqliteValue(forKey: "antigravityAuthStatus", dbURL: dbURL)
            guard let planName = parseAntigravityPlanName(authStatusText) else { return nil }
            let subscriptionActiveUntil = parseAntigravitySubscriptionActiveUntil(authStatusText)

            let creditsText = sqliteValue(forKey: "antigravityUnifiedStateSync.modelCredits", dbURL: dbURL)
            let credits = parseAntigravityModelCredits(creditsText)

            return AntigravityStatus(
                planName: planName,
                availableCredits: credits.available,
                minimumCreditAmountForUsage: credits.minimum,
                subscriptionActiveUntil: subscriptionActiveUntil
            )
        }
    }

    private func parseAntigravitySubscriptionActiveUntil(_ authStatusText: String?) -> String? {
        guard let authStatusText,
              let data = authStatusText.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        if let until = json["subscriptionActiveUntil"] as? String { return until }
        if let expires = json["expiresAt"] as? String { return expires }
        if let expiresNum = json["expiresAt"] as? Double { return String(expiresNum) }
        if let expiration = json["expirationTime"] as? String { return expiration }
        if let expirationNum = json["expirationTime"] as? Double { return String(expirationNum) }

        if let protoB64 = json["userStatusProtoBinaryBase64"] as? String,
           let proto = Data(base64Encoded: protoB64) {
            let ascii = extractASCIIStrings(from: proto)
            let datePattern = "^\\d{4}-\\d{2}-\\d{2}"
            if let regex = try? NSRegularExpression(pattern: datePattern) {
                for str in ascii {
                    let range = NSRange(location: 0, length: str.utf16.count)
                    if regex.firstMatch(in: str, options: [], range: range) != nil {
                        return str
                    }
                }
            }
        }
        return nil
    }

    private func sqliteValue(forKey key: String, dbURL: URL) -> String? {
        var db: OpaquePointer?
        guard sqlite3_open_v2(dbURL.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
            if let db { sqlite3_close(db) }
            return sqliteValueViaShell(forKey: key, dbURL: dbURL)
        }
        defer { sqlite3_close(db) }

        var stmt: OpaquePointer?
        let sql = "SELECT value FROM ItemTable WHERE key = ? LIMIT 1"
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
            if let stmt { sqlite3_finalize(stmt) }
            return nil
        }
        defer { sqlite3_finalize(stmt) }

        let bindResult = key.withCString { cString in
            sqlite3_bind_text(stmt, 1, cString, -1, SQLITE_TRANSIENT)
        }
        guard bindResult == SQLITE_OK else {
            return sqliteValueViaShell(forKey: key, dbURL: dbURL)
        }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }

        if let blob = sqlite3_column_blob(stmt, 0) {
            let len = Int(sqlite3_column_bytes(stmt, 0))
            let data = Data(bytes: blob, count: len)
            return String(data: data, encoding: .utf8)
        }
        return nil
    }

    private func sqliteValueViaShell(forKey key: String, dbURL: URL) -> String? {
        // The sqlite3 C API path above handles 99% of queries. Spawning
        // `/usr/bin/sqlite3` is not allowed under Apple Review Guideline
        // 2.5.2, so the rare bind-failure case returns nil instead.
        _ = key; _ = dbURL
        return nil
    }

    private func parseAntigravityPlanName(_ authStatusText: String?) -> String? {
        guard let authStatusText,
              let data = authStatusText.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let protoB64 = json["userStatusProtoBinaryBase64"] as? String,
              let proto = Data(base64Encoded: protoB64)
        else {
            return nil
        }

        let ascii = extractASCIIStrings(from: proto)
        let preferred = [
            "Google AI Ultra",
            "Google AI Pro",
            "Google AI Standard",
            "Google AI Free",
        ]
        for match in preferred where ascii.contains(match) {
            return match
        }
        return ascii.first(where: { $0.hasPrefix("Google AI ") })
    }

    private struct ProtoField {
        let field: Int
        let wire: Int
        let varint: UInt64?
        let bytes: Data?
    }

    private func readVarint(_ buf: Data, at offset: Int) -> (value: UInt64, next: Int)? {
        var result: UInt64 = 0
        var shift: UInt64 = 0
        var index = offset
        while index < buf.count {
            let byte = buf[index]
            index += 1
            result |= UInt64(byte & 0x7f) << shift
            if (byte & 0x80) == 0 { return (result, index) }
            shift += 7
            if shift > 63 { return nil }
        }
        return nil
    }

    private func parseProto(_ buf: Data) -> [ProtoField] {
        var out: [ProtoField] = []
        var index = 0
        while index < buf.count {
            guard let key = readVarint(buf, at: index) else { break }
            index = key.next
            let field = Int(key.value >> 3)
            let wire = Int(key.value & 0x07)
            if wire == 0 {
                guard let value = readVarint(buf, at: index) else { break }
                out.append(ProtoField(field: field, wire: wire, varint: value.value, bytes: nil))
                index = value.next
            } else if wire == 2 {
                guard let length = readVarint(buf, at: index) else { break }
                index = length.next
                let end = index + Int(length.value)
                guard end <= buf.count else { break }
                out.append(ProtoField(field: field, wire: wire, varint: nil, bytes: buf.subdata(in: index..<end)))
                index = end
            } else {
                break
            }
        }
        return out
    }

    private func protoFirstString(_ fields: [ProtoField], field: Int) -> String? {
        guard let hit = fields.first(where: { $0.field == field && $0.wire == 2 }),
              let bytes = hit.bytes else { return nil }
        return String(data: bytes, encoding: .utf8)
    }

    private func protoFirstBytes(_ fields: [ProtoField], field: Int) -> Data? {
        fields.first(where: { $0.field == field && $0.wire == 2 })?.bytes
    }

    private func protoFirstVarint(_ fields: [ProtoField], field: Int) -> UInt64? {
        fields.first(where: { $0.field == field && $0.wire == 0 })?.varint
    }

    /// Mirrors `bridge/src/antigravity-local.ts:parseModelCredits`. The DB
    /// value at `antigravityUnifiedStateSync.modelCredits` is a base64-wrapped
    /// protobuf map; each entry's value is itself a base64 protobuf wrapping
    /// the actual integer in field 1 (with field 2 as a fallback).
    private func parseAntigravityModelCredits(_ text: String?) -> (available: Int?, minimum: Int?) {
        guard let text,
              let outer = Data(base64Encoded: text) else {
            return (nil, nil)
        }
        var available: Int?
        var minimum: Int?
        for entry in parseProto(outer) where entry.field == 1 && entry.wire == 2 {
            guard let entryBytes = entry.bytes else { continue }
            let pair = parseProto(entryBytes)
            guard let key = protoFirstString(pair, field: 1),
                  let wrapped = protoFirstBytes(pair, field: 2) else { continue }
            guard let wrappedB64 = protoFirstString(parseProto(wrapped), field: 1),
                  let inner = Data(base64Encoded: wrappedB64) else { continue }
            let innerFields = parseProto(inner)
            guard let raw = protoFirstVarint(innerFields, field: 1)
                ?? protoFirstVarint(innerFields, field: 2) else { continue }
            let value = Int(raw)
            if key == "availableCreditsSentinelKey" { available = value }
            if key == "minimumCreditAmountForUsageKey" { minimum = value }
        }
        return (available, minimum)
    }

    private func extractASCIIStrings(from data: Data, minimumLength: Int = 6) -> [String] {
        let bytes = [UInt8](data)
        var buffer: [UInt8] = []
        var strings: [String] = []

        func flush() {
            defer { buffer.removeAll(keepingCapacity: true) }
            guard buffer.count >= minimumLength,
                  let string = String(bytes: buffer, encoding: .utf8)?
                    .trimmingCharacters(in: .whitespacesAndNewlines),
                  !string.isEmpty else { return }
            strings.append(string)
        }

        for byte in bytes {
            if (32...126).contains(byte) {
                buffer.append(byte)
            } else {
                flush()
            }
        }
        flush()
        return strings
    }

    // MARK: - File Cache

    private struct CacheFile: Codable {
        let data: CodableUsage
        let fetchedAt: Double

        struct CodableUsage: Codable {
            var fiveHourPercent: Double?
            var fiveHourResetsAt: String?
            var sevenDayPercent: Double?
            var sevenDayResetsAt: String?
            var scopedLimits: [ScopedUsageLimit]? = nil
            var extraUsageEnabled: Bool?
            var extraUsageMonthlyLimit: Double?
            var extraUsageUsedCredits: Double?
            var extraUsageUtilization: Double?
        }
    }

    private func readFileCache() -> (data: ApiUsageData, fetchedAt: Double)? {
        guard let data = readCacheDataBounded(),
              let cache = try? JSONDecoder().decode(CacheFile.self, from: data) else { return nil }
        // Auto-detect ms vs s: Node.js bridge writes Date.now() (ms), Swift writes timeIntervalSince1970 (s)
        let fetchedAt = cache.fetchedAt > 1e12 ? cache.fetchedAt / 1000.0 : cache.fetchedAt
        let usage = ApiUsageData(
            fiveHourPercent: cache.data.fiveHourPercent,
            fiveHourResetsAt: cache.data.fiveHourResetsAt,
            sevenDayPercent: cache.data.sevenDayPercent,
            sevenDayResetsAt: cache.data.sevenDayResetsAt,
            scopedLimits: cache.data.scopedLimits ?? [],
            extraUsageEnabled: cache.data.extraUsageEnabled ?? false,
            extraUsageMonthlyLimit: cache.data.extraUsageMonthlyLimit,
            extraUsageUsedCredits: cache.data.extraUsageUsedCredits,
            extraUsageUtilization: cache.data.extraUsageUtilization,
            fetchedAt: fetchedAt,
            stale: false
        )
        return (usage, fetchedAt)
    }

    private func readCacheDataBounded() -> Data? {
        let box = UsageCacheDataBox()
        let semaphore = DispatchSemaphore(value: 0)
        Self.cacheIOQueue.async {
            box.set(try? Data(contentsOf: Self.cacheFile))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + Self.cacheReadTimeout) == .success else {
            DaemonLogger.shared.debug("UsageAPI", "File cache read timed out; skipping cache")
            return nil
        }
        return box.get()
    }

    private func writeFileCache(_ usage: ApiUsageData) {
        let cache = CacheFile(
            data: CacheFile.CodableUsage(
                fiveHourPercent: usage.fiveHourPercent,
                fiveHourResetsAt: usage.fiveHourResetsAt,
                sevenDayPercent: usage.sevenDayPercent,
                sevenDayResetsAt: usage.sevenDayResetsAt,
                scopedLimits: usage.scopedLimits,
                extraUsageEnabled: usage.extraUsageEnabled,
                extraUsageMonthlyLimit: usage.extraUsageMonthlyLimit,
                extraUsageUsedCredits: usage.extraUsageUsedCredits,
                extraUsageUtilization: usage.extraUsageUtilization
            ),
            fetchedAt: Date().timeIntervalSince1970
        )
        if let data = try? JSONEncoder().encode(cache) {
            Self.cacheIOQueue.async {
                try? data.write(to: Self.cacheFile)
            }
        }
    }

    // MARK: - Parse Response

    private func parseUsageResponse(_ json: [String: Any]) -> ApiUsageData {
        var usage = ApiUsageData()

        func getDouble(_ val: Any?) -> Double? {
            if let d = val as? Double { return d }
            if let i = val as? Int { return Double(i) }
            return nil
        }

        func getUtilization(_ obj: Any?) -> Double? {
            if let val = getDouble(obj) { return val }
            guard let dict = obj as? [String: Any] else { return nil }
            return getDouble(dict["utilization"]) ?? getDouble(dict["percentUsed"]) ?? getDouble(dict["percentage"]) ?? getDouble(dict["percent"]) ?? getDouble(dict["usage"])
        }

        func getResetsAt(_ obj: Any?) -> String? {
            guard let dict = obj as? [String: Any] else { return nil }
            return (dict["resets_at"] as? String) ?? (dict["resetsAt"] as? String) ?? (dict["reset_at"] as? String) ?? (dict["expires_at"] as? String)
        }

        // 1. Five Hour
        let fiveHour = json["five_hour"] ?? json["fiveHour"] ?? (json["rateLimits"] as? [String: Any])?["fiveHour"]
        usage.fiveHourPercent = getUtilization(fiveHour)
        usage.fiveHourResetsAt = getResetsAt(fiveHour)

        // 2. Seven Day
        let sevenDay = json["seven_day"] ?? json["sevenDay"] ?? (json["rateLimits"] as? [String: Any])?["sevenDay"]
        usage.sevenDayPercent = getUtilization(sevenDay)
        usage.sevenDayResetsAt = getResetsAt(sevenDay)

        // 3. Extra Usage
        let extra = json["extra_usage"] ?? json["extraUsage"]
        if let extraDict = extra as? [String: Any] {
            usage.extraUsageEnabled = (extraDict["is_enabled"] as? Bool) ?? (extraDict["enabled"] as? Bool) ?? false
            usage.extraUsageMonthlyLimit = getDouble(extraDict["monthly_limit"]) ?? getDouble(extraDict["monthlyLimit"])
            usage.extraUsageUsedCredits = getDouble(extraDict["used_credits"]) ?? getDouble(extraDict["usedCredits"])
            usage.extraUsageUtilization = getUtilization(extra)
        }

        // Per-model scoped limits are NOT parsed here: this Swift daemon never
        // acquires OAuth usage directly (`directOAuthUsageSupported == false`), and
        // puritysb's #99 guardrail keeps direct `limits[]` acquisition in the Node
        // daemon. Scoped caps reach this daemon only via the relay ingest
        // (DaemonServer.parseRelayedUsage) and the shared usage cache the Node
        // daemon writes — never by parsing a live OAuth response here.

        usage.inferredBillingType = usage.fiveHourPercent != nil ? "subscription" : "api"
        return usage
    }

    // MARK: - Backoff

    private func getBackoffSeconds() -> TimeInterval {
        guard consecutiveFailures > 0 else { return 0 }
        let intervals: [TimeInterval] = [45, 90, 180, 300]
        let backoff = intervals[min(consecutiveFailures - 1, intervals.count - 1)]
        let elapsed = Date().timeIntervalSince(lastBackoffStart)
        return max(0, backoff - elapsed)
    }
}
#endif
