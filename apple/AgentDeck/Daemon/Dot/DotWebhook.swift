#if os(macOS)
import Foundation
import Network
import Security
import CryptoKit
import Darwin

struct DotWebhookReply: Sendable { var status: Int; var body: Data }
@DaemonActor
final class DotWebhook {
    private var connection: NWConnection?
    private var deadline: Task<Void, Never>?
    private var completion: CheckedContinuation<DotWebhookReply, Error>?
    private var bytes = Data()
    private static let queue = DispatchQueue(label: "agentdeck.dot.callback")

    nonisolated static func isPublic(_ value: String) -> Bool {
        var v4 = in_addr()
        if inet_pton(AF_INET, value, &v4) == 1 {
            let b = withUnsafeBytes(of: &v4) { Array($0) }
            if [0, 10, 127].contains(Int(b[0])) || b[0] >= 224 { return false }
            if b[0] == 100 && (64...127).contains(b[1]) { return false }
            if b[0] == 169 && b[1] == 254 { return false }
            if b[0] == 172 && (16...31).contains(b[1]) { return false }
            if b[0] == 192 && (b[1] == 168 || (b[1] == 0 && [0, 2].contains(b[2])) || (b[1] == 88 && b[2] == 99)) { return false }
            if b[0] == 198 && ([18, 19].contains(b[1]) || (b[1] == 51 && b[2] == 100)) { return false }
            if b[0] == 203 && b[1] == 0 && b[2] == 113 { return false }
            return true
        }
        var v6 = in6_addr()
        guard inet_pton(AF_INET6, value, &v6) == 1 else { return false }
        let b = withUnsafeBytes(of: &v6) { Array($0) }
        guard b[0] & 0xe0 == 0x20 else { return false }
        if b[0] == 0x20 && b[1] == 0x01 && (b[2] < 2 || (b[2] == 0x0d && b[3] == 0xb8)) { return false }
        if b[0] == 0x20 && b[1] == 0x02 { return false }
        if b[0] == 0x3f && b[1] == 0xff && b[2] < 0x10 { return false }
        return true
    }
    nonisolated static func callbackURL(_ value: String) throws -> URLComponents {
        guard value.unicodeScalars.count <= DotLimits.callbackURLCharacters,
              let url = URLComponents(string: value), url.url != nil, url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.fragment == nil, url.port == nil || url.port == 443 else {
            throw DotFailure.message("Callback must use public HTTPS on port 443.")
        }
        return url
    }
    nonisolated static func key(_ value: String) throws -> Data {
        guard value.hasPrefix("whsec_"), let data = Data(base64Encoded: String(value.dropFirst(6))),
              (24...64).contains(data.count), data.base64EncodedString() == String(value.dropFirst(6)) else { throw DotFailure.message("Invalid webhook secret.") }
        return data
    }
    nonisolated static func signature(id: String, seconds: Int, body: Data, secret: String) throws -> String {
        var input = Data("\(id).\(seconds).".utf8); input.append(body)
        return "v1," + Data(HMAC<SHA256>.authenticationCode(for: input, using: SymmetricKey(data: try key(secret)))).base64EncodedString()
    }
    static func send(url: String, body: Data, headers: [String: String]) async throws -> DotWebhookReply {
        let target = try callbackURL(url)
        return try await withCheckedThrowingContinuation { continuation in
            let operation = DotWebhook(); operation.completion = continuation
            operation.deadline = Task { @DaemonActor in
                try? await Task.sleep(for: .milliseconds(DotLimits.callbackMs))
                if !Task.isCancelled { operation.finish(.failure(DotFailure.message("Callback timed out."))) }
            }
            // Blocking resolver is off the daemon executor; deadline covers it and late results are ignored.
            let hostname = target.host!.replacingOccurrences(of: "[", with: "").replacingOccurrences(of: "]", with: "")
            DispatchQueue.global().async {
                var hints = addrinfo(); hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM
                var result: UnsafeMutablePointer<addrinfo>?
                let status = getaddrinfo(hostname, "443", &hints, &result)
                var addresses: [String] = []
                if status == 0 {
                    var cursor = result
                    while let row = cursor {
                        var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                        if getnameinfo(row.pointee.ai_addr, row.pointee.ai_addrlen, &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                            addresses.append(String(cString: buffer))
                        }
                        cursor = row.pointee.ai_next
                    }
                }
                if let result { freeaddrinfo(result) }
                let resolved = addresses
                Task { @DaemonActor in
                    guard operation.completion != nil else { return }
                    guard !resolved.isEmpty, resolved.allSatisfy(Self.isPublic) else {
                        operation.finish(.failure(DotFailure.message("Callback destination is unavailable or non-public."))); return
                    }
                    operation.connect(target, address: resolved[0], body: body, headers: headers)
                }
            }
        }
    }
    private func connect(_ target: URLComponents, address: String, body: Data, headers: [String: String]) {
        let tls = NWProtocolTLS.Options()
        sec_protocol_options_set_tls_server_name(tls.securityProtocolOptions, target.host!)
        sec_protocol_options_set_min_tls_protocol_version(tls.securityProtocolOptions, .TLSv12)
        let connection = NWConnection(host: NWEndpoint.Host(address), port: 443, using: NWParameters(tls: tls, tcp: NWProtocolTCP.Options()))
        self.connection = connection
        let path = (target.percentEncodedPath.isEmpty ? "/" : target.percentEncodedPath) + (target.percentEncodedQuery.map { "?" + $0 } ?? "")
        var request = "POST \(path) HTTP/1.1\r\nHost: \(target.host!)\r\nConnection: close\r\nAccept-Encoding: identity\r\nContent-Length: \(body.count)\r\n"
        for (name, value) in headers { request += "\(name): \(value)\r\n" }
        var data = Data((request + "\r\n").utf8); data.append(body)
        connection.stateUpdateHandler = { [weak self] state in
            if case .failed = state { Task { @DaemonActor in self?.finish(.failure(DotFailure.message("Callback TLS connection failed."))) } }
        }
        connection.start(queue: Self.queue)
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            Task { @DaemonActor in
                guard let self else { return }
                if error != nil { self.finish(.failure(DotFailure.message("Callback send failed."))) } else { self.receive() }
            }
        })
    }
    private func receive() {
        connection?.receive(minimumIncompleteLength: 1, maximumLength: DotLimits.callbackResponseBytes + DotLimits.headerBytes + 1) { [weak self] data, _, complete, error in
            Task { @DaemonActor in
                guard let self, self.completion != nil else { return }
                if let data { self.bytes.append(data) }
                guard error == nil, self.bytes.count <= DotLimits.headerBytes + DotLimits.callbackResponseBytes else {
                    self.finish(.failure(DotFailure.message("Callback response failed or exceeded limits."))); return
                }
                if complete {
                    do { self.finish(.success(try Self.parseReply(self.bytes))) }
                    catch { self.finish(.failure(error)) }
                } else { self.receive() }
            }
        }
    }
    nonisolated static func parseReply(_ data: Data) throws -> DotWebhookReply {
        guard let split = data.range(of: Data("\r\n\r\n".utf8)), split.lowerBound <= DotLimits.headerBytes,
              let header = String(data: data[..<split.lowerBound], encoding: .utf8) else { throw DotFailure.message("Invalid callback response.") }
        let lines = header.components(separatedBy: "\r\n"), first = lines[0].split(separator: " ")
        guard first.count >= 2, ["HTTP/1.1", "HTTP/1.0"].contains(String(first[0])), let status = Int(first[1]) else { throw DotFailure.message("Invalid callback status.") }
        var fields: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { throw DotFailure.message("Invalid callback header.") }
            let name = String(line[..<colon]).lowercased(), value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            if ["content-length", "transfer-encoding", "content-encoding"].contains(name), fields[name] != nil { throw DotFailure.message("Ambiguous callback framing.") }
            fields[name] = value
        }
        var body = Data(data[split.upperBound...])
        if let encoding = fields["content-encoding"], encoding != "identity" { throw DotFailure.message("Unsupported response encoding.") }
        if let transfer = fields["transfer-encoding"] {
            guard transfer.lowercased() == "chunked", fields["content-length"] == nil else { throw DotFailure.message("Invalid response framing.") }
            var decoded = Data()
            while true {
                guard let line = body.range(of: Data("\r\n".utf8)), let hex = String(data: body[..<line.lowerBound], encoding: .utf8)?.split(separator: ";").first,
                      let count = Int(hex, radix: 16), count >= 0, count <= DotLimits.callbackResponseBytes else { throw DotFailure.message("Invalid chunk.") }
                body = Data(body[line.upperBound...])
                if count == 0 { guard body.starts(with: Data("\r\n".utf8)) else { throw DotFailure.message("Unsupported chunk trailer.") }; body = decoded; break }
                guard body.count >= count + 2, body[count..<(count + 2)] == Data("\r\n".utf8), decoded.count + count <= DotLimits.callbackResponseBytes else { throw DotFailure.message("Invalid chunk length.") }
                decoded.append(body.prefix(count)); body = Data(body.dropFirst(count + 2))
            }
        } else if let size = fields["content-length"] {
            guard Int(size) == body.count else { throw DotFailure.message("Truncated callback response.") }
        }
        guard body.count <= DotLimits.callbackResponseBytes else { throw DotFailure.message("Callback body too large.") }
        return .init(status: status, body: body)
    }
    private func finish(_ result: Result<DotWebhookReply, Error>) {
        guard let completion else { return }
        self.completion = nil; deadline?.cancel(); deadline = nil; connection?.cancel(); connection = nil
        completion.resume(with: result)
    }
}
#endif
