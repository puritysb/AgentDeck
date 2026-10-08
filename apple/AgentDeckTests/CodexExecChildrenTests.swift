#if os(macOS)
// Headless `codex exec` runs folded under their launcher — the reducer that
// mirrors bridge/src/codex-exec-children.ts. The process table is the shape
// captured live on 2026-10-01: claude → zsh → run.sh → xargs → bash → timeout
// → node → codex, with the `codex-code-mode-host` helper below the binary.
// The rollout cwd is `/private/tmp/…` while the argv says `-C /tmp/…`, as
// macOS does; `realpath` is faked so the tests never touch the filesystem.

import XCTest
@testable import AgentDeck

final class CodexExecChildrenTests: XCTestCase {
    private let claudeSid = "4f55869a-38a5-494c-8577-7afad72aae35"
    private let childKey = "codex:01a0f35b-74a5-7bc0-827d-ef80f440478e"
    private let cwd = "/tmp/scratch/gen/work/2020s_ai_ai"
    private let cwdReal = "/private/tmp/scratch/gen/work/2020s_ai_ai"

    private func row(_ pid: Int, _ ppid: Int, _ command: String) -> ProcessEnumerator.ProcessRow {
        ProcessEnumerator.ProcessRow(pid: pid, ppid: ppid, command: command)
    }

    private func batchTable() -> [ProcessEnumerator.ProcessRow] {
        [
            row(71456, 1872, "claude"),
            row(16524, 71456, "/bin/zsh -c source snapshot.sh && bash run.sh"),
            row(17382, 16524, "/bin/bash /tmp/scratch/gen/run.sh 4 1970s_mainframe_ai"),
            row(17384, 17382, "xargs -P 4 -I{} bash -c gen_one {}"),
            row(49448, 17384, "bash -c gen_one 2020s_ai_ai"),
            row(49451, 49448, "timeout 1500 codex exec --skip-git-repo-check -s workspace-write -C \(cwd) -"),
            row(49452, 49451, "node /opt/homebrew/bin/codex exec --skip-git-repo-check -s workspace-write -C \(cwd) -"),
            row(49460, 49452, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex exec --skip-git-repo-check -s workspace-write -C \(cwd) -"),
            row(49470, 49460, "/opt/homebrew/lib/node_modules/@openai/codex/vendor/bin/codex-code-mode-host"),
        ]
    }

    private var claudePeer: CodexExecPeer { CodexExecPeer(sessionId: claudeSid, pid: 71456) }
    private var headless: CodexRolloutSessionMeta { CodexRolloutSessionMeta(originator: "codex_exec", cwd: cwdReal) }
    private let fakeRealpath: (String) -> String = { $0.hasPrefix("/tmp/") ? "/private" + $0 : $0 }
    private func registry() -> CodexExecChildRegistry { CodexExecChildRegistry(realpath: fakeRealpath) }

    // MARK: rules

    func testExecCommandShapeBehindWrappersNotHelpers() {
        XCTAssertTrue(CodexExecChildRules.isCodexExecCommand("timeout 1500 codex exec -C \(cwd) -"))
        XCTAssertTrue(CodexExecChildRules.isCodexExecCommand("node /opt/homebrew/bin/codex exec -C \(cwd) -"))
        XCTAssertTrue(CodexExecChildRules.isCodexExecCommand("/x/bin/codex --profile fast exec -"))
        XCTAssertTrue(CodexExecChildRules.isCodexExecCommand("/x/bin/codex e fix tests"))
        XCTAssertFalse(CodexExecChildRules.isCodexExecCommand("/x/bin/codex"))
        XCTAssertFalse(CodexExecChildRules.isCodexExecCommand("/x/bin/codex resume abc"))
        XCTAssertFalse(CodexExecChildRules.isCodexExecCommand("/x/bin/codex-code-mode-host"))
        XCTAssertFalse(CodexExecChildRules.isCodexExecCommand("/Applications/ChatGPT.app/Contents/Resources/codex app-server"))
    }

    func testExecCwdFlags() {
        XCTAssertEqual(CodexExecChildRules.execCwd(fromCommand: "codex exec -C \(cwd) -"), cwd)
        XCTAssertEqual(CodexExecChildRules.execCwd(fromCommand: "codex exec --cd /a/b -"), "/a/b")
        XCTAssertEqual(CodexExecChildRules.execCwd(fromCommand: "codex exec --cd=/a/b -"), "/a/b")
        XCTAssertNil(CodexExecChildRules.execCwd(fromCommand: "codex exec -"))
    }

    func testHeadlessOriginatorIsCodexExecOnly() {
        XCTAssertTrue(CodexExecChildRules.isHeadlessOriginator("codex_exec"))
        XCTAssertTrue(CodexExecChildRules.isHeadlessOriginator("Codex_Exec"))
        XCTAssertFalse(CodexExecChildRules.isHeadlessOriginator("codex-tui"))
        XCTAssertFalse(CodexExecChildRules.isHeadlessOriginator("Codex Desktop"))
        XCTAssertFalse(CodexExecChildRules.isHeadlessOriginator(nil))
    }

    func testAncestryWalksWrapperChainToLauncher() {
        XCTAssertEqual(CodexExecChildRules.nearestAncestorPeer(pid: 49460, processes: batchTable(), peers: [claudePeer]), claudePeer)
        XCTAssertNil(CodexExecChildRules.nearestAncestorPeer(pid: 49460, processes: batchTable(), peers: []))
        let selfPeer = CodexExecPeer(sessionId: childKey, pid: 49460)
        XCTAssertNil(CodexExecChildRules.nearestAncestorPeer(pid: 49460, processes: batchTable(), peers: [selfPeer]))
        let cyclic = [row(10, 11, "a"), row(11, 10, "b")]
        XCTAssertNil(CodexExecChildRules.nearestAncestorPeer(pid: 10, processes: cyclic, peers: [claudePeer]))
        // Several peers on one pid (Codex Desktop conversations): first listed wins.
        let a = CodexExecPeer(sessionId: "conv-a", pid: 71456)
        let b = CodexExecPeer(sessionId: "conv-b", pid: 71456)
        XCTAssertEqual(CodexExecChildRules.nearestAncestorPeer(pid: 49460, processes: batchTable(), peers: [a, b]), a)
    }

    func testCanonicalPathResolvesTmpSymlink() {
        XCTAssertEqual(CodexExecChildRules.canonicalPath(cwd + "/", realpath: fakeRealpath), cwdReal)
        XCTAssertNil(CodexExecChildRules.canonicalPath(nil, realpath: fakeRealpath))
    }

    // MARK: registry, hook path

    func testAttachesOnSessionStartWhenProcessVisible() {
        var reg = registry()
        let v = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                             processes: batchTable(), peers: [claudePeer], now: 1_000) { headless }
        XCTAssertTrue(v.childOnly)
        XCTAssertFalse(v.wantsFreshTable)
        guard case .attached(let child)? = v.events.first else { return XCTFail("expected attached, got \(v.events)") }
        XCTAssertEqual(child.parentSessionId, claudeSid)
        XCTAssertEqual(child.pid, 49460)
        XCTAssertEqual(child.cwd, cwdReal)
        XCTAssertTrue(reg.knows(childKey))
        XCTAssertEqual(reg.parent(of: childKey), claudeSid)
    }

    func testStopCompletesOnceAndTrailingHooksStayChildOnly() {
        var reg = registry()
        _ = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                         processes: batchTable(), peers: [claudePeer], now: 1_000) { headless }
        let stop = reg.noteHook(event: "codex_stop", sessionId: childKey, cwd: cwdReal,
                                processes: batchTable(), peers: [claudePeer], now: 1_060) { headless }
        XCTAssertTrue(stop.childOnly)
        XCTAssertEqual(stop.events.count, 1)
        guard case .stopped(let child)? = stop.events.first else { return XCTFail("expected stopped") }
        XCTAssertEqual(child.stoppedAt, 1_060)
        let trailing = reg.noteHook(event: "codex_tool_end", sessionId: childKey, cwd: cwdReal,
                                    processes: batchTable(), peers: [claudePeer], now: 1_061) { headless }
        XCTAssertTrue(trailing.childOnly)
        XCTAssertTrue(trailing.events.isEmpty)
    }

    func testInteractiveRolloutFlowsThrough() {
        var reg = registry()
        let tui = CodexRolloutSessionMeta(originator: "codex-tui", cwd: cwdReal)
        let v = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                             processes: batchTable(), peers: [claudePeer], now: 1_000) { tui }
        XCTAssertFalse(v.childOnly)
        XCTAssertFalse(v.wantsFreshTable)
        XCTAssertFalse(reg.knows(childKey))
    }

    func testHeadlessRunWithNoSessionAncestorIsStandalone() {
        var reg = registry()
        let table = [row(500, 1, "/bin/zsh"), row(501, 500, "/x/bin/codex exec -C \(cwd) -")]
        let v = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                             processes: table, peers: [claudePeer], now: 1_000) { headless }
        XCTAssertFalse(v.childOnly)
        XCTAssertFalse(reg.knows(childKey))
    }

    func testRunWithoutDashCResolvesAsTheOnlyUnclaimedExec() {
        var reg = registry()
        let table = [
            row(71456, 1872, "claude"),
            row(16524, 71456, "/bin/zsh -c cd /somewhere && codex exec fix tests"),
            row(16530, 16524, "/x/bin/codex exec fix tests"),
        ]
        let v = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: "/somewhere",
                             processes: table, peers: [claudePeer], now: 1_000) { headless }
        XCTAssertTrue(v.childOnly)
        guard case .attached(let child)? = v.events.first else { return XCTFail("expected attached") }
        XCTAssertEqual(child.pid, 16530)
    }

    func testPendingAsksForAFreshTableOnceAndLetsHooksFlow() {
        var reg = registry()
        // SessionStart before the tick refreshed the table.
        let first = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                                 processes: [], peers: [claudePeer], now: 1_000) { headless }
        XCTAssertEqual(first, CodexExecChildRegistry.HookVerdict(childOnly: false, events: [], wantsFreshTable: true))
        XCTAssertFalse(reg.knows(childKey))
        // The fresh table shows it: attached right away.
        let second = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                                  processes: batchTable(), peers: [claudePeer], now: 1_000) { headless }
        XCTAssertTrue(second.childOnly)
        XCTAssertEqual(second.events.count, 1)
    }

    func testPendingDoesNotAskTwiceAndTheTickAttachesLater() {
        var reg = registry()
        XCTAssertTrue(reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                                   processes: [], peers: [claudePeer], now: 1_000) { headless }.wantsFreshTable)
        let again = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                                 processes: [], peers: [claudePeer], now: 1_000) { headless }
        XCTAssertFalse(again.childOnly)
        XCTAssertFalse(again.wantsFreshTable)
        let events = reg.reconcile(processes: batchTable(), peers: [claudePeer], now: 1_004)
        guard case .attached(let child)? = events.first else { return XCTFail("expected attached from tick") }
        XCTAssertEqual(child.parentSessionId, claudeSid)
        XCTAssertEqual(child.pid, 49460)
    }

    func testPendingGivesUpAfterTTL() {
        var reg = registry()
        _ = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                         processes: [], peers: [claudePeer], now: 1_000) { headless }
        let late = reg.noteHook(event: "codex_tool_start", sessionId: childKey, cwd: cwdReal,
                                processes: [], peers: [claudePeer],
                                now: 1_000 + CodexExecChildRegistry.pendingTTL + 1) { headless }
        XCTAssertFalse(late.childOnly)
        // Sticky: the process showing up later does not re-open the question.
        let after = reg.noteHook(event: "codex_tool_end", sessionId: childKey, cwd: cwdReal,
                                 processes: batchTable(), peers: [claudePeer],
                                 now: 1_000 + CodexExecChildRegistry.pendingTTL + 2) { headless }
        XCTAssertFalse(after.childOnly)
        XCTAssertFalse(reg.knows(childKey))
    }

    func testRolloutMissingAtSessionStartIsRecheckedLater() {
        var reg = registry()
        var meta: CodexRolloutSessionMeta? = nil
        let first = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                                 processes: batchTable(), peers: [claudePeer], now: 1_000) { meta }
        XCTAssertFalse(first.childOnly)
        meta = headless
        let second = reg.noteHook(event: "codex_user_prompt_submit", sessionId: childKey, cwd: cwdReal,
                                  processes: batchTable(), peers: [claudePeer], now: 1_003) { meta }
        XCTAssertTrue(second.childOnly)
        XCTAssertEqual(second.events.count, 1)
    }

    func testSameCwdSiblingsClaimDistinctProcesses() {
        var reg = registry()
        let other = "codex:01a0f35b-b2be-7ca1-955e-8ca991dd357b"
        let table = batchTable() + [
            row(49548, 17384, "bash -c gen_one 2020s_ai_ai"),
            row(49551, 49548, "/x/bin/codex exec -C \(cwd) -"),
        ]
        let a = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                             processes: table, peers: [claudePeer], now: 1_000) { headless }
        let b = reg.noteHook(event: "codex_session_start", sessionId: other, cwd: cwdReal,
                             processes: table, peers: [claudePeer], now: 1_000) { headless }
        guard case .attached(let ca)? = a.events.first, case .attached(let cb)? = b.events.first else {
            return XCTFail("both should attach")
        }
        XCTAssertNotEqual(ca.pid, cb.pid)
    }

    // MARK: registry, tick path

    func testProcessExitCompletesChildAndEmptyTableDoesNot() {
        var reg = registry()
        _ = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                         processes: batchTable(), peers: [claudePeer], now: 1_000) { headless }
        // An empty table is "could not look".
        XCTAssertTrue(reg.reconcile(processes: [], peers: [claudePeer], now: 1_010).isEmpty)
        // The chain exited; the launcher is still there.
        let without = batchTable().filter { $0.pid < 49451 }
        let events = reg.reconcile(processes: without, peers: [claudePeer], now: 1_070)
        guard case .stopped(let child)? = events.first else { return XCTFail("expected stopped") }
        XCTAssertEqual(child.stoppedAt, 1_070)
        XCTAssertTrue(reg.knows(childKey)) // tombstoned, still not a session
        XCTAssertTrue(reg.reconcile(processes: without, peers: [claudePeer], now: 1_075).isEmpty)
    }

    func testGuessedPidExitDoesNotCompleteWhileASameCwdRunIsAlive() {
        var reg = registry()
        let sibling = [
            row(49548, 17384, "bash -c gen_one 2020s_ai_ai"),
            row(49551, 49548, "/x/bin/codex exec -C \(cwd) -"),
        ]
        _ = reg.noteHook(event: "codex_session_start", sessionId: childKey, cwd: cwdReal,
                         processes: batchTable() + sibling, peers: [claudePeer], now: 1_000) { headless }
        let after = batchTable().filter { $0.pid < 49451 } + sibling
        XCTAssertTrue(reg.reconcile(processes: after, peers: [claudePeer], now: 1_060).isEmpty)
        let events = reg.reconcile(processes: batchTable().filter { $0.pid < 49451 }, peers: [claudePeer], now: 1_120)
        XCTAssertEqual(events.count, 1)
    }

    func testNonCodexHookIsNeverAChild() {
        var reg = registry()
        let v = reg.noteHook(event: "SessionStart", sessionId: claudeSid, cwd: cwdReal,
                             processes: batchTable(), peers: [claudePeer], now: 1_000) { headless }
        XCTAssertFalse(v.childOnly)
    }

    // MARK: rollout head

    func testSessionMetaReadsOriginatorAndCwdFromRolloutHead() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("codex-exec-children-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("2026/10/01"), withIntermediateDirectories: true)
        let id = "01a0f35b-b63f-7dd0-be3f-0d264da1be18"
        let instructions = String(repeating: "x", count: 20_000)
        let line = """
        {"timestamp":"2026-09-30T17:27:49.193Z","ordinal":0,"type":"session_meta","payload":{"session_id":"\(id)","id":"\(id)","timestamp":"2026-09-30T17:27:49.055Z","cwd":"\(cwdReal)","runtime_workspace_roots":["\(cwdReal)"],"originator":"codex_exec","cli_version":"0.156.0","source":"exec","thread_source":"user","model_provider":"openai","base_instructions":{"text":"\(instructions)"}}}
        """
        let url = root.appendingPathComponent("2026/10/01/rollout-2026-10-01T02-27-49-\(id).jsonl")
        try (line + "\n").data(using: .utf8)!.write(to: url)
        let meta = CodexRolloutResponseReader.sessionMeta(sessionId: id, sessionsRoot: root)
        XCTAssertEqual(meta, CodexRolloutSessionMeta(originator: "codex_exec", cwd: cwdReal, isSubagent: false))
        XCTAssertEqual(CodexRolloutResponseReader.originatorIsDesktop(sessionId: id, sessionsRoot: root), false)
        XCTAssertNil(CodexRolloutResponseReader.sessionMeta(sessionId: "01a0f35b-0000-0000-0000-000000000000", sessionsRoot: root))
    }
}
#endif
