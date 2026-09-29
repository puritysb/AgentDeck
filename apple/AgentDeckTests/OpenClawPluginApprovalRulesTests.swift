import XCTest
@testable import AgentDeck

/// Behavior gate for `OpenClawPluginApprovalRules.generated.swift` (issue
/// #309), mirroring `shared/src/__tests__/openclaw-plugin-approval.test.ts`
/// case-for-case so both daemons parse the same `plugin.approval.requested`
/// frame into the same prompt text and option order.
final class OpenClawPluginApprovalRulesTests: XCTestCase {

    private let gatewayEvent: [String: Any] = [
        "approvalKind": "plugin",
        "id": "plugin:aa2318a0-dfdb-40e2-8238-c09e7905f95e",
        "createdAtMs": 1_786_940_704_797.0,
        "request": [
            "pluginId": "telegram",
            "title": "Send message to #ops",
            "description": "Post a status update to the #ops channel.",
            "severity": "warning",
            "toolName": "channel.send",
            "allowedDecisions": ["allow-once", "allow-always", "deny"],
            "agentId": "main",
            "sessionKey": "agent:main:main",
        ],
    ]

    func testReadsTitleAsHeadline() {
        let prompt = OpenClawPluginApprovalRules.parse(gatewayEvent, nowMs: 0)!
        XCTAssertEqual(prompt.question, "Send message to #ops")
        XCTAssertFalse(prompt.question.contains("title not reported"))
    }

    func testCarriesDescriptionAsLeadDetailLine() {
        let prompt = OpenClawPluginApprovalRules.parse(gatewayEvent, nowMs: 0)!
        XCTAssertEqual(prompt.detail?.split(separator: "\n").first, "Post a status update to the #ops channel.")
        XCTAssertTrue(prompt.detail?.contains("tool: channel.send") ?? false)
        XCTAssertTrue(prompt.detail?.contains("plugin: telegram") ?? false)
    }

    func testDefaultsSeverityToWarning() {
        var event = gatewayEvent
        var request = event["request"] as! [String: Any]
        request.removeValue(forKey: "severity")
        event["request"] = request
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertEqual(prompt.severity, "warning")
        XCTAssertEqual(prompt.severity, OpenClawPluginApprovalRules.defaultSeverity)
    }

    func testHonorsExplicitSeverity() {
        var event = gatewayEvent
        var request = event["request"] as! [String: Any]
        request["severity"] = "critical"
        event["request"] = request
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertEqual(prompt.severity, "critical")
    }

    func testOffersExactlyTheAllowedDecisions() {
        let prompt = OpenClawPluginApprovalRules.parse(gatewayEvent, nowMs: 0)!
        XCTAssertEqual(prompt.options.map { $0.decision }, [.allowOnce, .allowAlways, .deny])
    }

    func testNarrowsToExplicitAllowedDecisions() {
        var event = gatewayEvent
        var request = event["request"] as! [String: Any]
        request["allowedDecisions"] = ["allow-once", "deny"]
        event["request"] = request
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertEqual(prompt.options.map { $0.decision }, [.allowOnce, .deny])
    }

    func testAlwaysKeepsDeny() {
        var event = gatewayEvent
        var request = event["request"] as! [String: Any]
        request["allowedDecisions"] = ["allow-once"]
        event["request"] = request
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertEqual(prompt.options.map { $0.decision }, [.allowOnce, .deny])
    }

    /// The whole outage exec shipped: `allow` is not in the Gateway's decision
    /// vocabulary, and it checks BEFORE the id lookup. Never let a filtered
    /// `allowedDecisions` list re-admit it for plugin approvals alone.
    func testNeverOffersThePlainAllowTheGatewayRejects() {
        var event = gatewayEvent
        var request = event["request"] as! [String: Any]
        request["allowedDecisions"] = ["allow", "deny"]
        event["request"] = request
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertEqual(prompt.options.map { $0.decision }, [.deny])
    }

    func testStillProducesAnswerablePromptWithNoTitleOrDescription() {
        let event: [String: Any] = ["id": "plugin:x", "request": [String: Any]()]
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertEqual(prompt.title, "")
        XCTAssertTrue(prompt.question.contains("title not reported"))
        XCTAssertNil(prompt.detail)
        XCTAssertGreaterThan(prompt.options.count, 0)
    }

    func testFallsBackToFlatFields() {
        let event: [String: Any] = ["id": "plugin:x", "title": "Flat title", "description": "d"]
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertEqual(prompt.question, "Flat title")
    }

    func testReturnsNilOnlyWithNoUsableId() {
        XCTAssertNil(OpenClawPluginApprovalRules.parse(
            ["request": ["title": "t", "description": "d"]], nowMs: 0))
        XCTAssertNil(OpenClawPluginApprovalRules.parse(["id": "  "], nowMs: 0))
    }

    func testCarriesExpiry() {
        var event = gatewayEvent
        event["expiresAtMs"] = 1_786_940_824_797.0
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertEqual(prompt.expiresAtMs, 1_786_940_824_797.0)
    }

    func testCarriesSessionKey() {
        let prompt = OpenClawPluginApprovalRules.parse(gatewayEvent, nowMs: 0)!
        XCTAssertEqual(prompt.sessionKey, "agent:main:main")
    }

    func testSummarizesScopeAsSupportingLine() {
        var event = gatewayEvent
        var request = event["request"] as! [String: Any]
        request["scope"] = ["kind": "message-send", "target": "#ops", "recipientCount": 12]
        event["request"] = request
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertTrue(prompt.detail?.contains("scope: message-send (#ops)") ?? false)
    }

    // MARK: - Answering

    func testMapsOptionIndexToDecision() {
        let prompt = OpenClawPluginApprovalRules.parse(gatewayEvent, nowMs: 0)!
        XCTAssertEqual(OpenClawPluginApprovalRules.decision(forOptionIndex: 0, in: prompt), .allowOnce)
        XCTAssertEqual(OpenClawPluginApprovalRules.decision(forOptionIndex: 1, in: prompt), .allowAlways)
        XCTAssertEqual(OpenClawPluginApprovalRules.decision(forOptionIndex: 2, in: prompt), .deny)
    }

    func testRefusesOutOfRangeIndex() {
        let prompt = OpenClawPluginApprovalRules.parse(gatewayEvent, nowMs: 0)!
        XCTAssertNil(OpenClawPluginApprovalRules.decision(forOptionIndex: 9, in: prompt))
        XCTAssertNil(OpenClawPluginApprovalRules.decision(forOptionIndex: -1, in: prompt))
    }

    func testAcceptsShortcutsAndAliases() {
        let prompt = OpenClawPluginApprovalRules.parse(gatewayEvent, nowMs: 0)!
        XCTAssertEqual(OpenClawPluginApprovalRules.decision(forRespondValue: "y", in: prompt), .allowOnce)
        XCTAssertEqual(OpenClawPluginApprovalRules.decision(forRespondValue: "a", in: prompt), .allowAlways)
        XCTAssertEqual(OpenClawPluginApprovalRules.decision(forRespondValue: "n", in: prompt), .deny)
        XCTAssertEqual(OpenClawPluginApprovalRules.decision(forRespondValue: "Deny", in: prompt), .deny)
    }

    func testNeverGuessesAnUnrecognizedPress() {
        let prompt = OpenClawPluginApprovalRules.parse(gatewayEvent, nowMs: 0)!
        XCTAssertNil(OpenClawPluginApprovalRules.decision(forRespondValue: "maybe", in: prompt))
        XCTAssertNil(OpenClawPluginApprovalRules.decision(forRespondValue: "", in: prompt))
    }

    func testRefusesAlwaysWhenForbidden() {
        var event = gatewayEvent
        var request = event["request"] as! [String: Any]
        request["allowedDecisions"] = ["allow-once", "deny"]
        event["request"] = request
        let prompt = OpenClawPluginApprovalRules.parse(event, nowMs: 0)!
        XCTAssertNil(OpenClawPluginApprovalRules.decision(forRespondValue: "always", in: prompt))
        XCTAssertEqual(OpenClawPluginApprovalRules.decision(forRespondValue: "y", in: prompt), .allowOnce)
    }

    // MARK: - plugin.approval.removed (undeclared in any .d.ts)

    func testRemovedIdReadsThePayloadId() {
        XCTAssertEqual(OpenClawPluginApprovalRules.removedId(from: ["id": "plugin:abc"]), "plugin:abc")
    }

    func testRemovedIdMakesNoClaimAboutUnreadablePayload() {
        XCTAssertNil(OpenClawPluginApprovalRules.removedId(from: [:]))
        XCTAssertNil(OpenClawPluginApprovalRules.removedId(from: ["id": 42]))
        XCTAssertNil(OpenClawPluginApprovalRules.removedId(from: ["id": "  "]))
    }

    // MARK: - isApprovalGoneError is REUSED from the exec mirror, not re-derived

    func testReusesExecApprovalGoneErrorClassifier() {
        XCTAssertTrue(OpenClawApprovalRules.isApprovalGoneError([
            "message": "unknown or expired approval id",
        ]))
        XCTAssertFalse(OpenClawApprovalRules.isApprovalGoneError([
            "message": "Gateway disconnected",
        ]))
    }
}
