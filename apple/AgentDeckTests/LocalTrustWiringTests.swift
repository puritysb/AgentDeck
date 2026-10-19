#if os(macOS)
// LocalTrustWiringTests.swift — the same-machine trust rule as this daemon
// applies it, not only as LocalTrustRules evaluates it. LocalTrustVectorsTests
// drives the evaluator and HttpAccessPolicyTests takes `isLocal` as an input,
// so reverting the HTTP policy to plain same-machine trust, or deleting the
// WebSocket handshake's Origin check, used to leave the whole suite green.

import Foundation
import XCTest
@testable import AgentDeck

/// The HTTP access policy through `DaemonServer.accessPolicyResponse`, the
/// function the installed policy calls.
final class DaemonAccessPolicyWiringTests: XCTestCase {
    private func request(_ head: String, from remoteIP: String = "127.0.0.1") -> HTTPServer.HTTPRequest {
        HTTPServer.parseHTTPRequest(Data((head + "\r\n\r\n").utf8), remoteIP: remoteIP)
    }

    private func decision(_ request: HTTPServer.HTTPRequest) -> HTTPServer.HTTPResponse? {
        DaemonServer.accessPolicyResponse(for: request, daemonPort: 9120, pairingWindowOpen: false)
    }

    func testALocalProgramKeepsSameMachineTrust() {
        XCTAssertNil(decision(request("POST /hooks/Stop HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nContent-Type: application/json")))
        XCTAssertNil(decision(request("GET /status HTTP/1.1\r\nHost: localhost:9120")))
        XCTAssertNil(decision(request("POST /apme/vibe HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nOrigin: http://127.0.0.1:9120")),
                     "the dashboard this daemon serves posts with its own origin")
    }

    func testAWebPageOnThisMachineIsAnsweredAsALanPeer() throws {
        let post = try XCTUnwrap(decision(request(
            "POST /hooks/Stop HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nOrigin: https://evil.example")))
        XCTAssertEqual(post.status, 401, "a cross-origin POST from a page needs the token")

        let rebound = try XCTUnwrap(decision(request("GET /status HTTP/1.1\r\nHost: rebind.example:9120")))
        XCTAssertEqual(rebound.status, 401, "a rebinding page is a LAN peer")

        // The one route a LAN peer reaches answers it without the token.
        let health = try XCTUnwrap(decision(request("GET /health HTTP/1.1\r\nHost: rebind.example:9120")))
        XCTAssertEqual(health.status, 200)
        let body = try XCTUnwrap(health.body.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertNil(body["pairingToken"], "a rebinding page must not read the token off /health")
    }

    func testAPeerOnTheNetworkStillNeedsTheToken() throws {
        let peer = try XCTUnwrap(decision(request("GET /status HTTP/1.1\r\nHost: 192.0.2.10:9120", from: "192.0.2.10")))
        XCTAssertEqual(peer.status, 401)
    }
}

/// The WebSocket handshake over a real socket: `handleWebSocketUpgrade` is
/// private and takes an NWConnection, so the listener is the only way in.
final class WebSocketUpgradeTrustTests: XCTestCase {
    private func startServer() async throws -> (WebSocketServer, UInt16) {
        let server = WebSocketServer()
        for port in UInt16(19460)..<UInt16(19490) {
            do {
                try await server.start(port: port, loopbackOnly: true)
                return (server, port)
            } catch {
                continue
            }
        }
        throw XCTSkip("no free loopback port for the handshake test")
    }

    /// Sends one upgrade request from 127.0.0.1 and returns the status line.
    private func handshakeStatus(port: UInt16, extraHeaders: String) async throws -> String {
        let task = URLSession.shared.streamTask(withHostName: "127.0.0.1", port: Int(port))
        task.resume()
        defer { task.cancel() }
        let head = "GET / HTTP/1.1\r\nHost: 127.0.0.1:\(port)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\(extraHeaders)\r\n"
        try await task.write(Data(head.utf8), timeout: 5)
        let (data, _) = try await task.readData(ofMinLength: 12, maxLength: 4096, timeout: 5)
        let text = String(decoding: data ?? Data(), as: UTF8.self)
        return text.components(separatedBy: "\r\n").first ?? ""
    }

    func testAWebPageOnThisMachineIsRefusedAtTheHandshake() async throws {
        let (server, port) = try await startServer()
        let page = try await handshakeStatus(port: port, extraHeaders: "Origin: https://evil.example\r\n")
        let program = try await handshakeStatus(port: port, extraHeaders: "")
        let ownPage = try await handshakeStatus(port: port, extraHeaders: "Origin: http://127.0.0.1:\(port)\r\n")
        await server.stop()
        XCTAssertTrue(page.hasPrefix("HTTP/1.1 401"), "a page without the token gets no socket: \(page)")
        XCTAssertTrue(program.hasPrefix("HTTP/1.1 101"), "a local program keeps same-machine trust: \(program)")
        XCTAssertTrue(ownPage.hasPrefix("HTTP/1.1 101"), "a page this server served keeps it too: \(ownPage)")
    }

    func testOnlyTheHeadersAskForAnUpgrade() {
        let hook = "POST /hooks/Stop HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nContent-Type: application/json\r\n\r\n"
            + #"{"last_assistant_message":"send Upgrade: websocket and Connection: Upgrade"}"#
        XCTAssertFalse(WebSocketServer.isWebSocketUpgrade(Data(hook.utf8)),
                       "a hook body quoting the header is an ordinary POST")
        let upgrade = "GET / HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"
        XCTAssertTrue(WebSocketServer.isWebSocketUpgrade(Data(upgrade.utf8)))
    }
}
#endif
