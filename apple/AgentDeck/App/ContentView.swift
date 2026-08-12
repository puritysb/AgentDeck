// ContentView.swift — Single-screen layout: terrarium + HUD + gear icon

import SwiftUI
import StoreKit

struct ContentView: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.requestReview) private var requestReview

    private var liveSessions: [SessionInfo] {
        stateHolder.state.siblingSessions
            .filter(\.alive)
            .sorted { $0.id < $1.id }
    }

    private var isNaturalReviewPause: Bool {
        AppReviewPromptPolicy.isNaturalPause(sessionStates: liveSessions.map(\.state))
    }

    private var reviewTaskKey: String {
        let sessions = liveSessions
            .map { "\($0.id):\($0.state ?? "unknown")" }
            .joined(separator: ",")
        return "\(scenePhase)-\(sessions)"
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
              isNaturalReviewPause else { return }

        let policy = AppReviewPromptPolicy()
        policy.recordMeaningfulUse()
        guard policy.shouldRequestReview() else { return }

        // Wait for the session list/dashboard transition to settle. Any live
        // session state change cancels this task and restarts the quiet period.
        do {
            try await Task.sleep(nanoseconds: 2_000_000_000)
        } catch {
            return
        }
        guard scenePhase == .active, isNaturalReviewPause else { return }

        policy.markRequestAttempt()
        requestReview()
    }
}
