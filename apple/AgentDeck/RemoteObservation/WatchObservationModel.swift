import Combine
import Foundation
#if canImport(WidgetKit)
import WidgetKit
#endif

/// The part of the Remote V1 transport a read-only Watch needs.
protocol WatchObservationSource: Sendable {
    func account() async throws -> RemoteObservationAccount
    func snapshot(account: RemoteObservationAccount) async throws -> RemoteObservationSnapshot?
    func invalidate() async
}

extension RemoteObservationCloudStore: WatchObservationSource {}

/// Watch-local cache of the last snapshot, bound to the verified iCloud identity.
struct WatchSnapshotCache {
    struct Envelope: Codable {
        let version: Int
        let account: String
        let localIdentity: String?
        let snapshot: RemoteObservationSnapshot
    }
    static let file = "watch-reader.json"
    let disk: RemoteProbeDisk

    init(disk: RemoteProbeDisk = RemoteObservationContract.disk) { self.disk = disk }

    var hasSaved: Bool { disk.read(Self.file, as: Envelope.self) != nil }

    /// A verified account must match; without one, only the opaque local iCloud
    /// token may restore (cold start without network). A mismatch clears.
    func load(localIdentity: String?, verifiedAccount: String? = nil, now: Date = Date()) -> RemoteObservationSnapshot? {
        guard let cache = disk.read(Self.file, as: Envelope.self), cache.version == 1,
              (try? cache.snapshot.validate()) != nil else { return nil }
        let matches = verifiedAccount.map { $0 == cache.account }
            ?? (localIdentity != nil && localIdentity == cache.localIdentity)
        guard matches else {
            if verifiedAccount != nil || localIdentity != nil { try? clear() }
            return nil
        }
        guard now < cache.snapshot.expiresAt else { try? clear(); return nil }
        return cache.snapshot
    }

    func save(_ snapshot: RemoteObservationSnapshot, account: String, localIdentity: String?) throws {
        try disk.write(Envelope(version: 1, account: account, localIdentity: localIdentity, snapshot: snapshot), to: Self.file)
    }

    func clear() throws { try disk.remove(Self.file) }
}

/// Read-only Watch reader of the Mac's Remote V1 snapshot in the user's private
/// CloudKit database. It follows the iPhone reader's account and cache rules: a
/// cache is restored only for the same iCloud identity, an account change clears
/// it, and a fetch never advances the original observation time.
@MainActor
final class WatchObservationModel: ObservableObject {
    @Published private(set) var snapshot: RemoteObservationSnapshot?
    @Published private(set) var status: String?
    @Published private(set) var busy = false
    @Published private(set) var lastFetch: Date?

    private let source: any WatchObservationSource
    private let localIdentity: () -> String?
    let cache: WatchSnapshotCache
    private var generation = 0
    private var verifiedAccount: String?
    private var accountObserver: NSObjectProtocol?
    private var fixture = false

    init(source: any WatchObservationSource = RemoteObservationCloudStore(), cache: WatchSnapshotCache = WatchSnapshotCache(),
         localIdentity: @escaping () -> String? = RemoteLocalIdentity.current) {
        self.source = source
        self.cache = cache
        self.localIdentity = localIdentity
        #if DEBUG
        if let pinned = WatchFixture.fromLaunchArguments() {
            fixture = true
            snapshot = pinned
            return
        }
        #endif
        snapshot = cache.load(localIdentity: localIdentity())
        if snapshot == nil, cache.hasSaved { status = Self.accountVerificationMessage }
        accountObserver = NotificationCenter.default.addObserver(forName: .CKAccountChangedNotificationName, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.accountDidChange() }
        }
        #if os(watchOS)
        WatchCompanionBridge.shared.activate { [weak self] data, account in
            Task { @MainActor in await self?.receiveCompanionSnapshot(data: data, account: account) }
        }
        #endif
    }

    #if DEBUG
    /// Demo capture: swap the pinned fixture in place (Debug builds only).
    func pinFixture(_ name: String) {
        guard fixture, let pinned = WatchFixture.named(name) else { return }
        snapshot = pinned
    }
    #endif

    func accountDidChange() async {
        generation += 1
        verifiedAccount = nil
        lastFetch = nil
        snapshot = nil
        try? cache.clear()
        busy = false
        status = String(localized: "iCloud account changed.")
        await source.invalidate()
        Self.reloadComplications()
    }

    /// Accepts a snapshot forwarded from the paired iPhone via WatchConnectivity
    /// only after confirming it is valid, unexpired, newer, and belongs to the
    /// same verified iCloud account.
    func receiveCompanionSnapshot(data: Data, account: String, now: Date = Date()) async {
        guard !fixture else { return }
        guard let incoming = try? RemoteObservationContract.decode(RemoteObservationSnapshot.self, from: data),
              (try? incoming.validate()) != nil,
              now < incoming.expiresAt else { return }
        let token = generation
        let owner: String
        if let verifiedAccount {
            owner = verifiedAccount
        } else if let resolved = try? await source.account() {
            guard token == generation else { return }
            verifiedAccount = resolved.identity
            owner = resolved.identity
        } else {
            return
        }
        guard owner == account else { return }
        if let current = snapshot,
           current.installationID == incoming.installationID,
           incoming.revision <= current.revision {
            return
        }
        snapshot = incoming
        status = nil
        try? cache.save(incoming, account: owner, localIdentity: localIdentity())
        Self.reloadComplications()
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
            let account = try await source.account()
            guard token == generation else { return }
            verifiedAccount = account.identity
            // Recheck even a restored/in-memory snapshot before the fetch:
            // a missed account notification must not retain another account's counts.
            snapshot = cache.load(localIdentity: localIdentity(), verifiedAccount: account.identity)
            let result = try await source.snapshot(account: account)
            guard token == generation else { return }
            lastFetch = Date()
            guard let result else {
                snapshot = nil
                try? cache.clear()
                status = String(localized: "Your Mac is not sharing to iCloud.")
                Self.reloadComplications()
                return
            }
            snapshot = result
            status = nil
            do {
                try cache.save(result, account: account.identity, localIdentity: localIdentity())
            } catch {
                status = String(localized: "Fetched; the observation could not be saved on this Watch.")
            }
            Self.reloadComplications()
        } catch {
            guard token == generation else { return }
            lastFetch = Date()
            status = describe(error)
        }
    }

    private static var accountVerificationMessage: String {
        String(localized: "A saved observation is on this Watch. Connect to iCloud to verify its account before showing it.")
    }

    private static func reloadComplications() {
        #if canImport(WidgetKit)
        WidgetCenter.shared.reloadAllTimelines()
        #endif
    }

    private func describe(_ error: Error) -> String {
        switch error {
        case RemoteObservationError.noAccount, RemoteObservationError.accountChanged:
            verifiedAccount = nil
            snapshot = nil
            try? cache.clear()
            Self.reloadComplications()
            return String(localized: "Sign in to iCloud with the same Apple Account as the Mac.")
        case RemoteObservationError.unsupportedSchema:
            return String(localized: "Update AgentDeck on this Watch to read your Mac's summary.")
        case RemoteObservationError.unverifiedAccount:
            if snapshot == nil {
                return cache.hasSaved ? Self.accountVerificationMessage
                    : String(localized: "iCloud is unverified. Connect and try again.")
            }
            return String(localized: "iCloud is unverified. Showing the last saved observation.")
        case let error as URLError where error.code == .timedOut:
            if snapshot == nil {
                return cache.hasSaved ? Self.accountVerificationMessage
                    : String(localized: "iCloud timed out. Connect and try again.")
            }
            return String(localized: "iCloud timed out. Last observation kept.")
        default:
            if snapshot == nil, cache.hasSaved { return Self.accountVerificationMessage }
            return snapshot == nil ? String(localized: "iCloud is unavailable. Try again shortly.")
                : String(localized: "iCloud is unavailable. Last observation kept.")
        }
    }
}

private extension Notification.Name {
    /// `CKAccountChanged`, named without importing CloudKit into test hosts.
    static let CKAccountChangedNotificationName = Notification.Name("CKAccountChangedNotification")
}

#if DEBUG
/// Screenshot and App Store capture pins. `-AgentDeckWatchFixture <name>` renders
/// a synthetic snapshot and never touches CloudKit.
/// Debug builds only; Release compiles this out.
enum WatchFixture {
    /// Launch arguments land in the argument domain; `defaults write` reaches
    /// the notification and widget processes, which get no arguments.
    static func fromLaunchArguments(_ defaults: UserDefaults = .standard, now: Date = Date()) -> RemoteObservationSnapshot? {
        defaults.string(forKey: "AgentDeckWatchFixture").flatMap { named($0, now: now) }
    }

    static func named(_ name: String, now: Date = Date()) -> RemoteObservationSnapshot? {
        func row(_ agent: RemoteSessionDetail.Agent, _ phase: RemoteSessionDetail.Phase, minutes: Double,
                 subagents: Int? = nil, jobs: Int? = nil) -> RemoteSessionDetail {
            RemoteSessionDetail(agent: agent, phase: phase, startedAt: now.addingTimeInterval(-minutes * 60),
                                activeSubagents: subagents, backgroundJobs: jobs)
        }
        func window(_ provider: RemoteUsageWindow.Provider, minutes: Int, remaining: Double, resetIn: Double) -> RemoteUsageWindow {
            RemoteUsageWindow(provider: provider, quantity: .allowance, durationMinutes: minutes, remainingPercent: remaining,
                              observedAt: now.addingTimeInterval(-40), resetsAt: now.addingTimeInterval(resetIn * 60), validUntil: nil)
        }
        let sessions: [RemoteSessionDetail]
        var usage: [RemoteUsageWindow] = []
        var age: TimeInterval = 25
        var state = RemoteSourceState.observed
        switch name {
        case "busy":
            sessions = [row(.claude, .response, minutes: 42, subagents: 2), row(.codexCLI, .response, minutes: 12),
                        row(.openCode, .working, minutes: 7, jobs: 1), row(.claude, .working, minutes: 95, subagents: 3),
                        row(.hermes, .working, minutes: 3), row(.antigravity, .idle, minutes: 180)]
            usage = [window(.codex, minutes: 300, remaining: 38, resetIn: 104), window(.codex, minutes: 10_080, remaining: 71, resetIn: 3_900),
                     window(.zai, minutes: 300, remaining: 84, resetIn: 61)]
        case "working":
            sessions = [row(.claude, .working, minutes: 18, subagents: 1), row(.codexApp, .working, minutes: 6),
                        row(.kiroCLI, .idle, minutes: 64)]
            usage = [window(.codex, minutes: 300, remaining: 62, resetIn: 190)]
        case "clear":
            sessions = [row(.claude, .idle, minutes: 120), row(.codexCLI, .idle, minutes: 30)]
            usage = [window(.codex, minutes: 300, remaining: 96, resetIn: 250)]
        case "historical":
            sessions = [row(.claude, .working, minutes: 40), row(.openClaw, .working, minutes: 22)]
            age = 14 * 60
        case "stopped":
            sessions = []
            state = .disabled
        default:
            return nil
        }
        let observed = state == .observed
        let observedAt = now.addingTimeInterval(-age)
        let waiting = sessions.filter { $0.phase == .response }.count
        return RemoteObservationSnapshot(
            installationID: UUID(uuidString: "00000000-0000-4000-8000-00000000A6DE")!, revision: 1, sourceState: state,
            observedAt: observed ? observedAt : nil, publishedAt: observedAt, expiresAt: observedAt.addingTimeInterval(RemoteObservationPolicy.readerLifetime),
            workingCount: observed ? sessions.filter { $0.phase == .working }.count : nil,
            waitingCount: observed ? waiting : nil, activeEventIDs: [],
            details: observed ? RemoteObservationDetails(sessions: sessions, sessionCount: sessions.count, usage: usage) : nil)
    }
}
#endif
