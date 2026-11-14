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
        switch headline {
        case .needsYou(let n): return String(localized: "\(n) need you")
        case .working(let n): return String(localized: "\(n) working")
        case .allClear: return String(localized: "All clear")
        case .unavailable: return String(localized: "AgentDeck —")
        }
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
