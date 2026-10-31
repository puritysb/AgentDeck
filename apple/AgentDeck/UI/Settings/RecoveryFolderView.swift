#if os(macOS)
import SwiftUI

struct RecoveryFolderView: View {
    var connectionURL: () -> String?
    var restartLocal: () -> Void = {}
    @ObservedObject private var settings = RecoveryFolderSettings.shared
    @State private var busy = false
    var body: some View {
        GroupBox("Automatic recovery") {
            VStack(alignment: .leading, spacing: 8) {
                Text("Keep display settings, session pins and aggregate learning when this Mac restarts.")
                    .font(.caption).foregroundStyle(.secondary)
                if let path = settings.selectedPath { Text(path).font(.caption).textSelection(.enabled) }
                if let error = settings.errorMessage { Text(error).font(.caption).foregroundStyle(.secondary) }
                HStack {
                    Button("Choose Folder…") { configure() }
                    if settings.selectedPath != nil {
                        Button("Retry") { configure(useSelected: true) }
                        Button("Disconnect") { configure(disconnect: true) }
                    }
                    if busy { ProgressView().controlSize(.small) }
                }.disabled(busy)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func configure(disconnect: Bool = false, useSelected: Bool = false) {
        do {
            let selected = disconnect ? nil : useSelected ? try settings.directory(requireConsent: false) : try settings.choose()
            if !disconnect && selected == nil { return }
            guard let endpoint = connectionURL() else {
                if disconnect { settings.disconnect() }
                else { settings.errorMessage = "Folder selected. Reconnect, then retry to confirm recovery." }
                restartLocal()
                return
            }
            busy = true
            Task { @MainActor in
                defer { busy = false }
                do {
                    try await RecoveryConfigurationClient.configure(connectionURL: endpoint, path: selected?.path)
                    if disconnect { settings.disconnect() }
                    else { settings.confirm() }
                    settings.errorMessage = nil
                } catch {
                    if disconnect {
                        settings.disconnect(); restartLocal()
                        settings.errorMessage = "Folder access was removed for this app. The other daemon’s disconnect was not confirmed."
                    } else { settings.errorMessage = "Recovery was not confirmed. \(error.localizedDescription)" }
                }
            }
        } catch { settings.errorMessage = error.localizedDescription }
    }
}
#endif
