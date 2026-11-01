#if os(macOS)
import XCTest
@testable import AgentDeck

final class DaemonConfigurationTests: XCTestCase {
    func testSharedConfigurationAndRevisionVectors() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/daemon-configuration-vectors.json")
        let rows = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [[String: Any]]
        for row in rows {
            let parsed = try? DaemonConfigurationRules.parse(row["value"])
            XCTAssertEqual(parsed != nil, row["valid"] as? Bool, row["name"] as? String ?? "")
            if let parsed { XCTAssertEqual(parsed.pixoo.revision, row["pixooRevision"] as? String) }
        }
    }
    func testNativeEditorTargetsEitherOwnerAndRefusesStaleEdits() async throws {
        let http = HTTPServer(), listener = WebSocketServer()
        let backend = PixooEditorFixture()
        await http.get("/health") { _ in .json(["pairingToken": "synthetic-editor-token"]) }
        await http.get("/configuration/pixoo") { request in await backend.get(request) }
        await http.post("/configuration/pixoo") { request in await backend.post(request) }
        try await listener.start(port: 19797, loopbackOnly: true)
        await listener.setHTTPHandler(http)
        do {
            let endpoint = "ws://127.0.0.1:19797"
            let initial = try await PixooConfigurationClient.request(connectionURL: endpoint)
            let edited = PixooConfiguration(devices: [.init(ip: "127.0.0.2", name: "Desk", brightness: 27, animation: "tide")], autoDiscover: false)
            let saved = try await PixooConfigurationClient.request(connectionURL: endpoint, configuration: edited, revision: initial.revision)
            XCTAssertEqual(saved.configuration, edited)
            do {
                _ = try await PixooConfigurationClient.request(connectionURL: endpoint, configuration: .init(devices: [], autoDiscover: false), revision: initial.revision)
                XCTFail("A stale editor must not erase the new devices")
            } catch { XCTAssertEqual((error as NSError).code, 409) }
            let current = try await PixooConfigurationClient.request(connectionURL: endpoint)
            XCTAssertEqual(current.configuration, edited)
            await listener.stop()
        } catch { await listener.stop(); throw error }
    }

    @DaemonActor
    func testPeerAdoptionPreservesLocalExtrasAndOfflineChanges() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let root: [String: Any] = ["unrelated": ["keep": true], "pixooDevices": [["ip": "127.0.0.2", "future": "preserved"]]]
        try JSONSerialization.data(withJSONObject: root).write(to: dir.appendingPathComponent("settings.json"))
        let order = SessionOrderStore(fileURL: dir.appendingPathComponent("session-order.json")).load()
        order.set("inactive", weight: 10)
        let store = DaemonConfigurationStore(directory: dir, order: order)
        let value = DaemonConfiguration(version: 1, pins: [.init(id: "active", weight: -5, updatedAt: 1, lastSeenAt: Int64(Date().timeIntervalSince1970 * 1000))],
            pixoo: .init(devices: [.init(ip: "127.0.0.2", name: "Desk", brightness: 27, animation: "tide")], autoDiscover: false))
        try store.adopt(value)
        XCTAssertEqual(order.weightFor("active"), -5); XCTAssertNil(order.weightFor("inactive"))
        let saved = try store.root()
        XCTAssertEqual((saved["unrelated"] as? [String: Bool])?["keep"], true)
        XCTAssertEqual((saved["pixooDevices"] as? [[String: Any]])?.first?["future"] as? String, "preserved")
        XCTAssertTrue(try FileManager.default.contentsOfDirectory(atPath: dir.path).contains { $0.hasPrefix("daemon-configuration-profile-") })
        try store.save(.init(devices: [], autoDiscover: false))
        XCTAssertEqual(try store.pixoo().devices, [])
        try Data("{broken".utf8).write(to: dir.appendingPathComponent("settings.json"))
        XCTAssertThrowsError(try store.save(value.pixoo))
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("settings.json"), encoding: .utf8), "{broken")
        try Data("{}".utf8).write(to: dir.appendingPathComponent("settings.json"))
        let corrupt = #"{"version":1,"pins":{"good":{"weight":-5,"updatedAt":1,"lastSeenAt":1793500000000},"bad":{"weight":"broken"}}}"#
        try Data(corrupt.utf8).write(to: dir.appendingPathComponent("session-order.json"))
        XCTAssertThrowsError(try store.snapshot())
        XCTAssertEqual(try String(contentsOf: dir.appendingPathComponent("session-order.json"), encoding: .utf8), corrupt)
    }
}
private actor PixooEditorFixture {
    var configuration = PixooConfiguration(devices: [], autoDiscover: false)
    func get(_ request: HTTPServer.HTTPRequest) -> HTTPServer.HTTPResponse {
        guard request.headers["authorization"] == "Bearer synthetic-editor-token" else { return .json(["error": "unauthorized"], status: 401) }
        let raw = try! JSONSerialization.jsonObject(with: DaemonConfigurationRules.data(configuration))
        return .json(["configuration": raw, "revision": configuration.revision])
    }
    func post(_ request: HTTPServer.HTTPRequest) -> HTTPServer.HTTPResponse {
        guard request.headers["authorization"] == "Bearer synthetic-editor-token" else { return .json(["error": "unauthorized"], status: 401) }
        guard let data = request.body, let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              raw["revision"] as? String == configuration.revision else { return .json(["error": "stale"], status: 409) }
        guard let next = try? DaemonConfigurationRules.pixoo(raw["configuration"]) else { return .json(["error": "invalid"], status: 400) }
        configuration = next; return get(request)
    }
}
#endif
