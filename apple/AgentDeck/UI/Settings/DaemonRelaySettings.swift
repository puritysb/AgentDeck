#if os(macOS)
import SwiftUI

struct DaemonRelaySettings: View {
    @State private var host = ""
    @State private var port = "9120"
    @State private var token = ""
    @State private var consent = false
    @State private var status = "Relay off"
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        VStack(alignment:.leading,spacing:8) {
            Text("Daemon relay").font(.headline)
            Text("Publish this Mac’s observed sessions to a hub. Controls return over the same connection; only supported hook controls are accepted.")
                .font(.caption).foregroundStyle(TerrariumHUD.subtext)
            TextField("Hub host",text:$host).textFieldStyle(.roundedBorder)
            TextField("Hub port",text:$port).textFieldStyle(.roundedBorder)
            SecureField("Hub pairing token · required beyond loopback",text:$token).textFieldStyle(.roundedBorder)
            Toggle("Allow sharing observed session metadata and accepting supported controls from this hub",isOn:$consent).font(.caption)
            HStack {
                Button("Save relay") {
                    let secret = token; token = ""; busy = true; error = nil
                    Task {
                        defer { busy = false }
                        do {
                            guard let port = Int(port) else { throw URLError(.badURL) }
                            try await DaemonRelayConnection.shared.connect(host:host,port:port,token:secret,consent:consent)
                            status = try await DaemonRelayConnection.shared.summary()
                        } catch { self.error = "Relay could not be saved. Check the host, port, token and Keychain access." }
                    }
                }.disabled(busy || !consent || host.isEmpty)
                Button("Disable relay") {
                    consent = false; token = ""; error = nil
                    Task {
                        do { try await DaemonRelayConnection.shared.disconnect(); status = "Relay off" }
                        catch { self.error = "Relay disabled. Keychain removal failed; retry Disable relay." }
                    }
                }.disabled(busy)
                if busy { ProgressView().controlSize(.small) }
            }
            Text(status).font(.caption).foregroundStyle(TerrariumHUD.subtext)
            if let error { Text(error).font(.caption).foregroundStyle(DesignTokens.Status.error) }
        }.padding(12)
        .task {
            if let saved = try? await DaemonRelayConnection.shared.snapshot().1 { host = saved.host; port = String(saved.port) }
            while !Task.isCancelled {
                if let text = try? await DaemonRelayConnection.shared.summary() { status = text }
                try? await Task.sleep(for:.seconds(2))
            }
        }
    }
}
#endif
