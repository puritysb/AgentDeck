#if os(iOS)
import SwiftUI

/// Companion first use: appearance, then the same bounded connection/recovery
/// surface used by the dashboard. Discovery and authorization remain separate.
struct OnboardingScreen: View {
    @Environment(\.scenePhase) private var scenePhase
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    @State private var connecting = false
    @State private var showQRScanner = false
    @State private var scanError: String?
    @State private var showPreview = false

    init(connecting: Bool = false) {
        _connecting = State(initialValue: connecting)
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if connecting {
                        connectionGuidance
                        if stateHolder.connection.status != .connected {
                            ConnectionOverlay(presentation: .onboarding)
                                .frame(maxWidth: .infinity)
                        }
                    } else {
                        OnboardingAppearance()
                        Text("On iPhone and iPad, AgentDeck displays activity from your Mac. You can explore device previews before connecting.")
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
                .padding(24)
                .frame(maxWidth: 600)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            Divider()
            VStack(spacing: 12) {
                HStack {
                    if connecting {
                        Button("Back") {
                            stopPendingConnection()
                            connecting = false
                        }
                    }
                    Spacer()
                    Button(connecting ? "Open Dashboard" : "Find My Mac") {
                        if connecting { finish() }
                        else {
                            connecting = true
                            if stateHolder.connection.status != .connected {
                                stateHolder.retryConnectionWaterfall()
                            }
                        }
                    }.buttonStyle(.borderedProminent)
                }
                Button(stateHolder.connection.status == .connected ? "Explore Device Previews" : "Explore Without Connecting") {
                    stopPendingConnection()
                    showPreview = true
                }
            }.padding(16)
        }
        .onChange(of: scenePhase) { _, phase in
            // Settings can change Local Network permission before the user
            // ever reaches ContentView, which normally owns this lifecycle.
            guard stateHolder.connection.status == .connected || (connecting && !showPreview) else { return }
            if phase == .active { stateHolder.handleForegroundReturn() }
            if phase == .background { stateHolder.handleBackgroundEntry() }
        }
        .fullScreenCover(isPresented: $showPreview) {
            NavigationStack {
                DevicePreviewScreen()
                    .navigationTitle("Device Previews")
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Back to Setup") { showPreview = false }
                        }
                    }
            }
            .environmentObject(stateHolder)
            .environmentObject(preferences)
        }
        .fullScreenCover(isPresented: $showQRScanner) {
            QRScannerView(onScan: { payload in
                showQRScanner = false
                let trimmed = payload.trimmingCharacters(in: .whitespacesAndNewlines)
                guard let url = URL(string: trimmed),
                      ["ws", "wss"].contains(url.scheme?.lowercased() ?? ""),
                      let host = url.host, !host.isEmpty else {
                    scanError = "That QR code is not an AgentDeck pairing link. Try the code in your Mac's Pair a Device window."
                    return
                }
                scanError = nil
                stateHolder.connectTo(url: trimmed)
            }, onCancel: { showQRScanner = false })
        }
    }

    private var connectionGuidance: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Connect to your Mac").font(.title.bold())
            Text("Open AgentDeck on your Mac on the same network. Allow Local Network access to find it, then open Devices → Pair Device on your Mac to approve this device or show its QR code.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if stateHolder.connection.status == .connected {
                Label("Connected to AgentDeck", systemImage: "checkmark.circle")
                Text("Your Mac shares the agent activity it receives. If no sessions are active, you can still open the dashboard.")
            } else {
                Button("Scan QR from Mac") { showQRScanner = true }
                    .buttonStyle(.bordered)
                Text("QR pairing also needs a network route to your Mac.")
                    .font(.caption).foregroundStyle(.secondary)
                if let scanError { Text(scanError).font(.callout).foregroundStyle(DesignTokens.UI.error) }
            }
        }
    }

    private func stopPendingConnection() {
        if stateHolder.connection.status != .connected {
            stateHolder.stopConnectionAttempts()
        }
    }

    private func finish() {
        // ContentView owns connection recovery after the transition. Completing
        // orientation is not a claim that pairing succeeded.
        preferences.hasSeenMonitorEmptyGuide = true
        preferences.hasSeenOnboarding = true
    }
}
#endif
