#if os(iOS)
import SwiftUI

/// Companion first use: appearance, then the same bounded connection/recovery
/// surface used by the dashboard. Discovery and authorization remain separate.
struct OnboardingScreen: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    @State private var connecting = false
    @State private var showQRScanner = false
    @State private var scanError: String?
    @State private var showPreview = false

    var body: some View {
        VStack(spacing: 0) {
            if connecting {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Connect to your Mac").font(.title.bold())
                    Text("Open AgentDeck on your Mac on the same network. Allow Local Network access to find it, then approve this device in the Mac's Pair a Device window or scan its QR code.")
                        .foregroundStyle(.secondary)
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
                }.padding(24)
                if stateHolder.connection.status != .connected {
                    ConnectionOverlay()
                } else { Spacer() }
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        OnboardingAppearance()
                        Text("On iPhone and iPad, AgentDeck displays activity from your Mac. You can explore device previews before connecting.")
                            .font(.callout).foregroundStyle(.secondary)
                    }.padding(24)
                }
            }
            Divider()
            VStack(spacing: 12) {
                HStack {
                    if connecting {
                        Button("Back") {
                            stateHolder.stopConnectionAttempts()
                            connecting = false
                        }
                    }
                    Spacer()
                    Button(connecting ? "Open Dashboard" : "Find My Mac") {
                        if connecting { finish() }
                        else {
                            connecting = true
                            stateHolder.retryConnectionWaterfall()
                        }
                    }.buttonStyle(.borderedProminent)
                }
                Button("Explore Without Connecting") {
                    stateHolder.stopConnectionAttempts()
                    showPreview = true
                }
            }.padding(16)
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

    private func finish() {
        // ContentView owns connection recovery after the transition. Completing
        // orientation is not a claim that pairing succeeded.
        preferences.hasSeenMonitorEmptyGuide = true
        preferences.hasSeenOnboarding = true
    }
}
#endif
