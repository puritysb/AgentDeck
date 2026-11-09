import XCTest
@testable import AgentDeck
#if os(macOS)
import SwiftUI
import RealityKit

final class CommunicationGraphTests: XCTestCase {
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

    func testEmptyHistoryDoesNotPlotUnrelatedRosterSessions() throws {
        let network = CommunicationNetwork.project(snapshot: nil, roster: try roster())
        XCTAssertTrue(network.nodes.isEmpty)
        XCTAssertTrue(network.links.isEmpty)
    }

    func testLinkBadgesAvoidTheNodesThatHidThemInTheLiveNineNodeGraph() {
        let width: CGFloat = 760, height: CGFloat = 390, nodeWidth: CGFloat = 130
        let points = (0..<9).map { index in
            let angle = Double(index)/9 * .pi*2 - .pi/2
            return CGPoint(x: width/2+cos(angle)*(width/2-nodeWidth/2-8), y: height/2+sin(angle)*(height/2-38))
        }
        var occupied = points.map { CGRect(x: $0.x-nodeWidth/2, y: $0.y-32, width: nodeWidth, height: 64) }
        let bounds = CGRect(x: 4, y: 4, width: width-8, height: height-8)
        for (from, to) in [(6, 2), (6, 8), (4, 2), (5, 2)] {
            let center = CGPoint(x: (points[from].x+points[to].x)/2, y: (points[from].y+points[to].y)/2)
            let rect = CommunicationLabelLayout.place(preferred: center, size: CGSize(width: 72, height: 24), bounds: bounds, avoiding: occupied)
            XCTAssertTrue(bounds.contains(rect))
            XCTAssertFalse(occupied.contains { $0.intersects(rect) }, "A link control must remain visible above the graph geometry")
            occupied.append(rect)
        }
    }

    func testReplyRequestIsOnlyAnObservationAndNewerTrafficWins() throws {
        let request = """
        {"id":"1","sessionId":"a","ts":10000,"relation":"messaged","direction":"out","peerSessionId":"b","peerIdentity":"pid","messageIntent":"request"}
        """
        let first = CommunicationNetwork.project(snapshot: try snapshot("[\(request)]"), roster: try roster())
        XCTAssertEqual(first.links.first?.status, "Reply request observed")
        let next = """
        {"id":"2","sessionId":"b","ts":20000,"relation":"messaged","direction":"out","peerSessionId":"a","peerIdentity":"pid","messageIntent":"unknown"}
        """
        let network = CommunicationNetwork.project(snapshot: try snapshot("[\(request),\(next)]"), roster: try roster())
        XCTAssertEqual(network.links.map(\.latestSender), ["b"])
        XCTAssertEqual(network.links.first?.status, "Message observed")
        XCTAssertEqual(network.links.first?.lastObservedAt, 20000)
    }

    func testNamesAndLegacyIdsStaySeparateEvenWhenARecentMessageHasTheSameName() throws {
        let value = try snapshot("""
        [{"id":"1","sessionId":"a","ts":10000,"relation":"messaged","direction":"out","peerName":"Reviewer"},
         {"id":"2","sessionId":"a","ts":20000,"relation":"messaged","direction":"in","peerSessionId":"b","peerName":"Reviewer"},
         {"id":"3","sessionId":"a","ts":30000,"relation":"messaged","direction":"in","peerSessionId":"gone","peerIdentity":"pid","peerName":"Reviewer"}]
        """)
        let network = CommunicationNetwork.project(snapshot: value, roster: try roster())
        XCTAssertEqual(network.links.map(\.latestSender), ["gone"])
        XCTAssertEqual(network.nodes.map(\.id), ["a", "gone"])
        XCTAssertEqual(network.unidentified.map(\.id), ["2", "1"])
        XCTAssertNil(network.nodes.first { $0.id == "gone" }?.rosterID)
    }

    func testCrossedMessagesMarkOrderUncertain() throws {
        let value = try snapshot("""
        [{"id":"1","sessionId":"a","ts":10000,"relation":"messaged","direction":"out","peerSessionId":"b","peerIdentity":"pid"},
         {"id":"2","sessionId":"b","ts":11000,"relation":"messaged","direction":"out","peerSessionId":"a","peerIdentity":"pid"}]
        """)
        let network = CommunicationNetwork.project(snapshot: value, roster: try roster())
        XCTAssertEqual(network.links.first?.crossed, true)
    }

    func testLegacyDeliveryNeedsUniqueReciprocalEvidence() throws {
        let send = #"{"id":"1","sessionId":"a","ts":10000,"relation":"messaged","direction":"out","peerSessionId":"b","evidence":"send_message_tool","messageFingerprint":"abc"}"#
        let receipt = #"{"id":"2","sessionId":"b","ts":10100,"relation":"messaged","direction":"in","peerSessionId":"a","evidence":"cross_session_message","messageFingerprint":"abc"}"#
        let duplicate = #"{"id":"3","sessionId":"a","ts":10200,"relation":"messaged","direction":"out","peerSessionId":"b","evidence":"send_message_tool","messageFingerprint":"abc"}"#
        let roster = try roster()
        let corroborated = CommunicationNetwork.project(snapshot: try snapshot("[\(send),\(receipt)]"), roster: roster)
        XCTAssertEqual(corroborated.links.count, 1)
        XCTAssertTrue(corroborated.unidentified.isEmpty)
        let ambiguous = CommunicationNetwork.project(snapshot: try snapshot("[\(send),\(receipt),\(duplicate)]"), roster: roster)
        XCTAssertTrue(ambiguous.links.isEmpty)
        XCTAssertEqual(ambiguous.unidentified.count, 3)
        let outsideWindow = receipt.replacingOccurrences(of: "10100", with: "13000")
        let distant = CommunicationNetwork.project(snapshot: try snapshot("[\(send),\(outsideWindow)]"), roster: roster)
        XCTAssertTrue(distant.links.isEmpty)
    }

    func testInvalidDirectionsFutureEventsAndNonMessagesDoNotCreateEdges() throws {
        let value = try snapshot("""
        [{"id":"1","sessionId":"a","ts":10000,"relation":"spawned","direction":"out","peerSessionId":"b"},
         {"id":"2","sessionId":"a","ts":10000,"relation":"messaged","direction":"unknown","peerSessionId":"b"},
         {"id":"3","sessionId":"a","ts":100001,"relation":"messaged","direction":"out","peerSessionId":"b"}]
        """)
        XCTAssertTrue(CommunicationNetwork.project(snapshot: value, roster: try roster()).links.isEmpty)
    }

    func testHabitatRequiresTwoVisibleIdentitiesAndFiltersInspectedCreature() throws {
        let value = try snapshot("""
        [{"id":"1","sessionId":"a","ts":10000,"relation":"messaged","direction":"out","peerSessionId":"b","peerIdentity":"pid","messageIntent":"request"},
         {"id":"2","sessionId":"a","ts":20000,"relation":"messaged","direction":"out","peerName":"unknown"}]
        """)
        let ids: Set<String> = ["observed:claude:a", "b", "unrelated"]
        func habitat(_ visible: Set<String>, _ focus: String? = nil) throws -> AquariumCommunications {
            .project(snapshot: value, roster: try roster(), visibleIDs: visible, focusedID: focus, fresh: true)
        }
        XCTAssertEqual(try habitat(ids).currents.map(\.senderID), ["observed:claude:a"])
        XCTAssertTrue(try habitat(["observed:claude:a"]).currents.isEmpty, "Off-stage peers have no invented position")
        XCTAssertTrue(try habitat(ids, "unrelated").currents.isEmpty)
        XCTAssertEqual(try habitat(ids, "b").currents.count, 1)
        let live = try habitat(ids)
        let frozen = AquariumCommunications(currents: live.currents, capturedAt: 100000, fresh: false, truncated: false)
        let later = Date(timeIntervalSince1970: 160)
        XCTAssertEqual(live.currents[0].status, "Reply request observed")
        XCTAssertEqual(frozen.clock(later), 100000)
    }

    @MainActor
    func test3DCurrentAnchorsFollowResidentParentAndCameraAndDisappearOnRemoval() async throws {
        let scene = AquariumResidents()
        scene.loadTemplates(try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz"))))
        var state = TerrariumState()
        state.creatures = [.init(id: "a", projectName: "A", modelName: nil, state: .working, homeX: 0.5, homeY: 0.5, scale: 1)]
        scene.sync(state, aspect: 1.6)
        let camera = PerspectiveCamera()
        camera.look(at: [0, 2, 0], from: [0, 2, 14], relativeTo: nil)
        scene.camera = camera
        let first = try XCTUnwrap(scene.communicationPosition("a", aspect: 1.6))
        scene.root.position.x += 1
        let moved = try XCTUnwrap(scene.communicationPosition("a", aspect: 1.6))
        XCTAssertGreaterThan(moved.x, first.x)
        camera.position.x += 1
        XCTAssertEqual(try XCTUnwrap(scene.communicationPosition("a", aspect: 1.6)).x, first.x, accuracy: 0.001)
        state.creatures = []
        scene.sync(state, aspect: 1.6)
        XCTAssertNil(scene.communicationPosition("a", aspect: 1.6))
        XCTAssertNil(scene.communicationPosition("missing", aspect: 1.6))
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

    func testRenderHistoryWithIdentifiedAndUnidentifiedPeers() async throws {
        let roster = try JSONDecoder().decode([SessionInfo].self, from: Data("""
        [{"id":"a","port":0,"alive":true,"projectName":"Implementation","state":"processing"},
         {"id":"b","port":0,"alive":true,"projectName":"Review","state":"idle"},
         {"id":"c","port":0,"alive":true,"projectName":"Tests","state":"awaiting_permission"}]
        """.utf8))
        let now = Int(Date().timeIntervalSince1970 * 1000)
        let payload = Data("""
        {"schema":"agentdeck-communications/v1","capturedAt":\(now),"since":\(now-86400000),"truncated":false,"events":[
        {"id":"1","sessionId":"a","ts":\(now-180000),"relation":"messaged","direction":"out","peerSessionId":"b","peerIdentity":"pid","peerName":"reviewer","messageIntent":"request","messageFingerprint":"abc","detail":"Please reply with the session identity findings"},
        {"id":"2","sessionId":"b","ts":\(now-179990),"relation":"messaged","direction":"in","peerSessionId":"a","peerIdentity":"pid","peerName":"builder","messageIntent":"request","messageFingerprint":"abc"},
        {"id":"3","sessionId":"c","ts":\(now-45000),"relation":"messaged","direction":"out","peerName":"external-peer","detail":"Waiting for the test fixture"}]}
        """.utf8)
        let feed = CommunicationFeed(load: { _ in payload }, pause: { throw CancellationError() })
        await feed.observe(port: 1, connected: true)
        var selected: String?
        let view = CommunicationGraphView(feed: feed, roster: roster, selectedID: "a", expanded: true,
                                          inspect: { selected = $0 })
            .padding(20).frame(width: 1000, height: 850).aquariumSurface()
        let hosting = NSHostingView(rootView: view)
        hosting.frame = NSRect(x: 0, y: 0, width: 1000, height: 850)
        hosting.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: "/tmp/agentdeck-communication-graph.png"))
        XCTAssertNil(selected, "Rendering a graph must not steer or select an agent")
        let network = CommunicationNetwork.project(snapshot: feed.snapshot, roster: roster)
        XCTAssertEqual(network.links.count, 1)
        XCTAssertEqual(network.links.first?.detail, "Please reply with the session identity findings")
        XCTAssertEqual(network.unidentified.count, 1)
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
        let network = CommunicationNetwork.project(snapshot: snapshot, roster: [])
        let screen = try XCTUnwrap(fixture["expectedScreen"] as? [String: Any])
        XCTAssertEqual(network.nodes.map(\.id), screen["nodes"] as? [String])
        XCTAssertEqual(network.links.count, 1)
        XCTAssertEqual(network.links.first?.latestSender, screen["latestSender"] as? String)
        XCTAssertEqual(network.links.first?.latestRecipient, screen["latestRecipient"] as? String)
        XCTAssertEqual(network.links.first?.status, screen["latestStatus"] as? String)
        XCTAssertEqual(network.unidentified.map { Int($0.ts) - now }, screen["unidentifiedOffsets"] as? [Int])

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
