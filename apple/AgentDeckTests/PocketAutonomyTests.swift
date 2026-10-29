#if os(macOS)
import XCTest
@testable import AgentDeck

final class PocketAutonomyTests: XCTestCase {
    @DaemonActor
    func testNodeVectorsAndAggregateOnlyPersistence() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/pocket-autonomy-vectors.json"))
        let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        for vector in try XCTUnwrap(vectors["cases"] as? [[String: Any]]) {
            let scratch = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: scratch) }
            let actual = try PocketVectorReplay.run(vector, root: scratch)
            XCTAssertEqual(actual as NSArray, vector["expected"] as? NSArray, vector["name"] as? String ?? "")
            let persisted = try String(contentsOf: scratch.appendingPathComponent("pocket-autonomy.json"), encoding: .utf8)
            for privateCopy in ["Secret", "Private", "Dentist", "Seoul", "다른 작업", "resume secret", "quoted"] {
                XCTAssertFalse(persisted.contains(privateCopy), "\(vector["name"] ?? ""): persisted private copy")
            }
        }
    }

    @DaemonActor
    private func withRoutes(_ body: (HTTPServer, URL, DaemonServer) async throws -> Void) async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let prior = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"]
        setenv("AGENTDECK_DATA_DIR", root.path, 1)
        defer {
            if let prior { setenv("AGENTDECK_DATA_DIR", prior, 1) } else { unsetenv("AGENTDECK_DATA_DIR") }
            try? FileManager.default.removeItem(at: root)
        }
        let daemon = try await DaemonServer(port: 19796, debug: false,
            posture: DaemonPosture(loopbackOnly: true, noDeviceModules: true))
        let http = HTTPServer()
        await daemon.setupHTTPRoutes(using: http)
        let listener = WebSocketServer()
        try await listener.start(port: 19796, loopbackOnly: true)
        await listener.setHTTPHandler(http)
        do { try await body(http, root, daemon) }
        catch { await listener.stop(); throw error }
        await listener.stop()
    }

    private func request(_ method: String = "GET", _ path: String = "/feed", query: [String: String] = [:],
                         body: [String: Any]? = nil, remoteIP: String = "127.0.0.1") throws -> HTTPServer.HTTPRequest {
        HTTPServer.HTTPRequest(method: method, path: path, headers: [
            "host": "127.0.0.1:19796", "agentdeck-surface-protocol": "1",
            "agentdeck-surface-profile": "portable-reader/v1", "agentdeck-client-id": "pocket-adaptive-test",
            "agentdeck-client-version": "1.4.1-pocket", "agentdeck-product-id": "io.pocketdaily.reader",
            "agentdeck-board": "xteink_x4", "agentdeck-update-channel": "stable",
            "agentdeck-capabilities": "feed.pull,feed.conditional,outbox.push,glance.read,ota.feed",
        ], body: try body.map { try JSONSerialization.data(withJSONObject: $0) }, queryParams: query, remoteIP: remoteIP)
    }
    private func json(_ response: HTTPServer.HTTPResponse) throws -> [String: Any] {
        XCTAssertEqual(response.status, 200)
        return try XCTUnwrap(response.body.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
    }
    private func adaptive(_ payload: [String: Any]) throws -> [String: Any] {
        let devices = try XCTUnwrap(payload["devices"] as? [[String: Any]])
        return try XCTUnwrap(devices.first { $0["type"] as? String == "card-feed" }?["pocketAutonomy"] as? [String: Any])
    }

    @DaemonActor
    func testActualFeedAndOutboxRoutesKeepConditionalExposureAndPersistentFirstAnswerWins() async throws {
        try await withRoutes { http, root, _ in
            let first = try self.json(await http.route(self.request()))
            let cards = try XCTUnwrap(first["cards"] as? [[String: Any]])
            let quest = try XCTUnwrap(cards.first { ($0["module"] as? [String: Any])?["module"] as? String == "quest" })
            let id = try XCTUnwrap(quest["cardId"] as? String)
            let sig = try XCTUnwrap(first["deckSig"] as? String)
            let conditional = try self.json(await http.route(self.request(query: ["sig": sig])))
            XCTAssertEqual(conditional["unchanged"] as? Bool, true)
            XCTAssertEqual((conditional["cards"] as? [Any])?.count, 0)
            let before = try self.adaptive(self.json(await http.route(self.request("GET", "/devices"))))
            XCTAssertEqual((before["arms"] as? [String: [String: Double]])?["preference"]?["shown"], 1)

            let decision: [String: Any] = ["cardId": id, "action": "card_choice", "choiceId": "work", "ageSec": 600]
            let posted = try self.json(await http.route(self.request("POST", "/outbox", body: ["board": "xteink_x4", "decisions": [decision]])))
            XCTAssertEqual((posted["results"] as? [[String: Any]])?.first?["status"] as? String, "applied")
            var retry = decision; retry["ageSec"] = 800
            _ = try self.json(await http.route(self.request("POST", "/outbox", body: ["board": "xteink_x4", "decisions": [retry]])))
            let after = try self.adaptive(self.json(await http.route(self.request("GET", "/devices"))))
            XCTAssertEqual(after["feedbackCount"] as? Double, 1)
            let next = try self.json(await http.route(self.request()))
            XCTAssertFalse((next["cards"] as? [[String: Any]] ?? []).contains { $0["cardId"] as? String == id })

            // Wait for the real debounced atomic write; never call a test-only
            // flush endpoint. The next server must restore from actual bytes.
            let statePath = root.appendingPathComponent("pocket-autonomy.json")
            var persisted: [String: Any] = [:]
            for _ in 0..<100 {
                if let data = try? Data(contentsOf: statePath),
                   let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { persisted = value }
                if persisted["feedbackCount"] as? Double == 1 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertEqual(persisted["feedbackCount"] as? Double, 1)
            let restored = try await DaemonServer(port: 19797, debug: false,
                posture: DaemonPosture(loopbackOnly: true, noDeviceModules: true))
            let restoredHTTP = HTTPServer(); await restored.setupHTTPRoutes(using: restoredHTTP)
            var conflict = decision; conflict["choiceId"] = "day"
            _ = try self.json(await restoredHTTP.route(self.request("POST", "/outbox", body: ["board": "xteink_x4", "decisions": [conflict]])))
            let restoredDiag = try self.adaptive(self.json(await restoredHTTP.route(self.request("GET", "/devices"))))
            XCTAssertEqual(restoredDiag["feedbackCount"] as? Double, 1)
            // HTTPServer.route dispatches handlers directly; the policy runs
            // in the listener. Exercise that actual boundary over the socket.
            var forbidden = URLRequest(url: URL(string: "http://127.0.0.1:19796/outbox")!)
            forbidden.httpMethod = "POST"; forbidden.timeoutInterval = 3
            forbidden.setValue("https://untrusted.example", forHTTPHeaderField: "Origin")
            forbidden.httpBody = try JSONSerialization.data(withJSONObject: ["board": "xteink_x4", "decisions": [decision]])
            let (_, denied) = try await URLSession.shared.data(for: forbidden)
            XCTAssertEqual((denied as? HTTPURLResponse)?.statusCode, 401)
        }
    }

    @DaemonActor
    func testOTAFirstEnvelopeNeverRecordsAdaptiveExposure() async throws {
        try await withRoutes { http, _, _ in
            _ = try self.json(await http.route(self.request("POST", "/esp32/ota", body: [
                "target": "xteink_x4", "stage": true, "productId": "io.pocketdaily.reader",
                "board": "xteink_x4", "updateChannel": "stable",
                "firmwareB64": Data(repeating: 0x41, count: 40 * 1024).base64EncodedString(),
            ])))
            let feed = try self.json(await http.route(self.request()))
            XCTAssertNotNil(feed["fw"])
            XCTAssertEqual(feed["unchanged"] as? Bool, true)
            XCTAssertEqual((feed["cards"] as? [Any])?.count, 0)
            let diagnostics = try self.adaptive(self.json(await http.route(self.request("GET", "/devices"))))
            XCTAssertEqual(diagnostics["pendingExposures"] as? Int, 0)
            XCTAssertEqual((diagnostics["arms"] as? [String: Any])?.count, 0)
        }
    }

    @DaemonActor
    func testStoppingDaemonRefusesLateFeedAndOutboxWithoutChangingLearning() async throws {
        try await withRoutes { http, root, daemon in
            let feed = try self.json(await http.route(self.request()))
            let id = try XCTUnwrap((feed["cards"] as? [[String: Any]])?.first?["cardId"] as? String)
            await daemon.shutdown()
            var stopped = false
            for _ in 0..<100 {
                if await http.route(try self.request()).status == 503 { stopped = true; break }
                try await Task.sleep(for: .milliseconds(10))
            }
            XCTAssertTrue(stopped)
            let stateURL = root.appendingPathComponent("pocket-autonomy.json")
            let before = try Data(contentsOf: stateURL)
            let late = await http.route(try self.request("POST", "/outbox", body: [
                "board": "xteink_x4", "decisions": [["cardId": id, "action": "card_choice", "choiceId": "day"]],
            ]))
            XCTAssertEqual(late.status, 503)
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertEqual(try Data(contentsOf: stateURL), before)
        }
    }
}
#endif
