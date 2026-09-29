#if os(macOS)
// ApmeJudgeDetect.swift — HTTP-only detection of local inference servers.
//
// Swift port of bridge/src/apme/judge-detect.ts. Probes the standard loopback
// ports so onboarding + the REVIEW judge-setup panel can offer "use what you
// already run" instead of asking the user to type an endpoint.
//
// App Store: loopback HTTP only (`com.apple.security.network.client`). NO
// subprocess, NO CLI probe (`ollama list`). Runs unchanged in the signed
// App Store daemon.

import Foundation

struct DetectedJudgeProvider: Sendable, Codable {
    let provider: String   // ollama | lmstudio | mlx
    let label: String
    let endpoint: String   // OpenAI-compatible base to store as apme.judge.endpoint
    let models: [String]
}

enum ApmeJudgeDetect {
    private struct Candidate {
        let provider: String
        let label: String
        let base: String
        let endpoint: String
        let tags: Bool
    }

    private static let candidates: [Candidate] = [
        .init(provider: "ollama", label: "Ollama", base: "http://127.0.0.1:11434", endpoint: "http://127.0.0.1:11434/v1", tags: true),
        .init(provider: "lmstudio", label: "LM Studio", base: "http://127.0.0.1:1234", endpoint: "http://127.0.0.1:1234/v1", tags: false),
        .init(provider: "mlx", label: "Local MLX server", base: "http://127.0.0.1:8800", endpoint: "http://127.0.0.1:8800/v1", tags: false),
        .init(provider: "mlx", label: "Local MLX server", base: "http://127.0.0.1:8080", endpoint: "http://127.0.0.1:8080/v1", tags: false),
    ]

    /// True when an Ollama catalog entry can answer a chat completion.
    ///
    /// Mirror of `ollamaChatCapable` in bridge/src/apme/judge-detect.ts.
    /// Ollama tags carry `capabilities` (`["completion", …]` for chat models,
    /// `["embedding"]` for embedders such as `bge-m3`); offering an embedder as
    /// a judge candidate only fails once the user has already picked it.
    /// A missing field is "no information", not "unusable" — older Ollama
    /// builds omit it entirely.
    private static func ollamaChatCapable(_ entry: [String: Any]) -> Bool {
        guard let caps = entry["capabilities"] as? [Any] else { return true }
        return caps.contains { ($0 as? String)?.lowercased() == "completion" }
    }

    private static func models(for c: Candidate, timeout: TimeInterval) async -> [String]? {
        if c.provider == "mlx" {
            guard let model = try? await MlxInference.shared.resolve(endpoint: c.base, pin: nil) else { return nil }
            return [model]
        }
        if c.tags, let url = URL(string: c.base + "/api/tags") {
            var r = URLRequest(url: url); r.timeoutInterval = timeout
            if let (data, resp) = try? await URLSession.shared.data(for: r),
               (resp as? HTTPURLResponse)?.statusCode == 200,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let arr = json["models"] as? [[String: Any]] {
                // Once /api/tags answered, its verdict is final: falling through
                // to /v1/models would re-add the embedding-only models just
                // filtered out (the compat shim reports no capabilities).
                if !arr.isEmpty {
                    return arr.filter(ollamaChatCapable).compactMap { $0["name"] as? String }
                }
            }
        }
        if let url = URL(string: c.base + "/v1/models") {
            var r = URLRequest(url: url); r.timeoutInterval = timeout
            if let (data, resp) = try? await URLSession.shared.data(for: r),
               (resp as? HTTPURLResponse)?.statusCode == 200,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let arr = json["data"] as? [[String: Any]] {
                return arr.compactMap { $0["id"] as? String }.filter { !$0.lowercased().contains("nanollava") }
            }
        }
        return nil
    }

    /// Probe standard local endpoints concurrently; return only servers that
    /// are reachable AND advertise at least one usable model. De-duped by
    /// (provider, endpoint).
    static func detect(timeout: TimeInterval = 1.2) async -> [DetectedJudgeProvider] {
        let found: [DetectedJudgeProvider] = await withTaskGroup(of: DetectedJudgeProvider?.self) { group in
            for c in candidates {
                group.addTask {
                    guard let m = await models(for: c, timeout: timeout), !m.isEmpty else { return nil }
                    return DetectedJudgeProvider(provider: c.provider, label: c.label, endpoint: c.endpoint, models: Array(m.prefix(12)))
                }
            }
            var out: [DetectedJudgeProvider] = []
            var seen = Set<String>()
            for await r in group {
                guard let r else { continue }
                let key = "\(r.provider):\(r.endpoint)"
                if seen.contains(key) { continue }
                seen.insert(key)
                out.append(r)
            }
            return out
        }
        return found
    }
}
#endif
