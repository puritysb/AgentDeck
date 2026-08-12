// ContentView.swift — Single-screen layout: terrarium + HUD + gear icon

import SwiftUI
import StoreKit

struct ContentView: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.requestReview) private var requestReview

    private var liveSessionIDs: [String] {
        stateHolder.state.siblingSessions
            .filter(\.alive)
            .map(\.id)
            .sorted()
    }

    private var reviewTaskKey: String {
        "\(scenePhase)-\(liveSessionIDs.joined(separator: ","))"
    }

    var body: some View {
        MonitorScreen()
            .onAppear {
                #if os(iOS)
                stateHolder.startConnectionWaterfall()
                #endif
            }
            .onChange(of: scenePhase) { _, newPhase in
                switch newPhase {
                case .active:
                    stateHolder.handleForegroundReturn()
                case .background:
                    stateHolder.handleBackgroundEntry()
                default:
                    break
                }
            }
            .task(id: reviewTaskKey) {
                await considerAppStoreReview()
            }
    }

    @MainActor
    private func considerAppStoreReview() async {
        guard await AppReviewPromptPolicy.isProductionAppStoreInstall(),
              scenePhase == .active,
              !liveSessionIDs.isEmpty else { return }

        let policy = AppReviewPromptPolicy()
        policy.recordMeaningfulUse()
        guard policy.shouldRequestReview() else { return }

        // Wait for the session list/dashboard transition to settle. Changes to
        // the live-session set cancel this task and restart the quiet period.
        do {
            try await Task.sleep(nanoseconds: 2_000_000_000)
        } catch {
            return
        }
        guard scenePhase == .active, !liveSessionIDs.isEmpty else { return }

        policy.markRequestAttempt()
        requestReview()
    }
}
