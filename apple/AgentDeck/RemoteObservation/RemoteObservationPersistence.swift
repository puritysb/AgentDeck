import Foundation
import CryptoKit

enum RemoteObservationPolicy {
    static let networkTimeout: TimeInterval = 15
    static let historicalAfter: TimeInterval = 180
    static let readerLifetime: TimeInterval = 7 * 24 * 60 * 60
    static let attentionLifetime: TimeInterval = 300
    static let publishInterval: TimeInterval = 60
    static let sourceLifetime: TimeInterval = 20
    static let pendingLimit = 32
    static let diskLimit = 131_072
    static func retryDelay(attempt: Int, retryAfter: TimeInterval? = nil, jitter: Double = 1) -> TimeInterval {
        let backoff = min(300, 5 * pow(2, Double(max(0, min(attempt - 1, 6)))) * min(1.2, max(0.8, jitter)))
        return max(backoff, retryAfter ?? 0)
    }
}

/// An opaque local iCloud token; never uploaded. Missing tokens fail closed on
/// cold-start cache restoration until CloudKit verifies the account online.
enum RemoteLocalIdentity {
    static func current() -> String? {
        guard let token = FileManager.default.ubiquityIdentityToken,
              let bytes = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: false) else { return nil }
        return SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
}

struct RemoteProbeDisk {
    let directory: URL
    init(directory: URL = RemoteProbeDisk.defaultDirectory) {
        self.directory = directory
    }
    static var defaultDirectory: URL {
        #if os(watchOS)
        // The Watch reader has no AgentDeck data directory; it keeps only its own cache.
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("remote-observation-poc", isDirectory: true)
        #else
        return AgentDeckPaths.baseDirectory.appendingPathComponent("remote-observation-poc", isDirectory: true)
        #endif
    }
    func read<T: Decodable>(_ name: String, as type: T.Type) -> T? {
        let url = directory.appendingPathComponent(name)
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= RemoteObservationPolicy.diskLimit,
              let bytes = try? Data(contentsOf: url), bytes.count <= RemoteObservationPolicy.diskLimit else { return nil }
        return try? JSONDecoder().decode(type, from: bytes)
    }
    func write<T: Encodable>(_ value: T, to name: String) throws {
        let bytes = try JSONEncoder().encode(value)
        guard bytes.count <= RemoteObservationPolicy.diskLimit else { throw CocoaError(.fileWriteOutOfSpace) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let url = directory.appendingPathComponent(name)
        #if os(iOS) || os(watchOS)
        try bytes.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try bytes.write(to: url, options: .atomic)
        #endif
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        var mutableURL = url
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try mutableURL.setResourceValues(values)
    }
    func remove(_ name: String) throws {
        let url = directory.appendingPathComponent(name)
        do { try FileManager.default.removeItem(at: url) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { }
    }
}

struct RemoteReaderCache {
    struct Envelope: Codable {
        let version: Int
        let account: String
        let localIdentity: String?
        let summary: RemoteRosterSummary
    }
    let disk: RemoteProbeDisk
    init(disk: RemoteProbeDisk = RemoteProbeDisk()) { self.disk = disk }
    func load(localIdentity: String?, verifiedAccount: String? = nil, now: Date = Date()) -> RemoteRosterSummary? {
        guard let cache = disk.read("reader.json", as: Envelope.self), cache.version == 1,
              cache.summary.schemaVersion == 1, cache.summary.workingCount >= 0, cache.summary.waitingCount >= 0 else { return nil }
        let matches = verifiedAccount.map { $0 == cache.account }
            ?? (localIdentity != nil && localIdentity == cache.localIdentity)
        guard matches else {
            if verifiedAccount != nil || localIdentity != nil { try? clear() }
            return nil
        }
        guard cache.summary.freshness(at: now) != .expired, cache.summary.freshness(at: now) != .unknown else {
            try? clear(); return nil
        }
        return cache.summary
    }
    func save(_ summary: RemoteRosterSummary, account: String, localIdentity: String?) throws {
        try disk.write(Envelope(version: 1, account: account, localIdentity: localIdentity, summary: summary), to: "reader.json")
    }
    func clear() throws { try disk.remove("reader.json") }
}

struct RemotePublisherState: Codable, Equatable {
    struct Episode: Codable, Equatable { let id: UUID; let occurredAt: Date }
    var version = 1
    var account: String
    var installation = UUID()
    var enabled = false
    var revision = 0
    var attentionRevision = 0
    var publishedAttentionRevision = 0
    var tracker = RemoteWaitTracker()
    var pending: [Episode] = []
    var droppedEpisodes = 0
    var failures = 0
    var retryAt: Date?
    var lastPublishedAt: Date?

    mutating func observe(_ sessions: [RemoteSessionEvidence], at date: Date) -> RemoteRosterSummary {
        let transition = tracker.observe(sessions, at: date)
        if !transition.started.isEmpty || !transition.resolved.isEmpty { attentionRevision += 1 }
        let resolved = Set(transition.resolved)
        pending.removeAll { resolved.contains($0.id) || date.timeIntervalSince($0.occurredAt) >= RemoteObservationPolicy.attentionLifetime }
        for id in transition.started {
            if pending.count < RemoteObservationPolicy.pendingLimit { pending.append(Episode(id: id, occurredAt: date)) }
            else { droppedEpisodes += 1 }
        }
        return transition.summary
    }
    mutating func prepareAfterRestart() { tracker.invalidate(); lastPublishedAt = nil }
    func eligible(at now: Date) -> [Episode] {
        let active = Set(tracker.currentWaitIDs)
        return pending.filter { active.contains($0.id) && now.timeIntervalSince($0.occurredAt) >= 0
            && now.timeIntervalSince($0.occurredAt) < RemoteObservationPolicy.attentionLifetime }
    }
    func shouldPublish(at now: Date) -> Bool {
        guard enabled, retryAt == nil || now >= retryAt! else { return false }
        return attentionRevision != publishedAttentionRevision || !eligible(at: now).isEmpty || lastPublishedAt == nil || now.timeIntervalSince(lastPublishedAt!) >= RemoteObservationPolicy.publishInterval
    }
}
