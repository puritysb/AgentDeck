import XCTest
@testable import AgentDeck

final class AppleBuildBoundaryTests: XCTestCase {
    func testDotResourceMatchesCompiledFeature() {
        #if AGENTDECK_DOT_PREVIEW
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "AgentDeckDotSupport") as? String, "preview")
        XCTAssertNotNil(Bundle.main.url(forResource: "dot-mcp-contract", withExtension: "json"))
        #else
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "AgentDeckDotSupport") as? String, "excluded")
        XCTAssertNil(Bundle.main.url(forResource: "dot-mcp-contract", withExtension: "json"))
        #endif
    }

    func testIncomingDotDoesNotBreakOrdinarySessions() throws {
        // An external Node/preview daemon may still send Dot. Store clients
        // ignore even incompatible future Dot data instead of losing the roster.
        #if AGENTDECK_DOT_PREVIEW
        let incoming = #"{"type":"sessions_list","sessions":[],"dot":{"configured":true,"hosting":true}}"#
        let event = try JSONDecoder().decode(SessionsListEvent.self, from: Data(incoming.utf8))
        XCTAssertEqual(event.dot?.configured, true)
        #else
        let incoming = #"{"type":"sessions_list","sessions":[],"dot":{"configured":"future-format","appearance":"untrusted"}}"#
        let event = try JSONDecoder().decode(SessionsListEvent.self, from: Data(incoming.utf8))
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(event)) as? [String: Any]
        XCTAssertNil(encoded?["dot"])
        #endif
        XCTAssertEqual(event.type, "sessions_list")
        XCTAssertTrue(event.sessions.isEmpty)
    }

    #if !AGENTDECK_DOT_PREVIEW
    func testStoreMatrixIgnoresDotFromExternalDaemon() {
        let sessions: [String: Any] = ["type": "sessions_list", "sessions": [["id": "one", "alive": true, "state": "idle", "agentType": "codex-cli"]]]
        var withDot = sessions
        withDot["dot"] = ["configured": true, "hosting": true, "reportState": "working", "reportedAt": 1_000, "expiresAt": 20_000]
        var normal = MatrixExpression(), external = MatrixExpression()
        normal.ingest(sessions, now: 1_000)
        external.ingest(withDot, now: 1_000)
        XCTAssertEqual(normal.render(size: 32, now: 1_000), external.render(size: 32, now: 1_000))
    }
    #endif
}

/// Hosted XCTest constructs the actual SwiftUI app before it runs these tests.
/// Only that root must be inert; ordinary fixtures still exercise real behavior.
@MainActor
final class HostedAppIsolationTests: XCTestCase {
    func testEachXCTestLaunchMarkerCreatesAnInertRoot() {
        for key in ["XCTestConfigurationFilePath", "XCTestBundlePath", "XCTestSessionIdentifier"] {
            // Presence, including an empty value, is XCTest's launch signal.
            let holder = AgentDeckApp.makeStateHolder(environment: [key: ""])
            XCTAssertTrue(holder.isInertHost, key)
            XCTAssertNil(holder.connection.onEvent, key)
            XCTAssertNil(holder.connection.onDisconnect, key)
            XCTAssertNil(holder.connection.onAuthenticationRequired, key)
            XCTAssertNil(holder.connection.onReconnectExhausted, key)
            XCTAssertNotNil(holder.timelineGenerator, key)
            assertIdle(holder)
        }
    }

    func testNoXCTestMarkerKeepsTheProductionRootActive() {
        preservingCredentials {
            for environment in [[:], ["AGENTDECK_TEST": "1", "XCTestUnrelated": "1"]] {
                let holder = AgentDeckApp.makeStateHolder(environment: environment)
                defer { holder.prepareForTermination() }
                XCTAssertFalse(holder.isInertHost)
                XCTAssertNotNil(holder.connection.onEvent)
                XCTAssertNotNil(holder.connection.onDisconnect)
            }
        }
    }

    func testInertRootDoesNotMigrateSavedCredentials() {
        preservingCredentials {
            let defaults = UserDefaults.standard
            defaults.set("ws://agentdeck-xctest.invalid:49160?token=synthetic", forKey: "lastBridgeUrl")
            defaults.set(["untouched": "synthetic"], forKey: "pairedBridgeURLs")
            let before = credentialSnapshot()
            let holder = AgentDeckApp.makeStateHolder(environment: ["XCTestBundlePath": "fixture"])
            XCTAssertTrue(holder.isInertHost)
            XCTAssertEqual(credentialSnapshot(), before)
        }
    }

    func testOrdinaryFixtureStillProcessesEventsInsideXCTest() throws {
        try preservingCredentials {
            let root = AgentDeckApp.makeStateHolder(environment: ["XCTestSessionIdentifier": "fixture"])
            let fixture = AgentStateHolder()
            defer { fixture.prepareForTermination() }
            let data = Data(#"{"type":"sessions_list","sessions":[{"id":"synthetic-test-session","port":49160,"alive":true,"state":"idle","agentType":"codex-cli"}]}"#.utf8)
            let event = BridgeEvent.sessionsList(try JSONDecoder().decode(SessionsListEvent.self, from: data))
            root.handleEvent(event)
            fixture.handleEvent(event)
            XCTAssertTrue(root.state.siblingSessions.isEmpty)
            XCTAssertEqual(fixture.state.siblingSessions.map(\.id), ["synthetic-test-session"])
            XCTAssertNotNil(fixture.lastDataReceivedAt)
        }
    }

    func testForegroundRetryAndPreferredBridgeCannotReviveTheRoot() async {
        let holder = AgentDeckApp.makeStateHolder(environment: ["XCTestBundlePath": "fixture"])
        let credentialsBefore = credentialSnapshot()
        // Intentionally invalid: even a regression must not dial a real host.
        let invalidURL = "://invalid test endpoint"
        holder.handleBackgroundEntry()
        holder.handleForegroundReturn()
        holder.startConnectionWaterfall()
        holder.retryConnectionWaterfall()
        holder.setPreferredLocalBridge(url: invalidURL)
        holder.connectTo(url: invalidURL)
        holder.schedulePreferredLocalRecovery(after: 0)
        holder.stopConnectionAttempts()
        holder.disconnectBridge()
        holder.prepareForTermination()
        holder.handleForegroundReturn()
        await settleQueues()
        assertIdle(holder)
        XCTAssertEqual(credentialSnapshot(), credentialsBefore)
    }

    func testDirectTransportAccessCannotReviveTheRoot() async {
        let holder = AgentDeckApp.makeStateHolder(environment: ["XCTestConfigurationFilePath": "fixture"])
        holder.discovery.startSearching()
        holder.connection.connect(to: "://invalid test endpoint")
        holder.connection.forceDisconnectAndRestart()
        await settleQueues()
        assertIdle(holder)
        XCTAssertNil(holder.connection.lastError, "The retired transport must not even parse the endpoint")
    }

    #if DEBUG
    func testLateDiscoveryAndDisconnectCallbacksDoNotAutoConnect() async {
        let holder = AgentDeckApp.makeStateHolder(environment: ["XCTestSessionIdentifier": "fixture"])
        holder.discovery.isBrowserEnabled = false
        await settleQueues()
        holder.discovery.publishForTesting([
            DiscoveredBridge(name: "synthetic", host: "agentdeck-xctest.invalid", port: 49160,
                             token: nil, agentType: "daemon")
        ])
        holder.connection.onDisconnect?()
        holder.connection.onReconnectExhausted?(nil)
        holder.connection.onAuthenticationRequired?()
        await settleQueues()
        assertIdle(holder)
    }
    #endif

    private func assertIdle(_ holder: AgentStateHolder, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(holder.isAutoConnecting, file: file, line: line)
        XCTAssertFalse(holder.state.bridgeConnected, file: file, line: line)
        XCTAssertFalse(holder.discovery.isSearching, file: file, line: line)
        XCTAssertEqual(holder.connection.status, .disconnected, file: file, line: line)
        XCTAssertFalse(holder.connection.isReconnecting, file: file, line: line)
        XCTAssertNil(holder.connection.url, file: file, line: line)
    }

    private func credentialSnapshot() -> NSDictionary {
        let defaults = UserDefaults.standard
        return ["lastBridgeUrl": defaults.object(forKey: "lastBridgeUrl") ?? NSNull(),
                "pairedBridgeURLs": defaults.object(forKey: "pairedBridgeURLs") ?? NSNull()] as NSDictionary
    }

    private func preservingCredentials(_ body: () throws -> Void) rethrows {
        let defaults = UserDefaults.standard
        let saved = ["lastBridgeUrl", "pairedBridgeURLs"].map { ($0, defaults.object(forKey: $0)) }
        defer {
            for (key, value) in saved {
                if let value { defaults.set(value, forKey: key) }
                else { defaults.removeObject(forKey: key) }
            }
        }
        try body()
    }

    private func settleQueues() async {
        try? await Task.sleep(for: .milliseconds(100))
    }
}
