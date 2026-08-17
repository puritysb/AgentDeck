// Timeline.swift — Event timeline types
// Ported from shared/src/timeline.ts

import Foundation

// MARK: - Timeline Entry Type

/// Lenient enum: unknown raw values decode to `.unknown(rawValue)` instead of
/// throwing. Lets older clients survive future protocol additions; lets newer
/// clients display unrecognised type rows in degraded mode.
enum TimelineEntryType: Codable, Sendable, Equatable, Hashable {
    case toolRequest
    case toolResolved
    case chatStart
    case chatEnd
    case chatResponse
    case error
    case scheduled
    case userAction
    case modelCall
    case modelResponse
    case memoryRecall
    case toolExec
    case evalResult
    case taskStart
    case taskEnd
    /// Mid-task completion milestone (TodoWrite-all-completed soft hint) —
    /// non-segmenting; surfaces WHERE work completed inside a long task.
    case taskMilestone
    case unknown(String)

    var rawValue: String {
        switch self {
        case .toolRequest: return "tool_request"
        case .toolResolved: return "tool_resolved"
        case .chatStart: return "chat_start"
        case .chatEnd: return "chat_end"
        case .chatResponse: return "chat_response"
        case .error: return "error"
        case .scheduled: return "scheduled"
        case .userAction: return "user_action"
        case .modelCall: return "model_call"
        case .modelResponse: return "model_response"
        case .memoryRecall: return "memory_recall"
        case .toolExec: return "tool_exec"
        case .evalResult: return "eval_result"
        case .taskStart: return "task_start"
        case .taskEnd: return "task_end"
        case .taskMilestone: return "task_milestone"
        case .unknown(let raw): return raw
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        self = TimelineEntryType(rawValue: raw)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    init(rawValue raw: String) {
        switch raw {
        case "tool_request": self = .toolRequest
        case "tool_resolved": self = .toolResolved
        case "chat_start": self = .chatStart
        case "chat_end": self = .chatEnd
        case "chat_response": self = .chatResponse
        case "error": self = .error
        case "scheduled": self = .scheduled
        case "user_action": self = .userAction
        case "model_call": self = .modelCall
        case "model_response": self = .modelResponse
        case "memory_recall": self = .memoryRecall
        case "tool_exec": self = .toolExec
        case "eval_result": self = .evalResult
        case "task_start": self = .taskStart
        case "task_end": self = .taskEnd
        case "task_milestone": self = .taskMilestone
        default: self = .unknown(raw)
        }
    }
}

// MARK: - Task Boundary Signal

enum TaskBoundarySignal: String, Codable, Sendable, Equatable {
    case todoComplete = "todo_complete"
    case clear
    case sessionEnd = "session_end"
    case manual
    case idleGap = "idle_gap"
}

// MARK: - Timeline Entry

struct TimelineEntry: Codable, Sendable, Identifiable {
    let ts: Double  // milliseconds
    let type: TimelineEntryType
    let raw: String
    var detail: String?
    var approvalId: String?
    var status: String?  // pending | approved | denied
    var agentType: String?
    /// Cron/channel/web initiated rows. Used to collapse noisy prompt dumps
    /// and distinguish background activity from user-submitted prompts.
    var automated: Bool?
    /// Project folder name of the session that produced this entry. Used as
    /// the row prefix so multi-session dashboards can tell "ViewTrans" apart
    /// from "AgentDeck" even when both are the same `agentType`. Nil for
    /// entries predating the multi-session attribution work.
    var projectName: String?
    /// Session id the entry belongs to. Populated from state_update events
    /// that carry the hook-attributing sessionId.
    var sessionId: String?
    /// Agent run id, when the upstream adapter exposes one. OpenClaw Gateway
    /// uses this to group tool/model rows belonging to the same generation.
    var runId: String?
    /// Lifecycle bounds for task/turn entries. `ts` remains the display/event
    /// timestamp; these fields let the detail pane show elapsed work clearly.
    var startedAt: Double?
    var endedAt: Double?
    /// APME task id. Set on task_start/task_end and on every turn entry inside
    /// the task scope. Lets the timeline group turns under a task header.
    var taskId: String?
    /// Only on task_end. Why the task closed.
    var boundarySignal: TaskBoundarySignal?
    /// How the row's `raw` summary was produced. Lets clients decide whether
    /// the detail pane is worth showing.
    ///   - "llm"       : LLM-summarized (clean, distinct from detail)
    ///   - "heuristic" : topic-hint extracted from response or prompt
    ///   - "none"      : last-resort fallback (literal "Completed", bare tool name, etc.)
    /// nil for legacy entries — clients should treat as "heuristic" (don't aggressively suppress).
    var summaryKind: String?
    /// Per-task evaluation rollup, attached on the second `task_end` emit the
    /// runner fires once the LLM judge resolves (5–30 s after the initial
    /// boundary). Stores upsert by (type == .taskEnd, taskId). Nil on the
    /// initial emit and for non-task entries / pre-existing on-disk rows.
    /// Mirrors the four task* fields on shared/src/timeline.ts::TimelineEntry.
    ///   - `taskScore`    : 0..1 composite (matches `tasks.composite_score`)
    ///   - `taskOutcome`  : "success" | "partial" | "fail" | "pending"
    ///   - `taskCategory` : task_rollup category
    ///   - `taskSummary`  : one-line judge summary
    var taskScore: Double?
    var taskOutcome: String?
    var taskCategory: String?
    var taskSummary: String?

    var id: Double { ts }

    var date: Date {
        Date(timeIntervalSince1970: ts / 1000)
    }

    enum CodingKeys: String, CodingKey {
        case ts, type, raw, detail, approvalId, status, agentType, automated, projectName
        case sessionId, runId, startedAt, endedAt, taskId, boundarySignal, summaryKind
        case taskScore, taskOutcome, taskCategory, taskSummary
    }

    init(
        ts: Double,
        type: TimelineEntryType,
        raw: String,
        detail: String? = nil,
        approvalId: String? = nil,
        status: String? = nil,
        agentType: String? = nil,
        automated: Bool? = nil,
        projectName: String? = nil,
        sessionId: String? = nil,
        runId: String? = nil,
        startedAt: Double? = nil,
        endedAt: Double? = nil,
        taskId: String? = nil,
        boundarySignal: TaskBoundarySignal? = nil,
        summaryKind: String? = nil,
        taskScore: Double? = nil,
        taskOutcome: String? = nil,
        taskCategory: String? = nil,
        taskSummary: String? = nil
    ) {
        self.ts = ts
        self.type = type
        self.raw = raw
        self.detail = detail
        self.approvalId = approvalId
        self.status = status
        self.agentType = agentType
        self.automated = automated
        self.projectName = projectName
        self.sessionId = sessionId
        self.runId = runId
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.taskId = taskId
        self.boundarySignal = boundarySignal
        self.summaryKind = summaryKind
        self.taskScore = taskScore
        self.taskOutcome = taskOutcome
        self.taskCategory = taskCategory
        self.taskSummary = taskSummary
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.ts = try c.decode(Double.self, forKey: .ts)
        self.type = try c.decode(TimelineEntryType.self, forKey: .type)
        self.raw = try c.decode(String.self, forKey: .raw)
        self.detail = try c.decodeIfPresent(String.self, forKey: .detail)
        self.approvalId = try c.decodeIfPresent(String.self, forKey: .approvalId)
        self.status = try c.decodeIfPresent(String.self, forKey: .status)
        self.agentType = try c.decodeIfPresent(String.self, forKey: .agentType)
        self.automated = try c.decodeIfPresent(Bool.self, forKey: .automated)
        self.projectName = try c.decodeIfPresent(String.self, forKey: .projectName)
        self.sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId)
        self.runId = try c.decodeIfPresent(String.self, forKey: .runId)
        self.startedAt = try c.decodeIfPresent(Double.self, forKey: .startedAt)
        self.endedAt = try c.decodeIfPresent(Double.self, forKey: .endedAt)
        self.taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        // boundarySignal: tolerate unknown future signals by silently dropping
        if let raw = try c.decodeIfPresent(String.self, forKey: .boundarySignal) {
            self.boundarySignal = TaskBoundarySignal(rawValue: raw)
        } else {
            self.boundarySignal = nil
        }
        self.summaryKind = try c.decodeIfPresent(String.self, forKey: .summaryKind)
        // Task-judge rollup fields, attached on the second `task_end` emit
        // the bridge runner fires once the LLM judge resolves. The custom
        // `init(from:)` above enumerates every field explicitly — without
        // these four `decodeIfPresent` calls the JSON keys arrive over WS
        // but Swift silently leaves the properties at their default nil,
        // so the dashboard task header never gets a score badge even
        // though the daemon broadcast it. Same trap as
        // `DaemonTimelineEntry`'s 3-site dict round-trip — patch in
        // lockstep when adding new TimelineEntry fields. Tolerate unknown
        // future `taskOutcome` strings by holding them verbatim; the
        // badge switch handles unknown values as the pending placeholder.
        self.taskScore = try c.decodeIfPresent(Double.self, forKey: .taskScore)
        self.taskOutcome = try c.decodeIfPresent(String.self, forKey: .taskOutcome)
        self.taskCategory = try c.decodeIfPresent(String.self, forKey: .taskCategory)
        self.taskSummary = try c.decodeIfPresent(String.self, forKey: .taskSummary)
    }
}

// MARK: - Grouped Entry (for UI display)

struct GroupedEntry: Identifiable, Sendable {
    let entry: TimelineEntry
    var count: Int = 1
    var lastTs: Double
    /// Assistant response body (chat_response) merged into this group. The
    /// daemon emits chat_start / chat_response / chat_end as three separate
    /// timeline entries; the UI presents them as one turn row so users see
    /// a single evaluable unit instead of three near-duplicate lines.
    var mergedResponse: TimelineEntry? = nil
    /// Terminator metadata (chat_end) merged into this group. Carries the
    /// "Completed · Ns · topic" suffix + `summaryKind` backend pill.
    var mergedCompletion: TimelineEntry? = nil

    /// True when the assistant has delivered something for this turn —
    /// either the response body or the completion metadata. UIs use this
    /// to decide whether to stop the chat_start spinner. Treating ONLY
    /// `mergedCompletion` as completion leaves the spinner rotating
    /// forever in two real production cases:
    ///   1. Claude Code Stop hook is only ~18% reliable (memory note
    ///      `feedback_apme_stop_hook.md`); chat_end is the row that
    ///      hook emits, but chat_response arrives via a different path.
    ///   2. `appendClaudeCodeChatEnd` builds chat_end inside a
    ///      `Task { await TimelineSummarizer.summarize(...) }` so a hung
    ///      summarizer prevents the chat_end broadcast even though
    ///      chat_response was emitted synchronously above it.
    /// In both cases the user has already seen the assistant's reply but
    /// the row keeps spinning. Codex stop-time review #11 (2026-05-17).
    var hasResponse: Bool { mergedResponse != nil || mergedCompletion != nil }

    /// Unique ID combining timestamp + type + count to avoid ForEach duplicate ID warnings
    var id: String { "\(entry.ts)-\(entry.type.rawValue)-\(count)" }
}

// MARK: - Timeline Grouping

/// How many prior groups a turn child (chat_response/chat_end) may scan back
/// through to find its chat_start. With several agents running concurrently,
/// other sessions' rows interleave between a prompt and its completion —
/// merging only into the immediately-previous group (the old behaviour) made
/// every busy-dashboard turn render as 2-3 scattered rows. Bounded so a
/// pathological backlog can't go quadratic. Mirrors TURN_MERGE_LOOKBACK in
/// android TimelineStore.kt.
private let turnMergeLookback = 40
private let turnMergeMaxGapMs: Double = 12 * 60 * 60 * 1000

func groupConsecutive(_ entries: [TimelineEntry], windowSeconds: Double = 60) -> [GroupedEntry] {
    guard !entries.isEmpty else { return [] }

    var groups: [GroupedEntry] = []
    for entry in entries {
        let isTaskMarker = entry.type == .taskStart || entry.type == .taskEnd
        if !isTaskMarker, let last = groups.last {
            // Turn merge: a chat_response/chat_end folds into the most recent
            // same-context turn group, looking past interleaved rows from
            // other sessions.
            if tryMergeTurnChild(&groups, entry) { continue }

            // Same-type consecutive run collapse (×count).
            // Task hierarchy entries never group — they're unique markers.
            let timeDiff = abs(entry.ts - last.lastTs)
            if last.entry.type != .taskStart && last.entry.type != .taskEnd &&
               entry.type == last.entry.type &&
               entry.raw == last.entry.raw &&
               sameTimelineContext(last.entry, entry) &&
               timeDiff <= timelineGroupingWindowMs(for: entry.type, defaultWindowSeconds: windowSeconds) {
                groups[groups.count - 1].count += 1
                groups[groups.count - 1].lastTs = entry.ts
                continue
            }
        }
        groups.append(GroupedEntry(entry: entry, lastTs: entry.ts))
    }
    return groups
}

/// Fold a turn child (chat_response / chat_end) into the group it belongs to.
///
/// Scans recent groups newest-first. The first same-context group encountered
/// decides the outcome — it is either this child's turn (merge) or evidence
/// that the turn is already closed / distinct (stop, render standalone).
/// sessionId + the chat_start anchor (`entry.startedAt == chat_start.ts`) are
/// the gate — wall-clock isn't, because long assistant responses (multi-fix
/// Claude Code tasks run 20 min+) push chat_end far past any reasonable
/// window. The anchor match is critical: without it an out-of-order chat_end
/// that arrives *after* the next user_prompt_submit would attach to the fresh
/// chat_start, cross-talking Q1's completion onto Q2's row (Codex stop-time
/// review #7, 2026-05-17). Legacy entries with nil startedAt fall back to
/// allowing the merge — bounded by the "most recent same-context chat_start"
/// rule.
///
/// Synthetic chat_start placeholders ("Prompt sent" / "Codex turn started")
/// never absorb — the dashboard filter promotes the trailing completion as
/// the visible row, and merging would hide that completion entirely. When the
/// prompt row is missing or synthetic, a visible chat_response absorbs its
/// trailing chat_end instead so "Completed · ..." doesn't spawn its own row.
/// Mirrors `tryMergeTurnChild` in android TimelineStore.kt.
private func tryMergeTurnChild(_ groups: inout [GroupedEntry], _ entry: TimelineEntry) -> Bool {
    let isResponse = entry.type == .chatResponse
    let isCompletion = entry.type == .chatEnd
    if !isResponse && !isCompletion { return false }

    var scanned = 0
    for i in stride(from: groups.count - 1, through: 0, by: -1) {
        scanned += 1
        if scanned > turnMergeLookback { return false }
        let g = groups[i]
        let ge = g.entry
        if entry.ts - ge.ts > turnMergeMaxGapMs { return false }
        guard sameTimelineContext(ge, entry) else { continue }

        switch ge.type {
        case .chatStart:
            // Most recent same-context chat_start = this child's turn. Any
            // mismatch means the child's real turn row is missing — merging
            // further back would cross-talk onto an older turn.
            if !timelineIsMeaningfulChatStart(ge) { return false }
            if g.mergedCompletion != nil { return false }
            if !sameTurnAnchor(start: ge, child: entry) { return false }
            if isResponse {
                if g.mergedResponse != nil { return false }
                groups[i].mergedResponse = entry
            } else {
                groups[i].mergedCompletion = entry
            }
            return true
        case .chatResponse:
            if isCompletion &&
               g.mergedCompletion == nil &&
               sameResponseCompletionAnchor(response: ge, completion: entry) {
                groups[i].mergedCompletion = entry
                return true
            }
            return false
        case .toolRequest, .toolResolved, .toolExec, .modelCall, .memoryRecall:
            // Activity *inside* the turn — look past it to the turn's chat_start.
            continue
        default:
            // Any other same-context row (chat_end, task marker…) is a turn
            // boundary for this session — stop scanning.
            return false
        }
    }
    return false
}

private func timelineGroupingWindowMs(for type: TimelineEntryType, defaultWindowSeconds: Double) -> Double {
    switch type {
    case .toolRequest:
        return 10_000
    case .evalResult:
        return max(defaultWindowSeconds * 1000, 10 * 60 * 1000)
    default:
        return defaultWindowSeconds * 1000
    }
}

/// Same-context test for grouping + turn merge. Mirrors Android
/// `TimelineDisplay.kt::sameTimelineContext` — a 4-level cascade
/// (taskId → runId → sessionId → project+agent fallback) so concurrent
/// sessions never cross-merge and OpenClaw runId-scoped rows group
/// correctly. Replaces the old sessionId-only `sameSession`, which
/// disagreed with the full-context display filter (`matchesTimelineFilter`)
/// and mis-grouped turns that share a session but differ by runId/taskId.
private func sameTimelineContext(_ a: TimelineEntry, _ b: TimelineEntry) -> Bool {
    // 1) taskId — strongest grouping key; same task is same context.
    if let at = timelineNonBlank(a.taskId), let bt = timelineNonBlank(b.taskId) {
        return at == bt
    }
    // 2) runId — adapter-emitted generation id (OpenClaw groups tool/model
    //    rows of the same generation by this).
    if let ar = timelineNonBlank(a.runId), let br = timelineNonBlank(b.runId) {
        return ar == br
    }
    // 3) sessionId — once either side has one, both must match. An earlier
    //    (projectName, agentType) fallback collapsed two real sessions in the
    //    same project into one timeline row.
    let asid = timelineNonBlank(a.sessionId)
    let bsid = timelineNonBlank(b.sessionId)
    if asid != nil || bsid != nil {
        return asid != nil && asid == bsid
    }
    // 4) Both sessionless — legacy fallback on project + agent.
    if timelineNonBlank(a.projectName) != nil,
       a.projectName == b.projectName,
       a.agentType == b.agentType {
        return true
    }
    return timelineNonBlank(a.projectName) == nil
        && timelineNonBlank(b.projectName) == nil
        && a.agentType == b.agentType
}

/// Session-list rows for passively observed agents use a provider prefix
/// (`observed:codex:<uuid>`), while hook timeline rows use the raw session id.
/// Canonicalize both sides before filtering so selecting an observed session
/// does not hide its timeline. Mirrors Android `canonicalTimelineSessionId`
/// and Node `BridgeTimelineStore.getHistoryForSession`.
func canonicalTimelineSessionId(_ value: String?) -> String? {
    guard let value = timelineNonBlank(value) else { return nil }
    // Generated from the TypeScript source rather than written here: this list
    // was hand-mirrored and drifted, missing both Kiro keys, so selecting a
    // Kiro session matched no rows and its timeline came up empty.
    for prefix in ObservedAgentRules.sessionPrefixes where value.hasPrefix(prefix) {
        return timelineNonBlank(String(value.dropFirst(prefix.count)))
    }
    return value
}

/// nil for a nil-or-whitespace string, else the string — the Swift analogue
/// of Kotlin's `String?.takeIf { it.isNotBlank() }` used by
/// `sameTimelineContext` / `normalizeTimelineEntryForStorage`.
private func timelineNonBlank(_ s: String?) -> String? {
    guard let s, !s.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    return s
}

// MARK: - Storage-layer normalization (WS-client mirror)
//
// Client-side mirror of `DaemonTimelineStore.normalizeForStorage` /
// `shouldDropLowSignalEntry` (macOS daemon, operates on `DaemonTimelineEntry`)
// and Android `TimelineDisplay.kt::normalizeTimelineEntryForStorage` (operates
// on the client `TimelineEntry`). The Swift daemon copy is macOS-only, so the
// WS-client store — used on iOS and by macOS when it attaches to an external
// Node daemon — needs its own copy on the shared `TimelineEntry` model, exactly
// as Android carries a client copy separate from the bridge. Keep all four
// mirrors (Node bridge DaemonTimelineStore.ts, Swift daemon
// DaemonTimelineStore.swift, Android TimelineDisplay.kt, here) in lockstep.
//
// Purpose: drop OTel / tool-placeholder noise at the *storage* layer so it
// never occupies a slot in the bounded buffer (aging out real turn/task rows)
// and so `entries` readers that bypass display grouping don't see it. The
// upstream daemon already normalizes its own store, so on a current peer this
// is idempotent defense; it matters against a pre-filter daemon or rows
// persisted before the filter existed — the divergence Android already closed.

/// Returns nil to drop a low-signal row; a rewritten entry for OpenClaw cron
/// `model_call` rows; else the entry unchanged.
///
/// The drop test reuses the client's existing display-layer
/// `timelineIsLowSignalEntry` (tool/OTel placeholder noise; TimelineStripView)
/// and adds `timelineIsOpenClawLowSignalResponse` — the OpenClaw polling-ack
/// drop that Android's `isLowSignalEntry` folds in but the Swift display filter
/// does not — so the *storage* layer matches Android's
/// `normalizeTimelineEntryForStorage`. Dropping at storage (not just display)
/// stops the noise from occupying a bounded-buffer slot.
func normalizeTimelineEntryForStorage(_ entry: TimelineEntry) -> TimelineEntry? {
    if timelineIsOpenClawLowSignalResponse(entry) || timelineIsLowSignalEntry(entry) { return nil }
    guard entry.agentType == "openclaw",
          entry.type == .modelCall,
          entry.automated == true
            || timelineIsOpenClawCronPrompt(entry.raw)
            || timelineIsOpenClawCronPrompt(entry.detail),
          timelineIsOpenClawCronPrompt(entry.raw) || timelineIsOpenClawCronPrompt(entry.detail)
    else {
        return entry
    }
    let source = timelineIsOpenClawCronPrompt(entry.raw) ? entry.raw : entry.detail
    return entry.withCronSummary(timelineSummarizeOpenClawCronPrompt(source))
}

func timelineIsOpenClawLowSignalResponse(_ entry: TimelineEntry) -> Bool {
    guard entry.agentType == "openclaw" else { return false }
    let isResponse = entry.type == .chatResponse || entry.type == .modelResponse
    let isAutomatedStart = entry.type == .chatStart && entry.automated == true
    guard isResponse || isAutomatedStart else { return false }

    let text = [entry.raw, entry.detail].compactMap { $0 }.joined(separator: "\n")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return false }
    if timelineHasOpenClawNotificationFailureSignal(text) { return false }

    let lower = text.lowercased()
    let hasNoReply = lower.contains("no_reply")
    let looksLikePolling =
        timelineRegexMatch(lower, #"still translating"#) ||
        timelineRegexMatch(lower, #"translation still in progress"#) ||
        timelineRegexMatch(lower, #"not all .*?(terminal|published|failed|complete|completed)"#) ||
        timelineRegexMatch(lower, #"(in progress|still active|no action needed|nothing to notify yet)"#) ||
        timelineRegexMatch(lower, #"cron job (stays|retained|active)"#) ||
        timelineRegexMatch(lower, #"pipeline still active"#) ||
        timelineRegexMatch(text, #"(아직|여전히|계속).*(번역|진행)\s*중"#) ||
        timelineRegexMatch(text, #"알릴 필요 없음|수행할 작업이 없음|대기합니다"#)

    if isAutomatedStart { return looksLikePolling }
    return looksLikePolling
        && (hasNoReply
            || lower.contains("no action needed")
            || lower.contains("nothing to notify yet")
            || text.contains("알릴 필요 없음"))
}

private func timelineHasOpenClawNotificationFailureSignal(_ text: String) -> Bool {
    let english = timelineRegexMatch(text, #"\b(line|notification|userid|target id|target issue)\b"#, caseInsensitive: true)
        && timelineRegexMatch(text, #"\b(fail(ed|ure)?|missing|unconfigured|notified|needed|pending)\b"#, caseInsensitive: true)
    let korean = timelineRegexMatch(text, #"(LINE|알림|userId|사용자 ID|대상 ID).*(실패|미등록|미설정|구성되지|필요|대기)"#, caseInsensitive: true)
    return english || korean
}

func timelineIsOpenClawCronPrompt(_ text: String?) -> Bool {
    guard let text else { return false }
    return text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[cron:")
}

func timelineSummarizeOpenClawCronPrompt(_ text: String?) -> String {
    guard let text else { return "자동 작업" }
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let end = trimmed.firstIndex(of: "]") else { return "자동 작업" }
    let header = String(trimmed[..<end])
    let parts = header.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
    guard parts.count == 2 else { return "자동 작업" }
    let job = String(parts[1])
        .replacingOccurrences(of: "[-_]+", with: " ", options: .regularExpression)
        .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !job.isEmpty else { return "자동 작업" }
    let capped = job.count > 64 ? String(job.prefix(61)) + "..." : job
    return "자동 작업 · \(capped)"
}

private func timelineRegexMatch(_ text: String, _ pattern: String, caseInsensitive: Bool = false) -> Bool {
    var options: String.CompareOptions = [.regularExpression]
    if caseInsensitive { options.insert(.caseInsensitive) }
    return text.range(of: pattern, options: options) != nil
}

extension TimelineEntry {
    /// OpenClaw cron `model_call` rewrite: collapse the raw `[cron: …]` dump to
    /// a short "자동 작업 · <job>" label, drop the noisy detail, force automated.
    /// `raw` is `let`, so this rebuilds the entry via the memberwise init.
    func withCronSummary(_ summary: String) -> TimelineEntry {
        TimelineEntry(
            ts: ts, type: type, raw: summary, detail: nil,
            approvalId: approvalId, status: status, agentType: agentType,
            automated: true, projectName: projectName, sessionId: sessionId,
            runId: runId, startedAt: startedAt, endedAt: endedAt, taskId: taskId,
            boundarySignal: boundarySignal, summaryKind: summaryKind ?? "heuristic",
            taskScore: taskScore, taskOutcome: taskOutcome,
            taskCategory: taskCategory, taskSummary: taskSummary
        )
    }
}

/// True when `child` (a chat_response or chat_end) actually belongs to
/// `start`. The daemon stamps every child's `startedAt` with the
/// originating chat_start's `ts` (`DaemonServer.swift::appendClaudeCodeChatEnd`),
/// so an exact match is the safest anchor. Legacy / pre-anchor emitters
/// don't carry `startedAt` — for those we permit the merge so behaviour
/// doesn't regress; the iteration order (entries ascending by ts) keeps
/// the worst case bounded to "the immediately next chat_start".
private func sameTurnAnchor(start: TimelineEntry, child: TimelineEntry) -> Bool {
    guard let anchor = child.startedAt else { return true }
    return anchor == start.ts
}

private func sameResponseCompletionAnchor(response: TimelineEntry, completion: TimelineEntry) -> Bool {
    switch (response.startedAt, completion.startedAt) {
    case let (r?, c?): return r == c
    case (nil, nil): return true
    case (nil, _?): return true
    case (_?, nil): return true
    }
}

/// True when a `chat_start` row carries a genuine user prompt (and thus is
/// worth showing as a turn row). False for adapter-emitted placeholders
/// like "Prompt sent" / "Codex turn started" where the user-visible text
/// is uninformative; those rows are absorbed by their following completion
/// row in `timelineDisplayGroupsForDashboard` rather than spawning a
/// synthetic head. Lives in the model because both `groupConsecutive`
/// (which uses it to decide whether to merge) and the UI filter call it.
func timelineIsMeaningfulChatStart(_ entry: TimelineEntry) -> Bool {
    let raw = entry.raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !raw.isEmpty else { return false }
    if timelineIsTaskNotificationChatStart(entry) { return false }
    let normalized = raw.lowercased()
    let syntheticStarts: Set<String> = [
        "prompt sent",
        "codex turn started",
        "starting chat",
        "connected",
        "resumed",
    ]
    return !syntheticStarts.contains(normalized)
}

/// The slash-command invocation a `chat_start` row's raw text represents
/// ("/merge", "/session-end --now"), or nil for an ordinary prompt.
/// Display-side mirror of shared/src/timeline.ts `parseSlashCommandPrompt` —
/// the command token must be the whole first word, so absolute paths
/// ("/Users/x/file") never match. Renderers use this to style command turns
/// distinctly (terminal glyph + CMD chip instead of a chat bubble).
func timelineSlashCommand(_ raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.hasPrefix("/") else { return nil }
    guard trimmed.range(of: #"^/[A-Za-z][\w:-]*(\s|$)"#, options: .regularExpression) != nil else {
        return nil
    }
    return trimmed
}

func timelineIsTaskNotificationChatStart(_ entry: TimelineEntry) -> Bool {
    guard entry.type == .chatStart else { return false }
    let raw = entry.raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let detail = entry.detail?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    return raw.hasPrefix("<task-notification>") || detail.hasPrefix("<task-notification>")
}

// Type display functions moved to TimelineStripView.swift (timelineTypeIcon, timelineTypeColor)
