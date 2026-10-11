#if os(macOS)
import Foundation

struct DotConsent: Identifiable, Sendable {
    var id: String; var scopes: [String]; var redirectURI: String; var expiresAt: Int
    var clientID: String = ""; var clientName: String = ""; var clientKind: DotClientKind = .preregistered
    var verificationCode: String { String(id.prefix(8)) }
}
/// How the requesting client identified itself. Only a metadata document is vouched for by its host;
/// a registered client named itself. Neither grants access; consent does.
enum DotClientKind: String, Sendable { case preregistered, registered, metadata }
struct DotGrant: Codable, Identifiable, Sendable { var id: String; var scopes: [String]; var expiresAt: Int; var revoked: Bool; var client: String? = nil }
private struct DotToken: Codable { var hash: String; var grant: String; var refresh: Bool; var expiresAt: Int; var used: Bool }
/// A loopback client registered through RFC 7591; it carries no secret and no authority.
private struct DotRegisteredClient: Codable { var id: String; var name: String; var redirects: [String]; var createdAt: Int }
private struct DotOAuthState: Codable { var version = 1; var grants: [DotGrant] = []; var tokens: [DotToken] = []; var clients: [DotRegisteredClient]? = nil }
struct DotOAuthConfiguration: Codable, Sendable { var origin: String; var clientID: String; var secret: String; var redirectURI: String; var local: Bool? = nil }
private struct DotClient: Sendable { var id: String; var name: String; var kind: DotClientKind; var redirects: [String] }
@DaemonActor
final class DotOAuth {
    private struct Pending { var consent: DotConsent; var challenge: String; var state: String; var decision: Bool?; var code: String?; var grant: String? }
    private var pending: [String: Pending] = [:]
    private var state: DotOAuthState
    private var documents: [String: (client: DotClient, expiresAt: Int)] = [:]
    private var fetching: [String: Task<DotClient, Error>] = [:]
    let config: DotOAuthConfiguration
    private let persist: (Data) throws -> Void
    private let clock: () -> Int
    private let fetchMetadata: @Sendable (URL) async throws -> Data
    static let scopes = ["agentdeck:read", "agentdeck:report", "agentdeck:subscribe"]
    init(config: DotOAuthConfiguration, data: Data?, clock: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) },
         fetchMetadata: @escaping @Sendable (URL) async throws -> Data = { try await DotOAuth.fetchDocument($0) }, persist: @escaping (Data) throws -> Void) throws {
        guard let origin = URLComponents(string: config.origin), origin.host != nil,
              origin.user == nil, origin.password == nil, origin.path.isEmpty, origin.query == nil, origin.fragment == nil else { throw DotFailure.message("Invalid OAuth origin.") }
        if config.local == true {
            guard origin.scheme == "http", origin.host == DotLocalMCP.host, config.clientID == DotLocalMCP.clientId,
                  Self.localRedirect(config.redirectURI) else { throw DotFailure.message("Invalid local OAuth configuration.") }
        } else {
            guard origin.scheme == "https", let redirect = URLComponents(string: config.redirectURI), redirect.scheme == "https", redirect.host != nil,
                  redirect.user == nil, redirect.password == nil, redirect.fragment == nil,
                  config.clientID.count >= 16, config.secret.count >= 32 else { throw DotFailure.message("Invalid OAuth configuration.") }
        }
        self.config = config; self.persist = persist; self.clock = clock; self.fetchMetadata = fetchMetadata
        state = try data.map { try JSONDecoder().decode(DotOAuthState.self, from: $0) } ?? DotOAuthState()
        guard state.version == 1, state.tokens.count <= DotOAuthLimits.records, state.grants.count <= DotOAuthLimits.records,
              (state.clients ?? []).count <= DotOAuthLimits.clients,
              (state.clients ?? []).allSatisfy({ client in
                  client.id.range(of: "^dcr_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil && client.name.count <= DotOAuthLimits.clientNameCharacters
                  && client.createdAt >= 0 && !client.redirects.isEmpty && client.redirects.count <= DotOAuthLimits.redirectURIs && client.redirects.allSatisfy(Self.clientRedirect)
              }) else { throw DotFailure.message("Invalid saved authorization state.") }
    }
    private func change<T>(_ mutation: (inout DotOAuthState) throws -> T) throws -> T {
        var next = state; let result = try mutation(&next)
        try persist(JSONEncoder().encode(next)); state = next; return result
    }
    func metadata() -> [String: Any] {
        var result: [String: Any] = ["issuer": config.origin, "authorization_endpoint": config.origin + "/oauth/authorize", "token_endpoint": config.origin + "/oauth/token",
         "revocation_endpoint": config.origin + "/oauth/revoke", "authorization_response_iss_parameter_supported": true,
         "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
         "token_endpoint_auth_methods_supported": [config.local == true ? "none" : "client_secret_post"], "code_challenge_methods_supported": ["S256"], "scopes_supported": Self.scopes]
        if config.local == true {
            result["registration_endpoint"] = config.origin + "/oauth/register"
            result["client_id_metadata_document_supported"] = true
            result["scopes_supported"] = DotLocalMCP.advertisedScopes
        }
        return result
    }
    nonisolated static func localRedirect(_ value: String) -> Bool {
        guard let url = URLComponents(string: value), url.scheme == "http", ["127.0.0.1", "localhost"].contains(url.host ?? ""),
              let port = url.port, (1024...65535).contains(port), url.path == DotLocalMCP.callbackPath,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return false }
        return true
    }
    /// Loopback HTTP on the shared callback path, in canonical form; `portRequired` is false only for a metadata document's entries.
    private nonisolated static func loopback(_ value: String, portRequired: Bool) -> (host: String, path: String)? {
        guard let url = URLComponents(string: value), url.scheme == "http", let host = url.host, ["127.0.0.1", "localhost"].contains(host),
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.percentEncodedPath.range(of: DotLocalMCP.clientCallbackPattern, options: .regularExpression) != nil else { return nil }
        if let port = url.port { guard (1024...65535).contains(port) else { return nil } } else if portRequired { return nil }
        guard "http://" + host + (url.port.map { ":\($0)" } ?? "") + url.percentEncodedPath == value else { return nil }
        return (host, url.percentEncodedPath)
    }
    /// A redirect a registered client may use: loopback HTTP, an explicit port and the shared callback path.
    nonisolated static func clientRedirect(_ value: String) -> Bool { loopback(value, portRequired: true) != nil }
    /// RFC 8252 §7.3: a metadata document's portless loopback redirect matches any port at request time.
    nonisolated static func metadataRedirectMatches(_ registered: [String], _ requested: String) -> Bool {
        guard let url = loopback(requested, portRequired: true) else { return false }
        let portless = "http://" + url.host + url.path
        return registered.contains { $0 == requested || $0 == portless }
    }
    /// Only HTTPS documents on allow-listed hosts, so the fetch can never reach this machine or its LAN.
    nonisolated static func metadataURL(_ value: String) -> Bool {
        guard value.count <= DotOAuthLimits.metadataURLCharacters, let url = URLComponents(string: value), url.scheme == "https",
              let host = url.host, DotLocalMCP.metadataHosts.contains(host), url.port == nil, url.user == nil, url.password == nil,
              url.query == nil, url.fragment == nil, url.percentEncodedPath.count > 1 else { return false }
        // WHATWG resolves `.`/`..` segments (and their %2E spellings) away, so Node never sees them as written.
        let dotSegments: Set<String> = [".", "..", "%2e", "%2e%2e", ".%2e", "%2e."]
        guard !url.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: false).contains(where: { dotSegments.contains($0.lowercased()) }) else { return false }
        return "https://" + host + url.percentEncodedPath == value
    }
    /// A client-chosen display name: controls, format characters and every separator but a plain space become spaces.
    nonisolated static func clientName(_ value: Any?) -> String {
        guard let text = value as? String else { return "Unnamed client" }
        let blanked: [Unicode.GeneralCategory] = [.control, .format, .lineSeparator, .paragraphSeparator, .spaceSeparator]
        let cleaned = String(String.UnicodeScalarView(text.unicodeScalars.map {
            $0 != " " && blanked.contains($0.properties.generalCategory) ? " " : $0
        })).trimmingCharacters(in: .whitespaces)
        let name = String(cleaned.prefix(DotOAuthLimits.clientNameCharacters))
        return name.isEmpty ? "Unnamed client" : name
    }
    /// Loopback hosts only. Bounded, secretless and unauthenticated by design: consent gates every grant.
    func register(_ input: Any) throws -> [String: Any] {
        guard config.local == true else { throw DotFailure.message("invalid_request") }
        guard let value = input as? [String: Any] else { throw DotFailure.message("invalid_client_metadata") }
        guard let redirects = value["redirect_uris"] as? [Any], !redirects.isEmpty, redirects.count <= DotOAuthLimits.redirectURIs,
              redirects.allSatisfy({ ($0 as? String).map(Self.clientRedirect) ?? false }) else { throw DotFailure.message("invalid_redirect_uri") }
        func list(_ key: String, _ allowed: [String]) -> Bool {
            guard let raw = value[key] else { return true }
            guard let items = raw as? [Any], !items.isEmpty else { return false }
            return items.allSatisfy { ($0 as? String).map(allowed.contains) ?? false }
        }
        guard list("grant_types", ["authorization_code", "refresh_token"]), list("response_types", ["code"]),
              value["token_endpoint_auth_method"] == nil || value["token_endpoint_auth_method"] as? String == "none",
              value["scope"] == nil || (value["scope"] as? String).map({ $0.split(separator: " ").allSatisfy { DotLocalMCP.advertisedScopes.contains(String($0)) } }) == true,
              value["client_name"] == nil || value["client_name"] is String else { throw DotFailure.message("invalid_client_metadata") }
        var unique: [String] = []
        for case let redirect as String in redirects where !unique.contains(redirect) { unique.append(redirect) }
        let client = DotRegisteredClient(id: "dcr_" + (try dotRandom()), name: Self.clientName(value["client_name"]), redirects: unique, createdAt: clock())
        let now = clock()
        try change { s in
            var clients = s.clients ?? []
            if clients.count >= DotOAuthLimits.clients {
                // Evict the oldest registration nobody depends on; a live grant or pending consent keeps a client.
                let busy = Set(s.grants.filter { !$0.revoked && $0.expiresAt > now }.compactMap(\.client) + pending.values.map(\.consent.clientID))
                guard let index = clients.firstIndex(where: { !busy.contains($0.id) }) else { throw DotFailure.message("temporarily_unavailable") }
                clients.remove(at: index)
            }
            clients.append(client); s.clients = clients
        }
        return ["client_id": client.id, "client_id_issued_at": client.createdAt / 1000, "client_name": client.name, "redirect_uris": client.redirects,
                "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "token_endpoint_auth_method": "none"]
    }
    /// Resolve a metadata-document client before `begin`; other client kinds need no I/O.
    func prepare(_ id: String?) async throws {
        guard config.local == true, let id, Self.metadataURL(id), let url = URL(string: id) else { return }
        if let cached = documents[id], cached.expiresAt > clock() { return }
        let work: Task<DotClient, Error>
        if let running = fetching[id] { work = running } else {
            guard fetching.count < DotOAuthLimits.pending else { throw DotFailure.message("temporarily_unavailable") }
            let fetch = fetchMetadata
            work = Task { try Self.clientDocument(id, data: try await fetch(url)) }
            fetching[id] = work
        }
        // A later prepare may have replaced the slot after this one finished; only clear our own.
        defer { if fetching[id] == work { fetching[id] = nil } }
        let client: DotClient
        do { client = try await work.value } catch { throw DotFailure.message("invalid_client") }
        let now = clock()
        documents = documents.filter { $0.value.expiresAt > now }
        if documents.count >= DotOAuthLimits.clients, let oldest = documents.min(by: { $0.value.expiresAt < $1.value.expiresAt })?.key { documents[oldest] = nil }
        documents[id] = (client, now + DotOAuthLimits.metadataCacheMs)
    }
    /// Validate a fetched Client ID Metadata Document; anything unexpected refuses the client.
    private nonisolated static func clientDocument(_ id: String, data: Data) throws -> DotClient {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any], value["client_id"] as? String == id,
              let redirects = value["redirect_uris"] as? [Any], !redirects.isEmpty, redirects.count <= DotOAuthLimits.redirectURIs,
              redirects.allSatisfy({ ($0 as? String).map { loopback($0, portRequired: false) != nil } ?? false }),
              value["token_endpoint_auth_method"] as? String == "none",
              value["grant_types"] == nil || (value["grant_types"] as? [Any])?.contains(where: { $0 as? String == "authorization_code" }) == true,
              value["response_types"] == nil || (value["response_types"] as? [Any])?.contains(where: { $0 as? String == "code" }) == true,
              value["client_name"] == nil || value["client_name"] is String else { throw DotFailure.message("invalid_client") }
        return DotClient(id: id, name: clientName(value["client_name"]), kind: .metadata, redirects: redirects.compactMap { $0 as? String })
    }
    /// HTTPS only (enforced by `metadataURL`), no redirects, a size cap and one overall deadline.
    nonisolated static func fetchDocument(_ url: URL) async throws -> Data { try await fetchDocument(url, deadlineMs: DotOAuthLimits.metadataMs) }
    nonisolated static func fetchDocument(_ url: URL, deadlineMs: Int) async throws -> Data {
        try await withThrowingTaskGroup(of: Data.self) { group in
            group.addTask {
                var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Double(deadlineMs) / 1000)
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                let session = URLSession(configuration: .ephemeral)
                defer { session.invalidateAndCancel() }
                let (bytes, response) = try await session.bytes(for: request, delegate: DotNoRedirect())
                guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw DotFailure.message("invalid_client") }
                var data = Data()
                for try await byte in bytes {
                    data.append(byte)
                    if data.count > DotOAuthLimits.metadataBytes { throw DotFailure.message("invalid_client") }
                }
                return data
            }
            group.addTask {
                try await Task.sleep(for: .milliseconds(deadlineMs))
                throw DotFailure.message("invalid_client")
            }
            defer { group.cancelAll() }
            return try await group.next()!
        }
    }
    private func resolve(_ id: String?) -> DotClient? {
        guard let id else { return nil }
        if id == config.clientID {
            return DotClient(id: id, name: config.local == true ? "AgentDeck local plugin" : "Registered client", kind: .preregistered, redirects: [config.redirectURI])
        }
        guard config.local == true else { return nil }
        if let registered = state.clients?.first(where: { $0.id == id }) {
            return DotClient(id: id, name: registered.name, kind: .registered, redirects: registered.redirects)
        }
        if let document = documents[id], document.expiresAt > clock() { return document.client }
        return nil
    }
    private func redirectAllowed(_ client: DotClient, _ redirect: String) -> Bool {
        switch client.kind {
        case .preregistered: return config.local == true ? Self.localRedirect(redirect) : redirect == config.redirectURI
        case .registered: return client.redirects.contains(redirect)
        case .metadata: return Self.metadataRedirectMatches(client.redirects, redirect)
        }
    }
    private func sweep() { pending = pending.filter { $0.value.consent.expiresAt > clock() } }
    func requests() -> [DotConsent] { sweep(); return pending.values.filter { $0.decision == nil }.map(\.consent).sorted { $0.expiresAt < $1.expiresAt } }
    func begin(_ p: [String: String]) throws -> String {
        sweep()
        let scopes = (p["scope"] ?? "").split(separator: " ").map(String.init)
        guard let client = resolve(p["client_id"]), redirectAllowed(client, p["redirect_uri"] ?? ""), p["resource"] == config.origin,
              p["response_type"] == "code", p["code_challenge_method"] == "S256", let challenge = p["code_challenge"],
              challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let context = p["state"], !context.isEmpty, context.utf8.count <= 512,
              // The loopback host has no Events surface, so it never grants subscription to any client kind.
              !scopes.isEmpty, scopes.allSatisfy({ (config.local == true ? DotLocalMCP.advertisedScopes : Self.scopes).contains($0) }) else { throw DotFailure.message("invalid_request") }
        guard pending.count < DotOAuthLimits.pending else { throw DotFailure.message("temporarily_unavailable") }
        let id = try dotRandom()
        pending[id] = Pending(consent: .init(id: id, scopes: Array(Set(scopes)).sorted(), redirectURI: p["redirect_uri"]!,
            expiresAt: clock() + DotOAuthLimits.consentMs, clientID: client.id, clientName: client.name, clientKind: client.kind), challenge: challenge, state: context)
        return id
    }
    func decide(_ id: String, approve: Bool) throws {
        sweep(); guard var request = pending[id], request.decision == nil else { throw DotFailure.message("invalid_request") }
        if approve {
            let grant = DotGrant(id: UUID().uuidString, scopes: request.consent.scopes, expiresAt: clock() + DotOAuthLimits.refreshMs, revoked: false, client: request.consent.clientID)
            let now = clock()
            try change { s in
                s.grants.removeAll { $0.expiresAt <= now }
                guard s.grants.count < DotOAuthLimits.records else { throw DotFailure.message("temporarily_unavailable") }
                s.grants.append(grant)
            }
            request.code = try dotRandom(); request.grant = grant.id
        }
        request.decision = approve; pending[id] = request
    }
    func redirect(_ id: String) throws -> String? {
        sweep(); guard let request = pending[id] else { throw DotFailure.message("invalid_request") }
        guard let decision = request.decision else { return nil }
        var url = URLComponents(string: request.consent.redirectURI)!
        url.queryItems = (url.queryItems ?? []) + [URLQueryItem(name: "state", value: request.state), URLQueryItem(name: "iss", value: config.origin),
            URLQueryItem(name: decision ? "code" : "error", value: decision ? request.code : "access_denied")]
        return url.string!
    }
    /// A confidential host authenticates its one client here; a public loopback client is bound per grant.
    private func client(_ p: [String: String]) throws {
        if config.local == true {
            guard let id = p["client_id"], !id.isEmpty else { throw DotFailure.message("invalid_client") }
        } else {
            guard p["client_id"] == config.clientID, dotEqual(dotDigest(p["client_secret"] ?? ""), dotDigest(config.secret)) else { throw DotFailure.message("invalid_client") }
        }
    }
    /// Grants issued before client binding belong to the one pre-registered client.
    private func owner(_ grant: DotGrant?) -> String? { grant.map { $0.client ?? config.clientID } }
    func exchange(_ p: [String: String]) throws -> [String: Any] {
        try client(p); sweep()
        guard p["resource"] == config.origin else { throw DotFailure.message("invalid_target") }
        let id: String
        if p["grant_type"] == "authorization_code" {
            guard let request = pending.values.first(where: { $0.code != nil && dotEqual($0.code!, p["code"] ?? "") }),
                  request.decision == true, let grant = request.grant, p["client_id"] == request.consent.clientID, p["redirect_uri"] == request.consent.redirectURI,
                  let verifier = p["code_verifier"], verifier.range(of: "^[A-Za-z0-9._~-]{43,128}$", options: .regularExpression) != nil,
                  dotEqual(dotDigest(verifier), request.challenge) else { throw DotFailure.message("invalid_grant") }
            pending.removeValue(forKey: request.consent.id); id = grant
        } else if p["grant_type"] == "refresh_token" {
            let hash = dotDigest(p["refresh_token"] ?? "")
            guard let token = state.tokens.first(where: { $0.refresh && dotEqual($0.hash, hash) && $0.expiresAt > clock() }) else { throw DotFailure.message("invalid_grant") }
            // A refresh token is bound to the client it was issued to; a mismatch neither consumes nor revokes it.
            guard owner(state.grants.first { $0.id == token.grant }) == p["client_id"] else { throw DotFailure.message("invalid_grant") }
            if token.used { try revokeGrant(token.grant); throw DotFailure.message("invalid_grant") }
            id = token.grant
            try change { s in if let i = s.tokens.firstIndex(where: { $0.hash == hash }) { s.tokens[i].used = true } }
        } else { throw DotFailure.message("unsupported_grant_type") }
        guard let grant = state.grants.first(where: { $0.id == id && !$0.revoked && $0.expiresAt > clock() }) else { throw DotFailure.message("invalid_grant") }
        if let requested = p["scope"], Set(requested.split(separator: " ").map(String.init)) != Set(grant.scopes) { throw DotFailure.message("invalid_scope") }
        let access = try dotRandom(), refresh = try dotRandom(), now = clock()
        let expiry = min(now + DotOAuthLimits.accessMs, grant.expiresAt)
        try change { s in
            s.tokens.removeAll { $0.expiresAt <= now }
            guard s.tokens.count + 2 <= DotOAuthLimits.records else { throw DotFailure.message("temporarily_unavailable") }
            s.tokens.append(.init(hash: dotDigest(access), grant: id, refresh: false, expiresAt: expiry, used: false))
            s.tokens.append(.init(hash: dotDigest(refresh), grant: id, refresh: true, expiresAt: grant.expiresAt, used: false))
        }
        return ["access_token": access, "token_type": "Bearer", "expires_in": (expiry - now) / 1000,
                "refresh_token": refresh, "scope": grant.scopes.joined(separator: " "), "resource": config.origin]
    }
    func authenticate(_ token: String) -> DotGrant? {
        let hash = dotDigest(token)
        guard let token = state.tokens.first(where: { !$0.refresh && $0.expiresAt > clock() && dotEqual($0.hash, hash) }) else { return nil }
        return grant(token.grant)
    }
    func grant(_ id: String) -> DotGrant? { state.grants.first { $0.id == id && !$0.revoked && $0.expiresAt > clock() } }
    func grants() -> [DotGrant] { state.grants.filter { !$0.revoked && $0.expiresAt > clock() } }
    func revokeGrant(_ id: String) throws {
        try change { s in
            if let i = s.grants.firstIndex(where: { $0.id == id }) { s.grants[i].revoked = true }
            s.tokens.removeAll { $0.grant == id }
        }
        pending = pending.filter { $0.value.grant != id }
    }
    func revoke(_ p: [String: String]) throws {
        try client(p)
        // RFC 7009: another client's token is ignored without revealing that it exists.
        if let token = state.tokens.first(where: { dotEqual($0.hash, dotDigest(p["token"] ?? "")) }),
           owner(state.grants.first { $0.id == token.grant }) == p["client_id"] { try revokeGrant(token.grant) }
    }
}
/// The metadata host must serve the document itself; a redirect yields the 3xx response, which is refused.
private final class DotNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}
#endif
