// ProviderRailEvaluatorTests.swift — regression guard against the
// Claude/OpenClaw rail-status drift that showed "Not connected" in the
// menu-bar popup while the Dashboard and Settings both correctly read the
// session as live. See IntegrationsView.swift `ProviderRailEvaluator`.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class ProviderRailEvaluatorTests: XCTestCase {

    // MARK: - Claude

    func testClaudeBothOn() {
        var s = DashboardState()
        s.oauthConnected = true
        let row = ProviderRailEvaluator.claude(state: s, hooksInstalled: true)
        XCTAssertEqual(row.status, .ok)
        // Both paths live — no subtitle needed; model catalog (if any) is
        // layered on by the dashboard rail, not the evaluator.
        XCTAssertNil(row.subtitle)
    }

    func testClaudeOauthOnlyOn() {
        var s = DashboardState()
        s.oauthConnected = true
        let row = ProviderRailEvaluator.claude(state: s, hooksInstalled: false)
        XCTAssertEqual(row.status, .ok)
        XCTAssertNil(row.subtitle)
    }

    func testClaudeHooksOnlyOn() {
        var s = DashboardState()
        s.oauthConnected = false  // Sandbox blocks OAuth read → known-down
        let row = ProviderRailEvaluator.claude(state: s, hooksInstalled: true)
        XCTAssertEqual(row.status, .ok, "hooks-only must read as green — regression guard for App Store build")
        XCTAssertEqual(row.subtitle, "Hooks on")
    }

    func testClaudeHooksOnlyWithUnknownOauth() {
        var s = DashboardState()
        s.oauthConnected = nil  // Early boot, haven't polled yet
        let row = ProviderRailEvaluator.claude(state: s, hooksInstalled: true)
        XCTAssertEqual(row.status, .ok)
        XCTAssertEqual(row.subtitle, "Hooks on")
    }

    func testClaudeNeitherKnownDown() {
        var s = DashboardState()
        s.oauthConnected = false
        let row = ProviderRailEvaluator.claude(state: s, hooksInstalled: false)
        XCTAssertEqual(row.status, .warn)
        XCTAssertEqual(row.subtitle, "Not connected")
    }

    func testClaudeNeitherUnknown() {
        var s = DashboardState()
        s.oauthConnected = nil
        let row = ProviderRailEvaluator.claude(state: s, hooksInstalled: false)
        XCTAssertEqual(row.status, .dim)
        XCTAssertNil(row.subtitle)
    }

    func testClaudeExpiredUsageExplainsMissingGaugeWithoutClaimingSessionFailure() {
        var s = DashboardState()
        s.oauthConnected = true
        s.usageStale = true
        s.tokenStatus = "expired"
        let row = ProviderRailEvaluator.claude(state: s, hooksInstalled: true)
        XCTAssertEqual(row.status, .ok)
        XCTAssertEqual(row.subtitle, "Usage authorization expired")
        s.usageStale = false
        s.tokenStatus = "valid"
        XCTAssertNil(ProviderRailEvaluator.claude(state: s, hooksInstalled: true).subtitle)
    }

    @MainActor
    func testUsageWireReasonIsRetainedAndClearedAfterRecoveryAndOwnershipChange() {
        let holder = AgentStateHolder()
        var expired = UsageEvent(type: "usage_update")
        expired.usageStale = true
        expired.tokenStatus = "expired"
        expired.oauthConnected = true
        holder.handleEvent(.usageUpdate(expired))
        XCTAssertEqual(holder.state.claudeUsageIssue, "Usage authorization expired")
        var partial = UsageEvent(type: "usage_update")
        partial.inputTokens = 12
        holder.handleEvent(.usageUpdate(partial))
        XCTAssertEqual(holder.state.tokenStatus, "expired")
        var fresh = UsageEvent(type: "usage_update")
        fresh.usageStale = false
        fresh.fiveHourPercent = 12
        holder.handleEvent(.usageUpdate(fresh))
        XCTAssertNil(holder.state.claudeUsageIssue)
        XCTAssertNil(holder.state.tokenStatus, "older fresh producers must also clear auth errors")
        holder.handleEvent(.usageUpdate(expired))
        fresh.usageStale = nil // old producers omit the negative flag
        holder.handleEvent(.usageUpdate(fresh))
        XCTAssertNil(holder.state.tokenStatus)
        var unavailable = UsageEvent(type: "usage_update")
        unavailable.usageStale = true
        holder.handleEvent(.usageUpdate(unavailable))
        XCTAssertNil(holder.state.claudeUsageIssue,
                     "a stale frame with no explicit expiry is 'no numbers', not a failure")
        holder.handleEvent(.usageUpdate(expired))
        holder.clearRelayedUsageState()
        XCTAssertNil(holder.state.tokenStatus)
        XCTAssertNil(holder.state.claudeUsageIssue)
    }

    /// The standalone App Store daemon emits exactly one shape: it never reads
    /// Claude's OAuth entry, so `tokenStatus` is always `unknown` and
    /// `usageStale` always true, while `effectiveOauthConnected()` reports true
    /// as soon as any claude-code session is cached. That trio must stay
    /// silent — a permanent "usage broken" line for every ordinary standalone
    /// user is the failure this pins (CLAUDE.md § App Store build invariants).
    func testStandaloneDaemonShapeNeverClaimsAQuotaFailure() {
        var s = DashboardState()
        s.usageStale = true
        s.tokenStatus = "unknown"
        s.oauthConnected = true
        XCTAssertNil(s.claudeUsageIssue)
        XCTAssertNil(s.claudeUsageBadge)
        XCTAssertNil(ProviderRailEvaluator.claude(state: s, hooksInstalled: true).subtitle)

        // An API-key / off-harness install legitimately has no OAuth credential.
        s.tokenStatus = "missing"
        s.oauthConnected = false
        XCTAssertNil(s.claudeUsageIssue)
        XCTAssertEqual(ProviderRailEvaluator.claude(state: s, hooksInstalled: false).subtitle,
                       "Not connected",
                       "no connection outranks a usage sentence")

        // Only an explicit expiry — which only the Node daemon can produce —
        // is a failure claim.
        s.tokenStatus = "expired"
        s.oauthConnected = true
        XCTAssertEqual(s.claudeUsageIssue, "Usage authorization expired")
        XCTAssertEqual(s.claudeUsageBadge, "Claude auth expired")
        s.usageStale = false
        XCTAssertNil(s.claudeUsageIssue, "fresh numbers retract the reason")
    }

    // MARK: - OpenClaw (presence-driven rail — SSOT)
    //
    // The rail evaluator gates on the emitted OpenClaw SESSION (the daemon
    // injects one iff the Gateway is authenticated), never on raw gateway
    // flags. The pre-pairing ladder (approval_pending / pairing_required /
    // token-missing, etc.) lives in the Settings → Integrations `openClawStatus`
    // row, NOT here — so those states must NOT surface a rail row.

    private func openClawSession(state: String = "idle") -> SessionInfo {
        SessionInfo(id: "openclaw-gateway", port: 18789, projectName: "OpenClaw",
                    agentType: "openclaw", state: state)
    }

    func testOpenClawHiddenWithoutSession() {
        var s = DashboardState()
        // Reachable + erroring but NO emitted session → rail must stay empty.
        s.gatewayAvailable = true
        s.gatewayHasError = true
        s.gatewayAuthStatus = "pairing_required"
        XCTAssertNil(ProviderRailEvaluator.openClaw(state: s),
                     "rail must suppress the row until the daemon emits an openclaw session")
    }

    func testOpenClawReachableUnauthenticatedHidden() {
        var s = DashboardState()
        // Port reachable but never authenticated (no session) — the classic
        // "OpenClaw won't go away" trace must NOT render on the rail.
        s.gatewayAvailable = true
        s.gatewayConnected = false
        s.siblingSessions = []
        XCTAssertNil(ProviderRailEvaluator.openClaw(state: s))
    }

    func testOpenClawShownWhenSessionPresent() {
        var s = DashboardState()
        s.gatewayConnected = true
        s.siblingSessions = [openClawSession()]
        let row = ProviderRailEvaluator.openClaw(state: s)
        XCTAssertEqual(row?.status, .ok)
        XCTAssertNil(row?.subtitle)
    }

    func testOpenClawErrorWithLiveSession() {
        var s = DashboardState()
        s.gatewayConnected = true
        s.gatewayHasError = true
        s.siblingSessions = [openClawSession()]
        let row = ProviderRailEvaluator.openClaw(state: s)
        XCTAssertEqual(row?.status, .error)
        XCTAssertEqual(row?.subtitle, "Gateway error")
    }

    // MARK: - LEDStatus.isFilled

    func testLEDStatusFilledVsDim() {
        XCTAssertTrue(LEDStatus.ok.isFilled)
        XCTAssertTrue(LEDStatus.warn.isFilled)
        XCTAssertTrue(LEDStatus.error.isFilled)
        XCTAssertFalse(LEDStatus.dim.isFilled)
    }
}
#endif
