#if os(macOS)
import XCTest
@testable import AgentDeck

final class AttentionSessionRosterTests: XCTestCase {
    @MainActor
    func testRealRosterOwnsAttentionFreshnessAndCannotSurviveHostSwitchOrStop() async throws {
        #if !DEBUG
        throw XCTSkip("Roster isolation requires the Debug Bonjour browser kill-switch")
        #else
        let defaults = UserDefaults.standard
        let previousURL = defaults.string(forKey: "lastBridgeUrl")
        let previousCredentials = defaults.dictionary(forKey: "pairedBridgeURLs") as? [String: String]
        let holder = AgentStateHolder()
        holder.discovery.isBrowserEnabled = false
        let server = WebSocketServer()
        addTeardownBlock {
            await MainActor.run {
                holder.prepareForTermination()
                UserDefaults.standard.set(previousURL, forKey: "lastBridgeUrl")
                UserDefaults.standard.set(previousCredentials, forKey: "pairedBridgeURLs")
            }
            await server.stop()
        }

        var selectedPort: UInt16?
        for port in UInt16(19640)..<UInt16(19670) {
            do {
                try await server.start(port: port, loopbackOnly: true)
                selectedPort = port
                break
            } catch {
                continue
            }
        }
        let port = try XCTUnwrap(selectedPort, "A private loopback test port must be available")
        await server.setConnectHandler { peer in
            peer.send(Data(#"{"type":"connection","status":"connected"}"#.utf8))
        }

        XCTAssertNil(holder.attentionSessionSnapshot)
        holder.connectTo(url: "ws://127.0.0.1:\(port)?token=roster-test-credential")
        try await waitForAttentionRosterCondition {
            holder.state.bridgeConnected && holder.connection.status == .connected
        }
        XCTAssertNil(holder.attentionSessionSnapshot, "A connected socket is not roster evidence")

        // An idle row exercises production parsing without posting a system notification.
        let roster = #"{"type":"sessions_list","sessions":[{"id":"roster-test-session","port":0,"projectName":"Roster fixture","agentType":"codex","alive":true,"state":"idle"}]}"#
        await server.broadcastRaw(Data(roster.utf8))
        try await waitForAttentionRosterCondition { holder.attentionSessionSnapshot != nil }
        let snapshot = try XCTUnwrap(holder.attentionSessionSnapshot)
        XCTAssertEqual(snapshot.endpoint, "127.0.0.1:\(port)")
        XCTAssertFalse(snapshot.endpoint.contains("roster-test-credential"))
        XCTAssertEqual(snapshot.sessions.map(\.id), ["roster-test-session"])
        XCTAssertEqual(snapshot.sessions.first?.projectName, "Roster fixture")
        XCTAssertEqual(snapshot.sessions.first?.state, "idle")
        XCTAssertNil(snapshot.sessions.first?.question)

        let timelineVersion = holder.timelineVersion
        await server.broadcastRaw(Data(#"{"type":"usage_update","inputTokens":76183}"#.utf8))
        await server.broadcastRaw(Data(#"{"type":"timeline_history","entries":[]}"#.utf8))
        try await waitForAttentionRosterCondition {
            holder.state.inputTokens == 76183 && holder.timelineVersion > timelineVersion
        }
        XCTAssertEqual(holder.attentionSessionSnapshot?.receivedAt, snapshot.receivedAt,
                       "Usage and timeline traffic must not refresh roster evidence")
        XCTAssertGreaterThan(try XCTUnwrap(holder.lastDataReceivedAt), snapshot.receivedAt,
                             "The unrelated frames must actually pass through the holder")

        let lateRoster = try XCTUnwrap(BridgeEventParser.parse(roster))
        // A different host spelling is a different selected endpoint. Keep these
        // assertions in one main-actor turn, before its new connection can arrive.
        holder.connectTo(url: "ws://localhost:\(port)")
        XCTAssertNil(holder.attentionSessionSnapshot, "Selecting another endpoint invalidates immediately")
        holder.handleEvent(lateRoster)
        XCTAssertNil(holder.attentionSessionSnapshot, "An old roster cannot bless the new endpoint")

        holder.stopConnectionAttempts()
        XCTAssertNil(holder.attentionSessionSnapshot, "An explicit stop invalidates immediately")
        holder.handleEvent(lateRoster)
        XCTAssertNil(holder.attentionSessionSnapshot, "A late roster cannot undo an explicit stop")
        #endif
    }
}

@MainActor
private func waitForAttentionRosterCondition(
    _ condition: () -> Bool,
    file: StaticString = #filePath,
    line: UInt = #line
) async throws {
    let deadline = ContinuousClock.now.advanced(by: .seconds(8))
    while !condition() {
        guard ContinuousClock.now < deadline else {
            XCTFail("Timed out waiting for the production WebSocket event", file: file, line: line)
            throw AttentionRosterWaitError.timeout
        }
        try await Task.sleep(for: .milliseconds(10))
    }
}

private enum AttentionRosterWaitError: Error {
    case timeout
}
#endif
