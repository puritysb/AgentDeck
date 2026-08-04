// InkDeckPreview.swift — InkDeck 7.5" e-ink (Seeed TRMNL OG DIY Kit) preview.
//
// Hand-maintained mirror of the firmware dashboard layout in
// esp32/src/ui/eink/eink_display.cpp (drawDashboard). The responsive geometry
// the firmware now uses lives in esp32/src/ui/eink/eink_dashboard_layout.h
// (AgentDeckEink::makeLayout) — a print-style 1-bit 800×480 page with
//   - brand header: dome-over-deck mark + "AgentDeck" wordmark, a link
//     chip (filled when connected), session count, double rule at y≈62;
//   - session card grid: double-outline rounded cards with the agent
//     creature glyph + project name + state line + a TIMELINE-grade work
//     summary; a card whose session has active subagents reserves a right
//     strip for a static miniature orbit + child count (static by design —
//     e-ink pays for animation in ghosting); the first awaiting card inverts
//     to solid black with white ink.
//     Columns are chosen by makeLayout: 1 for a lone session, 2 landscape,
//     3 once five+ sessions share the 800px panel (rows capped at 2);
//   - adaptive usage band (usageRowCount 0/1/2): provider rows (CLAUDE /
//     CODEX, 5H/7D bar gauges) draw only for providers that actually report
//     usage, and a missing window is dropped (present ones pack left) rather
//     than shown as a dead "--". With 0 rows the separator rule is omitted and
//     the session grid reclaims the band;
//   - recent-work strip: up to Snap::TICKER_ROWS (3) latest milestone timeline
//     rows, newest at the top, gated on the live daemon link. Replaces the old
//     single ticker line. The host-display-sleep card was removed — InkDeck is
//     always USB-powered and keeps the dashboard retained instead.
//
// Sync pins (below) are the git blob hashes of the origin files at the last
// re-sync; scripts/check-preview-mirror-sync.mjs verifies they still match and
// fails CI when the firmware drifts ahead of this mirror. Update this view and
// re-pin whenever the firmware layout changes.
//
// SYNC-HASH esp32/src/ui/eink/eink_display.cpp 181fd6d9954b38a9d0c1eef08776e04118979a55
// SYNC-HASH esp32/src/ui/eink/eink_dashboard_layout.h 9179d41777d6e2caff02735607ad7ca210de8bb8

import SwiftUI

struct InkDeckPreview: View {
    let selection: DevicePreviewSelection

    // 800×480 panel at 0.62× so the whole page fits the canvas.
    private let panelW: CGFloat = 800 * 0.62
    private let panelH: CGFloat = 480 * 0.62

    private let paper = Color(red: 0.96, green: 0.95, blue: 0.92)
    private let ink = Color.black.opacity(0.88)

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(
                cornerRadius: 12,
                bezelWidth: 14,
                bezelColor: Color(white: 0.92),
                screenColor: paper
            ) {
                page
            }
            .frame(width: panelW + 28, height: panelH + 28)
            Text("InkDeck • 800×480 UC8179 e-ink (ESP32-S3)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    // MARK: - Page

    private var page: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            sessionGrid
                .frame(maxHeight: .infinity)
            usageFooter
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
    }

    // MARK: Header — drawBrandHeader

    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                AgentDeckLogo(size: 26, color: ink)
                Text("AgentDeck")
                    .font(.system(size: 19, weight: .bold))
                    .foregroundStyle(ink)
                Spacer(minLength: 8)
                if selection.sessionCount > 0 {
                    Text("\(selection.sessionCount) session\(selection.sessionCount == 1 ? "" : "s")")
                        .font(.system(size: 9))
                        .foregroundStyle(ink.opacity(0.8))
                }
                linkChip
            }
            // Print-style double rule.
            Rectangle().fill(ink).frame(height: 1.6)
            Rectangle().fill(ink).frame(height: 0.6).padding(.top, 1.2)
        }
        .padding(.top, 2)
    }

    private var linkChip: some View {
        let connected = selection.state != .disconnected
        let label = connected ? "WIFI LINK" : "NO LINK"
        return Text(label)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(connected ? paper : ink)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(connected ? ink : .clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(ink, lineWidth: connected ? 0 : 1)
            )
    }

    // MARK: Session grid — drawSessionGrid / drawSessionCard

    private var sessionGrid: some View {
        let sessions = selection.displaySessions
        // Column count mirrors AgentDeckEink::makeLayout for the 800×480
        // landscape panel: 1 for a lone session, 3 once five+ sessions pack the
        // panel, else 2. (Portrait X3/X4 use a single wide column — N/A here.)
        let columns = sessions.count <= 1 ? 1 : (sessions.count >= 5 ? 3 : 2)
        return Group {
            if sessions.isEmpty {
                // Two distinct empty states, like the firmware: disconnected →
                // drawSearching ("searching for daemon…"); connected with no
                // sessions → drawSessionGrid's rowCount==0 branch ("no active
                // sessions" + workspace hint). Conflating them made a healthy
                // idle daemon read as broken.
                VStack(spacing: 8) {
                    AgentDeckLogo(size: 44, color: ink.opacity(0.7))
                    if selection.state == .disconnected {
                        Text("searching for daemon…")
                            .font(.system(size: 10))
                            .foregroundStyle(ink.opacity(0.6))
                    } else {
                        Text("no active sessions")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(ink.opacity(0.8))
                        Text("start claude / codex / opencode in a workspace")
                            .font(.system(size: 9))
                            .foregroundStyle(ink.opacity(0.55))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // makeLayout caps the grid at 2 card rows; with ≤5 preview
                // sessions and 2–3 columns the chunking never exceeds that.
                let rows = Array(sessions.enumerated()).chunked(into: columns)
                VStack(spacing: 6) {
                    ForEach(rows, id: \.first!.offset) { rowEntries in
                        HStack(spacing: 6) {
                            ForEach(rowEntries, id: \.offset) { entry in
                                sessionCard(session: entry.element)
                            }
                        }
                    }
                }
                .padding(.vertical, 6)
            }
        }
    }

    private func sessionCard(session: PreviewDisplaySession) -> some View {
        let state = session.state
        let awaiting = state == .awaitingPrompt
        let cardInk = awaiting ? paper : ink
        return HStack(spacing: 8) {
            PreviewCreatureGlyph(
                agent: session.agent,
                state: state,
                size: 34,
                tintOverride: cardInk
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(session.projectName)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(cardInk)
                    .lineLimit(1)
                // State line: "<LABEL>: <live activity>" (colon, not the old
                // " · " — the firmware moved to an ASCII colon so the CP437
                // fallback font can't mangle a UTF-8 middot). Awaiting cards
                // show the label alone.
                Text(stateLine(for: state))
                    .font(.system(size: 8, weight: .semibold, design: .monospaced))
                    .foregroundStyle(cardInk.opacity(0.72))
                    .lineLimit(1)
                // Detail line: the awaiting question, else the TIMELINE-grade
                // work summary ("HH:MM · task · text") — NOT the live activity,
                // which already rides the state line above. The model tag sits
                // bottom-right (below), not on this line.
                Text(detailLine(for: state))
                    .font(.system(size: 8))
                    .foregroundStyle(cardInk.opacity(0.6))
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            // Subagent orbit, reserving the right strip the firmware takes out
            // of the text width (subagentReserve). Static by construction:
            // e-ink pays for every animated pixel in ghosting, so the firmware
            // draws a fixed six-dot ring with one satellite rather than a
            // rotating one. The parent card stays the only selectable entity.
            if session.subagentCount > 0 {
                subagentOrbit(count: session.subagentCount, cardInk: cardInk)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity)
        // Model tag bottom-right, when the daemon reports one (live-follow).
        .overlay(alignment: .bottomTrailing) {
            if let model = session.modelName {
                Text(model)
                    .font(.system(size: 7, design: .monospaced))
                    .foregroundStyle(cardInk.opacity(0.55))
                    .lineLimit(1)
                    .padding(.trailing, 8)
                    .padding(.bottom, 6)
            }
        }
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(awaiting ? ink : .clear)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(ink, lineWidth: awaiting ? 0 : 1.4)
        )
    }

    /// The card's subagent orbit: a six-dot ellipse, one radial wire, a filled
    /// satellite, and the count beneath — the firmware's fixed `ringX/ringY`
    /// table drawn at every other index, scaled into this schematic card.
    private func subagentOrbit(count: Int, cardInk: Color) -> some View {
        VStack(spacing: 2) {
            Canvas { ctx, size in
                let cx = size.width / 2
                let cy = size.height / 2
                let rx = size.width / 2 - 1
                let ry = rx * 0.5
                // Same six sampled positions as the firmware (i += 2 over a
                // twelve-point ring), expressed as angles so the schematic
                // scales instead of hard-coding pixel offsets.
                for i in stride(from: 0, to: 12, by: 2) {
                    let a = Double(i) / 12 * 2 * .pi + .pi
                    let p = CGRect(
                        x: cx + rx * CGFloat(cos(a)) - 0.6,
                        y: cy + ry * CGFloat(sin(a)) - 0.6,
                        width: 1.2, height: 1.2
                    )
                    ctx.fill(Path(ellipseIn: p), with: .color(cardInk.opacity(0.7)))
                }
                var wire = Path()
                wire.move(to: CGPoint(x: cx, y: cy))
                wire.addLine(to: CGPoint(x: cx + rx, y: cy))
                ctx.stroke(wire, with: .color(cardInk.opacity(0.7)), lineWidth: 0.8)
                ctx.fill(
                    Path(ellipseIn: CGRect(x: cx + rx - 2, y: cy - 2, width: 4, height: 4)),
                    with: .color(cardInk)
                )
            }
            .frame(width: 26, height: 14)
            Text("\(count)")
                .font(.system(size: 8, weight: .semibold, design: .monospaced))
                .foregroundStyle(cardInk.opacity(0.8))
        }
        .frame(width: 32)
    }

    /// State line text — "<LABEL>: <activity>" for a busy session (firmware
    /// `"%s: %s"`), just the label for awaiting/idle-with-no-activity.
    private func stateLine(for state: PixooPreviewState) -> String {
        let label = Self.firmwareStateLabel(for: state)
        switch state {
        case .awaitingPrompt, .disconnected:
            return label
        case .processing, .idle:
            return "\(label): \(activityLine(for: state))"
        }
    }

    /// Card detail — awaiting shows the pending question; otherwise the
    /// daemon-computed latest milestone as "HH:MM · task · text".
    private func detailLine(for state: PixooPreviewState) -> String {
        switch state {
        case .awaitingPrompt: return "may I edit eink_display.cpp?"
        case .processing:     return "14:01 · edit · refactor e-ink layout SSOT"
        case .idle:           return "13:57 · task · finished dashboard sync"
        case .disconnected:   return ""
        }
    }

    private func activityLine(for state: PixooPreviewState) -> String {
        switch state {
        case .idle:           return "last turn complete"
        case .processing:     return "editing files…"
        case .awaitingPrompt: return "permission requested"
        case .disconnected:   return "offline"
        }
    }

    /// Firmware card state labels (eink_display.cpp stateLabel): the panel
    /// prints PERMISSION / CHOOSE / REVIEW for the awaiting states — never
    /// "AWAITING" — and OFFLINE for anything unknown. The preview's coarse
    /// state model maps awaitingPrompt to the permission variant.
    static func firmwareStateLabel(for state: PixooPreviewState) -> String {
        switch state {
        case .processing:     return "PROCESSING"
        case .awaitingPrompt: return "PERMISSION"
        case .idle:           return "IDLE"
        case .disconnected:   return "OFFLINE"
        }
    }

    // MARK: Usage footer — drawUsageFooter (adaptive split + recent-work strip)

    /// Sample providers that "report usage" for this preview frame. Mirrors the
    /// firmware's usageRowCount gate: a provider row draws only when its quota
    /// data exists. Offline daemon → no usage data at all; otherwise the row
    /// set follows the agents in the session mix (Claude-linked / Codex-linked).
    private var usageFooter: some View {
        // Real usage windows in live-follow mode; the placeholder gauges (Claude
        // by the session mix, Codex when a Codex session exists) otherwise.
        let rows = selection.displayUsageRows
        return VStack(alignment: .leading, spacing: 4) {
            // 0 usage rows → no separator, no gauge band (usage.empty() in the
            // firmware layout); the session grid above reclaims the space and
            // only the recent-work strip remains.
            if !rows.isEmpty {
                Rectangle().fill(ink).frame(height: 1.4)
                ForEach(rows) { row in
                    providerRow(glyphAgent: row.agent, label: row.label, plan: row.plan, p5: row.p5, p7: row.p7)
                }
            }
            // Recent-work strip — up to Snap::TICKER_ROWS (3) latest milestone
            // rows, newest first, gated on the live daemon link (a stale line
            // under the "searching…" screen read as if still connected).
            if selection.state != .disconnected {
                ForEach(Array(workStripRows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 5) {
                        Text(row.time)
                            .font(.system(size: 8, weight: .bold, design: .monospaced))
                        Text(row.text)
                            .font(.system(size: 8))
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(ink.opacity(0.7))
                }
            }
        }
        .padding(.bottom, 2)
    }

    /// Up to 3 synthetic milestone rows, newest first — stands in for the
    /// firmware's timeline-ring recent-work strip.
    private var workStripRows: [(time: String, text: String)] {
        switch selection.state {
        case .processing:
            return [
                ("14:02", "claude · agentdeck · response streaming…"),
                ("13:57", "claude · agentdeck · edited eink_display.cpp"),
                ("13:41", "codex · bridge · task complete"),
            ]
        case .awaitingPrompt:
            return [
                ("14:02", "claude · agentdeck · awaiting permission"),
                ("13:57", "claude · agentdeck · ran the test suite"),
            ]
        case .idle:
            return [
                ("13:58", "claude · agentdeck · turn complete"),
                ("13:41", "codex · bridge · task complete"),
            ]
        case .disconnected:
            return []
        }
    }

    private func providerRow(glyphAgent: PixooPreviewAgent, label: String, plan: String, p5: Double, p7: Double) -> some View {
        HStack(spacing: 6) {
            PreviewCreatureGlyph(agent: glyphAgent, state: .idle, size: 13, tintOverride: ink)
            VStack(alignment: .leading, spacing: 0) {
                Text(label)
                    .font(.system(size: 8, weight: .bold))
                Text(plan)
                    .font(.system(size: 6.5, design: .monospaced))
                    .foregroundStyle(ink.opacity(0.6))
            }
            .foregroundStyle(ink)
            .frame(width: 52, alignment: .leading)
            // Present windows pack left (firmware: p5 at x=150, p7 next); a
            // missing window is dropped, never shown as "--". The preview's
            // sample rows always carry both, so both render here.
            gaugeBar(tag: "5H", pct: p5)
            gaugeBar(tag: "7D", pct: p7)
            Spacer(minLength: 0)
        }
    }

    private func gaugeBar(tag: String, pct: Double) -> some View {
        HStack(spacing: 4) {
            Text(tag)
                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                .foregroundStyle(ink)
            ZStack(alignment: .leading) {
                Rectangle()
                    .stroke(ink, lineWidth: 0.9)
                Rectangle()
                    .fill(ink)
                    .frame(width: 86 * pct)
                    .padding(1.5)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(width: 90, height: 10)
            Text("\(Int(pct * 100))%")
                .font(.system(size: 7.5, design: .monospaced))
                .foregroundStyle(ink.opacity(0.8))
        }
    }
}

// Small helper: chunk an enumerated array into fixed-size rows for the grid.
private extension Array {
    func chunked(into size: Int) -> [[Element]] {
        guard size > 0 else { return [self] }
        return stride(from: 0, to: count, by: size).map {
            Array(self[$0..<Swift.min($0 + size, count)])
        }
    }
}
