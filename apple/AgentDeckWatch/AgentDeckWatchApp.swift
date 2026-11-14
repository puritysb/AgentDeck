import SwiftUI

/// Development-only Watch reader for the CloudKit remote-observation PoC
/// (docs/apple-remote-observation.md). It reads the encrypted counts the Mac
/// app shares to the user's private CloudKit database; it never connects to a
/// daemon, never answers a prompt and holds no LAN token.
@main
struct AgentDeckWatchApp: App {
    @StateObject private var model = WatchObservationModel()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                WatchSummaryView(model: model)
            }
            .task(id: scenePhase) {
                // Opening the app, or tapping a forwarded iPhone alert, reads
                // the current summary; while active, poll at the publish cadence.
                guard scenePhase == .active else { return }
                await model.refreshIfStale()
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(RemoteObservationPolicy.publishInterval))
                    guard !Task.isCancelled else { return }
                    await model.refresh()
                }
            }
        }
    }
}
