#if AGENTDECK_CLOUDKIT_POC
import CloudKit
import CryptoKit
import Foundation
import SwiftUI
import UserNotifications
#if os(iOS)
import UIKit
#endif

@MainActor
final class CloudKitProbeModel: ObservableObject {
    static let shared = CloudKitProbeModel()
    @Published private(set) var status = "Not connected"
    @Published private(set) var event: CloudKitProbeEvent?
    @Published private(set) var busy = false
    @Published private(set) var roster: RemoteRosterSummary?
    private let store: CloudKitProbeStore
    private let cache: RemoteReaderCache
    private var generation = 0
    private var accountObserver: NSObjectProtocol?
    init(store: CloudKitProbeStore = CloudKitProbeStore(), cache: RemoteReaderCache = RemoteReaderCache()) {
        self.store = store
        self.cache = cache
        guard !AgentDeckApp.isHostedTest() else { return }
        roster = cache.load(localIdentity: RemoteLocalIdentity.current())
        if roster != nil { status = "Restored last observation from this account’s local cache." }
        accountObserver = NotificationCenter.default.addObserver(forName: .CKAccountChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                self?.generation += 1
                self?.event = nil
                self?.roster = nil
                try? self?.cache.clear()
                self?.busy = false
                self?.status = "iCloud account changed. Enable receiving again."
                await self?.store.invalidateAccount()
            }
        }
    }
    func restoreCachedObservation() async {
        guard !AgentDeckApp.isHostedTest(), roster == nil,
              cache.disk.read("reader.json", as: RemoteReaderCache.Envelope.self) != nil else { return }
        status = "Verifying iCloud account before restoring the saved observation…"
        await run("restore")
    }
    func run(_ action: String) async {
        guard !busy else { return }
        busy = true
        let token = generation
        defer { if token == generation { busy = false } }
        if action == "disable" {
            #if os(iOS)
            UIApplication.shared.unregisterForRemoteNotifications()
            #endif
            roster = nil
            event = nil
            try? cache.clear()
        }
        if action == "storage" {
            defer { try? cache.disk.remove("storage-check.json") }
            do {
                try cache.disk.write(["version": 1], to: "storage-check.json")
                guard cache.disk.read("storage-check.json", as: [String: Int].self) == ["version": 1] else {
                    throw CocoaError(.fileReadCorruptFile)
                }
                status = "Local cache storage round trip passed."
            } catch {
                let failure = error as NSError
                status = "Local cache storage failed: \(failure.domain) \(failure.code)."
            }
            return
        }
        do {
            let account = try await store.checkAccount()
            guard token == generation else { return }
            if action == "disable" {
                try await store.unsubscribe(account: account)
                guard token == generation else { return }
                status = "PoC receiving disabled; this reader is cleared."
            } else if action == "send" {
                let result = try await store.sendTest(account: account)
                guard token == generation else { return }
                event = result
                status = "Saved to CloudKit; notification delivery is not confirmed."
            } else if action == "receive" {
                #if os(iOS)
                let allowed = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
                guard allowed else { status = "Notifications are disabled in Settings."; return }
                UIApplication.shared.registerForRemoteNotifications()
                #endif
                try await store.subscribe(account: account)
                guard token == generation else { return }
                status = "Subscription saved. Send a test from the Mac."
            } else if action == "restore" {
                let owner = try await store.accountIdentity(account: account)
                guard token == generation else { return }
                roster = cache.load(localIdentity: RemoteLocalIdentity.current(), verifiedAccount: owner)
                status = roster == nil ? "No saved observation for this account." : "Restored original observation from this account’s local cache."
            } else if action == "roster" {
                let owner = try await store.accountIdentity(account: account)
                guard token == generation else { return }
                roster = cache.load(localIdentity: RemoteLocalIdentity.current(), verifiedAccount: owner)
                let result = try await store.fetchRoster(account: account)
                guard token == generation else { return }
                roster = result
                do {
                    try cache.save(result, account: owner, localIdentity: RemoteLocalIdentity.current())
                    status = "Fetched and cached original source observation."
                } catch {
                    let failure = error as NSError
                    status = "Fetched; durable cache write failed: \(failure.domain) \(failure.code). Retry refresh when storage is available."
                }
            } else {
                let result = try await store.fetchLatest(account: account)
                guard token == generation else { return }
                event = result
                status = "Fetched. Observation time below is unchanged."
            }
        } catch {
            guard token == generation else { return }
            if action == "disable" {
                status = "This device stopped push registration and cleared its reader. Cloud subscription deletion is not confirmed; retry when online."
            } else if (error as? CloudKitProbeStore.ProbeError) == .accountUnverified {
                status = "iCloud account state is unverified. The last saved observation is retained; retry when available."
            } else if (error as? CloudKitProbeStore.ProbeError) == .accountUnavailable
                || (error as? CloudKitProbeStore.ProbeError) == .accountChanged {
                roster = nil; event = nil
                try? cache.clear()
                status = "iCloud identity is unavailable or changed. Reader cleared; enable again when ready."
            } else if action == "roster", (error as? CKError)?.code == .unknownItem {
                roster = nil
                try? cache.clear()
                status = "Shared summary is unavailable or has been deleted."
            } else if (error as? URLError)?.code == .timedOut {
                status = action == "send"
                    ? "CloudKit response timed out. Save outcome is unknown; fetch to check before retrying."
                    : "CloudKit read timed out. Last observation is retained; retry when online."
            } else {
                status = "CloudKit unavailable (\((error as NSError).domain):\((error as NSError).code)). Retry when ready."
            }
        }
    }
}

struct CloudKitProbeView: View {
    @ObservedObject private var model = CloudKitProbeModel.shared
    #if os(iOS)
    @State private var showLocalDashboard = false
    #endif
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("CloudKit delivery experiment").font(.headline)
            Text("Test buttons share synthetic IDs and times. The optional local summary experiment separately shares only encrypted counts and their original observation time.")
            #if os(macOS)
            Button("Send test update") { Task { await model.run("send") } }.disabled(model.busy)
            #else
            Button("Local network dashboard") { showLocalDashboard = true }
            Button("Enable test notifications") { Task { await model.run("receive") } }.disabled(model.busy)
            Button("Disable PoC notifications and clear reader") { Task { await model.run("disable") } }.disabled(model.busy)
            Text("Disabling also removes this experiment’s shared iCloud subscription.").font(.caption)
            #endif
            #if os(macOS)
            LocalRosterProbeView()
            #else
            Button("Check local cache storage") { Task { await model.run("storage") } }.disabled(model.busy)
            Button("Fetch local work summary") { Task { await model.run("roster") } }.disabled(model.busy)
            if let roster = model.roster {
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    if roster.freshness(at: context.date) == .recent || roster.freshness(at: context.date) == .historical {
                        Text("Last observed: \(roster.workingCount) working · \(roster.waitingCount) waiting")
                            .accessibilityIdentifier("remote-observation.counts")
                    }
                    Text("Freshness: \(String(describing: roster.freshness(at: context.date)))")
                    Text(roster.observedAt, style: .time)
                        .accessibilityIdentifier("remote-observation.source-time")
                }
            }
            #endif
            Button("Fetch latest test") { Task { await model.run("fetch") } }.disabled(model.busy)
            Text(model.status).foregroundStyle(.secondary)
            if let event = model.event {
                TimelineView(.periodic(from: .now, by: 15)) { context in
                    Text(event.isExpired(at: context.date) ? "Historical test · expired" : "Test observation")
                    Text(event.occurredAt, style: .date)
                    Text(event.occurredAt, style: .time)
                }
            }
            if model.busy { ProgressView() }
        }.padding()
        #if os(iOS)
        .fullScreenCover(isPresented: $showLocalDashboard) { LocalControlProbeView() }
        .task { await model.restoreCachedObservation() }
        #endif
        #if os(macOS)
        .task {
            guard !AgentDeckApp.isHostedTest() else { return }
            if ProcessInfo.processInfo.environment["AGENTDECK_CLOUDKIT_TEST_SEND"] == "1" {
                await model.run("send")
                NSLog("CloudKit stage A: %@", model.status)
            }
        }
        #endif
    }
}

#if os(iOS)
final class CloudKitProbeDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        await CloudKitProbeModel.shared.run("roster")
        if await CloudKitProbeModel.shared.roster == nil {
            await CloudKitProbeModel.shared.run("fetch")
        }
    }
}
#endif
#endif
