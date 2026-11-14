import CloudKit
import Foundation
import WidgetKit

/// Read-only Watch reader of the Mac's shared summary in the user's private
/// CloudKit database. It follows the iPhone reader's account and cache rules:
/// a cache is restored only for the same iCloud identity, an account change
/// clears it, and a fetch never advances the original observation time.
@MainActor
final class WatchObservationModel: ObservableObject {
    @Published private(set) var summary: RemoteRosterSummary?
    @Published private(set) var status: String?
    @Published private(set) var busy = false
    @Published private(set) var lastFetch: Date?

    private let store: CloudKitProbeStore
    private let cache: RemoteReaderCache
    private var generation = 0
    private var accountObserver: NSObjectProtocol?
    private var fixture = false

    init(store: CloudKitProbeStore = CloudKitProbeStore(), cache: RemoteReaderCache = RemoteReaderCache()) {
        self.store = store
        self.cache = cache
        #if DEBUG
        // Screenshot pin: `-AgentDeckWatchFixture <waiting>,<working>,<ageSeconds>`
        // renders a synthetic summary and never touches CloudKit.
        if let index = CommandLine.arguments.firstIndex(of: "-AgentDeckWatchFixture"),
           CommandLine.arguments.indices.contains(index + 1) {
            let parts = CommandLine.arguments[index + 1].split(separator: ",").compactMap { Int($0) }
            if parts.count == 3 {
                fixture = true
                summary = RemoteRosterSummary(schemaVersion: 1, observedAt: Date().addingTimeInterval(-Double(parts[2])),
                                              workingCount: parts[1], waitingCount: parts[0])
                return
            }
        }
        #endif
        // Cold start without network: only an opaque local identity match restores.
        summary = cache.load(localIdentity: RemoteLocalIdentity.current())
        accountObserver = NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.accountDidChange() }
        }
    }

    private func accountDidChange() async {
        generation += 1
        summary = nil
        try? cache.clear()
        busy = false
        status = String(localized: "iCloud account changed.")
        await store.invalidateAccount()
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Skips a refresh when one finished moments ago (scene activation bursts).
    func refreshIfStale(now: Date = Date()) async {
        if let lastFetch, now.timeIntervalSince(lastFetch) < 30 { return }
        await refresh()
    }

    func refresh() async {
        guard !busy, !fixture else { return }
        busy = true
        let token = generation
        defer { if token == generation { busy = false } }
        do {
            let account = try await store.checkAccount()
            let owner = try await store.accountIdentity(account: account)
            guard token == generation else { return }
            if summary == nil {
                summary = cache.load(localIdentity: RemoteLocalIdentity.current(), verifiedAccount: owner)
            }
            let result = try await store.fetchRoster(account: account)
            guard token == generation else { return }
            summary = result
            lastFetch = Date()
            status = nil
            try? cache.save(result, account: owner, localIdentity: RemoteLocalIdentity.current())
            WidgetCenter.shared.reloadAllTimelines()
        } catch {
            guard token == generation else { return }
            lastFetch = Date()
            status = describe(error)
        }
    }

    private func describe(_ error: Error) -> String {
        switch error {
        case CloudKitProbeStore.ProbeError.accountUnverified:
            return String(localized: "iCloud is unverified. Showing the last saved observation.")
        case CloudKitProbeStore.ProbeError.accountUnavailable, CloudKitProbeStore.ProbeError.accountChanged:
            summary = nil
            try? cache.clear()
            WidgetCenter.shared.reloadAllTimelines()
            return String(localized: "Sign in to iCloud with the same Apple Account as the Mac.")
        case let error as CKError where error.code == .unknownItem:
            summary = nil
            try? cache.clear()
            WidgetCenter.shared.reloadAllTimelines()
            return String(localized: "The Mac is not sharing a summary.")
        case let error as URLError where error.code == .timedOut:
            return String(localized: "iCloud timed out. Last observation kept.")
        default:
            let failure = error as NSError
            return String(localized: "iCloud unavailable (\(failure.domain) \(failure.code)).")
        }
    }
}
