#if os(macOS)
import AppIntents
import Foundation

/// A value snapshot for Shortcuts; the endpoint and session identity stay in `id`.
struct AttentionSessionEntity: AppEntity, Sendable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Session")
    static let defaultQuery = AttentionSessionQuery()

    let id: String

    @Property(title: "Project")
    var projectName: String

    @Property(title: "Agent")
    var agentType: String

    @Property(title: "Question")
    var question: String

    @Property(title: "Last Observed")
    var observedAt: Date

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(projectName)", subtitle: "\(agentType) — \(question)")
    }

    init(item: AttentionSessionItem) {
        id = item.reference.id
        projectName = item.projectName
        agentType = item.agentType
        question = item.question
        observedAt = item.observedAt
    }
}

struct AttentionSessionQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [AttentionSessionEntity] {
        guard !identifiers.isEmpty else { return [] }
        // The service preserves each requested identity when a live session is
        // folded into another row, using that row's current display metadata.
        let items = try await AttentionSessionAccess.shared.resolveSessions(identifiers: identifiers)
        var entities: [AttentionSessionEntity] = []
        for item in items {
            entities.append(AttentionSessionEntity(item: item))
        }
        return entities
    }

    func suggestedEntities() async throws -> [AttentionSessionEntity] {
        let items = try await AttentionSessionAccess.shared.waitingSessions()
        var entities: [AttentionSessionEntity] = []
        for item in items {
            entities.append(AttentionSessionEntity(item: item))
        }
        return entities
    }
}

struct ListWaitingSessionsIntent: AppIntent {
    static let title: LocalizedStringResource = "List Waiting Sessions"
    static let description = IntentDescription("List AgentDeck sessions that need your response.")
    static let supportedModes: IntentModes = .foreground(.immediate)

    @MainActor
    func perform() async throws -> some IntentResult & ReturnsValue<[AttentionSessionEntity]> {
        let items = try await AttentionSessionAccess.shared.waitingSessions()
        var entities: [AttentionSessionEntity] = []
        for item in items {
            entities.append(AttentionSessionEntity(item: item))
        }
        return .result(value: entities)
    }
}

struct OpenAttentionSessionIntent: OpenIntent {
    static let title: LocalizedStringResource = "Open Session"
    static let description = IntentDescription("Show a session in the AgentDeck Dashboard.")
    static let supportedModes: IntentModes = .foreground(.immediate)

    @Parameter(title: "Session")
    var target: AttentionSessionEntity

    @MainActor
    func perform() async throws -> some IntentResult {
        guard let reference = AttentionSessionReference(id: target.id) else {
            throw AttentionSessionIntentError.invalidReference
        }
        try await AttentionSessionAccess.shared.openSession(reference)
        return .result()
    }
}

struct AttentionSessionShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: ListWaitingSessionsIntent(),
            phrases: ["Show waiting sessions in \(.applicationName)"],
            shortTitle: "Waiting Sessions",
            systemImageName: "exclamationmark.bubble"
        )
        AppShortcut(
            intent: OpenAttentionSessionIntent(),
            phrases: ["Open a session in \(.applicationName)"],
            shortTitle: "Open Session",
            systemImageName: "rectangle.stack"
        )
    }
}

private enum AttentionSessionIntentError: LocalizedError {
    case invalidReference

    var errorDescription: String? {
        String(localized: "This session is no longer available. Choose a session again.")
    }
}
#endif
