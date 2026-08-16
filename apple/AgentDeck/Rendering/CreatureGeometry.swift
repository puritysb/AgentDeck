// CreatureGeometry.swift — Hand-maintained SwiftUI port of the canonical creature
// geometry SSOT `android/app/src/main/kotlin/dev/agentdeck/terrarium/CreatureGeometry.kt`.
//
// ⚠️ SSOT PORT — KEEP IN SYNC. The Kotlin `object CreatureGeometry` is the single
// source of truth for the terrarium creature vector geometry shared by the Compose
// tablet renderer and the e-ink native-Canvas renderer. This file re-transcribes the
// exact same `*_PATH_DATA` strings and viewBox sizes so the Apple
// device-preview / terrarium surfaces cannot silhouette-drift from the canonical
// robot / peak / OpenClaw. When `CreatureGeometry.kt` changes, update the mirrored
// constants below in the SAME change.
//
// Sync pins — verified by `scripts/check-preview-mirror-sync.mjs` (CI). When an
// origin changes, re-port (or confirm no visual impact) and bump its pin in the
// same commit. Note: Kotlin-side parser workarounds (e.g. normalizeSvgArcFlags)
// don't change path geometry and only need a pin bump.
// SYNC-HASH android/app/src/main/kotlin/dev/agentdeck/terrarium/CreatureGeometry.kt 435d60044ee9f5528fd270fca9878b939894b687
// SYNC-HASH android/app/src/main/kotlin/dev/agentdeck/terrarium/creature/CloudCreature.kt e33052a7d027b94029c01361b31b3cfc468868ab
// SYNC-HASH android/app/src/main/kotlin/dev/agentdeck/terrarium/creature/OpenCodeCreature.kt 98075f5650447acb19d02076a1dc7a5c270544f2
//
// Faithful scope: the Kotlin SSOT defines path geometry for the agent marks —
//   • Octopus / Claude Code robot        (claudecode.svg,   viewBox 24)
//   • Antigravity peak / arc mark         (antigravity.svg,  viewBox 24)
//   • OpenClaw official mark              (openclaw.svg,    viewBox 24)
// Codex and OpenCode use their exact design/brand paths rather than procedural
// substitutes, so previews and terrarium surfaces preserve the same geometry.
//
// Fill / stroke roles are taken from the canonical consumers (EinkRenderer.kt):
//   • Octopus path         → even-odd fill (the two inner rects are eye cutouts)
//   • Antigravity path     → fill
//   • OpenClaw body/claws   → even-odd fill; eye dots are separate fill layers
//
// Cross-platform: SwiftUI + CoreGraphics only (no AppKit / UIKit), so this compiles for
// both the macOS and iOS targets. Parsing delegates to the arc-capable parser used by
// the Apple terrarium so compact official SVG arc flags retain their exact geometry.

import SwiftUI

// MARK: - Canonical geometry (mirrors CreatureGeometry.kt)

enum CreatureGeometry {

    // --- Octopus / Claude Code robot (claudecode.svg, viewBox 0 0 24 24) ---
    // fill-rule: evenodd — the two inner rects are transparent eye cutouts.
    static let octopusViewBox: CGFloat = 24
    static let octopusPathData =
        "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"

    // --- Antigravity peak/arc mark (design/brand/antigravity.svg, viewBox 0 0 24 24) ---
    // Upward double-peak / mountain arc silhouette. SSOT mirror of
    // shared/src/svg-renderers/agent-logos.ts ANTIGRAVITY_PATH.
    static let antigravityViewBox: CGFloat = 24
    static let antigravityPathData =
        "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"

    static let kiroViewBox: CGFloat = 24
    static let kiroPathData =
        "M4.594 6.677C6.67-2.226 18.746-2.211 21.16 6.632c.353 1.297 1.725 7.582-1.673 13.747-1.545 2.797-5.841 5.49-6.99 1.883C8.6 25.477 3.315 24.1 5.789 18.609l-.318.143c-3.57 1.305-3.863-1.208-3.173-2.513.45-.84.727-1.335.937-1.897.353-.975.458-1.568.593-2.498.27-1.837.277-3.607.765-5.167zm8.37.01a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.214-.705 1.214-1.89 0-.622-.127-1.125-.367-1.455a1.014 1.014 0 00-.855-.435zm4.08 0a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.215-.705 1.215-1.89 0-.622-.128-1.125-.368-1.455a1.014 1.014 0 00-.855-.435z"

    static let codexViewBox: CGFloat = 24
    static let codexPathData =
        "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
    static let openCodeViewBox: CGFloat = 24
    static let openCodePathData = "M16 6H8v12h8V6zm4 16H4V2h16v20z"

    // --- OpenClaw official mark (design/brand/openclaw.svg, viewBox 0 0 24 24) ---
    static let openClawViewBox: CGFloat = 24
    static let openClawEyePathData = [
        "M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z",
        "M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z",
    ]
    static let openClawBodyPathData = [
        "M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z",
        "M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z",
        "M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.58 1.159-1.476 1.361-2.342.96l-.011-.005a2.419 2.419 0 01-.114-.056l-.019-.01a2.751 2.751 0 01-.115-.067l-.023-.014c-.035-.022-.071-.044-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76-.276-.647-.311-1.132-.174-1.472.176-.439.636-.639 1.23-.639.032-.011.066-.02.099-.03.08-.026.16-.05.238-.072l.117-.03a5.502 5.502 0 01.3-.067z",
    ]

    // --- Parsed Paths in viewBox coordinate space (mirrors the *NativePath accessors) ---

    static let octopusPath: Path = CrayfishCreature.parseSvgPath(octopusPathData)
    static let antigravityPath: Path = CrayfishCreature.parseSvgPath(antigravityPathData)
    static let kiroPath: Path = CrayfishCreature.parseSvgPath(kiroPathData)
    static let codexPath: Path = CrayfishCreature.parseSvgPath(codexPathData)
    static let openCodePath: Path = CrayfishCreature.parseSvgPath(openCodePathData)
    static let openClawBodyPaths = openClawBodyPathData.map(CrayfishCreature.parseSvgPath)
    static let openClawEyePaths = openClawEyePathData.map(CrayfishCreature.parseSvgPath)

    // MARK: - Layered creature model

    /// How a layer should be rasterized. Mirrors the `Paint.Style` / fill-rule choices
    /// made by the canonical consumers.
    enum FillRole {
        case fill
        case evenOddFill
    }

    /// A single drawable layer in the creature's own viewBox coordinate space.
    struct Layer {
        let path: Path
        let role: FillRole
    }

    /// A whole creature: its authoring viewBox plus its ordered layers.
    struct Creature {
        let viewBox: CGFloat
        let layers: [Layer]
    }

    /// Kinds that have canonical path geometry in the SSOT.
    private enum Kind {
        case octopus
        case antigravity
        case kiro
        case crayfish
        case cloud
        case ring
    }

    /// Normalizes the various agent-type spellings used across the codebase
    /// (`"claude"`, `"claude-code"`, `"codex-cli"`, `"openclaw"`, …) onto the
    /// creature kinds. Inlined here to keep the file self-contained.
    private static func kind(for agentType: String?) -> Kind? {
        switch agentType?.lowercased() {
        case "claude", "claude-code", "claudecode", "claude_code":
            return .octopus
        case "openclaw", "crayfish":
            return .crayfish
        case "antigravity":
            return .antigravity
        case "kiro", "kiro-cli", "kiro-ide":
            return .kiro
        case "codex", "codex-cli", "codex-app":
            return .cloud
        case "opencode":
            return .ring
        default:
            return nil
        }
    }

    /// The canonical creature for an agent type, in its own viewBox coordinate space.
    /// Returns nil only for unknown agents.
    static func creature(for agentType: String?) -> Creature? {
        switch kind(for: agentType) {
        case .octopus:
            return Creature(
                viewBox: octopusViewBox,
                layers: [Layer(path: octopusPath, role: .evenOddFill)]
            )
        case .antigravity:
            return Creature(
                viewBox: antigravityViewBox,
                layers: [Layer(path: antigravityPath, role: .fill)]
            )
        case .kiro:
            return Creature(
                viewBox: kiroViewBox,
                layers: [Layer(path: kiroPath, role: .evenOddFill)]
            )
        case .crayfish:
            return Creature(
                viewBox: openClawViewBox,
                layers: openClawBodyPaths.map { Layer(path: $0, role: .evenOddFill) }
                    + openClawEyePaths.map { Layer(path: $0, role: .fill) }
            )
        case .cloud:
            return Creature(
                viewBox: codexViewBox,
                layers: [Layer(path: codexPath, role: .evenOddFill)]
            )
        case .ring:
            return Creature(
                viewBox: openCodeViewBox,
                layers: [Layer(path: openCodePath, role: .evenOddFill)]
            )
        case .none:
            return nil
        }
    }

    // MARK: - Rect-fitted convenience

    /// The affine transform that fits a creature's square viewBox centered into `rect`
    /// (aspect-preserving, `min` scale — same fit the Compose/Canvas surfaces use).
    static func fitTransform(viewBox: CGFloat, in rect: CGRect) -> CGAffineTransform {
        guard viewBox > 0 else { return .identity }
        let scale = min(rect.width, rect.height) / viewBox
        let drawn = viewBox * scale
        let originX = rect.minX + (rect.width - drawn) / 2
        let originY = rect.minY + (rect.height - drawn) / 2
        return CGAffineTransform(translationX: originX, y: originY)
            .scaledBy(x: scale, y: scale)
    }

    /// Convenience: the union of the creature's fill layers, transformed to fit `rect`.
    /// Returns nil for agents without canonical geometry.
    static func path(for agentType: String?, in rect: CGRect) -> Path? {
        guard let creature = creature(for: agentType) else { return nil }
        let transform = fitTransform(viewBox: creature.viewBox, in: rect)
        var combined = Path()
        for layer in creature.layers {
            combined.addPath(layer.path.applying(transform))
        }
        return combined.isEmpty ? nil : combined
    }

    /// True when the agent has canonical creature geometry to render.
    static func hasGeometry(for agentType: String?) -> Bool {
        kind(for: agentType) != nil
    }
}

// MARK: - SwiftUI Shape / View

/// A SwiftUI `Shape` that emits the fillable silhouette of an agent's canonical creature,
/// fitted to the drawing rect. Yields an empty path for agents without SSOT geometry, so
/// it can be used directly as `.fill(...)` in a layout without crashing.
struct CanonicalCreatureShape: Shape {
    let agentType: String?

    func path(in rect: CGRect) -> Path {
        CreatureGeometry.path(for: agentType, in: rect) ?? Path()
    }
}

/// Drop-in preview view that renders an agent's canonical creature (all layers, with the
/// correct fill rules) tinted a single `color`. Mirrors the
/// single-tint silhouette treatment used by the terrarium/e-ink surfaces. All five agents
/// render: robot, cloud+`>_`, ring, crayfish, peak. Unknown agents render nothing.
struct CanonicalCreatureView: View {
    let agentType: String?
    var size: CGFloat = 64
    var color: Color = .primary

    var body: some View {
        Canvas { context, canvasSize in
            guard let creature = CreatureGeometry.creature(for: agentType) else { return }
            let rect = CGRect(origin: .zero, size: canvasSize)
            let transform = CreatureGeometry.fitTransform(viewBox: creature.viewBox, in: rect)
            context.drawLayer { layerCtx in
                for layer in creature.layers {
                    let transformed = layer.path.applying(transform)
                    switch layer.role {
                    case .fill:
                        layerCtx.fill(transformed, with: .color(color))
                    case .evenOddFill:
                        layerCtx.fill(transformed, with: .color(color), style: FillStyle(eoFill: true))
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Self.accessibilityLabel(for: agentType))
    }

    private static func accessibilityLabel(for agentType: String?) -> String {
        switch agentType?.lowercased() {
        case "claude", "claude-code", "claudecode", "claude_code":
            return "Claude Code creature"
        case "codex", "codex-cli", "codex-app":
            return "Codex cloud creature"
        case "opencode":
            return "OpenCode ring creature"
        case "openclaw", "crayfish":
            return "OpenClaw crayfish creature"
        case "antigravity":
            return "Antigravity creature"
        case "kiro", "kiro-cli", "kiro-ide":
            return "Kiro ghost creature"
        default:
            return "Agent creature"
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Canonical creatures") {
    HStack(spacing: 24) {
        VStack {
            CanonicalCreatureView(agentType: "claude-code", size: 96,
                                  color: Color(red: 0.753, green: 0.439, blue: 0.345))
            Text("octopus").font(.caption2)
        }
        VStack {
            CanonicalCreatureView(agentType: "openclaw", size: 96,
                                  color: Color(red: 1.0, green: 0.30, blue: 0.30))
            Text("crayfish").font(.caption2)
        }
        VStack {
            CanonicalCreatureView(agentType: "antigravity", size: 96,
                                  color: Color(red: 0.373, green: 0.388, blue: 0.408))
            Text("antigravity").font(.caption2)
        }
    }
    .padding()
    .background(Color.black)
}
#endif
