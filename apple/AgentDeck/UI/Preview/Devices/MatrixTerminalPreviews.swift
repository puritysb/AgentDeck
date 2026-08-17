// MatrixTerminalPreviews.swift — Ulanzi TC001/TC100 8×32 LED matrix + TUI terrarium.
//
// The matrix preview draws the Pixoo-style 64×64 frame from PixooPreview,
// then crops the top 8 rows and the middle 32 columns so the result has the
// correct 8×32 aspect. This reuses the real renderer pipeline for visual
// parity with the actual WS2812B hardware. Note: the production matrix code
// path lives in the bridge/ESP32 firmware — this is a *visual approximation*
// sufficient for the "what does it look like" preview, not a driver test.
//
// The terminal preview uses TUITerrariumRenderer directly.

import SwiftUI
#if os(macOS)
import AppKit
#endif

// MARK: - Pixoo 64

struct Pixoo64Preview: View {
    let selection: DevicePreviewSelection
    #if os(macOS)
    @EnvironmentObject private var daemonService: DaemonService
    #endif

    var body: some View {
        VStack(spacing: 12) {
            DeviceBezel(cornerRadius: 16, bezelWidth: 12, bezelColor: Color(white: 0.12)) {
                let config = PixooPreviewConfig(
                    agent: selection.agent,
                    state: selection.state,
                    sessionCount: selection.sessionCount,
                    fiveHourPercent: nil,
                    gatewayAvailable: false,
                    liveState: selection.live?.source
                )
                #if os(macOS)
                PixooDeviceFrameView(config: config, port: daemonService.port)
                    .frame(width: 320, height: 320)
                #else
                PixooStaticFrameView(config: config)
                    .frame(width: 320, height: 320)
                #endif
            }
            .frame(width: 380, height: 380)
            
            Text("Pixoo 64 • 64×64 LED Matrix")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

private struct PixooStaticFrameView: View {
    let config: PixooPreviewConfig

    var body: some View {
        PixooPreview.previewImage(config)
            .resizable()
            .interpolation(.none)
            .aspectRatio(1, contentMode: .fill)
            .cornerRadius(4)
            .overlay(PixooPixelGrid())
    }
}

#if os(macOS)
private struct PixooDeviceFrameView: View {
    let config: PixooPreviewConfig
    let port: UInt16

    @State private var frameImage: NSImage?

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            if let frameImage {
                Image(nsImage: frameImage)
                    .resizable()
                    .interpolation(.none)
                    .aspectRatio(1, contentMode: .fill)
            } else {
                PixooPreview.previewImage(config)
                    .resizable()
                    .interpolation(.none)
                    .aspectRatio(1, contentMode: .fill)
            }

            Text(frameImage == nil ? "SIM" : "LIVE")
                .font(.system(size: 8, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.86))
                .padding(.horizontal, 5)
                .padding(.vertical, 3)
                .background(Color.black.opacity(0.62), in: RoundedRectangle(cornerRadius: 4))
                .padding(5)
        }
        .cornerRadius(4)
        .overlay(PixooPixelGrid())
        .task(id: Int(port)) {
            await pollCurrentFrame()
        }
    }

    private func pollCurrentFrame() async {
        guard port > 0 else { return }
        while !Task.isCancelled {
            await refreshCurrentFrame()
            try? await Task.sleep(for: .milliseconds(500))
        }
    }

    private func refreshCurrentFrame() async {
        guard let url = URL(string: "http://127.0.0.1:\(port)/pixoo/frame?ts=\(Int(Date().timeIntervalSince1970 * 1000))") else {
            return
        }
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.timeoutInterval = 1.5

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard
                let http = response as? HTTPURLResponse,
                http.statusCode == 200,
                let image = NSImage(data: data)
            else {
                return
            }
            await MainActor.run {
                self.frameImage = image
            }
        } catch {
            // Keep the last good frame; if none exists, the simulated frame remains visible.
        }
    }
}
#endif

private struct PixooPixelGrid: View {
    var body: some View {
        GeometryReader { geo in
            Path { p in
                let stepXY = geo.size.width / 64
                for i in 0...64 {
                    let pos = CGFloat(i) * stepXY
                    p.move(to: CGPoint(x: pos, y: 0))
                    p.addLine(to: CGPoint(x: pos, y: geo.size.height))
                    p.move(to: CGPoint(x: 0, y: pos))
                    p.addLine(to: CGPoint(x: geo.size.width, y: pos))
                }
            }
            .stroke(Color.black.opacity(0.35), lineWidth: 0.3)
        }
    }
}

// MARK: - Ulanzi TC001 matrix
//
// Real firmware (esp32/src/ui/matrix/matrix_pages.cpp) rotates through
// pages: AGENTS (creature sprites, renderAgents), USAGE (full-screen 5h/7d
// percent gauges, renderUsage), CODEX (primary/secondary token-window
// gauges, renderCodex), and a disconnect breathing pulse. USAGE and CODEX
// both delegate to renderGaugePair(): with two windows present it cross-fades
// first↔second on a 9s cycle (0.5s slides); a single window draws one gauge,
// and a missing first window promotes the second. Gauge fill follows the
// blue→amber→red severity ramp; the CODEX page paints its percent numeral
// electric-violet CRGB(196,112,255) while the USAGE page keeps it white.
//
// This preview reproduces ONLY the AGENTS page — the firmware's exact
// generated 8×8 alpha masks rasterized from design/brand/*.svg, its per-kind
// state colors, and the subagent satellites (up to three cyan perimeter pixels
// per glyph, each with a dim wire pixel toward the glyph centre) — as a single
// static frame (no page cycling, gauge numerals, or text scroller). The
// USAGE/CODEX gauge additions above (the
// codex violet numeral + renderGaugePair) render on pages this preview does
// not draw, so they leave the mirrored AGENTS pixels unchanged; they are
// documented here so the pin bump below is a conscious "checked, does not
// affect the AGENTS render" acknowledgement.
//
// SYNC-HASH esp32/src/ui/matrix/matrix_pages.cpp ff885f0187a2a0769fad084f146dcdb58733e07a
// scripts/check-preview-mirror-sync.mjs fails CI when the origin above drifts
// from this pin — re-verify AGENTS-page parity and bump the hash together.

struct UlanziMatrixPreview: View {
    let selection: DevicePreviewSelection

    // 8x32 WS2812B LED grid rendered as a CSS-style dot matrix. Pixel
    // size controls how big each LED appears in the preview; keep it
    // generous so the shape of the creature is legible.
    private let ledPixel: CGFloat = 10
    private let matrixW = 32
    private let matrixH = 8

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(cornerRadius: 10, bezelWidth: 8, bezelColor: Color(white: 0.12)) {
                GeometryReader { _ in
                    ZStack {
                        Color.black
                        Canvas { ctx, size in
                            drawMatrix(ctx: &ctx, size: size)
                        }
                        .padding(2)
                    }
                }
            }
            .frame(width: CGFloat(matrixW) * ledPixel + 28,
                   height: CGFloat(matrixH) * ledPixel + 28)
            Text("Ulanzi TC001 • 8×32 WS2812B")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
            Text("AGENTS page — one creature sprite per alive session; OpenClaw crayfish pins to the right edge. Firmware also rotates USAGE (5h/7d percent gauges) and CODEX (violet token-window gauges) pages.")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
    }

    // Draw the AGENTS page directly into a Canvas using one filled rect
    // per "lit" LED. Mirrors matrix_pages.cpp renderAgents: agents left-to-
    // right at the 8px official-mark stride, crayfish pinned at x=24 when
    // OpenClaw is in the mix.
    private func drawMatrix(ctx: inout GraphicsContext, size: CGSize) {
        let cellW = size.width / CGFloat(matrixW)
        let cellH = size.height / CGFloat(matrixH)

        // Off-LED fill — very dim grey so the grid is visible without
        // drawing a separate overlay.
        let offColor = Color(red: 0.06, green: 0.06, blue: 0.08)
        for y in 0..<matrixH {
            for x in 0..<matrixW {
                let rect = CGRect(
                    x: CGFloat(x) * cellW + 1,
                    y: CGFloat(y) * cellH + 1,
                    width: cellW - 2,
                    height: cellH - 2
                )
                ctx.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(offColor))
            }
        }

        // Live-follow → real sessions (per-session agent + state); manual → the
        // synthesized palette. One creature per alive session, like the firmware.
        let sessions = selection.displaySessions
        let hasOpenClaw = sessions.contains { $0.agent == .openclaw }
        let crayfishX = 24
        let agentMaxX = hasOpenClaw ? crayfishX - 8 : matrixW - 8

        // Non-OpenClaw agents march left → right at the native 8px glyph width.
        var cursorX = 0
        for (index, session) in sessions.enumerated() where session.agent != .openclaw {
            guard cursorX <= agentMaxX else { break }
            let agent = session.agent
            let state = session.state
            drawSprite(
                ctx: &ctx, atX: cursorX,
                alpha: Tc001Sprites.mask(for: agent),
                bodyRGB: Tc001Sprites.bodyRGB255(agent: agent, state: state, instanceIdx: index),
                rainbow: agent == .antigravity,
                cellW: cellW, cellH: cellH
            )
            drawSubagentSatellites(
                ctx: &ctx, atX: cursorX, count: session.subagentCount,
                cellW: cellW, cellH: cellH
            )
            cursorX += 8
        }

        // OpenClaw crayfish pinned at the right edge — the firmware's
        // Gateway-presence signal (uses the OpenClaw session's own state).
        if hasOpenClaw {
            let ocState = sessions.first { $0.agent == .openclaw }?.state ?? selection.state
            drawSprite(
                ctx: &ctx, atX: crayfishX,
                alpha: Tc001Sprites.mask(for: .openclaw),
                bodyRGB: Tc001Sprites.bodyRGB255(agent: .openclaw, state: ocState, instanceIdx: 0),
                rainbow: false,
                cellW: cellW, cellH: cellH
            )
        }

        // Empty aquarium → idle breathing octopus, matching the firmware's
        // agentCount == 0 branch (dim terracotta, mid-breath).
        if sessions.isEmpty {
            drawSprite(
                ctx: &ctx, atX: 12,
                alpha: Tc001Sprites.mask(for: .claudeCode),
                bodyRGB: (64, 38, 29),
                rainbow: false,
                cellW: cellW, cellH: cellH
            )
        }
    }

    /// Subagent satellites — mirrors `drawSubagentSatellites` in
    /// matrix_pages.cpp. The 8×32 grid has no room for a literal orbit, so up
    /// to three cyan perimeter pixels stand in, each with a dim "wire" pixel
    /// pulled halfway toward the glyph centre so the satellite reads as owned
    /// by the adjacent creature rather than as a fourth agent.
    private func drawSubagentSatellites(
        ctx: inout GraphicsContext, atX x: Int, count: Int,
        cellW: CGFloat, cellH: CGFloat
    ) {
        guard count > 0 else { return }
        let sx = [7, 7, 0]
        let sy = [0, 7, 0]
        let cyan = Color(red: 0, green: 229.0 / 255.0, blue: 1)
        let wire = Color(red: 0, green: 62.0 / 255.0, blue: 78.0 / 255.0)
        for i in 0..<min(count, 3) {
            plot(ctx: &ctx, x: x + sx[i], y: sy[i], color: cyan, cellW: cellW, cellH: cellH)
            // Integer halving toward the 4,4 centre, exactly as the firmware
            // computes it — (0 - 4) / 2 truncates to -2 in both languages.
            plot(ctx: &ctx, x: x + 4 + (sx[i] - 4) / 2, y: 4 + (sy[i] - 4) / 2,
                 color: wire, cellW: cellW, cellH: cellH)
        }
    }

    private func plot(
        ctx: inout GraphicsContext, x: Int, y: Int, color: Color,
        cellW: CGFloat, cellH: CGFloat
    ) {
        guard x >= 0, x < matrixW, y >= 0, y < matrixH else { return }
        let rect = CGRect(
            x: CGFloat(x) * cellW + 1, y: CGFloat(y) * cellH + 1,
            width: cellW - 2, height: cellH - 2
        )
        ctx.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(color))
    }

    private func drawSprite(
        ctx: inout GraphicsContext,
        atX x: Int,
        alpha: [UInt8], bodyRGB: (Double, Double, Double), rainbow: Bool,
        cellW: CGFloat, cellH: CGFloat
    ) {
        for row in 0..<OfficialTc001Glyphs.size {
            for col in 0..<OfficialTc001Glyphs.size {
                let coverage = Double(alpha[row * OfficialTc001Glyphs.size + col]) / 255
                guard coverage >= 12.0 / 255.0 else { continue }
                let source = rainbow ? Self.rainbowBands[col] : bodyRGB
                let envelope = rainbow ? min(1, max(bodyRGB.0, bodyRGB.1, bodyRGB.2) / 255 * 1.45) : 1
                let color = Color(
                    red: source.0 / 255 * envelope * coverage,
                    green: source.1 / 255 * envelope * coverage,
                    blue: source.2 / 255 * envelope * coverage
                )
                drawLED(ctx: &ctx, x: x + col, y: row, color: color,
                        cellW: cellW, cellH: cellH)
            }
        }
    }

    private func drawLED(
        ctx: inout GraphicsContext,
        x: Int, y: Int,
        color: Color,
        cellW: CGFloat, cellH: CGFloat
    ) {
        guard x >= 0, x < matrixW, y >= 0, y < matrixH else { return }
        let rect = CGRect(
            x: CGFloat(x) * cellW + 1,
            y: CGFloat(y) * cellH + 1,
            width: cellW - 2,
            height: cellH - 2
        )
        // Slight glow to suggest an LED lens on top of an LED die.
        ctx.fill(Path(roundedRect: rect, cornerRadius: 1.5), with: .color(color.opacity(0.92)))
        ctx.fill(
            Path(ellipseIn: rect.insetBy(dx: rect.width * 0.18, dy: rect.height * 0.18)),
            with: .color(color)
        )
    }

    /// Same left-to-right rainbow bands as firmware drawOfficialMatrixGlyph.
    private static let rainbowBands: [(Double, Double, Double)] = [
        (92, 214, 77), (31, 198, 179), (58, 199, 235), (245, 203, 36),
        (255, 82, 65), (183, 92, 182), (102, 111, 225), (36, 126, 255),
    ]
}

/// TC001 preview adapter. Geometry comes from generated OfficialTc001Glyphs;
/// only the firmware state-color model remains hand-written here.
private enum Tc001Sprites {
    static func mask(for agent: PixooPreviewAgent) -> [UInt8] {
        let key: OfficialDotGlyph
        switch agent {
        case .claudeCode: key = .claudeCode
        case .codex: key = .codex
        case .opencode: key = .openCode
        case .openclaw: key = .openClaw
        case .antigravity: key = .antigravity
        case .kiro: key = .kiro
        }
        return OfficialTc001Glyphs.masks[key] ?? []
    }

    /// Raw 0–255 body tone behind `bodyColor` — used directly by the antigravity
    /// rainbow micro renderer, which scales its hues by this brightness envelope.
    static func bodyRGB255(agent: PixooPreviewAgent, state: PixooPreviewState, instanceIdx: Int) -> (Double, Double, Double) {
        var rgb: (Double, Double, Double)
        switch state {
        case .processing:
            switch agent {
            case .codex:       rgb = (65, 65, 160)    // indigo, mid-pulse
            case .opencode:    rgb = (140, 132, 132)  // warm light gray, mid-pulse
            case .antigravity: rgb = (140, 143, 148)  // cool gray envelope, mid-pulse
            case .kiro:        rgb = (98, 60, 174)    // Kiro purple, mid-pulse
            default:           rgb = (125, 75, 56)    // terracotta, mid-pulse
            }
        case .awaitingPrompt:
            rgb = (130, 78, 0)                     // amber, mid-pulse
        case .idle:
            switch agent {
            case .codex:       rgb = (30, 30, 80)
            case .opencode:    rgb = (72, 67, 67)
            case .antigravity: rgb = (68, 70, 73)     // dim rainbow envelope
            case .kiro:        rgb = (58, 32, 103)    // dim Kiro purple
            default:           rgb = (80, 45, 35)
            }
        case .disconnected:
            rgb = (25, 25, 25)
        }
        // Firmware dims each additional instance of the same agent kind.
        if instanceIdx > 0 {
            let factor = Double(10 - min(instanceIdx, 4) * 2) / 10
            rgb = (rgb.0 * factor, rgb.1 * factor, rgb.2 * factor)
        }
        return rgb
    }

}

// MARK: - Divoom Timebox Mini (11×11)
//
// Renders the EXACT native micro frame the Timebox module pushes over BLE:
// `PixooRenderer.renderMicro` composes the hand-authored 11×11 MicroGlyphs
// creature on its status field. The preview shows the same bytes on a
// dot-matrix grid — no separate drawing code to drift.

struct TimeboxMiniPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 12) {
            DeviceBezel(cornerRadius: 18, bezelWidth: 18, bezelColor: Color(white: 0.16)) {
                let config = PixooPreviewConfig(
                    agent: selection.agent,
                    state: selection.state,
                    sessionCount: selection.sessionCount,
                    fiveHourPercent: nil,
                    gatewayAvailable: false,
                    liveState: selection.live?.source
                )
                MatrixFrameView(cgImage: PixooPreview.previewMicroCGImage(config), gridSide: 11)
                    .frame(width: 286, height: 286)
            }
            .frame(width: 340, height: 340)
            Text("Divoom Timebox Mini • 11×11 BLE")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
            Text("Native micro-glyph frame — the same renderMicro output the daemon uploads to the panel.")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
    }
}

// MARK: - iDotMatrix 32×32
//
// Renders the EXACT frame pipeline the iDotMatrix module ships over BLE:
// 64×64 PixooRenderer scene → box downscale to 32×32 → the same
// brightness/contrast boost. See PixooPreview.preview32RGB.

struct IDotMatrixPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 12) {
            DeviceBezel(cornerRadius: 14, bezelWidth: 12, bezelColor: Color(white: 0.1)) {
                let config = PixooPreviewConfig(
                    agent: selection.agent,
                    state: selection.state,
                    sessionCount: selection.sessionCount,
                    fiveHourPercent: nil,
                    gatewayAvailable: selection.agent == .openclaw,
                    liveState: selection.live?.source
                )
                MatrixFrameView(cgImage: PixooPreview.preview32CGImage(config), gridSide: 32)
                    .frame(width: 320, height: 320)
            }
            .frame(width: 370, height: 370)
            Text("iDotMatrix • 32×32 BLE LED")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
            Text("Downscaled 64×64 aquarium with the device's brightness boost — the exact BLE frame pipeline.")
                .font(.system(size: 9))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
    }
}

/// Shared LED-matrix frame presenter: nearest-neighbor image + pixel grid.
private struct MatrixFrameView: View {
    let cgImage: CGImage?
    let gridSide: Int

    var body: some View {
        ZStack {
            if let cgImage {
                Image(decorative: cgImage, scale: 1.0, orientation: .up)
                    .resizable()
                    .interpolation(.none)
                    .antialiased(false)
                    .aspectRatio(1, contentMode: .fit)
            } else {
                Color.black
            }
        }
        .overlay(matrixGrid)
        .cornerRadius(4)
    }

    private var matrixGrid: some View {
        GeometryReader { geo in
            Path { p in
                let step = geo.size.width / CGFloat(gridSide)
                for i in 0...gridSide {
                    let pos = CGFloat(i) * step
                    p.move(to: CGPoint(x: pos, y: 0))
                    p.addLine(to: CGPoint(x: pos, y: geo.size.height))
                    p.move(to: CGPoint(x: 0, y: pos))
                    p.addLine(to: CGPoint(x: geo.size.width, y: pos))
                }
            }
            .stroke(Color.black.opacity(0.35), lineWidth: 0.3)
        }
    }
}

// MARK: - Terminal Terrarium

struct TerminalTerrariumPreview: View {
    let selection: DevicePreviewSelection

    private var agentsAndStates: (agents: [String], states: [String]) {
        // Live-follow → the daemon's real sessions (agent + state per session).
        if selection.live != nil {
            let sessions = selection.displaySessions
            return (sessions.map { $0.agent.rawValue },
                    sessions.map { $0.state.sessionStateStringForUI })
        }
        // Manual → a fixed-variety palette so the terrarium reads as populated.
        let count = max(selection.sessionCount, 1)
        let palette: [PixooPreviewAgent] = [selection.agent, .codex, .opencode, .openclaw]
        var agents: [String] = []
        var states: [String] = []
        for i in 0..<min(count, 4) {
            agents.append(palette[i % palette.count].rawValue)
            states.append(i == 0 ? selection.state.sessionStateStringForUI : "idle")
        }
        return (agents, states)
    }

    var body: some View {
        VStack(spacing: 10) {
            let (agents, states) = agentsAndStates
            let config = TerrariumPreviewConfig(
                agents: agents,
                states: states,
                animationFrame: selection.animationFrame,
                width: 60,
                height: 20
            )
            DeviceBezel(cornerRadius: 10, bezelWidth: 10, bezelColor: Color(white: 0.18), screenColor: .black) {
                TUITerrariumRenderer(config: config, cellWidth: 8, cellHeight: 16)
            }
            .frame(width: 540, height: 360)
            Text("Terminal • agentdeck dashboard")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}
