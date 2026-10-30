#if os(macOS)
import SwiftUI

struct AntigravitySessionSettingsView: View {
    @ObservedObject private var observer = AntigravitySessionSettings.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Session Observation").font(.system(size: 12, weight: .semibold))
            Text(observer.detail).font(.system(size: 11)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let path = observer.selectedPath {
                Text(path).font(.system(size: 10, design: .monospaced)).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            }
            HStack {
                Button(observer.isEnabled ? "Choose another transcript folder…" : "Choose transcript folder…") { observer.chooseFolder() }
                if observer.isEnabled {
                    Button("Refresh observation") { Task { _ = await observer.read() } }
                    Button("Stop observing") { observer.stopObserving() }
                }
            }.buttonStyle(.bordered).controlSize(.small)
            Text("Read-only JSONL observation. Old or unreadable evidence never becomes a completed turn or a permission request. Account and plan access below stays separate.")
                .font(.system(size: 10)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.task { if observer.isEnabled { _ = await observer.read() } }
    }
}
#endif
