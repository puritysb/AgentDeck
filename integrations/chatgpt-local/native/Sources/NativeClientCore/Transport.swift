import Foundation

public struct HTTPReply: Sendable {
    public let status: Int
    public let location: String?
    public let body: Data
    public init(status: Int, location: String? = nil, body: Data = Data()) { self.status = status; self.location = location; self.body = body }
}
public protocol Transport {
    func send(_ request: URLRequest) throws -> HTTPReply
}

/// A fresh ephemeral session per bounded request; no cookies, cache, proxy or redirects.
public struct LocalHTTP: Transport {
    public init() {}
    public func send(_ request: URLRequest) throws -> HTTPReply {
        let operation = Operation()
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = Contract.timeout
        config.timeoutIntervalForResource = Contract.timeout
        let session = URLSession(configuration: config, delegate: operation, delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        session.dataTask(with: request).resume()
        guard operation.done.wait(timeout: .now() + Contract.timeout) == .success else { throw ClientFailure.deadline }
        return try operation.result()
    }
    private final class Operation: NSObject, URLSessionDataDelegate, @unchecked Sendable {
        let done = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var response: HTTPURLResponse?
        var body = Data()
        var failure: ClientFailure?
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
            lock.lock(); defer { lock.unlock() }
            guard let http = response as? HTTPURLResponse else { failure = .invalidResponse; completionHandler(.cancel); return }
            self.response = http
            if response.expectedContentLength > Int64(Contract.bodyLimit) { failure = .oversized; completionHandler(.cancel) }
            else { completionHandler(.allow) }
        }
        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            lock.lock(); defer { lock.unlock() }
            guard body.count + data.count <= Contract.bodyLimit else { failure = .oversized; dataTask.cancel(); return }
            body.append(data)
        }
        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock()
            if error != nil && failure == nil { failure = .unavailable }
            lock.unlock(); done.signal()
        }
        func result() throws -> HTTPReply {
            lock.lock(); defer { lock.unlock() }
            if let failure { throw failure }
            guard let response else { throw ClientFailure.invalidResponse }
            return HTTPReply(status: response.statusCode, location: response.value(forHTTPHeaderField: "Location"), body: body)
        }
    }
}
