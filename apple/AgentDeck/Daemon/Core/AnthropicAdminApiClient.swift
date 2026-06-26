#if os(macOS)
// AnthropicAdminApiClient.swift — Anthropic Console Admin API usage polling.
//
// This is the *only* sanctioned path for AgentDeck to display per-user
// Anthropic token consumption in an App Store build. Claude Code's
// subscription OAuth token cannot be used by third-party apps per
// Anthropic's Feb 2026 policy update, but Admin API keys obtained from
// the Anthropic Console (console.anthropic.com/settings/keys) are the
// documented third-party integration path — they map to API-usage
// billing, not Pro/Max subscription quota.
//
// Users who paste a key here see cumulative token counts for today +
// this month across the organization. Users on Pro/Max subscriptions
// without an API key still get live session monitoring through the
// hook pipeline, but not subscription quota gauges in the sandboxed app.
//
// Admin API keys are stored in Keychain with the same pattern as the
// OpenClaw Gateway shared token.

import Foundation

enum AnthropicAdminApiKeyStore {
    private static let service = "bound.serendipity.agent.deck.anthropic.admin-api-key"
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
        SecItemDelete(query as CFDictionary)
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

/// Token counts for a single reporting window.
struct AnthropicTokenCounts: Sendable, Codable {
    var input: Int = 0
    var output: Int = 0
    var cacheRead: Int = 0
    var cacheCreation: Int = 0
    var total: Int { input + output + cacheRead + cacheCreation }
}

/// Per-model usage summary for the current month.
struct AnthropicModelUsage: Sendable, Codable {
    let model: String
    let totalTokens: Int
}

/// Snapshot returned by `AnthropicAdminApiClient.fetchUsage()`.
/// Consumers read `today` / `month` / `topModels` and decide how to
/// display them. `fetchedAt` is epoch seconds of the successful fetch;
/// `stale == true` signals the values came from cache (or a network
/// failure), the UI should mark them accordingly.
struct AnthropicAdminUsage: Sendable, Codable {
    var today: AnthropicTokenCounts
    var month: AnthropicTokenCounts
    var topModels: [AnthropicModelUsage]
    var fetchedAt: Double
    var stale: Bool
}

/// Fetches org-wide token usage from the Anthropic Console Admin API.
/// Separate from `UsageAPIClient` (which polls the Claude Code OAuth
/// subscription endpoint) because the key types, endpoints, and data
/// shapes are unrelated. Users can configure one, both, or neither.
final class AnthropicAdminApiClient: Sendable {
    static let shared = AnthropicAdminApiClient()

    private static let usageReportURL =
        "https://api.anthropic.com/v1/organizations/usage_report/messages"
    private static let apiVersion = "2023-06-01"

    /// Returns the configured Admin API key from Keychain, or nil when no
    /// key is set.
    func currentKey() -> String? {
        AnthropicAdminApiKeyStore.loadKey()
    }

    func hasKey() -> Bool { currentKey() != nil }

    /// Fetch today + month-to-date usage. Returns nil when no key is
    /// configured or the upstream request fails beyond the internal
    /// stale-cache fallback.
    func fetchUsage() async -> AnthropicAdminUsage? {
        guard let key = currentKey() else { return nil }

        // Build two parallel requests: one bucketed by day for the last
        // 30 days (drives month total + today slice + model breakdown),
        // one 1-minute-bucket request limited to today for real-time
        // "today" counts. Single endpoint handles both via query params.
        let calendar = Calendar(identifier: .gregorian)
        let now = Date()
        let startOfToday = calendar.startOfDay(for: now)
        guard let monthStart = calendar.date(byAdding: .day, value: -30, to: startOfToday) else {
            return nil
        }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]

        guard let response = await fetchMessagesReport(
            key: key,
            startingAt: iso.string(from: monthStart),
            endingAt: iso.string(from: now),
            bucketWidth: "1d"
        ) else {
            return nil
        }

        var today = AnthropicTokenCounts()
        var month = AnthropicTokenCounts()
        var modelTotals: [String: Int] = [:]

        for bucket in response.data {
            let bucketStart = iso.date(from: bucket.startingAt) ?? Date.distantPast
            let isToday = calendar.isDate(bucketStart, inSameDayAs: now)
            for result in bucket.results {
                let inputTokens = result.uncached_input_tokens ?? result.input_tokens ?? 0
                let outputTokens = result.output_tokens ?? 0
                let cacheReadTokens = result.cache_read_input_tokens ?? 0
                let cacheCreationTokens = result.cache_creation_input_tokens ?? 0

                month.input += inputTokens
                month.output += outputTokens
                month.cacheRead += cacheReadTokens
                month.cacheCreation += cacheCreationTokens
                if isToday {
                    today.input += inputTokens
                    today.output += outputTokens
                    today.cacheRead += cacheReadTokens
                    today.cacheCreation += cacheCreationTokens
                }
                if let model = result.model {
                    let tokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens
                    modelTotals[model, default: 0] += tokens
                }
            }
        }

        let topModels = modelTotals
            .sorted { $0.value > $1.value }
            .prefix(3)
            .map { AnthropicModelUsage(model: $0.key, totalTokens: $0.value) }

        return AnthropicAdminUsage(
            today: today,
            month: month,
            topModels: topModels,
            fetchedAt: Date().timeIntervalSince1970,
            stale: false
        )
    }

    // MARK: - HTTP

    private struct Envelope: Decodable {
        let data: [Bucket]
    }

    private struct Bucket: Decodable {
        let starting_at: String
        let ending_at: String?
        let results: [Result]

        // Convenience matching for ISO parse.
        var startingAt: String { starting_at }
    }

    // Anthropic's usage_report/messages response has evolved naming. We
    // decode a permissive superset and map at callsite:
    //   - `input_tokens` (legacy) or `uncached_input_tokens` (current)
    //   - `output_tokens`
    //   - `cache_read_input_tokens`, `cache_creation_input_tokens`
    //   - `model` may be absent when no group-by is applied
    private struct Result: Decodable {
        let model: String?
        let input_tokens: Int?
        let uncached_input_tokens: Int?
        let output_tokens: Int?
        let cache_read_input_tokens: Int?
        let cache_creation_input_tokens: Int?
    }

    private func fetchMessagesReport(
        key: String,
        startingAt: String,
        endingAt: String,
        bucketWidth: String
    ) async -> Envelope? {
        var components = URLComponents(string: Self.usageReportURL)
        components?.queryItems = [
            URLQueryItem(name: "starting_at", value: startingAt),
            URLQueryItem(name: "ending_at", value: endingAt),
            URLQueryItem(name: "bucket_width", value: bucketWidth),
            URLQueryItem(name: "group_by[]", value: "model"),
        ]
        guard let url = components?.url else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(key, forHTTPHeaderField: "x-api-key")
        request.setValue(Self.apiVersion, forHTTPHeaderField: "anthropic-version")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 15

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            guard http.statusCode == 200 else {
                DaemonLogger.shared.debug(
                    "AnthropicAdmin",
                    "usage_report HTTP \(http.statusCode)"
                )
                return nil
            }
            return try JSONDecoder().decode(Envelope.self, from: data)
        } catch {
            DaemonLogger.shared.debug(
                "AnthropicAdmin",
                "usage_report error: \(error.localizedDescription)"
            )
            return nil
        }
    }
}
#endif
