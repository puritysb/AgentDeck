#if os(macOS)
// ApmeJudgeMlx.swift — Local MLX server judge adapter.
//
// Swift port of `callMlx` in bridge/src/apme/runner.ts. MLX is the
// user-run local inference server (default: http://127.0.0.1:8800)
// using the OpenAI chat-completions API surface. Zero marginal cost —
// the user has already paid in GPU watts.
//
// Backend selection priority (user sets via Settings Picker):
//   1. foundationModels — Apple Intelligence, on-device, network-free
//   2. mlx — this adapter, requires user to run mlx-lm or mlx-vlm server
//   3. api — Anthropic API, requires key, paid
//
// Sandbox: `com.apple.security.network.client` covers 127.0.0.1 access.
// No additional entitlements needed.

import Foundation

enum ApmeJudgeMlx {
    /// Judge model label for the `evals.judge_model` column. Resolved
    /// lazily because the auto-detect might rename "default" to a real
    /// model id the user loaded.
    static var judgeModelLabel: String { "mlx:\(LastResolvedModel.get() ?? "default")" }

    /// Thread-safe storage for the most recently resolved model id.
    /// Swift 6 strict concurrency disallows non-isolated mutable globals,
    /// so we wrap the single string in an NSLock-backed box.
    private enum LastResolvedModel {
        nonisolated(unsafe) private static var value: String?
        private static let lock = NSLock()
        static func get() -> String? {
            lock.lock(); defer { lock.unlock() }
            return value
        }
        static func set(_ v: String) {
            lock.lock(); defer { lock.unlock() }
            value = v
        }
    }

    /// Run the judge via MLX HTTP endpoint. Returns nil on any failure —
    /// caller (ApmeRunner) treats nil as "skip this eval" and doesn't retry.
    static func judge(prompt: String, config: ApmeJudgeConfig) async -> String? {
        let endpoint = config.endpoint ?? "http://127.0.0.1:8800/chat/completions"
        guard let url = URL(string: endpoint) else { return nil }

        // Auto-detect model if not explicitly configured. Matches TS runner.ts:
        // query /v1/models then /models, pick first non-nanollava entry.
        let model = await resolveModel(config: config, endpoint: endpoint)
        LastResolvedModel.set(model)

        let body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": "You are an exacting code evaluator. Reply with strict JSON only."],
                ["role": "user", "content": prompt],
            ],
            "temperature": 0.0,
            "max_tokens": 800,
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return nil }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = bodyData
        request.timeoutInterval = 60

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return nil
            }
            return try ApmeJudgeChatResponse.content(data)
        } catch {
            return nil
        }
    }

    /// Query the MLX server's models endpoint. Falls back to the user's
    /// configured model id if auto-detect fails. Skips "nanollava" variants
    /// which some users keep loaded for vision tasks but aren't good judges.
    private static func resolveModel(config: ApmeJudgeConfig, endpoint: String) async -> String {
        // Priority: llm.mlx pin (shared across summarizers/judge) > apme.judge.model
        // > auto-detect from /v1/models > apme.judge.model fallback.
        if let pin = ApmeSettings.loadMlxConfig().model {
            return pin
        }
        // Only auto-detect when the user hasn't specified a real model.
        // The TS port uses "qwen3-30b" as the placeholder default; we match that.
        if config.model != "default" && config.model != "qwen3-30b" {
            return config.model
        }

        // Derive the base URL from the chat-completions endpoint.
        let base = endpoint
            .replacingOccurrences(of: "/v1/chat/completions", with: "")
            .replacingOccurrences(of: "/chat/completions", with: "")

        for path in ["/v1/models", "/models"] {
            guard let url = URL(string: base + path) else { continue }
            var req = URLRequest(url: url)
            req.timeoutInterval = 3
            guard let (data, response) = try? await URLSession.shared.data(for: req),
                  let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let models = json["data"] as? [[String: Any]]
            else { continue }
            for m in models {
                if let id = m["id"] as? String,
                   !id.lowercased().contains("nanollava") {
                    return id
                }
            }
        }
        return config.model
    }

    /// Quick probe — true when the MLX server is reachable.
    /// Used by the Settings Picker to show "MLX ready" vs "MLX offline".
    static func isReachable() async -> Bool {
        let config = ApmeSettings.load()
        let endpoint = config.judge.endpoint ?? "http://127.0.0.1:8800/chat/completions"
        let base = endpoint
            .replacingOccurrences(of: "/v1/chat/completions", with: "")
            .replacingOccurrences(of: "/chat/completions", with: "")
        guard let url = URL(string: base + "/v1/models") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 2
        guard let (_, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse
        else { return false }
        return http.statusCode == 200
    }
}
#endif
