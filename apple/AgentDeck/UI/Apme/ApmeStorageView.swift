#if os(macOS)
import SwiftUI

@MainActor
final class ApmeStorageModel: ObservableObject {
    @Published var status: ApmeStorageStatus?
    @Published var preview: ApmePrunePreview?
    @Published var days = ApmeRetentionPolicy.defaultDays {
        didSet { preview = nil }
    }
    @Published var busy = false
    @Published var message: String?
    private let endpoint: URL
    private let token: String
    private let transport: @Sendable (URLRequest) async throws -> (Data, URLResponse)

    init(endpoint: URL, token: String,
         transport: @escaping @Sendable (URLRequest) async throws -> (Data, URLResponse) = { try await URLSession.shared.data(for: $0) }) {
        self.endpoint = endpoint; self.token = token; self.transport = transport
    }

    private func request<T: Decodable>(_ path: String, body: Data? = nil) async throws -> T {
        var components = URLComponents(url: endpoint.appendingPathComponent("apme/storage" + path), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "token", value: token)]
        if path == "/preview" { components.queryItems?.append(URLQueryItem(name: "days", value: String(days))) }
        var request = URLRequest(url: components.url!)
        request.timeoutInterval = 40
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await transport(request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            let error = (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["error"] ?? "Storage request failed."
            throw NSError(domain: "ApmeStorage", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func refresh() async {
        guard !busy else { return }
        busy = true; message = nil
        defer { busy = false }
        do { status = try await request("") }
        catch { status = nil; message = error.localizedDescription }
    }

    func makePreview() async {
        guard !busy else { return }
        busy = true; message = nil; preview = nil
        defer { busy = false }
        do { preview = try await request("/preview") }
        catch { message = error.localizedDescription }
    }

    func apply() async {
        guard !busy, let preview else { return }
        busy = true; self.preview = nil; message = nil
        defer { busy = false }
        do {
            let body = try JSONSerialization.data(withJSONObject: ["cutoffMs": preview.cutoffMs, "fingerprint": preview.fingerprint, "confirm": true])
            let result: ApmePrunePreview = try await request("/prune", body: body)
            message = "Cleaned payloads in \(result.steps.rows + result.sampleEvents.rows) records. All record rows were preserved."
            do { status = try await request("") }
            catch { status = nil; message = "Cleanup finished; current file sizes could not be refreshed." }
        } catch { message = error.localizedDescription }
    }

    func compact() async {
        guard !busy else { return }
        busy = true; preview = nil; message = nil
        defer { busy = false }
        do {
            status = try await request("/compact", body: Data(#"{"confirm":true}"#.utf8))
            message = "Compaction finished. Current file sizes are shown below."
        } catch { message = error.localizedDescription }
    }
}

struct ApmeStorageView: View {
    @StateObject var model: ApmeStorageModel
    @Environment(\.dismiss) private var dismiss
    @State private var confirmPrune = false
    @State private var confirmCompact = false

    private func bytes(_ value: Int64?) -> String {
        value.map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "Unknown"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("APME Storage").font(.title2)
                Spacer()
                Button("Done") { dismiss() }.disabled(model.busy)
            }
            Text("Storage on this Mac. Cleanup keeps record rows, task history, replies and evaluations, and removes only eligible old payload content.")
                .font(.callout).foregroundStyle(.secondary)
            if let status = model.status {
                Grid(alignment: .leading, horizontalSpacing: 24) {
                    GridRow { Text("Database file"); Text(bytes(status.databaseBytes)) }
                    GridRow { Text("Write-ahead log"); Text(bytes(status.walBytes)) }
                    GridRow { Text("Shared memory file"); Text(bytes(status.sharedMemoryBytes)) }
                    GridRow { Text("SQLite pages / reusable pages"); Text("\(bytes(status.pageBytes)) / \(bytes(status.reusableBytes))") }
                    GridRow { Text("Free disk space"); Text(bytes(status.freeDiskBytes)) }
                }
                Text("Cleanup preserves record rows. Separate compaction may reduce disk usage.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text("Payloads older than")
                Picker("Days", selection: $model.days) {
                    ForEach([ApmeRetentionPolicy.defaultDays, 60, 90, 180, 365], id: \.self) { days in
                        Text("\(days) days").tag(days)
                    }
                }.labelsHidden().frame(width: 110).disabled(model.busy)
                Button("Preview Cleanup") { Task { await model.makePreview() } }
                    .disabled(model.busy || model.days < 1 || model.days > 36500)
            }
            if let preview = model.preview {
                Text("\(preview.steps.rows) step payloads and \(preview.sampleEvents.rows) tool event payloads are eligible.")
                Text("Preview payload length: \(preview.steps.bytesBefore + preview.sampleEvents.bytesBefore) SQLite characters. This is not a disk-space estimate.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Clean Up Previewed Payloads…", role: .destructive) { confirmPrune = true }
                    .disabled(model.busy || preview.steps.rows + preview.sampleEvents.rows == 0)
            }
            HStack {
                Button("Refresh Sizes") { Task { await model.refresh() } }.disabled(model.busy)
                Button("Compact Database…") { confirmCompact = true }
                    .disabled(model.busy || model.status?.vacuumAllowed != true)
                if model.busy { ProgressView().controlSize(.small) }
            }
            if let message = model.message { Text(message).font(.callout).textSelection(.enabled) }
        }
        .padding(24).frame(width: 620)
        .task { await model.refresh() }
        .confirmationDialog("Remove the previewed old payload content? This cannot be undone. Record rows, replies and evaluations are kept.", isPresented: $confirmPrune, titleVisibility: .visible) {
            Button("Clean Up Payloads", role: .destructive) { Task { await model.apply() } }
        }
        .confirmationDialog("Compact the database file? This temporarily needs additional disk space and may pause evaluation storage.", isPresented: $confirmCompact, titleVisibility: .visible) {
            Button("Compact Database") { Task { await model.compact() } }
        }
        .interactiveDismissDisabled(model.busy)
    }
}
#endif
