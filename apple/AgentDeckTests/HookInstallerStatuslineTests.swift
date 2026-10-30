#if os(macOS)
import XCTest
@testable import AgentDeck

/// The Claude status-line relay the App Store app installs next to its hooks:
/// it wraps the status line the user already has, unwraps it back verbatim,
/// and never adds a status line where none was configured.
final class HookInstallerStatuslineTests: XCTestCase {
    private let user = "bun x ccusage statusline --visual-burn-rate emoji && echo 'done'"

    func testHookRefreshPreservesOtherHandlersInSharedMatcherGroups() throws {
        let own: [String: Any] = ["type": "command", "command": "AGENTDECK_PORT=9120"]
        let user: [String: Any] = ["type": "command", "command": "printf user-hook", "timeout": 7]
        let settings: [String: Any] = ["hooks": ["SessionStart": [
            ["matcher": "custom", "timeout": 9, "hooks": [own, user]],
        ]]]
        let fixed = HookInstaller.applyHooks(settings)
        let hooks = try XCTUnwrap(fixed["hooks"] as? [String: Any])
        let groups = try XCTUnwrap(hooks["SessionStart"] as? [[String: Any]])
        XCTAssertEqual(groups.count, 2)
        XCTAssertEqual(groups[0]["matcher"] as? String, "custom")
        XCTAssertEqual(groups[0]["timeout"] as? Int, 9)
        let handlers = try XCTUnwrap(groups[0]["hooks"] as? [[String: Any]])
        XCTAssertEqual(handlers.count, 1)
        XCTAssertEqual(handlers[0] as NSDictionary, user as NSDictionary)
        XCTAssertEqual(HookInstaller.applyHooks(fixed) as NSDictionary, fixed as NSDictionary)
    }

    func testRelayAloneIsBoundedFireAndForgetWithNoWrappedCommand() {
        let cmd = HookInstaller.buildStatuslineRelayCommand(original: nil)
        XCTAssertTrue(cmd.contains("/claude/statusline"))
        XCTAssertFalse(cmd.contains("AGENTDECK_PORT"))
        XCTAssertTrue(cmd.contains(#"--connect-timeout 0.2 --max-time 0.8 -X POST "http://127.0.0.1:$PORT/claude/statusline""#))
        XCTAssertTrue(cmd.contains(#"X-AgentDeck-Pid: $PPID"#))
        XCTAssertTrue(cmd.hasSuffix("fi"))
        XCTAssertTrue(cmd.contains(#"if [ -n "$PORT" ]; then"#))
        XCTAssertFalse(cmd.contains("PORT:-9120"))
        XCTAssertTrue(cmd.contains("python3 -I -c"))
        XCTAssertTrue(HookInstaller.isAgentDeckStatuslineCommand(cmd))
        XCTAssertEqual(HookInstaller.unwrapStatuslineCommand(cmd), "")
    }

    func testWrapAndUnwrapRoundTripVerbatimTrimmed() {
        for original in [
            user,
            "~/.claude/statusline.sh",
            "input=$(cat)\nMODEL=$(echo \"$input\" | jq -r '.model.display_name')\necho \"[$MODEL]\"",
            "  npx -y ccstatusline@latest  \n",
        ] {
            let trimmed = original.trimmingCharacters(in: .whitespacesAndNewlines)
            let cmd = HookInstaller.buildStatuslineRelayCommand(original: original)
            XCTAssertTrue(cmd.hasSuffix("\nprintf '%s' \"$I\" | {\n\(trimmed)\n}"), original)
            XCTAssertEqual(HookInstaller.unwrapStatuslineCommand(cmd), trimmed, original)
            XCTAssertEqual(HookInstaller.buildStatuslineRelayCommand(original: HookInstaller.unwrapStatuslineCommand(cmd)), cmd, original)
        }
    }

    func testForeignCommandsAreNotOurs() {
        XCTAssertFalse(HookInstaller.isAgentDeckStatuslineCommand(user))
        XCTAssertNil(HookInstaller.unwrapStatuslineCommand(user))
        XCTAssertNil(HookInstaller.unwrapStatuslineCommand(42))
        XCTAssertNil(HookInstaller.unwrapStatuslineCommand(nil))
    }

    func testApplyWrapsAnExistingStatusLineAndKeepsItsOtherKeys() {
        let settings: [String: Any] = ["statusLine": ["type": "command", "command": user, "padding": 0]]
        let applied = HookInstaller.applyStatuslineRelay(settings)
        let slot = applied["statusLine"] as? [String: Any]
        XCTAssertEqual(slot?["type"] as? String, "command")
        XCTAssertEqual(slot?["padding"] as? Int, 0)
        XCTAssertEqual(HookInstaller.unwrapStatuslineCommand(slot?["command"]), user)
        // Idempotent: applying again changes nothing.
        let again = HookInstaller.applyStatuslineRelay(applied)
        XCTAssertEqual((again["statusLine"] as? [String: Any])?["command"] as? String, slot?["command"] as? String)
    }

    func testApplyNeverAddsAStatusLineAndLeavesForeignShapesAlone() {
        let none: [String: Any] = ["hooks": [:]]
        XCTAssertNil(HookInstaller.applyStatuslineRelay(none)["statusLine"])
        let asString: [String: Any] = ["statusLine": "weird"]
        XCTAssertEqual(HookInstaller.applyStatuslineRelay(asString)["statusLine"] as? String, "weird")
        let noCommand: [String: Any] = ["statusLine": ["type": "command"]]
        XCTAssertEqual((HookInstaller.applyStatuslineRelay(noCommand)["statusLine"] as? [String: Any])?.count, 1)
        let null: [String: Any] = ["statusLine": NSNull()]
        XCTAssertTrue(HookInstaller.applyStatuslineRelay(null)["statusLine"] is NSNull)
    }

    func testApplyRefreshesARelayTheUserOptedIntoElsewhere() {
        // A relay-only slot installed by the CLI's `--statusline` survives the app's auto pass.
        let relayOnly: [String: Any] = ["statusLine": ["type": "command", "command": HookInstaller.buildStatuslineRelayCommand(original: nil)]]
        let applied = HookInstaller.applyStatuslineRelay(relayOnly)
        XCTAssertEqual((applied["statusLine"] as? [String: Any])?["command"] as? String,
                       HookInstaller.buildStatuslineRelayCommand(original: nil))
        // An outdated snippet is rebuilt around the same user command.
        let outdated = HookInstaller.buildStatuslineRelayCommand(original: user)
            .replacingOccurrences(of: "relay v1", with: "relay v0")
        let refreshed = HookInstaller.applyStatuslineRelay(["statusLine": ["type": "command", "command": outdated]])
        XCTAssertEqual((refreshed["statusLine"] as? [String: Any])?["command"] as? String,
                       HookInstaller.buildStatuslineRelayCommand(original: user))
    }

    func testSettingsPolicyMirrorsTheCliInstallers() {
        // `.on` installs the relay even with no status line configured.
        let none: [String: Any] = ["hooks": [:]]
        let on = HookInstaller.applyStatuslineRelay(none, policy: .on)
        XCTAssertEqual((on["statusLine"] as? [String: Any])?["command"] as? String,
                       HookInstaller.buildStatuslineRelayCommand(original: nil))
        // `.auto` keeps a relay the user turned on earlier.
        XCTAssertEqual((HookInstaller.applyStatuslineRelay(on, policy: .auto)["statusLine"] as? [String: Any])?["command"] as? String,
                       HookInstaller.buildStatuslineRelayCommand(original: nil))
        // `.off` removes ours and restores the user's command; a foreign slot is untouched.
        XCTAssertNil(HookInstaller.applyStatuslineRelay(on, policy: .off)["statusLine"])
        let wrapped = HookInstaller.applyStatuslineRelay(["statusLine": ["type": "command", "command": user, "padding": 2]], policy: .auto)
        let restored = HookInstaller.applyStatuslineRelay(wrapped, policy: .off)["statusLine"] as? [String: Any]
        XCTAssertEqual(restored?["command"] as? String, user)
        XCTAssertEqual(restored?["padding"] as? Int, 2)
        let foreign: [String: Any] = ["statusLine": ["type": "command", "command": user]]
        XCTAssertEqual((HookInstaller.applyStatuslineRelay(foreign, policy: .off)["statusLine"] as? [String: Any])?["command"] as? String, user)
    }

    func testRemoveRestoresTheUserCommandOrDropsARelayOnlySlot() {
        let wrapped = HookInstaller.applyStatuslineRelay(["statusLine": ["type": "command", "command": user, "padding": 1]])
        let restored = HookInstaller.removeStatuslineRelay(wrapped)["statusLine"] as? [String: Any]
        XCTAssertEqual(restored?["command"] as? String, user)
        XCTAssertEqual(restored?["padding"] as? Int, 1)

        let relayOnly: [String: Any] = ["statusLine": ["type": "command", "command": HookInstaller.buildStatuslineRelayCommand(original: nil)]]
        XCTAssertNil(HookInstaller.removeStatuslineRelay(relayOnly)["statusLine"])

        let foreign: [String: Any] = ["statusLine": ["type": "command", "command": user]]
        XCTAssertEqual((HookInstaller.removeStatuslineRelay(foreign)["statusLine"] as? [String: Any])?["command"] as? String, user)
    }
}
#endif
