// ApmeClassifierBackendTests.swift — #299: LLM-assist classifier backend
// dispatch. `task_category` selects the judge rubric downstream, so the two
// daemons picking a different category for the same task is a score
// difference. Before this fix, Swift's `classifyWithLlm` routed through
// `callConfiguredJudge` — WHATEVER judge backend the user configured for
// eval scoring, including the paid `api`/`openai` legs — while Node's
// classifier always called MLX-or-rules. These tests pin the replacement:
// the backend try-order is the shared SSOT (`ApmeClassifierRules`,
// generated from shared/src/apme-classifier-rules.ts) and a paid backend is
// structurally unreachable from the classifier dispatch.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class ApmeClassifierBackendTests: XCTestCase {

    // MARK: - SSOT invariants (mirrors shared/src/__tests__/apme-classifier-rules-sync.test.ts)

    func testBackendOrderNeverIncludesAPaidBackend() {
        XCTAssertFalse(ApmeClassifierRules.backendOrder.contains("api"))
        XCTAssertFalse(ApmeClassifierRules.backendOrder.contains("openai"))
        XCTAssertFalse(ApmeClassifierRules.backendOrder.contains("openclaw"))
        XCTAssertEqual(ApmeClassifierRules.backendOrder.last, "rules",
                       "'rules' is a give-up, not a network call, and must be last")
    }

    /// Mutation-check: `classifyWithBackend` is a closed switch over the
    /// SSOT's own vocabulary. Passing "api"/"openai" directly — as a mutant
    /// that widened the switch, or a caller that read `config.judge.backend`
    /// instead of the SSOT order — must still return nil, never reach
    /// `ApmeJudgeApi`/`ApmeJudgeOpenAI`.
    func testClassifyWithBackendRefusesAPaidBackendEvenIfAsked() async {
        var config = ApmeConfig()
        config.judge.backend = .api
        config.judge.model = "claude-opus-5"

        let apiResult = await ApmeClassifier.classifyWithBackend("api", prompt: "p", config: config)
        XCTAssertNil(apiResult, "the classifier dispatch has no case for \"api\" — this must stay nil")

        let openaiResult = await ApmeClassifier.classifyWithBackend("openai", prompt: "p", config: config)
        XCTAssertNil(openaiResult)
    }

    /// End-to-end mutation check: even with the eval judge configured to the
    /// paid `api` backend and every SSOT backend unreachable, the classifier
    /// must land on the rule-based category — never attempt, and never
    /// silently succeed via, a paid call.
    func testClassifyWithLlmNeverReachesAPaidBackendEvenWhenJudgeIsConfiguredToIt() async {
        var config = ApmeConfig()
        config.judge.backend = .api
        config.judge.model = "claude-opus-5"
        config.judge.endpoint = "http://127.0.0.1:65999/v1/chat/completions" // unreachable, MLX leg only

        let signals = TaskSignals()
        let expectedRuleCategory = ApmeClassifier.classify(signals)

        let mlxTransport = ScriptedFailingTransport()
        let category = await ApmeJudgeMlx.withTransportForTests({ b, u in mlxTransport.handle(b, u) }) {
            await ApmeClassifier.withFoundationModelsTransportForTests({ _ in nil }) {
                await ApmeClassifier.classifyWithLlm(
                    taskPrompt: "Investigate the current behavior", signals: signals, config: config)
            }
        }
        XCTAssertEqual(category, expectedRuleCategory)
    }

    // MARK: - Backend try-order

    /// Drives the REAL order (`ApmeClassifierRules.backendOrder`) with every
    /// backend stubbed to succeed, and asserts the FIRST network-reaching
    /// entry answers — whichever backend that is. This stays correct however
    /// the measured order resolves (foundationModels included or excluded),
    /// because it reads the order from the SSOT rather than hardcoding it.
    func testFirstBackendInOrderIsPreferredWhenAllSucceed() async {
        let mlxTransport = ScriptedTextTransport(["mlx-said-coding"])
        let fmCounter = CallCounter()

        let category = await ApmeJudgeMlx.withTransportForTests({ b, u in mlxTransport.handle(b, u) }) {
            await ApmeClassifier.withFoundationModelsTransportForTests({ _ in
                fmCounter.increment()
                return "fm-said-coding"
            }) {
                var config = ApmeConfig()
                config.judge.model = "test-model"
                config.judge.endpoint = "http://127.0.0.1:65990/v1/chat/completions"
                return await ApmeClassifier.classifyWithBackend(
                    ApmeClassifierRules.backendOrder.first(where: { $0 != "rules" }) ?? "mlx",
                    prompt: "p", config: config)
            }
        }
        XCTAssertNotNil(category)

        // Whichever backend is first, the OTHER one must not have been
        // reached by this single-backend dispatch call.
        if ApmeClassifierRules.backendOrder.first == "foundationModels" {
            XCTAssertEqual(fmCounter.count, 1)
            XCTAssertEqual(mlxTransport.sentCount, 0)
        } else if ApmeClassifierRules.backendOrder.first == "mlx" {
            XCTAssertEqual(mlxTransport.sentCount, 1)
            XCTAssertEqual(fmCounter.count, 0)
        }
    }

    /// `classifyWithLlm` walks the FULL order and falls through on failure,
    /// down to the rule-based category when nothing in the order answers.
    func testClassifyWithLlmFallsThroughEveryBackendToRules() async {
        let signals = TaskSignals()
        let expected = ApmeClassifier.classify(signals)
        let mlxTransport = ScriptedFailingTransport()
        var config = ApmeConfig()
        config.judge.model = "test-model" // skip the /v1/models auto-detect

        let category = await ApmeJudgeMlx.withTransportForTests({ b, u in mlxTransport.handle(b, u) }) {
            await ApmeClassifier.withFoundationModelsTransportForTests({ _ in nil }) {
                await ApmeClassifier.classifyWithLlm(
                    taskPrompt: "Investigate the current behavior", signals: signals, config: config)
            }
        }
        XCTAssertEqual(category, expected)
    }

    /// A backend answering with a label outside `ApmeClassifierRules.labels`
    /// must not be accepted — `classifyWithLlm` falls through exactly as if
    /// that backend had failed outright.
    func testOutOfVocabularyAnswerFallsThroughToTheNextBackend() async {
        let signals = TaskSignals()
        let expected = ApmeClassifier.classify(signals)
        let mlxTransport = ScriptedTextTransport(["this is not a category at all"])
        var config = ApmeConfig()
        config.judge.model = "test-model" // skip the /v1/models auto-detect

        let category = await ApmeJudgeMlx.withTransportForTests({ b, u in mlxTransport.handle(b, u) }) {
            await ApmeClassifier.withFoundationModelsTransportForTests({ _ in nil }) {
                await ApmeClassifier.classifyWithLlm(
                    taskPrompt: "Investigate the current behavior", signals: signals, config: config)
            }
        }
        XCTAssertEqual(category, expected)
    }

    /// A valid label from the FIRST backend in order is accepted directly —
    /// exact match, no partial-match ambiguity.
    func testValidLabelFromMlxIsAcceptedWhenMlxLeadsTheOrder() async throws {
        try XCTSkipUnless(ApmeClassifierRules.backendOrder.first == "mlx",
                          "this vector is specific to an mlx-first order")
        let signals = TaskSignals()
        let mlxTransport = ScriptedTextTransport(["coding"])
        var config = ApmeConfig()
        config.judge.model = "test-model"
        config.judge.endpoint = "http://127.0.0.1:65991/v1/chat/completions"

        let category = await ApmeJudgeMlx.withTransportForTests({ b, u in mlxTransport.handle(b, u) }) {
            await ApmeClassifier.classifyWithLlm(
                taskPrompt: "Fix the failing test", signals: signals, config: config)
        }
        XCTAssertEqual(category, .coding)
    }

    // MARK: - max_tokens / timeout stay the classifier's own small budget

    func testMlxClassificationSendsTheSharedMaxTokensCapNotTheJudgeBudget() async {
        let mlxTransport = ScriptedTextTransport(["coding"])
        var config = ApmeJudgeConfig()
        config.model = "test-model"
        config.endpoint = "http://127.0.0.1:65992/v1/chat/completions"

        _ = await ApmeJudgeMlx.withTransportForTests({ b, u in mlxTransport.handle(b, u) }) {
            await ApmeJudgeMlx.classifyTaskCategory(prompt: "p", config: config)
        }
        XCTAssertEqual(mlxTransport.sent.first?["max_tokens"] as? Int, ApmeClassifierRules.maxTokens)
        XCTAssertLessThanOrEqual(ApmeClassifierRules.maxTokens, 20)
        XCTAssertFalse(mlxTransport.sent.first?.keys.contains("repetition_penalty") ?? true,
                       "classification is not a judge verdict — no repetition_penalty")
    }

    // MARK: - Label normalization (mirrors shared/src/apme-classifier-rules.ts)

    func testNormalizeLabelExactAndPartialMatch() {
        XCTAssertEqual(ApmeClassifierRules.normalizeLabel("coding"), "coding")
        XCTAssertEqual(ApmeClassifierRules.normalizeLabel("  Coding!  "), "coding")
        XCTAssertEqual(ApmeClassifierRules.normalizeLabel("The answer is coding."), "coding")
        XCTAssertNil(ApmeClassifierRules.normalizeLabel("not a real label"))
    }

    // MARK: - Test doubles

    /// A plain `var` captured and mutated inside a `@Sendable` closure is a
    /// Swift 6 concurrency error, not a warning — this is the lock-backed
    /// counter every such closure in this file uses instead.
    private final class CallCounter: @unchecked Sendable {
        private var value = 0
        private let lock = NSLock()
        func increment() { lock.lock(); value += 1; lock.unlock() }
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    }

    /// Every attempt fails — the classifier must fall through past this
    /// backend without throwing or hanging.
    private final class ScriptedFailingTransport: @unchecked Sendable {
        private(set) var sentCount = 0
        private let lock = NSLock()
        func handle(_ body: [String: Any], _ url: URL) -> ApmeJudgeMlx.JudgeAttempt {
            lock.lock(); sentCount += 1; lock.unlock()
            return .transportFailure
        }
    }

    /// Replies with the chat-completions text a real `.ok` verdict would
    /// carry, one scripted reply per call in order.
    private final class ScriptedTextTransport: @unchecked Sendable {
        private let replies: [String]
        private(set) var sent: [[String: Any]] = []
        private let lock = NSLock()
        init(_ replies: [String]) { self.replies = replies }
        var sentCount: Int { lock.lock(); defer { lock.unlock() }; return sent.count }
        func handle(_ body: [String: Any], _ url: URL) -> ApmeJudgeMlx.JudgeAttempt {
            lock.lock()
            let i = sent.count
            sent.append(body)
            lock.unlock()
            guard i < replies.count else { return .transportFailure }
            return .ok(replies[i])
        }
    }
}
#endif
