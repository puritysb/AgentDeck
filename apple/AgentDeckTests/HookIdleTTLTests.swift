// HookIdleTTLTests.swift — precedence coverage for the hook-observed session
// eviction ladder (`DaemonServer.hookIdleTTL`).
//
// The ladder decides how long a quiet row may live before
// evictStaleHookSessions reaps it — and eviction is destructive: it
// force-closes any open turn with a synthetic chat_end and drops the row from
// every surface, so a session that is merely quiet reads as finished. The
// per-agent constants are self-documenting; the ORDER is what breaks silently,
// which is why the ladder is a pure function and why these tests exist.
// macOS-only (daemon path).

#if os(macOS)
import XCTest
@testable import AgentDeck

// Exercises daemon-actor types (ApmeCollector, DaemonServer statics).
@DaemonActor
final class HookIdleTTLTests: XCTestCase {

    private func entry(
        id: String = "s1",
        agentType: String?,
        state: String? = nil,
        currentTool: String? = nil
    ) -> DaemonSessionEntry {
        var e = DaemonSessionEntry(
            id: id,
            port: 9120,
            pid: 0,
            projectName: "AgentDeck",
            agentType: agentType,
            tmuxSession: nil,
            tty: nil,
            parentTty: nil,
            startedAt: nil
        )
        e.state = state
        e.currentTool = currentTool
        e.controlMode = "observed"
        return e
    }

    private func ttl(
        _ sid: String,
        _ e: DaemonSessionEntry,
        interactive: Bool = false
    ) -> TimeInterval {
        DaemonServer.hookIdleTTL(sessionId: sid, entry: e, isCodexInteractive: interactive)
    }

    // MARK: - claude-code

    /// The regression this branch exists for: Claude Code emits no hook
    /// between PreToolUse and PostToolUse, so one >3 min tool call (a build, a
    /// subagent fan-out) went silent and the 180 s ghost TTL reaped the live
    /// turn mid-flight.
    func testProcessingClaudeTurnOutlivesTheGhostTTL() async {
        let t = ttl("a690b039", entry(agentType: "claude-code", state: "processing", currentTool: "Bash"))
        XCTAssertEqual(t, 30 * 60)
        XCTAssertGreaterThan(t, 180)
    }

    /// Idling between turns is not a ghost either — under the 180 s window the
    /// row vanished from the deck while the user was typing the next prompt.
    func testIdleClaudeKeepsInteractiveTTLBetweenTurns() async {
        XCTAssertEqual(ttl("s1", entry(agentType: "claude-code", state: "idle")), 30 * 60)
    }

    /// Precedence: awaiting must outrank the claude branch. A permission
    /// prompt can sit for hours; 30 min would evict it mid-decision, which is
    /// the reported bug `awaitingHookStaleTTL` exists to fix.
    func testAwaitingClaudeOutranksInteractiveTTL() async {
        XCTAssertEqual(
            ttl("s1", entry(agentType: "claude-code", state: "awaiting_permission")),
            6 * 60 * 60
        )
    }

    // MARK: - codex

    func testCodexInteractiveThreadGetsLongTTL() async {
        XCTAssertEqual(
            ttl("codex:t1", entry(agentType: "codex-cli", state: "processing"), interactive: true),
            30 * 60
        )
    }

    /// A non-interactive codex row keeps the tool-aware companion windows.
    func testCodexCompanionTTLIsToolAware() async {
        XCTAssertEqual(
            ttl("codex:t1", entry(agentType: "codex-cli", state: "processing", currentTool: "Bash")),
            240
        )
        XCTAssertEqual(
            ttl("codex:t1", entry(agentType: "codex-cli", state: "processing")),
            90
        )
    }

    /// Codex is matched by prefix OR agentType — a row keyed without the
    /// `codex:` prefix must not fall through to the claude branch.
    func testCodexMatchedByAgentTypeWithoutPrefix() async {
        XCTAssertEqual(
            ttl("t1", entry(agentType: "codex-cli", state: "processing"), interactive: true),
            30 * 60
        )
    }

    // MARK: - opencode

    func testOpenCodeGetsInteractiveTTL() async {
        XCTAssertEqual(
            ttl("opencode:ses_1", entry(agentType: "opencode", state: "processing")),
            30 * 60
        )
    }

    // MARK: - default

    /// The 180 s ghost default now only catches an agent the ladder does not
    /// model yet. If a new agent starts pushing hooks, it lands here and will
    /// flap exactly as claude/codex/opencode each did — give it a branch.
    func testUnmodelledAgentKeepsGhostTTL() async {
        XCTAssertEqual(ttl("s1", entry(agentType: "some-future-agent", state: "processing")), 180)
        XCTAssertEqual(ttl("s1", entry(agentType: nil, state: "processing")), 180)
    }
}
#endif
