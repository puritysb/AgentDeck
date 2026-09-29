#if os(macOS)
// ApmeJudgeCrossDaemonTests.swift — the judge legs answer the same settings
// file the same way the Node daemon does.
//
// Both daemons may hold port 9120 and both read `~/.agentdeck/settings.json`,
// so a divergence here means the same user configuration produces a different
// verdict depending on which daemon answered, with nothing in either log saying
// so. Each case below is one such divergence, found in #298's review rounds and
// filed as #299.
import XCTest
@testable import AgentDeck

final class ApmeJudgeCrossDaemonTests: XCTestCase {

    // MARK: - Where the MLX judge posts

    /// Point `AGENTDECK_DATA_DIR` at a temp dir holding `settings`, run `body`.
    private func withSettings(_ settings: [String: Any],
                              _ body: () throws -> Void) rethrows {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("apme-judge-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let data = try! JSONSerialization.data(withJSONObject: settings)
        try! data.write(to: dir.appendingPathComponent("settings.json"))
        let previous = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"]
        setenv("AGENTDECK_DATA_DIR", dir.path, 1)
        ApmeSettings.clearMlxCache()
        defer {
            if let previous { setenv("AGENTDECK_DATA_DIR", previous, 1) } else { unsetenv("AGENTDECK_DATA_DIR") }
            ApmeSettings.clearMlxCache()
            try? FileManager.default.removeItem(at: dir)
        }
        try body()
    }

    func testMlxJudgeHonoursTheLlmMlxEndpointPin() {
        // Node: `cfg.endpoint ?? mlxChatUrl()`, and `mlxChatUrl()` is the
        // `llm.mlx` pin. This daemon read only `apme.judge.endpoint`, so with
        // the settings below Node judged against the LAN server while Swift
        // posted to loopback, got nothing, and dropped to the Foundation Models
        // floor (0.580 vs 0.86–1.00 on the judge-fidelity rubric).
        withSettings(["llm": ["mlx": ["endpoint": "http://192.168.1.5:8800"]]]) {
            var cfg = ApmeJudgeConfig()
            cfg.endpoint = nil
            XCTAssertEqual(ApmeJudgeMlx.chatCompletionsEndpoint(config: cfg),
                           "http://192.168.1.5:8800/chat/completions")
        }
    }

    func testAnExplicitJudgeEndpointStillWins() {
        withSettings(["llm": ["mlx": ["endpoint": "http://192.168.1.5:8800"]]]) {
            var cfg = ApmeJudgeConfig()
            cfg.endpoint = "http://10.0.0.9:9001/v1/chat/completions"
            XCTAssertEqual(ApmeJudgeMlx.chatCompletionsEndpoint(config: cfg),
                           "http://10.0.0.9:9001/v1/chat/completions")
        }
    }

    func testTheResolvedDefaultIsUnchangedWhenNothingIsConfigured() {
        withSettings([:]) {
            var cfg = ApmeJudgeConfig()
            cfg.endpoint = nil
            XCTAssertEqual(ApmeJudgeMlx.chatCompletionsEndpoint(config: cfg),
                           "http://127.0.0.1:8800/chat/completions")
        }
    }

    func testNonMlxJudgeDoesNotLeakIntoMlxSettings() {
        for backend in ["openai", "api", "foundationModels", "openclaw"] {
            withSettings(["apme": ["judge": ["backend": backend, "endpoint": "https://other.invalid/v1", "model": "other"]]]) {
                let config = ApmeSettings.loadMlxConfig()
                XCTAssertEqual(config.endpoint, "http://127.0.0.1:8800")
                XCTAssertNil(config.model)
            }
        }
    }

    func testExplicitDefaultMlxEndpointWinsOverLegacyEndpoint() {
        withSettings(["llm": ["mlx": ["endpoint": "http://127.0.0.1:8800"]],
                      "apme": ["judge": ["backend": "mlx", "endpoint": "http://other.invalid:8800"]]]) {
            XCTAssertEqual(ApmeSettings.loadMlxConfig().endpoint, "http://127.0.0.1:8800")
        }
    }

    // MARK: - Which statuses are a verdict on the OpenAI-compatible leg

    private func openAIConfig() -> ApmeJudgeConfig {
        var cfg = ApmeJudgeConfig()
        cfg.backend = .openai
        cfg.endpoint = "http://127.0.0.1:11434/v1"
        // A named model skips `resolveModel`'s probe, so the test touches no
        // network at all.
        cfg.model = "local-model"
        return cfg
    }

    private static func verdictBody() -> Data {
        let content = #"{"overall":0.8,"summary":"Did the thing."}"#
        return try! JSONSerialization.data(withJSONObject: [
            "choices": [["message": ["content": content], "finish_reason": "stop"]],
        ])
    }

    func testOpenAILegAcceptsEveryTwoHundredStatusLikeNodeDoes() async throws {
        // `resp.ok` on the Node side is 200–299. `guard code == 200` here made a
        // proxy answering 201/202 a verdict there and a failure here.
        let body = Self.verdictBody()
        let config = openAIConfig()
        for code in [200, 201, 202, 299] {
            let text = try await ApmeJudgeOpenAI.withTransportForTests({ _ in (body, code) }) {
                try await ApmeJudgeOpenAI.judgeThrowing(prompt: "judge", config: config)
            }
            XCTAssertTrue(text.contains("overall"), "status \(code) should be a verdict")
        }
    }

    func testOpenAILegStillRefusesNonTwoHundredStatuses() async {
        let body = Self.verdictBody()
        let config = openAIConfig()
        for code in [199, 300, 400, 401, 429, 500] {
            do {
                _ = try await ApmeJudgeOpenAI.withTransportForTests({ _ in (body, code) }) {
                    try await ApmeJudgeOpenAI.judgeThrowing(prompt: "judge", config: config)
                }
                XCTFail("status \(code) must not be read as a verdict")
            } catch let e as ApmeJudgeOpenAI.JudgeError {
                guard case .http(let got) = e else { return XCTFail("status \(code) → \(e)") }
                XCTAssertEqual(got, code)
            } catch {
                XCTFail("status \(code) → unexpected \(error)")
            }
        }
    }

    func testOpenAILegStillRefusesACutBodyOnATwoHundred() async {
        // Widening the status gate must not widen the BODY gate: a 201 whose
        // answer was cut at the token cap is still not a verdict.
        let cut = try! JSONSerialization.data(withJSONObject: [
            "choices": [["message": ["content": #"{"overall":0.8,"summ"#], "finish_reason": "length"]],
        ])
        let config = openAIConfig()
        do {
            _ = try await ApmeJudgeOpenAI.withTransportForTests({ _ in (cut, 201) }) {
                try await ApmeJudgeOpenAI.judgeThrowing(prompt: "judge", config: config)
            }
            XCTFail("a cut body must not be a verdict, whatever the 2xx status")
        } catch {
            // any refusal is the assertion — the body gate owns which one
        }
    }

    // MARK: - #299 item 1: the per-endpoint "unsupported field" memory is gone
    //
    // Owner decision, 2026-09-10: both legs now retry a refused field ONCE,
    // PER REQUEST, and remember nothing — no Set, no NSLock, nothing survives
    // past the call that discovered the refusal. The old memory produced a
    // HIGH/MEDIUM defect in four consecutive adversarial review rounds and
    // defended against a server never once observed on this fleet.

    /// The MLX leg's full ladder: `repetition_penalty` refused, then
    /// `response_format` refused, then success — three requests, in that
    /// order — and a SECOND call to the identical endpoint pays the same cost
    /// again because nothing was written down the first time.
    func testMlxJudgeDropsPenaltyThenJsonModePerRequestAndRemembersNothing() async {
        let url = URL(string: "http://127.0.0.1:65889/v1/chat/completions")!
        var config = ApmeJudgeConfig()
        config.endpoint = url.absoluteString
        config.model = "test-model"          // skips the /v1/models auto-detect
        let verdict = #"{"choices":[{"message":{"content":"{\"overall\":0.8}"}}]}"#

        let t = ApmeParseJudgeTests.ScriptedTransport([.clientError(400), .clientError(400), .ok(verdict)])
        let text = await ApmeJudgeMlx.withTransportForTests({ b, u in t.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: config)
        }
        XCTAssertEqual(text, verdict)
        XCTAssertEqual(t.sent.count, 3)
        // Request 1: both fields.
        XCTAssertTrue(t.sent[0].keys.contains("repetition_penalty"))
        XCTAssertTrue(t.sent[0].keys.contains("response_format"))
        // Request 2: penalty dropped first (non-standard, cheaper to lose).
        XCTAssertFalse(t.sent[1].keys.contains("repetition_penalty"))
        XCTAssertTrue(t.sent[1].keys.contains("response_format"))
        // Request 3: response_format dropped too.
        XCTAssertFalse(t.sent[2].keys.contains("repetition_penalty"))
        XCTAssertFalse(t.sent[2].keys.contains("response_format"))

        // A second call to the SAME endpoint starts fresh with both fields —
        // nothing survived the first call.
        let t2 = ApmeParseJudgeTests.ScriptedTransport([.ok(verdict)])
        let text2 = await ApmeJudgeMlx.withTransportForTests({ b, u in t2.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: config)
        }
        XCTAssertEqual(text2, verdict)
        XCTAssertEqual(t2.sent.count, 1)
        XCTAssertTrue(t2.sent[0].keys.contains("repetition_penalty"))
        XCTAssertTrue(t2.sent[0].keys.contains("response_format"))
    }

    /// Thread-safe accumulator for a `@Sendable` transport closure — the
    /// closures below run inside `ApmeJudgeOpenAI`'s transport seam, which is
    /// `@Sendable`, so a plain captured `var` cannot be mutated from it.
    private final class Recorder<T>: @unchecked Sendable {
        private var values: [T] = []
        private let lock = NSLock()
        func append(_ v: T) { lock.lock(); values.append(v); lock.unlock() }
        func snapshot() -> [T] { lock.lock(); defer { lock.unlock() }; return values }
        func reset() { lock.lock(); values.removeAll(); lock.unlock() }
    }

    /// The OpenAI-compatible leg's `response_format` retry, mirroring the
    /// Node `callOpenAICompatible` ladder: refused once, retried without it,
    /// and a second call to the same endpoint offers the field again.
    func testOpenAILegRetriesResponseFormatPerRequestAndRemembersNothing() async throws {
        let config = openAIConfig()
        let sawJsonMode = Recorder<Bool>()

        let text = try await ApmeJudgeOpenAI.withTransportForTests({ req in
            let body = (try? JSONSerialization.jsonObject(with: req.httpBody ?? Data())) as? [String: Any] ?? [:]
            let jsonMode = body["response_format"] != nil
            sawJsonMode.append(jsonMode)
            if jsonMode {
                return (Data("unknown field response_format".utf8), 400)
            }
            return (Self.verdictBody(), 200)
        }) {
            try await ApmeJudgeOpenAI.judgeThrowing(prompt: "judge", config: config)
        }
        XCTAssertTrue(text.contains("overall"))
        XCTAssertEqual(sawJsonMode.snapshot(), [true, false], "one probe, one retry without the field")

        // A second call must start again WITH the field — nothing remembered.
        sawJsonMode.reset()
        _ = try await ApmeJudgeOpenAI.withTransportForTests({ req in
            let body = (try? JSONSerialization.jsonObject(with: req.httpBody ?? Data())) as? [String: Any] ?? [:]
            sawJsonMode.append(body["response_format"] != nil)
            return (Self.verdictBody(), 200)
        }) {
            try await ApmeJudgeOpenAI.judgeThrowing(prompt: "judge", config: config)
        }
        XCTAssertEqual(sawJsonMode.snapshot(), [true], "the second call must offer response_format again")
    }

    /// Documented scope, not an omission (bridge/src/apme/runner.ts,
    /// `callOpenAICompatible`): this leg never sends `repetition_penalty`,
    /// whatever the user configured, because it also serves hosted providers
    /// (OpenRouter etc.) that DO honour the field.
    func testOpenAILegNeverSendsRepetitionPenalty() async throws {
        var config = openAIConfig()
        config.repetitionPenalty = 1.3
        let sawPenalty = Recorder<Bool>()
        _ = try await ApmeJudgeOpenAI.withTransportForTests({ req in
            let body = (try? JSONSerialization.jsonObject(with: req.httpBody ?? Data())) as? [String: Any] ?? [:]
            sawPenalty.append(body["repetition_penalty"] != nil)
            return (Self.verdictBody(), 200)
        }) {
            try await ApmeJudgeOpenAI.judgeThrowing(prompt: "judge", config: config)
        }
        XCTAssertFalse(sawPenalty.snapshot().contains(true))
    }
}
#endif
