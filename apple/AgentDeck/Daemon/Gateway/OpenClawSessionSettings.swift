import Foundation

/// Deck-switchable settings of one OpenClaw session, in the Gateway's own words
/// (#463). Swift mirror of `openClawSessionSettings` in
/// `shared/src/session-settings.ts` — same precedence, same refusals:
///
/// - effort: the row's `thinkingLevels` ({id,label}), else its legacy
///   `thinkingOptions`, else the list `defaults`; current = `thinkingLevel`,
///   else the default; default = `thinkingDefault`.
/// - model: only when the `models.list` catalog lists something; current =
///   `modelProvider/model`; default = the catalog's `role: default` entry, else
///   the list defaults; `overridden` when `modelOverrideSource` is set.
///
/// Nothing is ever invented: a value the Gateway did not report is absent.
/// Output is the wire shape of `SessionSetting` (shared/src/protocol.ts).
enum OpenClawSessionSettings {
    /// A read crossing from the adapter actor to `@DaemonActor`. The dictionaries
    /// are built fresh per read and never mutated afterwards.
    struct Read: @unchecked Sendable {
        let settings: [[String: Any]]
        let error: String?
        let targetSessionKey: String?

        init(settings: [[String: Any]], error: String?, targetSessionKey: String? = nil) {
            self.settings = settings
            self.error = error
            self.targetSessionKey = targetSessionKey
        }
    }

    struct Command: Sendable {
        let requestId: String
        let sessionId: String
        let isSet: Bool
        let targetSessionKey: String?
        let key: String?
        let value: String?
        let error: String?
    }

    /// Missing/non-string values are invalid. Only explicit JSON null clears.
    /// Uncorrelatable requests are dropped; a valid request id receives an error.
    static func command(_ input: [String: Any]) -> Command? {
        guard let type = input["type"] as? String,
              type == "query_session_settings" || type == "set_session_setting",
              let requestId = boundedText(input["requestId"], max: SessionSettingsRules.maxRequestIdLength),
              let sessionId = input["sessionId"] as? String,
              !sessionId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let isSet = type == "set_session_setting"
        let target = boundedText(input["targetSessionKey"], max: SessionSettingsRules.maxTargetKeyLength)
        let key = input["key"] as? String
        let value = input["value"] as? String
        var error: String?
        if isSet {
            if target == nil { error = "Invalid targetSessionKey" }
            else if key != "model" && key != "effort" { error = "Invalid setting key" }
            else if !(input["value"] is NSNull), boundedText(input["value"], max: SessionSettingsRules.maxValueLength) == nil {
                error = "Invalid setting value"
            }
        }
        return Command(requestId: requestId, sessionId: sessionId, isSet: isSet,
            targetSessionKey: target, key: key, value: value, error: error)
    }

    static func boundedText(_ value: Any?, max: Int) -> String? {
        guard let string = value as? String, string.utf16.count <= max,
              !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return string
    }

    static func settings(
        row: [String: Any],
        defaults: [String: Any]?,
        catalog: [[String: Any]]?
    ) -> [[String: Any]] {
        var out: [[String: Any]] = []

        let models = (catalog ?? []).filter {
            ($0["available"] as? Bool) != false && text($0["key"]) != nil
        }
        if !models.isEmpty {
            var setting: [String: Any] = ["key": "model"]
            if let current = modelKey(row) { setting["current"] = current }
            let defaultModel = models.first { $0["role"] as? String == "default" }.flatMap { text($0["key"]) }
                ?? defaults.flatMap(modelKey)
            if let defaultModel { setting["default"] = defaultModel }
            if let source = row["modelOverrideSource"], !(source is NSNull) { setting["overridden"] = true }
            setting["options"] = models.compactMap { entry -> [String: Any]? in
                guard let key = text(entry["key"]) else { return nil }
                if let name = text(entry["name"]), name != key { return ["id": key, "label": name] }
                return ["id": key]
            }
            out.append(setting)
        }

        if let levels = thinkingOptions(row) ?? defaults.flatMap(thinkingOptions) {
            var setting: [String: Any] = ["key": "effort", "options": levels]
            let thinkingDefault = text(row["thinkingDefault"]) ?? defaults.flatMap { text($0["thinkingDefault"]) }
            if let current = text(row["thinkingLevel"]) ?? thinkingDefault { setting["current"] = current }
            if let thinkingDefault { setting["default"] = thinkingDefault }
            out.append(setting)
        }
        return out
    }

    /// `sessions.patch` params for a deck choice; `nil` value clears the override.
    static func patchParams(sessionKey: String, key: String, value: String?) -> [String: Any]? {
        guard boundedText(sessionKey, max: SessionSettingsRules.maxTargetKeyLength) != nil,
              value == nil || boundedText(value, max: SessionSettingsRules.maxValueLength) != nil else { return nil }
        let field: String
        switch key {
        case "model": field = "model"
        case "effort": field = "thinkingLevel"
        default: return nil
        }
        return ["key": sessionKey, field: value.map { $0 as Any } ?? NSNull()]
    }

    #if os(macOS)
    /// Fresh immutable JSON dictionaries cross to the Gateway actor only in
    /// these boxes. The injected transport exercises the production operations.
    struct RPCRequest: @unchecked Sendable { let method: String; let params: [String: Any] }
    struct RPCReply: @unchecked Sendable { let ok: Bool; let payload: [String: Any]?; let error: String? }
    typealias RPC = @Sendable (RPCRequest) async -> RPCReply

    static func query(targetSessionKey: String?, rpc: RPC) async -> Read {
        guard let target = boundedText(targetSessionKey, max: SessionSettingsRules.maxTargetKeyLength) else {
            return Read(settings: [], error: "No OpenClaw session")
        }
        let listed = await rpc(RPCRequest(method: "sessions.list", params: [:]))
        guard listed.ok, let payload = listed.payload else {
            return Read(settings: [], error: listed.error ?? "sessions.list failed", targetSessionKey: target)
        }
        guard let rows = payload["sessions"] as? [[String: Any]],
              let row = rows.first(where: { $0["key"] as? String == target }) else {
            return Read(settings: [], error: "The OpenClaw session the deck targets is not listed", targetSessionKey: target)
        }
        let catalog = await rpc(RPCRequest(method: "models.list", params: [:]))
        let entries = catalog.ok ? catalog.payload.flatMap(OpenClawAdapter.projectModelCatalog)?.0 : nil
        return Read(settings: settings(row: row, defaults: payload["defaults"] as? [String: Any], catalog: entries),
            error: nil, targetSessionKey: target)
    }

    static func set(targetSessionKey: String, activeSessionKey: String?, key: String, value: String?, rpc: RPC) async -> String? {
        guard targetSessionKey == activeSessionKey else { return "OpenClaw session changed; query settings again" }
        guard let params = patchParams(sessionKey: targetSessionKey, key: key, value: value) else {
            return "Invalid setting key or value"
        }
        let response = await rpc(RPCRequest(method: "sessions.patch", params: params))
        return response.ok ? nil : (response.error ?? "sessions.patch failed")
    }
    #endif

    private static func thinkingOptions(_ row: [String: Any]) -> [[String: Any]]? {
        if let levels = row["thinkingLevels"] as? [[String: Any]] {
            let out = levels.compactMap { level -> [String: Any]? in
                guard let id = text(level["id"]) else { return nil }
                if let label = text(level["label"]), label != id { return ["id": id, "label": label] }
                return ["id": id]
            }
            if !out.isEmpty { return out }
        }
        if let ids = row["thinkingOptions"] as? [Any] {
            let out = ids.compactMap(text).map { ["id": $0] as [String: Any] }
            if !out.isEmpty { return out }
        }
        return nil
    }

    private static func modelKey(_ row: [String: Any]) -> String? {
        guard let model = text(row["model"]) else { return nil }
        if let provider = text(row["modelProvider"]), !model.contains("/") { return "\(provider)/\(model)" }
        return model
    }

    private static func text(_ value: Any?) -> String? {
        guard let s = value as? String else { return nil }
        let trimmed = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
