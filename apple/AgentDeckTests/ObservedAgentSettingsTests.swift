import XCTest
@testable import AgentDeck

/// #463: model / effort / permission mode are read in each agent's own words
/// and never defaulted. Payload shapes measured 2026-10-06 (Claude Code
/// 2.1.289, Codex 0.156); mirrors `bridge/src/__tests__/hook-claude-sessions.test.ts`.
final class ObservedAgentSettingsTests: XCTestCase {
    func testClaudeHookFieldsPassThroughVerbatim() {
        XCTAssertEqual(
            ObservedAgentSettings.claude(fromHook: ["source": "startup", "model": "claude-sonnet-5-5"]),
            .init(model: "claude-sonnet-5-5"))
        XCTAssertEqual(
            ObservedAgentSettings.claude(fromHook: ["permission_mode": "auto", "effort": ["level": "xhigh"]]),
            .init(effortLevel: "xhigh", permissionMode: "auto"))
        XCTAssertTrue(ObservedAgentSettings.claude(fromHook: ["permission_mode": ""]).isEmpty)
    }

    func testCodexHookPermissionModeIsIgnored() {
        // Codex derives `permission_mode` from approval_policy as a Claude-compatible
        // label; it is not Codex's own vocabulary.
        XCTAssertEqual(
            ObservedAgentSettings.codex(fromHook: ["model": "gpt-6-astra", "permission_mode": "bypassPermissions"]),
            .init(model: "gpt-6-astra"))
    }

    func testCodexTurnContextUsesSandboxTypeOrPlan() {
        let base: [String: Any] = ["model": "gpt-6-astra", "effort": "ultra"]
        var sandboxed = base
        sandboxed["sandbox_policy"] = ["type": "workspace-write"]
        sandboxed["collaboration_mode"] = ["mode": "default"]
        XCTAssertEqual(
            ObservedAgentSettings.codex(turnContext: sandboxed),
            .init(model: "gpt-6-astra", effortLevel: "ultra", permissionMode: "workspace-write"))
        var planning = sandboxed
        planning["collaboration_mode"] = ["mode": "plan"]
        XCTAssertEqual(ObservedAgentSettings.codex(turnContext: planning).permissionMode, "plan")
        XCTAssertNil(ObservedAgentSettings.codex(turnContext: ["model": "gpt-6-astra"]).effortLevel)
    }

    func testMergeRetainsWhatTheReadingDoesNotCarry() {
        let current = ObservedAgentSettings.Reading(model: "m", effortLevel: "high", permissionMode: "auto")
        XCTAssertEqual(
            ObservedAgentSettings.merge(.init(permissionMode: "plan"), into: current),
            .init(model: "m", effortLevel: "high", permissionMode: "plan"))
    }

    func testLatestTurnContextSkipsPartialLinesAndTakesTheNewest() {
        let tail = [
            #"t_context", "payload": {"model": "cut"}}"#,
            #"{"type":"turn_context","payload":{"model":"old","effort":"low"}}"#,
            #"{"type":"event_msg","payload":{"type":"token_count"}}"#,
            #"{"type":"turn_context","payload":{"model":"new","effort":"max"}}"#,
        ].joined(separator: "\n")
        let payload = ObservedAgentSettings.latestTurnContext(inRolloutTail: tail)
        XCTAssertEqual(payload?["model"] as? String, "new")
        XCTAssertEqual(payload?["effort"] as? String, "max")
    }
}
