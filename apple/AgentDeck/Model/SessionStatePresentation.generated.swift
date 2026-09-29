// GENERATED from shared/src/session-state-presentation.ts and design/tokens.css bindings. DO NOT EDIT.
// Regenerate with `pnpm generate-session-state`.
import Foundation

/// Session state presentation — DESIGN.md §2.7. Only `.awaiting` may animate.
enum SessionTone: Int, CaseIterable, Sendable {
    case idle, working, awaiting, offline

    static let bright: [UInt32] = [0x9A9AA2, 0x3ED6E8, 0xFFA93D, 0x7A8A9C]
    static let paper: [UInt32] = [0x4D4D51, 0x1F6B74, 0x7F541E, 0x3D454E]

    func colorHex(onPaper: Bool = false) -> UInt32 {
        (onPaper ? Self.paper : Self.bright)[rawValue]
    }
    var pulses: Bool { self == .awaiting }
    /// RGB888 for pixel renderers (Pixoo, Timebox, iDotMatrix).
    func rgb(onPaper: Bool = false) -> (UInt8, UInt8, UInt8) {
        let v = colorHex(onPaper: onPaper)
        return (UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF))
    }

    /// Missing → offline; unknown non-empty → idle (a live, quiet session).
    init(wire: String?) {
        guard let wire, !wire.isEmpty else { self = .offline; return }
        self = AgentConnectionState(rawValue: wire)?.sessionTone ?? .idle
    }
}

struct SessionStateWords: Equatable, Sendable {
    /// Sentence case, for rows with room to speak.
    let label: String
    /// Uppercase pill text, at most 7 characters.
    let short: String
    /// At most 4 characters.
    let tiny: String
}

extension AgentConnectionState {
    var sessionTone: SessionTone {
        switch self {
        case .disconnected: .offline
        case .idle: .idle
        case .processing: .working
        case .awaitingPermission: .awaiting
        case .awaitingOption: .awaiting
        case .awaitingDiff: .awaiting
        }
    }

    var sessionWords: SessionStateWords {
        switch self {
        case .disconnected: SessionStateWords(label: "Offline", short: "OFFLINE", tiny: "OFF")
        case .idle: SessionStateWords(label: "Idle", short: "IDLE", tiny: "IDLE")
        case .processing: SessionStateWords(label: "Working", short: "WORKING", tiny: "WORK")
        case .awaitingPermission: SessionStateWords(label: "Needs approval", short: "APPROVE", tiny: "PERM")
        case .awaitingOption: SessionStateWords(label: "Needs a choice", short: "CHOOSE", tiny: "OPT")
        case .awaitingDiff: SessionStateWords(label: "Review diff", short: "REVIEW", tiny: "DIFF")
        }
    }
}
