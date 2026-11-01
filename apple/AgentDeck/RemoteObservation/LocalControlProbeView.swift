#if AGENTDECK_CLOUDKIT_POC && os(iOS)
import SwiftUI

/// The existing LAN control surface, kept separate from the read-only cloud reader.
struct LocalControlProbeView: View {
    @StateObject private var holder = AgentStateHolder()
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ContentView()
            .environmentObject(holder)
            .environmentObject(AppPreferences.shared)
            .overlay(alignment: .topTrailing) {
                Button("Close local dashboard") { dismiss() }
                    .buttonStyle(.bordered).padding()
            }
            .onDisappear { holder.prepareForTermination() }
    }
}
#endif
