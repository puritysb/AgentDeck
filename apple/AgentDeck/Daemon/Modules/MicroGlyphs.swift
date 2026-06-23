#if os(macOS)
// MicroGlyphs.swift — Native 11×11 creature glyphs for the Timebox Mini micro layout.
//
// Swift mirror of bridge/src/pixoo/micro-glyphs.ts. The Timebox Mini has only 121
// LEDs; downscaling the 32×32 terrarium creature bottoms out at a fuzzy silhouette,
// so each creature is hand-authored directly at 11×11 as a bold, high-contrast
// bitmap. The glyphs are the canonical brand marks (assets/logos/*_creature_gen.png,
// design/brand/*.svg): Claude=rusty robot, Codex=cloud+`>_`, OpenClaw=lobster,
// OpenCode=ring. The grids and colors here are kept byte-identical to the TS module
// so the App Store macOS build and the Node CLI render the same frames.
//
// Grid characters: '.' transparent (shows status bg), 'B' body, 'A' arm/leg/antenna,
// 'C' claw, 'D' joint/shadow, 'E' eye, 'M' prompt marking, 'F' logo frame.

import Foundation

enum MicroCreature { case octopus, codex, opencode, crayfish }
enum MicroGlyphState { case idle, working, asking }
enum MicroAggregate { case idle, processing, awaiting, error }

enum MicroGlyphs {
    typealias RGB = (UInt8, UInt8, UInt8)
    static let size = 11

    private struct Glyph {
        let colors: [Character: RGB]
        let idle: [String]
        let work: [String]?
    }

    // Claude Code — rusty robot (assets/logos/robot_creature_gen.png): rectangular
    // head with two glowing amber eyes, neck, body with arms (darker joints) jutting
    // out the sides, two legs. Terracotta body kept bright for the LED panel.
    private static let octopus = Glyph(
        colors: ["B": (235, 130, 90), "D": (150, 84, 64), "E": (255, 176, 64)],
        idle: [
            "...........",
            "..BBBBBBB..",
            "..BEEBEEB..",
            "..BBBBBBB..",
            "....BBB....",
            ".DBBBBBBBD.",
            ".DBBBBBBBD.",
            "..BBBBBBB..",
            "...BB.BB...",
            "...BB.BB...",
            "...........",
        ],
        work: [
            "...........",
            "..BBBBBBB..",
            "..BEEBEEB..",
            "..BBBBBBB..",
            "....BBB....",
            ".DBBBBBBBD.",
            ".DBBBBBBBD.",
            "..BBBBBBB..",
            "...BB.BB...",
            "..BB...BB..",
            "..D.....D..",
        ]
    )

    // Codex — lavender cloud (#6166E0, cloud_creature_gen.png): bumpy round cloud
    // body carrying a white `>` chevron + `_` terminal prompt.
    private static let codex = Glyph(
        colors: ["B": (120, 126, 236), "M": (238, 240, 255)],
        idle: [
            ".BB.BB.BB..",
            "BBBBBBBBBB.",
            "BBBBBBBBBBB",
            "BBBBBBBBBBB",
            "BBMBBBBBBBB",
            "BBBMMBBBBBB",
            "BBMBBBBBBBB",
            "BBBBBMMMBBB",
            "BBBBBBBBBBB",
            ".BBBBBBBBB.",
            "..B.BB.B...",
        ],
        work: nil
    )

    // OpenCode — two overlapping HOLLOW squares (canonical opencode.svg ring logo;
    // no filled core — a solid center reads as a shadow). Centered in the field.
    private static let opencode = Glyph(
        colors: ["F": (232, 232, 232)],
        idle: [
            "...........",
            ".FFFFFF....",
            ".F....F....",
            ".F....F....",
            ".F..FFFFFF.",
            ".F..F...F..",
            ".FFFF...F..",
            "....F...F..",
            "....F...F..",
            "....FFFFFF.",
            "...........",
        ],
        work: nil
    )

    // OpenClaw — red mechanical lobster (#FF4D4D, lobster_creature_gen.png): two big
    // claws raised at the top corners, antennae rising from the center, a head with
    // two teal eyes (#00E5CC), and a vertical segmented tail fanning out below.
    private static let crayfish = Glyph(
        colors: ["B": (255, 92, 92), "C": (210, 52, 52), "A": (225, 180, 170), "E": (0, 229, 204)],
        idle: [
            "CC.......CC",
            "CC...A...CC",
            ".C..AAA..C.",
            "...BEBEB...",
            "...BBBBB...",
            "A..BBBBB..A",
            ".A.BBBBB.A.",
            "...BBBBB...",
            "...BBBBB...",
            "...BB.BB...",
            "..BB...BB..",
        ],
        work: [
            "CC.......CC",
            ".C...A...C.",
            "..C.AAA.C..",
            "...BEBEB...",
            "...BBBBB...",
            ".A.BBBBB.A.",
            "A..BBBBB..A",
            "...BBBBB...",
            "...BBBBB...",
            "...B.B.B...",
            "..BB...BB..",
        ]
    )

    private static func glyph(for creature: MicroCreature) -> Glyph {
        switch creature {
        case .octopus: return octopus
        case .codex: return codex
        case .opencode: return opencode
        case .crayfish: return crayfish
        }
    }

    /// Dark status-color field so the bright creature pops. Amber awaiting pulses.
    static func statusBg(_ state: MicroAggregate, animFrame: Int) -> RGB {
        switch state {
        case .error: return (64, 18, 18)
        case .awaiting:
            let p = 0.78 + 0.22 * ((sin(Double(animFrame) * 0.25) + 1) / 2)
            return (UInt8(74 * p), UInt8(50 * p), UInt8(10 * p))
        case .processing: return (10, 28, 64)
        case .idle: return (16, 56, 28)
        }
    }

    /// Paint a creature glyph onto an 11×11 RGB buffer (only non-transparent pixels).
    /// `working` alternates two leg frames; `asking` reuses the idle pose.
    static func paint(_ buf: inout [UInt8], creature: MicroCreature, state: MicroGlyphState, animFrame: Int) {
        let g = glyph(for: creature)
        let grid: [String]
        if state == .working, let work = g.work, ((animFrame >> 2) & 1) == 1 {
            grid = work
        } else {
            grid = g.idle
        }
        for y in 0..<size {
            let row = Array(grid[y])
            for x in 0..<size {
                guard let col = g.colors[row[x]] else { continue }
                let i = (y * size + x) * 3
                buf[i] = col.0; buf[i + 1] = col.1; buf[i + 2] = col.2
            }
        }
    }
}
#endif
