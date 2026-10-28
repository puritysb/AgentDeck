import Foundation
import CoreFoundation

public enum ClientFailure: Error, CustomStringConvertible, Equatable {
    case invalidInput, unavailable, authorizationRequired, authorizationDenied, connectionExists, reconnectRequired
    case unsafeStorage, keychain(Int32), busy, oversized, deadline, invalidResponse
    public var description: String {
        switch self {
        case .invalidInput: "Input rejected."
        case .unavailable: "Local AgentDeck is unavailable; writes were not retried."
        case .authorizationRequired: "Local authorization is required. Run authorize and approve in AgentDeck."
        case .authorizationDenied: "The connection was declined in AgentDeck. No client credentials were saved."
        case .connectionExists: "This account already has local credentials. Use the existing connection, or run disconnect with the same account and port before authorizing again."
        case .reconnectRequired: "Local credentials can no longer be used safely. With AgentDeck available, run disconnect with the same account and port, then authorize and approve again. Writes were not retried."
        case .unsafeStorage: "Private local storage is unavailable or unsafe."
        case .keychain(let code): "Keychain unavailable (\(code)); no file fallback was used."
        case .busy: "Another client owns this local connection."
        case .oversized: "Input or response exceeded the contract limit."
        case .deadline: "Local operation timed out; writes were not retried."
        case .invalidResponse: "Local AgentDeck returned an invalid response."
        }
    }
}

public struct Endpoint: Sendable {
    public let port: Int
    public var resource: String { "http://\(DotLocalMCP.host):\(port)" }
    public init(port: Int? = nil) throws {
        let value = port ?? DotLocalMCP.port
        // These ports belong to the hub/session bridges and the privileged operator API.
        guard (1024...65535).contains(value), !(9120...9139).contains(value), value != DotLocalMCP.controlPort else { throw ClientFailure.invalidInput }
        self.port = value
    }
    func url(_ path: String) throws -> URL {
        let routes = ["/oauth/authorize", "/oauth/status", "/oauth/token", "/oauth/revoke", "/mcp"]
        guard routes.contains(String(path.split(separator: "?", maxSplits: 1)[0])), let url = URL(string: resource + path),
              url.host == DotLocalMCP.host, url.port == port, url.user == nil, url.password == nil, url.fragment == nil else { throw ClientFailure.invalidInput }
        return url
    }
}

public enum Contract {
    public static var bodyLimit: Int { DotLimits.bodyBytes }
    public static var timeout: TimeInterval { Double(DotLimits.callbackMs) / 1000 }
    static let allowedTools = Set(["get_request", "get_context", "claim_request", "report_update"])
    public static var tools: [[String: Any]] {
        let document = try! JSONSerialization.jsonObject(with: Canonical.contractData) as! [String: Any]
        return (document["tools"] as! [[String: Any]]).filter { allowedTools.contains($0["name"] as? String ?? "") }
    }
    static func integer(_ value: Any?) -> Int? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite,
              n.doubleValue.rounded(.towardZero) == n.doubleValue, abs(n.doubleValue) <= 9007199254740991 else { return nil }
        return n.intValue
    }
    static func validate(_ value: Any, schema: [String: Any]) throws {
        func reject() throws -> Never { throw ClientFailure.invalidInput }
        switch schema["type"] as? String {
        case "object":
            guard let object = value as? [String: Any] else { try reject() }
            let props = schema["properties"] as? [String: [String: Any]] ?? [:]
            if (schema["required"] as? [String] ?? []).contains(where: { object[$0] == nil }) { try reject() }
            if schema["additionalProperties"] as? Bool == false, object.keys.contains(where: { props[$0] == nil }) { try reject() }
            for (key, item) in object { if let definition = props[key] { try validate(item, schema: definition) } }
        case "string":
            guard let string = value as? String else { try reject() }
            let count = string.unicodeScalars.count
            if let min = schema["minLength"] as? Int, count < min { try reject() }
            if let max = schema["maxLength"] as? Int, count > max { try reject() }
            if let pattern = schema["pattern"] as? String, string.range(of: pattern, options: .regularExpression) == nil { try reject() }
        case "integer":
            guard let n = integer(value) else { try reject() }
            if let min = integer(schema["minimum"]), n < min { try reject() }
            if let max = integer(schema["maximum"]), n > max { try reject() }
        default: if schema["enum"] == nil { try reject() }
        }
        if let options = schema["enum"] as? [String], !options.contains(value as? String ?? "") { try reject() }
    }
    public static func validateCall(tool: String, arguments: [String: Any], requestID: String?) throws {
        guard let definition = tools.first(where: { $0["name"] as? String == tool }), let schema = definition["inputSchema"] as? [String: Any] else { throw ClientFailure.invalidInput }
        try validate(arguments, schema: schema)
        if let requestID, arguments["requestId"] as? String != requestID { throw ClientFailure.invalidInput }
    }
    public static func encode(_ value: Any) throws -> Data {
        // Foundation can raise an Objective-C exception for invalid graphs; Swift catch cannot recover it.
        guard JSONSerialization.isValidJSONObject(value) else { throw ClientFailure.invalidInput }
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        guard data.count <= bodyLimit else { throw ClientFailure.oversized }
        return data
    }
    public static func object(_ data: Data) throws -> [String: Any] {
        guard data.count <= bodyLimit else { throw ClientFailure.oversized }
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClientFailure.invalidInput }
        return value
    }
}
