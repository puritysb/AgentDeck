#if os(macOS)
import Foundation

private final class PixooConfigurationNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
struct PixooConfigurationResponse: Decodable, Sendable {
    var configuration: PixooConfiguration
    var revision: String
}
enum PixooConfigurationClient {
    static func request(connectionURL: String, configuration: PixooConfiguration? = nil, revision: String? = nil) async throws -> PixooConfigurationResponse {
        guard let health = ZaiConfigurationClient.localURL(connectionURL, path: "/health"),
              let target = ZaiConfigurationClient.localURL(connectionURL, path: "/configuration/pixoo") else {
            throw NSError(domain: "PixooConfiguration", code: 1, userInfo: [NSLocalizedDescriptionKey: "Connect to AgentDeck on this Mac to edit displays."])
        }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 12; config.timeoutIntervalForResource = 12
        config.urlCache = nil; config.httpCookieStorage = nil
        let session = URLSession(configuration: config, delegate: PixooConfigurationNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (data, response) = try await session.data(from: health)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["pairingToken"] as? String, !token.isEmpty else {
            throw NSError(domain: "PixooConfiguration", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not connect to AgentDeck."])
        }
        var request = URLRequest(url: target, timeoutInterval: 12)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let configuration {
            struct Update: Encodable { var configuration: PixooConfiguration; var revision: String? }
            request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try DaemonConfigurationRules.data(Update(configuration: configuration, revision: revision))
        }
        let (result, received) = try await session.data(for: request)
        let status = (received as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let message = status == 409 ? "Display settings changed. Reload and try again."
                : "Could not save display settings. Reconnect and try again."
            throw NSError(domain: "PixooConfiguration", code: status, userInfo: [NSLocalizedDescriptionKey: message])
        }
        return try JSONDecoder().decode(PixooConfigurationResponse.self, from: result)
    }
}
#endif
