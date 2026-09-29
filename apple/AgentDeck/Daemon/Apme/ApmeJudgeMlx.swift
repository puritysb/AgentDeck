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

    /// Mirrors `MLX_JUDGE_REPETITION_PENALTY` in bridge/src/apme/runner.ts,
    /// which carries the measurement and its limits — the claim is the cut
    /// rate (4 of 6 tasks → 1 of 6, i.e. 12/18 → 3/18 observations, under two
    /// designs), not that the failure is
    /// permanent. The two constants are a hand mirror with no generator, so
    /// they must be edited together; each side pins the literal in its own
    /// suite.
    static let defaultRepetitionPenalty = 1.05

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

    /// Where the MLX judge posts.
    ///
    /// `apme.judge.endpoint` first — the user naming a judge server outright —
    /// then the `llm.mlx` pin, which `resolveModel` below has always honoured
    /// and which Node resolves for the URL too (`runner.ts`:
    /// `cfg.endpoint ?? mlxChatUrl()`). Reading only the first is what made the
    /// two daemons disagree about one settings file: with
    /// `{"llm":{"mlx":{"endpoint":"http://192.168.1.5:8800"}}}` and no
    /// `apme.judge.endpoint`, Node judged against the LAN server while Swift
    /// posted to loopback, got nothing, and dropped silently to the Foundation
    /// Models floor — 0.580 against 0.86–1.00 on the judge-fidelity rubric,
    /// with nothing in either log saying which leg had answered.
    ///
    /// `LlmMlxConfig.endpoint` is the base URL with any chat suffix already
    /// stripped, and defaults to `http://127.0.0.1:8800`, so the resolved
    /// default is unchanged.
    static func chatCompletionsEndpoint(config: ApmeJudgeConfig) -> String {
        if let ep = config.endpoint, !ep.isEmpty { return ep }
        return ApmeSettings.loadMlxConfig().endpoint + "/chat/completions"
    }

    /// Run the judge via MLX HTTP endpoint. Returns nil on any failure —
    /// caller (ApmeRunner) treats nil as "skip this eval" and doesn't retry.
    /// `sendsRepetitionPenalty` is false for the CLASSIFIER, which shares this
    /// transport but not the measurement: the 4-of-6 → 1-of-6 cut rate was
    /// measured on judge prompts, and Node's classifier has its own `fetch`
    /// that never carried the field. Sending it here would extend a measured
    /// claim to a different prompt shape on one daemon only.
    ///
    /// Per-request retry ladder, mirroring `callMlx` in
    /// bridge/src/apme/runner.ts: on a refused FIELD (400/422), drop
    /// `repetition_penalty` first — it is the non-standard one, so it is the
    /// likelier culprit, and losing it only raises the cut rate while losing
    /// `response_format` costs the strict-JSON request entirely — then
    /// `response_format`. Nothing is written anywhere: the next call starts
    /// fresh with both fields (owner decision, #299 item 1, 2026-09-10). An
    /// earlier version remembered a proven refusal per endpoint for the life
    /// of the process; that memory produced a HIGH/MEDIUM defect in four
    /// consecutive adversarial review rounds and defended against a server
    /// never once observed on this fleet — the MLX server every measurement
    /// here was taken against silently ACCEPTS unknown fields. The remaining
    /// cost is one (or two) extra requests, on every call, to a genuinely
    /// strict server — cheap next to a permanently mis-marked endpoint.
    /// The classifier (`classifyTaskCategory`) is a SEPARATE entry point —
    /// it shares `send()`'s transport but not this function's 800-token
    /// budget, timeout, or repetition-penalty measurement (measured on judge
    /// prompts, not the classifier's one-word answer).
    static func judge(prompt: String, config: ApmeJudgeConfig, sendsRepetitionPenalty: Bool = true) async -> String? {
        let endpoint = chatCompletionsEndpoint(config: config)
        guard let url = URL(string: endpoint) else { return nil }

        // Resolve a pin or verify residency. The shared transport revalidates
        // the model immediately before POST and refuses model replacement.
        guard let model = await resolveModel(config: config, endpoint: endpoint) else { return nil }
        LastResolvedModel.set(model)

        func makeBody(penalty: Double?, jsonMode: Bool) -> [String: Any] {
            var body: [String: Any] = [
                "model": model,
                "messages": [
                    ["role": "system", "content": "You are an exacting code evaluator. Reply with strict JSON only."],
                    ["role": "user", "content": prompt],
                ],
                "temperature": 0.0,
                "max_tokens": 800,
            ]
            if let penalty { body["repetition_penalty"] = penalty }
            // Mirrors Node's `response_format: { type: 'json_object' }` — see
            // the JSON-mode rationale in bridge/src/apme/runner.ts. This leg
            // had no `response_format` at all until #299 item 1; adding it
            // without the field/field ladder above would have reintroduced
            // the exact "one bad field permanently loses the leg" failure the
            // ladder exists to prevent.
            if jsonMode { body["response_format"] = ["type": "json_object"] }
            return body
        }

        // `1` means OFF, and off means the field is not sent AT ALL — the same
        // rule as `configured > 1` in bridge/src/apme/runner.ts. Sending
        // `repetition_penalty: 1` is a no-op for the model but still costs a
        // user on a strict server the 400 + retry probe; "disabling" it must
        // not have a price.
        var penalty: Double? = sendsRepetitionPenalty ? Self.resolvedPenalty(configured: config.repetitionPenalty) : nil
        var jsonMode = true
        var attempt = await send(makeBody(penalty: penalty, jsonMode: jsonMode), to: url)

        // At most 2 retries (3 requests total), matching Node's cap. Only a
        // `.clientError` may be read as a refused field — `.noVerdict` (a
        // repetition cut: HTTP 200 whose body rejects) and `.transportFailure`
        // say nothing about either field and must stop the ladder rather than
        // being misread as one.
        for _ in 0..<2 {
            guard case .clientError = attempt else { break }
            if penalty != nil {
                penalty = nil
            } else if jsonMode {
                jsonMode = false
            } else {
                break                                    // nothing left to give up
            }
            attempt = await send(makeBody(penalty: penalty, jsonMode: jsonMode), to: url)
        }

        switch attempt {
        case .ok(let text): return text
        case .noVerdict, .transportFailure, .clientError: return nil
        }
    }

    /// Run a TASK-CATEGORY CLASSIFICATION call, not an eval judge call — a
    /// separate entry point sharing `send()`'s transport (and its test seam,
    /// `withTransportForTests`) but none of `judge()`'s budget: prompt,
    /// output cap and timeout come from `ApmeClassifierRules` (the generated
    /// mirror of shared/src/apme-classifier-rules.ts), and no
    /// `repetition_penalty` is ever sent — that measurement covers judge
    /// prompts (800-token verdicts), and this call asks for one word.
    /// Returns nil on any failure; the caller (`ApmeClassifier`) falls
    /// through to the next backend in `backendOrder`, never retrying here.
    static func classifyTaskCategory(prompt: String, config: ApmeJudgeConfig) async -> String? {
        let endpoint = chatCompletionsEndpoint(config: config)
        guard let url = URL(string: endpoint) else { return nil }

        guard let model = await resolveModel(config: config, endpoint: endpoint) else { return nil }

        let body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": ApmeClassifierRules.systemPrompt],
                ["role": "user", "content": prompt],
            ],
            "temperature": 0.0,
            "max_tokens": ApmeClassifierRules.maxTokens,
        ]

        switch await send(body, to: url, timeoutInterval: ApmeClassifierRules.timeoutSeconds) {
        case .ok(let text):
            return text
        case .noVerdict, .clientError, .transportFailure:
            return nil
        }
    }

    /// The value that actually goes on the wire, given the user's setting.
    /// Pure, so it can be driven without a server.
    ///
    /// `1` means OFF, and off means the field is not sent AT ALL — the same
    /// rule as `configured > 1` in bridge/src/apme/runner.ts. This gate lives
    /// at the SEND, not in `ApmeSettings.parse`, because the parser's job is
    /// to say whether the user wrote a usable number (it keeps 1...2) and this
    /// one's is to say whether the field is sent.
    static func resolvedPenalty(configured: Double?) -> Double? {
        let value = configured ?? Self.defaultRepetitionPenalty
        return value > 1 ? value : nil
    }

    /// Why a request produced no verdict, kept distinct because the caller's
    /// decision differs: only `clientError` may be read as a refused field.
    enum JudgeAttempt {
        case ok(String)
        /// 200, but the body is not a verdict (empty, or cut at the token cap).
        case noVerdict
        case clientError(Int)
        /// Non-2xx that is not a 4xx, or the request never completed.
        case transportFailure
    }

    /// How a request reaches the server. Injectable ONLY so `judge()` itself
    /// can be driven in tests.
    ///
    /// This exists because three consecutive review rounds found the same
    /// hole: `judge()` called `URLSession.shared` directly, so it had zero
    /// coverage, and every fix landed in it was unpinned. Rounds 3 and 4 each
    /// answered "this path has no tests" by extracting one more PURE seam
    /// (`classify`, then `resolvedPenalty`) — so the pieces ended up tested
    /// twice over while the caller that COMPOSES them, where every one of
    /// those fixes actually lives, stayed untested. Four mutations proved it:
    /// deleting the line that sends the field, moving the suppression back
    /// before the retry, letting a repetition cut suppress, and re-enabling
    /// the penalty for the classifier ALL left the suite green.
    ///
    /// A pure seam can only pin a decision. The composition is the behaviour.
    typealias Transport = @Sendable ([String: Any], URL) async -> JudgeAttempt

    nonisolated(unsafe) private static var injectedTransport: Transport?
    private static let transportLock = NSLock()

    /// Swap the transport for one test and restore it afterwards. The closure
    /// form makes the restore unskippable — an early `XCTAssert` failure must
    /// not leak a stub into the next test.
    static func withTransportForTests<T>(_ transport: @escaping Transport,
                                         _ body: () async throws -> T) async rethrows -> T {
        setTransport(transport)
        defer { setTransport(nil) }
        return try await body()
    }

    // Swift 6 makes `NSLock.lock()` unavailable from an async context, so the
    // critical sections stay in these synchronous helpers and the async code
    // only calls them. Nothing is awaited while the lock is held.
    private static func setTransport(_ t: Transport?) {
        transportLock.lock(); defer { transportLock.unlock() }
        injectedTransport = t
    }

    private static func currentTransport() -> Transport? {
        transportLock.lock(); defer { transportLock.unlock() }
        return injectedTransport
    }

    static func send(_ body: [String: Any], to url: URL, timeoutInterval: TimeInterval = 90) async -> JudgeAttempt {
        if let injected = currentTransport() { return await injected(body, url) }
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return .transportFailure }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = bodyData
        // Default 90 s, matching `runner.ts`'s judge fetch. 68.7 s was observed
        // on a real `task_rollup` prompt with Gemma 4 under local load, so at
        // 60 s a verdict that lands on the Node daemon times out on this one —
        // the same prompt, the same server, two answers. `classifyTaskCategory`
        // passes its own short budget (`ApmeClassifierRules.timeoutSeconds`) —
        // a different call with a different purpose sharing the judge's 90 s
        // ceiling would stall task closure waiting on a busy local server.
        request.timeoutInterval = timeoutInterval
        do {
            let (data, response) = try await MlxInference.shared.send(request)
            guard let http = response as? HTTPURLResponse else { return .transportFailure }
            return classify(status: http.statusCode, data: data)
        } catch {
            return .transportFailure
        }
    }

    /// Which outcome a completed response is. Pure, so the distinction the
    /// caller depends on can be driven without a server: only `clientError`
    /// may be read as a refused field, and a 200 whose body is not a verdict
    /// (the repetition cut this penalty exists to reduce) must NOT be.
    static func classify(status: Int, data: Data) -> JudgeAttempt {
        // 400/422 ONLY, mirroring `isJsonModeRejection` in
        // bridge/src/apme/runner.ts — these are the statuses a server uses to
        // reject the REQUEST. The whole 4xx range reads a 404 from a wrong
        // endpoint path, or a 429 from an auth proxy, as "this server refuses
        // repetition_penalty", which is a claim about a field nobody looked at.
        if status == 400 || status == 422 { return .clientError(status) }
        // `resp.ok` on the Node side is 200–299, so a proxy answering 201/202
        // must not be a failure on one daemon and a verdict on the other.
        guard (200..<300).contains(status) else { return .transportFailure }
        do { return .ok(try ApmeJudgeChatResponse.content(data)) }
        catch { return .noVerdict }
    }

    /// Explicit model is only a requested identity. send() verifies residency
    /// again and refuses a mismatch, even when the pin is user configured.
    private static func resolveModel(config: ApmeJudgeConfig, endpoint: String) async -> String? {
        if let pin = ApmeSettings.loadMlxConfig().model { return pin }
        if let pin = MlxSafetyRules.pin(config.model) { return pin }
        return try? await MlxInference.shared.resolve(endpoint: endpoint, pin: nil)
    }

    /// Quick probe — true when the MLX server is reachable.
    /// Used by the Settings Picker to show "MLX ready" vs "MLX offline".
    static func isReachable() async -> Bool {
        let config = ApmeSettings.load()
        let endpoint = chatCompletionsEndpoint(config: config.judge)
        return (try? await MlxInference.shared.resolve(endpoint: endpoint,
            pin: ApmeSettings.loadMlxConfig().model ?? MlxSafetyRules.pin(config.judge.model))) != nil
    }
}
#endif
