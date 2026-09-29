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
#endif
