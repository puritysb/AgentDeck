#if os(macOS)
// TimelineSummarizer.swift — LLM-based response summarization for timeline rows.
//
// Provider chain (when `.auto`):
//   Apple Intelligence (FoundationModels, macOS 26+ / iOS 26+)
//     → MLX local server (127.0.0.1:8800)
//     → heuristic (extractTopicHint)
//
// All backends are cost-free (FoundationModels is on-device free, MLX is
// user-run, heuristic is pure-Swift). API-paid backends are intentionally
// not part of this chain — see feedback_cost_sensitive_defaults.md.
// The Ollama tier was removed 2026-08-22 (Node mirror too): it hard-pinned
// the outdated `qwen2.5:7b`, and the Settings picker never offered it.
//
// App Store safety:
//   - No subprocess spawn (verify-appstore-archive.sh-clean)
//   - No bundled interpreters (FoundationModels comes from the OS, MLX is
//     an external user-run service discovered via outbound localhost which
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

    private static let maxChars = 80

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
        let config = ApmeSettings.loadMlxConfig()
        return try? await MlxInference.shared.resolve(endpoint: config.endpoint, pin: config.model)
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

    /// Label a coding agent's *current work* as one short natural-language phrase
    /// for a glance display (XTeink X3 rows). Distinct from `summarize`, which
    /// condenses a finished response — here the input is session context (tool,
    /// goal, project) and the instruction asks for a "what is it doing" label.
    /// FoundationModels-first (the App Store default on macOS 26+); returns nil
    /// when unavailable so the caller keeps its heuristic.
    static func labelActivity(_ context: String) async -> String? {
        let instructions =
            "You label a coding agent's current work for a tiny status display. Reply with ONE short " +
            "present-tense phrase (max 8 words, no period, no quotes) describing what the agent is doing, " +
            "e.g. \"Editing the auth module\" or \"Running the test suite\". English only."
#if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            guard case .available = SystemLanguageModel.default.availability else { return nil }
            do {
                let session = LanguageModelSession(instructions: instructions)
                let response = try await session.respond(
                    to: String(context.prefix(1000)),
                    options: GenerationOptions(temperature: 0)
                )
                return cleanLLMOutput(response.content)
            } catch {
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
            let (data, _) = try await MlxInference.shared.send(request)
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
    /// rules still match the MLX prompt.
    private static let foundationModelsInstructions = """
    You summarize an AI coding agent's response in a single short line for a timeline UI.
    Rules:
    - 최대 80자, 한국어 우선 (응답이 영어면 영어로 80 chars max).
    - 결과 중심 (process 아님), 인사말/설명 없이 요약만.
    - Plain text only — no quotes, no list markers, no code fences.
    """
}
#endif
