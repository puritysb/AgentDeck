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
}
#endif
