#if os(macOS)
import XCTest
@testable import AgentDeck

/// Replays shared/claude-statusline-vectors.json — the same file the Node suite
/// replays. Parser compatibility is shared; the Swift daemon deliberately uses
/// status-line receipts for diagnostics only (integration coverage below).
final class ClaudeStatuslineRulesTests: XCTestCase {
    private static let receivedAtMs: Double = 1792108799000

    private func root() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/claude-statusline-vectors.json")
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func cases(_ section: String) throws -> (now: Double, rows: [[String: Any]]) {
        let root = try root()
        let now = try XCTUnwrap((root["now"] as? NSNumber)?.doubleValue)
        let rows = try XCTUnwrap(root[section] as? [[String: Any]])
        XCTAssertGreaterThan(rows.count, 0, section)
        return (now, rows)
    }

    private func number(_ raw: Any?) -> Double? {
        guard let n = raw as? NSNumber, !(raw is NSNull) else { return nil }
        return n.doubleValue
    }

    private func window(_ raw: Any?) -> ClaudeStatuslineRules.Window? {
        guard let d = raw as? [String: Any], let pct = number(d["usedPercent"]) else { return nil }
        return ClaudeStatuslineRules.Window(usedPercent: pct, resetsAt: d["resetsAt"] as? String)
    }

    private func reading(_ raw: Any?) -> ClaudeStatuslineRules.Reading? {
        guard let d = raw as? [String: Any] else { return nil }
        return ClaudeStatuslineRules.Reading(
            fiveHour: window(d["fiveHour"]), sevenDay: window(d["sevenDay"]),
            sessionId: d["sessionId"] as? String, model: d["model"] as? String, version: d["version"] as? String,
            receivedAtMs: number(d["receivedAt"]) ?? Self.receivedAtMs,
            durationMs: number(d["durationMs"]), apiDurationMs: number(d["apiDurationMs"]),
            inputTokens: number(d["inputTokens"]), outputTokens: number(d["outputTokens"]))
    }

    func testParseVectors() throws {
        for c in try cases("parse").rows {
            let name = c["name"] as? String ?? ""
            let got = ClaudeStatuslineRules.parse(c["payload"], receivedAtMs: Self.receivedAtMs)
            guard let expected = c["expected"] as? [String: Any] else {
                XCTAssertNil(got, name)
                continue
            }
            let r = try XCTUnwrap(got, name)
            XCTAssertEqual(r.fiveHour, window(expected["fiveHour"]), name)
            XCTAssertEqual(r.sevenDay, window(expected["sevenDay"]), name)
            XCTAssertEqual(r.sessionId, expected["sessionId"] as? String, name)
            XCTAssertEqual(r.model, expected["model"] as? String, name)
            XCTAssertEqual(r.version, expected["version"] as? String, name)
            XCTAssertEqual(r.receivedAtMs, Self.receivedAtMs, name)
            XCTAssertEqual(r.durationMs, number(expected["durationMs"]), name)
            XCTAssertEqual(r.apiDurationMs, number(expected["apiDurationMs"]), name)
            XCTAssertEqual(r.inputTokens, number(expected["inputTokens"]), name)
            XCTAssertEqual(r.outputTokens, number(expected["outputTokens"]), name)
        }
    }

    func testAgeVectors() throws {
        let (now, rows) = try cases("age")
        for c in rows {
            let name = c["name"] as? String ?? ""
            let expected: ClaudeStatuslineRules.Age
            switch try XCTUnwrap(c["age"] as? String) {
            case "fresh": expected = .fresh
            case "aged": expected = .aged
            default: expected = .unknown
            }
            XCTAssertEqual(ClaudeStatuslineRules.age(receivedAtMs: number(c["receivedAt"]), nowMs: now), expected, name)
        }
    }

    func testPollVectors() throws {
        let (now, rows) = try cases("poll")
        for c in rows {
            let name = c["name"] as? String ?? ""
            let got = ClaudeStatuslineRules.shouldPollOAuth(
                statuslineReceivedAtMs: number(c["statuslineReceivedAt"]),
                lastOAuthFetchAtMs: number(c["lastOAuthFetchAt"]),
                oauthHasScopedLimits: try XCTUnwrap(c["oauthHasScopedLimits"] as? Bool),
                nowMs: now)
            XCTAssertEqual(got, try XCTUnwrap(c["poll"] as? Bool), name)
        }
    }

    func testCarryVectors() throws {
        let (now, rows) = try cases("carry")
        for c in rows {
            let name = c["name"] as? String ?? ""
            XCTAssertEqual(
                ClaudeStatuslineRules.oauthCarryOverFresh(lastOAuthFetchAtMs: number(c["lastOAuthFetchAt"]), nowMs: now),
                try XCTUnwrap(c["carry"] as? Bool), name)
        }
    }

    func testOAuthOrderingVectors() throws {
        for c in try cases("oauthOrdering").rows {
            let name = c["name"] as? String ?? ""
            XCTAssertEqual(ClaudeStatuslineRules.preserveUsageOnOAuth(
                currentFetchedAt: try XCTUnwrap(number(c["currentFetchedAt"])),
                nextFetchedAt: try XCTUnwrap(number(c["nextFetchedAt"])),
                fresh: try XCTUnwrap(c["fresh"] as? Bool),
                statuslineLive: try XCTUnwrap(c["statuslineLive"] as? Bool)),
                try XCTUnwrap(c["preserve"] as? Bool), name)
        }
    }

    func testChangedVectors() throws {
        for c in try cases("changed").rows {
            let name = c["name"] as? String ?? ""
            let next = try XCTUnwrap(reading(c["next"]), name)
            XCTAssertEqual(ClaudeStatuslineRules.changed(prev: reading(c["prev"]), next: next),
                           try XCTUnwrap(c["changed"] as? Bool), name)
        }
    }

    func testFocusedWeeklySnapshotRetiresCachedWindowWithoutRenewingObservation() {
        let current = ApiUsageData(
            fiveHourPercent: 42, fiveHourResetsAt: "2099-01-01T00:00:00Z",
            sevenDayPercent: 12, sevenDayResetsAt: "2099-01-08T00:00:00Z",
            extraUsageEnabled: true, extraUsageMonthlyLimit: 100,
            fetchedAt: 1234)
        let next = DaemonServer.syncRelayedClaudeUsage(current, [
            "claudeUsageSnapshot": true, "sevenDayPercent": 0.0,
            "sevenDayResetsAt": "2099-01-15T00:00:00Z",
        ])
        XCTAssertNil(next.fiveHourPercent)
        XCTAssertNil(next.fiveHourResetsAt)
        XCTAssertEqual(next.sevenDayPercent, 0)
        XCTAssertFalse(next.extraUsageEnabled)
        XCTAssertNil(next.extraUsageMonthlyLimit)
        XCTAssertEqual(next.fetchedAt, current.fetchedAt)
        let legacy = DaemonServer.syncRelayedClaudeUsage(current, ["sevenDayPercent": 0.0])
        XCTAssertEqual(legacy.fiveHourPercent, current.fiveHourPercent)
        XCTAssertEqual(legacy.fiveHourResetsAt, current.fiveHourResetsAt)
    }

    func testAcceptanceVectors() throws {
        for c in try cases("accept").rows {
            let name = c["name"] as? String ?? ""
            let previous = reading(c["previousForSession"])
            let current = reading(c["current"])
            let next = try XCTUnwrap(reading(c["next"]), name)
            XCTAssertEqual(ClaudeStatuslineRules.progressRegressed(previous: previous, next: next),
                           try XCTUnwrap(c["regressed"] as? Bool), name)
            XCTAssertEqual(ClaudeStatuslineRules.shouldAccept(
                previousForSession: previous, current: current, next: next,
                currentSource: c["currentSource"] as? String),
                try XCTUnwrap(c["accepted"] as? Bool), name)
        }
    }

    /// The constants the Node side pins (claude-statusline-sync.test.ts checks
    /// the generated file byte for byte; this guards the semantics they carry).
    func testFreshBoundIsInclusive() {
        let now: Double = 1_792_108_800_000
        XCTAssertEqual(ClaudeStatuslineRules.age(receivedAtMs: now - ClaudeStatuslineRules.freshMs, nowMs: now), .fresh)
        XCTAssertEqual(ClaudeStatuslineRules.age(receivedAtMs: now - ClaudeStatuslineRules.freshMs - 1, nowMs: now), .aged)
        XCTAssertEqual(ClaudeStatuslineRules.route, "/claude/statusline")
    }
}

/// Real POST /claude/statusline → GET /usage handlers, with no daemon startup,
/// registry ownership, device modules, hooks installation or polling. A local
/// receipt must never become an account quota observation in the Swift daemon.
@DaemonActor
final class ClaudeStatuslineDiagnosticIntegrationTests: XCTestCase {
    private let document = #"{"session_id":"quota-diagnostic-test","rate_limits":{"five_hour":{"used_percentage":33,"resets_at":4102444800},"seven_day":{"used_percentage":9,"resets_at":4103049600}},"cost":{"total_duration_ms":1000,"total_api_duration_ms":100},"context_window":{"total_input_tokens":10,"total_output_tokens":20}}"#

    private func withDaemon(_ body: (DaemonServer, UInt16) async throws -> Void) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("claude-statusline-\(UUID().uuidString)")
        let previous = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"]
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        setenv("AGENTDECK_DATA_DIR", directory.path, 1)
        defer {
            if let previous { setenv("AGENTDECK_DATA_DIR", previous, 1) }
            else { unsetenv("AGENTDECK_DATA_DIR") }
            try? FileManager.default.removeItem(at: directory)
        }
        let listener = WebSocketServer()
        var selected: UInt16?
        for port in UInt16(19740)..<UInt16(19750) {
            do {
                try await listener.start(port: port, loopbackOnly: true)
                selected = port
                break
            } catch { continue }
        }
        let port = try XCTUnwrap(selected, "no loopback port available for the isolated route test")
        do {
            let daemon = try await DaemonServer(
                port: Int(port), debug: false,
                posture: DaemonPosture(loopbackOnly: true, noDeviceModules: true))
            let http = HTTPServer()
            await daemon.setupHTTPRoutes(using: http)
            await listener.setHTTPHandler(http)
            try await body(daemon, port)
            XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("daemon.json").path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("sessions.json").path))
        } catch {
            await listener.stop()
            throw error
        }
        await listener.stop()
    }

    private func request(_ port: UInt16, path: String, body: String? = nil) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(path)")!)
        request.timeoutInterval = 5
        if let body {
            request.httpMethod = "POST"
            request.httpBody = Data(body.utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func assertNoClaudeQuota(_ usage: [String: Any], file: StaticString = #filePath, line: UInt = #line) {
        for key in ["fiveHourPercent", "sevenDayPercent", "fiveHourResetsAt", "sevenDayResetsAt",
                    "scopedLimits", "extraUsageEnabled", "extraUsageMonthlyLimit",
                    "extraUsageUsedCredits", "extraUsageUtilization"] {
            XCTAssertNil(usage[key], key, file: file, line: line)
        }
        XCTAssertEqual(usage["usageStale"] as? Bool, true, file: file, line: line)
        XCTAssertEqual(usage["claudeUsageSnapshot"] as? Bool, true, file: file, line: line)
        let subscriptions = usage["subscriptions"] as? [[String: Any]] ?? []
        XCTAssertFalse(subscriptions.contains { ($0["name"] as? String) == "Claude" }, file: file, line: line)
    }

    func testStatuslinePOSTRecordsDeliveryWithoutQuotaBillingOrSubscription() async throws {
        try await withDaemon { daemon, port in
            let beforeState = daemon.buildFullStateEvent(agentType: "daemon")
            for body in [document, document,
                         #"{"session_id":"other-session","rate_limits":{"five_hour":{"used_percentage":100,"resets_at":1}}}"#,
                         #"{"session_id":"other-session","rate_limits":{}}"#] {
                let response = try await request(port, path: ClaudeStatuslineRules.route, body: body)
                XCTAssertEqual(response["received"] as? Bool, true)
                XCTAssertEqual(response["applied"] as? Bool, false)
                XCTAssertEqual(response["broadcast"] as? Bool, false)
                let endpoint = try await request(port, path: "/usage")
                XCTAssertEqual(endpoint["fetchedAt"] as? Int, 0)
                assertNoClaudeQuota(try XCTUnwrap(endpoint["usage"] as? [String: Any]))
            }
            let health = daemon.claudeUsageHealth()
            XCTAssertNotNil(health.receivedAtMs)
            XCTAssertEqual(health.session, "other-session")
            XCTAssertEqual(health.age, "fresh", "receipt age diagnoses delivery, not quota freshness")
            XCTAssertFalse(health.live)
            XCTAssertNil(health.source)
            XCTAssertNil(health.lastOAuthFamilyMs)
            let state = daemon.buildFullStateEvent(agentType: "daemon")
            XCTAssertEqual(state["billingType"] as? String, beforeState["billingType"] as? String)
            XCTAssertEqual(state["state"] as? String, beforeState["state"] as? String)
            XCTAssertEqual(state["agentType"] as? String, "daemon")
            XCTAssertEqual(state["subscriptions"] as? [[String: String]], beforeState["subscriptions"] as? [[String: String]])
        }
    }

    func testStatuslineDoesNotReplaceOrRefreshAnAccountRelayAndCannotKeepStaleQuotaLive() async throws {
        try await withDaemon { daemon, port in
            let observedAt = Date().addingTimeInterval(-60).timeIntervalSince1970
            var account = ApiUsageData(
                fiveHourPercent: 41, fiveHourResetsAt: "2099-01-01T00:00:00Z",
                sevenDayPercent: 12, sevenDayResetsAt: "2099-01-08T00:00:00Z",
                extraUsageEnabled: true, extraUsageMonthlyLimit: 100,
                extraUsageUsedCredits: 5, extraUsageUtilization: 5,
                inferredBillingType: "subscription", fetchedAt: observedAt)
            daemon.applyOAuthFamilyReading(account, source: "relay")
            let before = try await request(port, path: "/usage")
            _ = try await request(port, path: ClaudeStatuslineRules.route, body: document)
            let after = try await request(port, path: "/usage")
            XCTAssertEqual(after["fetchedAt"] as? Int, Int(observedAt * 1000))
            let beforeUsage = try XCTUnwrap(before["usage"] as? [String: Any])
            let afterUsage = try XCTUnwrap(after["usage"] as? [String: Any])
            for key in ["fiveHourPercent", "sevenDayPercent", "extraUsageMonthlyLimit", "extraUsageUsedCredits", "extraUsageUtilization"] {
                XCTAssertEqual(afterUsage[key] as? Double, beforeUsage[key] as? Double, key)
            }
            XCTAssertEqual(afterUsage["extraUsageEnabled"] as? Bool, true)
            XCTAssertEqual(afterUsage["subscriptions"] as? [[String: String]], [["name": "Claude"]])
            XCTAssertEqual(daemon.claudeUsageHealth().source, "relay")
            XCTAssertFalse(daemon.claudeUsageHealth().live)

            // A newer real account response remains able to correct usage down.
            account.fiveHourPercent = 7
            account.fetchedAt = observedAt + 30
            daemon.applyOAuthFamilyReading(account, source: "relay")
            let corrected = try await request(port, path: "/usage")
            XCTAssertEqual((corrected["usage"] as? [String: Any])?["fiveHourPercent"] as? Double, 7)
            XCTAssertEqual(corrected["fetchedAt"] as? Int, Int((observedAt + 30) * 1000))

            account.stale = true
            daemon.applyOAuthFamilyReading(account, source: "relay")
            _ = try await request(port, path: ClaudeStatuslineRules.route, body: document)
            let stale = try await request(port, path: "/usage")
            assertNoClaudeQuota(try XCTUnwrap(stale["usage"] as? [String: Any]))
            XCTAssertEqual(stale["fetchedAt"] as? Int, Int((observedAt + 30) * 1000))
        }
    }
}
#endif
