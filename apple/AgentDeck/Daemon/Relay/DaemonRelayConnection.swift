#if os(macOS)
import Foundation

struct DaemonRelayTarget: Codable, Sendable, Equatable {
    let host: String
    let port: Int
    let token: String?
    var loopback: Bool { ["localhost","127.0.0.1","::1"].contains(host) }
    init(host: String, port: Int, token: String?) throws {
        let host = host.trimmingCharacters(in:.whitespacesAndNewlines).lowercased()
        guard !host.isEmpty, host.utf8.count <= 253, (1...65535).contains(port),
              host.unicodeScalars.allSatisfy({ CharacterSet(charactersIn:"abcdefghijklmnopqrstuvwxyz0123456789.:-").contains($0) }),
              !host.hasPrefix("-"), !host.contains("..") else { throw URLError(.badURL) }
        let token = token?.trimmingCharacters(in:.whitespacesAndNewlines)
        guard token == nil || (token!.utf8.count <= DaemonRelayPolicy.RELAY_MAX_STRING && token!.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 })) else { throw URLError(.userAuthenticationRequired) }
        self.host = host; self.port = port; self.token = token?.isEmpty == false ? token : nil
        guard loopback || self.token != nil, url(scheme:"ws") != nil else { throw URLError(.userAuthenticationRequired) }
    }
    func url(scheme: String, health: Bool = false) -> URL? {
        var c = URLComponents(); c.scheme = scheme; c.host = loopback ? "127.0.0.1" : (host.contains(":") ? "[\(host)]" : host); c.port = port
        c.path = health ? "/health" : ""
        if !health, !loopback, let token { c.queryItems = [URLQueryItem(name:"token",value:token)] }
        return c.url
    }
}

/// Reuses the app's non-interactive Data Protection storage implementation with
/// its own service/consent key. No GitHub account or credentials are consulted.
actor DaemonRelayConnection {
    static let shared = DaemonRelayConnection()
    nonisolated let generation = GitHubCIGeneration()
    private let storage: GitHubCIStorage
    private var loaded = false, revision = 0
    private var target: DaemonRelayTarget?
    init(storage: GitHubCIStorage = .keychain(service:(Bundle.main.bundleIdentifier ?? "bound.serendipity.agent.deck") + ".daemon-relay")) { self.storage = storage }
    func snapshot() throws -> (Int, DaemonRelayTarget?) {
        if !loaded {
            if storage.consent(), let data = try storage.load() {
                let raw = try JSONDecoder().decode(DaemonRelayTarget.self,from:data)
                target = try DaemonRelayTarget(host:raw.host,port:raw.port,token:raw.token)
            }
            loaded = true
        }
        return (revision,target)
    }
    func connect(host: String, port: Int, token: String?, consent: Bool) throws {
        guard consent else { throw URLError(.userAuthenticationRequired) }
        let target = try DaemonRelayTarget(host:host,port:port,token:token)
        try storage.save(JSONEncoder().encode(target)); storage.setConsent(true)
        self.target = target; loaded = true; revision += 1; generation.set(revision)
    }
    func disconnect() throws {
        revision += 1; generation.set(revision); target = nil; loaded = true; storage.setConsent(false)
        try storage.remove()
    }
    func summary() throws -> String {
        guard let target = try snapshot().1 else { return "Relay off" }
        return target.host + ":" + String(target.port) + " · " + generation.notice
    }
}
#endif
