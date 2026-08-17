// CreatureLayout.swift — Multi-session creature positioning
// Ported from android CreatureLayout.kt

import Foundation

struct CreatureSlot {
    let x: Float
    let y: Float
    let scale: Float
}

enum CreatureLayout {
    /// Layout octopus positions for N agents
    static func layoutOctopuses(count: Int) -> [CreatureSlot] {
        layoutBand(
            count: count,
            xMin: 0.20,
            xMax: 0.50,
            frontY: 0.42,
            backY: 0.52,
            singleRowLimit: 4,
            baseScale: 1.0,
            minScale: 0.58,
            creatureWidth: 0.11
        )
    }

    static func layoutCloudCreatures(count: Int) -> [CreatureSlot] {
        layoutBand(
            count: count,
            xMin: 0.30,
            xMax: 0.55,
            frontY: 0.16,
            backY: 0.28,
            singleRowLimit: 3,
            baseScale: 0.98,
            minScale: 0.56,
            creatureWidth: 0.080
        )
    }

    static func layoutOpenCodeCreatures(count: Int) -> [CreatureSlot] {
        layoutBand(
            count: count,
            xMin: 0.45,
            xMax: 0.68,
            frontY: 0.34,
            backY: 0.46,
            singleRowLimit: 3,
            baseScale: 0.96,
            minScale: 0.56,
            creatureWidth: 0.078
        )
    }

    /// Antigravity peak/arc creatures — upper-right band, distinct from
    /// octopus/cloud/opencode zones.
    static func layoutAntigravityCreatures(count: Int) -> [CreatureSlot] {
        layoutBand(
            count: count,
            xMin: 0.58,
            xMax: 0.82,
            frontY: 0.22,
            backY: 0.34,
            singleRowLimit: 3,
            baseScale: 0.96,
            minScale: 0.56,
            creatureWidth: 0.096
        )
    }

    /// Kiro ghosts — top-left band, INSIDE the visible tank. Above the
    /// octopuses and left of the Codex clouds (0.30+). The x floor is 0.21,
    /// not the tank edge: the session-list HUD covers roughly the left 0.19,
    /// and a band starting at 0.08 put the ghosts behind it. The right side is
    /// the upstream HUD plus the Antigravity strip and crayfish floor.
    static func layoutKiroCreatures(count: Int) -> [CreatureSlot] {
        layoutBand(
            count: count,
            xMin: 0.21,
            xMax: 0.32,
            frontY: 0.10,
            backY: 0.20,
            singleRowLimit: 3,
            baseScale: 0.96,
            minScale: 0.56,
            creatureWidth: 0.086
        )
    }

    /// Hard floor for the crowd-driven shrink. Below the per-band `minScale`
    /// so tightly packed bands can still shrink enough to honor the overlap cap
    /// before we give up and accept brief overlap.
    private static let crowdedMinScale: Float = 0.40

    /// Max fraction of a creature's width that two neighbors may overlap.
    /// 0.5 → centers stay at least half a body-width apart (≤50% overlap).
    private static let maxOverlapFraction: Float = 0.5

    private static func layoutBand(
        count: Int,
        xMin: Float,
        xMax: Float,
        frontY: Float,
        backY: Float,
        singleRowLimit: Int,
        baseScale: Float,
        minScale: Float,
        creatureWidth: Float
    ) -> [CreatureSlot] {
        guard count > 0 else { return [] }

        let rows: Int
        if count <= singleRowLimit {
            rows = 1
        } else if count <= singleRowLimit * 2 {
            rows = 2
        } else {
            rows = 3
        }

        let scale = max(minScale, baseScale - Float(max(0, count - 1)) * 0.055)
        let rowCounts = distribute(count: count, rows: rows)
        var slots: [CreatureSlot] = []
        var absoluteIndex = 0

        for row in 0..<rows {
            let rowCount = rowCounts[row]
            guard rowCount > 0 else { continue }

            let rowT = rows == 1 ? 0 : Float(row) / Float(rows - 1)
            let rowY = frontY + (backY - frontY) * rowT
            let rowInset = 0.015 + Float(row) * 0.02
            let rowMinX = xMin + rowInset
            let rowMaxX = xMax - rowInset
            // Alternating jitter magnitude — constant within a row.
            let spread = max(0.003, min(0.012, (rowMaxX - rowMinX) / Float(max(rowCount * 5, 1))))

            // Overlap cap: keep neighbor center-spacing ≥ maxOverlapFraction of
            // the on-screen body width so creatures never overlap by more than
            // ~half. When the band is too tight to honor that at the count-based
            // scale, shrink every creature in the row by the same ratio (down to
            // crowdedMinScale) instead of letting them pile up.
            var rowScale = max(minScale, scale - Float(row) * 0.04)
            if rowCount >= 2 {
                // Worst-case gap after the alternating jitter squeezes a pair.
                let spacing = (rowMaxX - rowMinX) / Float(rowCount - 1) - 2 * spread
                let overlapCapScale = max(0, spacing) / (maxOverlapFraction * creatureWidth)
                rowScale = max(crowdedMinScale, min(rowScale, overlapCapScale))
            }

            for col in 0..<rowCount {
                let t = rowCount == 1 ? 0.5 : Float(col) / Float(rowCount - 1)
                let baseX = rowMinX + (rowMaxX - rowMinX) * t
                let phase: Float = ((absoluteIndex + row) % 2 == 0) ? -1 : 1
                let x = min(xMax, max(xMin, baseX + spread * phase))
                let yJitter = Float((absoluteIndex % 3) - 1) * 0.008
                slots.append(CreatureSlot(x: x, y: rowY + yJitter, scale: rowScale))
                absoluteIndex += 1
            }
        }

        return slots
    }

    private static func distribute(count: Int, rows: Int) -> [Int] {
        guard rows > 0 else { return [] }
        var result = Array(repeating: count / rows, count: rows)
        for index in 0..<(count % rows) {
            result[index] += 1
        }
        return result
    }
}
