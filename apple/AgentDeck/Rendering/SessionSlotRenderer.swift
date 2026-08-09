// SessionSlotRenderer.swift — Swift port of shared/src/svg-renderers/session-slot-renderer.ts.
//
// Renders the 144×144 Stream Deck+ session button as a native SwiftUI view, so the
// Device Preview feature and any future in-app Stream Deck simulator can share the
// same rendering pipeline. The real Stream Deck hardware still receives SVG via the
// TypeScript bridge — this Swift version is visual-parity only.
//
// ─────────────────────────────────────────────────────────────────────────────
// KEEP IN SYNC (SSOT PORT): hand-maintained mirror of `renderSessionSlot` in the
// TS renderer. When that function's visuals change, re-port here in the same
// commit. Last synced against the RUNNING-teal / PERM-amber-breathe split
// (TS f9869f9e) + idle-only ACT badge + brand-logo watermark placement.
//
// Sync pin — verified by `scripts/check-preview-mirror-sync.mjs` (CI). When the
// origin changes, re-port (or confirm no visual impact) and bump the pin in the
// same commit.
// Pin bumped 2026-08-07: the origin unified its animation constants so a surface
// that BAKES the loop (the D200H, which ships one looping GIF per state rather
// than ticking every frame) can close it — `ORBIT_SPEED_PX`,
// `SESSION_SLOT_ANIM_CYCLE`, `PULSE_OMEGA`. Ported: the pulse and the breath now
// ride PULSE_OMEGA instead of the hand-picked 0.12 / 0.14.
//
// Two origin changes deliberately did NOT need porting, recorded so the next
// reader does not go looking for them:
//   • the focus ring's orbit speed (16 → ORBIT_SPEED_PX) — this mirror never drew
//     the focus ring at all; `isActive` is declared and unused.
//   • `processingStartFrame` defaulting to 0 instead of `animFrame` — this mirror
//     never applied that per-session phase anchor, so it never had the bug where
//     the anchor cancelled the rotation and froze the dashes.
// Ported 2026-08-08: the original 72×72 Stream Deck key's low-resolution
// typography profile (`wrapSessionName`, 20pt names, and lower tool baseline).
// SYNC-HASH shared/src/svg-renderers/session-slot-renderer.ts a943e7e09cc29dbaa75b654a5d6f25c6322e40d7
//
// Scope for this first pass:
//   - renderSessionSlot (primary session button)
// Future ports if needed:
//   - renderEmptySlot / renderNoDaemonSlot / renderDetailInfo / renderOptionButton / etc.

import SwiftUI

enum SessionSlot {
    static let size: CGFloat = 144
    static let cornerRadius: CGFloat = 16
    static let innerInset: CGFloat = 8
    static let innerCornerRadius: CGFloat = 12

    /// Dash travel per `animFrame` unit (TS: `ORBIT_SPEED_PX`).
    static let orbitSpeedPx = 22
    /// Dash pattern period — the `dash: [92, 420]` below sums to exactly this.
    static let borderPerimeter = 512
    /// `animFrame` units in one full animation cycle (TS: `SESSION_SLOT_ANIM_CYCLE`).
    static let animCycle = Double(borderPerimeter) / Double(orbitSpeedPx)
    /// Pulse / breath frequency: one complete breath per cycle (TS: `PULSE_OMEGA`).
    ///
    /// Replaces the hand-picked 0.12 and 0.14. Those were fine here — this preview
    /// is a live ticker that just keeps incrementing `animFrame` — but they are not
    /// commensurate with the orbit period, so a surface that bakes the animation
    /// into a looping GIF (the D200H) snapped from a lit border back to a dark one
    /// on every wrap. The shared renderer had to change; this mirror follows so the
    /// preview keeps showing what the hardware shows.
    static let pulseOmega = Double.pi / animCycle
}

/// Premium palette (matches the p1/p2 pairs in the TS renderer, not StateColors.brand).
private struct AgentSlotPalette {
    let primary: Color
    let secondary: Color

    static func `for`(_ agent: String?) -> AgentSlotPalette {
        switch agent {
        case "claude-code":
            return .init(primary: Color(hex: "#D97757"), secondary: Color(hex: "#BE6D52"))
        case "codex-cli", "codex-app":
            return .init(primary: Color(hex: "#8BA4FF"), secondary: Color(hex: "#5981FF"))
        case "openclaw":
            return .init(primary: Color(hex: "#FF6B6B"), secondary: Color(hex: "#CC3333"))
        default: // opencode + unknown
            return .init(primary: Color(hex: "#F1ECEC"), secondary: Color(hex: "#AFAFAF"))
        }
    }
}

private enum SlotMode {
    case idle, working, asking

    init(state: String?) {
        switch state {
        case "processing":                                     self = .working
        case let s? where s.hasPrefix("awaiting"):             self = .asking
        default:                                                self = .idle
        }
    }
}

// MARK: - Primary entry point

struct SessionSlotView: View {
    let session: SessionInfo
    var isActive: Bool = false
    var animFrame: Int = 0
    var displayName: String? = nil
    /// Mirrors `renderSessionSlot(..., { lowResolutionKey: true })` for the
    /// original 72×72 Stream Deck key preview.
    var lowResolutionKey: Bool = false

    private var mode: SlotMode { SlotMode(state: session.state) }
    private var agent: String { session.agentType ?? "claude-code" }
    private var palette: AgentSlotPalette { .for(session.agentType) }
    private var nameForDisplay: String {
        displayName ?? session.projectName ?? "—"
    }
    private var nameLines: [String] {
        SessionSlotText.wrapSessionName(
            nameForDisplay,
            maxChars: lowResolutionKey ? 11 : 15
        )
    }
    private var nameStartBaseline: CGFloat {
        switch nameLines.count {
        case 1: return lowResolutionKey ? 60 : 54
        case 2: return lowResolutionKey ? 56 : 53
        case 3: return lowResolutionKey ? 53 : 52
        default: return lowResolutionKey ? 52 : 50
        }
    }
    private var nameLineHeight: CGFloat {
        nameLines.count == 4
            ? (lowResolutionKey ? 18 : 15)
            : (lowResolutionKey ? 20 : 18)
    }
    private var modelText: String {
        guard let m = session.modelName else { return "" }
        return SessionSlotText.truncate(m, max: 12)
    }
    private var stateLabelText: String {
        switch mode {
        case .working: return "RUNNING"
        case .asking:  return "PERMIT?"
        case .idle:    return "IDLE"
        }
    }
    /// RUNNING is a cool teal, PERM the semantic amber — mirrors the TS
    /// renderer's WORKING_COLOR/stateColor split (f9869f9e) so the two states
    /// never read as the same hue.
    private var signalColor: Color {
        switch mode {
        case .working: return Color(hex: "#2DD4BF")
        case .asking:  return Color(hex: "#F59E0B")
        case .idle:    return palette.primary
        }
    }
    private var accentColorText: Color {
        switch mode {
        case .working: return Color(hex: "#CCFBF1")
        case .asking:  return Color(hex: "#FCD34D")
        case .idle:    return palette.primary
        }
    }
    private var toolText: String {
        mode == .working ? "Running task" : modelText
    }

    var body: some View {
        ZStack {
            // Outer gradient background — matches the #1C1C1E → #0C0C0E fill in TS
            RoundedRectangle(cornerRadius: SessionSlot.cornerRadius, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Color(hex: "#1C1C1E"), Color(hex: "#0C0C0E")],
                        startPoint: .top, endPoint: .bottom
                    )
                )

            // Inner panel (the 128×128 rounded rect at 8,8 in TS)
            RoundedRectangle(cornerRadius: SessionSlot.innerCornerRadius, style: .continuous)
                .fill(Color(hex: "#2C2C2E").opacity(0.8))
                .padding(SessionSlot.innerInset)

            // State border. RUNNING: teal marching dashes orbiting the key
            // (renderOrbitingRect — dash 92px over the 512px perimeter);
            // PERM: solid amber that breathes (full perimeter, no dashes).
            // Deliberately different motion + hue per state (TS f9869f9e).
            if mode == .working {
                let pulseOpacity = 0.72 + 0.20 * abs(sin(Double(animFrame) * SessionSlot.pulseOmega))
                let phase = CGFloat(-((animFrame * SessionSlot.orbitSpeedPx) % SessionSlot.borderPerimeter))
                RoundedRectangle(cornerRadius: SessionSlot.innerCornerRadius, style: .continuous)
                    .strokeBorder(signalColor, style: StrokeStyle(lineWidth: 3.6, dash: [92, 420], dashPhase: phase))
                    .opacity(pulseOpacity * 0.72)
                    .blur(radius: 2.4)
                    .padding(SessionSlot.innerInset)
                RoundedRectangle(cornerRadius: SessionSlot.innerCornerRadius, style: .continuous)
                    .strokeBorder(signalColor, style: StrokeStyle(lineWidth: 1.8, dash: [92, 420], dashPhase: phase))
                    .opacity(min(1, pulseOpacity + 0.06))
                    .padding(SessionSlot.innerInset)
            }
            if mode == .asking {
                let breathe = 0.45 + 0.55 * abs(sin(Double(animFrame) * SessionSlot.pulseOmega))
                RoundedRectangle(cornerRadius: SessionSlot.innerCornerRadius, style: .continuous)
                    .strokeBorder(signalColor, lineWidth: 7)
                    .opacity(breathe * 0.6)
                    .blur(radius: 2.4)
                    .padding(SessionSlot.innerInset)
                RoundedRectangle(cornerRadius: SessionSlot.innerCornerRadius, style: .continuous)
                    .strokeBorder(signalColor, lineWidth: 3)
                    .opacity(0.97)
                    .padding(SessionSlot.innerInset)
            }

            // Agent watermark (bottom-right, mirrors the TS 72px logo at 92,80).
            agentWatermark
                .frame(width: 56, height: 56)
                .opacity(mode == .idle ? 0.62 : 0.55)
                .offset(x: (SessionSlot.size / 2) - 32, y: (SessionSlot.size / 2) - 34)

            // Top-right badge: teal RUN pill while working, bold amber PERM pill
            // while awaiting, faint ACT pill only when idle (TS badgeObj).
            if mode == .working {
                runBadge
                    .offset(x: 42, y: -50)
            }
            if mode == .asking {
                permBadge
                    .offset(x: 39, y: -50)
            }
            if mode == .idle {
                actBadge
                    .offset(x: 42, y: -50)
            }

            // Text baselines mirror the TS renderer. The 72px hardware profile
            // is rendered at 144px then downsampled, so it deliberately uses
            // larger source typography and an 8px-lower tool baseline.
            let stateFontSize: CGFloat = lowResolutionKey ? 18 : 17
            Text(stateLabelText)
                .font(.system(size: stateFontSize, weight: .heavy))
                .foregroundStyle(accentColorText)
                .frame(width: 104, alignment: .leading)
                .position(x: 72, y: SessionSlotText.centerY(svgBaseline: 32, fontSize: stateFontSize))

            let nameFontSize: CGFloat = lowResolutionKey ? 20 : 16
            ForEach(Array(nameLines.enumerated()), id: \.offset) { index, line in
                Text(line)
                    .font(.system(size: nameFontSize, weight: lowResolutionKey ? .bold : .semibold))
                    .foregroundStyle(Color(hex: "#E2E8F0"))
                    .frame(width: 104, alignment: .leading)
                    .position(
                        x: 72,
                        y: SessionSlotText.centerY(
                            svgBaseline: nameStartBaseline + CGFloat(index) * nameLineHeight,
                            fontSize: nameFontSize
                        )
                    )
            }

            let toolFontSize: CGFloat = lowResolutionKey ? 15 : (mode == .working ? 13 : 14)
            Text(toolText)
                .font(.system(size: toolFontSize, weight: .medium))
                .foregroundStyle(accentColorText.opacity(0.8))
                .frame(width: 104, alignment: .leading)
                .position(
                    x: 72,
                    y: SessionSlotText.centerY(
                        svgBaseline: lowResolutionKey ? 128 : 120,
                        fontSize: toolFontSize
                    )
                )
        }
        .frame(width: SessionSlot.size, height: SessionSlot.size)
    }

    // MARK: - Sub-views

    private var agentWatermark: some View {
        SessionCreatureIcon(
            agentType: agent,
            tint: SessionBrand.color(for: agent),
            size: 40
        )
    }

    /// Teal RUN pill (TS runBadge: 30×16 at x=99,y=14, dark text on signal).
    private var runBadge: some View {
        ZStack {
            Capsule()
                .fill(signalColor.opacity(0.9))
                .frame(width: 30, height: 16)
            Text("RUN")
                .font(.system(size: 9, weight: .heavy))
                .foregroundStyle(Color(hex: "#0C0C0E"))
        }
    }

    /// Bold amber PERM pill (TS askDot: 42×19 at x=90,y=12) — replaced the
    /// old 5px dot so "needs you" is legible at a glance.
    private var permBadge: some View {
        ZStack {
            Capsule()
                .fill(signalColor)
                .frame(width: 42, height: 19)
            Text("PERM")
                .font(.system(size: 11, weight: .heavy))
                .foregroundStyle(Color(hex: "#221500"))
        }
    }

    private var actBadge: some View {
        ZStack {
            Capsule()
                .fill(Color.white.opacity(0.1))
                .frame(width: 28, height: 16)
            Text("ACT")
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(Color(hex: "#A1A1AA"))
        }
    }
}

// MARK: - Text utilities

enum SessionSlotText {
    static func truncate(_ s: String, max: Int) -> String {
        s.count <= max ? s : String(s.prefix(max - 1)) + "\u{2026}"
    }

    /// Swift mirror of the TS renderer's space/camelCase wrapper.
    static func wrapSessionName(_ name: String, maxChars: Int, maxLines: Int = 4) -> [String] {
        if name.count <= maxChars { return [name] }
        var lines: [String] = []
        var remaining = name.trimmingCharacters(in: .whitespaces)

        while remaining.count > maxChars && lines.count < maxLines - 1 {
            let chars = Array(remaining)
            var breakpoints: [Int] = []
            for index in 1..<chars.count {
                let current = chars[index]
                let previous = chars[index - 1]
                if current == " " || (current.isUppercase && (previous.isLowercase || previous.isNumber)) {
                    breakpoints.append(index)
                }
            }
            let split = breakpoints.last(where: { $0 <= maxChars }) ?? maxChars
            lines.append(String(chars[..<split]).trimmingCharacters(in: .whitespaces))
            remaining = String(chars[split...]).trimmingCharacters(in: .whitespaces)
        }

        lines.append(
            remaining.count <= maxChars
                ? remaining
                : String(remaining.prefix(maxChars - 1)).trimmingCharacters(in: .whitespaces) + "\u{2026}"
        )
        return lines
    }

    /// SwiftUI positions text by its center; the TS SVG values are baselines.
    static func centerY(svgBaseline: CGFloat, fontSize: CGFloat) -> CGFloat {
        svgBaseline - fontSize * 0.35
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Session slot variants") {
    HStack(spacing: 16) {
        SessionSlotView(
            session: .init(
                id: "1", port: 9121, projectName: "AgentDeck",
                agentType: "claude-code", alive: true,
                state: "processing", modelName: "opus-4-7"
            ),
            animFrame: 20
        )
        SessionSlotView(
            session: .init(
                id: "2", port: 9122, projectName: "AgentDeck",
                agentType: "codex-cli", alive: true,
                state: "awaiting_permission", modelName: "gpt-5"
            ),
            animFrame: 15
        )
        SessionSlotView(
            session: .init(
                id: "3", port: 9123, projectName: "AgentDeck",
                agentType: "openclaw", alive: true,
                state: "idle", modelName: "router"
            )
        )
    }
    .padding()
    .background(Color.black)
}
#endif
