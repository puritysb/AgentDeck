#if os(macOS)
import SwiftUI

struct CalendarSettings: View {
    @State private var sources = ""
    @State private var consent = false
    @State private var busy = false
    @State private var status = "Not connected"
    @State private var error: String?
    @State private var operation = 0
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Calendar schedule").font(.headline)
            Text("Show the remaining schedule on paired Pocket and Glance displays. Private calendar addresses stay in this Mac’s Keychain.")
                .font(.caption).foregroundStyle(TerrariumHUD.subtext)
            SecureField("Private HTTPS or webcal ICS URLs, separated by spaces", text: $sources).textFieldStyle(.roundedBorder)
            Text("webcal addresses use HTTPS. Calendar servers must support a secure connection.")
                .font(.caption).foregroundStyle(TerrariumHUD.subtext)
            Toggle("Allow AgentDeck to fetch these sources and share event titles and times with paired Pocket and Glance displays", isOn: $consent).font(.caption)
            HStack {
                Button("Save calendars") { save() }.disabled(busy || !consent || sources.isEmpty)
                Button("Disconnect calendars") { disconnect() }
                if busy { ProgressView().controlSize(.small) }
                Text(status).font(.caption).foregroundStyle(TerrariumHUD.subtext)
            }
            Text("Calendar copy is cached only in memory. Pocket learns aggregate feedback, never calendar titles, addresses or event details.")
                .font(.caption).foregroundStyle(TerrariumHUD.subtext)
            if let error { Text(error).font(.caption).foregroundStyle(DesignTokens.Status.error) }
        }.padding(12).task {
            while !Task.isCancelled { await refresh(); try? await Task.sleep(for: .seconds(5)) }
        }
    }
    private func refresh() async {
        do {
            let summary = try await CalendarConnection.shared.summary()
            let freshness = await CalendarProvider.shared.freshness()
            status = summary + (summary == "Not connected" || freshness == "disabled" ? "" : " · " + freshness)
        } catch { status = "Calendar access unknown" }
    }
    private func save() {
        busy = true; error = nil; operation += 1; let ticket = operation
        let agreed = consent, revision = CalendarConnection.shared.grant.value
        let urls = sources.split(whereSeparator: { $0.isWhitespace }).map(String.init); sources = ""
        Task {
            guard ticket == operation else { return }
            do {
                try await CalendarConnection.shared.connect(urls: urls, consent: agreed, expectedRevision: revision)
                guard ticket == operation else { return }; await refresh()
            } catch { if ticket == operation { self.error = "Calendars could not be saved. Check the HTTPS or webcal addresses and Keychain access." } }
            if ticket == operation { busy = false }
        }
    }
    private func disconnect() {
        CalendarConnection.shared.revoke()
        operation += 1; busy = false; consent = false; sources = ""; error = nil; status = "Not connected"
        Task {
            do { try await CalendarConnection.shared.disconnect(); await CalendarProvider.shared.stop() }
            catch { self.error = "Calendar access is disabled. Keychain removal failed; retry Disconnect." }
        }
    }
}
#endif
