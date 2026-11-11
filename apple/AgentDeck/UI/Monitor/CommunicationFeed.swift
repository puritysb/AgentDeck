#if os(macOS)
import SwiftUI

/// Bounded read of observed peer messages, held only while Work detail is open.
@MainActor
final class CommunicationFeed: ObservableObject {
    @Published var snapshot: CommunicationSnapshot?
    @Published var state: CollaborationReadState = .loading
    private var generation = UUID()
    private var lastPort = 0
    private let load: @Sendable (URL) async throws -> Data
    private let pause: @Sendable () async throws -> Void

    init(load: @escaping @Sendable (URL) async throws -> Data = CollaborationFeed.fetch,
         pause: @escaping @Sendable () async throws -> Void = {
             try await Task.sleep(for: .seconds(CollaborationPresentation.networkRefreshSeconds))
         }) {
        self.load = load; self.pause = pause
    }

    func observe(port: Int, connected: Bool) async {
        let current = UUID(); generation = current
        if lastPort != port { snapshot = nil; lastPort = port }
        guard connected, port > 0 else { state = .disconnected; return }
        state = .loading
        while !Task.isCancelled && generation == current {
            do {
                let data = try await load(URL(string: "http://127.0.0.1:\(port)/apme/communications")!)
                let value = try JSONDecoder().decode(CommunicationSnapshot.self, from: data)
                try Task.checkCancellation()
                guard generation == current else { return }
                guard value.schema == "agentdeck-communications/v1", value.capturedAt.isFinite,
                      value.since.isFinite, value.since <= value.capturedAt,
                      value.events.count <= CollaborationPresentation.networkEventLimit else {
                    throw CollaborationReadError.unsupported
                }
                snapshot = value; state = .ready
            } catch {
                guard !Task.isCancelled, generation == current else { return }
                switch error {
                case CollaborationReadError.unsupported: state = .unsupported
                case CollaborationReadError.tooLarge: state = .tooLarge
                default: state = .failed
                }
            }
            do { try await pause() } catch { return }
        }
    }
}
#endif
