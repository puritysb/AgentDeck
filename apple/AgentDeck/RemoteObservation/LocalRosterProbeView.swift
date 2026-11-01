#if AGENTDECK_CLOUDKIT_POC && os(macOS)
import SwiftUI
import Combine
import CloudKit

@MainActor
final class LocalRosterProbeModel: ObservableObject {
    @Published private(set) var summary: RemoteRosterSummary?
    @Published private(set) var status = "Local observation is off"
    @Published private(set) var busy = false
    private var source: AgentStateHolder?
    private var subscription: AnyCancellable?
    private var tracker = RemoteWaitTracker()
    private let store = CloudKitProbeStore()
    private var pendingEpisodes: [UUID: Date] = [:]
    private var generation = 0
    private var accountObserver: NSObjectProtocol?

    init() {
        accountObserver = NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.stop()
                await self?.store.invalidateAccount()
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
        status = "Reading the local daemon; nothing is shared automatically"
    }

    private func inspect() {
        guard let snapshot = source?.attentionSessionSnapshot,
              snapshot.endpoint == PairingCredential.endpoint(of: "ws://127.0.0.1:9120"),
              snapshot.isFresh() else {
            tracker.invalidate()
            summary = nil
            return
        }
        let evidence = snapshot.sessions.map { session in
            RemoteSessionEvidence(localID: session.id, alive: session.alive,
                working: session.state == AgentConnectionState.processing.rawValue,
                waitingForResponse: AgentConnectionState(rawValue: session.state ?? "")?.isAwaiting == true
                    && !(session.question?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true))
        }
        let transition = tracker.observe(evidence, at: snapshot.receivedAt)
        summary = transition.summary
        for id in transition.resolved { pendingEpisodes.removeValue(forKey: id) }
        for id in transition.started where pendingEpisodes.count < 32 {
            pendingEpisodes[id] = snapshot.receivedAt
        }
        pendingEpisodes = pendingEpisodes.filter { Date().timeIntervalSince($0.value) < 300 }

    }

    func stop() {
        generation += 1
        pendingEpisodes.removeAll()
        subscription = nil
        source?.prepareForTermination()
        source = nil
        summary = nil
        tracker = RemoteWaitTracker()
        status = "Local observation stopped"
    }

    func deleteSharedSummary() async {
        guard !busy else { return }
        busy = true
        let token = generation
        defer { busy = false }
        do {
            let account = try await store.checkAccount()
            guard token == generation else { return }
            try await store.deleteRoster(account: account)
            status = "Shared summary deleted. Local observation can continue."
        } catch {
            guard token == generation else { return }
            status = "Deletion not confirmed. Retry when online."
        }
    }

    func shareOnce(includeCurrentWaits: Bool = false) async {
        guard !busy else { return }
        inspect()
        guard let summary, Date().timeIntervalSince(summary.observedAt) < 20 else {
            status = "A fresh local roster is required"
            return
        }
        if includeCurrentWaits {
            for id in tracker.currentWaitIDs.prefix(32) where pendingEpisodes[id] == nil {
                pendingEpisodes[id] = summary.observedAt
            }
        }
        busy = true
        let token = generation
        defer { busy = false }
        do {
            let account = try await store.checkAccount()
            guard token == generation else { return }
            inspect()
            guard let fresh = self.summary, Date().timeIntervalSince(fresh.observedAt) < 20 else {
                status = "A fresh local roster is required"
                return
            }
            try await store.saveRoster(fresh, account: account)
            guard token == generation else { return }
            for (id, time) in pendingEpisodes.sorted(by: { $0.value < $1.value }) {
                guard token == generation else { return }
                // Revalidate against a fresh roster before each send.
                inspect()
                guard self.summary != nil, pendingEpisodes[id] != nil else { continue }
                try await store.saveWaitEpisode(id: id, occurredAt: time, account: account)
                guard token == generation else { return }
                pendingEpisodes.removeValue(forKey: id)
            }
            status = "Encrypted counts and eligible new wait updates saved. Delivery is not confirmed."
        } catch {
            guard token == generation else { return }
            if (error as? URLError)?.code == .timedOut {
                status = "CloudKit response timed out during \(await store.phase). Save outcome is unknown; retries keep the same wait IDs."
            } else {
                status = "Share not confirmed during \(await store.phase) (\((error as NSError).domain):\((error as NSError).code))"
            }
        }
    }
}

struct LocalRosterProbeView: View {
    @StateObject private var model = LocalRosterProbeModel()
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text("Local work summary · manual experiment").font(.headline)
            Text("Connect reads this Mac only. Share sends encrypted counts and their original observation time to your private iCloud database, once per press. New response waits observed after connection can generate a generic notification; no task text is sent.")
            Button("Connect to local daemon") { model.start() }
            if let summary = model.summary {
                Text("Last observed: \(summary.workingCount) working · \(summary.waitingCount) waiting")
                Text(summary.observedAt, style: .time)
                Button("Share counts and new waits once") { Task { await model.shareOnce() } }
                if summary.waitingCount > 0 {
                    Button("Notify current response waits once") {
                        Task { await model.shareOnce(includeCurrentWaits: true) }
                    }
                }
            }
            Button("Delete shared summary") { Task { await model.deleteSharedSummary() } }
            Button("Stop local observation") { model.stop() }
            Text(model.status).foregroundStyle(.secondary)
        }.disabled(model.busy)
        .onDisappear { model.stop() }
    }
}
#endif
