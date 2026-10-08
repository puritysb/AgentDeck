#if os(macOS)
import Foundation

// Headless `codex exec` runs as children of the session that launched them —
// the Swift mirror of `bridge/src/codex-exec-children.ts`.
//
// A harness that fans work out through `codex exec` (a Claude Bash running
// `xargs -P 4 codex exec …`) starts one real `codex` process per job. Each
// fires the user-global lifecycle hooks, so each used to become a full
// `codex-cli` session row and an APME run that nothing closed (49 of each in
// one batch, 2026-10-01). A headless run is not an independent session: nobody
// steers it, it has one prompt, and the work belongs to whoever launched it.
// It is folded into the launcher's child census instead — the same axis a
// Claude `Agent` call or a Codex `SubagentStart` moves.
//
// The Node daemon has two producers (a process observer with `lsof`, and the
// hooks). This daemon has no process observer, so the hooks are the only
// producer: a headless rollout's `codex exec` process is found in the sysctl
// table by its `-C <cwd>` argv (or as the only unclaimed `codex exec`) and its
// ancestry walked to a peer. When the table the daemon holds is too old to
// show the process yet, the verdict is `pending` and the caller reads a fresh
// table once; a still-unresolved run's hooks FLOW — a user's own terminal
// `codex exec` must remain a session with a run — and the 5 s coordination
// tick attaches it later if its process turns out to descend from a peer,
// retracting what the early hooks minted. A child's process leaving a
// non-empty table without a terminal hook is its completion; since every pid
// here is an argv match rather than an `lsof` fact, a same-cwd sibling still
// running keeps the child open.
//
// Peers are the sessions this daemon knows a pid for: Claude sessions register
// theirs through the `X-AgentDeck-Pid` hook header. The Codex hook snippet
// carries no such header, so a Codex TUI launching `codex exec` is not
// resolvable here and its children stay standalone (tracked in #429).

struct CodexExecPeer: Sendable, Equatable {
    let sessionId: String
    let pid: Int
}

struct CodexExecChild: Sendable, Equatable {
    /// Hook session key (`codex:<uuid>`).
    let sessionId: String
    /// The `codex exec` process chosen by argv — best effort, see above.
    var pid: Int?
    var cwd: String?
    let parentSessionId: String
    /// Epoch seconds.
    let startedAt: Double
    var lastSeenAt: Double
    var stoppedAt: Double?
}

enum CodexExecChildEvent: Sendable, Equatable {
    case attached(CodexExecChild)
    case stopped(CodexExecChild)
}

/// What the rollout head says about a run — read by the caller inside the
/// sandbox's security scope (see `codexObservedAgentType`), so this type
/// carries the answer and no path.
struct CodexRolloutSessionMeta: Sendable, Equatable {
    let originator: String?
    let cwd: String?
    let isSubagent: Bool?

    init(originator: String?, cwd: String?, isSubagent: Bool? = nil) {
        self.originator = originator
        self.cwd = cwd
        self.isSubagent = isSubagent
    }
}

enum CodexExecChildRules {
    static let headlessOriginator = "codex_exec"

    /// `codex exec` stamps its originator; the desktop app and the TUI stamp
    /// theirs. Case-insensitive because Codex has changed the case of these
    /// labels before.
    static func isHeadlessOriginator(_ originator: String?) -> Bool {
        guard let originator else { return false }
        return originator.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == headlessOriginator
    }

    /// The argv shape of a headless run: the `codex` binary followed by the
    /// `exec` subcommand (or its alias `e`), possibly behind `node` /
    /// `timeout` wrappers. `codex-code-mode-host` and the Electron helpers
    /// never match. A path containing whitespace splits here and is simply
    /// not matched: the argv carries no quoting to recover it from.
    static func isCodexExecCommand(_ command: String) -> Bool {
        let argv = command.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard argv.count >= 2 else { return false }
        let bin = binaryName(argv[0])
        var start = 1
        if bin == "node" || bin == "timeout" {
            guard let idx = argv.indices.dropFirst().first(where: { binaryName(argv[$0]) == "codex" }) else { return false }
            start = idx + 1
        } else if bin != "codex" {
            return false
        }
        return argv[start...].contains { $0 == "exec" || $0 == "e" }
    }

    /// `-C <dir>` / `--cd <dir>` / `--cd=<dir>` from a `codex exec` argv.
    static func execCwd(fromCommand command: String) -> String? {
        let argv = command.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        for (i, a) in argv.enumerated() {
            if (a == "-C" || a == "--cd"), i + 1 < argv.count { return argv[i + 1] }
            if a.hasPrefix("--cd=") { return String(a.dropFirst("--cd=".count)) }
        }
        return nil
    }

    /// The nearest ancestor of `pid` whose pid is a peer — the launching
    /// session. `pid` itself never matches; the walk is cycle-safe. Several
    /// peers may share one pid (every Codex Desktop conversation reports the
    /// app-server's); the first listed wins, deterministically.
    static func nearestAncestorPeer(
        pid: Int,
        processes: [ProcessEnumerator.ProcessRow],
        peers: [CodexExecPeer]
    ) -> CodexExecPeer? {
        guard !peers.isEmpty else { return nil }
        var byPid: [Int: ProcessEnumerator.ProcessRow] = [:]
        for p in processes { byPid[p.pid] = p }
        var peerByPid: [Int: CodexExecPeer] = [:]
        for p in peers where peerByPid[p.pid] == nil { peerByPid[p.pid] = p }
        var visited: Set<Int> = [pid]
        var current = byPid[pid]
        while let row = current, row.ppid > 1, !visited.contains(row.ppid) {
            if let peer = peerByPid[row.ppid] { return peer }
            visited.insert(row.ppid)
            current = byPid[row.ppid]
        }
        return nil
    }

    /// Canonical form for the argv-vs-rollout cwd match: on macOS a `-C /tmp/x`
    /// run reports `cwd: /private/tmp/x`.
    static func canonicalPath(_ path: String?, realpath: (String) -> String) -> String? {
        guard let path, !path.isEmpty else { return nil }
        func norm(_ p: String) -> String {
            var s = p.replacingOccurrences(of: "\\", with: "/")
            while s.count > 1, s.hasSuffix("/") { s.removeLast() }
            return s
        }
        return norm(realpath(norm(path)))
    }

    static func defaultRealpath(_ path: String) -> String {
        URL(fileURLWithPath: path).resolvingSymlinksInPath().path
    }

    static func binaryName(_ token: String) -> String {
        let base = token.split(separator: "/").last.map(String.init) ?? token
        return base.hasSuffix(".exe") ? String(base.dropLast(4)) : base
    }

    /// Prefer the binary over its `node` / `timeout` wrappers: ancestry is the
    /// same either way, but the pid is what the vanish check watches.
    static func wrapperRank(_ command: String) -> Int {
        let first = command.split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
        return binaryName(first) == "codex" ? 0 : 1
    }
}

/// Per-session-id verdicts and the live children. A value type mutated on
/// `@DaemonActor` by `DaemonServer`; every input (process table, peers, the
/// rollout head, the clock) is passed in, so the reducer is testable without
/// the actor.
struct CodexExecChildRegistry {
    /// A headless rollout whose parent is still unresolved after this long is
    /// a standalone run for good.
    static let pendingTTL: Double = 60
    /// A rollout not on disk at SessionStart is re-checked on the next hook,
    /// but not on every hook.
    static let noRolloutRetry: Double = 2
    /// A finished child stays known this long so a trailing tool_end cannot
    /// resurrect it as a session — the terminal-tombstone window.
    static let stoppedTTL: Double = 30 * 60
    static let verdictTTL: Double = 6 * 60 * 60

    static let terminalEvents: Set<String> = [
        "codex_stop", "codex_session_end", "codex_turn_complete", "codex_interrupt",
    ]

    private enum Verdict: Sendable, Equatable {
        case child
        case standalone(at: Double)
        case notHeadless(at: Double)
        case pending(since: Double, cwd: String?, retried: Bool)
        case noRollout(at: Double)
    }

    private(set) var children: [String: CodexExecChild] = [:]
    private var verdicts: [String: Verdict] = [:]
    private let realpath: (String) -> String

    init(realpath: @escaping (String) -> String = CodexExecChildRules.defaultRealpath) {
        self.realpath = realpath
    }

    /// Attached: the id is not an independent session.
    func knows(_ sessionId: String) -> Bool {
        children[sessionId] != nil
    }

    func parent(of sessionId: String) -> String? {
        children[sessionId]?.parentSessionId
    }

    struct HookVerdict: Sendable, Equatable {
        /// The hook belongs to an attached child and must not enter the parent
        /// session's row, state, timeline, or APME pipelines.
        let childOnly: Bool
        let events: [CodexExecChildEvent]
        /// Headless, but its process is not in the table the caller passed —
        /// the caller may read a fresh table and call again (once per session).
        var wantsFreshTable: Bool = false
    }

    /// Hook path. `sessionMeta` reads the rollout head on demand (nil = could
    /// not read, never "not headless"); `cwd` is the hook payload's.
    mutating func noteHook(
        event: String,
        sessionId: String,
        cwd hookCwd: String?,
        processes: [ProcessEnumerator.ProcessRow],
        peers: [CodexExecPeer],
        now: Double,
        sessionMeta: () -> CodexRolloutSessionMeta?
    ) -> HookVerdict {
        guard event.hasPrefix("codex_") else { return HookVerdict(childOnly: false, events: []) }
        sweep(now: now)

        if var child = children[sessionId] {
            child.lastSeenAt = now
            var events: [CodexExecChildEvent] = []
            if Self.terminalEvents.contains(event), child.stoppedAt == nil {
                child.stoppedAt = now
                events.append(.stopped(child))
            }
            children[sessionId] = child
            return HookVerdict(childOnly: true, events: events)
        }

        let verdict = verdicts[sessionId]
        switch verdict {
        case .standalone, .notHeadless:
            return HookVerdict(childOnly: false, events: [])
        case .noRollout(let at) where now - at < Self.noRolloutRetry:
            return HookVerdict(childOnly: false, events: [])
        default:
            break
        }

        var cwd = hookCwd
        if case .pending(_, let pendingCwd, _) = verdict {
            cwd = cwd ?? pendingCwd
        } else {
            guard let meta = sessionMeta() else {
                // SessionStart can land before the rollout's first line is
                // flushed. Not a verdict — look again on the next hook.
                verdicts[sessionId] = .noRollout(at: now)
                return HookVerdict(childOnly: false, events: [])
            }
            guard CodexExecChildRules.isHeadlessOriginator(meta.originator) else {
                verdicts[sessionId] = .notHeadless(at: now)
                return HookVerdict(childOnly: false, events: [])
            }
            cwd = cwd ?? meta.cwd
        }

        switch resolveByArgv(sessionId: sessionId, cwd: cwd, processes: processes, peers: peers) {
        case .child(let pid, let parent):
            var child = attach(sessionId: sessionId, pid: pid, cwd: cwd, parent: parent, now: now)
            var events: [CodexExecChildEvent] = [.attached(child)]
            if Self.terminalEvents.contains(event) {
                child.stoppedAt = now
                children[sessionId] = child
                events.append(.stopped(child))
            }
            return HookVerdict(childOnly: true, events: events)
        case .standalone:
            verdicts[sessionId] = .standalone(at: now)
            return HookVerdict(childOnly: false, events: [])
        case .unknown:
            // No process visible in this table. The hooks flow — a standalone
            // run must keep its session and run — while the verdict stays
            // open for a fresh table (once) and for the tick.
            var since = now
            var retried = false
            if case .pending(let s, _, let r) = verdict { since = s; retried = r }
            if now - since > Self.pendingTTL || Self.terminalEvents.contains(event) {
                verdicts[sessionId] = .standalone(at: now)
                return HookVerdict(childOnly: false, events: [])
            }
            verdicts[sessionId] = .pending(since: since, cwd: cwd, retried: true)
            return HookVerdict(childOnly: false, events: [], wantsFreshTable: !retried)
        }
    }

    /// Tick path (the coordination tick's fresh process table): resolve
    /// pending runs whose process is now visible, and complete attached
    /// children whose process is gone. An empty table is "could not look".
    mutating func reconcile(
        processes: [ProcessEnumerator.ProcessRow],
        peers: [CodexExecPeer],
        now: Double
    ) -> [CodexExecChildEvent] {
        sweep(now: now)
        guard !processes.isEmpty else { return [] }
        var events: [CodexExecChildEvent] = []
        for (sessionId, verdict) in verdicts {
            guard case .pending(let since, let cwd, _) = verdict else { continue }
            switch resolveByArgv(sessionId: sessionId, cwd: cwd, processes: processes, peers: peers) {
            case .child(let pid, let parent):
                events.append(.attached(attach(sessionId: sessionId, pid: pid, cwd: cwd, parent: parent, now: now)))
            case .standalone:
                verdicts[sessionId] = .standalone(at: now)
            case .unknown:
                if now - since > Self.pendingTTL { verdicts[sessionId] = .standalone(at: now) }
            }
        }
        let livePids = Set(processes.map { $0.pid })
        for (sessionId, var child) in children {
            guard child.stoppedAt == nil, let pid = child.pid else { continue }
            if livePids.contains(pid) { continue }
            // The pid is an argv guess that may belong to a same-cwd sibling;
            // its exit proves nothing while a run for that cwd is still up.
            if let cwd = child.cwd, liveExec(forCwd: cwd, in: processes) { continue }
            child.stoppedAt = now
            children[sessionId] = child
            events.append(.stopped(child))
        }
        return events
    }

    private func liveExec(forCwd cwd: String, in processes: [ProcessEnumerator.ProcessRow]) -> Bool {
        let target = CodexExecChildRules.canonicalPath(cwd, realpath: realpath)
        return processes.contains {
            CodexExecChildRules.isCodexExecCommand($0.command)
                && CodexExecChildRules.canonicalPath(CodexExecChildRules.execCwd(fromCommand: $0.command), realpath: realpath) == target
        }
    }

    private enum Resolution: Equatable {
        case child(pid: Int, parent: CodexExecPeer)
        case standalone
        case unknown
    }

    private func resolveByArgv(
        sessionId: String,
        cwd: String?,
        processes: [ProcessEnumerator.ProcessRow],
        peers: [CodexExecPeer]
    ) -> Resolution {
        guard !processes.isEmpty else { return .unknown }
        let claimed = Set(children.values.compactMap { c -> Int? in
            (c.sessionId != sessionId && c.stoppedAt == nil) ? c.pid : nil
        })
        let unclaimed = processes.filter { !claimed.contains($0.pid) && CodexExecChildRules.isCodexExecCommand($0.command) }
        guard !unclaimed.isEmpty else { return .unknown }
        let target = CodexExecChildRules.canonicalPath(cwd, realpath: realpath)
        var candidates = target == nil ? [] : unclaimed.filter {
            CodexExecChildRules.canonicalPath(CodexExecChildRules.execCwd(fromCommand: $0.command), realpath: realpath) == target
        }
        // No argv cwd to match (`cd dir && codex exec …`): the one unclaimed
        // run in the table is this one; several are indistinguishable here.
        if candidates.isEmpty {
            let bare = unclaimed.filter { CodexExecChildRules.execCwd(fromCommand: $0.command) == nil }
            guard bare.count == 1 else { return .unknown }
            candidates = bare
        }
        let ordered = candidates.sorted { CodexExecChildRules.wrapperRank($0.command) < CodexExecChildRules.wrapperRank($1.command) }
        for proc in ordered {
            if let parent = CodexExecChildRules.nearestAncestorPeer(pid: proc.pid, processes: processes, peers: peers),
               parent.sessionId != sessionId {
                return .child(pid: proc.pid, parent: parent)
            }
        }
        return .standalone
    }

    private mutating func attach(
        sessionId: String, pid: Int, cwd: String?, parent: CodexExecPeer, now: Double
    ) -> CodexExecChild {
        let child = CodexExecChild(
            sessionId: sessionId, pid: pid, cwd: cwd, parentSessionId: parent.sessionId,
            startedAt: now, lastSeenAt: now, stoppedAt: nil
        )
        children[sessionId] = child
        verdicts[sessionId] = .child
        return child
    }

    private mutating func sweep(now: Double) {
        for (sid, child) in children {
            if let stoppedAt = child.stoppedAt, now - stoppedAt > Self.stoppedTTL {
                children.removeValue(forKey: sid)
                verdicts.removeValue(forKey: sid)
            }
        }
        for (sid, verdict) in verdicts {
            let at: Double
            switch verdict {
            case .child: continue
            case .standalone(let t), .notHeadless(let t), .noRollout(let t): at = t
            case .pending(let since, _, _): at = since
            }
            if now - at > Self.verdictTTL { verdicts.removeValue(forKey: sid) }
        }
    }
}
#endif
