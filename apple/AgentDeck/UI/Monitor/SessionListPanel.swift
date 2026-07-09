// SessionListPanel.swift — Agent session list panel (matches Android SessionListPanel.kt)

import SwiftUI

// MARK: - Terrarium HUD Colors (matching Android TerrariumColors)

enum TerrariumHUD {
    static let bg = Color.black.opacity(0.5)                       // 0x80000000
    static let text = Color(red: 0.886, green: 0.91, blue: 0.941) // #E2E8F0
    static let subtext = Color(red: 0.58, green: 0.64, blue: 0.72) // #94A3B8
    static let ledGreen = Color(red: 0.133, green: 0.773, blue: 0.369)  // #22C55E
    static let ledAmber = Color(red: 0.984, green: 0.749, blue: 0.141)  // #FBBF24
    static let ledRed = Color(red: 0.937, green: 0.267, blue: 0.267)    // #EF4444
    static let tetraNeon = Color(red: 0, green: 0.898, blue: 1)         // #00E5FF
    static let claudeBody = Color(red: 0.753, green: 0.439, blue: 0.345) // #C07058
}

struct SessionListPanel: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder

    /// Maximum visible sessions before showing overflow summary
    private let maxVisibleSessions = 10

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // Brand logo — stacked-deck mark + "AgentDeck" wordmark. Unified
            // with the menubar brand direction so the same logo shape appears
            // in both surfaces, just retinted (neon cyan for the aquarium
            // HUD vs the menubar's system-primary).
            HStack(spacing: 6) {
                AgentDeckLogo(size: 20, color: TerrariumHUD.tetraNeon)
                Text("AgentDeck")
                    .font(.system(size: 22, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
            }
            .frame(maxWidth: .infinity)

            // Neon cyan underline bar (glow + crisp)
            Canvas { context, size in
                let barWidth = size.width * 0.8
                let x = (size.width - barWidth) / 2

                // Glow layer
                let glowRect = CGRect(x: x, y: 0, width: barWidth, height: 3)
                context.fill(Path(roundedRect: glowRect, cornerRadius: 1.5),
                             with: .color(TerrariumHUD.tetraNeon.opacity(0.3)))

                // Crisp bar
                let barRect = CGRect(x: x, y: 3, width: barWidth, height: 2)
                context.fill(Path(roundedRect: barRect, cornerRadius: 1),
                             with: .color(TerrariumHUD.tetraNeon))
            }
            .frame(height: 5)

            Spacer().frame(height: 4)

            // Build unified entry list, clustered into project work groups
            // (IPS10 office huddle port — SessionGrouping.swift). Worktree/task
            // folders sharing a long prefix render under one group header with
            // only their differentiating tail; singletons render flat.
            let entries = buildEntries()
            let visibleEntries = entries.count > maxVisibleSessions
                ? Array(entries.prefix(maxVisibleSessions))
                : entries
            let rows = Self.buildDisplayRows(visibleEntries)

            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                switch row {
                case .header(let key, let count):
                    groupHeaderRow(key: key, count: count)
                case .session(let entry, let label, let indent):
                    sessionRowInteractive(entry: entry, label: label)
                        .padding(.leading, indent ? 10 : 0)
                }
            }

            // Overflow indicator
            if entries.count > maxVisibleSessions {
                Text("and \(entries.count - maxVisibleSessions) more...")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
            }

            // Worker count
            if let count = stateHolder.state.workerSessionCount, count > 0 {
                Text("Workers: \(count)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
            }
        }
        .padding(8)
        .background(TerrariumHUD.bg, in: RoundedRectangle(cornerRadius: 8))
        .opacity(stateHolder.state.bridgeConnected ? 1.0 : 0.6)
    }

    // MARK: - Entry Builder

    private struct SessionEntry {
        let projectName: String
        let agentType: String?
        let modelName: String?
        let effortLevel: String?
        let state: AgentConnectionState
        let startedAt: String?
        /// Explicit deck/tab sort override (default 0); lower sorts first.
        let weight: Int?
        let isPrimary: Bool
        let isFocused: Bool
        /// Underlying `SessionInfo.id` for siblings. Nil for the primary
        /// (local) session, which uses `stateHolder.state.sessionId` as
        /// the focus target.
        let sessionId: String?
        /// Shared activity one-liner (bridge SSOT) — same summary the
        /// InkDeck cards and Android rows show, so surfaces don't drift.
        var activity: String?
    }

    private func buildEntries() -> [SessionEntry] {
        var entries: [SessionEntry] = []

        // Daemon/gateway state_updates are aggregate rows, not user sessions.
        // Focus-relayed state_updates, however, promote one real session into
        // the primary fields while the canonical sessions_list still contains
        // the same session. Deduplicate by session id only; using agentType
        // hid the focused Codex/Claude row whenever another session of the same
        // type was present, while the terrarium still rendered the promoted
        // creature.
        let primarySessionId = stateHolder.state.sessionId
        let focusedSessionId = stateHolder.state.focusedSessionId
        // Capture the sibling that backs the primary so we can borrow its
        // startedAt below. Without an anchor the primary entry collapses to
        // nil-startedAt, which sorts to the end of its (project, agentType)
        // group via DashboardDataRules.startedAtTime → .greatestFiniteMagnitude
        // and made the #N suffix order race-sensitive on iPad / iOS.
        let primaryAnchorSibling: SessionInfo? = primarySessionId.flatMap { pid in
            stateHolder.state.siblingSessions.first(where: { $0.id == pid })
        }
        let primaryBackedBySibling = primaryAnchorSibling != nil
        let duplicatePrimaryWithoutId = primarySessionId == nil &&
            stateHolder.state.agentType != nil &&
            stateHolder.state.siblingSessions.contains(where: {
                $0.agentType == stateHolder.state.agentType
            })
        let shouldShowPrimary = stateHolder.state.agentType != "daemon" &&
            stateHolder.state.agentType != "openclaw" &&
            (primaryBackedBySibling || !duplicatePrimaryWithoutId)

        if shouldShowPrimary {
            entries.append(SessionEntry(
                projectName: displayProjectName(stateHolder.state.projectName, agentType: stateHolder.state.agentType),
                agentType: stateHolder.state.agentType,
                modelName: stateHolder.state.modelName,
                effortLevel: stateHolder.state.effortLevel,
                state: stateHolder.state.state,
                startedAt: primaryAnchorSibling?.startedAt,
                weight: primaryAnchorSibling?.weight,
                isPrimary: true,
                isFocused: focusedSessionId != nil && stateHolder.state.sessionId == focusedSessionId,
                sessionId: stateHolder.state.sessionId,
                activity: primaryAnchorSibling?.activity
            ))
        }

        // Siblings (skip daemon, and the focused session iff primary already
        // represents it). Suppressing the focused id unconditionally hid newly
        // started sessions for 5–15 s in daemon/openclaw mode: the daemon
        // stamps `state.sessionId` with `currentHookSessionId` on every
        // `state_update`, but `shouldShowPrimary` is false there, so the
        // session disappeared from both primary and sibling rows until another
        // hook flipped `currentHookSessionId` away. Mirrors the
        // `primaryIsOctopus &&` gate in TerrariumState.toTerrariumState.
        let siblings = stateHolder.state.siblingSessions
            .filter { sibling in
                guard sibling.agentType != "daemon" else { return false }
                if shouldShowPrimary && sibling.id == stateHolder.state.sessionId {
                    return false
                }
                return true
            }
        for sibling in siblings {
            entries.append(SessionEntry(
                projectName: displayProjectName(sibling.projectName, agentType: sibling.agentType),
                agentType: sibling.agentType,
                modelName: sibling.modelName,
                effortLevel: sibling.effortLevel,
                // alive=true (we already filter siblings via isDaemonLike, and the
                // wire payload always sets alive=true for the OC virtual session)
                // — fall back to .idle for unknown/empty state to match
                // ControlTowerPanel.sessionState(_:) and Android mapSessionState.
                // .disconnected fallback caused OC to render as OFF during the
                // brief race window before stateMachine transitioned out of
                // .disconnected on gateway connect.
                state: AgentConnectionState(rawValue: sibling.state ?? "") ?? .idle,
                startedAt: sibling.startedAt,
                weight: sibling.weight,
                isPrimary: false,
                isFocused: sibling.id == focusedSessionId,
                sessionId: sibling.id,
                activity: sibling.activity
            ))
        }

        return Self.sortEntries(entries)
    }

    // MARK: - Session Row (interactive wrapper + row)

    /// One flattened list row: a group header, or a session row with its
    /// display label + indent already resolved.
    private enum DisplayRow {
        case header(key: String, count: Int)
        case session(entry: SessionEntry, label: String, indent: Bool)
    }

    /// Flatten grouped entries into display rows. Precomputed (not inside the
    /// ForEach builder) so the #N counters advance deterministically.
    private static func buildDisplayRows(_ entries: [SessionEntry]) -> [DisplayRow] {
        let nameCounts = Dictionary(grouping: entries, by: { "\($0.projectName)|\($0.agentType ?? "")" })
            .mapValues(\.count)
        var counters: [String: Int] = [:]
        func suffix(for entry: SessionEntry) -> String {
            let key = "\(entry.projectName)|\(entry.agentType ?? "")"
            guard (nameCounts[key] ?? 1) > 1 else { return "" }
            let idx = (counters[key] ?? 0) + 1
            counters[key] = idx
            return " #\(idx)"
        }

        var rows: [DisplayRow] = []
        for group in SessionGrouping.group(entries, projectOf: { $0.projectName }) {
            if group.grouped {
                rows.append(.header(key: group.key, count: group.members.count))
                for entry in group.members {
                    rows.append(.session(
                        entry: entry,
                        label: memberLabel(groupKey: group.key, entry: entry) + suffix(for: entry),
                        indent: true
                    ))
                }
            } else {
                let entry = group.members[0]
                rows.append(.session(entry: entry, label: entry.projectName + suffix(for: entry), indent: false))
            }
        }
        return rows
    }

    /// Display label for a member row under a group header. The header already
    /// carries the shared stem, so the row shows only the differentiating tail
    /// ("claude-glm" under "xteink-x3-x4-japanese-broken"). Exact-duplicate
    /// members fall back to the agent display name; the #N suffix disambiguates.
    private static func memberLabel(groupKey: String, entry: SessionEntry) -> String {
        let norm = SessionGrouping.normalizeProject(entry.projectName)
        if norm.count > groupKey.count, norm.lowercased().hasPrefix(groupKey.lowercased()) {
            let rest = String(norm.dropFirst(groupKey.count))
                .drop(while: { $0 == "-" || $0 == "_" || $0 == " " || $0 == "." })
            if !rest.isEmpty { return String(rest) }
        }
        if norm.lowercased() == groupKey.lowercased() {
            switch entry.agentType {
            case "codex-cli": return "Codex CLI"
            case "codex-app": return "Codex App"
            case "claude-code": return "Claude Code"
            case "openclaw": return "OpenClaw"
            case "opencode": return "OpenCode"
            case "antigravity": return "Antigravity"
            default: break
            }
        }
        return entry.projectName
    }

    /// Work-group header strip above clustered member rows.
    private func groupHeaderRow(key: String, count: Int) -> some View {
        HStack(spacing: 4) {
            Text(key)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(TerrariumHUD.subtext)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            Text("×\(count)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(TerrariumHUD.subtext.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
    }

    /// Row wrapper that handles taps: dispatches `focusSession` so the
    /// dashboard/terrarium centers this session. Tapping the focused row again
    /// clears explicit focus so the HUD can return to neutral.
    @ViewBuilder
    private func sessionRowInteractive(entry: SessionEntry, label: String) -> some View {
        Button {
            if let sid = entry.sessionId {
                if entry.isFocused {
                    stateHolder.sendCommand(.clearSessionFocus)
                } else {
                    stateHolder.sendCommand(.focusSession(sessionId: sid))
                }
            }
        } label: {
            sessionRow(entry: entry, label: label)
                .padding(.horizontal, 5)
                .padding(.vertical, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .background(
                    entry.isFocused ? TerrariumHUD.tetraNeon.opacity(0.14) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 5)
                )
                .overlay(alignment: .leading) {
                    if entry.isFocused {
                        RoundedRectangle(cornerRadius: 1)
                            .fill(TerrariumHUD.tetraNeon.opacity(0.95))
                            .frame(width: 2)
                    }
                }
        }
        .buttonStyle(.plain)
    }

    private func sessionRow(entry: SessionEntry, label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            // Icon + session name
            HStack(spacing: 4) {
                agentIconView(for: entry.agentType)
                Text(label)
                    .font(.system(size: 12, weight: entry.isFocused || entry.isPrimary ? .bold : .regular))
                    .foregroundStyle(TerrariumHUD.text)
                    .lineLimit(2)
            }

            sessionMetaRow(entry: entry)

            // Shared activity one-liner (bridge SSOT) — same summary the
            // InkDeck cards and Android rows show, so surfaces don't drift.
            if let activity = entry.activity, !activity.isEmpty {
                Text(activity)
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
    }

    private func sessionMetaRow(entry: SessionEntry) -> some View {
        let detailText = buildDetailText(entry: entry)
        return HStack(spacing: 4) {
            Text(compactStateMarker(entry.state))
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(stateColor(entry.state))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)

            if let detailText {
                Text("·")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
                    .fixedSize(horizontal: true, vertical: false)
                Text(detailText)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private func buildDetailText(entry: SessionEntry) -> String? {
        var parts: [String] = []
        if let model = entry.modelName, !model.isEmpty {
            parts.append(displayShortModelName(model, maxLength: 18))
        }
        // Skip neutral efforts — "medium" (legacy default) and "default"
        // (Claude Code 2.1+ per-model default). Show everything else
        // (max/xhigh/high/low/fast) so users can see non-default choices.
        if let effort = entry.effortLevel, effort != "medium", effort != "default" {
            parts.append(effort)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: - Helpers

    // MARK: - Brand Icons (SVG path data, viewBox 0 0 24 24)

    @ViewBuilder
    private func agentIconView(for agentType: String?) -> some View {
        switch agentType {
        case "claude-code", "codex-cli", "codex-app", "openclaw", "opencode", "antigravity":
            AgentBrandIcon(
                agentType: agentType,
                tint: SessionBrand.color(for: agentType),
                size: 16,
                contentInset: sessionListIconInset(for: agentType)
            )
            .frame(width: 16, height: 16)
        default:
            Text("●")
                .font(.system(size: 8))
                .foregroundStyle(TerrariumHUD.subtext)
                .frame(width: 16, height: 16)
        }
    }

    private func sessionListIconInset(for agentType: String?) -> CGFloat {
        switch agentType {
        case "codex-cli", "codex-app":
            // Codex's official SVG reaches the viewBox edges. Give it a real
            // internal inset instead of padding outside the Image frame so
            // the left/top anti-aliased pixels do not clip in the 16pt row slot.
            return 2.0
        case "openclaw":
            return 1.8
        default:
            return 1.5
        }
    }

    private func displayProjectName(_ raw: String?, agentType: String?) -> String {
        let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return trimmed }
        switch agentType {
        case "codex-cli": return "Codex CLI"
        case "codex-app": return "Codex App"
        case "claude-code": return "Claude Code"
        case "openclaw": return "OpenClaw"
        case "opencode": return "OpenCode"
        case "antigravity": return "Antigravity"
        default: return "Agent"
        }
    }

}

private extension SessionListPanel {
    static func agentTypeRank(_ agentType: String?) -> Int {
        DashboardDataRules.agentTypeRank(agentType)
    }

    private static func sortEntries(_ entries: [SessionEntry]) -> [SessionEntry] {
        entries.sorted { lhs, rhs in
            // Three-way comparison, never subtraction — weights are
            // user-controlled and Int subtraction can trap on overflow.
            let lhsWeight = DashboardDataRules.sessionWeight(lhs.weight)
            let rhsWeight = DashboardDataRules.sessionWeight(rhs.weight)
            if lhsWeight != rhsWeight { return lhsWeight < rhsWeight }

            let typeDiff = agentTypeRank(lhs.agentType) - agentTypeRank(rhs.agentType)
            if typeDiff != 0 { return typeDiff < 0 }

            let projectCompare = DashboardDataRules.naturalLabelCompare(lhs.projectName, rhs.projectName)
            if projectCompare != .orderedSame { return projectCompare == .orderedAscending }

            let lhsStarted = DashboardDataRules.startedAtTime(lhs.startedAt)
            let rhsStarted = DashboardDataRules.startedAtTime(rhs.startedAt)
            if lhsStarted != rhsStarted { return lhsStarted < rhsStarted }

            let lhsId = lhs.sessionId ?? ""
            let rhsId = rhs.sessionId ?? ""
            return DashboardDataRules.naturalLabelCompare(lhsId, rhsId) == .orderedAscending
        }
    }

    static func stateRank(_ state: AgentConnectionState) -> Int {
        switch state {
        case .processing: 0
        case .awaitingPermission, .awaitingOption, .awaitingDiff: 1
        case .idle: 2
        case .disconnected: 3
        }
    }

    func compactStateMarker(_ state: AgentConnectionState) -> String {
        switch state {
        case .idle: "● IDLE"
        case .processing: "◉ PROC"
        case .awaitingPermission: "⚠ PERM"
        case .awaitingOption: "◇ SEL"
        case .awaitingDiff: "□ DIFF"
        case .disconnected: "○ OFF"
        }
    }

    private func stateColor(_ state: AgentConnectionState) -> Color {
        switch state {
        case .idle: TerrariumHUD.ledGreen
        case .processing: Color(red: 0.231, green: 0.51, blue: 0.965) // #3B82F6
        case .awaitingPermission, .awaitingOption, .awaitingDiff: TerrariumHUD.ledAmber
        case .disconnected: TerrariumHUD.subtext
        }
    }
}
