import Foundation

enum RemoteObservationEnvironment: String, Sendable { case development = "Development", production = "Production" }

/// Apple-only policy. Move to the generated shared SSOT before adding a non-Apple reader.
enum RemoteObservationContract {
    static let version = 1
    static let container = "iCloud.bound.serendipity.agent.deck"
    static let zone = "RemoteObservationV1"
    static let snapshotRecord = "latest"
    static let snapshotType = "ObservationSnapshot"
    static let eventType = "AttentionEvent"
    static let payloadLimit = 16_384
    static let eventRetention: TimeInterval = 24 * 60 * 60
    static let cleanupBatch = 100
    static let bindingLimit = 256
    static let schedulerInterval: TimeInterval = 5
    static let cleanupInterval: TimeInterval = 60 * 60

    static func encode<T: Encodable>(_ value: T) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .custom { date, encoder in
            let ms = date.timeIntervalSince1970 * 1_000
            guard ms.isFinite, ms >= 0, ms < Double(Int64.max) else { throw RemoteObservationError.invalidData }
            var container = encoder.singleValueContainer()
            try container.encode(Int64(ms.rounded(.down)))
        }
        let bytes = try encoder.encode(value)
        guard bytes.count <= payloadLimit else { throw RemoteObservationError.invalidData }
        return bytes
    }

    static func decode<T: Decodable>(_ type: T.Type, from bytes: Data) throws -> T {
        guard bytes.count <= payloadLimit else { throw RemoteObservationError.invalidData }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let ms = try decoder.singleValueContainer().decode(Int64.self)
            guard ms >= 0 else { throw RemoteObservationError.invalidData }
            return Date(timeIntervalSince1970: Double(ms) / 1_000)
        }
        return try decoder.decode(type, from: bytes)
    }

    static var environment: RemoteObservationEnvironment? {
        (Bundle.main.object(forInfoDictionaryKey: "AgentDeckRemoteObservationEnvironment") as? String)
            .flatMap(RemoteObservationEnvironment.init(rawValue:))
    }

    static func storage(in directory: URL, environment: RemoteObservationEnvironment?) -> RemoteProbeDisk {
        RemoteProbeDisk(directory: directory.appendingPathComponent("remote-observation-v1-\(environment?.rawValue ?? "Unconfigured")", isDirectory: true))
    }

    static var disk: RemoteProbeDisk {
        storage(in: AgentDeckPaths.baseDirectory, environment: environment)
    }
}

enum RemoteObservationError: Error, Equatable {
    case noAccount, unverifiedAccount, accountChanged, invalidData, unsupportedSchema
    case anotherPublisher, pendingOriginalAccount, operationUnsettled, notReceiving
}

struct RemoteObservationAccount: Sendable, Equatable {
    let identity: String
    let generation: Int
}

enum RemoteSourceState: String, Codable, Sendable { case observed, unavailable, disabled }

struct RemoteObservationSnapshot: Codable, Equatable, Sendable {
    var schemaVersion = RemoteObservationContract.version
    let installationID: UUID
    let revision: Int
    let sourceState: RemoteSourceState
    let observedAt: Date?
    let publishedAt: Date
    let expiresAt: Date
    let workingCount: Int?
    let waitingCount: Int?
    let activeEventIDs: [UUID]

    func validate() throws {
        guard schemaVersion == RemoteObservationContract.version else { throw RemoteObservationError.unsupportedSchema }
        guard revision > 0, expiresAt > publishedAt, activeEventIDs.count <= RemoteObservationPolicy.pendingLimit,
              Set(activeEventIDs).count == activeEventIDs.count else { throw RemoteObservationError.invalidData }
        if sourceState == .observed {
            guard let observedAt, observedAt.timeIntervalSince1970.isFinite,
                  let workingCount, let waitingCount, workingCount >= 0, waitingCount >= 0,
                  activeEventIDs.count <= waitingCount else {
                throw RemoteObservationError.invalidData
            }
        } else if workingCount != nil || waitingCount != nil || !activeEventIDs.isEmpty {
            throw RemoteObservationError.invalidData
        }
    }

    func freshness(at now: Date) -> RemoteObservationFreshness {
        guard now < expiresAt else { return .expired }
        guard let observedAt, observedAt <= now else { return .unknown }
        return now.timeIntervalSince(observedAt) >= RemoteObservationPolicy.historicalAfter ? .historical : .recent
    }
}

struct RemoteAttentionEvent: Codable, Equatable, Identifiable, Sendable {
    var schemaVersion = RemoteObservationContract.version
    let id: UUID
    let installationID: UUID
    let occurredAt: Date
    let expiresAt: Date
    var resolvedAt: Date?

    func validate() throws {
        guard schemaVersion == RemoteObservationContract.version else { throw RemoteObservationError.unsupportedSchema }
        guard expiresAt > occurredAt, resolvedAt == nil || resolvedAt! >= occurredAt else {
            throw RemoteObservationError.invalidData
        }
    }

    enum Presentation: String, Sendable { case waiting, resolved, expired, sharingStopped, unconfirmed }
    func presentation(snapshot: RemoteObservationSnapshot?, at now: Date) -> Presentation {
        if let resolvedAt { return resolvedAt <= now && occurredAt <= now ? .resolved : .unconfirmed }
        if now >= expiresAt { return .expired }
        guard occurredAt <= now, let snapshot, snapshot.installationID == installationID else { return .unconfirmed }
        if snapshot.sourceState == .disabled { return .sharingStopped }
        guard snapshot.sourceState == .observed, snapshot.freshness(at: now) == .recent,
              snapshot.activeEventIDs.contains(id) else { return .unconfirmed }
        return .waiting
    }
}

struct RemoteEventMutation: Sendable, Equatable {
    let event: RemoteAttentionEvent
    /// False for resolved, old, or source-unconfirmed episodes: update an existing record only.
    let mayCreate: Bool
}

struct RemoteLocalRoster: Sendable {
    let sessions: [RemoteSessionEvidence]
    let observedAt: Date
}

/// Local-only identifiers are confined to this journal, never to a CloudKit payload.
struct RemotePublicationJournal: Codable, Equatable, Sendable {
    enum Intent: String, Codable { case none, stop, delete }
    struct Episode: Codable, Equatable, Sendable {
        var event: RemoteAttentionEvent
        var attempted = false
        var acknowledged = false
    }
    var version = 1
    let account: String
    var installationID = UUID()
    var enabled = false
    var intent = Intent.none
    var revision = 0
    var bindings: [String: UUID] = [:]
    var episodes: [Episode] = []
    var baseline = false
    var lastPublishedAt: Date?
    var lastSourceState: RemoteSourceState?
    var failures = 0
    var retryAt: Date?
    var droppedEvents = 0

    mutating func invalidateSource() { baseline = false }
    mutating func revokeConsent() {
        enabled = false; bindings.removeAll(); episodes.removeAll(); baseline = false
        if intent == .none { intent = .stop }
        retryAt = nil
    }

    mutating func observe(_ roster: RemoteLocalRoster, at now: Date) {
        episodes.removeAll { now.timeIntervalSince($0.event.occurredAt) >= RemoteObservationContract.eventRetention }
        let current = Dictionary(roster.sessions.map { ($0.localID, $0) }, uniquingKeysWith: { _, last in last })
        for (localID, eventID) in bindings {
            // Missing after an unknown gap is not evidence that a request resolved.
            if let row = current[localID], !row.alive || !row.waitingForResponse {
                if let index = episodes.firstIndex(where: { $0.event.id == eventID }), episodes[index].event.resolvedAt == nil {
                    episodes[index].event.resolvedAt = max(roster.observedAt, episodes[index].event.occurredAt)
                    episodes[index].acknowledged = false
                }
                bindings.removeValue(forKey: localID)
            }
        }
        // A wait that resolved/expired before its first attempted save must never become a catch-up alert.
        episodes.removeAll { !$0.attempted && ($0.event.resolvedAt != nil || now >= $0.event.expiresAt) }
        let waiting = current.values.filter { $0.alive && $0.waitingForResponse }.sorted { $0.localID < $1.localID }
        for row in waiting where bindings[row.localID] == nil {
            guard bindings.count < RemoteObservationContract.bindingLimit else { droppedEvents += 1; continue }
            let id = UUID()
            bindings[row.localID] = id
            if baseline {
                if episodes.count >= RemoteObservationPolicy.pendingLimit {
                    // Retain unacknowledged ambiguous writes; drop a new alert instead of replaying a different identity.
                    if let index = episodes.firstIndex(where: { $0.acknowledged && ($0.event.resolvedAt != nil || now >= $0.event.expiresAt) }) {
                        episodes.remove(at: index)
                    }
                }
                guard episodes.count < RemoteObservationPolicy.pendingLimit else { droppedEvents += 1; continue }
                episodes.append(Episode(event: RemoteAttentionEvent(id: id, installationID: installationID,
                    occurredAt: roster.observedAt, expiresAt: roster.observedAt.addingTimeInterval(RemoteObservationPolicy.attentionLifetime))))
            }
        }
        // Baseline-only/expired absent bindings have no pending cloud meaning.
        let retained = Set(episodes.map { $0.event.id })
        bindings = bindings.filter { current[$0.key]?.waitingForResponse == true || retained.contains($0.value) }
        baseline = true
    }

    func snapshot(roster: RemoteLocalRoster?, at now: Date, disabled: Bool = false) -> RemoteObservationSnapshot {
        let state: RemoteSourceState = disabled ? .disabled : (roster == nil ? .unavailable : .observed)
        let living = roster?.sessions.filter(\.alive)
        let waitingIDs = Set((roster?.sessions ?? []).filter { $0.alive && $0.waitingForResponse }.map(\.localID))
        let active = episodes.filter { episode in episode.event.resolvedAt == nil && now < episode.event.expiresAt
            && bindings.contains(where: { waitingIDs.contains($0.key) && $0.value == episode.event.id }) }
        return RemoteObservationSnapshot(installationID: installationID, revision: revision,
            sourceState: state, observedAt: roster?.observedAt, publishedAt: now,
            expiresAt: now.addingTimeInterval(RemoteObservationPolicy.readerLifetime),
            workingCount: state == .observed ? Set((living ?? []).filter(\.working).map(\.localID)).count : nil,
            waitingCount: state == .observed ? waitingIDs.count : nil,
            activeEventIDs: state == .observed ? active.map { $0.event.id } : [])
    }

    func mutations(roster: RemoteLocalRoster?, at now: Date) -> [RemoteEventMutation] {
        let waitingIDs = Set((roster?.sessions ?? []).filter { $0.alive && $0.waitingForResponse }.map(\.localID))
        return episodes.filter { !$0.acknowledged }.compactMap { episode in
            let current = episode.event.resolvedAt == nil && now >= episode.event.occurredAt && now < episode.event.expiresAt
                && bindings.contains(where: { waitingIDs.contains($0.key) && $0.value == episode.event.id })
            guard current || episode.attempted else { return nil }
            return RemoteEventMutation(event: episode.event, mayCreate: current)
        }
    }

    func isDue(source: RemoteSourceState, at now: Date) -> Bool {
        guard retryAt == nil || now >= retryAt! else { return false }
        return intent != .none || source != lastSourceState || episodes.contains(where: { !$0.acknowledged })
            || lastPublishedAt == nil || now.timeIntervalSince(lastPublishedAt!) >= RemoteObservationPolicy.publishInterval
    }
}

struct RemoteReaderJournal: Codable, Sendable {
    var version = 1
    var receiverID = UUID()
    var account: String?
    var installationID: UUID?
    var receiving = false
    var notifications = false
    var unsubscribePending = false
}

/// Small independent revocation marker: a failed larger journal write must not restore old consent.
struct RemoteSharingRevocation: Codable {
    let account: String
    let installationID: UUID
    let revision: Int
    let intent: RemotePublicationJournal.Intent
}

struct RemoteObservationCache: Codable {
    var version = 1
    let account: String
    let localIdentity: String?
    let snapshot: RemoteObservationSnapshot
    let event: RemoteAttentionEvent?
}

/// No commands, provider credentials or raw session records cross this interface.
protocol RemoteObservationTransport: Sendable {
    func account() async throws -> RemoteObservationAccount
    func invalidate() async
    func quiesce() async throws
    func snapshot(account: RemoteObservationAccount) async throws -> RemoteObservationSnapshot?
    func event(id: UUID, account: RemoteObservationAccount) async throws -> RemoteAttentionEvent?
    func publish(_ snapshot: RemoteObservationSnapshot, events: [RemoteEventMutation], account: RemoteObservationAccount) async throws
    func subscribe(installation: UUID, receiver: UUID, enabled: Bool, account: RemoteObservationAccount) async throws
    func delete(installation: UUID, account: RemoteObservationAccount) async throws
    func cleanup(at now: Date, account: RemoteObservationAccount) async throws
}
