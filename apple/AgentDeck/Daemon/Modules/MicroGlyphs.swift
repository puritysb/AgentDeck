#if os(macOS)
// MicroGlyphs.swift — Timebox Mini 11×11 "Agent Beacon" renderer.
//
// The Timebox is not a miniature terrarium. A generated 9×9 official agent
// mark stays fixed inside a one-pixel status rail. Only that rail animates, so
// identity remains stable while processing/awaiting/error is legible at a glance.
// Mask geometry comes from design/brand/*.svg via generate-micro-glyphs.mjs;
// this file owns only the Timebox-specific color and motion language.

import Foundation

enum MicroCreature { case octopus, codex, opencode, crayfish, antigravity, kiro }
enum MicroAggregate { case idle, processing, awaiting, error }

enum MicroGlyphs {
    typealias RGB = (UInt8, UInt8, UInt8)
    static let size = 11

    private static let background: RGB = (2, 6, 10)
    private static let idleRail: RGB = (38, 170, 116)
    private static let processingRail: RGB = (82, 220, 255)
    private static let awaitingRail: RGB = (255, 184, 54)
    private static let errorRail: RGB = (255, 70, 70)

    private static let perimeter: [(Int, Int)] = {
        var p: [(Int, Int)] = []
        for x in 0..<11 { p.append((x, 0)) }
        for y in 1..<11 { p.append((10, y)) }
        for x in stride(from: 9, through: 0, by: -1) { p.append((x, 10)) }
        for y in stride(from: 9, through: 1, by: -1) { p.append((0, y)) }
        return p
    }()

    private static func officialGlyph(for creature: MicroCreature) -> OfficialDotGlyph {
        switch creature {
        case .octopus: return .claudeCode
        case .codex: return .codex
        case .opencode: return .openCode
        case .crayfish: return .openClaw
        case .antigravity: return .antigravity
        case .kiro: return .kiro
        }
    }

    private static func agentColor(_ glyph: OfficialDotGlyph, sourceX: Int) -> RGB {
        switch glyph {
        case .claudeCode: return (235, 130, 90)
        case .codex: return (112, 124, 255)
        case .openCode: return (238, 238, 238)
        case .openClaw: return (255, 92, 92)
        case .kiro: return (124, 58, 237)
        case .antigravity:
            let bands: [RGB] = [
                (92, 214, 77), (245, 203, 36), (255, 132, 16),
                (255, 82, 65), (183, 92, 182), (102, 111, 225), (36, 126, 255),
            ]
            let index = min(bands.count - 1, sourceX * bands.count / OfficialTimeboxGlyphs.size)
            return bands[index]
        }
    }

    private static func setPixel(
        _ buf: inout [UInt8], x: Int, y: Int, color: RGB, intensity: Double = 1
    ) {
        guard x >= 0, x < size, y >= 0, y < size else { return }
        func channel(_ value: UInt8) -> UInt8 {
            UInt8(max(0, min(255, Int(round(Double(value) * intensity)))))
        }
        let i = (y * size + x) * 3
        buf[i] = channel(color.0)
        buf[i + 1] = channel(color.1)
        buf[i + 2] = channel(color.2)
    }

    private static func paintOfficialMark(
        _ buf: inout [UInt8], creature: MicroCreature, aggregate: MicroAggregate
    ) {
        let glyph = officialGlyph(for: creature)
        guard let mask = OfficialTimeboxGlyphs.masks[glyph] else { return }
        let stateIntensity = aggregate == .idle ? 0.92 : (aggregate == .error ? 0.72 : 1)
        let n = OfficialTimeboxGlyphs.size

        for y in 0..<n {
            for x in 0..<n {
                let alpha = mask[y * n + x]
                let coverage = alpha >= 224 ? 1.0
                    : (alpha >= 144 ? 0.82 : (alpha >= 56 ? 0.56 : (alpha >= 20 ? 0.32 : 0)))
                guard coverage > 0 else { continue }
                let light = 0.88 + (1 - Double(y) / Double(n - 1)) * 0.12
                setPixel(
                    &buf, x: x + 1, y: y + 1,
                    color: agentColor(glyph, sourceX: x),
                    intensity: coverage * stateIntensity * light
                )
            }
        }

        if glyph == .openClaw {
            setPixel(&buf, x: 4, y: 4, color: (0, 229, 204), intensity: stateIntensity)
            setPixel(&buf, x: 7, y: 4, color: (0, 229, 204), intensity: stateIntensity)
        }
    }

    private static func paintStandby(_ buf: inout [UInt8], animFrame: Int) {
        let pulse = 0.55 + 0.25 * ((sin(Double(animFrame) * 0.18) + 1) / 2)
        let tide: RGB = (76, 206, 220)
        for (y, left, right) in [(4, 4, 6), (6, 3, 7), (8, 4, 6)] {
            for x in left...right { setPixel(&buf, x: x, y: y, color: tide, intensity: pulse) }
        }
    }

    private static func paintStatusRail(
        _ buf: inout [UInt8], aggregate: MicroAggregate, animFrame: Int
    ) {
        let railColor: RGB
        switch aggregate {
        case .processing: railColor = processingRail
        case .awaiting: railColor = awaitingRail
        case .error: railColor = errorRail
        case .idle: railColor = idleRail
        }
        let baseIntensity = aggregate == .idle ? 0.10 : 0.13
        for (x, y) in perimeter {
            setPixel(&buf, x: x, y: y, color: railColor, intensity: baseIntensity)
        }

        switch aggregate {
        case .processing:
            let head = (animFrame / 3) % perimeter.count
            for trail in 0..<5 {
                let index = (head - trail + perimeter.count) % perimeter.count
                let (x, y) = perimeter[index]
                setPixel(&buf, x: x, y: y, color: processingRail, intensity: 1 - Double(trail) * 0.17)
            }
        case .awaiting:
            let phase = ((animFrame / 4) & 1) == 0
            let points = phase
                ? [(0, 0), (1, 0), (0, 1), (10, 10), (9, 10), (10, 9)]
                : [(10, 0), (9, 0), (10, 1), (0, 10), (1, 10), (0, 9)]
            for (x, y) in points { setPixel(&buf, x: x, y: y, color: awaitingRail) }
        case .error:
            let intensity = 0.65 + 0.35 * ((sin(Double(animFrame) * 0.35) + 1) / 2)
            for index in stride(from: 0, to: perimeter.count, by: 2) {
                let (x, y) = perimeter[index]
                setPixel(&buf, x: x, y: y, color: errorRail, intensity: intensity)
            }
        case .idle:
            let intensity = 0.56 + 0.16 * ((sin(Double(animFrame) * 0.12) + 1) / 2)
            for (x, y) in [(0, 0), (10, 0), (10, 10), (0, 10)] {
                setPixel(&buf, x: x, y: y, color: idleRail, intensity: intensity)
            }
        }
    }

    /// Paint a complete 11×11 Agent Beacon frame.
    static func paintBeacon(
        _ buf: inout [UInt8], creature: MicroCreature?, aggregate: MicroAggregate, animFrame: Int
    ) {
        guard buf.count == size * size * 3 else { return }
        for i in 0..<(size * size) {
            buf[i * 3] = background.0
            buf[i * 3 + 1] = background.1
            buf[i * 3 + 2] = background.2
        }
        if let creature { paintOfficialMark(&buf, creature: creature, aggregate: aggregate) }
        else { paintStandby(&buf, animFrame: animFrame) }
        paintStatusRail(&buf, aggregate: aggregate, animFrame: animFrame)
    }
}
#endif
