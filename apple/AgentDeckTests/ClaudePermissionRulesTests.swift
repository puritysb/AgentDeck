import XCTest
@testable import AgentDeck

/// Behavior gate for the generated Claude permission predictor
/// (`ClaudePermissionRules.generated.swift`). The Swift copy is byte-gated
/// against the TS emitter by vitest, but the VECTORS are the behavior gate:
/// an emitter edit that compiles yet diverges from the TS rules goes red here.
final class ClaudePermissionRulesTests: XCTestCase {

    private struct Rules: Decodable {
        let allow: [String]
        let deny: [String]
        let ask: [String]
    }

    private struct Vector: Decodable {
        let note: String
        let tool: String
        let command: String?
        let mode: String?
        let rules: Rules?
        let hold: Bool
    }

    /// Replays the SHARED vector file (shared/claude-permission-vectors.json)
    /// — the same file vitest replays against the TS implementation.
    func testPredictorMatchesSharedVectors() throws {
        let vectorsURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // AgentDeckTests/
            .deletingLastPathComponent()   // apple/
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("shared/claude-permission-vectors.json")
        let data = try Data(contentsOf: vectorsURL)
        let vectors = try JSONDecoder().decode([Vector].self, from: data)
        XCTAssertGreaterThanOrEqual(vectors.count, 30, "vector file too small to be a gate")
        for v in vectors {
            let rules = v.rules.map {
                ClaudePermissionRules.MergedRules(allow: $0.allow, deny: $0.deny, ask: $0.ask)
            }
            let prediction = ClaudePermissionRules.predictPreToolUseHold(
                tool: v.tool, command: v.command, permissionMode: v.mode, rules: rules)
            XCTAssertEqual(prediction.hold, v.hold, "\(v.note) — \(prediction.reason)")
        }
    }

    /// The documented wildcard table, spelled out so a matcher regression
    /// names the exact rule shape that broke.
    func testBashRuleWildcardTable() {
        let table: [(String, String, Bool)] = [
            ("npm run build", "npm run build", true),
            ("npm run build", "npm run build --watch", false),
            ("npm run *", "npm run build", true),
            ("npm run *", "npm run", true),
            ("npm run *", "npm install", false),
            ("git log * main", "git log --oneline main", true),
            ("git log * main", "git log main", false),
            ("git * main", "git merge main", true),
            ("git * main", "git log", false),
            ("* --version", "node --version", true),
            ("* --version", "node -v", false),
            ("ls *", "ls -la", true),
            ("ls *", "ls", true),
            ("ls *", "lsof", false),
            ("ls*", "lsof", true),
            ("* --help *", "npm --help x", true),
            ("* --help *", "npm --help", false),
            ("ls:*", "ls -la", true),
            ("ls:*", "lsof", false),
            ("*", "anything at all", true),
        ]
        for (spec, command, expected) in table {
            XCTAssertEqual(
                ClaudePermissionRules.bashRuleMatches(spec: spec, command: command), expected,
                "Bash(\(spec)) vs \"\(command)\"")
        }
    }

    func testCompoundSplitIsQuoteAwareAndRefusesUnparseable() {
        XCTAssertEqual(
            ClaudePermissionRules.splitCompoundCommand("a && b || c ; d | e |& f & g\nh"),
            ["a", "b", "c", "d", "e", "f", "g", "h"])
        XCTAssertEqual(
            ClaudePermissionRules.splitCompoundCommand("grep \"a|b\" x; echo 'c&&d'"),
            ["grep \"a|b\" x", "echo 'c&&d'"])
        XCTAssertNil(ClaudePermissionRules.splitCompoundCommand("cat <<'EOF'\nx\nEOF"))
        XCTAssertNil(ClaudePermissionRules.splitCompoundCommand("echo $(rm -rf /)"))
        XCTAssertNil(ClaudePermissionRules.splitCompoundCommand("echo `ls`"))
        XCTAssertNil(ClaudePermissionRules.splitCompoundCommand("echo \"unterminated"))
        XCTAssertNil(ClaudePermissionRules.splitCompoundCommand("npm test &&"))
    }

    func testWrapperStrippingAndBuiltinSets() {
        XCTAssertEqual(ClaudePermissionRules.stripCommandWrappers("LANG=C NO_COLOR=1 timeout 30 npm test"), "npm test")
        XCTAssertEqual(ClaudePermissionRules.stripCommandWrappers("nice -n 10 nohup make"), "make")
        XCTAssertEqual(ClaudePermissionRules.stripCommandWrappers("xargs grep pattern"), "grep pattern")
        XCTAssertEqual(ClaudePermissionRules.stripCommandWrappers("xargs -n1 grep pattern"), "xargs -n1 grep pattern")
        for c in ["ls -la", "cat x", "git status", "git log -5", "git branch", "git branch -a", "wc -l *.py"] {
            XCTAssertTrue(ClaudePermissionRules.isBuiltinReadOnlyCommand(c), c)
        }
        for c in ["git branch x", "git push", "find . -delete *", "ls > x", "npm test", "git checkout -- ."] {
            XCTAssertFalse(ClaudePermissionRules.isBuiltinReadOnlyCommand(c), c)
        }
        XCTAssertTrue(ClaudePermissionRules.isAcceptEditsFsCommand("LANG=C sed -i s/a/b/ f"))
        XCTAssertFalse(ClaudePermissionRules.isAcceptEditsFsCommand("npm test"))
    }

    func testSignatureAndModeGate() {
        XCTAssertEqual(ClaudePermissionRules.gateSignature(tool: "Bash", commandText: "  git push origin main"), "Bash|git push")
        XCTAssertEqual(ClaudePermissionRules.gateSignature(tool: "Edit", commandText: nil), "Edit")
        XCTAssertTrue(ClaudePermissionRules.shouldGatePreToolUse(permissionMode: nil, tool: "Bash"))
        XCTAssertFalse(ClaudePermissionRules.shouldGatePreToolUse(permissionMode: "acceptEdits", tool: "Edit"))
        XCTAssertTrue(ClaudePermissionRules.shouldGatePreToolUse(permissionMode: "acceptEdits", tool: "Bash"))
        for m in ["auto", "plan", "dontAsk", "bypassPermissions"] {
            XCTAssertFalse(ClaudePermissionRules.shouldGatePreToolUse(permissionMode: m, tool: "Bash"), m)
        }
        XCTAssertGreaterThanOrEqual(ClaudePermissionRules.gateLearnWindowMs, 5 * 60_000)
    }
}
