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
    /// Sticky-bottom: the list follows new rows until the user scrolls away
    /// from the bottom, and re-engages the moment they scroll back. Selection
    /// deliberately does NOT gate this — when auto-scroll hung off
    /// `focusedIndex < 0`, tapping a row once to read it in the detail pane
    /// froze the list until the session filter changed.
    @State private var stickToBottom = true
    /// Row count the last scroll-geometry callback was baselined against.
    @State private var stickyLayoutCount = -1

    /// Slack for "at the bottom", in points — absorbs sub-pixel rounding and
    /// the 1pt inter-row spacing.
    private static let stickyBottomSlop: CGFloat = 12
    private static let scrollSpace = "timelineScroll"

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
    // The ScrollView is built unconditionally, with the empty state as its
    // content. An `if grouped.isEmpty` branch AROUND it meant the empty →
    // first-history-snapshot transition constructed the scrolling branch fresh
    // with its final count, so `onChange(of:)` never observed a change and the
    // very first load stayed pinned to the OLDEST row. One stable view identity
    // makes 0→N an ordinary content change the handler below already covers.
    // (A ScrollView top-anchors its content, so the empty-state text keeps the
    // top alignment its own frame used to force.)
    private func timelineList(allowExpand: Bool) -> some View {
        GeometryReader { viewport in
            ScrollViewReader { proxy in
                ScrollView {
                    if grouped.isEmpty {
                        Text(timelineFilter == nil ? "No events yet" : "No events for this session")
                            .font(.system(size: fontScale.sub, design: .monospaced))
                            .foregroundStyle(TerrariumHUD.subtext)
                            .padding(.horizontal, 8)
                            .frame(maxWidth: .infinity, alignment: .topLeading)
                    } else {
                        LazyVStack(alignment: .leading, spacing: 1) {
                            ForEach(Array(grouped.enumerated()), id: \.offset) { index, group in
                                VStack(alignment: .leading, spacing: 0) {
                                    // Day break above the first row of each calendar
                                    // day — bare HH:mm stamps otherwise read as today
                                    // on a buffer that spans midnight.
                                    if let dayLabel = timelineDayBreakLabel(at: index, in: grouped) {
                                        dayBreakRow(dayLabel)
                                    }
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
                        .background(
                            // Reads the content's bottom edge to decide whether the
                            // list is parked at the bottom. A plain geometry read +
                            // onChange, deliberately NOT a PreferenceKey: those do
                            // not propagate out of a ScrollView on macOS.
                            GeometryReader { content in
                                Color.clear.onChange(
                                    of: content.frame(in: .named(Self.scrollSpace)).maxY,
                                    initial: true
                                ) { _, contentMaxY in
                                    updateStickToBottom(
                                        contentMaxY: contentMaxY,
                                        viewportHeight: viewport.size.height
                                    )
                                }
                            }
                        )
                    }
                }
                .coordinateSpace(.named(Self.scrollSpace))
                // Keyed on timelineVersion, not grouped.count: a chat_response
                // folding into an existing group, an ×count collapse, or a
                // task_end upsert all change a row's content — and its height —
                // without changing the row count, and the list must stay pinned
                // to the bottom through those too. `initial: true` covers a strip
                // created with rows already present (filter switch, HUD toggled
                // back on), which produces no transition at all.
                .onChange(of: timelineVersion, initial: true) {
                    guard !grouped.isEmpty, stickToBottom else { return }
                    proxy.scrollTo(grouped.count - 1, anchor: .bottom)
                }
            }
        }
    }

    /// Re-evaluates sticky-bottom from the scroll position.
    private func updateStickToBottom(contentMaxY: CGFloat, viewportHeight: CGFloat) {
        guard viewportHeight > 0 else { return }
        // A relayout caused by the row set itself changing is not the user
        // moving: the appended row lands below the viewport before the
        // scroll-to-bottom above has run, which would read as "scrolled away"
        // and disengage the very mode that is about to scroll. Re-baseline and
        // keep the current mode.
        guard stickyLayoutCount == grouped.count else {
            stickyLayoutCount = grouped.count
            return
        }
        stickToBottom = contentMaxY <= viewportHeight + Self.stickyBottomSlop
    }

    /// Day-break separator: uppercase label + hairline rule to the trailing edge.
    private func dayBreakRow(_ label: String) -> some View {
        HStack(spacing: 6) {
            Text(label)
                .font(.system(size: fontScale.sub, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
            Rectangle()
                .fill(TerrariumHUD.subtext.opacity(0.25))
                .frame(height: 1)
        }
        .padding(.top, 5)
        .padding(.bottom, 2)
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Entries from \(label.lowercased())")
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
        // Nested = this row's task header is the nearest header ABOVE it.
        // Bare `taskId != nil` is not enough: with interleaved concurrent
        // sessions (and legacy cross-session-contaminated taskIds on disk),
        // an unrelated row would indent under another session's TASK header
        // and read as a fake subtree.
        let isNested = timelineRowIsNestedUnderTaskHeader(at: index, in: grouped)
        // The turn is "completed" the moment EITHER chat_response or
        // chat_end is merged in — `GroupedEntry.hasResponse`. chat_end
        // is unreliable in production (Stop hook ~18% reliability;
        // chat_end is emitted from a Task that awaits a summarizer that
        // can hang), so requiring it for the spinner-stop is what made
        // the dashboard look frozen on already-delivered replies.
        // Codex stop-time review #11 (2026-05-17).
        let merged = group.hasResponse
        // A chat_start is done the moment its completion exists ANYWHERE later
        // in the timeline with the same context — not only when it happened to
        // be timestamp-adjacent enough to merge into this group. The unfiltered
        // all-sessions view interleaves other sessions' rows between a turn's
        // chat_start and its chat_response, breaking the adjacency merge
        // (hasResponse=false) and leaving a finished prompt spinning forever.
        // The lenient cross-group check the display filter already uses is the
        // right test. Falls back to hasResponse for non-chatStart groups.
        let isCompleted = group.hasResponse
            || (group.entry.type == .chatStart
                && timelineHasLaterCompletion(for: group.entry, in: grouped))
        // Queued/superseded prompt: rendered with a fold glyph + "answered with
        // next turn" note instead of a bare completion check, so a turn the user
        // genuinely submitted doesn't read as a finished turn with no reply.
        let foldedInto = group.entry.type == .chatStart
            ? timelineSupersedingGroup(for: group, at: index, in: grouped)
            : nil
        let isFolded = foldedInto != nil
        // The answered turn that absorbed an earlier queued prompt — tags its
        // response sub-line "shared" so the borrowed answer is legible.
        let absorbsQueued = group.entry.type == .chatStart
            && timelineAbsorbsQueuedPrompt(for: group, at: index, in: grouped)
        let iconKey: TimelineIconKey = {
            if group.entry.type == .chatStart && isCompleted { return .success }
            return timelineIconKey(for: group.entry.type, status: group.entry.status)
        }()
        let iconColor = isFolded
            ? TerrariumHUD.subtext.opacity(0.7)
            : (group.entry.type == .chatStart && isCompleted
                ? timelineTypeColor(for: .chatEnd)
                : timelineTypeColor(for: group.entry.type))
        // Slash-command turn ("/merge", "/session-end") — rendered with a
        // terminal glyph + CMD chip instead of a chat bubble so command
        // invocations are legible at a glance. Completed command turns keep
        // the success check (completion signal outranks the command marker).
        let slashCommand = group.entry.type == .chatStart
            ? timelineSlashCommand(group.entry.raw) : nil
        // Fold turns get a distinct down-right glyph; everything else keeps its
        // semantic icon.
        let rowSymbolName = isFolded
            ? "arrow.turn.down.right"
            : (slashCommand != nil && !isCompleted ? "terminal.fill" : sfSymbol(for: iconKey))
        let brandColor = SessionBrand.color(for: group.entry.agentType)
        let countSuffix = group.count > 1 ? " ×\(group.count)" : ""
        let sessionLabel = rowPrefixLabel(for: group.entry)
        let isRotating: Bool = {
            if isFolded { return false }
            if group.entry.type == .chatStart && isCompleted { return false }
            return timelineIsRotatingEntry(group.entry, siblings: grouped.map(\.entry))
        }()

        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 4) {
                // Indent turn rows under task headers — visual cue that this turn
                // belongs to the task above it.
                if isNested {
                    Spacer().frame(width: 8)
                }

                Text(formatTime(group.entry.date))
                    .font(.system(size: fontScale.sub, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(isChatEnd ? 0.4 : 0.5))

                // Animate the leading icon when the row is in flight (running
                // state). Swap semantic icons such as the slash-command terminal
                // for the circular running glyph while rotating; rectangular
                // symbols spinning around their centre read as a rendering glitch.
                // `.symbolEffect(.rotate)` would be cleaner but requires iOS 18 /
                // macOS 15, so use a TimelineView-driven rotationEffect on iOS 17+.
                RotatingTimelineIcon(
                    symbolName: rowSymbolName,
                    font: .system(size: fontScale.sub, weight: .bold),
                    color: iconColor.opacity(isChatEnd ? 0.6 : 1),
                    size: 12,
                    isRotating: isRotating,
                    rotatingSymbolName: sfSymbol(for: .running)
                )
                .accessibilityLabel(isFolded ? "answered with next turn" : iconKey.rawValue)

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

                // Command chip — marks a slash-command invocation before its
                // text so "/merge" reads as an executed command, not a chat.
                if slashCommand != nil {
                    Text("CMD")
                        .font(.system(size: max(8, fontScale.label - 1), weight: .heavy, design: .monospaced))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 3)
                        .padding(.vertical, 0.5)
                        .background(iconColor.opacity(0.7), in: RoundedRectangle(cornerRadius: 2))
                        .accessibilityLabel("slash command")
                }

                // Strip markdown decorators from the summary so `**bold**` /
                // `## heading` don't leak into the row as literal characters.
                // (The regular detail pane / compact inline-expand still renders
                // the full markdown.)
                Text(strippedRaw(timelineSummaryTextForDashboard(group)) + countSuffix)
                    .font(.system(
                        size: fontScale.sub,
                        weight: slashCommand != nil ? .semibold : .regular,
                        design: .monospaced
                    ))
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

            // Sub-line: folded/queued-prompt note. This turn's single shared
            // reply landed on the following turn, so point there instead of
            // leaving a completed-looking row with no answer.
            if isFolded {
                HStack(alignment: .top, spacing: 4) {
                    Spacer().frame(width: isNested ? 64 : 56)
                    Text("answered with next turn")
                        .font(.system(size: fontScale.label, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext.opacity(0.6))
                        .lineLimit(1)
                    Image(systemName: "arrow.turn.right.down")
                        .font(.system(size: fontScale.label, weight: .semibold))
                        .foregroundStyle(TerrariumHUD.subtext.opacity(0.5))
                    Spacer(minLength: 0)
                }
            }

            // Sub-line: assistant response body. Indented + dimmed so the
            // user prompt above stays the primary reading anchor. Hidden
            // while this row's inline detail pane is expanded showing the
            // response body — resp.raw is a prefix of resp.detail, so the
            // sub-line would repeat the body's opening right above it.
            if let resp = group.mergedResponse, !timelineIsProgressChatResponse(resp),
               !(allowMultiline && expandedIndex == index && inlineDetailShowsBody(group)) {
                HStack(alignment: .top, spacing: 4) {
                    Spacer().frame(width: isNested ? 64 : 56)
                    Text("→")
                        .font(.system(size: fontScale.sub, weight: .semibold, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext.opacity(0.55))
                    Text(strippedRaw(resp.raw))
                        .font(.system(size: fontScale.sub, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.text.opacity(0.78))
                        .lineLimit(allowMultiline ? 3 : 1)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: allowMultiline)
                    if absorbsQueued {
                        Text("shared")
                            .font(.system(size: max(8, fontScale.label - 1), weight: .semibold, design: .monospaced))
                            .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                            .background(
                                TerrariumHUD.subtext.opacity(0.12),
                                in: RoundedRectangle(cornerRadius: 3)
                            )
                            .accessibilityLabel("shared with the previous queued prompt")
                    }
                    Spacer(minLength: 0)
                }
            }

            // Sub-line: terminator metadata ("Completed · 2s · topic") +
            // the summary-backend pill.
            if let end = group.mergedCompletion, end.summaryKind != "progress" {
                HStack(spacing: 4) {
                    Spacer().frame(width: isNested ? 64 : 56)
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
    /// App Store macOS builds now target macOS 26+, but Apple Intelligence can
    /// still be unavailable when disabled or not downloaded, so `auto` can
    /// still fall through to heuristic. Hiding the heuristic pill made the
    /// entire feature read as "not running" for those users. Pill is suppressed
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
    private static nonisolated(unsafe) let strippedRawCache = makeTimelineMemoCache(NSString.self)

    private func strippedRaw(_ raw: String) -> String {
        let key = raw as NSString
        if let hit = Self.strippedRawCache.object(forKey: key) { return hit as String }
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
        let result = smartTruncate(cleaned, limit: 120)
        Self.strippedRawCache.setObject(result as NSString, forKey: key)
        return result
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
        // Folded/queued prompt: the shared reply lives on the following turn,
        // so borrow its body here instead of showing an empty detail.
        let foldedInto = group.entry.type == .chatStart
            ? timelineSupersedingGroup(for: group, in: grouped) : nil
        let bodyGroup = foldedInto ?? group
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
            if let foldedInto {
                Text("↳ answered together with the next turn · \(formatTime(foldedInto.entry.date))")
                    .font(.system(size: fontScale.label, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
            }
            let detailEntry = timelineDetailEntryForDashboard(bodyGroup)
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
        // Same pane-wide selection as the regular detail pane — without it
        // only the markdown body was copyable.
        .textSelection(.enabled)
        .padding(.vertical, 2)
    }

    /// Whether to show the detail body for this entry.
    /// Suppress when:
    ///   - summaryKind == "none" (heuristic gave up; detail is just raw response → noisy)
    ///   - detailIsRedundant matches against raw
    private func shouldShowDetail(entry: TimelineEntry, detail: String) -> Bool {
        timelineShouldShowDetailForDashboard(entry: entry, detail: detail)
    }

    /// Whether the inline (compact) detail pane will render a markdown body
    /// for this group — mirrors `inlineDetailPane`'s gate so the turn row can
    /// hide its response sub-line while the same text is expanded below it.
    private func inlineDetailShowsBody(_ group: GroupedEntry) -> Bool {
        let detailEntry = timelineDetailEntryForDashboard(group)
        guard let detail = detailEntry.detail else { return false }
        return shouldShowDetail(entry: detailEntry, detail: detail)
    }

    /// Task hierarchy header — one row per task. Renders the `task_start`
    /// header with its matching closure (`task_end`, same taskId) folded in:
    /// the judge's one-line summary becomes the title when the own title is a
    /// bare "Task N", the closure label ("Session end · 2 turns · 6m 5s")
    /// renders as a trailing chip, and the eval badge reads the closure's
    /// score/outcome. `task_end` rows never render standalone — they are
    /// data-only closure records (spinner stop, judge upsert vehicle, reaper
    /// synthesis). Contract SSOT: shared/src/timeline-task-display.ts.
    private func taskHeaderRow(_ group: GroupedEntry, index: Int) -> some View {
        let entry = group.entry
        // Closure lookup + spinner must see PRE-display-filter rows: the
        // matching task_end is filtered out of `grouped` by design, so
        // scanning `grouped` would leave every closed task spinning forever.
        let display = timelineTaskHeaderDisplay(for: entry, in: filteredEntries)
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
                isRotating: timelineIsRotatingEntry(entry, siblings: filteredEntries),
                rotatingSymbolName: sfSymbol(for: .running)
            )
            Text("TASK")
                .font(.system(size: fontScale.sub, weight: .heavy, design: .monospaced))
                .foregroundStyle(accent)
            if !sessionLabel.isEmpty {
                Text(sessionLabel)
                    .font(.system(size: fontScale.sub, weight: .medium, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .lineLimit(1)
            }
            Text(display.title)
                .font(.system(size: fontScale.sub, weight: .semibold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.text)
                .lineLimit(1)
            if let closureText = display.closureText {
                Text(closureText)
                    .font(.system(size: fontScale.label, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
                    .lineLimit(1)
            }
            Spacer()
            // Eval badge — once the task closed. While the judge is still
            // running (taskOutcome == nil / "pending"), shows a dim "…"
            // placeholder so users learn that an evaluation is on the way.
            if display.closed {
                TaskEvalBadge(
                    score: display.taskScore,
                    outcome: display.taskOutcome,
                    fontSize: fontScale.label,
                    closedAt: display.closedAt
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
            // Top hairline marks the task envelope's opening; the envelope
            // closes implicitly at the next header (no standalone end row).
            VStack(spacing: 0) {
                Rectangle().fill(accent.opacity(0.6)).frame(height: 1)
                Spacer()
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
                let isTurnCompleted = group.entry.type == .chatStart
                    && (group.hasResponse
                        || timelineHasLaterCompletion(for: group.entry, in: grouped))
                // Folded/queued prompt — borrow the following turn's shared
                // reply for this pane's body and mark the header accordingly.
                let foldedInto = group.entry.type == .chatStart
                    ? timelineSupersedingGroup(for: group, in: grouped) : nil
                let isFolded = foldedInto != nil
                let iconKey: TimelineIconKey = isTurnCompleted
                    ? .success
                    : timelineIconKey(for: group.entry.type, status: group.entry.status)
                let iconColor = isFolded
                    ? TerrariumHUD.subtext
                    : (isTurnCompleted
                        ? timelineTypeColor(for: .chatEnd)
                        : timelineTypeColor(for: group.entry.type))
                let headerSymbol = isFolded ? "arrow.turn.down.right" : sfSymbol(for: iconKey)
                let isRotating: Bool = (isFolded || isTurnCompleted)
                    ? false
                    : timelineIsRotatingEntry(group.entry, siblings: grouped.map(\.entry))
                let countSuffix = group.count > 1 ? " (×\(group.count))" : ""

                // Header: type badge chip + timestamp
                HStack(spacing: 6) {
                    HStack(spacing: 3) {
                        RotatingTimelineIcon(
                            symbolName: headerSymbol,
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
                // Selected task headers fold in their closure's verdict
                // (task_end rows themselves are never selectable — data-only
                // under the one-row-per-task contract).
                if group.entry.type == .taskStart {
                    let closure = timelineTaskClosure(for: group.entry, in: filteredEntries)
                    let verdict = closure ?? group.entry
                    if closure != nil || timelineTaskHasEvalPayload(group.entry) {
                        HStack(alignment: .top, spacing: 6) {
                            TaskEvalBadge(
                                score: verdict.taskScore,
                                outcome: verdict.taskOutcome,
                                fontSize: fontScale.body,
                                closedAt: (closure?.endedAt ?? closure?.ts).map { Date(timeIntervalSince1970: $0 / 1000) }
                            )
                            if let cat = verdict.taskCategory, !cat.isEmpty {
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
                        if let summary = verdict.taskSummary ?? group.entry.taskSummary, !summary.isEmpty {
                            Text(summary)
                                .font(.system(size: fontScale.label, design: .monospaced))
                                .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                                .lineLimit(3)
                                .padding(.horizontal, 8)
                                .padding(.top, 2)
                        }
                        Spacer().frame(height: 4)
                    }
                }

                // Detail text — gated by `shouldShowDetail` which suppresses:
                //   (a) summaryKind == "none" (heuristic last-resort: detail
                //       is just the raw response we couldn't summarize, so
                //       showing it duplicates the summary noisily)
                //   (b) detailIsRedundant fuzzy match against raw (LLM /
                //       heuristic summarizer paraphrased the response opening)
                // For a folded turn the body comes from the following turn that
                // carried the shared reply; the summary above stays this turn's
                // own prompt so the user still sees what they asked.
                let bodyGroup = foldedInto ?? group
                let detailEntry = timelineDetailEntryForDashboard(bodyGroup)
                let shownDetail: String? = {
                    guard let detail = detailEntry.detail,
                          shouldShowDetail(entry: detailEntry, detail: detail) else { return nil }
                    return detail
                }()

                // Summary — dropped when the body below opens with the same
                // text. Standalone chat_response rows carry `raw` as a plain
                // character-prefix truncation of `detail` (producers stamp
                // raw=prefix(120–200) / detail=prefix(1000–8000) of the same
                // response), so rendering both printed the response opening
                // twice: literal markdown here, formatted in the body. Merged
                // prompt→response turns keep the summary (the prompt is not a
                // prefix of the response).
                let summaryText = timelineSummaryTextForDashboard(group)
                let summaryIsBodyOpening = shownDetail.map {
                    timelineSummaryIsRedundantWithDetail(summary: summaryText, detail: $0)
                } ?? false
                if !summaryIsBodyOpening {
                    Text(summaryText)
                        .font(.system(size: fontScale.body, weight: .bold, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.text)
                        .padding(.horizontal, 8)
                }

                if let foldedInto {
                    Text("↳ answered together with the next turn · \(formatTimeSeconds(foldedInto.entry.date))")
                        .font(.system(size: fontScale.label, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext.opacity(0.8))
                        .padding(.horizontal, 8)
                        .padding(.top, 2)
                }

                if let detail = shownDetail {
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
        // Selection was only enabled on the markdown body, so the summary,
        // timestamps, and lifecycle rows — the lines users most often copy —
        // silently ignored drag-selection. Enable it pane-wide; Text views
        // inherit it via the environment.
        .textSelection(.enabled)
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
    /// Delegates to the memoized file-scope helper (bodies were identical).
    private func stripMarkdownInline(_ s: String) -> String {
        timelineStripMarkdownInline(s)
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
        case "antigravity": "Antigravity"
        case "kiro-cli": "Kiro CLI"
        case "kiro-ide": "Kiro IDE"
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
        case .taskMilestone: return "TODOS ✓"
        case .unknown(let raw): return raw.uppercased()
        }
    }
}

// MARK: - Day Break

/// Label to render ABOVE the row at `index`, or nil when that row continues the
/// previous row's calendar day. Mirrors Kotlin `timelineDayBreakLabel`
/// (android .../ui/monitor/TimelineDayBreak.kt) — keep the two in sync.
///
/// Index 0 is deliberately asymmetric: it emits a separator only when the
/// oldest visible row is NOT from today. A single-day buffer is the
/// overwhelmingly common case, and a "TODAY" banner atop a HUD strip this small
/// is pure chrome; a buffer that opens on an older day genuinely needs the
/// anchor, because every row below it shows only HH:mm.
func timelineDayBreakLabel(
    at index: Int,
    in groups: [GroupedEntry],
    now: Date = Date(),
    calendar: Calendar = .current
) -> String? {
    guard index >= 0, index < groups.count else { return nil }
    let day = groups[index].entry.date
    if index == 0 {
        guard !calendar.isDate(day, inSameDayAs: now) else { return nil }
    } else {
        guard !calendar.isDate(day, inSameDayAs: groups[index - 1].entry.date) else { return nil }
    }
    return timelineDayLabel(for: day, now: now, calendar: calendar)
}

func timelineDayLabel(for date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
    if calendar.isDate(date, inSameDayAs: now) { return "TODAY" }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
       calendar.isDate(date, inSameDayAs: yesterday) {
        return "YESTERDAY"
    }
    let fmt = DateFormatter()
    // Fixed POSIX locale, matching the rest of this English-only HUD ("No
    // events yet"). A device-locale month name would also break the monospaced
    // column rhythm the strip is built on.
    fmt.locale = Locale(identifier: "en_US_POSIX")
    // Format in the same zone the day comparison above used, or a caller
    // passing a non-current calendar would get a label naming a different day
    // than the one that triggered the break.
    fmt.calendar = calendar
    fmt.timeZone = calendar.timeZone
    fmt.dateFormat = calendar.isDate(date, equalTo: now, toGranularity: .year)
        ? "EEE, MMM d"
        : "MMM d, yyyy"
    return fmt.string(from: date).uppercased()
}

func timelineDisplayGroupsForDashboard(_ groups: [GroupedEntry]) -> [GroupedEntry] {
    groups.filter { group in
        let entry = group.entry
        if entry.type == .taskStart || entry.type == .taskEnd {
            return timelineShouldShowTaskMarker(group, in: groups)
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

// One-row-per-task render contract — mirrors shared/src/timeline-task-display.ts
// (`timelineShouldRenderTaskRow` / `timelineTaskClosure` /
// `timelineTaskHeaderDisplay`); update both in the same commit.
//
// `task_end` is a DATA-ONLY closure record: it stops the in-flight spinner,
// carries the judge-result upsert, and is what the orphan reaper synthesizes —
// but it never renders as a standalone row. The `task_start` header folds the
// closure in instead. Bare "Task N" headers with no eval payload (own or
// closure) render nothing, so interrupted reaper closures leave no visible row.
func timelineShouldShowTaskMarker(_ group: GroupedEntry, in groups: [GroupedEntry]) -> Bool {
    let entry = group.entry
    if entry.type == .taskEnd { return false }
    guard entry.type == .taskStart else { return true }
    if entry.taskCategory == "_empty" { return false }
    let closure = timelineTaskClosure(for: entry, in: groups.map(\.entry))
    if closure?.taskCategory == "_empty" { return false }
    if timelineIsMeaningfulTaskTitle(entry.raw) { return true }
    return timelineTaskHasEvalPayload(entry) || timelineTaskHasEvalPayload(closure)
}

/// The matching `task_end` closure record for a `task_start` header, if it
/// has arrived among `siblings`. nil for non-headers and open tasks.
func timelineTaskClosure(for entry: TimelineEntry, in siblings: [TimelineEntry]) -> TimelineEntry? {
    guard entry.type == .taskStart, let taskId = entry.taskId, !taskId.isEmpty else { return nil }
    return siblings.first { $0.type == .taskEnd && $0.taskId == taskId }
}

private func timelineTaskHasEvalPayload(_ entry: TimelineEntry?) -> Bool {
    guard let entry else { return false }
    if entry.taskScore != nil { return true }
    if entry.taskOutcome?.isEmpty == false { return true }
    if let category = entry.taskCategory, !category.isEmpty, category != "_empty" { return true }
    if entry.taskSummary?.isEmpty == false { return true }
    return false
}

/// Displayed pieces of a task header with its closure folded in. Mirrors
/// `timelineTaskHeaderDisplay` in shared/src/timeline-task-display.ts.
struct TimelineTaskHeaderDisplay {
    /// Own title when meaningful, else the judge's one-line summary, else raw.
    let title: String
    /// Closure label chip ("Session end · 2 turns · 6m 5s"); nil while open.
    let closureText: String?
    /// True once the matching `task_end` exists.
    let closed: Bool
    /// Badge inputs — closure fields win (the judge upserts onto the closure).
    let taskScore: Double?
    let taskOutcome: String?
    /// When the task closed, for the pending → unscored badge transition.
    let closedAt: Date?
}

func timelineTaskHeaderDisplay(
    for entry: TimelineEntry, in siblings: [TimelineEntry]
) -> TimelineTaskHeaderDisplay {
    let closure = timelineTaskClosure(for: entry, in: siblings)
    let ownTitle = entry.raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let summary = (closure?.taskSummary ?? entry.taskSummary)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let title = timelineIsMeaningfulTaskTitle(ownTitle) ? ownTitle : (summary.isEmpty ? ownTitle : summary)
    let closureText = closure?.raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let outcome = (closure?.taskOutcome ?? entry.taskOutcome)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
    return TimelineTaskHeaderDisplay(
        title: title,
        closureText: closureText?.isEmpty == false ? closureText : nil,
        closed: closure != nil,
        taskScore: closure?.taskScore ?? entry.taskScore,
        taskOutcome: outcome?.isEmpty == false ? outcome : nil,
        closedAt: closure.map { Date(timeIntervalSince1970: ($0.endedAt ?? $0.ts) / 1000) }
    )
}

// MARK: - Per-row classifier caches
//
// Timeline rows are immutable once ingested, but every timeline update
// re-renders every visible row, and `String.range(of: .regularExpression)` /
// `replacingOccurrences(of:options:.regularExpression)` recompile their pattern
// on every call. Under a busy session (hook events every second) that kept the
// daemon app's main thread pinned in libswift_StringProcessing, starving the
// MainActor WS handlers (client registrations timed out → device churn). The
// patterns are compiled once and pure string→result helpers are memoized;
// NSCache is thread-safe and evicts under memory pressure.

private enum TimelineRowRegex {
    static let taskNumberEN = try! NSRegularExpression(pattern: #"^task\s+\d+$"#, options: [.caseInsensitive])
    static let taskNumberKO = try! NSRegularExpression(pattern: #"^작업\s*\d+$"#)
    static let progressEN: [NSRegularExpression] = [
        #"\b(still|currently|continues? to|is|are)\s+(running|building|installing|executing|processing|waiting)\b"#,
        #"\b(still running|still building|build is running|is still running|are still running)\b"#,
        #"\b(waiting for|wait until|once (?:the )?.*(?:finishes|completes|arrives)|continue once|will continue once|i.ll continue once)\b"#,
        #"\b(no interim lines|buffers? output until completion|tail buffers output)\b"#,
    ].map { try! NSRegularExpression(pattern: $0) }
    static let progressKO: [NSRegularExpression] = [
        #"(아직|계속)\s*(실행|진행|빌드|설치)\s*중"#,
        #"(완료|끝나|도착)면\s*(계속|이어)"#,
        #"(기다리는 중|대기 중)"#,
    ].map { try! NSRegularExpression(pattern: $0) }
    static let finalLeadEN = try! NSRegularExpression(
        pattern: #"^(done|completed|complete|fixed|merged|verified|all done)\b"#, options: [.caseInsensitive])
    static let finalLeadKO = try! NSRegularExpression(pattern: #"^(완료|수정 완료|검증 완료|반영 완료|머지 완료)"#)

    static func matches(_ rx: NSRegularExpression, _ s: String) -> Bool {
        rx.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
}

private func makeTimelineMemoCache<V: AnyObject>(_ type: V.Type) -> NSCache<NSString, V> {
    let cache = NSCache<NSString, V>()
    cache.countLimit = 2048
    return cache
}

// nonisolated(unsafe): NSCache is documented thread-safe; it just lacks a
// Sendable annotation in the SDK.
private nonisolated(unsafe) let timelineMarkdownStripCache = makeTimelineMemoCache(NSString.self)
private nonisolated(unsafe) let timelineProgressUpdateCache = makeTimelineMemoCache(NSNumber.self)

func timelineIsMeaningfulTaskTitle(_ raw: String) -> Bool {
    let title = timelineStripMarkdownInline(raw)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !title.isEmpty else { return false }
    if TimelineRowRegex.matches(TimelineRowRegex.taskNumberEN, title) { return false }
    if TimelineRowRegex.matches(TimelineRowRegex.taskNumberKO, title) { return false }
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

/// Whether the bold Summary line would merely repeat the opening of the
/// detail body shown below it. Standalone chat_response rows are stamped by
/// every producer with `raw` as a plain character-prefix truncation of
/// `detail` (no ellipsis), so the check is a markdown-stripped token-prefix
/// comparison, allowing the final summary token to be cut mid-word by the
/// truncation boundary. A promoted lead (`timelinePromoteInformativeLead`)
/// is a mid-body paragraph and intentionally survives this check.
func timelineSummaryIsRedundantWithDetail(summary: String, detail: String) -> Bool {
    let sTokens = timelineComparableTokens(summary)
    let dTokens = timelineComparableTokens(detail)
    guard !sTokens.isEmpty, !dTokens.isEmpty else { return false }
    if sTokens == dTokens { return true }
    guard sTokens.count >= 3, dTokens.count >= sTokens.count else { return false }
    guard dTokens.starts(with: sTokens.dropLast()) else { return false }
    return dTokens[sTokens.count - 1].hasPrefix(sTokens[sTokens.count - 1])
}

private func timelineComparableTokens(_ s: String) -> [String] {
    timelineStripMarkdownInline(s)
        .lowercased()
        .components(separatedBy: CharacterSet.alphanumerics.inverted)
        .filter { !$0.isEmpty }
}

func timelineIsProgressChatResponse(_ entry: TimelineEntry) -> Bool {
    guard entry.type == .chatResponse else { return false }
    if entry.summaryKind == "progress" { return true }
    return timelineLooksLikeAssistantProgressUpdate(entry.detail ?? entry.raw)
}

func timelineLooksLikeAssistantProgressUpdate(_ text: String?) -> Bool {
    guard let text else { return false }
    let key = text as NSString
    if let hit = timelineProgressUpdateCache.object(forKey: key) { return hit.boolValue }
    let result = timelineComputeLooksLikeAssistantProgressUpdate(text)
    timelineProgressUpdateCache.setObject(NSNumber(value: result), forKey: key)
    return result
}

private func timelineComputeLooksLikeAssistantProgressUpdate(_ text: String) -> Bool {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return false }
    let head = String(trimmed.prefix(800))
    let lower = head.lowercased()

    let englishProgress = TimelineRowRegex.progressEN.contains {
        TimelineRowRegex.matches($0, lower)
    }
    let koreanProgress = TimelineRowRegex.progressKO.contains {
        TimelineRowRegex.matches($0, head)
    }

    guard englishProgress || koreanProgress else { return false }

    let startsAsFinal =
        TimelineRowRegex.matches(TimelineRowRegex.finalLeadEN, trimmed) ||
        TimelineRowRegex.matches(TimelineRowRegex.finalLeadKO, trimmed)
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
    let key = s as NSString
    if let hit = timelineMarkdownStripCache.object(forKey: key) { return hit as String }
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
    let result = out.trimmingCharacters(in: .whitespacesAndNewlines)
    timelineMarkdownStripCache.setObject(result as NSString, forKey: key)
    return result
}

/// True when the row at `index` should render indented under a TASK header:
/// it carries a taskId AND the nearest task marker above it in the rendered
/// list is that same task's `task_start`. A bare `taskId != nil` check is not
/// sufficient — interleaved concurrent sessions (and legacy rows whose taskId
/// was stamped from another session's active task before the per-session
/// collector fix) would indent under an unrelated session's header, reading
/// as a fake cross-session subtree. Mirrors `timelineRowIsNestedUnderTaskHeader`
/// in android TimelineStrip.kt.
func timelineRowIsNestedUnderTaskHeader(at index: Int, in groups: [GroupedEntry]) -> Bool {
    guard index >= 0, index < groups.count else { return false }
    guard let taskId = groups[index].entry.taskId, !taskId.isEmpty else { return false }
    for i in stride(from: index - 1, through: 0, by: -1) {
        let e = groups[i].entry
        if e.type == .taskStart || e.type == .taskEnd {
            // The nearest marker decides: an open header of the same task
            // nests this row; any other header (another task's, or this
            // task's own task_end) means the row stands at top level.
            return e.type == .taskStart && e.taskId == taskId
        }
    }
    return false
}

func timelineHasLaterCompletion(for start: TimelineEntry, in groups: [GroupedEntry]) -> Bool {
    groups.contains { other in
        guard timelineIsCompletionEntry(other.entry) else { return false }
        guard other.entry.ts >= start.ts else { return false }
        return timelineSameContext(start, other.entry)
    }
}

/// A queued / superseded `chat_start`. The user really did submit this prompt,
/// but a later same-session prompt took over the turn anchor before any
/// completion arrived — Codex (and other observed agents) coalesce rapid-fire
/// UserPromptSubmit into one turn and emit a single Stop stamped to the
/// *latest* open turn (see `sameTurnAnchor`). The one shared response therefore
/// merges into that later turn, leaving this one with no response of its own.
/// Returns the later group carrying the shared response, so the folded turn
/// can borrow it for its detail pane; nil when this turn was answered on its
/// own or is still the live open turn (nothing has answered the batch yet).
func timelineSupersedingGroup(for group: GroupedEntry, at index: Int,
                              in grouped: [GroupedEntry]) -> GroupedEntry? {
    guard group.entry.type == .chatStart, !group.hasResponse else { return nil }
    guard index >= 0, index + 1 < grouped.count else { return nil }
    for j in (index + 1)..<grouped.count {
        let other = grouped[j]
        guard timelineSameContext(group.entry, other.entry) else { continue }
        // A same-session session boundary or standalone completion between the
        // two prompts means this turn closed on its own boundary — not folded.
        if other.entry.type == .taskEnd { return nil }
        if other.entry.type == .chatStart {
            if other.hasResponse { return other }
            continue // another still-open queued prompt — keep looking for the answered one
        }
        if timelineIsCompletionEntry(other.entry) { return nil }
    }
    return nil
}

/// Index-free convenience for the detail pane, which only has the group.
func timelineSupersedingGroup(for group: GroupedEntry,
                              in grouped: [GroupedEntry]) -> GroupedEntry? {
    guard let idx = grouped.firstIndex(where: { $0.id == group.id }) else { return nil }
    return timelineSupersedingGroup(for: group, at: idx, in: grouped)
}

/// Mirror of `timelineSupersedingGroup`: true when `group` is the answered
/// `chat_start` that absorbed an earlier same-session queued prompt's shared
/// response. Drives the small "shared" tag on the response sub-line.
func timelineAbsorbsQueuedPrompt(for group: GroupedEntry, at index: Int,
                                 in grouped: [GroupedEntry]) -> Bool {
    guard group.entry.type == .chatStart, group.hasResponse else { return false }
    for j in stride(from: index - 1, through: 0, by: -1) {
        let other = grouped[j]
        guard timelineSameContext(group.entry, other.entry) else { continue }
        if other.entry.type == .taskEnd { return false }
        if other.entry.type == .chatStart { return !other.hasResponse }
        if timelineIsCompletionEntry(other.entry) { return false }
    }
    return false
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
    // Observed agents emit one tool_exec per Bash/MCP/read/todowrite action.
    // Those rows are useful for telemetry/eval ingestion, but they drown the
    // user-facing timeline and can make Claude work look like observed-agent
    // work when multiple agents run together. OpenCode had no suppression and
    // flooded its own turn with tool rows while Codex read clean. Antigravity
    // is included forward-compat (the observed-hook classifier already accepts
    // antigravity_* events).
    if ObservedAgentRules.toolExecSuppressed.contains(entry.agentType ?? ""), entry.type == .toolExec {
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
    /// When the task closed (task_end row timestamp). Drives the pending →
    /// unscored terminal transition: if the judge hasn't resolved within
    /// `unscoredAfterSec` of the close, it never will (judge disabled, LLM
    /// backend down, or the enqueue was lost) — showing "…" forever reads as
    /// "still working". nil = unknown close time; stays on the pending glyph.
    var closedAt: Date? = nil

    /// Judges resolve in 5–30 s; 5 minutes is decisively past any real queue.
    private static let unscoredAfterSec: TimeInterval = 300

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
            if let closedAt, Date().timeIntervalSince(closedAt) > Self.unscoredAfterSec {
                glyph = "unscored"; color = TerrariumHUD.subtext.opacity(0.5)
            } else {
                glyph = "…"; color = TerrariumHUD.subtext.opacity(0.6)
            }
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
        .accessibilityLabel(
            score != nil ? "Task score \(String(format: "%.2f", score!)) \(outcome ?? "")"
                : glyph == "unscored" ? "Task eval unscored" : "Task eval pending"
        )
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

struct TimelineSessionFilter: Equatable {
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
        case "antigravity": return "Antigravity"
        case "kiro-cli": return "Kiro CLI"
        case "kiro-ide": return "Kiro IDE"
        default: return sessionId
        }
    }
}

extension TimelineEntry {
    func matchesTimelineFilter(_ filter: TimelineSessionFilter) -> Bool {
        let entrySessionId = canonicalTimelineSessionId(sessionId)
        let focusedSessionId = canonicalTimelineSessionId(filter.sessionId)
        if entrySessionId != nil, entrySessionId == focusedSessionId {
            return true
        }

        // OpenClaw timeline entries are daemon-local and historically used
        // agent attribution without a session id. Keep those visible when the
        // virtual Gateway session is focused.
        if filter.sessionId == "openclaw-gateway",
           agentType == "openclaw",
           entrySessionId == nil {
            return true
        }

        guard entrySessionId == nil else { return false }
        if let projectName = filter.projectName,
           !projectName.isEmpty,
           projectName == self.projectName,
           filter.agentType == agentType {
            return true
        }
        return false
    }
}

private struct TimelineMarkdownPreview: View {
    let text: String

    /// Parsed lines with consecutive plain-text / code lines coalesced into
    /// one node. macOS drag-selection cannot cross Text view boundaries, so
    /// per-line Texts made every paragraph and code block a patchwork of
    /// one-line selection islands; coalescing turns each paragraph and each
    /// fenced block into a single selectable run.
    private var lines: [TimelineMarkdownLine] {
        var out: [TimelineMarkdownLine] = []
        for line in TimelineMarkdownLine.parse(text) {
            switch (out.last, line) {
            case let (.text(prev)?, .text(next)):
                out[out.count - 1] = .text(prev + "\n" + next)
            case let (.code(prev)?, .code(next)):
                out[out.count - 1] = .code(prev + "\n" + next)
            default:
                out.append(line)
            }
        }
        return out
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
            attributedMultilineText(content,
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
            let next = span.text(baseFont: font, baseColor: color)
            return Text("\(acc)\(next)")
        }
    }

    /// Multi-line variant for coalesced `.text` nodes: inline spans are still
    /// parsed per line (span markers never cross line breaks) and the lines
    /// are folded into ONE `Text` so the whole paragraph is a single
    /// selectable run.
    private func attributedMultilineText(_ content: String, font: Font, color: Color) -> Text {
        content.components(separatedBy: "\n")
            .enumerated()
            .reduce(Text("")) { acc, item in
                let line = attributedText(item.element, font: font, color: color)
                return item.offset == 0 ? line : Text("\(acc)\n\(line)")
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
/// Same staleness horizon for an unpaired `chat_start` (see
/// `timelineIsRotatingEntry`). A single turn rarely runs >10min, so a
/// chat_start still spinning past this lost its completion event.
private let chatStartMaxAgeSec: TimeInterval = 600
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

/// Same-session test mirroring the turn-merge rule: both ids equal, or both
/// absent (legacy single-session emitters). Mirrors `sameRotatingSession` in
/// shared/src/timeline-icons.ts.
private func timelineSameRotatingSession(_ a: String?, _ b: String?) -> Bool {
    let aEmpty = a?.isEmpty ?? true
    let bEmpty = b?.isEmpty ?? true
    if aEmpty && bEmpty { return true }
    return !aEmpty && !bEmpty && a == b
}

/// True when a turn row should rotate its leading icon. Combines the
/// `running` icon-key (chat_start, unknown types) with the in-flight task
/// hierarchy signal so an open `task_start` also spins until its `task_end`
/// arrives. Mirrors `isRotatingEntry` in shared/src/timeline-icons.ts —
/// update all three mirrors (shared / Apple / Android) in the same commit.
func timelineIsRotatingEntry(_ entry: TimelineEntry, siblings: [TimelineEntry]) -> Bool {
    if timelineIconKey(for: entry.type, status: entry.status) == .running {
        // Staleness backstop mirroring `timelineIsInFlightTask`: a `chat_start`
        // whose completion never arrives (Claude Stop hook ~18% reliable, or a
        // summarizer Task that hangs) would otherwise spin forever. After
        // `chatStartMaxAgeSec` with no completion, treat it as resolved-but-
        // orphaned so the row reads static. Only chat_start gets the cap;
        // genuine `.unknown`/`.running` transient rows keep spinning.
        if entry.type == .chatStart {
            let ageSec = Date().timeIntervalSince(entry.date)
            if ageSec > chatStartMaxAgeSec { return false }
            // Shared-SSOT sibling scan the Swift mirror had dropped: a later
            // same-session completion — or a later chat_start superseding
            // this turn even when its completion signal was lost — stops the
            // spinner immediately instead of animating out the full age cap.
            for s in siblings where s.ts >= entry.ts {
                if !timelineSameRotatingSession(entry.sessionId, s.sessionId) { continue }
                // `error` closes a turn as surely as a response does — a failed
                // request emits one instead of a reply, and leaving it off this
                // list kept the spinner turning next to its own explanation.
                if s.type == .chatResponse || s.type == .chatEnd
                    || s.type == .modelResponse || s.type == .error {
                    return false
                }
                if s.type == .chatStart && s.ts > entry.ts { return false }
            }
        }
        return true
    }
    return timelineIsInFlightTask(entry, siblings: siblings)
}

/// Map a timeline entry to its semantic icon key. Mirrors
/// `timelineIconKey()` in shared/src/timeline-icons.ts.
func timelineIconKey(for type: TimelineEntryType, status: String? = nil) -> TimelineIconKey {
    switch type {
    case .taskStart, .taskEnd:
        return .task
    case .taskMilestone:
        return .success
    case .chatStart:
        return .running
    case .chatEnd, .chatResponse, .modelResponse:
        return .success
    case .modelCall:
        return .model
    case .toolRequest:
        // `abandoned` shares the amber no-decision icon with `pending`: the same
        // fact at two points in time (still open / closed unanswered), and
        // neither is a refusal.
        switch status {
        case "approved": return .success
        case "denied": return .error
        default: return .awaiting
        }
    case .toolResolved:
        // The resolution row carries the SAME status as the request it closes,
        // so it must branch on it. Returning .success unconditionally drew a
        // green check on a denial and on an abandonment alike.
        switch status {
        case "denied": return .error
        case "abandoned": return .awaiting
        default: return .success
        }
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
