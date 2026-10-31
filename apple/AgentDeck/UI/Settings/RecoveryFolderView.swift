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
                if let path = settings.selectedPath {
                    Text(path).font(.caption).textSelection(.enabled)
                    Text(settings.confirmed ? "Recovery folder authorized" : "Recovery has not been confirmed. Retry after connecting.").font(.caption).foregroundStyle(.secondary)
                }
                if let error = settings.errorMessage { Text(error).font(.caption).foregroundStyle(.secondary) }
                ForEach(settings.conflicts) { conflict in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Saved \(conflict.runtime) profile · \(conflict.profile.prefix(8))").font(.caption.bold())
                        Text(summary("Saved profile", conflict.local)).font(.caption)
                        Text(summary("Recovery profile", conflict.recovered)).font(.caption)
                        Text("Both versions are preserved before a choice is applied.").font(.caption).foregroundStyle(.secondary)
                        if conflict.pending { Text("Choice saved; waiting for this profile to reconnect.").font(.caption) }
                        HStack {
                            Button("Use saved \(conflict.runtime) profile") { resolve(conflict, choice: "local") }
                            Button("Use recovery profile") { resolve(conflict, choice: "recovery") }
                        }.disabled(busy)
                    }.padding(.vertical, 4)
                }
                HStack {
                    Button("Choose Folder…") { configure() }
                    if settings.selectedPath != nil {
                        Button("Retry") { configure(useSelected: true) }
                        Button("Review Conflicts") { Task { await settings.refreshConflicts() } }
                        Button("Disconnect") { configure(disconnect: true) }
                    }
                    if busy { ProgressView().controlSize(.small) }
                }.disabled(busy)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.task { await settings.refreshConflicts() }
    }
    private func summary(_ title: String, _ value: RecoveryProfileSummary) -> String {
        "\(title): \(value.pins) pins, \(value.displays) displays, \(value.feedback.formatted(.number.precision(.fractionLength(0)))) feedback"
    }
    private func resolve(_ conflict: RecoveryConflict, choice: String) {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                try await settings.resolve(conflict, choice: choice)
                if let endpoint = connectionURL(), let path = settings.selectedPath {
                    do { try await RecoveryConfigurationClient.configure(connectionURL: endpoint, path: path); settings.errorMessage = nil }
                    catch { restartLocal(); settings.errorMessage = "Choice preserved. Waiting for the selected profile to reconnect." }
                } else { restartLocal() }
            } catch { settings.errorMessage = "The preview changed or could not be saved. Review the current profiles again." }
            await settings.refreshConflicts()
        }
    }
    private func configure(disconnect: Bool = false, useSelected: Bool = false) {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let selected = disconnect ? nil : useSelected ? try settings.directory(requireConsent: false) : try await settings.choose()
                if !disconnect && selected == nil { return }
                guard let endpoint = connectionURL() else {
                    if disconnect { settings.disconnect() }
                    else { settings.errorMessage = "Folder selected. Reconnect, then retry to confirm recovery." }
                    restartLocal()
                    return
                }
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
                await settings.refreshConflicts()
            } catch { settings.errorMessage = error.localizedDescription }
        }
    }
}
#endif
