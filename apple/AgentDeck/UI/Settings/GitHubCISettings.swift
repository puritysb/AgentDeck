#if os(macOS)
import SwiftUI

struct GitHubCISettings: View {
    @State private var repositories = ""
    @State private var token = ""
    @State private var consent = false
    @State private var busy = false
    @State private var status = "Not connected"
    @State private var error: String?
    @State private var operation = 0
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("GitHub CI status").font(.headline)
            Text("Read CI for explicit watches in the repositories you select.")
                .font(.caption).foregroundStyle(TerrariumHUD.subtext)
            TextField("owner/repo, separated by commas", text: $repositories)
                .textFieldStyle(.roundedBorder)
            SecureField("Fine-grained token · optional for public repositories", text: $token)
                .textFieldStyle(.roundedBorder)
            Text("For selected private repositories, grant read-only Actions, Pull requests, Contents, Checks and Commit statuses. The token stays in this Mac’s Keychain.")
                .font(.caption).foregroundStyle(TerrariumHUD.subtext)
            Toggle("Allow AgentDeck to send these repository and CI watch identities to GitHub", isOn: $consent)
                .font(.caption)
            HStack {
                Button("Connect") { connect() }.disabled(busy || !consent || repositories.isEmpty)
                Button("Disconnect") { disconnect() }
                if busy { ProgressView().controlSize(.small) }
                Text(status).font(.caption).foregroundStyle(TerrariumHUD.subtext)
            }
            if let error { Text(error).font(.caption).foregroundStyle(DesignTokens.Status.error) }
        }
        .padding(12)
        .task {
            if let saved = try? await GitHubCIConnection.shared.repositories() { repositories = saved.joined(separator:", ") }
            while !Task.isCancelled { await refresh(); try? await Task.sleep(for:.seconds(5)) }
        }
    }
    private func refresh() async {
        do { status = try await GitHubCIConnection.shared.summary() }
        catch { self.error = "Keychain is unavailable. CI status remains unknown." }
    }
    private func connect() {
        busy = true; error = nil; operation += 1; let ticket = operation
        let repos = repositories.split(whereSeparator: { $0 == "," || $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let secret = token; token = ""
        Task {
            do {
                try await GitHubCIConnection.shared.connect(repositories: repos, token: secret, consent: consent)
                guard ticket == operation else { return }
                await refresh()
            } catch {
                guard ticket == operation else { return }
                self.error = "Connection could not be saved. Check repository names, token permissions and Keychain access."
            }
            if ticket == operation { busy = false }
        }
    }
    private func disconnect() {
        operation += 1; busy = false; consent = false; token = ""; status = "Not connected"; error = nil
        Task {
            do { try await GitHubCIConnection.shared.disconnect() }
            catch { self.error = "CI polling is disabled. Keychain removal failed; retry Disconnect." }
        }
    }
}
#endif
