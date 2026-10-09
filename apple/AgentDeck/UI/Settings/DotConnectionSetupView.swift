#if os(macOS)
import SwiftUI

/// Discoverable setup is separate from a real, host-reported companion.
struct DotConnectionSetupView: View {
    @EnvironmentObject private var daemonService: DaemonService
    @EnvironmentObject private var stateHolder: AgentStateHolder

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Dot can share reports and describe interactions with your agents. It appears on your displays after its connection is configured.")
                .fixedSize(horizontal: false, vertical: true)
            if daemonService.isUsingExternalDaemon {
                GroupBox("Dot connection") {
                    VStack(alignment: .leading, spacing: 10) {
                        if stateHolder.state.bridgeConnected {
                            if let dot = stateHolder.state.dot, dot.configured {
                                DotSurfaceView(snapshot: dot)
                            } else {
                                Text("No Dot connection reported").font(.headline)
                            }
                        } else {
                            Text("Connection status unknown").font(.headline)
                            Text("Reconnect the dashboard to see the host’s Dot connection.")
                        }
                        Text("Connection settings are managed by the host sharing this dashboard.")
                            .font(.callout)
                        Text("Setup needs a public HTTPS address, a trusted TLS certificate and approval of the connection in Dot. Installing AgentDeck alone does not connect a Dot account.")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                }
            } else {
                DotSettingsView()
            }
            Text("Status describes reports received through this connection. Opening or closing ChatGPT does not establish Dot’s cloud activity.")
                .font(.caption).foregroundStyle(.secondary)
        }.accessibilityIdentifier("dot-connection-setup")
    }
}
#endif
