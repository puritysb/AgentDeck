import XCTest
import Foundation
import Darwin
@testable import NativeClientCore

private final class MemoryVault: CredentialVault {
    var value: Credentials?
    var saves: [Credentials] = []
    var failFinalSave = false
    var failMarkerSave = false
    var loads = 0
    func load() throws -> Credentials? { loads += 1; return value }
    func save(_ value: Credentials) throws {
        if failMarkerSave && value.refreshing { throw ClientFailure.keychain(-25308) }
        if failFinalSave && !value.refreshing { throw ClientFailure.unsafeStorage }
        self.value = value; saves.append(value)
    }
    func remove() throws { value = nil }
}
private final class MockTransport: Transport {
    var requests: [URLRequest] = []
    var respond: (URLRequest) throws -> HTTPReply = { _ in throw ClientFailure.unavailable }
    func send(_ request: URLRequest) throws -> HTTPReply { requests.append(request); return try respond(request) }
}
private func tokens(_ resource: String = "http://127.0.0.1:9476", access: String = "b", refresh: String = "s") throws -> Data {
    try Contract.encode(["token_type": "Bearer", "resource": resource, "scope": "agentdeck:read agentdeck:report", "expires_in": 300,
                         "access_token": String(repeating: access, count: 43), "refresh_token": String(repeating: refresh, count: 43)])
}
private func credential(expiry: Int = 400_000) -> Credentials {
    Credentials(resource: "http://127.0.0.1:9476", clientID: DotLocalMCP.clientId, access: String(repeating: "a", count: 43), refresh: String(repeating: "r", count: 43), expiresAt: expiry, refreshing: false)
}
private func reply(_ request: URLRequest, result: [String: Any] = ["accepted": true]) throws -> HTTPReply {
    let rpc = try Contract.object(request.httpBody!)
    return HTTPReply(status: 200, body: try Contract.encode(["jsonrpc": "2.0", "id": rpc["id"]!, "result": result]))
}
private func fields(_ data: Data?) -> [String: String] {
    let raw = String(data: data ?? Data(), encoding: .utf8) ?? ""
    return Dictionary(uniqueKeysWithValues: (URLComponents(string: "http://localhost/?" + raw)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
}

final class ClientTests: XCTestCase {
    func testCanonicalToolsAndValidationRejectBeforeStorageOrNetwork() throws {
        XCTAssertEqual(Set(Contract.tools.compactMap { $0["name"] as? String }), Set(["get_request", "get_context", "claim_request", "report_update"]))
        let vault = MemoryVault(), transport = MockTransport()
        let client = LocalClient(endpoint: try Endpoint(), vault: vault, transport: transport)
        for (tool, arguments): (String, [String: Any]) in [
            ("exec", ["requestId": "r"]), ("get_request", ["requestId": "foreign"]),
            ("get_request", ["requestId": "r", "url": "https://example.com"]),
            ("report_update", ["requestId": "r", "attemptId": "a", "sequence": true, "state": "working", "summary": "x", "idempotencyKey": "k"]),
            ("report_update", ["requestId": "r", "attemptId": "a", "sequence": 1.5, "state": "working", "summary": "x", "idempotencyKey": "k"])
        ] { XCTAssertThrowsError(try client.call(tool: tool, arguments: arguments, requestID: "r")) }
        XCTAssertEqual(vault.loads, 0); XCTAssertTrue(transport.requests.isEmpty)
    }
    func testJSONEncodingRejectsInvalidGraphsBeforeFoundationSerialization() throws {
        for value: Any in [Date(), "scalar", NSNull(), ["value": Double.nan], ["value": Double.infinity], ["value": Date()]] {
            XCTAssertThrowsError(try Contract.encode(value))
        }
        XCTAssertNoThrow(try Contract.encode(["value": NSNull(), "items": [1, 2]]))
    }
    func testEndpointAndPKCE() throws {
        for port in [80, 9120, 9125, 9139, 9477, 65536] { XCTAssertThrowsError(try Endpoint(port: port)) }
        XCTAssertEqual(try Endpoint(port: 19476).resource, "http://127.0.0.1:19476")
        XCTAssertEqual(LocalClient.challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertThrowsError(try Endpoint().url("/operator/status"))
    }
    func testAuthorizePKCEAndStateVerifiedAndNoTokenInConsent() throws {
        let vault = MemoryVault(), transport = MockTransport()
        var authorization: [String: String] = [:], pending: [String: Any] = [:]
        transport.respond = { request in
            switch request.url!.path {
            case "/oauth/authorize":
                authorization = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
                return HTTPReply(status: 302, location: "/oauth/status?id=" + String(repeating: "p", count: 43))
            case "/oauth/status":
                return HTTPReply(status: 302, location: authorization["redirect_uri"]! + "?" + LocalClient.form(["code": String(repeating: "c", count: 43), "state": authorization["state"]!, "iss": authorization["resource"]!]))
            case "/oauth/token":
                let form = fields(request.httpBody)
                XCTAssertEqual(LocalClient.challenge(form["code_verifier"]!), authorization["code_challenge"])
                XCTAssertEqual(form["resource"], "http://127.0.0.1:9476")
                return HTTPReply(status: 200, body: try tokens())
            default: throw ClientFailure.invalidInput
            }
        }
        try LocalClient(endpoint: Endpoint(), vault: vault, transport: transport, clock: { 100_000 }).authorize { pending = $0 }
        XCTAssertNotNil(vault.value); XCTAssertFalse(vault.value!.refreshing)
        XCTAssertEqual(Set(pending.keys), Set(["consentId", "verificationCode", "scopes"]))
        XCTAssertEqual(transport.requests.count, 3)
    }
    func testAuthorizeRejectsWrongIssuerStateAndDuplicateQueryBeforeExchange() throws {
        for patch in ["issuer", "state", "duplicate"] {
            let vault = MemoryVault(), transport = MockTransport(); var query: [String: String] = [:]
            transport.respond = { request in
                if request.url!.path == "/oauth/authorize" {
                    query = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
                    return HTTPReply(status: 302, location: "/oauth/status?id=" + String(repeating: "p", count: 43))
                }
                let location = query["redirect_uri"]! + "?" + LocalClient.form(["code": String(repeating: "c", count: 43), "state": patch == "state" ? "foreign" : query["state"]!, "iss": patch == "issuer" ? "http://127.0.0.1:19476" : query["resource"]!]) + (patch == "duplicate" ? "&state=another" : "")
                return HTTPReply(status: 302, location: location)
            }
            XCTAssertThrowsError(try LocalClient(endpoint: Endpoint(), vault: vault, transport: transport).authorize { _ in })
            XCTAssertNil(vault.value); XCTAssertEqual(transport.requests.count, 2)
        }
    }
    func testRejectsTokenScopeDuplicatesEscalationAndBadLifetime() throws {
        let client = LocalClient(endpoint: try Endpoint(), vault: MemoryVault())
        let baseline = try Contract.object(tokens())
        for patch: [String: Any] in [["scope": "agentdeck:read agentdeck:report agentdeck:report"], ["scope": "agentdeck:read agentdeck:report agentdeck:subscribe"], ["expires_in": true], ["expires_in": 301], ["resource": "https://example.com"]] {
            XCTAssertThrowsError(try client.token(Contract.encode(baseline.merging(patch) { _, new in new })))
        }
    }
    func testRefreshMarkerPrecedesNetworkAndNewCredentialsAreUsed() throws {
        let vault = MemoryVault(), transport = MockTransport(); vault.value = credential(expiry: 100_000)
        transport.respond = { request in
            if request.url!.path == "/oauth/token" {
                XCTAssertEqual(vault.value?.refreshing, true)
                return HTTPReply(status: 200, body: try tokens())
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer " + String(repeating: "b", count: 43))
            return try reply(request)
        }
        _ = try LocalClient(endpoint: Endpoint(), vault: vault, transport: transport, clock: { 100_000 }).call(tool: "get_request", arguments: ["requestId": "r"])
        XCTAssertEqual(vault.saves.map(\.refreshing), [true, false]); XCTAssertEqual(transport.requests.count, 2)
    }
    func testUncertainRefreshAndFailedPersistenceNeverReplayAfterRestart() throws {
        for lostResponse in [true, false] {
            let vault = MemoryVault(), transport = MockTransport(); vault.value = credential(expiry: 100_000); vault.failFinalSave = !lostResponse
            transport.respond = { _ in
                if lostResponse { throw ClientFailure.deadline }
                return HTTPReply(status: 200, body: try tokens())
            }
            let first = LocalClient(endpoint: try Endpoint(), vault: vault, transport: transport, clock: { 100_000 })
            XCTAssertThrowsError(try first.call(tool: "get_request", arguments: ["requestId": "r"])) { error in
                XCTAssertEqual(error as? ClientFailure, .reconnectRequired)
            }
            XCTAssertThrowsError(try first.call(tool: "get_request", arguments: ["requestId": "r"]))
            XCTAssertThrowsError(try LocalClient(endpoint: Endpoint(), vault: vault, transport: transport, clock: { 100_000 }).call(tool: "get_request", arguments: ["requestId": "r"]))
            XCTAssertEqual(transport.requests.count, 1); XCTAssertEqual(vault.value?.refreshing, true)
        }
    }
    func testLockedKeychainBeforeRefreshDoesNotQuarantineUnsentCredential() throws {
        let vault = MemoryVault(), transport = MockTransport(); vault.value = credential(expiry: 100_000)
        vault.failMarkerSave = true
        let client = LocalClient(endpoint: try Endpoint(), vault: vault, transport: transport, clock: { 100_000 })
        XCTAssertThrowsError(try client.call(tool: "get_request", arguments: ["requestId": "r"])) { error in
            XCTAssertEqual(error as? ClientFailure, .keychain(-25308))
        }
        XCTAssertTrue(transport.requests.isEmpty)
        XCTAssertEqual(vault.value?.refreshing, false)
        vault.failMarkerSave = false
        transport.respond = { request in
            if request.url!.path == "/oauth/token" { return HTTPReply(status: 200, body: try tokens()) }
            return try reply(request)
        }
        XCTAssertNoThrow(try client.call(tool: "get_request", arguments: ["requestId": "r"]))
        XCTAssertEqual(transport.requests.count, 2)
        XCTAssertEqual(vault.saves.map(\.refreshing), [true, false])
    }
    func testExistingAndRejectedConnectionsGiveActionableRecoveryWithoutReplacingCredentials() throws {
        let vault = MemoryVault(), transport = MockTransport(); vault.value = credential()
        let client = LocalClient(endpoint: try Endpoint(), vault: vault, transport: transport, clock: { 100_000 })
        XCTAssertThrowsError(try client.authorize { _ in XCTFail("Existing credentials must not create another consent") }) { error in
            XCTAssertEqual(error as? ClientFailure, .connectionExists)
        }
        XCTAssertTrue(transport.requests.isEmpty)
        transport.respond = { _ in HTTPReply(status: 401) }
        XCTAssertThrowsError(try client.call(tool: "get_request", arguments: ["requestId": "r"])) { error in
            XCTAssertEqual(error as? ClientFailure, .reconnectRequired)
        }
        XCTAssertEqual(vault.value, credential())
        XCTAssertTrue(ClientFailure.reconnectRequired.description.contains("disconnect"))
        XCTAssertTrue(ClientFailure.connectionExists.description.contains("same account and port"))
    }
    func testConsentDenialDoesNotExchangeOrSaveCredentials() throws {
        let vault = MemoryVault(), transport = MockTransport(); var authorization: [String: String] = [:]
        transport.respond = { request in
            if request.url!.path == "/oauth/authorize" {
                authorization = Dictionary(uniqueKeysWithValues: URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems!.map { ($0.name, $0.value!) })
                return HTTPReply(status: 302, location: "/oauth/status?id=" + String(repeating: "p", count: 43))
            }
            return HTTPReply(status: 302, location: authorization["redirect_uri"]! + "?" + LocalClient.form([
                "error": "access_denied", "state": authorization["state"]!, "iss": authorization["resource"]!]))
        }
        XCTAssertThrowsError(try LocalClient(endpoint: Endpoint(), vault: vault, transport: transport).authorize { _ in }) { error in
            XCTAssertEqual(error as? ClientFailure, .authorizationDenied)
        }
        XCTAssertNil(vault.value); XCTAssertTrue(vault.saves.isEmpty)
        XCTAssertEqual(transport.requests.map { $0.url!.path }, ["/oauth/authorize", "/oauth/status"])
    }
    func testTemporaryAuthorizationServerFailureIsNotReportedAsMissingConsent() throws {
        for status in [429, 503] {
            let vault = MemoryVault(), transport = MockTransport()
            transport.respond = { _ in HTTPReply(status: status) }
            XCTAssertThrowsError(try LocalClient(endpoint: Endpoint(), vault: vault, transport: transport).authorize { _ in }) { error in
                XCTAssertEqual(error as? ClientFailure, .unavailable)
            }
            XCTAssertNil(vault.value); XCTAssertEqual(transport.requests.count, 1)
        }
    }
    func testReportIsNotRetriedAndReauthorizationRecoversExistingFrontend() throws {
        let vault = MemoryVault(), transport = MockTransport(); vault.value = credential()
        let client = LocalClient(endpoint: try Endpoint(), vault: vault, transport: transport, clock: { 100_000 })
        transport.respond = { _ in HTTPReply(status: 401) }
        XCTAssertThrowsError(try client.call(tool: "get_request", arguments: ["requestId": "r"]))
        XCTAssertThrowsError(try client.call(tool: "get_request", arguments: ["requestId": "r"]))
        XCTAssertEqual(transport.requests.count, 1)
        vault.value = try client.token(tokens())
        transport.respond = { try reply($0) }
        XCTAssertNoThrow(try client.call(tool: "get_request", arguments: ["requestId": "r"]))
        transport.respond = { _ in throw ClientFailure.deadline }
        XCTAssertThrowsError(try client.call(tool: "report_update", arguments: ["requestId": "r", "attemptId": "a", "sequence": 1, "state": "working", "summary": "test", "idempotencyKey": "k"]))
        XCTAssertEqual(transport.requests.count, 3)
    }
    func testDisconnectCanRevokeAfterUncertainRefreshWithoutRefreshReplay() throws {
        let vault = MemoryVault(), transport = MockTransport(); vault.value = credential(expiry: 1); vault.value!.refreshing = true
        transport.respond = { request in
            XCTAssertEqual(request.url!.path, "/oauth/revoke")
            XCTAssertEqual(fields(request.httpBody)["token"], String(repeating: "r", count: 43))
            return HTTPReply(status: 200)
        }
        try LocalClient(endpoint: Endpoint(), vault: vault, transport: transport).disconnect()
        XCTAssertNil(vault.value); XCTAssertEqual(transport.requests.count, 1)
    }
    func testMCPDiscoveryUsesCanonicalFourSchemasWithoutCredentials() throws {
        let vault = MemoryVault(), transport = MockTransport()
        let frontend = MCPFrontend(client: LocalClient(endpoint: try Endpoint(), vault: vault, transport: transport))
        let response = frontend.handle(["jsonrpc": "2.0", "id": 1, "method": "tools/list"])
        let actual = (response?["result"] as? [String: Any])?["tools"] as? [[String: Any]]
        XCTAssertEqual(try Contract.encode(actual!), try Contract.encode(Contract.tools))
        XCTAssertNil(frontend.handle(["jsonrpc": "2.0", "method": "notifications/initialized"]))
        XCTAssertNotNil(frontend.handle(["jsonrpc": "2.0", "id": true, "method": "ping"])?["error"])
        XCTAssertNotNil(frontend.handle(["jsonrpc": "2.0", "id": 2, "method": "events/subscribe"])?["error"])
        XCTAssertEqual(vault.loads, 0); XCTAssertTrue(transport.requests.isEmpty)
    }
}

extension ClientTests {
    func testAuthorizationStatusAcceptsOnlyExactRelativeOrSameOriginLocations() throws {
        let suffix = "/oauth/status?id=" + String(repeating: "p", count: 43)
        let locations = [suffix, "http://127.0.0.1:9476" + suffix,
                         "http://127.0.0.1:19476" + suffix, "//127.0.0.1:9476" + suffix,
                         "http://user@127.0.0.1:9476" + suffix, suffix + "&id=another", suffix + "#fragment"]
        for (index, location) in locations.enumerated() {
            let vault = MemoryVault(), transport = MockTransport()
            transport.respond = { request in
                if request.url!.path == "/oauth/authorize" { return HTTPReply(status: 302, location: location) }
                // Stop after reaching the validated status route; no authorization state is changed.
                throw ClientFailure.deadline
            }
            XCTAssertThrowsError(try LocalClient(endpoint: Endpoint(), vault: vault, transport: transport).authorize { _ in })
            XCTAssertEqual(transport.requests.count, index < 2 ? 2 : 1, location)
            XCTAssertNil(vault.value)
        }
    }
}
