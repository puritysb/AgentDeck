#if os(macOS)
import Foundation
import Network
import Security

struct DotHTTPRequest: Sendable {
    let method: String
    let target: String
    let headers: [String: String]
    let body: Data
}
struct DotHTTPResponse: Sendable {
    var status: Int = 200
    var headers: [String: String] = [:]
    var body = Data()
    static func json(_ object: Any, status: Int = 200) -> Self {
        guard JSONSerialization.isValidJSONObject(object), let data = try? JSONSerialization.data(withJSONObject: object) else {
            return Self(status: 500)
        }
        return Self(status: status, headers: ["Content-Type": "application/json"], body: data)
    }
}
enum DotHTTPParse: Sendable {
    case incomplete, invalid, ready(DotHTTPRequest)
}

/// A dedicated public endpoint. It never uses the LAN HTTPServer's route table or pairing token.
@DaemonActor
final class DotHTTPSListener {
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var deadlines: [UUID: Task<Void, Never>] = [:]
    private var epoch = UUID()
    private(set) var state = "Stopped"
    private static let queue = DispatchQueue(label: "agentdeck.dot.https")

    nonisolated static func parse(_ data: Data) -> DotHTTPParse {
        guard data.count <= DotLimits.headerBytes + DotLimits.bodyBytes else { return .invalid }
        guard let split = data.range(of: Data("\r\n\r\n".utf8)) else {
            return data.count > DotLimits.headerBytes ? .invalid : .incomplete
        }
        guard split.lowerBound <= DotLimits.headerBytes,
              let text = String(data: data[..<split.lowerBound], encoding: .utf8) else { return .invalid }
        let lines = text.components(separatedBy: "\r\n")
        let start = (lines.first ?? "").split(separator: " ", omittingEmptySubsequences: false)
        guard start.count == 3, start[2] == "HTTP/1.1", start[1].first == "/", !start[1].contains("#") else { return .invalid }
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":"), line.first != " ", line.first != "\t" else { return .invalid }
            let key = String(line[..<colon]).lowercased()
            guard !key.isEmpty, key.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }), headers[key] == nil else { return .invalid }
            headers[key] = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
        }
        guard headers["host"] != nil, headers["transfer-encoding"] == nil, headers["expect"] == nil else { return .invalid }
        let lengthText = headers["content-length"] ?? "0"
        guard !lengthText.isEmpty, lengthText.allSatisfy({ $0.isASCII && $0.isNumber }), let count = Int(lengthText), count <= DotLimits.bodyBytes else { return .invalid }
        let available = data.count - split.upperBound
        if available < count { return .incomplete }
        guard available == count else { return .invalid } // One request/connection; no pipelining ambiguity.
        return .ready(DotHTTPRequest(method: String(start[0]), target: String(start[1]), headers: headers, body: data[split.upperBound...]))
    }
    private(set) var isReady = false
    func start(identity: SecIdentity, port: UInt16, handler: @escaping @DaemonActor @Sendable (DotHTTPRequest) async -> DotHTTPResponse) throws {
        guard port >= 1024, !(9120...9139).contains(Int(port)) else { throw DotFailure.message("Choose a dedicated HTTPS port outside 9120–9139.") }
        stop()
        let run = epoch
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        guard let nativeIdentity = sec_identity_create(identity) else { throw DotFailure.message("TLS identity is unavailable.") }
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, nativeIdentity)
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        let listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        self.listener = listener; state = "Starting HTTPS"
        listener.stateUpdateHandler = { [weak self] result in
            Task { @DaemonActor in
                guard let self, self.epoch == run else { return }
                switch result {
                case .ready: self.isReady = true; self.state = "HTTPS listening; internet reachability unverified"
                case .failed: self.stop(); self.state = "HTTPS listener failed"
                default: break
                }
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            Task { @DaemonActor in
                guard let self, self.epoch == run, self.connections.count < DotLimits.connections else { connection.cancel(); return }
                let id = UUID(); self.connections[id] = connection
                self.deadlines[id] = Task { @DaemonActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(DotLimits.callbackMs))
                    guard !Task.isCancelled else { return }; self?.finish(id)
                }
                connection.start(queue: Self.queue)
                self.receive(id, buffer: Data(), handler: handler)
            }
        }
        listener.start(queue: Self.queue)
        Task { @DaemonActor [weak self] in
            try? await Task.sleep(for: .milliseconds(DotLimits.callbackMs))
            guard let self, self.epoch == run, self.state == "Starting HTTPS" else { return }
            self.stop(); self.state = "HTTPS startup timed out"
        }
    }
    private func receive(_ id: UUID, buffer: Data, handler: @escaping @DaemonActor @Sendable (DotHTTPRequest) async -> DotHTTPResponse) {
        guard let connection = connections[id] else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: DotLimits.headerBytes + DotLimits.bodyBytes + 1) { [weak self] data, _, complete, error in
            Task { @DaemonActor in
                guard let self, self.connections[id] != nil else { return }
                guard error == nil, let data, !data.isEmpty else { self.finish(id); return }
                var bytes = buffer; bytes.append(data)
                switch Self.parse(bytes) {
                case .incomplete:
                    if complete { self.finish(id) } else { self.receive(id, buffer: bytes, handler: handler) }
                case .invalid: self.send(.init(status: 400), id: id)
                case .ready(let request): self.send(await handler(request), id: id)
                }
            }
        }
    }
    private func send(_ response: DotHTTPResponse, id: UUID) {
        guard let connection = connections[id] else { return }
        let labels = [200: "OK", 202: "Accepted", 302: "Found", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 413: "Content Too Large", 429: "Too Many Requests", 500: "Internal Server Error"]
        var headers = response.headers
        headers["Content-Length"] = String(response.body.count); headers["Connection"] = "close"
        headers["Cache-Control"] = "no-store"; headers["Referrer-Policy"] = "no-referrer"; headers["X-Content-Type-Options"] = "nosniff"
        var text = "HTTP/1.1 \(response.status) \(labels[response.status] ?? "Response")\r\n"
        for (key, value) in headers {
            guard !value.contains("\r"), !value.contains("\n") else { finish(id); return }
            text += "\(key): \(value)\r\n"
        }
        var bytes = Data((text + "\r\n").utf8); bytes.append(response.body)
        connection.send(content: bytes, completion: .contentProcessed { [weak self] _ in Task { @DaemonActor in self?.finish(id) } })
    }
    private func finish(_ id: UUID) { deadlines.removeValue(forKey: id)?.cancel(); connections.removeValue(forKey: id)?.cancel() }
    func stop() {
        isReady = false
        epoch = UUID(); listener?.cancel(); listener = nil
        for id in Array(connections.keys) { finish(id) }; state = "Stopped"
    }
}
enum DotFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}
#endif
