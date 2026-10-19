#if os(macOS)
import Foundation
import XCTest
@testable import AgentDeck

/// Replays shared/esp32-wifi-setup-vectors.json against ESP32WifiSetup and the
/// ESP32Serial pieces it serves, so this daemon answers GET/POST /esp32/wifi
/// field for field as the Node daemon does (bridge/src/__tests__/esp32-wifi-setup.test.ts
/// replays the same file). Responses are compared as sorted-key JSON, so a
/// Bool and a number, or a missing key and a null, never compare equal.
final class ESP32WifiSetupTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/esp32-wifi-setup-vectors.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func canonical(_ object: Any?) throws -> String {
        let data = try JSONSerialization.data(
            withJSONObject: object ?? NSNull(), options: [.sortedKeys, .fragmentsAllowed])
        return String(decoding: data, as: UTF8.self)
    }

    private func int(_ value: Any?) -> Int { (value as? NSNumber)?.intValue ?? -1 }

    private func ack(_ value: Any?) -> ESP32Serial.WifiProvisionAck? {
        guard let fields = value as? [String: Any] else { return nil }
        return ESP32Serial.WifiProvisionAck(
            success: fields["success"] as? Bool ?? false, joined: ESP32Serial.jsonBool(fields["joined"]),
            ip: fields["ip"] as? String ?? "", error: fields["error"] as? String ?? "", at: int(fields["at"]))
    }

    /// What the fake dependencies saw.
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var _boardsAsked: [String?] = []
        private var _saved: [WifiConfig] = []
        private var _provisioned: [(credId: String?, manual: Bool)] = []

        var boardsAsked: [String?] { lock.withLock { _boardsAsked } }
        var saved: [WifiConfig] { lock.withLock { _saved } }
        var provisioned: [(credId: String?, manual: Bool)] { lock.withLock { _provisioned } }

        func askedBoards(_ credId: String?) { lock.withLock { _boardsAsked.append(credId) } }
        func save(_ config: WifiConfig) { lock.withLock { _saved.append(config) } }
        func provision(_ credId: String?, _ manual: Bool) { lock.withLock { _provisioned.append((credId, manual)) } }
    }

    private struct SaveFailed: Error {}

    private func deps(
        _ file: [String: Any], config: WifiConfig?, serial: Bool, saveFails: Bool, recorder: Recorder
    ) throws -> ESP32WifiSetup.Deps {
        let token = try XCTUnwrap(file["token"] as? String)
        let bridgeIP = try XCTUnwrap(file["bridgeIp"] as? String)
        let rows = try XCTUnwrap(file["boardsReply"] as? [[String: Any]]).map { row in
            ESP32Serial.WifiSetupBoardRow(
                port: row["port"] as? String ?? "", board: row["board"] as? String ?? "",
                wifiConnected: row["wifiConnected"] as? Bool, wifiRadioParked: row["wifiRadioParked"] as? Bool,
                holdsCredentials: row["holdsCredentials"] as? Bool, provisionedAt: int(row["provisionedAt"]),
                ack: ack(row["ack"]))
        }
        let outcomes = try XCTUnwrap(file["provisionReply"] as? [[String: Any]]).map { row in
            ESP32Serial.WifiProvisionOutcome(
                port: row["port"] as? String ?? "", board: row["board"] as? String ?? "",
                sent: row["sent"] as? Bool ?? false, reason: row["reason"] as? String ?? "")
        }
        return ESP32WifiSetup.Deps(
            loadConfig: { config },
            saveConfig: { config in
                if saveFails { throw SaveFailed() }
                recorder.save(config)
            },
            serialRunning: { serial },
            boards: { credId in
                recorder.askedBoards(credId)
                return rows
            },
            provision: { msg, manual in
                recorder.provision(msg.value["credId"] as? String, manual)
                return outcomes
            },
            authToken: { token },
            bridgeIP: { bridgeIP },
            bridgePort: int(file["bridgePort"]))
    }

    private func config(_ value: Any?) -> WifiConfig? {
        guard let fields = value as? [String: Any],
              let ssid = fields["ssid"] as? String, let password = fields["password"] as? String else { return nil }
        return WifiConfig(ssid: ssid, password: password, autoProvision: fields["autoProvision"] as? Bool ?? true)
    }

    func testTheVectorCredIdIsTheSharedRulesId() throws {
        let file = try vectors()
        XCTAssertEqual(
            ESP32WifiProvisionRules.credId(
                authToken: try XCTUnwrap(file["token"] as? String),
                ssid: "DeskNet", password: "correct horse battery staple"),
            file["credId"] as? String)
    }

    func testStatusVectors() async throws {
        let file = try vectors()
        let cases = try XCTUnwrap(file["status"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            let recorder = Recorder()
            let response = await ESP32WifiSetup.status(try deps(
                file, config: config(vector["config"]), serial: vector["serial"] as? Bool ?? false,
                saveFails: false, recorder: recorder))
            XCTAssertEqual(response.status, 200, name)
            XCTAssertTrue(JSONSerialization.isValidJSONObject(response.body), name)
            XCTAssertEqual(try canonical(response.body), try canonical(vector["response"]), name)
            if vector.keys.contains("boardsAskedWith") {
                XCTAssertEqual(recorder.boardsAsked.count, 1, name)
                XCTAssertEqual(recorder.boardsAsked.first ?? nil, vector["boardsAskedWith"] as? String, name)
            } else {
                XCTAssertTrue(recorder.boardsAsked.isEmpty, "\(name): boards asked for")
            }
        }
    }

    func testApplyVectors() async throws {
        let file = try vectors()
        let cases = try XCTUnwrap(file["apply"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            // Once as the decoded value, once through the route's own body parser.
            let raw = try JSONSerialization.data(withJSONObject: vector["body"] ?? NSNull(), options: .fragmentsAllowed)
            for (path, body) in [("value", vector["body"]), ("http", ESP32WifiSetup.parseBody(raw))] {
                let label = "\(name) [\(path)]"
                let recorder = Recorder()
                let response = await ESP32WifiSetup.apply(body: body, deps: try deps(
                    file, config: nil, serial: vector["serial"] as? Bool ?? false,
                    saveFails: vector["saveFails"] as? Bool ?? false, recorder: recorder))
                XCTAssertEqual(response.status, int(vector["status"]), label)
                XCTAssertTrue(JSONSerialization.isValidJSONObject(response.body), label)
                XCTAssertEqual(try canonical(response.body), try canonical(vector["response"]), label)
                XCTAssertEqual(recorder.saved, config(vector["saved"]).map { [$0] } ?? [], label)
                if let provisioned = vector["provisioned"] as? [String: Any] {
                    XCTAssertEqual(recorder.provisioned.count, 1, label)
                    XCTAssertEqual(recorder.provisioned.first?.credId, provisioned["credId"] as? String, label)
                    XCTAssertEqual(recorder.provisioned.first?.manual, provisioned["manual"] as? Bool, label)
                } else {
                    XCTAssertTrue(recorder.provisioned.isEmpty, "\(label): provisioned")
                }
            }
        }
    }

    func testAuthorizationVectors() throws {
        let file = try vectors()
        let token = try XCTUnwrap(file["token"] as? String)
        let cases = try XCTUnwrap(file["authorized"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            let authorized = ESP32WifiSetup.authorized(
                remoteAddress: vector["remoteAddress"] as? String,
                authorization: vector["authorization"] as? String,
                validateToken: { $0 == token })
            XCTAssertEqual(authorized, vector["authorized"] as? Bool, name)
        }
        let refusal = try XCTUnwrap(file["refusal"] as? [String: Any])
        XCTAssertEqual(ESP32WifiSetup.refusal().status, int(refusal["status"]))
        XCTAssertEqual(try canonical(ESP32WifiSetup.refusal().body), try canonical(refusal["response"]))
    }

    func testRowVectors() throws {
        let cases = try XCTUnwrap(try vectors()["rows"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            // Through the parse every serial device_info takes.
            let info = (vector["deviceInfo"] as? [String: Any]).map { fields -> ESP32Serial.DeviceInfo in
                var message = fields
                message["type"] = "device_info"
                return ESP32Serial.deviceInfo(message: message)
            }
            let row = ESP32Serial.WifiSetupBoardRow(
                port: "/dev/cu.row", deviceInfo: info, expectedCredId: vector["expectedCredId"] as? String,
                provisionedAt: int(vector["provisionedAt"]), ack: ack(vector["ack"]))
            XCTAssertTrue(JSONSerialization.isValidJSONObject(row.json), name)
            XCTAssertEqual(try canonical(row.json), try canonical(vector["row"]), name)
        }
    }

    func testAckVectors() throws {
        let cases = try XCTUnwrap(try vectors()["acks"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            var recorded = try XCTUnwrap(vector["recorded"] as? [String: Any], name)
            recorded["at"] = 7
            let message = try XCTUnwrap(vector["message"] as? [String: Any], name)
            let ack = ESP32Serial.WifiProvisionAck(message: message, at: 7)
            XCTAssertEqual(try canonical(ack.json), try canonical(recorded), name)
            // The sheet reads the field as served, null included.
            let decoded = try JSONDecoder().decode(
                ESP32WifiStatus.Ack.self, from: JSONSerialization.data(withJSONObject: ack.json))
            XCTAssertEqual(decoded.joined, ack.joined, name)
            // A connection owed nothing keeps it, as the board's line does in Node.
            var conn = connection()
            ESP32Serial.recordWifiProvisionAck(&conn, message: message, now: 7)
            XCTAssertEqual(conn.wifiProvisionAck, ack, name)
        }
    }

    private func connection() -> ESP32Serial.SerialConnection {
        ESP32Serial.SerialConnection(port: "/dev/cu.ack", fd: -1, writeHandle: nil, readHandle: nil)
    }

    func testAnAckWhileALaterProvisionIsOwedOneAnswersTheEarlierProvision() {
        var conn = connection()
        ESP32Serial.markWifiProvisionWritten(&conn, now: 1_000)
        ESP32Serial.markWifiProvisionWritten(&conn, now: 2_000)
        // The board answers in order: this is the first provision's answer.
        ESP32Serial.recordWifiProvisionAck(
            &conn, message: ["type": "wifi_provision_ack", "success": false, "error": "connection failed"], now: 3_000)
        XCTAssertNil(conn.wifiProvisionAck)
        ESP32Serial.recordWifiProvisionAck(
            &conn, message: ["type": "wifi_provision_ack", "success": true, "joined": false], now: 4_000)
        XCTAssertEqual(conn.wifiProvisionAck,
                       ESP32Serial.WifiProvisionAck(success: true, joined: false, ip: "", error: "", at: 4_000))
        XCTAssertEqual(conn.wifiProvisionAckLedger, ESP32WifiProvisionRules.AckLedger(owed: 0, lastWriteAt: 2_000))
        XCTAssertEqual(conn.wifiProvisionSentAt, 2_000)
    }

    func testAnAckOwedPastTheSharedTimeoutIsPresumedLostAtTheNextWrite() {
        var conn = connection()
        ESP32Serial.markWifiProvisionWritten(&conn, now: 1_000)
        ESP32Serial.markWifiProvisionWritten(&conn, now: 1_000 + ESP32WifiProvisionRules.ackTimeoutMs + 1)
        ESP32Serial.recordWifiProvisionAck(
            &conn, message: ["type": "wifi_provision_ack", "success": true, "joined": true, "ip": "192.168.1.23"],
            now: 40_000)
        XCTAssertEqual(conn.wifiProvisionAck?.joined, true)
        XCTAssertEqual(conn.wifiProvisionAck?.ip, "192.168.1.23")
    }

    func testTheLogSaysConnectedOnlyForABoardThatJoined() {
        func line(_ fields: [String: Any]) -> String {
            ESP32Serial.WifiProvisionAck(message: fields, at: 0).logLine
        }
        XCTAssertEqual(line(["success": true, "joined": true, "ip": "192.168.1.23"]), "WiFi connected: 192.168.1.23 \u{2713}")
        XCTAssertEqual(line(["success": true, "joined": false, "ip": "192.168.1.23"]),
                       "WiFi credentials saved; the board joins when it leaves USB")
        XCTAssertEqual(line(["success": true, "ip": "192.168.1.23"]), "WiFi credentials accepted")
        XCTAssertEqual(line(["success": false, "error": "connection failed"]), "WiFi failed: connection failed")
    }

    func testBodyVectors() throws {
        XCTAssertEqual(try canonical(ESP32WifiSetup.parseBody(nil)), "{}", "no body reads as an empty object")
        let cases = try XCTUnwrap(try vectors()["bodies"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            var bytes: Data
            if let hex = vector["hex"] as? String {
                bytes = Data(stride(from: 0, to: hex.count, by: 2).compactMap { offset -> UInt8? in
                    let start = hex.index(hex.startIndex, offsetBy: offset)
                    return UInt8(hex[start..<hex.index(start, offsetBy: 2)], radix: 16)
                })
            } else {
                bytes = Data((try XCTUnwrap(vector["text"] as? String, name)).utf8)
            }
            if let padTo = vector["padTo"] as? Int {
                bytes.append(Data(repeating: 0x20, count: padTo - bytes.count))
            }
            let parsed = ESP32WifiSetup.parseBody(bytes)
            if try XCTUnwrap(vector["valid"] as? Bool, name) {
                XCTAssertEqual(try canonical(parsed), try canonical(vector["value"]), name)
            } else {
                XCTAssertNil(parsed, name)
            }
        }
    }

    // MARK: - The route handler the daemon registers

    private func request(_ head: String, body: String = "", from remoteIP: String = "127.0.0.1") -> HTTPServer.HTTPRequest {
        HTTPServer.parseHTTPRequest(Data((head + "\r\n\r\n" + body).utf8), remoteIP: remoteIP)
    }

    func testTheRouteAnswersOnlyALoopbackCallerHoldingTheToken() async throws {
        let file = try vectors()
        let token = try XCTUnwrap(file["token"] as? String)
        let recorder = Recorder()
        let fakeDeps = try deps(file, config: nil, serial: true, saveFails: false, recorder: recorder)
        func answer(_ request: HTTPServer.HTTPRequest) async -> HTTPServer.HTTPResponse {
            await DaemonServer.esp32WifiRouteResponse(request, validateToken: { $0 == token }, deps: { fakeDeps })
        }

        let get = await answer(request("GET /esp32/wifi HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nAuthorization: Bearer \(token)"))
        XCTAssertEqual(get.status, 200)
        XCTAssertEqual(get.headers["Cache-Control"], "no-store")
        let status = try XCTUnwrap(get.body.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(status["configured"] as? Bool, false)

        let lan = await answer(request(
            "GET /esp32/wifi HTTP/1.1\r\nHost: 192.168.1.50:9120\r\nAuthorization: Bearer \(token)", from: "192.168.1.23"))
        XCTAssertEqual(lan.status, 403, "the credentials never cross the LAN, token or not")
        let untokened = await answer(request("GET /esp32/wifi HTTP/1.1\r\nHost: 127.0.0.1:9120"))
        XCTAssertEqual(untokened.status, 403, "arriving from this machine is not enough")
        XCTAssertEqual(recorder.boardsAsked.count, 1, "only the authorized GET reached the boards")

        let body = #"{"ssid":"DeskNet","password":"correct horse battery staple"}"#
        let post = await answer(request(
            "POST /esp32/wifi HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nAuthorization: Bearer \(token)\r\n"
                + "Content-Type: application/json\r\nContent-Length: \(body.utf8.count)", body: body))
        XCTAssertEqual(post.status, 200)
        XCTAssertEqual(recorder.saved, [WifiConfig(ssid: "DeskNet", password: "correct horse battery staple")])
        XCTAssertEqual(recorder.provisioned.first?.manual, true)
        let echoed = String(decoding: post.body ?? Data(), as: UTF8.self)
        XCTAssertFalse(echoed.contains("correct horse"), "the password is never served")
        XCTAssertFalse(echoed.contains(try XCTUnwrap(file["credId"] as? String)), "nor the credential id")

        let garbled = await answer(request(
            "POST /esp32/wifi HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nAuthorization: Bearer \(token)\r\nContent-Length: 6",
            body: "{nope}"))
        XCTAssertEqual(garbled.status, 400)
        XCTAssertEqual(recorder.saved.count, 1, "a body that is not JSON saves nothing")

        // Bytes that are not UTF-8 reach the route and are refused there, as
        // Node refuses them. The server used to read such a request as `GET /`.
        var latin1 = Data(#"{"ssid":"Desk"#.utf8)
        latin1.append(0xFF)
        latin1.append(Data(#"","password":"correct horse battery staple"}"#.utf8))
        var raw = Data(("POST /esp32/wifi HTTP/1.1\r\nHost: 127.0.0.1:9120\r\nAuthorization: Bearer \(token)\r\n"
            + "Content-Type: application/json\r\nContent-Length: \(latin1.count)\r\n\r\n").utf8)
        raw.append(latin1)
        let parsed = HTTPServer.parseHTTPRequest(raw, remoteIP: "127.0.0.1")
        XCTAssertEqual(parsed.method, "POST")
        XCTAssertEqual(parsed.path, "/esp32/wifi")
        let notUTF8 = await answer(parsed)
        XCTAssertEqual(notUTF8.status, 400)
        let refusal = try XCTUnwrap(notUTF8.body.flatMap { try JSONSerialization.jsonObject(with: $0) as? [String: Any] })
        XCTAssertEqual(refusal["error"] as? String, "invalid-body")
        XCTAssertEqual(recorder.saved.count, 1, "bytes that are not UTF-8 save nothing")
    }

    // MARK: - The operator's request through the fan-out

    func testAnOperatorRequestPassesWhatTheAutomaticPathHoldsBack() throws {
        let msg = ESP32Serial.wifiProvisionMessage(
            ssid: "DeskNet", password: "correct horse battery staple", bridgeIP: "192.168.1.50",
            bridgePort: 9120, authToken: "fanout-token")
        let oldFirmware = ESP32Serial.DeviceInfo(board: "86box", wifiConfigured: true, wifiConnected: false)
        let joined = ESP32Serial.DeviceInfo(board: "ttgo", wifiConfigured: true, wifiConnected: true)
        let views = [
            ESP32Serial.ProvisionView(port: "/dev/cu.sent", connected: true, provisionSent: true, deviceInfo: oldFirmware),
            ESP32Serial.ProvisionView(port: "/dev/cu.old", connected: true, provisionSent: false, deviceInfo: oldFirmware),
            ESP32Serial.ProvisionView(port: "/dev/cu.joined", connected: true, provisionSent: false, deviceInfo: joined),
        ]
        let sent = [
            "/dev/cu.sent": ESP32Serial.provisionFingerprint(for: msg),
            "/dev/cu.old": ESP32Serial.provisionFingerprint(for: msg),
        ]
        XCTAssertEqual(ESP32Serial.wifiProvisionTargets(views, msg: msg, fingerprintsByPort: sent), [])
        let manual = ESP32Serial.wifiProvisionPlan(views, msg: msg, fingerprintsByPort: sent, manual: true)
        XCTAssertEqual(manual.map(\.send), [true, true, false])
        XCTAssertEqual(manual.map(\.reason), ["operator-request", "operator-request", "wifi-connected"])
    }

    // MARK: - What the sheet says

    func testTheSheetDescribesEachBoardFromItsOwnReport() {
        func board(provisionedAt: Int64 = 0, ack: ESP32WifiStatus.Ack? = nil, connected: Bool? = false,
                   holds: Bool? = nil, name: String = "t_embed") -> ESP32WifiStatus.Board {
            ESP32WifiStatus.Board(port: "/dev/cu.x", board: name, wifiConnected: connected, wifiRadioParked: true,
                                  holdsCredentials: holds, provisionedAt: provisionedAt, ack: ack)
        }
        let joined = ESP32WifiStatus.Ack(success: true, joined: true, ip: "192.168.1.23", error: "", at: 2)
        let saved = ESP32WifiStatus.Ack(success: true, joined: false, ip: "", error: "", at: 2)
        let older = ESP32WifiStatus.Ack(success: true, joined: nil, ip: "192.168.1.23", error: "", at: 2)
        let failed = ESP32WifiStatus.Ack(success: false, joined: false, ip: "", error: "connection failed", at: 2)
        let unsaved = ESP32WifiStatus.Ack(success: false, joined: false, ip: "", error: "credentials not saved", at: 2)
        XCTAssertEqual(ESP32WifiBoardLine.describe(board(provisionedAt: 1, ack: joined), outcome: nil),
                       .ok("Joined Wi-Fi at 192.168.1.23"))
        // A serial-primary board stays off Wi-Fi while it is on USB.
        XCTAssertEqual(ESP32WifiBoardLine.describe(board(provisionedAt: 1, ack: saved), outcome: nil),
                       .ok("Saved — the board switches to Wi-Fi when it's off USB"))
        // Older firmware does not say, and its address may be an earlier join's.
        XCTAssertEqual(ESP32WifiBoardLine.describe(board(provisionedAt: 1, ack: older), outcome: nil),
                       .ok("The board accepted the credentials"))
        XCTAssertEqual(ESP32WifiBoardLine.describe(board(provisionedAt: 1, ack: failed), outcome: nil),
                       .failed("Couldn't join Wi-Fi: connection failed"))
        XCTAssertEqual(ESP32WifiBoardLine.describe(board(provisionedAt: 1, ack: unsaved), outcome: nil),
                       .failed("The board couldn't save the credentials"))
        guard case .waiting = ESP32WifiBoardLine.describe(board(provisionedAt: 1), outcome: nil) else {
            return XCTFail("a sent provision with no answer is still waiting")
        }
        let match = ESP32WifiApplyResult.Outcome(port: "/dev/cu.x", board: "t_embed", sent: false, reason: "credentials-match")
        XCTAssertEqual(ESP32WifiBoardLine.describe(board(holds: true), outcome: match), .ok("Already holds these credentials"))
        XCTAssertEqual(ESP32WifiBoardLine.describe(board(name: ""), outcome: nil), .neutral("Identifying…"))
        XCTAssertEqual(ESP32WifiBoardLine.describe(board(connected: true), outcome: nil), .ok("On Wi-Fi"))
    }
}
#endif
