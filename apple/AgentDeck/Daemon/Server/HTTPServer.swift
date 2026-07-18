#if os(macOS)
// HTTPServer.swift — route table + request handling for /health, /status,
// /shutdown, hooks. Network.framework, no external dependencies.
//
// IMPORTANT — the daemon does NOT run this type's listener.
//
// `DaemonServer` creates an `HTTPServer`, registers routes on it, and hands it
// to `wsServer.setHTTPHandler(_:)`. `WebSocketServer` owns the one and only
// listener on the daemon port; when a connection turns out to be plain HTTP it
// calls `httpHandler.handle(request:on:)` here. Nothing calls `start(port:)`
// except tests, so `start`/`stop`/`handleConnection` and the `NWListener` they
// manage are unused in the shipping daemon.
//
// Say it plainly because it has already misled once: during the 2026-07-18
// investigation the `queue: .main` on that listener looked like the reason
// `/health` went unanswered while WebSocket traffic kept flowing. It was not —
// that code never ran. The real cause was that HTTP *handlers* dispatch into
// `DaemonServer`, which was `@MainActor`, so requests were accepted on
// WebSocketServer's `ioQueue` and then starved waiting for the main actor.
// The fix was moving the daemon to `@DaemonActor`. If you are debugging
// listener behaviour on the daemon port, read `WebSocketServer`, not this file.

import Foundation
import Network

actor HTTPServer {
    /// Accept and per-connection I/O for the (currently test-only) listener.
    /// Not `.main`: this daemon is hosted in a GUI app, so anything pinned to
    /// the main queue competes with SwiftUI rendering. `WebSocketServer` — the
    /// listener the daemon actually runs — keeps its own `ioQueue` for that
    /// reason, and this matches it so the two cannot drift again.
    private static let ioQueue = DispatchQueue(label: "dev.agentdeck.http.io", qos: .userInitiated)

    private var listener: NWListener?
    private(set) var boundPort: UInt16?
    private var routes: [(method: String, path: String, handler: @Sendable (HTTPRequest) async -> HTTPResponse)] = []
    private var streamRoutes: [(method: String, path: String, handler: @Sendable (HTTPRequest, StreamConnection) async -> Void)] = []

    struct HTTPRequest: Sendable {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data?
        let queryParams: [String: String]
        let remoteIP: String
    }

    struct HTTPResponse: Sendable {
        let status: Int
        let headers: [String: String]
        let body: Data?

        static func json(_ obj: Any, status: Int = 200) -> HTTPResponse {
            let data = try? JSONSerialization.data(withJSONObject: obj)
            return HTTPResponse(
                status: status,
                headers: ["Content-Type": "application/json"],
                body: data
            )
        }

        static func text(_ str: String, status: Int = 200) -> HTTPResponse {
            HTTPResponse(
                status: status,
                headers: ["Content-Type": "text/plain"],
                body: Data(str.utf8)
            )
        }

        static let notFound = HTTPResponse(status: 404, headers: [:], body: Data("Not Found".utf8))
    }

    final class StreamConnection: @unchecked Sendable {
        fileprivate let raw: NWConnection

        fileprivate init(raw: NWConnection) {
            self.raw = raw
        }

        func send(_ data: Data, completion: @escaping @Sendable (Bool) -> Void) {
            raw.send(content: data, completion: .contentProcessed { error in
                completion(error == nil)
            })
        }

        func cancel() {
            raw.cancel()
        }
    }

    // MARK: - Route Registration

    func get(_ path: String, handler: @escaping @Sendable (HTTPRequest) async -> HTTPResponse) {
        routes.append((method: "GET", path: path, handler: handler))
    }

    func post(_ path: String, handler: @escaping @Sendable (HTTPRequest) async -> HTTPResponse) {
        routes.append((method: "POST", path: path, handler: handler))
    }

    func stream(_ path: String, handler: @escaping @Sendable (HTTPRequest, StreamConnection) async -> Void) {
        streamRoutes.append((method: "GET", path: path, handler: handler))
    }

    // MARK: - Lifecycle

    func start(port: UInt16) throws {
        let params = NWParameters.tcp
        // SO_REUSEADDR — rebind after TIME_WAIT/crash. Matches
        // `WebSocketServer`, which has set it since 06a932c1, and matches what
        // `SessionRegistry.isPortBindable`'s probe socket assumes. Consistency
        // only: this listener does not run in the daemon.
        params.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "HTTPServer", code: -1, userInfo: [NSLocalizedDescriptionKey: "Invalid port \(port)"])
        }
        let listener = try NWListener(using: params, on: nwPort)
        self.listener = listener
        self.boundPort = port

        listener.newConnectionHandler = { [weak self] conn in
            Task { await self?.handleConnection(conn) }
        }

        listener.stateUpdateHandler = { state in
            if case .ready = state {
                DaemonLogger.shared.debug("HTTP", "Server listening on port \(port)")
            }
        }

        listener.start(queue: Self.ioQueue)
    }

    func stop() {
        listener?.cancel()
    }

    // MARK: - Connection Handling

    private func handleConnection(_ conn: NWConnection) {
        conn.start(queue: Self.ioQueue)
        Self.receiveFullRequest(on: conn) { [weak self] data in
            guard let data, let self else {
                conn.cancel()
                return
            }
            Task {
                let request = Self.parseHTTPRequest(data, remoteIP: conn.endpoint.debugDescription)
                let handled = await self.handle(request, on: conn)
                if !handled {
                    conn.cancel()
                }
            }
        }
    }

    /// Read one full HTTP request (headers + body) by walking `receive`
    /// until the parsed Content-Length is satisfied. Necessary because
    /// `receive(maximumLength: 65536)` returns only one chunk per call —
    /// Codex's OTLP/HTTP exporter routinely batches ~65 KB of spans, and
    /// a single-chunk read truncated the body so JSON parse failed for
    /// every batch. 4 MB cap is a defensive ceiling against runaway
    /// requests (no legitimate dashboard payload is larger).
    static func receiveFullRequest(
        on conn: NWConnection,
        accumulated: Data = Data(),
        completion: @escaping @Sendable (Data?) -> Void
    ) {
        if completeRequestIfReady(accumulated, isComplete: false, completion: completion) {
            return
        }

        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { chunk, _, isComplete, error in
            if error != nil {
                completion(nil)
                return
            }
            var data = accumulated
            if let chunk { data.append(chunk) }

            if completeRequestIfReady(data, isComplete: isComplete, completion: completion) {
                return
            }

            receiveFullRequest(on: conn, accumulated: data, completion: completion)
        }
    }

    /// True when the (possibly partial) request buffer's request line targets
    /// POST /esp32/ota. Only the first line is examined; a buffer too short
    /// to contain the full request line yet returns false, which is safe —
    /// the default cap is far above any request-line length, so the check
    /// re-runs with more data before the cap can trigger.
    private static func requestLineIsEsp32Ota(_ data: Data) -> Bool {
        let prefix = data.prefix(64)
        guard let line = String(data: prefix, encoding: .utf8) else { return false }
        return line.hasPrefix("POST /esp32/ota ") || line.hasPrefix("POST /esp32/ota/")
    }

    private static func completeRequestIfReady(
        _ data: Data,
        isComplete: Bool,
        completion: @escaping @Sendable (Data?) -> Void
    ) -> Bool {
        if data.isEmpty {
            if isComplete {
                completion(nil)
                return true
            } else {
                return false
            }
        }

        // Cap at 4 MB to bound the listener's per-connection memory.
        // Exception: /esp32/ota carries a base64-inlined firmware image
        // (sandbox blocks path reads) — a 16 MB-class board firmware is
        // ~8 MB, ~10.7 MB as base64, so that one route gets a 24 MB cap.
        let cap = requestLineIsEsp32Ota(data) ? 24 * 1024 * 1024 : 4 * 1024 * 1024
        if data.count >= cap {
            completion(data)
            return true
        }

        // Find end of headers; if not seen yet, keep reading.
        guard let headerRange = data.range(of: Data("\r\n\r\n".utf8)) else {
            if isComplete {
                completion(data)
                return true
            } else {
                return false
            }
        }

        // Parse Content-Length from the headers slice.
        let headerText = String(data: data.subdata(in: 0..<headerRange.lowerBound), encoding: .utf8) ?? ""
        var expectedBody = 0
        for line in headerText.components(separatedBy: "\r\n") {
            if line.lowercased().hasPrefix("content-length:") {
                let parts = line.split(separator: ":", maxSplits: 1)
                if parts.count == 2,
                   let n = Int(parts[1].trimmingCharacters(in: .whitespaces)) {
                    expectedBody = n
                }
                break
            }
        }

        let bodyBytesSoFar = data.count - headerRange.upperBound
        if bodyBytesSoFar >= expectedBody {
            completion(data)
            return true
        } else if isComplete {
            DaemonLogger.shared.debug(
                "HTTP",
                "Incomplete request body: expected=\(expectedBody) received=\(bodyBytesSoFar)"
            )
            completion(nil)
            return true
        } else {
            return false
        }
    }

    /// Route a request, including long-lived stream routes. Returns true if handled.
    func handle(_ request: HTTPRequest, on conn: NWConnection) async -> Bool {
        for route in streamRoutes where route.method == request.method && route.path == request.path {
            await route.handler(request, StreamConnection(raw: conn))
            return true
        }

        let response = await route(request)
        let raw = Self.formatHTTPResponse(response)
        conn.send(content: raw, completion: .contentProcessed({ _ in
            conn.cancel()
        }))
        return true
    }

    /// Route a request to matching handler (used by WebSocketServer for HTTP delegation).
    /// Supports both exact match and prefix match (paths ending with "*").
    func route(_ request: HTTPRequest) async -> HTTPResponse {
        // Trailing-slash insensitive: some clients append a trailing slash to
        // otherwise-exact paths (e.g. `/api/setup/`). Normalizing here lets an
        // exact-only route still match instead of 404ing those requests.
        var normalizedPath = request.path
        while normalizedPath.count > 1 && normalizedPath.hasSuffix("/") {
            normalizedPath.removeLast()
        }
        // Exact match first
        for route in routes {
            if route.method == request.method && (route.path == request.path || route.path == normalizedPath) {
                return await route.handler(request)
            }
        }
        // Prefix match (e.g., "/hooks/*" matches "/hooks/PreToolUse")
        for route in routes {
            if route.method == request.method && route.path.hasSuffix("*") {
                let prefix = String(route.path.dropLast()) // remove "*"
                if request.path.hasPrefix(prefix) {
                    return await route.handler(request)
                }
            }
        }
        return .notFound
    }

    // MARK: - HTTP Parsing (static — used by WebSocketServer for unified handling)

    static func parseHTTPRequest(_ data: Data, remoteIP: String) -> HTTPRequest {
        let text = String(data: data, encoding: .utf8) ?? ""
        let separator = "\r\n"
        let lines = text.components(separatedBy: separator)

        guard let requestLine = lines.first else {
            return HTTPRequest(method: "GET", path: "/", headers: [:], body: nil, queryParams: [:], remoteIP: remoteIP)
        }

        let parts = requestLine.split(separator: " ", maxSplits: 2)
        let method = parts.count > 0 ? String(parts[0]) : "GET"
        let fullPath = parts.count > 1 ? String(parts[1]) : "/"

        // Parse path and query params
        let pathComponents = fullPath.split(separator: "?", maxSplits: 1)
        let path = String(pathComponents[0])
        var queryParams: [String: String] = [:]
        if pathComponents.count > 1 {
            for param in pathComponents[1].split(separator: "&") {
                let kv = param.split(separator: "=", maxSplits: 1)
                if kv.count == 2 {
                    queryParams[String(kv[0])] = String(kv[1])
                }
            }
        }

        // Parse headers
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            if line.isEmpty {
                break
            }
            let hParts = line.split(separator: ":", maxSplits: 1)
            if hParts.count == 2 {
                headers[String(hParts[0]).lowercased()] = String(hParts[1]).trimmingCharacters(in: .whitespaces)
            }
        }

        // Body — slice from the raw Data buffer (NOT the string-joined
        // lines) so we preserve byte-fidelity even when the body is large
        // enough that String round-trip would corrupt it. Codex's OTLP
        // exporter sends ~65 KB JSON batches that previously failed
        // `JSONSerialization.jsonObject(with:)` because the join step
        // mangled trailing bytes. Header parsing above can stay string-
        // based (text-only, well below pathological sizes).
        let body: Data?
        if let headerTerminator = data.range(of: Data("\r\n\r\n".utf8)) {
            let bodyOffset = headerTerminator.upperBound
            if bodyOffset < data.count {
                body = data.subdata(in: bodyOffset..<data.count)
            } else {
                body = nil
            }
        } else {
            body = nil
        }

        return HTTPRequest(method: method, path: path, headers: headers, body: body, queryParams: queryParams, remoteIP: remoteIP)
    }

    static func formatHTTPResponse(_ response: HTTPResponse) -> Data {
        var header = formatHTTPHeaders(status: response.status, headers: response.headers)
        let bodyData = response.body ?? Data()
        header += "Content-Length: \(bodyData.count)\r\n"
        header += "Connection: close\r\n"
        header += "\r\n"

        var result = Data(header.utf8)
        result.append(bodyData)
        return result
    }

    static func formatHTTPHeaders(status: Int, headers: [String: String]) -> String {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 204: statusText = "No Content"
        case 400: statusText = "Bad Request"
        case 401: statusText = "Unauthorized"
        case 404: statusText = "Not Found"
        case 500: statusText = "Internal Server Error"
        case 501: statusText = "Not Implemented"
        case 503: statusText = "Service Unavailable"
        default: statusText = "Unknown"
        }

        var header = "HTTP/1.1 \(status) \(statusText)\r\n"
        header += "Access-Control-Allow-Origin: *\r\n"
        for (key, value) in headers {
            header += "\(key): \(value)\r\n"
        }
        return header
    }
}
#endif
