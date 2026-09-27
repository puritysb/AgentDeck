import Foundation

/// Name-tag placement for the native aquarium (DESIGN.md §6.4) — the same rule
/// as Android's `resolveResidentLabels`, driven by the shared `TerrariumRules`.
///
/// A tag must never hide another resident. Tags resolve in priority order —
/// focused, awaiting, working, idle; nearer residents first within a rank:
/// in a dense tank an idle, unfocused tag collapses to a title chip; an idle tag
/// that would collide with a tag already placed is dropped (the roster keeps
/// it); any tag lying over another resident's body yields its backing so the
/// body shows through. Rects are screen-oriented (y grows downward).
enum ResidentLabelLayout {
    struct Box: Equatable {
        var left: Float, top: Float, right: Float, bottom: Float
        func intersects(_ other: Box) -> Bool {
            left < other.right && other.left < right && top < other.bottom && other.top < bottom
        }
    }

    enum Mode: Equatable { case full, compact, hidden }

    enum Rank: Int { case focused = 0, awaiting, working, idle }

    struct Input {
        let id: String
        let rank: Rank
        let body: Box
        let fullTag: Box
        let compactTag: Box
    }

    struct Decision: Equatable {
        let id: String
        let mode: Mode
        let backingOpacity: Float
        let textOpacity: Float
        /// The WORKING badge and its ink — the state signal, faded only when yielding.
        var signalOpacity: Float = 1
    }

    /// Decisions in draw order: lowest priority first.
    static func resolve(_ inputs: [Input]) -> [Decision] {
        let dense = inputs.count >= TerrariumRules.nativeLabelDenseResidentCount
        let ordered = inputs.sorted {
            if $0.rank != $1.rank { return $0.rank.rawValue < $1.rank.rawValue }
            if $0.body.bottom != $1.body.bottom { return $0.body.bottom > $1.body.bottom }
            return $0.id < $1.id
        }
        var placed: [Box] = []
        let decisions = ordered.map { input -> Decision in
            let idle = input.rank == .idle
            let compact = dense && idle
            let box = compact ? input.compactTag : input.fullTag
            let collides = placed.contains { $0.intersects(box) }
            if collides && idle { return Decision(id: input.id, mode: .hidden, backingOpacity: 0, textOpacity: 0, signalOpacity: 0) }
            placed.append(box)
            let overBody = inputs.contains { $0.id != input.id && $0.body.intersects(box) }
            let yielding = collides || overBody
            let backing = yielding ? TerrariumRules.nativeLabelYieldBackingOpacity
                : compact ? TerrariumRules.nativeLabelCompactBackingOpacity
                : TerrariumRules.nativeLabelBackingOpacity
            let text: Float = !idle ? 1
                : yielding ? TerrariumRules.nativeLabelYieldTextOpacity
                : TerrariumRules.nativeLabelIdleTextOpacity
            return Decision(id: input.id, mode: compact ? .compact : .full, backingOpacity: backing, textOpacity: text,
                            signalOpacity: yielding ? TerrariumRules.nativeLabelYieldSignalOpacity : 1)
        }
        return decisions.reversed()
    }
}
