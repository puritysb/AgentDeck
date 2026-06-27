#if os(macOS)
// TimelineSummarizer.swift — LLM-based response summarization for timeline rows.
//
// Provider chain (when `.auto`):
//   Apple Intelligence (FoundationModels, macOS 26+ / iOS 26+)
//     → MLX local server (127.0.0.1:8800)
//     → Ollama (127.0.0.1:11434)
//     → heuristic (extractTopicHint)
//
// All backends are cost-free (FoundationModels is on-device free, MLX/Ollama
// are user-run, heuristic is pure-Swift). API-paid backends are intentionally
// not part of this chain — see feedback_cost_sensitive_defaults.md.
//
// App Store safety:
//   - No subprocess spawn (verify-appstore-archive.sh-clean)
//   - No bundled interpreters (FoundationModels comes from the OS, MLX/Ollama
//     are external user-run services discovered via outbound localhost which
//     is allowed by `com.apple.security.network.client`)
//   - No install nudge — silent fallback when a backend is unavailable

import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

enum TimelineSummarizer {
    /// User-selectable backend selector. Stored as a raw string in
    /// AppPreferences so that schema changes don't break round-trip.
    enum SummaryProvider: String {
        case auto
        case appleIntelligence
        case mlx
        case heuristic
    }

    /// `kind` is plumbed onto the timeline entry as `summaryKind` so dashboards
    /// can label entries (and analytics can split LLM vs heuristic). Values
    /// stay stable across the schema; downstream just treats anything other
    /// than "heuristic" as an LLM-derived summary.
    typealias SummaryResult = (text: String, kind: String)

    private static let ollamaPort = 11434
    private static let maxChars = 80

    /// Preferred MLX model when the live catalog advertises it. Mirrors
    /// shared/src/llm-settings.ts MLX_FALLBACK_MODEL. Used only for catalog
    /// matching — never returned when the server is down.
    private static let mlxFallbackModel = "mlx-community/Qwen3.6-35B-A3B-4bit"

    /// Cached picked model id from /v1/models, refreshed on staleness.
    /// `nil` means "server probed, nothing usable" and summarize must skip.
    nonisolated(unsafe) private static var probedModel: String?
    nonisolated(unsafe) private static var probedAt: Date = .distantPast
    private static let probeCacheTTL: TimeInterval = 60

    static func isAssistantProgressUpdate(_ text: String?) -> Bool {
        guard let text else { return false }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let head = String(trimmed.prefix(800))
        let lower = head.lowercased()

        let progressPatterns = [
            #"\b(still|currently|continues? to|is|are)\s+(running|building|installing|executing|processing|waiting)\b"#,
            #"\b(still running|still building|build is running|is still running|are still running)\b"#,
            #"\b(waiting for|wait until|once (?:the )?.*(?:finishes|completes|arrives)|continue once|will continue once|i.ll continue once)\b"#,
            #"\b(no interim lines|buffers? output until completion|tail buffers output)\b"#,
        ]
        let englishProgress = progressPatterns.contains {
            lower.range(of: $0, options: .regularExpression) != nil
        }
        let koreanProgress =
            head.range(of: #"(아직|계속)\s*(실행|진행|빌드|설치)\s*중"#, options: .regularExpression) != nil ||
            head.range(of: #"(완료|끝나|도착)면\s*(계속|이어)"#, options: .regularExpression) != nil ||
            head.range(of: #"(기다리는 중|대기 중)"#, options: .regularExpression) != nil

        guard englishProgress || koreanProgress else { return false }

        let startsAsFinal =
            trimmed.range(of: #"^(done|completed|complete|fixed|merged|verified|all done)\b"#, options: [.regularExpression, .caseInsensitive]) != nil ||
            trimmed.range(of: #"^(완료|수정 완료|검증 완료|반영 완료|머지 완료)"#, options: .regularExpression) != nil
        return !startsAsFinal
    }

    /// Resolve the MLX model id for an inference call. Returns `nil` when
    /// the MLX server is unreachable — callers must skip the HTTP request
    /// rather than POSTing to a nonexistent model (App Store users without
    /// `mlx_vlm.server` installed would otherwise see a silent 100% failure
    /// rate and blocking network timeouts).
    private static func resolveMlxModel() async -> String? {
        if let pin = ApmeSettings.loadMlxConfig().model {
            return pin
        }
        if probedModel == nil || Date().timeIntervalSince(probedAt) > probeCacheTTL {
            probedModel = await pickFromCatalog()
            probedAt = Date()
        }
        return probedModel
    }

    /// Fetch /v1/models catalog and apply the 4-layer policy mirrored from
    /// shared `pickMlxModel`: pin → MLX_FALLBACK_MODEL if present → first
    /// entry → nil. The pin branch is handled by the caller (settings take
    /// precedence over probe). `nanollava` variants are always filtered.
    private static func pickFromCatalog() async -> String? {
        let base = ApmeSettings.loadMlxConfig().endpoint
        for path in ["/v1/models", "/models"] {
            guard let url = URL(string: base + path) else { continue }
            var req = URLRequest(url: url)
            req.timeoutInterval = 2
            guard let (data, response) = try? await URLSession.shared.data(for: req),
                  let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let rows = json["data"] as? [[String: Any]]
            else { continue }
            let catalog: [String] = rows.compactMap { row in
                guard let id = row["id"] as? String,
                      !id.isEmpty,
                      !id.lowercased().contains("nanollava")
                else { return nil }
                return id
            }
            if catalog.isEmpty { return nil }
            if catalog.contains(mlxFallbackModel) { return mlxFallbackModel }
            return catalog.first
        }
        return nil
    }

    /// Summarize a response text using the requested provider chain.
    /// Returns `(text, kind)` where `kind` identifies which backend produced
    /// the summary — used to populate `DaemonTimelineEntry.summaryKind`.
    /// Returns `nil` only when even the heuristic produces nothing (very
    /// short or empty text); otherwise the heuristic is the universal floor.
    static func summarize(_ text: String, provider: SummaryProvider = .auto) async -> SummaryResult? {
        switch provider {
        case .heuristic:
            return heuristic(text)

        case .appleIntelligence:
            if let r = await queryFoundationModels(text) { return r }
            return heuristic(text)

        case .mlx:
            if let r = await queryMLX(text) { return r }
            return heuristic(text)

        case .auto:
            if let r = await queryFoundationModels(text) { return r }
            if let r = await queryMLX(text) { return r }
            if let r = await queryOllama(text) { return r }
            return heuristic(text)
        }
    }

    private static func heuristic(_ text: String) -> SummaryResult? {
        guard let h = extractTopicHint(text) else { return nil }
        return (h, "heuristic")
    }

    // MARK: - Apple Intelligence (FoundationModels)

    /// On-device summarization via FoundationModels. Returns nil silently
    /// when the framework is missing, the OS is below 26, or Apple
    /// Intelligence is disabled / not yet downloaded — caller falls through
    /// to the next tier. Mirrors the gating used by ApmeJudgeFoundationModels.
    private static func queryFoundationModels(_ text: String) async -> SummaryResult? {
#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else {
                return nil
            }
            do {
                let session = LanguageModelSession(
                    instructions: foundationModelsInstructions
                )
                let options = GenerationOptions(temperature: 0.3)
                let truncated = String(text.prefix(2000))
                let response = try await session.respond(to: truncated, options: options)
                if let cleaned = cleanLLMOutput(response.content) {
                    return (cleaned, "appleIntelligence")
                }
            } catch {
                // Best-effort — never block the timeline pipeline.
                return nil
            }
        }
#endif
        return nil
    }

    // MARK: - MLX (port 8800)

    private static func queryMLX(_ text: String) async -> SummaryResult? {
        let base = ApmeSettings.loadMlxConfig().endpoint
        guard let url = URL(string: base + "/chat/completions") else { return nil }
        // MLX server not detected (App Store install without mlx-vlm) — skip
        // rather than posting to a nonexistent model and burning a 10s timeout.
        guard let model = await resolveMlxModel() else { return nil }
        let truncated = String(text.prefix(2000))
        let body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": summarySystemPrompt],
                ["role": "user", "content": truncated],
            ],
            "enable_thinking": false,
            "max_tokens": 100,
            "temperature": 0.3,
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 10

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let choices = json["choices"] as? [[String: Any]],
               let message = choices.first?["message"] as? [String: Any],
               let content = message["content"] as? String,
               let cleaned = cleanLLMOutput(content) {
                return (cleaned, "mlx")
            }
        } catch { /* MLX not available */ }
        return nil
    }

    // MARK: - Ollama

    private static func queryOllama(_ text: String) async -> SummaryResult? {
        let url = URL(string: "http://127.0.0.1:\(ollamaPort)/api/generate")!
        let truncated = String(text.prefix(2000))
        let body: [String: Any] = [
            "model": "qwen2.5:7b",
            "prompt": "\(summarySystemPrompt)\n\n\(truncated)",
            "stream": false,
        ]

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 15

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
               let response = json["response"] as? String,
               let cleaned = cleanLLMOutput(response) {
                return (cleaned, "ollama")
            }
        } catch { /* Ollama not available */ }
        return nil
    }

    // MARK: - Heuristic

    static func extractTopicHint(_ text: String) -> String? {
        let lines = text.components(separatedBy: .newlines)
        var inCodeBlock = false

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") { inCodeBlock.toggle(); continue }
            if inCodeBlock { continue }
            if trimmed.isEmpty || trimmed.hasPrefix("#") || trimmed.hasPrefix("---") { continue }
            if trimmed.count < 5 { continue }

            // Strip markdown
            var clean = trimmed
                .replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: "*", with: "")
                .replacingOccurrences(of: "`", with: "")
            // Strip Korean politeness prefixes
            let prefixes = ["네, ", "네,", "알겠습니다. ", "완료했습니다. ", "좋습니다. "]
            for prefix in prefixes {
                if clean.hasPrefix(prefix) { clean = String(clean.dropFirst(prefix.count)) }
            }

            if clean.count >= 5 {
                return String(clean.prefix(maxChars))
            }
        }
        return nil
    }

    static func cleanLLMOutput(_ content: String) -> String? {
        var text = content
        // Strip <think>...</think> blocks
        while let range = text.range(of: "<think>") {
            if let end = text.range(of: "</think>") {
                text.removeSubrange(range.lowerBound..<end.upperBound)
            } else {
                break
            }
        }

        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Strip quotes
        if (text.hasPrefix("\"") && text.hasSuffix("\"")) ||
           (text.hasPrefix("'") && text.hasSuffix("'")) {
            text = String(text.dropFirst().dropLast())
        }
        // Strip list markers
        if text.hasPrefix("- ") || text.hasPrefix("• ") {
            text = String(text.dropFirst(2))
        }

        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.count >= 3 else { return nil }
        return String(text.prefix(maxChars))
    }

    // MARK: - Prompt

    private static let summarySystemPrompt = """
    당신은 AI 코딩 에이전트의 작업 결과를 한 줄로 요약하는 역할입니다.
    규칙:
    - 최대 80자 이내
    - 결과 중심 (과정 아님)
    - 한국어로 작성
    - 인사말, 설명 없이 요약만
    """

    /// FoundationModels uses a separate `instructions` channel rather than a
    /// system message, so the wording is tuned for that API surface. The
    /// rules still match the MLX / Ollama prompt.
    private static let foundationModelsInstructions = """
    You summarize an AI coding agent's response in a single short line for a timeline UI.
    Rules:
    - 최대 80자, 한국어 우선 (응답이 영어면 영어로 80 chars max).
    - 결과 중심 (process 아님), 인사말/설명 없이 요약만.
    - Plain text only — no quotes, no list markers, no code fences.
    """
}
#endif
