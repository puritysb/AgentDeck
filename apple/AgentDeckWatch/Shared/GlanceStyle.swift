import SwiftUI

/// Wording and colour for a `RemoteGlance`, shared by the Watch app and its
/// complications so both surfaces say the same thing about the same evidence.
extension RemoteGlance {
    var count: Int? {
        switch headline {
        case .needsYou(let n), .working(let n): return n
        case .allClear: return 0
        case .unavailable: return nil
        }
    }

    var title: String {
        switch headline {
        case .needsYou(let n): return n == 1 ? String(localized: "needs you") : String(localized: "need you")
        case .working: return String(localized: "working")
        case .allClear: return String(localized: "All clear")
        case .unavailable: return String(localized: "No summary")
        }
    }

    /// A compact label for inline complications.
    var inline: String {
        let label: String
        switch headline {
        case .needsYou(let n): label = n == 1 ? String(localized: "1 needs you") : String(localized: "\(n) need you")
        case .working(let n): label = String(localized: "\(n) working")
        case .allClear: label = String(localized: "All clear")
        case .unavailable: label = String(localized: "AgentDeck —")
        }
        return historical ? String(localized: "Last: \(label)") : label
    }

    /// Session-state tokens (DESIGN.md §2.7); historical evidence is muted.
    var tint: Color {
        if historical { return DesignTokens.Session.offline }
        switch headline {
        case .needsYou: return DesignTokens.Session.awaiting
        case .working: return DesignTokens.Session.working
        case .allClear: return DesignTokens.Session.idle
        case .unavailable: return DesignTokens.Session.offline
        }
    }
}
