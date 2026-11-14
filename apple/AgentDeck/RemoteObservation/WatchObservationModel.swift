#if AGENTDECK_CLOUDKIT_POC
import Combine
import CloudKit
import Foundation
import WidgetKit

/// Read-only Watch reader of the Mac's shared summary in the user's private
/// CloudKit database. It follows the iPhone reader's account and cache rules:
/// a cache is restored only for the same iCloud identity, an account change
/// clears it, and a fetch never advances the original observation time.
protocol WatchObservationStore: Sendable {
    func checkAccount(expected: Int?) async throws -> Int
    func accountIdentity(account: Int?) async throws -> String
    func fetchRoster(account: Int?) async throws -> RemoteRosterSummary
    func invalidateAccount() async
}

extension CloudKitProbeStore: WatchObservationStore {}

@MainActor
final class WatchObservationModel: ObservableObject {
    @Published private(set) var summary: RemoteRosterSummary?
    @Published private(set) var status: String?
    @Published private(set) var busy = false
    @Published private(set) var lastFetch: Date?

    private let store: any WatchObservationStore
    private let localIdentity: () -> String?
    private let cache: RemoteReaderCache
    private var generation = 0
    private var accountObserver: NSObjectProtocol?
    private var fixture = false

    init(store: any WatchObservationStore = CloudKitProbeStore(), cache: RemoteReaderCache = RemoteReaderCache(),
         localIdentity: @escaping () -> String? = RemoteLocalIdentity.current) {
        self.store = store
        self.cache = cache
        self.localIdentity = localIdentity
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
        summary = cache.load(localIdentity: localIdentity())
        if summary == nil, hasSavedObservation {
            status = Self.accountVerificationMessage
        }
        accountObserver = NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.accountDidChange() }
        }
    }

    func accountDidChange() async {
        generation += 1
        lastFetch = nil
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
            let account = try await store.checkAccount(expected: nil)
            let owner = try await store.accountIdentity(account: account)
            guard token == generation else { return }
            // Recheck even a restored/in-memory observation before the fetch:
            // a missed account notification must not retain another account's counts.
            summary = cache.load(localIdentity: localIdentity(), verifiedAccount: owner)
            let result = try await store.fetchRoster(account: account)
            guard token == generation else { return }
            summary = result
            lastFetch = Date()
            status = nil
            do {
                try cache.save(result, account: owner, localIdentity: localIdentity())
            } catch {
                status = String(localized: "Fetched; the observation could not be saved on this Watch.")
            }
            WidgetCenter.shared.reloadAllTimelines()
        } catch {
            guard token == generation else { return }
            lastFetch = Date()
            status = describe(error)
        }
    }

    private static var accountVerificationMessage: String {
        String(localized: "A saved observation is on this Watch. Connect to iCloud to verify its account before showing it.")
    }

    private var hasSavedObservation: Bool {
        cache.disk.read("reader.json", as: RemoteReaderCache.Envelope.self) != nil
    }

    private func describe(_ error: Error) -> String {
        switch error {
        case CloudKitProbeStore.ProbeError.accountUnverified:
            if summary == nil {
                return hasSavedObservation ? Self.accountVerificationMessage
                    : String(localized: "iCloud is unverified. Connect and try again.")
            }
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
            if summary == nil {
                return hasSavedObservation ? Self.accountVerificationMessage
                    : String(localized: "iCloud timed out. Connect and try again.")
            }
            return String(localized: "iCloud timed out. Last observation kept.")
        default:
            if summary == nil, hasSavedObservation { return Self.accountVerificationMessage }
            let failure = error as NSError
            return String(localized: "iCloud unavailable (\(failure.domain) \(failure.code)).")
        }
    }
}

#endif
