#if os(macOS)
import Foundation

struct DotHostConfiguration: Codable, Sendable {
    var origin: String
    var port: UInt16
    var oauth: DotOAuthConfiguration
    var resumeOnLaunch: Bool?
}
struct DotHostSnapshot: Sendable {
    var resumeOnLaunch: Bool = false; var hosting: Bool = false; var available: Bool; var status: String; var origin: String; var clientID: String
    var appearance: DotAppearance? = nil
    var consents: [DotConsent]; var grants: [DotGrant]; var reports: [DotBriefing]
    func deckSnapshot(now: Int) -> [String: Any]? {
        let value = self
        guard !value.origin.isEmpty else { return nil }
        let latest = value.reports.first
        var reportState = latest?.report?.state
        if let latest, let report = latest.report, !["completed", "failed"].contains(report.state),
           (latest.expiresAt <= now || now - report.receivedAt >= DotLimits.reportFreshMs) { reportState = "stale" }
        var result: [String: Any] = ["configured": true, "hosting": value.hosting,
                "reportState": reportState as Any? ?? NSNull(),
                "reportedAt": latest?.report?.receivedAt as Any? ?? NSNull(),
                "expiresAt": latest?.expiresAt as Any? ?? NSNull()]
        if let appearance, appearance.portrait != nil, let data = try? JSONEncoder().encode(appearance),
           let dictionary = try? JSONSerialization.jsonObject(with: data) { result["appearance"] = dictionary }
        let snapshot = DotSurfaceSnapshot(configured: true, hosting: value.hosting, reportState: reportState,
            reportedAt: latest?.report?.receivedAt, expiresAt: latest?.expiresAt)
        result["code"] = snapshot.phase(at: now)
        result["validForMs"] = snapshot.phase(at: now) == 2 || snapshot.phase(at: now) == 3
            ? max(0, min(DotLimits.reportFreshMs - (now - (latest?.report?.receivedAt ?? 0)), (latest?.expiresAt ?? now) - now)) : 0
        if let edge = latest?.interactions?.last {
            result["relation"] = ["kind": edge.kind, "direction": edge.direction, "stage": edge.stage,
                "target": edge.targetRef as Any? ?? NSNull(), "receivedAt": edge.receivedAt, "evidence": "dot_report"]
        }
        return result
    }

}
@DaemonActor
final class DotHost {
    static let shared = DotHost()
    private let listener = DotHTTPSListener()
    private var config: DotHostConfiguration?
    private var oauth: DotOAuth?
    private var store: DotMCPStore?
    private var worker: Task<Void, Never>?
    private var activeOwner: UUID?
    private var error: String?
    private var active = false
    private var generation = UUID()
    private var budgetAt = Date.distantPast
    private var budget = 0

    func owned(by id: UUID) { activeOwner = id }
    func release(_ id: UUID) {
        guard activeOwner == id else { return }
        stop(); activeOwner = nil
    }
    func snapshot() -> DotHostSnapshot {
        .init(resumeOnLaunch: config?.resumeOnLaunch == true, hosting: active && listener.isReady, available: activeOwner != nil, status: error ?? listener.state, origin: config?.origin ?? "", clientID: config?.oauth.clientID ?? "", appearance: DotAppearanceStore.current(),
              consents: oauth?.requests() ?? [], grants: oauth?.grants() ?? [], reports: store?.requests() ?? [])
    }
    func deckSnapshot() -> [String: Any]? {
        snapshot().deckSnapshot(now: Int(Date().timeIntervalSince1970 * 1000))
    }
    func secret() -> String? { config?.oauth.secret }
    func stop() { generation = UUID(); listener.stop(); worker?.cancel(); worker = nil; store?.stop(); active = false }
    func configure(origin: String, port: UInt16, redirect: String, certificate: Data, password: String) throws {
        guard activeOwner != nil else { throw DotFailure.message("The local AgentDeck daemon is not active.") }
        guard let url = URLComponents(string: origin), url.scheme == "https", let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil, url.path.isEmpty || url.path == "/",
              !["localhost", "127.0.0.1", "::1"].contains(host), port >= 1024, !(9120...9139).contains(Int(port)),
              let redirectURL = URLComponents(string: redirect), redirectURL.scheme == "https", redirectURL.host != nil,
              redirectURL.user == nil, redirectURL.password == nil, redirectURL.fragment == nil else {
            throw DotFailure.message("Enter an HTTPS origin, exact OAuth callback URL and a dedicated port.")
        }
        var canonical = url; canonical.path = ""
        let publicOrigin = canonical.string!
        let envelope = DotCertificateEnvelope(bytes: certificate, password: password)
        _ = try DotIdentity.validate(envelope, hostname: host)
        let value = DotHostConfiguration(origin: publicOrigin, port: port,
            oauth: .init(origin: publicOrigin, clientID: try dotRandom(), secret: try dotRandom(), redirectURI: redirect))
        // Configuration replacement revokes old connections. A failed write leaves hosting stopped.
        stop(); oauth = nil; store = nil
        try DotVault.save(Data(), account: "authorization")
        try DotVault.save(JSONEncoder().encode(envelope), account: "identity")
        try DotVault.save(JSONEncoder().encode(value), account: "configuration")
        config = value
    }
    func load() throws {
        guard let data = try DotVault.load("configuration"), !data.isEmpty else { return }
        config = try JSONDecoder().decode(DotHostConfiguration.self, from: data)
    }
    func resumeIfEnabled() throws {
        try load()
        if config?.resumeOnLaunch == true { try start() }
    }
    func setResumeOnLaunch(_ enabled: Bool) throws {
        guard var value = config else { throw DotFailure.message("Configure HTTPS first.") }
        value.resumeOnLaunch = enabled
        try DotVault.save(JSONEncoder().encode(value), account: "configuration")
        config = value
    }
    func start() throws {
        guard activeOwner != nil else { throw DotFailure.message("The local AgentDeck daemon is not active.") }
        if config == nil { try load() }
        guard let config, let bytes = try DotVault.load("identity") else { throw DotFailure.message("Configure the public hostname and certificate first.") }
        guard let publicURL = URLComponents(string: config.origin), publicURL.scheme == "https",
              let hostname = publicURL.host, !hostname.isEmpty, publicURL.user == nil, publicURL.password == nil,
              publicURL.query == nil, publicURL.fragment == nil, publicURL.path.isEmpty,
              config.port >= 1024, !(9120...9139).contains(Int(config.port)) else {
            throw DotFailure.message("Stored HTTPS configuration is invalid. Configure the connection again.")
        }
        stop(); error = nil
        let envelope = try JSONDecoder().decode(DotCertificateEnvelope.self, from: bytes)
        let identity = try DotIdentity.validate(envelope, hostname: hostname)
        let authData = try DotVault.load("authorization")
        let auth = try DotOAuth(config: config.oauth, data: authData?.isEmpty == false ? authData : nil) { try DotVault.save($0, account: "authorization") }
        guard let contractURL = Bundle.main.url(forResource: "dot-mcp-contract", withExtension: "json") else { throw DotFailure.message("MCP contract resource is missing.") }
        let database = try DotMCPStore(file: AgentDeckPaths.baseDirectory.appendingPathComponent("dot/requests.json"), contract: Data(contentsOf: contractURL), access: { auth.grant($0) != nil })
        try database.maintenance()
        oauth = auth; store = database
        let run = generation
        try listener.start(identity: identity, port: config.port) { [weak self] request in
            guard let self, self.generation == run else { return .init(status: 503) }
            return await self.handle(request)
        }
        active = true
        worker = Task { @DaemonActor [weak self] in
            var validatedAt = Date()
            while !Task.isCancelled {
                guard let self, self.generation == run else { return }
                if Date().timeIntervalSince(validatedAt) >= 60 {
                    do { _ = try DotIdentity.validate(envelope, hostname: hostname); validatedAt = Date() }
                    catch { self.stop(); self.error = "HTTPS identity expired or is no longer trusted. Import a renewed certificate."; return }
                }
                do { if self.listener.isReady { try await database.deliver() } } catch { self.error = "Dot delivery or persistence failed. Restart after checking configuration." }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
    func approve(_ id: String, allowed: Bool) throws { try oauth?.decide(id, approve: allowed) }
    func revoke(_ id: String) throws { try oauth?.revokeGrant(id); try store?.revoke(id) }
    func request(grant: String, profile: String, context: String, key: String) throws {
        guard active, listener.isReady, let store else { throw DotFailure.message("Start HTTPS hosting before requesting a briefing.") }
        try store.create(owner: grant, profile: profile, context: context, key: key)
    }
    nonisolated static func parameters(_ value: String) throws -> [String: String] {
        guard let components = URLComponents(string: "https://form.invalid/?" + value.replacingOccurrences(of: "+", with: "%20")) else { throw DotFailure.message("invalid_request") }
        var result: [String: String] = [:]
        for item in components.queryItems ?? [] {
            guard result[item.name] == nil, let value = item.value else { throw DotFailure.message("invalid_request") }
            result[item.name] = value
        }
        return result
    }
    private func handle(_ request: DotHTTPRequest) async -> DotHTTPResponse {
        guard let config, let oauth, let store else { return .init(status: 503) }
        if request.headers["origin"] != nil { return .init(status: 403) }
        // A bounded installation-wide budget also covers unauthenticated OAuth requests.
        if Date().timeIntervalSince(budgetAt) >= 60 { budgetAt = Date(); budget = 0 }
        budget += 1; if budget > DotLimits.requestsPerMinute { return .init(status: 429, headers: ["Retry-After": "60"]) }
        guard let target = URLComponents(string: request.target), target.host == nil, target.scheme == nil else { return .init(status: 400) }
        do {
            if request.method == "GET", target.path == "/.well-known/oauth-protected-resource" {
                return .json(["resource": config.origin, "authorization_servers": [config.origin], "scopes_supported": DotOAuth.scopes])
            }
            if request.method == "GET", target.path == "/.well-known/oauth-authorization-server" { return .json(oauth.metadata()) }
            if request.method == "GET", target.path == "/oauth/authorize" {
                let id = try oauth.begin(Self.parameters(target.percentEncodedQuery ?? ""))
                return .init(status: 302, headers: ["Location": config.origin + "/oauth/status?id=" + id])
            }
            if request.method == "GET", target.path == "/oauth/status" {
                let params = try Self.parameters(target.percentEncodedQuery ?? "")
                guard let id = params["id"], id.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { return .init(status: 400) }
                if let redirect = try oauth.redirect(id) { return .init(status: 302, headers: ["Location": redirect]) }
                let text = "<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=3><title>Connect AgentDeck</title><h1>Approve in AgentDeck</h1><p>Open AgentDeck Settings, then Dot. Compare this code before approving:</p><p>\(id.prefix(8))</p><p>This request expires in two minutes.</p>"
                return .init(headers: ["Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"], body: Data(text.utf8))
            }
            if request.method == "POST", ["/oauth/token", "/oauth/revoke"].contains(target.path) {
                guard request.headers["content-type"]?.hasPrefix("application/x-www-form-urlencoded") == true,
                      let body = String(data: request.body, encoding: .utf8) else { return .init(status: 400) }
                let params = try Self.parameters(body)
                if target.path == "/oauth/token" { return .json(try oauth.exchange(params)) }
                try oauth.revoke(params); try store.maintenance(); return .json([:])
            }
            guard target.path == "/mcp", target.query == nil else { return .init(status: 404) }
            guard let header = request.headers["authorization"], header.hasPrefix("Bearer "), let grant = oauth.authenticate(String(header.dropFirst(7))) else {
                return .init(status: 401, headers: ["WWW-Authenticate": "Bearer resource_metadata=\"\(config.origin)/.well-known/oauth-protected-resource\""])
            }
            guard request.method == "POST" else { return .init(status: 405, headers: ["Allow": "POST"]) }
            if let version = request.headers["mcp-protocol-version"], !["2025-11-25", store.contract["version"] as! String].contains(version) { return .init(status: 400) }
            guard request.headers["content-type"]?.hasPrefix("application/json") == true,
                  let object = try JSONSerialization.jsonObject(with: request.body) as? [String: Any], object["jsonrpc"] as? String == "2.0",
                  let method = object["method"] as? String else { return .init(status: 400) }
            guard let id = object["id"] else { return .init(status: method == "notifications/initialized" || method == "notifications/cancelled" ? 202 : 400) }
            if !(id is String) { try DotSchema.validate(id, ["type": "integer"]) }
            func result(_ value: [String: Any]) -> DotHTTPResponse { .json(["jsonrpc": "2.0", "id": id, "result": value]) }
            do {
                let params = object["params"] as? [String: Any] ?? [:]
                if method == "initialize" {
                    guard params["protocolVersion"] is String, params["capabilities"] is [String: Any], params["clientInfo"] is [String: Any] else { throw DotRPCError(code: -32602, message: "Invalid initialization") }
                    return result(["protocolVersion": "2025-11-25", "capabilities": ["tools": [:]], "serverInfo": ["name": "agentdeck-direct", "version": AppMetadata.current.version],
                        "instructions": "Read and claim the supplied request before reporting. Reports describe this request only, never global Dot status."])
                }
                if method == "ping" { return result([:]) }
                if request.headers["mcp-protocol-version"] == "2025-11-25", method.hasPrefix("events/") || method == "server/discover" { throw DotRPCError(code: -32601, message: "Events require experimental discovery") }
                return result(try await store.rpc(grant: grant, method: method, params: params))
            } catch {
                let fault = error as? DotRPCError ?? .init(code: -32603, message: "MCP operation failed")
                return .json(["jsonrpc": "2.0", "id": id, "error": ["code": fault.code, "message": fault.message]])
            }
        } catch {
            let message = error.localizedDescription
            let known = ["invalid_request", "invalid_client", "invalid_target", "invalid_grant", "invalid_scope", "unsupported_grant_type", "temporarily_unavailable"]
            return .json(["error": known.contains(message) ? message : "invalid_request"], status: 400)
        }
    }
}
#endif
