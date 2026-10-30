#if os(macOS)
import Foundation

/// Pure v1 wire rules. Never permits a remote row to acquire a local port/control mode.
enum DaemonRelayRules {
    static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }
    static func bool(_ value: Any?) -> Bool? {
        guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return nil }; return n.boolValue
    }
    static func sanitize(_ raw: Any?) -> [[String: Any]] {
        guard let rows = raw as? [Any] else { return [] }
        var result: [[String: Any]] = [], seen = Set<String>()
        for raw in rows {
            if result.count >= DaemonRelayPolicy.RELAY_MAX_ROWS { break }
            guard let row = raw as? [String: Any], let id = row["id"] as? String, !id.isEmpty,
                  !seen.contains(id), row["controlMode"] as? String != "managed", id != "openclaw-gateway" else { continue }
            seen.insert(id)
            var out: [String: Any] = ["id":id,"port":0,"alive":bool(row["alive"]) != false,"controlMode":"observed","projectName":"remote"]
            for key in DaemonRelayPolicy.RELAY_STRING_FIELDS {
                if let v = row[key] as? String, !v.isEmpty { out[key] = String(decoding:v.utf16.prefix(DaemonRelayPolicy.RELAY_MAX_STRING),as:UTF16.self) }
            }
            for key in DaemonRelayPolicy.RELAY_NUMBER_FIELDS { if let n = number(row[key]) { out[key] = n } }
            for key in DaemonRelayPolicy.RELAY_BOOLEAN_FIELDS { if let b = bool(row[key]) { out[key] = b } }
            for key in DaemonRelayPolicy.RELAY_OBJECT_FIELDS { if let obj = row[key] as? [String: Any] { out[key] = obj } }
            if row["waitingOn"] is NSNull || row["waitingOn"] is [String: Any] { out["waitingOn"] = row["waitingOn"] }
            if let weight = number(row["weight"]) { out["weight"] = SessionWeightRules.clamp(Int(max(Double(Int32.min),min(Double(Int32.max),weight.rounded(.towardZero))))) }
            if let options = row["options"] as? [Any] {
                out["options"] = options.compactMap { raw -> [String:Any]? in
                    guard let option = raw as? [String:Any], option["label"] is String else { return nil }
                    return option.filter { $0.value is String || bool($0.value) != nil || number($0.value) != nil }
                }.prefix(DaemonRelayPolicy.RELAY_MAX_OPTIONS).map { $0 }
            }
            if let folded = row["foldedSessionIds"] as? [Any] { out["foldedSessionIds"] = Array(folded.compactMap { $0 as? String }.prefix(DaemonRelayPolicy.RELAY_MAX_ROWS)) }
            result.append(out)
        }
        return result
    }
    static func publish(_ rows: [[String:Any]], excluding: Set<String>) -> [[String:Any]] {
        rows.filter { row in
            guard let id = row["id"] as? String else { return false }
            return !id.isEmpty && id != "openclaw-gateway" && row["controlMode"] as? String != "managed" && !excluding.contains(id)
        }.map { row in row.filter { !DaemonRelayPolicy.RELAY_VOLATILE_FIELDS.contains($0.key) } }
    }
    static func data(_ object: Any) -> Data? {
        guard JSONSerialization.isValidJSONObject(object) else { return nil }
        return try? JSONSerialization.data(withJSONObject:object,options:[.sortedKeys])
    }
    /// Runs only after live relay routing. Unknown/retired remote focus and
    /// scoped ids must never become a local/gateway focused-command fallback.
    static func rejectsLocalFallback(_ cmd: [String:Any], focused: String?, local: Set<String>) -> Bool {
        guard let type = cmd["type"] as? String,
              ["session_command","interrupt","escape","send_prompt","respond","select_option","navigate_option","switch_mode"].contains(type) else { return false }
        if let sid = cmd["sessionId"] as? String { return sid != "openclaw-gateway" && !local.contains(sid) }
        if let focused { return focused != "openclaw-gateway" && !local.contains(focused) }
        return false
    }
    /// Native worker gate is deliberately narrower than Node's terminal-capable gate.
    static func nativeCommand(_ raw: Any?, published: [[String:Any]], current: [[String:Any]]) -> [String:Any]? {
        guard let cmd = raw as? [String:Any], let type = cmd["type"] as? String else { return nil }
        let publishedIds = Set(published.compactMap { $0["id"] as? String })
        let current = current.filter { row in
            (row["controlMode"] as? String) == "observed" && ((row["agentType"] as? String) == "claude-code" || bool(row["_relayHeldCodex"]) == true)
        }
        if type == "permission_decision" {
            guard let rid = cmd["requestId"] as? String, let decision = cmd["decision"] as? String, ["allow","deny"].contains(decision),
                  let row = current.first(where: { $0["requestId"] as? String == rid }), let sid = row["id"] as? String,
                  bool(row["_relayHeldAsk"]) != true, publishedIds.contains(sid), published.contains(where: { $0["id"] as? String == sid && $0["requestId"] as? String == rid }) else { return nil }
            return ["type":type,"requestId":rid,"decision":decision]
        }
        guard let sid = cmd["sessionId"] as? String, publishedIds.contains(sid), let row = current.first(where: { $0["id"] as? String == sid }) else { return nil }
        let inner: [String:Any]
        if type == "session_command", let c = cmd["command"] as? [String:Any] { inner = c }
        else if type == "select_option" { inner = cmd }
        else { return nil }
        guard let kind = inner["type"] as? String else { return nil }
        var safe: [String:Any] = ["type":kind]
        switch kind {
        case "interrupt", "escape":
            guard row["agentType"] as? String == "claude-code" else { return nil } // hook soft stop only
        case "send_prompt":
            guard row["agentType"] as? String == "claude-code" else { return nil }
            guard let text = inner["text"] as? String, !text.isEmpty, text.utf8.count <= DaemonRelayPolicy.RELAY_MAX_MESSAGE_BYTES else { return nil }; safe["text"] = text
        case "select_option", "respond":
            guard let rid = row["requestId"] as? String,
                  published.contains(where: { $0["id"] as? String == sid && $0["requestId"] as? String == rid }) else { return nil }
            if bool(row["_relayHeldAsk"]) == true {
                guard kind == "select_option", let echo = inner["question"] as? String, !echo.isEmpty else { return nil }
            }
            if kind == "select_option" {
                guard let index = number(inner["index"]), index >= 0, index.rounded() == index, index <= Double(Int32.max) else { return nil }; safe["index"] = Int(index)
            } else {
                guard let value = inner["value"] as? String, ["y","yes","n","no"].contains(value.lowercased()) else { return nil }; safe["value"] = value
            }
            if let question = inner["question"] as? String { safe["question"] = question }
        default: return nil
        }
        return ["type":"session_command","sessionId":sid,"command":safe]
    }
}

@DaemonActor
final class DaemonRelayHub {
    struct Worker {
        let instance: String
        let send: @DaemonActor ([String:Any]) -> Void
        var rows: [[String:Any]] = []
        var fingerprint = Data()
        var at: TimeInterval
        var expired = false
    }
    let instanceId: String
    private var workers: [UUID:Worker] = [:]
    private var order: [UUID] = []
    private var knownIds: [String] = []
    var allKnownIds: Set<String> { Set(knownIds) }
    var onChange: @DaemonActor () -> Void = {}
    init(instanceId: String) { self.instanceId = instanceId }
    func contains(_ socket: UUID) -> Bool { workers[socket] != nil }
    @discardableResult
    func handle(_ frame: [String:Any], socket: UUID, now: TimeInterval = Date().timeIntervalSince1970,
                send: @escaping @DaemonActor ([String:Any]) -> Void) -> Bool {
        guard let type = frame["type"] as? String else { return false }
        guard type.hasPrefix("relay_") else { return false }
        guard let data = DaemonRelayRules.data(frame), data.count <= DaemonRelayPolicy.RELAY_MAX_MESSAGE_BYTES else {
            drop(socket); send(["type":"relay_refused","reason":"invalid or oversized frame"]); return true
        }
        if type == "relay_hello" {
            guard DaemonRelayRules.number(frame["v"]) == Double(DaemonRelayPolicy.RELAY_PROTOCOL_VERSION),
                  let instance = frame["instanceId"] as? String, !instance.isEmpty, instance != instanceId,
                  instance.utf8.count <= DaemonRelayPolicy.RELAY_MAX_STRING else {
                send(["type":"relay_refused","reason":"unsupported protocol or invalid/self instance"]); return true
            }
            for id in Array(order) where workers[id]?.instance == instance || id == socket { workers.removeValue(forKey:id); order.removeAll { $0 == id } }
            guard workers.count < DaemonRelayPolicy.RELAY_MAX_WORKERS else { send(["type":"relay_refused","reason":"worker limit"]); return true }
            order.append(socket); workers[socket] = Worker(instance:instance,send:send,at:now)
            send(["type":"relay_ack","v":DaemonRelayPolicy.RELAY_PROTOCOL_VERSION]); onChange(); return true
        }
        if type == "relay_sessions" {
            guard var worker = workers[socket] else { return true }
            let rows = DaemonRelayRules.sanitize(frame["sessions"]), fingerprint = DaemonRelayRules.data(rows) ?? Data()
            for row in rows { if let id = row["id"] as? String, !knownIds.contains(id) { knownIds.append(id) } }
            knownIds = Array(knownIds.suffix(DaemonRelayPolicy.RELAY_MAX_ROWS * DaemonRelayPolicy.RELAY_MAX_WORKERS))
            let changed = fingerprint != worker.fingerprint || stale(worker,now)
            worker.rows = rows; worker.fingerprint = fingerprint; worker.at = now; worker.expired = false
            workers[socket] = worker; if changed { onChange() }; return true
        }
        return type == "relay_command_refused" || type.hasPrefix("relay_")
    }
    func drop(_ socket: UUID) { if workers.removeValue(forKey:socket) != nil { order.removeAll { $0 == socket }; onChange() } }
    func stop() { workers.removeAll(); order.removeAll(); knownIds.removeAll() }
    private func stale(_ w: Worker,_ now: TimeInterval) -> Bool { now < w.at || (now-w.at)*1000 > Double(DaemonRelayPolicy.RELAY_ROW_TTL_MS) }
    func sweep(now: TimeInterval = Date().timeIntervalSince1970) {
        var changed = false
        for id in order {
            if var w = workers[id], stale(w,now), !w.expired, !w.rows.isEmpty { w.expired = true; workers[id] = w; changed = true }
        }
        if changed { onChange() }
    }
    func rows(now: TimeInterval = Date().timeIntervalSince1970) -> [[String:Any]] {
        var seen = Set<String>(), result: [[String:Any]] = []
        let fractional = ISO8601DateFormatter(); fractional.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        for id in order {
            guard let w = workers[id], !stale(w,now) else { continue }
            for row in w.rows {
                guard let sid = row["id"] as? String, seen.insert(sid).inserted else { continue }
                var display = row
                // Workers strip elapsedSec to avoid a snapshot every second;
                // the hub derives it for clocks-less displays (Node parity).
                if let text = row["startedAt"] as? String, let started = fractional.date(from:text) ?? plain.date(from:text) {
                    let seconds = max(0, now-started.timeIntervalSince1970)
                    if seconds < Double(Int.max) { display["elapsedSec"] = Int(seconds) }
                }
                result.append(display)
            }
        }; return result
    }
    func route(_ cmd: [String:Any], focused: String?, local: [[String:Any]]) -> Bool {
        let localIds = Set(local.compactMap { $0["id"] as? String }), localRequests = Set(local.compactMap { $0["requestId"] as? String })
        let current = rows(), type = cmd["type"] as? String ?? ""
        var command = cmd, sid = cmd["sessionId"] as? String
        if type == "permission_decision", let rid = cmd["requestId"] as? String {
            guard !localRequests.contains(rid) else { return false }; sid = current.first { $0["requestId"] as? String == rid }?["id"] as? String
        } else if !["session_command","select_option"].contains(type) || sid == nil {
            guard sid == nil, ["interrupt","escape","send_prompt","respond","select_option"].contains(type), let focused else { return false }
            sid = focused; command = ["type":"session_command","sessionId":focused,"command":cmd]
        }
        guard let sid, !localIds.contains(sid) else { return false }
        guard current.contains(where: { $0["id"] as? String == sid }) else { return knownIds.contains(sid) }
        for id in order {
            guard let w = workers[id], !stale(w,Date().timeIntervalSince1970), w.rows.contains(where: { $0["id"] as? String == sid }) else { continue }
            w.send(["type":"relay_command_down","command":command]); return true
        }; return true
    }
}
#endif
