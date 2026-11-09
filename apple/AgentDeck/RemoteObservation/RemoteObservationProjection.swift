import Foundation

/// Local identifiers are used only for transition tracking, never encoded.
struct RemoteSessionEvidence: Sendable {
    let localID: String
    let alive: Bool
    let working: Bool
    let waitingForResponse: Bool
    var agent: RemoteSessionDetail.Agent = .unknown
    var state: AgentConnectionState? = nil
    var startedAt: Date? = nil
    var activeSubagents: Int? = nil
    var backgroundJobs: Int? = nil

    init(localID: String, alive: Bool, working: Bool, waitingForResponse: Bool) {
        self.localID = localID
        self.alive = alive
        self.working = working
        self.waitingForResponse = waitingForResponse
    }

    init(row: SessionInfo, observedAt: Date) {
        let state = AgentConnectionState(rawValue: row.state ?? "")
        self.init(localID: row.id, alive: row.alive, working: state == .processing,
                  waitingForResponse: state?.isAwaiting == true
                    && !(row.question?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true))
        self.state = state
        agent = RemoteSessionDetail.Agent(rawValue: row.agentType ?? "") ?? .unknown
        if let start = remoteObservationDate(row.startedAt), start.timeIntervalSince1970 >= 0, start <= observedAt {
            startedAt = start
        }
        activeSubagents = row.subagents.map { max(0, $0.active) }
        backgroundJobs = row.coordination.map { max(0, $0.backgroundJobs) }
    }

    var detail: RemoteSessionDetail {
        let phase: RemoteSessionDetail.Phase
        if waitingForResponse { phase = .response }
        else if working { phase = .working }
        else if state?.isAwaiting == true { phase = .awaiting }
        else if state == .idle { phase = .idle }
        else { phase = .unknown }
        return RemoteSessionDetail(agent: agent, phase: phase, startedAt: startedAt,
                                   activeSubagents: activeSubagents, backgroundJobs: backgroundJobs)
    }
}

struct RemoteRosterSummary: Codable, Equatable, Sendable {
    let schemaVersion: Int
    let observedAt: Date
    let workingCount: Int
    let waitingCount: Int

    /// A new cloud fetch cannot advance source freshness.
    func freshness(at now: Date) -> RemoteObservationFreshness {
        let age = now.timeIntervalSince(observedAt)
        guard age >= 0 else { return .unknown }
        if age >= RemoteObservationPolicy.readerLifetime { return .expired }
        return age >= RemoteObservationPolicy.historicalAfter ? .historical : .recent
    }
}

enum RemoteObservationFreshness: Equatable, Sendable {
    case recent, historical, expired, unknown
}

struct RemoteWaitTransition: Sendable {
    let summary: RemoteRosterSummary
    /// Opaque episode IDs only. No local session identifiers leave this reducer.
    let started: [UUID]
    let resolved: [UUID]
}

/// A full roster is evidence; a socket loss is not an empty roster.
struct RemoteWaitTracker: Codable, Equatable, Sendable {
    private var active: [String: UUID] = [:]
    private var hasBaseline = false
    /// Only an explicit manual action may notify a wait already present at baseline.
    var currentWaitIDs: [UUID] { Array(active.values) }

    mutating func observe(_ evidence: [RemoteSessionEvidence], at time: Date) -> RemoteWaitTransition {
        let living = evidence.filter(\.alive)
        let waiting = Set(living.filter(\.waitingForResponse).map(\.localID))
        let resolved = active.filter { !waiting.contains($0.key) }.map(\.value)
        var started: [UUID] = []
        active = active.filter { waiting.contains($0.key) }
        for id in waiting.sorted() where active[id] == nil {
            let episode = UUID()
            active[id] = episode
            if hasBaseline { started.append(episode) }
        }
        hasBaseline = true
        return RemoteWaitTransition(
            summary: RemoteRosterSummary(schemaVersion: 1, observedAt: time,
                workingCount: Set(living.filter(\.working).map(\.localID)).count,
                waitingCount: waiting.count), started: started, resolved: resolved)
    }

    /// Reconnection needs a fresh baseline; unknown gaps do not resolve episodes.
    mutating func invalidate() { hasBaseline = false }
}
