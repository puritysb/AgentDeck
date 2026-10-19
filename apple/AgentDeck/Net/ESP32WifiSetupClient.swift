#if os(macOS)
// ESP32WifiSetupClient.swift — the Wi-Fi sheet's side of `GET/POST /esp32/wifi`
// on whichever daemon holds the port, the in-process one or the one this app
// is a client of. The daemon saves the credentials and sends them to its serial
// boards; the sheet never opens a serial port itself, since the daemon owns the
// ports and two readers on one tty steal each other's bytes.

import Foundation

private final class ESP32WifiSetupNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

/// `GET /esp32/wifi` (shared/esp32-wifi-setup-vectors.json pins the shape).
struct ESP32WifiStatus: Decodable, Sendable, Equatable {
    let configured: Bool
    let ssid: String
    let autoProvision: Bool
    let serial: Bool
    let boards: [Board]

    struct Board: Decodable, Sendable, Equatable, Identifiable {
        let port: String
        let board: String
        let wifiConnected: Bool?
        let wifiRadioParked: Bool?
        let holdsCredentials: Bool?
        let provisionedAt: Int64
        let ack: Ack?
        var id: String { port }
    }

    struct Ack: Decodable, Sendable, Equatable {
        let success: Bool
        /// true: the board joined; false: it saved the credentials for when it
        /// leaves USB; nil: its firmware does not say, so `ip` may be stale.
        let joined: Bool?
        let ip: String
        let error: String
        let at: Int64
    }
}

/// `POST /esp32/wifi`.
struct ESP32WifiApplyResult: Decodable, Sendable, Equatable {
    let autoProvision: Bool
    let boards: [Outcome]

    struct Outcome: Decodable, Sendable, Equatable, Identifiable {
        let port: String
        let board: String
        let sent: Bool
        let reason: String
        var id: String { port }
    }
}

enum ESP32WifiSetupClient {
    struct Failure: LocalizedError, Equatable {
        let message: String
        var errorDescription: String? { message }
    }

    static let unreachable = "Couldn't reach AgentDeck's daemon on this Mac."
    static let notAuthenticated = "Couldn't authenticate with AgentDeck's daemon on this Mac."

    static func status(port: Int) async throws -> ESP32WifiStatus {
        let data = try await call(port: port, method: "GET", body: nil)
        return try decode(ESP32WifiStatus.self, from: data)
    }

    static func apply(port: Int, ssid: String, password: String, autoProvision: Bool) async throws -> ESP32WifiApplyResult {
        let body = try JSONSerialization.data(withJSONObject: [
            "ssid": ssid, "password": password, "autoProvision": autoProvision,
        ] as [String: Any])
        let data = try await call(port: port, method: "POST", body: body)
        return try decode(ESP32WifiApplyResult.self, from: data)
    }

    /// The sentence for an `/esp32/wifi` refusal.
    static func message(status: Int, error: String?) -> String {
        switch status {
        case 400: return error.flatMap(credentialsMessage) ?? "The daemon could not use these credentials."
        case 401, 403: return notAuthenticated
        case 404: return "This connection does not support Wi-Fi setup."
        case 500 where error == "save-failed": return "The daemon could not save the credentials."
        default: return "Wi-Fi setup failed (HTTP \(status))."
        }
    }

    /// The sentence for a word the shared credential rule
    /// (`ESP32WifiProvisionRules.credentialsProblem`) or the route answers.
    static func credentialsMessage(_ word: String) -> String? {
        switch word {
        case "ssid-missing": return "Enter the network name."
        case "ssid-too-long": return "A network name is at most 32 bytes."
        case "password-too-short": return "A Wi-Fi password is at least 8 characters."
        case "password-too-long":
            return "A Wi-Fi password is at most 63 characters (fewer with accented or non-Latin letters), or a 64-digit hex key."
        case "control-character": return "Remove the control character, such as a line break."
        case "invalid-body": return "The daemon could not read the request."
        default: return nil
        }
    }

    private static func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw Failure(message: "The daemon's answer could not be read.")
        }
    }

    /// The token comes from the target daemon's own loopback `/health`, as
    /// ZaiConfigurationClient does: it is the token that daemon checks, which
    /// the app's copy may not be yet right after a handover.
    private static func call(port: Int, method: String, body: Data?) async throws -> Data {
        guard (1...65_535).contains(port),
              let healthURL = URL(string: "http://127.0.0.1:\(port)/health"),
              let target = URL(string: "http://127.0.0.1:\(port)/esp32/wifi") else {
            throw Failure(message: unreachable)
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 8
        config.timeoutIntervalForResource = 8
        config.urlCache = nil
        config.httpCookieStorage = nil
        let session = URLSession(configuration: config, delegate: ESP32WifiSetupNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }

        let health: (Data, URLResponse)
        do {
            health = try await session.data(from: healthURL)
        } catch {
            throw Failure(message: unreachable)
        }
        guard (health.1 as? HTTPURLResponse)?.statusCode == 200,
              let json = try? JSONSerialization.jsonObject(with: health.0) as? [String: Any],
              let token = json["pairingToken"] as? String, !token.isEmpty else {
            throw Failure(message: notAuthenticated)
        }

        var request = URLRequest(url: target, timeoutInterval: 8)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let answer: (Data, URLResponse)
        do {
            answer = try await session.data(for: request)
        } catch {
            throw Failure(message: unreachable)
        }
        let status = (answer.1 as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let word = (try? JSONSerialization.jsonObject(with: answer.0) as? [String: Any])?["error"] as? String
            throw Failure(message: message(status: status, error: word))
        }
        return answer.0
    }
}

/// What the Wi-Fi sheet says about one board.
enum ESP32WifiBoardLine: Equatable {
    case ok(String)
    case waiting(String)
    case failed(String)
    case neutral(String)

    var text: String {
        switch self {
        case .ok(let t), .waiting(let t), .failed(let t), .neutral(let t): return t
        }
    }

    /// `outcome` is this sheet's own send to the board, when it made one.
    static func describe(_ board: ESP32WifiStatus.Board, outcome: ESP32WifiApplyResult.Outcome?) -> ESP32WifiBoardLine {
        if board.provisionedAt > 0 {
            if let ack = board.ack { return describe(ack) }
            return .waiting("Credentials sent — waiting for the board's answer")
        }
        if let outcome, !outcome.sent {
            switch outcome.reason {
            case "wifi-connected": return .ok("Already on Wi-Fi, left as it is")
            case "credentials-match": return .ok("Already holds these credentials")
            case "unidentified": return .neutral("Not identified yet, nothing sent")
            default: return .neutral("Nothing sent")
            }
        }
        if board.wifiConnected == true { return .ok("On Wi-Fi") }
        if board.holdsCredentials == true { return .ok("Holds the saved credentials") }
        if board.board.isEmpty { return .neutral("Identifying…") }
        if board.holdsCredentials == false { return .neutral("Holds other credentials") }
        return .neutral("Ready for credentials")
    }

    /// A board's answer. Only a board that says it joined is called joined: a
    /// serial-primary board saves the credentials and stays off Wi-Fi while
    /// it is on USB, and older firmware does not say which it did.
    private static func describe(_ ack: ESP32WifiStatus.Ack) -> ESP32WifiBoardLine {
        guard ack.success else {
            if ack.error == "credentials not saved" { return .failed("The board couldn't save the credentials") }
            return .failed("Couldn't join Wi-Fi: \(ack.error.isEmpty ? "no reason given" : ack.error)")
        }
        switch ack.joined {
        case true?: return .ok(ack.ip.isEmpty ? "Joined Wi-Fi" : "Joined Wi-Fi at \(ack.ip)")
        case false?: return .ok("Saved — the board switches to Wi-Fi when it's off USB")
        case nil: return .ok("The board accepted the credentials")
        }
    }
}

#endif
