#if os(macOS)
import Foundation

/// OTel dispatch consults memory only. File lookup is asynchronous and unknown
/// metadata admits the session until a later, explicit child verdict arrives.
@DaemonActor
final class CodexOtelSubagentFilter {
    typealias Resolver = @Sendable (String) async -> Bool?
    private struct Entry {
        var value: Bool?
        var attemptedAt: Date?
        var access: UInt64
    }
    private var entries: [String: Entry] = [:]
    private var pending: Set<String> = []
    private var access: UInt64 = 0
    private let resolve: Resolver
    private(set) var isClosed = false
    var onSubagent: (@DaemonActor (String) -> Void)?

    init(resolve: @escaping Resolver) { self.resolve = resolve }

    func check(_ threadId: String, now: Date = Date()) -> Bool? {
        guard !isClosed else { return nil }
        if entries[threadId] == nil, entries.count >= ObservedAgentRules.codexMetadataCacheLimit {
            guard let oldest = entries.filter({ !pending.contains($0.key) })
                .min(by: { $0.value.access < $1.value.access })?.key else { return nil }
            entries.removeValue(forKey: oldest)
        }
        access &+= 1
        var entry = entries[threadId] ?? Entry(access: access)
        entry.access = access
        entries[threadId] = entry
        if let value = entry.value { return value }
        guard !pending.contains(threadId), pending.count < ObservedAgentRules.codexMetadataInFlightLimit else { return nil }
        if let attemptedAt = entry.attemptedAt,
           now.timeIntervalSince(attemptedAt) * 1000 < ObservedAgentRules.codexMetadataRetryMs { return nil }
        entry.attemptedAt = now
        entries[threadId] = entry
        pending.insert(threadId)
        let resolver = resolve
        Task { @DaemonActor [weak self] in
            let value = await resolver(threadId)
            guard let self else { return }
            self.pending.remove(threadId)
            guard !self.isClosed else { return }
            self.entries[threadId]?.value = value
            if value == true { self.onSubagent?(threadId) }
        }
        return nil
    }

    /// Do not release pending slots until their worker actually completes.
    /// Teardown prevents new work and late callbacks rather than relying on
    /// cooperative cancellation of Foundation filesystem operations.
    func close() {
        isClosed = true
        onSubagent = nil
        entries.removeAll()
    }
    var cachedCount: Int { entries.count }
    var pendingCount: Int { pending.count }
}
#endif
