#if AGENTDECK_CLOUDKIT_POC && os(iOS)
import SwiftUI

/// The existing LAN control surface, kept separate from the read-only cloud reader.
struct LocalControlProbeView: View {
    @StateObject private var holder = AgentStateHolder()
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Local network controls").font(.caption)
                Spacer()
                Button("Close") { dismiss() }
                    .accessibilityLabel("Close local dashboard")
                    .buttonStyle(.bordered)
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)
            ContentView()
                .environmentObject(holder)
                .environmentObject(AppPreferences.shared)
        }
        .onDisappear { holder.prepareForTermination() }
    }
}
#endif
