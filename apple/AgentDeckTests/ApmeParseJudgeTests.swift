// ApmeParseJudgeTests.swift — parseJudgeJson parity tests.
//
// These fixtures mirror the TS test cases. `parseJudgeJson` is the one
// function in the APME pipeline where silent drift between Swift and TS
// causes data loss (the original whitelist bug dropped conversation/research
// rubric axes until commit e76325f7). Any change that fails this suite
// must be mirrored in bridge/src/apme/runner.ts and vice versa.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class ApmeParseJudgeTests: XCTestCase {

    func testChatResponseMatchesSharedVectors() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/apme-judge-response-vectors.json")
        let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(vectors.count, 16)
        for vector in vectors {
            let note = try XCTUnwrap(vector["note"] as? String)
            let response = try XCTUnwrap(vector["response"] as? [String: Any])
            let data = try JSONSerialization.data(withJSONObject: response)
            if vector["accepted"] as? Bool == true {
                let content = try ApmeJudgeChatResponse.content(data)
                // `accepted` is the transport gate; `verdict` (defaulting to it)
                // is whether the parser must then produce one, so the vectors
                // pin both daemons end to end rather than one at each layer.
                if vector["verdict"] as? Bool ?? true {
                    XCTAssertNotNil(ApmeRunner.parseJudgeJson(content), note)
                } else {
                    XCTAssertNil(ApmeRunner.parseJudgeJson(content), note)
                }
            } else {
                XCTAssertThrowsError(try ApmeJudgeChatResponse.content(data), note)
            }
        }
    }

    /// A cut response is not a verdict, whatever the body looks like. An
    /// exemption for "its object closed" was tried and removed — brace topology
    /// cannot tell whether the model finished, and it had no measured
    /// beneficiary on this fleet.
    func testOutputLimitRejectsWhateverTheBodyLooksLike() {
        for content in [#"{\"overall\":0."#, #"{\"overall\":0.8} and then some prose"#] {
            let data = Data(#"{"choices":[{"finish_reason":"length","message":{"content":"\#(content)"}}]}"#.utf8)
            XCTAssertThrowsError(try ApmeJudgeChatResponse.content(data)) { error in
                guard case ApmeJudgeOpenAI.JudgeError.outputLimit = error else {
                    return XCTFail("Expected output limit, got \(error)")
                }
            }
        }
    }

    /// `JSONSerialization` bridges JSON booleans to NSNumber, so `as? Double`
    /// read `{"overall":true}` as a perfect 1.0 score here while Node refused
    /// the body, and turned `{"passed":true}` into a numeric axis row in
    /// `evals` on one daemon only.
    func testBooleansAreNotScores() {
        XCTAssertNil(ApmeRunner.parseJudgeJson(#"{"overall":true}"#))
        XCTAssertNil(ApmeRunner.parseJudgeJson(#"{"overall":false,"summary":"x"}"#))
        let parsed = ApmeRunner.parseJudgeJson(#"{"overall":0.8,"passed":true,"flag":false}"#)
        XCTAssertEqual(parsed?.scores, ["overall": 0.8])
    }

    /// `choices` must be an ARRAY. Swift rejected an object map all along and
    /// Node did not; the vector file now pins it for both (#286 item 4).
    func testChoicesMustBeAnArray() {
        let data = Data(#"{"choices":{"0":{"message":{"content":"{\"overall\":0.8}"}}}}"#.utf8)
        XCTAssertThrowsError(try ApmeJudgeChatResponse.content(data))
    }

    /// The label is the provenance stamped onto stored eval rows, so it must
    /// name the model that RAN. As a hardcoded constant it went on claiming
    /// `claude-opus-4-6` after the default moved — the same cross-daemon
    /// attribution error #286 set out to remove. And a configured id that is
    /// not an Anthropic model is not forwarded: there is no
    /// `resetBackendCoupledFields` on this side to wipe a leftover MLX id on a
    /// backend switch, and this leg reports a 400 as `nil`, which is
    /// byte-identical to "no API key found".
    func testApiJudgeResolvesTheModelItWillActuallyCall() {
        XCTAssertEqual(ApmeJudgeApi.resolveModel("default"), ApmeJudgeApi.defaultModel)
        XCTAssertEqual(ApmeJudgeApi.resolveModel(""), ApmeJudgeApi.defaultModel)
        XCTAssertEqual(ApmeJudgeApi.resolveModel("mlx-community/gemma-4-26b-a4b-it-4bit"),
                       ApmeJudgeApi.defaultModel)
        XCTAssertEqual(ApmeJudgeApi.resolveModel("claude-haiku-4-5"), "claude-haiku-4-5")
        // Against a custom endpoint the substitution is off: this daemon (unlike
        // Node) honours `endpoint`, so the leg may be pointed at an
        // Anthropic-compatible gateway whose ids are legitimately not
        // `claude…`-prefixed, and swapping one would bill the user for a model
        // they did not name.
        XCTAssertEqual(
            ApmeJudgeApi.resolveModel("anthropic.claude-opus-4-6-v1:0", endpoint: "https://gateway.invalid/v1/messages"),
            "anthropic.claude-opus-4-6-v1:0")
        XCTAssertEqual(
            ApmeJudgeApi.resolveModel("gemma-3-27b", endpoint: ApmeJudgeApi.defaultEndpoint),
            ApmeJudgeApi.defaultModel)
    }

    /// The label is the provenance stamped onto stored eval rows, so it must
    /// name the model that RAN — as a hardcoded constant it went on claiming
    /// `claude-opus-4-6` after the default moved. Driven through the same
    /// function `judge()` uses, so the assertion is on the real path rather
    /// than on the fallback branch.
    func testApiJudgeLabelNamesTheModelThatRan() {
        var config = ApmeJudgeConfig()
        config.backend = .api
        config.model = "claude-haiku-4-5"
        XCTAssertEqual(ApmeJudgeApi.resolvedModelForRequest(config), "claude-haiku-4-5")
        XCTAssertEqual(ApmeJudgeApi.judgeModelLabel, "api:claude-haiku-4-5")

        config.model = "mlx-community/gemma-4-26b-a4b-it-4bit"
        XCTAssertEqual(ApmeJudgeApi.resolvedModelForRequest(config), ApmeJudgeApi.defaultModel)
        XCTAssertEqual(ApmeJudgeApi.judgeModelLabel, "api:\(ApmeJudgeApi.defaultModel)")
    }

    /// The Anthropic leg's completion rule, replayed from the same file Vitest
    /// replays. It is reached only through an SDK/network call, so without this
    /// the rule had no gate on either daemon and reverting it stayed green.
    func testApiResponseMatchesSharedVectors() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/apme-judge-api-response-vectors.json")
        let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(vectors.count, 9)
        for vector in vectors {
            let note = try XCTUnwrap(vector["note"] as? String)
            let response = try XCTUnwrap(vector["response"] as? [String: Any])
            if vector["accepted"] as? Bool == true {
                let text = try ApmeJudgeApi.content(response)
                XCTAssertNotNil(ApmeRunner.parseJudgeJson(text), note)
            } else {
                XCTAssertThrowsError(try ApmeJudgeApi.content(response), note)
            }
        }
    }

    /// The 1.05 default is a HAND MIRROR of `MLX_JUDGE_REPETITION_PENALTY` in
    /// bridge/src/apme/runner.ts with no generator between them, and both
    /// daemons read the same settings.json while either may hold the port — so
    /// a drift means the same user config judges differently depending on which
    /// answered. Each side pins the literal in its own suite; the Node twin is
    /// in apme-judge-repetition-penalty.test.ts.
    func testRepetitionPenaltyDefaultMatchesTheNodeMirror() {
        XCTAssertEqual(ApmeJudgeMlx.defaultRepetitionPenalty, 1.05)
    }

    /// Out of range is not a choice: below 1 rewards repetition, which is the
    /// opposite of the point, so an unusable value is discarded and the default
    /// applies rather than reaching the server.
    func testRepetitionPenaltyRangeMatchesTheNodeValidation() {
        for (value, expected) in [("1", 1.0), ("1.05", 1.05), ("2", 2.0)] as [(String, Double)] {
            let json = "{\"apme\":{\"judge\":{\"backend\":\"mlx\",\"repetitionPenalty\":\(value)}}}"
            XCTAssertEqual(ApmeSettings.parse(Data(json.utf8)).judge.repetitionPenalty, expected, "kept \(value)")
        }
        // `true` is the case that exercises the boolean guard: it bridges to
        // NSNumber and `as? Double` is 1.0, so without `CFGetTypeID` it would
        // enable the penalty on Swift while Node rejects it — one
        // settings.json, two verdicts. `false` bridges to 0.0 and is caught by
        // the range check whether or not the guard exists, so it is included
        // for symmetry only and proves nothing about the guard.
        for value in ["0", "0.5", "-1", "3", "\"high\"", "true", "false"] {
            let json = "{\"apme\":{\"judge\":{\"backend\":\"mlx\",\"repetitionPenalty\":\(value)}}}"
            XCTAssertNil(ApmeSettings.parse(Data(json.utf8)).judge.repetitionPenalty, "dropped \(value)")
        }
    }

    /// Scoping and reset semantics of the suppression Set.
    ///
    /// NOTE the name this test used to carry — "only a client error
    /// suppresses" — which it never tested: `suppressPenalty(for:status:)`
    /// does not branch on `status` at all (the value only reaches the log
    /// line), so calling it with 503 inserts exactly as 400 does. The "only a
    /// 4xx, and only when dropping the field actually helped" rule lives in
    /// `judge()`'s switch, which this test never reaches. That switch is now
    /// driven directly through an injected transport — see the `judge()`
    /// section below.
    func testPenaltySuppressionIsScopedToTheEndpointAndClearable() {
        let url = URL(string: "http://127.0.0.1:65999/v1/chat/completions")!
        ApmeJudgeMlx.clearPenaltySuppressionForTests()
        XCTAssertFalse(ApmeJudgeMlx.penaltySuppressed(for: url))

        ApmeJudgeMlx.suppressPenalty(for: url, status: 400)
        XCTAssertTrue(ApmeJudgeMlx.penaltySuppressed(for: url))

        // Scoped to the endpoint, not global.
        let other = URL(string: "http://127.0.0.1:65998/v1/chat/completions")!
        XCTAssertFalse(ApmeJudgeMlx.penaltySuppressed(for: other))

        ApmeJudgeMlx.clearPenaltySuppressionForTests()
        XCTAssertFalse(ApmeJudgeMlx.penaltySuppressed(for: url))
    }

    /// A cut body is `noVerdict`, never `clientError` — this is the
    /// classification that was wrong, and it is what keeps the penalty alive
    /// through the exact failure it exists to reduce. A repetition cut is an
    /// HTTP 200 whose body `content` rejects; reading that as a refused field
    /// disabled the penalty for every later verdict on the endpoint.
    func testResponseKindsThePenaltyDecisionDependsOn() {
        let cut = Data(#"{"choices":[{"finish_reason":"length","message":{"content":"{\"overall\":0."}}]}"#.utf8)
        if case .noVerdict = ApmeJudgeMlx.classify(status: 200, data: cut) {} else {
            XCTFail("a cut body must be noVerdict, not a refused field")
        }
        let empty = Data(#"{"choices":[{"message":{"content":""}}]}"#.utf8)
        if case .noVerdict = ApmeJudgeMlx.classify(status: 200, data: empty) {} else {
            XCTFail("an empty body must be noVerdict")
        }
        let good = Data(#"{"choices":[{"message":{"content":"{\"overall\":0.8}"}}]}"#.utf8)
        if case .ok = ApmeJudgeMlx.classify(status: 200, data: good) {} else { XCTFail("expected ok") }
        // Only a 4xx is a refused field.
        if case .clientError(400) = ApmeJudgeMlx.classify(status: 400, data: Data()) {} else {
            XCTFail("400 must be clientError")
        }
        // A 5xx says nothing about the field — suppressing on it would disable
        // the penalty for the life of the process after one server hiccup.
        if case .transportFailure = ApmeJudgeMlx.classify(status: 503, data: Data()) {} else {
            XCTFail("503 must not be a refused field")
        }
        // 422 is the other status Node's `isJsonModeRejection` treats as a
        // rejected request.
        if case .clientError(422) = ApmeJudgeMlx.classify(status: 422, data: Data()) {} else {
            XCTFail("422 must be clientError")
        }
        // The REST of the 4xx range is not a refused field. A 404 is a wrong
        // endpoint path and a 429 is an auth proxy; reading either as "this
        // server refuses repetition_penalty" marks the endpoint on evidence
        // about a field nobody looked at, and logs a refusal that never
        // happened.
        for status in [401, 403, 404, 408, 429] {
            if case .transportFailure = ApmeJudgeMlx.classify(status: status, data: Data()) {} else {
                XCTFail("\(status) must not be read as a refused field")
            }
        }
        // `resp.ok` is 200–299 on the Node side, so a proxy answering 201 must
        // not be a verdict on one daemon and a failure on the other.
        if case .ok = ApmeJudgeMlx.classify(status: 201, data: good) {} else {
            XCTFail("201 must be ok, matching Node's resp.ok")
        }
    }

    /// The value that actually reaches the wire — the half of the decision
    /// `classify` does not own, and the half that had NO test at all: the Swift
    /// suite pinned two constants and a pure classifier while every behaviour
    /// this change was written to produce went unasserted, so deleting the line
    /// that sends the field left the suite green.
    ///
    /// `1` means OFF and off means the field is absent, which is the promise
    /// made in docs/apme.md, settings.ts and CLAUDE.md. It held on Node alone
    /// until this test existed: Swift POSTed `repetition_penalty: 1.0` and the
    /// user who "disabled" it still paid the 400 + retry probe on a strict
    /// server, and still got their endpoint marked.
    func testResolvedPenaltyMatchesTheNodeSendGate() {
        // Default when the user set nothing.
        XCTAssertEqual(ApmeJudgeMlx.resolvedPenalty(configured: nil, suppressed: false), 1.05)
        // The user's value is used, not the constant.
        XCTAssertEqual(ApmeJudgeMlx.resolvedPenalty(configured: 1.5, suppressed: false), 1.5)
        // EXACTLY 1 omits the field — the Node twin is `omits the field
        // entirely when set to 1`.
        XCTAssertNil(ApmeJudgeMlx.resolvedPenalty(configured: 1.0, suppressed: false))
        // A suppressed endpoint omits it whatever the setting says.
        XCTAssertNil(ApmeJudgeMlx.resolvedPenalty(configured: 1.5, suppressed: true))
        XCTAssertNil(ApmeJudgeMlx.resolvedPenalty(configured: nil, suppressed: true))
    }

    /// An unknown backend name must reject the fields COUPLED to it, not just
    /// itself. Swift used to keep `endpoint` and `model` from a config line the
    /// loader had refused, so a typo'd backend beside a remote URL sent the
    /// judge prompt — the user's code and trajectory — to that third party.
    /// Node has always wiped them (`resetBackendCoupledFields`).
    func testAnUnknownBackendDoesNotKeepItsRemoteEndpoint() {
        let json = #"{"apme":{"judge":{"backend":"grok","endpoint":"https://api.example.com/v1/chat/completions","model":"grok-4","reasoningEffort":"high"}}}"#
        let cfg = ApmeSettings.parse(Data(json.utf8)).judge
        XCTAssertNil(cfg.endpoint, "a refused backend must not keep a remote endpoint")
        XCTAssertNotEqual(cfg.model, "grok-4", "nor the model coupled to it")
        XCTAssertNil(cfg.reasoningEffort)

        // A KNOWN backend still keeps its own fields — this is a rejection
        // rule, not a blanket ignore.
        let good = #"{"apme":{"judge":{"backend":"openai","endpoint":"https://api.example.com/v1/chat/completions","model":"gpt-x"}}}"#
        let ok = ApmeSettings.parse(Data(good.utf8)).judge
        XCTAssertEqual(ok.endpoint, "https://api.example.com/v1/chat/completions")
        XCTAssertEqual(ok.model, "gpt-x")
    }

    // MARK: - judge(), driven through an injected transport
    //
    // Everything below reaches `ApmeJudgeMlx.judge(...)` itself. That matters
    // more than it sounds: rounds 3, 4 and 5 each found a defect in this
    // function, and until the transport became injectable NONE of them could
    // be pinned — the suite tested `classify` and `resolvedPenalty` twice over
    // while the caller composing them had zero coverage. Four separate
    // mutations of `judge()` left the whole suite green.

    /// A transport that replays a scripted sequence and records what was sent.
    private final class ScriptedTransport: @unchecked Sendable {
        private let replies: [ApmeJudgeMlx.JudgeAttempt]
        private(set) var sent: [[String: Any]] = []
        private let lock = NSLock()
        init(_ replies: [ApmeJudgeMlx.JudgeAttempt]) { self.replies = replies }
        func handle(_ body: [String: Any], _ url: URL) -> ApmeJudgeMlx.JudgeAttempt {
            lock.lock(); defer { lock.unlock() }
            let i = sent.count
            sent.append(body)
            return i < replies.count ? replies[i] : .transportFailure
        }
        var penaltiesSent: [Double?] { sent.map { $0["repetition_penalty"] as? Double } }
    }

    private func judgeConfig(endpoint: String, penalty: Double? = nil) -> ApmeJudgeConfig {
        var cfg = ApmeJudgeConfig()
        cfg.endpoint = endpoint
        cfg.model = "test-model"          // skips the /v1/models auto-detect
        cfg.repetitionPenalty = penalty
        return cfg
    }

    private static let verdict = #"{"choices":[{"message":{"content":"{\"overall\":0.8}"}}]}"#

    /// The value `resolvedPenalty` computes must actually REACH the wire.
    /// Deleting the line that writes it into the body left the suite green
    /// through two review rounds, because the only tests were of the pure
    /// function that computes it.
    func testJudgeSendsTheResolvedPenaltyOnTheWire() async {
        ApmeJudgeMlx.clearPenaltySuppressionForTests()
        let t = ScriptedTransport([.ok(Self.verdict)])
        _ = await ApmeJudgeMlx.withTransportForTests({ b, u in t.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: judgeConfig(endpoint: "http://127.0.0.1:65990/v1/chat/completions"))
        }
        XCTAssertEqual(t.penaltiesSent, [1.05], "the default must reach the request body")

        let explicit = ScriptedTransport([.ok(Self.verdict)])
        _ = await ApmeJudgeMlx.withTransportForTests({ b, u in explicit.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: judgeConfig(endpoint: "http://127.0.0.1:65991/v1/chat/completions", penalty: 1.5))
        }
        XCTAssertEqual(explicit.penaltiesSent, [1.5], "the user's value must reach the request body")

        // Exactly 1 disables, and disabling means the key is ABSENT.
        let off = ScriptedTransport([.ok(Self.verdict)])
        _ = await ApmeJudgeMlx.withTransportForTests({ b, u in off.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: judgeConfig(endpoint: "http://127.0.0.1:65992/v1/chat/completions", penalty: 1))
        }
        XCTAssertNil(off.penaltiesSent.first ?? nil)
        XCTAssertFalse(off.sent[0].keys.contains("repetition_penalty"), "1 must omit the key, not send 1.0")
    }

    /// The round-4 rule, at the level it actually lives: a refusal is written
    /// down only when dropping the field is what changed the outcome.
    ///
    /// Direction (ii) is the one nothing expressed before — moving
    /// `suppressPenalty` back above the retry (the round-3 defect) passed the
    /// entire suite.
    func testOnlyAProvenRefusalIsRemembered() async {
        // (i) 400 with the field, accepted without it ⇒ proven, remembered.
        let proven = URL(string: "http://127.0.0.1:65993/v1/chat/completions")!
        ApmeJudgeMlx.clearPenaltySuppressionForTests()
        let t1 = ScriptedTransport([.clientError(400), .ok(Self.verdict)])
        let text = await ApmeJudgeMlx.withTransportForTests({ b, u in t1.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: judgeConfig(endpoint: proven.absoluteString))
        }
        XCTAssertNotNil(text, "the retry's verdict must be returned")
        XCTAssertEqual(t1.penaltiesSent, [1.05, nil], "retry must drop the field")
        XCTAssertTrue(ApmeJudgeMlx.penaltySuppressed(for: proven), "a proven refusal is remembered")

        // (ii) 400 both with AND without the field ⇒ the field was never the
        // reason, so nothing may be written down.
        let unproven = URL(string: "http://127.0.0.1:65994/v1/chat/completions")!
        ApmeJudgeMlx.clearPenaltySuppressionForTests()
        let t2 = ScriptedTransport([.clientError(400), .clientError(400)])
        let none = await ApmeJudgeMlx.withTransportForTests({ b, u in t2.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: judgeConfig(endpoint: unproven.absoluteString))
        }
        XCTAssertNil(none)
        XCTAssertFalse(ApmeJudgeMlx.penaltySuppressed(for: unproven),
                       "an unrelated 400 must not write off the field")
    }

    /// A retry the server ACCEPTED is proof, even when the reply is not a
    /// usable verdict. Requiring a verdict made the "one request per endpoint"
    /// promise void for a strict server running the cut-prone model — i.e. in
    /// exactly the combination this change exists for — and disagreed with
    /// Node, whose ladder exits on `resp.ok` before the body is judged.
    func testAnAcceptedRetryIsProofEvenWithoutAVerdict() async {
        let url = URL(string: "http://127.0.0.1:65995/v1/chat/completions")!
        ApmeJudgeMlx.clearPenaltySuppressionForTests()
        let t = ScriptedTransport([.clientError(400), .noVerdict])
        _ = await ApmeJudgeMlx.withTransportForTests({ b, u in t.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: judgeConfig(endpoint: url.absoluteString))
        }
        XCTAssertTrue(ApmeJudgeMlx.penaltySuppressed(for: url),
                      "the server accepted the request without the field — that is the evidence")
    }

    /// The named regression, at the level it lives. A repetition cut is HTTP
    /// 200 whose body is not a verdict; reading it as a refused field lets the
    /// failure this penalty exists to REDUCE switch the penalty off. Making
    /// `.noVerdict` suppress on the FIRST attempt left the suite green.
    func testARepetitionCutNeverSuppressesThePenalty() async {
        let url = URL(string: "http://127.0.0.1:65996/v1/chat/completions")!
        ApmeJudgeMlx.clearPenaltySuppressionForTests()
        let t = ScriptedTransport([.noVerdict])
        _ = await ApmeJudgeMlx.withTransportForTests({ b, u in t.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: judgeConfig(endpoint: url.absoluteString))
        }
        XCTAssertEqual(t.sent.count, 1, "a cut must not trigger the refusal retry")
        XCTAssertFalse(ApmeJudgeMlx.penaltySuppressed(for: url),
                       "a repetition cut says nothing about the field")

        // Same for a server that is simply not up yet.
        let down = URL(string: "http://127.0.0.1:65997/v1/chat/completions")!
        let t2 = ScriptedTransport([.transportFailure])
        _ = await ApmeJudgeMlx.withTransportForTests({ b, u in t2.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: judgeConfig(endpoint: down.absoluteString))
        }
        XCTAssertFalse(ApmeJudgeMlx.penaltySuppressed(for: down))
    }

    /// The classifier shares this transport but not the measurement — the cut
    /// rate was measured on judge prompts, and Node's classifier has its own
    /// `fetch` that never carried the field. That exclusion was a single
    /// literal no test read: flipping it back to `true` left the suite green.
    func testTheClassifierPathSendsNoPenalty() async {
        ApmeJudgeMlx.clearPenaltySuppressionForTests()
        // Drive the REAL classifier dispatch, not `judge()` with the flag
        // typed by hand: the thing that can regress is the argument at that
        // call site, and a test passing its own `false` cannot see it change.
        var config = ApmeConfig()
        config.judge.backend = .mlx
        config.judge.endpoint = "http://127.0.0.1:65998/v1/chat/completions"
        config.judge.model = "test-model"
        config.judge.fallbackToFoundationModels = false

        let t = ScriptedTransport([.ok(Self.verdict)])
        _ = await ApmeJudgeMlx.withTransportForTests({ b, u in t.handle(b, u) }) {
            await ApmeClassifier.callConfiguredJudge(prompt: "p", config: config)
        }
        XCTAssertEqual(t.sent.count, 1, "the classifier must reach the MLX leg")
        XCTAssertFalse(t.sent[0].keys.contains("repetition_penalty"),
                       "the classifier must not carry the judge measurement's field")

        // And the judge path through the same transport MUST carry it, so this
        // is asserting an exclusion rather than a broken wire.
        let j = ScriptedTransport([.ok(Self.verdict)])
        _ = await ApmeJudgeMlx.withTransportForTests({ b, u in j.handle(b, u) }) {
            await ApmeJudgeMlx.judge(prompt: "p", config: config.judge)
        }
        XCTAssertEqual(j.penaltiesSent, [1.05])
    }

    // MARK: - Happy path

    func testValidCodeAxes() {
        let json = """
        {"task_completion":0.9,"code_quality":0.8,"efficiency":0.7,"overall":0.85,"reasoning":"Good"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["task_completion"], 0.9)
        XCTAssertEqual(parsed?.scores["code_quality"], 0.8)
        XCTAssertEqual(parsed?.scores["efficiency"], 0.7)
        XCTAssertEqual(parsed?.scores["overall"], 0.85)
        XCTAssertEqual(parsed?.reasoning, "Good")
    }

    func testConversationRubricAxesAccepted() {
        // This is the regression guard for commit e76325f7 — the old TS
        // parser had a hardcoded whitelist that silently dropped these
        // axes, leaving only `overall` in the evals table.
        let json = """
        {"accuracy":0.95,"helpfulness":0.85,"conciseness":0.9,"overall":0.9,"reasoning":"x"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores.count, 4)
        XCTAssertEqual(parsed?.scores["accuracy"], 0.95)
        XCTAssertEqual(parsed?.scores["helpfulness"], 0.85)
        XCTAssertEqual(parsed?.scores["conciseness"], 0.9)
        XCTAssertEqual(parsed?.scores["overall"], 0.9)
    }

    func testResearchRubricAxesAccepted() {
        let json = """
        {"thoroughness":0.7,"relevance":0.9,"synthesis":0.75,"overall":0.78,"reasoning":"x"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["thoroughness"], 0.7)
        XCTAssertEqual(parsed?.scores["relevance"], 0.9)
        XCTAssertEqual(parsed?.scores["synthesis"], 0.75)
        XCTAssertEqual(parsed?.scores["overall"], 0.78)
    }

    // MARK: - Rescaling + clamping

    func testZeroToTenRescale() {
        // Models occasionally ignore the "float in [0,1]" instruction.
        // clamp01 must rescale values in (1, 10] by /10.
        let json = """
        {"task_completion":9,"code_quality":8,"overall":8.5,"reasoning":"x"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["task_completion"], 0.9)
        XCTAssertEqual(parsed?.scores["code_quality"], 0.8)
        XCTAssertEqual(parsed?.scores["overall"], 0.85)
    }

    func testClampAbove1RescaleBehavior() {
        // TS parity: clamp01 assumes any value > 1 and ≤ 10 was emitted on
        // a 0..10 scale and rescales by /10. So 1.5 → 0.15, not → 1.0.
        // This is arguably a quirk (slight rounding overshoot collapses to
        // a small score) but matches bridge/src/apme/runner.ts:601-606.
        let json = """
        {"overall":1.5}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertEqual(parsed?.scores["overall"], 0.15)
    }

    func testClampAbove10ClampsTo1() {
        // Values > 10 fall through to `v > 1 → v = 1`.
        let json = """
        {"overall":11}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertEqual(parsed?.scores["overall"], 1.0)
    }

    func testClampBelow0() {
        let json = """
        {"overall":-0.3}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertEqual(parsed?.scores["overall"], 0.0)
    }

    // MARK: - Wrapped JSON (code fences, prose prefixes)

    func testCodeFenceWrappedJson() {
        // Apple Foundation Models wraps JSON in ```json fences at
        // temperature=0. parseJudgeJson extracts the first `{...}` block.
        let text = """
        Here is the evaluation:

        ```json
        {"accuracy":0.9,"helpfulness":0.9,"conciseness":0.8,"overall":0.85,"reasoning":"Correct"}
        ```

        Let me know if you need more detail.
        """
        let parsed = ApmeRunner.parseJudgeJson(text)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["overall"], 0.85)
        XCTAssertEqual(parsed?.scores["accuracy"], 0.9)
    }

    func testProseWrappedJson() {
        let text = """
        Based on the criteria, here is my judgment: {"overall":0.7,"intent":0.6,"reasoning":"Meh"}
        """
        let parsed = ApmeRunner.parseJudgeJson(text)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.scores["overall"], 0.7)
        XCTAssertEqual(parsed?.scores["intent"], 0.6)
    }

    // MARK: - Rejection cases

    func testMissingOverallReturnsNil() {
        // The TS contract requires `overall` — without it, the row is
        // considered unparseable and the whole eval is dropped.
        let json = """
        {"accuracy":0.9,"helpfulness":0.8}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNil(parsed)
    }

    func testNonNumericAxesIgnored() {
        let json = """
        {"accuracy":"high","overall":0.8,"notes":"some text"}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertNil(parsed?.scores["accuracy"])  // dropped — string
        XCTAssertNil(parsed?.scores["notes"])      // reserved + non-numeric
        XCTAssertEqual(parsed?.scores["overall"], 0.8)
    }

    func testReservedFieldsNeverCountAsAxes() {
        // Even if a model returns numeric values for reserved fields,
        // parseJudgeJson must not count them as axes.
        let json = """
        {"overall":0.9,"reasoning":0.5,"done":1,"missed":0,"notes":0.3}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        // Only `overall` should be in scores — reserved fields skipped.
        XCTAssertEqual(parsed?.scores.count, 1)
        XCTAssertEqual(parsed?.scores["overall"], 0.9)
    }

    func testEmptyInputReturnsNil() {
        XCTAssertNil(ApmeRunner.parseJudgeJson(""))
        XCTAssertNil(ApmeRunner.parseJudgeJson("no json here"))
    }

    // MARK: - done / missed arrays

    func testDoneMissedArraysParsed() {
        let json = """
        {"overall":0.8,"reasoning":"ok","done":["answered","verified"],"missed":["context"]}
        """
        let parsed = ApmeRunner.parseJudgeJson(json)
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.done, ["answered", "verified"])
        XCTAssertEqual(parsed?.missed, ["context"])
    }

    // MARK: - clamp01 unit tests

    func testClamp01ValidRange() {
        XCTAssertEqual(ApmeRunner.clamp01(0.0), 0.0)
        XCTAssertEqual(ApmeRunner.clamp01(0.5), 0.5)
        XCTAssertEqual(ApmeRunner.clamp01(1.0), 1.0)
    }

    func testClamp01Rescale10() {
        XCTAssertEqual(ApmeRunner.clamp01(5.0), 0.5)
        XCTAssertEqual(ApmeRunner.clamp01(10.0), 1.0)
    }

    func testClamp01ClampAbove10() {
        XCTAssertEqual(ApmeRunner.clamp01(15.0), 1.0)
    }

    func testClamp01ClampBelow0() {
        XCTAssertEqual(ApmeRunner.clamp01(-1.0), 0.0)
    }
}

/// A scorer must not be able to take the process down.
///
/// Observed 2026-08-06: `ApmeScorers.toolKey` fed a trajectory event's untyped
/// `input` straight to `JSONSerialization.data(withJSONObject:)`, which raises
/// an ObjC `NSInvalidArgumentException` — not a Swift error, so `try?` sails
/// past it — for anything that is not a valid top-level JSON container. A tool
/// event carrying a bare String aborted the app from a background eval task,
/// taking the daemon, every device connection and the port with it.
final class ApmeScorerHostileInputTests: XCTestCase {
    private func toolEvent(_ input: Any) -> [String: Any] {
        ["kind": "tool", "name": "Bash", "status": "success", "input": input]
    }

    private func trajectoryScore(_ results: [ApmeScorers.Result]) -> Double? {
        results.first(where: { $0.scorer == "trajectory_quality" })?.score
    }

    func testSurvivesAToolInputThatIsNotAJSONContainer() {
        // Each of these makes the raw call raise. Reaching the assertion at all
        // is the test.
        let hostile: [Any] = [
            "a bare string",
            42,
            Double.nan,
            Date(),
            URL(string: "https://example.com")!,
        ]
        for input in hostile {
            let results = ApmeScorers.run(events: [toolEvent(input), toolEvent(input)])
            XCTAssertFalse(results.isEmpty, "scorer produced nothing for \(type(of: input))")
        }
    }

    func testStillDistinguishesDuplicateToolCallsWithStringInputs() {
        // The guard must not flatten every String input to one key — that would
        // score unrelated calls as repeats. The `as? String` fallback is what
        // keeps them apart, and it was unreachable before the fix.
        let differing = ApmeScorers.run(events: [toolEvent("ls -la"), toolEvent("git status")])
        let identical = ApmeScorers.run(events: [toolEvent("ls -la"), toolEvent("ls -la")])
        XCTAssertNotNil(trajectoryScore(differing))
        XCTAssertGreaterThan(trajectoryScore(differing)!, trajectoryScore(identical)!)
    }

    func testSerializesAWellFormedContainerInputAsBefore() {
        let a = ApmeScorers.run(events: [
            toolEvent(["command": "ls"] as [String: Any]),
            toolEvent(["command": "ls"] as [String: Any]),
        ])
        let b = ApmeScorers.run(events: [
            toolEvent(["command": "ls"] as [String: Any]),
            toolEvent(["command": "pwd"] as [String: Any]),
        ])
        XCTAssertGreaterThan(trajectoryScore(b)!, trajectoryScore(a)!)
    }
}
#endif
