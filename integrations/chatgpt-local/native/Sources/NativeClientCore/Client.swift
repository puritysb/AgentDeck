import Foundation
import Security
import CryptoKit

public final class LocalClient {
    let endpoint: Endpoint
    let vault: any CredentialVault
    let transport: any Transport
    let clock: () -> Int
    let sleep: (TimeInterval) -> Void
    private var failedAccess: String?
    private let acquireLock: () throws -> AnyObject?
    public init(endpoint: Endpoint, vault: any CredentialVault, transport: any Transport = LocalHTTP(),
                clock: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }, sleep: @escaping (TimeInterval) -> Void = Thread.sleep, acquireLock: @escaping () throws -> AnyObject? = { nil }) {
        self.endpoint = endpoint; self.vault = vault; self.transport = transport; self.clock = clock; self.sleep = sleep; self.acquireLock = acquireLock
    }
    static func random() throws -> String {
        var data = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, data.count, &data) == errSecSuccess else { throw ClientFailure.unavailable }
        return base64url(Data(data))
    }
    static func base64url(_ data: Data) -> String { data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
    static func challenge(_ verifier: String) -> String { base64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }
    static func form(_ fields: [String: String]) -> String {
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")
        return fields.keys.sorted().map { $0.addingPercentEncoding(withAllowedCharacters: allowed)! + "=" + fields[$0]!.addingPercentEncoding(withAllowedCharacters: allowed)! }.joined(separator: "&")
    }
    func http(_ path: String, method: String, body: Data? = nil, bearer: String? = nil, form: Bool = false) throws -> HTTPReply {
        let url = try endpoint.url(path)
        let route = String(path.split(separator: "?", maxSplits: 1)[0])
        guard (["/oauth/authorize", "/oauth/status"].contains(route) ? method == "GET" : method == "POST"),
              body == nil || body!.count <= Contract.bodyLimit else { throw ClientFailure.invalidInput }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Contract.timeout)
        request.httpMethod = method; request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue(form ? "application/x-www-form-urlencoded" : "application/json", forHTTPHeaderField: "Content-Type") }
        if let bearer { request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization") }
        if route == "/mcp" { request.setValue(Canonical.protocolVersion, forHTTPHeaderField: "MCP-Protocol-Version") }
        return try transport.send(request)
    }
    func token(_ body: Data) throws -> Credentials {
        let data = try Contract.object(body)
        guard data["token_type"] as? String == "Bearer", data["resource"] as? String == endpoint.resource,
              let scope = data["scope"] as? String, scope.split(separator: " ").map(String.init).sorted() == DotLocalMCP.advertisedScopes.sorted(),
              let seconds = Contract.integer(data["expires_in"]), seconds > 0, seconds <= DotOAuthLimits.accessMs / 1000,
              let access = data["access_token"] as? String, let refresh = data["refresh_token"] as? String else { throw ClientFailure.invalidResponse }
        let result = Credentials(resource: endpoint.resource, clientID: DotLocalMCP.clientId, access: access, refresh: refresh, expiresAt: clock() + seconds * 1000, refreshing: false)
        try result.validate(endpoint: endpoint); return result
    }
    /// A fresh grant. This client never reads the privileged operator credential or approves itself.
    public func authorize(pending: ([String: Any]) throws -> Void) throws {
        let ownership = try acquireLock(); defer { withExtendedLifetime(ownership) {} }
        guard try vault.load() == nil else { throw ClientFailure.connectionExists }
        let verifier = try Self.random(), state = try Self.random()
        let redirect = "http://\(DotLocalMCP.host):\(DotLocalMCP.callbackPort)\(DotLocalMCP.callbackPath)"
        let fields = ["response_type": "code", "client_id": DotLocalMCP.clientId, "redirect_uri": redirect, "resource": endpoint.resource,
                      "scope": DotLocalMCP.advertisedScopes.joined(separator: " "), "state": state, "code_challenge_method": "S256", "code_challenge": Self.challenge(verifier)]
        let start = try http("/oauth/authorize?" + Self.form(fields), method: "GET")
        guard start.status == 302 else { throw Self.authorizationFailure(start.status) }
        guard let rawLocation = start.location else { throw ClientFailure.invalidResponse }
        let location = rawLocation.hasPrefix(endpoint.resource + "/") ? String(rawLocation.dropFirst(endpoint.resource.count)) : rawLocation
        guard location.range(of: "^/oauth/status\\?id=[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw ClientFailure.invalidResponse }
        let id = String(location.suffix(43))
        try pending(["consentId": id, "verificationCode": String(id.prefix(8)), "scopes": DotLocalMCP.advertisedScopes])
        let deadline = clock() + DotOAuthLimits.consentMs
        while clock() < deadline {
            let reply = try http(location, method: "GET")
            if reply.status == 302 {
                guard let raw = reply.location, let callback = URLComponents(string: raw), callback.scheme == "http", callback.host == DotLocalMCP.host,
                      callback.port == DotLocalMCP.callbackPort, callback.path == DotLocalMCP.callbackPath, callback.user == nil, callback.password == nil,
                      callback.fragment == nil, let items = callback.queryItems else { throw ClientFailure.invalidResponse }
                guard items.count == 3, Set(items.map(\.name)).count == 3,
                      items.first(where: { $0.name == "state" })?.value == state,
                      items.first(where: { $0.name == "iss" })?.value == endpoint.resource else { throw ClientFailure.invalidResponse }
                if Set(items.map(\.name)) == Set(["error", "state", "iss"]),
                   items.first(where: { $0.name == "error" })?.value == "access_denied" { throw ClientFailure.authorizationDenied }
                guard Set(items.map(\.name)) == Set(["code", "state", "iss"]),
                      let code = items.first(where: { $0.name == "code" })?.value, code.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw ClientFailure.authorizationRequired }
                let response = try http("/oauth/token", method: "POST", body: Data(Self.form(["grant_type": "authorization_code", "client_id": DotLocalMCP.clientId,
                    "resource": endpoint.resource, "redirect_uri": redirect, "code": code, "code_verifier": verifier]).utf8), form: true)
                guard response.status == 200 else { throw Self.authorizationFailure(response.status) }
                let saved = try token(response.body)
                do { try vault.save(saved) } catch {
                    // The exchanged grant must not silently remain usable after failed custody.
                    _ = try? http("/oauth/revoke", method: "POST", body: Data(Self.form(["client_id": saved.clientID, "token": saved.refresh]).utf8), form: true)
                    throw error
                }
                return
            }
            guard reply.status == 200 else { throw Self.authorizationFailure(reply.status) }
            sleep(min(1, Double(max(0, deadline - clock())) / 1000))
        }
        throw ClientFailure.deadline
    }
    private static func authorizationFailure(_ status: Int) -> ClientFailure {
        status == 429 || status >= 500 ? .unavailable : .authorizationRequired
    }
    private func access() throws -> String {
        guard var saved = try vault.load() else { throw ClientFailure.authorizationRequired }
        try saved.validate(endpoint: endpoint)
        guard !saved.refreshing, failedAccess != saved.access else { throw ClientFailure.reconnectRequired }
        if saved.expiresAt - clock() > 30_000 { return saved.access }
        // A failed marker save sent no refresh request. Preserve the storage error
        // so a temporarily locked Keychain can recover without replacing the grant.
        saved.refreshing = true; try vault.save(saved)
        do {
            let response = try http("/oauth/token", method: "POST", body: Data(Self.form(["grant_type": "refresh_token", "client_id": saved.clientID,
                "resource": endpoint.resource, "refresh_token": saved.refresh]).utf8), form: true)
            guard response.status == 200 else { throw ClientFailure.authorizationRequired }
            let next = try token(response.body); try vault.save(next); return next.access
        } catch { failedAccess = saved.access; throw ClientFailure.reconnectRequired }
    }
    public func call(tool: String, arguments: [String: Any], requestID: String? = nil) throws -> [String: Any] {
        try Contract.validateCall(tool: tool, arguments: arguments, requestID: requestID)
        let ownership = try acquireLock(); defer { withExtendedLifetime(ownership) {} }
        let id = UUID().uuidString
        let body = try Contract.encode(["jsonrpc": "2.0", "id": id, "method": "tools/call", "params": ["name": tool, "arguments": arguments]])
        let bearer = try access()
        let response = try http("/mcp", method: "POST", body: body, bearer: bearer)
        if response.status == 401 || response.status == 403 { failedAccess = bearer; throw ClientFailure.reconnectRequired }
        guard response.status == 200 else { throw ClientFailure.unavailable }
        let rpc = try Contract.object(response.body)
        guard rpc["jsonrpc"] as? String == "2.0", rpc["id"] as? String == id, rpc["error"] == nil,
              let result = rpc["result"] as? [String: Any] else { throw ClientFailure.invalidResponse }
        // Preserve tool-level errors as MCP results, never convert them to success.
        return result
    }
    public func disconnect() throws {
        let ownership = try acquireLock(); defer { withExtendedLifetime(ownership) {} }
        guard let saved = try vault.load() else { return }
        try saved.validate(endpoint: endpoint)
        let response = try http("/oauth/revoke", method: "POST", body: Data(Self.form(["client_id": saved.clientID, "token": saved.refresh]).utf8), form: true)
        guard response.status == 200 else { throw ClientFailure.unavailable }
        try vault.remove()
    }
}

public final class MCPFrontend {
    private let client: LocalClient
    private let requestID: String?
    public init(client: LocalClient, requestID: String? = nil) { self.client = client; self.requestID = requestID }
    public func handle(_ rpc: [String: Any]) -> [String: Any]? {
        let id = rpc["id"]
        func rpcError(_ code: Int, _ message: String) -> [String: Any] { ["jsonrpc": "2.0", "id": id ?? NSNull(), "error": ["code": code, "message": message]] }
        guard rpc["jsonrpc"] as? String == "2.0", let method = rpc["method"] as? String,
              id == nil || id is String || Contract.integer(id) != nil else { return rpcError(-32600, "Invalid request") }
        if id == nil {
            return ["notifications/initialized", "notifications/cancelled"].contains(method) ? nil : rpcError(-32600, "Unsupported notification")
        }
        do {
            let result: [String: Any]
            switch method {
            case "initialize":
                guard let params = rpc["params"] as? [String: Any], params["protocolVersion"] is String,
                      params["capabilities"] is [String: Any], params["clientInfo"] is [String: Any] else { throw ClientFailure.invalidInput }
                result = ["protocolVersion": Canonical.protocolVersion, "capabilities": ["tools": [:]],
                          "serverInfo": ["name": "agentdeck-local-native-preview", "version": "0.1.0"],
                          "instructions": "Read explicitly shared requests and context, then claim before reporting. Reports describe the request, not global Dot status. Local authorization must already exist."]
            case "ping": result = [:]
            case "tools/list": result = ["tools": Contract.tools]
            case "tools/call":
                guard let params = rpc["params"] as? [String: Any], let tool = params["name"] as? String, let args = params["arguments"] as? [String: Any] else { throw ClientFailure.invalidInput }
                result = try client.call(tool: tool, arguments: args, requestID: requestID)
            default: return rpcError(-32601, "Unsupported method")
            }
            return ["jsonrpc": "2.0", "id": id!, "result": result]
        } catch let failure as ClientFailure { return rpcError(-32001, failure.description) }
        catch { return rpcError(-32602, "Invalid request or local connection unavailable") }
    }
}
