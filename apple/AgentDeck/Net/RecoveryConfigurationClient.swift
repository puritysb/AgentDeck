#if os(macOS)
import Foundation

/// Local operator action; a received path never creates a native sandbox grant.
enum RecoveryConfigurationClient {
    static func configure(connectionURL: String, path: String?) async throws {
        guard let url = ZaiConfigurationClient.localURL(connectionURL, path: "/configuration/recovery") else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 8)
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["enabled": path != nil, "path": path as Any? ?? NSNull()])
        let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForResource = 8
        let session = URLSession(configuration: config, delegate: RecoveryNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (_, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.cannotWriteToFile) }
    }
}
private final class RecoveryNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
#endif
