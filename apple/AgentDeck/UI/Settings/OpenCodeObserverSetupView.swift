#if os(macOS)
import SwiftUI

struct OpenCodeObserverSetupView: View {
    @ObservedObject private var setup = OpenCodeObserverSetup.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Observer plugin")
                .font(.system(size: 11, weight: .semibold))
            Text(setup.message)
                .font(.system(size: 11))
                .foregroundStyle(setup.hasError ? DesignTokens.UI.error : DesignTokens.UI.hudSubtext)
                .fixedSize(horizontal: false, vertical: true)
            if let path = setup.selectedPath {
                Text(path).font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary).textSelection(.enabled)
            }
            HStack {
                Button("Choose plugins folder…") { setup.chooseFolder() }
                if setup.hasSelection {
                    Button("Install / Update") { setup.install() }.disabled(setup.port == nil)
                    Button("Remove observer") { setup.remove() }
                    Button("Remove folder access") { setup.forgetFolder() }
                }
            }
            .buttonStyle(.bordered).controlSize(.small)
            Text("Installs an observation-only plugin for OpenCode to load. Other plugins and your OpenCode configuration are preserved. Removing folder access leaves installed files in place.")
                .font(.system(size: 10)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
#endif
