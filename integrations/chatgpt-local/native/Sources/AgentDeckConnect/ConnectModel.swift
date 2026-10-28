import Foundation
import SwiftUI

@MainActor
final class ConnectModel: ObservableObject {
    enum Phase {
        case checking, ready, starting, waiting(PendingConsent), authorized, stored
        case disconnecting, disconnected, failed(ConnectIssue, revocation: Bool)
    }

    @Published private(set) var phase: Phase = .checking
    @Published private(set) var presence: CredentialPresence = .unknown
    private let worker: ConnectionWorker?
    private var started = false
    private var operation = UUID()

    init() {
        do { worker = ConnectionWorker(configuration: try ConnectConfiguration()) }
        catch { worker = nil; phase = .failed(.configuration, revocation: false) }
    }

    var isBusy: Bool {
        switch phase {
        case .checking, .starting, .waiting, .disconnecting: true
        default: false
        }
    }

    var canConnect: Bool { worker != nil && !isBusy && presence == .absent }
    var canDisconnect: Bool { worker != nil && !isBusy && presence != .absent }
    var canInspect: Bool { worker != nil && !isBusy }

    func inspect() {
        guard let worker, !isBusy || !started else { return }
        started = true
        let run = UUID(); operation = run; phase = .checking
        Task {
            let result = await worker.inspectStoredConnection()
            guard operation == run else { return }
            presence = result.presence
            if let issue = result.issue { phase = .failed(issue, revocation: false) }
            else { phase = result.presence == .stored ? .stored : .ready }
        }
    }

    func connect() {
        guard let worker, canConnect else { return }
        let run = UUID(); operation = run; phase = .starting
        Task { [self] in
            let result = await worker.connect { [weak self] consent in
                Task { @MainActor in
                    guard let self, self.operation == run, self.isBusy else { return }
                    self.phase = .waiting(consent)
                }
            }
            guard operation == run else { return }
            presence = result.presence
            if let issue = result.issue {
                if case .existing = issue { phase = .stored }
                else { phase = .failed(issue, revocation: false) }
            } else {
                phase = .authorized
            }
        }
    }

    func disconnect() {
        guard let worker, canDisconnect else { return }
        let run = UUID(); operation = run; phase = .disconnecting
        Task {
            let result = await worker.disconnect()
            guard operation == run else { return }
            presence = result.presence
            if let issue = result.issue { phase = .failed(issue, revocation: true) }
            else { phase = .disconnected }
        }
    }
}
