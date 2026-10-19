#if os(macOS)
// `timeline.json` is the one file both daemons own in turn.
//
// Either daemon can be the one bound to 9120, and whichever is serving is the
// only process allowed to write this file. So a handover — the CLI daemon
// stops and the app takes the port, or the reverse — means one implementation
// rehydrating history the OTHER one wrote. If the formats drift, the symptom
// is not an error: the decode returns nil and the entire timeline silently
// starts empty.
//
// The Node suite already pins this from its side (`timeline-persistence.test.ts`
// asserts it writes a plain JSON array, that every row carries the ts/type/raw
// triple, and that it can read a file in the shape the Swift daemon writes).
// The Swift side only round-tripped its OWN file, so the contract was pinned in
// one direction and the reverse handover was untested.
//
// **The fixtures below are copied verbatim from a real `~/.agentdeck/timeline.json`
// written by the Node daemon (read 2026-08-19), not composed from the decoder's
// field list.** A fixture built from what the reader expects cannot fail, which
// is exactly how a format gap survives a green suite.

import XCTest
@testable import AgentDeck

final class TimelineCrossDaemonFormatTests: XCTestCase {
    func testStagedNodeHistorySurvivesSwiftPromotionWithoutReplacingOwnHistory() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let ownFile = dir.appendingPathComponent("timeline.json")
        let peerFile = dir.appendingPathComponent("timeline-handover.json")
        let own = Data(#"[{"ts":1000,"type":"chat_response","raw":"existing Swift history"}]"#.utf8)
        try own.write(to: ownFile)
        // Copied from the installed Node candidate's actual 2026-10-13 acceptance turn.
        let peer = Data(#"[{"ts":1791885086142,"type":"chat_response","raw":"CLI handover repair accepted.","detail":"CLI handover repair accepted.","sessionId":"01a13493-b966-76a1-837a-3a6129dfe22d","agentType":"codex-cli","startedAt":1791885058410,"endedAt":1791885086142,"taskId":"6e5799d6-400c-42a7-bde2-b8e59ad0082d","projectName":"AgentDeck \u00b7 AgentDeck"}]"#.utf8)
        DaemonTimelineStore.stageHandoverSnapshot(peer, to: peerFile)
        let store = DaemonTimelineStore(persistFile: ownFile, handoverFile: peerFile)
        await store.start()
        let rows = await store.getAll()
        XCTAssertEqual(rows.map(\.raw), ["existing Swift history", "CLI handover repair accepted."])
        XCTAssertEqual(try Data(contentsOf: ownFile), own, "Staging must not write the active daemon's file")
        let again = DaemonTimelineStore(persistFile: ownFile, handoverFile: peerFile)
        await again.start()
        let repeated = await again.getAll()
        XCTAssertEqual(repeated.count, 2)
    }

    @DaemonActor
    func testSharedCiScheduledDedupVectors() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/timeline-ci-dedup-vectors.json"))
        let vectors = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [[String: Any]])
        for vector in vectors {
            let store = DaemonTimelineStore(persistFile: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString))
            let before = try JSONSerialization.data(withJSONObject: XCTUnwrap(vector["before"] as? [String: Any]))
            let incoming = try JSONSerialization.data(withJSONObject: XCTUnwrap(vector["incoming"] as? [String: Any]))
            let firstAccepted = await store.add(try JSONDecoder().decode(DaemonTimelineEntry.self, from: before))
            let incomingAccepted = await store.add(try JSONDecoder().decode(DaemonTimelineEntry.self, from: incoming))
            XCTAssertTrue(firstAccepted)
            XCTAssertEqual(incomingAccepted, vector["action"] as? String == "add",
                           "Only accepted rows may be broadcast: \(vector["name"] ?? "")")
            let actual = await store.getAll()
            XCTAssertEqual(actual.count, vector["action"] as? String == "add" ? 2 : 1, vector["name"] as? String ?? "")
        }
    }

    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("timeline-xdaemon-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// The richest row the Node daemon actually emits — a closed task carrying
    /// its APME verdict. Fifteen keys, several of which the Swift decoder has
    /// no property for; unknown keys must be ignored, never fatal.
    private let nodeTaskEnd = """
    {
      "endedAt": 1786970557842,
      "taskId": "d60fdec7-622f-4212-bb71-6caffafb402e",
      "boundarySignal": "session_end",
      "taskCategory": "ops",
      "sessionId": "215ec8a9-e98a-498e-8281-6bc5d5a99754",
      "ts": 1786970557842,
      "runId": "16ba3c3e-5dd4-4dd0-8d8c-573cb91f0771",
      "startedAt": 1786969352964,
      "taskOutcome": "success",
      "agentType": "claude-code",
      "taskSummary": "Created, merged, and deployed PR #219, then corrected a local git state assessment after peer review.",
      "projectName": "AgentDeck",
      "taskScore": 0.95,
      "type": "task_end",
      "raw": "Session end · 20m 5s"
    }
    """

    /// A plain prompt row — the common case, and the one that proves a row
    /// needs nothing beyond the shared triple plus attribution.
    private let nodeChatStart = """
    {
      "ts": 1787096905572,
      "type": "chat_start",
      "raw": "CLAUDE.md 가 없는데 그래도 괜찮은가? 현재 프로젝트 상태 점검하라.",
      "sessionId": "a3dab322-fe25-42fc-9080-d1c84326e8c8",
      "agentType": "claude-code",
      "startedAt": 1787096905572,
      "taskId": "da44437f-3bcd-4662-84ed-4d5138633fa9",
      "projectName": "foundby-site"
    }
    """

    /// Claude's opt-in per-tool rows, in the key set and order of a real
    /// `tool_request`/`tool_resolved` pair the Node daemon wrote (read
    /// 2026-10-19); the command, ids and timestamps are stand-ins.
    private let nodeToolRequest = """
    {"ts":1787096910000,"type":"tool_request","raw":"Bash requested","detail":"pnpm vitest run","sessionId":"a3dab322-fe25-42fc-9080-d1c84326e8c8","toolUseId":"toolu_01XyZ0aBcDeFgHiJkLmNoPqR","agentType":"claude-code","toolEvent":true,"projectName":"foundby-site"}
    """
    private let nodeToolResolved = """
    {"ts":1787096912000,"type":"tool_resolved","raw":"Bash completed","detail":"pnpm vitest run","sessionId":"a3dab322-fe25-42fc-9080-d1c84326e8c8","toolUseId":"toolu_01XyZ0aBcDeFgHiJkLmNoPqR","agentType":"claude-code","toolEvent":true,"projectName":"foundby-site"}
    """

    private func writeNodeFile(_ rows: [String]) throws -> URL {
        let url = dir.appendingPathComponent("timeline.json")
        try "[\(rows.joined(separator: ","))]".write(to: url, atomically: true, encoding: .utf8)
        return url
    }

    // MARK: - Reading the other daemon's file

    func testRehydratesAFileTheNodeDaemonWrote() async throws {
        let file = try writeNodeFile([nodeChatStart, nodeTaskEnd])
        let store = DaemonTimelineStore(persistFile: file)
        await store.start()
        let entries = await store.getAll()

        XCTAssertEqual(entries.count, 2,
                       "history the CLI daemon wrote was dropped on handover")
        // Rehydration sorts by `ts`, and the task_end fixture is the OLDER of
        // the two real rows, so match on content rather than on file order.
        let prompt = entries.first { $0.type == "chat_start" }
        let closed = entries.first { $0.type == "task_end" }
        XCTAssertEqual(prompt?.sessionId, "a3dab322-fe25-42fc-9080-d1c84326e8c8")
        XCTAssertEqual(closed?.raw, "Session end · 20m 5s")
        XCTAssertEqual(entries.map(\.ts), entries.map(\.ts).sorted(),
                       "carried-over history must stay chronological")
    }

    func testDropsTheOptInToolRowsTheNodeDaemonWrote() async throws {
        // Only the Node daemon serves these, and only to a surface that asked
        // for them. Decoded without their flag they were ordinary tool rows,
        // which this daemon sent to every client, boards included.
        let file = try writeNodeFile([nodeChatStart, nodeToolRequest, nodeToolResolved])
        let store = DaemonTimelineStore(persistFile: file)
        await store.start()
        let entries = await store.getAll()
        XCTAssertEqual(entries.map(\.type), ["chat_start"])
    }

    func testKeepsTheAttributionTheOtherDaemonRecorded() async throws {
        // Losing agentType/projectName would not empty the timeline — it would
        // render every carried-over row as an unattributed one, which reads as
        // corruption rather than as a handover.
        let file = try writeNodeFile([nodeTaskEnd])
        let store = DaemonTimelineStore(persistFile: file)
        await store.start()
        let first = await store.getAll().first
        let entry = try XCTUnwrap(first)

        XCTAssertEqual(entry.agentType, "claude-code")
        XCTAssertEqual(entry.projectName, "AgentDeck")
        XCTAssertEqual(entry.taskId, "d60fdec7-622f-4212-bb71-6caffafb402e")
    }

    func testAnUnknownKeyFromANewerNodeDaemonDoesNotDropTheRow() async throws {
        // The two daemons ship on their own schedules, so the app WILL meet a
        // file written by a Node daemon that records a field this build has
        // never heard of. One unknown key must not cost the whole history.
        let futureRow = """
        {"ts":1787096905572,"type":"chat_start","raw":"hello",
         "sessionId":"a3dab322-fe25-42fc-9080-d1c84326e8c8",
         "agentType":"claude-code","somethingAddedLater":{"nested":true}}
        """
        let file = try writeNodeFile([futureRow, nodeTaskEnd])
        let store = DaemonTimelineStore(persistFile: file)
        await store.start()
        let count = await store.getAll().count
        XCTAssertEqual(count, 2)
    }

    // MARK: - Writing a file the other daemon can read

    func testWritesAPlainArrayWithTheSharedTriple() async throws {
        // Mirror of the Node assertion. An object wrapper, or a row missing
        // ts/type/raw, would decode to nothing on the Node side and lose the
        // history in the other direction.
        let file = dir.appendingPathComponent("out.json")
        let store = DaemonTimelineStore(persistFile: file)
        await store.start()
        await store.add(DaemonTimelineEntry(
            ts: 1787096905572, type: "chat_start", raw: "written by Swift",
            agentType: "claude-code", projectName: "AgentDeck",
            sessionId: "a3dab322-fe25-42fc-9080-d1c84326e8c8"))
        await store.flush()
        try await Task.sleep(for: .milliseconds(200))

        let data = try Data(contentsOf: file)
        let parsed = try JSONSerialization.jsonObject(with: data)
        let rows = try XCTUnwrap(parsed as? [[String: Any]],
                                 "not a plain JSON array — the Node reader decodes an array")
        let row = try XCTUnwrap(rows.first)
        XCTAssertNotNil(row["ts"])
        XCTAssertNotNil(row["type"])
        XCTAssertNotNil(row["raw"])
    }

    func testRoundTripsThroughTheNodeShapeWithoutLoss() async throws {
        // Write with Swift, re-read with Swift through the same plain-array
        // path Node uses. This is the handover in both directions.
        let file = dir.appendingPathComponent("round.json")
        let writer = DaemonTimelineStore(persistFile: file)
        await writer.start()
        await writer.add(DaemonTimelineEntry(
            ts: 1787096905572, type: "task_end", raw: "Session end · 20m 5s",
            agentType: "claude-code", projectName: "AgentDeck",
            sessionId: "215ec8a9-e98a-498e-8281-6bc5d5a99754"))
        await writer.flush()
        try await Task.sleep(for: .milliseconds(200))

        let reader = DaemonTimelineStore(persistFile: file)
        await reader.start()
        let readBack = await reader.getAll().first
        let entry = try XCTUnwrap(readBack)
        XCTAssertEqual(entry.ts, 1787096905572)
        XCTAssertEqual(entry.type, "task_end")
        XCTAssertEqual(entry.raw, "Session end · 20m 5s")
        XCTAssertEqual(entry.sessionId, "215ec8a9-e98a-498e-8281-6bc5d5a99754")
    }
}
#endif
