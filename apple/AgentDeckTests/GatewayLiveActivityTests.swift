#if os(macOS)
import XCTest
@testable import AgentDeck

final class GatewayLiveActivityTests: XCTestCase {
    func testCapturedTurnStartsBeforeToolsAndEmitsOneCompletedTool() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("tests/parity/gateway-live/turn.json")
        let frames = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [[String: Any]])
        var live = GatewayLiveActivity()
        var rows: [GatewayLiveUpdate] = []
        for f in frames {
            let event = try XCTUnwrap(f["event"] as? String)
            let payload = try XCTUnwrap(f["payload"] as? [String: Any])
            rows += live.ingest(event, payload, now: try XCTUnwrap(f["observedAt"] as? Double) + 0.75)
            if event == "session.tool" || (event == "chat" && payload["state"] as? String == "status") {
                XCTAssertTrue(live.busy)
            }
        }
        XCTAssertFalse(live.busy)
        XCTAssertEqual(rows.map { $0.entry.type }, ["chat_start", "tool_exec", "chat_response"])
        XCTAssertTrue(rows[0].entry.raw.contains("sleep 20"))
        XCTAssertTrue(rows[1].entry.detail?.contains("AGENTDECK_OC_CHAT_TOOL_OK") == true)
        XCTAssertGreaterThan((rows[1].entry.endedAt ?? 0) - (rows[1].entry.startedAt ?? 0), 20_000)
        XCTAssertEqual(rows[2].entry.raw, "AGENTDECK_OC_CHAT_DONE")
        for row in rows {
            for stamp in [row.entry.ts, row.entry.startedAt, row.entry.endedAt].compactMap({ $0 }) {
                XCTAssertEqual(stamp, stamp.rounded(.towardZero))
            }
        }
        XCTAssertEqual(rows[0].entry.ts, rows[2].entry.startedAt)
        let rendered = try JSONDecoder().decode([TimelineEntry].self,
            from: JSONEncoder().encode(rows.map { $0.entry }))
        let groups = groupConsecutive(rendered)
        XCTAssertEqual(groups.count, 2) // one request/answer group and one tool
        XCTAssertEqual(groups.first?.mergedResponse?.raw, "AGENTDECK_OC_CHAT_DONE")
        XCTAssertEqual(Set(rows.compactMap { $0.entry.runId }).count, 1)
        XCTAssertTrue(rows.allSatisfy { $0.entry.automated == false })
        for f in frames {
            XCTAssertTrue(live.ingest(f["event"] as! String, f["payload"] as! [String: Any], now: f["observedAt"] as! Double).isEmpty)
        }
        XCTAssertFalse(live.busy)
    }

    // Mirror of the TS fold test: one row for all tool calls of a run,
    // updated in place, so a config walk cannot bury the prompt and reply.
    func testToolCallsOfARunFoldIntoOneRow() {
        var live = GatewayLiveActivity()
        let key = "agent:main:test"
        _ = live.ingest("session.message", ["sessionKey": key, "runId": "a", "message": ["role": "user", "content": "tone it down"]], now: 1)
        func call(_ id: String, _ path: String, _ ts: Double, failed: Bool = false) -> [GatewayLiveUpdate] {
            _ = live.ingest("session.tool", ["sessionKey": key, "runId": "a", "stream": "tool",
                "data": ["phase": "start", "name": "openclaw", "toolCallId": id, "args": ["path": path]]], now: ts)
            var data: [String: Any] = ["phase": "result", "name": "openclaw", "toolCallId": id]
            if failed { data["isError"] = true }
            return live.ingest("session.tool", ["sessionKey": key, "runId": "a", "stream": "tool", "data": data], now: ts + 1)
        }
        let first = call("1", "channels", 10)
        XCTAssertEqual(first.count, 1)
        XCTAssertFalse(first[0].upsert)
        XCTAssertEqual(first[0].entry.raw, "openclaw · channels")
        let second = call("2", "agents.main", 20)
        XCTAssertTrue(second[0].upsert)
        XCTAssertEqual(second[0].entry.ts, first[0].entry.ts)
        _ = call("3", "messages.groupChat", 30)
        let fourth = call("4", ".", 40, failed: true)
        XCTAssertEqual(fourth[0].entry.raw, "openclaw ×4 · channels, agents.main, messages.groupChat, … · 1 failed")
        XCTAssertEqual(fourth[0].entry.detail?.components(separatedBy: "\n").count, 4)
        XCTAssertEqual(GatewayLiveActivity.toolFoldRaw(["exec · a", "read · b", "exec · c", "openclaw · d · failed"]),
                       "4 tools · exec ×2, read, openclaw · 1 failed")
    }

    func testConcurrentRunsAndLateToolResults() {
        var live = GatewayLiveActivity()
        let key = "agent:main:test"
        _ = live.ingest("sessions.changed", ["sessionKey": key, "session": ["activeRunIds": ["a", "b"]]], now: 1)
        _ = live.ingest("chat", ["sessionKey": key, "runId": "a", "state": "final"], now: 2)
        XCTAssertTrue(live.busy)
        _ = live.ingest("chat", ["sessionKey": key, "runId": "b", "state": "final"], now: 3)
        XCTAssertFalse(live.busy)
        let result: [String: Any] = ["sessionKey": key, "runId": "a", "data": ["phase": "result", "toolCallId": "tool", "name": "exec", "isError": true]]
        XCTAssertEqual(live.ingest("session.tool", result, now: 4).count, 1)
        XCTAssertTrue(live.ingest("session.tool", result, now: 5).isEmpty)
        XCTAssertFalse(live.busy)
        live.reset()
        XCTAssertFalse(live.busy)
    }
}
#endif
