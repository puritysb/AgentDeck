// DeskPreviews.swift — Stream Deck+ session button and Ulanzi D200H mockups.
//
// The Stream Deck+ preview reuses the production SessionSlotRenderer so this
// is the highest-fidelity mockup in the catalog. The D200H previews consume
// D200HLayoutModel — the Swift port of the shared `buildSessionDeck` engine
// that drives the real device through the Ulanzi Studio plugin — so the slot
// arrangement (session tiles, usage gauges, OFFLINE hero, paging) is exactly
// what the hardware shows; only the per-tile pixel style is approximated.

import SwiftUI

// MARK: - Stream Deck Key

/// Single 72×72 Stream Deck key.
struct StreamDeckKeyPreview: View {
    let selection: DevicePreviewSelection

    private var session: SessionInfo {
        // Live-follow: render the real focused session verbatim.
        if let live = liveFocusedSession(selection) { return live }
        return SessionInfo(
            id: "preview-sd-key",
            port: 9120,
            projectName: selection.agent.displayName,
            agentType: selection.agent.rawValue,
            alive: true,
            state: selection.state.sessionStateStringForUI,
            modelName: modelName,
            startedAt: nil
        )
    }

    private var modelName: String {
        switch selection.agent {
        case .claudeCode:  return "opus-4-7"
        case .codex:       return "gpt-5"
        case .opencode:    return "router"
        case .openclaw:    return "router"
        case .antigravity: return "gemini-3"
        }
    }

    var body: some View {
        VStack(spacing: 14) {
            SessionSlotView(session: session, animFrame: selection.animationFrame)
                .scaleEffect(0.5)
                .frame(width: 72, height: 72)
                .shadow(color: .black.opacity(0.4), radius: 6, y: 3)
            Text("Stream Deck • 72×72")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - Stream Deck+

/// Single 144×144 Stream Deck+ key driven by the real SessionSlotView.
struct StreamDeckPlusPreview: View {
    let selection: DevicePreviewSelection

    private var session: SessionInfo {
        // Live-follow: render the real focused session verbatim.
        if let live = liveFocusedSession(selection) { return live }
        return SessionInfo(
            id: "preview-sd",
            port: 9120,
            projectName: selection.agent.displayName,
            agentType: selection.agent.rawValue,
            alive: true,
            state: selection.state.sessionStateStringForUI,
            modelName: modelName,
            startedAt: nil
        )
    }

    private var modelName: String {
        switch selection.agent {
        case .claudeCode:  return "opus-4-7"
        case .codex:       return "gpt-5"
        case .opencode:    return "router"
        case .openclaw:    return "router"
        case .antigravity: return "gemini-3"
        }
    }

    var body: some View {
        VStack(spacing: 14) {
            SessionSlotView(session: session, animFrame: selection.animationFrame)
                .shadow(color: .black.opacity(0.4), radius: 8, y: 4)
            Text("Stream Deck+ • 144×144")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

/// The live focused session (or the first live session) for single-tile
/// previews, or nil in manual mode / when no sessions are live. Returned
/// `SessionInfo` values are the daemon's real sessions, so the SessionSlotView
/// renders the true project name, model, and state.
private func liveFocusedSession(_ selection: DevicePreviewSelection) -> SessionInfo? {
    guard let live = selection.live else { return nil }
    if let fid = live.focusedSessionId,
       let match = live.sessions.first(where: { $0.id == fid }) {
        return match
    }
    return live.sessions.first
}

// MARK: - D200H layout input (shared by key + deck previews)

private func d200hDeckSlots(for selection: DevicePreviewSelection) -> [D200HKeySlot] {
    // Live-follow: feed the daemon's real sessions + usage straight into the
    // shared layout engine — a true emulator frame (real project names, models,
    // states, and usage %), identical to what the Ulanzi plugin drives onto the
    // physical D200H. Falls through to the synthetic sample when not following.
    if let input = liveD200HInput(for: selection) {
        return D200HLayoutModel.buildSessionDeck(input, view: D200HDeckView(mode: .list))
    }

    let agents = selection.previewAgents
    let sessions = agents.enumerated().map { index, agent in
        D200HSession(
            id: "preview-\(index)",
            agentType: agent.rawValue,
            state: selection.previewState(for: index).sessionStateStringForUI,
            projectName: "\(agent.displayName.lowercased())-project",
            modelName: index == 0 ? "opus-4-7" : nil,
            options: selection.previewState(for: index) == .awaitingPrompt
                ? [D200HOption(label: "Allow", shortcut: "y"), D200HOption(label: "Deny", shortcut: "n")]
                : []
        )
    }
    // Usage tiles are hide-if-absent in the layout engine (TS 208b1afc), so the
    // sample usage follows the session mix: Claude quota when a Claude session
    // is present (or the daemon idles with no sessions), Codex windows only
    // when a Codex session is. Lets the preview show the freed-slot reflow.
    let hasClaude = agents.isEmpty || agents.contains(.claudeCode)
    let hasCodex = agents.contains(.codex)
    let input = D200HDeckInput(
        state: sessions.isEmpty ? "disconnected" : selection.state.sessionStateStringForUI,
        sessions: sessions,
        usage: D200HUsage(
            fiveHourPercent: hasClaude ? 42 : nil,
            sevenDayPercent: hasClaude ? 68 : nil,
            codexPrimaryPercent: hasCodex ? 23 : nil,
            codexPrimaryWindowMinutes: hasCodex ? 300 : nil,
            codexSecondaryPercent: hasCodex ? 51 : nil,
            codexSecondaryWindowMinutes: hasCodex ? 10080 : nil
        )
    )
    return D200HLayoutModel.buildSessionDeck(input, view: D200HDeckView(mode: .list))
}

/// Build the D200H layout input from the live daemon snapshot, or nil when the
/// preview is in manual (toolbar) mode. Maps each real `SessionInfo` to a
/// `D200HSession` (only the focused session carries its live prompt options)
/// and forwards the real usage windows verbatim.
/// Internal (not private) so the snapshot test can assert the mapping.
func liveD200HInput(for selection: DevicePreviewSelection) -> D200HDeckInput? {
    guard let live = selection.live else { return nil }
    let sessions = live.sessions.map { s -> D200HSession in
        let opts = s.id == live.focusedSessionId
            ? live.focusedOptions.map { D200HOption(label: $0.label, shortcut: $0.shortcut) }
            : []
        return D200HSession(
            id: s.id,
            agentType: s.agentType ?? "claude-code",
            state: s.state ?? "idle",
            projectName: s.projectName ?? "",
            modelName: s.modelName,
            currentTool: s.currentTool,
            startedAt: s.startedAt,
            weight: s.weight,  // --weight pin must reach the preview's sort/fold mirror
            options: opts,
            groupSize: s.groupSize,
            foldedSessionIds: s.foldedSessionIds
        )
    }
    return D200HDeckInput(
        state: live.topLevelState,
        sessions: sessions,
        usage: D200HUsage(
            fiveHourPercent: live.fiveHourPercent,
            sevenDayPercent: live.sevenDayPercent,
            known: live.usageKnown,
            codexPrimaryPercent: live.codexPrimaryPercent,
            codexPrimaryWindowMinutes: live.codexPrimaryWindowMinutes,
            codexPrimaryStale: live.codexPrimaryStale,
            codexSecondaryPercent: live.codexSecondaryPercent,
            codexSecondaryWindowMinutes: live.codexSecondaryWindowMinutes,
            codexSecondaryStale: live.codexSecondaryStale,
            codexCapturedAt: live.codexCapturedAt
        ),
        focusedSessionId: live.focusedSessionId,
        navigable: live.navigable
    )
}

// MARK: - D200H Key

/// One of the D200H's 120×120 key tiles — the first session slot exactly as
/// the layout engine assigns it.
struct D200HKeyPreview: View {
    let selection: DevicePreviewSelection

    private var slot: D200HKeySlot? {
        d200hDeckSlots(for: selection).first {
            if case .session = $0.kind { return true }
            if case .offlineHero = $0.kind { return true }
            return false
        }
    }

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(cornerRadius: 12, bezelWidth: 6) {
                if let slot {
                    D200HSlotTile(slot: slot, size: 116)
                }
            }
            .frame(width: 140, height: 140)
            Text("D200H key • 120×120")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - D200H Full Deck

/// The full D200H 5×3 key grid, computed by D200HLayoutModel.buildSessionDeck —
/// session tiles sorted/labelled by the engine, the pinned Claude/Codex 5H/7D
/// usage-gauge block, and the OFFLINE brand-mark hero when the list is empty.
struct D200HDeckPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        let slots = d200hDeckSlots(for: selection)
        VStack(spacing: 12) {
            DeviceBezel(cornerRadius: 22, bezelWidth: 16) {
                VStack(spacing: 6) {
                    ForEach(0..<D200HLayoutModel.gridRows, id: \.self) { row in
                        HStack(spacing: 6) {
                            ForEach(0..<D200HLayoutModel.gridCols, id: \.self) { col in
                                let idx = row * D200HLayoutModel.gridCols + col
                                if idx < slots.count {
                                    D200HSlotTile(slot: slots[idx], size: 58)
                                }
                            }
                        }
                    }
                }
            }
            .frame(width: 380, height: 260)
            Text("Ulanzi D200H • 5×3 keys + 2 encoders")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - D200H slot tile renderer

/// Maps a layout-engine slot to its visual. Style approximates the Node SVG
/// renderers (session-slot / usage-gauge / info) — the ARRANGEMENT is exact.
private struct D200HSlotTile: View {
    let slot: D200HKeySlot
    var size: CGFloat = 58

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.10, style: .continuous)
                .fill(background)
            content
        }
        .frame(width: size, height: size)
    }

    private var background: Color {
        switch slot.kind {
        case .session(_, let state, _):
            return StateColors.color(for: state).opacity(0.16)
        case .offlineHero, .info:
            return Color.black.opacity(0.5)
        case .usageGauge:
            return Color.black.opacity(0.42)
        case .empty:
            return Color.white.opacity(0.04)
        default:
            return Color.black.opacity(0.35)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch slot.kind {
        case .session(let agentType, let state, let stateLabel):
            VStack(spacing: size * 0.03) {
                CanonicalCreatureView(
                    agentType: agentType,
                    size: size * 0.40,
                    color: StateColors.brand(agent: agentType)
                )
                Text(slot.label)
                    .font(.system(size: size * 0.11, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineLimit(1)
                Text(stateLabel)
                    .font(.system(size: size * 0.10, weight: .heavy, design: .monospaced))
                    .foregroundStyle(StateColors.color(for: state))
                    .lineLimit(1)
                // Model alias / "Running task" line — the real renderSessionSlot
                // draws this third line; dropping it hid the model on every tile.
                if let subtitle = slot.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: size * 0.09, design: .monospaced))
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)
                }
            }
            .padding(size * 0.05)
        case .offlineHero:
            VStack(spacing: size * 0.05) {
                AgentDeckLogo(size: size * 0.36, color: .white.opacity(0.9))
                Text(slot.label)
                    .font(.system(size: size * 0.12, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.85))
                // "Open AgentDeck" — the real brand info slot shows this hint.
                if let subtitle = slot.subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.system(size: size * 0.09))
                        .foregroundStyle(.white.opacity(0.55))
                        .lineLimit(1)
                }
            }
        case .usageGauge(let agent, _, let percent, let known, let stale, let inactive, let footnote):
            // Mirrors renderUsageGauge (d200h-layout.ts): a vertical water-tank
            // fill rising from the bottom (severity ramp, 0.38 tint + crisp
            // level line), window label top-left, brand mark top-right, big %
            // centered. NO "CLAUDE/CODEX" text prefix — identity rides the
            // brand mark, not a label.
            ZStack {
                if known {
                    GeometryReader { geo in
                        // An aged snapshot dims exactly like an expired window —
                        // neither number is current — but keeps its own footnote.
                        let dim = stale || (footnote?.isEmpty == false)
                        let ramp = gaugeColor(percent: percent, known: true, stale: dim, inactive: inactive)
                        let fillH = geo.size.height * min(1, max(0, percent / 100))
                        VStack(spacing: 0) {
                            Spacer(minLength: 0)
                            Rectangle().fill(ramp).frame(height: 1.5)
                            Rectangle().fill(ramp.opacity(dim ? 0.22 : 0.38))
                                .frame(height: max(0, fillH - 1.5))
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.10, style: .continuous))
                }
                VStack(spacing: 0) {
                    HStack(alignment: .top) {
                        Text(slot.label)
                            .font(.system(size: size * 0.15, weight: .bold, design: .monospaced))
                            .foregroundStyle(known && !stale && footnote == nil ? .white : .white.opacity(0.45))
                        Spacer(minLength: 0)
                        CanonicalCreatureView(
                            agentType: agent == "codex" ? "codex-cli" : "claude-code",
                            size: size * 0.18,
                            color: StateColors.brand(agent: agent == "codex" ? "codex-cli" : "claude-code")
                                .opacity(known ? 1 : 0.45)
                        )
                    }
                    Spacer(minLength: 0)
                    Text(known ? "\(Int(percent))%" : "—")
                        .font(.system(size: size * 0.22, weight: .heavy))
                        .foregroundStyle(known && !stale && footnote == nil ? .white : .white.opacity(0.45))
                    if let note = footnote ?? (stale ? "stale" : nil) {
                        Text(note)
                            .font(.system(size: size * 0.09, weight: .bold))
                            .foregroundStyle(.white.opacity(0.45))
                    }
                    Spacer(minLength: 0)
                }
                .padding(size * 0.08)
            }
        case .info(_, _):
            Text(slot.label)
                .font(.system(size: size * 0.11, weight: .semibold))
                .foregroundStyle(.white.opacity(0.7))
                .multilineTextAlignment(.center)
                .padding(size * 0.06)
        case .nextPage:
            VStack(spacing: 2) {
                Image(systemName: "ellipsis")
                    .foregroundStyle(.white.opacity(0.75))
                Text(slot.label)
                    .font(.system(size: size * 0.11, weight: .bold, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.7))
            }
        case .empty:
            EmptyView()
        default:
            Text(slot.label)
                .font(.system(size: size * 0.11, weight: .bold, design: .monospaced))
                .foregroundStyle(.white.opacity(0.7))
                .lineLimit(2)
        }
    }

    /// Severity ramp — port of `usageRampColor` (d200h-layout.ts): >80 red,
    /// >50 amber, else green; stale desaturates to slate.
    private func gaugeColor(percent: Double, known: Bool, stale: Bool = false, inactive: Bool = false) -> Color {
        guard known else { return .white.opacity(0.4) }
        if stale { return Color(red: 0x64 / 255.0, green: 0x74 / 255.0, blue: 0x8B / 255.0) }
        // Inactive per-model scoped cap: informational cyan (UI.cyan #3ED6E8),
        // never the critical ramp regardless of percent (issue #99).
        if inactive { return Color(red: 0x3E / 255.0, green: 0xD6 / 255.0, blue: 0xE8 / 255.0) }
        if percent > 80 { return Color(red: 0xEF / 255.0, green: 0x44 / 255.0, blue: 0x44 / 255.0) }
        if percent > 50 { return Color(red: 0xEA / 255.0, green: 0xB3 / 255.0, blue: 0x08 / 255.0) }
        return Color(red: 0x22 / 255.0, green: 0xC5 / 255.0, blue: 0x5E / 255.0)
    }
}
