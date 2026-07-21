#if os(macOS)
import XCTest
@testable import AgentDeck

/// Regression guard for the WiFi-WS ESP32 flap fix.
///
/// A WiFi ESP32 board is a *display* client, not a dashboard. It must ONLY ever
/// receive the whitelisted, `prepareForSerial`-shrunk event stream — never the
/// full dashboard-state fanout. The regression that these tests exist to prevent
/// (commit f7443d42) blasted the full state at every ESP32 board on every
/// (re)connect, overran their small buffers over congested 2.4 GHz, and flapped
/// the socket every few seconds in a self-reinforcing storm. If someone routes
/// unshrunk / non-display events at ESP32 boards again, these fail.
/// See memory `esp32-wifi-flap-broadcast-amplification`.
final class ESP32WifiForwardTests: XCTestCase {

    /// Dashboard-only events must be dropped (nil) for a display board.
    func testNonForwardedEventIsDroppedForEsp32() {
        let dashboardOnly: [[String: Any]] = [
            ["type": "apme_eval", "scorecard": ["x": 1]],
            ["type": "sessions_update_internal"],
            ["type": "recommend_result"],
        ]
        for ev in dashboardOnly {
            XCTAssertNil(
                ESP32Serial.wifiEsp32Forward(ev, deviceInfo: nil),
                "non-forwarded event \(ev["type"] ?? "?") must be dropped for WiFi ESP32")
        }
    }

    /// A forwarded event is delivered but STRIPPED of heavy dashboard-only fields —
    /// that shrink is exactly what keeps the board's buffer from overrunning.
    func testForwardedStateUpdateIsShrunkNotFull() {
        let full: [String: Any] = [
            "type": "state_update",
            "agentType": "claude",
            "modelCatalog": ["big": Array(repeating: "x", count: 200)],
            "moduleHealth": ["serial": ["connected": true]],
            "subscriptions": ["a", "b"],
        ]
        guard let out = ESP32Serial.wifiEsp32Forward(full, deviceInfo: nil) else {
            return XCTFail("state_update must be forwarded to WiFi ESP32 boards")
        }
        XCTAssertEqual(out["type"] as? String, "state_update")
        XCTAssertNil(out["modelCatalog"], "modelCatalog must be stripped for ESP32 display boards")
        XCTAssertNil(out["moduleHealth"], "moduleHealth must be stripped for ESP32 display boards")
        XCTAssertNil(out["subscriptions"], "subscriptions must be stripped for ESP32 display boards")
        XCTAssertEqual(out["agentType"] as? String, "claude", "display-relevant fields survive the shrink")
    }

    /// Timeline rows must be capped to the firmware's byte-sized TimelineEntry
    /// buffers on a UTF-8 character boundary. Uncapped raw let the board's
    /// 119-byte strncpy cut mid-한글 and the IPS10 cards / InkDeck ticker drew a
    /// broken trailing glyph (Node parity: bridge/src/esp32-serial.ts `stamp`).
    func testTimelineEventRawIsByteCappedUtf8Safe() {
        let raw = String(repeating: "가", count: 60)   // 180 UTF-8 bytes, 60 Characters
        let ev: [String: Any] = [
            "type": "timeline_event",
            "entry": ["ts": 1_752_700_000_000, "type": "chat_start", "raw": raw,
                      "detail": String(repeating: "나", count: 100),
                      "projectName": String(repeating: "다", count: 30)],
        ]
        guard let out = ESP32Serial.wifiEsp32Forward(ev, deviceInfo: nil),
              let entry = out["entry"] as? [String: Any],
              let outRaw = entry["raw"] as? String,
              let outDetail = entry["detail"] as? String,
              let outProject = entry["projectName"] as? String else {
            return XCTFail("timeline_event must be forwarded with a shrunk entry")
        }
        XCTAssertLessThanOrEqual(outRaw.utf8.count, 119)
        XCTAssertEqual(outRaw, String(repeating: "가", count: 39), "cut must land on a character boundary")
        XCTAssertLessThanOrEqual(outDetail.utf8.count, 199)
        XCTAssertLessThanOrEqual(outProject.utf8.count, 39)
    }

    /// History seeds are capped to the firmware ring (newest 64) with each entry shrunk.
    func testTimelineHistoryCappedToFirmwareRing() {
        let entries: [[String: Any]] = (0..<100).map { ["ts": $0, "type": "chat_start", "raw": "row \($0)"] }
        let ev: [String: Any] = ["type": "timeline_history", "entries": entries]
        guard let out = ESP32Serial.wifiEsp32Forward(ev, deviceInfo: nil),
              let outEntries = out["entries"] as? [[String: Any]] else {
            return XCTFail("timeline_history must be forwarded")
        }
        XCTAssertEqual(outEntries.count, 64)
        XCTAssertEqual(outEntries.first?["raw"] as? String, "row 36", "newest 64 survive")
        XCTAssertEqual(outEntries.last?["raw"] as? String, "row 99")
    }

    /// sessions_list string caps are UTF-8 BYTE budgets, not Character counts —
    /// 39 한글 Characters would be 117 bytes and overflow projectName[40] on-device.
    func testSessionsListCapsAreByteBudgets() {
        let ev: [String: Any] = [
            "type": "sessions_list",
            "sessions": [["id": "s1", "alive": true,
                          "projectName": String(repeating: "가", count: 39)]],
        ]
        guard let out = ESP32Serial.wifiEsp32Forward(ev, deviceInfo: nil),
              let sessions = out["sessions"] as? [[String: Any]],
              let project = sessions.first?["projectName"] as? String else {
            return XCTFail("sessions_list must be forwarded")
        }
        XCTAssertLessThanOrEqual(project.utf8.count, 39)
        XCTAssertEqual(project, String(repeating: "가", count: 13))
    }

    /// An ESP32 board is unregistered for the first few hundred ms of every
    /// connection (device_info is announced only after its WS opens), so the
    /// shaping path must hold with `deviceInfo: nil` — that is the state the
    /// connect burst actually sees. Keying board-vs-dashboard on registration
    /// instead sent boards the raw 100-entry history (115 KB, 28× their 4 KB
    /// line buffer), killing the socket before the announce landed: the board
    /// reconnected, lost the race again, and never registered (round_amoled's
    /// 5-second flap). Every shaped frame must fit the smallest line buffer.
    func testUnregisteredBoardFramesFitSmallestLineBuffer() {
        let entries: [[String: Any]] = (0..<100).map { i in
            ["ts": Double(i), "type": "chat_start",
             "raw": "\(i)-" + String(repeating: "가", count: 60),
             "detail": String(repeating: "나", count: 60)]
        }
        let events: [[String: Any]] = [
            ["type": "timeline_history", "entries": entries],
            ["type": "sessions_list", "sessions": (0..<14).map { i in
                ["id": "s\(i)", "alive": true, "agentType": "claude", "state": "processing",
                 "projectName": String(repeating: "다", count: 20)] }],
        ]
        for ev in events {
            guard let shaped = ESP32Serial.wifiEsp32Forward(ev, deviceInfo: nil),
                  let data = try? JSONSerialization.data(withJSONObject: shaped) else {
                return XCTFail("\(ev["type"] ?? "?") must be forwarded for an unregistered board")
            }
            XCTAssertLessThan(data.count, 4096,
                              "\(ev["type"] ?? "?") shaped to \(data.count)B — overruns the 4096B board line buffer")
        }
    }

    /// timeline_history is byte-budgeted, not just row-capped — a busy
    /// afternoon of CJK entries made the 64-row frame ~37KB, past every
    /// board's line buffer (serial: silent discard; WiFi: socket-killing).
    func testTimelineHistoryByteBudgeted() {
        let entries: [[String: Any]] = (0..<64).map { i in
            ["ts": Double(i), "raw": "\(i)-" + String(repeating: "가", count: 39)]
        }
        let ev: [String: Any] = ["type": "timeline_history", "entries": entries]
        guard let out = ESP32Serial.wifiEsp32Forward(ev, deviceInfo: nil),
              let kept = out["entries"] as? [[String: Any]] else {
            return XCTFail("timeline_history must be forwarded")
        }
        XCTAssertLessThan(kept.count, entries.count)
        XCTAssertFalse(kept.isEmpty)
        let total = kept.compactMap { try? JSONSerialization.data(withJSONObject: $0).count + 1 }.reduce(0, +)
        XCTAssertLessThanOrEqual(total, ESP32Serial.timelineHistoryByteBudget)
        // Newest survive
        XCTAssertEqual(kept.last?["ts"] as? Double, 63)
    }

    /// The roster is capped at SERIAL_SESSIONS_CAP (Node parity). Uncapped, a
    /// burst of observed Claude sessions pushed the frame past the boards'
    /// 4 KB line buffer — serial firmware discards the line silently, but the
    /// WiFi WS firmware closes the socket (the WiFi-only board reconnect flap).
    func testSessionsListCappedRoundRobinAcrossAgentTypes() {
        var sessions: [[String: Any]] = (0..<14).map { i in
            ["id": "claude-\(i)", "alive": true, "agentType": "claude", "state": "processing"]
        }
        sessions.append(["id": "codex-0", "alive": true, "agentType": "codex", "state": "idle"])
        let ev: [String: Any] = ["type": "sessions_list", "sessions": sessions]
        guard let out = ESP32Serial.wifiEsp32Forward(ev, deviceInfo: nil),
              let shaped = out["sessions"] as? [[String: Any]] else {
            return XCTFail("sessions_list must be forwarded")
        }
        XCTAssertEqual(shaped.count, ESP32Serial.serialSessionsCap)
        // Round-robin keeps the lone codex row instead of letting 14 claude
        // sessions evict it.
        XCTAssertTrue(shaped.contains { ($0["id"] as? String) == "codex-0" })
    }

    /// The daemon-computed lastEvent* milestone fields (TIMELINE parity for the
    /// IPS10 cards) survive the sessions_list shrink — byte-capped, and omitted
    /// entirely when absent (empty strings would waste the serial line budget).
    func testSessionsListLastEventFieldsForwardedConditionally() {
        let ev: [String: Any] = [
            "type": "sessions_list",
            "sessions": [
                ["id": "s1", "alive": true,
                 "lastEventText": String(repeating: "가", count: 60),
                 "lastEventTask": "ips10 카드 개선", "lastEventHm": "14:07"],
                ["id": "s2", "alive": true],
            ],
        ]
        guard let out = ESP32Serial.wifiEsp32Forward(ev, deviceInfo: nil),
              let sessions = out["sessions"] as? [[String: Any]] else {
            return XCTFail("sessions_list must be forwarded")
        }
        let withEvent = sessions[0]
        XCTAssertLessThanOrEqual((withEvent["lastEventText"] as? String)?.utf8.count ?? 999, 99)
        XCTAssertEqual(withEvent["lastEventTask"] as? String, "ips10 카드 개선")
        XCTAssertEqual(withEvent["lastEventHm"] as? String, "14:07")
        let without = sessions[1]
        XCTAssertNil(without["lastEventText"], "absent milestone must be omitted, not sent as empty string")
        XCTAssertNil(without["lastEventTask"])
        XCTAssertNil(without["lastEventHm"])
    }

    /// The whitelist must cover the display events a board renders, and match the
    /// USB-serial path (single source of truth: `serialForwardedEvents`).
    func testDisplayEventWhitelistForwarded() {
        for t in ["state_update", "usage_update", "sessions_list", "display_state", "timeline_event", "timeline_history"] {
            XCTAssertTrue(ESP32Serial.serialForwardedEvents.contains(t), "\(t) should be a forwarded display event")
            XCTAssertNotNil(
                ESP32Serial.wifiEsp32Forward(["type": t], deviceInfo: nil),
                "display event \(t) must be forwarded to WiFi ESP32 boards")
        }
    }
}

/// Regression guard for the serial open-failure backoff (PR #77).
///
/// Every `open()` toggles DTR/RTS and resets the attached board, so a port that
/// keeps failing to open (a wedged CH340) must escalate its retry cadence
/// instead of rebooting a healthy board every minute. This locks the ramp so a
/// future tweak to the constants can't silently tighten it back to the old
/// once-a-minute reset-poking. See memory `ips10-wedged-ch340-daemon-reset-poke`.
final class ESP32SerialOpenBackoffTests: XCTestCase {

    /// Transient (open-timeout / non-EACCES) failures ramp 10→20→40→80→160→300s.
    /// The cap rises from 60s to the 5-min block at the escalation threshold, so
    /// 300s is only reached at the 6th failure — a gradual ramp, not a cliff.
    func testTransientBackoffRampsAndEscalates() {
        let expected: [(failCount: Int, seconds: TimeInterval)] = [
            (1, 10), (2, 20), (3, 40),    // below threshold: exponential, capped at 60s
            (4, 80), (5, 160),            // cap raised to 300s, still ramping
            (6, 300), (7, 300), (20, 300) // settled at the 5-min block
        ]
        for c in expected {
            XCTAssertEqual(
                ESP32Serial.openFailureBackoff(failCount: c.failCount, isPermanent: false),
                c.seconds, accuracy: 0.001,
                "transient open-failure backoff for failCount \(c.failCount)")
        }
    }

    /// No failCount may ever push the transient cadence past the 5-min block.
    func testTransientBackoffNeverExceedsFiveMinutes() {
        for failCount in 1...200 {
            XCTAssertLessThanOrEqual(
                ESP32Serial.openFailureBackoff(failCount: failCount, isPermanent: false),
                300,
                "transient backoff must never exceed the 5-min permanent block")
        }
    }

    /// EACCES (permanent) failures use the flat 5-min block regardless of count.
    func testPermanentFailureUsesFlatFiveMinuteBlock() {
        for failCount in 1...5 {
            XCTAssertEqual(
                ESP32Serial.openFailureBackoff(failCount: failCount, isPermanent: true),
                300, accuracy: 0.001,
                "EACCES (permanent) always uses the flat 5-min block")
        }
    }
}
#endif
