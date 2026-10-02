import Foundation

/// Admission and lifetime rules for the `hermes_*` observer hooks — the Swift
/// mirror of `HermesSessions.note` / `sweepDeparted` in
/// bridge/src/hermes-sessions.ts.
///
/// A Hermes conversation survives turns and ends on finalize (`session_end`),
/// on 30 minutes of silence, or when the Hermes process that reported it is
/// gone. Only an opening event (`session_start` / `user_prompt_submit`) or a
/// `tool_start` (real progress after a daemon restart) may create a row; a
/// stray Stop never does, and nothing may reopen a finalized conversation
/// except a new opening event.
struct HermesObserverGate: Sendable {
    /// Same row id as the Node daemon (`observed:hermes:<id>`), so both daemons'
    /// rows and timeline keys read alike to devices and ObservedAgentRules.
    static let sessionPrefix = "observed:hermes:"
    static let silenceTTL: TimeInterval = 30 * 60
    static let maxTracked = 128
    static let boundaries: Set<String> = [
        "session_start", "user_prompt_submit", "tool_start", "tool_end", "stop", "session_end",
    ]

    /// Whether a reported pid still runs. Only "no such process" is `dead`;
    /// a refused or failed probe (EPERM in the App Sandbox, …) is `unknown`
    /// and never closes a conversation.
    enum Liveness: Sendable, Equatable { case alive, dead, unknown }

    enum Verdict: Sendable, Equatable {
        case reject
        /// `boundary` is the agent-neutral event name; `sessionKey` is the
        /// daemon row id (`observed:hermes:<observer id>`).
        case accept(boundary: String, sessionKey: String)
    }

    private struct Entry: Sendable { var lastAt: Date; var pid: Int32? }
    private var live: [String: Entry] = [:]
    private var ended: [String: Date] = [:]

    /// The observer's identity: `hermes-` + 32 lowercase hex (a hash of the
    /// profile home and the native session id).
    static func isObserverSessionId(_ value: String) -> Bool {
        guard value.hasPrefix("hermes-") else { return false }
        let hex = value.dropFirst("hermes-".count)
        return hex.count == 32 && hex.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
    }

    mutating func admit(event: String, payload: [String: Any], now: Date) -> Verdict {
        guard event.hasPrefix("hermes_") else { return .reject }
        let boundary = String(event.dropFirst("hermes_".count))
        guard Self.boundaries.contains(boundary),
              let sid = payload["session_id"] as? String,
              Self.isObserverSessionId(sid) else { return .reject }
        prune(now: now)
        let opening = boundary == "session_start" || boundary == "user_prompt_submit"
        if opening {
            ended[sid] = nil
        } else if ended[sid] != nil {
            return .reject
        }
        let key = Self.sessionPrefix + sid
        if boundary == "session_end" {
            live[sid] = nil
            ended[sid] = now
            ended = Self.trimmed(ended)
            return .accept(boundary: boundary, sessionKey: key)
        }
        // Recover from a daemon restart only on real progress, never a stray Stop.
        if live[sid] == nil && !opening && boundary != "tool_start" { return .reject }
        let reported = (payload["pid"] as? NSNumber)?.int32Value
        let pid = reported.flatMap { $0 > 1 ? $0 : nil } ?? live[sid]?.pid
        live[sid] = Entry(lastAt: now, pid: pid)
        trimLive()
        return .accept(boundary: boundary, sessionKey: key)
    }

    /// Close every conversation whose Hermes process is gone. One-shot mode
    /// (`hermes -z`) hard-exits through `os._exit` without finalizing, so this
    /// is its only end short of the silence TTL. Returns the row ids closed.
    mutating func sweepDeparted(now: Date, probe: (Int32) -> Liveness = Self.probe) -> [String] {
        var verdicts: [Int32: Liveness] = [:]
        var closed: [String] = []
        for (sid, entry) in live {
            guard let pid = entry.pid else { continue }
            let verdict = verdicts[pid] ?? probe(pid)
            verdicts[pid] = verdict
            guard verdict == .dead else { continue }
            live[sid] = nil
            ended[sid] = now
            closed.append(Self.sessionPrefix + sid)
        }
        ended = Self.trimmed(ended)
        return closed
    }

    /// The daemon evicted the row (silence TTL): forget it here too.
    mutating func forget(sessionKey: String) {
        guard sessionKey.hasPrefix(Self.sessionPrefix) else { return }
        live[String(sessionKey.dropFirst(Self.sessionPrefix.count))] = nil
    }

    static func probe(_ pid: Int32) -> Liveness {
        if kill(pid, 0) == 0 { return .alive }
        return errno == ESRCH ? .dead : .unknown
    }

    private mutating func prune(now: Date) {
        live = live.filter { now.timeIntervalSince($0.value.lastAt) < Self.silenceTTL }
        ended = ended.filter { now.timeIntervalSince($0.value) < Self.silenceTTL }
    }

    private mutating func trimLive() {
        guard live.count > Self.maxTracked else { return }
        for (sid, _) in live.sorted(by: { $0.value.lastAt < $1.value.lastAt }).prefix(live.count - Self.maxTracked) {
            live[sid] = nil
        }
    }

    private static func trimmed(_ map: [String: Date]) -> [String: Date] {
        guard map.count > Self.maxTracked else { return map }
        let keep = map.sorted { $0.value > $1.value }.prefix(Self.maxTracked)
        return Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
    }

}
