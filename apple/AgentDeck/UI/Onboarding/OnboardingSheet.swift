#if os(macOS)
import SwiftUI

struct OnboardingSheet: View {
    @EnvironmentObject private var preferences: AppPreferences
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var daemonService: DaemonService
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openWindow) private var openWindow
    @StateObject private var flow: OnboardingFlow

    init(flow: OnboardingFlow = OnboardingFlow()) {
        _flow = StateObject(wrappedValue: flow)
    }
    @State private var feedback: [String: String] = [:]
    @State private var showsOtherAgents = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    switch flow.step {
                    case .appearance:
                        OnboardingAppearance()
                        Text("This Mac is all you need. Extra devices are optional.")
                            .font(.callout)
                    case .agents: agents
                    case .ready: ready
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(28)
            }
            Divider()
            HStack(spacing: 12) {
                Text("Step \(flow.step.rawValue + 1) of 3")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Set Up Later") { finish() }
                    .accessibilityIdentifier("onboarding-skip")
                Spacer()
                if flow.step != .appearance { Button("Back") { flow.back() } }
                Button(flow.step == .ready ? "Open Dashboard" : "Continue") {
                    if flow.step == .ready { finish() } else { flow.next() }
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("onboarding-next")
            }.padding(20)
        }
        .frame(width: 680, height: 660)
        .onAppear {
            // Record a deliberate fresh-user choice without changing existing
            // access or consent. Dismissing at any step is recoverable.
            if preferences.onboardingAgents == nil {
                var selected: [String] = []
                if preferences.hooksInstalled || hasSession("claude") { selected.append("claude") }
                if preferences.codexConfigInstalled || hasSession("codex") { selected.append("codex") }
                preferences.onboardingAgents = selected
            }
        }
    }

    private var agents: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Connect the agents you use").font(.title.bold())
            Text("Choose either, both, or continue without connecting. AgentDeck observes work in your existing apps; it does not start an agent or ask for an account password.")
                .foregroundStyle(.secondary)
            agentCard("claude", name: "Claude Code", type: "claude-code",
                      detail: "Allow activity reporting from Claude Code. You choose its settings file before AgentDeck adds its own entries.")
            agentCard("codex", name: "Codex App & CLI", type: "codex-app",
                      detail: "Allow activity reporting from Codex. You choose its configuration file; your model and other integrations are preserved.")
            Text("Use your agent as usual after setup. A running session may need to be reopened before it picks up the change.")
                .font(.callout).foregroundStyle(.secondary)
            DisclosureGroup("Other agents", isExpanded: $showsOtherAgents) {
                VStack(alignment: .leading, spacing: 10) {
                    Text("OpenCode, Kiro and OpenClaw can be configured in Settings → Integrations when you use them.")
                    if hasSession("hermes") {
                        Label("Hermes activity is arriving", systemImage: "checkmark.circle")
                        Text("This is a read-only view of your existing Hermes connection.")
                    }
                    Button("Open Integrations") { finish(opening: "settings") }
                }.padding(.top, 8)
            }
        }
    }

    private func hasSession(_ agent: String) -> Bool {
        stateHolder.state.siblingSessions.contains {
            $0.alive && ($0.agentType == agent || (agent == "claude" && $0.agentType == "claude-code")
                || (agent == "codex" && ["codex-app", "codex-cli"].contains($0.agentType ?? "")))
        }
    }

    private func observation(_ agent: String) -> OnboardingFlow.Observation {
        .resolve(installed: agent == "claude" ? preferences.hooksInstalled : preferences.codexConfigInstalled,
                 live: hasSession(agent))
    }

    private func agentCard(_ id: String, name: String, type: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                SessionCreatureIcon(agentType: type, tint: SessionBrand.color(for: type), size: 28)
                Text(name).font(.headline)
                Spacer()
                Text(observation(id).title).font(.caption).foregroundStyle(.secondary)
            }
            Text(detail).font(.callout).foregroundStyle(.secondary)
            if observation(id) == .notConfigured {
                if daemonService.isUsingExternalDaemon {
                    Text("This Mac is receiving sessions from an existing connection. New activity will appear here when that connection reports it.")
                        .font(.callout)
                } else {
                    Button(feedback[id] == nil ? "Connect \(name)" : "Try Again") {
                        var selected = preferences.onboardingAgents ?? []
                        if !selected.contains(id) { selected.append(id) }
                        preferences.onboardingAgents = selected
                        if id == "claude" { _ = HookInstaller.promptAndInstall() }
                        else { _ = CodexConfigInstaller.promptAndInstall() }
                        feedback[id] = observation(id) == .notConfigured
                            ? "Setup was not completed. You can try again or continue and set it up later."
                            : nil
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("onboarding-connect-\(id)")
                }
            }
            if let message = feedback[id] { Text(message).font(.caption) }
            if id == "codex", observation(id) != .notConfigured, !preferences.codexUsageAccessEnabled, !daemonService.isUsingExternalDaemon {
                Button("Add usage limits (optional)…") { _ = preferences.chooseCodexDirectory() }
                Text("Usage needs separate read access to your Codex folder. Activity reporting works without it.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }

    private var ready: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Your dashboard is yours").font(.title.bold())
            if hasSession("claude") || hasSession("codex") || stateHolder.state.siblingSessions.contains(where: \.alive) {
                Text("Your sessions are visible. Open the dashboard to follow their activity.")
            } else if preferences.hasConfiguredObservation {
                Text("Observation is set up. Your next agent activity will appear here. You can use your agent as usual.")
            } else {
                Text("You can look around now. Connect an agent later from Settings → Dashboard → Set Up AgentDeck to see live work.")
            }
            Text("Want to use a device you already have?").font(.headline)
            Picker("Optional devices", selection: $flow.interest) {
                ForEach(OnboardingFlow.Interest.allCases) { item in Text(item.title).tag(item) }
            }.pickerStyle(.segmented)
            deviceStory
            Divider()
            Text("Optional notifications").font(.headline)
            Text("Get a notification when a session needs your attention. You can decide later in Settings.")
                .font(.callout).foregroundStyle(.secondary)
            Button("Choose Notifications…") {
                Task { await NotificationPermission.chooseFromUserAction() }
            }
        }
    }

    @ViewBuilder private var deviceStory: some View {
        switch flow.interest {
        case .mac:
            Text("All core dashboard views work on this Mac. You can explore extra screens any time from Preview Devices.")
                .foregroundStyle(.secondary)
        case .streamDeck:
            Text("Keep session status on your keys while you work. Supported actions can show real questions from an agent; available controls depend on the session.")
            if let devices = stateHolder.state.moduleHealth?.streamDeck?.devices, !devices.isEmpty {
                Label("Stream Deck is reporting to AgentDeck", systemImage: "checkmark.circle")
            } else {
                Text("An existing AgentDeck action in Stream Deck reports connected keys here. A USB connection alone does not report sessions.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Button("Preview Devices") { finish(opening: "device-preview") }
        case .displays:
            Text("An iPad or iPhone can show your live dashboard beside your work. Ambient displays can keep session status visible at a glance.")
            Text("Preview layouts without hardware, or pair a screen you already own. Pairing requires network access to this Mac.")
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                Button("Preview Devices") { finish(opening: "device-preview") }
                Button("Pair a Device") { finish(opening: "pairing-qr") }
            }
        }
    }

    private func finish(opening window: String? = nil) {
        preferences.hasSeenMonitorEmptyGuide = true
        preferences.hasSeenOnboarding = true
        dismiss()
        if let window { openWindow(id: window) }
    }
}
#endif
