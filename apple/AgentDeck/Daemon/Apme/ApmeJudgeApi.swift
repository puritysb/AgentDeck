#if os(macOS)
// ApmeJudgeApi.swift — Anthropic API judge adapter (opt-in, paid).
//
// Per feedback_cost_sensitive_defaults memory: API calls are NEVER the
// default. The user must explicitly pick "api" in Settings AND have a key
// available. Both conditions fail → return nil → caller skips the eval.
//
// Key lookup order:
//   1. `ANTHROPIC_API_KEY` environment variable
//   2. AgentDeck settings.json — resolved via `AgentDeckPaths.settingsJson`
//      so App Store builds read from the sandbox data container and CLI/dev
//      builds read from `~/.agentdeck/settings.json`. Same file
//      format either way; the Node bridge writes to its own `~/.agentdeck/`
//      path so a user running both stacks needs to either stick with one or
//      keep both keys in sync.
//
// No Keychain — Keychain access for the shared settings.json key would
// require `keychain-access-groups` coordination with a future helper.
// settings.json via the sandbox data container is good enough and avoids the
// permission prompt.
//
// Sandbox: api.anthropic.com is reached via `com.apple.security.network.client`
// which is already granted. No ATS exception needed (HTTPS).

import Foundation

enum ApmeJudgeApi {
    /// Default when the configured `model` belongs to another backend (e.g. an
    /// MLX id left over from a backend switch). Mirrored by
    /// `API_JUDGE_DEFAULT_MODEL` in bridge/src/apme/runner.ts: both daemons
    /// read the same settings.json and are the same judge, so a user who opted
    /// into this leg without naming a model must not get a different model
    /// depending on which daemon holds the port (this said `claude-opus-4-6`,
    /// Node said `claude-opus-4-8`, until #286).
    static let defaultModel = "claude-opus-5"

    /// Which model this leg will actually call.
    ///
    /// Mirrors Node's `apiJudgeModel` — a configured id that is not an
    /// Anthropic model is not forwarded, because there is no
    /// `resetBackendCoupledFields` on this side to wipe a leftover MLX id on a
    /// backend switch, and POSTing `gemma-3-27b` to api.anthropic.com returns a
    /// 400 that this leg reports as `nil`, byte-identical to "no API key found".
    ///
    /// …but ONLY against api.anthropic.com. Unlike Node, this daemon honours
    /// `config.endpoint`, so the leg may be pointed at an Anthropic-compatible
    /// gateway whose model ids legitimately are not `claude…` prefixed
    /// (`anthropic.claude-…-v1:0` and friends). Substituting there would spend
    /// the user's money on a model they did not name, against this file's own
    /// cost-sensitive rule that API failures stay failures. A custom endpoint
    /// forwards verbatim; the resolved model is logged either way so a 400 is
    /// diagnosable instead of silent.
    static func resolveModel(_ configured: String, endpoint: String? = nil) -> String {
        // The placeholder is not a model on ANY endpoint. `ApmeJudgeConfig.model`
        // defaults to the literal "default", so scoping this to
        // api.anthropic.com made a user with a gateway and no `model` POST
        // `"model": "default"` — a 400 this leg reports as `nil`, byte-identical
        // to "no API key found".
        if configured.isEmpty || configured == "default" { return defaultModel }
        // Only the pass-through of a real, non-Anthropic id is endpoint-scoped.
        if let endpoint, !endpoint.isEmpty, endpoint != defaultEndpoint { return configured }
        return configured.hasPrefix("claude") ? configured : defaultModel
    }

    /// Resolve the model for a real request AND record it, so `judgeModelLabel`
    /// names what ran. `judge()` goes through this and nothing else, which is
    /// what makes the label testable without a network call.
    static func resolvedModelForRequest(_ config: ApmeJudgeConfig) -> String {
        let model = resolveModel(config.model, endpoint: config.endpoint)
        LastResolvedModel.set(model)
        return model
    }

    static let defaultEndpoint = "https://api.anthropic.com/v1/messages"

    /// Provenance stamped onto stored eval rows — it must name the model that
    /// RAN, not the one the code was written against. Held like the MLX and
    /// OpenAI legs' labels rather than hardcoded: a constant went on claiming
    /// `claude-opus-4-6` after the default moved, which is the same
    /// cross-daemon attribution error #286 set out to remove.
    static var judgeModelLabel: String { "api:\(LastResolvedModel.get() ?? defaultModel)" }

    private enum LastResolvedModel {
        nonisolated(unsafe) private static var value: String?
        private static let lock = NSLock()
        static func get() -> String? { lock.lock(); defer { lock.unlock() }; return value }
        static func set(_ v: String) { lock.lock(); defer { lock.unlock() }; value = v }
    }

    /// Run the Anthropic API judge. Returns nil if:
    ///   - No API key available
    ///   - Network failure
    ///   - Non-200 response (caller sees nil and skips)
    ///
    /// Does NOT silently fall back to another backend — cost-sensitive
    /// defaults memory says API failures stay failures so the user sees
    /// the cost they opted into (zero calls on failure).
    static func judge(prompt: String, config: ApmeJudgeConfig) async -> String? {
        guard let apiKey = loadApiKey() else {
            // Log once-ish for diagnostics but don't spam — tasks run every 30s.
            DaemonLogger.shared.debug("APME", "API judge selected but no key found in env or settings.json")
            return nil
        }

        let model = resolvedModelForRequest(config)
        let endpoint = config.endpoint ?? defaultEndpoint
        guard let url = URL(string: endpoint) else { return nil }
        DaemonLogger.shared.debug("APME", "API judge → \(model) at \(endpoint)")

        // `max_tokens` mirrors `API_JUDGE_MAX_TOKENS` in runner.ts. It was
        // 1,024 here against Node's 8,192, so the same task judged on the same
        // settings was cut 8x earlier on this daemon and both bodies were
        // accepted as verdicts. It is a ceiling, not a charge — only tokens
        // actually produced are billed.
        //
        // No `temperature`: sampling parameters are rejected outright on
        // Opus 4.7 and later, so sending one made this leg fail with a 400 for
        // every current model — the failure then read as `nil`, i.e. the same
        // shape as "no API key".
        let body: [String: Any] = [
            "model": model,
            "max_tokens": 8192,
            "system": "You are an exacting code evaluator. Reply with strict JSON only.",
            "messages": [
                ["role": "user", "content": prompt],
            ],
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2023-06-01", forHTTPHeaderField: "anthropic-version")
        request.httpBody = bodyData
        request.timeoutInterval = 60

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            if http.statusCode != 200 {
                DaemonLogger.shared.debug("APME", "API judge HTTP \(http.statusCode)")
                return nil
            }
            guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return nil }
            do { return try content(json) } catch {
                DaemonLogger.shared.debug("APME", "API judge: \(error)")
                return nil
            }
        } catch {
            DaemonLogger.shared.debug("APME", "API judge network error: \(error.localizedDescription)")
            return nil
        }
    }

    enum ApiJudgeError: Error, CustomStringConvertible {
        case empty
        case refused
        case outputLimit
        var description: String {
            switch self {
            case .empty: return "the judge returned no text"
            case .refused: return "the judge refused the request (stop_reason=refusal)"
            case .outputLimit: return "the judge reached its output limit before completion (stop_reason=max_tokens)"
            }
        }
    }

    /// The Anthropic-shaped counterpart of `ApmeJudgeChatResponse.content`, and
    /// the same rule under Anthropic's spelling: a refusal is not a verdict,
    /// and a body cut at `max_tokens` is one only when its JSON object closed.
    /// The text blocks are joined first because the object can close in one
    /// block and the cut land in the next. Response shape:
    /// `{ content: [ { type: "text", text: "…" } ], stop_reason: "…" }`.
    /// Behavior is pinned by shared/apme-judge-api-response-vectors.json,
    /// which both suites replay — mirrors `apiJudgeText` in
    /// bridge/src/apme/runner.ts.
    static func content(_ json: [String: Any]) throws -> String {
        let blocks = json["content"] as? [[String: Any]] ?? []
        var combined = ""
        for block in blocks {
            if let type = block["type"] as? String, type == "text",
               let text = block["text"] as? String {
                if !combined.isEmpty { combined += "\n" }
                combined += text
            }
        }
        let stopReason = json["stop_reason"] as? String
        if stopReason == "refusal" { throw ApiJudgeError.refused }
        if stopReason == "max_tokens", !ApmeRunner.holdsCompleteJsonObject(combined) {
            throw ApiJudgeError.outputLimit
        }
        if combined.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { throw ApiJudgeError.empty }
        return combined
    }

    /// Whether an API key is currently available. Used by the Settings
    /// Picker to gate the "api" option with a helpful subtitle.
    static var isConfigured: Bool { loadApiKey() != nil }

    /// Priority: env var, then settings.json apme.judge.apiKey.
    private static func loadApiKey() -> String? {
        if let env = ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"],
           !env.isEmpty {
            return env
        }
        let path = AuthManager.agentDeckDir.appendingPathComponent("settings.json").path
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let apme = json["apme"] as? [String: Any],
              let judge = apme["judge"] as? [String: Any],
              let key = judge["apiKey"] as? String,
              !key.isEmpty
        else { return nil }
        return key
    }
}
#endif
