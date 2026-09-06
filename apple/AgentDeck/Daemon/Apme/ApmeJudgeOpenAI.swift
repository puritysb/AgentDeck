#if os(macOS)
// ApmeJudgeOpenAI.swift — generic OpenAI-compatible judge adapter.
//
// Swift port of `callOpenAICompatible` in bridge/src/apme/runner.ts. One
// implementation covers the de-facto standard providers, all of which speak
// POST /v1/chat/completions:
//   - Ollama       endpoint http://127.0.0.1:11434/v1   (no key)
//   - LM Studio    endpoint http://127.0.0.1:1234/v1    (no key)
//   - vLLM / llama.cpp / LiteLLM / MLX  (local, no key)
//   - OpenRouter   endpoint https://openrouter.ai/api/v1 (Bearer apiKey)
//   - any other OpenAI-compatible endpoint
//
// App Store: pure network I/O (`com.apple.security.network.client`). No
// subprocess, no bundled interpreter — the endpoint is user-configured.

import Foundation

enum ApmeJudgeOpenAI {
    static var judgeModelLabel: String { "openai:\(LastResolvedModel.get() ?? "default")" }

    private enum LastResolvedModel {
        nonisolated(unsafe) private static var value: String?
        private static let lock = NSLock()
        static func get() -> String? { lock.lock(); defer { lock.unlock() }; return value }
        static func set(_ v: String) { lock.lock(); defer { lock.unlock() }; value = v }
    }

    enum JudgeError: Error, CustomStringConvertible {
        case noEndpoint
        case http(Int)
        case empty
        case outputLimit
        case transport(String)
        var description: String {
            switch self {
            case .noEndpoint: return "no endpoint configured (set apme.judge.endpoint)"
            case .http(let c): return "server returned HTTP \(c)"
            case .outputLimit: return "the judge reached its output limit before completion"
            case .empty: return "the judge returned an empty response"
            case .transport(let m): return m
            }
        }
    }

    /// Normalize a user endpoint (bare host / base+/v1 / full URL) to the
    /// chat-completions URL. Mirrors openAIChatUrl in the Node runner.
    static func chatURL(_ endpoint: String) -> String {
        var e = endpoint.trimmingCharacters(in: .whitespaces)
        while e.hasSuffix("/") { e.removeLast() }
        if e.hasSuffix("/chat/completions") { return e }
        if e.hasSuffix("/v1") { return e + "/chat/completions" }
        return e + "/v1/chat/completions"
    }

    static func base(_ endpoint: String) -> String {
        var e = endpoint.trimmingCharacters(in: .whitespaces)
        while e.hasSuffix("/") { e.removeLast() }
        e = e.replacingOccurrences(of: "/chat/completions", with: "")
        if e.hasSuffix("/v1") { e.removeLast(3) }
        return e
    }

    /// Resolve a model id when the user left it unset. Ollama → /api/tags,
    /// everything else → /v1/models.
    static func resolveModel(base: String, apiKey: String?, configured: String) async -> String {
        if !configured.isEmpty && configured != "default" && configured != "qwen3-30b" { return configured }
        func authed(_ url: URL) -> URLRequest {
            var r = URLRequest(url: url); r.timeoutInterval = 3
            if let k = apiKey, !k.isEmpty { r.setValue("Bearer \(k)", forHTTPHeaderField: "Authorization") }
            return r
        }
        if let url = URL(string: base + "/api/tags"),
           let (data, resp) = try? await URLSession.shared.data(for: authed(url)),
           (resp as? HTTPURLResponse)?.statusCode == 200,
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let models = json["models"] as? [[String: Any]],
           let name = models.compactMap({ $0["name"] as? String }).first {
            return name
        }
        for path in ["/v1/models", "/models"] {
            guard let url = URL(string: base + path),
                  let (data, resp) = try? await URLSession.shared.data(for: authed(url)),
                  (resp as? HTTPURLResponse)?.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let models = json["data"] as? [[String: Any]] else { continue }
            for m in models {
                if let id = m["id"] as? String, !id.lowercased().contains("nanollava") { return id }
            }
        }
        return configured.isEmpty ? "default" : configured
    }

    /// Best-effort variant for the automatic pipeline — nil on any failure.
    static func judge(prompt: String, config: ApmeJudgeConfig) async -> String? {
        return try? await judgeThrowing(prompt: prompt, config: config)
    }

    /// Throwing variant for the on-demand REVIEW path (surfaces the real error).
    static func judgeThrowing(prompt: String, config: ApmeJudgeConfig) async throws -> String {
        guard let endpoint = config.endpoint, !endpoint.isEmpty else { throw JudgeError.noEndpoint }
        let b = base(endpoint)
        let model = await resolveModel(base: b, apiKey: config.apiKey, configured: config.model)
        LastResolvedModel.set(model)
        guard let url = URL(string: chatURL(endpoint)) else { throw JudgeError.noEndpoint }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let k = config.apiKey, !k.isEmpty { request.setValue("Bearer \(k)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 90
        var body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": "You are an exacting code evaluator. Reply with strict JSON only."],
                ["role": "user", "content": prompt],
            ],
            "temperature": 0,
            "max_tokens": 1024,
        ]
        // `apme.judge.reasoningEffort` was Node-only: both daemons read the
        // same settings.json and call the same user-configured endpoint, so a
        // user who set `none` to stop a local model emitting thinking tokens
        // got it obeyed on one daemon and ignored on the other — and the
        // ignored request then spent the 1,024-token cap on thinking and came
        // back `finish_reason: "length"`.
        if let effort = config.reasoningEffort, !effort.isEmpty {
            body["reasoning_effort"] = effort
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard code == 200 else { throw JudgeError.http(code) }
            return try ApmeJudgeChatResponse.content(data)
        } catch let e as JudgeError {
            throw e
        } catch {
            throw JudgeError.transport(String(describing: error))
        }
    }
}
/// Shared MLX/OpenAI response gate: `choices` must be a non-empty ARRAY, the
/// content a non-empty string, and a body the server says it cut must still
/// hold a JSON object that closed. Mirrors `judgeChatContent` in
/// bridge/src/apme/runner.ts; behavior is pinned in
/// shared/apme-judge-response-vectors.json, which both suites replay.
enum ApmeJudgeChatResponse {
    static func content(_ data: Data) throws -> String {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let first = choices.first
        else { throw ApmeJudgeOpenAI.JudgeError.empty }
        guard let content = (first["message"] as? [String: Any])?["content"] as? String,
              !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { throw ApmeJudgeOpenAI.JudgeError.empty }
        // A cut response is not a verdict. See `judgeChatContent` in
        // bridge/src/apme/runner.ts for why the "unless its object closed"
        // exemption was tried and removed.
        if first["finish_reason"] as? String == "length" {
            throw ApmeJudgeOpenAI.JudgeError.outputLimit
        }
        return content
    }
}
#endif
