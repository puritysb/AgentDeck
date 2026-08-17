// SessionBrand.swift — Shared brand palette + creature-icon renderer
//
// Previously lived inside `ControlTowerPanel.swift` (macOS-only), which meant
// the iOS dashboard couldn't use the same visual language. Moved to a shared
// file so both the menubar popup and the cross-platform MonitorScreen HUD
// render agents with the same colors and the same path-rendered marks.
//
// Keep the palette in sync with:
//   * `bridge/src/modules/…` agent color maps
//   * `AgentStatusIcon`'s NSColor mirror (menubar rendering path)

import SwiftUI

/// Canonical per-agent brand colors applied to the path-rendered official marks.
enum SessionBrand {
    static func color(for agentType: String?) -> Color {
        switch agentType {
        case "claude-code": return Color(red: 0.753, green: 0.439, blue: 0.345) // #C07058
        case "codex-cli":   return Color(red: 0.38,  green: 0.40,  blue: 0.88)  // indigo
        case "codex-app":   return Color(red: 0.38,  green: 0.40,  blue: 0.88)  // indigo
        case "openclaw":    return Color(red: 1.0,   green: 0.30,  blue: 0.30)  // #FF4D4D
        case "opencode":    return Color(red: 0.945, green: 0.925, blue: 0.925) // near-white
        case "antigravity": return Color(red: 0.373, green: 0.388, blue: 0.408) // #5F6368
        case "kiro-cli", "kiro-ide": return Color(red: 0.486, green: 0.227, blue: 0.929) // #7C3AED
        case "daemon":      return Color(red: 0.55,  green: 0.55,  blue: 0.60)
        default:            return Color.secondary
        }
    }

    /// Whether a drawn brand mark exists for this agent.
    ///
    /// Surfaces that need to fall back to a placeholder must ask this instead
    /// of restating which agents have a mark. A hand-kept list in
    /// `SessionListPanel` fell behind the icon table the moment Kiro shipped —
    /// the spec, the color and the accessibility label all knew `kiro-cli`
    /// while that one switch did not, so every Kiro row drew the grey bullet.
    static func hasBrandMark(for agentType: String?) -> Bool {
        AgentBrandIconSpec.fromAgentType(agentType) != nil
    }
}

/// Renders an agent's branded creature in its brand color.
///
/// Keep known agents on the path-rendered `AgentBrandIcon` instead of the
/// asset-catalog SVG renderer. The catalog path has repeatedly clipped or
/// flattened compact Codex marks in menu bar/popover surfaces because the SVG
/// uses currentColor + even-odd clipping and reaches the viewBox edge.
struct SessionCreatureIcon: View {
    let agentType: String?
    let tint: Color
    let size: CGFloat
    var contentInset: CGFloat = 0

    var body: some View {
        Group {
            if AgentBrandIconSpec.fromAgentType(agentType) != nil {
                AgentBrandIcon(
                    agentType: agentType,
                    tint: tint,
                    size: size,
                    contentInset: contentInset
                )
            } else {
                Image(systemName: "questionmark.circle")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(tint)
                    .padding(contentInset)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Self.accessibilityLabel(for: agentType))
    }

    private static func accessibilityLabel(for type: String?) -> String {
        switch type {
        case "claude-code": return "Claude Code session"
        case "openclaw":    return "OpenClaw session"
        case "codex-cli":   return "Codex session"
        case "codex-app":   return "Codex App session"
        case "opencode":    return "OpenCode session"
        case "antigravity": return "Antigravity session"
        case "kiro-cli":    return "Kiro CLI session"
        case "kiro-ide":    return "Kiro IDE session"
        case "daemon":      return "Daemon"
        default:            return "Unknown agent session"
        }
    }
}

/// Path-rendered brand mark for dashboard, timeline, menu bar, and attention
/// surfaces. This mirrors Android's `BrandIcon.kt` path renderer so glyphs
/// stay pixel-stable across platforms and avoid asset-catalog SVG quirks
/// (especially masks, odd viewBox ratios, currentColor, and template
/// flattening).
struct AgentBrandIcon: View {
    let agentType: String?
    let tint: Color
    let size: CGFloat
    var contentInset: CGFloat = 0

    var body: some View {
        Group {
            if let spec = AgentBrandIconSpec.fromAgentType(agentType) {
                Canvas { context, canvasSize in
                    let inset = min(contentInset, min(canvasSize.width, canvasSize.height) * 0.45)
                    let availableWidth = max(0, canvasSize.width - inset * 2)
                    let availableHeight = max(0, canvasSize.height - inset * 2)
                    let scale = min(availableWidth / spec.viewBox, availableHeight / spec.viewBox)
                    guard scale > 0 else { return }

                    let drawnWidth = spec.viewBox * scale
                    let drawnHeight = spec.viewBox * scale
                    let originX = (canvasSize.width - drawnWidth) / 2
                    let originY = (canvasSize.height - drawnHeight) / 2
                    let fillStyle = FillStyle(eoFill: spec.evenOddFill)

                    context.drawLayer { layer in
                        layer.translateBy(x: originX, y: originY)
                        layer.scaleBy(x: scale, y: scale)
                        for path in spec.paths {
                            layer.fill(path, with: .color(tint), style: fillStyle)
                        }
                    }
                }
            } else {
                Image(systemName: "questionmark.circle")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .foregroundStyle(tint)
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(Self.accessibilityLabel(for: agentType))
    }

    private static func accessibilityLabel(for type: String?) -> String {
        switch type {
        case "claude-code": return "Claude Code session"
        case "openclaw":    return "OpenClaw session"
        case "codex-cli":   return "Codex session"
        case "codex-app":   return "Codex App session"
        case "opencode":    return "OpenCode session"
        case "antigravity": return "Antigravity session"
        case "kiro-cli":    return "Kiro CLI session"
        case "kiro-ide":    return "Kiro IDE session"
        case "daemon":      return "Daemon"
        default:            return "Unknown agent session"
        }
    }
}

private struct AgentBrandIconSpec {
    let paths: [Path]
    let viewBox: CGFloat
    let evenOddFill: Bool

    static func fromAgentType(_ agentType: String?) -> AgentBrandIconSpec? {
        switch agentType {
        case "claude-code": return .claude
        case "codex-cli":   return .codex
        case "codex-app":   return .codex
        case "openclaw":    return .openClaw
        case "opencode":    return .openCode
        case "antigravity": return .antigravity
        case "kiro-cli", "kiro-ide": return .kiro
        default:            return nil
        }
    }

    private static let claude = AgentBrandIconSpec(
        paths: [parse(claudePath)],
        viewBox: 24,
        evenOddFill: true
    )

    private static let codex = AgentBrandIconSpec(
        paths: [parse(codexPath)],
        viewBox: 24,
        evenOddFill: true
    )

    private static let openClaw = AgentBrandIconSpec(
        paths: openClawPaths.map(parse),
        viewBox: 24,
        evenOddFill: true
    )

    private static let openCode = AgentBrandIconSpec(
        paths: [parse(openCodePath)],
        viewBox: 24,
        evenOddFill: true
    )

    private static let antigravity = AgentBrandIconSpec(
        paths: [parse(antigravityPath)],
        viewBox: 24,
        evenOddFill: true
    )

    private static let kiro = AgentBrandIconSpec(
        paths: [parse(kiroPath)],
        viewBox: 24,
        evenOddFill: true
    )

    private static func parse(_ pathData: String) -> Path {
        CrayfishCreature.parseSvgPath(fixArcFlags(pathData))
    }

    /// SVG permits arc flags to be adjacent (`... 0 110 1.055`); the local
    /// path parser expects them as separate numeric tokens.
    private static func fixArcFlags(_ path: String) -> String {
        let chars = Array(path)
        var output = ""
        var i = 0

        func skipWhitespaceAndCommas() {
            while i < chars.count,
                  chars[i] == " " || chars[i] == "," || chars[i] == "\n" || chars[i] == "\t" || chars[i] == "\r" {
                i += 1
            }
        }

        func appendNumber() {
            guard i < chars.count else { return }
            output.append(" ")
            if chars[i] == "-" || chars[i] == "+" {
                output.append(chars[i])
                i += 1
            }
            while i < chars.count, chars[i].isNumber {
                output.append(chars[i])
                i += 1
            }
            if i < chars.count, chars[i] == "." {
                output.append(".")
                i += 1
                while i < chars.count, chars[i].isNumber {
                    output.append(chars[i])
                    i += 1
                }
            }
            if i < chars.count, chars[i] == "e" || chars[i] == "E" {
                output.append(chars[i])
                i += 1
                if i < chars.count, chars[i] == "-" || chars[i] == "+" {
                    output.append(chars[i])
                    i += 1
                }
                while i < chars.count, chars[i].isNumber {
                    output.append(chars[i])
                    i += 1
                }
            }
        }

        while i < chars.count {
            let char = chars[i]
            if char == "a" || char == "A" {
                output.append(char)
                i += 1

                while i < chars.count {
                    skipWhitespaceAndCommas()
                    guard i < chars.count else { break }
                    let next = chars[i]
                    if next.isLetter, next != "e", next != "E" { break }

                    appendNumber() // rx
                    skipWhitespaceAndCommas()
                    appendNumber() // ry
                    skipWhitespaceAndCommas()
                    appendNumber() // x-axis-rotation

                    skipWhitespaceAndCommas()
                    if i < chars.count, chars[i] == "0" || chars[i] == "1" {
                        output.append(" ")
                        output.append(chars[i])
                        i += 1
                    }

                    skipWhitespaceAndCommas()
                    if i < chars.count, chars[i] == "0" || chars[i] == "1" {
                        output.append(" ")
                        output.append(chars[i])
                        i += 1
                    }

                    skipWhitespaceAndCommas()
                    appendNumber() // dx/x
                    skipWhitespaceAndCommas()
                    appendNumber() // dy/y
                }
            } else {
                output.append(char)
                i += 1
            }
        }

        return output
    }

    // Claude Code mark — lobe-icons MIT (viewBox 0 0 24 24, grid pattern, evenodd)
    private static let claudePath =
        "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"

    // Codex mark — canonical AgentDeck copy in design/brand/codex.svg.
    private static let codexPath =
        "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"

    // OpenCode mark — lobe-icons MIT (viewBox 0 0 24 24, nested-square)
    private static let openCodePath =
        "M16 6H8v12h8V6zm4 16H4V2h16v20z"

    // Antigravity mark — lobe-icons MIT (viewBox 0 0 24 24, peak/arc)
    private static let antigravityPath =
        "M21.751 22.607c1.34 1.005 3.35.335 1.508-1.508C17.73 15.74 18.904 1 12.037 1 5.17 1 6.342 15.74.815 21.1c-2.01 2.009.167 2.511 1.507 1.506 5.192-3.517 4.857-9.714 9.715-9.714 4.857 0 4.522 6.197 9.714 9.715z"

    // @lobehub/icons-static-svg@1.94.0, MIT (design/brand/kiro.svg)
    private static let kiroPath =
        "M4.594 6.677C6.67-2.226 18.746-2.211 21.16 6.632c.353 1.297 1.725 7.582-1.673 13.747-1.545 2.797-5.841 5.49-6.99 1.883C8.6 25.477 3.315 24.1 5.789 18.609l-.318.143c-3.57 1.305-3.863-1.208-3.173-2.513.45-.84.727-1.335.937-1.897.353-.975.458-1.568.593-2.498.27-1.837.277-3.607.765-5.167zm8.37.01a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.214-.705 1.214-1.89 0-.622-.127-1.125-.367-1.455a1.014 1.014 0 00-.855-.435zm4.08 0a.92.92 0 00-.81.428c-.217.323-.33.825-.33 1.462 0 .705.15 1.89 1.14 1.89h.008c.757 0 1.215-.705 1.215-1.89 0-.622-.128-1.125-.368-1.455a1.014 1.014 0 00-.855-.435z"

    private static let openClawPaths = [
        "M9.046 7.104a.527.527 0 110 1.055.527.527 0 010-1.055z",
        "M15.376 7.104a.528.528 0 110 1.056.528.528 0 010-1.056z",
        "M16.877 1.912c.58-.27 1.14-.323 1.616-.037a.317.317 0 01-.326.542c-.227-.136-.547-.153-1.022.068-.352.165-.765.45-1.234.866 2.683 1.17 4.4 3.5 5.148 5.921a6.421 6.421 0 00-.704.184c-.578.016-1.174.204-1.502.735-.338.55-.268 1.276.072 2.069l.005.012.007.014c.523 1.045 1.318 1.91 2.2 2.284-.912 3.274-3.44 6.144-5.972 6.988v2.109h-2.11v-2.11c-1.043.417-2.086.01-2.11 0v2.11h-2.11v-2.11c-2.531-.843-5.061-3.713-5.973-6.987.882-.373 1.678-1.238 2.2-2.284l.007-.014.006-.012c.34-.793.41-1.518.071-2.069-.327-.531-.923-.719-1.503-.735a6.409 6.409 0 00-.704-.183c.749-2.421 2.466-4.751 5.149-5.922-.47-.416-.88-.701-1.234-.866-.474-.221-.794-.204-1.021-.068a.318.318 0 01-.435-.109.317.317 0 01.109-.433c.476-.286 1.036-.233 1.615.037.49.229 1.031.628 1.621 1.182A9.924 9.924 0 0112 2.568c1.199 0 2.284.19 3.256.526.59-.554 1.13-.953 1.62-1.182zM8.835 6.577a1.266 1.266 0 100 2.532 1.266 1.266 0 000-2.532zm6.33 0a1.267 1.267 0 100 2.533 1.267 1.267 0 000-2.533z",
        "M.395 13.118c-.966-1.932-.163-3.863 2.41-3.365v-.001l.05.01c.084.018.17.038.26.06.033.009.067.017.1.027.084.022.168.048.255.076l.09.027c.528 0 .95.158 1.16.501.212.343.212.87-.105 1.61-.085.17-.178.333-.276.489l-.01.017a4.967 4.967 0 01-.62.791l-.019.02c-1.092 1.117-2.496 1.336-3.295-.262z",
        "M21.193 9.753c2.574-.5 3.378 1.433 2.411 3.365-.58 1.159-1.476 1.361-2.342.96l-.011-.005a2.419 2.419 0 01-.114-.056l-.019-.01a2.751 2.751 0 01-.115-.067l-.023-.014c-.035-.022-.071-.044-.106-.068l-.05-.035c-.55-.388-1.062-1.007-1.44-1.76-.276-.647-.311-1.132-.174-1.472.176-.439.636-.639 1.23-.639.032-.011.066-.02.099-.03.08-.026.16-.05.238-.072l.117-.03a5.502 5.502 0 01.3-.067z",
    ]
}
