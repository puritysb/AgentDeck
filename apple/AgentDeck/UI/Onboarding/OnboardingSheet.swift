#if os(macOS)
// OnboardingSheet.swift — First-launch 4-pane orientation for macOS.
//
// App Store review expects a clear first-run path for non-developer users.
// The dashboard starts empty by design (no session until the user launches
// one), so without onboarding a fresh user sees a blank terrarium and no
// affordance to proceed. This sheet bridges that gap with four screens:
//
//   1. Welcome — brand + value prop ("Stop Chatting. Start Steering.")
//   2. Pick an agent — supported agent overview. App Store builds never
//      show install commands or route users to companion executables.
//   3. Optional integrations — services that can be enabled later
//   4. Pair your iPad — Bonjour pitch + iOS companion download link
//
// Gated by `AppPreferences.hasSeenOnboarding` so returning users skip it.
// xctest environments bypass the gate so test runs don't deadlock on a
// modal sheet.

import SwiftUI
import AppKit

struct OnboardingSheet: View {
    @EnvironmentObject private var preferences: AppPreferences
    @Environment(\.dismiss) private var dismiss

    @State private var pane: Int = 0
    @State private var userHasAgent: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            footer
                .padding(.horizontal, 24)
                .padding(.vertical, 14)
        }
        .frame(width: 640, height: 540)
    }

    /// 4 panes: Welcome → Agent picker → Optional integrations → Pair iPad.
    /// Adding the integrations pane (Claude Code hooks / OpenClaw /
    /// Anthropic API) keeps the wizard length reasonable while letting
    /// first-run users know those surfaces exist before they go hunting
    /// in Settings. The pane is purely informational — actual token
    /// paste and hook consent stay in Settings → Integrations to keep
    /// the wizard short.
    private static let paneCount = 4

    @ViewBuilder
    private var content: some View {
        switch pane {
        case 0: WelcomePane()
        case 1: AgentPickerPane(userHasAgent: $userHasAgent)
        case 2: IntegrationsPane()
        default: PairIPadPane()
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            // Progress dots.
            HStack(spacing: 6) {
                ForEach(0..<Self.paneCount, id: \.self) { idx in
                    Circle()
                        .fill(idx == pane ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 8, height: 8)
                }
            }

            Spacer()

            if pane > 0 {
                Button("Back") {
                    pane = max(0, pane - 1)
                }
                .buttonStyle(.bordered)
            }

            Button(pane == Self.paneCount - 1 ? "Get Started" : "Continue") {
                if pane < Self.paneCount - 1 {
                    pane += 1
                } else {
                    finish()
                }
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut(.defaultAction)
        }
    }

    private func finish() {
        preferences.hasSeenOnboarding = true
        dismiss()
    }
}

// MARK: - Pane 1: Welcome

private struct WelcomePane: View {
    var body: some View {
        VStack(spacing: 22) {
            Spacer()

            // Terrarium creature — use the octopus app icon as a recognizable
            // brand anchor rather than a runtime-animated creature (Canvas
            // sizing inside a sheet has edge cases we'd rather avoid here).
            Image(systemName: "scribble.variable")
                .resizable()
                .scaledToFit()
                .frame(width: 120, height: 120)
                .foregroundStyle(Color.accentColor)
                .padding(.bottom, 6)

            Text("Stop Chatting.\nStart Steering.")
                .font(.system(size: 30, weight: .bold))
                .multilineTextAlignment(.center)

            Text("Real-time monitoring and evaluation for AI coding agents. Works with Claude Code, Codex, and OpenCode sessions across every device in your setup.")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 40)

            Spacer()
        }
        .padding(24)
    }
}

// MARK: - Pane 2: Agent picker

/// Orientation pane: the app is self-contained and does not present CLI
/// install commands as an in-app next step.
private struct AgentPickerPane: View {
    @Binding var userHasAgent: Bool

    private struct AgentOption {
        let name: String
        let tagline: String
    }

    private var options: [AgentOption] {
        [
            AgentOption(
                name: "Claude Code",
                tagline: "Live session telemetry arrives through opt-in hooks."
            ),
            AgentOption(
                name: "Codex",
                tagline: "Runs in your own terminal; sessions appear here once started."
            ),
            AgentOption(
                name: "OpenCode",
                tagline: "Runs in your own terminal; sessions appear here once started."
            ),
        ]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Choose the agent you already use")
                    .font(.system(size: 22, weight: .semibold))
                Text("AgentDeck works as a standalone dashboard. Enable hooks in Settings when you want live Claude Code sessions to appear here.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(spacing: 10) {
                ForEach(options, id: \.name) { option in
                    agentCard(option)
                }
            }
            Text("No companion executable is required for Device Preview, iPad pairing, voice input, APME reports, or hardware status output.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Spacer()
        }
        .padding(24)
    }

    @ViewBuilder
    private func agentCard(_ option: AgentOption) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(option.name)
                    .font(.system(size: 14, weight: .semibold))
                Text(option.tagline)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.secondary.opacity(0.08))
        )
    }
}

// MARK: - Pane 3: Optional integrations

/// Informational pane introducing the integrations grouped exactly the
/// same way Settings groups them — accounts you sign in to vs. paste-
/// in API keys. Reuses `IntegrationCatalog` so the copy is identical
/// across Onboarding, Settings, and the dashboard SetupCard.
private struct IntegrationsPane: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Optional integrations")
                        .font(.system(size: 22, weight: .semibold))
                    Text("Skip any you don't need — every one of them can be enabled later from Settings → Integrations.")
                        .font(.system(size: 13))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                integrationGroup(
                    title: "Sign in once — no tokens here",
                    rows: IntegrationCatalog.all.filter { $0.kind == .accountLinked }
                )

                integrationGroup(
                    title: "Optional API keys",
                    rows: IntegrationCatalog.all.filter { $0.kind == .apiKey }
                )

                Text("Most people only need to sign in to Claude. Everything else is opt-in.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .padding(24)
        }
    }

    private func integrationGroup(title: String, rows: [IntegrationDescriptor]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.system(size: 12, weight: .bold))
                .kerning(0.6)
                .foregroundStyle(.secondary)
            VStack(spacing: 10) {
                ForEach(rows) { descriptor in
                    IntegrationRow(
                        descriptor: descriptor,
                        status: .notConfigured(detail: nil),
                        mode: .onboarding
                    )
                }
            }
        }
    }
}

// MARK: - Pane 4: Pair iPad

private struct PairIPadPane: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Pair your iPad or iPhone")
                    .font(.system(size: 22, weight: .semibold))
                Text("AgentDeck has a free iOS companion app. It auto-discovers this Mac over Wi-Fi and mirrors your live sessions to a second screen — great as a bedside monitor or for pair programming.")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack(alignment: .top, spacing: 16) {
                Image(systemName: "ipad.landscape")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 120, height: 120)
                    .foregroundStyle(Color.accentColor.opacity(0.8))

                VStack(alignment: .leading, spacing: 10) {
                    bullet("Install **AgentDeck** from the iOS App Store")
                    bullet("Open it on the same Wi-Fi network as this Mac")
                    bullet("The iPad finds the Mac automatically via mDNS")
                    bullet("Choose **Pair Device** in the menu bar, then scan the QR code to authorize the connection.")
                }
                .font(.system(size: 13))
            }

            HStack(spacing: 10) {
                Button {
                    NSWorkspace.shared.open(AppMetadata.appStoreURL)
                } label: {
                    Label("Open iOS App Store", systemImage: "square.and.arrow.up")
                }
                .buttonStyle(.borderedProminent)
            }

            Spacer()
        }
        .padding(24)
    }

    private func bullet(_ markdown: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .foregroundStyle(Color.accentColor)
            Text((try? AttributedString(markdown: markdown)) ?? AttributedString(markdown))
                .foregroundStyle(.primary)
        }
    }
}
#endif
