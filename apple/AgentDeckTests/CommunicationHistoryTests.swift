import XCTest
@testable import AgentDeck
#if os(macOS)
import SwiftUI

final class CommunicationHistoryTests: XCTestCase {
    private func snapshot(_ events: String) throws -> CommunicationSnapshot {
        try JSONDecoder().decode(CommunicationSnapshot.self, from: Data("""
        {"schema":"agentdeck-communications/v1","capturedAt":100000,"since":1,"truncated":false,"events":\(events)}
        """.utf8))
    }
    private func roster() throws -> [SessionInfo] {
        try JSONDecoder().decode([SessionInfo].self, from: Data("""
        [{"id":"observed:claude:a","port":0,"alive":true,"projectName":"Same project","state":"idle"},
         {"id":"b","port":0,"alive":true,"projectName":"Same project","state":"processing"},
         {"id":"unrelated","port":0,"alive":true,"projectName":"Same project","state":"idle"}]
        """.utf8))
    }

    func testNoSnapshotProjectsNothing() throws {
        let history = CommunicationHistory.project(snapshot: nil, roster: try roster())
        XCTAssertTrue(history.messages.isEmpty)
        XCTAssertTrue(history.names.isEmpty)
    }

    func testNamesAndLegacyIdsNeverIdentifyAPeer() throws {
        let value = try snapshot("""
        [{"id":"1","sessionId":"a","ts":10000,"relation":"messaged","direction":"out","peerName":"Reviewer"},
         {"id":"2","sessionId":"a","ts":20000,"relation":"messaged","direction":"in","peerSessionId":"b","peerName":"Reviewer"},
         {"id":"3","sessionId":"a","ts":30000,"relation":"messaged","direction":"in","peerSessionId":"gone","peerIdentity":"pid","peerName":"Reviewer"}]
        """)
        let history = CommunicationHistory.project(snapshot: value, roster: try roster())
        XCTAssertEqual(history.messages.map(\.id), ["3"])
        XCTAssertEqual(history.names, ["a": "Same project", "gone": "Reviewer"])
        XCTAssertEqual(history.name("absent"), "absent")
    }

    func testLegacyDeliveryNeedsUniqueReciprocalEvidence() throws {
        let send = #"{"id":"1","sessionId":"a","ts":10000,"relation":"messaged","direction":"out","peerSessionId":"b","evidence":"send_message_tool","messageFingerprint":"abc"}"#
        let receipt = #"{"id":"2","sessionId":"b","ts":10100,"relation":"messaged","direction":"in","peerSessionId":"a","evidence":"cross_session_message","messageFingerprint":"abc"}"#
        let duplicate = #"{"id":"3","sessionId":"a","ts":10200,"relation":"messaged","direction":"out","peerSessionId":"b","evidence":"send_message_tool","messageFingerprint":"abc"}"#
        let roster = try roster()
        let corroborated = CommunicationHistory.project(snapshot: try snapshot("[\(send),\(receipt)]"), roster: roster)
        XCTAssertEqual(corroborated.messages.map(\.id), ["2"])
        XCTAssertEqual(corroborated.messages.first?.sent?.id, "1")
        let ambiguous = CommunicationHistory.project(snapshot: try snapshot("[\(send),\(receipt),\(duplicate)]"), roster: roster)
        XCTAssertTrue(ambiguous.messages.isEmpty)
        let outsideWindow = receipt.replacingOccurrences(of: "10100", with: "13000")
        XCTAssertTrue(CommunicationHistory.project(snapshot: try snapshot("[\(send),\(outsideWindow)]"), roster: roster).messages.isEmpty)
    }

    func testTaskHandoffRequiresReceiptAndMatchingTaskEvidence() throws {
        let value = try snapshot("""
        [{"id":"send","sessionId":"a","ts":10000,"relation":"messaged","direction":"out","peerSessionId":"b","peerIdentity":"pid","evidence":"send_message_tool","messageFingerprint":"abc","detail":"Reproduction steps"},
         {"id":"receipt","sessionId":"b","ts":10100,"relation":"messaged","direction":"in","peerSessionId":"a","peerIdentity":"pid","evidence":"cross_session_message","messageFingerprint":"abc"},
         {"id":"other","sessionId":"a","ts":20000,"relation":"messaged","direction":"out","peerSessionId":"b","peerIdentity":"pid","evidence":"send_message_tool","messageFingerprint":"def"}]
        """)
        let messages = CommunicationHistory.project(snapshot: value, roster: try roster()).messages
        XCTAssertEqual(messages.map(\.id), ["other", "receipt"])
        XCTAssertEqual(messages.last?.detail, "Reproduction steps")

        func taskEvent(_ timestamp: Double, direction: String, peer: String) -> CollaborationRelation {
            CollaborationRelation(id: "task-event", relation: "messaged", direction: direction, phase: "closed",
                                  peerSessionId: peer, evidence: "message", observedAt: timestamp)
        }
        let outgoing = taskEvent(10_000, direction: "out", peer: "b")
        let incoming = taskEvent(10_100, direction: "in", peer: "a")
        XCTAssertEqual(messages.filter { $0.belongsToTask(sessionID: "observed:claude:a", relations: [outgoing]) }.map(\.id), ["receipt"])
        XCTAssertEqual(messages.filter { $0.belongsToTask(sessionID: "b", relations: [incoming]) }.map(\.id), ["receipt"])
        let unrelated = taskEvent(20_000, direction: "out", peer: "b")
        XCTAssertTrue(messages.filter { $0.belongsToTask(sessionID: "a", relations: [unrelated]) }.isEmpty)
        XCTAssertTrue(messages.filter { $0.belongsToTask(sessionID: "unrelated", relations: [outgoing]) }.isEmpty)
    }

    func testInvalidDirectionsFutureEventsAndNonMessagesAreIgnored() throws {
        let value = try snapshot("""
        [{"id":"1","sessionId":"a","ts":10000,"relation":"spawned","direction":"out","peerSessionId":"b","peerIdentity":"pid"},
         {"id":"2","sessionId":"a","ts":10000,"relation":"messaged","direction":"unknown","peerSessionId":"b","peerIdentity":"pid"},
         {"id":"3","sessionId":"a","ts":100001,"relation":"messaged","direction":"out","peerSessionId":"b","peerIdentity":"pid"}]
        """)
        XCTAssertTrue(CommunicationHistory.project(snapshot: value, roster: try roster()).messages.isEmpty)
    }
}

@MainActor
final class CommunicationFeedTests: XCTestCase {
    private let data = Data(#"{"schema":"agentdeck-communications/v1","capturedAt":100000,"since":1,"truncated":false,"events":[]}"#.utf8)

    func testFailedRefreshRetainsHistoryButChangingDaemonClearsIt() async {
        let queue = CommunicationResponses([.success(data), .failure(URLError(.timedOut)), .failure(URLError(.timedOut))])
        let feed = CommunicationFeed(load: { _ in try await queue.read() }, pause: { throw CancellationError() })
        await feed.observe(port: 1, connected: true)
        XCTAssertEqual(feed.state, .ready)
        await feed.observe(port: 1, connected: true)
        XCTAssertEqual(feed.state, .failed)
        XCTAssertEqual(feed.snapshot?.capturedAt, 100000)
        await feed.observe(port: 2, connected: true)
        XCTAssertNil(feed.snapshot)
        await feed.observe(port: 2, connected: false)
        XCTAssertEqual(feed.state, .disconnected)
    }

    func testUnknownSchemaCannotPublishHistory() async {
        let feed = CommunicationFeed(load: { _ in
            Data(#"{"schema":"future","capturedAt":1000,"since":0,"truncated":false,"events":[]}"#.utf8)
        }, pause: { throw CancellationError() })
        await feed.observe(port: 1, connected: true)
        XCTAssertEqual(feed.state, .unsupported)
        XCTAssertNil(feed.snapshot)
    }
}

private actor CommunicationResponses {
    var responses: [Result<Data, Error>]
    init(_ responses: [Result<Data, Error>]) { self.responses = responses }
    func read() throws -> Data { try responses.removeFirst().get() }
}

@DaemonActor
final class CommunicationPersistenceTests: XCTestCase {
    func testSharedSwiftNodeHistoryFixtureThroughHTTPAndScreenProjection() async throws {
        let file = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("shared/collaboration-identity-vectors.json")
        let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        let fixture = try XCTUnwrap(vectors["historyParity"] as? [String: Any])
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let previous = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"]
        setenv("AGENTDECK_DATA_DIR", directory.path, 1)
        let store = ApmeStore()
        defer {
            store.close()
            if let previous { setenv("AGENTDECK_DATA_DIR", previous, 1) } else { unsetenv("AGENTDECK_DATA_DIR") }
            try? FileManager.default.removeItem(at: directory)
        }
        XCTAssertTrue(store.open())
        let collector = ApmeCollector(store: store)
        let now = Int(Date().timeIntervalSince1970 * 1_000)
        var ts = now
        let tracker = CoordinationTracker(now: { ts })
        for peer in try XCTUnwrap(fixture["peers"] as? [[String: Any]]) {
            let sid = try XCTUnwrap(peer["sessionId"] as? String)
            tracker.registerPid(sessionId: sid, pid: try XCTUnwrap(peer["pid"] as? Int))
            collector.handleHook(event: "session_start", data: ["session_id": sid, "agent_type": "claude-code"])
            collector.handleHook(event: "UserPromptSubmit", data: ["session_id": sid, "prompt": try XCTUnwrap(fixture["prompt"])])
        }
        for message in try XCTUnwrap(fixture["messages"] as? [[String: Any]]) {
            ts = now + (try XCTUnwrap(message["offset"] as? Int))
            if let duplicate = message["duplicatePeer"] as? [String: Any] {
                tracker.registerPid(sessionId: try XCTUnwrap(duplicate["sessionId"] as? String),
                                    pid: try XCTUnwrap(duplicate["pid"] as? Int))
            }
            let sid = try XCTUnwrap(message["sessionId"] as? String)
            let observed: CoordinationRelation?
            if let prompt = message["prompt"] as? String {
                observed = tracker.noteMessageIn(sessionId: sid, prompt: prompt)
            } else {
                observed = tracker.noteToolCall(sessionId: sid, toolName: "SendMessage", toolInput: message["toolInput"] as? [String: Any])
            }
            let event = try XCTUnwrap(observed)
            XCTAssertTrue(collector.noteRelation(sessionId: sid, relation: event.relation, direction: event.direction,
                phase: event.phase, peerSessionId: event.peerSessionId, peerName: event.peerName, evidence: event.evidence,
                detail: event.detail, ts: event.ts, key: event.key, messageIntent: event.messageIntent,
                messageFingerprint: event.messageFingerprint, peerIdentity: event.peerIdentity))
        }
        let ancestry = try XCTUnwrap(fixture["ambiguousAncestry"] as? [String: [[String: Any]]])
        let processes = try XCTUnwrap(ancestry["processes"]).map { row in
            try ProcessEnumerator.ProcessRow(pid: XCTUnwrap(row["pid"] as? Int), ppid: XCTUnwrap(row["ppid"] as? Int),
                                             command: XCTUnwrap(row["command"] as? String))
        }
        let peers = try XCTUnwrap(ancestry["peers"]).map { row in
            try CoordinationPeer(sessionId: XCTUnwrap(row["sessionId"] as? String), pid: XCTUnwrap(row["pid"] as? Int))
        }
        XCTAssertTrue(tracker.observe(processes, peers: peers).filter { $0.relation == "spawned" }.isEmpty)
        for event in try XCTUnwrap(fixture["extra"] as? [[String: Any]]) {
            XCTAssertTrue(collector.noteRelation(sessionId: "a", relation: try XCTUnwrap(event["relation"] as? String),
                direction: try XCTUnwrap(event["direction"] as? String), phase: try XCTUnwrap(event["phase"] as? String),
                peerSessionId: event["peerSessionId"] as? String, peerName: event["peerName"] as? String,
                evidence: try XCTUnwrap(event["evidence"] as? String), detail: nil,
                ts: now + (try XCTUnwrap(event["offset"] as? Int)), key: try XCTUnwrap(event["key"] as? String)))
        }
        let delegate = try XCTUnwrap(fixture["delegate"] as? [String: Any])
        XCTAssertTrue(collector.noteSubagentLifecycle(sessionId: "a", id: try XCTUnwrap(delegate["id"] as? String),
            name: try XCTUnwrap(delegate["name"] as? String), phase: try XCTUnwrap(delegate["phase"] as? String),
            ts: now + (try XCTUnwrap(delegate["offset"] as? Int))))

        let http = HTTPServer()
        await ApmeHttpRoutes.register(on: http, store: store)
        func get(_ path: String, query: [String: String] = [:]) async throws -> Data {
            let response = await http.route(.init(method: "GET", path: path, headers: [:], body: nil,
                queryParams: query.merging(["token": AuthManager.shared.token]) { _, token in token }, remoteIP: "127.0.0.1"))
            XCTAssertEqual(response.status, 200)
            return try XCTUnwrap(response.body)
        }
        let history = try await get("/apme/communications")
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: history) as? [String: Any])
        let events = try XCTUnwrap(raw["events"] as? [[String: Any]])
        let expected = try XCTUnwrap(fixture["expectedMessages"] as? [[String: Any]])
        let keys = try XCTUnwrap(expected.first).keys.filter { $0 != "offset" }
        let comparable = try events.map { event in
            var result = event.filter { keys.contains($0.key) }
            result["offset"] = try XCTUnwrap(event["ts"] as? Int) - now
            return result
        }
        XCTAssertEqual(comparable as NSArray, expected as NSArray)

        let snapshot = try JSONDecoder().decode(CommunicationSnapshot.self, from: history)
        XCTAssertEqual(snapshot.schema, "agentdeck-communications/v1")
        XCTAssertFalse(snapshot.truncated)
        // Only the two PID-identified endpoints become messages; name-only and
        // legacy-id observations stay out of the history.
        let projected = CommunicationHistory.project(snapshot: snapshot, roster: [])
        let screen = try XCTUnwrap(fixture["expectedScreen"] as? [String: Any])
        XCTAssertEqual(projected.names.keys.sorted(), screen["nodes"] as? [String])
        XCTAssertEqual(projected.messages.first?.sender, screen["latestSender"] as? String)
        XCTAssertEqual(projected.messages.first?.recipient, screen["latestRecipient"] as? String)

        let page = try JSONDecoder().decode(CollaborationTaskPage.self,
            from: await get("/apme/tasks", query: ["session": "a", "limit": "8"]))
        XCTAssertEqual(page.tasks.map(\.sessionId), ["a"])
        let task = try XCTUnwrap(page.tasks.first)
        let detail = try JSONDecoder().decode(CollaborationDetail.self, from: await get("/apme/tasks/\(task.id)"))
        let children = CollaborationProjection.children(sample: detail.sample, sessionId: "a", taskId: task.id)
        let relations = CollaborationProjection.relations(sample: detail.sample, sessionId: "a", taskId: task.id)
        XCTAssertEqual(children.map(\.id), screen["delegates"] as? [String])
        XCTAssertEqual(CollaborationProjection.workRelations(relations).compactMap(\.peerName), screen["backgroundJobs"] as? [String])
    }

    func testNativeStoreReturnsOnlyBoundedRecentMessagesAcrossSessions() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        setenv("AGENTDECK_DATA_DIR", directory.path, 1)
        let store = ApmeStore()
        defer { store.close(); unsetenv("AGENTDECK_DATA_DIR"); try? FileManager.default.removeItem(at: directory) }
        XCTAssertTrue(store.open())
        let collector = ApmeCollector(store: store)
        for session in ["a", "b"] {
            collector.handleHook(event: "session_start", data: ["session_id": session, "agent_type": "claude-code"])
            collector.handleHook(event: "UserPromptSubmit", data: ["session_id": session, "prompt": "private prompt"])
            for (key, relation, ts) in [("old", "messaged", 1), ("recent", "messaged", 10000), ("job", "waiting_on", 20000)] {
                XCTAssertTrue(collector.noteRelation(sessionId: session, relation: relation, direction: "out", phase: "closed",
                    peerSessionId: "peer", peerName: "Peer", evidence: "test", detail: String(repeating: "x", count: 300), ts: ts, key: key, messageIntent: "request", messageFingerprint: "abc"))
            }
        }
        let rows = try store.listCommunicationEvents(since: 100, limit: 10)
        XCTAssertEqual(rows.count, 2)
        XCTAssertTrue(rows.allSatisfy { $0["messageIntent"] as? String == "request" && $0["messageFingerprint"] as? String == "abc" })
        XCTAssertEqual(Set(rows.compactMap { $0["sessionId"] as? String }), ["a", "b"])
        XCTAssertTrue(rows.allSatisfy { ($0["detail"] as? String)?.count == 140 && $0["input"] == nil && $0["text"] == nil })
        XCTAssertEqual(try store.listCommunicationEvents(since: 100, limit: 1).count, 1)
        store.close()
        XCTAssertThrowsError(try store.listCommunicationEvents(since: 100, limit: 1))
    }
}
#endif
