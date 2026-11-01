#if os(macOS)
import Foundation

@DaemonActor
final class GitHubCIProvider {
    struct Key: Hashable, Sendable { let sid: String; let token: Int; let identity: GitHubCIIdentity }
    struct Reading { var evidence: GitHubCIEvidence; var at: TimeInterval }
    private let connection: GitHubCIConnection
    private let client: GitHubCIClient
    private var revision: Int?
    private var epoch = 0
    private var allowed = Set<String>()
    private var account: GitHubCIAccount?
    private var authRejected = false
    private var readings: [Key: Reading] = [:]
    private var tasks: [Key: Task<Void, Never>] = [:]
    private var next: [Key: TimeInterval] = [:]
    private var terminal: [Key: TimeInterval] = [:]
    private var stopped = false
    private var backoffUntil: TimeInterval = 0
    init(connection: GitHubCIConnection = .shared, client: GitHubCIClient = .init()) {
        self.connection = connection; self.client = client
    }
    func stop() { stopped = true; invalidate() }
    private func invalidate() {
        epoch += 1; tasks.values.forEach { $0.cancel() }; tasks.removeAll()
        readings.removeAll(); next.removeAll(); terminal.removeAll(); backoffUntil = 0
    }
    func syncConfiguration() async {
        do {
            let state = try await connection.snapshot()
            guard !stopped else { return }
            if revision != state.revision {
                invalidate(); revision = state.revision; authRejected = false
                account = state.account; allowed = Set(state.account?.repositories ?? [])
            }
        } catch { invalidate(); account = nil; allowed = []; revision = nil }
    }
    func projection(_ wait: [String: Any], sid: String, token: Int?, now: TimeInterval) -> [String: Any] {
        guard !stopped, revision == connection.generation.value, !authRejected, let token, let identity = GitHubCIIdentity(wait), allowed.contains(identity.repo),
              let value = readings[Key(sid:sid, token:token, identity:identity)],
              now >= value.at, (now - value.at) * 1000 < Double(GitHubCIPolicy.freshMs) else {
            return GitHubCIEvidence(reason:"stale_or_unavailable").wire(into: wait)
        }
        return value.evidence.wire(into: wait)
    }
    /// Returns waits whose terminal result display interval is finished.
    func poll(_ waits: [(String, Int, [String: Any])], now: TimeInterval, changed: @escaping @DaemonActor () -> Void) -> [(String, Int)] {
        guard !stopped else { return [] }
        guard revision == connection.generation.value else { invalidate(); return [] }
        let keys = Set(waits.compactMap { sid, token, wait in GitHubCIIdentity(wait).map { Key(sid:sid,token:token,identity:$0) } })
        for key in Array(tasks.keys) where !keys.contains(key) { tasks.removeValue(forKey:key)?.cancel() }
        readings = readings.filter { keys.contains($0.key) }; next = next.filter { keys.contains($0.key) }; terminal = terminal.filter { keys.contains($0.key) }
        var closed: [(String, Int)] = []
        let deadlines = next
        let ordered = waits.sorted { a, b in
            func due(_ row: (String, Int, [String: Any])) -> TimeInterval {
                guard let identity = GitHubCIIdentity(row.2) else { return .infinity }
                return deadlines[Key(sid:row.0,token:row.1,identity:identity)] ?? 0
            }
            return due(a) < due(b)
        }
        for (sid, token, wait) in ordered {
            guard let identity = GitHubCIIdentity(wait) else { continue }
            let key = Key(sid:sid,token:token,identity:identity)
            if let at = terminal[key], now - at >= Double(GitHubCIPolicy.resultAgeMs) / 1000 {
                if let opened = wait["openedAt"] as? Int { closed.append((sid,opened)) }; continue
            }
            if let value = readings[key], now < value.at || (now - value.at) * 1000 >= Double(GitHubCIPolicy.freshMs) {
                readings.removeValue(forKey:key); terminal.removeValue(forKey:key); changed()
            }
            guard !authRejected, now >= backoffUntil, let account, allowed.contains(identity.repo), tasks[key] == nil,
                  tasks.count < GitHubCIPolicy.maxConcurrent, now >= (next[key] ?? 0), terminal[key] == nil else { continue }
            let captured = epoch, credentialRevision = connection.generation.value
            next[key] = now + Double(GitHubCIPolicy.pollMs) / 1000
            tasks[key] = Task { [weak self, client] in
                let evidence = await client.probe(identity, token: account.token)
                guard let self, !self.stopped, !Task.isCancelled, captured == self.epoch, credentialRevision == self.connection.generation.value else { return }
                self.tasks.removeValue(forKey:key)
                let at = Date().timeIntervalSince1970
                let notice: String
                switch evidence.reason {
                case "authentication_rejected": notice = "Token rejected; reconnect"
                case "permission_denied": notice = "CI permission denied"
                case "rate_limited": notice = "GitHub rate limit; retry deferred"
                case "observed": notice = "Last CI request: " + evidence.phase
                default: notice = "Last CI request: unknown"
                }
                self.connection.generation.report(notice, revision: credentialRevision)
                if evidence.reason == "authentication_rejected" {
                    self.invalidate(); self.authRejected = true; changed(); return
                }
                if evidence.reason == "rate_limited" { self.backoffUntil = max(self.backoffUntil, evidence.retryAt) }
                self.readings[key] = Reading(evidence:evidence,at:at)
                self.next[key] = max(self.next[key] ?? 0, evidence.retryAt)
                if evidence.phase == "passed" || evidence.phase == "failed" { self.terminal[key] = at }
                changed()
            }
        }
        return closed
    }
}
#endif
