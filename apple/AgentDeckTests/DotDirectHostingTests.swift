#if os(macOS)
import XCTest
import SwiftUI
import AppKit
import RealityKit
@testable import AgentDeck

final class DotDirectHostingTests: XCTestCase {
    @MainActor
    func testCompanionPreviewRendersReportedStates() throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        func snapshot(_ status: String, age: Int = 0) -> DotHostSnapshot {
            var row = DotBriefing(id: "preview", owner: "owner", profile: "desk", key: "key", fingerprint: "hash", context: "", capturedAt: now, createdAt: now, expiresAt: now + DotLimits.requestMs, eventId: "event", subscriptionId: "sub", delivery: "accepted", attempts: 1, nextAttemptAt: now)
            row.report = DotReport(sequence: 1, state: status, summary: "검증된 브리핑 결과", receivedAt: now - age)
            return DotHostSnapshot(hosting: true, available: true, status: "Listening", origin: "https://preview.example", clientID: "preview", consents: [], grants: [DotGrant(id: "owner", scopes: [], expiresAt: now + 1000, revoked: false)], reports: [row])
        }
        let view = VStack(alignment: .leading, spacing: 12) {
            DotCompanionView(snapshot: snapshot("working"))
            DotCompanionView(snapshot: snapshot("needs_attention"))
            DotCompanionView(snapshot: snapshot("working", age: DotLimits.reportFreshMs))
        }.padding(24).background(DesignTokens.Ink.s900).environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: view); renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        XCTAssertGreaterThan(image.width, 300); XCTAssertGreaterThan(image.height, 300)
        let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: "/tmp/agentdeck-dot-companion-preview.png"))
    }
    @MainActor
    func testThreeDimensionalCompanionIsSeparateFromSessionsAndHonorsMotion() {
        let now = 1800000000000
        var row = DotBriefing(id: "3d", owner: "owner", profile: "desk", key: "k", fingerprint: "h", context: "", capturedAt: now, createdAt: now,
            expiresAt: now + DotLimits.requestMs, eventId: "e", subscriptionId: "s", delivery: "accepted", attempts: 1, nextAttemptAt: now)
        row.report = .init(sequence: 1, state: "working", summary: "", receivedAt: now)
        var snapshot = DotHostSnapshot(hosting: true, available: true, status: "Listening", origin: "https://example.test", clientID: "id", consents: [],
            grants: [DotGrant(id: "owner", scopes: [], expiresAt: now + 1000, revoked: false)], reports: [row])
        let resident = DotAquariumResident()
        XCTAssertFalse(resident.root.isEnabled)
        resident.sync(snapshot, now: now)
        XCTAssertTrue(resident.root.isEnabled)
        XCTAssertNil(AquariumResidents.sessionID(for: resident.root))
        XCTAssertTrue(DotAquariumResident.contains(resident.root.children.first!))
        XCTAssertGreaterThan(resident.root.visualBounds(relativeTo: resident.root).extents.x, 0.5)
        let home = resident.root.position
        resident.step(1); XCTAssertEqual(resident.root.position, home)
        resident.animate = true; resident.step(1); XCTAssertNotEqual(resident.root.position, home)
        resident.sync(snapshot, now: now + DotLimits.reportFreshMs)
        resident.step(1); XCTAssertEqual(resident.root.position, home)
        snapshot.origin = ""; resident.sync(snapshot, now: now); XCTAssertFalse(resident.root.isEnabled)
    }
    @MainActor
    func testRelationshipPreviewShowsDirectionAndUnverifiedTarget() throws {
        let now = 1800000000000
        let events = [
            DotInteractionEvent(relationId: "r1", sequence: 1, kind: "delegation", direction: "dot_to_agent", stage: "requested", targetRef: "codex-session-ref", summary: "Run the targeted tests", evidence: "dot_report", receivedAt: now),
            DotInteractionEvent(relationId: "r2", sequence: 1, kind: "result", direction: "agent_to_dot", stage: "completed", targetRef: nil, summary: "Result received — target acknowledgement has not been verified", evidence: "dot_report", receivedAt: now - DotLimits.reportFreshMs)
        ]
        let view = DotInteractionView(events: events, now: now).padding(24).frame(width: 540)
            .background(DesignTokens.Ink.s900).environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: view); renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let png = try XCTUnwrap(NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: "/tmp/agentdeck-dot-relations-preview.png"))
    }
    func testDeckSnapshotIsSeparateBoundedAndExpiresWithoutLeakingContext() throws {
        let now = 1800000000000
        var row = DotBriefing(id: "request", owner: "private-owner", profile: "desk", key: "k", fingerprint: "h", context: "private-context", capturedAt: now, createdAt: now, expiresAt: now + DotLimits.requestMs, eventId: "e", subscriptionId: "s", delivery: "accepted", attempts: 1, nextAttemptAt: now)
        row.report = .init(sequence: 1, state: "working", summary: "private-summary", receivedAt: now)
        var snapshot = DotHostSnapshot(hosting: true, available: true, status: "Listening", origin: "https://private.example", clientID: "private-client", consents: [], grants: [], reports: [row])
        let value = try XCTUnwrap(snapshot.deckSnapshot(now: now))
        XCTAssertEqual(Set(value.keys), ["configured", "hosting", "reportState", "reportedAt", "expiresAt", "code", "validForMs"])
        XCTAssertEqual(value["reportState"] as? String, "working")
        let encoded = String(data: try JSONSerialization.data(withJSONObject: value), encoding: .utf8)!
        XCTAssertFalse(encoded.contains("private"))
        XCTAssertEqual(snapshot.deckSnapshot(now: now + DotLimits.reportFreshMs)?["reportState"] as? String, "stale")
        snapshot.hosting = false
        XCTAssertEqual(snapshot.deckSnapshot(now: now)?["hosting"] as? Bool, false)
        snapshot.origin = ""; XCTAssertNil(snapshot.deckSnapshot(now: now))
    }
    func testNativeDeckPreviewReservesDotWithoutCreatingASession() {
        let sessions = [D200HSession(id: "oc", agentType: "openclaw", state: "idle", projectName: "A"), D200HSession(id: "h", agentType: "hermes", state: "idle", projectName: "B")]
        let original = D200HLayoutModel.buildSessionDeck(.init(state: "idle", sessions: sessions), view: .init(mode: .list))
        let dot = D200HLayoutModel.buildSessionDeck(.init(state: "idle", sessions: sessions, dotLabel: "NO REPORT"), view: .init(mode: .list))
        XCTAssertEqual(dot.first?.label, "DOT")
        XCTAssertEqual(dot[1].label, original[0].label); XCTAssertEqual(dot[2].label, original[1].label)
    }
    func testCompanionNeverInfersWorkFromDeliveryOrAppPresence() {
        let now = 1800000000000
        var request = DotBriefing(id: "request", owner: "owner", profile: "desk", key: "key", fingerprint: "hash", context: "", capturedAt: now, createdAt: now, expiresAt: now + DotLimits.requestMs, eventId: "event", subscriptionId: "sub", delivery: "accepted", attempts: 1, nextAttemptAt: now)
        func phase(_ hosting: Bool = true, _ connected: Bool = true, _ time: Int = now) -> DotPresentation.Phase {
            DotPresentation.resolve(hosting: hosting, connected: connected, request: request, now: time).phase
        }
        XCTAssertEqual(phase(), .waiting)
        XCTAssertEqual(phase(false), .offline)
        XCTAssertEqual(phase(true, false), .unlinked)
        request.report = DotReport(sequence: 1, state: "working", summary: "", receivedAt: now)
        XCTAssertEqual(phase(), .working)
        XCTAssertEqual(phase(true, true, now + DotLimits.reportFreshMs), .stale)
        request.report?.receivedAt = now + 1
        XCTAssertEqual(phase(), .stale)
        request.report?.receivedAt = now
        request.report?.state = "needs_attention"
        XCTAssertEqual(phase(), .attention)
        request.report?.state = "completed"
        request.report?.receivedAt = now + 1
        XCTAssertEqual(phase(), .stale)
        request.report?.receivedAt = now
        XCTAssertEqual(phase(), .completed)
        XCTAssertEqual(phase(true, true, now + DotLimits.completionReactionMs), .idle)
        let cards = DotPresentation.resultCards([request], now: now)
        XCTAssertEqual(cards.count, 1)
        XCTAssertEqual(cards[0]["actionClass"] as? String, "info")
        let module = cards[0]["module"] as! [String: Any]
        XCTAssertEqual(module["module"] as? String, "dot")
        XCTAssertNil(module["choices"]); XCTAssertNil(cards[0]["session"])
        XCTAssertTrue(DotPresentation.resultCards([request], now: now + DotLimits.retentionMs).isEmpty)
        request.report?.state = "future-state"
        XCTAssertEqual(phase(), .stale)
    }
    func testStrictHTTPFramingRejectsSmugglingAndOversizedBodies() {
        for text in ["POST /mcp HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\nContent-Length: 1\r\n\r\n",
                     "POST /mcp HTTP/1.1\r\nHost: a\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
                     "POST /mcp HTTP/1.1\r\nHost: a\r\nContent-Length: 999999\r\n\r\n",
                     "POST /mcp HTTP/1.1\r\nHost: a\r\nContent-Length: 0\r\n\r\nGET /shutdown HTTP/1.1\r\n\r\n"] {
            if case .invalid = DotHTTPSListener.parse(Data(text.utf8)) {} else { XCTFail("Accepted ambiguous framing") }
        }
        if case .incomplete = DotHTTPSListener.parse(Data("POST /mcp HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\n\r\n{".utf8)) {} else { XCTFail("Partial body accepted") }
        if case .ready(let request) = DotHTTPSListener.parse(Data("POST /mcp HTTP/1.1\r\nHost: a\r\nContent-Length: 2\r\n\r\n{}".utf8)) {
            XCTAssertEqual(request.body, Data("{}".utf8))
        } else { XCTFail("Valid request rejected") }
    }
    func testStandardWebhookSignatureMatchesNodeFixture() throws {
        let secret = "whsec_" + Data(repeating: 42, count: 32).base64EncodedString()
        XCTAssertEqual(try DotWebhook.signature(id: "evt_fixture", seconds: 1800000000,
            body: Data("{\"message\":\"한글\"}".utf8), secret: secret), "v1,mpo/HT/96w/PI9fx85wkEVVSPkOY1r33niQM+tp2y7s=")
    }
    func testCallbackValidationAndChunkedFraming() throws {
        for address in ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "192.168.1.1", "203.0.113.1", "::1", "::ffff:8.8.8.8", "fc00::1", "2001:db8::1", "2002:0808:0808::1"] { XCTAssertFalse(DotWebhook.isPublic(address), address) }
        for address in ["8.8.8.8", "2606:4700::1111"] { XCTAssertTrue(DotWebhook.isPublic(address)) }
        XCTAssertThrowsError(try DotWebhook.callbackURL("https://user:pass@example.com"))
        XCTAssertThrowsError(try DotWebhook.callbackURL("http://example.com"))
        let reply = try DotWebhook.parseReply(Data("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n".utf8))
        XCTAssertEqual(reply.body, Data("{}".utf8))
        XCTAssertThrowsError(try DotWebhook.parseReply(Data("HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n{}".utf8)))
    }
    func testOAuthConsentPKCERefreshReplayAndPersistence() async throws {
        try await Task { @DaemonActor in
            var persisted: Data?
            var now = 1800000000000
            let config = DotOAuthConfiguration(origin: "https://agentdeck.example", clientID: "registered-test-client", secret: String(repeating: "s", count: 43), redirectURI: "https://chatgpt.com/connector_platform_oauth_redirect")
            let verifier = String(repeating: "v", count: 64)
            let auth = try DotOAuth(config: config, data: nil, clock: { now }) { persisted = $0 }
            let input = ["client_id": config.clientID, "redirect_uri": config.redirectURI, "resource": config.origin, "response_type": "code", "scope": "agentdeck:read agentdeck:report agentdeck:subscribe", "state": "original", "code_challenge_method": "S256", "code_challenge": dotDigest(verifier)]
            let ticket = try auth.begin(input)
            XCTAssertNil(try auth.redirect(ticket)); XCTAssertTrue(auth.grants().isEmpty)
            try auth.decide(ticket, approve: true)
            let redirect = URLComponents(string: try XCTUnwrap(auth.redirect(ticket)))!
            XCTAssertEqual(redirect.queryItems?.first(where: { $0.name == "iss" })?.value, config.origin)
            let code = redirect.queryItems!.first(where: { $0.name == "code" })!.value!
            var params = ["client_id": config.clientID, "client_secret": config.secret, "grant_type": "authorization_code", "resource": config.origin, "code": code, "redirect_uri": config.redirectURI, "code_verifier": "wrong"]
            XCTAssertThrowsError(try auth.exchange(params)); params["code_verifier"] = verifier
            let tokens = try auth.exchange(params)
            XCTAssertThrowsError(try auth.exchange(params))
            let access = tokens["access_token"] as! String, refresh = tokens["refresh_token"] as! String
            XCTAssertNotNil(auth.authenticate(access))
            XCTAssertFalse(String(data: persisted!, encoding: .utf8)!.contains(refresh))
            let restarted = try DotOAuth(config: config, data: persisted, clock: { now }) { persisted = $0 }
            XCTAssertNotNil(restarted.authenticate(access))
            now += DotOAuthLimits.accessMs
            XCTAssertNil(restarted.authenticate(access))
            let renew = ["client_id": config.clientID, "client_secret": config.secret, "grant_type": "refresh_token", "resource": config.origin, "refresh_token": refresh]
            let replacement = try restarted.exchange(renew)
            XCTAssertNotNil(restarted.authenticate(replacement["access_token"] as! String))
            XCTAssertThrowsError(try restarted.exchange(renew))
            XCTAssertNil(restarted.authenticate(replacement["access_token"] as! String))
        }.value
    }
    func testNativeSubscriptionToReportRoundTripAndRestart() async throws {
        try await Task { @DaemonActor in
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let specURL = try XCTUnwrap(Bundle.main.url(forResource: "dot-mcp-contract", withExtension: "json"))
            let spec = try Data(contentsOf: specURL), file = directory.appendingPathComponent("requests.json")
            var active = true, delivered: [Data] = []
            let grant = DotGrant(id: "owner", scopes: DotOAuth.scopes, expiresAt: Int.max, revoked: false)
            let store = try DotMCPStore(file: file, contract: spec, access: { _ in active }) { _, data, _ in
                let object = try JSONSerialization.jsonObject(with: data) as! [String: Any]
                if let challenge = object["challenge"] as? String { return .init(status: 200, body: try JSONSerialization.data(withJSONObject: ["challenge": challenge])) }
                delivered.append(data); return .init(status: 202, body: Data())
            }
            let secret = "whsec_" + Data(repeating: 42, count: 32).base64EncodedString()
            let subscription: [String: Any] = ["name": "agentdeck.briefing.requested", "arguments": ["integrationId": "desk"], "delivery": ["mode": "webhook", "url": "https://receiver.example/callback", "secret": secret], "cursor": NSNull()]
            _ = try await store.rpc(grant: grant, method: "events/subscribe", params: subscription)
            try store.create(owner: grant.id, profile: "desk", context: "사용자가 공유한 문맥", key: "press-1")
            try store.create(owner: grant.id, profile: "desk", context: "사용자가 공유한 문맥", key: "press-1")
            XCTAssertEqual(store.requests().count, 1)
            try await store.deliver(); XCTAssertEqual(delivered.count, 1)
            let id = try XCTUnwrap(store.requests().first?.id)
            let claim = try await store.rpc(grant: grant, method: "tools/call", params: ["name": "claim_request", "arguments": ["requestId": id, "idempotencyKey": "claim"]])
            let attempt = (claim["structuredContent"] as! [String: Any])["attemptId"] as! String
            let edge: [String: Any] = ["requestId": id, "attemptId": attempt, "idempotencyKey": "edge-1", "relationId": "delegation-1",
                "sequence": 1, "kind": "delegation", "direction": "dot_to_agent", "stage": "requested", "targetRef": "codex-session-ref", "summary": "Run tests"]
            @DaemonActor func reportEdge(_ value: [String: Any]) async throws -> [String: Any] {
                try await store.rpc(grant: grant, method: "tools/call", params: ["name": "report_interaction", "arguments": value])
            }
            let first = try await reportEdge(edge)
            XCTAssertNil(first["isError"])
            _ = try await reportEdge(edge)
            XCTAssertEqual(store.requests().first?.interactions?.count, 1)
            var invalid = edge; invalid["evidence"] = "agent_acknowledgement"
            do { _ = try await reportEdge(invalid); XCTFail("Accepted forged provenance") } catch {}
            invalid = edge; invalid["idempotencyKey"] = "rebind"; invalid["sequence"] = 2; invalid["targetRef"] = "other"
            let rejected = try await reportEdge(invalid); XCTAssertEqual(rejected["isError"] as? Bool, true)
            var done = edge; done["idempotencyKey"] = "edge-2"; done["sequence"] = 2; done["stage"] = "completed"
            _ = try await reportEdge(done)
            invalid = done; invalid["idempotencyKey"] = "resurrect"; invalid["sequence"] = 3; invalid["stage"] = "running"
            let resurrected = try await reportEdge(invalid); XCTAssertEqual(resurrected["isError"] as? Bool, true)
            XCTAssertNil(store.requests().first?.report)
            XCTAssertEqual(store.requests().first?.interactions?.last?.evidence, "dot_report")
            let cards = DotPresentation.resultCards(store.requests(), now: Int(Date().timeIntervalSince1970 * 1000))
            XCTAssertEqual(cards.first?["actionClass"] as? String, "info")
            XCTAssertTrue((cards.first?["module"] as? [String: Any])?["question"] as? String != nil)
            let args: [String: Any] = ["requestId": id, "attemptId": attempt, "sequence": 1, "idempotencyKey": "report", "state": "completed", "summary": "완료 보고"]
            _ = try await store.rpc(grant: grant, method: "tools/call", params: ["name": "report_update", "arguments": args])
            _ = try await store.rpc(grant: grant, method: "tools/call", params: ["name": "report_update", "arguments": args])
            XCTAssertEqual(store.requests().first?.report?.summary, "완료 보고")
            XCTAssertEqual(delivered.count, 1, "A report must never create another event")
            let restart = try DotMCPStore(file: file, contract: spec, access: { _ in active })
            XCTAssertEqual(restart.requests().first?.report?.sequence, 1)
            XCTAssertEqual(restart.requests().first?.interactions?.map(\.stage), ["requested", "completed"])
            let saved = try Data(contentsOf: file)
            let corrupt = String(data: saved, encoding: .utf8)!.replacingOccurrences(of: "dot_report", with: "agent_acknowledgement")
            try Data(corrupt.utf8).write(to: file)
            XCTAssertThrowsError(try DotMCPStore(file: file, contract: spec, access: { _ in true }))
            try saved.write(to: file)
            active = false; try restart.maintenance(); XCTAssertTrue(restart.requests().isEmpty)
        }.value
    }
    func testNativeSchemaRejectsBooleansAndFractionalTimestamps() async throws {
        try await Task { @DaemonActor in
            XCTAssertThrowsError(try DotSchema.validate(true, ["type": "integer"]))
            XCTAssertThrowsError(try DotSchema.validate(1.5, ["type": "integer"]))
            XCTAssertThrowsError(try DotSchema.validate(["requestId": "x", "extra": 1], ["type": "object", "properties": ["requestId": ["type": "string"]], "required": ["requestId"], "additionalProperties": false]))
        }.value
    }
    func testCharacterNormalizationIsBoundedAndPreservesTopLeftOrientation() async throws {
        let source = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFElEQVR4nGO4JMn1nwEEGRj+gwEASPEJ7YV4WrYAAAAASUVORK5CYII=")!
        let asset = try await DotAppearanceStore.normalizeImage(source)
        XCTAssertEqual(asset.version, DotAppearanceRules.version)
        XCTAssertNotNil(asset.portrait)
        let rgba = [UInt8](try XCTUnwrap(asset.glyph))
        XCTAssertEqual(rgba.count, DotAppearanceRules.glyphBytes)
        let topLeft = (1 * DotAppearanceRules.glyphSize + 1) * 4
        XCTAssertGreaterThan(rgba[topLeft], rgba[topLeft + 1])
        XCTAssertGreaterThan(rgba[topLeft], rgba[topLeft + 2])
        let bottomLeft = (14 * DotAppearanceRules.glyphSize + 1) * 4
        XCTAssertGreaterThan(rgba[bottomLeft + 2], rgba[bottomLeft])
        do {
            _ = try await DotAppearanceStore.normalizeImage(Data("<svg/>".utf8))
            XCTFail("SVG is not a permitted character")
        } catch { }
        var corrupted = asset; corrupted.rgba = "bad"
        XCTAssertNil(corrupted.glyph)
    }
    func testRemoteDotDecoderAndPixelOverlayStaySeparateFromSessions() throws {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let source = Data("{\"type\":\"sessions_list\",\"sessions\":[],\"dot\":{\"configured\":true,\"hosting\":true,\"reportState\":\"working\",\"reportedAt\":NOW,\"expiresAt\":LATER}}".replacingOccurrences(of: "NOW", with: String(now)).replacingOccurrences(of: "LATER", with: String(now + 10000)).utf8)
        let event = try JSONDecoder().decode(SessionsListEvent.self, from: source)
        XCTAssertEqual(event.sessions.count, 0)
        XCTAssertEqual(event.dot?.effectiveCode, 2)
        let plain = Data(repeating: 13, count: 64 * 64 * 3)
        let painted = DotPixelOverlay.paint(plain, width: 64, dot: event.dot, now: now)
        XCTAssertEqual(painted.prefix(64 * 10 * 3), plain.prefix(64 * 10 * 3))
        XCTAssertNotEqual(painted, plain)
        XCTAssertEqual(DotPixelOverlay.paint(Data(repeating: 13, count: 11 * 11 * 3), width: 11, dot: event.dot), Data(repeating: 13, count: 11 * 11 * 3))
        let legacy = try JSONDecoder().decode(SessionsListEvent.self, from: Data("{\"type\":\"sessions_list\",\"sessions\":[]}".utf8))
        XCTAssertNil(legacy.dot)
    }

}
#endif
