#if AGENTDECK_CLOUDKIT_POC && os(macOS)
import SwiftUI
import Combine
import CloudKit

@MainActor
final class LocalRosterProbeModel: ObservableObject {
    static let shared = LocalRosterProbeModel()
    @Published private(set) var summary: RemoteRosterSummary?
    @Published private(set) var status = "Local observation is off"
    @Published private(set) var busy = false
    @Published private(set) var automatic = false
    private var source: AgentStateHolder?
    private var subscription: AnyCancellable?
    private var state = RemotePublisherState(account: "")
    private let disk: RemoteProbeDisk
    private let store: CloudKitProbeStore
    private var generation = 0
    private var scheduler: Task<Void, Never>?
    private var resumeTask: Task<Void, Never>?
    private var activity: NSObjectProtocol?
    private var accountObserver: NSObjectProtocol?

    init(disk: RemoteProbeDisk = RemoteProbeDisk(), store: CloudKitProbeStore = CloudKitProbeStore()) {
        self.disk = disk
        self.store = store
        guard !AgentDeckApp.isHostedTest() else { return }
        accountObserver = NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.stop(cancelWrites: false)
                self.state = RemotePublisherState(account: "")
                try? self.disk.remove("publisher.json")
                await self.store.invalidateAccount()
            }
        }
    }

    func start() {
        guard source == nil else { return }
        let holder = AgentStateHolder()
        source = holder
        holder.connectTo(url: "ws://127.0.0.1:9120")
        subscription = holder.$state.sink { [weak self] _ in
            Task { @MainActor [weak self] in self?.inspect() }
        }
        status = "Reading the local daemon; sharing requires explicit enablement"
    }

    private func inspect() {
        guard let snapshot = source?.attentionSessionSnapshot,
              snapshot.endpoint == PairingCredential.endpoint(of: "ws://127.0.0.1:9120"), snapshot.isFresh() else {
            state.tracker.invalidate()
            summary = nil
            return
        }
        let evidence = snapshot.sessions.map { session in
            RemoteSessionEvidence(localID: session.id, alive: session.alive,
                working: session.state == AgentConnectionState.processing.rawValue,
                waitingForResponse: AgentConnectionState(rawValue: session.state ?? "")?.isAwaiting == true
                    && !(session.question?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true))
        }
        let previous = state
        summary = state.observe(evidence, at: snapshot.receivedAt)
        if automatic && state != previous { persist() }
    }

    @discardableResult
    private func persist() -> Bool {
        do { try disk.write(state, to: "publisher.json"); return true }
        catch {
            state.failures += 1
            state.retryAt = Date().addingTimeInterval(RemoteObservationPolicy.retryDelay(attempt: state.failures))
            status = "Local outbox could not be stored; publication is paused until storage recovers."
            return false
        }
    }

    func enableAutomatic(restoring: Bool = false) async {
        guard !busy, !automatic else { return }
        if restoring, disk.read("publisher.json", as: RemotePublisherState.self)?.enabled != true { return }
        busy = true
        let token = generation
        defer { if token == generation { busy = false } }
        do {
            let account = try await store.checkAccount()
            let identity = try await store.accountIdentity(account: account)
            guard token == generation else { return }
            if var saved = disk.read("publisher.json", as: RemotePublisherState.self), saved.version == 1,
               saved.pending.count <= RemoteObservationPolicy.pendingLimit, saved.account == identity {
                saved.prepareAfterRestart()
                state = saved
            } else {
                guard !restoring else {
                    try? disk.remove("publisher.json")
                    status = "Cloud account changed or saved state is invalid. Enable sharing again."
                    return
                }
                state = RemotePublisherState(account: identity)
            }
            state.enabled = true
            guard persist() else { return }
            automatic = true
            if activity == nil {
                activity = ProcessInfo.processInfo.beginActivity(options: .userInitiatedAllowingIdleSystemSleep,
                    reason: "Publish explicitly enabled AgentDeck remote observations")
            }
            start()
            scheduler = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.tick()
                    do { try await Task.sleep(for: .seconds(5)) } catch { return }
                }
            }
            status = "Automatic sharing enabled; original source times are preserved"
        } catch {
            guard token == generation else { return }
            status = "Automatic sharing is not connected; saved outbox is retained for this account. Retry when online."
        }
    }

    func restoreWhenReady() async {
        guard !AgentDeckApp.isHostedTest() else { return }
        guard resumeTask == nil, !automatic else { return }
        resumeTask = Task { [weak self] in
            defer { self?.resumeTask = nil }
            while !Task.isCancelled {
                guard let self, self.disk.read("publisher.json", as: RemotePublisherState.self)?.enabled == true else { return }
                await self.enableAutomatic(restoring: true)
                if self.automatic { return }
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
            }
        }
    }

    private func tick() async {
        guard automatic, !busy else { return }
        inspect()
        guard summary != nil, state.shouldPublish(at: Date()) else { return }
        await shareOnce()
    }

    private func releaseActivity() {
        if let activity { ProcessInfo.processInfo.endActivity(activity); self.activity = nil }
    }

    func stop(cancelWrites: Bool = true) {
        generation += 1
        busy = false
        resumeTask?.cancel(); resumeTask = nil
        scheduler?.cancel(); scheduler = nil
        automatic = false
        releaseActivity()
        state.enabled = false
        state.pending.removeAll()
        state.tracker = RemoteWaitTracker()
        if !state.account.isEmpty { persist() }
        subscription = nil
        source?.prepareForTermination(); source = nil
        summary = nil
        status = "Local observation and automatic sharing stopped"
        if cancelWrites { Task { await store.invalidateAccount() } }
    }

    func deleteSharedSummary() async {
        guard !busy else { return }
        stop(cancelWrites: false) // Prevent an automatic tick from recreating a deleted summary.
        busy = true
        let token = generation
        defer { if token == generation { busy = false } }
        do {
            await store.invalidateAccount()
            let account = try await store.checkAccount()
            guard token == generation else { return }
            try await store.deleteRoster(account: account)
            guard token == generation else { return }
            status = "Shared summary deleted; automatic sharing is off."
        } catch {
            guard token == generation else { return }
            status = "Sharing stopped; cloud deletion is not confirmed. Retry when online."
        }
    }

    func shareOnce(includeCurrentWaits: Bool = false) async {
        guard !busy else { return }
        inspect()
        guard let summary, Date().timeIntervalSince(summary.observedAt) >= 0,
              Date().timeIntervalSince(summary.observedAt) < RemoteObservationPolicy.sourceLifetime else {
            status = "A fresh local roster is required"; return
        }
        if includeCurrentWaits {
            let pending = Set(state.pending.map(\.id))
            for id in state.tracker.currentWaitIDs where !pending.contains(id) && state.pending.count < RemoteObservationPolicy.pendingLimit {
                state.pending.append(.init(id: id, occurredAt: summary.observedAt))
            }
        }
        busy = true
        let token = generation
        defer { if token == generation { busy = false } }
        do {
            let account = try await store.checkAccount()
            let identity = try await store.accountIdentity(account: account)
            guard token == generation else { return }
            if state.account.isEmpty { state.account = identity }
            guard state.account == identity else { stop(); status = "Cloud account changed. Enable sharing again."; return }
            inspect()
            guard let fresh = self.summary, Date().timeIntervalSince(fresh.observedAt) < RemoteObservationPolicy.sourceLifetime else { return }
            let attentionRevision = state.attentionRevision
            state.revision += 1
            guard persist() else { return } // Persist episode IDs BEFORE submitting anything.
            try await store.saveRoster(fresh, account: account, installation: state.installation, revision: state.revision)
            guard token == generation else { return }
            for episode in state.eligible(at: Date()) {
                inspect()
                guard token == generation, self.summary != nil,
                      state.eligible(at: Date()).contains(where: { $0.id == episode.id }) else { continue }
                // Resolve a prior ambiguous save by identity; never mint another event ID.
                if try await !store.waitEpisodeExists(id: episode.id, account: account) {
                    try await store.saveWaitEpisode(id: episode.id, occurredAt: episode.occurredAt, account: account)
                }
                guard token == generation else { return }
                state.pending.removeAll { $0.id == episode.id }
                guard persist() else { return }
            }
            state.publishedAttentionRevision = attentionRevision
            state.lastPublishedAt = Date(); state.failures = 0; state.retryAt = nil
            persist()
            status = "Encrypted summary and eligible waits saved. Notification delivery is not confirmed."
        } catch {
            guard token == generation else { return }
            state.failures += 1
            let ck = error as? CKError
            if ck?.code == .notAuthenticated || ck?.code == .permissionFailure || ck?.code == .quotaExceeded
                || (error as? CloudKitProbeStore.ProbeError) == .publisherConflict {
                automatic = false; state.enabled = false
                releaseActivity()
                scheduler?.cancel(); scheduler = nil
                if (error as? CloudKitProbeStore.ProbeError) == .publisherConflict {
                    status = "Another installation owns the shared summary. Automatic sharing is off."
                } else if ck?.code == .quotaExceeded {
                    status = "iCloud quota is exceeded. Automatic sharing is off; retry enablement after storage is available."
                } else {
                    status = "iCloud authorization needs attention. Automatic sharing is off; retry enablement when ready."
                }
            } else {
                let delay = RemoteObservationPolicy.retryDelay(attempt: state.failures,
                    retryAfter: ck?.retryAfterSeconds, jitter: Double.random(in: 0.8...1.2))
                state.retryAt = Date().addingTimeInterval(delay)
                status = "Cloud save outcome is unconfirmed; retained event IDs will retry after backoff."
            }
            persist()
        }
    }
}

struct LocalRosterProbeView: View {
    @ObservedObject private var model = LocalRosterProbeModel.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Local work summary · development experiment").font(.headline)
            Text("Sharing sends encrypted counts and original observation times to your private iCloud database. New response waits produce generic notifications; no task text leaves this Mac. Automatic sharing continues while this app runs and resumes for the same verified account after relaunch.")
            Button("Connect to local daemon") { model.start() }
            Button(model.automatic ? "Automatic sharing enabled" : "Enable automatic sharing") { Task { await model.enableAutomatic() } }
                .disabled(model.automatic || model.busy)
            if let summary = model.summary {
                Text("Last observed: \(summary.workingCount) working · \(summary.waitingCount) waiting")
                Text(summary.observedAt, style: .time)
                Button("Share counts and new waits once") { Task { await model.shareOnce() } }
                if summary.waitingCount > 0 {
                    Button("Notify current response waits once") { Task { await model.shareOnce(includeCurrentWaits: true) } }
                }
            }
            Button("Delete shared summary") { Task { await model.deleteSharedSummary() } }
            Button("Stop sharing and observation") { model.stop() }
            Text(model.status).foregroundStyle(.secondary)
        }
        .task { await model.restoreWhenReady() }
    }
}
#endif
