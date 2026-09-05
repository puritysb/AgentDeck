// Native attention experiment. Pure read projection, deliberately no command API.
import Foundation

struct AttentionContextRow: Identifiable, Equatable, Codable, Sendable {
    let id: String
    var projectName: String?
    var agentType: String?
    var state: String?
    var activity: String?
    var question: String?
    var questionDetail: String?
    var liveAnswerable: Bool?
    var alive: Bool?

    var needsAttention: Bool {
        alive != false && ["awaiting_permission", "awaiting_option", "awaiting_diff"].contains(state ?? "")
    }

    var title: String { projectName?.isEmpty == false ? projectName! : "Unnamed session" }
    var stateLabel: String {
        guard alive != false else { return "관측 종료" }
        switch state {
        case "processing": return "작업 중"
        case "idle": return "대기 중 · 완료 여부 미확인"
        case "awaiting_permission": return "승인 대기"
        case "awaiting_option": return "선택 대기"
        case "awaiting_diff": return "변경 검토 대기"
        case "disconnected": return "연결 끊김"
        default: return "상태 미확인"
        }
    }
}

struct AttentionContextSnapshot: Equatable, Sendable {
    var rows: [AttentionContextRow] = []
    var connected = false
    var receivedAt: Date?
}

/// Event arrivals update content, never selection or the order of existing rows.
/// A vanished selected session remains a labelled last-known detail, not a new target.
struct AttentionContextSelection {
    private(set) var rows: [AttentionContextRow] = []
    private(set) var selectedID: String?
    private(set) var selected: AttentionContextRow?
    private(set) var connected = false
    private(set) var receivedAt: Date?
    private(set) var hasSnapshot = false

    var selectionIsCurrent: Bool {
        connected && rows.contains { $0.id == selectedID && $0.alive != false }
    }

    var awaiting: [AttentionContextRow] { rows.filter(\.needsAttention) }

    mutating func ingest(_ snapshot: AttentionContextSnapshot) {
        connected = snapshot.connected
        // A disconnect often comes with an emptied transport roster. Keep evidence.
        guard snapshot.connected else { return }
        hasSnapshot = true
        receivedAt = snapshot.receivedAt
        var byID: [String: AttentionContextRow] = [:]
        for row in snapshot.rows where !row.id.isEmpty { byID[row.id] = row }
        let oldOrder = rows.map(\.id)
        let remaining = byID.keys.filter { !oldOrder.contains($0) }.sorted()
        rows = (oldOrder + remaining).compactMap { byID[$0] }
        if let id = selectedID, let current = byID[id] { selected = current }
        // No automatic first/awaiting selection: quiet starts with an explicit choice.
    }

    mutating func select(_ id: String) {
        guard let row = rows.first(where: { $0.id == id }) else { return }
        selectedID = id
        selected = row
    }

    mutating func clearSelection() { selectedID = nil; selected = nil }
}
