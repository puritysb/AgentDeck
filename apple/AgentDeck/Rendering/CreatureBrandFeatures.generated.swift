// Generated from shared/src/brand-features.ts + unchanged canonical SVGs. Do not edit.
import SwiftUI

enum CreatureBrandFeatures {
    static let monochromeMinimumSize: CGFloat = 24
    static let monochromeOutlineWidth: CGFloat = 0.4
    static let monochromeLightBodyAgents: Set<String> = ["claudecode", "openclaw"]
    struct Layer {
        let role: String
        let hole: Bool
        let monochrome: String
        let creatureMonochrome: String
        let color: Color?
        let paths: [Path]
    }
    static let layers: [String: [Layer]] = [
        "claudecode": [
            Layer(role: "eyes", hole: false, monochrome: "paper", creatureMonochrome: "ink", color: Color(red: 0, green: 0, blue: 0), paths: [CrayfishCreature.parseSvgPath("M6 10.949h1.488V8.102H6v2.847z"), CrayfishCreature.parseSvgPath("M16.51 10.949H18V8.102h-1.49v2.847z")])
        ],
        "codex": [
            Layer(role: "prompt", hole: false, monochrome: "paper", creatureMonochrome: "paper", color: Color(red: 1, green: 1, blue: 1), paths: [CrayfishCreature.parseSvgPath("M7.282 8.307a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393z"), CrayfishCreature.parseSvgPath("M12.728 14.547a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z")])
        ],
        "openclaw": [
            Layer(role: "eyes", hole: false, monochrome: "paper", creatureMonochrome: "ink", color: Color(red: 0.0196078431372549, green: 0.03137254901960784, blue: 0.06274509803921569), paths: [CrayfishCreature.parseSvgPath("M8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532z"), CrayfishCreature.parseSvgPath("M15.165 6.577a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z")]),
            Layer(role: "eye-highlight", hole: false, monochrome: "ink", creatureMonochrome: "paper", color: Color(red: 0, green: 0.8980392156862745, blue: 0.8), paths: [CrayfishCreature.parseSvgPath("M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z")]),
            Layer(role: "eye-highlight", hole: false, monochrome: "ink", creatureMonochrome: "paper", color: Color(red: 0, green: 0.8980392156862745, blue: 0.8), paths: [CrayfishCreature.parseSvgPath("M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z")])
        ],
        "opencode": [
            Layer(role: "center", hole: true, monochrome: "hole", creatureMonochrome: "hole", color: nil, paths: [CrayfishCreature.parseSvgPath("M16 6H8v12h8V6z")])
        ]
    ]
    static func canonical(_ agent: String?) -> String {
        switch agent {
        case "claude", "claude-code", "claude_code": return "claudecode"
        case "codex-cli", "codex-app": return "codex"
        case "crayfish": return "openclaw"
        default: return agent ?? ""
        }
    }
    static func draw(_ agent: String?, context: GraphicsContext, transform: CGAffineTransform = .identity, compactInkMonochrome: Bool = false, monochromeCreature: Bool = false) {
        for layer in layers[canonical(agent)] ?? [] where !layer.hole {
            guard let featureColor = layer.color else { continue }
            let color = compactInkMonochrome ? (layer.monochrome == "ink" ? Color.black : Color.white) : monochromeCreature ? (layer.creatureMonochrome == "paper" ? Color.white : Color.black) : featureColor
            for path in layer.paths { context.fill(path.applying(transform), with: .color(color)) }
        }
    }
}
