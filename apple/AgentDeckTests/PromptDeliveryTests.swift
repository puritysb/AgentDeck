import XCTest
@testable import AgentDeck

/// Where a prompt sent through `session_command` goes, as the delivery log
/// line states it (#541). The classification mirrors the routing order in
/// `DaemonServer.handleCommand`.
final class PromptDeliveryTests: XCTestCase {
    private func classify(
        _ sessionId: String,
        controlMode: String? = nil,
        agentType: String? = nil,
        known: Bool = false,
        gateway: Bool = false
    ) -> PromptDelivery {
        PromptDelivery.classify(
            sessionId: sessionId, controlMode: controlMode, agentType: agentType,
            knownSession: known, gatewayConnected: gateway)
    }

    func testObservedClaudeIsQueuedForTheTurnEnd() {
        let d = classify("observed:claude:26ed3653", controlMode: "observed", agentType: "claude-code", known: true)
        XCTAssertEqual(d, .turnEndQueue)
        XCTAssertEqual(d.delivered, "queued")
    }

    func testObservedOpenCodeIsQueuedForThePlugin() {
        XCTAssertEqual(classify("opencode:ses_1", controlMode: "observed", agentType: "opencode", known: true), .openCodeQueue)
    }

    func testAnObservedAgentWithoutAPromptPathIsNotDelivered() {
        // An observed Codex row has no queue and no terminal this app may type
        // into; the press must read as not delivered, never as relayed.
        let d = classify("observed:codex:019a", controlMode: "observed", agentType: "codex-cli", known: true)
        XCTAssertEqual(d, .noPath(agent: "codex-cli"))
        XCTAssertEqual(d.delivered, "false")
        XCTAssertEqual(classify("observed:x:1", controlMode: "observed", agentType: nil, known: true), .noPath(agent: "unknown"))
    }

    func testTheGatewayRowDependsOnAConnectedGateway() {
        XCTAssertEqual(classify("openclaw-gateway", gateway: true), .gateway)
        XCTAssertEqual(classify("openclaw-gateway", gateway: false), .gatewayUnavailable)
        // The gateway row is classified by id even when it is in the roster.
        XCTAssertEqual(classify("openclaw-gateway", controlMode: "managed", known: true, gateway: false), .gatewayUnavailable)
    }

    func testManagedAndUnknownSessions() {
        XCTAssertEqual(classify("claude-9121", controlMode: "managed", known: true), .sessionBridge)
        XCTAssertEqual(classify("gone", known: false), .sessionNotFound)
    }

    func testLogLineMatchesTheNodeDaemonShape() {
        let line = PromptDelivery.noPath(agent: "codex-cli").logLine(
            label: "PTT", text: "Run the tests and fix any failures before you commit them", sessionId: "observed:codex:019a0000-0000-7000-8000-000000000001")
        XCTAssertEqual(
            line,
            "PTT: \"Run the tests and fix any failures befor\" -> observed:codex:019a0000-0000-700 delivered=false (no prompt path for an observed codex-cli session in this app)")
        XCTAssertEqual(
            PromptDelivery.turnEndQueue.logLine(label: "PTT", text: "go on", sessionId: "observed:claude:1"),
            "PTT: \"go on\" -> observed:claude:1 delivered=queued via turn-end directive (delivered when the session's current turn ends)")
        XCTAssertEqual(
            PromptDelivery.gateway.logLine(label: "PTT", text: "hi", sessionId: "openclaw-gateway"),
            "PTT: \"hi\" -> openclaw-gateway delivered=true via gateway")
    }
}
