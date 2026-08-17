// TUITerrariumRenderer.swift — Cross-platform TUI terrarium preview renderer.
//
// Swift port (preview-scoped) of `bridge/src/tui/terrarium.ts`. This is a
// deterministic, visual-parity-only renderer used by the Device Preview
// feature to show what the TUI dashboard's aquarium looks like — it does
// NOT output ANSI codes, it renders into a SwiftUI Canvas with a monospaced
// font, one character cell at a time.
//
// Sync pin — verified by `scripts/check-preview-mirror-sync.mjs` (CI). When the
// origin changes, re-port (or confirm no visual impact given the deliberate
// simplifications below) and bump the pin in the same commit.
// SYNC-HASH bridge/src/tui/terrarium.ts 47a475ebde15a4333b3395deeb67f83cc00a2290
//
// Scope / deliberate simplifications (vs the TS original):
//   - No Braille sprites: creatures render as 3-char ASCII glyphs colored by
//     agent brand (via StateColors.brand). Preserves silhouette/position.
//   - Deterministic only: no Math.random(), no Boids, no Lissajous. Bubble
//     positions and fish positions are seeded from (index + frame).
//   - No voice/starburst/signal-wave particle systems. First-pass preview.
//   - Fixed 60×20 grid (the TS "small" scale). Resizing supported via config.
//
// NOTE: the existing `TerrariumRenderer` class in `apple/AgentDeck/Terrarium/`
// is a *Canvas-drawing* aquarium renderer used by the production Dashboard —
// it is NOT a SwiftUI View. This file introduces `TUITerrariumRenderer: View`
// to avoid the name clash (Xcode also forbids two `.swift` files with the
// same leaf name in one target, which is why this file is prefixed "TUI").
// The public helper namespace is `TerrariumPreview`.

import SwiftUI

// MARK: - Public config

/// Configuration for a single static/animated frame of the TUI terrarium preview.
struct TerrariumPreviewConfig: Equatable {
    /// Agent identifiers, one per creature. Accepts:
    ///   "claude-code", "codex-cli", "opencode", "openclaw"
    /// Unknown strings render as the default octopus glyph.
    var agents: [String]
    /// Parallel to `agents`. Accepts canonical state strings:
    ///   "idle", "processing", "awaiting_permission", "awaiting_option",
    ///   "awaiting_diff", "disconnected". Also tolerates camelCase
    ///   ("awaitingPrompt" / "awaitingPermission") and empty/nil by mapping
    ///   to "idle".
    var states: [String]
    /// Animation tick, 0..N. Step this externally (e.g. via a TimelineView)
    /// to animate the preview; all derived positions are deterministic in `animationFrame`.
    var animationFrame: Int = 0
    /// Character-grid columns.
    var width: Int = 60
    /// Character-grid rows.
    var height: Int = 20

    init(
        agents: [String] = [],
        states: [String] = [],
        animationFrame: Int = 0,
        width: Int = 60,
        height: Int = 20
    ) {
        self.agents = agents
        self.states = states
        self.animationFrame = animationFrame
        self.width = max(20, width)
        self.height = max(6, height)
    }
}

// MARK: - Public view

/// SwiftUI view that renders a single frame of the TUI terrarium into a
/// monospaced Canvas. Deterministic w.r.t. `config.animationFrame`.
struct TUITerrariumRenderer: View {
    let config: TerrariumPreviewConfig

    /// Reasonable default cell size; callers can wrap in a sized container.
    var cellWidth: CGFloat = 8
    var cellHeight: CGFloat = 16

    var body: some View {
        let grid = TerrariumGridBuilder.build(config: config)
        let w = CGFloat(config.width) * cellWidth
        let h = CGFloat(config.height) * cellHeight

        return Canvas(opaque: true) { ctx, _ in
            // Water gradient background (rows = depth). Mirrors TS bg(r,g,b) ramp.
            for row in 0..<config.height {
                let t = Double(row) / Double(max(1, config.height))
                let r = 10.0 + t * 20.0
                let g = 22.0 + t * 36.0
                let b = 40.0 + t * 55.0
                let color = Color(red: r / 255.0, green: g / 255.0, blue: b / 255.0)
                let rect = CGRect(
                    x: 0,
                    y: CGFloat(row) * cellHeight,
                    width: w,
                    height: cellHeight
                )
                ctx.fill(Path(rect), with: .color(color))
            }
            // Draw each cell's glyph + fg color.
            for row in 0..<config.height {
                for col in 0..<config.width {
                    let cell = grid[row][col]
                    guard cell.char != " " else { continue }
                    let text = Text(String(cell.char))
                        .font(.system(size: cellHeight * 0.85,
                                      weight: .regular,
                                      design: .monospaced))
                        .foregroundColor(cell.color)
                    let origin = CGPoint(
                        x: CGFloat(col) * cellWidth + cellWidth / 2,
                        y: CGFloat(row) * cellHeight + cellHeight / 2
                    )
                    let resolved = ctx.resolve(text)
                    ctx.draw(resolved, at: origin, anchor: .center)
                }
            }
        }
        .frame(width: w, height: h)
        .accessibilityLabel("Terrarium preview")
    }
}

// MARK: - Optional helper for static snapshots

enum TerrariumPreview {
    /// Returns a ready-made view for the given config. Thin wrapper; kept so
    /// call sites can write `TerrariumPreview.render(config)` without knowing
    /// the exact view type.
    @ViewBuilder
    static func render(_ config: TerrariumPreviewConfig) -> some View {
        TUITerrariumRenderer(config: config)
    }
}

// MARK: - Grid model

private struct TerrariumCell {
    var char: Character = " "
    var color: Color = .white
}

private enum TerrariumPalette {
    // Environment palette — distilled from colors in `bridge/src/tui/ansi.ts`.
    static let sand       = Color(red: 218 / 255, green: 178 / 255, blue: 128 / 255)
    static let seaweed    = Color(red:  88 / 255, green: 170 / 255, blue: 100 / 255)
    static let bubble     = Color(red: 180 / 255, green: 210 / 255, blue: 240 / 255)
    static let waveCrest  = Color(red: 100 / 255, green: 149 / 255, blue: 237 / 255)
    static let tetra      = Color(red: 100 / 255, green: 220 / 255, blue: 255 / 255)
    static let nameTag    = Color(red: 180 / 255, green: 180 / 255, blue: 180 / 255)
    static let awaitQ     = Color(red: 255 / 255, green: 255 / 255, blue: 100 / 255)

    /// Creature color = agent brand (StateColors.brand) tinted by state.
    /// Idle → full brand. Processing → brightened. Awaiting → awaiting amber.
    /// Disconnected → dim gray.
    static func creatureColor(agent: String, state: String) -> Color {
        let s = normalizeState(state)
        switch s {
        case "disconnected":
            return Color(red: 0.42, green: 0.45, blue: 0.50)
        case "awaiting":
            return Color(hex: StateColors.Hex.awaiting)
        case "processing":
            return StateColors.brand(agent: agent)
        default: // idle
            return StateColors.brand(agent: agent)
        }
    }
}

/// Collapse the many state labels into 4 buckets the renderer cares about.
private func normalizeState(_ s: String) -> String {
    if s.isEmpty { return "idle" }
    let lower = s.lowercased()
    if lower.contains("disconnect") { return "disconnected" }
    if lower.contains("await") { return "awaiting" }      // awaiting_* / awaitingPrompt
    if lower.contains("process") || lower == "working" { return "processing" }
    if lower == "idle" || lower == "floating" || lower == "sleeping" { return "idle" }
    return "idle"
}

// MARK: - Grid builder (pure)

private enum TerrariumGridBuilder {
    static func build(config: TerrariumPreviewConfig) -> [[TerrariumCell]] {
        let width = config.width
        let height = config.height
        let frame = config.animationFrame
        let sandRow = max(2, height - 2)

        var grid: [[TerrariumCell]] = Array(
            repeating: Array(repeating: TerrariumCell(), count: width),
            count: height
        )

        // --- water surface wave (row 0) ---
        let waveChars: [Character] = ["~", "\u{2248}", "\u{223F}", "~", "\u{2248}"]
        for x in 0..<width {
            let idx = ((x + frame) % waveChars.count + waveChars.count) % waveChars.count
            grid[0][x] = TerrariumCell(char: waveChars[idx], color: TerrariumPalette.waveCrest)
        }

        // --- sand bed (last 2 rows) ---
        let sandPatternsA: [Character] = Array("░▒░░░░▒▒░░")
        let sandPatternsB: [Character] = Array("░░░░▒░░░░░")
        for row in sandRow..<height {
            let pattern = row == height - 1 ? sandPatternsA : sandPatternsB
            for x in 0..<width {
                let idx = (x * 7 + 3) % pattern.count
                grid[row][x] = TerrariumCell(char: pattern[idx], color: TerrariumPalette.sand)
            }
        }

        // --- seaweed (short, near the floor) ---
        let seaweedFractions: [Double] = [0.04, 0.10, 0.18, 0.85, 0.92, 0.97]
        let seaweedTop = max(0, height - 5)
        for row in seaweedTop..<sandRow {
            for pos in seaweedFractions {
                let sx = Int(pos * Double(width))
                guard sx >= 0, sx < width else { continue }
                let depth = sandRow - row
                let ch: Character
                if depth <= 1 {
                    ch = "\u{2502}" // │
                } else {
                    // deterministic sway from frame+pos
                    let phase = sin(Double(frame) * 0.05 + pos * 15) > 0
                    ch = phase ? "\u{2571}" : "\u{2572}"
                }
                grid[row][sx] = TerrariumCell(char: ch, color: TerrariumPalette.seaweed)
            }
        }

        // --- static bubbles (deterministic) ---
        let bubbleChars: [Character] = ["\u{00B0}", "\u{00B7}", "\u{25CB}", "\u{25E6}"]
        let bubbleCount = 8
        for i in 0..<bubbleCount {
            // Pseudo-random stream using a cheap hash — no RNG, frame-driven.
            let seed = (i * 2654435761) & 0x7fffffff
            let xFrac = 0.08 + Double((seed ^ (i &* 31)) % 1000) / 1250.0 // 0.08..0.88
            // Animate Y by frame but wrap deterministically.
            let yRaw = (Double(height - 3) - Double((i * 3 + frame / 2) % (height - 3)))
            let bx = Int(xFrac * Double(width))
            let by = max(1, Int(yRaw))
            if by > 0, by < sandRow, bx >= 0, bx < width, grid[by][bx].char == " " {
                let ch = bubbleChars[i % bubbleChars.count]
                grid[by][bx] = TerrariumCell(char: ch, color: TerrariumPalette.bubble)
            }
        }

        // --- static fish school (2 fish, 3-char glyphs, deterministic) ---
        let fishCount = 4
        for i in 0..<fishCount {
            // Center moves on a slow sinusoid; each fish offsets by index.
            let t = Double(frame) * 0.04 + Double(i) * 1.3
            let fx = 0.15 + 0.7 * (0.5 + 0.5 * sin(t))
            let fy = 0.22 + 0.35 * (0.5 + 0.5 * cos(t * 0.7 + Double(i)))
            let forward = Int(sin(t * 0.3)) >= 0
            let glyph: [Character] = forward ? ["\u{003E}", "\u{003C}", "\u{003E}"] : ["\u{003C}", "\u{003E}", "\u{003C}"]
            let fxi = Int(fx * Double(width))
            let fyi = Int(fy * Double(height))
            for (k, ch) in glyph.enumerated() {
                let px = fxi + k
                if fyi > 0, fyi < sandRow, px >= 0, px < width, grid[fyi][px].char == " " {
                    grid[fyi][px] = TerrariumCell(char: ch, color: TerrariumPalette.tetra)
                }
            }
        }

        // --- creatures ---
        let count = max(config.agents.count, config.states.count)
        for i in 0..<count {
            let agent = i < config.agents.count ? config.agents[i] : "claude-code"
            let stateRaw = i < config.states.count ? config.states[i] : "idle"
            let state = normalizeState(stateRaw)

            // Horizontal spread: evenly distribute across the aquarium middle.
            let fracX: Double = count <= 1
                ? 0.35
                : 0.12 + (Double(i) * 0.70) / Double(max(1, count - 1))
            // Vertical position by state, matching terrarium.ts logic:
            //   processing → near surface (0.30), awaiting → mid (0.50),
            //   idle/disconnected → on the floor (~0.88).
            let fracYBase: Double
            switch state {
            case "processing": fracYBase = 0.30
            case "awaiting":   fracYBase = 0.50
            default:           fracYBase = 0.82
            }
            // Gentle bob — bigger amplitude when swimming.
            let bobAmp = state == "processing" ? 0.025 : 0.008
            let bobFreq = state == "processing" ? 0.18 : 0.05
            let phase = Double(i) * 1.1
            let fracY = fracYBase + sin(Double(frame) * bobFreq + phase) * bobAmp

            let cx = Int(fracX * Double(width))
            let cy = max(1, min(sandRow - 1, Int(fracY * Double(height))))

            let glyph = creatureGlyph(agent: agent, state: state)
            let color = TerrariumPalette.creatureColor(agent: agent, state: state)
            drawGlyph(glyph, center: (cx, cy), color: color, into: &grid)

            // "?" indicator when awaiting (above creature, to the right)
            if state == "awaiting" {
                let qx = cx + 2
                let qy = cy - 1
                if qy >= 0, qy < height, qx >= 0, qx < width {
                    grid[qy][qx] = TerrariumCell(char: "?", color: TerrariumPalette.awaitQ)
                }
            }

            // Simple processing "sparkle" — one char above the creature.
            if state == "processing" {
                let sx = cx
                let sy = max(0, cy - 2)
                if grid[sy][sx].char == " " {
                    grid[sy][sx] = TerrariumCell(
                        char: "\u{2727}", // ✧
                        color: Color(red: 1.0, green: 0.78, blue: 0.39)
                    )
                }
            }

            // Agent label underneath the creature (short form).
            let label = shortLabel(for: agent, index: i)
            let lx = cx - label.count / 2
            let ly = cy + 2
            if ly < sandRow {
                for (k, ch) in label.enumerated() {
                    let px = lx + k
                    if px >= 0, px < width {
                        grid[ly][px] = TerrariumCell(char: ch, color: TerrariumPalette.nameTag)
                    }
                }
            }
        }

        return grid
    }

    /// Single-row 3-char glyph per agent. Kept small so it fits at 60×20.
    private static func creatureGlyph(agent: String, state: String) -> [Character] {
        switch agent {
        case "claude-code":
            // octopus-ish: tentacles + eye
            return state == "processing" ? ["(", "\u{25CF}", ")"] : ["(", "o", ")"]
        case "codex-cli", "codex-app":
            // cloud / jellyfish
            return state == "processing" ? ["<", "\u{25C7}", ">"] : ["<", "o", ">"]
        case "opencode":
            // nested box
            return ["\u{2508}", "\u{25A2}", "\u{2508}"]
        case "antigravity":
            return ["\u{2571}", "\u{25B2}", "\u{2572}"]
        case "openclaw":
            // crayfish — pincers
            return state == "processing" ? ["\u{03BB}", "\u{25C9}", "\u{03BB}"]
                                         : ["\u{03BB}", "o", "\u{03BB}"]
        case "kiro-cli", "kiro-ide":
            // ghost - domed head between parentheses; the filled disc marks
            // WORKING, matching how the other creatures signal it here.
            return state == "processing" ? ["(", "\u{25D5}", ")"]
                                         : ["(", "\u{25CB}", ")"]
        default:
            return ["(", "o", ")"]
        }
    }

    private static func shortLabel(for agent: String, index: Int) -> String {
        switch agent {
        case "claude-code": return "cc"
        case "codex-cli":   return "cx"
        case "codex-app":   return "ca"
        case "opencode":    return "oc"
        case "antigravity": return "ag"
        case "openclaw":    return "ow"
        case "kiro-cli":    return "kc"
        case "kiro-ide":    return "ki"
        default:            return "a\(index)"
        }
    }

    private static func drawGlyph(
        _ glyph: [Character],
        center: (Int, Int),
        color: Color,
        into grid: inout [[TerrariumCell]]
    ) {
        let (cx, cy) = center
        let h = grid.count
        let w = grid.first?.count ?? 0
        guard cy >= 0, cy < h else { return }
        let startX = cx - glyph.count / 2
        for (k, ch) in glyph.enumerated() {
            let px = startX + k
            guard px >= 0, px < w else { continue }
            grid[cy][px] = TerrariumCell(char: ch, color: color)
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("TUI terrarium — mixed states") {
    let config = TerrariumPreviewConfig(
            agents: ["claude-code", "codex-cli", "codex-app", "opencode", "openclaw"],
        states: ["processing", "awaiting_permission", "idle", "processing"],
        animationFrame: 42
    )
    return TUITerrariumRenderer(config: config)
        .padding()
        .background(Color.black)
}

#Preview("TUI terrarium — single idle") {
    let config = TerrariumPreviewConfig(
        agents: ["claude-code"],
        states: ["idle"],
        animationFrame: 0,
        width: 60,
        height: 20
    )
    return TUITerrariumRenderer(config: config)
        .padding()
        .background(Color.black)
}
#endif
