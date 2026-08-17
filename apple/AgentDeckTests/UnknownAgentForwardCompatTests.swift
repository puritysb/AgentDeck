#if os(macOS)
import XCTest
import SwiftUI
@testable import AgentDeck

/// The daemon and each dashboard ship on their own schedules, so a dashboard
/// WILL receive `agentType` values it has never heard of — every time a new
/// agent is added, for as long as it takes the app to catch up.
///
/// The contract for those is narrow: render a neutral default, or render
/// nothing. What must never happen is rendering them as some OTHER agent,
/// because that is not a degraded view — it is a wrong one, and it is the
/// failure mode this codebase actually had. Two bucket definitions were spelled
/// as deny-lists ("everything except the agents we know"), which silently
/// dressed every future agent as Claude.
///
/// These tests pin the polarity rather than the membership: adding a real agent
/// should not require touching them, and removing the guard should fail here.
final class UnknownAgentForwardCompatTests: XCTestCase {

    /// A type no build of this app has ever seen, standing in for whatever the
    /// daemon ships next.
    private let futureAgent = "some-future-agent"

    private func session(id: String, agentType: String, state: String = "processing") -> SessionInfo {
        SessionInfo(
            id: id,
            port: 9120,
            projectName: "AgentDeck",
            agentType: agentType,
            alive: true,
            state: state,
            modelName: nil,
            effortLevel: nil,
            startedAt: nil
        )
    }

    // MARK: - Terrarium

    /// The octopus is Claude's creature. An unknown agent must not wear it.
    func testUnknownAgentIsNotDrawnAsAClaudeOctopus() {
        var state = DashboardState()
        state.state = .processing
        state.bridgeConnected = true
        state.agentType = futureAgent
        state.sessionId = "future:1"

        let terrarium = state.toTerrariumState()

        XCTAssertTrue(
            terrarium.creatures.isEmpty,
            "An unknown agentType must produce no octopus — it is Claude's creature, not a default"
        )
        XCTAssertTrue(terrarium.cloudCreatures.isEmpty)
        XCTAssertTrue(terrarium.opencodeCreatures.isEmpty)
        XCTAssertTrue(terrarium.antigravityCreatures.isEmpty)
        XCTAssertTrue(terrarium.kiroCreatures.isEmpty)
    }

    /// Same rule for sibling sessions, which take a separate code path.
    func testUnknownSiblingIsNotDrawnAsAClaudeOctopus() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "future:1", agentType: futureAgent),
            session(id: "claude:1", agentType: "claude-code"),
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(
            terrarium.creatures.count, 1,
            "Only the real claude-code session may be an octopus"
        )
        XCTAssertEqual(terrarium.creatures.first?.id, "claude:1")
    }

    /// The allow-list is what makes the above true; state it directly so the
    /// failure message points at the cause rather than at a creature count.
    func testOctopusBucketIsAnAllowList() {
        XCTAssertTrue(DashboardState.isOctopusAgent("claude-code"))
        XCTAssertFalse(DashboardState.isOctopusAgent(futureAgent))
        XCTAssertFalse(DashboardState.isOctopusAgent(nil))
        // Agents with their own creature must not fall back into this bucket.
        for known in ["codex-cli", "codex-app", "opencode", "openclaw", "antigravity", "kiro-cli", "kiro-ide", "daemon", "monitor"] {
            XCTAssertFalse(DashboardState.isOctopusAgent(known), "\(known) has its own representation")
        }
    }

    // MARK: - Identity surfaces

    /// Colour and label must degrade to neutral values, and crucially not to
    /// another agent's.
    func testUnknownAgentGetsNeutralIdentityNotBorrowedIdentity() {
        XCTAssertEqual(SessionBrand.color(for: futureAgent), Color.secondary)
        XCTAssertNotEqual(SessionBrand.color(for: futureAgent), SessionBrand.color(for: "claude-code"))

        // The label may be generic, but must not name a different agent.
        let label = displayAgentLabel(futureAgent)
        for known in ["Claude", "Codex", "OpenCode", "OpenClaw", "Antigravity", "Kiro"] {
            XCTAssertFalse(label.contains(known), "Unknown agent label '\(label)' must not name \(known)")
        }
    }

    /// The other half of the contract: every agent that IS on the wire must
    /// resolve to its own colour and its own label. This catches a new agent
    /// being added to the protocol while nobody wires its identity — the
    /// symptom Kiro shipped with.
    func testEveryWireAgentTypeHasItsOwnIdentity() {
        var seenColors: [String: Color] = [:]
        for agent in Self.wireAgentTypes {
            let color = SessionBrand.color(for: agent)
            XCTAssertNotEqual(
                color, Color.secondary,
                "\(agent) is on the wire but falls back to the unknown-agent colour"
            )
            let label = displayAgentLabel(agent)
            XCTAssertNotEqual(label, "Agent", "\(agent) has no display label")
            seenColors[agent] = color
        }
        // Codex CLI/App and Kiro CLI/IDE intentionally share a brand colour;
        // everything else must be distinguishable from Claude.
        for agent in Self.wireAgentTypes where agent != "claude-code" {
            XCTAssertNotEqual(
                seenColors[agent], seenColors["claude-code"],
                "\(agent) is coloured as Claude"
            )
        }
    }

    /// Raw wire strings for every agent the generated protocol knows about,
    /// minus the two non-session rows (`daemon`, `monitor`).
    private static let wireAgentTypes = [
        "claude-code", "codex-cli", "codex-app", "opencode",
        "openclaw", "antigravity", "kiro-cli", "kiro-ide",
    ]
}
#endif
