import CloudKit
import Combine
import Foundation
#if os(iOS)
import UIKit
import UserNotifications
#endif

/// App-owned cloud work. Neither daemon actors nor frame processing await this controller.
@MainActor
final class RemoteObservationController: ObservableObject {
    static let shared = RemoteObservationController()
    @Published private(set) var writer: RemotePublicationJournal?
    @Published private(set) var reader = RemoteReaderJournal()
    @Published private(set) var snapshot: RemoteObservationSnapshot?
    @Published private(set) var attentionEvent: RemoteAttentionEvent?
    @Published private(set) var status = "Remote monitoring is off."
    @Published private(set) var busy = false
    @Published private(set) var usingCache = false
    @Published private(set) var notificationStatus = ""
    #if os(iOS)
    private var pushRegistrationConfirmed: Bool?
    #endif
    @Published private(set) var attentionStatus = ""
    @Published var selectedTab = CompanionTab.local
    enum CompanionTab: Hashable { case local, remote }

    private let transport: any RemoteObservationTransport
    private let disk: RemoteProbeDisk
    private let now: () -> Date
    private let localIdentity: () -> String?
    private let jitter: () -> Double
    private let automaticLifecycle: Bool
    private var generation = 0
    private var source: (() -> RemoteLocalRoster?)?
    private var scheduler: Task<Void, Never>?
    private var observer: NSObjectProtocol?
    private var lastReadAt: Date?
    private var lastCleanupAt: Date?
    private var readerFailures = 0
    private var readerRetryAt: Date?
    private var pendingEventID: UUID?
    private var started = false
    #if os(macOS)
    private var activity: NSObjectProtocol?
    #endif

    init(transport: any RemoteObservationTransport = RemoteObservationCloudStore(),
         disk: RemoteProbeDisk = RemoteObservationContract.disk,
         now: @escaping () -> Date = Date.init,
         localIdentity: @escaping () -> String? = RemoteLocalIdentity.current,
         jitter: @escaping () -> Double = { Double.random(in: 0.8...1.2) },
         automaticLifecycle: Bool = !AgentDeckApp.isHostedTest()) {
        self.transport = transport; self.disk = disk; self.now = now
        self.localIdentity = localIdentity; self.automaticLifecycle = automaticLifecycle
        self.jitter = jitter
        // Hosted apps must not inspect the real user's consent/cache or contact iCloud.
        if automaticLifecycle { restoreDisk() }
    }

    func restoreDisk() {
        if var saved = disk.read("publisher.json", as: RemotePublicationJournal.self), saved.version == 1,
           saved.episodes.count <= RemoteObservationPolicy.pendingLimit,
           saved.bindings.count <= RemoteObservationContract.bindingLimit, saved.revision >= 0, saved.revision < Int.max {
            saved.invalidateSource(); saved.lastPublishedAt = nil
            writer = saved
        }
        if let saved = disk.read("receiver.json", as: RemoteReaderJournal.self), saved.version == 1 {
            reader = saved
        }
        if let revoked = disk.read("publisher-revocation.json", as: RemoteSharingRevocation.self) {
            if writer?.account != revoked.account || writer?.installationID != revoked.installationID {
                writer = RemotePublicationJournal(account: revoked.account, installationID: revoked.installationID, revision: revoked.revision)
            }
            writer?.enabled = false; writer?.intent = revoked.intent
            writer?.bindings.removeAll(); writer?.episodes.removeAll()
        }
        if disk.read("receiver-disabled.json", as: [String: Int].self) != nil {
            reader.receiving = false; reader.notifications = false
            reader.unsubscribePending = reader.installationID != nil
        }
        if reader.receiving, let cache = disk.read("reader.json", as: RemoteObservationCache.self),
           cache.version == 1, cache.account == reader.account,
           let identity = localIdentity(), cache.localIdentity == identity,
           (try? cache.snapshot.validate()) != nil,
           cache.snapshot.freshness(at: now()) != .expired, cache.snapshot.freshness(at: now()) != .unknown {
            snapshot = cache.snapshot; attentionEvent = cache.event; usingCache = true
            status = "Saved observation restored. Refresh to check the Mac."
        }
        if let cache = disk.read("reader.json", as: RemoteObservationCache.self), now() >= cache.snapshot.expiresAt {
            try? clearReader()
        }
    }

    func bindLocalSource(_ source: @escaping () -> RemoteLocalRoster?) {
        self.source = source
        start()
    }

    func start() {
        guard automaticLifecycle, !started else { return }
        started = true
        observer = NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.accountChanged() }
        }
        scheduler = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                do { try await Task.sleep(for: .seconds(RemoteObservationContract.schedulerInterval)) } catch { return }
            }
        }
    }

    func shutdown() {
        scheduler?.cancel(); scheduler = nil
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        generation += 1
        releaseActivity()
        Task { await transport.invalidate() }
    }

    func foreground() async {
        start()
        if reader.receiving || reader.unsubscribePending { await refresh(force: true) }
    }

    func tick() async {
        guard !busy else { return }
        #if os(macOS)
        if writer?.enabled == true || writer.map({ $0.intent != .none }) == true { await publishIfNeeded() }
        #else
        guard !automaticLifecycle || UIApplication.shared.applicationState == .active else { return }
        if reader.receiving || reader.unsubscribePending { await refresh() }
        #endif
    }

    private func persistWriter() throws {
        guard let writer else { return }
        try disk.write(writer, to: "publisher.json")
    }
    private func persistReader() throws { try disk.write(reader, to: "receiver.json") }
    private func persistRevocation() throws {
        guard let writer else { return }
        try disk.write(RemoteSharingRevocation(account: writer.account, installationID: writer.installationID,
            revision: writer.revision, intent: writer.intent), to: "publisher-revocation.json")
    }
    private func hideReader() {
        snapshot = nil; attentionEvent = nil; usingCache = false; pendingEventID = nil
        attentionStatus = ""
        notificationStatus = ""
    }
    private func clearReader() throws {
        hideReader()
        try disk.remove("reader.json")
    }
    private func currentRoster() -> RemoteLocalRoster? {
        guard let roster = source?(), now().timeIntervalSince(roster.observedAt) >= 0,
              now().timeIntervalSince(roster.observedAt) < RemoteObservationPolicy.sourceLifetime else { return nil }
        return roster
    }
    private func releaseActivity() {
        #if os(macOS)
        if let activity { ProcessInfo.processInfo.endActivity(activity); self.activity = nil }
        #endif
    }

    private func keepPublisherActive() {
        #if os(macOS)
        if activity == nil, automaticLifecycle {
            activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep,
                reason: "Publish explicitly enabled remote observations")
        }
        #endif
    }

    func enableSharing() async {
        guard !busy else { return }
        busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let account = try await transport.account()
            guard token == generation else { return }
            if let writer, writer.intent != .none { throw RemoteObservationError.pendingOriginalAccount }
            try disk.remove("publisher-revocation.json")
            if writer?.account != account.identity { writer = RemotePublicationJournal(account: account.identity) }
            writer?.enabled = true; writer?.invalidateSource(); writer?.lastPublishedAt = nil; writer?.retryAt = nil
            if let roster = currentRoster() { writer?.observe(roster, at: now()) }
            try persistWriter()
            keepPublisherActive()
            status = "Sharing enabled. This Mac must stay running and online."
        } catch {
            if token == generation { writer?.enabled = false; status = message(error) }
        }
        guard token == generation else { return }
        busy = false
        await publishIfNeeded(force: true)
    }

    func stopSharing(delete: Bool = false) async {
        // User stop takes precedence over an in-flight save. Persist intent before any network work.
        generation += 1; let token = generation; busy = true
        releaseActivity()
        if writer == nil { busy = false; return }
        writer?.enabled = false
        if delete || writer?.intent == .delete { writer?.intent = .delete } else { writer?.intent = .stop }
        writer?.retryAt = nil; writer?.invalidateSource()
        do { try persistRevocation(); try persistWriter() }
        catch {
            try? disk.remove("publisher.json")
            status = "Sharing stopped in this process, but the stop could not be saved. Retry before quitting."
            await transport.invalidate()
            if token == generation { busy = false }
            return
        }
        status = delete ? "Sharing stopped. Remote deletion is pending." : "Sharing stopped. Sending the stopped state is pending."
        await transport.invalidate()
        guard token == generation else { return }
        busy = false
        await publishIfNeeded(force: true)
    }

    func sourceWasInvalidated() async {
        guard writer?.enabled == true else { return }
        generation += 1; let token = generation; busy = true
        writer?.invalidateSource(); writer?.lastPublishedAt = nil
        await transport.invalidate()
        guard token == generation else { return }
        busy = false
        await publishIfNeeded(force: true)
    }

    func publishIfNeeded(force: Bool = false) async {
        guard !busy, var journal = writer, journal.enabled || journal.intent != .none else { return }
        let roster = currentRoster()
        if let roster { journal.observe(roster, at: now()) } else { journal.invalidateSource() }
        let sourceState: RemoteSourceState = roster == nil ? .unavailable : .observed
        writer = journal
        do { try persistWriter() }
        catch { status = "The local outbox could not be saved. Cloud publication is paused."; return }
        guard force || journal.isDue(source: sourceState, at: now()) else { return }
        busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let account = try await transport.account()
            guard token == generation else { return }
            guard account.identity == journal.account else { throw RemoteObservationError.pendingOriginalAccount }
            if journal.enabled { keepPublisherActive() }
            if journal.intent != .none {
                try await transport.quiesce()
                guard token == generation else { return }
            }
            if journal.intent == .delete {
                try await transport.delete(installation: journal.installationID, account: account)
                guard token == generation else { return }
                journal.intent = .none; journal.episodes.removeAll(); journal.bindings.removeAll()
                journal.lastPublishedAt = nil; journal.lastSourceState = nil; journal.failures = 0; journal.retryAt = nil
                writer = journal; try persistWriter()
                try disk.remove("publisher-revocation.json")
                status = "Remote data and its notification subscriptions were deleted. Sharing is off."
                return
            }
            let fresh = journal.intent == .stop ? nil : currentRoster()
            if let fresh { journal.observe(fresh, at: now()) } else { journal.invalidateSource() }
            let mutations = journal.intent == .stop ? [] : journal.mutations(roster: fresh, at: now())
            guard journal.revision < Int.max else { throw RemoteObservationError.invalidData }
            journal.revision += 1
            for mutation in mutations {
                if let index = journal.episodes.firstIndex(where: { $0.event.id == mutation.event.id }) { journal.episodes[index].attempted = true }
            }
            writer = journal; try persistWriter() // Stable identities/revision precede an ambiguous cloud commit.
            let summary = journal.snapshot(roster: fresh, at: now(), disabled: journal.intent == .stop)
            try await transport.publish(summary, events: mutations, account: account)
            guard token == generation else { return }
            for mutation in mutations {
                if let index = journal.episodes.firstIndex(where: { $0.event.id == mutation.event.id }) { journal.episodes[index].acknowledged = true }
            }
            journal.lastPublishedAt = now(); journal.lastSourceState = summary.sourceState
            journal.failures = 0; journal.retryAt = nil
            if journal.intent == .stop {
                journal.intent = .none; journal.episodes.removeAll(); journal.bindings.removeAll()
            }
            writer = journal; try persistWriter()
            if summary.sourceState == .disabled { try disk.remove("publisher-revocation.json") }
            status = summary.sourceState == .disabled ? "Sharing is off. The stopped state was saved remotely."
                : "Observation saved. Notification delivery is determined by Apple."
            await cleanupIfNeeded(account: account, token: token)
        } catch {
            guard token == generation else { return }
            writer?.failures += 1
            writer?.retryAt = now().addingTimeInterval(RemoteObservationPolicy.retryDelay(attempt: writer?.failures ?? 1,
                retryAfter: (error as? CKError)?.retryAfterSeconds, jitter: jitter()))
            if error as? RemoteObservationError == .anotherPublisher || (error as? CKError)?.code == .quotaExceeded
                || error as? RemoteObservationError == .noAccount || (error as? CKError)?.code == .notAuthenticated
                || (error as? CKError)?.code == .permissionFailure {
                writer?.enabled = false; releaseActivity()
            }
            do { try persistWriter(); status = message(error) }
            catch { status = "The outbox could not be saved. Publication is paused; retry when local storage is available." }
        }
    }

    func enableReceiving() async {
        guard !busy else { return }
        busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let account = try await transport.account()
            guard token == generation else { return }
            if reader.unsubscribePending { throw RemoteObservationError.pendingOriginalAccount }
            if reader.account != account.identity { try clearReader(); reader = RemoteReaderJournal() }
            reader.account = account.identity; reader.receiving = true
            try persistReader()
            try disk.remove("receiver-disabled.json")
            status = "Remote monitoring enabled."
        } catch { if token == generation { status = message(error) }; return }
        guard token == generation else { return }
        busy = false
        await refresh(force: true)
    }

    func stopReceiving() async {
        generation += 1; let token = generation; busy = true
        reader.receiving = false; reader.notifications = false
        reader.unsubscribePending = reader.installationID != nil
        hideReader() // Privacy does not depend on the filesystem accepting another write.
        #if os(iOS)
        if automaticLifecycle {
            UIApplication.shared.unregisterForRemoteNotifications()
            pushRegistrationConfirmed = nil
        }
        #endif
        var storageReady = true
        do { try disk.write(["version": 1], to: "receiver-disabled.json"); try persistReader(); try clearReader() }
        catch {
            storageReady = false
            try? disk.remove("receiver.json")
            status = "Receiving stopped in this process. Local cleanup could not be saved; retry before quitting."
        }
        await transport.invalidate()
        guard token == generation else { return }
        busy = false; readerRetryAt = nil
        guard storageReady else { return }
        await refresh(force: true)
    }

    func enableNotifications() async {
        guard reader.receiving, let installation = reader.installationID, !busy else {
            notificationStatus = "Enable remote monitoring and refresh a shared Mac observation first."; return
        }
        busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do {
            #if os(iOS)
            if automaticLifecycle {
                let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                guard token == generation else { return }
                guard allowed else { notificationStatus = "Notifications are off. You can enable them in iOS Settings."; return }
            }
            #endif
            let account = try await transport.account()
            guard token == generation, account.identity == reader.account else { throw RemoteObservationError.accountChanged }
            #if os(iOS)
            if automaticLifecycle { registerForPush() }
            #endif
            try await transport.subscribe(installation: installation, receiver: reader.receiverID, enabled: true, account: account)
            guard token == generation else { return }
            reader.notifications = true; try persistReader()
            #if os(iOS)
            notificationStatus = pushSetupStatus
            #else
            notificationStatus = "CloudKit notification subscription saved."
            #endif
        } catch { if token == generation { notificationStatus = message(error) } }
    }

    func notificationOpened(id: UUID?) async {
        selectedTab = .remote
        if let id {
            if attentionEvent?.id != id { attentionEvent = nil }
            pendingEventID = id
            attentionStatus = "Checking this attention update…"
        }
        guard reader.receiving else { status = "Remote receiving is off. Enable it to inspect this notification."; return }
        await refresh(force: true)
    }

    func notificationArrived(id: UUID?) async {
        // An incoming banner refreshes the current inspection; only a user tap selects another episode.
        await refresh(force: true)
    }

    #if os(iOS)
    private var pushSetupStatus: String {
        switch pushRegistrationConfirmed {
        case true?:
            return "Notifications enabled. Apple may delay or suppress alerts and forwards eligible alerts to your Watch."
        case false?:
            return "CloudKit subscription saved. This iPhone could not register for push notifications."
        case nil:
            return "CloudKit subscription saved. This iPhone is waiting for push registration."
        }
    }

    private func registerForPush() {
        if UIApplication.shared.isRegisteredForRemoteNotifications {
            pushRegistrationConfirmed = true
        }
        UIApplication.shared.registerForRemoteNotifications()
    }

    func pushRegistrationChanged(confirmed: Bool) {
        guard reader.receiving else { return }
        pushRegistrationConfirmed = confirmed
        if reader.notifications { notificationStatus = pushSetupStatus }
    }
    #endif

    func refresh(force: Bool = false) async {
        guard !busy, reader.receiving || reader.unsubscribePending else { return }
        if !force {
            if let readerRetryAt, now() < readerRetryAt { return }
            if pendingEventID == nil, let lastReadAt, now().timeIntervalSince(lastReadAt) < RemoteObservationPolicy.publishInterval { return }
        }
        busy = true; let token = generation
        defer { if token == generation { busy = false } }
        do {
            let account = try await transport.account()
            guard token == generation else { return }
            guard account.identity == reader.account else { throw RemoteObservationError.accountChanged }
            if reader.unsubscribePending, let installation = reader.installationID {
                try await transport.quiesce()
                guard token == generation else { return }
                try await transport.subscribe(installation: installation, receiver: reader.receiverID, enabled: false, account: account)
                guard token == generation else { return }
                reader.unsubscribePending = false; try persistReader()
            }
            guard reader.receiving else { status = "Receiving stopped. This phone's subscription and saved reader were cleared."; return }
            #if os(iOS)
            if automaticLifecycle && reader.notifications { registerForPush() }
            #endif
            // A missing local iCloud token withholds offline contents; online account verification can restore them.
            if snapshot == nil, let cache = disk.read("reader.json", as: RemoteObservationCache.self),
               cache.version == 1, cache.account == account.identity, (try? cache.snapshot.validate()) != nil,
               cache.snapshot.freshness(at: now()) != .expired, cache.snapshot.freshness(at: now()) != .unknown {
                snapshot = cache.snapshot; attentionEvent = cache.event; usingCache = true
            }
            let fetched = try await transport.snapshot(account: account)
            guard token == generation else { return }
            if let fetched {
                try fetched.validate()
                guard now() < fetched.expiresAt else { try clearReader(); lastReadAt = now(); status = "The shared observation expired."; return }
                // A different Mac never inherits another installation's subscription implicitly.
                if let previous = reader.installationID, previous != fetched.installationID, reader.notifications {
                    try await transport.subscribe(installation: previous, receiver: reader.receiverID, enabled: false, account: account)
                    guard token == generation else { return }
                }
                reader.installationID = fetched.installationID
                snapshot = fetched; usingCache = false
                if let id = pendingEventID ?? attentionEvent?.id {
                    let event = try await transport.event(id: id, account: account)
                    guard token == generation else { return }
                    // A second tap while this read was suspended owns the next inspection.
                    // Leave its ID queued for the next bounded refresh instead of clearing it.
                    if let pendingEventID, pendingEventID != id { return }
                    if let event { try event.validate() }
                    attentionEvent = event?.installationID == fetched.installationID ? event : nil
                    pendingEventID = nil
                    attentionStatus = attentionEvent == nil ? "This alert is unavailable or was deleted. No current wait is confirmed." : ""
                }
                if reader.notifications {
                    try await transport.subscribe(installation: fetched.installationID, receiver: reader.receiverID, enabled: true, account: account)
                    guard token == generation else { return }
                }
                try disk.write(RemoteObservationCache(account: account.identity, localIdentity: localIdentity(),
                    snapshot: fetched, event: attentionEvent), to: "reader.json")
                try persistReader()
                status = "Fetched the Mac's original observation."
            } else {
                let inspectingAttention = pendingEventID != nil || attentionEvent != nil
                try clearReader()
                if inspectingAttention {
                    attentionStatus = "The shared summary was deleted or is unavailable. No current response wait is confirmed."
                }
                status = "No shared observation. Sharing may not be set up or the remote data was deleted."
            }
            lastReadAt = now(); readerFailures = 0; readerRetryAt = nil
            await cleanupIfNeeded(account: account, token: token)
        } catch {
            guard token == generation else { return }
            if error as? RemoteObservationError == .accountChanged || error as? RemoteObservationError == .noAccount {
                reader.receiving = false; reader.notifications = false
                reader.unsubscribePending = reader.installationID != nil
                hideReader()
                do {
                    try disk.write(["version": 1], to: "receiver-disabled.json")
                    try persistReader(); try clearReader()
                } catch { try? disk.remove("receiver.json") }
            }
            readerFailures += 1
            readerRetryAt = now().addingTimeInterval(RemoteObservationPolicy.retryDelay(attempt: readerFailures,
                retryAfter: (error as? CKError)?.retryAfterSeconds, jitter: jitter()))
            usingCache = snapshot != nil
            if pendingEventID != nil { attentionStatus = "This attention update could not be checked. Its current state is unknown." }
            status = message(error)
        }
    }

    private func cleanupIfNeeded(account: RemoteObservationAccount, token: Int) async {
        guard token == generation, lastCleanupAt == nil || now().timeIntervalSince(lastCleanupAt!) >= RemoteObservationContract.cleanupInterval else { return }
        do {
            try await transport.cleanup(at: now(), account: account)
            guard token == generation else { return }
            lastCleanupAt = now()
        } catch {
            // Content expiry is immediate in the reader; physical cloud cleanup is retryable.
            if token == generation { notificationStatus = "Expired cloud records could not be cleaned up yet. Cleanup will retry while the app runs." }
        }
    }

    func accountChanged() async {
        generation += 1; let token = generation; busy = true
        releaseActivity()
        writer?.revokeConsent()
        reader.receiving = false; reader.notifications = false
        reader.unsubscribePending = reader.installationID != nil
        hideReader()
        #if os(iOS)
        if automaticLifecycle {
            UIApplication.shared.unregisterForRemoteNotifications()
            pushRegistrationConfirmed = nil
        }
        #endif
        var storageReady = true
        do {
            try persistRevocation(); try persistWriter()
            try disk.write(["version": 1], to: "receiver-disabled.json"); try persistReader(); try clearReader()
        }
        catch {
            storageReady = false
            try? disk.remove("publisher.json")
            try? disk.remove("receiver.json")
            status = "Account changed. Local consent cleanup needs a retry before quitting."
        }
        await transport.invalidate()
        guard token == generation else { return }
        busy = false; lastReadAt = nil; readerRetryAt = nil
        if storageReady { status = "iCloud account changed. Sharing and receiving are off; pending cleanup stays bound to the original account." }
    }

    private func message(_ error: Error) -> String {
        switch error as? RemoteObservationError {
        case .noAccount: return "Sign in to iCloud to use remote monitoring. No old-account data will be uploaded."
        case .unverifiedAccount: return "iCloud identity could not be verified. Saved data is retained privately; retry when available."
        case .accountChanged: return "The iCloud account changed. Receiving is off and the old reader was cleared."
        case .pendingOriginalAccount: return "Pending stop, deletion or subscription cleanup belongs to the original iCloud account. Reconnect that account and retry cleanup first."
        case .anotherPublisher: return "Another Mac owns the remote observation. Sharing is off; its data was preserved."
        case .unsupportedSchema: return "This remote observation needs a newer AgentDeck. The last readable observation is retained."
        case .operationUnsettled: return "An earlier cloud write has not settled. Cleanup remains pending and will be retried."
        default:
            if (error as? CKError)?.code == .quotaExceeded { return "iCloud storage is full. Sharing is paused; free storage and enable it again." }
            if (error as? CKError)?.code == .notAuthenticated { return "iCloud authorization needs attention. Sharing is paused." }
            if writer?.intent == .delete { return "Sharing is off. Remote deletion is not confirmed; retry when the original account is online." }
            if writer?.intent == .stop { return "Sharing is off. The remote stopped state is not confirmed; retry when online." }
            return "Cloud access could not be confirmed. The original observation time is unchanged; retry when online."
        }
    }
}
