// GENERATED — pnpm generate-gateway-live-rules. SSOT: shared/src/gateway-live-activity.ts
import Foundation

#if os(macOS)
struct GatewayLiveUpdate {
    var entry: DaemonTimelineEntry
    var upsert = false
}
struct GatewayLiveActivity {
    static let maxRuns = @MAX_RUNS@
    private static let maxTools = @MAX_TOOLS@
    private static let rawLimit = @RAW_LIMIT@
    private static let detailLimit = @DETAIL_LIMIT@
    private static let terminalPhases = @TERMINAL@
    private static let activePhases = @ACTIVE@
    private static let quietActions = @QUIET@
    private struct Run {
        var sessionKey: String
        var runId: String?
        var startedAt: Double
        var prompt: String?
        var response = ""
        var closed = false
        var responseEmitted = false
        var automated = false
    }
    private struct Tool { var name: String; var input: Any?; var ts: Double; var done = false }
    private var runs: [String: Run] = [:]
    private var order: [String] = []
    private var tools: [String: Tool] = [:]
    private var toolOrder: [String] = []
    private var messages: [String] = []
    var busy: Bool { runs.values.contains { !$0.closed } }
    mutating func reset() { runs.removeAll(); order.removeAll(); tools.removeAll(); toolOrder.removeAll(); messages.removeAll() }
    private func string(_ value: Any?) -> String? {
        guard let s = value as? String, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return s
    }
    private func object(_ value: Any?) -> [String: Any] { value as? [String: Any] ?? [:] }
    private func text(_ content: Any?) -> String {
        if let s = content as? String { return s }
        return (content as? [Any] ?? []).map { object($0) }.filter { $0["type"] as? String == "text" }.compactMap { string($0["text"]) }.joined()
    }
    private mutating func put(_ key: String, _ run: Run) {
        if runs[key] == nil { order.append(key) }
        runs[key] = run
        while order.count > Self.maxRuns { runs.removeValue(forKey: order.removeFirst()) }
    }
    private func row(_ run: Run, _ type: String, _ ts: Double, _ raw: String, _ detail: String? = nil) -> DaemonTimelineEntry {
        var entry = DaemonTimelineEntry(ts: ts.rounded(.towardZero), type: type,
            raw: String(raw.prefix(Self.rawLimit)), detail: detail.flatMap { $0.isEmpty ? nil : String($0.prefix(Self.detailLimit)) },
            approvalId: nil, status: nil, agentType: "openclaw", repeatCount: nil, automated: run.automated)
        entry.projectName = "OpenClaw"
        entry.sessionId = "openclaw-gateway"
        entry.runId = run.runId
        entry.startedAt = run.startedAt
        return entry
    }
    mutating func ingest(_ event: String, _ p: [String: Any], now observedAt: Double) -> [GatewayLiveUpdate] {
        let now = observedAt.rounded(.towardZero)
        let data = object(p["data"]), message = object(p["message"]), session = object(p["session"])
        let meta = object(message["__openclaw"])
        guard let sessionKey = string(p["sessionKey"]) ?? string(session["key"]) else { return [] }
        let runId = string(p["runId"]) ?? string(meta["runId"])
        var out: [GatewayLiveUpdate] = []
        if event == "sessions.changed" {
            for id in session["activeRunIds"] as? [String] ?? [] where !id.isEmpty {
                _ = ingest("chat", ["sessionKey": sessionKey, "runId": id, "state": "status"], now: now)
            }
            if session["hasActiveRun"] as? Bool == false {
                for key in order where runs[key]?.sessionKey == sessionKey { runs[key]?.closed = true }
            }
            if runId == nil { return out }
        }
        let isTool = event == "session.tool" || (event == "agent" && p["stream"] as? String == "tool")
        let phase = string(data["phase"]) ?? string(p["phase"]) ?? ""
        let lifecycle = (event == "agent" && p["stream"] as? String == "lifecycle") || event == "sessions.changed"
        let isUser = event == "session.message" && message["role"] as? String == "user"
            && (string(text(message["content"])) ?? string(message["text"])) != nil
        if isUser, let messageId = string(p["messageId"]) ?? string(meta["id"]) {
            let id = "\(sessionKey)|\(messageId)"
            if messages.contains(id) { return out }
            messages.append(id)
            if messages.count > Self.maxTools { messages.removeFirst() }
        }
        let state = string(p["state"]) ?? ""
        let terminal = (event == "chat" && ["final", "error", "aborted"].contains(state)) || (lifecycle && Self.terminalPhases.contains(phase))
        let toolBody = data.isEmpty ? p : data
        let validTool = isTool && ["start", "update", "result"].contains(string(toolBody["phase"]) ?? "") && string(toolBody["toolCallId"]) != nil && string(toolBody["name"]) != nil
        let active = isUser || validTool || (event == "chat" && ["status", "delta"].contains(state))
            || (event == "agent" && p["stream"] as? String == "run_status") || (lifecycle && Self.activePhases.contains(phase))
        let assistant = event == "session.message" && message["role"] as? String == "assistant"
        guard active || terminal || assistant else { return out }
        let pendingKey = "session:\(sessionKey)"
        var key = runId.map { "run:\($0)" } ?? pendingKey
        var found = runs[key]
        if found == nil, runId == nil, let activeKey = order.reversed().first(where: { runs[$0]?.sessionKey == sessionKey && runs[$0]?.closed == false }) {
            key = activeKey; found = runs[key]
        }
        if found == nil, let runId, var pending = runs[pendingKey], !pending.closed {
            runs.removeValue(forKey: pendingKey); order.removeAll { $0 == pendingKey }
            pending.runId = runId; put(key, pending); found = pending
            if let prompt = pending.prompt { out.append(.init(entry: row(pending, "chat_start", pending.startedAt, prompt, prompt), upsert: true)) }
        }
        if found == nil || (isUser && found?.closed == true && runId == nil) {
            guard active || terminal else { return out }
            found = Run(sessionKey: sessionKey, runId: runId, startedAt: now,
                        automated: sessionKey.contains(":cron:") || sessionKey.contains(":heartbeat"))
        }
        guard var run = found else { return out }
        if run.closed && !terminal && !assistant && !(isTool && phase == "result") { return out }
        if isUser {
            let prompt = string(text(message["content"])) ?? string(message["text"])
            if let prompt, run.prompt == nil {
                run.prompt = prompt
                let cron = prompt.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[cron:")
                run.automated = run.automated || cron
                out.append(.init(entry: row(run, "chat_start", run.startedAt, cron ? "Scheduled task" : prompt, prompt)))
            }
        }
        if (event == "chat" && state == "delta") || (assistant && message["stopReason"] as? String != "toolUse") {
            if let content = string(text(message["content"])) { run.response = content }
        }
        if isTool {
            let body = data.isEmpty ? p : data
            if let id = string(body["toolCallId"]) ?? string(p["toolCallId"]), let name = string(body["name"]) ?? string(p["name"]) {
                let toolKey = "\(run.runId ?? sessionKey)|\(id)"
                var tool = tools[toolKey] ?? Tool(name: name, input: body["args"] ?? body["input"], ts: now)
                if tools[toolKey] == nil { toolOrder.append(toolKey) }
                if tool.input == nil { tool.input = body["args"] ?? body["input"] }
                if body["phase"] as? String == "result" && !tool.done {
                    tool.done = true
                    let result = body["result"] ?? body["output"] ?? body["error"]
                    let failed = body["isError"] as? Bool == true || (body["error"] != nil && !(body["error"] is NSNull)) || object(object(result)["details"])["status"] as? String == "failed"
                    let args = object(tool.input), action = string(args["action"])
                    if failed || tool.name != "process" || !Self.quietActions.contains(action ?? "") {
                        let command = string(args["command"]) ?? string(args["path"]) ?? action
                        let output = string(text(object(result)["content"])) ?? (result as? String) ?? ""
                        let compactCommand = command?.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
                        let raw = tool.name + (compactCommand.map { " · \($0)" } ?? "") + (failed ? " · failed" : "")
                        let detail = (["session: \(sessionKey)", command, output].compactMap { $0 }).joined(separator: "\n")
                        var entry = row(run, "tool_exec", now, raw, detail)
                        entry.startedAt = tool.ts; entry.endedAt = now
                        out.append(.init(entry: entry))
                    }
                }
                tools[toolKey] = tool
                while toolOrder.count > Self.maxTools { tools.removeValue(forKey: toolOrder.removeFirst()) }
            }
        }
        if terminal {
            run.closed = true
            let response = string(text(message["content"])) ?? string(object(data["terminalReply"])["text"]) ?? run.response
            if !run.responseEmitted && (!response.isEmpty || event == "chat") {
                run.responseEmitted = true
                let error = ["error", "aborted"].contains(state) || ["error", "aborted"].contains(phase)
                let fallback = "Chat " + (state == "aborted" || phase == "aborted" ? "aborted" : "error") + (string(p["errorKind"]).map { " (\($0))" } ?? "")
                let label = error ? (string(p["errorMessage"]) ?? string(data["error"]) ?? fallback) : (string(response) ?? "Completed")
                let detail = error ? [label, string(p["errorKind"]).map { "kind \($0)" }, string(p["stopReason"]).map { "stop \($0)" }, run.runId.map { "run \($0)" }, "session \(sessionKey)", string(response)].compactMap { $0 }.joined(separator: " · ") : response
                var entry = row(run, error ? "error" : !response.isEmpty ? "chat_response" : "chat_end", now, label, detail)
                if response.isEmpty && !error { entry.summaryKind = "none" }
                entry.endedAt = now; out.append(.init(entry: entry))
            }
        }
        put(key, run)
        return out
    }
}
#endif
