#if os(macOS)
import Foundation
import XCTest
@testable import AgentDeck

/// Replays shared/esp32-wifi-provision-vectors.json against the generated
/// `ESP32WifiProvisionRules` (CryptoKit), so this daemon sends the same
/// credential id and reaches the same provisioning decision as the Node daemon
/// (shared and bridge suites replay the same file).
final class ESP32WifiProvisionRulesTests: XCTestCase {
    private func vectors() throws -> [String: Any] {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("shared/esp32-wifi-provision-vectors.json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    func testConstantsMatchTheVectorFile() throws {
        let file = try vectors()
        XCTAssertEqual(ESP32WifiProvisionRules.credIdDomain, file["domain"] as? String)
        XCTAssertEqual(ESP32WifiProvisionRules.credIdHexLength, file["hexLength"] as? Int)
    }

    func testCredIdVectors() throws {
        let cases = try XCTUnwrap(try vectors()["credIds"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            let actual = ESP32WifiProvisionRules.credId(
                authToken: try XCTUnwrap(vector["token"] as? String, name),
                ssid: try XCTUnwrap(vector["ssid"] as? String, name),
                password: try XCTUnwrap(vector["password"] as? String, name))
            // A JSON null reads as nil here: no id.
            XCTAssertEqual(actual, vector["credId"] as? String, name)
        }
    }

    func testDecisionVectors() throws {
        let file = try vectors()
        let defaults = try XCTUnwrap(file["decisionDefaults"] as? [String: Any])
        let cases = try XCTUnwrap(file["decisions"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            let overrides = try XCTUnwrap(vector["input"] as? [String: Any], name)
            let fields = defaults.merging(overrides) { _, override in override }
            let input = ESP32WifiProvisionRules.Input(
                connected: try XCTUnwrap(fields["connected"] as? Bool, name),
                provisionSent: try XCTUnwrap(fields["provisionSent"] as? Bool, name),
                board: fields["board"] as? String,
                wifiConfigured: fields["wifiConfigured"] as? Bool,
                wifiConnected: fields["wifiConnected"] as? Bool,
                wifiRadioParked: fields["wifiRadioParked"] as? Bool,
                wifiCredId: fields["wifiCredId"] as? String,
                expectedCredId: fields["expectedCredId"] as? String,
                refreshIps10Endpoint: fields["refreshIps10Endpoint"] as? Bool ?? false,
                manual: fields["manual"] as? Bool ?? false)
            let decision = ESP32WifiProvisionRules.decision(input)
            XCTAssertEqual(decision.send, vector["send"] as? Bool, name)
            XCTAssertEqual(decision.reason, vector["reason"] as? String, name)
            XCTAssertEqual(decision.legacy, vector["legacy"] as? Bool, name)
        }
    }

    func testCredentialVectors() throws {
        let cases = try XCTUnwrap(try vectors()["credentials"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            let problem = ESP32WifiProvisionRules.credentialsProblem(
                ssid: try XCTUnwrap(vector["ssid"] as? String, name),
                password: try XCTUnwrap(vector["password"] as? String, name))
            // A JSON null reads as nil here: the board could use them.
            XCTAssertEqual(problem, vector["problem"] as? String, name)
        }
    }

    func testAckLedgerVectors() throws {
        let file = try vectors()
        XCTAssertEqual(ESP32WifiProvisionRules.ackTimeoutMs, file["ackTimeoutMs"] as? Int)
        let cases = try XCTUnwrap(file["ackLedger"] as? [[String: Any]])
        XCTAssertFalse(cases.isEmpty)
        for vector in cases {
            let name = vector["name"] as? String ?? "?"
            var ledger = ESP32WifiProvisionRules.AckLedger()
            var answered: [Bool] = []
            var expected: [Bool] = []
            for event in try XCTUnwrap(vector["events"] as? [[String: Any]], name) {
                if let at = event["write"] as? Int {
                    ledger = ESP32WifiProvisionRules.ackWritten(
                        ledger, now: at, credId: event["credId"] as? String ?? "")
                } else {
                    let answer = ESP32WifiProvisionRules.ackAnswered(
                        ledger, ackCredId: event["ackCredId"] as? String ?? "")
                    answered.append(answer.latest)
                    expected.append(try XCTUnwrap(event["ack"] as? Bool, name))
                    ledger = answer.ledger
                }
            }
            XCTAssertEqual(answered, expected, name)
            let end = try XCTUnwrap(vector["ledger"] as? [String: Any], name)
            XCTAssertEqual(ledger, ESP32WifiProvisionRules.AckLedger(
                owed: try XCTUnwrap(end["owed"] as? Int, name),
                lastWriteAt: try XCTUnwrap(end["lastWriteAt"] as? Int, name),
                latestCredId: try XCTUnwrap(end["latestCredId"] as? String, name)), name)
        }
    }

    func testProvisionCarriesTheIdOfItsOwnToken() throws {
        let cases = try XCTUnwrap(try vectors()["credIds"] as? [[String: Any]])
        let vector = try XCTUnwrap(cases.first)
        let token = try XCTUnwrap(vector["token"] as? String)
        let ssid = try XCTUnwrap(vector["ssid"] as? String)
        let password = try XCTUnwrap(vector["password"] as? String)
        let msg = ESP32Serial.wifiProvisionMessage(
            ssid: ssid, password: password, bridgeIP: "192.168.1.50", bridgePort: 9120, authToken: token)
        XCTAssertEqual(msg["type"] as? String, "wifi_provision")
        XCTAssertEqual(msg["authToken"] as? String, token)
        XCTAssertEqual(msg["credId"] as? String, vector["credId"] as? String)
        // No token, no id: the board clears its own on receipt.
        let tokenless = ESP32Serial.wifiProvisionMessage(
            ssid: ssid, password: password, bridgeIP: "192.168.1.50", bridgePort: 9120, authToken: "")
        XCTAssertNil(tokenless["credId"])
    }

    func testInputIsTheConnectionsOwnReport() {
        let credId = "4fbb066b2801b4ae"
        let parked = ESP32Serial.DeviceInfo(
            board: "t_embed", wifiConfigured: false, wifiConnected: false,
            wifiRadioParked: true, wifiCredId: credId)
        let input = ESP32Serial.wifiProvisionInput(
            connected: true, provisionSent: false, deviceInfo: parked, expectedCredId: credId)
        XCTAssertFalse(input.refreshIps10Endpoint)
        XCTAssertEqual(ESP32WifiProvisionRules.decision(input).reason, "credentials-match")
        // WiFi credentials are not written to a tty no board has identified on.
        let unidentified = ESP32Serial.wifiProvisionInput(
            connected: true, provisionSent: false, deviceInfo: nil, expectedCredId: credId)
        XCTAssertEqual(ESP32WifiProvisionRules.decision(unidentified).reason, "unidentified")
    }

    func testLegacyDecisionsKeepThisDaemonsFingerprintRule() {
        typealias Decision = ESP32WifiProvisionRules.Decision
        // Old firmware or no id to offer: once per port per credential set,
        // whatever the board says about saved credentials.
        let legacyConfigured = Decision(send: false, reason: "legacy-configured", legacy: true)
        XCTAssertTrue(ESP32Serial.shouldSendWifiProvision(legacyConfigured, legacyFingerprintSent: false))
        XCTAssertFalse(ESP32Serial.shouldSendWifiProvision(legacyConfigured, legacyFingerprintSent: true))
        // An id decision stands on its own.
        let match = Decision(send: false, reason: "credentials-match", legacy: false)
        XCTAssertFalse(ESP32Serial.shouldSendWifiProvision(match, legacyFingerprintSent: false))
        let differ = Decision(send: true, reason: "credentials-differ", legacy: false)
        XCTAssertTrue(ESP32Serial.shouldSendWifiProvision(differ, legacyFingerprintSent: true))
    }

    func testFanOutComparesEachBoardAgainstTheMessagesOwnId() throws {
        let msg = ESP32Serial.wifiProvisionMessage(
            ssid: "DeskNet", password: "fanout-pw", bridgeIP: "192.168.1.50", bridgePort: 9120,
            authToken: "fanout-token")
        let credId = try XCTUnwrap(msg["credId"] as? String)
        func view(_ port: String, _ info: ESP32Serial.DeviceInfo?) -> ESP32Serial.ProvisionView {
            ESP32Serial.ProvisionView(port: port, connected: true, provisionSent: false, deviceInfo: info)
        }
        func parked(credId: String?) -> ESP32Serial.DeviceInfo {
            ESP32Serial.DeviceInfo(
                board: "t_embed", wifiConfigured: false, wifiConnected: false,
                wifiRadioParked: true, wifiCredId: credId)
        }
        let views = [
            view("/dev/cu.holds", parked(credId: credId)),
            view("/dev/cu.differs", parked(credId: "0000000000000000")),
            view("/dev/cu.unidentified", nil),
            view("/dev/cu.old-firmware", parked(credId: nil)),
        ]
        XCTAssertEqual(ESP32Serial.wifiProvisionTargets(views, msg: msg, fingerprintsByPort: [:]), [1, 3])
        // Old firmware keeps this daemon's rule: once per port per credential set.
        let sent = ["/dev/cu.old-firmware": ESP32Serial.provisionFingerprint(for: msg)]
        XCTAssertEqual(ESP32Serial.wifiProvisionTargets(views, msg: msg, fingerprintsByPort: sent), [1])
    }

    func testLegacyRearmSkipsFirmwareThatReportsACredentialId() {
        let old = ESP32Serial.DeviceInfo(board: "86box", wifiConfigured: true, wifiConnected: false)
        XCTAssertTrue(ESP32Serial.shouldSendLegacyRearm(acked: false, deviceInfo: old))
        XCTAssertFalse(ESP32Serial.shouldSendLegacyRearm(acked: true, deviceInfo: old))
        // Firmware that reports the id understands auth_provision; its silence
        // is a lost frame, and a full provision would wake its parked radio.
        let knowsId = ESP32Serial.DeviceInfo(
            board: "86box", wifiConfigured: false, wifiConnected: false, wifiRadioParked: true, wifiCredId: "")
        XCTAssertFalse(ESP32Serial.shouldSendLegacyRearm(acked: false, deviceInfo: knowsId))
        XCTAssertFalse(ESP32Serial.shouldSendLegacyRearm(acked: false, deviceInfo: nil))
        let unnamed = ESP32Serial.DeviceInfo(board: "", wifiConfigured: true, wifiConnected: false)
        XCTAssertFalse(ESP32Serial.shouldSendLegacyRearm(acked: false, deviceInfo: unnamed))
    }

    func testAnEmptyBoardNameIsNotAnIdentification() {
        // The token and the legacy re-arm go only to a board that named itself,
        // as in the Node daemon and the generated provisioning decision.
        XCTAssertFalse(ESP32Serial.hasIdentified(nil))
        XCTAssertFalse(ESP32Serial.hasIdentified(
            ESP32Serial.DeviceInfo(board: "", wifiConfigured: false, wifiConnected: false)))
        XCTAssertFalse(ESP32Serial.hasIdentified(
            ESP32Serial.DeviceInfo(board: nil, wifiConfigured: false, wifiConnected: false)))
        XCTAssertTrue(ESP32Serial.hasIdentified(
            ESP32Serial.DeviceInfo(board: "86box", wifiConfigured: false, wifiConnected: false)))
    }
}
#endif
