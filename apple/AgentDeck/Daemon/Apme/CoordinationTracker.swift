#if os(macOS)
// CoordinationTracker.swift — cross-session coordination evidence.
//
// A deliberate near-transliteration of bridge/src/coordination-evidence.ts
// (a rule restated in different words is a rule that can drift): the same
// three observations, the same folding, the same "never infer from project
// membership" boundary. Both daemons replay
// shared/coordination-evidence-vectors.json.
//
//   - `spawned`   — a peer session whose process is a descendant of this
//                   session's process (`process_ancestry`), or the intent to
//                   spawn one seen on a Bash tool call (`bash_claude_p`).
//   - `messaged`  — the sender's SendMessage tool input (`send_message_tool`)
//                   and the receiver's <cross-session-message> envelope
//                   (`cross_session_message`, socket basename = sender pid).
//   - `waiting_on`— a process (not an agent session, not its descendant)
//                   whose argv names this session's scratchpad directory
//                   (`background_process`).
//
// The session→pid link comes from the hook header `X-AgentDeck-Pid` (the
// posting shell's parent): the sandboxed daemon cannot read
// `~/.claude/sessions/<pid>.json`, and the transcript is not held open. The
// process table itself is `sysctl`, which needs no entitlement.

import Foundation

struct CoordinationRelation: Sendable, Equatable {
    let sessionId: String
    let relation: String      // spawned | messaged | waiting_on
    let direction: String     // in | out
    let phase: String         // open | closed
    let peerSessionId: String?
    let peerName: String?
    let evidence: String
    let detail: String?
    let ts: Int
    let key: String
}

struct CoordinationSummaryValue: Sendable, Equatable {
    var backgroundJobs: Int
    var spawnedActive: Int
    var spawnedCompleted: Int
    var messagesIn: Int
    var messagesOut: Int
    var lastPeerName: String?
    var lastRelationAt: Int?

    var dictionary: [String: Any] {
        var d: [String: Any] = [
            "backgroundJobs": backgroundJobs, "spawnedActive": spawnedActive,
            "spawnedCompleted": spawnedCompleted, "messagesIn": messagesIn, "messagesOut": messagesOut,
        ]
        if let lastPeerName { d["lastPeerName"] = lastPeerName }
        if let lastRelationAt { d["lastRelationAt"] = lastRelationAt }
        return d
    }
}

struct CoordinationPeer: Sendable, Equatable {
    let sessionId: String
    let pid: Int
}

enum CoordinationEvidence {
    static let maxDetail = 140

    static func clip(_ text: String, _ max: Int = maxDetail) -> String {
        let flat = text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        if flat.count <= max { return flat }
        let cut = String(flat.prefix(max - 1)).trimmingCharacters(in: .whitespaces)
        return cut + "…"
    }

    /// Mirrors `isAgentSpawnCommand`: `claude -p` / `claude --print` only.
    static func isAgentSpawnCommand(_ command: String?) -> Bool {
        guard let command else { return false }
        let pattern = #"(^|[\s;&|(])claude\s+(?:[^\n;&|]*\s)?(?:-p|--print)(?:\s|$)"#
        return command.range(of: pattern, options: .regularExpression) != nil
    }

    /// Mirrors `isAgentProcessCommand`.
    static func isAgentProcessCommand(_ command: String) -> Bool {
        let tokens = command.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        let head = tokens.first { $0.range(of: #"^[A-Z_]+="#, options: .regularExpression) == nil } ?? ""
        let base = head.split(separator: "/").last.map(String.init) ?? ""
        if ["claude", "codex", "opencode", "kiro-cli"].contains(base) { return true }
        let first3 = tokens.prefix(3).joined(separator: " ")
        return first3.range(of: #"(^|/)(claude|codex|opencode)(\.js|\.mjs)?(\s|$)"#, options: .regularExpression) != nil
    }

    /// Mirrors `commandNamesSession`.
    static func commandNamesSession(_ command: String, _ sessionId: String) -> Bool {
        guard sessionId.count >= 8 else { return false }
        return command.contains("/\(sessionId)/") || command.hasSuffix("/\(sessionId)")
    }

    /// Mirrors `commandLabel`: conservative — a script/path token or a 3+
    /// character word, else "process" (the first live read produced "NO" and
    /// "\012" from heredoc-driven shells).
    static func commandLabel(_ command: String) -> String {
        let skip: Set<String> = ["bash", "sh", "zsh", "-c", "-lc", "-l", "-e", "python", "python3", "node", "npx", "pnpm", "env", "exec", "nohup", "timeout", "cd", "&&", ";", "||"]
        let raw = command.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        var tokens: [String] = []
        for (i, t) in raw.enumerated() {
            // A `cd <dir>` target is where the job runs, not what it is.
            if i > 0, raw[i - 1] == "cd" { continue }
            if skip.contains(t) { continue }
            if t.range(of: #"^[A-Za-z_][A-Za-z0-9_]*="#, options: .regularExpression) != nil || t.hasPrefix("-") || t.contains("/private/tmp/") { continue }
            tokens.append(t)
        }
        let script = tokens.first { $0.range(of: #"\.(sh|py|mjs|cjs|js|ts|rb|pl|swift)$"#, options: .regularExpression) != nil }
        let path = tokens.first { $0.contains("/") && $0.range(of: #"^\d+$"#, options: .regularExpression) == nil }
        let word = tokens.first { $0.range(of: #"^[A-Za-z][A-Za-z0-9._-]{2,}$"#, options: .regularExpression) != nil }
        guard let first = script ?? path ?? word else { return "process" }
        let base = first.split(separator: "/").last.map(String.init) ?? first
        guard base.range(of: #"^[A-Za-z0-9][A-Za-z0-9._-]{1,}$"#, options: .regularExpression) != nil else { return "process" }
        return clip(base, 48)
    }

    /// Mirrors `findAncestorSession`: walk the parent chain from `pid`
    /// (exclusive) and return the first ancestor that is a peer session.
    static func findAncestorSession(
        _ processes: [ProcessEnumerator.ProcessRow], pid: Int, peers: [CoordinationPeer], maxDepth: Int = 8
    ) -> CoordinationPeer? {
        var byPid: [Int: ProcessEnumerator.ProcessRow] = [:]
        for p in processes { byPid[p.pid] = p }
        var peerByPid: [Int: CoordinationPeer] = [:]
        for p in peers { peerByPid[p.pid] = p }
        var cur = byPid[pid]
        var depth = 0
        while let row = cur, depth < maxDepth {
            let ppid = row.ppid
            if ppid <= 1 { return nil }
            if let peer = peerByPid[ppid], peer.pid != pid { return peer }
            cur = byPid[ppid]
            depth += 1
        }
        return nil
    }
}

/// Per-session reducer — see the Node `CoordinationTracker`. Hook facts come
/// in through `noteMessageIn` / `noteToolCall` / `registerPid`; the process
/// table through `observe`. `summary` is the `sessions_list` census and is
/// kept here, not derived from the rows it emits.
final class CoordinationTracker {
    private struct Entry {
        var jobs: [Int: String] = [:]
        var spawned: [String: Bool] = [:]
        var spawnIntents = 0
        var messagesIn = 0
        var messagesOut = 0
        var lastPeerName: String?
        var lastRelationAt: Int?
    }

    private var sessions: [String: Entry] = [:]
    private var nameToSession: [String: String] = [:]
    private var sessionToName: [String: String] = [:]
    private var pidToSession: [Int: String] = [:]
    private var hookPids: [String: Int] = [:]
    private let now: () -> Int

    init(now: @escaping () -> Int = { Int(Date().timeIntervalSince1970 * 1000) }) {
        self.now = now
    }

    private func entry(_ sessionId: String) -> Entry {
        sessions[sessionId] ?? Entry()
    }

    private func touch(_ e: inout Entry, _ peerName: String?, _ ts: Int) {
        if let peerName, !peerName.isEmpty { e.lastPeerName = peerName }
        e.lastRelationAt = ts
    }

    /// Mirrors `registerPid`: walk up from the hook shell's parent to the
    /// nearest agent process.
    func registerPid(sessionId: String, pid: Int, processes: [ProcessEnumerator.ProcessRow] = []) {
        guard pid > 1 else { return }
        var byPid: [Int: ProcessEnumerator.ProcessRow] = [:]
        for p in processes { byPid[p.pid] = p }
        var cur = byPid[pid]
        var chosen = pid
        var depth = 0
        while let row = cur, depth < 4, !CoordinationEvidence.isAgentProcessCommand(row.command) {
            guard let parent = byPid[row.ppid], parent.pid > 1 else { break }
            cur = parent
            if CoordinationEvidence.isAgentProcessCommand(parent.command) { chosen = parent.pid }
            depth += 1
        }
        hookPids[sessionId] = chosen
        pidToSession[chosen] = sessionId
    }

    /// Mirrors `mergePeers`: observer peers plus hook-registered pids.
    func mergePeers(_ observed: [CoordinationPeer]) -> [CoordinationPeer] {
        var seen = Set(observed.map(\.sessionId))
        var out = observed
        for (sessionId, pid) in hookPids where !seen.contains(sessionId) {
            out.append(CoordinationPeer(sessionId: sessionId, pid: pid))
            seen.insert(sessionId)
        }
        return out
    }

    func noteMessageIn(sessionId: String, prompt: String) -> CoordinationRelation? {
        guard let env = ApmeCollector.parseCrossSessionEnvelope(prompt) else { return nil }
        let ts = now()
        let peerSessionId = env.fromPid.flatMap { pidToSession[$0] }
        if let name = env.fromName, let peer = peerSessionId {
            nameToSession[name] = peer
            sessionToName[peer] = name
        }
        var e = entry(sessionId)
        e.messagesIn += 1
        touch(&e, env.fromName, ts)
        sessions[sessionId] = e
        return CoordinationRelation(
            sessionId: sessionId, relation: "messaged", direction: "in", phase: "closed",
            peerSessionId: peerSessionId, peerName: env.fromName, evidence: "cross_session_message",
            detail: env.body.isEmpty ? nil : env.body, ts: ts,
            key: "\(env.fromPid.map(String.init) ?? env.fromName ?? "peer"):\(ts)")
    }

    func noteToolCall(sessionId: String, toolName: String?, toolInput: [String: Any]?) -> CoordinationRelation? {
        if toolName == "SendMessage" {
            guard let target = ApmeCollector.parseSendMessageTarget(toolInput) else { return nil }
            let ts = now()
            let peerSessionId: String? = target.peerPid.flatMap { pidToSession[$0] }
                ?? target.peerName.flatMap { nameToSession[$0] }
            let peerName = target.peerName ?? peerSessionId.flatMap { sessionToName[$0] }
            var e = entry(sessionId)
            e.messagesOut += 1
            touch(&e, peerName, ts)
            sessions[sessionId] = e
            return CoordinationRelation(
                sessionId: sessionId, relation: "messaged", direction: "out", phase: "closed",
                peerSessionId: peerSessionId, peerName: peerName, evidence: "send_message_tool",
                detail: target.summary, ts: ts,
                key: "\(target.peerPid.map(String.init) ?? target.peerName ?? "peer"):\(ts)")
        }
        if toolName == "Bash" {
            let command = toolInput?["command"] as? String
            guard CoordinationEvidence.isAgentSpawnCommand(command) else { return nil }
            let ts = now()
            var e = entry(sessionId)
            e.spawnIntents += 1
            touch(&e, nil, ts)
            sessions[sessionId] = e
            return CoordinationRelation(
                sessionId: sessionId, relation: "spawned", direction: "out", phase: "open",
                peerSessionId: nil, peerName: "claude -p", evidence: "bash_claude_p",
                detail: CoordinationEvidence.clip(command ?? "", 96), ts: ts, key: "intent:\(ts)")
        }
        return nil
    }

    /// Mirrors `observe`: reconcile against the process table.
    func observe(_ processes: [ProcessEnumerator.ProcessRow], peers: [CoordinationPeer]) -> [CoordinationRelation] {
        // An empty process table is "I could not look", never "everything
        // ended" — see the Node `observe`. `sysctl` returning nothing must not
        // close every open child and job, because the sample's dedup key makes
        // that closure permanent.
        if processes.isEmpty { return [] }
        let ts = now()
        var out: [CoordinationRelation] = []
        pidToSession = [:]
        for p in peers { pidToSession[p.pid] = p.sessionId }
        for (sessionId, pid) in hookPids where pidToSession[pid] == nil { pidToSession[pid] = sessionId }
        let peerPids = Set(peers.map(\.pid))
        let alivePeerIds = Set(peers.map(\.sessionId))
        let rows = processes.map { ProcessEnumerator.ProcessRow(pid: $0.pid, ppid: $0.ppid, command: String($0.command.prefix(4096))) }
        var byPid: [Int: ProcessEnumerator.ProcessRow] = [:]
        for r in rows { byPid[r.pid] = r }

        // Spawned peers: ancestry.
        for child in peers {
            guard let parent = CoordinationEvidence.findAncestorSession(rows, pid: child.pid, peers: peers),
                  parent.sessionId != child.sessionId else { continue }
            var e = entry(parent.sessionId)
            if e.spawned[child.sessionId] != nil { continue }
            e.spawned[child.sessionId] = true
            if e.spawnIntents > 0 { e.spawnIntents -= 1 }
            touch(&e, nil, ts)
            sessions[parent.sessionId] = e
            out.append(CoordinationRelation(
                sessionId: parent.sessionId, relation: "spawned", direction: "out", phase: "open",
                peerSessionId: child.sessionId, peerName: nil, evidence: "process_ancestry",
                detail: nil, ts: ts, key: child.sessionId))
            out.append(CoordinationRelation(
                sessionId: child.sessionId, relation: "spawned", direction: "in", phase: "open",
                peerSessionId: parent.sessionId, peerName: nil, evidence: "process_ancestry",
                detail: nil, ts: ts, key: parent.sessionId))
        }
        // Spawned peers that ended.
        for (parentId, var e) in sessions {
            var changed = false
            for (childId, alive) in e.spawned where alive && !alivePeerIds.contains(childId) {
                e.spawned[childId] = false
                touch(&e, nil, ts)
                changed = true
                out.append(CoordinationRelation(
                    sessionId: parentId, relation: "spawned", direction: "out", phase: "closed",
                    peerSessionId: childId, peerName: nil, evidence: "process_ancestry",
                    detail: nil, ts: ts, key: childId))
            }
            if changed { sessions[parentId] = e }
        }
        // Background jobs.
        for peer in peers {
            var seen = Set<Int>()
            var e = sessions[peer.sessionId]
            for proc in rows {
                if proc.pid == peer.pid || peerPids.contains(proc.pid) { continue }
                guard CoordinationEvidence.commandNamesSession(proc.command, peer.sessionId) else { continue }
                if CoordinationEvidence.findAncestorSession(rows, pid: proc.pid, peers: peers) != nil { continue }
                if let parentRow = byPid[proc.ppid],
                   CoordinationEvidence.commandNamesSession(parentRow.command, peer.sessionId),
                   !peerPids.contains(parentRow.pid) { continue }
                seen.insert(proc.pid)
                var entry = e ?? Entry()
                if entry.jobs[proc.pid] != nil { e = entry; continue }
                let label = CoordinationEvidence.commandLabel(proc.command)
                entry.jobs[proc.pid] = label
                touch(&entry, nil, ts)
                e = entry
                out.append(CoordinationRelation(
                    sessionId: peer.sessionId, relation: "waiting_on", direction: "out", phase: "open",
                    peerSessionId: nil, peerName: label, evidence: "background_process",
                    detail: CoordinationEvidence.clip(proc.command, 96), ts: ts, key: String(proc.pid)))
            }
            guard var entry = e else { continue }
            for (pid, label) in entry.jobs where !seen.contains(pid) {
                entry.jobs.removeValue(forKey: pid)
                touch(&entry, nil, ts)
                out.append(CoordinationRelation(
                    sessionId: peer.sessionId, relation: "waiting_on", direction: "out", phase: "closed",
                    peerSessionId: nil, peerName: label, evidence: "background_process",
                    detail: nil, ts: ts, key: String(pid)))
            }
            sessions[peer.sessionId] = entry
        }
        return out
    }

    func forget(sessionId: String) {
        sessions.removeValue(forKey: sessionId)
        if let pid = hookPids.removeValue(forKey: sessionId), pidToSession[pid] == sessionId {
            pidToSession.removeValue(forKey: pid)
        }
    }

    /// `nil` when the session has never had a relation (the wire field is
    /// omitted); explicit zeros once it has.
    func summary(sessionId: String) -> CoordinationSummaryValue? {
        guard let e = sessions[sessionId] else { return nil }
        var active = 0, completed = 0
        for alive in e.spawned.values { if alive { active += 1 } else { completed += 1 } }
        return CoordinationSummaryValue(
            backgroundJobs: e.jobs.count, spawnedActive: active + e.spawnIntents, spawnedCompleted: completed,
            messagesIn: e.messagesIn, messagesOut: e.messagesOut,
            lastPeerName: e.lastPeerName, lastRelationAt: e.lastRelationAt)
    }
}
// BEGIN GENERATED CLAUDE BACKGROUND — bridge/generate-claude-background.mjs
// Source SHA256: c812ab6346bca0dab62a8fce0df36e720f8a403857545966c0a1d9dc35dd5903
// Parent turns remain idle; only the session-work projection stays working.
enum ClaudeBackgroundTasks {
    static func taskIds(_ payload: [String: Any], excluding: String? = nil) -> [String]? {
        guard let tasks = payload["background_tasks"] as? [Any], tasks.count <= 4096 else { return nil }
        let finished: Set<String> = ["completed", "failed", "cancelled", "canceled", "killed", "stopped", "done"]
        var ids: [String] = []
        for value in tasks {
            guard let task = value as? [String: Any], let id = task["id"] as? String, !id.isEmpty,
                  let status = task["status"] as? String else { return nil }
            if id == excluding || finished.contains(status) { continue }
            guard status == "running" else { return nil }
            if !ids.contains(id) { ids.append(id) }
        }
        return ids
    }

    static func taskCount(_ payload: [String: Any], excluding: String? = nil) -> Int? {
        taskIds(payload, excluding: excluding)?.count
    }

    /// Feed one Claude hook into the daemon's shared tracker.
    @discardableResult
    static func note(_ event: String, payload: [String: Any], into work: inout BackgroundWorkTracker,
                     now: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
        guard let sid = payload["session_id"] as? String,
              !sid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if event != "SubagentStop", let child = payload["agent_id"] as? String, !child.isEmpty { return false }
        if event == "SessionStart" || event == "SessionEnd" { return work.reset(sid) }
        guard ["Stop", "StopFailure", "SubagentStop", "Notification"].contains(event) else { return false }
        if event == "Notification" && payload["notification_type"] as? String != "idle_prompt" { return false }
        guard let ids = Self.taskIds(payload, excluding: event == "SubagentStop" ? payload["agent_id"] as? String : nil) else { return false }
        return work.snapshot(sid, items: ids, now: now, noun: "task", staleMs: .some(nil))
    }
}
// END GENERATED CLAUDE BACKGROUND
// BEGIN CODEX BACKGROUND TERMINALS — hand mirror of bridge/src/codex-background-terminals.ts
// Codex unified-exec processes still running after a turn, read from the
// rollout: a tool result announcing a running `session_id` (code-mode JSON with
// no `exit_code`, or legacy "Process running with session ID <n>") enters, the
// `CommandExecution` `item_completed` with that `process_id` leaves. Claimed only
// while the Codex process that posted the hook is alive, because a dead Codex
// cannot write the completion. Every read feeds the shared
// `BackgroundWorkTracker` a full snapshot. The Node suite replays
// shared/codex-background-terminal-vectors.json through this block.
struct CodexBackgroundTerminalIO {
    /// Last `bytes` of the file as whole lines, or nil when unreadable.
    var readTail: (_ path: String, _ bytes: Int) -> [String]?
    var locate: (_ sessionId: String) -> String?
    /// true alive, false definitely gone, nil could not tell.
    var isAlive: (_ pid: Int) -> Bool?
}

struct CodexBackgroundTerminals {
    static let tailBytes = 512 * 1024
    static let pollSeconds: UInt64 = 3
    static let maxWatches = 64
    static let maxTerminals = 256
    static let reads: Set<String> = ["codex_stop", "codex_turn_complete", "codex_interrupt"]
    static let resets: Set<String> = ["codex_session_start", "codex_session_end"]

    private struct Watch { var path: String; var pid: Int; var running: Set<String> }
    private var watches: [String: Watch] = [:]
    private var order: [String] = []

    var watchedSessions: [String] { order }

    private static func idOf(_ value: Any?) -> String? {
        if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
            let d = number.doubleValue
            guard d >= 0, d == d.rounded(.towardZero), d < 9_007_199_254_740_992 else { return nil }
            return String(Int64(d))
        }
        if let s = value as? String, !s.isEmpty, s.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) { return s }
        return nil
    }

    private static let runningText = try! NSRegularExpression(pattern: "Process running with session ID ([0-9]+)")

    private static func runningFromText(_ text: String, _ mark: (String) -> Void) {
        let ns = text as NSString
        for match in runningText.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            mark(ns.substring(with: match.range(at: 1)))
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("{"), let data = trimmed.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = idOf(obj["session_id"]), obj["exit_code"] == nil else { return }
        mark(id)
    }

    /// Each terminal's last status in a window ("running" / "finished"), or
    /// nil when no record parsed. Absence from the window is not completion.
    static func statuses(_ lines: [String]) -> [String: String]? {
        var result: [String: String] = [:]
        var parsed = false
        for line in lines {
            guard let data = line.data(using: .utf8),
                  let rec = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            parsed = true
            guard let payload = rec["payload"] as? [String: Any] else { continue }
            let type = rec["type"] as? String
            let ptype = payload["type"] as? String
            if type == "response_item", ptype == "function_call_output" || ptype == "custom_tool_call_output" {
                if let text = payload["output"] as? String {
                    runningFromText(text) { result[$0] = "running" }
                } else if ptype == "custom_tool_call_output", let parts = payload["output"] as? [Any] {
                    for part in parts {
                        if let text = (part as? [String: Any])?["text"] as? String {
                            runningFromText(text) { result[$0] = "running" }
                        }
                    }
                }
            } else if type == "event_msg", ptype == "item_completed",
                      let item = payload["item"] as? [String: Any], item["type"] as? String == "CommandExecution",
                      let id = idOf(item["process_id"]) {
                result[id] = "finished"
            }
        }
        return parsed ? result : nil
    }

    static func merge(_ known: Set<String>, _ lines: [String]) -> Set<String>? {
        guard let statuses = statuses(lines) else { return nil }
        var next = known
        for (id, status) in statuses {
            if status == "running" { next.insert(id) } else { next.remove(id) }
        }
        return next.count > maxTerminals ? nil : next
    }

    /// Feed a routed `codex_*` hook. Returns whether the session's count changed.
    @discardableResult
    mutating func note(_ event: String, payload: [String: Any], io: CodexBackgroundTerminalIO,
                       work: inout BackgroundWorkTracker, now: Double) -> Bool {
        guard let sid = payload["session_id"] as? String,
              !sid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        if Self.resets.contains(event) { return forget(sid, work: &work) }
        guard Self.reads.contains(event) else { return false }
        guard let number = payload["agentdeck_pid"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue == number.doubleValue.rounded(.towardZero), number.doubleValue > 1 else { return false }
        let pid = number.intValue
        let tp = payload["transcript_path"] as? String
        guard let path = (tp?.hasSuffix(".jsonl") == true ? tp : nil) ?? io.locate(sid) else { return false }
        let prior = watches[sid]
        let keep = prior.map { $0.pid == pid && $0.path == path } ?? false
        watches[sid] = Watch(path: path, pid: pid, running: keep ? prior!.running : [])
        order.removeAll { $0 == sid }
        order.append(sid)
        while order.count > Self.maxWatches { watches.removeValue(forKey: order.removeFirst()) }
        return refresh(sid, io: io, work: &work, now: now)
    }

    @discardableResult
    mutating func refresh(_ sid: String, io: CodexBackgroundTerminalIO,
                          work: inout BackgroundWorkTracker, now: Double) -> Bool {
        guard var watch = watches[sid] else { return false }
        let running: Set<String>?
        if io.isAlive(watch.pid) == false {
            running = []
        } else if let lines = io.readTail(watch.path, Self.tailBytes) {
            running = Self.merge(watch.running, lines)
        } else {
            running = nil
        }
        guard let running else { return false }
        watch.running = running
        if running.isEmpty {
            watches.removeValue(forKey: sid)
            order.removeAll { $0 == sid }
        } else {
            watches[sid] = watch
        }
        return work.snapshot(sid, items: Array(running), now: now, noun: "terminal", staleMs: .some(nil))
    }

    @discardableResult
    mutating func forget(_ sid: String, work: inout BackgroundWorkTracker) -> Bool {
        watches.removeValue(forKey: sid)
        order.removeAll { $0 == sid }
        return work.reset(sid)
    }
}
// END CODEX BACKGROUND TERMINALS
// BEGIN GENERATED BACKGROUND WORK — scripts/generate-background-work.mjs
// Source SHA256: e939a60700224e8d1d8268f2b1c5cf4ade0233d97f8730316e90d60c7d286916
// Agent-agnostic background work per session; adapters translate each agent's
// signal into snapshot/start/finish/reset. Absent = unknown, explicit 0 = done.
struct BackgroundWorkTracker {
    static let maxSessions = 4096
    static let maxItems = 4096
    static let tool = "Background tasks"

    static func noun(_ kind: String, count: Int) -> String {
        switch kind {
        case "task": return count == 1 ? "background task" : "background tasks"
        case "terminal": return count == 1 ? "background terminal" : "background terminals"
        case "process": return count == 1 ? "background process" : "background processes"
        default: return count == 1 ? "background task" : "background tasks"
        }
    }

    private struct Work {
        var items: [String: Double] = [:]
        var noun = "task"
        var staleMs: Double?
    }
    private var sessions: [String: Work] = [:]
    private var order: [String] = []

    func count(_ sid: String) -> Int? { sessions[sid]?.items.count }

    /// noun/staleMs: nil leaves the session's current value; staleMs .some(nil) clears the bound.
    @discardableResult
    mutating func snapshot(_ sid: String, items: [String], now: Double, noun: String? = nil, staleMs: Double?? = nil) -> Bool {
        guard !sid.isEmpty, items.count <= Self.maxItems else { return false }
        let before = count(sid)
        var work = touch(sid, noun: noun, staleMs: staleMs)
        work.items = [:]
        for item in items where !item.isEmpty { work.items[item] = now }
        sessions[sid] = work
        evict()
        return before != work.items.count
    }

    @discardableResult
    mutating func start(_ sid: String, item: String, now: Double, noun: String? = nil, staleMs: Double?? = nil) -> Bool {
        guard !sid.isEmpty, !item.isEmpty else { return false }
        let before = count(sid)
        var work = touch(sid, noun: noun, staleMs: staleMs)
        if work.items[item] == nil, work.items.count >= Self.maxItems { sessions[sid] = work; return false }
        work.items[item] = now
        sessions[sid] = work
        evict()
        return before != work.items.count
    }

    @discardableResult
    mutating func finish(_ sid: String, item: String) -> Bool {
        guard var work = sessions[sid], work.items.removeValue(forKey: item) != nil else { return false }
        sessions[sid] = work
        return true
    }

    @discardableResult
    mutating func reset(_ sid: String) -> Bool {
        order.removeAll { $0 == sid }
        return sessions.removeValue(forKey: sid) != nil
    }

    /// Sessions whose count changed because an item outlived its stale bound.
    mutating func reap(now: Double) -> [String] {
        var changed: [String] = []
        for sid in order {
            guard var work = sessions[sid], let stale = work.staleMs else { continue }
            let before = work.items.count
            work.items = work.items.filter { now - $0.value <= stale }
            if work.items.count != before { sessions[sid] = work; changed.append(sid) }
        }
        return changed
    }

    func project(_ sid: String, session: [String: Any]) -> [String: Any] {
        guard let work = sessions[sid] else { return session }
        let count = work.items.count
        var result = session
        result["backgroundTaskCount"] = count
        guard session["state"] as? String == "idle", count > 0 else { return result }
        let activity = "Waiting for \(count) \(Self.noun(work.noun, count: count))"
        result["state"] = "processing"
        result["currentTool"] = Self.tool
        result["currentTask"] = activity
        result["activity"] = activity
        return result
    }

    private mutating func touch(_ sid: String, noun: String?, staleMs: Double??) -> Work {
        var work = sessions[sid] ?? Work()
        if let noun { work.noun = noun }
        if let staleMs { work.staleMs = staleMs }
        order.removeAll { $0 == sid }
        order.append(sid)
        return work
    }

    private mutating func evict() {
        while order.count > Self.maxSessions { sessions.removeValue(forKey: order.removeFirst()) }
    }
}

/// The generic `<agent>_background_start|finish|snapshot` hook vocabulary.
enum BackgroundWorkHooks {
    struct Rule { let agent: String; let noun: String; let staleMs: Double?; let resets: [String]; let childStop: String? }
    static let rules: [Rule] = [
        Rule(agent: "opencode", noun: "task", staleMs: 21600000, resets: ["opencode_session_start", "opencode_session_end"], childStop: "opencode_subagent_stop"),
        Rule(agent: "hermes", noun: "process", staleMs: nil, resets: ["hermes_session_start", "hermes_session_end"], childStop: nil),
    ]
    static let maxItemId = 256

    enum Op: Equatable {
        case start(sessionId: String, item: String, noun: String, staleMs: Double?)
        case finish(sessionId: String, item: String)
        case snapshot(sessionId: String, items: [String], noun: String, staleMs: Double?)
        case reset(sessionId: String)
    }

    private static func itemId(_ value: Any?) -> String? {
        guard let s = value as? String, !s.isEmpty, s.utf16.count <= maxItemId else { return nil }
        return s
    }

    static func isEvent(_ event: String) -> Bool {
        for suffix in ["_background_start", "_background_finish", "_background_snapshot"] where event.hasSuffix(suffix) {
            let agent = event.dropLast(suffix.count)
            return !agent.isEmpty && agent.utf8.allSatisfy { $0 >= 97 && $0 <= 122 }
        }
        return false
    }

    static func op(_ event: String, payload: [String: Any]) -> Op? {
        guard let sid = payload["session_id"] as? String,
              !sid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        for rule in rules {
            if rule.resets.contains(event) { return .reset(sessionId: sid) }
            if let childStop = rule.childStop, event == childStop {
                guard let item = itemId(payload["agent_id"]) else { return nil }
                return .finish(sessionId: sid, item: item)
            }
            if event == rule.agent + "_background_start" || event == rule.agent + "_background_finish" {
                guard let item = itemId(payload["item_id"]) else { return nil }
                return event.hasSuffix("_start")
                    ? .start(sessionId: sid, item: item, noun: rule.noun, staleMs: rule.staleMs)
                    : .finish(sessionId: sid, item: item)
            }
            if event == rule.agent + "_background_snapshot" {
                guard let raw = payload["items"] as? [Any], raw.count <= BackgroundWorkTracker.maxItems else { return nil }
                var items: [String] = []
                for value in raw {
                    guard let item = itemId(value) else { return nil }
                    if !items.contains(item) { items.append(item) }
                }
                return .snapshot(sessionId: sid, items: items, noun: rule.noun, staleMs: rule.staleMs)
            }
        }
        return nil
    }

    @discardableResult
    static func apply(_ op: Op, to work: inout BackgroundWorkTracker, now: Double) -> Bool {
        switch op {
        case .reset(let sid): return work.reset(sid)
        case .finish(let sid, let item): return work.finish(sid, item: item)
        case .start(let sid, let item, let noun, let staleMs):
            return work.start(sid, item: item, now: now, noun: noun, staleMs: .some(staleMs))
        case .snapshot(let sid, let items, let noun, let staleMs):
            return work.snapshot(sid, items: items, now: now, noun: noun, staleMs: .some(staleMs))
        }
    }
}
// END GENERATED BACKGROUND WORK
#endif
