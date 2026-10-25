// DeviceApprovalGateTests.swift — regression guard for false "Attention"
// popups and mismatched options on the macOS dashboard.
//
// For observed direct-`claude` sessions the daemon has no PTY, so it
// synthesizes awaiting-state from hook signals. Two precision classifiers:
//
// 1) `DaemonServer.shouldGate(permissionMode:tool:)` — Claude's PreToolUse hook
//    fires for EVERY tool call regardless of mode/allowlist, even when Claude
//    auto-approves and never prompts. (The held PreToolUse device-approval gate
//    itself was removed on 2026-06-27 and stays removed; the classifier is
//    retained for parity/reference.)
//
// 2) `DaemonServer.isPermissionNotification(notificationType:message:)` — prefer
//    Claude's authoritative `notification_type` (only `permission_prompt` is an
//    awaiting state); fall back to the brittle free-text regex only when absent.
//    This is the live gate for the display-only Notification overlay restored
//    on 2026-07-05 (awaiting + question + system notification, no options).
//
// Mirrors the Node `shouldGatePreToolUse` / `isPermissionNotification` tests in
// bridge/src/__tests__/awaiting-overlay.test.ts. macOS-only (daemon path).

#if os(macOS)
import XCTest
@testable import AgentDeck

final class DeviceApprovalGateTests: XCTestCase {

    // MARK: - shouldGate(permissionMode:tool:)

    func testGatesInPromptableModes() {
        // default / unknown / absent → Claude may prompt → gate.
        XCTAssertTrue(DaemonServer.shouldGate(permissionMode: "default", tool: "Bash"))
        XCTAssertTrue(DaemonServer.shouldGate(permissionMode: nil, tool: "Bash"))
        XCTAssertTrue(DaemonServer.shouldGate(permissionMode: "something-new", tool: "Write"))
    }

    func testNeverGatesWhenClaudeWontPromptOrExecute() {
        // `auto` belongs here: the policy engine auto-approves outside the
        // settings allowlist files, so gating it produced false attention
        // popups (+25s hold latency) for calls the user was never asked about.
        for tool in ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit"] {
            XCTAssertFalse(DaemonServer.shouldGate(permissionMode: "bypassPermissions", tool: tool))
            XCTAssertFalse(DaemonServer.shouldGate(permissionMode: "dontAsk", tool: tool))
            XCTAssertFalse(DaemonServer.shouldGate(permissionMode: "auto", tool: tool))
            XCTAssertFalse(DaemonServer.shouldGate(permissionMode: "plan", tool: tool))
        }
    }

    func testAcceptEditsSkipsEditsButStillGatesBash() {
        XCTAssertFalse(DaemonServer.shouldGate(permissionMode: "acceptEdits", tool: "Edit"))
        XCTAssertFalse(DaemonServer.shouldGate(permissionMode: "acceptEdits", tool: "Write"))
        XCTAssertFalse(DaemonServer.shouldGate(permissionMode: "acceptEdits", tool: "MultiEdit"))
        XCTAssertFalse(DaemonServer.shouldGate(permissionMode: "acceptEdits", tool: "NotebookEdit"))
        XCTAssertTrue(DaemonServer.shouldGate(permissionMode: "acceptEdits", tool: "Bash"))
    }

    // MARK: - isPermissionNotification(notificationType:message:)

    func testNotificationTypeWinsWhenPresent() {
        XCTAssertTrue(DaemonServer.isPermissionNotification(notificationType: "permission_prompt", message: "anything"))
        // Other structured types must NOT flip to attention, even if the message
        // contains permission-ish words.
        XCTAssertFalse(DaemonServer.isPermissionNotification(notificationType: "idle_prompt", message: "Claude needs your permission"))
        XCTAssertFalse(DaemonServer.isPermissionNotification(notificationType: "auth_success", message: "permission to use"))
        XCTAssertFalse(DaemonServer.isPermissionNotification(notificationType: "elicitation_dialog", message: "requesting permission"))
    }

    func testFallsBackToRegexWhenNotificationTypeAbsent() {
        XCTAssertTrue(DaemonServer.isPermissionNotification(notificationType: nil, message: "Claude needs your permission to use Bash"))
        XCTAssertFalse(DaemonServer.isPermissionNotification(notificationType: nil, message: "Claude is waiting for your input"))
        XCTAssertFalse(DaemonServer.isPermissionNotification(notificationType: "", message: "requesting permission"))
    }
}
#endif
