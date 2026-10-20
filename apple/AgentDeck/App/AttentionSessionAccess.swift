#if os(macOS)
import Foundation
import Combine

/// An address, not a credential or permission to control a session.
struct AttentionSessionReference: Codable, Hashable, Sendable {
    let endpoint: String
    let sessionID: String

    init(endpoint: String, sessionID: String) {
        self.endpoint = endpoint
        self.sessionID = sessionID
    }

    var id: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self) else { return "" }
        return "attention:v1:" + data.base64EncodedString()
    }

    init?(id: String) {
        let prefix = "attention:v1:"
        guard id.hasPrefix(prefix), id.utf8.count <= 8192,
              let data = Data(base64Encoded: String(id.dropFirst(prefix.count))),
              let value = try? JSONDecoder().decode(Self.self, from: data),
              !value.endpoint.isEmpty, !value.sessionID.isEmpty else { return nil }
        self = value
    }
}

struct AttentionSessionItem: Sendable {
    let reference: AttentionSessionReference
    let projectName: String
    let agentType: String
    let question: String
    let observedAt: Date
}

enum AttentionSessionError: LocalizedError, Equatable {
    case unavailable, differentHost, sessionEnded, expired, superseded, invalidNotification

    var errorDescription: String? {
        switch self {
        case .unavailable:
            return "The session list is unavailable or out of date. Check the connection in AgentDeck and try again."
        case .differentHost:
            return "This session belongs to a different host. Select that host in AgentDeck before opening it."
        case .sessionEnded:
            return "This session is no longer available. It may have ended."
        case .expired:
            return "The request to open this session expired. Try opening it again."
        case .superseded:
            return "A newer request to open a session replaced this one."
        case .invalidNotification:
            return "This notification cannot identify its session. Choose a session in the Dashboard."
        }
    }
}

/// Only a sessions_list frame can create this snapshot. Connection changes
/// invalidate it; unrelated traffic and wake events cannot advance its age.
struct AttentionSessionSnapshot: Sendable {
    static let maximumAge: TimeInterval = 20
    let endpoint: String
    let sessions: [SessionInfo]
    let receivedAt: Date

    func isFresh(at now: Date = Date()) -> Bool {
        let age = now.timeIntervalSince(receivedAt)
        return age >= 0 && age < Self.maximumAge
    }

    func items(waitingOnly: Bool, at now: Date = Date()) throws -> [AttentionSessionItem] {
        guard isFresh(at: now) else { throw AttentionSessionError.unavailable }
        return sessions.filter { session in
            session.alive && (!waitingOnly || AgentConnectionState(rawValue: session.state ?? "")?.isAwaiting == true)
        }.sorted { $0.id < $1.id }.map { session in
            AttentionSessionItem(
                reference: AttentionSessionReference(endpoint: endpoint, sessionID: session.id),
                projectName: session.projectName ?? "Session",
                agentType: session.agentType ?? "Unknown agent",
                question: session.question ?? "",
                observedAt: receivedAt)
        }
    }

    func resolve(_ reference: AttentionSessionReference, at now: Date = Date()) throws -> String {
        guard isFresh(at: now) else { throw AttentionSessionError.unavailable }
        guard endpoint == reference.endpoint else { throw AttentionSessionError.differentHost }
        // Exact IDs win; only explicitly declared fold membership is an alias.
        if let row = sessions.first(where: { $0.id == reference.sessionID }) {
            guard row.alive else { throw AttentionSessionError.sessionEnded }
            return row.id
        }
        guard let row = sessions.first(where: {
            $0.alive && ($0.foldedSessionIds ?? []).contains(reference.sessionID)
        }) else { throw AttentionSessionError.sessionEnded }
        return row.id
    }
}

struct AttentionSessionPresentation: Identifiable {
    let id: UUID
    let reference: AttentionSessionReference?
    let expiresAt: Date
    let error: AttentionSessionError?
}

enum AttentionSessionDestination: Equatable {
    case session(String)
    case failure(String)
}

/// One route for notifications and Shortcuts. Retained independently of the
/// Dashboard window so cold launches and menu-bar-only launches cannot lose it.
@MainActor
final class AttentionSessionAccess: ObservableObject {
    static let shared = AttentionSessionAccess()
    @Published private(set) var presentation: AttentionSessionPresentation?
    private(set) var hasRequestedDashboard = false
    private var snapshotProvider: (() -> AttentionSessionSnapshot?)?
    private var dashboardOpener: (() -> Void)?
    private var currentOpenID: UUID?
    private let readinessTimeout: Duration

    init(readinessTimeout: Duration = .seconds(8)) {
        self.readinessTimeout = readinessTimeout
    }

    func configure(snapshot: @escaping () -> AttentionSessionSnapshot?, openDashboard: @escaping () -> Void) {
        snapshotProvider = snapshot
        dashboardOpener = openDashboard
        if hasRequestedDashboard { openDashboard() }
    }

    func waitingSessions() async throws -> [AttentionSessionItem] {
        try await freshSnapshot().items(waitingOnly: true)
    }

    func availableSessions() async throws -> [AttentionSessionItem] {
        try await freshSnapshot().items(waitingOnly: false)
    }

    /// Saved Shortcuts entities can outlive a roster's chosen representative.
    /// Keep the requested identity while refreshing metadata from its live row.
    func resolveSessions(identifiers: [String]) async throws -> [AttentionSessionItem] {
        guard !identifiers.isEmpty else { return [] }
        let snapshot = try await freshSnapshot()
        let now = Date()
        let items = try snapshot.items(waitingOnly: false, at: now)
        var resolved: [AttentionSessionItem] = []
        for identifier in identifiers {
            guard let reference = AttentionSessionReference(id: identifier),
                  let rowID = try? snapshot.resolve(reference, at: now),
                  let item = items.first(where: { $0.reference.sessionID == rowID }) else { continue }
            resolved.append(AttentionSessionItem(
                reference: reference, projectName: item.projectName, agentType: item.agentType,
                question: item.question, observedAt: item.observedAt))
        }
        return resolved
    }

    func openSession(_ reference: AttentionSessionReference) async throws {
        let requestID = UUID()
        currentOpenID = requestID
        presentation = nil
        requestDashboard()
        do {
            let snapshot = try await freshSnapshot(requestID: requestID)
            guard currentOpenID == requestID else { throw AttentionSessionError.superseded }
            _ = try snapshot.resolve(reference)
            presentation = AttentionSessionPresentation(
                id: requestID, reference: reference,
                expiresAt: Date().addingTimeInterval(8), error: nil)
            dashboardOpener?()
        } catch {
            if currentOpenID == requestID, !Task.isCancelled {
                let failure = error as? AttentionSessionError ?? .unavailable
                presentation = AttentionSessionPresentation(
                    id: requestID, reference: nil, expiresAt: Date(), error: failure)
                dashboardOpener?()
            }
            throw error
        }
    }

    func openNotification(referenceID: String?) async {
        guard let referenceID, let reference = AttentionSessionReference(id: referenceID) else {
            let id = UUID()
            currentOpenID = id
            presentation = AttentionSessionPresentation(
                id: id, reference: nil, expiresAt: Date(), error: .invalidNotification)
            requestDashboard()
            return
        }
        // openSession retains a visible, actionable error for notification callers.
        do { try await openSession(reference) } catch { }
    }

    /// Revalidate at consumption, not only when the request was made: the
    /// window may have been closed, or the host/roster may have changed.
    func consumePresentation(id: UUID, at now: Date = Date()) -> AttentionSessionDestination? {
        guard let pending = presentation, pending.id == id else { return nil }
        presentation = nil
        if let error = pending.error { return .failure(error.localizedDescription) }
        guard now < pending.expiresAt else { return .failure(AttentionSessionError.expired.localizedDescription) }
        guard let reference = pending.reference, let snapshot = snapshotProvider?() else {
            return .failure(AttentionSessionError.unavailable.localizedDescription)
        }
        do { return .session(try snapshot.resolve(reference, at: now)) }
        catch { return .failure(error.localizedDescription) }
    }

    private func requestDashboard() {
        hasRequestedDashboard = true
        dashboardOpener?()
    }

    private func freshSnapshot(requestID: UUID? = nil) async throws -> AttentionSessionSnapshot {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: readinessTimeout)
        repeat {
            try Task.checkCancellation()
            if let requestID, currentOpenID != requestID { throw AttentionSessionError.superseded }
            if let snapshot = snapshotProvider?(), snapshot.isFresh() { return snapshot }
            guard clock.now < deadline else { throw AttentionSessionError.unavailable }
            try await Task.sleep(for: .milliseconds(50))
        } while true
    }
}
#endif
