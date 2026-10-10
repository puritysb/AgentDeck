#if os(macOS)
import XCTest
@testable import AgentDeck

/// Replays shared/claude-background-job-vectors.json — the same file the Node
/// suite replays — so one Claude process cannot be a spare on one daemon and a
/// session on the other.
final class ClaudeBackgroundJobRulesTests: XCTestCase {
    private func vectors() throws -> [[String: Any]] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/claude-background-job-vectors.json")
        let data = try Data(contentsOf: url)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try XCTUnwrap(root["vectors"] as? [[String: Any]])
    }

    func testEveryVectorMatchesTheNodeSSOT() throws {
        let cases = try vectors()
        XCTAssertGreaterThan(cases.count, 0)
        for c in cases {
            let name = c["name"] as? String ?? ""
            let command = try XCTUnwrap(c["command"] as? String)
            let parent = c["parent"] as? String
            let role = ClaudeBackgroundJobRules.role(command: command, parentCommand: parent)
            let expected: ClaudeBackgroundJobRules.Role
            switch try XCTUnwrap(c["role"] as? String) {
            case "spare": expected = .spare
            case "pty-host": expected = .ptyHost
            case "job": expected = .job(forkedFrom: c["forkedFrom"] as? String)
            default: expected = .other
            }
            XCTAssertEqual(role, expected, name)
            XCTAssertEqual(
                ClaudeBackgroundJobRules.isSpareStartup(source: c["source"], role: role),
                try XCTUnwrap(c["spareStartup"] as? Bool), name
            )
        }
    }

    func testRoleByPidNeedsTheProcessInTheTable() {
        let table = [
            ProcessEnumerator.ProcessRow(pid: 28603, ppid: 1, command: "claude bg-pty-host --bg-pty-host /tmp/s.sock 200 50 -- x"),
            ProcessEnumerator.ProcessRow(pid: 28616, ppid: 28603, command: "claude bg-spare --bg-spare /tmp/c.claim.sock"),
        ]
        XCTAssertEqual(ClaudeBackgroundJobRules.role(pid: 28616, in: table), .spare)
        XCTAssertNil(ClaudeBackgroundJobRules.role(pid: 999, in: table))
    }

    /// The hook path classifies a brand-new process synchronously (no await
    /// that would let the session's next hook overtake its SessionStart).
    func testProcessRowReadsOneLiveProcess() throws {
        let row = try XCTUnwrap(ProcessEnumerator.processRow(pid: Int(getpid())))
        XCTAssertEqual(row.ppid, Int(getppid()))
        XCTAssertFalse(row.command.isEmpty)
        XCTAssertNil(ProcessEnumerator.processRow(pid: 0))
    }
}
#endif
