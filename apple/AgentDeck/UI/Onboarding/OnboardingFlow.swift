import SwiftUI

/// First-run navigation is independent of authorization: skipping or going back
/// never revokes access, installs an integration, or fabricates a live session.
@MainActor
final class OnboardingFlow: ObservableObject {
    enum Step: Int, CaseIterable { case appearance, agents, ready }
    enum Interest: String, CaseIterable, Identifiable {
        case mac, streamDeck, displays
        var id: String { rawValue }
        var title: String {
            switch self {
            case .mac: "Just this Mac"
            case .streamDeck: "I have a Stream Deck"
            case .displays: "Explore other screens"
            }
        }
    }
    @Published private(set) var step: Step = .appearance
    @Published var interest: Interest = .mac
    func next() { step = Step(rawValue: step.rawValue + 1) ?? .ready }
    func back() { step = Step(rawValue: step.rawValue - 1) ?? .appearance }

    enum Observation: Equatable {
        case receiving, ready, notConfigured
        static func resolve(installed: Bool, live: Bool) -> Self {
            if live { return .receiving }
            return installed ? .ready : .notConfigured
        }
        var title: String {
            switch self {
            case .receiving: "Session visible"
            case .ready: "Ready for the next activity"
            case .notConfigured: "Not set up"
            }
        }
    }

    nonisolated static func hasLiveSession(_ agent: String?, dashboard: DashboardState) -> Bool {
        guard dashboard.bridgeConnected else { return false }
        return dashboard.siblingSessions.contains { session in
            guard session.alive, session.state != "disconnected" else { return false }
            guard let agent else { return true }
            return session.agentType == agent || (agent == "claude" && session.agentType == "claude-code")
                || (agent == "codex" && ["codex-app", "codex-cli"].contains(session.agentType ?? ""))
        }
    }

    /// nil preserves the behaviour of installations that predate guided setup.
    /// An explicit empty selection means the user chose to look around first.
    static func shouldSuggest(_ agent: String, selected: [String]?, configured: Bool, live: Bool) -> Bool {
        selected == nil || selected?.contains(agent) == true || configured || live
    }
}

/// Uses the real renderers; this empty habitat is explicitly a theme preview,
/// never synthetic activity placed into the user's session store.
struct OnboardingAppearance: View {
    @EnvironmentObject private var preferences: AppPreferences
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Make yourself at home").font(.title.bold())
            Text("See your AI work, recent results and usage in one place. Choose a view — you can change it later in Settings.")
                .foregroundStyle(.secondary)
            Picker("Appearance", selection: $preferences.dashboardType) {
                ForEach(AppPreferences.DashboardType.available) { theme in
                    Text(theme == .standard ? "2D aquarium" : "3D aquarium · Preview").tag(theme)
                }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("onboarding-appearance")
            Group {
                if preferences.effectiveDashboardType == .aquarium3D {
                    if #available(iOS 18.0, macOS 15.0, *) {
                        LivingAquariumScene()
                    }
                } else {
                    TerrariumView(terrariumState: TerrariumState())
                }
            }
            .frame(height: 210)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .allowsHitTesting(false)
            .accessibilityLabel("Appearance preview, no live sessions")
            Text("Appearance preview · Your sessions appear after you connect an agent.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}
