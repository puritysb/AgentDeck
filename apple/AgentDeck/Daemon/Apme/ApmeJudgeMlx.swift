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

    /// Run the judge via MLX HTTP endpoint. Returns nil on any failure —
    /// caller (ApmeRunner) treats nil as "skip this eval" and doesn't retry.
    /// `sendsRepetitionPenalty` is false for the CLASSIFIER, which shares this
    /// transport but not the measurement: the 4-of-6 → 1-of-6 cut rate was
    /// measured on judge prompts, and Node's classifier has its own `fetch`
    /// that never carried the field. Sending it here would extend a measured
    /// claim to a different prompt shape on one daemon only.
    static func judge(prompt: String, config: ApmeJudgeConfig, sendsRepetitionPenalty: Bool = true) async -> String? {
        let endpoint = config.endpoint ?? "http://127.0.0.1:8800/chat/completions"
        guard let url = URL(string: endpoint) else { return nil }

        // Auto-detect model if not explicitly configured. Matches TS runner.ts:
        // query /v1/models then /models, pick first non-nanollava entry.
        let model = await resolveModel(config: config, endpoint: endpoint)
        LastResolvedModel.set(model)

        var body: [String: Any] = [
            "model": model,
            "messages": [
                ["role": "system", "content": "You are an exacting code evaluator. Reply with strict JSON only."],
                ["role": "user", "content": prompt],
            ],
            "temperature": 0.0,
            "max_tokens": 800,
        ]
        // Rationale and default: `MLX_JUDGE_REPETITION_PENALTY` in
        // bridge/src/apme/runner.ts. `repetition_penalty` is NOT an
        // OpenAI-standard field, and `apme.judge.endpoint` may point at a
        // strict OpenAI-shaped server — which answers 4xx. This leg has no
        // retry ladder and reports every non-200 as `nil`, so without a
        // fallback such a user would lose EVERY eval, permanently, and the
        // skip would be indistinguishable from "MLX offline". One retry
        // without the field is the whole recovery, and a refusal the retry
        // PROVED is remembered so the cost is one request per endpoint rather
        // than one per verdict — see the `.clientError` branch for why the
        // proof is load-bearing.
        let penalty = sendsRepetitionPenalty
            ? Self.resolvedPenalty(configured: config.repetitionPenalty, suppressed: Self.penaltySuppressed(for: url))
            : nil
        if let penalty { body["repetition_penalty"] = penalty }

        switch await send(body, to: url) {
        case .ok(let text):
            return text
        case .noVerdict, .transportFailure:
            // NOT a refused field. `noVerdict` is the repetition cut itself —
            // HTTP 200 whose body `content` rejects — so reading it as a
            // refusal would let the very failure this penalty exists to reduce
            // switch the penalty off for every later verdict on this endpoint.
            // A transport failure (server not up yet at login) says nothing
            // about the field either, and suppressing on it would disable the
            // penalty for the life of the app after one refused connection.
            return nil
        case .clientError(let status):
            // The request was rejected while carrying a non-standard field, so
            // the field is a CANDIDATE cause — not yet the established one.
            guard penalty != nil else { return nil }
            body.removeValue(forKey: "repetition_penalty")
            switch await send(body, to: url) {
            case .ok(let text):
                Self.suppressPenalty(for: url, status: status)
                return text
            case .noVerdict:
                // The server ACCEPTED the request once the field was gone —
                // that is the evidence, and it is complete. Whether the reply
                // was then a usable verdict is a different question about the
                // MODEL, and requiring it here made the promise one line above
                // ("one request per endpoint, not one per verdict") void in
                // exactly the combination this PR is about: a strict server
                // plus the cut-prone model. Node records it (its ladder exits
                // on `resp.ok`, before the body is judged), so requiring a
                // verdict also made the two daemons disagree.
                Self.suppressPenalty(for: url, status: status)
                return nil
            case .clientError, .transportFailure:
                // Dropping the field did not help, so it was never the reason.
                // Writing the endpoint off here is how one unrelated 400 (a
                // wrong model id, an auth proxy) disabled the penalty for the
                // life of the app while claiming, in the log, to have observed
                // a refusal that never happened.
                return nil
            }
        }
    }

    /// The value that actually goes on the wire, given the user's setting and
    /// this endpoint's suppression memory. Pure, so both halves of the rule
    /// can be driven without a server.
    ///
    /// `1` means OFF, and off means the field is not sent AT ALL — the same
    /// rule as `configured > 1` in bridge/src/apme/runner.ts. Sending
    /// `repetition_penalty: 1` is a no-op for the model but still costs a user
    /// on a strict OpenAI-shaped server a 400 plus the retry probe, and marks
    /// their endpoint; "disabling" it must not have a price. This gate lives
    /// at the SEND, not in `ApmeSettings.parse`, because the parser's job is
    /// to say whether the user wrote a usable number (it keeps 1...2) and this
    /// one's is to say whether the field is sent.
    static func resolvedPenalty(configured: Double?, suppressed: Bool) -> Double? {
        if suppressed { return nil }
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

    static func send(_ body: [String: Any], to url: URL) async -> JudgeAttempt {
        if let injected = currentTransport() { return await injected(body, url) }
        guard let bodyData = try? JSONSerialization.data(withJSONObject: body) else { return .transportFailure }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = bodyData
        request.timeoutInterval = 60
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
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

    /// Endpoints that failed while carrying `repetition_penalty`. Mirrors
    /// `judgePenaltyUnsupported` in bridge/src/apme/runner.ts: per-process, so
    /// discovering a strict server costs one request, not one per judge call.
    nonisolated(unsafe) private static var penaltyUnsupported = Set<String>()
    private static let penaltyLock = NSLock()
    static func penaltySuppressed(for url: URL) -> Bool {
        penaltyLock.lock(); defer { penaltyLock.unlock() }
        return penaltyUnsupported.contains(url.absoluteString)
    }
    static func suppressPenalty(for url: URL, status: Int) {
        penaltyLock.lock()
        let inserted = penaltyUnsupported.insert(url.absoluteString).inserted
        penaltyLock.unlock()
        if inserted {
            DaemonLogger.shared.info("[APME] judge: \(url.absoluteString) rejected repetition_penalty (HTTP \(status)) — retrying without it and not sending it again this process")
        }
    }
    static func clearPenaltySuppressionForTests() {
        penaltyLock.lock(); defer { penaltyLock.unlock() }
        penaltyUnsupported.removeAll()
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
