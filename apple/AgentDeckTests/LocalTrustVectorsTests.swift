#if os(macOS)
// LocalTrustVectorsTests.swift — replays shared/local-trust-vectors.json
// against LocalTrust.swift, the same file shared/src/__tests__/local-trust.test.ts
// replays against the TypeScript rule. Either daemon may hold the port, so a
// web page on this machine must be told from a local program identically.

import XCTest
@testable import AgentDeck

final class LocalTrustVectorsTests: XCTestCase {
    private struct Request: Decodable {
        let method: String
        let upgrade: Bool?
        let host: String?
        let origin: String?
    }
    private struct Case: Decodable {
        let note: String
        /// Replaces environment.hostNames for this case.
        let hostNames: [String]?
        let request: Request
        let verdict: String
    }
    private struct Environment: Decodable {
        let port: Int
        let localAddresses: [String]
        let hostNames: [String]
    }
    private struct File: Decodable {
        let environment: Environment
        let cases: [Case]
    }

    private func loadVectors() throws -> File {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // AgentDeckTests/
            .deletingLastPathComponent()   // apple/
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("shared/local-trust-vectors.json")
        return try JSONDecoder().decode(File.self, from: Data(contentsOf: url))
    }

    func testMatchesSharedVectors() throws {
        let file = try loadVectors()
        XCTAssertGreaterThanOrEqual(file.cases.count, 30, "vector file too small to be a gate")
        let addresses = Set(file.environment.localAddresses)
        let env = LocalTrustRules.Environment(
            port: file.environment.port,
            isLocalAddress: { addresses.contains($0) },
            hostNames: file.environment.hostNames)
        XCTAssertEqual(Set(file.cases.map(\.verdict)), ["trusted", "foreign-host", "foreign-origin"],
                       "every verdict must be exercised")
        for c in file.cases {
            let caseEnv = c.hostNames.map {
                LocalTrustRules.Environment(port: env.port, isLocalAddress: env.isLocalAddress, hostNames: $0)
            } ?? env
            let verdict = LocalTrustRules.verdict(
                method: c.request.method, upgrade: c.request.upgrade == true,
                origin: c.request.origin, host: c.request.host, environment: caseEnv)
            XCTAssertEqual(verdict.rawValue, c.verdict, c.note)
        }
    }

    /// The daemon's request adapter reads the lower-cased keys HTTPServer
    /// produces, from a real parsed request.
    func testParsedRequestIsJudgedByItsHostAndOrigin() {
        func parsed(_ head: String) -> HTTPServer.HTTPRequest {
            HTTPServer.parseHTTPRequest(Data((head + "\r\n\r\n").utf8), remoteIP: "127.0.0.1")
        }
        let program = parsed("POST /hooks/Stop HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nContent-Type: application/json")
        XCTAssertEqual(LocalTrust.verdict(for: program, port: 9120), .trusted)

        let page = parsed("POST /hooks/Stop HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nOrigin: https://evil.example")
        XCTAssertEqual(LocalTrust.verdict(for: page, port: 9120), .foreignOrigin)

        let rebound = parsed("GET /health HTTP/1.1\r\nHost: rebind.example:9120")
        XCTAssertEqual(LocalTrust.verdict(for: rebound, port: 9120), .foreignHost)

        let socket = parsed("GET / HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nUpgrade: websocket\r\nOrigin: https://evil.example")
        XCTAssertEqual(LocalTrust.verdict(for: socket, port: 9120), .trusted,
                       "a plain GET keeps trust; only the upgrade checks Origin")
        XCTAssertEqual(LocalTrust.verdict(for: socket, upgrade: true, port: 9120), .foreignOrigin)

        let dashboard = parsed("POST /apme/vibe HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nOrigin: http://127.0.0.1:9120")
        XCTAssertEqual(LocalTrust.verdict(for: dashboard, port: 9120), .trusted,
                       "the dashboard this daemon serves posts with its own origin")
        let forwarded = parsed("POST /apme/vibe HTTP/1.1\r\nHost: 127.0.0.1:19120\r\nOrigin: http://127.0.0.1:19120")
        XCTAssertEqual(LocalTrust.verdict(for: forwarded, port: 9120), .trusted,
                       "through a port forward both headers carry the forwarded port")
        let otherDaemon = parsed("POST /apme/vibe HTTP/1.1\r\nHost: 127.0.0.1:9121\r\nOrigin: http://127.0.0.1:9120")
        XCTAssertEqual(LocalTrust.verdict(for: otherDaemon, port: 9121), .foreignOrigin,
                       "a page the daemon on another port served is not this daemon's")
    }

    /// Asked about an IP origin only, without brackets or a zone, as
    /// AuthManager.isLocalConnection expects.
    func testLocalAddressIsAskedOnlyAboutABareIPOrigin() {
        final class Asked: @unchecked Sendable { var values: [String] = [] }
        let asked = Asked()
        let env = LocalTrustRules.Environment(
            port: 9120, isLocalAddress: { asked.values.append($0); return true }, hostNames: [])
        _ = LocalTrustRules.verdict(method: "POST", upgrade: false, origin: "http://[fe80::1%25en0]:9120",
                               host: "127.0.0.1:9120", environment: env)
        _ = LocalTrustRules.verdict(method: "POST", upgrade: false, origin: "http://localhost:9120",
                               host: "127.0.0.1:9120", environment: env)
        XCTAssertEqual(asked.values, ["fe80::1"])
    }
}

/// The CORS half of the same boundary: a GET keeps local trust whatever page
/// sent it, so an answer is readable by a web page exactly when it carries
/// `Access-Control-Allow-Origin`. Until this was fixed every answer carried it,
/// `/health` and its pairing token included.
final class HTTPCrossOriginTests: XCTestCase {
    private func head(_ response: HTTPServer.HTTPResponse) -> String {
        let data = HTTPServer.formatHTTPResponse(response)
        let text = String(decoding: data, as: UTF8.self)
        return text.components(separatedBy: "\r\n\r\n").first ?? ""
    }

    func testAnAnswerIsNotReadableCrossOriginByDefault() {
        let health = HTTPServer.HTTPResponse.json(["status": "ok", "pairingToken": "x"])
        XCTAssertFalse(head(health).lowercased().contains("access-control-allow-origin"))
        XCTAssertFalse(HTTPServer.formatHTTPHeaders(status: 200, headers: [:])
            .lowercased().contains("access-control-allow-origin"))
    }

    func testARouteOptsInExplicitly() {
        let status = HTTPServer.HTTPResponse.json(["status": "ok"]).allowingAnyOrigin()
        XCTAssertTrue(head(status).contains("Access-Control-Allow-Origin: *"))
        XCTAssertEqual(status.headers["Content-Type"], "application/json", "other headers are kept")
    }
}
#endif
