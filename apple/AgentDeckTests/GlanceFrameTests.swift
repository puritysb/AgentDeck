#if os(macOS)
import XCTest
@testable import AgentDeck

final class GlanceFrameTests: XCTestCase {
    @DaemonActor
    func testActualRoutesIdentityConditionalGeometryPNGAndAuth() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let prior = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"]
        setenv("AGENTDECK_DATA_DIR", root.path, 1)
        defer {
            if let prior { setenv("AGENTDECK_DATA_DIR", prior, 1) } else { unsetenv("AGENTDECK_DATA_DIR") }
            try? FileManager.default.removeItem(at: root)
        }
        let daemon = try await DaemonServer(port: 19798, debug: false,
            posture: DaemonPosture(loopbackOnly: true, noDeviceModules: true))
        let http = HTTPServer(); await daemon.setupHTTPRoutes(using: http)
        let listener = WebSocketServer()
        try await listener.start(port: 19798, loopbackOnly: true); await listener.setHTTPHandler(http)
        do {
            func request(_ query: [String: String] = [:], headers: [String: String] = [:]) -> HTTPServer.HTTPRequest {
                .init(method: "GET", path: "/glance-frame", headers: headers, body: nil, queryParams: query, remoteIP: "127.0.0.1")
            }
            let first = await http.route(request())
            XCTAssertEqual(first.status, 200)
            XCTAssertEqual(first.headers["X-Frame-Width"], "792")
            XCTAssertEqual(first.headers["X-Frame-Height"], "528")
            XCTAssertEqual(first.body?.count, 99 * 528)
            XCTAssertEqual(first.headers["Content-Type"], "application/octet-stream")
            let sig = try XCTUnwrap(first.headers["X-Frame-Sig"])
            let same = await http.route(request(["sig":sig]))
            XCTAssertEqual(same.status, 304); XCTAssertEqual(same.body?.count, 0)
            XCTAssertEqual(same.headers["X-Frame-Sig"], sig)
            XCTAssertEqual(same.headers["Cache-Control"], "no-store")
            let custom = await http.route(request(["w":"529.4","h":"797.4"]))
            XCTAssertEqual(custom.headers["X-Frame-Width"], "529")
            XCTAssertEqual(custom.body?.count, 67 * 797)
            XCTAssertNotEqual(custom.headers["X-Frame-Sig"], sig)
            let radix = await http.route(request(["w":" 0x211 ","h":"0o1435"]))
            XCTAssertEqual(radix.headers["X-Frame-Sig"], custom.headers["X-Frame-Sig"])
            let invalid = await http.route(request(["w":"1601","h":"500","board":"unknown"]))
            XCTAssertEqual(invalid.headers["X-Frame-Sig"], sig)
            let alias = await http.route(request(["board":"inkdeck"]))
            let canonical = await http.route(request(["board":"trmnl_75"]))
            XCTAssertEqual(alias.headers["X-Frame-Sig"], canonical.headers["X-Frame-Sig"])
            let png = await http.route(request(["format":"png","board":"xteink_x4"]))
            XCTAssertEqual(png.headers["Content-Type"], "image/png")
            XCTAssertEqual(png.body?.prefix(8), Data([137,80,78,71,13,10,26,10]))
            var identity = ["agentdeck-surface-protocol":"1", "agentdeck-surface-profile":"portable-reader/v1",
                "agentdeck-client-id":"glance-test", "agentdeck-client-version":"1.4.1-pocket",
                "agentdeck-product-id":"io.pocketdaily.reader", "agentdeck-board":"xteink_x4",
                "agentdeck-update-channel":"stable", "agentdeck-capabilities":"glance.read"]
            let declared = await http.route(request(headers: identity))
            XCTAssertEqual(declared.status, 200); XCTAssertEqual(declared.headers["X-Frame-Width"], "800")
            let mismatch = await http.route(request(["board":"xteink_x3"], headers: identity))
            XCTAssertEqual(mismatch.status, 409)
            identity["agentdeck-capabilities"] = "feed.pull"
            let forbidden = await http.route(request(headers: identity)); XCTAssertEqual(forbidden.status, 403)
            identity.removeValue(forKey: "agentdeck-client-id")
            let incomplete = await http.route(request(headers: identity)); XCTAssertEqual(incomplete.status, 400)
            // The listener owns the centralized LAN/browser auth gate.
            var browser = URLRequest(url: URL(string: "http://127.0.0.1:19798/glance-frame")!)
            browser.httpMethod = "POST"
            browser.timeoutInterval = 3; browser.setValue("https://untrusted.example", forHTTPHeaderField: "Origin")
            let (_, denied) = try await URLSession.shared.data(for: browser)
            XCTAssertEqual((denied as? HTTPURLResponse)?.statusCode, 401)
            await daemon.shutdown()
            let stopped = await http.route(request()); XCTAssertEqual(stopped.status, 503)
        } catch { await listener.stop(); throw error }
        await listener.stop()
    }
}
#endif
