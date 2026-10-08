#if os(macOS)
import Foundation

struct DotConsent: Identifiable, Sendable {
    var id: String; var scopes: [String]; var redirectURI: String; var expiresAt: Int
    var verificationCode: String { String(id.prefix(8)) }
}
struct DotGrant: Codable, Identifiable, Sendable { var id: String; var scopes: [String]; var expiresAt: Int; var revoked: Bool }
private struct DotToken: Codable { var hash: String; var grant: String; var refresh: Bool; var expiresAt: Int; var used: Bool }
private struct DotOAuthState: Codable { var version = 1; var grants: [DotGrant] = []; var tokens: [DotToken] = [] }
struct DotOAuthConfiguration: Codable, Sendable { var origin: String; var clientID: String; var secret: String; var redirectURI: String }
@DaemonActor
final class DotOAuth {
    private struct Pending { var consent: DotConsent; var challenge: String; var state: String; var decision: Bool?; var code: String?; var grant: String? }
    private var pending: [String: Pending] = [:]
    private var state: DotOAuthState
    let config: DotOAuthConfiguration
    private let persist: (Data) throws -> Void
    private let clock: () -> Int
    static let scopes = ["agentdeck:read", "agentdeck:report", "agentdeck:subscribe"]
    init(config: DotOAuthConfiguration, data: Data?, clock: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }, persist: @escaping (Data) throws -> Void) throws {
        guard let origin = URLComponents(string: config.origin), origin.scheme == "https", origin.host != nil,
              origin.user == nil, origin.password == nil, origin.path.isEmpty, origin.query == nil, origin.fragment == nil,
              let redirect = URLComponents(string: config.redirectURI), redirect.scheme == "https", redirect.host != nil,
              redirect.user == nil, redirect.password == nil, redirect.fragment == nil,
              config.clientID.count >= 16, config.secret.count >= 32 else { throw DotFailure.message("Invalid OAuth configuration.") }
        self.config = config; self.persist = persist; self.clock = clock
        state = try data.map { try JSONDecoder().decode(DotOAuthState.self, from: $0) } ?? DotOAuthState()
        guard state.version == 1, state.tokens.count <= DotOAuthLimits.records, state.grants.count <= DotOAuthLimits.records else { throw DotFailure.message("Invalid saved authorization state.") }
    }
    private func change<T>(_ mutation: (inout DotOAuthState) throws -> T) throws -> T {
        var next = state; let result = try mutation(&next)
        try persist(JSONEncoder().encode(next)); state = next; return result
    }
    func metadata() -> [String: Any] {
        ["issuer": config.origin, "authorization_endpoint": config.origin + "/oauth/authorize", "token_endpoint": config.origin + "/oauth/token",
         "revocation_endpoint": config.origin + "/oauth/revoke", "authorization_response_iss_parameter_supported": true,
         "response_types_supported": ["code"], "grant_types_supported": ["authorization_code", "refresh_token"],
         "token_endpoint_auth_methods_supported": ["client_secret_post"], "code_challenge_methods_supported": ["S256"], "scopes_supported": Self.scopes]
    }
    private func sweep() { pending = pending.filter { $0.value.consent.expiresAt > clock() } }
    func requests() -> [DotConsent] { sweep(); return pending.values.filter { $0.decision == nil }.map(\.consent).sorted { $0.expiresAt < $1.expiresAt } }
    func begin(_ p: [String: String]) throws -> String {
        sweep()
        let scopes = (p["scope"] ?? "").split(separator: " ").map(String.init)
        guard p["client_id"] == config.clientID, p["redirect_uri"] == config.redirectURI, p["resource"] == config.origin,
              p["response_type"] == "code", p["code_challenge_method"] == "S256", let challenge = p["code_challenge"],
              challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              let context = p["state"], !context.isEmpty, context.utf8.count <= 512,
              !scopes.isEmpty, scopes.allSatisfy({ Self.scopes.contains($0) }) else { throw DotFailure.message("invalid_request") }
        guard pending.count < DotOAuthLimits.pending else { throw DotFailure.message("temporarily_unavailable") }
        let id = try dotRandom()
        pending[id] = Pending(consent: .init(id: id, scopes: Array(Set(scopes)).sorted(), redirectURI: config.redirectURI,
            expiresAt: clock() + DotOAuthLimits.consentMs), challenge: challenge, state: context)
        return id
    }
    func decide(_ id: String, approve: Bool) throws {
        sweep(); guard var request = pending[id], request.decision == nil else { throw DotFailure.message("invalid_request") }
        if approve {
            let grant = DotGrant(id: UUID().uuidString, scopes: request.consent.scopes, expiresAt: clock() + DotOAuthLimits.refreshMs, revoked: false)
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
    private func client(_ p: [String: String]) throws {
        guard p["client_id"] == config.clientID, dotEqual(dotDigest(p["client_secret"] ?? ""), dotDigest(config.secret)) else { throw DotFailure.message("invalid_client") }
    }
    func exchange(_ p: [String: String]) throws -> [String: Any] {
        try client(p); sweep()
        guard p["resource"] == config.origin else { throw DotFailure.message("invalid_target") }
        let id: String
        if p["grant_type"] == "authorization_code" {
            guard let request = pending.values.first(where: { $0.code != nil && dotEqual($0.code!, p["code"] ?? "") }),
                  request.decision == true, let grant = request.grant, p["redirect_uri"] == request.consent.redirectURI,
                  let verifier = p["code_verifier"], verifier.range(of: "^[A-Za-z0-9._~-]{43,128}$", options: .regularExpression) != nil,
                  dotEqual(dotDigest(verifier), request.challenge) else { throw DotFailure.message("invalid_grant") }
            pending.removeValue(forKey: request.consent.id); id = grant
        } else if p["grant_type"] == "refresh_token" {
            let hash = dotDigest(p["refresh_token"] ?? "")
            guard let token = state.tokens.first(where: { $0.refresh && dotEqual($0.hash, hash) && $0.expiresAt > clock() }) else { throw DotFailure.message("invalid_grant") }
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
        if let token = state.tokens.first(where: { dotEqual($0.hash, dotDigest(p["token"] ?? "")) }) { try revokeGrant(token.grant) }
    }
}
#endif
