// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/esp32-wifi-provision.ts
// Regenerate: pnpm generate-esp32-wifi-provision-rules (drift gated by shared/src/__tests__/esp32-wifi-provision-sync.test.ts)
#if os(macOS)
import CryptoKit
import Foundation

/// Whether a serial-attached ESP32 needs a `wifi_provision`, and the
/// credential id that lets a board with its radio parked say it already holds
/// these credentials (`device_info.wifiCredId`). Behaviour is pinned by
/// `shared/esp32-wifi-provision-vectors.json` (`ESP32WifiProvisionRulesTests`).
enum ESP32WifiProvisionRules {
    static let credIdDomain = "agentdeck-wifi-cred-v1"
    static let credIdHexLength = 16
    /// The board whose radio-up provision the Node daemon re-sends.
    static let endpointRefreshBoard = "ips_10"

    /// The id a provision carrying these credentials and this token sends: the
    /// first `credIdHexLength` lowercase hex characters of HMAC-SHA256, keyed
    /// by the token, over `domain NUL ssid NUL password` (all UTF-8). nil when
    /// any input is empty — such a provision carries no id.
    static func credId(authToken: String, ssid: String, password: String) -> String? {
        guard !authToken.isEmpty, !ssid.isEmpty, !password.isEmpty else { return nil }
        let message = credIdDomain + "\u{0}" + ssid + "\u{0}" + password
        let mac = HMAC<SHA256>.authenticationCode(
            for: Data(message.utf8), using: SymmetricKey(data: Data(authToken.utf8)))
        let hex = mac.map { String(format: "%02x", $0) }.joined()
        return String(hex.prefix(credIdHexLength))
    }

    /// One serial connection's latest `device_info`, and the id of the
    /// provision this daemon would send it.
    struct Input: Equatable {
        var connected: Bool
        var provisionSent: Bool
        var board: String?
        var wifiConfigured: Bool?
        var wifiConnected: Bool?
        var wifiRadioParked: Bool?
        /// "" = firmware that knows the field and stores no id; nil = older firmware.
        var wifiCredId: String?
        var expectedCredId: String?
        var refreshIps10Endpoint: Bool
        /// The operator asked for this provision just now (`POST /esp32/wifi`):
        /// a provision already sent on this connection does not stop it, old
        /// firmware gets one send per request, and it never makes the endpoint
        /// refresh (a joined board is left alone).
        var manual: Bool = false
    }

    struct Decision: Equatable {
        let send: Bool
        let reason: String
        /// Decided by the rule that predates the id: the caller may keep its own there.
        let legacy: Bool
    }

    static func decision(_ input: Input) -> Decision {
        if !input.connected { return Decision(send: false, reason: "not-connected", legacy: false) }
        guard let board = input.board, !board.isEmpty else {
            return Decision(send: false, reason: "unidentified", legacy: false)
        }
        if input.provisionSent, !input.manual {
            return Decision(send: false, reason: "already-sent", legacy: false)
        }
        if input.refreshIps10Endpoint, !input.manual, board == endpointRefreshBoard,
           input.wifiConnected == true, input.wifiRadioParked != true {
            return Decision(send: true, reason: "endpoint-refresh", legacy: false)
        }
        if input.wifiConnected == true { return Decision(send: false, reason: "wifi-connected", legacy: false) }
        if let reported = input.wifiCredId, let expected = input.expectedCredId, !expected.isEmpty {
            return reported == expected
                ? Decision(send: false, reason: "credentials-match", legacy: false)
                : Decision(send: true, reason: "credentials-differ", legacy: false)
        }
        if input.manual { return Decision(send: true, reason: "operator-request", legacy: false) }
        return input.wifiConfigured == true
            ? Decision(send: false, reason: "legacy-configured", legacy: true)
            : Decision(send: true, reason: "legacy-unconfigured", legacy: true)
    }

    /// How long after the latest provision a board's answer to it may still
    /// come; an answer owed for longer was lost.
    static let ackTimeoutMs = 30000

    /// The answers a serial connection is owed. Current firmware echoes the
    /// provision's `credId` in its `wifi_provision_ack`; older firmware names
    /// none, and the board takes provisions one at a time, in order.
    struct AckLedger: Equatable, Sendable {
        var owed = 0
        /// When the latest provision was written (epoch ms); 0 = none.
        var lastWriteAt = 0
        /// The latest provision's `credId`; "" = it carried none.
        var latestCredId = ""
    }

    /// The ledger after writing a provision carrying `credId` at `now` (epoch ms).
    static func ackWritten(_ ledger: AckLedger, now: Int, credId: String = "") -> AckLedger {
        let lost = ledger.owed > 0 && now - ledger.lastWriteAt > ackTimeoutMs
        return AckLedger(owed: (lost ? 0 : ledger.owed) + 1, lastWriteAt: now, latestCredId: credId)
    }

    /// An ack arrived, naming `ackCredId` ("" = none): whether it answers the
    /// latest provision, and the ledger after it. When both carry an id, the
    /// ids decide; otherwise the count does, and an ack nothing was owed for is
    /// taken as the latest answer.
    static func ackAnswered(_ ledger: AckLedger, ackCredId: String = "") -> (latest: Bool, ledger: AckLedger) {
        var next = ledger
        if !ledger.latestCredId.isEmpty && !ackCredId.isEmpty {
            if ackCredId == ledger.latestCredId {
                next.owed = 0
                return (true, next)
            }
            if ledger.owed > 1 { next.owed = ledger.owed - 1 }
            return (false, next)
        }
        if ledger.owed > 1 {
            next.owed = ledger.owed - 1
            return (false, next)
        }
        next.owed = 0
        return (true, next)
    }

    /// 802.11 caps an SSID at this many octets.
    static let ssidMaxBytes = 32
    /// A WPA passphrase is `passwordMinBytes`...`passphraseMaxBytes` bytes;
    /// exactly `pskHexLength` hex digits is the raw key.
    static let passwordMinBytes = 8
    static let passphraseMaxBytes = 63
    static let pskHexLength = 64

    /// Why a board could not use these credentials (the word `POST /esp32/wifi`
    /// answers 400 with), or nil when it could. Lengths are UTF-8 bytes.
    static func credentialsProblem(ssid: String, password: String) -> String? {
        if ssid.isEmpty { return "ssid-missing" }
        if hasControlCharacter(ssid) || hasControlCharacter(password) { return "control-character" }
        if ssid.utf8.count > ssidMaxBytes { return "ssid-too-long" }
        let passwordBytes = password.utf8.count
        if passwordBytes < passwordMinBytes { return "password-too-short" }
        if passwordBytes > passphraseMaxBytes, !(passwordBytes == pskHexLength && isHexKey(password)) {
            return "password-too-long"
        }
        return nil
    }

    /// C0 controls and DEL.
    private static func hasControlCharacter(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
    }

    private static func isHexKey(_ text: String) -> Bool {
        !text.isEmpty && text.unicodeScalars.allSatisfy {
            ("0"..."9").contains($0) || ("a"..."f").contains($0) || ("A"..."F").contains($0)
        }
    }
}
#endif
