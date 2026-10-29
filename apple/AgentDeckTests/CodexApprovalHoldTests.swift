#if os(macOS)
import XCTest
@testable import AgentDeck

/// Codex device approvals (the opt-in `PermissionRequest` hold). Replays
/// shared/codex-approval-hold-vectors.json, as bridge/src/__tests__/
/// codex-approval-hold.test.ts and hooks/src/__tests__/codex-install.test.ts do.
final class CodexApprovalHoldTests: XCTestCase {

    private func vectors() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/codex-approval-hold-vectors.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    // MARK: - Installer

    func testInstallerEmitsTheSharedHoldCommand() throws {
        // Codex hashes the command for trust: a one-byte drift between the two
        // installers would put every user back on the review screen.
        XCTAssertEqual(CodexConfigInstaller.buildApprovalHoldCommand(), try vectors()["posixHoldCommand"] as? String)
        XCTAssertEqual(CodexConfigInstaller.approvalHoldHeader.lowercased(), CodexApprovalHoldRules.header)
    }

    func testInstallerWritesTheSharedPermissionRequestGroup() throws {
        let group = try XCTUnwrap(try vectors()["posixPermissionRequestGroup"] as? String)
        XCTAssertTrue(CodexConfigInstaller.managedBlockBody(includeApprovalHold: true).contains(group))
    }

    func testHoldIsASecondHandlerAndLeavesEveryOtherByteAlone() {
        let plain = CodexConfigInstaller.managedBlockBody(includeOtel: false)
        let held = CodexConfigInstaller.managedBlockBody(includeOtel: false, includeApprovalHold: true)
        let hold = [
            "[[hooks.PermissionRequest.hooks]]",
            "type = \"command\"",
            "command = \(MiniToml.quoted(CodexConfigInstaller.buildApprovalHoldCommand()))",
            "timeout = 60",
        ].joined(separator: "\n")
        XCTAssertEqual(held.replacingOccurrences(of: "\n" + hold, with: ""), plain)
        XCTAssertEqual(held.components(separatedBy: "[[hooks.PermissionRequest]]").count - 1, 1)
        XCTAssertFalse(plain.contains(CodexConfigInstaller.approvalHoldHeader))
    }

    func testPolicyIsOffByDefaultOnWhenAskedKeptByARefreshAndRemovedWhenOff() throws {
        let original = "model = \"gpt-5\"\n"
        let plain = try CodexConfigInstaller.preparedConfig(original, daemonHttpPort: 9120)
        XCTAssertFalse(CodexConfigInstaller.hasApprovalHold(plain))

        let held = try CodexConfigInstaller.preparedConfig(plain, daemonHttpPort: 9120, approvals: .on)
        XCTAssertTrue(CodexConfigInstaller.hasApprovalHold(held))
        // The install pass at every daemon start must neither add nor drop it.
        XCTAssertEqual(try CodexConfigInstaller.preparedConfig(held, daemonHttpPort: 9120), held)
        XCTAssertEqual(try CodexConfigInstaller.preparedConfig(plain, daemonHttpPort: 9120), plain)

        let off = try CodexConfigInstaller.preparedConfig(held, daemonHttpPort: 9120, approvals: .off)
        XCTAssertEqual(off, plain)
        XCTAssertEqual(MiniToml.removeManagedBlock(in: held), original)
    }

    func testHoldKeepsTrustRecordsAndAUserGroupOutsideTheFence() throws {
        let user = [
            "[[hooks.PermissionRequest]]",
            "[[hooks.PermissionRequest.hooks]]",
            "type = \"command\"",
            "command = \"workmux set-window-status waiting\"",
            "",
            "[hooks.state]",
            "",
            "[hooks.state.\"/Users/me/.codex/config.toml:permission_request:0:0\"]",
            "trusted_hash = \"sha256:abc\"",
        ].joined(separator: "\n")
        let installed = try CodexConfigInstaller.preparedConfig(user, daemonHttpPort: 9120)
        let held = try CodexConfigInstaller.preparedConfig(installed, daemonHttpPort: 9120, approvals: .on)
        XCTAssertEqual(MiniToml.removeManagedBlock(in: held), MiniToml.removeManagedBlock(in: installed))
        XCTAssertTrue(held.contains("trusted_hash = \"sha256:abc\""))
        XCTAssertTrue(held.contains("command = \"workmux set-window-status waiting\""))
    }

    func testOnlyAManagedCommandCountsAsTheHold() {
        let outside = "[[hooks.PermissionRequest]]\n[[hooks.PermissionRequest.hooks]]\ntype = \"command\"\ncommand = \"curl -H 'X-AgentDeck-Hold: 55' x\""
        XCTAssertFalse(CodexConfigInstaller.hasApprovalHold(outside))
        let comment = MiniToml.applyManagedBlock(in: "", body: "# X-AgentDeck-Hold is documented elsewhere")
        XCTAssertFalse(CodexConfigInstaller.hasApprovalHold(comment))
    }

    // MARK: - Daemon rules

    func testReviewerRecords() throws {
        let rows = try XCTUnwrap(try vectors()["reviewerRecords"] as? [[String: Any]])
        for row in rows {
            let records = try XCTUnwrap(row["records"] as? [Any])
            let lines = try records.map { record in
                String(decoding: try JSONSerialization.data(withJSONObject: record, options: [.fragmentsAllowed]), as: UTF8.self)
            }
            let text = (["torn line"] + lines + ["{incomplete"]).joined(separator: "\n")
            XCTAssertEqual(CodexApprovalHoldRules.reviewer(inRollout: text, turnId: row["turnId"] as? String),
                           row["reviewer"] as? String, row["name"] as? String ?? "?")
        }
    }

    func testOnlyConfirmedHumanReviewCreatesAttentionOrAHold() throws {
        let rows = try XCTUnwrap(try vectors()["reviewerDecisions"] as? [[String: Any]])
        for row in rows {
            XCTAssertEqual(CodexApprovalHoldRules.needsHuman(row["reviewer"] as? String),
                           row["needsHuman"] as? Bool, String(describing: row["reviewer"]))
        }
    }

    func testLongRolloutRetainsTheActualReviewer() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let context = "{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"mcp-turn\",\"approvals_reviewer\":\"auto_review\"}}\n"
        try (context + String(repeating: "x", count: 2 * CodexApprovalHoldRules.contextBytes + 1)).write(
            to: file, atomically: true, encoding: .utf8)
        let reviewer = CodexRolloutResponseReader.approvalReviewer(
            sessionId: "mcp-session", transcriptPath: file.path, turnId: "mcp-turn")
        XCTAssertEqual(reviewer, "auto_review")
        XCTAssertFalse(CodexApprovalHoldRules.needsHuman(reviewer))
        let user = context.replacingOccurrences(of: "auto_review", with: "user")
        try (user + String(repeating: "x", count: 2 * CodexApprovalHoldRules.contextBytes + 1)).write(
            to: file, atomically: true, encoding: .utf8)
        XCTAssertTrue(CodexApprovalHoldRules.needsHuman(CodexRolloutResponseReader.approvalReviewer(
            sessionId: "mcp-session", transcriptPath: file.path, turnId: "mcp-turn")))
    }

    func testSettingsRecordLargerThanTheReadWindowIsNotDiscarded() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let record: [String: Any] = ["type": "turn_context", "payload": ["turn_id": "large-turn",
            "approvals_reviewer": "user", "developer_instructions": String(repeating: "x", count: 2 * CodexApprovalHoldRules.contextBytes + 4096)]]
        // JSONSerialization may reorder fields: write the canonical JSONL
        // header explicitly, as Codex does, to exercise the extension path.
        let payload = try JSONSerialization.data(withJSONObject: record["payload"]!)
        var data = Data("{\"type\":\"turn_context\",\"payload\":".utf8)
        data.append(payload); data.append(Data("}\n".utf8))
        try data.write(to: file)
        XCTAssertEqual(CodexRolloutResponseReader.approvalReviewer(
            sessionId: "large", transcriptPath: file.path, turnId: "large-turn"), "user")
    }

    func testLatestUnknownAndRewrittenSettingsDoNotReuseAnOlderUser() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: file) }
        let user = "{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"t1\",\"approvals_reviewer\":\"user\"}}\n"
        let unknown = "{\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"t1\"}}\n"
        let gap = String(repeating: "x", count: CodexApprovalHoldRules.contextBytes + 4096)
        func read() -> String? { CodexRolloutResponseReader.approvalReviewer(sessionId: "s", transcriptPath: file.path, turnId: "t1") }
        try (user + gap).write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(read(), "user")
        try (user + unknown + gap).write(to: file, atomically: true, encoding: .utf8)
        XCTAssertNil(read())
        try user.replacingOccurrences(of: "user", with: "auto_review").write(to: file, atomically: true, encoding: .utf8)
        XCTAssertEqual(read(), "auto_review")
        try "".write(to: file, atomically: true, encoding: .utf8)
        XCTAssertNil(read())
    }

    func testFileWorkDoesNotBlockTheDaemonExecutor() async {
        let pending = Task { await CodexApprovalReadWorker.read { _ in
            Thread.sleep(forTimeInterval: 0.1)
            return "user"
        } }
        // This must run while the read worker is occupied.
        let marker = await DaemonActor.run { "daemon-responsive" }
        XCTAssertEqual(marker, "daemon-responsive")
        let reviewer = await pending.value
        XCTAssertEqual(reviewer, "user")
    }

    func testCanonicalSettingsPrefixes() throws {
        for row in try XCTUnwrap(try vectors()["reviewerPrefixes"] as? [[String: Any]]) {
            XCTAssertEqual(CodexApprovalHoldRules.isSettingsPrefix(try XCTUnwrap(row["text"] as? String)),
                           row["settings"] as? Bool)
        }
    }

    func testHeaderAndDecisionBodies() throws {
        let v = try vectors()
        XCTAssertEqual(CodexApprovalHoldRules.header, v["header"] as? String)
        let rows = try XCTUnwrap(v["decisions"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 4)
        for row in rows {
            let decision = try XCTUnwrap(row["decision"] as? String)
            let body = CodexApprovalHoldRules.decisionBody(decision)
            if row["body"] is NSNull {
                XCTAssertEqual(body, "", decision)
            } else {
                let expected = try XCTUnwrap(row["body"] as? NSDictionary)
                let actual = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(body.utf8)) as? NSDictionary, decision)
                XCTAssertEqual(actual, expected, decision)
                // The hook prints only an answer that names the output key.
                XCTAssertTrue(body.contains("\"hookSpecificOutput\""), decision)
            }
        }
    }

    func testBudgets() throws {
        let rows = try XCTUnwrap(try vectors()["budgets"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? "?"
            let header = try XCTUnwrap(row["header"] as? String, name)
            let defaultMs = try XCTUnwrap(row["defaultMs"] as? Int, name)
            XCTAssertEqual(
                CodexApprovalHoldRules.holdMilliseconds(header: header, defaultMs: defaultMs, elapsedMs: row["elapsedMs"] as? Int ?? 0),
                row["holdMs"] as? Int, name)
        }
        XCTAssertNil(CodexApprovalHoldRules.holdMilliseconds(header: nil, defaultMs: 25_000))
    }

    func testEligibility() throws {
        let v = try vectors()
        let defaults = try XCTUnwrap(v["eligibilityDefaults"] as? [String: Any])
        let rows = try XCTUnwrap(v["eligibility"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? "?"
            let input = defaults.merging(try XCTUnwrap(row["input"] as? [String: Any], name)) { _, new in new }
            let verdict = CodexApprovalHoldRules.decision(.init(
                enabled: try XCTUnwrap(input["enabled"] as? Bool, name),
                clientCount: try XCTUnwrap(input["clientCount"] as? Int, name),
                sessionId: try XCTUnwrap(input["sessionId"] as? String, name),
                background: try XCTUnwrap(input["background"] as? Bool, name),
                execChild: try XCTUnwrap(input["execChild"] as? Bool, name),
                visible: try XCTUnwrap(input["visible"] as? Bool, name),
                alreadyHeld: try XCTUnwrap(input["alreadyHeld"] as? Bool, name)))
            XCTAssertEqual(verdict.hold, row["hold"] as? Bool, name)
            XCTAssertEqual(verdict.reason, row["reason"] as? String, name)
        }
    }

    func testReleasingEvents() throws {
        let v = try vectors()
        XCTAssertEqual(CodexApprovalHoldRules.releasingEvents, Set(try XCTUnwrap(v["releasingEvents"] as? [String])))
        for event in try XCTUnwrap(v["nonReleasingEvents"] as? [String]) {
            XCTAssertFalse(CodexApprovalHoldRules.releasingEvents.contains(event), event)
        }
    }

    func testPresses() throws {
        let rows = try XCTUnwrap(try vectors()["presses"] as? [[String: Any]])
        XCTAssertFalse(rows.isEmpty)
        for row in rows {
            let name = row["name"] as? String ?? "?"
            let press = try XCTUnwrap(row["press"] as? [String: Any], name)
            XCTAssertEqual(
                CodexApprovalHoldRules.pressDecision(
                    type: press["type"] as? String ?? "", index: press["index"] as? Int,
                    value: press["value"] as? String),
                row["decision"] as? String, name)
        }
    }

    // MARK: - A deck press on an open hold
    //
    // `codexApprovalPress` is what `DaemonServer.answerCodexApproval` decides
    // with; the routing that calls it lives in `handleCommand`, which has no
    // test seam (the Node e2e suite drives the same routes on a real daemon).

    func testAPressAnswersTheOpenHoldWithTheSharedDecision() throws {
        let v = try vectors()
        let question = try XCTUnwrap(v["capturedQuestion"] as? String)
        for row in try XCTUnwrap(v["presses"] as? [[String: Any]]) {
            let name = row["name"] as? String ?? "?"
            let press = try XCTUnwrap(row["press"] as? [String: Any], name)
            let verdict = DaemonServer.codexApprovalPress(
                command: press, heldRequestId: "req-1", shownRequestId: "req-1", shownQuestion: question)
            let type = press["type"] as? String
            if type != "select_option" && type != "respond" {
                XCTAssertNil(verdict, name)
            } else if let decision = row["decision"] as? String {
                XCTAssertEqual(verdict, .answer(requestId: "req-1", decision: decision), name)
            } else {
                XCTAssertEqual(verdict, .notAnAnswer, name)
            }
        }
    }

    func testAPressWithNoOpenHoldTakesItsUsualRoute() {
        XCTAssertNil(DaemonServer.codexApprovalPress(
            command: ["type": "select_option", "index": 0], heldRequestId: nil,
            shownRequestId: nil, shownQuestion: "Approve Bash: ls"))
    }

    func testAPressEchoingAPromptTheHoldDoesNotShowIsDropped() throws {
        let question = try XCTUnwrap(try vectors()["capturedQuestion"] as? String)
        func press(_ echo: String?, shownRequestId: String? = "req-1") -> DaemonServer.CodexApprovalPress? {
            var command: [String: Any] = ["type": "select_option", "index": 0]
            if let echo { command["question"] = echo }
            return DaemonServer.codexApprovalPress(
                command: command, heldRequestId: "req-1", shownRequestId: shownRequestId, shownQuestion: question)
        }
        let answer = DaemonServer.CodexApprovalPress.answer(requestId: "req-1", decision: "allow")
        XCTAssertEqual(press(question), answer)
        // A device that cut the question short still names it.
        XCTAssertEqual(press(String(question.prefix(26))), answer)
        XCTAssertEqual(press("Approve Bash: rm -rf build"), .stale)
        // The row no longer carries this hold's button.
        XCTAssertEqual(press(question, shownRequestId: nil), .stale)
        // No echo leaves nothing to check: the open hold is answered.
        XCTAssertEqual(press(nil, shownRequestId: nil), answer)
    }

    // MARK: - permission_decision names its approval

    /// A decision for a hold or gate that is already answered must not fall
    /// through to the OpenClaw approval that happens to be up — it used to
    /// approve it (`allow` → allow-once).
    func testADecisionResolvesOnlyTheOpenClawApprovalItNames() async throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("tests/parity/gateway-frames/exec-approval-requested.json")
        let frame = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let payload = try XCTUnwrap(frame["payload"] as? [String: Any])
        let approvalId = try XCTUnwrap(payload["id"] as? String)

        let adapter = OpenClawAdapter(gatewayUrl: "ws://127.0.0.1:9")
        let none = await adapter.resolvePendingApproval(requestId: approvalId, decision: "allow")
        XCTAssertFalse(none, "no approval is up")
        await adapter.receiveGatewayEventForTesting("exec.approval.requested", payload: payload)
        let shown = await adapter.activeApprovalId()
        XCTAssertEqual(shown, approvalId)

        let unknown = await adapter.resolvePendingApproval(
            requestId: "019a0000-0000-7000-8000-00000000c0de", decision: "allow")
        XCTAssertFalse(unknown, "an id the approval does not carry resolves nothing")
        let named = await adapter.resolvePendingApproval(requestId: approvalId, decision: "allow")
        XCTAssertTrue(named, "the approval's own id still resolves it")

        // Clear it, which also stops its reconcile watch.
        await adapter.receiveGatewayEventForTesting("exec.approval.resolved", payload: ["id": approvalId])
        let cleared = await adapter.activeApprovalId()
        XCTAssertNil(cleared)
    }

    func testCapturedRequestReadsAsTheSharedQuestionOnItsSessionRow() throws {
        let v = try vectors()
        let request = try XCTUnwrap(v["capturedPermissionRequest"] as? [String: Any])
        XCTAssertEqual(DaemonServer.codexPermissionQuestion(request), v["capturedQuestion"] as? String)
        let thread = try XCTUnwrap(request["session_id"] as? String)
        XCTAssertEqual(DaemonServer.hookSessionId(event: "codex_permission_request", json: request), "codex:\(thread)")
    }

    // MARK: - Gate

    func testCodexGateKeepsOnePerSessionAndAnswersADeviceDecision() async {
        let steering = ObservedSteering()
        guard ObservedSteering.gateEnabled else { return } // AGENTDECK_OBSERVED_APPROVAL=0
        let sid = "codex:019a0000-0000-7000-8000-000000000001"
        let requestId = await steering.beginCodexGate(sessionId: sid, clientCount: 1, holdSeconds: 5)
        XCTAssertNotNil(requestId)
        let busy = await steering.beginCodexGate(sessionId: sid, clientCount: 1, holdSeconds: 5)
        XCTAssertNil(busy, "a second approval in the same session passes to its terminal prompt")
        let noClients = await steering.beginCodexGate(sessionId: "codex:other", clientCount: 0, holdSeconds: 5)
        XCTAssertNil(noClients)

        let held = Task { await steering.awaitGate(requestId: requestId!) }
        // Give awaitGate a moment to install its continuation.
        try? await Task.sleep(nanoseconds: 50_000_000)
        let affected = await steering.resolveGate(requestId: requestId!, decision: "deny")
        XCTAssertEqual(affected, sid)
        let decision = await held.value
        XCTAssertEqual(decision, "deny")
        let again = await steering.beginCodexGate(sessionId: sid, clientCount: 1, holdSeconds: 5)
        XCTAssertNotNil(again)
    }

    func testCodexGateEndsWithItsTurn() async {
        let steering = ObservedSteering()
        guard ObservedSteering.gateEnabled else { return }
        let sid = "codex:019a0000-0000-7000-8000-000000000002"
        let requestId = await steering.beginCodexGate(sessionId: sid, clientCount: 1, holdSeconds: 5)
        let held = Task { await steering.awaitGate(requestId: requestId!) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        let ended = await steering.endGate(requestId: requestId!)
        XCTAssertEqual(ended, sid)
        let outcome = await held.value
        XCTAssertEqual(outcome, "ended")
        let late = await steering.resolveGate(requestId: requestId!, decision: "allow")
        XCTAssertNil(late, "a press after the turn ended answers nothing")
    }

    func testCodexGateTimesOutOnItsOwnBudget() async {
        let steering = ObservedSteering()
        guard ObservedSteering.gateEnabled else { return }
        let requestId = await steering.beginCodexGate(
            sessionId: "codex:019a0000-0000-7000-8000-000000000003", clientCount: 1, holdSeconds: 0.2)
        let started = Date()
        let outcome = await steering.awaitGate(requestId: requestId!)
        XCTAssertEqual(outcome, "pass")
        // Far below the permission gate's default hold (25 s).
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }
}
#endif
