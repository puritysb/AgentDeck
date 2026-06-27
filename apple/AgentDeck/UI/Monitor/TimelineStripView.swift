// TimelineStripView.swift — Event timeline (matches Android TimelineStrip.kt)

import SwiftUI

/// Layout adapts to device class + orientation:
///   - `.compact` : iPhone portrait (h=compact, v=regular). Single-column with
///     tap-to-expand inline detail. No right-side detail pane.
///   - `.regular` : everywhere else (iPad portrait/landscape, iPhone landscape, macOS).
///     65/35 HStack with right-side detail pane.
enum TimelineLayoutMode { case compact, regular }

/// Per-form-factor font scale. Phone-class (compact) screens are cramped;
/// shrink the HUD text by one step. Mirrors the Android `MonitorLayoutScale`
/// phone/tablet split.
enum TimelineFontScale {
    case compact, regular
    /// Smallest tier — lifecycle labels, badges, inline detail metadata.
    var label: CGFloat { self == .compact ? 8  : 9  }
    /// Body tier — most timeline rows (time, icon, summary).
    var sub:   CGFloat { self == .compact ? 9  : 10 }
    /// Header tier — DetailPane summary, task header text.
    var body:  CGFloat { self == .compact ? 10 : 11 }
}

#if os(iOS)
import UIKit
private func resolveTimelineLayoutMode(
    horizontal: UserInterfaceSizeClass?,
    vertical: UserInterfaceSizeClass?
) -> TimelineLayoutMode {
    // iPhone portrait is the only device class Apple intends to be "compact".
    // iPhone landscape, iPad in any orientation, and macOS all have a regular
    // horizontal size class.
    if horizontal == .compact && vertical == .regular { return .compact }
    return .regular
}
#else
private func resolveTimelineLayoutMode(
    horizontal: Any? = nil,
    vertical: Any? = nil
) -> TimelineLayoutMode {
    .regular
}
#endif

struct TimelineStripView: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder

    @State private var focusedIndex: Int = -1
    /// Compact-mode tap-to-expand. -1 = none expanded.
    @State private var expandedIndex: Int = -1

    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var hSizeClass
    @Environment(\.verticalSizeClass) private var vSizeClass
    private var layoutMode: TimelineLayoutMode {
        resolveTimelineLayoutMode(horizontal: hSizeClass, vertical: vSizeClass)
    }
    #else
    private var layoutMode: TimelineLayoutMode { .regular }
    #endif

    /// Font scale tracks layout mode 1:1: compact-layout (iPhone portrait)
    /// → smaller fonts; regular layout (iPad / macOS / iPhone landscape) →
    /// previous defaults. Keeps tablet/desktop look unchanged while phone
    /// HUDs become readable at the cramped widths.
    private var fontScale: TimelineFontScale {
        layoutMode == .compact ? .compact : .regular
    }

    /// Read grouped entries — triggers re-render via timelineVersion observation.
    /// The daemon persists a low-level event stream, but this dashboard panel
    /// renders task/turn lifecycle rows: an in-flight `chat_start` is visible
    /// until a matching completion arrives, then the completion/result row
    /// becomes the unit shown in the list.
    private var grouped: [GroupedEntry] {
        timelineDisplayGroups(groupConsecutive(filteredEntries))
    }

    /// Accessed in body to register SwiftUI observation on timeline changes
    private var timelineVersion: Int { stateHolder.timelineVersion }

    private var timelineFilter: TimelineSessionFilter? {
        guard let sessionId = stateHolder.state.focusedSessionId else { return nil }
        if let primaryId = stateHolder.state.sessionId, primaryId == sessionId {
            return TimelineSessionFilter(
                sessionId: sessionId,
                projectName: stateHolder.state.projectName,
                agentType: stateHolder.state.agentType
            )
        }
        if let session = stateHolder.state.siblingSessions.first(where: { $0.id == sessionId }) {
            return TimelineSessionFilter(
                sessionId: sessionId,
                projectName: session.projectName,
                agentType: session.agentType
            )
        }
        if sessionId == "openclaw-gateway" {
            return TimelineSessionFilter(sessionId: sessionId, projectName: "OpenClaw", agentType: "openclaw")
        }
        return TimelineSessionFilter(sessionId: sessionId, projectName: nil, agentType: nil)
    }

    private var timelineFilterKey: String {
        timelineFilter?.sessionId ?? "all"
    }

    private var filteredEntries: [TimelineEntry] {
        let entries = stateHolder.timelineStore.entries
        guard let filter = timelineFilter else { return entries }
        return entries.filter { entry in
            entry.matchesTimelineFilter(filter)
        }
    }

    private var focusedGroup: GroupedEntry? {
        if grouped.isEmpty { return nil }
        if focusedIndex < 0 || focusedIndex >= grouped.count {
            return grouped.last
        }
        return grouped[focusedIndex]
    }

    var body: some View {
        Group {
            switch layoutMode {
            case .regular: regularBody
            case .compact: compactBody
            }
        }
        .padding(.horizontal, layoutMode == .compact ? 8 : 16)
        .padding(.vertical, 4)
        .onChange(of: timelineFilterKey) {
            focusedIndex = -1
            expandedIndex = -1
        }
    }

    /// Regular layout: 65/35 HStack (iPad / macOS / iPhone landscape).
    private var regularBody: some View {
        GeometryReader { geo in
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    timelineHeader
                    timelineList(allowExpand: false)
                }
                .frame(width: geo.size.width * 0.65, alignment: .topLeading)
                .frame(maxHeight: .infinity, alignment: .topLeading)

                Rectangle()
                    .fill(TerrariumHUD.subtext.opacity(0.3))
                    .frame(width: 1)
                    .padding(.vertical, 8)

                detailPane(focusedGroup)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    /// Compact layout: single-column with tap-to-expand inline detail.
    /// Used on iPhone portrait where the right detail pane is too narrow to
    /// be useful (~120 dp after split).
    private var compactBody: some View {
        // Pin the column to the top of its allotted area so the empty-state
        // text ("TIMELINE" + "No events yet") doesn't drift to centre on
        // iPhone portrait — host gives the strip a fixed sand-fraction
        // height; without explicit top alignment SwiftUI distributes the
        // unused vertical space, which reads as middle-of-area.
        VStack(alignment: .leading, spacing: 0) {
            timelineHeader
            timelineList(allowExpand: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private var timelineHeader: some View {
        HStack(spacing: 4) {
            Text("TIMELINE")
                .id(timelineVersion)
                .font(.system(size: fontScale.sub, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)
            if let filter = timelineFilter {
                Text("· \(filter.label)")
                    .font(.system(size: fontScale.sub, weight: .medium, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.tetraNeon.opacity(0.82))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 8)
        .padding(.top, 4)
        .padding(.bottom, 2)
    }

    /// `allowExpand=true` — compact mode: tap toggles inline detail.
    /// `allowExpand=false` — regular mode: tap selects for the right detail pane.
    @ViewBuilder
    private func timelineList(allowExpand: Bool) -> some View {
        if grouped.isEmpty {
            // Hard-anchor empty-state text to the top — even if the parent
            // alignment hint isn't honoured (e.g. on a SwiftUI version that
            // centres single-child VStacks), the trailing Spacer here pushes
            // the text up.
            VStack(alignment: .leading, spacing: 0) {
                Text(timelineFilter == nil ? "No events yet" : "No events for this session")
                    .font(.system(size: fontScale.sub, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .padding(.horizontal, 8)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(grouped.enumerated()), id: \.offset) { index, group in
                            VStack(alignment: .leading, spacing: 0) {
                                compactLogRow(group, index: index, allowMultiline: allowExpand)
                                    .id(index)
                                    .onTapGesture {
                                        if allowExpand {
                                            expandedIndex = (expandedIndex == index) ? -1 : index
                                            focusedIndex = index
                                        } else {
                                            focusedIndex = index
                                        }
                                    }
                                if allowExpand && expandedIndex == index {
                                    inlineDetailPane(group)
                                        .padding(.leading, 18)
                                        .padding(.trailing, 6)
                                        .padding(.vertical, 4)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 4)
                }
                .onChange(of: grouped.count) {
                    if !grouped.isEmpty, focusedIndex < 0 {
                        proxy.scrollTo(grouped.count - 1, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Compact Log Row

    @ViewBuilder
    private func compactLogRow(_ group: GroupedEntry, index: Int, allowMultiline: Bool) -> some View {
        if group.entry.type == .taskStart || group.entry.type == .taskEnd {
            taskHeaderRow(group, index: index)
        } else {
            turnRow(group, index: index, allowMultiline: allowMultiline)
        }
    }

    private func turnRow(_ group: GroupedEntry, index: Int, allowMultiline: Bool) -> some View {
        let isSelected = index == focusedIndex ||
            (focusedIndex < 0 && index == grouped.count - 1)
        let isChatEnd = group.entry.type == .chatEnd
        // The turn is "completed" the moment EITHER chat_response or
        // chat_end is merged in — `GroupedEntry.hasResponse`. chat_end
        // is unreliable in production (Stop hook ~18% reliability;
        // chat_end is emitted from a Task that awaits a summarizer that
        // can hang), so requiring it for the spinner-stop is what made
        // the dashboard look frozen on already-delivered replies.
        // Codex stop-time review #11 (2026-05-17).
        let merged = group.hasResponse
        let isCompleted = group.hasResponse
        let iconKey: TimelineIconKey = {
            if group.entry.type == .chatStart && isCompleted { return .success }
            return timelineIconKey(for: group.entry.type, status: group.entry.status)
        }()
        let iconColor = group.entry.type == .chatStart && isCompleted
            ? timelineTypeColor(for: .chatEnd)
            : timelineTypeColor(for: group.entry.type)
        let brandColor = SessionBrand.color(for: group.entry.agentType)
        let countSuffix = group.count > 1 ? " ×\(group.count)" : ""
        let sessionLabel = rowPrefixLabel(for: group.entry)
        let isRotating: Bool = {
            if group.entry.type == .chatStart && isCompleted { return false }
            return timelineIsRotatingEntry(group.entry, siblings: grouped.map(\.entry))
        }()

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                // Indent turn rows under task headers — visual cue that this turn
                // belongs to the task above it.
                if group.entry.taskId != nil {
                    Spacer().frame(width: 8)
                }

                Text(formatTime(group.entry.date))
                    .font(.system(size: fontScale.sub, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(isChatEnd ? 0.4 : 0.5))

                // Animate the leading icon when the row is in flight (running
                // state). `.symbolEffect(.rotate)` would be cleaner but requires
                // iOS 18 / macOS 15; the project's iOS deploy target is 17.0,
                // so use a TimelineView-driven rotationEffect that works on iOS 17+.
                RotatingTimelineIcon(
                    symbolName: sfSymbol(for: iconKey),
                    font: .system(size: fontScale.sub, weight: .bold),
                    color: iconColor.opacity(isChatEnd ? 0.6 : 1),
                    size: 12,
                    isRotating: isRotating
                )
                .accessibilityLabel(iconKey.rawValue)

                AgentBrandIcon(
                    agentType: group.entry.agentType,
                    tint: brandColor.opacity(isChatEnd ? 0.65 : 1),
                    size: 10,
                    contentInset: (group.entry.agentType == "codex-cli" || group.entry.agentType == "codex-app") ? 0.9 : 0.5
                )
                .frame(width: 12, height: 12)

                if !sessionLabel.isEmpty {
                    Text(sessionLabel)
                        .font(.system(size: fontScale.sub, weight: .medium, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext.opacity(isChatEnd ? 0.55 : 0.75))
                        .lineLimit(1)
                }

                // Strip markdown decorators from the summary so `**bold**` /
                // `## heading` don't leak into the row as literal characters.
                // (The regular detail pane / compact inline-expand still renders
                // the full markdown.)
                Text(strippedRaw(timelineSummaryTextForDashboard(group)) + countSuffix)
                    .font(.system(size: fontScale.sub, design: .monospaced))
                    .foregroundStyle(isChatEnd ? TerrariumHUD.text.opacity(0.6) : TerrariumHUD.text)
                    .lineLimit(allowMultiline ? 2 : 1)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: allowMultiline)

                Spacer()

                // chat_end rows carry a tiny backend pill so the user can see
                // which provider produced the topic suffix and confirm the
                // Settings → Timeline summary picker is taking effect. Hidden
                // for non-chat_end rows and for entries without a kind tag
                // (legacy on-disk rows, gateway entries, plain heuristic).
                // For merged turn rows, the pill is rendered on the completion
                // sub-line instead so it sits next to the "Completed · …" suffix.
                if isChatEnd && !merged,
                   let kindLabel = summaryBackendLabel(group.entry.summaryKind) {
                    Text(kindLabel)
                        .font(.system(size: max(8, fontScale.label - 1), weight: .semibold, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                        .padding(.horizontal, 4)
                        .padding(.vertical, 1)
                        .background(
                            TerrariumHUD.subtext.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 3)
                        )
                        .accessibilityLabel("Summary backend: \(kindLabel)")
                }
            }

            // Sub-line: assistant response body. Indented + dimmed so the
            // user prompt above stays the primary reading anchor.
            if let resp = group.mergedResponse, !timelineIsProgressChatResponse(resp) {
                HStack(alignment: .top, spacing: 4) {
                    Spacer().frame(width: group.entry.taskId != nil ? 64 : 56)
                    Text("→")
                        .font(.system(size: fontScale.sub, weight: .semibold, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext.opacity(0.55))
                    Text(strippedRaw(resp.raw))
                        .font(.system(size: fontScale.sub, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.text.opacity(0.78))
                        .lineLimit(allowMultiline ? 3 : 1)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: allowMultiline)
                    Spacer(minLength: 0)
                }
            }

            // Sub-line: terminator metadata ("Completed · 2s · topic") +
            // the summary-backend pill.
            if let end = group.mergedCompletion, end.summaryKind != "progress" {
                HStack(spacing: 4) {
                    Spacer().frame(width: group.entry.taskId != nil ? 64 : 56)
                    Text(strippedRaw(end.raw))
                        .font(.system(size: fontScale.label, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
                        .lineLimit(1)
                    if let kindLabel = summaryBackendLabel(end.summaryKind) {
                        Text(kindLabel)
                            .font(.system(size: max(8, fontScale.label - 1), weight: .semibold, design: .monospaced))
                            .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(
                                TerrariumHUD.subtext.opacity(0.12),
                                in: RoundedRectangle(cornerRadius: 3)
                            )
                            .accessibilityLabel("Summary backend: \(kindLabel)")
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 1)
        .background(
            isSelected ? Color.white.opacity(0.08) : Color.clear,
            in: RoundedRectangle(cornerRadius: 2)
        )
        // Selection indicator drawn as overlay so it doesn't push row
        // content right when it appears. Sits in the parent LazyVStack's
        // 4 dp horizontal padding via a negative x offset.
        .overlay(alignment: .leading) {
            if isSelected {
                Rectangle()
                    .fill(iconColor)
                    .frame(width: 2, height: 14)
                    .offset(x: -6)
            }
        }
    }

    /// Short pill label for `summaryKind`. Every kind that AgentDeck knows
    /// it produced gets a visible tag — including heuristic, since the
    /// App Store deployment target is macOS 15 but FoundationModels needs
    /// macOS 26, so the default `auto` chain falls through to heuristic on
    /// the majority of installs. Hiding the heuristic pill made the entire
    /// feature read as "not running" for those users. Pill is suppressed
    /// only for unrecognized values, the gave-up sentinel ("none"), and
    /// nil (legacy on-disk rows from before the field existed, plus
    /// gateway pass-through entries that don't carry one).
    private func summaryBackendLabel(_ kind: String?) -> String? {
        switch kind {
        case "appleIntelligence": return "AI"
        case "mlx":                return "MLX"
        case "ollama":             return "Ollama"
        case "heuristic":          return "Heur"
        default:                   return nil
        }
    }

    /// Strip lightweight markdown so `## 정리`, `**bold**`, `[text](url)`,
    /// backtick-code don't leak into the summary line. Mirrors
    /// `cleanRawText` from `shared/src/timeline.ts`.
    private func strippedRaw(_ raw: String) -> String {
        var out = raw
        // Bold: **text** → text
        out = out.replacingOccurrences(of: #"\*\*([^*]+)\*\*"#, with: "$1", options: .regularExpression)
        // Heading: leading 1-6 hashes + space → ""
        out = out.replacingOccurrences(of: #"(?m)^#{1,6}\s+"#, with: "", options: .regularExpression)
        // Markdown link: [text](url) → text
        out = out.replacingOccurrences(of: #"\[([^\]]+)\]\([^)]+\)"#, with: "$1", options: .regularExpression)
        // Inline code: `code` → code
        out = out.replacingOccurrences(of: #"`([^`]+)`"#, with: "$1", options: .regularExpression)
        // Table pipes and separators: | text | or ---|---|---
        out = out.replacingOccurrences(of: #"^[|:\-\s]+$"#, with: "", options: [.regularExpression, .anchored])
        out = out.replacingOccurrences(of: #"\|"#, with: " ", options: .regularExpression)
        // HTML tags: <img ... /> or <div>
        out = out.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)

        let cleaned = out.trimmingCharacters(in: .whitespacesAndNewlines)
        return smartTruncate(cleaned, limit: 120)
    }

    /// Truncates string at word/Korean-character boundaries rather than cutting in the middle of a token.
    private func smartTruncate(_ text: String, limit: Int) -> String {
        guard text.count > limit else { return text }
        let index = text.index(text.startIndex, offsetBy: limit - 3)
        let substring = text[..<index]

        // Try to find the last space to truncate at a word boundary
        if let lastSpaceRange = substring.range(of: " ", options: .backwards) {
            let spaceIndex = lastSpaceRange.lowerBound
            if text.distance(from: spaceIndex, to: index) < 15 { // only back off up to 15 characters
                return String(text[..<spaceIndex]) + "..."
            }
        }
        return String(substring) + "..."
    }

    /// Inline detail block used in compact mode (iPhone portrait) below the
    /// tapped row. Mirrors the right-side detail pane's content shape but
    /// laid out vertically inside the list.
    @ViewBuilder
    private func inlineDetailPane(_ group: GroupedEntry) -> some View {
        let entry = group.entry
        VStack(alignment: .leading, spacing: 4) {
            let lifecycleRows = lifecycleDetailRows(for: entry)
            if !lifecycleRows.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(lifecycleRows.enumerated()), id: \.offset) { _, row in
                        Text("\(row.label) \(row.value)")
                            .font(.system(size: fontScale.label, design: .monospaced))
                            .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
                    }
                }
            }
            let detailEntry = timelineDetailEntryForDashboard(group)
            if let detail = detailEntry.detail,
               shouldShowDetail(entry: detailEntry, detail: detail) {
                TimelineMarkdownPreview(text: detail)
            } else {
                Text("Tap collapse · summary only")
                    .font(.system(size: fontScale.label, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.5))
            }
        }
        .background(Color.black.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
        .padding(.vertical, 2)
    }

    /// Whether to show the detail body for this entry.
    /// Suppress when:
    ///   - summaryKind == "none" (heuristic gave up; detail is just raw response → noisy)
    ///   - detailIsRedundant matches against raw
    private func shouldShowDetail(entry: TimelineEntry, detail: String) -> Bool {
        timelineShouldShowDetailForDashboard(entry: entry, detail: detail)
    }

    /// Task hierarchy header — visually distinct full-width row that groups
    /// the turn rows below it. Renders for both task_start and task_end so
    /// the timeline shows where work units begin and where they were declared
    /// finished (and by which boundary signal).
    private func taskHeaderRow(_ group: GroupedEntry, index: Int) -> some View {
        let entry = group.entry
        let isEnd = entry.type == .taskEnd
        let isSelected = index == focusedIndex ||
            (focusedIndex < 0 && index == grouped.count - 1)
        let accent = TerrariumHUD.tetraNeon
        let sessionLabel = rowPrefixLabel(for: entry)

        return HStack(spacing: 6) {
            // Rotate the TASK marker while the task_start has no matching
            // task_end yet — gives an at-a-glance "this task is still running"
            // signal alongside the static `.task` glyph for closed tasks.
            // Static state shows `list.bullet.rectangle.fill` (task identity);
            // rotation swaps in `arrow.triangle.2.circlepath` so the spinner
            // reads as a spinner rather than a flickering square.
            RotatingTimelineIcon(
                symbolName: sfSymbol(for: .task),
                font: .system(size: fontScale.body, weight: .bold),
                color: accent,
                size: 14,
                isRotating: timelineIsRotatingEntry(entry, siblings: grouped.map(\.entry)),
                rotatingSymbolName: sfSymbol(for: .running)
            )
            Text(isEnd ? "TASK END" : "TASK")
                .font(.system(size: fontScale.sub, weight: .heavy, design: .monospaced))
                .foregroundStyle(accent)
            if !sessionLabel.isEmpty {
                Text(sessionLabel)
                    .font(.system(size: fontScale.sub, weight: .medium, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .lineLimit(1)
            }
            Text(entry.raw)
                .font(.system(size: fontScale.sub, weight: .semibold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.text)
                .lineLimit(1)
            Spacer()
            // Eval badge — only meaningful on task_end. While the judge is
            // still running (taskOutcome == nil / "pending"), shows a dim "…"
            // placeholder so users learn that an evaluation is on the way.
            if isEnd {
                TaskEvalBadge(
                    score: entry.taskScore,
                    outcome: entry.taskOutcome,
                    fontSize: fontScale.label
                )
            }
            Text(formatTime(entry.date))
                .font(.system(size: fontScale.label, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.6))
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(
            (isSelected ? accent.opacity(0.18) : accent.opacity(0.08)),
            in: RoundedRectangle(cornerRadius: 3)
        )
        .overlay(
            // Top hairline on task_start, bottom hairline on task_end — gives
            // each task a visual envelope without doubling vertical padding.
            VStack(spacing: 0) {
                if !isEnd {
                    Rectangle().fill(accent.opacity(0.6)).frame(height: 1)
                }
                Spacer()
                if isEnd {
                    Rectangle().fill(accent.opacity(0.6)).frame(height: 1)
                }
            }
        )
        // Selection indicator overlay (drawn outside the row content so it
        // never shifts text right when toggled).
        .overlay(alignment: .leading) {
            if isSelected {
                Rectangle()
                    .fill(accent)
                    .frame(width: 2, height: 18)
                    .offset(x: -6)
            }
        }
    }

    /// Produce the compact-row attribution prefix. Prefers `projectName`
    /// (e.g. "AgentDeck") over the coarser `agentType` ("Claude"). Falls
    /// back to the agent tag when no project is recorded so OpenClaw or
    /// legacy entries still get *something* readable.
    private func rowPrefixLabel(for entry: TimelineEntry) -> String {
        if let p = entry.projectName, !p.isEmpty {
            return "[\(p)]"
        }
        let tag = agentTag(entry.agentType)
        return tag.isEmpty ? "" : "[\(tag)]"
    }

    // MARK: - Detail Pane

    private func detailPane(_ group: GroupedEntry?) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let group {
                // Mirror the turnRow's hasResponse-aware spinner stop —
                // detail pane shares the same chat_start row identity,
                // so when chat_response (or chat_end) is merged in, the
                // pane's leading icon must also flip to success and
                // stop rotating. Without this, opening the detail pane
                // on a delivered turn whose chat_end dropped (Stop hook
                // unreliability / async summarize hang) shows a spinner
                // that keeps rotating forever even though the row above
                // is already a static checkmark. Codex stop-time review
                // #12 (2026-05-17).
                let isTurnCompleted = group.entry.type == .chatStart && group.hasResponse
                let iconKey: TimelineIconKey = isTurnCompleted
                    ? .success
                    : timelineIconKey(for: group.entry.type, status: group.entry.status)
                let iconColor = isTurnCompleted
                    ? timelineTypeColor(for: .chatEnd)
                    : timelineTypeColor(for: group.entry.type)
                let isRotating: Bool = isTurnCompleted
                    ? false
                    : timelineIsRotatingEntry(group.entry, siblings: grouped.map(\.entry))
                let countSuffix = group.count > 1 ? " (×\(group.count))" : ""

                // Header: type badge chip + timestamp
                HStack(spacing: 6) {
                    HStack(spacing: 3) {
                        RotatingTimelineIcon(
                            symbolName: sfSymbol(for: iconKey),
                            font: .system(size: fontScale.label, weight: .bold),
                            color: .white,
                            size: nil,
                            isRotating: isRotating
                        )
                        Text(formatType(group.entry.type))
                            .font(.system(size: fontScale.label, weight: .bold, design: .monospaced))
                            .foregroundStyle(.white)
                    }
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(iconColor.opacity(0.7), in: RoundedRectangle(cornerRadius: 3))

                    Spacer()

                    Text(formatTimeSeconds(group.entry.date))
                        .font(.system(size: fontScale.label, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)
                }
                .padding(.horizontal, 8)
                .padding(.top, 4)

                // Source tag
                let sourceLabel = sourceLabel(for: group.entry)
                if !sourceLabel.isEmpty {
                    Text(sourceLabel + countSuffix)
                        .font(.system(size: fontScale.label, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
                        .padding(.horizontal, 8)
                }

                let lifecycleRows = lifecycleDetailRows(for: group.entry)
                if !lifecycleRows.isEmpty {
                    Spacer().frame(height: 4)
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(lifecycleRows.enumerated()), id: \.offset) { _, row in
                            HStack(spacing: 4) {
                                Text(row.label)
                                    .font(.system(size: max(7, fontScale.label - 1), weight: .bold, design: .monospaced))
                                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
                                    .frame(width: 42, alignment: .leading)
                                Text(row.value)
                                    .font(.system(size: max(7, fontScale.label - 1), design: .monospaced))
                                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.82))
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                }

                Spacer().frame(height: 4)

                // Task eval verdict — rendered between the lifecycle rows and
                // the raw summary so the score is visible without scrolling.
                // Only meaningful on task_end; non-task entries skip this view.
                if group.entry.type == .taskEnd {
                    HStack(alignment: .top, spacing: 6) {
                        TaskEvalBadge(
                            score: group.entry.taskScore,
                            outcome: group.entry.taskOutcome,
                            fontSize: fontScale.body
                        )
                        if let cat = group.entry.taskCategory, !cat.isEmpty {
                            Text(cat)
                                .font(.system(size: fontScale.label, weight: .medium, design: .monospaced))
                                .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                                .padding(.horizontal, 4)
                                .padding(.vertical, 1)
                                .background(
                                    RoundedRectangle(cornerRadius: 3)
                                        .stroke(TerrariumHUD.subtext.opacity(0.4), lineWidth: 0.5)
                                )
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 8)
                    if let summary = group.entry.taskSummary, !summary.isEmpty {
                        Text(summary)
                            .font(.system(size: fontScale.label, design: .monospaced))
                            .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                            .lineLimit(3)
                            .padding(.horizontal, 8)
                            .padding(.top, 2)
                    }
                    Spacer().frame(height: 4)
                }

                // Summary
                Text(timelineSummaryTextForDashboard(group))
                    .font(.system(size: fontScale.body, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
                    .padding(.horizontal, 8)

                // Detail text — gated by `shouldShowDetail` which suppresses:
                //   (a) summaryKind == "none" (heuristic last-resort: detail
                //       is just the raw response we couldn't summarize, so
                //       showing it duplicates the summary noisily)
                //   (b) detailIsRedundant fuzzy match against raw (LLM /
                //       heuristic summarizer paraphrased the response opening)
                let detailEntry = timelineDetailEntryForDashboard(group)
                if let detail = detailEntry.detail,
                   shouldShowDetail(entry: detailEntry, detail: detail) {
                    Spacer().frame(height: 4)
                    ScrollView {
                        TimelineMarkdownPreview(text: detail)
                    }
                    .padding(.horizontal, 8)
                }

                Spacer()
            } else {
                Spacer()
                Text("No events")
                    .font(.system(size: fontScale.sub, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.5))
                    .frame(maxWidth: .infinity)
                Spacer()
            }
        }
        .background(Color.black.opacity(0.19), in: RoundedRectangle(cornerRadius: 4))
    }

    /// Whether a detail blob duplicates the summary row enough to suppress.
    /// Mirrors `timelineDetailIsRedundant` in
    /// android/.../ui/timeline/TimelineMarkdownView.kt — keep the rules in
    /// lockstep so the two dashboards behave identically.
    private func detailIsRedundant(detail: String, raw: String) -> Bool {
        if detail == raw { return true }
        let normalize: (String) -> String = { s in
            s.lowercased()
                .components(separatedBy: CharacterSet.alphanumerics.inverted)
                .filter { !$0.isEmpty }
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespaces)
        }

        // Phase 2 fix (log-based): real entries from ~/.agentdeck/timeline.json
        // routinely look like:
        //   raw    = "정리\n\nfocusSession 의 시각 효과 추가됨:\n\n| 변경 | 위치 |..."
        //   detail = "## 정리\n\n**focusSession 의 시각 효과 추가됨:**\n\n| 변경 | 위치 |..."
        // i.e. detail is just the markdown-formatted version of raw. Strip
        // markdown from detail and compare the FULL strings, not just the
        // first paragraph. The first-paragraph rule misclassified these as
        // distinct because "## 정리" normalized to a single token.
        let strippedDetailFull = stripMarkdownInline(detail)
        let nRawFull = normalize(raw)
        let nDetailFull = normalize(strippedDetailFull)

        if !nRawFull.isEmpty && !nDetailFull.isEmpty {
            if nDetailFull == nRawFull { return true }
            // Detail covers raw fully, raw covers ≥85% of detail tokens → redundant.
            let rTokens = nRawFull.split(separator: " ")
            let dTokens = nDetailFull.split(separator: " ")
            let common = Array(rTokens.prefix(dTokens.count))
            if dTokens.count >= 3 && common == Array(dTokens.prefix(common.count))
                && Double(common.count) / Double(max(dTokens.count, 1)) >= 0.85 {
                return true
            }
            // Token-prefix rule (8 tokens) — covers heuristic-summary + duration suffix case.
            let r8 = Array(rTokens.prefix(8))
            let d8 = Array(dTokens.prefix(8))
            if r8.count >= 3 && r8 == d8 { return true }
        }

        // Legacy first-paragraph rule (kept for chat_end "Topic · 4s · 2 tools"
        // shapes where detail is the response opening).
        let firstPara = detail.components(separatedBy: "\n\n").first ?? detail
        let nDetailPara = normalize(stripMarkdownInline(firstPara))
        if !nRawFull.isEmpty && !nDetailPara.isEmpty {
            if nDetailPara.hasPrefix(nRawFull) { return true }
            if let rawHead = raw.components(separatedBy: " · ").first,
               !rawHead.trimmingCharacters(in: .whitespaces).isEmpty {
                let nHead = normalize(rawHead)
                if !nHead.isEmpty,
                   nHead.split(separator: " ").count >= 2,
                   nDetailPara.hasPrefix(nHead) {
                    return true
                }
            }
            let rawTokens = nRawFull.split(separator: " ").prefix(6)
            let detailTokens = nDetailPara.split(separator: " ").prefix(6)
            if rawTokens.count >= 3 && Array(rawTokens) == Array(detailTokens) {
                return true
            }
        }
        return false
    }

    /// Lightweight inline markdown strip (mirrors `cleanDetailText` from
    /// `shared/src/timeline.ts`). Keeps line breaks; strips fences, bold,
    /// italic, headings, blockquotes, list bullets, links, inline code.
    private func stripMarkdownInline(_ s: String) -> String {
        var out = s
        // Code fences ```lang ... ``` → contents
        out = out.replacingOccurrences(of: "```[\\w]*\\n?([\\s\\S]*?)```",
                                       with: "$1", options: .regularExpression)
        out = out.replacingOccurrences(of: "\\*\\*([^*]+)\\*\\*",
                                       with: "$1", options: .regularExpression)
        out = out.replacingOccurrences(of: "(?<!\\*)\\*([^*\\n]+)\\*(?!\\*)",
                                       with: "$1", options: .regularExpression)
        out = out.replacingOccurrences(of: "^#{1,6}\\s+", with: "",
                                       options: [.regularExpression])
        // Multiline-anchored strips
        out = out.replacingOccurrences(of: "(?m)^>\\s+", with: "", options: .regularExpression)
        out = out.replacingOccurrences(of: "(?m)^[-*]\\s+", with: "", options: .regularExpression)
        out = out.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)",
                                       with: "$1", options: .regularExpression)
        out = out.replacingOccurrences(of: "`([^`]+)`",
                                       with: "$1", options: .regularExpression)
        // Additional strips for pre-flight polish
        out = out.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        out = out.replacingOccurrences(of: "\\|", with: " ", options: .regularExpression)
        return out.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Helpers

    private func timelineDisplayGroups(_ groups: [GroupedEntry]) -> [GroupedEntry] {
        timelineDisplayGroupsForDashboard(groups)
    }

    private func hasLaterCompletion(for start: TimelineEntry, in groups: [GroupedEntry]) -> Bool {
        timelineHasLaterCompletion(for: start, in: groups)
    }

    private func hasPairedChatResponse(for end: TimelineEntry, in groups: [GroupedEntry]) -> Bool {
        timelineHasPairedChatResponse(for: end, in: groups)
    }

    private func isCompletionEntry(_ entry: TimelineEntry) -> Bool {
        timelineIsCompletionEntry(entry)
    }

    private func sameTimelineContext(_ a: TimelineEntry, _ b: TimelineEntry) -> Bool {
        timelineSameContext(a, b)
    }

    private func lifecycleDetailRows(for entry: TimelineEntry) -> [(label: String, value: String)] {
        let startMs = entry.startedAt ?? pairedStart(for: entry)?.ts
        let endMs = entry.endedAt ?? (isCompletionEntry(entry) || entry.type == .evalResult ? entry.ts : nil)
        var rows: [(String, String)] = []
        if let startMs {
            rows.append(("START", formatTimeSeconds(Date(timeIntervalSince1970: startMs / 1000))))
        }
        if let endMs, isCompletionEntry(entry) || entry.type == .evalResult {
            rows.append(("END", formatTimeSeconds(Date(timeIntervalSince1970: endMs / 1000))))
        }
        if let startMs, let endMs, endMs >= startMs {
            rows.append(("DUR", formatDuration(endMs - startMs)))
        }
        return rows
    }

    private func pairedStart(for entry: TimelineEntry) -> TimelineEntry? {
        stateHolder.timelineStore.entries.last { candidate in
            candidate.type == .chatStart &&
                candidate.ts <= entry.ts &&
                entry.ts - candidate.ts <= 12 * 60 * 60 * 1000 &&
                sameTimelineContext(candidate, entry)
        }
    }

    private func formatTime(_ date: Date) -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm"
        return fmt.string(from: date)
    }

    private func formatTimeSeconds(_ date: Date) -> String {
        let fmt = DateFormatter()
        fmt.dateFormat = "HH:mm:ss"
        return fmt.string(from: date)
    }

    private func formatDuration(_ ms: Double) -> String {
        let seconds = max(0, Int((ms / 1000).rounded()))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        let rem = seconds % 60
        if minutes < 60 { return "\(minutes)m \(rem)s" }
        let hours = minutes / 60
        return "\(hours)h \(minutes % 60)m"
    }

    private func agentTag(_ agentType: String?) -> String {
        switch agentType {
        case "claude-code": "Claude"
        case "codex-cli": "Codex CLI"
        case "codex-app": "Codex App"
        case "openclaw": "OpenClaw"
        case "opencode": "OpenCode"
        case "daemon": "Daemon"
        case nil: ""
        default: "Agent"
        }
    }

    private func sourceLabel(for entry: TimelineEntry) -> String {
        let project = entry.projectName?.isEmpty == false ? entry.projectName : nil
        let tag = agentTag(entry.agentType)
        if let project, !tag.isEmpty {
            return "\(project) · \(tag)"
        }
        return project ?? tag
    }

    private func formatType(_ type: TimelineEntryType) -> String {
        switch type {
        case .toolRequest: return "TOOL"
        case .toolResolved: return "DONE"
        case .toolExec: return "EXEC"
        case .modelCall: return "MODEL"
        case .modelResponse: return "RESP"
        case .chatStart: return "CHAT"
        case .chatEnd: return "END"
        case .chatResponse: return "REPLY"
        case .memoryRecall: return "MEM"
        case .error: return "ERR"
        case .scheduled: return "SCHED"
        case .userAction: return "USER"
        case .evalResult: return "EVAL"
        case .taskStart: return "TASK"
        case .taskEnd: return "TASK ✓"
        case .unknown(let raw): return raw.uppercased()
        }
    }
}

func timelineDisplayGroupsForDashboard(_ groups: [GroupedEntry]) -> [GroupedEntry] {
    groups.filter { group in
        let entry = group.entry
        if entry.type == .taskStart || entry.type == .taskEnd {
            return timelineShouldShowTaskMarker(group)
        }
        if timelineIsLowSignalEntry(entry) { return false }
        if timelineIsTaskNotificationChatStart(entry) { return false }
        if timelineIsProgressChatResponse(entry) { return false }
        if entry.type == .chatStart {
            if !timelineHasLaterCompletion(for: entry, in: groups) { return true }
            return timelineIsMeaningfulChatStart(entry)
        }
        if entry.type == .modelCall {
            return !timelineHasLaterCompletion(for: entry, in: groups)
        }
        if entry.type == .chatEnd {
            if entry.summaryKind == "progress" { return false }
            // Completion metadata belongs under its response row. Keep a
            // standalone row only for legacy response-less + prompt-less
            // entries. If the prompt row exists, that is the user-facing unit;
            // a separate Completed row is just turn-close metadata.
            return !timelineHasPairedChatResponse(for: entry, in: groups) &&
                !timelineHasPairedChatStart(for: entry, in: groups)
        }
        return true
    }
}

func timelineShouldShowTaskMarker(_ group: GroupedEntry) -> Bool {
    let entry = group.entry
    guard entry.type == .taskStart || entry.type == .taskEnd else { return true }
    if entry.taskCategory == "_empty" { return false }
    // session_end is an internal sample boundary, not a user activity. Some
    // sessions use the handoff command and some do not, so showing it as a
    // standalone TASK END row makes the visible timeline depend on workflow
    // hygiene rather than actual work.
    if entry.type == .taskEnd && entry.boundarySignal == .sessionEnd { return false }
    if entry.type == .taskEnd { return true }
    if timelineIsMeaningfulTaskTitle(entry.raw) { return true }
    return entry.taskScore != nil ||
        entry.taskOutcome?.isEmpty == false ||
        entry.taskCategory?.isEmpty == false ||
        entry.taskSummary?.isEmpty == false
}

func timelineIsMeaningfulTaskTitle(_ raw: String) -> Bool {
    let title = timelineStripMarkdownInline(raw)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return false }
    if title.range(of: #"^task\s+\d+$"#, options: [.regularExpression, .caseInsensitive]) != nil {
        return false
    }
    if title.range(of: #"^작업\s*\d+$"#, options: [.regularExpression]) != nil {
        return false
    }
    return true
}

func timelineSummaryTextForDashboard(_ group: GroupedEntry) -> String {
    timelinePromoteInformativeLead(group.entry.raw, type: group.entry.type)
}

func timelineDetailEntryForDashboard(_ group: GroupedEntry) -> TimelineEntry {
    if group.entry.type == .chatStart,
       let response = group.mergedResponse,
       !timelineIsProgressChatResponse(response) {
        return response
    }
    return group.entry
}

func timelineShouldShowDetailForDashboard(entry: TimelineEntry, detail: String) -> Bool {
    if entry.summaryKind == "none" || entry.summaryKind == "progress" { return false }
    if entry.type == .chatResponse && timelineLooksLikeAssistantProgressUpdate(entry.detail ?? entry.raw) {
        return false
    }
    let trimmed = detail.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    if entry.type == .chatResponse {
        let raw = entry.raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count > raw.count + 40 || trimmed.contains("\n")
    }
    return !timelineDetailIsRedundant(detail: detail, raw: entry.raw)
}

func timelineIsProgressChatResponse(_ entry: TimelineEntry) -> Bool {
    guard entry.type == .chatResponse else { return false }
    if entry.summaryKind == "progress" { return true }
    return timelineLooksLikeAssistantProgressUpdate(entry.detail ?? entry.raw)
}

func timelineLooksLikeAssistantProgressUpdate(_ text: String?) -> Bool {
    guard let text else { return false }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    let head = String(trimmed.prefix(800))
    let lower = head.lowercased()

    let progressPatterns = [
        #"\b(still|currently|continues? to|is|are)\s+(running|building|installing|executing|processing|waiting)\b"#,
        #"\b(still running|still building|build is running|is still running|are still running)\b"#,
        #"\b(waiting for|wait until|once (?:the )?.*(?:finishes|completes|arrives)|continue once|will continue once|i.ll continue once)\b"#,
        #"\b(no interim lines|buffers? output until completion|tail buffers output)\b"#,
    ]
    let englishProgress = progressPatterns.contains {
        lower.range(of: $0, options: .regularExpression) != nil
    }
    let koreanProgress =
        head.range(of: #"(아직|계속)\s*(실행|진행|빌드|설치)\s*중"#, options: .regularExpression) != nil ||
        head.range(of: #"(완료|끝나|도착)면\s*(계속|이어)"#, options: .regularExpression) != nil ||
        head.range(of: #"(기다리는 중|대기 중)"#, options: .regularExpression) != nil

    guard englishProgress || koreanProgress else { return false }

    let startsAsFinal =
        trimmed.range(of: #"^(done|completed|complete|fixed|merged|verified|all done)\b"#, options: [.regularExpression, .caseInsensitive]) != nil ||
        trimmed.range(of: #"^(완료|수정 완료|검증 완료|반영 완료|머지 완료)"#, options: .regularExpression) != nil
    return !startsAsFinal
}

func timelinePromoteInformativeLead(_ raw: String, type: TimelineEntryType) -> String {
    guard type == .chatResponse else { return raw }
    let paragraphs = raw
        .components(separatedBy: "\n\n")
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { !$0.isEmpty }
    guard paragraphs.count >= 2 else { return raw }

    var index = 0
    while index < min(2, paragraphs.count - 1),
          timelineIsGenericOutcomeLead(paragraphs[index]) {
        index += 1
    }
    return paragraphs[index]
}

private func timelineIsGenericOutcomeLead(_ text: String) -> Bool {
    let stripped = timelineStripMarkdownInline(text)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !stripped.isEmpty, stripped.count <= 96 else { return false }
    let lower = stripped.lowercased()
    if lower.hasPrefix("all done") || lower == "done" || lower.hasPrefix("done.") {
        return true
    }
    if stripped.hasPrefix("반영") || stripped.hasPrefix("완료") ||
       stripped.hasPrefix("전부 완료") || stripped.hasPrefix("수정 완료") ||
       stripped.hasPrefix("검증 완료") || stripped.hasPrefix("처리 완료") {
        return true
    }
    return lower.contains("verified") && lower.contains("desktop") && lower.count < 80
}

func timelineDetailIsRedundant(detail: String, raw: String) -> Bool {
    if detail == raw { return true }
    let normalize: (String) -> String = { s in
        s.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespaces)
    }

    let strippedDetailFull = timelineStripMarkdownInline(detail)
    let nRawFull = normalize(raw)
    let nDetailFull = normalize(strippedDetailFull)

    if !nRawFull.isEmpty && !nDetailFull.isEmpty {
        if nDetailFull == nRawFull { return true }
        let rTokens = nRawFull.split(separator: " ")
        let dTokens = nDetailFull.split(separator: " ")
        let common = Array(rTokens.prefix(dTokens.count))
        if dTokens.count >= 3 && common == Array(dTokens.prefix(common.count))
            && Double(common.count) / Double(max(dTokens.count, 1)) >= 0.85 {
            return true
        }
        let r8 = Array(rTokens.prefix(8))
        let d8 = Array(dTokens.prefix(8))
        if r8.count >= 3 && r8 == d8 { return true }
    }

    let firstPara = detail.components(separatedBy: "\n\n").first ?? detail
    let nDetailPara = normalize(timelineStripMarkdownInline(firstPara))
    if !nRawFull.isEmpty && !nDetailPara.isEmpty {
        if nDetailPara.hasPrefix(nRawFull) { return true }
        if let rawHead = raw.components(separatedBy: " · ").first,
           !rawHead.trimmingCharacters(in: .whitespaces).isEmpty {
            let nHead = normalize(rawHead)
            if !nHead.isEmpty,
               nHead.split(separator: " ").count >= 2,
               nDetailPara.hasPrefix(nHead) {
                return true
            }
        }
        let rawTokens = nRawFull.split(separator: " ").prefix(6)
        let detailTokens = nDetailPara.split(separator: " ").prefix(6)
        if rawTokens.count >= 3 && Array(rawTokens) == Array(detailTokens) {
            return true
        }
    }
    return false
}

func timelineStripMarkdownInline(_ s: String) -> String {
    var out = s
    out = out.replacingOccurrences(of: "```[\\w]*\\n?([\\s\\S]*?)```",
                                   with: "$1", options: .regularExpression)
    out = out.replacingOccurrences(of: "\\*\\*([^*]+)\\*\\*",
                                   with: "$1", options: .regularExpression)
    out = out.replacingOccurrences(of: "(?<!\\*)\\*([^*\\n]+)\\*(?!\\*)",
                                   with: "$1", options: .regularExpression)
    out = out.replacingOccurrences(of: "^#{1,6}\\s+", with: "",
                                   options: [.regularExpression])
    out = out.replacingOccurrences(of: "(?m)^>\\s+", with: "", options: .regularExpression)
    out = out.replacingOccurrences(of: "(?m)^[-*]\\s+", with: "", options: .regularExpression)
    out = out.replacingOccurrences(of: "\\[([^\\]]+)\\]\\([^)]+\\)",
                                   with: "$1", options: .regularExpression)
    out = out.replacingOccurrences(of: "`([^`]+)`",
                                   with: "$1", options: .regularExpression)
    out = out.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
    out = out.replacingOccurrences(of: "\\|", with: " ", options: .regularExpression)
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
}

func timelineHasLaterCompletion(for start: TimelineEntry, in groups: [GroupedEntry]) -> Bool {
    groups.contains { other in
        guard timelineIsCompletionEntry(other.entry) else { return false }
        guard other.entry.ts >= start.ts else { return false }
        return timelineSameContext(start, other.entry)
    }
}

func timelineHasPairedChatResponse(for end: TimelineEntry, in groups: [GroupedEntry]) -> Bool {
    groups.contains { other in
        guard other.entry.type == .chatResponse else { return false }
        guard timelineSameContext(end, other.entry) else { return false }
        if let endStartedAt = end.startedAt,
           let responseStartedAt = other.entry.startedAt,
           abs(endStartedAt - responseStartedAt) < 1000 {
            return true
        }
        return abs(end.ts - other.entry.ts) <= 10_000
    }
}

func timelineHasPairedChatStart(for end: TimelineEntry, in groups: [GroupedEntry]) -> Bool {
    groups.contains { other in
        let start = other.entry
        guard start.type == .chatStart else { return false }
        guard timelineSameContext(start, end) else { return false }
        if let endStartedAt = end.startedAt {
            return abs(endStartedAt - start.ts) < 1000
        }
        return start.ts <= end.ts && end.ts - start.ts <= 12 * 60 * 60 * 1000
    }
}

func timelineIsCompletionEntry(_ entry: TimelineEntry) -> Bool {
    entry.type == .chatResponse || entry.type == .chatEnd || entry.type == .modelResponse
}

func timelineSameContext(_ a: TimelineEntry, _ b: TimelineEntry) -> Bool {
    // 1) taskId — strongest grouping key; if both carry one, only same task groups.
    if let at = a.taskId, !at.isEmpty, let bt = b.taskId, !bt.isEmpty {
        return at == bt
    }
    // 2) runId — adapter-emitted generation id (OpenClaw Gateway).
    let ar = a.runId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let br = b.runId?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let ar, !ar.isEmpty, let br, !br.isEmpty { return ar == br }

    // 3) sessionId — once either side has a sessionId, that's authoritative.
    let asid = a.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let bsid = b.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let aHasSid = asid?.isEmpty == false
    let bHasSid = bsid?.isEmpty == false
    if aHasSid || bHasSid {
        return aHasSid && bHasSid && asid == bsid
    }

    // 4) Both sessionless — last-resort grouping by (projectName, agentType).
    // Only legal for legacy entries predating the multi-session attribution work.
    if let ap = a.projectName, let bp = b.projectName, !ap.isEmpty, ap == bp,
       a.agentType == b.agentType {
        return true
    }
    return a.projectName == nil && b.projectName == nil && a.agentType == b.agentType
}

// `timelineIsMeaningfulChatStart` moved to Model/Timeline.swift so the
// model-side `groupConsecutive` can apply the same predicate when deciding
// whether to merge a chat_start with its trailing chat_response/chat_end.

func timelineIsLowSignalEntry(_ entry: TimelineEntry) -> Bool {
    guard entry.type == .toolExec || entry.type == .toolRequest || entry.type == .toolResolved else {
        return false
    }
    // Codex emits one tool_exec per Bash/MCP action. Those rows are useful for
    // telemetry/eval ingestion, but they drown the user-facing timeline and can
    // make Claude work look like Codex work when multiple agents run together.
    if (entry.agentType == "codex-cli" || entry.agentType == "codex-app"), entry.type == .toolExec {
        return true
    }
    // Real signal in detail → keep regardless of placeholder raw.
    // OpenClaw producer's detail format is
    //   `[status: X]\n[input: ...]\n[output: ...]`
    // with each line independently optional, so an entry whose detail
    // is just "status: running" alone is still placeholder noise —
    // only `input:` / `output:` lines (or any non-status line) qualify
    // as real signal. Codex stop-time review 2026-05-18.
    if timelineDetailHasRealSignal(entry.detail) {
        return false
    }
    let raw = entry.raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if (entry.agentType == "codex-cli" || entry.agentType == "codex-app"), entry.sessionId == "codex:otel-active" {
        // Structural match, mirroring the OpenClaw branch below. The producer
        // (DaemonServer.appendCodexToolExec) composes raw as "<tool>" or
        // "<tool> completed", so prefix-match each placeholder name instead of
        // enumerating every suffix — an enumerated list silently leaks new
        // suffixes (the same class of gap the 2026-05-18 third-round Codex
        // review flagged on the OpenClaw filter). "tool"/"unknown" are dropped
        // at source since 2026-05-18 but persist in historical timeline.json;
        // "exec" is the generic shell span name.
        for placeholder in ["tool", "unknown", "exec"] {
            if raw == placeholder || raw.hasPrefix(placeholder + " ") { return true }
        }
        return false
    }
    // OpenClaw placeholder rows. Producer drops new ones at source as of
    // 2026-05-18; this filter catches historical entries loaded from
    // timeline.json. Structural match (`raw == "tool"` or starts with
    // `"tool · "`) so any status string is covered — Gateway's
    // SessionToolPayload.status is free-form (running/complete/pending/
    // error/failed/aborted/canceled/...). Codex stop-time review 2026-05-18
    // (third round) flagged `failed` slipping past the enumerated set.
    if entry.agentType == "openclaw" {
        return raw == "tool" || raw.hasPrefix("tool · ")
    }
    return false
}

/// Mirror of `DaemonTimelineStore.detailHasRealSignal`. Detail counts as
/// real signal when it contains at least one non-empty line that is not
/// just a `status: ...` ack — i.e. there's an `input:` / `output:` line
/// (OpenClaw producer format) or any other content worth surfacing.
func timelineDetailHasRealSignal(_ detail: String?) -> Bool {
    guard let detail else { return false }
    for rawLine in detail.split(omittingEmptySubsequences: true, whereSeparator: { $0 == "\n" || $0 == "\r" }) {
        let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        if !trimmed.lowercased().hasPrefix("status:") {
            return true
        }
    }
    return false
}

/// Score + outcome chip rendered at the right edge of a `task_end` header.
/// The judge runs async, so on the first emit `score == nil` and we render a
/// dim placeholder ("…"). When the second `task_end` arrives 5–30 s later
/// the row upserts and the chip materializes with the score + outcome glyph.
private struct TaskEvalBadge: View {
    let score: Double?
    let outcome: String?
    let fontSize: CGFloat

    var body: some View {
        let glyph: String
        let color: Color
        switch outcome {
        case "success":
            glyph = "✓"; color = DesignTokens.UI.ok
        case "partial":
            glyph = "△"; color = DesignTokens.UI.attn
        case "fail":
            glyph = "✗"; color = DesignTokens.UI.error
        case "abandoned":
            // User explicitly closed the task via `agentdeck task cancel`
            // (or the future detail-pane button). The judge preserves this
            // outcome instead of overwriting with its score-derived class —
            // render as a neutral "explicitly stopped" so the row doesn't
            // masquerade as pending nor read as agent failure.
            glyph = "⊘"; color = DesignTokens.UI.error.opacity(0.55)
        default:
            glyph = "…"; color = TerrariumHUD.subtext.opacity(0.6)
        }
        return HStack(spacing: 3) {
            if let score {
                Text(String(format: "%.2f", score))
                    .font(.system(size: fontSize, weight: .semibold, design: .monospaced))
                    .foregroundStyle(color)
            }
            Text(glyph)
                .font(.system(size: fontSize, weight: .bold, design: .monospaced))
                .foregroundStyle(color)
        }
        .padding(.horizontal, 5)
        .padding(.vertical, 1)
        .background(
            RoundedRectangle(cornerRadius: 3)
                .fill(color.opacity(score == nil ? 0.08 : 0.16))
        )
        .accessibilityLabel(score != nil ? "Task score \(String(format: "%.2f", score!)) \(outcome ?? "")" : "Task eval pending")
    }
}

/// SF Symbol icon that rotates continuously when `isRotating == true`.
/// Drives the rotation off `TimelineView(.animation)`'s context date so we
/// don't need iOS 18's `.symbolEffect(.rotate)` (project iOS deploy target
/// is 17.0). When `isRotating == false` it short-circuits to a plain Image
/// so non-running rows pay zero animation cost.
///
/// When `rotatingSymbolName` is supplied, that symbol is shown during rotation
/// and the static `symbolName` returns when rotation stops. This lets callers
/// keep a semantic glyph for the resting state (e.g. `list.bullet.rectangle.fill`
/// for the TASK marker) while swapping in a rotation-friendly shape (a
/// circular arrow) while the spinner is active — a square glyph spinning on
/// its centre reads as a glitch.
private struct RotatingTimelineIcon: View {
    let symbolName: String
    let font: Font
    let color: Color
    /// Optional explicit frame width/height. When nil, the icon sizes to its
    /// font (used inside the detail-pane chip where the layout already pads).
    let size: CGFloat?
    let isRotating: Bool
    /// Optional rotation-only symbol. nil = use `symbolName` in both states.
    var rotatingSymbolName: String? = nil

    private static let rotationPeriod: Double = 1.8 // seconds per full revolution

    var body: some View {
        Group {
            if isRotating {
                TimelineView(.animation) { context in
                    let elapsed = context.date.timeIntervalSince1970
                    let phase = elapsed.truncatingRemainder(dividingBy: Self.rotationPeriod)
                    let degrees = (phase / Self.rotationPeriod) * 360.0
                    rotatingImage
                        .rotationEffect(.degrees(degrees))
                }
            } else {
                staticImage
            }
        }
        .modifier(SizedFrame(size: size))
    }

    private var staticImage: some View {
        Image(systemName: symbolName)
            .font(font)
            .foregroundStyle(color)
    }

    private var rotatingImage: some View {
        Image(systemName: rotatingSymbolName ?? symbolName)
            .font(font)
            .foregroundStyle(color)
    }
}

private struct SizedFrame: ViewModifier {
    let size: CGFloat?
    func body(content: Content) -> some View {
        if let size {
            content.frame(width: size, height: size)
        } else {
            content
        }
    }
}

private struct TimelineSessionFilter: Equatable {
    let sessionId: String
    let projectName: String?
    let agentType: String?

    var label: String {
        if let projectName, !projectName.isEmpty {
            return projectName
        }
        switch agentType {
        case "openclaw": return "OpenClaw"
        case "claude-code": return "Claude"
        case "codex-cli": return "Codex CLI"
        case "codex-app": return "Codex App"
        case "opencode": return "OpenCode"
        default: return sessionId
        }
    }
}

private extension TimelineEntry {
    func matchesTimelineFilter(_ filter: TimelineSessionFilter) -> Bool {
        if normalized(sessionId) == filter.sessionId {
            return true
        }

        // OpenClaw timeline entries are daemon-local and historically used
        // agent attribution without a session id. Keep those visible when the
        // virtual Gateway session is focused.
        if filter.sessionId == "openclaw-gateway",
           agentType == "openclaw",
           normalized(sessionId) == nil {
            return true
        }

        guard normalized(sessionId) == nil else { return false }
        if let projectName = filter.projectName,
           !projectName.isEmpty,
           projectName == self.projectName,
           filter.agentType == agentType {
            return true
        }
        return false
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct TimelineMarkdownPreview: View {
    let text: String

    private var lines: [TimelineMarkdownLine] {
        TimelineMarkdownLine.parse(text)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                lineView(line)
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func lineView(_ line: TimelineMarkdownLine) -> some View {
        switch line {
        case .blank:
            Spacer().frame(height: 4)
        case let .heading(level, content):
            attributedText(content,
                            font: .system(size: level == 1 ? 11 : 10,
                                          weight: .bold,
                                          design: .default),
                            color: TerrariumHUD.text.opacity(0.95))
                .padding(.top, level == 1 ? 2 : 1)
                .fixedSize(horizontal: false, vertical: true)
        case let .bullet(content):
            HStack(alignment: .top, spacing: 5) {
                Text("•")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.78))
                attributedText(content,
                                font: .system(size: 10, design: .default),
                                color: TerrariumHUD.subtext.opacity(0.86))
                    .fixedSize(horizontal: false, vertical: true)
            }
        case let .numbered(marker, content):
            HStack(alignment: .top, spacing: 5) {
                Text(marker)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.78))
                    .frame(width: 22, alignment: .trailing)
                attributedText(content,
                                font: .system(size: 10, design: .default),
                                color: TerrariumHUD.subtext.opacity(0.86))
                    .fixedSize(horizontal: false, vertical: true)
            }
        case let .quote(content):
            HStack(alignment: .top, spacing: 4) {
                Text("│")
                    .font(.system(size: 10, design: .default))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.72))
                attributedText(content,
                                font: .system(size: 10, design: .default),
                                color: TerrariumHUD.subtext.opacity(0.72))
                    .fixedSize(horizontal: false, vertical: true)
            }
        case let .code(content):
            Text(content.isEmpty ? " " : content)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.ledGreen.opacity(0.8))
                .fixedSize(horizontal: false, vertical: true)
        case let .text(content):
            attributedText(content,
                            font: .system(size: 10, design: .default),
                            color: TerrariumHUD.subtext.opacity(0.86))
                .fixedSize(horizontal: false, vertical: true)
        case let .table(rows, hasHeader):
            tableView(rows: rows, hasHeader: hasHeader)
        }
    }

    /// Render a single line of inline markdown content as styled `Text`.
    /// Wraps `parseInlineSpans` and folds spans into one `Text` via
    /// concatenation so SwiftUI lays out / wraps it as a single paragraph.
    private func attributedText(_ content: String, font: Font, color: Color) -> Text {
        let spans = TimelineInlineSpan.parse(content)
        return spans.reduce(Text("")) { acc, span in
            acc + span.text(baseFont: font, baseColor: color)
        }
    }

    /// Compact table layout. Equal-width columns via Grid; first row bolded
    /// when hasHeader. Wrapped in a horizontal scroll so wide tables don't
    /// blow up the detail pane width.
    @ViewBuilder
    private func tableView(rows: [[String]], hasHeader: Bool) -> some View {
        if rows.isEmpty {
            EmptyView()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 2) {
                    ForEach(rows.indices, id: \.self) { i in
                        let isHeader = hasHeader && i == 0
                        GridRow {
                            ForEach(rows[i].indices, id: \.self) { j in
                                attributedText(rows[i][j],
                                                font: .system(
                                                    size: 9,
                                                    weight: isHeader ? .bold : .regular,
                                                    design: .monospaced),
                                                color: isHeader
                                                    ? TerrariumHUD.text.opacity(0.95)
                                                    : TerrariumHUD.subtext.opacity(0.86))
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(minWidth: 60, alignment: .leading)
                            }
                        }
                        if isHeader {
                            // separator hairline under the header row
                            Rectangle()
                                .fill(TerrariumHUD.subtext.opacity(0.35))
                                .frame(height: 0.5)
                        }
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }
}

private enum TimelineMarkdownLine {
    case blank
    case heading(level: Int, content: String)
    case bullet(String)
    case numbered(marker: String, content: String)
    case quote(String)
    case code(String)
    case text(String)
    /// Markdown table. `rows[0]` is the header when `hasHeader == true`.
    case table(rows: [[String]], hasHeader: Bool)

    static func parse(_ text: String) -> [TimelineMarkdownLine] {
        var parsed: [TimelineMarkdownLine] = []
        var inCodeFence = false
        let allLines = text.components(separatedBy: .newlines)

        var i = 0
        while i < allLines.count {
            let rawLine = allLines[i]
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {
                inCodeFence.toggle()
                i += 1
                continue
            }
            if inCodeFence {
                parsed.append(.code(rawLine))
                i += 1
                continue
            }
            if trimmed.isEmpty {
                parsed.append(.blank)
                i += 1
                continue
            }

            // Table block — current line is `|...|` and not a separator.
            if isTableRow(trimmed) {
                var rows: [[String]] = [splitCells(trimmed)]
                var hasHeader = false
                var j = i + 1
                if j < allLines.count {
                    let nextTrimmed = allLines[j].trimmingCharacters(in: .whitespaces)
                    if isTableSeparator(nextTrimmed) {
                        hasHeader = true
                        j += 1
                    }
                }
                while j < allLines.count {
                    let nextTrimmed = allLines[j].trimmingCharacters(in: .whitespaces)
                    if !isTableRow(nextTrimmed) { break }
                    rows.append(splitCells(nextTrimmed))
                    j += 1
                }
                parsed.append(.table(rows: rows, hasHeader: hasHeader))
                i = j
                continue
            }

            if let heading = parseHeading(trimmed) {
                parsed.append(.heading(level: heading.level, content: heading.content))
            } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
                parsed.append(.bullet(String(trimmed.dropFirst(2))))
            } else if let numbered = parseNumbered(trimmed) {
                parsed.append(.numbered(marker: numbered.marker, content: numbered.content))
            } else if trimmed.hasPrefix("> ") {
                parsed.append(.quote(String(trimmed.dropFirst(2))))
            } else {
                parsed.append(.text(rawLine))
            }
            i += 1
        }

        return parsed.isEmpty ? [.text(text)] : parsed
    }

    private static func parseHeading(_ trimmed: String) -> (level: Int, content: String)? {
        var level = 0
        for char in trimmed {
            if char == "#" {
                level += 1
            } else {
                break
            }
        }
        guard (1...6).contains(level) else { return nil }
        guard trimmed.dropFirst(level).first == " " else { return nil }
        let content = trimmed.dropFirst(level + 1)
        return (level, String(content))
    }

    private static func parseNumbered(_ trimmed: String) -> (marker: String, content: String)? {
        guard let markerEnd = trimmed.firstIndex(where: { $0 == "." || $0 == ")" }) else { return nil }
        let number = trimmed[..<markerEnd]
        guard !number.isEmpty, number.allSatisfy(\.isNumber) else { return nil }
        let contentStart = trimmed.index(after: markerEnd)
        guard contentStart < trimmed.endIndex, trimmed[contentStart].isWhitespace else { return nil }
        let content = trimmed[contentStart...].trimmingCharacters(in: .whitespaces)
        return ("\(number)\(trimmed[markerEnd])", content)
    }

    // ---- Table helpers ----

    private static func isTableRow(_ trimmed: String) -> Bool {
        guard trimmed.hasPrefix("|"), trimmed.hasSuffix("|"), trimmed.count >= 2 else { return false }
        if isTableSeparator(trimmed) { return false }
        return trimmed.contains("|")
    }

    private static func isTableSeparator(_ trimmed: String) -> Bool {
        guard trimmed.hasPrefix("|"), trimmed.hasSuffix("|") else { return false }
        let inner = String(trimmed.dropFirst().dropLast())
        // Real separator must contain at least one dash.
        guard inner.contains("-") else { return false }
        let allowed: Set<Character> = ["-", ":", " ", "|", "\t"]
        return inner.allSatisfy { allowed.contains($0) }
    }

    private static func splitCells(_ trimmed: String) -> [String] {
        let inner = trimmed
            .trimmingCharacters(in: .whitespaces)
            .dropFirst()  // leading |
            .dropLast()   // trailing |
        return inner.split(separator: "|", omittingEmptySubsequences: false)
            .map { String($0).trimmingCharacters(in: .whitespaces) }
    }
}

/// Inline-span tokenizer (single line of content). Mirrors the TypeScript
/// `parseInlineSpans` in `shared/src/timeline-markdown.ts`. First-match-wins
/// left-to-right walker; never recurses.
private enum TimelineInlineSpan {
    case plain(String)
    case bold(String)
    case italic(String)
    case code(String)
    case link(text: String, href: String)

    /// Render a span as a styled SwiftUI `Text` over a base font + colour.
    func text(baseFont: Font, baseColor: Color) -> Text {
        switch self {
        case .plain(let s):
            return Text(s).font(baseFont).foregroundStyle(baseColor)
        case .bold(let s):
            return Text(s).font(baseFont.weight(.bold)).foregroundStyle(baseColor)
        case .italic(let s):
            return Text(s).font(baseFont.italic()).foregroundStyle(baseColor)
        case .code(let s):
            return Text(s)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.ledGreen.opacity(0.85))
        case .link(let label, _):
            // We don't make the link tappable — just style it. (Detail-pane
            // taps already drive selection; routing through `URL` would
            // conflict with the tap-to-expand gesture on iPhone portrait.)
            return Text(label)
                .font(baseFont)
                .foregroundStyle(TerrariumHUD.tetraNeon.opacity(0.9))
                .underline()
        }
    }

    static func parse(_ text: String) -> [TimelineInlineSpan] {
        if text.isEmpty { return [] }
        var out: [TimelineInlineSpan] = []
        var pending = ""
        let chars = Array(text)
        var i = 0

        func flushPlain() {
            if !pending.isEmpty {
                out.append(.plain(pending))
                pending = ""
            }
        }

        while i < chars.count {
            let ch = chars[i]

            // `code`
            if ch == "`" {
                if let close = chars[(i + 1)...].firstIndex(of: "`") {
                    flushPlain()
                    let body = String(chars[(i + 1)..<close])
                    out.append(.code(body))
                    i = close + 1
                    continue
                }
            }

            // **bold**
            if ch == "*", i + 1 < chars.count, chars[i + 1] == "*" {
                if let close = findDoubleStar(chars, from: i + 2) {
                    flushPlain()
                    let body = String(chars[(i + 2)..<close])
                    out.append(.bold(body))
                    i = close + 2
                    continue
                }
            }

            // *italic*
            if ch == "*",
               i + 1 < chars.count,
               chars[i + 1] != "*",
               (i == 0 || chars[i - 1] != "*") {
                if let close = findSingleStar(chars, from: i + 1) {
                    flushPlain()
                    let body = String(chars[(i + 1)..<close])
                    out.append(.italic(body))
                    i = close + 1
                    continue
                }
            }

            // [text](href)
            if ch == "[" {
                if let bracketClose = chars[(i + 1)...].firstIndex(of: "]"),
                   bracketClose + 1 < chars.count,
                   chars[bracketClose + 1] == "(",
                   let parenClose = chars[(bracketClose + 2)...].firstIndex(of: ")") {
                    let label = String(chars[(i + 1)..<bracketClose])
                    let href = String(chars[(bracketClose + 2)..<parenClose])
                    flushPlain()
                    out.append(.link(text: label, href: href))
                    i = parenClose + 1
                    continue
                }
            }

            pending.append(ch)
            i += 1
        }
        flushPlain()
        return out.isEmpty ? [.plain(text)] : out
    }

    private static func findDoubleStar(_ chars: [Character], from start: Int) -> Int? {
        var i = start
        while i + 1 < chars.count {
            if chars[i] == "*", chars[i + 1] == "*" { return i }
            i += 1
        }
        return nil
    }

    private static func findSingleStar(_ chars: [Character], from start: Int) -> Int? {
        var i = start
        while i < chars.count {
            if chars[i] == "*" {
                let prev = i > 0 ? chars[i - 1] : nil
                let next = i + 1 < chars.count ? chars[i + 1] : nil
                if prev != "*" && next != "*" { return i }
            }
            i += 1
        }
        return nil
    }
}

// MARK: - Timeline Type Color & Icon
//
// Single source of truth for icon semantics is `shared/src/timeline-icons.ts`
// (`timelineIconKey`). This Swift port maps each abstract key to:
//   - a Color (using TerrariumHUD design tokens)
//   - an SF Symbol name
//   - a fallback ASCII glyph (used by Apple-side e-ink/preview surfaces)
//
// Glyphs were Unicode shapes (◆ ◇ ▶ ■ ⦻ ☞ ★). They render at thin strokes,
// half of them (◆ vs ◇, ▶ vs ▸) are visually near-identical, and they offer
// no semantic hint without the colour. SF Symbols give us recognisable shapes
// at every weight + dynamic type level.

enum TimelineIconKey: String {
    case success
    case error
    case running
    case awaiting
    case tool
    case model
    case user
    case task
    case scheduled
    case memory
}

/// True when `entry` is a `task_start` whose matching `task_end` (same
/// `taskId`) hasn't yet appeared in `siblings`. Mirrors `isInFlightTask` in
/// shared/src/timeline-icons.ts — used to spin the leading icon for in-flight
/// task hierarchy markers instead of the static `task` glyph.
///
/// **Staleness guard**: a task_start older than `inFlightTaskMaxAgeSec`
/// without a matching task_end is treated as a *resolved-but-orphaned*
/// task (daemon was killed mid-task / hook delivery race / sibling
/// session_end took a closeTask early-return path). Without this guard
/// the leading task icon spins forever on rows the user already
/// considers done — exactly the "/session-end 했는데 아직 진행중처럼
/// 나옴" report. The daemon-side orphan reaper (DaemonServer.swift)
/// will eventually upsert a synthetic task_end with
/// `boundarySignal="interrupted"`, but this UI guard is independent so a
/// stale row reads as completed even before that reaper runs (or on
/// dashboard-only sessions that bypass the daemon path entirely).
private let inFlightTaskMaxAgeSec: TimeInterval = 600
func timelineIsInFlightTask(_ entry: TimelineEntry, siblings: [TimelineEntry]) -> Bool {
    if entry.type != .taskStart { return false }
    guard let taskId = entry.taskId, !taskId.isEmpty else { return false }
    for s in siblings {
        if s.type == .taskEnd && s.taskId == taskId { return false }
    }
    let ageSec = Date().timeIntervalSince(entry.date)
    if ageSec > inFlightTaskMaxAgeSec { return false }
    return true
}

/// True when a turn row should rotate its leading icon. Combines the
/// `running` icon-key (chat_start, unknown types) with the in-flight task
/// hierarchy signal so an open `task_start` also spins until its `task_end`
/// arrives. Mirrors `isRotatingEntry` in shared/src/timeline-icons.ts.
func timelineIsRotatingEntry(_ entry: TimelineEntry, siblings: [TimelineEntry]) -> Bool {
    if timelineIconKey(for: entry.type, status: entry.status) == .running { return true }
    return timelineIsInFlightTask(entry, siblings: siblings)
}

/// Map a timeline entry to its semantic icon key. Mirrors
/// `timelineIconKey()` in shared/src/timeline-icons.ts.
func timelineIconKey(for type: TimelineEntryType, status: String? = nil) -> TimelineIconKey {
    switch type {
    case .taskStart, .taskEnd:
        return .task
    case .chatStart:
        return .running
    case .chatEnd, .chatResponse, .modelResponse:
        return .success
    case .modelCall:
        return .model
    case .toolRequest:
        switch status {
        case "approved": return .success
        case "denied": return .error
        default: return .awaiting
        }
    case .toolResolved:
        return .success
    case .toolExec:
        return .tool
    case .error:
        return .error
    case .userAction:
        return .user
    case .scheduled:
        return .scheduled
    case .memoryRecall:
        return .memory
    case .evalResult:
        return status == "denied" ? .error : .success
    case .unknown:
        return .running
    }
}

/// SF Symbol name for a given icon key.
func sfSymbol(for key: TimelineIconKey) -> String {
    switch key {
    case .success:   return "checkmark.circle.fill"
    case .error:     return "xmark.octagon.fill"
    case .running:   return "arrow.triangle.2.circlepath"
    case .awaiting:  return "hourglass"
    case .tool:      return "wrench.and.screwdriver.fill"
    case .model:     return "brain"
    case .user:      return "person.fill"
    case .task:      return "list.bullet.rectangle.fill"
    case .scheduled: return "alarm.fill"
    case .memory:    return "memorychip"
    }
}

func timelineTypeColor(for type: TimelineEntryType) -> Color {
    switch timelineIconKey(for: type) {
    case .success:   return TerrariumHUD.ledGreen
    case .error:     return TerrariumHUD.ledRed
    case .running:   return TerrariumHUD.text
    case .awaiting:  return TerrariumHUD.ledAmber
    case .tool:      return TerrariumHUD.ledGreen
    case .model:     return TerrariumHUD.tetraNeon
    case .user:      return Color(red: 0.231, green: 0.51, blue: 0.965)
    case .task:      return TerrariumHUD.tetraNeon
    case .scheduled: return TerrariumHUD.subtext
    case .memory:    return TerrariumHUD.claudeBody
    }
}

/// Fallback ASCII glyph — Unicode-light, single-cell, useful when an SF
/// Symbol isn't available (e.g. preview snapshots, monospaced contexts).
func timelineTypeIcon(for type: TimelineEntryType, status: String? = nil) -> String {
    switch timelineIconKey(for: type, status: status) {
    case .success:   return "✓"
    case .error:     return "✗"
    case .running:   return "▶"
    case .awaiting:  return "⏳"
    case .tool:      return "⚙"
    case .model:     return "◆"
    case .user:      return "•"
    case .task:      return type == .taskEnd ? "▣" : "▢"
    case .scheduled: return "⏰"
    case .memory:    return "⦿"
    }
}
