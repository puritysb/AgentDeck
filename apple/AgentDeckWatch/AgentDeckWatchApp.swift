import SwiftUI
import UserNotifications
import WatchKit

/// Read-only Watch companion for Remote observation
/// (docs/apple-remote-observation.md). It reads the encrypted Remote V1 snapshot
/// the Mac app shares to the user's private CloudKit database; it never connects
/// to a daemon, never answers a prompt and holds no LAN token. Attention alerts
/// arrive by Apple's iPhone notification forwarding and render in
/// `AttentionNotificationView`.
@main
struct AgentDeckWatchApp: App {
    @StateObject private var model = WatchObservationModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            WatchRootView(model: model)
                .task(id: scenePhase) {
                    // Opening the app, or tapping a forwarded alert, reads the current
                    // snapshot; while active, poll at the publish cadence.
                    guard scenePhase == .active else { return }
                    await model.refreshIfStale()
                    while !Task.isCancelled {
                        try? await Task.sleep(for: .seconds(RemoteObservationPolicy.publishInterval))
                        guard !Task.isCancelled else { return }
                        await model.refresh()
                    }
                }
        }
        WKNotificationScene(controller: AttentionNotificationController.self,
                            category: RemoteObservationContract.attentionCategory)
    }
}
