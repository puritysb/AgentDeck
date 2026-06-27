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

func groupConsecutive(_ entries: [TimelineEntry], windowSeconds: Double = 60) -> [GroupedEntry] {
    guard !entries.isEmpty else { return [] }

    var result: [GroupedEntry] = []
    var current = GroupedEntry(entry: entries[0], lastTs: entries[0].ts)

    for i in 1..<entries.count {
        let entry = entries[i]
        let timeDiff = abs(entry.ts - current.lastTs)

        // Task hierarchy entries never group — they're unique markers.
        if entry.type == .taskStart || entry.type == .taskEnd ||
           current.entry.type == .taskStart || current.entry.type == .taskEnd {
            result.append(current)
            current = GroupedEntry(entry: entry, lastTs: entry.ts)
            continue
        }

        // Turn merge: an in-flight chat_start absorbs the chat_response and
        // chat_end the daemon emits for the same session, so the UI shows
        // one row per user prompt instead of three. sessionId + the
        // chat_start anchor (`entry.startedAt == chat_start.ts`) are the
        // gate — wall-clock isn't, because long assistant responses
        // (multi-fix Claude Code tasks run 20 min+) push chat_end far
        // past any reasonable window. The anchor match is critical:
        // without it an out-of-order chat_end that arrives *after* the
        // next user_prompt_submit would attach to the fresh chat_start,
        // cross-talking Q1's completion onto Q2's row (Codex stop-time
        // review #7, 2026-05-17). Legacy entries with nil startedAt
        // fall back to allowing the merge — pre-anchor emitters
        // shouldn't regress, and the iteration order itself constrains
        // the worst case.
        //
        // Synthetic chat_start placeholders ("Prompt sent" /
        // "Codex turn started") are still excluded — the dashboard
        // filter promotes the trailing chat_end as the visible row,
        // and merging would hide that completion entirely.
        if current.entry.type == .chatStart &&
           current.mergedCompletion == nil &&
           timelineIsMeaningfulChatStart(current.entry) &&
           sameSession(current.entry, entry) &&
           sameTurnAnchor(start: current.entry, child: entry) {
            if entry.type == .chatResponse && current.mergedResponse == nil {
                current.mergedResponse = entry
                continue
            }
            if entry.type == .chatEnd {
                current.mergedCompletion = entry
                continue
            }
        }

        // If the prompt row is missing, synthetic, or filtered later, keep the
        // response body as the visible turn row and attach the trailing
        // chat_end metadata underneath it. Showing `Completed · ...` as its
        // own row adds little signal and makes the timeline read like logs
        // instead of turns. Anchor matching still prevents delayed completions
        // from crossing into the next response.
        if current.entry.type == .chatResponse &&
           current.mergedCompletion == nil &&
           entry.type == .chatEnd &&
           sameSession(current.entry, entry) &&
           sameResponseCompletionAnchor(response: current.entry, completion: entry) {
            current.mergedCompletion = entry
            continue
        }

        if entry.type == current.entry.type &&
           entry.raw == current.entry.raw &&
           sameSession(current.entry, entry) &&
           timeDiff <= timelineGroupingWindowMs(for: entry.type, defaultWindowSeconds: windowSeconds) {
            current.count += 1
            current.lastTs = entry.ts
        } else {
            result.append(current)
            current = GroupedEntry(entry: entry, lastTs: entry.ts)
        }
    }
    result.append(current)
    return result
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

/// Same-session test for the turn merge. Treats two entries as the same
/// session when either both carry the same non-empty sessionId, or both
/// have nil sessionId (legacy / single-session) — keeps the merge
/// working on entries that predate sessionId attribution.
private func sameSession(_ a: TimelineEntry, _ b: TimelineEntry) -> Bool {
    switch (a.sessionId, b.sessionId) {
    case (nil, nil): return true
    case let (x?, y?): return x == y
    default: return false
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

func timelineIsTaskNotificationChatStart(_ entry: TimelineEntry) -> Bool {
    guard entry.type == .chatStart else { return false }
    let raw = entry.raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let detail = entry.detail?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    return raw.hasPrefix("<task-notification>") || detail.hasPrefix("<task-notification>")
}

// Type display functions moved to TimelineStripView.swift (timelineTypeIcon, timelineTypeColor)
