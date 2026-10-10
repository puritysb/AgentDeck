#if os(macOS)
import Foundation
import CoreFoundation

struct DotReport: Codable, Sendable { var sequence: Int; var state: String; var summary: String; var receivedAt: Int }
struct DotClaim: Codable, Sendable { var attemptId: String; var key: String; var expiresAt: Int }
struct DotBriefing: Codable, Identifiable, Sendable {
    var id: String; var owner: String; var profile: String; var key: String; var fingerprint: String
    var context: String; var capturedAt: Int; var createdAt: Int; var expiresAt: Int
    var eventId: String; var subscriptionId: String; var delivery: String; var attempts: Int; var nextAttemptAt: Int
    var interactions: [DotInteractionEvent]?; var interactionKeys: [String: String]?
    var claim: DotClaim?; var report: DotReport?; var reportKeys: [String: String] = [:]
}
private struct DotSubscription: Codable {
    var id: String; var owner: String; var profile: String; var url: String; var secret: String
    var expiresAt: Int; var verifiedUntil: Int; var previousSecret: String?; var previousUntil: Int?
}
private struct DotMCPState: Codable { var version = 1; var subscriptions: [DotSubscription] = []; var requests: [DotBriefing] = [] }
struct DotRPCError: Error { var code: Int; var message: String }

@DaemonActor
enum DotSchema {
    static func validate(_ value: Any, _ schema: [String: Any]) throws {
        func reject() throws -> Never { throw DotRPCError(code: -32602, message: "Input does not match the declared schema") }
        if let alternatives = schema["anyOf"] as? [[String: Any]] {
            for choice in alternatives { if (try? validate(value, choice)) != nil { return } }; try reject()
        }
        if let options = schema["enum"] as? [String], let string = value as? String, !options.contains(string) { try reject() }
        if let constant = schema["const"] as? String, value as? String != constant { try reject() }
        switch schema["type"] as? String {
        case "object":
            guard let object = value as? [String: Any] else { try reject() }
            let properties = schema["properties"] as? [String: [String: Any]] ?? [:]
            for name in schema["required"] as? [String] ?? [] { if object[name] == nil { try reject() } }
            if schema["additionalProperties"] as? Bool == false, object.keys.contains(where: { properties[$0] == nil }) { try reject() }
            for (key, item) in object { if let definition = properties[key] { try validate(item, definition) } }
        case "array":
            guard let array = value as? [Any] else { try reject() }
            if let limit = schema["maxItems"] as? Int, array.count > limit { try reject() }
            if let items = schema["items"] as? [String: Any] { for item in array { try validate(item, items) } }
        case "string":
            guard let string = value as? String else { try reject() }
            let count = string.unicodeScalars.count
            if let max = schema["maxLength"] as? Int, count > max { try reject() }
            if let min = schema["minLength"] as? Int, count < min { try reject() }
            if let pattern = schema["pattern"] as? String, string.range(of: pattern, options: .regularExpression) == nil { try reject() }
        case "integer":
            guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
                  number.doubleValue.rounded(.towardZero) == number.doubleValue,
                  abs(number.doubleValue) <= 9007199254740991 else { try reject() }
            if let min = schema["minimum"] as? Double, number.doubleValue < min { try reject() }
            if let max = schema["maximum"] as? Double, number.doubleValue > max { try reject() }
        case "null": if !(value is NSNull) { try reject() }
        case "boolean": guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { try reject() }
        default: break
        }
        if let values = schema["enum"] as? [String], !(value is String) || !values.contains(value as? String ?? "") { try reject() }
    }
}

@DaemonActor
final class DotMCPStore {
    private var state: DotMCPState
    private let file: URL
    private let clock: () -> Int
    private let access: (String) -> Bool
    private let send: (String, Data, [String: String]) async throws -> DotWebhookReply
    private var verifying: Set<String> = []
    private var revisions: [String: UUID] = [:]
    private var delivering = false
    private var epoch = UUID()
    let contract: [String: Any]
    init(file: URL, contract: Data, clock: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }, access: @escaping (String) -> Bool,
         send: @escaping (String, Data, [String: String]) async throws -> DotWebhookReply = { try await DotWebhook.send(url: $0, body: $1, headers: $2) }) throws {
        self.file = file; self.clock = clock; self.access = access; self.send = send
        guard let spec = try JSONSerialization.jsonObject(with: contract) as? [String: Any], spec["tools"] is [[String: Any]], spec["event"] is [String: Any] else { throw DotFailure.message("Invalid MCP contract.") }
        self.contract = spec
        if FileManager.default.fileExists(atPath: file.path) {
            let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
            guard (attrs[.size] as? Int ?? Int.max) <= DotLimits.records * DotLimits.bodyBytes else { throw DotFailure.message("Dot store is too large.") }
            state = try JSONDecoder().decode(DotMCPState.self, from: Data(contentsOf: file))
            guard state.version == 1, state.requests.count <= DotLimits.records, state.subscriptions.count <= DotLimits.records else { throw DotFailure.message("Invalid Dot store.") }
        } else { state = DotMCPState() }
        let validStamp: (Int) -> Bool = { $0 >= 0 && $0 <= 9007199254740991 }
        guard state.requests.allSatisfy({ row in
            [row.createdAt, row.capturedAt, row.expiresAt, row.nextAttemptAt].allSatisfy(validStamp)
            && row.context.unicodeScalars.count <= DotLimits.contextCharacters && row.attempts >= 0 && row.attempts <= DotLimits.attempts
            && row.reportKeys.count <= DotLimits.reportKeys && (row.interactions?.count ?? 0) <= DotLimits.interactionEvents && (row.interactionKeys?.count ?? 0) <= DotLimits.interactionEvents && ["local", "pending", "accepted", "failed", "expired", "cancelled"].contains(row.delivery)
        }), state.subscriptions.allSatisfy({ validStamp($0.expiresAt) && validStamp($0.verifiedUntil) }) else { throw DotFailure.message("Invalid persisted Dot data.") }
        let requestTool = (spec["tools"] as! [[String: Any]]).first { $0["name"] as? String == "get_request" }!
        let properties = (requestTool["outputSchema"] as! [String: Any])["properties"] as! [String: Any]
        let historySchema = properties["interactions"] as! [String: Any]
        for row in state.requests {
            try DotSchema.validate((row.interactions ?? []).map(\.dictionary), historySchema)
            var seen: [String: DotInteractionEvent] = [:]
            for event in row.interactions ?? [] {
                guard DotInteractionPolicy.allows(seen[event.relationId], event) else { throw DotFailure.message("Invalid persisted interaction history.") }
                seen[event.relationId] = event
            }
        }
    }
    private func change<T>(_ mutation: (inout DotMCPState) throws -> T) throws -> T {
        var next = state; let result = try mutation(&next)
        let directory = file.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try JSONEncoder().encode(next).write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
        state = next; return result
    }
    func stop() { epoch = UUID(); revisions.removeAll() }
    func requests() -> [DotBriefing] { state.requests.sorted { $0.createdAt > $1.createdAt } }
    func revoke(_ owner: String) throws {
        try change { s in s.subscriptions.removeAll { $0.owner == owner }; s.requests.removeAll { $0.owner == owner } }
        epoch = UUID()
    }
    func maintenance() throws {
        let now = clock(), revoked = Set(state.subscriptions.map(\.owner).filter { !access($0) } + state.requests.map(\.owner).filter { !access($0) })
        if state.subscriptions.contains(where: { $0.expiresAt <= now || revoked.contains($0.owner) || ($0.previousUntil ?? Int.max) <= now }) || state.requests.contains(where: { revoked.contains($0.owner) || $0.createdAt + DotLimits.retentionMs <= now || ($0.expiresAt <= now && !$0.context.isEmpty) }) {
            try change { s in
                s.subscriptions.removeAll { $0.expiresAt <= now || revoked.contains($0.owner) }
                for i in s.subscriptions.indices where (s.subscriptions[i].previousUntil ?? Int.max) <= now { s.subscriptions[i].previousSecret = nil; s.subscriptions[i].previousUntil = nil }
                s.requests.removeAll { revoked.contains($0.owner) || $0.createdAt + DotLimits.retentionMs <= now }
                for i in s.requests.indices where s.requests[i].expiresAt <= now { s.requests[i].context = "" }
            }
        }
    }
    private func view(_ r: DotBriefing) -> [String: Any] {
        ["interactions": (r.interactions ?? []).map(\.dictionary), "requestId": r.id, "integrationId": r.profile, "createdAt": r.createdAt, "expiresAt": r.expiresAt,
         "delivery": r.delivery, "attempts": r.attempts,
         "claim": r.claim.map { ["attemptId": $0.attemptId, "expiresAt": $0.expiresAt] as [String: Any] } as Any? ?? NSNull(),
         "report": r.report.map { ["sequence": $0.sequence, "state": $0.state, "summary": $0.summary, "receivedAt": $0.receivedAt] as [String: Any] } as Any? ?? NSNull()]
    }
    func create(owner: String, profile: String, context: String, key: String, local: Bool = false) throws {
        guard access(owner), !context.isEmpty, context.unicodeScalars.count <= DotLimits.contextCharacters else { throw DotFailure.message("Choose a connected account and share at most 8,000 characters.") }
        let now = clock(), fingerprint = dotDigest(profile + "\n" + context)
        try change { s in
            if let prior = s.requests.first(where: { $0.owner == owner && $0.key == key }) {
                guard prior.fingerprint == fingerprint else { throw DotFailure.message("Request key conflict.") }; return
            }
            let sub = s.subscriptions.first(where: { $0.owner == owner && $0.profile == profile && $0.expiresAt > now })
            guard local || sub != nil else { throw DotFailure.message("Ask Dot to subscribe to this integration profile first.") }
            guard s.requests.count < DotLimits.records else { throw DotFailure.message("Request storage is full. Disconnect to clear local history, or wait for automatic expiry.") }
            s.requests.append(.init(id: "req_" + UUID().uuidString, owner: owner, profile: profile, key: key, fingerprint: fingerprint,
                context: context, capturedAt: now, createdAt: now, expiresAt: now + DotLimits.requestMs, eventId: "evt_" + UUID().uuidString,
                subscriptionId: local ? "" : sub!.id, delivery: local ? "local" : "pending", attempts: 0, nextAttemptAt: now))
        }
    }
    func rpc(grant: DotGrant, method: String, params: [String: Any]) async throws -> [String: Any] {
        guard access(grant.id) else { throw DotRPCError(code: -32003, message: "Access revoked") }
        let event = contract["event"] as! [String: Any], tools = contract["tools"] as! [[String: Any]]
        switch method {
        case "server/discover": return ["resultType": "complete", "supportedVersions": [contract["version"]!], "capabilities": ["tools": [:], "events": [:]]]
        case "tools/list": return ["tools": tools.filter { grant.scopes.contains(($0["annotations"] as? [String: Any])?["readOnlyHint"] as? Bool == true ? "agentdeck:read" : "agentdeck:report") }]
        case "events/list", "events/subscribe", "events/unsubscribe":
            guard grant.scopes.contains("agentdeck:subscribe") else { throw DotRPCError(code: -32003, message: "Insufficient scope") }
            if method == "events/list" { return ["events": [event]] }
            guard let schemas = contract["schemas"] as? [String: [String: Any]], let schema = schemas[method == "events/subscribe" ? "subscribe" : "unsubscribe"] else { throw DotFailure.message("Missing subscription schema.") }
            try DotSchema.validate(params, schema)
            guard params["name"] as? String == event["name"] as? String, let arguments = params["arguments"] as? [String: Any],
                  let delivery = params["delivery"] as? [String: Any], delivery["mode"] as? String == "webhook", let url = delivery["url"] as? String else { throw DotRPCError(code: -32602, message: "Invalid subscription") }
            try DotSchema.validate(arguments, event["inputSchema"] as! [String: Any]); _ = try DotWebhook.callbackURL(url)
            let profile = arguments["integrationId"] as! String
            let id = "sub_" + dotDigest(grant.id + "\n" + profile + "\n" + url)
            if method == "events/unsubscribe" {
                revisions[id] = UUID()
                try change { s in
                    s.subscriptions.removeAll { $0.id == id }
                    for i in s.requests.indices where s.requests[i].subscriptionId == id && s.requests[i].delivery == "pending" { s.requests[i].delivery = "cancelled" }
                }; return [:]
            }
            if let cursor = params["cursor"], !(cursor is NSNull) { throw DotRPCError(code: -32602, message: "Replay is not supported") }
            guard let secret = delivery["secret"] as? String else { throw DotRPCError(code: -32602, message: "Missing signing secret") }
            _ = try DotWebhook.key(secret)
            var ttl = DotLimits.subscriptionMs
            if let value = params["ttlMs"], !(value is NSNull) {
                try DotSchema.validate(value, ["type": "integer", "minimum": 1000]); ttl = min(value as! Int, ttl)
            }
            guard !verifying.contains(grant.id) else { throw DotRPCError(code: -32009, message: "Subscription verification in progress") }
            guard !state.subscriptions.contains(where: { $0.owner == grant.id && $0.profile == profile && $0.id != id && $0.expiresAt > clock() }) else { throw DotRPCError(code: -32009, message: "Profile already has a primary subscription") }
            let old = state.subscriptions.first { $0.id == id }, now = clock(), run = epoch, revision = UUID()
            revisions[id] = revision; verifying.insert(grant.id); defer { verifying.remove(grant.id) }
            var verified = old?.verifiedUntil ?? 0
            if old == nil || old!.expiresAt <= now || verified <= now || old!.secret != secret {
                let challenge = try dotRandom(), body = try JSONSerialization.data(withJSONObject: ["type": "verification", "challenge": challenge])
                let headers = try signed(secret: secret, previous: nil, id: "verify_" + UUID().uuidString, subscription: id, body: body)
                let response: DotWebhookReply
                do { response = try await send(url, body, headers) } catch { throw DotRPCError(code: -32015, message: "Callback verification failed or timed out") }
                guard (200..<300).contains(response.status), let result = try? JSONSerialization.jsonObject(with: response.body) as? [String: Any],
                      let echoed = result["challenge"] as? String, dotEqual(echoed, challenge) else { throw DotRPCError(code: -32015, message: "Callback verification failed") }
                verified = clock() + DotLimits.rotationMs
            }
            guard run == epoch, revisions[id] == revision, access(grant.id) else { throw DotRPCError(code: -32003, message: "Subscription was cancelled") }
            let expiry = clock() + ttl
            var sub = DotSubscription(id: id, owner: grant.id, profile: profile, url: url, secret: secret, expiresAt: expiry, verifiedUntil: verified)
            if let old, old.secret != secret { sub.previousSecret = old.secret; sub.previousUntil = clock() + DotLimits.rotationMs }
            else if let old, (old.previousUntil ?? 0) > clock() { sub.previousSecret = old.previousSecret; sub.previousUntil = old.previousUntil }
            try change { s in
                s.subscriptions.removeAll { $0.id == id || ($0.owner == grant.id && $0.profile == profile) }
                guard s.subscriptions.count < DotLimits.records else { throw DotFailure.message("Subscription capacity reached.") }; s.subscriptions.append(sub)
            }
            return ["id": id, "refreshBefore": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(expiry) / 1000)), "cursor": NSNull(), "truncated": false]
        case "tools/call":
            guard let name = params["name"] as? String, let tool = tools.first(where: { $0["name"] as? String == name }), let arguments = params["arguments"] as? [String: Any] else { throw DotRPCError(code: -32602, message: "Invalid tool") }
            let read = (tool["annotations"] as? [String: Any])?["readOnlyHint"] as? Bool == true
            guard grant.scopes.contains(read ? "agentdeck:read" : "agentdeck:report") else { throw DotRPCError(code: -32003, message: "Insufficient scope") }
            try DotSchema.validate(arguments, tool["inputSchema"] as! [String: Any])
            do {
                let result = try call(name, arguments, owner: grant.id)
                let text = String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!
                return ["content": [["type": "text", "text": text]], "structuredContent": result]
            } catch { return ["isError": true, "content": [["type": "text", "text": error.localizedDescription]]] }
        default: throw DotRPCError(code: -32601, message: "Unsupported method")
        }
    }
    private func call(_ name: String, _ a: [String: Any], owner: String) throws -> [String: Any] {
        guard let index = state.requests.firstIndex(where: { $0.owner == owner && $0.id == a["requestId"] as? String }) else { throw DotFailure.message("Request not found.") }
        let r = state.requests[index], now = clock()
        if name == "get_request" { return view(r).merging(["expired": r.expiresAt <= now]) { _, b in b } }
        guard r.expiresAt > now else { throw DotFailure.message("Request expired.") }
        if name == "get_context" { return ["context": r.context, "capturedAt": r.capturedAt, "requestId": r.id] }
        return try change { s in
            var row = s.requests[index]
            if name == "claim_request" {
                if let claim = row.claim {
                    guard claim.key == a["idempotencyKey"] as? String else { throw DotFailure.message("Already claimed.") }
                    return ["attemptId": claim.attemptId, "expiresAt": claim.expiresAt]
                }
                let claim = DotClaim(attemptId: "attempt_" + UUID().uuidString, key: a["idempotencyKey"] as! String, expiresAt: min(row.expiresAt, now + DotLimits.claimMs))
                row.claim = claim; s.requests[index] = row
                return ["attemptId": claim.attemptId, "expiresAt": claim.expiresAt]
            }
            guard let claim = row.claim, claim.attemptId == a["attemptId"] as? String else { throw DotFailure.message("Unknown attempt.") }
            if name == "report_interaction" {
                let event = DotInteractionEvent(relationId: a["relationId"] as! String, sequence: a["sequence"] as! Int,
                    kind: a["kind"] as! String, direction: a["direction"] as! String, stage: a["stage"] as! String,
                    targetRef: a["targetRef"] as? String, summary: a["summary"] as! String, evidence: "dot_report", receivedAt: now)
                let key = a["idempotencyKey"] as! String
                let values: [Any] = [claim.attemptId, event.relationId, event.sequence, event.kind, event.direction, event.stage, event.targetRef as Any? ?? NSNull(), event.summary]
                let bytes = try JSONSerialization.data(withJSONObject: values)
                let fingerprint = dotDigest(bytes.base64EncodedString())
                if let prior = row.interactionKeys?[key] {
                    guard prior == fingerprint else { throw DotFailure.message("Interaction idempotency conflict.") }
                    return ["accepted": true, "sequence": event.sequence]
                }
                let history = row.interactions ?? []
                guard claim.expiresAt > now, !["completed", "failed"].contains(row.report?.state ?? ""), history.count < DotLimits.interactionEvents,
                      DotInteractionPolicy.allows(history.last(where: { $0.relationId == event.relationId }), event) else { throw DotFailure.message("Expired, conflicting or terminal interaction.") }
                row.interactions = history + [event]
                var keys = row.interactionKeys ?? [:]; keys[key] = fingerprint; row.interactionKeys = keys
                s.requests[index] = row
                return ["accepted": true, "sequence": event.sequence]
            }
            let sequence = a["sequence"] as! Int, key = a["idempotencyKey"] as! String, summary = a["summary"] as! String, status = a["state"] as! String
            let fingerprint = dotDigest(claim.attemptId + "\n" + String(sequence) + "\n" + status + "\n" + summary)
            if let old = row.reportKeys[key] { guard old == fingerprint else { throw DotFailure.message("Idempotency conflict.") }; return ["accepted": true, "sequence": sequence] }
            guard claim.expiresAt > now, !["completed", "failed"].contains(row.report?.state ?? ""), sequence > (row.report?.sequence ?? 0), row.reportKeys.count < DotLimits.reportKeys else { throw DotFailure.message("Expired, stale or terminal report.") }
            row.report = DotReport(sequence: sequence, state: status, summary: summary, receivedAt: now); row.reportKeys[key] = fingerprint; s.requests[index] = row
            return ["accepted": true, "sequence": sequence]
        }
    }
    private func signed(secret: String, previous: String?, id: String, subscription: String, body: Data) throws -> [String: String] {
        let seconds = clock() / 1000
        let signatures = try ([secret] + (previous.map { [$0] } ?? [])).map { try DotWebhook.signature(id: id, seconds: seconds, body: body, secret: $0) }.joined(separator: " ")
        return ["Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": String(seconds), "webhook-signature": signatures, "X-MCP-Subscription-Id": subscription]
    }
    func deliver() async throws {
        guard !delivering else { return }; delivering = true; defer { delivering = false }
        try maintenance()
        guard let r = state.requests.first(where: { $0.delivery == "pending" && $0.nextAttemptAt <= clock() }) else { return }
        guard let sub = state.subscriptions.first(where: { $0.id == r.subscriptionId && $0.expiresAt > clock() }), r.expiresAt > clock(), access(r.owner), r.attempts < DotLimits.attempts else {
            try change { s in if let i = s.requests.firstIndex(where: { $0.id == r.id }) { s.requests[i].delivery = "expired" } }; return
        }
        let event = contract["event"] as! [String: Any], run = epoch
        let body = try JSONSerialization.data(withJSONObject: ["eventId": r.eventId, "name": event["name"]!, "timestamp": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(r.createdAt) / 1000)),
            "data": ["requestId": r.id, "integrationId": r.profile, "expiresAt": r.expiresAt], "cursor": NSNull()], options: .sortedKeys)
        let headers = try signed(secret: sub.secret, previous: (sub.previousUntil ?? 0) > clock() ? sub.previousSecret : nil, id: r.eventId, subscription: sub.id, body: body)
        let now = clock()
        try change { s in if let i = s.requests.firstIndex(where: { $0.id == r.id }) { s.requests[i].attempts += 1; s.requests[i].nextAttemptAt = now + min(DotLimits.retryMaxMs, 1000 * (1 << s.requests[i].attempts)) } }
        let status = (try? await send(sub.url, body, headers))?.status ?? 0
        guard run == epoch, access(r.owner) else { return }
        try change { s in
            guard let i = s.requests.firstIndex(where: { $0.id == r.id && $0.delivery == "pending" }) else { return }
            if (200..<300).contains(status) { s.requests[i].delivery = "accepted" }
            else if status == 410 || status == 413 || ((300..<500).contains(status) && status != 408 && status != 429) || s.requests[i].attempts >= DotLimits.attempts { s.requests[i].delivery = "failed" }
            if status == 410 {
                s.subscriptions.removeAll { $0.id == sub.id }
                for j in s.requests.indices where s.requests[j].subscriptionId == sub.id && s.requests[j].delivery == "pending" { s.requests[j].delivery = "cancelled" }
            }
        }
    }
}
#endif
