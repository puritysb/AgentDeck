#if os(macOS)
// PixooRenderer.swift — Direct Swift port of bridge/src/pixoo renderer pipeline.

import Foundation

/// Decode the nested usage payload once at the device-module boundary. Keeping
/// the typed value in DashboardState gives Pixoo64 and iDotMatrix identical
/// Codex-window semantics without duplicating dictionary parsing in render code.
func dotMatrixCodexRateLimits(from raw: Any?) -> CodexRateLimits? {
    guard let raw, JSONSerialization.isValidJSONObject(raw),
          let data = try? JSONSerialization.data(withJSONObject: raw),
          let limits = try? JSONDecoder().decode(CodexRateLimits.self, from: data)
    else { return nil }
    return limits
}

final class PixooRenderer {
    private typealias RGB = (UInt8, UInt8, UInt8)

    private struct Camera {
        var cx: Double
        var cy: Double
        var zoom: Double
    }

    private struct CameraZone {
        let name: String
        let cx: Double
        let cy: Double
        let zoom: Double
        let duration: Double
    }

    private struct ActiveCreature {
        let x: Double
        let y: Double
        let priority: Int
    }

    private enum DirectorMode {
        case idleCycle
        case tracking
        case cyclingActive
    }

    private struct DirectorState {
        var mode: DirectorMode
        var camera: Camera
        var idleIndex: Int
        var currentZone: CameraZone
        var targetZone: CameraZone
        var zoneTimer: Double
        var transitionT: Double
        var transitioning: Bool
        var activeIndex: Int
        var activeDwell: Double
    }

    private enum CreatureKind {
        case octopus
        case cloud
        case opencode
        case antigravity
        case kiro
    }

    private enum CreatureState {
        case idle
        case processing
        case awaiting
    }

    private struct CreatureInstance {
        var sessionId: String
        var agentType: String
        var creatureType: CreatureKind
        var state: CreatureState
        var worldX: Double
        var worldY: Double
        var phaseOffset: Int
        /// Crowd-driven shrink from CreatureLayout — shared with the Node
        /// renderer via shared/src/creature-layout.ts.
        var sizeScale: Double
    }

    private struct CompactMark {
        let glyph: OfficialDotGlyph
        let state: CreatureState
        let toneIndex: Int
    }

    private struct Bubble {
        var x: Double
        var y: Double
        var speed: Double
        var wobblePhase: Double
        var bright: Bool
    }

    private struct DataParticle {
        var x: Double
        var y: Double
        var vy: Double
        var life: Double
        var green: Bool
    }

    private struct TetraState {
        var x: Double
        var y: Double
        var heading: Double
        var speed: Double
        var phase: Double
        var schoolId: Int
    }

    private struct OctopusPalette {
        let body: RGB
        let arm: RGB
        let leg: RGB
        let sleeping: RGB
        let starburst: RGB
    }

    private struct CloudPalette {
        let body: RGB
        let edge: RGB
        let marking: RGB
        let sleeping: RGB
        let pulse: RGB
    }

    private struct OpenCodePalette {
        let outer: RGB
        let inner: RGB
        let sleeping: RGB
        let pulse: RGB
    }

    private struct AntigravityPalette {
        let lime: RGB
        let teal: RGB
        let cyan: RGB
        let yellow: RGB
        let orange: RGB
        let red: RGB
        let pink: RGB
        let violet: RGB
        let blue: RGB
        let sky: RGB
        let cutout: RGB
    }

    private static let width = 64
    private static let height = 64
    private static let sandTop = 54
    private static let sandBot = 59
    private static let substrateTop = 60
    private static let surfaceY = 2
    private static let cfDefaultX = 0.72
    private static let cfDefaultY = 0.74
    private static let transitionSec = 8.0
    private static let activeDwellSec = 6.0
    private static let wideCamera = Camera(cx: 0.5, cy: 0.5, zoom: 1.0)
    private static let zones: [String: CameraZone] = [
        "wide": .init(name: "wide", cx: 0.5, cy: 0.5, zoom: 1.0, duration: 10),
        "pan-left": .init(name: "pan-left", cx: 0.35, cy: 0.52, zoom: 1.15, duration: 8),
        "pan-right": .init(name: "pan-right", cx: 0.65, cy: 0.52, zoom: 1.15, duration: 8),
        "school": .init(name: "school", cx: 0.5, cy: 0.4, zoom: 1.6, duration: 10),
    ]
    private static let idleCycle: [CameraZone] = [
        zones["wide"]!,
        zones["pan-left"]!,
        zones["wide"]!,
        zones["pan-right"]!,
    ]

    private static let phi = (1.0 + sqrt(5.0)) / 2.0
    private static let sessionToneFactors: [Double] = [1.08, 1.0, 0.9, 0.8, 0.72, 0.64]
    private static let codingAgents = Set(["claude-code"])
    private static let cloudAgents = Set(["codex-cli", "codex-app"])
    private static let opencodeAgents = Set(["opencode"])
    private static let antigravityAgents = Set(["antigravity"])
    private static let kiroAgents = Set(["kiro-cli", "kiro-ide"])

    private static let octopusGrid: [[Int]] = [
        [0,0,1,1,1,1,1,1,1,1,1,0,0],
        [0,1,1,1,1,1,1,1,1,1,1,1,0],
        [0,1,1,1,1,1,1,1,1,1,1,1,0],
        [0,1,1,1,2,1,1,1,2,1,1,1,0],
        [0,1,1,1,2,1,1,1,2,1,1,1,0],
        [3,1,1,1,1,1,1,1,1,1,1,1,4],
        [3,3,1,1,1,1,1,1,1,1,1,4,4],
        [3,3,1,1,1,1,1,1,1,1,1,4,4],
        [0,0,1,1,1,1,1,1,1,1,1,0,0],
        [0,0,1,1,1,1,1,1,1,1,1,0,0],
        [0,0,5,0,5,0,1,0,6,0,6,0,0],
        [0,0,5,0,5,0,0,0,6,0,6,0,0],
        [0,0,5,0,0,0,0,0,0,0,6,0,0],
    ]
    private static let octopusLOD: [[Int]] = [
        [0,1,1,1,1,1,0],
        [1,1,1,1,1,1,1],
        [1,1,2,1,2,1,1],
        [1,1,1,1,1,1,1],
        [0,1,1,1,1,1,0],
        [0,0,5,1,6,0,0],
        [0,0,5,0,6,0,0],
    ]
    private static let crayfishGrid: [[Int]] = [
        [0,0,7,0,0,0,0,0,0,7,0,0],
        [0,0,0,7,0,0,0,0,7,0,0,0],
        [0,0,0,1,1,1,1,1,1,0,0,0],
        [3,3,1,1,1,1,1,1,1,1,4,4],
        [0,3,1,1,2,1,1,2,1,1,4,0],
        [0,0,1,1,1,1,1,1,1,1,0,0],
        [0,0,0,1,1,1,1,1,1,0,0,0],
        [0,0,5,0,0,1,1,0,0,6,0,0],
    ]
    private static let crayfishLOD: [[Int]] = [
        [0,7,0,0,0,0,7,0],
        [0,0,1,1,1,1,0,0],
        [3,1,1,1,1,1,1,4],
        [0,1,2,1,1,2,1,0],
        [0,0,1,1,1,1,0,0],
        [0,5,0,1,1,0,6,0],
    ]
    private static let cloudGrid: [[Int]] = [
        [0,0,0,1,1,0,0,1,1,0,0,0,0],
        [0,0,1,1,1,1,0,1,1,1,1,0,0],
        [0,1,1,1,1,1,1,1,1,1,1,1,0],
        [1,1,1,1,1,1,1,1,1,1,1,1,1],
        [3,1,1,2,1,1,1,1,1,1,1,1,3],
        [3,1,1,1,2,1,1,1,2,2,2,1,3],
        [3,1,1,2,1,1,1,1,1,1,1,1,3],
        [1,1,1,1,1,1,1,1,1,1,1,1,1],
        [0,1,1,1,1,1,1,1,1,1,1,1,0],
        [0,0,1,1,1,1,0,1,1,1,1,0,0],
        [0,0,0,1,1,0,0,1,1,0,0,0,0],
    ]
    private static let cloudLOD: [[Int]] = [
        [0,1,1,0,1,1,0,1,0],
        [1,1,1,1,1,1,1,1,1],
        [1,1,2,1,1,1,1,1,1],
        [1,1,1,2,1,2,2,2,1],
        [1,1,2,1,1,1,1,1,1],
        [1,1,1,1,1,1,1,1,1],
        [0,1,1,0,1,1,0,1,0],
    ]
    private static let opencodeGrid: [[Int]] = [
        [8,8,8,8,8,8,8,8,8,8],
        [8,0,0,0,0,0,0,0,0,8],
        [8,0,9,9,9,9,9,9,0,8],
        [8,0,9,0,0,0,0,9,0,8],
        [8,0,9,0,0,0,0,9,0,8],
        [8,0,9,0,0,0,0,9,0,8],
        [8,0,9,9,9,9,9,9,0,8],
        [8,0,0,0,0,0,0,0,0,8],
        [8,8,8,8,8,8,8,8,8,8],
    ]
    private static let opencodeLOD: [[Int]] = [
        [8,8,8,8,8,8],
        [8,0,0,0,0,8],
        [8,0,9,9,0,8],
        [8,0,9,9,0,8],
        [8,0,0,0,0,8],
        [8,8,8,8,8,8],
    ]
    private static let antigravityGrid: [String] = [
        "....YOO....",
        "....YOO....",
        "...LYOOR...",
        "...LTORR...",
        "..LLTVPP...",
        "..TTKKVPP..",
        ".TQQK.KVU..",
        ".QQK...KUU.",
        "NQK.....KUU",
        "NN.......UU",
        "...........",
    ]

    private static let pixelFont: [Character: [UInt8]] = [
        "0": [0b111, 0b101, 0b101, 0b101, 0b111],
        "1": [0b010, 0b110, 0b010, 0b010, 0b111],
        "2": [0b111, 0b001, 0b111, 0b100, 0b111],
        "3": [0b111, 0b001, 0b111, 0b001, 0b111],
        "4": [0b101, 0b101, 0b111, 0b001, 0b001],
        "5": [0b111, 0b100, 0b111, 0b001, 0b111],
        "6": [0b111, 0b100, 0b111, 0b101, 0b111],
        "7": [0b111, 0b001, 0b001, 0b001, 0b001],
        "8": [0b111, 0b101, 0b111, 0b101, 0b111],
        "9": [0b111, 0b101, 0b111, 0b001, 0b111],
        "%": [0b101, 0b001, 0b010, 0b100, 0b101],
        "/": [0b001, 0b001, 0b010, 0b100, 0b100],
        "h": [0b100, 0b100, 0b111, 0b101, 0b101],
        "m": [0b101, 0b111, 0b101, 0b101, 0b101],
        "d": [0b001, 0b001, 0b011, 0b101, 0b011],
        " ": [0b000, 0b000, 0b000, 0b000, 0b000],
        // Uppercase glyphs for "OFFLINE" disconnected frame — mirrors
        // bridge/src/pixoo/pixoo-font.ts.
        "O": [0b010, 0b101, 0b101, 0b101, 0b010],
        "F": [0b111, 0b100, 0b110, 0b100, 0b100],
        "L": [0b100, 0b100, 0b100, 0b100, 0b111],
        "I": [0b111, 0b010, 0b010, 0b010, 0b111],
        "N": [0b101, 0b111, 0b111, 0b101, 0b101],
        "E": [0b111, 0b100, 0b110, 0b100, 0b111],
    ]

    private static let colors = Colors()

    private struct Colors {
        let octopusBody: RGB = (0xC0, 0x70, 0x58)
        let octopusEye: RGB = (0x10, 0x08, 0x08)
        let octopusArm: RGB = (0xA0, 0x58, 0x40)
        let octopusLeg: RGB = (0xA0, 0x58, 0x40)
        let octopusSleeping: RGB = (0x80, 0x50, 0x40)
        let octopusStarburst: RGB = (0xD0, 0x88, 0x70)
        let crayfishBody: RGB = (0xFF, 0x4D, 0x4D)
        let crayfishEye: RGB = (0x00, 0xE5, 0xCC)
        let crayfishEyeRing: RGB = (0x10, 0x08, 0x08)
        let crayfishClaw: RGB = (0xCC, 0x44, 0x33)
        let crayfishLeg: RGB = (0xCC, 0x33, 0x33)
        let crayfishRouting: RGB = (0xFF, 0x6B, 0x6B)
        let crayfishAntenna: RGB = (0xDD, 0x55, 0x55)
        let crayfishGlow: RGB = (0x80, 0x20, 0x20)
        let crayfishSick: RGB = (0x88, 0x66, 0x66)
        let cloudBody: RGB = (0x63, 0x66, 0xF1)
        let cloudEdge: RGB = (0x4F, 0x46, 0xE5)
        let cloudMarking: RGB = (0xF5, 0xF7, 0xFF)
        let cloudGlow: RGB = (0x31, 0x33, 0x78)
        let cloudPulse: RGB = (0xA5, 0xB4, 0xFC)
        let cloudSleeping: RGB = (0x3A, 0x3C, 0x90)
        let opencodeOuter: RGB = (0xF1, 0xEC, 0xEC)
        let opencodeInner: RGB = (0x4B, 0x46, 0x46)
        let opencodePulse: RGB = (0xCF, 0xCE, 0xCD)
        let opencodeSleeping: RGB = (0x8A, 0x84, 0x84)
        let antigravityLime: RGB = (0x5C, 0xD6, 0x4D)
        let antigravityTeal: RGB = (0x1F, 0xC6, 0xB3)
        let antigravityCyan: RGB = (0x3A, 0xC7, 0xEB)
        let antigravityYellow: RGB = (0xF5, 0xCB, 0x24)
        let antigravityOrange: RGB = (0xFF, 0x84, 0x10)
        let antigravityRed: RGB = (0xFF, 0x52, 0x41)
        let antigravityPink: RGB = (0xB7, 0x5C, 0xB6)
        let antigravityViolet: RGB = (0x66, 0x6F, 0xE1)
        let antigravityBlue: RGB = (0x24, 0x7E, 0xFF)
        let antigravitySky: RGB = (0x29, 0xB8, 0xEE)
        let tetraNeon: RGB = (0x00, 0xE5, 0xFF)
        let tetraBody: RGB = (0x1E, 0x40, 0xAF)
        let tetraFin: RGB = (0xFF, 0x6B, 0x6B)
        let waterDeep: RGB = (0x14, 0x24, 0x3C)
        let waterMid: RGB = (0x1C, 0x38, 0x58)
        let waterLight: RGB = (0x24, 0x48, 0x6C)
        let waterSurface: RGB = (0x2C, 0x58, 0x80)
        let waterTealDeep: RGB = (0x10, 0x30, 0x3C)
        let waterTealMid: RGB = (0x18, 0x44, 0x50)
        let waterTealLight: RGB = (0x22, 0x58, 0x64)
        let waterTealSurface: RGB = (0x2C, 0x6C, 0x78)
        let waterAmberDeep: RGB = (0x34, 0x24, 0x14)
        let waterAmberMid: RGB = (0x4C, 0x36, 0x1C)
        let waterAmberLight: RGB = (0x60, 0x48, 0x24)
        let waterAmberSurface: RGB = (0x78, 0x5C, 0x2E)
        let waterRedDeep: RGB = (0x3C, 0x14, 0x14)
        let waterRedMid: RGB = (0x58, 0x1E, 0x1E)
        let waterRedLight: RGB = (0x70, 0x28, 0x28)
        let waterRedSurface: RGB = (0x88, 0x32, 0x32)
        let sand: RGB = (0x38, 0x2C, 0x1E)
        let sandLight: RGB = (0x4C, 0x3C, 0x28)
        let sandDark: RGB = (0x28, 0x20, 0x14)
        let gravel: RGB = (0x44, 0x36, 0x24)
        let rock: RGB = (0x2C, 0x24, 0x1A)
        let rockLight: RGB = (0x38, 0x2E, 0x22)
        let seaweed: RGB = (0x22, 0xC5, 0x5E)
        let seaweedDark: RGB = (0x18, 0x90, 0x42)
        let seaweedLight: RGB = (0x30, 0xE0, 0x70)
        let bubble: RGB = (0x40, 0x70, 0xA0)
        let bubbleBright: RGB = (0x60, 0x98, 0xCC)
        let lightRay: RGB = (0x20, 0x40, 0x60)
        let caustic: RGB = (0x1C, 0x36, 0x50)
        let dataParticle: RGB = (0x70, 0xB0, 0xFF)
        let dataParticleGreen: RGB = (0x50, 0xF0, 0x90)
        let stateIdle: RGB = (0x22, 0xC5, 0x5E)
        let stateProcessing: RGB = (0x3B, 0x82, 0xF6)
        let stateAwaiting: RGB = (0xF5, 0x9E, 0x0B)
        let stateError: RGB = (0xEF, 0x44, 0x44)
        let white: RGB = (0xFF, 0xFF, 0xFF)
        let black: RGB = (0x00, 0x00, 0x00)
    }

    private var lastRenderTimeMs: Double = 0
    private var directorState: DirectorState?
    private var creatureInstances: [String: CreatureInstance] = [:]
    private var creatureOrder: [String] = []
    private var bubbles: [Bubble] = []
    private var dataParticles: [DataParticle] = []
    private var tetras: [TetraState]?

    func render(dashboardState: DashboardState) -> Data {
        return renderSequence(dashboardState: dashboardState, frameCount: 1).first!
    }

    func renderSequence(dashboardState: DashboardState, frameCount: Int, intervalMs: Int = 100) -> [Data] {
        let state = dashboardState.state
        let usagePct = dashboardState.fiveHourPercent ?? 0
        // Crayfish is drawn only when the OpenClaw Gateway is authenticated.
        // Reachability alone (`gatewayAvailable`) was misleading — an OpenClaw
        // process on localhost with no shared token would still light up the
        // Pixoo creature even though nothing would route through it.
        let hasGateway = dashboardState.gatewayConnected || dashboardState.siblingSessions.contains { $0.agentType == "openclaw" }

        syncCreatures(dashboardState: dashboardState)

        var activeCreatures: [ActiveCreature] = []
        for sessionId in creatureOrder {
            guard let creature = creatureInstances[sessionId] else { continue }
            switch creature.state {
            case .awaiting:
                activeCreatures.append(.init(x: creature.worldX, y: creature.worldY, priority: 0))
            case .processing:
                activeCreatures.append(.init(x: creature.worldX, y: creature.worldY, priority: 1))
            case .idle:
                break
            }
        }

        let hudCount = hudProviderCount(from: dashboardState)
        let crayfishY = hudCount >= 2 ? 0.65 : (hudCount == 1 ? 0.72 : Self.cfDefaultY)
        let crayfishRouting = hasGateway && dashboardState.siblingSessions.contains {
            $0.agentType == "openclaw" && $0.state == "processing"
        }
        if crayfishRouting {
            activeCreatures.append(.init(x: Self.cfDefaultX, y: crayfishY, priority: 2))
        }

        let nowMs = Date().timeIntervalSince1970 * 1000
        let dt = lastRenderTimeMs > 0 ? min(5, (nowMs - lastRenderTimeMs) / 1000) : 1.0
        lastRenderTimeMs = nowMs
        let schoolPos = getSchoolCenter()
        let camera = quantizeCameraPixels(updateDirector(
            dt: dt,
            activeCreatures: activeCreatures,
            crayfishRouting: crayfishRouting,
            crayfishPos: hasGateway ? (Self.cfDefaultX, crayfishY) : nil,
            schoolPos: schoolPos
        ))

        var frames: [Data] = []
        let baseAnimFrame = Self.getAnimFrame(atTimeMs: nowMs)

        for i in 0..<frameCount {
            let animFrame = baseAnimFrame + i
            var world = [UInt8](repeating: 0, count: Self.width * Self.height * 3)
            var output = [UInt8](repeating: 0, count: Self.width * Self.height * 3)

            let palette = zoneBlue()
            for y in 0..<Self.sandTop {
                let color = waterColorAt(palette: palette, surfaceY: Self.surfaceY, y: y)
                for x in 0..<Self.width {
                    setPixel(&world, x, y, color)
                }
            }

            drawTerrain(&world)
            drawLightRays(&world, animFrame: animFrame, surfaceY: Self.surfaceY)
            drawCaustics(&world, animFrame: animFrame, surfaceY: Self.surfaceY)
            drawSeaweed(&world, animFrame: animFrame, surfaceY: Self.surfaceY)

            let anyCreatureProcessing = creatureInstances.values.contains { $0.state == .processing }
            let anyCreatureAwaiting = creatureInstances.values.contains { $0.state == .awaiting }
            let effectiveState: AgentConnectionState = anyCreatureProcessing ? .processing : (anyCreatureAwaiting ? .awaitingOption : state)

            let bubbleDensity = effectiveState == .processing ? 10 : (effectiveState == .idle ? 3 : 5)
            updateBubbles(animFrame: animFrame, surfaceY: Self.surfaceY, density: bubbleDensity)
            for bubble in bubbles {
                blendPixel(&world, Int(round(bubble.x)), Int(round(bubble.y)), bubble.bright ? Self.colors.bubbleBright : Self.colors.bubble, 0.6)
            }

            updateDataParticles(animFrame: animFrame, surfaceY: Self.surfaceY, active: anyCreatureProcessing)
            for particle in dataParticles {
                let fadeAlpha = min(1, particle.life / 10)
                let color = particle.green ? Self.colors.dataParticleGreen : Self.colors.dataParticle
                glowPixel(&world, Int(round(particle.x)), Int(round(particle.y)), color, 0.5 * fadeAlpha)
            }

            let tetraMaxY = hudCount >= 2 ? 46 : (hudCount == 1 ? 52 : (Self.sandTop - 3))
            updateTetras(animFrame: animFrame, surfaceY: Self.surfaceY, maxY: tetraMaxY)
            drawSurface(&world, animFrame: animFrame, surfaceY: Self.surfaceY, palette: palette, state: effectiveState)

            blitWithCamera(world: world, output: &output, camera: camera)

            if let tetras {
                for tetra in tetras {
                    drawTetra(&output, worldX: tetra.x / Double(Self.width), worldY: tetra.y / Double(Self.width), heading: tetra.heading, camera: camera)
                }
            }

            for sessionId in creatureOrder {
                guard let creature = creatureInstances[sessionId] else { continue }
                let sessionToneIndex = creatureOrder.firstIndex(of: creature.sessionId) ?? 0
                let spriteState = creature.state
                let glyph: OfficialDotGlyph = switch creature.creatureType {
                case .cloud: .codex
                case .opencode: .openCode
                case .antigravity: .antigravity
                case .kiro: .kiro
                case .octopus: .claudeCode
                }
                drawOfficialDotGlyph(&output, glyph: glyph, worldX: creature.worldX, worldY: creature.worldY, state: spriteState, animFrame: animFrame + creature.phaseOffset, camera: camera, sessionToneIndex: sessionToneIndex, sizeScale: creature.sizeScale)
            }

            if hasGateway {
                drawOfficialDotGlyph(&output, glyph: .openClaw, worldX: Self.cfDefaultX, worldY: crayfishY, state: crayfishRouting ? .processing : .idle, animFrame: animFrame, camera: camera, sessionToneIndex: 0, sick: dashboardState.gatewayHasError)
            }

            if usagePct >= 90 {
                let flashIntensity = (sin(Double(animFrame) * 0.2) + 1) * 0.08
                for y in 0..<Self.height {
                    for x in 0..<Self.width {
                        glowPixel(&output, x, y, Self.colors.stateError, flashIntensity)
                    }
                }
            }

            let sessionCount = creatureInstances.count
            if sessionCount >= 2 {
                for i in 0..<min(sessionCount, min(6, creatureOrder.count)) {
                    let dotX = 1 + i * 3
                    guard let creature = creatureInstances[creatureOrder[i]] else { continue }
                    let dotColor: RGB = switch creature.creatureType {
                    case .cloud:
                        cloudPalette(for: i).body
                    case .opencode:
                        Self.colors.white
                    case .antigravity:
                        antigravityPalette(for: i).yellow
                    case .kiro:
                        (124, 58, 237)
                    case .octopus:
                        octopusPalette(for: i).body
                    }
                    setPixel(&output, dotX, 1, dotColor)
                    setPixel(&output, dotX + 1, 1, dotColor)
                    setPixel(&output, dotX, 2, dotColor)
                    setPixel(&output, dotX + 1, 2, dotColor)
                }
            }

            drawUsageHUD(&output, dashboardState: dashboardState, animFrame: animFrame)
            frames.append(Data(output))
        }

        return frames
    }

    /// Render the Timebox Mini's native 11×11 Agent Beacon. A stable generated
    /// 9×9 official mark carries identity while the one-pixel perimeter rail
    /// alone carries processing/awaiting/error motion.
    func renderMicro(dashboardState: DashboardState) -> Data {
        let usagePct = dashboardState.fiveHourPercent ?? 0
        let hasGateway = dashboardState.gatewayConnected || dashboardState.siblingSessions.contains { $0.agentType == "openclaw" }
        let gatewayHasError = dashboardState.gatewayHasError

        syncCreatures(dashboardState: dashboardState)

        func priority(_ c: CreatureInstance) -> Int {
            switch c.state { case .awaiting: return 0; case .processing: return 1; case .idle: return 2 }
        }
        let dominant = creatureOrder.compactMap { creatureInstances[$0] }.min { priority($0) < priority($1) }

        // When the only creature is the gateway crayfish, its routing state still
        // drives the background (no dominant creature instance exists for OpenClaw).
        let routing = dashboardState.siblingSessions.contains { $0.agentType == "openclaw" && $0.state == "processing" }

        let aggregate: MicroAggregate
        if gatewayHasError || usagePct >= 90 {
            aggregate = .error
        } else if dominant?.state == .awaiting {
            aggregate = .awaiting
        } else if dominant?.state == .processing || (dominant == nil && routing) {
            aggregate = .processing
        } else {
            aggregate = .idle
        }

        let animFrame = Self.getAnimFrame(atTimeMs: Date().timeIntervalSince1970 * 1000)

        let n = MicroGlyphs.size
        var out = [UInt8](repeating: 0, count: n * n * 3)
        var creature: MicroCreature?
        if let dominant {
            creature =
                dominant.agentType == "antigravity" ? .antigravity
                    : dominant.creatureType == .kiro ? .kiro
                    : dominant.creatureType == .cloud ? .codex
                    : (dominant.creatureType == .opencode ? .opencode : .octopus)
        } else if hasGateway {
            creature = .crayfish
        }
        MicroGlyphs.paintBeacon(&out, creature: creature, aggregate: aggregate, animFrame: animFrame)

        return Data(out)
    }

    /// Native 32×32 compact terrarium for iDotMatrix.
    ///
    /// Rendering the completed 64×64 scene and then halving it made a nominal
    /// 9–12px official mark land at only 5–6 physical LEDs. This path composes
    /// directly at panel resolution: simplified water/terrain, at most three
    /// official marks, and screen-space state effects. No resampling occurs
    /// after the mark is painted, so negative-space features remain readable.
    func renderCompact32(dashboardState: DashboardState) -> Data {
        syncCreatures(dashboardState: dashboardState)
        let n = 32
        var out = [UInt8](repeating: 0, count: n * n * 3)
        let animFrame = Self.getAnimFrame(atTimeMs: Date().timeIntervalSince1970 * 1000)

        func set(_ x: Int, _ y: Int, _ color: RGB) {
            guard x >= 0, x < n, y >= 0, y < n else { return }
            let i = (y * n + x) * 3
            out[i] = color.0; out[i + 1] = color.1; out[i + 2] = color.2
        }
        func blend(_ x: Int, _ y: Int, _ color: RGB, _ alpha: Double) {
            guard x >= 0, x < n, y >= 0, y < n, alpha > 0 else { return }
            let i = (y * n + x) * 3
            let a = min(1, alpha), inv = 1 - a
            out[i] = UInt8(min(255, Int(round(Double(out[i]) * inv + Double(color.0) * a))))
            out[i + 1] = UInt8(min(255, Int(round(Double(out[i + 1]) * inv + Double(color.1) * a))))
            out[i + 2] = UInt8(min(255, Int(round(Double(out[i + 2]) * inv + Double(color.2) * a))))
        }

        // iDotMatrix is an identity stage, not a miniature aquarium. A deep
        // blue-black field and one state horizon leave the saturated marks as
        // the first thing the diffuser resolves; the old sand/terrain bands
        // competed with the silhouettes on a 32px panel.
        for y in 0..<28 {
            let t = Double(y) / 27
            let color: RGB = (
                UInt8(2 + Int(5 * t)),
                UInt8(7 + Int(10 * t)),
                UInt8(18 + Int(18 * t))
            )
            for x in 0..<n { set(x, y, color) }
        }

        let surface: RGB = dashboardState.state.isAwaiting
            ? (255, 190, 45)
            : dashboardState.state == .processing ? (50, 225, 255) : (38, 210, 145)
        for x in 0..<n where (x + animFrame / 4).isMultiple(of: dashboardState.state == .processing ? 3 : 6) {
            set(x, 2, surface)
        }

        func glyph(for kind: CreatureKind) -> OfficialDotGlyph {
            switch kind {
            case .octopus: return .claudeCode
            case .cloud: return .codex
            case .opencode: return .openCode
            case .antigravity: return .antigravity
            case .kiro: return .kiro
            }
        }
        func priority(_ state: CreatureState) -> Int {
            switch state { case .awaiting: return 0; case .processing: return 1; case .idle: return 2 }
        }

        var marks = creatureOrder.compactMap { id -> CompactMark? in
            guard let c = creatureInstances[id] else { return nil }
            let tone = max(0, creatureOrder.firstIndex(of: id) ?? 0)
            return CompactMark(glyph: glyph(for: c.creatureType), state: c.state, toneIndex: tone)
        }
        let hasGateway = dashboardState.gatewayConnected || dashboardState.siblingSessions.contains { $0.agentType == "openclaw" }
        if hasGateway {
            let routing = dashboardState.siblingSessions.contains { $0.agentType == "openclaw" && $0.state == "processing" }
            marks.append(CompactMark(glyph: .openClaw, state: routing ? .processing : .idle, toneIndex: 0))
        }
        marks.sort { priority($0.state) < priority($1.state) }
        marks = Array(marks.prefix(3))

        let slots: [(x: Int, y: Int, size: Int)]
        switch marks.count {
        case 1: slots = [(16, 14, 18)]
        case 2: slots = [(9, 14, 13), (23, 14, 13)]
        default: slots = [(6, 14, 10), (16, 14, 10), (26, 14, 10)]
        }

        func baseColor(_ mark: CompactMark, _ sourceX: Int) -> RGB {
            switch mark.glyph {
            case .claudeCode: return (255, 112, 76)
            case .codex: return (126, 116, 255)
            case .openCode: return (255, 246, 248)
            case .openClaw: return (255, 67, 84)
            case .kiro: return (124, 58, 237)
            case .antigravity:
                let bands: [RGB] = [
                    (92, 214, 77), (245, 203, 36), (255, 132, 16),
                    (255, 82, 65), (183, 92, 182), (102, 111, 225), (36, 126, 255),
                ]
                return bands[min(bands.count - 1, sourceX * bands.count / OfficialDotGlyphs.size)]
            }
        }

        for (index, mark) in marks.enumerated() {
            let slot = slots[index]
            guard let mask = OfficialDotGlyphs.masks[mark.glyph] else { continue }
            let bob = mark.state == .processing ? Int(round(sin(Double(animFrame + index * 5) * 0.28))) : 0
            let x0 = slot.x - slot.size / 2
            let y0 = slot.y - slot.size / 2 + bob
            for dy in 0..<slot.size {
                let sy = min(OfficialDotGlyphs.size - 1, dy * OfficialDotGlyphs.size / slot.size)
                for dx in 0..<slot.size {
                    let sx = min(OfficialDotGlyphs.size - 1, dx * OfficialDotGlyphs.size / slot.size)
                    let alpha = Double(mask[sy * OfficialDotGlyphs.size + sx]) / 255
                    guard alpha > 0.04 else { continue }
                    let color = baseColor(mark, sx)
                    // One-pixel shadow separates adjacent official-mask cells;
                    // a restrained halo lets the physical diffuser reconnect
                    // the silhouette without washing out its negative space.
                    blend(x0 + dx + 1, y0 + dy + 1, (0, 0, 0), alpha * 0.55)
                    if alpha > 0.42 {
                        blend(x0 + dx - 1, y0 + dy, color, 0.055)
                        blend(x0 + dx + 1, y0 + dy, color, 0.055)
                    }
                    let coverage = min(1, pow(alpha, 0.72) * 1.12)
                    let light = 1.08 - Double(dy) / Double(max(1, slot.size - 1)) * 0.12
                    let lit: RGB = (
                        UInt8(min(255, Int(round(Double(color.0) * light)))),
                        UInt8(min(255, Int(round(Double(color.1) * light)))),
                        UInt8(min(255, Int(round(Double(color.2) * light))))
                    )
                    blend(x0 + dx, y0 + dy, lit, coverage)
                }
            }
            if mark.glyph == .openClaw {
                set(x0 + Int(round(9.05 / 24 * Double(slot.size))), y0 + Int(round(7.63 / 24 * Double(slot.size))), Self.colors.crayfishEye)
                set(x0 + Int(round(15.38 / 24 * Double(slot.size))), y0 + Int(round(7.63 / 24 * Double(slot.size))), Self.colors.crayfishEye)
            }
            if mark.state == .processing {
                for spark in 0..<3 {
                    let angle = Double(animFrame) * 0.24 + Double(spark) * Double.pi * 2 / 3
                    let radius = Double(slot.size) / 2 + 1
                    set(Int(round(Double(slot.x) + cos(angle) * radius)), Int(round(Double(slot.y + bob) + sin(angle) * radius)), (110, 235, 255))
                }
            } else if mark.state == .awaiting {
                set(min(31, x0 + slot.size), max(2, y0), (255, 190, 45))
                set(min(31, x0 + slot.size), max(2, y0 + 1), (255, 190, 45))
            }
        }

        if marks.isEmpty {
            for (x, y) in [(14, 12), (15, 11), (16, 12), (17, 11), (18, 12), (15, 14), (16, 15), (17, 14)] {
                set(x, y, (76, 206, 220))
            }
        }

        // One-pixel telemetry rails — Claude 5h/7d then Codex primary/secondary —
        // PRESENT ONES ONLY. On a 32-row panel each rail is 3% of the whole
        // display, so reserving a row for a provider that reports nothing (a
        // Claude-only user, a free-tier Codex account, this daemon with no Claude
        // quota path) spent that height on a dead black stripe. Building the list
        // first and anchoring it to the BOTTOM edge keeps the rails where the eye
        // expects them while every unclaimed row falls back to the tank. The
        // two-pixel source key stays lit while the 29-pixel track encodes used
        // percentage. Timebox intentionally omits these rails; at 11px they would
        // destroy the identity badge. Mirrors renderCompact32Frame in
        // bridge/src/pixoo/pixoo-renderer.ts.
        let codexPrimary = dashboardState.codexRateLimits?.primary?.stale == true
            ? nil : dashboardState.codexRateLimits?.primary?.usedPercent
        let codexSecondary = dashboardState.codexRateLimits?.secondary?.stale == true
            ? nil : dashboardState.codexRateLimits?.secondary?.usedPercent
        var telemetry: [(Double, RGB)] = []
        for candidate: (Double?, RGB) in [
            (dashboardState.fiveHourPercent, (42, 220, 154)),
            (dashboardState.sevenDayPercent, (54, 154, 255)),
            (codexPrimary, (185, 86, 255)),
            (codexSecondary, (104, 116, 255)),
        ] {
            if let raw = candidate.0 { telemetry.append((raw, candidate.1)) }
        }
        let firstRailY = 32 - telemetry.count
        for (row, item) in telemetry.enumerated() {
            let y = firstRailY + row
            for x in 0..<n { set(x, y, (5, 8, 14)) }
            let pct = max(0, min(100, item.0))
            let color: RGB = pct >= 90 ? (255, 58, 72) : pct >= 70 ? (255, 183, 38) : item.1
            set(0, y, item.1); set(1, y, item.1)
            let width = Int(round(pct / 100 * 29))
            if width > 0 { for x in 3..<(3 + width) { set(x, y, color) } }
        }

        return Data(out)
    }

    /// Static black frame with a centered grey "OFFLINE" label. Mirrors
    /// `renderDisconnectedFrame()` in bridge/src/pixoo/pixoo-renderer.ts so
    /// Pixoo stops displaying stale creature frames the moment the Swift
    /// daemon goes away.
    func renderDisconnectedFrame() -> Data {
        var buf = [UInt8](repeating: 0, count: Self.width * Self.height * 3)
        let text = "OFFLINE"
        // Glyphs are 3px wide + 1px gap; drawText is right-aligned, so compute
        // a rightX that centers the 27px text on the 64px canvas (cols 18..44).
        let textWidth = text.count * 4 - 1
        let rightX = (Self.width + textWidth) / 2
        drawText(&buf, text: text, rightX: rightX, y: 29, color: (0x55, 0x55, 0x55))
        return Data(buf)
    }

    private func syncCreatures(dashboardState: DashboardState) {
        // Codex sessions get folded by projectName before slot assignment.
        // Each Claude Code rescue/stop-gate spawns a fresh codex thread, so
        // without folding the same workspace lights up 4-5 cloud sprites at
        // once. Octopus / opencode are NOT folded — multi-instance is a
        // deliberate user pattern there.
        var aliveCoding: [(id: String, agentType: String, state: CreatureState)] = []
        var codexFolded: [String: (id: String, agentType: String, state: CreatureState, startedAt: String?)] = [:]
        var codexFoldedOrder: [String] = []

        func codexKey(projectName: String?, id: String) -> String {
            if let p = projectName, !p.isEmpty { return p }
            return "__id__\(id)"
        }
        func statePriority(_ s: CreatureState) -> Int {
            // Mirror TerrariumState fold ordering: processing > awaiting > idle.
            switch s {
            case .processing: return 3
            case .awaiting: return 2
            case .idle: return 1
            }
        }

        for session in dashboardState.siblingSessions where session.alive {
            guard let agentType = session.agentType, isCreatureAgent(agentType) else { continue }
            let mapped = mapSessionState(session.state)
            if agentType == "codex-cli" || agentType == "codex-app" {
                let key = "\(agentType):\(codexKey(projectName: session.projectName, id: session.id))"
                if let existing = codexFolded[key] {
                    let pickStart = (session.startedAt ?? "") > (existing.startedAt ?? "")
                    let mergedState = statePriority(mapped) > statePriority(existing.state) ? mapped : existing.state
                    codexFolded[key] = (
                        id: pickStart ? session.id : existing.id,
                        agentType: agentType,
                        state: mergedState,
                        startedAt: pickStart ? session.startedAt : existing.startedAt
                    )
                } else {
                    codexFoldedOrder.append(key)
                    codexFolded[key] = (id: session.id, agentType: agentType, state: mapped, startedAt: session.startedAt)
                }
                continue
            }
            aliveCoding.append((id: session.id, agentType: agentType, state: mapped))
        }
        for key in codexFoldedOrder {
            guard let entry = codexFolded[key] else { continue }
            aliveCoding.append((id: entry.id, agentType: entry.agentType, state: entry.state))
        }

        // Synthesize a creature from the dashboard state only BEFORE the first
        // sessions_list arrives. Once the list is known, an empty list means an
        // empty tank — firing this fallback then leaves a stale Claude octopus
        // blinking whenever only non-creature agents (e.g. OpenClaw) are live.
        let primaryAgentType = dashboardState.agentType ?? "claude-code"
        if
            aliveCoding.isEmpty,
            !dashboardState.sessionsListReceived,
            isCreatureAgent(primaryAgentType),
            dashboardState.state != .disconnected
        {
            aliveCoding.append((id: "_primary", agentType: primaryAgentType, state: simplifiedState(dashboardState.state)))
        }

        let aliveIds = Set(aliveCoding.map(\.id))
        creatureInstances = creatureInstances.filter { aliveIds.contains($0.key) }
        creatureOrder.removeAll { !aliveIds.contains($0) }

        let typeCounts = Dictionary(aliveCoding.map { (creatureType(for: $0.agentType), 1) }, uniquingKeysWith: +)
        let octopusSlots = pixooSlots(for: .octopus, count: typeCounts[.octopus] ?? 0)
        let cloudSlots = pixooSlots(for: .cloud, count: typeCounts[.cloud] ?? 0)
        let opencodeSlots = pixooSlots(for: .opencode, count: typeCounts[.opencode] ?? 0)
        let antigravitySlots = pixooSlots(for: .antigravity, count: typeCounts[.antigravity] ?? 0)
        let kiroSlots = pixooSlots(for: .kiro, count: typeCounts[.kiro] ?? 0)
        var typeIndices: [CreatureKind: Int] = [.octopus: 0, .cloud: 0, .opencode: 0, .antigravity: 0, .kiro: 0]

        let hudCount = hudProviderCount(from: dashboardState)
        for (index, session) in aliveCoding.enumerated() {
            let kind = creatureType(for: session.agentType)
            let slotIndex = typeIndices[kind, default: 0]
            typeIndices[kind, default: 0] = slotIndex + 1
            let slot = pixooSlot(for: kind, index: slotIndex, octopusSlots: octopusSlots, cloudSlots: cloudSlots, opencodeSlots: opencodeSlots, antigravitySlots: antigravitySlots, kiroSlots: kiroSlots)
            let worldX = Double(slot.x)
            let worldY = stateY(session.state, kind: kind, baseY: Double(slot.y), hudProviderCount: hudCount)

            if var existing = creatureInstances[session.id] {
                existing.state = session.state
                existing.agentType = session.agentType
                existing.creatureType = kind
                existing.worldX = worldX
                existing.worldY = worldY
                existing.sizeScale = Double(slot.scale)
                creatureInstances[session.id] = existing
            } else {
                creatureInstances[session.id] = CreatureInstance(
                    sessionId: session.id,
                    agentType: session.agentType,
                    creatureType: kind,
                    state: session.state,
                    worldX: worldX,
                    worldY: worldY,
                    phaseOffset: index * 5,
                    sizeScale: Double(slot.scale)
                )
                creatureOrder.append(session.id)
            }
        }

        for session in aliveCoding where !creatureOrder.contains(session.id) {
            creatureOrder.append(session.id)
        }

        if
            let primaryIndex = aliveCoding.firstIndex(where: { $0.id == "_primary" }),
            var primary = creatureInstances[aliveCoding[primaryIndex].id]
        {
            let preciseState = simplifiedState(dashboardState.state)
            primary.state = preciseState
            let primaryKind = creatureType(for: primary.agentType)
            let slotIndex = max(0, (typeIndices[primaryKind] ?? 1) - 1)
            let baseSlot = pixooSlot(
                for: primaryKind,
                index: slotIndex,
                octopusSlots: octopusSlots,
                cloudSlots: cloudSlots,
                opencodeSlots: opencodeSlots,
                antigravitySlots: antigravitySlots,
                kiroSlots: kiroSlots
            )
            primary.worldY = stateY(preciseState, kind: primary.creatureType, baseY: Double(baseSlot.y), hudProviderCount: hudCount)
            creatureInstances[aliveCoding[primaryIndex].id] = primary
        }
    }

    private func pixooSlots(for kind: CreatureKind, count: Int) -> [CreatureSlot] {
        switch kind {
        case .octopus:
            return CreatureLayout.layoutOctopuses(count: count)
        case .cloud:
            return CreatureLayout.layoutCloudCreatures(count: count)
        case .opencode:
            return CreatureLayout.layoutOpenCodeCreatures(count: count)
        case .antigravity:
            return CreatureLayout.layoutAntigravityCreatures(count: count)
        case .kiro:
            // Reuse the generated upper-right floating band until the shared
            // layout SSOT replaces the three hand-maintained mirrors.
            return CreatureLayout.layoutAntigravityCreatures(count: count)
        }
    }

    private func pixooSlot(
        for kind: CreatureKind,
        index: Int,
        octopusSlots: [CreatureSlot],
        cloudSlots: [CreatureSlot],
        opencodeSlots: [CreatureSlot],
        antigravitySlots: [CreatureSlot],
        kiroSlots: [CreatureSlot]
    ) -> CreatureSlot {
        let slots: [CreatureSlot] = switch kind {
        case .octopus: octopusSlots
        case .cloud: cloudSlots
        case .opencode: opencodeSlots
        case .antigravity: antigravitySlots
        case .kiro: kiroSlots
        }
        guard !slots.isEmpty else { return CreatureSlot(x: 0.38, y: 0.42, scale: 1.0) }
        return slots[min(index, slots.count - 1)]
    }

    private func updateDirector(
        dt: Double,
        activeCreatures: [ActiveCreature],
        crayfishRouting: Bool,
        crayfishPos: (x: Double, y: Double)?,
        schoolPos: (x: Double, y: Double)
    ) -> Camera {
        if directorState == nil {
            directorState = DirectorState(
                mode: .idleCycle,
                camera: Self.wideCamera,
                idleIndex: 0,
                currentZone: Self.idleCycle[0],
                targetZone: Self.idleCycle[0],
                zoneTimer: 0,
                transitionT: 0,
                transitioning: false,
                activeIndex: 0,
                activeDwell: 0
            )
        }
        guard var state = directorState else { return Self.wideCamera }
        let sorted = activeCreatures.enumerated()
            .sorted { lhs, rhs in
                if lhs.element.priority != rhs.element.priority {
                    return lhs.element.priority < rhs.element.priority
                }
                return lhs.offset < rhs.offset
            }
            .map(\.element)

        let previousMode = state.mode
        if sorted.isEmpty {
            state.mode = .idleCycle
        } else if sorted.count == 1 {
            state.mode = .tracking
        } else {
            state.mode = .cyclingActive
        }

        if previousMode != state.mode {
            switch state.mode {
            case .idleCycle:
                state.idleIndex = 0
                state.currentZone = Self.idleCycle[0]
                state.targetZone = Self.idleCycle[0]
                state.zoneTimer = 0
                state.transitionT = 0
                state.transitioning = false
            case .tracking:
                break
            case .cyclingActive:
                state.activeIndex = 0
                state.activeDwell = 0
            }
        }

        if state.mode == .cyclingActive, let first = sorted.first, first.priority == 0, state.activeIndex != 0 {
            state.activeIndex = 0
            state.activeDwell = 0
        }

        switch state.mode {
        case .idleCycle:
            if state.transitioning {
                state.transitionT += dt / Self.transitionSec
                if state.transitionT >= 1 {
                    state.transitionT = 1
                    state.transitioning = false
                    state.currentZone = state.targetZone
                    state.zoneTimer = 0
                }
                let eased = easeInOut(state.transitionT)
                let fromCam = resolveIdleZoneCamera(state.currentZone, schoolPos: schoolPos)
                let toCam = resolveIdleZoneCamera(state.targetZone, schoolPos: schoolPos)
                state.camera = lerpCamera(from: fromCam, to: toCam, t: eased)
            } else {
                state.zoneTimer += dt
                let zoneCam = resolveIdleZoneCamera(state.currentZone, schoolPos: schoolPos)
                state.camera = lerpCamera(from: state.camera, to: zoneCam, t: min(1, dt * 2))
                if state.zoneTimer >= state.currentZone.duration {
                    state.idleIndex = (state.idleIndex + 1) % Self.idleCycle.count
                    state.targetZone = Self.idleCycle[state.idleIndex]
                    state.transitioning = true
                    state.transitionT = 0
                }
            }
        case .tracking:
            if let creature = sorted.first {
                let yOff = creature.priority == 0 ? -0.05 : 0.0
                let target = Camera(cx: creature.x, cy: creature.y + yOff, zoom: 3.2)
                state.camera = lerpCamera(from: state.camera, to: target, t: min(1, dt * 0.8))
            }
        case .cyclingActive:
            guard !sorted.isEmpty else { break }
            state.activeDwell += dt
            if state.activeDwell >= Self.activeDwellSec {
                state.activeIndex = (state.activeIndex + 1) % sorted.count
                state.activeDwell = 0
            }
            let creature = sorted[state.activeIndex % sorted.count]
            let yOff = creature.priority == 0 ? -0.05 : 0.0
            let target = Camera(cx: creature.x, cy: creature.y + yOff, zoom: 3.2)
            state.camera = lerpCamera(from: state.camera, to: target, t: min(1, dt * 0.8))
        }

        if crayfishRouting, sorted.isEmpty, crayfishPos != nil {
            let target = Camera(cx: 0.72, cy: 0.55, zoom: 3.2)
            state.camera = lerpCamera(from: state.camera, to: target, t: min(1, dt * 0.8))
        }

        state.camera = clampCamera(state.camera)
        directorState = state
        return state.camera
    }

    private func resolveIdleZoneCamera(_ zone: CameraZone, schoolPos: (x: Double, y: Double)) -> Camera {
        if zone.name == "school" {
            return Camera(cx: schoolPos.x, cy: schoolPos.y, zoom: zone.zoom)
        }
        return Camera(cx: zone.cx, cy: zone.cy, zoom: zone.zoom)
    }

    private func updateTetras(animFrame: Int, surfaceY: Int, maxY: Int) {
        if tetras == nil {
            tetras = (0..<14).map { i in
                TetraState(
                    x: 12 + Double.random(in: 0...40),
                    y: 20 + Double.random(in: 0...25),
                    heading: Bool.random() ? 1 : -1,
                    speed: 0.08 + Double.random(in: 0...0.12),
                    phase: Double.random(in: 0...(Double.pi * 2)),
                    schoolId: i < 7 ? 0 : 1
                )
            }
        }
        guard var tetras else { return }
        let sc0X = 24 + sin(Double(animFrame) * 0.02) * 16
        let sc0Y = max(Double(surfaceY + 8), 22) + cos(Double(animFrame) * 0.015) * 8
        let sc1X = 40 + sin(Double(animFrame) * 0.0175 + 2) * 16
        let sc1Y = max(Double(surfaceY + 8), 24) + cos(Double(animFrame) * 0.0225 + 1) * 8
        let centers = [(x: sc0X, y: sc0Y), (x: sc1X, y: sc1Y)]

        for idx in tetras.indices {
            let school = centers[tetras[idx].schoolId]
            let dx = school.x - tetras[idx].x
            let dy = school.y - tetras[idx].y
            tetras[idx].x += dx * 0.025 + tetras[idx].heading * (tetras[idx].speed * 0.5)
            tetras[idx].y += dy * 0.025 + sin(Double(animFrame) * 0.05 + tetras[idx].phase) * 0.2
            let minY = Double(surfaceY + 3)
            if tetras[idx].x < 3 || tetras[idx].x > 61 {
                tetras[idx].heading *= -1
                tetras[idx].x = max(3, min(61, tetras[idx].x))
            }
            if tetras[idx].y < minY { tetras[idx].y = minY }
            if tetras[idx].y > Double(maxY) { tetras[idx].y = Double(maxY) }
        }
        self.tetras = tetras
    }

    private func getSchoolCenter() -> (x: Double, y: Double) {
        guard let tetras, !tetras.isEmpty else { return (0.5, 0.4) }
        let sumX = tetras.reduce(0.0) { $0 + $1.x }
        let sumY = tetras.reduce(0.0) { $0 + $1.y }
        return (sumX / Double(tetras.count) / Double(Self.width), sumY / Double(tetras.count) / Double(Self.width))
    }

    private func updateBubbles(animFrame: Int, surfaceY: Int, density: Int) {
        let maxBubbles = density
        while bubbles.count < maxBubbles {
            bubbles.append(Bubble(
                x: 4 + Double.random(in: 0...56),
                y: Double(Self.sandTop - 1) - Double.random(in: 0...4),
                speed: 0.3 + Double.random(in: 0...0.4),
                wobblePhase: Double.random(in: 0...(Double.pi * 2)),
                bright: Bool.random()
            ))
        }

        for idx in bubbles.indices {
            bubbles[idx].y -= bubbles[idx].speed * 0.5
            bubbles[idx].x += sin(Double(animFrame) * 0.075 + bubbles[idx].wobblePhase) * 0.15
        }
        bubbles = bubbles.filter { $0.y > Double(surfaceY + 1) }
        while bubbles.count > maxBubbles + 4 {
            bubbles.removeFirst()
        }
    }

    private func updateDataParticles(animFrame: Int, surfaceY: Int, active: Bool) {
        if active && animFrame % 6 == 0 {
            dataParticles.append(DataParticle(
                x: 10 + Double.random(in: 0...44),
                y: Double(surfaceY + 2) + Double.random(in: 0...3),
                vy: 0.2 + Double.random(in: 0...0.15),
                life: 60 + Double.random(in: 0...40),
                green: Double.random(in: 0...1) > 0.6
            ))
        }
        for idx in dataParticles.indices {
            dataParticles[idx].y += dataParticles[idx].vy
            dataParticles[idx].x += sin(Double(animFrame) * 0.1 + dataParticles[idx].x * 0.3) * 0.2
            dataParticles[idx].life -= 1
        }
        dataParticles = dataParticles.filter {
            $0.life > 0 && $0.y < Double(Self.sandTop - 1) && $0.y > Double(surfaceY)
        }
        if dataParticles.count > 16 {
            dataParticles.removeFirst(dataParticles.count - 16)
        }
    }

    private func drawTerrain(_ buf: inout [UInt8]) {
        for y in Self.sandTop...Self.sandBot {
            for x in 0..<Self.width {
                let noise = (x * 7 + y * 13) % 11
                let color = noise < 3 ? Self.colors.sandLight : (noise < 7 ? Self.colors.sand : Self.colors.sandDark)
                setPixel(&buf, x, y, color)
            }
        }
        for gx in [8, 15, 22, 29, 37, 44, 51, 57] {
            setPixel(&buf, gx, Self.sandTop, Self.colors.gravel)
        }
        for y in Self.substrateTop..<Self.height {
            for x in 0..<Self.width {
                let noise = (x * 11 + y * 7) % 13
                setPixel(&buf, x, y, noise < 4 ? Self.colors.rockLight : Self.colors.rock)
            }
        }
        let rocks = [(12, Self.sandBot, 4, 2), (30, Self.sandBot + 1, 3, 2), (48, Self.sandBot, 5, 3)]
        for (x, y, w, h) in rocks {
            for dy in 0..<h {
                for dx in 0..<w {
                    setPixel(&buf, x + dx, y + dy, dx == 0 || dx == w - 1 || dy == 0 ? Self.colors.rockLight : Self.colors.rock)
                }
            }
        }
    }

    private func drawSeaweed(_ buf: inout [UInt8], animFrame: Int, surfaceY: Int) {
        let positions = [(2,13,0.0),(5,9,1.2),(8,6,2.5),(55,12,0.8),(58,8,1.9),(61,7,3.1)]
        for (x, h, phase) in positions {
            let maxHeight = min(h, Self.sandTop - surfaceY - 2)
            guard maxHeight > 0 else { continue }
            for i in 0..<maxHeight {
                let swayAmount = (Double(i) / Double(maxHeight)) * 1.5
                let sway = Int(round(sin(Double(animFrame) * 0.06 + phase + Double(i) * 0.4) * swayAmount))
                let color = i % 3 == 0 ? Self.colors.seaweedLight : (i % 2 == 0 ? Self.colors.seaweed : Self.colors.seaweedDark)
                let px = x + sway
                let py = Self.sandTop - 1 - i
                if py > surfaceY {
                    setPixel(&buf, px, py, color)
                }
            }
        }
    }

    private func drawLightRays(_ buf: inout [UInt8], animFrame: Int, surfaceY: Int) {
        let rays = [
            (15 + sin(Double(animFrame) * 0.02) * 5, 0.15),
            (35 + sin(Double(animFrame) * 0.015 + 1) * 6, -0.1),
            (50 + sin(Double(animFrame) * 0.025 + 2) * 4, 0.2),
        ]
        for (baseX, angle) in rays {
            let depth = Self.sandTop - surfaceY
            guard depth > 0 else { continue }
            for d in 2..<(depth - 2) {
                let y = surfaceY + d
                let x = Int(round(baseX + Double(d) * angle))
                let fadeIn = min(1.0, Double(d) / 6.0)
                let fadeOut = max(0.0, 1.0 - Double(d) / Double(depth))
                let alpha = fadeIn * fadeOut * 0.2
                if alpha > 0.02 {
                    glowPixel(&buf, x, y, Self.colors.lightRay, alpha)
                    glowPixel(&buf, x - 1, y, Self.colors.lightRay, alpha * 0.4)
                    glowPixel(&buf, x + 1, y, Self.colors.lightRay, alpha * 0.4)
                }
            }
        }
    }

    private func drawCaustics(_ buf: inout [UInt8], animFrame: Int, surfaceY: Int) {
        guard surfaceY < Self.sandTop - 3 else { return }
        for x in 1..<(Self.width - 1) {
            let pattern = sin(Double(x) * 0.5 + Double(animFrame) * 0.05) * cos(Double(x) * 0.3 - Double(animFrame) * 0.035)
            if pattern > 0.5 {
                let intensity = (pattern - 0.5) * 0.4
                glowPixel(&buf, x, Self.sandTop, Self.colors.caustic, intensity)
                glowPixel(&buf, x, Self.sandTop + 1, Self.colors.caustic, intensity * 0.5)
            }
        }
    }

    private func drawSurface(_ buf: inout [UInt8], animFrame: Int, surfaceY: Int, palette: WaterPalette, state: AgentConnectionState) {
        let shimmerColor: RGB
        switch state {
        case .processing:
            shimmerColor = Self.colors.stateProcessing
        case .awaitingPermission, .awaitingOption, .awaitingDiff:
            shimmerColor = Self.colors.stateAwaiting
        default:
            shimmerColor = Self.colors.stateIdle
        }
        let waveSpeed = state == .processing ? 0.125 : 0.05
        let waveAmp = state == .processing ? 1.5 : 0.8
        let shimmerIntensity: Double
        switch state {
        case .processing:
            shimmerIntensity = 0.35
        case .awaitingPermission, .awaitingOption, .awaitingDiff:
            shimmerIntensity = 0.25 + sin(Double(animFrame) * 0.15) * 0.15
        default:
            shimmerIntensity = 0.15
        }
        for x in 0..<Self.width {
            let wave = sin(Double(x) * 0.25 + Double(animFrame) * waveSpeed) * waveAmp
            let wy = surfaceY + Int(round(wave))
            blendPixel(&buf, x, wy, palette.surface, 0.8)
            if wave > waveAmp * 0.3 {
                glowPixel(&buf, x, wy, shimmerColor, shimmerIntensity)
            }
            if wave > waveAmp * 0.6 && ((x + animFrame) % 5 == 0) {
                glowPixel(&buf, x, wy, Self.colors.white, 0.15)
            }
        }
    }

    private func drawUsageHUD(_ buf: inout [UInt8], dashboardState: DashboardState, animFrame: Int) {
        struct UsageWindow {
            let percent: Double
            let resetsAt: String?
        }
        struct ProviderRow {
            let glyph: OfficialDotGlyph
            let brand: RGB
            let primary: UsageWindow?
            let secondary: UsageWindow?
            let subscriptionUntil: String?
        }
        func freshCodexWindow(_ window: CodexRateLimitWindow?) -> UsageWindow? {
            guard window?.stale != true, let percent = window?.usedPercent else { return nil }
            return UsageWindow(percent: percent, resetsAt: window?.resetsAt)
        }

        var providers: [ProviderRow] = []
        if dashboardState.usageStale != true, let fiveHour = dashboardState.fiveHourPercent {
            providers.append(ProviderRow(
                glyph: .claudeCode, brand: (255, 112, 76),
                primary: UsageWindow(percent: fiveHour, resetsAt: dashboardState.fiveHourResetsAt),
                secondary: dashboardState.sevenDayPercent.map {
                    UsageWindow(percent: $0, resetsAt: dashboardState.sevenDayResetsAt)
                },
                subscriptionUntil: nil
            ))
        }
        let codexPrimary = freshCodexWindow(dashboardState.codexRateLimits?.primary)
        let codexSecondary = freshCodexWindow(dashboardState.codexRateLimits?.secondary)
        if codexPrimary != nil || codexSecondary != nil {
            providers.append(ProviderRow(
                glyph: .codex, brand: (126, 116, 255),
                primary: codexPrimary,
                secondary: codexSecondary,
                subscriptionUntil: dashboardState.codexSubscriptionActiveUntil
            ))
        }
        guard !providers.isEmpty else { return }

        let timeColor: RGB = (0x60, 0x70, 0x80)
        let firstY = providers.count > 1 ? 50 : 57

        func drawCreatureMarker(_ provider: ProviderRow, rowY: Int) {
            guard let mask = OfficialDotGlyphs.masks[provider.glyph] else { return }
            let sourceSize = OfficialDotGlyphs.size
            // Preserve the canonical canvas proportions. Claude's occupied
            // bounds are wider than tall; cropping and stretching them to 7x7
            // changes the robot silhouette. The 9px slot leaves one LED on
            // both sides of the seven-pixel mark.
            let markerSize = 7
            let markerX = 1
            for dy in 0..<7 {
                let sy = min(sourceSize - 1, Int(floor((Double(dy) + 0.5) * Double(sourceSize) / Double(markerSize))))
                for dx in 0..<markerSize {
                    let sx = min(sourceSize - 1, Int(floor((Double(dx) + 0.5) * Double(sourceSize) / Double(markerSize))))
                    let alpha = mask[sy * sourceSize + sx]
                    guard alpha > 16 else { continue }
                    let intensity = alpha >= 96 ? 1.0 : 0.56
                    setPixel(&buf, markerX + dx, rowY + dy, lerpColor(Self.colors.black, provider.brand, intensity))
                }
            }
        }

        func fittedReset(_ resetsAt: String?, percentText: String, zoneWidth: Int) -> String {
            let detailed = formatResetDetailed(resetsAt)
            guard !detailed.isEmpty else { return "" }
            let maxCharacters = zoneWidth / 4
            if percentText.count + detailed.count <= maxCharacters { return detailed }
            var digits = ""
            for character in detailed {
                if character.isNumber { digits.append(character) }
                else if "dhm".contains(character), !digits.isEmpty { return digits + String(character) }
                else { break }
            }
            return String(detailed.prefix(max(0, maxCharacters - percentText.count)))
        }

        func subscriptionDate(_ until: String?) -> String {
            guard let value = until?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
                return ""
            }
            let datePart = String(value.prefix(10))
            let parts = datePart.split(separator: "-")
            if parts.count == 3, parts[0].count == 4,
               let month = Int(parts[1]), let day = Int(parts[2]),
               (1...12).contains(month), (1...31).contains(day) {
                return "\(month)/\(day)"
            }
            let compact = value.hasPrefix("~") ? String(value.dropFirst()) : value
            let compactParts = compact.split(separator: "/")
            if compactParts.count == 2,
               let month = Int(compactParts[0]), let day = Int(compactParts[1]),
               (1...12).contains(month), (1...31).contains(day) {
                return "\(month)/\(day)"
            }
            return ""
        }

        func drawCenteredLabel(_ text: String, leftX: Int, rightX: Int, rowY: Int) {
            guard !text.isEmpty else { return }
            let textWidth = text.count * 4 - 1
            let startX = leftX + max(0, (rightX - leftX - textWidth) / 2)
            drawText(&buf, text: text, rightX: startX + textWidth, y: rowY + 1, color: timeColor)
        }

        func renderWindow(_ window: UsageWindow, leftX: Int, rightX: Int, rowY: Int, brand: RGB) {
            let percent = max(0, min(100, window.percent))
            let color = gaugeColor(percent, animFrame: animFrame, brand: brand)
            let zoneWidth = rightX - leftX
            let fillWidth = Int(round(Double(zoneWidth) * percent / 100.0))
            // TC001-style fill: use a dim, full-height field for the consumed
            // portion and keep the percentage/reset text bright above it.
            if fillWidth > 0 {
                for y in rowY..<(rowY + 7) {
                    for x in leftX..<(leftX + fillWidth) { blendPixel(&buf, x, y, color, 0.24) }
                }
            }
            let percentText = "\(Int(round(percent)))%"
            let resetText = fittedReset(window.resetsAt, percentText: percentText, zoneWidth: zoneWidth)
            if resetText.isEmpty {
                drawText(&buf, text: percentText, rightX: rightX, y: rowY + 1, color: color)
            } else {
                drawText(&buf, text: resetText, rightX: rightX, y: rowY + 1, color: timeColor)
                drawText(&buf, text: percentText, rightX: rightX - resetText.count * 4, y: rowY + 1, color: color)
            }
        }

        for (index, provider) in providers.enumerated() {
            let rowY = firstY + index * 7
            for y in rowY..<(rowY + 7) {
                for x in 0..<Self.width {
                    blendPixel(&buf, x, y, Self.colors.black, 0.70)
                    blendPixel(&buf, x, y, provider.brand, 0.08)
                }
            }
            // Slightly denser provider tint behind the mark joins the logo to
            // the usage band without obscuring its canonical silhouette.
            for y in rowY..<(rowY + 7) {
                for x in 0..<9 { blendPixel(&buf, x, y, provider.brand, 0.12) }
            }
            drawCreatureMarker(provider, rowY: rowY)
            if let primary = provider.primary, let secondary = provider.secondary {
                for y in (rowY + 1)..<(rowY + 6) { blendPixel(&buf, 36, y, provider.brand, 0.28) }
                renderWindow(primary, leftX: 9, rightX: 36, rowY: rowY, brand: provider.brand)
                renderWindow(secondary, leftX: 37, rightX: 64, rowY: rowY, brand: provider.brand)
            } else if provider.primary == nil, let secondary = provider.secondary,
                      !subscriptionDate(provider.subscriptionUntil).isEmpty {
                for y in (rowY + 1)..<(rowY + 6) { blendPixel(&buf, 36, y, provider.brand, 0.28) }
                drawCenteredLabel(subscriptionDate(provider.subscriptionUntil), leftX: 9, rightX: 36, rowY: rowY)
                renderWindow(secondary, leftX: 37, rightX: 64, rowY: rowY, brand: provider.brand)
            } else if let only = provider.primary ?? provider.secondary {
                renderWindow(only, leftX: 9, rightX: 64, rowY: rowY, brand: provider.brand)
            }
        }
    }

    /// Canonical dot-matrix mark generated from design/brand/*.svg.
    /// Geometry is shared with the Node renderer; state only changes motion/color.
    private func drawOfficialDotGlyph(
        _ buf: inout [UInt8],
        glyph: OfficialDotGlyph,
        worldX: Double,
        worldY: Double,
        state: CreatureState,
        animFrame: Int,
        camera: Camera,
        sessionToneIndex: Int,
        sizeScale: Double = 1.0,
        sick: Bool = false
    ) {
        guard isVisible(worldX, worldY, camera, padding: 0.15),
              let mask = OfficialDotGlyphs.masks[glyph] else { return }
        let (scx, scy) = worldToScreen(worldX, worldY, camera)
        // The 8px floor is the legibility limit of the official mask — a crowd
        // shrink is allowed to reach it but never to go under it and turn a
        // brand mark into mush.
        let target = max(8, Int(round(0.1875 * sizeScale * camera.zoom * Double(Self.width))))
        let bob = state == .processing ? Int(round(sin(Double(animFrame) * 0.28) * max(1, Double(target) / 14))) : 0
        let x0 = Int(round(scx - Double(target) / 2))
        let y0 = Int(round(scy - Double(target) / 2)) + bob
        let octopus = octopusPalette(for: sessionToneIndex)
        let codex = cloudPalette(for: sessionToneIndex)
        let openCode = opencodePalette(for: sessionToneIndex)
        let processingPulse = 0.28 + 0.18 * ((sin(Double(animFrame) * 0.2) + 1) / 2)

        let base: RGB = {
            if sick { return Self.colors.crayfishSick }
            switch glyph {
            case .claudeCode:
                return state == .processing ? octopus.starburst : octopus.body
            case .codex:
                return state == .processing ? lerpColor(codex.body, codex.pulse, processingPulse) : codex.body
            case .openCode:
                return state == .processing ? lerpColor(openCode.outer, openCode.pulse, processingPulse) : openCode.outer
            case .openClaw:
                return state == .processing ? Self.colors.crayfishRouting : Self.colors.crayfishBody
            case .kiro:
                return state == .processing ? (167, 120, 255) : (124, 58, 237)
            case .antigravity:
                return Self.colors.white
            }
        }()

        func antigravityColor(_ sourceX: Int) -> RGB {
            let t = Double(sourceX) / Double(OfficialDotGlyphs.size - 1)
            if t < 0.25 { return lerpColor((92, 214, 77), (245, 203, 36), t * 4) }
            if t < 0.55 { return lerpColor((245, 203, 36), (255, 82, 65), (t - 0.25) / 0.3) }
            if t < 0.78 { return lerpColor((255, 82, 65), (183, 92, 182), (t - 0.55) / 0.23) }
            return lerpColor((183, 92, 182), (36, 126, 255), (t - 0.78) / 0.22)
        }

        for dy in 0..<target {
            let sy = min(OfficialDotGlyphs.size - 1, dy * OfficialDotGlyphs.size / target)
            for dx in 0..<target {
                let sx = min(OfficialDotGlyphs.size - 1, dx * OfficialDotGlyphs.size / target)
                let alpha = Double(mask[sy * OfficialDotGlyphs.size + sx]) / 255
                if alpha <= 0.02 { continue }
                let color = glyph == .antigravity ? antigravityColor(sx) : base
                blendPixel(&buf, x0 + dx, y0 + dy, color, alpha)
            }
        }

        if glyph == .openClaw && !sick {
            for (vx, vy) in [(9.05, 7.63), (15.38, 7.63)] {
                setPixel(&buf, x0 + Int(round(vx / 24 * Double(target))), y0 + Int(round(vy / 24 * Double(target))), Self.colors.crayfishEye)
            }
        }

        if state == .awaiting {
            drawQuestionBubble(&buf, centerX: x0 + target + 1, centerY: y0)
        } else if state == .processing {
            let sparkle: RGB = glyph == .antigravity ? (255, 216, 80) : lerpColor(base, Self.colors.white, 0.45)
            for i in 0..<4 {
                let angle = Double(animFrame) * 0.22 + Double(i) * Double.pi / 2
                let distance = Double(target) / 2 + 2
                setPixel(&buf, Int(round(scx + cos(angle) * distance)), Int(round(scy + Double(bob) + sin(angle) * distance)), sparkle)
            }
        }
    }

    private func drawOctopus(_ buf: inout [UInt8], worldX: Double, worldY: Double, state: CreatureState, animFrame: Int, camera: Camera, palette: OctopusPalette) {
        guard isVisible(worldX, worldY, camera, padding: 0.15) else { return }
        let (scx, scy) = worldToScreen(worldX, worldY, camera)
        let useLOD = camera.zoom < 1.3
        let grid = useLOD ? Self.octopusLOD : Self.octopusGrid
        let cols = useLOD ? 7 : 13
        let rows = useLOD ? 7 : 13
        let baseX = Int(round(scx - Double(cols) / 2))
        let baseY = Int(round(scy - Double(rows) / 2))
        let breathPx = state == .processing ? Int(round(sin(Double(animFrame) * 0.3) * 1.5)) : 0
        let bodyColor = state == .processing ? palette.starburst : (state == .idle ? palette.body : palette.body)
        for row in 0..<rows {
            for col in 0..<cols {
                let cell = grid[row][col]
                if cell == 0 { continue }
                let color: RGB
                switch cell {
                case 2: color = Self.colors.octopusEye
                case 3, 4: color = state == .processing ? palette.starburst : palette.arm
                case 5, 6: color = palette.leg
                default: color = state == .awaiting ? palette.body : bodyColor
                }
                var dx = 0
                if state != .idle && (cell == 5 || cell == 6) {
                    dx = Int(round(sin(Double(animFrame) * 0.2 + Double(col) * 1.8) * 1.5))
                }
                fillCell(&buf, baseX + col + dx, baseY + row + breathPx, 1, 1, color)
            }
        }
        if state == .awaiting {
            drawQuestionBubble(&buf, centerX: Int(round(scx)), centerY: baseY - 3 + Int(round(sin(Double(animFrame) * 0.25))))
        }
        if state == .processing {
            let sparkPhase = Double(animFrame) * 0.35
            let dist = 5 + sin(Double(animFrame) * 0.25) * 3
            for i in 0..<6 {
                let angle = sparkPhase + (Double(i) * Double.pi * 2 / 6)
                let sx = scx + cos(angle) * dist
                let sy = scy + Double(breathPx) + sin(angle) * dist * 0.6
                setPixel(&buf, Int(round(sx)), Int(round(sy)), palette.starburst)
            }
        }
    }

    private func drawCloud(_ buf: inout [UInt8], worldX: Double, worldY: Double, state: CreatureState, animFrame: Int, camera: Camera, palette: CloudPalette) {
        guard isVisible(worldX, worldY, camera, padding: 0.15) else { return }
        let (scx, scy) = worldToScreen(worldX, worldY, camera)
        let useLOD = camera.zoom < 1.3
        let grid = useLOD ? Self.cloudLOD : Self.cloudGrid
        let cols = useLOD ? 9 : 13
        let rows = useLOD ? 7 : 11
        let baseX = Int(round(scx - Double(cols) / 2))
        let baseY = Int(round(scy - Double(rows) / 2))
        let pulseSpeed = state == .processing ? 0.25 : 0.06
        let pulsePhase = sin(Double(animFrame) * pulseSpeed)
        let contracting = pulsePhase < 0
        let breathPx = state == .processing ? Int(round(sin(Double(animFrame) * 0.3) * 1.5)) : 0
        let pulseMix = 0.18 + ((sin(Double(animFrame) * 0.2) + 1) * 0.18)
        let bodyColor = state == .processing ? lerpColor(palette.body, palette.pulse, pulseMix) : (state == .idle ? palette.body : palette.body)
        let markingVisible = animFrame % 60 > 5
        for row in 0..<rows {
            for col in 0..<cols {
                let cell = grid[row][col]
                if cell == 0 { continue }
                if cell == 3 {
                    if contracting { continue }
                    fillCell(&buf, baseX + col, baseY + row + breathPx, 1, 1, palette.edge)
                    continue
                }
                if cell == 2 {
                    fillCell(&buf, baseX + col, baseY + row + breathPx, 1, 1, markingVisible ? palette.marking : bodyColor)
                    continue
                }
                fillCell(&buf, baseX + col, baseY + row + breathPx, 1, 1, bodyColor)
            }
        }
        if state == .awaiting {
            drawQuestionBubble(&buf, centerX: Int(round(scx)), centerY: baseY - 3 + Int(round(sin(Double(animFrame) * 0.25))))
        }
        if state == .processing {
            let orbitPhase = Double(animFrame) * 0.2
            let dist = 5 + sin(Double(animFrame) * 0.15) * 2
            for i in 0..<4 {
                let angle = orbitPhase + (Double(i) * Double.pi * 2 / 4)
                let sx = scx + cos(angle) * dist
                let sy = scy + Double(breathPx) + sin(angle) * dist * 0.6
                setPixel(&buf, Int(round(sx)), Int(round(sy)), palette.pulse)
            }
        }
    }

    private func drawOpenCode(_ buf: inout [UInt8], worldX: Double, worldY: Double, state: CreatureState, animFrame: Int, camera: Camera, palette: OpenCodePalette) {
        let scx = Int(round(((worldX - camera.cx) * camera.zoom + 0.5) * 64))
        let scy = Int(round(((worldY - camera.cy) * camera.zoom + 0.5) * 64))
        let pixW = max(1, Int(round((10.0 / 64.0) * camera.zoom * 64.0 / 10.0)))
        let pixH = pixW
        let breathPx = state == .processing ? Int(round(sin(Double(animFrame) * 0.3) * 1.5)) : (state == .idle ? Int(round(sin(Double(animFrame) * 0.08) * 0.7)) : 0)
        let useLOD = camera.zoom < 1.3
        let grid = useLOD ? Self.opencodeLOD : Self.opencodeGrid
        let cols = useLOD ? 6 : 10
        let rows = useLOD ? 6 : 9
        let baseX = scx - Int(round(Double(cols * pixW) / 2))
        let baseY = scy + breathPx - Int(round(Double(rows * pixH) / 2))
        let outerColor = state == .processing ? lerpColor(palette.outer, palette.pulse, 0.5 + sin(Double(animFrame) * 0.2) * 0.5) : (state == .idle ? palette.outer : palette.outer)
        let innerColor = state == .idle ? palette.inner : palette.inner
        for row in 0..<rows {
            for col in 0..<cols {
                let cell = grid[row][col]
                if cell == 0 { continue }
                let color = cell == 9 ? innerColor : outerColor
                for dy in 0..<pixH {
                    for dx in 0..<pixW {
                        setPixel(&buf, baseX + col * pixW + dx, baseY + row * pixH + dy, color)
                    }
                }
            }
        }
        if state == .awaiting {
            let dotCx = scx + Int(round(Double(cols) / 2)) + 3
            let dotCy = baseY - 2 + Int(round(sin(Double(animFrame) * 0.26) * 1.4))
            for i in -1...1 {
                blendPixel(&buf, dotCx + i * 3, dotCy, Self.colors.stateAwaiting, 0.75)
                blendPixel(&buf, dotCx + i * 3 + 1, dotCy, Self.colors.stateAwaiting, 0.45)
            }
        }
    }

    private func antigravityCellColor(_ ch: Character, palette: AntigravityPalette) -> RGB? {
        switch ch {
        case "L": return palette.lime
        case "T": return palette.teal
        case "Q": return palette.cyan
        case "Y": return palette.yellow
        case "O": return palette.orange
        case "R": return palette.red
        case "P": return palette.pink
        case "V": return palette.violet
        case "U": return palette.blue
        case "N": return palette.sky
        case "K": return palette.cutout
        default: return nil
        }
    }

    private func drawAntigravity(_ buf: inout [UInt8], worldX: Double, worldY: Double, state: CreatureState, animFrame: Int, camera: Camera, palette: AntigravityPalette) {
        guard isVisible(worldX, worldY, camera, padding: 0.15) else { return }
        let (scx, scy) = worldToScreen(worldX, worldY, camera)
        // Broken into typed steps — the single expression hit the CI Xcode
        // type-checker timeout in Release builds.
        let quantizedZoom: Double = round(camera.zoom * 4) / 4
        let cellRaw: Double = (0.1875 * quantizedZoom * Double(Self.width)) / 11.0
        let cell = max(1, Int(round(cellRaw)))
        let spriteW = 11 * cell
        let spriteH = 11 * cell
        let breathPx = state == .processing
            ? Int(round(sin(Double(animFrame) * 0.28) * Double(cell)))
            : (state == .idle ? Int(round(sin(Double(animFrame) * 0.08) * 0.5)) : 0)
        let nudgeX = state == .processing && ((animFrame >> 3) & 1) == 1 ? cell : 0
        let nudgeY = state != .idle && ((animFrame >> 2) & 1) == 1 ? -cell : 0
        let baseX = Int(round(scx - Double(spriteW) / 2)) + nudgeX
        let baseY = Int(round(scy - Double(spriteH) / 2)) + breathPx + nudgeY
        var tracked = Set<Int>()

        for row in 0..<11 {
            let line = Self.antigravityGrid[row]
            for col in 0..<11 {
                let idx = line.index(line.startIndex, offsetBy: col)
                guard let color = antigravityCellColor(line[idx], palette: palette) else { continue }
                fillCellTracked(&buf, x: Double(baseX + col * cell), y: Double(baseY + row * cell), w: Double(cell), h: Double(cell), color: color, tracked: &tracked)
            }
        }

        drawCreatureOutline(&buf, trackedPixels: tracked, bodyColor: palette.violet, alpha: 0.45)

        if state == .awaiting {
            drawQuestionBubble(&buf, centerX: Int(round(scx + Double(spriteW) * 0.48)), centerY: Int(round(Double(baseY) + Double(spriteH) * 0.18)))
        }

        if state == .processing {
            let sparkle = lerpColor(palette.yellow, Self.colors.white, 0.35)
            let dist = max(2, cell * 3)
            for i in 0..<4 {
                let t = Double(animFrame) * 0.22 + Double(i) * Double.pi / 2
                setPixel(&buf, Int(round(scx + cos(t) * Double(dist))), Int(round(Double(baseY - 1) + sin(t) * Double(dist) * 0.35)), sparkle)
            }
        }
    }

    private func drawCrayfish(_ buf: inout [UInt8], worldX: Double, worldY: Double, routing: Bool, animFrame: Int, camera: Camera, sick: Bool) {
        guard isVisible(worldX, worldY, camera, padding: 0.15) else { return }
        let (scx, scy) = worldToScreen(worldX, worldY, camera)
        let useLOD = camera.zoom < 1.3
        let grid = useLOD ? Self.crayfishLOD : Self.crayfishGrid
        let cols = useLOD ? 8 : 12
        let rows = useLOD ? 6 : 8
        let cellW = useLOD ? camera.zoom * 1.5 : camera.zoom
        let cellH = cellW * 1.5
        let spriteW = Double(cols) * cellW
        let spriteH = Double(rows) * cellH
        let baseX = scx - spriteW / 2
        let baseY = scy - spriteH / 2
        let breathRaw = sick ? 0.0 : pow(abs(sin(Double(animFrame) * 0.15)), 0.7) * (sin(Double(animFrame) * 0.15) >= 0 ? 1 : -1)
        let breathPx = sick ? 0.0 : ensureMinAmplitude(breathRaw * cellH * 0.5, minPx: 1)
        let glowRx = spriteW / 2 + 2
        let glowRy = spriteH / 2 + 2
        drawCreatureGlow(&buf, centerX: Int(round(scx)), centerY: Int(round(scy + breathPx)), rx: Int(ceil(glowRx)), ry: Int(ceil(glowRy)), glowColor: Self.colors.crayfishGlow, intensity: 0.12, isLOD: useLOD)
        var tracked = Set<Int>()
        for row in 0..<rows {
            for col in 0..<cols {
                let cell = grid[row][col]
                guard let color = crayfishCellColor(cell, routing: routing, sick: sick) else { continue }
                var dx = 0.0
                let dy = breathPx
                if !sick {
                    if cell == 7 {
                        let speed = routing ? 0.35 : 0.15
                        let wiggle = sin(Double(animFrame) * speed + Double(col) * 3) * cellW * 1.5
                        let twitch = ((animFrame + col * 17) % 60) < 4 ? cellW * 2 * (col < 6 ? -1 : 1) : 0
                        dx = ensureMinAmplitude(wiggle + twitch, minPx: 1)
                    }
                    if cell == 3 || cell == 4 {
                        if routing {
                            let clap = sin(Double(animFrame) * 0.3) * cellW * 3
                            dx = ensureMinAmplitude(cell == 3 ? clap : -clap, minPx: 1)
                        } else {
                            let gentle = sin(Double(animFrame) * 0.125) * cellW
                            dx = ensureMinAmplitude(cell == 3 ? gentle : -gentle, minPx: 1)
                        }
                    }
                    if cell == 5 || cell == 6 {
                        dx = ensureMinAmplitude(sin(Double(animFrame) * 0.1 + (cell == 5 ? 0 : Double.pi)) * cellW * 1.2, minPx: 1)
                    }
                    fillCellTracked(&buf, x: baseX + Double(col) * cellW + dx, y: baseY + Double(row) * cellH + dy, w: cellW, h: cellH, color: color, tracked: &tracked)
                } else {
                    let tiltPx = (Double(col) - Double(cols) / 2) * 0.15
                    dx = col < cols / 2 ? 1 : -1
                    fillCellTracked(&buf, x: baseX + Double(col) * cellW + dx, y: baseY + Double(row) * cellH + dy + tiltPx, w: cellW, h: cellH, color: color, tracked: &tracked)
                }
            }
        }
        let outlineAlpha = useLOD ? 0.6 : 0.8
        drawCreatureOutline(&buf, trackedPixels: tracked, bodyColor: routing ? Self.colors.crayfishRouting : Self.colors.crayfishBody, alpha: outlineAlpha)
        let eyeRow = useLOD ? 2 : 3
        let eyeCols = useLOD ? [2, 5] : [4, 7]
        let eyeCenter = sick ? (0x44, 0x66, 0x60) : Self.colors.crayfishEye
        let eyeRing = sick ? (0x44, 0x33, 0x33) : Self.colors.crayfishEyeRing
        for ec in eyeCols {
            let ex = Int(round(baseX + (Double(ec) + 0.5) * cellW))
            let ey = Int(round(baseY + (Double(eyeRow) + 0.5) * cellH + breathPx))
            for dy in -1...1 {
                for dx in -1...1 where !(dx == 0 && dy == 0) {
                    setPixel(&buf, ex + dx, ey + dy, eyeRing)
                }
            }
            setPixel(&buf, ex, ey, eyeCenter)
        }
        if routing {
            let wavePhase = Double(animFrame) * 0.3
            for i in 0..<4 {
                let angle = wavePhase + (Double(i) * Double.pi / 2)
                let dist = (4 + sin(Double(animFrame) * 0.2 + Double(i))) * cellW
                let sx = scx + cos(angle) * dist
                let sy = scy + breathPx + sin(angle) * dist * 0.5
                glowCell(&buf, x: sx, y: sy, w: cellW, h: cellW, color: Self.colors.crayfishEye, intensity: 0.4)
            }
            let bodyPulse = (sin(Double(animFrame) * 0.25) + 1) * 0.15
            for row in 0..<rows {
                for col in 0..<cols where grid[row][col] != 0 {
                    glowCell(&buf, x: baseX + Double(col) * cellW, y: baseY + Double(row) * cellH + breathPx, w: cellW, h: cellH, color: Self.colors.crayfishRouting, intensity: bodyPulse)
                }
            }
        }
    }

    private func drawTetra(_ buf: inout [UInt8], worldX: Double, worldY: Double, heading: Double, camera: Camera) {
        guard isVisible(worldX, worldY, camera, padding: 0.08) else { return }
        let (sx, sy) = worldToScreen(worldX, worldY, camera)
        let px = camera.zoom
        let bw = max(1, Int(round(px * 2)))
        let bh = max(1, Int(round(px)))
        fillCell(&buf, Int(round(sx)), Int(round(sy)), bw, bh, Self.colors.tetraBody)
        let stripeX = heading > 0 ? Int(round(sx - px)) : Int(round(sx + px * 2))
        fillCell(&buf, stripeX, Int(round(sy)), max(1, Int(round(px))), bh, Self.colors.tetraNeon)
        let finX = heading > 0 ? stripeX - max(1, Int(round(px * 0.5))) : stripeX + max(1, Int(round(px)))
        fillCell(&buf, finX, Int(round(sy)), max(1, Int(round(px * 0.5))), bh, Self.colors.tetraFin)
    }

    /// Awaiting affordance: a soft white disc with an amber "?" on top.
    ///
    /// `centerX`/`centerY` are the CENTER of the disc. The disc is the backing
    /// that keeps the mark legible against mid-water blues; the glyph is the
    /// 5-pixel question mark (top bar → curve → stem → dot), which is the
    /// smallest form that still reads as "?" rather than as noise.
    ///
    /// Mirror of `drawQuestionBubble` in bridge/src/pixoo/pixoo-sprites.ts —
    /// keep the radius, alpha, and glyph offsets identical.
    private func drawQuestionBubble(_ buf: inout [UInt8], centerX: Int, centerY: Int) {
        let r = 3
        for dy in -r...r {
            for dx in -r...r where dx * dx + dy * dy <= r * r {
                blendPixel(&buf, centerX + dx, centerY + dy, Self.colors.white, 0.7)
            }
        }
        // 5-px "?" centered in the disc — every pixel stays inside radius 3.
        let gx = centerX
        let gy = centerY - 2
        setPixel(&buf, gx, gy, Self.colors.stateAwaiting)
        setPixel(&buf, gx + 1, gy, Self.colors.stateAwaiting)
        setPixel(&buf, gx + 1, gy + 1, Self.colors.stateAwaiting)
        setPixel(&buf, gx, gy + 2, Self.colors.stateAwaiting)
        setPixel(&buf, gx, gy + 4, Self.colors.stateAwaiting)
    }

    private static func getAnimFrame(atTimeMs timeMs: Double? = nil) -> Int {
        let ms = timeMs ?? (Date().timeIntervalSince1970 * 1000)
        return Int(floor(ms / 100.0))
    }

    private func octopusPalette(for sessionIndex: Int) -> OctopusPalette {
        let tone = Self.sessionToneFactors[min(max(sessionIndex, 0), Self.sessionToneFactors.count - 1)]
        return OctopusPalette(
            body: scaleColor(Self.colors.octopusBody, tone),
            arm: scaleColor(Self.colors.octopusArm, tone),
            leg: scaleColor(Self.colors.octopusLeg, tone),
            sleeping: scaleColor(Self.colors.octopusSleeping, tone),
            starburst: scaleColor(Self.colors.octopusStarburst, tone)
        )
    }

    private func cloudPalette(for sessionIndex: Int) -> CloudPalette {
        let tone = Self.sessionToneFactors[min(max(sessionIndex, 0), Self.sessionToneFactors.count - 1)]
        return CloudPalette(
            body: scaleColor(Self.colors.cloudBody, tone),
            edge: scaleColor(Self.colors.cloudEdge, tone),
            marking: scaleColor(Self.colors.cloudMarking, tone),
            sleeping: scaleColor(Self.colors.cloudSleeping, tone),
            pulse: scaleColor(Self.colors.cloudPulse, tone)
        )
    }

    private func opencodePalette(for sessionIndex: Int) -> OpenCodePalette {
        let tone = Self.sessionToneFactors[min(max(sessionIndex, 0), Self.sessionToneFactors.count - 1)]
        return OpenCodePalette(
            outer: scaleColor(Self.colors.opencodeOuter, tone),
            inner: scaleColor(Self.colors.opencodeInner, tone),
            sleeping: scaleColor(Self.colors.opencodeSleeping, tone),
            pulse: scaleColor(Self.colors.opencodePulse, tone)
        )
    }

    private func antigravityPalette(for sessionIndex: Int) -> AntigravityPalette {
        let tone = Self.sessionToneFactors[min(max(sessionIndex, 0), Self.sessionToneFactors.count - 1)]
        return AntigravityPalette(
            lime: scaleColor(Self.colors.antigravityLime, tone),
            teal: scaleColor(Self.colors.antigravityTeal, tone),
            cyan: scaleColor(Self.colors.antigravityCyan, tone),
            yellow: scaleColor(Self.colors.antigravityYellow, tone),
            orange: scaleColor(Self.colors.antigravityOrange, tone),
            red: scaleColor(Self.colors.antigravityRed, tone),
            pink: scaleColor(Self.colors.antigravityPink, tone),
            violet: scaleColor(Self.colors.antigravityViolet, tone),
            blue: scaleColor(Self.colors.antigravityBlue, tone),
            sky: scaleColor(Self.colors.antigravitySky, tone),
            cutout: Self.colors.black
        )
    }

    private struct WaterPalette {
        let surface: RGB
        let light: RGB
        let mid: RGB
        let deep: RGB
    }

    private func zoneBlue() -> WaterPalette {
        WaterPalette(surface: Self.colors.waterSurface, light: Self.colors.waterLight, mid: Self.colors.waterMid, deep: Self.colors.waterDeep)
    }

    private func waterColorAt(palette: WaterPalette, surfaceY: Int, y: Int) -> RGB {
        let waterDepth = Self.sandTop - surfaceY
        guard waterDepth > 0 else { return palette.deep }
        let t = Double(y - surfaceY) / Double(waterDepth)
        if t < 0.25 { return lerpColor(palette.surface, palette.light, t / 0.25) }
        if t < 0.6 { return lerpColor(palette.light, palette.mid, (t - 0.25) / 0.35) }
        return lerpColor(palette.mid, palette.deep, (t - 0.6) / 0.4)
    }

    private func creatureType(for agentType: String) -> CreatureKind {
        if Self.antigravityAgents.contains(agentType) { return .antigravity }
        if Self.kiroAgents.contains(agentType) { return .kiro }
        if Self.cloudAgents.contains(agentType) { return .cloud }
        if Self.opencodeAgents.contains(agentType) { return .opencode }
        return .octopus
    }

    private func isCreatureAgent(_ agentType: String) -> Bool {
        Self.codingAgents.contains(agentType) || Self.cloudAgents.contains(agentType) || Self.opencodeAgents.contains(agentType) || Self.antigravityAgents.contains(agentType) || Self.kiroAgents.contains(agentType)
    }

    private func simplifiedState(_ state: AgentConnectionState) -> CreatureState {
        switch state {
        case .processing: return .processing
        case .awaitingPermission, .awaitingOption, .awaitingDiff: return .awaiting
        default: return .idle
        }
    }

    private func mapSessionState(_ state: String?) -> CreatureState {
        switch state {
        case "processing": return .processing
        case "awaiting_permission", "awaiting_option", "awaiting_diff": return .awaiting
        default: return .idle
        }
    }

    private func hudProviderCount(from dashboardState: DashboardState) -> Int {
        var count = 0
        if dashboardState.usageStale != true, dashboardState.fiveHourPercent != nil {
            count += 1
        }
        func freshCodexWindow(_ window: CodexRateLimitWindow?) -> Bool {
            window?.stale != true && window?.usedPercent != nil
        }
        let codexPrimary = freshCodexWindow(dashboardState.codexRateLimits?.primary)
        let codexSecondary = freshCodexWindow(dashboardState.codexRateLimits?.secondary)
        if codexPrimary || codexSecondary {
            count += 1
        }
        return count
    }

    private func stateY(_ state: CreatureState, kind: CreatureKind, baseY: Double, hudProviderCount: Int = 0) -> Double {
        let y: Double = switch kind {
        case .octopus:
            switch state {
            case .processing: clamp(baseY, min: 0.40, max: 0.54)
            case .awaiting: clamp(baseY - 0.04, min: 0.35, max: 0.48)
            case .idle: 0.80
            }
        case .cloud:
            switch state {
            case .processing: clamp(baseY, min: 0.16, max: 0.28)
            case .awaiting: clamp(baseY + 0.26, min: 0.52, max: 0.64)
            case .idle: clamp(baseY + 0.40, min: 0.80, max: 0.82)
            }
        case .opencode:
            switch state {
            case .processing: clamp(baseY - 0.02, min: 0.20, max: 0.34)
            case .awaiting: clamp(baseY + 0.22, min: 0.50, max: 0.62)
            case .idle: clamp(baseY + 0.36, min: 0.79, max: 0.81)
            }
        case .antigravity:
            switch state {
            case .processing: clamp(baseY - 0.04, min: 0.16, max: 0.30)
            case .awaiting: clamp(baseY + 0.22, min: 0.46, max: 0.54)
            case .idle: clamp(baseY + 0.34, min: 0.56, max: 0.64)
            }
        case .kiro:
            switch state {
            case .processing: clamp(baseY - 0.04, min: 0.16, max: 0.30)
            case .awaiting: clamp(baseY + 0.16, min: 0.42, max: 0.54)
            case .idle: clamp(baseY + 0.26, min: 0.60, max: 0.70)
            }
        }
        if hudProviderCount >= 2 {
            return min(y, 0.65)
        } else if hudProviderCount == 1 {
            return min(y, 0.72)
        }
        return y
    }

    private func clamp(_ value: Double, min minValue: Double, max maxValue: Double) -> Double {
        Swift.min(maxValue, Swift.max(minValue, value))
    }

    private func gaugeColor(_ pct: Double, animFrame: Int, brand: RGB) -> RGB {
        if pct >= 90 {
            let pulse = (sin(Double(animFrame) * 0.2) + 1) * 0.3
            return lerpColor(Self.colors.stateError, Self.colors.white, pulse)
        }
        if pct >= 70 { return Self.colors.stateAwaiting }
        return brand
    }

    func formatResetDetailed(_ resetsAt: String?) -> String {
        guard let resetsAt else { return "" }
        guard let date = parseISO8601Date(resetsAt) else { return "" }
        let ms = date.timeIntervalSinceNow * 1000
        if ms <= 0 { return "0m" }
        let totalMins = max(1, Int(ceil(ms / 60000)))
        let hours = totalMins / 60
        let days = hours / 24
        let remHours = hours % 24
        let mins = totalMins % 60
        if days > 0 && remHours > 0 { return "\(days)d\(remHours)" }
        if days > 0 { return "\(days)d" }
        if hours > 0 && mins > 0 { return "\(hours)h\(mins)" }
        if hours > 0 { return "\(hours)h" }
        return "\(mins)m"
    }

    private func brightenColor(_ color: RGB, factor: Double) -> RGB {
        (
            UInt8(min(255, Int(round(Double(color.0) * factor)))),
            UInt8(min(255, Int(round(Double(color.1) * factor)))),
            UInt8(min(255, Int(round(Double(color.2) * factor)))),
        )
    }

    private func parseISO8601Date(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) {
            return date
        }

        let base = ISO8601DateFormatter()
        base.formatOptions = [.withInternetDateTime]
        return base.date(from: value)
    }

    private func drawText(_ buf: inout [UInt8], text: String, rightX: Int, y: Int, color: RGB) {
        var cursorX = rightX
        for ch in text.reversed() {
            guard let glyph = Self.pixelFont[ch] else {
                cursorX -= 2
                continue
            }
            cursorX -= 3
            for row in 0..<5 {
                let bits = glyph[row]
                for col in 0..<3 where bits & (1 << (2 - col)) != 0 {
                    setPixel(&buf, cursorX + col, y + row, color)
                }
            }
            cursorX -= 1
        }
    }

    private func setPixel(_ buf: inout [UInt8], _ x: Int, _ y: Int, _ color: RGB) {
        guard x >= 0, x < Self.width, y >= 0, y < Self.height else { return }
        let idx = (y * Self.width + x) * 3
        buf[idx] = color.0
        buf[idx + 1] = color.1
        buf[idx + 2] = color.2
    }

    private func blendPixel(_ buf: inout [UInt8], _ x: Int, _ y: Int, _ color: RGB, _ alpha: Double) {
        guard x >= 0, x < Self.width, y >= 0, y < Self.height, alpha > 0 else { return }
        let idx = (y * Self.width + x) * 3
        let a = min(1.0, alpha)
        let inv = 1.0 - a
        buf[idx] = UInt8(min(255, Int(round(Double(buf[idx]) * inv + Double(color.0) * a))))
        buf[idx + 1] = UInt8(min(255, Int(round(Double(buf[idx + 1]) * inv + Double(color.1) * a))))
        buf[idx + 2] = UInt8(min(255, Int(round(Double(buf[idx + 2]) * inv + Double(color.2) * a))))
    }

    private func glowPixel(_ buf: inout [UInt8], _ x: Int, _ y: Int, _ color: RGB, _ intensity: Double) {
        guard x >= 0, x < Self.width, y >= 0, y < Self.height, intensity > 0 else { return }
        let idx = (y * Self.width + x) * 3
        buf[idx] = UInt8(min(255, Int(buf[idx]) + Int(round(Double(color.0) * intensity))))
        buf[idx + 1] = UInt8(min(255, Int(buf[idx + 1]) + Int(round(Double(color.1) * intensity))))
        buf[idx + 2] = UInt8(min(255, Int(buf[idx + 2]) + Int(round(Double(color.2) * intensity))))
    }

    private func fillCell(_ buf: inout [UInt8], _ x: Int, _ y: Int, _ w: Int, _ h: Int, _ color: RGB) {
        for dy in 0..<max(1, h) {
            for dx in 0..<max(1, w) {
                setPixel(&buf, x + dx, y + dy, color)
            }
        }
    }

    private func fillCellTracked(_ buf: inout [UInt8], x: Double, y: Double, w: Double, h: Double, color: RGB, tracked: inout Set<Int>) {
        let ix = Int(floor(x))
        let iy = Int(floor(y))
        let iw = max(1, Int(round(Double(ix) + w)) - ix)
        let ih = max(1, Int(round(Double(iy) + h)) - iy)
        for dy in 0..<ih {
            for dx in 0..<iw {
                let px = ix + dx
                let py = iy + dy
                guard px >= 0, px < Self.width, py >= 0, py < Self.height else { continue }
                setPixel(&buf, px, py, color)
                tracked.insert(py * Self.width + px)
            }
        }
    }

    private func glowCell(_ buf: inout [UInt8], x: Double, y: Double, w: Double, h: Double, color: RGB, intensity: Double) {
        let ix = Int(floor(x))
        let iy = Int(floor(y))
        let iw = max(1, Int(round(Double(ix) + w)) - ix)
        let ih = max(1, Int(round(Double(iy) + h)) - iy)
        for dy in 0..<ih {
            for dx in 0..<iw {
                glowPixel(&buf, ix + dx, iy + dy, color, intensity)
            }
        }
    }

    private func scaleColor(_ color: RGB, _ factor: Double) -> RGB {
        (
            UInt8(max(0, min(255, Int(round(Double(color.0) * factor))))),
            UInt8(max(0, min(255, Int(round(Double(color.1) * factor))))),
            UInt8(max(0, min(255, Int(round(Double(color.2) * factor)))))
        )
    }

    private func lerpColor(_ a: RGB, _ b: RGB, _ t: Double) -> RGB {
        let s = max(0, min(1, t))
        return (
            UInt8(round(Double(a.0) + (Double(b.0) - Double(a.0)) * s)),
            UInt8(round(Double(a.1) + (Double(b.1) - Double(a.1)) * s)),
            UInt8(round(Double(a.2) + (Double(b.2) - Double(a.2)) * s))
        )
    }

    private func worldToScreen(_ wx: Double, _ wy: Double, _ cam: Camera) -> (Double, Double) {
        (
            (wx - cam.cx) * Double(Self.width) * cam.zoom + Double(Self.width) / 2,
            (wy - cam.cy) * Double(Self.width) * cam.zoom + Double(Self.width) / 2
        )
    }

    private func isVisible(_ wx: Double, _ wy: Double, _ cam: Camera, padding: Double) -> Bool {
        let halfView = 0.5 / cam.zoom + padding
        return abs(wx - cam.cx) <= halfView && abs(wy - cam.cy) <= halfView
    }

    /// Snap the camera center to the device-pixel grid.
    ///
    /// The background blit and the integer-snapped sprite origin round
    /// independently, so a sub-pixel camera center lets their rounding *phase*
    /// drift frame-to-frame — a fixed sprite cell (a creature eye) shimmers 1px
    /// even though the creature isn't moving. Quantizing the center so
    /// `cx * width * zoom ∈ ℤ` freezes that phase, leaving only the creature's
    /// own whole-pixel translation. At the ~1fps Pixoo push rate the cost to pan
    /// smoothness is invisible.
    ///
    /// Mirror of `quantizeCameraPixels` in bridge/src/pixoo/pixoo-camera.ts.
    private func quantizeCameraPixels(_ cam: Camera) -> Camera {
        let s = Double(Self.width) * cam.zoom // output pixels per world unit
        guard s > 0 else { return cam }
        return Camera(
            cx: (cam.cx * s).rounded() / s,
            cy: (cam.cy * s).rounded() / s,
            zoom: cam.zoom
        )
    }

    private func clampCamera(_ cam: Camera) -> Camera {
        let halfView = 0.5 / cam.zoom
        return Camera(
            cx: max(halfView, min(1 - halfView, cam.cx)),
            cy: max(halfView, min(1 - halfView, cam.cy)),
            zoom: cam.zoom
        )
    }

    private func lerpCamera(from: Camera, to: Camera, t: Double) -> Camera {
        let s = max(0, min(1, t))
        return Camera(
            cx: from.cx + (to.cx - from.cx) * s,
            cy: from.cy + (to.cy - from.cy) * s,
            zoom: from.zoom + (to.zoom - from.zoom) * s
        )
    }

    private func easeInOut(_ t: Double) -> Double {
        let s = max(0, min(1, t))
        return s * s * (3 - 2 * s)
    }

    private func blitWithCamera(world: [UInt8], output: inout [UInt8], camera: Camera) {
        let cxPx = camera.cx * Double(Self.width)
        let cyPx = camera.cy * Double(Self.width)
        let viewSize = Double(Self.width) / camera.zoom
        let left = cxPx - viewSize / 2
        let top = cyPx - viewSize / 2
        for sy in 0..<Self.height {
            for sx in 0..<Self.width {
                let wx = Int(floor(left + Double(sx) / camera.zoom))
                let wy = Int(floor(top + Double(sy) / camera.zoom))
                let dst = (sy * Self.width + sx) * 3
                guard wx >= 0, wx < Self.width, wy >= 0, wy < Self.height else { continue }
                let src = (wy * Self.width + wx) * 3
                output[dst] = world[src]
                output[dst + 1] = world[src + 1]
                output[dst + 2] = world[src + 2]
            }
        }
    }

    private func drawCreatureGlow(_ buf: inout [UInt8], centerX: Int, centerY: Int, rx: Int, ry: Int, glowColor: RGB, intensity: Double, isLOD: Bool) {
        let actualIntensity = isLOD ? intensity * 1.5 : intensity
        let spread = isLOD ? 1.2 : 1.3
        let irx = Int(ceil(Double(rx) * spread))
        let iry = Int(ceil(Double(ry) * spread))
        for dy in -iry...iry {
            for dx in -irx...irx {
                let dist = sqrt(pow(Double(dx) / Double(max(1, rx)), 2) + pow(Double(dy) / Double(max(1, ry)), 2))
                if dist > spread { continue }
                let falloff = pow(1 - dist / spread, 2)
                glowPixel(&buf, centerX + dx, centerY + dy, glowColor, actualIntensity * falloff)
            }
        }
    }

    private func drawCreatureOutline(_ buf: inout [UInt8], trackedPixels: Set<Int>, bodyColor: RGB, alpha: Double) {
        let outline = (
            UInt8(round(Double(bodyColor.0) * 0.5)),
            UInt8(round(Double(bodyColor.1) * 0.5)),
            UInt8(round(Double(bodyColor.2) * 0.5))
        )
        for key in trackedPixels {
            let cx = key % Self.width
            let cy = key / Self.width
            for dx in -1...1 {
                for dy in -1...1 where !(dx == 0 && dy == 0) {
                    let nx = cx + dx
                    let ny = cy + dy
                    guard nx >= 0, nx < Self.width, ny >= 0, ny < Self.height else { continue }
                    if !trackedPixels.contains(ny * Self.width + nx) {
                        blendPixel(&buf, nx, ny, outline, alpha)
                    }
                }
            }
        }
    }

    private func crayfishCellColor(_ cell: Int, routing: Bool, sick: Bool) -> RGB? {
        guard cell != 0 else { return nil }
        if sick {
            switch cell {
            case 2: return Self.colors.crayfishSick
            case 3, 4, 5, 6: return (0x77, 0x55, 0x55)
            case 7: return (0x88, 0x66, 0x66)
            default: return Self.colors.crayfishSick
            }
        }
        let bodyColor = routing ? Self.colors.crayfishRouting : Self.colors.crayfishBody
        switch cell {
        case 1, 2: return bodyColor
        case 3, 4: return Self.colors.crayfishClaw
        case 5, 6: return Self.colors.crayfishLeg
        case 7: return Self.colors.crayfishAntenna
        default: return bodyColor
        }
    }

    private func ensureMinAmplitude(_ value: Double, minPx: Double) -> Double {
        if abs(value) < 0.01 { return 0 }
        let rounded = round(value)
        if rounded == 0 { return value > 0 ? minPx : -minPx }
        return rounded
    }
}
#endif
