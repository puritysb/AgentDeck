#if os(macOS)
// Desktop-vs-TUI detection from a Codex rollout's first line.
//
// The fixture lines are patterned on a line captured from a live store
// (~/.codex/sessions/2026/09/01/rollout-…jsonl, 2026-09-01) rather than
// composed from the parser's own field list — a fixture built from what the
// reader expects agrees with it forever. The originator VALUES are the ones a
// 200-rollout survey of that store actually held: "Codex Desktop",
// "codex-tui", "codex_cli_rs", "codex_vscode", "codex_exec".

import XCTest
@testable import AgentDeck

final class CodexOriginatorTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codex-originator-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("2026/09/01"),
            withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func writeRollout(id: String, firstLine: String, extraLines: [String] = []) throws {
        let url = root.appendingPathComponent(
            "2026/09/01/rollout-2026-09-01T00-52-37-\(id).jsonl")
        let body = ([firstLine] + extraLines).joined(separator: "\n") + "\n"
        try body.data(using: .utf8)!.write(to: url)
    }

    private func metaLine(originator: String, id: String, instructionBytes: Int = 20_000) -> String {
        // Shape captured off a live rollout — keys and nesting verbatim. The
        // base_instructions bulk is load-bearing, not decoration: real first
        // lines measure 18–22 KB (20-rollout survey, 2026-09-01), and a
        // fixture patterned on a `head -c 600` capture hid that the 8 KB head
        // window truncated every real line into a no-claim verdict.
        let instructions = String(repeating: "x", count: instructionBytes)
        return """
        {"timestamp":"2026-08-31T15:53:40.772Z","ordinal":0,"type":"session_meta","payload":{"session_id":"\(id)","id":"\(id)","timestamp":"2026-08-31T15:52:37.127Z","cwd":"/Users/u/project","originator":"\(originator)","cli_version":"0.150.0-alpha.8","source":"vscode","thread_source":"user","model_provider":"openai","base_instructions":{"text":"\(instructions)"}}}
        """
    }

    func testDesktopOriginatorIsDesktop() throws {
        let id = "01a05885-c5e3-7ce0-9c45-06ec2f04a6fd"
        try writeRollout(id: id, firstLine: metaLine(originator: "Codex Desktop", id: id))
        XCTAssertEqual(
            CodexRolloutResponseReader.originatorIsDesktop(sessionId: id, sessionsRoot: root),
            true)
    }

    func testTuiOriginatorsAreNotDesktop() throws {
        for (index, originator) in ["codex-tui", "codex_cli_rs", "codex_vscode", "codex_exec"].enumerated() {
            let id = "0000000\(index)-c5e3-7ce0-9c45-06ec2f04a6fd"
            try writeRollout(id: id, firstLine: metaLine(originator: originator, id: id))
            XCTAssertEqual(
                CodexRolloutResponseReader.originatorIsDesktop(sessionId: id, sessionsRoot: root),
                false, originator)
        }
    }

    func testHookSessionIdPrefixIsAccepted() throws {
        // The hook path synthesizes ids as `codex:<uuid>`; locateRollout
        // strips the prefix, and the verdict must ride through it.
        let id = "11a05885-c5e3-7ce0-9c45-06ec2f04a6fd"
        try writeRollout(id: id, firstLine: metaLine(originator: "Codex Desktop", id: id))
        XCTAssertEqual(
            CodexRolloutResponseReader.originatorIsDesktop(
                sessionId: "codex:\(id)", sessionsRoot: root),
            true)
    }

    func testMissingRolloutMakesNoClaim() {
        XCTAssertNil(CodexRolloutResponseReader.originatorIsDesktop(
            sessionId: "22a05885-c5e3-7ce0-9c45-06ec2f04a6fd", sessionsRoot: root))
    }

    func testUnparseableFirstLineMakesNoClaim() throws {
        // "Could not read" must never collapse into "not desktop" at THIS
        // layer — the caller retries; a cached false would stick forever.
        let id = "33a05885-c5e3-7ce0-9c45-06ec2f04a6fd"
        try writeRollout(id: id, firstLine: "{\"type\":\"session_meta\",\"payload\"")
        XCTAssertNil(CodexRolloutResponseReader.originatorIsDesktop(
            sessionId: id, sessionsRoot: root))
    }

    func testOnlyTheFirstLineDecides() throws {
        // A later line claiming a different originator is not session_meta's
        // to override; the head is written once at session open.
        let id = "44a05885-c5e3-7ce0-9c45-06ec2f04a6fd"
        try writeRollout(
            id: id,
            firstLine: metaLine(originator: "codex-tui", id: id),
            extraLines: [#"{"type":"event_msg","payload":{"type":"agent_message","message":"Codex Desktop"}}"#])
        XCTAssertEqual(
            CodexRolloutResponseReader.originatorIsDesktop(sessionId: id, sessionsRoot: root),
            false)
    }

    func testSubagentSourceInRealSizedHeadIsExplicitChildEvidence() throws {
        let id = "01a10bf8-45c3-72c0-a7fc-9d8334961f5d"
        let line = metaLine(originator: "Codex Desktop", id: id, instructionBytes: 22_952)
            .replacingOccurrences(of: #""source":"vscode""#,
                with: #""source":{"subagent":{"thread_spawn":{"parent_thread_id":"019f364e-d68c-7c33-9215-069c76458d62"}}}"#)
        try writeRollout(id: id, firstLine: line)
        let meta = try XCTUnwrap(CodexRolloutResponseReader.sessionMeta(sessionId: id, sessionsRoot: root))
        XCTAssertEqual(meta.isSubagent, true)
        XCTAssertEqual(meta.originator, "Codex Desktop")
        XCTAssertEqual(meta.cwd, "/Users/u/project")
    }

    func testStandaloneAndUnknownMetadataRemainDistinct() throws {
        let id = "55a05885-c5e3-7ce0-9c45-06ec2f04a6fd"
        try writeRollout(id: id, firstLine: metaLine(originator: "codex_exec", id: id))
        XCTAssertEqual(CodexRolloutResponseReader.sessionMeta(sessionId: id, sessionsRoot: root)?.isSubagent, false)
        XCTAssertNil(CodexRolloutSessionMeta(originator: "codex_exec", cwd: "/repo").isSubagent)
        for extra: [String: Any] in [[:], ["source": [:]], ["parent_thread_id": "parent"], ["thread_source": "subagent"]] {
            var payload = extra
            payload["id"] = id
            XCTAssertNil(CodexRolloutResponseReader.subagentVerdict(payload: payload, sessionId: id))
        }
        XCTAssertEqual(CodexRolloutResponseReader.subagentVerdict(
            payload: ["id": id, "thread_source": "subagent", "parent_thread_id": "parent"], sessionId: id), true)
    }

    func testMissingOrMismatchedIdCannotClassifyTheRequestedThread() {
        let id = "66a05885-c5e3-7ce0-9c45-06ec2f04a6fd"
        XCTAssertNil(CodexRolloutResponseReader.subagentVerdict(payload: ["source": ["subagent": [:]]], sessionId: id))
        XCTAssertNil(CodexRolloutResponseReader.subagentVerdict(
            payload: ["id": "77a05885-c5e3-7ce0-9c45-06ec2f04a6fd", "source": ["subagent": [:]]], sessionId: id))
        XCTAssertEqual(CodexRolloutResponseReader.subagentVerdict(
            payload: ["id": id, "source": "cli"], sessionId: "codex:\(id)"), false)
    }

    func testTruncatedSubagentHeadMakesNoClaim() throws {
        let id = "88a05885-c5e3-7ce0-9c45-06ec2f04a6fd"
        try writeRollout(id: id, firstLine: metaLine(originator: "Codex Desktop", id: id,
            instructionBytes: ObservedAgentRules.codexMetadataHeadBytes + 1))
        XCTAssertNil(CodexRolloutResponseReader.sessionMeta(sessionId: id, sessionsRoot: root))
    }

    func testLegacyOriginatorAndCwdRemainReadableWhenIdCannotProveClassification() throws {
        let id = "99a05885-c5e3-7ce0-9c45-06ec2f04a6fd"
        try writeRollout(id: id, firstLine:
            #"{"type":"session_meta","payload":{"originator":"Codex Desktop","cwd":"/legacy","source":{"subagent":{}}}}"#)
        let meta = try XCTUnwrap(CodexRolloutResponseReader.sessionMeta(sessionId: id, sessionsRoot: root))
        XCTAssertEqual(meta.originator, "Codex Desktop")
        XCTAssertEqual(meta.cwd, "/legacy")
        XCTAssertNil(meta.isSubagent)
        XCTAssertEqual(CodexRolloutResponseReader.originatorIsDesktop(sessionId: id, sessionsRoot: root), true)
    }
}

/// Replays shared/codex-ambient-vectors.json — the same file the Node suite
/// replays — so one Codex prompt cannot be background on one daemon and a
/// user task on the other.
final class CodexAmbientHookRulesTests: XCTestCase {
    private func vectors() throws -> [[String: Any]] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/codex-ambient-vectors.json")
        let data = try Data(contentsOf: url)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(root["vectors"] as? [[String: Any]])
    }

    func testEveryVectorMatchesTheNodeSSOT() throws {
        let cases = try vectors()
        XCTAssertGreaterThan(cases.count, 0)
        for c in cases {
            let name = c["name"] as? String ?? ""
            let prompt = try XCTUnwrap(c["prompt"] as? String)
            let expected = try XCTUnwrap(c["ambient"] as? Bool)
            XCTAssertEqual(CodexAmbientHookRules.isAmbientPrompt(prompt), expected, name)
        }
    }

    func testEveryBackgroundCwdVectorMatchesTheNodeSSOT() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/codex-ambient-vectors.json")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let cases = try XCTUnwrap(root["cwdVectors"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 0)
        for c in cases {
            let name = c["name"] as? String ?? ""
            let expected = try XCTUnwrap(c["background"] as? Bool)
            XCTAssertEqual(CodexAmbientHookRules.isBackgroundCwd(c["cwd"], codexHome: c["codexHome"] as? String), expected, name)
        }
    }

    func testPromptTextReadsEveryKeyShapeCodexBuildsHaveSent() {
        let hyper = "Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for this project"
        XCTAssertEqual(CodexAmbientHookRules.promptText(["prompt": "a", "user_prompt": "b"]), "a")
        XCTAssertEqual(CodexAmbientHookRules.promptText(["user_prompt": "b"]), "b")
        XCTAssertEqual(CodexAmbientHookRules.promptText(["message": ["content": "c"]]), "c")
        XCTAssertEqual(CodexAmbientHookRules.promptText([:]), "")
        // A build that sends `user_prompt` must still be classified — the
        // Node classifier reads the same fallback chain.
        XCTAssertTrue(CodexAmbientHookRules.isAmbientPrompt(CodexAmbientHookRules.promptText(["user_prompt": hyper])))
    }

    func testNonStringPromptsAreNeverAmbient() {
        XCTAssertFalse(CodexAmbientHookRules.isAmbientPrompt(nil))
        XCTAssertFalse(CodexAmbientHookRules.isAmbientPrompt(["text": "Overview Generate 0 to 3 hyperpersonalized suggestions"]))
    }

    func testThreadsAreRememberedUntilSilentPastTheTTL() {
        var threads = CodexAmbientThreads()
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertFalse(threads.isAmbient("codex:amb", now: t0))
        threads.mark("codex:amb", now: t0)
        XCTAssertTrue(threads.isAmbient("codex:amb", now: t0.addingTimeInterval(CodexAmbientThreads.ttl - 1)))
        // The hook above refreshed the id; silence is measured from it.
        XCTAssertTrue(threads.isAmbient("codex:amb", now: t0.addingTimeInterval(CodexAmbientThreads.ttl + 60)))
        XCTAssertFalse(threads.isAmbient("codex:amb", now: t0.addingTimeInterval(3 * CodexAmbientThreads.ttl)))
        XCTAssertEqual(threads.count, 0)
        XCTAssertFalse(threads.isAmbient("codex:other", now: t0))
    }
}
#endif
