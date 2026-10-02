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
        case .kiro:        return "auto"
        }
    }

    var body: some View {
        VStack(spacing: 14) {
            SessionSlotView(
                session: session,
                animFrame: selection.animationFrame,
                lowResolutionKey: true
            )
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
        case .kiro:        return "auto"
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
            scopedLimits: (live.source.scopedLimits ?? []).map {
                D200HScopedLimit(label: $0.label, percent: $0.percent, active: $0.active == true)
            },
            codexPrimaryPercent: live.codexPrimaryPercent,
            codexPrimaryWindowMinutes: live.codexPrimaryWindowMinutes,
            codexPrimaryStale: live.codexPrimaryStale,
            codexSecondaryPercent: live.codexSecondaryPercent,
            codexSecondaryWindowMinutes: live.codexSecondaryWindowMinutes,
            codexSecondaryStale: live.codexSecondaryStale,
            codexCapturedAt: live.codexCapturedAt,
            zaiPrimaryPercent: live.source.zaiRateLimits?.primary?.usedPercent,
            zaiPrimaryWindowMinutes: live.source.zaiRateLimits?.primary?.windowMinutes,
            zaiPrimaryStale: live.source.zaiRateLimits?.primary?.stale == true,
            zaiPrimaryIsMcp: live.source.zaiRateLimits?.primary?.quantity == "mcp",
            zaiSecondaryPercent: live.source.zaiRateLimits?.secondary?.usedPercent,
            zaiSecondaryWindowMinutes: live.source.zaiRateLimits?.secondary?.windowMinutes,
            zaiSecondaryStale: live.source.zaiRateLimits?.secondary?.stale == true,
            zaiSecondaryIsMcp: live.source.zaiRateLimits?.secondary?.quantity == "mcp",
            zaiCapturedAt: live.source.zaiRateLimits?.capturedAt,
            // The fallbacks that replace an exhausted Codex window, pre-gated
            // by the same shared rules the device applies (the layout mirror
            // re-checks them against the windows above).
            lunaReserve: live.source.codexRateLimits?.activeLunaReserve().map {
                D200HLunaReserve(usedPercent: $0.usedPercent, resetsAt: $0.resetsAt,
                                 regularResetsAt: $0.regularResetsAt, available: $0.available)
            },
            codexCreditBalance: live.source.codexRateLimits?.activeCodexCredits()?.balance ?? -1
        ),
        focusedSessionId: live.focusedSessionId,
        navigable: live.navigable
    )
}

/// Mirrors `creditCoinSvg` (shared/src/svg-renderers/usage-reserve-marks.ts):
/// three stacked coins — rim band, bottom face, outlined top face — with an
/// inner ring on the top coin. Drawn in the crescent's box so the credit and
/// Luna tiles read as peers.
struct PreviewCreditCoinStack: View {
    let fill: Color
    let rim: Color

    var body: some View {
        Canvas { context, canvas in
            let rx = canvas.width / 2
            let ry = max(2, rx * 0.36)
            let step = max(2, rx * 0.42)
            let stroke = max(1, rx * 0.1)
            let cx = canvas.width / 2
            // Vertically centre the stack: from top face (bottom − 2·step − ry)
            // to the lowest face (bottom + step + ry).
            let bottom = canvas.height / 2 + step / 2
            for i in 0..<3 {
                let y = bottom - CGFloat(i) * step
                context.fill(Path(CGRect(x: cx - rx, y: y, width: rx * 2, height: step)), with: .color(fill))
                context.fill(Path(ellipseIn: CGRect(x: cx - rx, y: y + step - ry, width: rx * 2, height: ry * 2)), with: .color(fill))
                let face = Path(ellipseIn: CGRect(x: cx - rx, y: y - ry, width: rx * 2, height: ry * 2))
                context.fill(face, with: .color(fill))
                context.stroke(face, with: .color(rim), lineWidth: stroke)
            }
            let top = bottom - 2 * step
            let irx = rx * 0.62, iry = max(1, ry * 0.55)
            context.stroke(Path(ellipseIn: CGRect(x: cx - irx, y: top - iry, width: irx * 2, height: iry * 2)),
                           with: .color(rim), lineWidth: stroke)
        }
    }
}

// MARK: - D200H Key

/// One of the D200H's 120×120 key tiles — the first session slot exactly as
/// the layout engine assigns it.
struct D200HKeyPreview: View {
    let selection: DevicePreviewSelection

    private var slot: D200HKeySlot? {
        d200hDeckSlots(for: selection).first {
            if case .session = $0.kind { return true }
            if case .offlineGrid = $0.kind { return true }
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
        case .offlineGrid(_, _, _, _), .info:
            return Color.black.opacity(0.5)
        case .usageGauge, .lunaReserve, .codexCredits:
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
        case .offlineGrid(let col, let row, let cols, let rows):
            D200HOfflineGridFragment(
                col: col, row: row, cols: cols, rows: rows,
                label: slot.label, subtitle: slot.subtitle ?? "",
                size: size
            )
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
                        PreviewUsageMark(
                            agentType: agent == "codex" ? "codex-cli" : (agent == "claude" ? "claude-code" : agent),
                            size: size * 0.18,
                            color: SessionBrand.color(for: agent == "codex" ? "codex-cli" : (agent == "claude" ? "claude-code" : agent))
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
        case .lunaReserve(let remainingPercent, let active):
            // Mirrors renderLunaReserveTile (d200h-layout.ts): the moon is the
            // focal mark — a right-open crescent with the lit mass lower-right —
            // beneath it the remaining percent ("N% LEFT") or EMPTY. Identity
            // stays Codex: brand mark top-right, "LUNA" as the window label.
            VStack(spacing: size * 0.02) {
                HStack(alignment: .top) {
                    Text("LUNA")
                        .font(.system(size: size * 0.15, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white.opacity(active ? 1 : 0.45))
                    Spacer(minLength: 0)
                    CanonicalCreatureView(
                        agentType: "codex-cli",
                        size: size * 0.18,
                        color: StateColors.brand(agent: "codex-cli")
                    )
                }
                ZStack {
                    Circle()
                        .fill(active ? Color(red: 0xEA / 255.0, green: 0xB3 / 255.0, blue: 0x08 / 255.0) : .white.opacity(0.30))
                        .frame(width: size * 0.42, height: size * 0.42)
                    // Shadow disk offset up-left, matching the TS mark
                    // (cx − ⌈r·0.42⌉, cy − ⌈r·0.20⌉).
                    Circle()
                        .fill(Color.black.opacity(0.42))
                        .frame(width: size * 0.42, height: size * 0.42)
                        .offset(x: -size * 0.09, y: -size * 0.04)
                }
                .frame(maxHeight: .infinity)
                // Number is the headline; LEFT is a label at half size
                // (remainingPercentSvgText) — at one size "100% LEFT" overran
                // the key and clipped its trailing T.
                HStack(alignment: .firstTextBaseline, spacing: size * 0.02) {
                    Text(active ? "\(Int(remainingPercent))%" : "EMPTY")
                        .font(.system(size: size * 0.15, weight: .heavy))
                    if active {
                        Text("LEFT")
                            .font(.system(size: size * 0.075, weight: .heavy))
                    }
                }
                .foregroundStyle(UsageSeverity.color(100 - remainingPercent))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            }
            .padding(size * 0.08)
        case .codexCredits(let balance):
            // Mirrors renderCodexCreditsTile (d200h-layout.ts): an amber coin in
            // the crescent's place, the balance ("62.5K") in sand — a count with
            // no cap, so no severity ramp and no fill — over "CREDITS LEFT".
            VStack(spacing: size * 0.02) {
                HStack(alignment: .top) {
                    Text("CODEX")
                        .font(.system(size: size * 0.10, weight: .bold, design: .monospaced))
                        .foregroundStyle(DesignTokens.Tide.s50)
                    Spacer(minLength: 0)
                    CanonicalCreatureView(
                        agentType: "codex-cli",
                        size: size * 0.18,
                        color: StateColors.brand(agent: "codex-cli")
                    )
                }
                PreviewCreditCoinStack(fill: DesignTokens.UI.attn, rim: Color.black.opacity(0.42))
                    .frame(width: size * 0.36, height: size * 0.34)
                    .frame(maxHeight: .infinity)
                Text(UsagePresentation.formatCreditBalance(balance))
                    .font(.system(size: size * 0.18, weight: .heavy))
                    .foregroundStyle(DesignTokens.Tide.s50)
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                Text("CREDITS LEFT")
                    .font(.system(size: size * 0.07, weight: .bold, design: .monospaced))
                    .foregroundStyle(DesignTokens.Tide.s50)
                    .lineLimit(1)
            }
            .padding(size * 0.08)
        case .usagePair(let agent, let windows):
            // Mirrors renderUsagePairGauge: two real windows share one physical
            // key only when the fixed three-key strip would otherwise drop one.
            ZStack(alignment: .topTrailing) {
                VStack(spacing: size * 0.025) {
                    ForEach(Array(windows.enumerated()), id: \.offset) { index, window in
                        let dim = window.stale || (window.footnote?.isEmpty == false)
                        VStack(spacing: size * 0.015) {
                            HStack(alignment: .firstTextBaseline) {
                                // Mirrors renderUsagePairGauge: a scoped cap's name
                                // (up to 6 chars) beside a 3-digit percent needs the
                                // smaller label, or the row reads "FABLE100%".
                                Text(window.label)
                                    .font(.system(size: size * (window.label.count >= 5 ? 0.10 : 0.13), weight: .bold, design: .monospaced))
                                Spacer(minLength: 0)
                                Text("\(Int(window.percent))%")
                                    .font(.system(size: size * 0.14, weight: .heavy))
                            }
                            .padding(.trailing, index == 0 ? size * 0.12 : 0)
                            .foregroundStyle(dim ? .white.opacity(0.45) : .white)
                            if let note = window.footnote ?? (window.stale ? "stale" : nil) {
                                Text(note)
                                    .font(.system(size: size * 0.075, weight: .bold, design: .monospaced))
                                    .foregroundStyle(.white.opacity(0.45))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            GeometryReader { geo in
                                ZStack(alignment: .leading) {
                                    Rectangle().fill(.white.opacity(0.12))
                                    Rectangle()
                                        .fill(gaugeColor(percent: window.percent, known: true, stale: dim, inactive: window.inactive))
                                        .frame(width: geo.size.width * min(1, max(0, window.percent / 100)))
                                }
                            }
                            .frame(height: 2)
                        }
                    }
                }
                .padding(size * 0.08)
                PreviewUsageMark(
                    agentType: agent == "codex" ? "codex-cli" : (agent == "claude" ? "claude-code" : agent),
                    size: size * 0.14,
                    color: SessionBrand.color(for: agent == "codex" ? "codex-cli" : (agent == "claude" ? "claude-code" : agent))
                )
                .padding(size * 0.055)
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

    /// Shared used-percent severity, including unknown and non-binding caps.
    private func gaugeColor(percent: Double, known: Bool, stale: Bool = false, inactive: Bool = false) -> Color {
        if !known || stale { return UsageSeverity.color(-1) }
        if inactive { return DesignTokens.UI.cyan }
        return UsageSeverity.color(percent)
    }
}

/// SwiftUI crop of the same logical full-deck card emitted by
/// `renderOpenAppGrid`. Each key owns one viewport; the physical gaps between
/// keys provide the same segmentation as the real D200H LCD buttons.
private struct D200HOfflineGridFragment: View {
    let col: Int
    let row: Int
    let cols: Int
    let rows: Int
    let label: String
    let subtitle: String
    let size: CGFloat

    var body: some View {
        let totalW = size * CGFloat(cols)
        let totalH = size * CGFloat(rows)
        let minDim = CGFloat(min(cols, rows))
        let scale = max(1, minDim * 0.8)

        ZStack {
            Color(red: 0.028, green: 0.102, blue: 0.118)
            RoundedRectangle(cornerRadius: 14 * scale, style: .continuous)
                .fill(Color(red: 0.055, green: 0.18, blue: 0.20).opacity(0.68))
                .overlay(
                    RoundedRectangle(cornerRadius: 14 * scale, style: .continuous)
                        .stroke(DesignTokens.UI.cyan.opacity(0.28), lineWidth: 1.2 * scale)
                )
                .padding(.horizontal, max(4, 4 * CGFloat(cols) / 4))
                .padding(.vertical, max(4, 4 * CGFloat(rows) / 2))

            VStack(spacing: 5 * scale) {
                AgentDeckLogo(size: 32 * scale, color: DesignTokens.UI.cyan.opacity(0.9))
                Text(label)
                    .font(.system(size: 18 * minDim / 2, weight: .heavy, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.88))
                Text(subtitle)
                    .font(.system(size: 10 * minDim / 2, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.55))
            }
        }
        .frame(width: totalW, height: totalH)
        .offset(x: -CGFloat(col) * size, y: -CGFloat(row) * size)
        .frame(width: size, height: size, alignment: .topLeading)
        .clipped()
    }
}
