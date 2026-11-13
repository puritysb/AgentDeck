#if os(macOS)
import Foundation
import Network
import Security

struct DeviceHTTPSRequest: Sendable {
    let method: String
    let target: String
    let headers: [String: String]
    let body: Data
}
struct DeviceHTTPSResponse: Sendable {
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
enum DeviceHTTPSParse: Sendable {
    case incomplete, invalid, ready(DeviceHTTPSRequest)
}

/// A dedicated read-only device endpoint. It never uses the LAN HTTPServer's route table or pairing token.
@DaemonActor
final class DeviceTLSServer {
    private var listener: NWListener?
    private var connections: [UUID: NWConnection] = [:]
    private var deadlines: [UUID: Task<Void, Never>] = [:]
    private var epoch = UUID()
    private(set) var state = "Stopped"
    private static let queue = DispatchQueue(label: "agentdeck.device.https")

    nonisolated static func parse(_ data: Data) -> DeviceHTTPSParse {
        guard data.count <= DeviceSnapshotRules.headerBytes else { return .invalid }
        guard let split = data.range(of: Data("\r\n\r\n".utf8)) else {
            return data.count > DeviceSnapshotRules.headerBytes ? .invalid : .incomplete
        }
        guard split.lowerBound <= DeviceSnapshotRules.headerBytes,
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
        guard !lengthText.isEmpty, lengthText.allSatisfy({ $0.isASCII && $0.isNumber }), let count = Int(lengthText), count <= 0 else { return .invalid }
        let available = data.count - split.upperBound
        if available < count { return .incomplete }
        guard available == count else { return .invalid } // One request/connection; no pipelining ambiguity.
        return .ready(DeviceHTTPSRequest(method: String(start[0]), target: String(start[1]), headers: headers, body: data[split.upperBound...]))
    }
    private(set) var isReady = false
    private(set) var startupFailure: NWError?
    func start(identity: SecIdentity, port: UInt16, loopbackOnly: Bool = false,
               credentials: DeviceCredentialStore,
               snapshot: @escaping @DaemonActor @Sendable () -> (sessions: Any, usage: Any)) throws {
        guard port >= 1024, !(9120...9139).contains(Int(port)) else { throw DeviceTLSFailure.message("Choose a dedicated TLS port outside 9120–9139.") }
        stop()
        startupFailure = nil
        let run = epoch
        guard let nativeIdentity = sec_identity_create(identity) else { throw DeviceTLSFailure.message("TLS identity is unavailable.") }
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        sec_protocol_options_set_local_identity(tls.securityProtocolOptions, nativeIdentity)
        let parameters = NWParameters(tls: tls, tcp: NWProtocolTCP.Options())
        if loopbackOnly { parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!) }
        let listener = loopbackOnly ? try NWListener(using: parameters) : try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        let handler: @DaemonActor @Sendable (DeviceHTTPSRequest) -> DeviceHTTPSResponse = { request in
            guard DeviceCredentialRules.httpAllowed(method: request.method, target: request.target), request.headers["origin"] == nil,
                  request.body.isEmpty else { return .init(status: 400) }
            guard let authorization = request.headers["authorization"], authorization.hasPrefix("Bearer ") else { return .init(status: 401) }
            let token = String(authorization.dropFirst(7))
            do {
                guard let device = try credentials.authenticate(token) else { return .init(status: 401) }
                let value = snapshot()
                let body = DeviceSnapshotRules.build(scopes: device.scopes, sessions: value.sessions, usage: value.usage)
                guard try credentials.authenticate(token) != nil else { return .init(status: 401) }
                let response = DeviceHTTPSResponse.json(body)
                guard response.body.count <= DeviceSnapshotRules.maxBytes else { return .init(status: 503) }
                return response
            } catch { return .init(status: 503) }
        }
        self.listener = listener; state = "Starting connection"
        listener.stateUpdateHandler = { [weak self] result in
            Task { @DaemonActor in
                guard let self, self.epoch == run else { return }
                switch result {
                case .ready: self.isReady = true; self.state = "Device TLS listening"
                case .failed(let error): self.stop(); self.startupFailure = error; self.state = "HTTPS listener failed"
                default: break
                }
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            Task { @DaemonActor in
                guard let self, self.epoch == run, self.connections.count < DeviceSnapshotRules.maxConnections else { connection.cancel(); return }
                let id = UUID(); self.connections[id] = connection
                self.deadlines[id] = Task { @DaemonActor [weak self] in
                    try? await Task.sleep(for: .milliseconds(DeviceSnapshotRules.timeoutMs))
                    guard !Task.isCancelled else { return }; self?.finish(id)
                }
                connection.start(queue: Self.queue)
                self.receive(id, buffer: Data(), handler: handler)
            }
        }
        listener.start(queue: Self.queue)
        Task { @DaemonActor [weak self] in
            try? await Task.sleep(for: .milliseconds(DeviceSecurityRules.bindTimeoutMs))
            guard let self, self.epoch == run, !self.isReady else { return }
            self.stop(); self.state = "HTTPS startup timed out"
        }
    }
    private func receive(_ id: UUID, buffer: Data, handler: @escaping @DaemonActor @Sendable (DeviceHTTPSRequest) -> DeviceHTTPSResponse) {
        guard let connection = connections[id] else { return }
        connection.receive(minimumIncompleteLength: 1, maximumLength: DeviceSnapshotRules.headerBytes + 1) { [weak self] data, _, complete, error in
            Task { @DaemonActor in
                guard let self, self.connections[id] != nil else { return }
                guard error == nil, let data, !data.isEmpty else { self.finish(id); return }
                var bytes = buffer; bytes.append(data)
                switch Self.parse(bytes) {
                case .incomplete:
                    if complete { self.finish(id) } else { self.receive(id, buffer: bytes, handler: handler) }
                case .invalid: self.send(.init(status: 400), id: id)
                case .ready(let request): self.send(handler(request), id: id)
                }
            }
        }
    }
    private func send(_ response: DeviceHTTPSResponse, id: UUID) {
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
enum DeviceTLSFailure: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}
#endif
