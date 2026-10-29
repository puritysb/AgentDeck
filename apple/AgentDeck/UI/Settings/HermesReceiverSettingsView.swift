#if os(macOS)
import SwiftUI

struct HermesReceiverSettingsView: View {
    @ObservedObject private var receiver = HermesReceiverSettings.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(receiver.detail)
                .font(.system(size: 11))
                .foregroundStyle(receiver.errorMessage == nil ? DesignTokens.UI.hudSubtext : DesignTokens.UI.error)
                .fixedSize(horizontal: false, vertical: true)
            if let path = receiver.selectedPath {
                Text(path)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }
            HStack(spacing: 8) {
                Button(receiver.isEnabled ? "Choose another folder…" : "Choose observer folder…") {
                    receiver.chooseFolder()
                }
                if receiver.isEnabled {
                    Button("Retry") { receiver.synchronize() }
                        .disabled(receiver.localPort == nil)
                    Button("Stop syncing") { receiver.stopSyncing() }
                }
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            Text("Port changes follow this Mac while AgentDeck is open. Stopping sync removes folder access and leaves the last receiver setting in place.")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
#endif
