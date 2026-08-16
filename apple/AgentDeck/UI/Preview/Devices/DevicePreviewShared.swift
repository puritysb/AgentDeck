// DevicePreviewShared.swift — Small helpers reused across Device Preview mockups.
//
// Most non-Pixoo / non-Terrarium devices in the catalog are framed by a simple
// rounded-rectangle "bezel" with placeholder content (creature + state dot + a
// short HUD line). Rather than porting LVGL / Compose / Kobo epd code to Swift
// just for previews, we keep each mockup pragmatic: the *shape* of the device
// is accurate, but the interior is a schematic.
//
// These helpers centralise the bezel, the creature-in-a-circle, the state dot,
// and a tiny HUD row so each per-device View stays under ~60 LOC.

import SwiftUI

// MARK: - Bezel

/// A rounded "device body" outline. Callers supply an aspect ratio and place
/// content in the closure. Thickness is the bezel wall; content fills the inner
/// rounded rect.
struct DeviceBezel<Content: View>: View {
    let cornerRadius: CGFloat
    let bezelWidth: CGFloat
    let bezelColor: Color
    let screenColor: Color
    @ViewBuilder var content: () -> Content

    init(
        cornerRadius: CGFloat = 18,
        bezelWidth: CGFloat = 14,
        bezelColor: Color = Color(white: 0.08),
        screenColor: Color = Color(white: 0.05),
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.cornerRadius = cornerRadius
        self.bezelWidth = bezelWidth
        self.bezelColor = bezelColor
        self.screenColor = screenColor
        self.content = content
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(bezelColor)
            RoundedRectangle(cornerRadius: max(2, cornerRadius - bezelWidth * 0.5), style: .continuous)
                .fill(screenColor)
                .padding(bezelWidth)
            content()
                .padding(bezelWidth + 4)
        }
    }
}

// MARK: - Creature placeholder

/// Agent creature rendered in the agent brand colour inside a soft disc.
/// Draws the CANONICAL aquarium creature (CreatureGeometry SSOT — robot,
/// cloud+`>_`, ring, crayfish) — the same silhouette the real ESP32 /
/// Android / e-ink devices raster — so previews cannot drift into showing
/// a brand logo where hardware shows a swimming creature.
struct PreviewCreature: View {
    let agent: PixooPreviewAgent
    let state: PixooPreviewState
    var size: CGFloat = 64

    private var tint: Color { StateColors.brand(agent: agent.rawValue) }

    var body: some View {
        ZStack {
            Circle()
                .fill(tint.opacity(0.15))
            CanonicalCreatureView(
                agentType: agent.rawValue,
                size: size * 0.76,
                color: tint
            )
        }
        .frame(width: size, height: size)
        .opacity(state == .disconnected ? 0.35 : 1.0)
        .accessibilityLabel("\(agent.displayName) \(state.displayName)")
    }
}

/// Bare creature glyph used inside realistic device mockups. Unlike
/// `PreviewCreature`, this has no circular badge, so tablet/e-ink previews
/// read like the actual screens rather than a single oversized avatar.
/// Renders the canonical CreatureGeometry creature, not the brand mark.
struct PreviewCreatureGlyph: View {
    let agent: PixooPreviewAgent
    let state: PixooPreviewState
    var size: CGFloat = 40
    var tintOverride: Color? = nil

    private var tint: Color { tintOverride ?? StateColors.brand(agent: agent.rawValue) }

    var body: some View {
        CanonicalCreatureView(
            agentType: agent.rawValue,
            size: size,
            color: tint
        )
        .opacity(state == .disconnected ? 0.3 : 1.0)
        .accessibilityLabel("\(agent.displayName) \(state.displayName)")
    }
}

// Internal bridge: map PixooPreviewState to the canonical lowercase state key
// used by StateColors.color(for:). Keeps the mapping in one place.
extension PixooPreviewState {
    var sessionStateStringForUI: String {
        switch self {
        case .idle:           return "idle"
        case .processing:     return "processing"
        case .awaitingPrompt: return "awaiting_permission"
        case .disconnected:   return "disconnected"
        }
    }
}

extension DevicePreviewSelection {
    var previewAgents: [PixooPreviewAgent] {
        guard sessionCount > 0 else { return [] }
        let palette: [PixooPreviewAgent] = [agent, .claudeCode, .codex, .opencode, .openclaw]
        var unique: [PixooPreviewAgent] = []
        for entry in palette where !unique.contains(entry) {
            unique.append(entry)
        }
        return Array(unique.prefix(max(1, sessionCount)))
    }

    func previewState(for index: Int) -> PixooPreviewState {
        index == 0 ? state : .idle
    }
}

// MARK: - Live-aware display accessors
//
// Schematic previews (InkDeck, ESP32 boards, tablets) render a list of sessions
// and a usage band. In live-follow mode these accessors return the daemon's
// REAL sessions/usage — actual project names, models, states, and usage % — so
// the preview becomes an emulator; in manual mode they synthesize the exact same
// placeholders those previews have always shown, so the toolbar look is
// unchanged. (The Pixoo pipeline + D200H consume `live` directly instead.)

/// One session as a schematic preview wants to draw it.
struct PreviewDisplaySession: Identifiable {
    let id: String
    var agent: PixooPreviewAgent
    var projectName: String
    var modelName: String?
    var state: PixooPreviewState
    /// Active subagents under this session. The firmware draws them as
    /// decorative activity owned by the parent — a static miniature orbit on
    /// e-ink, perimeter satellite pixels on the LED matrix — never as another
    /// session. Zero means "draw nothing", not "unknown".
    var subagentCount: Int = 0
}

/// One usage provider row (0…1 fractions) for the usage band.
struct PreviewDisplayUsageRow: Identifiable {
    var agent: PixooPreviewAgent
    var label: String   // "CLAUDE" / "CODEX"
    var plan: String    // "Max 20x" / "Plus"
    var p5: Double       // 5h window, 0…1
    var p7: Double       // 7d window, 0…1
    var id: String { label }
}

extension PixooPreviewAgent {
    /// Map a daemon `agentType` string to a preview agent (codex-app folds into
    /// codex; unknown → Claude). Mirrors `DevicePreviewScreen.liveSelectionInputs`.
    static func from(agentType: String?) -> PixooPreviewAgent {
        switch agentType {
        case "codex-cli", "codex-app": return .codex
        case "opencode":               return .opencode
        case "openclaw":               return .openclaw
        case "antigravity":            return .antigravity
        case "kiro-cli", "kiro-ide": return .kiro
        default:                       return .claudeCode
        }
    }
}

extension PixooPreviewState {
    /// Map a daemon session-state string to the coarse preview state bucket.
    static func from(sessionState: String?) -> PixooPreviewState {
        switch sessionState {
        case "processing":   return .processing
        case "disconnected": return .disconnected
        case let s? where s.hasPrefix("awaiting"): return .awaitingPrompt
        default:             return .idle
        }
    }
}

extension DevicePreviewSelection {
    /// Sessions to render: the real daemon sessions in live-follow mode, else
    /// the synthetic palette with the `<agent>-project` labels the schematic
    /// previews already used.
    var displaySessions: [PreviewDisplaySession] {
        if let live {
            return live.sessions.map { s in
                PreviewDisplaySession(
                    id: s.id,
                    agent: PixooPreviewAgent.from(agentType: s.agentType),
                    projectName: (s.projectName?.isEmpty == false) ? s.projectName! : "session",
                    modelName: s.modelName,
                    state: PixooPreviewState.from(sessionState: s.state),
                    // Live subagent counts live in TimelineStore, not in the
                    // DashboardState this snapshot is built from, so live-follow
                    // draws no satellites yet. Plumbing them through
                    // LivePreviewData is a separate change; leaving it at 0 is
                    // honest (nothing drawn) rather than invented.
                    subagentCount: 0
                )
            }
        }
        return previewAgents.enumerated().map { index, agent in
            PreviewDisplaySession(
                id: "preview-\(index)",
                agent: agent,
                projectName: "\(agent.displayName.lowercased())-project",
                modelName: nil,
                state: previewState(for: index),
                // One busy session carries children so the mirrored orbit and
                // satellites actually render in the gallery — a preview that
                // never exercises the element cannot show it drifted.
                subagentCount: index == 1 ? 2 : 0
            )
        }
    }

    /// Usage provider rows for the schematic usage band. Real windows in
    /// live-follow mode (hide-if-absent), else the placeholder gauges.
    var displayUsageRows: [PreviewDisplayUsageRow] {
        if let live {
            guard live.topLevelState != "disconnected" else { return [] }
            var rows: [PreviewDisplayUsageRow] = []
            if live.usageKnown, live.fiveHourPercent != nil || live.sevenDayPercent != nil {
                rows.append(PreviewDisplayUsageRow(
                    agent: .claudeCode, label: "CLAUDE", plan: "Max 20x",
                    p5: (live.fiveHourPercent ?? 0) / 100, p7: (live.sevenDayPercent ?? 0) / 100))
            }
            if live.codexPrimaryPercent != nil || live.codexSecondaryPercent != nil {
                rows.append(PreviewDisplayUsageRow(
                    agent: .codex, label: "CODEX", plan: "Plus",
                    p5: (live.codexPrimaryPercent ?? 0) / 100, p7: (live.codexSecondaryPercent ?? 0) / 100))
            }
            return rows
        }
        guard state != .disconnected else { return [] }
        let agents = previewAgents
        var rows: [PreviewDisplayUsageRow] = []
        if agents.isEmpty || agents.contains(.claudeCode) {
            rows.append(PreviewDisplayUsageRow(agent: .claudeCode, label: "CLAUDE", plan: "Max 20x", p5: 0.42, p7: 0.68))
        }
        if agents.contains(.codex) {
            rows.append(PreviewDisplayUsageRow(agent: .codex, label: "CODEX", plan: "Plus", p5: 0.23, p7: 0.51))
        }
        return rows
    }
}

// MARK: - Status dot + HUD row

struct PreviewStateDot: View {
    let state: PixooPreviewState
    var size: CGFloat = 10

    var body: some View {
        Circle()
            .fill(StateColors.color(for: state.sessionStateStringForUI))
            .frame(width: size, height: size)
            .overlay(
                Circle()
                    .strokeBorder(Color.white.opacity(0.35), lineWidth: 0.5)
            )
    }
}

struct PreviewHUD: View {
    let agent: PixooPreviewAgent
    let state: PixooPreviewState
    let sessionCount: Int
    var compact: Bool = false

    private var primary: String {
        switch state {
        case .idle:           return "IDLE"
        case .processing:     return "RUNNING"
        case .awaitingPrompt: return "PERMIT?"
        case .disconnected:   return "OFFLINE"
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            PreviewStateDot(state: state, size: compact ? 6 : 9)
            Text(primary)
                .font(.system(size: compact ? 9 : 11, weight: .heavy, design: .monospaced))
                .foregroundStyle(StateColors.color(for: state.sessionStateStringForUI))
            Spacer(minLength: 4)
            Text("\(sessionCount)·\(agent.displayName.prefix(3).uppercased())")
                .font(.system(size: compact ? 9 : 10, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Tiny creature grid (for deck/tablet schematics)

/// A compact 4-cell session grid used by the schematic deck and tablet
/// previews. Each cell is a small brand-coloured square with a state dot.
struct PreviewSessionTile: View {
    let agent: PixooPreviewAgent
    let state: PixooPreviewState
    var size: CGFloat = 48

    var body: some View {
        let tint = StateColors.brand(agent: agent.rawValue)
        return ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(tint.opacity(0.18))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(tint.opacity(0.5), lineWidth: 1)
                )
            PreviewCreatureGlyph(agent: agent, state: state, size: size * 0.54)
                .padding(4)
            PreviewStateDot(state: state, size: 5)
                .padding(4)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Realistic preview building blocks

struct PreviewMiniSessionList: View {
    let selection: DevicePreviewSelection
    var dark: Bool = true
    var compact: Bool = false

    var body: some View {
        // Live-follow → real sessions (project name + model state); manual → the
        // synthesized `<agent>-project` palette. Project-name primary matches
        // the real device (and InkDeck / D200H).
        let sessions = selection.displaySessions
        return VStack(alignment: .leading, spacing: compact ? 3 : 4) {
            Text("SESSIONS")
                .font(.system(size: compact ? 7 : 8, weight: .heavy, design: .monospaced))
                .foregroundStyle(labelColor.opacity(0.72))
            if sessions.isEmpty {
                Text("NO SESSIONS")
                    .font(.system(size: compact ? 7 : 8, design: .monospaced))
                    .foregroundStyle(labelColor.opacity(0.52))
            } else {
                ForEach(Array(sessions.enumerated()), id: \.offset) { index, session in
                    HStack(spacing: compact ? 3 : 4) {
                        PreviewCreatureGlyph(
                            agent: session.agent,
                            state: session.state,
                            size: compact ? 12 : 14,
                            tintOverride: dark ? nil : .black.opacity(index == 0 ? 0.86 : 0.55)
                        )
                        VStack(alignment: .leading, spacing: 0) {
                            Text(session.projectName)
                                .font(.system(size: compact ? 7 : 9, weight: index == 0 ? .semibold : .regular))
                                .lineLimit(1)
                            Text(session.state.displayName.uppercased())
                                .font(.system(size: compact ? 6 : 7, design: .monospaced))
                                .foregroundStyle(rowStateColor(session.state, index: index))
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(labelColor.opacity(index == 0 ? 0.95 : 0.68))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(compact ? 5 : 7)
        .background(
            RoundedRectangle(cornerRadius: dark ? 8 : 3)
                .fill(dark ? Color.black.opacity(0.44) : Color.black.opacity(0.045))
        )
    }

    private var labelColor: Color { dark ? .white : .black }

    private func rowStateColor(_ state: PixooPreviewState, index: Int) -> Color {
        dark
            ? StateColors.color(for: state.sessionStateStringForUI)
            : .black.opacity(index == 0 ? 0.7 : 0.45)
    }
}

struct PreviewTopologyMini: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("UPSTREAM")
                .font(.system(size: 8, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.56))
            topologyRow("Claude", active: selection.agent == .claudeCode)
            topologyRow("Codex", active: selection.agent == .codex)
            topologyRow("OpenClaw", active: selection.agent == .openclaw)

            Rectangle()
                .fill(TerrariumColors.tetraNeon.opacity(0.55))
                .frame(height: 1)
                .padding(.vertical, 2)

            HStack(spacing: 4) {
                AgentDeckLogo(size: 13, color: TerrariumColors.tetraNeon)
                Text("AgentDeck")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
            }
            .foregroundStyle(.white.opacity(0.9))

            Text("DOWNSTREAM")
                .font(.system(size: 8, weight: .heavy, design: .monospaced))
                .foregroundStyle(.white.opacity(0.56))
                .padding(.top, 2)
            topologyRow("This device", active: selection.sessionCount > 0)
        }
        .padding(7)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.black.opacity(0.44))
        )
    }

    private func topologyRow(_ text: String, active: Bool) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(active ? TerrariumHUD.ledGreen : Color.white.opacity(0.22))
                .frame(width: 5, height: 5)
            Text(text)
                .font(.system(size: 8, design: .monospaced))
                .lineLimit(1)
            Spacer(minLength: 0)
        }
        .foregroundStyle(.white.opacity(active ? 0.86 : 0.48))
    }
}

struct PreviewAquariumScene: View {
    let selection: DevicePreviewSelection
    var showBottomHUD: Bool = true

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [TerrariumColors.deepSea, TerrariumColors.midWater, TerrariumColors.shallowWater],
                startPoint: .top,
                endPoint: .bottom
            )

            GeometryReader { geo in
                ForEach(0..<5, id: \.self) { i in
                    Capsule()
                        .fill(Color.white.opacity(0.045))
                        .frame(width: geo.size.width * 0.12, height: geo.size.height * 0.95)
                        .rotationEffect(.degrees(-16))
                        .offset(x: geo.size.width * (0.08 + CGFloat(i) * 0.19), y: -geo.size.height * 0.12)
                }

                ForEach(0..<6, id: \.self) { i in
                    RoundedRectangle(cornerRadius: 2)
                        .fill(TerrariumHUD.ledGreen.opacity(0.34))
                        .frame(width: 3, height: geo.size.height * CGFloat(0.16 + Double(i % 3) * 0.05))
                        .offset(x: geo.size.width * CGFloat(0.08 + Double(i) * 0.16), y: geo.size.height * 0.78)
                }

                ForEach(Array(selection.displaySessions.enumerated()), id: \.offset) { index, session in
                    let position = creaturePosition(index)
                    let creatureState = session.state
                    PreviewCreatureGlyph(
                        agent: session.agent,
                        state: creatureState,
                        size: min(max(min(geo.size.width, geo.size.height) * 0.16, 24), 52)
                    )
                    .scaleEffect(creatureState == .processing ? 1.06 : 1.0)
                    .position(x: geo.size.width * position.x, y: geo.size.height * position.y)
                }
            }

            if showBottomHUD {
                VStack {
                    Spacer()
                    PreviewHUD(
                        agent: selection.agent,
                        state: selection.state,
                        sessionCount: selection.sessionCount,
                        compact: true
                    )
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.black.opacity(0.38))
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private func creaturePosition(_ index: Int) -> (x: CGFloat, y: CGFloat) {
        let points: [(CGFloat, CGFloat)] = [
            (0.46, 0.48),
            (0.64, 0.34),
            (0.31, 0.38),
            (0.70, 0.62),
        ]
        let p = points[index % points.count]
        return (p.0, p.1)
    }
}

struct PreviewTimelineMini: View {
    let selection: DevicePreviewSelection
    var dark: Bool = true
    var compact: Bool = false

    private var rows: [String] {
        if selection.sessionCount == 0 { return ["waiting for bridge"] }
        switch selection.state {
        case .idle:
            return ["idle · ready", "last turn complete"]
        case .processing:
            return ["tool · editing files", "response streaming", "usage gauge updated"]
        case .awaitingPrompt:
            return ["permission requested", "option list available"]
        case .disconnected:
            return ["device offline", "state cache cleared"]
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 2 : 3) {
            Text("TIMELINE")
                .font(.system(size: compact ? 7 : 8, weight: .heavy, design: .monospaced))
                .foregroundStyle(foreground.opacity(dark ? 0.58 : 0.62))
            ForEach(rows.prefix(compact ? 2 : 3), id: \.self) { row in
                HStack(spacing: 3) {
                    Circle()
                        .fill(StateColors.color(for: selection.state.sessionStateStringForUI).opacity(dark ? 0.9 : 0.72))
                        .frame(width: compact ? 3 : 4, height: compact ? 3 : 4)
                    Text(row)
                        .font(.system(size: compact ? 6 : 7, design: .monospaced))
                        .lineLimit(1)
                }
                .foregroundStyle(foreground.opacity(dark ? 0.78 : 0.66))
            }
        }
    }

    private var foreground: Color { dark ? .white : .black }
}
