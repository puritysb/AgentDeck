// The optional physical-key Aquarium page does not change this default dashboard mirror.
// Trmnl75Preview.swift — TRMNL 7.5" e-ink (Seeed TRMNL OG DIY Kit) preview.
//
// Hand-maintained mirror of the firmware dashboard layout in
// esp32/src/ui/eink/eink_display.cpp (drawDashboard). The responsive geometry
// the firmware now uses lives in esp32/src/ui/eink/eink_dashboard_layout.h
// (AgentDeckEink::makeLayout) — a print-style 1-bit 800×480 page with
//   - brand header: dome-over-deck mark + "AgentDeck" wordmark, a link
//     chip (filled when connected), and the session counts by state in the
//     reader's words ("1 need you, 2 working, 3 idle"), double rule at y≈62.
//     On a narrow panel the quiet categories drop first, then the font —
//     never an overprint of the wordmark;
//   - Paper Board roster (DESIGN.md §5.14): only sessions that need the reader
//     or are working get a card; quiet sessions collapse into one IDLE line of
//     glyph + name at the foot of the card band ("+N ACTIVE" first when active
//     cards overflow, "+N" when names run out of width). With nothing active,
//     the quiet sessions get the cards back. Cards are double-outline rounded
//     boxes with the agent creature glyph + project name, then the state
//     marker with the live activity (the state word only when there is no
//     activity, or the session waits on the reader), then the TIMELINE-grade
//     work summary or the awaiting question. No filler copy when a session
//     has no summary yet. A card whose session has active subagents reserves
//     a right strip for a static miniature orbit + child count (e-ink pays for
//     animation in ghosting); every awaiting card inverts to solid black.
//     Columns are chosen by makeLayout: 1 for a lone card, 2 landscape, 3 once
//     five+ cards share the 800px panel (rows capped at 2), in glance order —
//     user input first, then live work, daemon order within each tier;
//   - adaptive usage band (usageRowCount 0/1/2): provider rows (CLAUDE /
//     CODEX, 5H/7D bar gauges) draw only for providers that actually report
//     usage, and a missing window is dropped (present ones pack left) rather
//     than shown as a dead "--". With 0 rows the separator rule is omitted and
//     the session grid reclaims the band;
//   - recent-work strip: up to Snap::TICKER_ROWS (3) latest response timeline
//     rows, newest at the top, gated on the live daemon link. Replaces the old
//     single ticker line. The host-display-sleep card was removed — TRMNL 7.5" is
//     always USB-powered and keeps the dashboard retained instead.
//
// Sync pins (below) are the git blob hashes of the origin files at the last
// re-sync; scripts/check-preview-mirror-sync.mjs verifies they still match and
// fails CI when the firmware drifts ahead of this mirror. Update this view and
// re-pin whenever the firmware layout changes.
//
// SYNC-HASH esp32/src/ui/eink/eink_display.cpp 1f5f2a079578b34197f04f18810680a3f95417cb
// SYNC-HASH esp32/src/ui/eink/eink_dashboard_layout.h 97b1d2a6f5c84e9cf733b3e5b3145ad45f3136e7

import SwiftUI

struct Trmnl75Preview: View {
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
            Text("TRMNL 7.5\" • 800×480 UC8179 e-ink (ESP32-S3)")
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
                    // The firmware drops the count to CLASSIC_FONT when the
                    // hidden tally no longer fits the space left of the chip
                    // (`textWidth(cnt) <= available`). Shrinking is the same
                    // decision here; truncating would cut the very tally the
                    // line was added to show.
                    Text(sessionCountLabel)
                        .font(.system(size: 9))
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
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

    // MARK: Glance order and hidden counts — prioritizedSessionOrder /
    //       hiddenSessionSummary (eink_display.cpp)

    /// Firmware glance order: user input first, then live work, then quiet
    /// context, with daemon order preserved inside each tier. Attention and
    /// processing used to share one tier, so a permission prompt could sort
    /// behind a busy session and be the card that fell off the page.
    private func prioritized(_ sessions: [PreviewDisplaySession]) -> [PreviewDisplaySession] {
        sessions.filter { $0.state == .awaitingPrompt }
            + sessions.filter { $0.state == .processing }
            + sessions.filter { $0.state != .awaitingPrompt && $0.state != .processing }
    }

    private func columnCount(for count: Int) -> Int {
        count <= 1 ? 1 : (count >= 5 ? 3 : 2)
    }

    /// `makeLayout`'s `capacity` — columns × rows, rows capped at 2 on this
    /// 800×480 landscape page (the firmware additionally derives rows from the
    /// available height; on a fixed panel that bound is never the tighter one).
    private func cardCapacity(for count: Int, columns: Int) -> Int {
        guard count > 0, columns > 0 else { return 0 }
        return columns * min(2, (count + columns - 1) / columns)
    }

    /// boardCountSummary: counts by state in the reader's words. Sessions
    /// beyond the rows on hand count as idle, like the firmware's
    /// `totalSessions - rowCount`.
    private var sessionCountLabel: String {
        let sessions = selection.displaySessions
        let input = sessions.filter { $0.state == .awaitingPrompt }.count
        let working = sessions.filter { $0.state == .processing }.count
        let idle = sessions.filter { $0.state == .idle }.count
            + max(0, selection.sessionCount - sessions.count)
        let offline = sessions.filter { $0.state == .disconnected }.count
        return [(input, "need you"), (working, "working"), (idle, "idle"), (offline, "offline")]
            .filter { $0.0 > 0 }
            .map { "\($0.0) \($0.1)" }
            .joined(separator: ", ")
    }

    private func isActive(_ session: PreviewDisplaySession) -> Bool {
        session.state == .awaitingPrompt || session.state == .processing
    }

    // MARK: Session grid — drawSessionGrid / drawSessionCard

    private var sessionGrid: some View {
        // Glance order first, then the fixed capacity — the firmware fills
        // cards from `prioritizedSessionOrder` and simply stops at
        // `layout.capacity`, so what a full page drops is always the quietest
        // thing, never whatever happened to sort last.
        let ordered = prioritized(selection.displaySessions)
        // usesIdleLine: cards for the active sessions only, quiet ones on one
        // line below; with nothing active (or nothing quiet) every row is a card.
        let active = ordered.filter(isActive)
        let idleLine = !active.isEmpty && active.count < ordered.count
        let carded = idleLine ? active : ordered
        // Column count mirrors AgentDeckEink::makeLayout for the 800×480
        // landscape panel: 1 for a lone card, 3 once five+ cards pack the
        // panel, else 2. (Portrait X3/X4 use a single wide column — N/A here.)
        let columns = columnCount(for: carded.count)
        let sessions = Array(carded.prefix(cardCapacity(for: carded.count, columns: columns)))
        let quiet = ordered.filter { !isActive($0) }
        return Group {
            if sessions.isEmpty {
                // Two distinct empty states, like the firmware: disconnected →
                // terminal OFFLINE card + quiet retry phase; connected with no
                // sessions → drawSessionGrid's rowCount==0 branch ("no active
                // sessions" + workspace hint). Conflating them made a healthy
                // idle daemon read as broken.
                VStack(spacing: 8) {
                    AgentDeckLogo(size: 44, color: ink.opacity(0.7))
                    if selection.state == .disconnected {
                        Text("OFFLINE")
                            .font(.system(size: 14, weight: .black, design: .monospaced))
                            .foregroundStyle(ink.opacity(0.88))
                        Text("Searching for AgentDeck…")
                            .font(.system(size: 9))
                            .foregroundStyle(ink.opacity(0.58))
                    } else {
                        Text("no active sessions")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(ink.opacity(0.8))
                        Text("start claude / codex / opencode / kiro in a workspace")
                            .font(.system(size: 9))
                            .foregroundStyle(ink.opacity(0.55))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                // makeLayout caps the grid at 2 card rows; `sessions` is already
                // trimmed to that capacity above, so the chunking cannot exceed
                // it even in live-follow mode with a crowded daemon.
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
                if idleLine {
                    idleLineView(quiet: quiet, activeHidden: active.count - sessions.count)
                }
            }
        }
    }

    /// drawIdleLine: "+N ACTIVE" when active cards overflowed, then IDLE and
    /// each quiet session as glyph + name.
    private func idleLineView(quiet: [PreviewDisplaySession], activeHidden: Int) -> some View {
        VStack(spacing: 3) {
            Rectangle().fill(ink).frame(height: 0.8)
            HStack(spacing: 10) {
                if activeHidden > 0 {
                    Text("+\(activeHidden) ACTIVE")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(ink)
                }
                Text("IDLE")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(ink)
                ForEach(quiet) { session in
                    HStack(spacing: 3) {
                        PreviewCreatureGlyph(agent: session.agent, state: session.state,
                                             size: 12, tintOverride: ink)
                        Text(session.projectName)
                            .font(.system(size: 9))
                            .foregroundStyle(ink)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.bottom, 4)
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
                // Line 2: the live activity at full body size (the firmware no
                // longer shares it with the state word, which pushed long text
                // into the CP437 fallback font); the state word only when there
                // is no activity or the session waits on the reader.
                Text(stateLine(for: state))
                    .font(.system(size: 8, weight: state == .processing ? .regular : .semibold))
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
    /// Line 2 of a card: the live activity when there is one, else the state
    /// word (always the word while the session waits on the reader).
    private func stateLine(for state: PixooPreviewState) -> String {
        switch state {
        case .processing: return activityLine(for: state)
        case .awaitingPrompt, .idle, .disconnected: return Self.firmwareStateLabel(for: state)
        }
    }

    /// Card detail — awaiting shows the pending question; otherwise the
    /// daemon-computed latest response as "HH:MM · task · text".
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

    /// Firmware card state labels (eink_display.cpp stateLabel): the shared
    /// short vocabulary (DESIGN.md §2.7) — APPROVE / CHOOSE / REVIEW for the
    /// awaiting states, never "AWAITING", and OFFLINE for anything unknown.
    /// The preview's coarse state model maps awaitingPrompt to the permission
    /// variant.
    static func firmwareStateLabel(for state: PixooPreviewState) -> String {
        switch state {
        case .processing:     return AgentConnectionState.processing.sessionWords.short
        case .awaitingPrompt: return AgentConnectionState.awaitingPermission.sessionWords.short
        case .idle:           return AgentConnectionState.idle.sessionWords.short
        case .disconnected:   return AgentConnectionState.disconnected.sessionWords.short
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
        let otherPlans = selection.live?.source.subscriptions.filter { sub in
            !rows.contains { row in
                (row.label == "CLAUDE" && sub.name.hasPrefix("Claude")) ||
                (row.label == "Z.AI" && sub.name.hasPrefix("GLM Coding Plan")) ||
                (row.label == "CODEX" && (sub.name.hasPrefix("ChatGPT") || sub.name.hasPrefix("Codex")))
            }
        } ?? []
        return VStack(alignment: .leading, spacing: 4) {
            // 0 usage rows → no separator, no gauge band (usage.empty() in the
            // firmware layout); the session grid above reclaims the space and
            // only the recent-work strip remains.
            if !rows.isEmpty {
                Rectangle().fill(ink).frame(height: 1.4)
                ForEach(rows) { row in
                    providerRow(agentType: row.agentType, label: row.label, plan: row.plan, p5: row.p5, p7: row.p7, secondaryLabel: row.secondaryLabel)
                }
            }
            if selection.state != .disconnected {
                // A plan-only provider (Antigravity) is its own row: mark, name,
                // and its plan in the first slot (UsageRows group, no windows).
                ForEach(Array(otherPlans.enumerated()), id: \.offset) { _, sub in
                    providerRow(agentType: "antigravity", label: "ANTIGRAVITY",
                                plan: [sub.name, sub.until ?? ""].filter { !$0.isEmpty }.joined(separator: " "),
                                p5: -1, p7: -1, secondaryLabel: "7D")
                }
                Text("RECENT").font(.system(size: 8, weight: .bold)).foregroundStyle(ink)
            }
            // Recent-work strip — up to Snap::TICKER_ROWS (3) latest response
            // rows, newest first, gated on the live daemon link (a stale line
            // under the "searching…" screen read as if still connected).
            if selection.state != .disconnected {
                ForEach(Array(workStripRows.prefix(selection.sessionCount > 2 ? 2 : 3).enumerated()), id: \.offset) { _, row in
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
                ("14:02", "claude · agentdeck · Response received"),
                ("13:57", "claude · agentdeck · Display fix ready for review"),
                ("13:41", "codex · bridge · task complete"),
            ]
        case .awaitingPrompt:
            return [
                ("14:02", "claude · agentdeck · Previous response received"),
                ("13:57", "claude · agentdeck · Test results received"),
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

    /// drawProviderUsage: fixed name column, then two aligned window slots.
    /// The plan (tier without the provider prefix) takes the slot a missing
    /// window leaves; with both windows it sits under the provider name.
    private func providerRow(agentType: String, label: String, plan: String, p5: Double, p7: Double, secondaryLabel: String) -> some View {
        let tier = UsagePresentation.subscriptionTier(plan)
        let windows = (p5 >= 0 ? 1 : 0) + (p7 >= 0 ? 1 : 0)
        // A prefix-only subscription ("Claude") has no tier and shows nothing.
        let planSlot = !tier.isEmpty && windows < 2
        return HStack(spacing: 6) {
            PreviewUsageMark(agentType: agentType, size: 13, color: ink)
            VStack(alignment: .leading, spacing: 0) {
                Text(label)
                    .font(.system(size: 8, weight: .bold))
                if !tier.isEmpty && !planSlot {
                    Text(tier).font(.system(size: 7)).lineLimit(1)
                }
            }
            .foregroundStyle(ink)
            .frame(width: 70, alignment: .leading)
            HStack(spacing: 8) {
                if p5 >= 0 { gaugeBar(tag: "5H", pct: p5).frame(maxWidth: .infinity) }
                if p7 >= 0 { gaugeBar(tag: secondaryLabel, pct: p7).frame(maxWidth: .infinity) }
                if planSlot {
                    HStack(spacing: 4) {
                        Text("PLAN").font(.system(size: 7.5, weight: .bold, design: .monospaced))
                        Text(tier).font(.system(size: 8)).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(ink)
                    .frame(maxWidth: .infinity)
                }
                ForEach(0..<max(0, 2 - windows - (planSlot ? 1 : 0)), id: \.self) { _ in
                    Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
                }
            }
        }
    }

    private func gaugeBar(tag: String, pct: Double) -> some View {
        HStack(spacing: 4) {
            Text(tag)
                .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                .foregroundStyle(ink)
            GeometryReader { geometry in
              ZStack(alignment: .leading) {
                Rectangle()
                    .stroke(ink, lineWidth: 0.9)
                Rectangle()
                    .fill(ink)
                    .frame(width: max(0, geometry.size.width - 3) * pct)
                    .padding(1.5)
                    .frame(maxWidth: .infinity, alignment: .leading)
              }
            }
            .frame(height: 10)
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
