import Foundation

private final class ZaiConfigurationNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

struct ZaiConfiguration: Decodable, Sendable {
    let configured: Bool
    let editable: Bool
    let authFailed: Bool
    let source: String
    let verified: Bool?
}

enum ZaiConfigurationClient {
    static func localURL(_ raw: String, path: String) -> URL? {
        guard var c = URLComponents(string: raw), ["ws", "wss"].contains(c.scheme ?? ""),
              ["localhost", "127.0.0.1", "::1", "[::1]"].contains(c.host ?? "") else { return nil }
        c.scheme = c.scheme == "wss" ? "https" : "http"
        c.path = path; c.query = nil; c.fragment = nil; c.user = nil; c.password = nil
        return c.url
    }
    static func request(connectionURL: String, method: String = "GET", key: String? = nil) async throws -> ZaiConfiguration {
        guard let healthURL = localURL(connectionURL, path: "/health"),
              let target = localURL(connectionURL, path: "/integrations/zai") else {
            throw NSError(domain: "ZaiConfiguration", code: 1, userInfo: [NSLocalizedDescriptionKey:
                "Edit credentials on the Mac hosting AgentDeck."])
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12; config.timeoutIntervalForResource = 12
        config.urlCache = nil; config.httpCookieStorage = nil
        let session = URLSession(configuration: config, delegate: ZaiConfigurationNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (health, response) = try await session.data(from: healthURL)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try JSONSerialization.jsonObject(with: health) as? [String: Any],
              json["isSwift"] as? Bool == false,
              let token = json["pairingToken"] as? String, !token.isEmpty else {
            throw NSError(domain: "ZaiConfiguration", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not authenticate with the local daemon."])
        }
        var request = URLRequest(url: target, timeoutInterval: 12)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let key {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["apiKey": key])
        }
        let (data, result) = try await session.data(for: request)
        guard (result as? HTTPURLResponse)?.statusCode == 200 else {
            let code = (result as? HTTPURLResponse)?.statusCode ?? 0
            let message = code == 404 ? "This connection does not support editing credentials."
                : code == 409 ? "This key is managed by the daemon environment."
                : "Could not update z.ai credentials."
            throw NSError(domain: "ZaiConfiguration", code: code, userInfo: [NSLocalizedDescriptionKey: message])
        }
        return try JSONDecoder().decode(ZaiConfiguration.self, from: data)
    }
}
