// PixooPreview.swift — Cross-platform, static preview wrapper around PixooRenderer.
//
// Purpose: expose the existing macOS `PixooRenderer` (which ports bridge/src/pixoo)
// as a reusable preview API for Device Preview and SwiftUI previews — WITHOUT
// duplicating any rendering logic. The renderer itself stays macOS-only (it lives
// in the in-process daemon); on iOS we return a stub image so the Device Preview
// UI can compile and run without a second Swift port.
//
// Key points:
//   - `PixooRenderer` has internal mutable state (bubbles, particles, animation
//     clocks). For deterministic preview output we instantiate a fresh renderer
//     on every call and discard it — its no-arg init is pure Swift with no I/O.
//   - The synthesized `DashboardState` mirrors what `syncCreatures` and the
//     gateway/HUD code in PixooRenderer actually read: `state`, `agentType`,
//     `siblingSessions[]` (with `alive` / `state` / `agentType`),
//     `fiveHourPercent`, `gatewayAvailable`.
//   - Agent rawValues match PixooRenderer's creature sets exactly:
//     codingAgents=["claude-code"], cloudAgents=["codex-cli"],
//     opencodeAgents=["opencode"]. "openclaw" is rendered as a crayfish via
//     the gateway path (`$0.agentType == "openclaw"` in siblings).

import Foundation
import SwiftUI
import CoreGraphics

// MARK: - Public API

/// Agent identity for preview. The raw values are the exact strings that
/// PixooRenderer's creature classifier checks against.
enum PixooPreviewAgent: String, CaseIterable, Identifiable, Sendable {
    case claudeCode  = "claude-code"
    case codex       = "codex-cli"
    case opencode    = "opencode"
    case openclaw    = "openclaw"
    case antigravity = "antigravity"
    case kiro        = "kiro-cli"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .claudeCode:  return "Claude"
        case .codex:       return "Codex"
        case .opencode:    return "OpenCode"
        case .openclaw:    return "OpenClaw"
        case .antigravity: return "Antigravity"
        case .kiro:        return "Kiro"
        }
    }
}

/// High-level preview state buckets. These map onto `AgentConnectionState`
/// and the string values PixooRenderer's `mapSessionState` recognizes.
enum PixooPreviewState: String, CaseIterable, Identifiable, Sendable {
    case idle
    case processing
    case awaitingPrompt
    case disconnected

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .idle:            return "Idle"
        case .processing:      return "Processing"
        case .awaitingPrompt:  return "Awaiting"
        case .disconnected:    return "Disconnected"
        }
    }

    /// Dashboard-level AgentConnectionState.
    fileprivate var dashboardState: AgentConnectionState {
        switch self {
        case .idle:           return .idle
        case .processing:     return .processing
        case .awaitingPrompt: return .awaitingPermission
        case .disconnected:   return .disconnected
        }
    }

    /// Session-level state string, matching `PixooRenderer.mapSessionState`.
    /// Note: use snake_case forms (`awaiting_permission`) — these are the
    /// exact strings bridges emit on `SessionInfo.state`.
    fileprivate var sessionStateString: String {
        switch self {
        case .idle:           return "idle"
        case .processing:     return "processing"
        case .awaitingPrompt: return "awaiting_permission"
        case .disconnected:   return "disconnected"
        }
    }
}

/// Input for a single preview frame.
struct PixooPreviewConfig: Sendable {
    var agent: PixooPreviewAgent
    var state: PixooPreviewState
    /// How many creatures to populate in `siblingSessions`. `0` on
    /// `.disconnected` yields an empty aquarium.
    var sessionCount: Int = 1
    var fiveHourPercent: Double? = nil
    var gatewayAvailable: Bool = false
    /// Live-follow: the real daemon state. When set, it is rendered verbatim
    /// (the Pixoo/Timebox/iDotMatrix previews become pixel-exact emulators) and
    /// the coarse `agent`/`state`/`sessionCount` synthesis above is bypassed.
    var liveState: DashboardState? = nil

    init(
        agent: PixooPreviewAgent,
        state: PixooPreviewState,
        sessionCount: Int = 1,
        fiveHourPercent: Double? = nil,
        gatewayAvailable: Bool = false,
        liveState: DashboardState? = nil
    ) {
        self.agent = agent
        self.state = state
        self.sessionCount = sessionCount
        self.fiveHourPercent = fiveHourPercent
        self.gatewayAvailable = gatewayAvailable
        self.liveState = liveState
    }
}

enum PixooPreview {

    // MARK: Raw bytes

    /// 64×64 raw RGB24 bytes (length = 12288). Cross-platform:
    /// - On macOS: runs a fresh `PixooRenderer` instance.
    /// - On iOS: returns a uniform dark-slate fill as a stub (see note at file top).
    static func previewRGB(_ config: PixooPreviewConfig) -> Data {
        #if os(macOS)
        let state = Self.synthesizeDashboardState(config)
        // Fresh instance per call — PixooRenderer carries mutable animation
        // state (bubbles, particles, creature positions) across frames, so
        // sharing one would leak non-determinism into previews.
        let renderer = PixooRenderer()
        return renderer.render(dashboardState: state)
        #else
        return Self.iOSStubRGB()
        #endif
    }

    /// Native 11×11 micro-glyph frame (length = 363) — the exact
    /// `PixooRenderer.renderMicro` output the Timebox Mini module pushes
    /// over BLE (before software-brightness dimming). iOS returns a stub.
    static func previewMicroRGB(_ config: PixooPreviewConfig) -> Data {
        #if os(macOS)
        let state = Self.synthesizeDashboardState(config)
        let renderer = PixooRenderer()
        return renderer.renderMicro(dashboardState: state)
        #else
        return Self.iOSStubRGB(side: 11)
        #endif
    }

    /// 32×32 frame (length = 3072) — the exact pipeline IDotMatrixModule
    /// runs for the real device: 64×64 render → box downscale → the same
    /// brightness/contrast boost applied before the BLE upload.
    static func preview32RGB(_ config: PixooPreviewConfig) -> Data {
        #if os(macOS)
        let rgb64 = [UInt8](previewRGB(config))
        var rgb32 = IDotMatrixModule.downscale64to32(rgb64)
        rgb32 = IDotMatrixModule.boostBrightnessContrast(rgb32, brightness: 1.6, contrast: 1.2)
        return Data(rgb32)
        #else
        return Self.iOSStubRGB(side: 32)
        #endif
    }

    // MARK: CGImage

    /// 64×64 CGImage. Callers who need to draw at a specific size should scale
    /// this themselves. RGB24, no alpha.
    static func previewCGImage(_ config: PixooPreviewConfig) -> CGImage? {
        let rgb = previewRGB(config)
        return Self.makeCGImage(rgb: rgb, width: 64, height: 64)
    }

    /// 11×11 CGImage of the Timebox Mini micro frame.
    static func previewMicroCGImage(_ config: PixooPreviewConfig) -> CGImage? {
        Self.makeCGImage(rgb: previewMicroRGB(config), width: 11, height: 11)
    }

    /// 32×32 CGImage of the iDotMatrix frame.
    static func preview32CGImage(_ config: PixooPreviewConfig) -> CGImage? {
        Self.makeCGImage(rgb: preview32RGB(config), width: 32, height: 32)
    }

    // MARK: SwiftUI Image

    /// SwiftUI `Image` wrapping the CGImage. No interpolation smoothing —
    /// callers that need nearest-neighbor should apply
    /// `.interpolation(.none)` on the returned Image.
    static func previewImage(_ config: PixooPreviewConfig) -> Image {
        if let cg = previewCGImage(config) {
            return Image(decorative: cg, scale: 1.0, orientation: .up)
                .interpolation(.none)
                .antialiased(false)
        }
        // Fallback placeholder — should be unreachable.
        return Image(systemName: "square.fill")
    }

    // MARK: - Helpers

    private static func synthesizeDashboardState(_ config: PixooPreviewConfig) -> DashboardState {
        // Live-follow: render the real daemon state verbatim through the real
        // renderer — a pixel-exact emulator frame, no synthesis.
        if let live = config.liveState { return live }
        var ds = DashboardState()
        ds.bridgeConnected = true
        ds.fiveHourPercent = config.fiveHourPercent
        ds.gatewayAvailable = config.gatewayAvailable
        ds.gatewayHasError = false

        let empty = config.sessionCount == 0 || config.state == .disconnected
        if empty {
            ds.state = .disconnected
            ds.agentType = nil
            ds.siblingSessions = []
            return ds
        }

        ds.state = config.state.dashboardState
        ds.agentType = config.agent.rawValue

        let stateStr = config.state.sessionStateString
        let count = max(1, config.sessionCount)
        ds.siblingSessions = (0..<count).map { i in
            SessionInfo(
                id: "preview-\(i)",
                port: 9120 + i,
                projectName: "preview",
                agentType: config.agent.rawValue,
                alive: true,
                state: stateStr,
                modelName: nil,
                startedAt: nil
            )
        }
        return ds
    }

    /// Build a CGImage from 64×64 RGB24 data. Returns nil on any CG failure.
    private static func makeCGImage(rgb: Data, width: Int, height: Int) -> CGImage? {
        let expected = width * height * 3
        guard rgb.count >= expected else { return nil }
        let trimmed = rgb.count == expected ? rgb : rgb.prefix(expected)

        guard let provider = CGDataProvider(data: Data(trimmed) as CFData) else { return nil }
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue)
        return CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 24,
            bytesPerRow: width * 3,
            space: colorSpace,
            bitmapInfo: bitmapInfo,
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }

    #if !os(macOS)
    /// iOS fallback: we deliberately do NOT re-port 1500 LOC of renderer to iOS
    /// just for previews. Instead we return a uniform dark-slate fill so
    /// `previewImage()` still has something visible. Consumers wanting rich
    /// previews on iOS should run the preview on macOS, or add a SwiftUI
    /// shim that layers a text overlay over this fill.
    private static func iOSStubRGB(side: Int = 64) -> Data {
        // Dark slate (#20293A-ish): R=0x20, G=0x29, B=0x3A
        let byteCount = side * side * 3
        var buf = Data(count: byteCount)
        buf.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else { return }
            for i in stride(from: 0, to: byteCount, by: 3) {
                base.storeBytes(of: 0x20, toByteOffset: i,     as: UInt8.self)
                base.storeBytes(of: 0x29, toByteOffset: i + 1, as: UInt8.self)
                base.storeBytes(of: 0x3A, toByteOffset: i + 2, as: UInt8.self)
            }
        }
        return buf
    }
    #endif
}
