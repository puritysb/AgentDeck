// OpenCodeObserverTests.swift — pure-function coverage for the opt-in
// OpenCode SSE monitoring path (Tier 1, sandboxed daemon).
//
// Mirrors the event semantics of bridge/src/adapters/opencode-adapter.ts
// (busy signals, session.idle, permission.requested, tool parts) and the
// SSE `data:` frame format of bridge/src/opencode-client.ts. Discovery
// helpers are covered with synthetic argv lists — no live server, no
// network. macOS-only (daemon path).

#if os(macOS)
import XCTest
@testable import AgentDeck

final class OpenCodeObserverTests: XCTestCase {

    func testGlobalEnvelopeKeepsDirectoryOnStatusAndQuestion() throws {
        let directory = "/tmp/space # & 한글"
        for event in ["session.status", "question.asked"] {
            let update = try XCTUnwrap(OpenCodeEventClassifier.classify(envelope: [
                "directory": directory,
                "payload": ["type": event, "properties": [
                    "sessionID": "ses_b", "id": "que_b", "status": ["type": "busy"],
                ] as [String: Any]],
            ]))
            XCTAssertEqual(update.directory, directory)
        }
    }

    func testColdAttachmentFindsOtherDirectoryAndPendingQuestion() async throws {
        let client = makeSnapshotClient(host: "inventory.test")
        let updates = await client.reconnectSnapshot()
        XCTAssertEqual(updates.map(\.kind), [.processing, .awaitingQuestion])
        XCTAssertEqual(updates.map(\.sessionID), ["ses_b", "ses_b"])
        XCTAssertEqual(updates.first?.title, "Other workspace")
        XCTAssertEqual(updates.last?.directory, SnapshotProtocol.directory)
        XCTAssertEqual(updates.last?.waitID, "que_b")
    }

    func testRememberedDirectoryRecoversWhenInventoryUnavailable() async {
        let client = makeSnapshotClient(host: "legacy.test")
        let withoutLocation = await client.reconnectSnapshot()
        XCTAssertTrue(withoutLocation.isEmpty)
        let recovered = await client.reconnectSnapshot(knownDirectories: [SnapshotProtocol.directory])
        XCTAssertEqual(recovered.map(\.kind), [.processing, .awaitingQuestion])
    }

    func testFailedPendingReadDoesNotInventResolution() async {
        let updates = await makeSnapshotClient(host: "failed-pending.test").reconnectSnapshot()
        XCTAssertEqual(updates.map(\.kind), [.processing])
        XCTAssertFalse(updates.contains { $0.kind == .idle || $0.kind == .questionReplied })
    }

    func testDuplicateDefaultAndExplicitScopeSeedsWaitOnlyOnce() async {
        let updates = await makeSnapshotClient(host: "duplicate.test").reconnectSnapshot()
        XCTAssertEqual(updates.map(\.kind), [.processing, .awaitingQuestion])
    }

    private func makeSnapshotClient(host: String) -> OpenCodeSSEClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SnapshotProtocol.self]
        return OpenCodeSSEClient(baseURL: URL(string: "https://\(host)")!, transport: URLSession(configuration: config))
    }

    func testOwnershipKeepsHooksOutsideStreamLifecycle() {
        var owner = OpenCodeObservationOwnership()
        XCTAssertTrue(owner.acceptSSE("sse", rowExists: false))
        XCTAssertTrue(owner.acceptSSE("both", rowExists: false))
        XCTAssertTrue(owner.claimHook("both"))
        XCTAssertFalse(owner.acceptSSE("both", rowExists: true))
        XCTAssertFalse(owner.acceptSSE("hook", rowExists: true))
        XCTAssertEqual(owner.disconnect(), ["sse"])
        XCTAssertTrue(owner.sse.isEmpty)
    }

    func testSharedWaitIdentityVectors() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/opencode-wait-vectors.json"))
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: String]])
        var waits = OpenCodeWaitState()
        for row in rows {
            _ = waits.consume(event: "opencode_" + row["event"]!, id: row["id"], title: row["title"])
            XCTAssertEqual(waits.first?.id, row["pending"], row["event"]!)
            if let first = waits.first {
                XCTAssertEqual(first.kind == "permission" ? "awaiting_permission" : "awaiting_option", row["state"])
            }
        }
    }

    func testCurrentWirePermissionAndQuestionIdentities() throws {
        func classify(_ type: String, _ props: [String: Any]) -> OpenCodeSessionUpdate? {
            OpenCodeEventClassifier.classify(envelope: ["payload": ["type": type, "properties": props]])
        }
        let permission = try XCTUnwrap(classify("permission.asked", ["sessionID": "s", "id": "p", "permission": "bash"]))
        XCTAssertEqual(permission.kind, .awaitingPermission)
        XCTAssertEqual(permission.waitID, "p")
        XCTAssertEqual(classify("permission.replied", ["sessionID": "s", "requestID": "p"])?.waitID, "p")
        XCTAssertEqual(classify("permission.replied", ["sessionID": "s", "permissionID": "legacy"])?.waitID, "legacy")
        XCTAssertEqual(classify("question.asked", ["sessionID": "s", "id": "q", "questions": [["question": "", "header": "Target"]]])?.question, "Target")
        let question = classify("question.asked", ["sessionID": "s", "id": "q", "questions": [["question": "Which target?"]]])
        XCTAssertEqual(question?.kind, .awaitingQuestion)
        XCTAssertEqual(question?.question, "Which target?")
        XCTAssertEqual(classify("question.rejected", ["sessionID": "s", "requestID": "q"])?.kind, .questionReplied)
    }

    // MARK: - SSE data-line parsing

    func testParsesDataLine() {
        let envelope = OpenCodeEventClassifier.parseSSEDataLine(
            #"data: {"payload":{"type":"session.idle","properties":{"sessionID":"s1"}}}"#
        )
        XCTAssertNotNil(envelope)
        XCTAssertEqual((envelope?["payload"] as? [String: Any])?["type"] as? String, "session.idle")
    }

    func testIgnoresKeepAlivesCommentsAndMalformedJSON() {
        XCTAssertNil(OpenCodeEventClassifier.parseSSEDataLine(""))
        XCTAssertNil(OpenCodeEventClassifier.parseSSEDataLine(": keep-alive"))
        XCTAssertNil(OpenCodeEventClassifier.parseSSEDataLine("event: message"))
        XCTAssertNil(OpenCodeEventClassifier.parseSSEDataLine("data:"))
        XCTAssertNil(OpenCodeEventClassifier.parseSSEDataLine("data: {not json"))
        // Non-object JSON roots are dropped, not crashed on.
        XCTAssertNil(OpenCodeEventClassifier.parseSSEDataLine("data: [1,2,3]"))
    }

    // MARK: - Event classification

    private func classify(_ type: String, _ properties: [String: Any]) -> OpenCodeSessionUpdate? {
        OpenCodeEventClassifier.classify(envelope: [
            "payload": ["type": type, "properties": properties] as [String: Any],
        ])
    }

    func testSessionCreatedUpsertsWithTitleAndDirectory() {
        let update = classify("session.created", [
            "info": ["id": "s1", "title": "Fix the parser", "directory": "/Users/dev/proj"] as [String: Any],
        ])
        XCTAssertEqual(update, OpenCodeSessionUpdate(
            sessionID: "s1", kind: .upsert, title: "Fix the parser", directory: "/Users/dev/proj"
        ))
    }

    func testBusyStatusIsProcessingAndIdleStatusIsDropped() {
        XCTAssertEqual(
            classify("session.status", ["sessionID": "s1", "status": ["type": "busy"] as [String: Any]]),
            OpenCodeSessionUpdate(sessionID: "s1", kind: .processing)
        )
        // Only busy arms the turn — idle status rides session.idle instead.
        XCTAssertNil(classify("session.status", ["sessionID": "s1", "status": ["type": "idle"] as [String: Any]]))
    }

    func testIncompleteAssistantMessageIsProcessingWithModel() {
        // `session.status:busy` is not reliably emitted — an in-flight
        // assistant message is the precise work-start signal (adapter parity).
        let update = classify("message.updated", [
            "info": [
                "sessionID": "s1", "role": "assistant",
                "time": ["created": 1] as [String: Any],
                "modelID": "big-model",
            ] as [String: Any],
        ])
        XCTAssertEqual(update, OpenCodeSessionUpdate(sessionID: "s1", kind: .processing, modelName: "big-model"))
    }

    func testCompletedAssistantMessageIsMetadataOnly() {
        let update = classify("message.updated", [
            "info": [
                "sessionID": "s1", "role": "assistant",
                "time": ["created": 1, "completed": 2] as [String: Any],
                "modelID": "big-model",
            ] as [String: Any],
        ])
        XCTAssertEqual(update, OpenCodeSessionUpdate(sessionID: "s1", kind: .metadata, modelName: "big-model"))
        // User messages never arm the turn.
        XCTAssertNil(classify("message.updated", [
            "info": ["sessionID": "s1", "role": "user", "time": ["created": 1] as [String: Any]] as [String: Any],
        ]))
    }

    func testToolPartCarriesCurrentTool() {
        let update = classify("message.part.updated", [
            "part": ["sessionID": "s1", "type": "tool", "tool": "bash"] as [String: Any],
        ])
        XCTAssertEqual(update, OpenCodeSessionUpdate(sessionID: "s1", kind: .processing, currentTool: "bash"))
        // Non-tool parts still signal processing, without a tool name.
        XCTAssertEqual(
            classify("message.part.updated", ["part": ["sessionID": "s1", "type": "text"] as [String: Any]]),
            OpenCodeSessionUpdate(sessionID: "s1", kind: .processing)
        )
    }

    func testDeltaIsProcessingAndIdleClears() {
        XCTAssertEqual(
            classify("message.part.delta", ["sessionID": "s1", "delta": "tok"]),
            OpenCodeSessionUpdate(sessionID: "s1", kind: .processing)
        )
        XCTAssertEqual(
            classify("session.idle", ["sessionID": "s1"]),
            OpenCodeSessionUpdate(sessionID: "s1", kind: .idle)
        )
    }

    func testPermissionRequestedIsDisplayOnlyAwaiting() {
        let update = classify("permission.requested", [
            "sessionID": "s1", "permissionID": "p1", "tool": "bash",
            "description": "Allow running npm test?",
        ])
        XCTAssertEqual(update, OpenCodeSessionUpdate(
            sessionID: "s1", kind: .awaitingPermission, question: "Allow running npm test?", waitID: "p1"
        ))
        // No description → synthesized question from the tool name. Never
        // any options/requestId — respond-in-terminal on every surface.
        XCTAssertEqual(
            classify("permission.requested", ["sessionID": "s1", "permissionID": "p1", "tool": "bash"]),
            OpenCodeSessionUpdate(sessionID: "s1", kind: .awaitingPermission, question: "Allow bash?", waitID: "p1")
        )
    }

    func testUnknownEventTypesAreDroppedSilently() {
        XCTAssertNil(classify("storage.write", ["key": "x"]))
        XCTAssertNil(classify("session.deleted", ["sessionID": "s1"]))
        XCTAssertNil(OpenCodeEventClassifier.classify(envelope: ["nope": true]))
    }

    // MARK: - Discovery

    func testExplicitPortExtraction() {
        XCTAssertEqual(
            OpenCodeObserver.explicitPort(inOpenCodeArgs: ["/usr/local/bin/opencode", "serve", "--port", "5123"]),
            5123
        )
        XCTAssertEqual(
            OpenCodeObserver.explicitPort(inOpenCodeArgs: ["opencode", "--port", "4097"]),
            4097
        )
        // Bare TUI: no --port in argv → undiscoverable by design.
        XCTAssertNil(OpenCodeObserver.explicitPort(inOpenCodeArgs: ["/usr/local/bin/opencode"]))
        // Not an opencode binary.
        XCTAssertNil(OpenCodeObserver.explicitPort(inOpenCodeArgs: ["/usr/bin/node", "server.js", "--port", "4096"]))
        // agentdeck-managed opencode is Tier 2's job — excluded.
        XCTAssertNil(OpenCodeObserver.explicitPort(
            inOpenCodeArgs: ["/usr/local/bin/opencode", "--port", "5000", "--agentdeck-session"]
        ))
        // Garbage ports rejected.
        XCTAssertNil(OpenCodeObserver.explicitPort(inOpenCodeArgs: ["opencode", "--port", "0"]))
        XCTAssertNil(OpenCodeObserver.explicitPort(inOpenCodeArgs: ["opencode", "--port", "not-a-number"]))
    }

    func testCandidateURLsDedupeAndOrder() {
        let urls = OpenCodeObserver.candidateURLs(
            userConfigured: "http://127.0.0.1:4096/",
            processArgs: [
                ["/usr/local/bin/opencode", "--port", "5123"],
                ["/usr/local/bin/opencode", "--port", "5123"],   // duplicate process
                ["/usr/bin/vim", "notes.txt"],                    // unrelated
            ]
        )
        // User URL (trailing slash normalized) dedupes against the default;
        // argv port appends once.
        XCTAssertEqual(urls.map(\.absoluteString), ["http://127.0.0.1:4096", "http://127.0.0.1:5123"])
    }

    func testCandidateURLsRejectNonHTTPUserInput() {
        let urls = OpenCodeObserver.candidateURLs(userConfigured: "ftp://example.com", processArgs: [])
        XCTAssertEqual(urls.map(\.absoluteString), [OpenCodeObserver.defaultServerURL])
    }
}
/// Exercise the real HTTP decoding and URL query construction, including
/// percent-encoding, default-scope duplicates and an unavailable inventory.
private final class SnapshotProtocol: URLProtocol, @unchecked Sendable {
    static let directory = "/tmp/space # & 한글"
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        let directory = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .first { $0.name == "directory" }?.value
        let inScope = directory == Self.directory || url.host == "duplicate.test"
        var status = 200
        let body: Any
        switch url.path {
        case "/experimental/session":
            if url.host == "legacy.test" { status = 404; body = [:] }
            else { body = [["id": "ses_b", "title": "Other workspace", "directory": Self.directory]] }
        case "/session/status":
            body = inScope ? ["ses_b": ["type": "busy"]] : [:]
        case "/question":
            if url.host == "failed-pending.test" { status = 503; body = [:] }
            else { body = inScope ? [["id": "que_b", "sessionID": "ses_b", "questions": [["question": "Continue?"]]]] : [] }
        case "/permission": body = []
        default: status = 404; body = [:]
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: body))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
#endif
